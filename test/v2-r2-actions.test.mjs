/**
 * V2 slice-1 R2 — guided recovery actions behind explicit Owner confirmation.
 *
 * Covers (fixtures via legit kernel paths; fault injection mirrors the
 * cert-harness precedent and is documented inline):
 *   G-00  confirm firewall: confirmed:false → CONFIRM_REQUIRED + zero mutation,
 *           for every pattern (5/5)
 *   G-01  ORPHANED_DISPATCH + KEEP_WAITING → executed, state preserved
 *   G-02  UNRECOVERED_COMPLETED_RUN without transcript → fail-closed
 *           REJECTED (wiring proof, no kernel bypass)
 *   G-03  CRASHED_PREPARATION (RTP RECEIVED) → reconciled to READY
 *   G-04  CRASHED_PREPARATION (QRP RECEIVED) → refused, no invented transition
 *   G-05  QA_GATE_STALLED → gate runs, deterministic PASS verdict
 *   G-06  MISSING_DELIVERY → delivery minted; re-execution is stale (no-op)
 *   G-07  ORPHANED_DISPATCH without orphanAction → INVALID_ARGUMENT
 *   G-08  unknown taskId → stale not-executed result (not a throw)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v2-r2-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const pmd = await import('../dist/server/backend/pm-delivery.js');
const pmj = await import('../dist/server/backend/pm-judgment.js');
const rtp = await import('../dist/server/backend/retry-preparation.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const qatk = await import('../dist/server/backend/qa-attempt.js');
const act = await import('../dist/server/backend/resume-actions.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const NODE = process.execPath;
const project = 'V2R2Proj';

disp._resetDispatcherStateForTests();

const goal = await gt.createGoal(TEST_ROOT, project, {
  title: 'V2 R2 goal', goalStatement: 'actions test goal',
  permissionPolicy: { mode: 'BYPASS' },
});

async function makeReadyTask(title, extra = {}) {
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title, goal: 'g', reason: 'r', scope: 's', ...extra,
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  return gt.getTask(TEST_ROOT, project, t.taskId);
}

function registerWorker(workerId) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: NODE,
    launchArgsPrefix: [FIX_ZERO], capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
  });
}

async function dispatchInstant(taskId, workerId) {
  registerWorker(workerId);
  const ws = path.join(WORKSPACE, taskId);
  fs.mkdirSync(ws, { recursive: true });
  await disp.dispatchTask(TEST_ROOT, project, {
    taskId, workerId, workspaceRoot: ws, expectedExecutionState: 'READY',
  });
  for (let i = 0; i < 50; i++) {
    const t = gt.getTask(TEST_ROOT, project, taskId);
    if (t.executionState === 'DISPATCHED' || t.executionState === 'RUNNING') return { task: t, ws };
    await sleep(40);
  }
  throw new Error(`never dispatched: ${taskId}`);
}

const taskFileOf = (taskId) => path.join(TEST_ROOT, project, '_relay', 'tasks', taskId, 'task.json');

// Fixtures ---------------------------------------------------------------
const tOrphan = await makeReadyTask('orphan task');
await dispatchInstant(tOrphan.taskId, 'w-r2a');

const tVerify = await makeReadyTask('verify task');
{
  await dispatchInstant(tVerify.taskId, 'w-r2b');
  let t = gt.getTask(TEST_ROOT, project, tVerify.taskId);
  await rt.markResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
}

const tQa = await makeReadyTask('qa task', {
  acceptanceCriteria: [{ id: 'AC-1', description: 'result exists', validationMode: 'DETERMINISTIC' }],
  qaContract: { deterministic: [{ kind: 'fileExists', path: 'result.md', criterionId: 'AC-1' }] },
});
let qaWs = '';
{
  const { task: t, ws } = await dispatchInstant(tQa.taskId, 'w-r2c');
  qaWs = ws;
  fs.writeFileSync(path.join(ws, 'result.md'), '# qa result\n');
  // Post-capture state: the live bridge writes evidence/adapter.json via
  // captureCompletion before receipt. The marker stands in for a completed
  // capture (the R2 action itself calls the real kernel).
  const qFolder = t.linkedRuns[0].folder;
  fs.mkdirSync(path.join(qFolder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(qFolder, 'evidence', 'adapter.json'), JSON.stringify({ captured: true }));
  await rt.markQaResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
}

const tRetry = await makeReadyTask('retry task');
let rtpId = '';
{
  await dispatchInstant(tRetry.taskId, 'w-r2d');
  let t = gt.getTask(TEST_ROOT, project, tRetry.taskId);
  await rt.markResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
  const delivery = await pmd.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t.taskId);
  await pmj.submitPmJudgment(TEST_ROOT, project, {
    deliveryId: delivery.deliveryId, decision: 'CHANGES',
    reason: 'needs more work here', retryInstruction: 'fix it',
  });
  const prep = await rtp.prepareRetryForJudgment(TEST_ROOT, project, delivery.deliveryId);
  rtpId = prep.preparation.preparationId;
  // Crash simulation: regress persisted status to RECEIVED.
  const prepFile = path.join(TEST_ROOT, project, '_relay', 'retry-preparations', rtpId, 'preparation.json');
  const raw = JSON.parse(fs.readFileSync(prepFile, 'utf8'));
  raw.status = 'RECEIVED';
  raw.updatedAt = new Date().toISOString();
  fs.writeFileSync(prepFile, JSON.stringify(raw, null, 2));
}

// Forged QRP RECEIVED (no kernel path produces one — documents the spec gap).
// Uses the real id-derivation helpers so the record is schema-valid.
const tQrp = await makeReadyTask('qrp task');
let qrpId = '';
{
  const t = gt.getTask(TEST_ROOT, project, tQrp.taskId);
  const runId = 'qrpfake01-0000-4000-8000-000000000000';
  const attemptId = qatk.qaAttemptIdFor(t.taskId, runId);
  qrpId = qrp.qaRemediationPreparationIdFor(attemptId);
  const dir = qrp.qaRemediationPreparationFolder(TEST_ROOT, project, qrpId);
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: 1, preparationId: qrpId, project, taskId: t.taskId,
    sourceQaAttemptId: attemptId, sourceRunId: runId, workerId: 'w-r2c',
    workspaceRoot: qaWs || WORKSPACE, status: 'RECEIVED', qaRemediationNumber: 1,
    failedCriteria: ['AC-1'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'preparation.json'), JSON.stringify(rec, null, 2));
}

// G-00: confirm firewall ---------------------------------------------------
console.log('\n-- G-00: confirm firewall --');
{
  const t = gt.getTask(TEST_ROOT, project, tOrphan.taskId);
  const runId = t.linkedRuns[0].runId;
  const cases = [
    { pattern: 'ORPHANED_DISPATCH', taskId: t.taskId, orphanAction: 'KEEP_WAITING' },
    { pattern: 'UNRECOVERED_COMPLETED_RUN', taskId: t.taskId, runId },
    { pattern: 'MISSING_DELIVERY', taskId: tVerify.taskId, runId: gt.getTask(TEST_ROOT, project, tVerify.taskId).linkedRuns[0].runId },
    { pattern: 'QA_GATE_STALLED', taskId: tQa.taskId, runId: gt.getTask(TEST_ROOT, project, tQa.taskId).linkedRuns[0].runId },
    { pattern: 'CRASHED_PREPARATION', taskId: tRetry.taskId, preparationId: rtpId },
  ];
  const before = fs.readFileSync(taskFileOf(t.taskId));
  for (const c of cases) {
    let threw = null;
    try {
      await act.executeGuidedAction(TEST_ROOT, project, { ...c, confirmed: false });
    } catch (e) { threw = e; }
    check(!!threw && threw.code === 'CONFIRM_REQUIRED', `${c.pattern}: CONFIRM_REQUIRED without confirm`);
  }
  check(fs.readFileSync(taskFileOf(t.taskId)).equals(before), 'zero mutation without confirm');
}

// G-01: orphan KEEP_WAITING -------------------------------------------------
console.log('\n-- G-01: orphan keep-waiting --');
{
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'ORPHANED_DISPATCH', taskId: tOrphan.taskId,
    orphanAction: 'KEEP_WAITING', reason: 'R2 test', confirmed: true,
  });
  check(r.executed === true, 'executed');
  const t = gt.getTask(TEST_ROOT, project, tOrphan.taskId);
  check(t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED', 'state preserved (still open)');
}

// G-02: unrecovered without transcript → fail-closed -------------------------
console.log('\n-- G-02: recover fail-closed --');
{
  const t = gt.getTask(TEST_ROOT, project, tOrphan.taskId);
  // Terminal exit-0 launch entry (scan signal), but no transcript/capture —
  // the kernel must fail closed, not promote.
  fs.writeFileSync(
    path.join(t.linkedRuns[0].folder, 'worker-launch.log'),
    JSON.stringify({ phase: 'completed', exitCode: 0, taskId: t.taskId }) + '\n',
  );
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'UNRECOVERED_COMPLETED_RUN', taskId: t.taskId,
    runId: t.linkedRuns[0].runId, confirmed: true,
  });
  check(r.executed === false && /REJECTED|BLOCKED/.test(r.summary), `fail-closed without transcript (${r.summary.slice(0, 60)})`);
}

// G-03: RTP reconcile -------------------------------------------------------
console.log('\n-- G-03: RTP reconcile --');
{
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'CRASHED_PREPARATION', taskId: tRetry.taskId,
    preparationId: rtpId, confirmed: true,
  });
  check(r.executed === true, 'executed');
  check(rtp.getRetryPreparation(TEST_ROOT, project, rtpId).status === 'READY', 'prep back at READY');
}

// G-04: QRP refusal ---------------------------------------------------------
console.log('\n-- G-04: QRP refusal --');
{
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'CRASHED_PREPARATION', taskId: tQrp.taskId,
    preparationId: qrpId, confirmed: true,
  });
  check(r.executed === false && /no advancing kernel function/.test(r.summary), 'refused without inventing a transition');
}

// G-05: QA gate -------------------------------------------------------------
console.log('\n-- G-05: QA gate --');
{
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'QA_GATE_STALLED', taskId: tQa.taskId,
    runId: gt.getTask(TEST_ROOT, project, tQa.taskId).linkedRuns[0].runId,
    confirmed: true,
  });
  check(r.executed === true, 'executed');
  const attempts = qatk.listQaAttemptsForTask(TEST_ROOT, project, tQa.taskId);
  check(attempts.some((a) => a.finalQaStatus === 'PASS'), 'deterministic PASS verdict recorded');
}

// G-06: missing delivery ----------------------------------------------------
console.log('\n-- G-06: missing delivery --');
{
  const t = gt.getTask(TEST_ROOT, project, tVerify.taskId);
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'MISSING_DELIVERY', taskId: t.taskId,
    runId: t.linkedRuns[0].runId, confirmed: true,
  });
  check(r.executed === true && /PMD-/.test(r.summary), `delivery minted (${r.summary.slice(0, 60)})`);
  const again = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'MISSING_DELIVERY', taskId: t.taskId,
    runId: t.linkedRuns[0].runId, confirmed: true,
  });
  check(again.executed === false, 're-execution is stale (no-op)');
}

// G-07: orphan without choice ------------------------------------------------
console.log('\n-- G-07: orphan without choice --');
{
  let threw = null;
  try {
    await act.executeGuidedAction(TEST_ROOT, project, {
      pattern: 'ORPHANED_DISPATCH', taskId: tOrphan.taskId, confirmed: true,
    });
  } catch (e) { threw = e; }
  check(!!threw && threw.code === 'INVALID_ARGUMENT', 'orphanAction required (no default)');
}

// G-08: stale ----------------------------------------------------------------
console.log('\n-- G-08: stale finding --');
{
  const r = await act.executeGuidedAction(TEST_ROOT, project, {
    pattern: 'MISSING_DELIVERY', taskId: 'TASK-9999', confirmed: true,
  });
  check(r.executed === false, 'unknown task → not-executed result');
}

console.log(`\n결과: ${passed} passed, ${failed} failed`);
disp._resetDispatcherStateForTests();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
