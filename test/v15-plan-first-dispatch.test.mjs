/** V1.5 Slice 2 — one frozen Plan GO dispatches first Task only. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v15-s2-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
let passed = 0;
let failed = 0;
const PASS = (message) => { console.log(`  PASS  ${message}`); passed += 1; };
const FAIL = (message) => { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; };
const check = (condition, message) => condition ? PASS(message) : FAIL(message);

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (error) {
    const detail = `${error?.code ?? ''} ${error instanceof Error ? error.message : String(error)}`;
    if (fragment && !detail.includes(fragment)) {
      FAIL(`${label} — expected ${fragment}, got ${detail}`);
    } else {
      PASS(label);
    }
  }
}

const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const intake = await import('../dist/server/backend/v1-intake.js');
const v1Dispatch = await import('../dist/server/backend/v1-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const project = 'V15Slice2';
const workspace = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(workspace, { recursive: true });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aliveFixture = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';
dispatcher._resetDispatcherStateForTests();
workers.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v15-s2-worker',
  displayName: 'V1.5 Slice 2 fixture worker',
  launchCommand: process.execPath,
  launchArgsPrefix: [aliveFixture],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const contract = (title) => ({
  title,
  goal: `Complete ${title}`,
  reason: 'V1.5 Slice 2 deterministic fixture',
  scope: 'Test-only local fixture scope',
  completionCriteria: ['fixture complete'],
});

async function createTasks(prefix, count = 3) {
  return Promise.all(Array.from({ length: count }, (_, index) => intake.createV1TaskFromContract(
    TEST_ROOT, project, contract(`${prefix}-${index + 1}`),
  )));
}

function authorizationFor(plan, overrides = {}) {
  return {
    authorizationId: `owner-go:${plan.planId}`,
    approvedAt: new Date().toISOString(),
    approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint])),
    ...overrides,
  };
}

async function createPlan(prefix, options = {}) {
  const created = await createTasks(prefix, options.count ?? 3);
  const planWorkspace = options.workspaceRoot ?? path.join(TEST_ROOT, `_workspace-${prefix}`);
  if (!options.workspaceRoot) fs.mkdirSync(planWorkspace, { recursive: true });
  const taskBindings = created.map(({ task }) => ({
    taskId: task.taskId,
    workerId: options.workerId ?? 'v15-s2-worker',
    workspaceRoot: planWorkspace,
    scopeFingerprint: retryAuth.computeTaskScopeFingerprint(task),
  }));
  const plan = await plans.createExecutionPlan(TEST_ROOT, project, {
    title: prefix,
    orderedTaskIds: created.map(({ task }) => task.taskId),
    taskBindings,
  });
  return { plan, created };
}

console.log('\n-- valid first-only Plan dispatch --');
const valid = await createPlan('valid-plan');
const validGo = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
  planId: valid.plan.planId,
  expectedPlanState: 'PLANNED',
  ownerAuthorization: authorizationFor(valid.plan),
});
check(validGo.outcome === 'DISPATCHED', '1 valid 3-Task Plan GO dispatches');
check(validGo.dispatch?.taskId === valid.plan.orderedTaskIds[0], '1 first frozen Task selected');
const validAfter = plans.getExecutionPlan(TEST_ROOT, project, valid.plan.planId);
check(validAfter.state === 'RUNNING' && validAfter.activeTaskId === valid.plan.orderedTaskIds[0], '2 Plan is RUNNING with first activeTaskId');
const firstAfter = gt.getTask(TEST_ROOT, project, valid.plan.orderedTaskIds[0]);
check(firstAfter.linkedRuns.length === 1, '1 exactly one first-Task Run linked');
for (const taskId of valid.plan.orderedTaskIds.slice(1)) {
  check(gt.getTask(TEST_ROOT, project, taskId).linkedRuns.length === 0, `3 successor ${taskId} not dispatched`);
}

console.log('\n-- duplicate and concurrent Owner GO --');
const duplicate = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
  planId: valid.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(valid.plan),
});
check(duplicate.outcome === 'ALREADY_STARTED' && duplicate.existingRunId === validGo.dispatch.runId, '4 duplicate GO returns existing Run without replay');
check(gt.getTask(TEST_ROOT, project, valid.plan.orderedTaskIds[0]).linkedRuns.length === 1, '4 duplicate GO creates no second Run');

const concurrent = await createPlan('concurrent-plan');
const concurrentInput = { planId: concurrent.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(concurrent.plan) };
const concurrentResults = await Promise.all([
  planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, concurrentInput),
  planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, concurrentInput),
]);
check(concurrentResults.filter((result) => result.outcome === 'DISPATCHED').length === 1, '5 concurrent GO has exactly one dispatcher winner');
check(gt.getTask(TEST_ROOT, project, concurrent.plan.orderedTaskIds[0]).linkedRuns.length === 1, '5 concurrent GO creates one Run only');

console.log('\n-- frozen authorization and binding validation --');
const fingerprintBad = await createPlan('fingerprint-bad');
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: fingerprintBad.plan.planId,
    expectedPlanState: 'PLANNED',
    ownerAuthorization: authorizationFor(fingerprintBad.plan, { planScopeFingerprint: '0'.repeat(64) }),
  }),
  '6 mutated Plan authorization fingerprint rejected',
  'planScopeFingerprint',
);
check(plans.getExecutionPlan(TEST_ROOT, project, fingerprintBad.plan.planId).state === 'PLANNED', '6 rejected authorization leaves Plan PLANNED');

const workerBad = await createPlan('worker-bad', { workerId: 'not-a-registered-worker' });
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: workerBad.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(workerBad.plan),
  }),
  '7 frozen worker binding must resolve',
  'NOT_FOUND',
);
const workspaceBad = await createPlan('workspace-bad', { workspaceRoot: path.join(TEST_ROOT, 'not-a-workspace') });
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: workspaceBad.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(workspaceBad.plan),
  }),
  '8 frozen workspace binding must resolve',
  'workspaceRoot',
);
const scopeBad = await createPlan('scope-bad');
const scopeBadPath = plans.executionPlanPath(TEST_ROOT, project, scopeBad.plan.planId);
const scopeBadRaw = JSON.parse(fs.readFileSync(scopeBadPath, 'utf8'));
scopeBadRaw.taskBindings[0].scopeFingerprint = `sha256:${'0'.repeat(64)}`;
fs.writeFileSync(scopeBadPath, `${JSON.stringify(scopeBadRaw, null, 2)}\n`, 'utf8');
const scopeBadPersisted = plans.getExecutionPlan(TEST_ROOT, project, scopeBad.plan.planId);
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: scopeBad.plan.planId,
    expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(scopeBadPersisted),
  }),
  '9 Task scope fingerprint mismatch rejected',
  'scope fingerprint',
);

console.log('\n-- invalid state, substitution, terminal Plan --');
const invalidTask = await createPlan('invalid-task');
await rt.transitionTaskExecution(TEST_ROOT, project, invalidTask.plan.orderedTaskIds[0], {
  expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'test invalid execution state',
});
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: invalidTask.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(invalidTask.plan),
  }),
  '10 first Task invalid execution state rejected',
  'READY/PENDING',
);
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: invalidTask.plan.planId,
    expectedPlanState: 'PLANNED',
    ownerAuthorization: authorizationFor(invalidTask.plan),
    taskId: invalidTask.plan.orderedTaskIds[1],
  }),
  '11 out-of-plan/caller Task substitution rejected',
  'taskId',
);
const terminal = await createPlan('terminal-plan');
await plans.startExecutionPlan(TEST_ROOT, project, terminal.plan.planId, {
  expectedState: 'PLANNED', activeTaskId: terminal.plan.orderedTaskIds[0], ownerAuthorization: authorizationFor(terminal.plan),
});
await plans.transitionExecutionPlan(TEST_ROOT, project, terminal.plan.planId, { expectedState: 'RUNNING', to: 'FAILED', reason: 'test terminal' });
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: terminal.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(terminal.plan),
  }),
  '12 terminal Plan rejects Owner GO',
  'FAILED',
);

console.log('\n-- failure and interruption boundaries --');
const beforeRunFailure = await createPlan('before-run-failure');
planDispatch._setExecutionPlanOwnerDispatchForTests(async () => { throw new Error('fixture dispatch failure before Run'); });
await shouldThrow(
  () => planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
    planId: beforeRunFailure.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(beforeRunFailure.plan),
  }),
  '13 dispatch failure before Run materialization surfaces',
  'fixture dispatch failure',
);
planDispatch._setExecutionPlanOwnerDispatchForTests();
const beforeRunAfter = plans.getExecutionPlan(TEST_ROOT, project, beforeRunFailure.plan.planId);
check(beforeRunAfter.state === 'BLOCKED' && beforeRunAfter.block?.code === 'PLAN_FIRST_DISPATCH_FAILED_BEFORE_RUN', '13 Plan BLOCKED after pre-Run dispatch failure');
check(gt.getTask(TEST_ROOT, project, beforeRunFailure.plan.orderedTaskIds[0]).linkedRuns.length === 0, '13 no Run materialized on failure');

const interrupted = await createPlan('post-materialization-interruption');
await plans.startExecutionPlan(TEST_ROOT, project, interrupted.plan.planId, {
  expectedState: 'PLANNED', activeTaskId: interrupted.plan.orderedTaskIds[0], ownerAuthorization: authorizationFor(interrupted.plan),
});
const interruptedBinding = interrupted.plan.taskBindings[0];
const interruptedRun = await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, {
  taskId: interruptedBinding.taskId,
  workerId: interruptedBinding.workerId,
  workspaceRoot: interruptedBinding.workspaceRoot,
  expectedExecutionState: 'READY',
});
const interruptedReplay = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
  planId: interrupted.plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(interrupted.plan),
});
check(interruptedReplay.outcome === 'ALREADY_STARTED' && interruptedReplay.existingRunId === interruptedRun.runId, '14 post-materialization replay recognizes existing Run');
check(gt.getTask(TEST_ROOT, project, interrupted.plan.orderedTaskIds[0]).linkedRuns.length === 1, '14 post-materialization replay never double-dispatches');

console.log('\n-- V1 regression boundary --');
check(gt.getTask(TEST_ROOT, project, valid.plan.orderedTaskIds[1]).linkedRuns.length === 0, '15 Slice 2 first-dispatch path never starts Task 2');
const standalone = (await intake.createV1TaskFromContract(TEST_ROOT, project, contract('standalone-v1'))).task;
const standaloneDispatch = await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, {
  taskId: standalone.taskId, workerId: 'v15-s2-worker', workspaceRoot: workspace, expectedExecutionState: 'READY',
});
check(gt.getTask(TEST_ROOT, project, standalone.taskId).linkedRuns.length === 1 && !!standaloneDispatch.runId, '16 standalone V1 owner-approved dispatch remains unchanged');

console.log('\n-- structural no-successor guard --');
const source = fs.readFileSync('src/backend/execution-plan-dispatch.ts', 'utf8');
check(!source.includes('orderedTaskIds[1]') && !source.includes('acceptTaskResult'), '17 Slice 2 contains no successor/ACCEPT orchestration');

planDispatch._setExecutionPlanOwnerDispatchForTests();
dispatcher._resetDispatcherStateForTests();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
console.log(`\nV1.5 Slice 2 tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed) process.exitCode = 1;
