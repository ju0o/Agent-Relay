/** V1.5 Slice 3 — canonical ACCEPT advances exactly one frozen Plan cursor. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v15-s3-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
let passed = 0;
let failed = 0;
const PASS = (message) => { console.log(`  PASS  ${message}`); passed += 1; };
const FAIL = (message) => { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; };
const check = (condition, message) => condition ? PASS(message) : FAIL(message);
async function shouldThrow(fn, label) {
  try { await fn(); FAIL(`${label} — expected throw`); } catch { PASS(label); }
}

const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const continuation = await import('../dist/server/backend/execution-plan-continuation.js');
const intake = await import('../dist/server/backend/v1-intake.js');
const v1Dispatch = await import('../dist/server/backend/v1-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const actions = await import('../dist/server/backend/task-actions.js');
const deliveries = await import('../dist/server/backend/pm-delivery.js');
const judgments = await import('../dist/server/backend/pm-judgment.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const project = 'V15Slice3';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aliveFixture = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';
dispatcher._resetDispatcherStateForTests();
workers.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2', workerId: 'v15-s3-worker', displayName: 'V1.5 Slice 3 fixture worker',
  launchCommand: process.execPath, launchArgsPrefix: [aliveFixture], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const contract = (title) => ({
  title, goal: `Complete ${title}`, reason: 'V1.5 Slice 3 deterministic fixture',
  scope: 'Test-only local fixture scope', completionCriteria: ['fixture complete'],
});
async function createTasks(prefix, count = 3) {
  return Promise.all(Array.from({ length: count }, (_, index) => intake.createV1TaskFromContract(
    TEST_ROOT, project, contract(`${prefix}-${index + 1}`),
  )));
}
function authorizationFor(plan) {
  return {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint])),
  };
}
async function createStartedPlan(prefix, bindingOverride = {}) {
  const created = await createTasks(prefix);
  const workspace = path.join(TEST_ROOT, `_workspace-${prefix}`);
  fs.mkdirSync(workspace, { recursive: true });
  const bindings = created.map(({ task }, index) => ({
    taskId: task.taskId,
    workerId: 'v15-s3-worker', workspaceRoot: workspace,
    scopeFingerprint: retryAuth.computeTaskScopeFingerprint(task),
    ...(index === 1 ? bindingOverride : {}),
  }));
  const plan = await plans.createExecutionPlan(TEST_ROOT, project, {
    title: prefix, orderedTaskIds: created.map(({ task }) => task.taskId), taskBindings: bindings,
  });
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(plan),
  });
  if (start.outcome !== 'DISPATCHED') throw new Error(`fixture plan did not start: ${start.outcome}`);
  return { plan, created, workspace, firstRunId: start.dispatch.runId };
}
async function markAndAccept(taskId, runId, workspace) {
  await rt.markResultReceived(TEST_ROOT, project, taskId, runId);
  // Mirror result-bridge's post-promotion release. The stay-alive fixture does
  // not itself terminate, unlike a completed real Worker observation.
  observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: workspace, taskId, runId });
  const task = gt.getTask(TEST_ROOT, project, taskId);
  return actions.acceptTaskResult({
    dataRoot: TEST_ROOT, project, goalId: task.goalId, taskId, runId,
    expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC', reason: 'V1.5 Slice 3 fixture ACCEPT',
  });
}

console.log('\n-- three-Task canonical ACCEPT progression --');
const flow = await createStartedPlan('three-task-flow');
const [taskA, taskB, taskC] = flow.plan.orderedTaskIds;
await markAndAccept(taskA, flow.firstRunId, flow.workspace);
let flowPlan = plans.getExecutionPlan(TEST_ROOT, project, flow.plan.planId);
let b = gt.getTask(TEST_ROOT, project, taskB);
check(flowPlan.state === 'RUNNING' && flowPlan.activeTaskId === taskB, '1 Task A ACCEPT advances cursor to Task B');
check(b.linkedRuns.length === 1, '1 Task B dispatched exactly once');
const bRun1 = b.linkedRuns[0].runId;
await markAndAccept(taskB, bRun1, flow.workspace);
flowPlan = plans.getExecutionPlan(TEST_ROOT, project, flow.plan.planId);
let c = gt.getTask(TEST_ROOT, project, taskC);
check(flowPlan.state === 'RUNNING' && flowPlan.activeTaskId === taskC, '2 Task B ACCEPT advances cursor to Task C');
check(c.linkedRuns.length === 1, '2 Task C dispatched exactly once');
await markAndAccept(taskC, c.linkedRuns[0].runId, flow.workspace);
flowPlan = plans.getExecutionPlan(TEST_ROOT, project, flow.plan.planId);
check(flowPlan.state === 'COMPLETED' && flowPlan.activeTaskId === null && !!flowPlan.completedAt, '3 final Task ACCEPT completes Plan once');
const finalOutcome = await continuation.continueExecutionPlanAfterTaskAccepted(TEST_ROOT, project, gt.getTask(TEST_ROOT, project, taskC));
check(finalOutcome === 'NO_PLAN' && plans.getExecutionPlan(TEST_ROOT, project, flow.plan.planId).state === 'COMPLETED', '17 duplicate final ACCEPT hook is a bounded no-op');

console.log('\n-- CHANGES/retry preserves active cursor --');
const retryFlow = await createStartedPlan('changes-retry-flow');
const [retryA, retryB, retryC] = retryFlow.plan.orderedTaskIds;
await markAndAccept(retryA, retryFlow.firstRunId, retryFlow.workspace);
let retryBTask = gt.getTask(TEST_ROOT, project, retryB);
const retryBRun1 = retryBTask.linkedRuns[0].runId;
await rt.markResultReceived(TEST_ROOT, project, retryB, retryBRun1);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: retryFlow.workspace, taskId: retryB, runId: retryBRun1 });
await actions.requestTaskChanges({
  dataRoot: TEST_ROOT, project, goalId: retryBTask.goalId, taskId: retryB, runId: retryBRun1,
  reason: 'Slice 3 fixture requests deterministic retry work.', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC',
});
check(plans.getExecutionPlan(TEST_ROOT, project, retryFlow.plan.planId).activeTaskId === retryB, '4 CHANGES leaves Task B active');
check(gt.getTask(TEST_ROOT, project, retryC).linkedRuns.length === 0, '4 CHANGES dispatches no successor');
// The fixture intentionally stays alive; real completed Worker processes exit
// after their terminal observation. Clear only fixture process-local tracking
// before exercising the canonical same-Task retry path.
dispatcher._resetDispatcherStateForTests();
fixtures.ensureTestFixtureAdapterRegistered();
await actions.requestTaskRetry({
  dataRoot: TEST_ROOT, project, goalId: retryBTask.goalId, taskId: retryB,
  expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED', callerSurface: 'OWNER_IPC', reason: 'fixture retry',
});
await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, {
  taskId: retryB, workerId: 'v15-s3-worker', workspaceRoot: retryFlow.workspace, expectedExecutionState: 'READY',
});
retryBTask = gt.getTask(TEST_ROOT, project, retryB);
check(retryBTask.linkedRuns.length === 2 && plans.getExecutionPlan(TEST_ROOT, project, retryFlow.plan.planId).activeTaskId === retryB, '5 same-Task retry retains Plan cursor');
await markAndAccept(retryB, retryBTask.linkedRuns[1].runId, retryFlow.workspace);
check(plans.getExecutionPlan(TEST_ROOT, project, retryFlow.plan.planId).activeTaskId === retryC, '5 retry ACCEPT advances to Task C once');

console.log('\n-- stale, out-of-plan, duplicate, concurrent, and delivery replay --');
const staleOutcome = await continuation.continueExecutionPlanAfterTaskAccepted(TEST_ROOT, project, gt.getTask(TEST_ROOT, project, retryA));
check(staleOutcome === 'NOT_ACTIVE' && gt.getTask(TEST_ROOT, project, retryC).linkedRuns.length === 1, '6 stale Task A ACCEPT cannot advance active Task B/C Plan');
const standalone = await intake.createV1TaskFromContract(TEST_ROOT, project, contract('out-of-plan'));
const standaloneWorkspace = path.join(TEST_ROOT, '_workspace-out-of-plan'); fs.mkdirSync(standaloneWorkspace, { recursive: true });
const standaloneRun = await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, {
  taskId: standalone.task.taskId, workerId: 'v15-s3-worker', workspaceRoot: standaloneWorkspace, expectedExecutionState: 'READY',
});
await markAndAccept(standalone.task.taskId, standaloneRun.runId, standaloneWorkspace);
check(plans.getExecutionPlan(TEST_ROOT, project, retryFlow.plan.planId).activeTaskId === retryC, '7 out-of-plan ACCEPT has no Plan effect');

const replay = await createStartedPlan('delivery-replay');
const replayA = replay.plan.orderedTaskIds[0];
await rt.markResultReceived(TEST_ROOT, project, replayA, replay.firstRunId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: replay.workspace, taskId: replayA, runId: replay.firstRunId });
const delivery = await deliveries.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, replayA);
await judgments.submitPmJudgment(TEST_ROOT, project, { deliveryId: delivery.deliveryId, decision: 'ACCEPT', reason: 'delivery replay fixture' });
await judgments.submitPmJudgment(TEST_ROOT, project, { deliveryId: delivery.deliveryId, decision: 'ACCEPT', reason: 'delivery replay fixture' });
const replayB = replay.plan.orderedTaskIds[1];
check(gt.getTask(TEST_ROOT, project, replayB).linkedRuns.length === 1, '8/10 duplicate delivery judgment replay dispatches successor once');

const concurrent = await createStartedPlan('concurrent-accept');
const concurrentA = concurrent.plan.orderedTaskIds[0];
await rt.markResultReceived(TEST_ROOT, project, concurrentA, concurrent.firstRunId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: concurrent.workspace, taskId: concurrentA, runId: concurrent.firstRunId });
const concurrentTask = gt.getTask(TEST_ROOT, project, concurrentA);
const acceptInput = {
  dataRoot: TEST_ROOT, project, goalId: concurrentTask.goalId, taskId: concurrentA, runId: concurrent.firstRunId,
  expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC', reason: 'concurrent accept fixture',
};
const concurrentAccepts = await Promise.allSettled([actions.acceptTaskResult(acceptInput), actions.acceptTaskResult(acceptInput)]);
check(concurrentAccepts.filter((result) => result.status === 'fulfilled').length === 1, '9 concurrent canonical ACCEPT has one Task mutation winner');
check(gt.getTask(TEST_ROOT, project, concurrent.plan.orderedTaskIds[1]).linkedRuns.length === 1, '9 concurrent ACCEPT dispatches successor once');

console.log('\n-- frozen successor failure boundaries --');
const workerMismatch = await createStartedPlan('successor-worker-bad', { workerId: 'missing-v15-s3-worker' });
await markAndAccept(workerMismatch.plan.orderedTaskIds[0], workerMismatch.firstRunId, workerMismatch.workspace);
let badPlan = plans.getExecutionPlan(TEST_ROOT, project, workerMismatch.plan.planId);
check(badPlan.state === 'BLOCKED' && badPlan.block?.code === 'PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN', '11 successor Worker mismatch blocks Plan');
const workspaceMismatch = await createStartedPlan('successor-workspace-bad', { workspaceRoot: path.join(TEST_ROOT, 'missing-workspace') });
await markAndAccept(workspaceMismatch.plan.orderedTaskIds[0], workspaceMismatch.firstRunId, workspaceMismatch.workspace);
badPlan = plans.getExecutionPlan(TEST_ROOT, project, workspaceMismatch.plan.planId);
check(badPlan.state === 'BLOCKED', '12 successor workspace mismatch blocks Plan');
const scopeMismatch = await createStartedPlan('successor-scope-bad', { scopeFingerprint: `sha256:${'0'.repeat(64)}` });
await markAndAccept(scopeMismatch.plan.orderedTaskIds[0], scopeMismatch.firstRunId, scopeMismatch.workspace);
badPlan = plans.getExecutionPlan(TEST_ROOT, project, scopeMismatch.plan.planId);
check(badPlan.state === 'BLOCKED', '13 successor scope mismatch blocks Plan');
const invalidSuccessor = await createStartedPlan('successor-invalid-state');
await rt.transitionTaskExecution(TEST_ROOT, project, invalidSuccessor.plan.orderedTaskIds[1], {
  expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'fixture invalid successor state',
});
await markAndAccept(invalidSuccessor.plan.orderedTaskIds[0], invalidSuccessor.firstRunId, invalidSuccessor.workspace);
badPlan = plans.getExecutionPlan(TEST_ROOT, project, invalidSuccessor.plan.planId);
check(badPlan.state === 'BLOCKED', '14 successor invalid execution state blocks Plan');

const dispatchFailure = await createStartedPlan('successor-dispatch-failure');
planDispatch._setExecutionPlanOwnerDispatchForTests(async () => { throw new Error('fixture successor dispatch failure'); });
await markAndAccept(dispatchFailure.plan.orderedTaskIds[0], dispatchFailure.firstRunId, dispatchFailure.workspace);
planDispatch._setExecutionPlanOwnerDispatchForTests();
badPlan = plans.getExecutionPlan(TEST_ROOT, project, dispatchFailure.plan.planId);
check(badPlan.state === 'BLOCKED' && badPlan.block?.code === 'PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN', '15 successor pre-Run dispatch failure blocks Plan');

console.log('\n-- post-cursor interruption fail-closed --');
const interruption = await createStartedPlan('post-cursor-interruption');
const interruptionA = interruption.plan.orderedTaskIds[0];
const interruptionB = interruption.plan.orderedTaskIds[1];
await rt.markResultReceived(TEST_ROOT, project, interruptionA, interruption.firstRunId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: interruption.workspace, taskId: interruptionA, runId: interruption.firstRunId });
const acceptedA = await rt.acceptResult(TEST_ROOT, project, interruptionA, interruption.firstRunId, {
  goalId: gt.getTask(TEST_ROOT, project, interruptionA).goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'simulate process interruption after durable accept',
});
await plans.advanceExecutionPlanActiveTask(TEST_ROOT, project, interruption.plan.planId, {
  expectedState: 'RUNNING', expectedActiveTaskId: interruptionA, nextActiveTaskId: interruptionB,
});
const interruptionBinding = interruption.plan.taskBindings[1];
await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, {
  taskId: interruptionB, workerId: interruptionBinding.workerId, workspaceRoot: interruptionBinding.workspaceRoot, expectedExecutionState: 'READY',
});
const interruptedOutcome = await continuation.continueExecutionPlanAfterTaskAccepted(TEST_ROOT, project, acceptedA);
check(interruptedOutcome === 'NOT_ACTIVE' && gt.getTask(TEST_ROOT, project, interruptionB).linkedRuns.length === 1, '16 post-cursor interruption never blindly redispatches successor');

console.log('\n-- structural guard --');
const continuationSource = fs.readFileSync('src/backend/execution-plan-continuation.ts', 'utf8');
check(!continuationSource.includes('requestTaskChanges') && !continuationSource.includes('requestTaskRetry'), '19 continuation never handles CHANGES/retry');
check(!continuationSource.includes('mcp') && !continuationSource.includes('MCP'), '20 continuation adds no MCP surface');

planDispatch._setExecutionPlanOwnerDispatchForTests();
dispatcher._resetDispatcherStateForTests();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
console.log(`\nV1.5 Slice 3 tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed) process.exitCode = 1;
