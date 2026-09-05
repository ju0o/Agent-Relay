/** V1.5 Slice 4 — explicit durable ExecutionPlan reconciliation. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(os.tmpdir(), `arl-v15-s4-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });
let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};

const plans = await import('../dist/server/backend/execution-plan.js');
const reconcile = await import('../dist/server/backend/execution-plan-reconciliation.js');
const v1 = await import('../dist/server/backend/v1-dispatch.js');
const intake = await import('../dist/server/backend/v1-intake.js');
const retry = await import('../dist/server/backend/retry-authorization.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const project = 'V15Slice4';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const alive = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';
dispatcher._resetDispatcherStateForTests();
workers.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'v15-s4-worker', displayName: 'V1.5 Slice 4 fixture worker',
  launchCommand: process.execPath, launchArgsPrefix: [alive], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const contract = (title) => ({ title, goal: `Complete ${title}`, reason: 'Slice 4 fixture', scope: 'Test-only scope', completionCriteria: ['fixture complete'] });
function auth(plan) {
  return {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint])),
  };
}
async function makePlan(prefix, count = 3) {
  const workspace = path.join(ROOT, `_workspace-${prefix}`); fs.mkdirSync(workspace, { recursive: true });
  const created = await Promise.all(Array.from({ length: count }, (_, index) => intake.createV1TaskFromContract(ROOT, project, contract(`${prefix}-${index + 1}`))));
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: prefix,
    orderedTaskIds: created.map(({ task }) => task.taskId),
    taskBindings: created.map(({ task }) => ({ taskId: task.taskId, workerId: 'v15-s4-worker', workspaceRoot: workspace, scopeFingerprint: retry.computeTaskScopeFingerprint(task) })),
  });
  return { plan, workspace };
}
async function startOnly(fixture) {
  return plans.startExecutionPlan(ROOT, project, fixture.plan.planId, {
    expectedState: 'PLANNED', activeTaskId: fixture.plan.orderedTaskIds[0], ownerAuthorization: auth(fixture.plan),
  });
}
async function dispatchTask(taskId, workspace) {
  return v1.dispatchV1OwnerApproved(ROOT, project, { taskId, workerId: 'v15-s4-worker', workspaceRoot: workspace, expectedExecutionState: 'READY' });
}
async function acceptWithoutHook(taskId, runId, workspace) {
  await rt.markResultReceived(ROOT, project, taskId, runId);
  observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: workspace, taskId, runId });
  const task = gt.getTask(ROOT, project, taskId);
  return rt.acceptResult(ROOT, project, taskId, runId, { goalId: task.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'restart fixture direct durable accept' });
}
function resetLocks() {
  plans._resetExecutionPlanLocksForTests();
  dispatcher._resetDispatcherStateForTests();
  fixtures.ensureTestFixtureAdapterRegistered();
}

console.log('\n-- pre-dispatch and active-run restart boundaries --');
const planned = await makePlan('planned');
let outcome = await reconcile.reconcileExecutionPlan(ROOT, project, planned.plan.planId);
check(outcome.status === 'BLOCKED_REQUIRES_OWNER' && outcome.actionTaken === 'OWNER_GO_REQUIRED', '1 restart before first Task dispatch (PLANNED) never auto-starts');

const missingFirst = await makePlan('missing-first'); await startOnly(missingFirst);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, missingFirst.plan.planId);
let first = gt.getTask(ROOT, project, missingFirst.plan.orderedTaskIds[0]);
check(outcome.status === 'SAFE_TO_DISPATCH_MISSING_SUCCESSOR' && first.linkedRuns.length === 1, '2/3 RUNNING before first Run materializes → bounded single dispatch');
const firstRun = first.linkedRuns[0].runId;
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, missingFirst.plan.planId);
first = gt.getTask(ROOT, project, missingFirst.plan.orderedTaskIds[0]);
check(
  (outcome.status === 'HEALTHY_RUNNING' || outcome.status === 'WAITING_FOR_RESULT')
    && first.linkedRuns.length === 1
    && outcome.observedRunId === firstRun,
  '3/4 existing first Run is observed after restart, never redispatched',
);

console.log('\n-- worker RUNNING, RESULT_RECEIVED, ACCEPT-before-cursor, cursor-before-dispatch --');
const workerRunning = await makePlan('worker-running'); await startOnly(workerRunning);
const workerRun = await dispatchTask(workerRunning.plan.orderedTaskIds[0], workerRunning.workspace);
// Fixture workers may remain DISPATCHED; force durable RUNNING for HEALTHY_RUNNING coverage.
try {
  rt.transitionTaskExecution(ROOT, project, workerRunning.plan.orderedTaskIds[0], {
    to: 'RUNNING',
    reason: 'slice4 force RUNNING for restart observe',
    expectedExecutionState: 'DISPATCHED',
  });
} catch {
  // If CAS rejects, observe DISPATCHED as WAITING_FOR_RESULT instead.
}
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, workerRunning.plan.planId);
const workerTask = gt.getTask(ROOT, project, workerRunning.plan.orderedTaskIds[0]);
check(
  workerTask.linkedRuns.length === 1
    && workerTask.linkedRuns[0].runId === workerRun.runId
    && (workerTask.executionState === 'RUNNING'
      ? outcome.status === 'HEALTHY_RUNNING'
      : outcome.status === 'WAITING_FOR_RESULT'),
  '4 restart while Worker DISPATCHED/RUNNING observes existing Run only',
);

const waitPm = await makePlan('wait-pm'); await startOnly(waitPm);
const waitRun = await dispatchTask(waitPm.plan.orderedTaskIds[0], waitPm.workspace);
await rt.markResultReceived(ROOT, project, waitPm.plan.orderedTaskIds[0], waitRun.runId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: waitPm.workspace, taskId: waitPm.plan.orderedTaskIds[0], runId: waitRun.runId });
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, waitPm.plan.planId);
check(outcome.status === 'WAITING_FOR_PM', '5 RESULT_RECEIVED before PM judgment waits without dispatch');

const accepted = await makePlan('accept-before-cursor'); await startOnly(accepted);
const acceptedRun = await dispatchTask(accepted.plan.orderedTaskIds[0], accepted.workspace);
await acceptWithoutHook(accepted.plan.orderedTaskIds[0], acceptedRun.runId, accepted.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, accepted.plan.planId);
let acceptedPlan = plans.getExecutionPlan(ROOT, project, accepted.plan.planId);
let acceptedB = gt.getTask(ROOT, project, accepted.plan.orderedTaskIds[1]);
check(outcome.status === 'SAFE_TO_DISPATCH_MISSING_SUCCESSOR' && acceptedPlan.activeTaskId === accepted.plan.orderedTaskIds[1] && acceptedB.linkedRuns.length === 1, '6 ACCEPT-before-advance repairs cursor and dispatches successor once');

const cursorOnly = await makePlan('cursor-before-dispatch'); await startOnly(cursorOnly);
const cursorRun = await dispatchTask(cursorOnly.plan.orderedTaskIds[0], cursorOnly.workspace);
await acceptWithoutHook(cursorOnly.plan.orderedTaskIds[0], cursorRun.runId, cursorOnly.workspace);
await plans.advanceExecutionPlanActiveTask(ROOT, project, cursorOnly.plan.planId, { expectedState: 'RUNNING', expectedActiveTaskId: cursorOnly.plan.orderedTaskIds[0], nextActiveTaskId: cursorOnly.plan.orderedTaskIds[1] });
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, cursorOnly.plan.planId);
check(outcome.status === 'SAFE_TO_DISPATCH_MISSING_SUCCESSOR' && gt.getTask(ROOT, project, cursorOnly.plan.orderedTaskIds[1]).linkedRuns.length === 1, '7 cursor-before-dispatch safely materializes missing successor once');

console.log('\n-- successor materialization, final completion, and successor-already-dispatched --');
const successorRun = await makePlan('successor-run'); await startOnly(successorRun);
const successorA = await dispatchTask(successorRun.plan.orderedTaskIds[0], successorRun.workspace);
await acceptWithoutHook(successorRun.plan.orderedTaskIds[0], successorA.runId, successorRun.workspace);
await plans.advanceExecutionPlanActiveTask(ROOT, project, successorRun.plan.planId, { expectedState: 'RUNNING', expectedActiveTaskId: successorRun.plan.orderedTaskIds[0], nextActiveTaskId: successorRun.plan.orderedTaskIds[1] });
await dispatchTask(successorRun.plan.orderedTaskIds[1], successorRun.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, successorRun.plan.planId);
check(
  (outcome.status === 'HEALTHY_RUNNING' || outcome.status === 'WAITING_FOR_RESULT')
    && gt.getTask(ROOT, project, successorRun.plan.orderedTaskIds[1]).linkedRuns.length === 1,
  '8 successor Run materialization survives restart without duplicate',
);

const alreadyDispatched = await makePlan('already-dispatched'); await startOnly(alreadyDispatched);
const alreadyA = await dispatchTask(alreadyDispatched.plan.orderedTaskIds[0], alreadyDispatched.workspace);
await acceptWithoutHook(alreadyDispatched.plan.orderedTaskIds[0], alreadyA.runId, alreadyDispatched.workspace);
// Simulate crash after successor Run materialized but before cursor advance confirmation.
await dispatchTask(alreadyDispatched.plan.orderedTaskIds[1], alreadyDispatched.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, alreadyDispatched.plan.planId);
const alreadyPlan = plans.getExecutionPlan(ROOT, project, alreadyDispatched.plan.planId);
check(
  outcome.status === 'SUCCESSOR_ALREADY_DISPATCHED'
    && alreadyPlan.activeTaskId === alreadyDispatched.plan.orderedTaskIds[1]
    && gt.getTask(ROOT, project, alreadyDispatched.plan.orderedTaskIds[1]).linkedRuns.length === 1,
  '8b ACCEPT+existing successor Run advances cursor once without second Run',
);

const finalRepair = await makePlan('final-repair', 1); await startOnly(finalRepair);
const finalRun = await dispatchTask(finalRepair.plan.orderedTaskIds[0], finalRepair.workspace);
await acceptWithoutHook(finalRepair.plan.orderedTaskIds[0], finalRun.runId, finalRepair.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, finalRepair.plan.planId);
check(outcome.status === 'PLAN_COMPLETE' && plans.getExecutionPlan(ROOT, project, finalRepair.plan.planId).activeTaskId === null, '11 final ACCEPT repairs Plan completion exactly once');
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, finalRepair.plan.planId);
check(outcome.status === 'PLAN_COMPLETE' && outcome.actionTaken === 'NOOP_TERMINAL', '12 completed Plan reconciliation is idempotent');
outcome = await reconcile.reconcileRunningExecutionPlan(ROOT, project, finalRepair.plan.planId);
check(outcome.status === 'PLAN_COMPLETE', '12b reconcileRunningExecutionPlan alias remains idempotent');

console.log('\n-- duplicate/concurrent reconciliation and retry ownership --');
const concurrent = await makePlan('concurrent'); await startOnly(concurrent);
resetLocks();
const concurrentOutcomes = await Promise.all([
  reconcile.reconcileExecutionPlan(ROOT, project, concurrent.plan.planId),
  reconcile.reconcileExecutionPlan(ROOT, project, concurrent.plan.planId),
]);
check(gt.getTask(ROOT, project, concurrent.plan.orderedTaskIds[0]).linkedRuns.length === 1 && concurrentOutcomes.some((item) => item.status === 'SAFE_TO_DISPATCH_MISSING_SUCCESSOR'), '13 concurrent reconciliation creates one first Run');

const retryOwned = await makePlan('retry-owned'); await startOnly(retryOwned);
const retryRun = await dispatchTask(retryOwned.plan.orderedTaskIds[0], retryOwned.workspace);
await rt.markResultReceived(ROOT, project, retryOwned.plan.orderedTaskIds[0], retryRun.runId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: retryOwned.workspace, taskId: retryOwned.plan.orderedTaskIds[0], runId: retryRun.runId });
const retryTask = gt.getTask(ROOT, project, retryOwned.plan.orderedTaskIds[0]);
await rt.requestChanges(ROOT, project, retryTask.taskId, retryRun.runId, { goalId: retryTask.goalId, reason: 'restart retry ownership fixture', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING' });
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, retryOwned.plan.planId);
check(
  outcome.status === 'WAITING_FOR_PM'
    && outcome.actionTaken === 'WAIT_FOR_G5_RETRY_PREPARATION'
    && gt.getTask(ROOT, project, retryTask.taskId).linkedRuns.length === 1,
  '9 CHANGES before retry preparation never forks a Plan retry Run',
);

const retryMaterialized = await makePlan('retry-materialized'); await startOnly(retryMaterialized);
const retryMaterializedA = await dispatchTask(retryMaterialized.plan.orderedTaskIds[0], retryMaterialized.workspace);
await acceptWithoutHook(retryMaterialized.plan.orderedTaskIds[0], retryMaterializedA.runId, retryMaterialized.workspace);
await plans.advanceExecutionPlanActiveTask(ROOT, project, retryMaterialized.plan.planId, { expectedState: 'RUNNING', expectedActiveTaskId: retryMaterialized.plan.orderedTaskIds[0], nextActiveTaskId: retryMaterialized.plan.orderedTaskIds[1] });
resetLocks();
const retryMaterializedB1 = await dispatchTask(retryMaterialized.plan.orderedTaskIds[1], retryMaterialized.workspace);
await rt.markResultReceived(ROOT, project, retryMaterialized.plan.orderedTaskIds[1], retryMaterializedB1.runId);
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: retryMaterialized.workspace, taskId: retryMaterialized.plan.orderedTaskIds[1], runId: retryMaterializedB1.runId });
const retryMaterializedTask = gt.getTask(ROOT, project, retryMaterialized.plan.orderedTaskIds[1]);
await rt.requestChanges(ROOT, project, retryMaterializedTask.taskId, retryMaterializedB1.runId, { goalId: retryMaterializedTask.goalId, reason: 'retry materialized restart fixture', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING' });
await rt.requestRetry(ROOT, project, retryMaterializedTask.taskId, { goalId: retryMaterializedTask.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED', reason: 'fixture retry' });
resetLocks();
await dispatchTask(retryMaterialized.plan.orderedTaskIds[1], retryMaterialized.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, retryMaterialized.plan.planId);
check(
  (outcome.status === 'HEALTHY_RUNNING' || outcome.status === 'WAITING_FOR_RESULT')
    && gt.getTask(ROOT, project, retryMaterialized.plan.orderedTaskIds[1]).linkedRuns.length === 2,
  '10 materialized retry Run is observed without a third Run',
);

console.log('\n-- stale lock, live lock, ambiguity, auth mismatch, V1 isolation --');
const stale = await makePlan('stale-lock'); await startOnly(stale);
fs.writeFileSync(plans.executionPlanLockPath(ROOT, project, stale.plan.planId), `${JSON.stringify({ planId: stale.plan.planId, pid: 99999999, processStartTicks: '1', acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString() })}\n`, 'utf8');
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, stale.plan.planId);
check(outcome.staleLockRecovered === true && gt.getTask(ROOT, project, stale.plan.orderedTaskIds[0]).linkedRuns.length === 1, '14 stale dead-PID lock is reclaimed and reconciliation remains single-dispatch');

const liveLock = await makePlan('live-lock'); await startOnly(liveLock);
let liveTicks;
try {
  const raw = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const closing = raw.lastIndexOf(')');
  liveTicks = raw.slice(closing + 2).trim().split(/\s+/)[19];
} catch {
  liveTicks = 'unknown';
}
fs.writeFileSync(plans.executionPlanLockPath(ROOT, project, liveLock.plan.planId), `${JSON.stringify({ planId: liveLock.plan.planId, pid: process.pid, processStartTicks: liveTicks, acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString() })}\n`, 'utf8');
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, liveLock.plan.planId);
check(
  outcome.status === 'BLOCKED_REQUIRES_OWNER'
    && outcome.actionTaken === 'LIVE_OR_UNRESOLVED_PLAN_LOCK'
    && gt.getTask(ROOT, project, liveLock.plan.orderedTaskIds[0]).linkedRuns.length === 0,
  '14b live-owner lock is never reclaimed and no dispatch occurs',
);
fs.unlinkSync(plans.executionPlanLockPath(ROOT, project, liveLock.plan.planId));

const ambiguous = await makePlan('ambiguous-run'); await startOnly(ambiguous);
const ambiguousAgent = path.join(ROOT, project, new Date().toISOString().slice(0, 10), 'worker-v15-s4-worker', '99');
fs.mkdirSync(ambiguousAgent, { recursive: true });
fs.writeFileSync(path.join(ambiguousAgent, 'meta.json'), JSON.stringify({ tags: [], runId: 'ambiguous-unlinked-run' }));
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, ambiguous.plan.planId);
check(outcome.status === 'BLOCKED_REQUIRES_OWNER' && plans.getExecutionPlan(ROOT, project, ambiguous.plan.planId).block?.code === 'PLAN_ACTIVE_UNLINKED_RUN_AMBIGUITY', '15 ambiguous unlinked Run blocks Plan');
// Remove the synthetic unlinked folder so later Plans sharing this Worker are not poisoned.
fs.rmSync(ambiguousAgent, { recursive: true, force: true });

const malformed = await makePlan('malformed');
fs.writeFileSync(plans.executionPlanPath(ROOT, project, malformed.plan.planId), '{not-json', 'utf8');
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, malformed.plan.planId);
check(outcome.status === 'BLOCKED_REQUIRES_OWNER' && outcome.actionTaken === 'RECONCILIATION_FAILED_CLOSED', '15b malformed Plan is fail-closed without guessed repair');

const authMismatch = await makePlan('auth-mismatch'); await startOnly(authMismatch);
const authRun = await dispatchTask(authMismatch.plan.orderedTaskIds[0], authMismatch.workspace);
await acceptWithoutHook(authMismatch.plan.orderedTaskIds[0], authRun.runId, authMismatch.workspace);
// Mutate successor Task contract fields so frozen binding fingerprints diverge
// from live Task truth. Plan record remains readable; repair must revalidate and BLOCK.
const successorId = authMismatch.plan.orderedTaskIds[1];
const successorTask = gt.getTask(ROOT, project, successorId);
successorTask.scope = `${successorTask.scope}::mutated-after-freeze`;
fs.writeFileSync(path.join(gt.taskFolder(ROOT, project, successorId), 'task.json'), `${JSON.stringify(successorTask, null, 2)}\n`, 'utf8');
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, authMismatch.plan.planId);
const authMismatchPlan = plans.getExecutionPlan(ROOT, project, authMismatch.plan.planId);
check(
  outcome.status === 'BLOCKED_REQUIRES_OWNER'
    && authMismatchPlan.block?.code === 'PLAN_SUCCESSOR_BINDING_INVALID'
    && authMismatchPlan.activeTaskId === authMismatch.plan.orderedTaskIds[0]
    && gt.getTask(ROOT, project, successorId).linkedRuns.length === 0,
  '15c fingerprint revalidation blocks ACCEPT repair without successor dispatch',
);

const corruptAuth = await makePlan('corrupt-auth'); await startOnly(corruptAuth);
const corruptPath = plans.executionPlanPath(ROOT, project, corruptAuth.plan.planId);
const corruptRecord = JSON.parse(fs.readFileSync(corruptPath, 'utf8'));
corruptRecord.ownerAuthorization.planScopeFingerprint = '0'.repeat(64);
fs.writeFileSync(corruptPath, `${JSON.stringify(corruptRecord, null, 2)}\n`, 'utf8');
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, corruptAuth.plan.planId);
check(
  outcome.status === 'BLOCKED_REQUIRES_OWNER'
    && outcome.actionTaken === 'RECONCILIATION_FAILED_CLOSED'
    && gt.getTask(ROOT, project, corruptAuth.plan.orderedTaskIds[0]).linkedRuns.length === 0,
  '15d corrupt Plan authorization evidence fails closed without dispatch',
);

const legacy = await intake.createV1TaskFromContract(ROOT, project, contract('legacy-v1-no-plan'));
const legacyBefore = gt.getTask(ROOT, project, legacy.task.taskId);
await reconcile.reconcileExecutionPlan(ROOT, project, accepted.plan.planId).catch(() => {});
const legacyAfter = gt.getTask(ROOT, project, legacy.task.taskId);
check(
  legacyBefore.linkedRuns.length === 0
    && legacyAfter.linkedRuns.length === 0
    && legacyAfter.executionState === legacyBefore.executionState
    && legacyAfter.pmState === legacyBefore.pmState,
  'V1 Task without Plan remains untouched by reconciliation',
);

console.log('\n-- 3-Task Plan survives restart at successive boundaries --');
const three = await makePlan('three-survive'); await startOnly(three);
const [tA, tB, tC] = three.plan.orderedTaskIds;
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, three.plan.planId);
const threeA = gt.getTask(ROOT, project, tA);
check(outcome.status === 'SAFE_TO_DISPATCH_MISSING_SUCCESSOR' && threeA.linkedRuns.length === 1, '3T boundary: missing first Run dispatches once');
if (threeA.linkedRuns.length !== 1) {
  console.log(`  detail: 3T first reconcile status=${outcome.status} action=${outcome.actionTaken} reason=${outcome.reason}`);
  throw new Error('3T first dispatch did not materialize; aborting remaining 3T boundaries');
}
const runA = threeA.linkedRuns[0].runId;
await acceptWithoutHook(tA, runA, three.workspace);
// Crash window: ACCEPT durable, cursor not advanced.
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, three.plan.planId);
check(
  plans.getExecutionPlan(ROOT, project, three.plan.planId).activeTaskId === tB
    && gt.getTask(ROOT, project, tB).linkedRuns.length === 1
    && gt.getTask(ROOT, project, tA).linkedRuns.length === 1,
  '3T boundary: ACCEPT-before-advance recovers B exactly once',
);
const runB = gt.getTask(ROOT, project, tB).linkedRuns[0].runId;
await acceptWithoutHook(tB, runB, three.workspace);
await plans.advanceExecutionPlanActiveTask(ROOT, project, three.plan.planId, {
  expectedState: 'RUNNING', expectedActiveTaskId: tB, nextActiveTaskId: tC,
});
// Crash window: cursor on C, no Run yet.
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, three.plan.planId);
check(
  plans.getExecutionPlan(ROOT, project, three.plan.planId).activeTaskId === tC
    && gt.getTask(ROOT, project, tC).linkedRuns.length === 1
    && gt.getTask(ROOT, project, tB).linkedRuns.length === 1,
  '3T boundary: cursor-before-dispatch recovers C exactly once',
);
const runC = gt.getTask(ROOT, project, tC).linkedRuns[0].runId;
await acceptWithoutHook(tC, runC, three.workspace);
resetLocks();
outcome = await reconcile.reconcileExecutionPlan(ROOT, project, three.plan.planId);
check(
  outcome.status === 'PLAN_COMPLETE'
    && plans.getExecutionPlan(ROOT, project, three.plan.planId).state === 'COMPLETED'
    && gt.getTask(ROOT, project, tA).linkedRuns.length === 1
    && gt.getTask(ROOT, project, tB).linkedRuns.length === 1
    && gt.getTask(ROOT, project, tC).linkedRuns.length === 1,
  '3T boundary: final ACCEPT repairs COMPLETED with no duplicate Runs',
);

// Out-of-plan Task must never become active via reconciliation.
const outOfPlan = await intake.createV1TaskFromContract(ROOT, project, contract('out-of-plan'));
const threeAfter = plans.getExecutionPlan(ROOT, project, three.plan.planId);
check(
  !threeAfter.orderedTaskIds.includes(outOfPlan.task.taskId)
    && threeAfter.activeTaskId === null
    && gt.getTask(ROOT, project, outOfPlan.task.taskId).linkedRuns.length === 0,
  'out-of-plan Task is never activated by reconciliation',
);

dispatcher._resetDispatcherStateForTests();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nV1.5 Slice 4 tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed) process.exitCode = 1;
