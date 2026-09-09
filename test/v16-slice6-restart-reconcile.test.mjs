/**
 * V1.6 Slice 6 — Restart / Reconcile: crash recovery at every QA Gate seam.
 * Runs against compiled server modules under dist/server.
 *
 * Plan SSOT: docs/V16-QA-GATE-PLAN-01.md §14 (8 seams), §16 (restart rows,
 * duplicate-reconcile row, Plan-interaction row), §8/§11/§12.
 *
 * Method: deterministic crash-state simulation. Each section constructs the
 * EXACT durable state a crash at that seam would leave behind (real kernel
 * records + real Task transitions, never hand-fabricated verdicts), optionally
 * wipes all process-local locks (simulating restart amnesia — durable state
 * is the only authority), then calls reconcileQaGate and asserts exactly-once
 * resume: no invented success, no replayed Worker work, no duplicated QA
 * attempts / remediation Runs / Deliveries, no Task corruption, no Plan move.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s6-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};
async function throwsWithCode(fn, code, message) {
  try {
    await fn();
    check(false, `${message} (did not throw)`);
  } catch (err) {
    check(err && err.code === code, `${message} (got code=${err && err.code}: ${err && err.message})`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gt = await import('../dist/server/backend/goal-task.js');
const gtr = await import('../dist/server/backend/goal-task-runtime.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const fsKernel = await import('../dist/server/backend/fs.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const project = 'V16Slice6';
const NODE = process.execPath;
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ZERO_FIXTURE = path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs');

wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 's6-worker', displayName: 's6 fixture implementation worker',
  launchCommand: NODE, launchArgsPrefix: [EXIT_ZERO_FIXTURE],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

// Fake semantic QA workers with an invocation marker file.
const FAKE_QA_DIR = path.join(ROOT, '_fake-qa-workers');
fs.mkdirSync(FAKE_QA_DIR, { recursive: true });
let qaWorkerCounter = 0;
function registerFakeQaWorker(script) {
  qaWorkerCounter += 1;
  const workerId = `s6-qa-${qaWorkerCounter}`;
  const scriptPath = path.join(FAKE_QA_DIR, `${workerId}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: NODE, launchArgsPrefix: [scriptPath], role: 'qa',
  });
  return workerId;
}
const PASS_SCRIPT = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: PASS');\nconsole.log('criteria:');\nfor (const id of ids) console.log('- ' + id + ': PASS');\n`;

let idCounter = 0;
let goalCache = null;
async function goal() {
  if (!goalCache) goalCache = await gt.createGoal(ROOT, project, { title: 'S6 goal', goalStatement: 'S6 fixture goal' });
  return goalCache;
}

function detContract() {
  return {
    acceptanceCriteria: [{ id: 'AC-01', description: 'output file out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  };
}
function semContract(qaWorkerId) {
  return {
    acceptanceCriteria: [{ id: 'AC-01', description: 'output expresses correct status', validationMode: 'SEMANTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId } },
  };
}

async function makeQaTask({ semantic = false, qaWorkerId = null } = {}) {
  const g = await goal();
  const c = semantic ? semContract(qaWorkerId) : detContract();
  return gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'S6 QA task', goal: 'S6 fixture task', reason: 'fixture',
    scope: 'fixture scope; authorized file: out.txt',
    completionCriteria: ['fixture done'], executionState: 'RUNNING', pmState: 'PENDING',
    acceptanceCriteria: c.acceptanceCriteria, qaContract: c.qaContract,
  });
}

async function linkRun(taskId, { resultText = 'fixture result', capture = true } = {}) {
  idCounter += 1;
  const n = idCounter;
  const workspaceRoot = path.join(ROOT, 'ws', `t-${n}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', `run-${n}`);
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s6-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 's6-worker' }), 'utf8');
  const task = await gt.linkRunToTask(ROOT, project, taskId, folder);
  const link = task.linkedRuns.find((r) => r.runId === runId);
  if (capture) {
    fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
    fs.writeFileSync(path.join(folder, 'result.md'), resultText, 'utf8');
  }
  return { runId, folder, workspaceRoot, taskRunSequence: link.taskRunSequence };
}

async function receive(taskId, runId) {
  return gtr.markQaResultReceived(ROOT, project, taskId, runId);
}
function release(taskId, runId, workspaceRoot) {
  observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId, runId });
}
async function waitForNoLive(taskId, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const st = await disp.getDispatchStatus(ROOT, project, taskId);
    if (!st.active) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for live dispatch: ${taskId}`);
    await sleep(50);
  }
}
/** Simulate a runtime restart: ALL process-local memory (locks, dispatcher
 * state, capture sessions) is forgotten. Durable state is the only authority
 * a post-restart reconcile may use. */
async function simulateRestart() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  pmDel._resetPmDeliveryLocksForTests();
  qa._resetQaAttemptLocksForTests();
  qrp._resetQaRemediationPreparationLocksForTests();
  gate._resetQaGateLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}
function attemptsFor(taskId) {
  return qa.listQaAttemptsForTask(ROOT, project, taskId);
}
function prepsFor(taskId) {
  return qrp.listQaRemediationPreparations(ROOT, project).filter((p) => p.taskId === taskId);
}
function deliveriesFor(taskId) {
  return pmDel.listPmDeliveries(ROOT, project).filter((d) => d.taskId === taskId);
}
/** Complete the CURRENT run (write capture + result + optional workspace
 * files), receive it, and reconcile — the live-trigger path. */
async function completeCurrentRunAndReconcile(taskId, { resultText = 'fixture result', files = {} } = {}) {
  const t = gt.getTask(ROOT, project, taskId);
  const latest = [...t.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const meta = fsKernel.readRunMeta(latest.folder);
  fs.mkdirSync(path.join(latest.folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(latest.folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(latest.folder, 'result.md'), resultText, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(meta.workspaceRoot, rel), content, 'utf8');
  }
  release(taskId, latest.runId, meta.workspaceRoot);
  await receive(taskId, latest.runId);
  const res = await gate.reconcileQaGate(ROOT, project, taskId);
  await waitForNoLive(taskId);
  return res;
}

// ── SEAM 1: Result captured, deterministic QA not started ────────────────────
console.log('\n== SEAM 1: captured Result, no QA attempt → evaluate → FAIL → remediate ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  check(attemptsFor(task.taskId).length === 0, 'S1 crash state: Result captured, zero QA attempts');
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S1 resume: FAIL → remediation dispatched');
  check(attemptsFor(task.taskId).length === 1, 'S1 exactly one QA attempt created');
  check(prepsFor(task.taskId).length === 1, 'S1 exactly one preparation created');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'S1 exactly one remediation Run');
  check(deliveriesFor(task.taskId).length === 0, 'S1 no PM Delivery on FAIL');
}

// ── SEAM 2: deterministic done, semantic QA not started (stale sub-run) ──────
console.log('\n== SEAM 2: deterministic PASS persisted, stale sub-run folder, semantic never ran ==');
{
  const marker = path.join(ROOT, 's6-seam2.marker');
  fs.writeFileSync(marker, '', 'utf8');
  const qaWorkerId = registerFakeQaWorker(PASS_SCRIPT(marker));
  const task = await makeQaTask({ semantic: true, qaWorkerId });
  const r1 = await linkRun(task.taskId);
  fs.writeFileSync(path.join(r1.workspaceRoot, 'out.txt'), 'ok', 'utf8');
  await receive(task.taskId, r1.runId);
  // Crash-state construction: deterministic PASS persisted, semantic absent.
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1,
    qaWorkerId, criteriaValidationModes: { 'AC-01': 'SEMANTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'PASS', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'out.txt', criterionId: 'AC-01' }],
  });
  // A stale in-flight sub-run folder with junk output but no persisted verdict.
  const staleDir = path.join(ROOT, project, '_relay', 'qa-semantic-runs', qaAttemptId);
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'attempt-1-stdout.txt'), 'junk from a dead process, no verdict', 'utf8');
  await simulateRestart();
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  const marks = fs.readFileSync(marker, 'utf8').length;
  check(res.outcome === 'PASS_DELIVERED', 'S2 resume: semantic runs once → PASS → delivered');
  check(marks === 1, `S2 stale sub-run treated as never-started: exactly 1 QA-agent invocation (got ${marks})`);
  check(attemptsFor(task.taskId).length === 1, 'S2 still exactly one QA attempt (no duplicate evaluation)');
  const now = fs.readFileSync(path.join(staleDir, 'attempt-1-stdout.txt'), 'utf8');
  check(now.includes('status: PASS'), 'S2 stale junk output overwritten by the real invocation');
  check(deliveriesFor(task.taskId).length === 1, 'S2 exactly one Delivery');
}

// ── SEAM 3: FAIL terminal, remediation not dispatched ────────────────────────
console.log('\n== SEAM 3: FAIL terminal, no preparation → create prep → dispatch exactly once ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing out.txt', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  await simulateRestart();
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED' && res.alreadyDispatched === false, 'S3 resume: preparation created + exactly one dispatch');
  check(prepsFor(task.taskId).length === 1, 'S3 exactly one preparation (no duplicate)');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'S3 exactly one remediation Run');
  const prep = prepsFor(task.taskId)[0];
  check(prep.dispatchedRunId === res.remediationRunId && prep.status === 'READY', 'S3 preparation consumed by the single dispatched Run');
}

// ── SEAM 4a: prep READY undispatched, crash between prep commit and dispatch ──
console.log('\n== SEAM 4a: READY prep, no Run, Task still RESULT_RECEIVED → dispatch once ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  // Crash window: preparation committed (and linked) but dispatch never ran —
  // Task still RESULT_RECEIVED+PENDING, no new Run anywhere.
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: qaAttemptId, taskId: task.taskId, sourceRunId: r1.runId,
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: qaAttemptId,
    workerId: 's6-worker', workspaceRoot: r1.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, qaAttemptId, prep.preparationId);
  await simulateRestart();
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S4a resume: undispatched READY prep → exactly one dispatch');
  check(prepsFor(task.taskId).length === 1, 'S4a no second preparation minted');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'S4a exactly one remediation Run total');
}

// ── SEAM 4b: prep READY undispatched, correlated Run already materialized ─────
console.log('\n== SEAM 4b: READY prep + materialized Run, no consume marker → adopt, never spawn ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: qaAttemptId, taskId: task.taskId, sourceRunId: r1.runId,
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: qaAttemptId,
    workerId: 's6-worker', workspaceRoot: r1.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, qaAttemptId, prep.preparationId);
  // Crash window: dispatch commit materialized the Run (linked, correlated
  // meta) but the consumption marker was never written; Task already READY.
  const g = await goal();
  await gtr.requestQaRemediationRetry(ROOT, project, task.taskId, { goalId: g.goalId, reason: 'qa-remediation:seam4b' });
  idCounter += 1;
  const craftedRunId = `s6-run-${idCounter}-adopt`;
  const craftedFolder = path.join(ROOT, project, '_fixture-runs', `run-${idCounter}-adopt`);
  fs.mkdirSync(craftedFolder, { recursive: true });
  fs.writeFileSync(path.join(craftedFolder, 'meta.json'), JSON.stringify({
    tags: [], runId: craftedRunId, workspaceRoot: r1.workspaceRoot, workerId: 's6-worker',
    qaRemediationPreparationId: prep.preparationId, sourceRunId: r1.runId,
  }), 'utf8');
  await gt.linkRunToTask(ROOT, project, task.taskId, craftedFolder);
  await simulateRestart();
  const runsBefore = gt.getTask(ROOT, project, task.taskId).linkedRuns.length;
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  const after = gt.getTask(ROOT, project, task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_ADOPTED' && res.remediationRunId === craftedRunId, 'S4b resume: materialized Run adopted, never a second spawn');
  check(after.linkedRuns.length === runsBefore, 'S4b linked Run count unchanged (no duplicate Worker)');
  const prepNow = qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId);
  check(prepNow.dispatchedRunId === craftedRunId, 'S4b adoption persisted as the consumption marker');
}

// ── SEAM 5a: QA PASS terminal, PM Delivery not created ───────────────────────
console.log('\n== SEAM 5a: PASS terminal, no Delivery → mint exactly once, duplicate is no-op ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  fs.writeFileSync(path.join(r1.workspaceRoot, 'out.txt'), 'ok', 'utf8');
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'PASS', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'out.txt', criterionId: 'AC-01' }],
  });
  await qa.completeQaAttempt(ROOT, project, qaAttemptId, { finalQaStatus: 'PASS' });
  await simulateRestart();
  const res1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res1.outcome === 'PASS_DELIVERED', 'S5a resume: PASS → ordinary Delivery minted');
  check(deliveriesFor(task.taskId).length === 1, 'S5a exactly one Delivery');
  const res2 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res2.outcome === 'PASS_DELIVERED' && res2.deliveryId === res1.deliveryId, 'S5a duplicate reconcile is a bounded no-op (same Delivery)');
  check(deliveriesFor(task.taskId).length === 1, 'S5a still exactly one Delivery after duplicate');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.pmState === 'VERIFYING' && t.acceptedRunId === undefined, 'S5a Task VERIFYING, never ACCEPTED by QA');
}

// ── SEAM 5b: budget-exhausted FAIL, restart before + after escalation ────────
console.log('\n== SEAM 5b: 3rd FAIL (budget exhausted) → escalate once, re-escalation is no-op ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  // Run 1 FAIL → remediation → Run 2 (real dispatches, instant fixture).
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S5b run 1 FAIL → remediation');
  // Run 2 FAIL → remediation → Run 3.
  const f2 = await completeCurrentRunAndReconcile(task.taskId);
  check(f2.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S5b run 2 FAIL → remediation');
  // Crash before run 3 is evaluated.
  await simulateRestart();
  // Run 3 FAIL → budget exhausted → escalate (no Run 4).
  const f3 = await completeCurrentRunAndReconcile(task.taskId);
  check(f3.outcome === 'FAIL_ESCALATED_BUDGET_EXHAUSTED', 'S5b run 3 FAIL → escalation, never Run 4');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 3, 'S5b exactly 3 Runs (no 4th)');
  check(prepsFor(task.taskId).length === 2, 'S5b exactly 2 preparations (budget = 2)');
  check(deliveriesFor(task.taskId).length === 1, 'S5b exactly one escalation Delivery');
  const vers = attemptsFor(task.taskId).map((a) => a.finalQaStatus);
  check(JSON.stringify(vers) === JSON.stringify(['FAIL', 'FAIL', 'FAIL']), 'S5b three terminal FAIL attempts, none invented');
  // Restart after escalation: re-escalation collapses to the same Delivery.
  await simulateRestart();
  const f4 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(f4.outcome === 'FAIL_ESCALATED_BUDGET_EXHAUSTED' && f4.deliveryId === f3.deliveryId, 'S5b duplicate post-escalation reconcile is a no-op');
  check(deliveriesFor(task.taskId).length === 1 && prepsFor(task.taskId).length === 2, 'S5b counts unchanged after duplicate');
}

// ── SEAM 7-post-dispatch: duplicate call with a result-less new Run ──────────
console.log('\n== SEAM 7b: duplicate reconcile after dispatch (new Run has no Result) → BLOCKED, resumable ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S7b remediation dispatched (Run 2, no Result yet)');
  // A duplicate trigger now targets Run 2, which has no captured Result:
  // it must refuse without state corruption — resumable when Run 2 completes.
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'BLOCKED', 'S7b duplicate pre-Result reconcile refuses BLOCKED');
  check(prepsFor(task.taskId).length === 1, 'S7b no second preparation from the duplicate');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'S7b no second remediation Run from the duplicate');
  check(deliveriesFor(task.taskId).length === 0, 'S7b no Delivery from the duplicate');
  // And the Task resumes normally once Run 2 actually completes.
  const f2 = await completeCurrentRunAndReconcile(task.taskId, { files: { 'out.txt': 'fixed' } });
  check(f2.outcome === 'PASS_DELIVERED', 'S7b Run 2 completion resumes to PASS + Delivery');
}

// ── SEAM 8: concurrent duplicate remediation triggers collapse to one ────────
console.log('\n== SEAM 8: two concurrent reconciles on one FAIL → single prep + single Run ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  await simulateRestart();
  // The per-task lock serializes the two callers. The winner dispatches Run 2
  // (linked) before the loser acquires the lock; the loser then re-reads
  // fresh state, finds the new current Run 2 with no captured Result yet, and
  // refuses BLOCKED (resumable) instead of fabricating an adoption it never
  // caused. Seam 8's core requirement — collapse to ONE dispatch — holds.
  const [c1, c2] = await Promise.allSettled([
    gate.reconcileQaGate(ROOT, project, task.taskId),
    gate.reconcileQaGate(ROOT, project, task.taskId),
  ]);
  await waitForNoLive(task.taskId);
  const winner = [c1, c2].find((c) => c.status === 'fulfilled');
  const loser = [c1, c2].find((c) => c.status === 'rejected');
  check(winner?.value?.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S8 one caller dispatches the single remediation Run');
  check(loser?.reason?.code === 'BLOCKED', `S8 loser refuses resumable-BLOCKED, never a second dispatch (got code=${loser?.reason?.code})`);
  check(prepsFor(task.taskId).length === 1, 'S8 exactly one preparation across both callers');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'S8 exactly one remediation Run across both callers');
  check(deliveriesFor(task.taskId).length === 0, 'S8 no Delivery from either caller on the FAIL path');
  // The loser's BLOCKED was resumable, not terminal: Run 2 completes normally.
  const f2 = await completeCurrentRunAndReconcile(task.taskId, { files: { 'out.txt': 'fixed' } });
  check(f2.outcome === 'PASS_DELIVERED', 'S8 Run 2 completion resumes to PASS + Delivery');
}

// ── CORRUPT durable QA record → fail closed, never recreated ─────────────────
console.log('\n== CORRUPT: hand-corrupted qa.json → CORRUPT_RECORD, nothing minted ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  const folder = path.join(ROOT, project, '_relay', 'qa-attempts', qaAttemptId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'qa.json'), '{corrupt-json, not parseable', 'utf8');
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'CORRUPT_RECORD', 'S9 corrupt attempt fails closed');
  check(prepsFor(task.taskId).length === 0, 'S9 no preparation over corrupt state');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'S9 no remediation Run over corrupt state');
  check(deliveriesFor(task.taskId).length === 0, 'S9 no Delivery over corrupt state');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'PENDING', 'S9 Task state untouched by corrupt record');
}

// ── CORRUPT preparation record → fail closed, never re-dispatched ────────────
console.log('\n== CORRUPT: hand-corrupted preparation.json → CORRUPT_RECORD, no dispatch ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: qaAttemptId, taskId: task.taskId, sourceRunId: r1.runId,
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: qaAttemptId,
    workerId: 's6-worker', workspaceRoot: r1.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, qaAttemptId, prep.preparationId);
  fs.writeFileSync(
    path.join(ROOT, project, '_relay', 'qa-remediation-preparations', prep.preparationId, 'preparation.json'),
    '[broken',
    'utf8',
  );
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'CORRUPT_RECORD', 'S10 corrupt preparation fails closed');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'S10 no remediation Run over corrupt preparation');
  check(deliveriesFor(task.taskId).length === 0, 'S10 no Delivery over corrupt preparation');
}

// ── LINKAGE MISMATCH: preparation bound to a ghost Run → refuse ──────────────
console.log('\n== MISMATCH: preparation sourceRunId not linked → INVALID_STATE, no dispatch ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId: r1.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, qaAttemptId, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  // Same deterministic prep id (discoverable by the gate) but a ghost source Run.
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: qaAttemptId, taskId: task.taskId, sourceRunId: 'ghost-run-never-linked',
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: qaAttemptId,
    workerId: 's6-worker', workspaceRoot: r1.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, qaAttemptId, prep.preparationId);
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'INVALID_STATE', 'S11 ghost-Run preparation refused');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'S11 no Run dispatched from mismatched preparation');
  check(deliveriesFor(task.taskId).length === 0, 'S11 no Delivery from mismatched preparation');
}

// ── STALE STATE: old terminal FAIL never re-fires after the Task moved on ────
console.log('\n== STALE: consumed FAIL lineage stays consumed once the Task moved on ==');
{
  const task = await makeQaTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S12 run 1 FAIL → remediation');
  const f2 = await completeCurrentRunAndReconcile(task.taskId, { files: { 'out.txt': 'fixed' } });
  check(f2.outcome === 'PASS_DELIVERED', 'S12 run 2 PASS → delivered');
  await simulateRestart();
  const f3 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(f3.outcome === 'PASS_DELIVERED' && f3.deliveryId === f2.deliveryId, 'S12 post-restart reconcile targets the current PASS only');
  check(prepsFor(task.taskId).length === 1, 'S12 consumed FAIL prep never re-fires');
  check(deliveriesFor(task.taskId).length === 1, 'S12 still exactly one Delivery');
}

// ── PLAN CURSOR: crash-framed QA never advances the Plan ─────────────────────
console.log('\n== PLAN: restart-framed FAIL then PASS never moves activeTaskId ==');
{
  const g = await goal();
  const wsP = path.join(ROOT, 'ws', 'plan-p');
  fs.mkdirSync(wsP, { recursive: true });
  const taskA = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan A', goal: 'A', reason: 'r', scope: 'plan scope A; authorized file: out.txt',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'AC-01', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan B', goal: 'successor', reason: 'r', scope: 'plan scope B',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
  });
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 's6-plan', orderedTaskIds: [taskA.taskId, taskB.taskId],
    taskBindings: [taskA, taskB].map((t) => ({
      taskId: t.taskId, workerId: 's6-worker', workspaceRoot: wsP, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
    })),
  });
  const authz = {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
  };
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authz,
  });
  check(start.outcome === 'DISPATCHED', 'S13 plan started');
  const activeBefore = plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId;
  check(activeBefore === taskA.taskId, 'S13 cursor on A after start');
  await waitForNoLive(taskA.taskId);
  // Run 1 FAILs QA (no out.txt) → restart → reconcile → same-Task remediation only.
  await simulateRestart();
  const r1 = await completeCurrentRunAndReconcile(taskA.taskId);
  check(r1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'S13 post-restart FAIL → remediation');
  check(plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId === taskA.taskId, 'S13 cursor stays on A after QA FAIL');
  check(gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 0, 'S13 successor B never starts on QA FAIL');
  // Run 2 PASSes QA → ordinary Delivery, still no ACCEPT / no advancement.
  await simulateRestart();
  const r2 = await completeCurrentRunAndReconcile(taskA.taskId, { files: { 'out.txt': 'fixed' } });
  check(r2.outcome === 'PASS_DELIVERED', 'S13 post-restart PASS → delivered');
  check(plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId === taskA.taskId, 'S13 cursor stays on A after QA PASS');
  check(gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 0, 'S13 successor B still never starts');
  const aNow = gt.getTask(ROOT, project, taskA.taskId);
  check(aNow.pmState === 'VERIFYING' && aNow.acceptedRunId === undefined, 'S13 Task A VERIFYING but NOT ACCEPTED');
}

console.log(`\nSlice 6 Restart / Reconcile: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
