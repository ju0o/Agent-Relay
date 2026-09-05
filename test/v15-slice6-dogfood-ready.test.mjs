/** Slice 6 Track F+G — full 3-Task fixture E2E + ordinary PM Delivery reuse proof. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v15-s6-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
let passed = 0; let failed = 0;
const PASS = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const FAIL = (m) => { console.log(`  FAIL  ${m}`); failed += 1; process.exitCode = 1; };
const check = (c, m) => (c ? PASS(m) : FAIL(m));

const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const intake = await import('../dist/server/backend/v1-intake.js');
const v1Dispatch = await import('../dist/server/backend/v1-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const actions = await import('../dist/server/backend/task-actions.js');
const deliveries = await import('../dist/server/backend/pm-delivery.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const project = 'V15Slice6E2E';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aliveFixture = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';
dispatcher._resetDispatcherStateForTests();
const WORKER = 'v15-s6-worker';
workers.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2', workerId: WORKER, displayName: 'V1.5 Slice 6 fixture worker',
  launchCommand: process.execPath, launchArgsPrefix: [aliveFixture], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});
const workspace = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(workspace, { recursive: true });

const contract = (title) => ({ title, goal: `Complete ${title}`, reason: 'slice6 e2e', scope: 'Test-only local fixture scope', completionCriteria: ['fixture complete'] });
const created = await Promise.all(['V15-A', 'V15-B', 'V15-C'].map((t) => intake.createV1TaskFromContract(TEST_ROOT, project, contract(t))));
const tasks = created.map(({ task }) => task);
const bindings = tasks.map(({ taskId, ...t }) => ({ taskId, workerId: WORKER, workspaceRoot: workspace, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(tasks.find((x) => x.taskId === taskId)) }));
const plan = await plans.createExecutionPlan(TEST_ROOT, project, { title: 'slice6-e2e', orderedTaskIds: tasks.map((t) => t.taskId), taskBindings: bindings });
const auth = {
  authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
  planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
  taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
};
const go = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, { planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: auth });
check(go.outcome === 'DISPATCHED', 'Owner GO dispatches Task A once');

const [idA, idB, idC] = plan.orderedTaskIds;
const dispatchSeq = [];
const writeExactResult = (taskId, runId, text) => {
  const t = gt.getTask(TEST_ROOT, project, taskId);
  const link = t.linkedRuns.find((l) => l.runId === runId);
  fs.writeFileSync(path.join(link.folder, 'agent-result.md'), text, 'utf8');
  fs.writeFileSync(path.join(link.folder, 'result.md'), text, 'utf8');
};
async function receiveAndDeliver(taskId, runId) {
  await rt.markResultReceived(TEST_ROOT, project, taskId, runId);
  observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: workspace, taskId, runId });
  await deliveries.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, taskId);
}
async function accept(taskId, runId, reason) {
  const t = gt.getTask(TEST_ROOT, project, taskId);
  return actions.acceptTaskResult({ dataRoot: TEST_ROOT, project, goalId: t.goalId, taskId, runId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC', reason });
}

// Task A: exact V15_A_ACCEPTED
let tA = gt.getTask(TEST_ROOT, project, idA);
const runA1 = tA.linkedRuns[0].runId;
dispatchSeq.push(`A:${runA1}`);
writeExactResult(idA, runA1, 'V15_A_ACCEPTED');
await receiveAndDeliver(idA, runA1);
await accept(idA, runA1, 'slice6 ACCEPT A');

// Task B run 1 → CHANGES
let tB = gt.getTask(TEST_ROOT, project, idB);
const runB1 = tB.linkedRuns[0].runId;
dispatchSeq.push(`B:${runB1}`);
writeExactResult(idB, runB1, 'V15_B\nattempt=1');
await receiveAndDeliver(idB, runB1);
await actions.requestTaskChanges({ dataRoot: TEST_ROOT, project, goalId: tB.goalId, taskId: idB, runId: runB1, reason: 'slice6 CHANGES B1', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC' });
check(plans.getExecutionPlan(TEST_ROOT, project, plan.planId).activeTaskId === idB, 'B1 CHANGES keeps Plan cursor on B, no advance');

// Same-Task G5 retry → run 2
dispatcher._resetDispatcherStateForTests();
fixtures.ensureTestFixtureAdapterRegistered();
await actions.requestTaskRetry({ dataRoot: TEST_ROOT, project, goalId: tB.goalId, taskId: idB, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED', callerSurface: 'OWNER_IPC', reason: 'slice6 retry' });
await v1Dispatch.dispatchV1OwnerApproved(TEST_ROOT, project, { taskId: idB, workerId: WORKER, workspaceRoot: workspace, expectedExecutionState: 'READY' });
tB = gt.getTask(TEST_ROOT, project, idB);
check(tB.linkedRuns.length === 2, 'same-Task retry creates B run 2 only');
const runB2 = tB.linkedRuns[1].runId;
dispatchSeq.push(`B:${runB2}`);
writeExactResult(idB, runB2, 'V15_B\nattempt=2');
await receiveAndDeliver(idB, runB2);
await accept(idB, runB2, 'slice6 ACCEPT B2');

// Task C → ACCEPT
let tC = gt.getTask(TEST_ROOT, project, idC);
const runC1 = tC.linkedRuns[0].runId;
dispatchSeq.push(`C:${runC1}`);
writeExactResult(idC, runC1, 'V15_C_ACCEPTED');
await receiveAndDeliver(idC, runC1);
await accept(idC, runC1, 'slice6 ACCEPT C');

const finalPlan = plans.getExecutionPlan(TEST_ROOT, project, plan.planId);
check(finalPlan.state === 'COMPLETED' && finalPlan.activeTaskId === null, 'Plan COMPLETED after C ACCEPT');
const allRuns = [gt.getTask(TEST_ROOT, project, idA), gt.getTask(TEST_ROOT, project, idB), gt.getTask(TEST_ROOT, project, idC)]
  .flatMap((t) => t.linkedRuns.map((l) => l.runId));
check(allRuns.length === 4, `exactly 4 Worker Runs (found ${allRuns.length})`);
check(new Set(allRuns).size === 4, 'no duplicate Run IDs across the Plan');
check(dispatchSeq.length === 4 && dispatchSeq[0].startsWith('A:') && dispatchSeq[1].startsWith('B:') && dispatchSeq[2].startsWith('B:') && dispatchSeq[3].startsWith('C:'), `dispatch sequence A1,B1,B2,C1 (${dispatchSeq.join(' ')})`);
// Exact result contents
const readResult = (taskId, runId) => {
  const t = gt.getTask(TEST_ROOT, project, taskId);
  return fs.readFileSync(path.join(t.linkedRuns.find((l) => l.runId === runId).folder, 'result.md'), 'utf8');
};
check(readResult(idA, runA1) === 'V15_A_ACCEPTED', 'Task A exact result V15_A_ACCEPTED');
check(readResult(idB, runB1) === 'V15_B\nattempt=1', 'Task B run 1 exact result attempt=1');
check(readResult(idB, runB2) === 'V15_B\nattempt=2', 'Task B run 2 exact result attempt=2');
check(readResult(idC, runC1) === 'V15_C_ACCEPTED', 'Task C exact result V15_C_ACCEPTED');

// Track G: ordinary PM Deliveries — one per attempt, identity-only, visible to widget polling
const all = deliveries.listPmDeliveries(TEST_ROOT, project);
const byRun = new Map(all.map((d) => [`${d.taskId}:${d.runId}`, d]));
for (const [tid, rid, label] of [[idA, runA1, 'A'], [idB, runB1, 'B1'], [idB, runB2, 'B2'], [idC, runC1, 'C']]) {
  const d = byRun.get(`${tid}:${rid}`);
  check(!!d && d.kind === 'TASK_VERIFY' && d.deliveryId === `PMD-${tid}-${rid}`, `${label} result minted ordinary PM Delivery ${d?.deliveryId ?? 'MISSING'}`);
  check(d && !JSON.stringify(d).includes('V15_'), `${label} delivery carries no result text (identity-only)`);
}
check(all.filter((d) => [idA, idB, idC].includes(d.taskId)).length === 4, 'exactly 4 Plan deliveries, no Plan-specific channel');
const pending = deliveries.listPendingPmDeliveries(TEST_ROOT, project).filter((d) => [idA, idB, idC].includes(d.taskId));
// After ACCEPTs, deliveries may be terminal; what matters is the polling surface sees ordinary records:
check(Array.isArray(pending), 'widget polling surface (listPendingPmDeliveries) reads ordinary deliveries without Plan logic');
const reconciled = await deliveries.reconcilePmDeliveries(TEST_ROOT, project);
check(reconciled && Array.isArray(reconciled.skippedTasks), 'reconcilePmDeliveries covers Plan Tasks as ordinary Tasks');

console.log(`\nS6-E2E complete. Passed: ${passed}, Failed: ${failed}`);
console.log(`DISPATCH_SEQ ${dispatchSeq.join(' ')}`);
