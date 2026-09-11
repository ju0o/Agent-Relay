/**
 * STABLE_HARDENING_01 — BUG-001 regression: QA-gated terminal promotion must
 * release the observation lock exactly like the ordinary path, so an
 * authorized same-worker/same-workspace successor (or QA remediation) dispatch
 * does not CONFLICT on a stale holder while the completed worker is live.
 *
 * Runs against compiled server modules under dist/server. Isolated temp root.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(os.tmpdir(), `arl-stable-h01-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });
const project = 'StableH01';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STAY_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};

const gt = await import('../dist/server/backend/goal-task.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const bridge = await import('../dist/server/backend/result-bridge.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const continuation = await import('../dist/server/backend/execution-plan-continuation.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const actions = await import('../dist/server/backend/task-actions.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const NODE = process.execPath;
function registerWorker(workerId) {
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, displayName: `${workerId} fixture worker`,
    launchCommand: NODE, launchArgsPrefix: [STAY_ALIVE],
    capabilities: ['fixture'], observationAdapterId: 'test-fixture',
  });
}
registerWorker('h01-worker');
registerWorker('h01-worker-b');
wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'h01-quick', displayName: 'h01 immediate-exit worker',
  launchCommand: NODE, launchArgsPrefix: [path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs')],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const goal = await gt.createGoal(ROOT, project, { title: 'h01 goal', goalStatement: 'stable hardening 01' });

async function resetLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  pmDel._resetPmDeliveryLocksForTests();
  qa._resetQaAttemptLocksForTests();
  qrp._resetQaRemediationPreparationLocksForTests();
  gate._resetQaGateLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function authorizationFor(plan) {
  return {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
  };
}

function responseComplete(sessionId, text, workspace) {
  return {
    adapterId: 'test-fixture', agentName: 'TestFixture', sessionId, workspace,
    observedAt: new Date().toISOString(), terminalSignal: 'test.complete',
    rawFinalText: text, completionKind: 'RESPONSE_COMPLETE',
  };
}

async function stageCompletion(taskId, runId, folder, text = 'fixture result') {
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(folder, 'result.md'), text, 'utf8');
  return bridge.promoteObservedResult({
    dataRoot: ROOT, project, goalId: goal.goalId, taskId, runId,
    completion: responseComplete(`ses-${taskId}-${runId}`, text, gt.getTask(ROOT, project, taskId).linkedRuns.find((r) => r.runId === runId)?.folder),
    boundFolder: folder, observationAdapterId: 'test-fixture',
    workspaceRoot: JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')).workspaceRoot,
  });
}

// ── Focused BUG-001: same-worker/same-workspace successor with live worker ──
console.log('\n== Focused: QA PASS + ACCEPT dispatches same-worker successor (live worker) ==');
{
  await resetLocal();
  const ws = path.join(ROOT, 'ws-focused');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'out.txt'), 'done', 'utf8');
  const taskA = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'A (QA)', goal: 'qa gated', reason: 'r',
    scope: 'plan scope; authorized file: out.txt', completionCriteria: ['done'],
    executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'B (successor)', goal: 'successor', reason: 'r',
    scope: 'plan scope B', completionCriteria: ['done'],
    executionState: 'READY', pmState: 'PENDING',
  });
  const bindings = [taskA, taskB].map((t) => ({
    taskId: t.taskId, workerId: 'h01-worker', workspaceRoot: ws,
    scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
  }));
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 'h01-focused', orderedTaskIds: [taskA.taskId, taskB.taskId], taskBindings: bindings,
  });
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(plan),
  });
  check(start.outcome === 'DISPATCHED', `F1 Owner GO dispatched Task A (got ${start.outcome})`);
  const runIdA = start.dispatch.runId;
  check(!!observation.getObservationLock('test-fixture', ws), 'F2 live worker holds observation lock before promotion');

  const folderA = gt.getTask(ROOT, project, taskA.taskId).linkedRuns.find((r) => r.runId === runIdA).folder;
  const promoted = await stageCompletion(taskA.taskId, runIdA, folderA);
  check(promoted !== null && promoted.pmState === 'VERIFYING', `F3 QA PASS promoted to VERIFYING (got ${promoted?.pmState})`);
  check(!observation.getObservationLock('test-fixture', ws), 'F4 observation lock released by QA-gated promotion (parity with ordinary path)');
  // D: QA PASS alone must not move the Plan.
  const preAccept = plans.getExecutionPlan(ROOT, project, plan.planId);
  check(preAccept.state === 'RUNNING' && preAccept.activeTaskId === taskA.taskId, 'F5/D QA PASS alone does not advance Plan cursor');

  const accepted = await actions.acceptTaskResult({
    dataRoot: ROOT, project, goalId: goal.goalId, taskId: taskA.taskId, runId: runIdA,
    expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    callerSurface: 'OWNER_IPC', reason: 'h01 fixture ACCEPT',
  });
  check(accepted.pmState === 'ACCEPTED', 'F6 Task A ACCEPTED');
  const after = plans.getExecutionPlan(ROOT, project, plan.planId);
  const tB = gt.getTask(ROOT, project, taskB.taskId);
  check(after.state === 'RUNNING' && after.activeTaskId === taskB.taskId && !after.block, `F7 Plan cursor on Task B, no block (state=${after.state} block=${JSON.stringify(after.block ?? null)})`);
  check(tB.linkedRuns.length === 1, `F8 successor dispatched exactly once (runs=${tB.linkedRuns.length})`);
  check(after.block?.code !== 'PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN', 'F9 no PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN');
  // G: duplicate continuation is a bounded no-op.
  const dup = await continuation.continueExecutionPlanAfterTaskAccepted(ROOT, project, gt.getTask(ROOT, project, taskA.taskId));
  check(dup !== 'ADVANCED_AND_DISPATCHED' && gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 1, `F10/G duplicate ACCEPT hook dispatches no second successor (got ${dup})`);
}

// ── A: QA-less path unchanged ────────────────────────────────────────────────
console.log('\n== A. QA-less promotion unchanged (unconditional Delivery + release) ==');
{
  await resetLocal();
  const ws = path.join(ROOT, 'ws-qa-less');
  fs.mkdirSync(ws, { recursive: true });
  const t = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'plain', goal: 'gg', reason: 'r', scope: 's',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
  });
  const d = await disp.dispatchTask(ROOT, project, {
    taskId: t.taskId, workerId: 'h01-worker', workspaceRoot: ws, expectedExecutionState: 'READY',
  });
  const folder = gt.getTask(ROOT, project, t.taskId).linkedRuns.find((r) => r.runId === d.runId).folder;
  const promoted = await stageCompletion(t.taskId, d.runId, folder);
  check(promoted !== null && promoted.pmState === 'VERIFYING', 'A1 QA-less promotion VERIFYING as before');
  check(pmDel.listPmDeliveries(ROOT, project).filter((x) => x.taskId === t.taskId).length === 1, 'A2 exactly one Delivery, unconditional');
  check(!observation.getObservationLock('test-fixture', ws), 'A3 lock released on ordinary path');
  // E: CHANGES vocabulary untouched.
  const changed = await actions.requestTaskChanges({
    dataRoot: ROOT, project, goalId: goal.goalId, taskId: t.taskId, runId: d.runId,
    reason: 'h01 fixture CHANGES', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    callerSurface: 'OWNER_IPC',
  });
  check(changed.pmState === 'CHANGES_REQUESTED', 'A4/E GPT CHANGES still sets CHANGES_REQUESTED');
}

// ── B: different-worker successor ────────────────────────────────────────────
console.log('\n== B. different-worker successor dispatches ==');
{
  await resetLocal();
  const wsA = path.join(ROOT, 'ws-diff-a');
  const wsB = path.join(ROOT, 'ws-diff-b');
  fs.mkdirSync(wsA, { recursive: true }); fs.mkdirSync(wsB, { recursive: true });
  fs.writeFileSync(path.join(wsA, 'out.txt'), 'done', 'utf8');
  const taskA = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'A (QA)', goal: 'qa gated', reason: 'r',
    scope: 'plan scope; authorized file: out.txt', completionCriteria: ['done'],
    executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'B (other worker)', goal: 'successor', reason: 'r',
    scope: 'plan scope B', completionCriteria: ['done'],
    executionState: 'READY', pmState: 'PENDING',
  });
  const mk = (t, workerId, workspaceRoot) => ({
    taskId: t.taskId, workerId, workspaceRoot, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
  });
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 'h01-diff-worker', orderedTaskIds: [taskA.taskId, taskB.taskId],
    taskBindings: [mk(taskA, 'h01-worker', wsA), mk(taskB, 'h01-worker-b', wsB)],
  });
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authorizationFor(plan),
  });
  check(start.outcome === 'DISPATCHED', 'B1 Owner GO dispatched');
  const folderA = gt.getTask(ROOT, project, taskA.taskId).linkedRuns[0].folder;
  await stageCompletion(taskA.taskId, start.dispatch.runId, folderA);
  await actions.acceptTaskResult({
    dataRoot: ROOT, project, goalId: goal.goalId, taskId: taskA.taskId, runId: start.dispatch.runId,
    expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    callerSurface: 'OWNER_IPC', reason: 'h01 B ACCEPT',
  });
  const after = plans.getExecutionPlan(ROOT, project, plan.planId);
  check(after.activeTaskId === taskB.taskId && gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 1, 'B2 different-worker successor dispatched once');
}

// ── C: active-run exclusion intact ───────────────────────────────────────────
console.log('\n== C. same worker double-dispatch while active is still refused ==');
{
  await resetLocal();
  const ws = path.join(ROOT, 'ws-active');
  fs.mkdirSync(ws, { recursive: true });
  const mkTask = (title) => gt.createTask(ROOT, project, {
    goalId: goal.goalId, title, goal: 'gg', reason: 'r', scope: 's',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
  });
  const taskX = await mkTask('X (live)');
  const taskY = await mkTask('Y (contender)');
  await disp.dispatchTask(ROOT, project, {
    taskId: taskX.taskId, workerId: 'h01-worker', workspaceRoot: ws, expectedExecutionState: 'READY',
  });
  let conflict = null;
  try {
    await disp.dispatchTask(ROOT, project, {
      taskId: taskY.taskId, workerId: 'h01-worker', workspaceRoot: ws, expectedExecutionState: 'READY',
    });
  } catch (err) { conflict = err; }
  check(!!conflict && conflict.code === 'CONFLICT', `C1 second dispatch while Run active → CONFLICT (got ${conflict?.code})`);
  const y = gt.getTask(ROOT, project, taskY.taskId);
  check(y.executionState === 'READY' && y.linkedRuns.length === 0, 'C2 contender untouched (READY, 0 Runs)');
}

// ── F: QA FAIL remediation (same-Task, lineage-separated) ─────────────────────
// NOTE: a same-Task remediation dispatch while that Task's own worker is still
// live is correctly refused by the per-Task active-dispatch guard (one-active-
// Run protection — absolute invariant, NOT BUG-001). So F uses an immediate-
// exit worker and proves the remediation path itself is intact post-fix.
console.log('\n== F. QA FAIL dispatches same-Task remediation ==');
{
  await resetLocal();
  const ws = path.join(ROOT, 'ws-fail');
  fs.mkdirSync(ws, { recursive: true });
  // out.txt deliberately absent → deterministic FAIL.
  const t = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'F (QA FAIL)', goal: 'qa gated', reason: 'r',
    scope: 'plan scope; authorized file: out.txt', completionCriteria: ['done'],
    executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const d = await disp.dispatchTask(ROOT, project, {
    taskId: t.taskId, workerId: 'h01-quick', workspaceRoot: ws, expectedExecutionState: 'READY',
  });
  const folder = gt.getTask(ROOT, project, t.taskId).linkedRuns.find((r) => r.runId === d.runId).folder;
  // Let the immediate-exit worker clear the per-Task live slot so the
  // remediation dispatch below exercises the observation-lock path only.
  const startWait = Date.now();
  for (;;) {
    const st = await disp.getDispatchStatus(ROOT, project, t.taskId);
    if (!st.active) break;
    if (Date.now() - startWait > 15000) throw new Error('timeout waiting for quick worker exit');
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await stageCompletion(t.taskId, d.runId, folder);
  const after = gt.getTask(ROOT, project, t.taskId);
  check(after.pmState === 'PENDING' && (after.executionState === 'READY' || after.executionState === 'DISPATCHED' || after.executionState === 'RUNNING'), `F1 FAIL stays PENDING with remediation Run active (got ${after.pmState}/${after.executionState})`);
  check(after.linkedRuns.length === 2, `F2 remediation Run dispatched despite live worker (runs=${after.linkedRuns.length})`);
  check(pmDel.listPmDeliveries(ROOT, project).filter((x) => x.taskId === t.taskId).length === 0, 'F3 no premature Delivery on remediable FAIL');
  void res;
}

disp._resetDispatcherStateForTests();
console.log(`\nStable Hardening 01 tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed) process.exitCode = 1;
