/**
 * V1.6 Slice 7 — Full QA: adversarial attack suite over integrated V1.6.
 * Runs against compiled server modules under dist/server.
 *
 * Plan SSOT: docs/V16-QA-GATE-PLAN-01.md §8–§14, §16, §20.
 *
 * Unlike Slices 1–6 (one mechanism per slice), this suite attacks the
 * COMBINATIONS: BOTH-mode end-to-end, semantic BLOCKED, deterministic BLOCKED,
 * QA↔G5 lineage interop, binding preservation/switch-refusal, LAUNCH_FAILED
 * post-commit binding, adopt-with-capture fall-through, multi-task isolation,
 * mid-flight contract hand-edit refusal, malformed-contract escalation,
 * duplicate live triggers, and the integrated authority re-proof
 * (QA PASS ⇏ ACCEPT / ⇏ Plan advance; QA FAIL ⇒ SAME Task; only GPT ACCEPT).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s7-${process.pid}-${Date.now()}`);
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
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const retryPrep = await import('../dist/server/backend/retry-preparation.js');
const retryDispatch = await import('../dist/server/backend/retry-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const planContinuation = await import('../dist/server/backend/execution-plan-continuation.js');
const vctx = await import('../dist/server/backend/pm-verification-context.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const fsKernel = await import('../dist/server/backend/fs.js');
const evk = await import('../dist/server/backend/event.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const project = 'V16Slice7';
const NODE = process.execPath;
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ZERO_FIXTURE = path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs');

wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 's7-worker', displayName: 's7 fixture implementation worker',
  launchCommand: NODE, launchArgsPrefix: [EXIT_ZERO_FIXTURE],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const FAKE_QA_DIR = path.join(ROOT, '_fake-qa-workers');
fs.mkdirSync(FAKE_QA_DIR, { recursive: true });
let qaWorkerCounter = 0;
function registerFakeQaWorker(script) {
  qaWorkerCounter += 1;
  const workerId = `s7-qa-${qaWorkerCounter}`;
  const scriptPath = path.join(FAKE_QA_DIR, `${workerId}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: NODE, launchArgsPrefix: [scriptPath], role: 'qa',
  });
  return workerId;
}
const PASS_SCRIPT = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: PASS');\nconsole.log('criteria:');\nfor (const id of ids) console.log('- ' + id + ': PASS');\n`;
const FAIL_SCRIPT = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: FAIL');\nconsole.log('failedCriteria:');\nconsole.log('- ' + ids[0]);\nconsole.log('reason: fake semantic failure');\nconsole.log('remediationInstruction: rewrite the file to express the correct status');\n`;
const GARBAGE_SCRIPT = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log('this is not a structured status block at all');\n`;
/** Content-aware worker (dogfood pattern): FAILs AC-01 while the bounded Worker
 * Result text expresses status=wrong, PASSes on status=correct. */
const CONTENT_SCRIPT = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconst p = process.argv[3] || '';\nif (p.includes('status=wrong')) {\nconsole.log('status: FAIL');\nconsole.log('failedCriteria:');\nconsole.log('- AC-01');\nconsole.log('reason: content expresses wrong status');\nconsole.log('remediationInstruction: rewrite the file to express the correct status');\n} else {\nconsole.log('status: PASS');\nconsole.log('criteria:');\nconsole.log('- AC-01: PASS');\n}\n`;

let idCounter = 0;
let goalCache = null;
async function goal() {
  if (!goalCache) goalCache = await gt.createGoal(ROOT, project, { title: 'S7 goal', goalStatement: 'S7 fixture goal' });
  return goalCache;
}
async function makeTask({ acceptanceCriteria, qaContract }) {
  const g = await goal();
  return gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'S7 QA task', goal: 'S7 fixture task', reason: 'fixture',
    scope: 'fixture scope; authorized file: out.txt',
    completionCriteria: ['fixture done'], executionState: 'RUNNING', pmState: 'PENDING',
    acceptanceCriteria, qaContract,
  });
}
function detTask() {
  return makeTask({
    acceptanceCriteria: [{ id: 'AC-01', description: 'output file out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
}
async function linkRun(taskId, { workerId = 's7-worker', resultText = 'fixture result', capture = true } = {}) {
  idCounter += 1;
  const n = idCounter;
  const workspaceRoot = path.join(ROOT, 'ws', `t-${n}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', `run-${n}`);
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s7-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId }), 'utf8');
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
async function resetLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  pmDel._resetPmDeliveryLocksForTests();
  qa._resetQaAttemptLocksForTests();
  qrp._resetQaRemediationPreparationLocksForTests();
  gate._resetQaGateLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}
function attemptsFor(taskId) { return qa.listQaAttemptsForTask(ROOT, project, taskId); }
function prepsFor(taskId) { return qrp.listQaRemediationPreparations(ROOT, project).filter((p) => p.taskId === taskId); }
function deliveriesFor(taskId) { return pmDel.listPmDeliveries(ROOT, project).filter((d) => d.taskId === taskId); }
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
function taskJsonPath(taskId) {
  return path.join(gt.taskFolder(ROOT, project, taskId), 'task.json');
}
function readTaskRaw(taskId) {
  return JSON.parse(fs.readFileSync(taskJsonPath(taskId), 'utf8'));
}
function writeTaskRaw(taskId, raw) {
  fs.writeFileSync(taskJsonPath(taskId), JSON.stringify(raw, null, 2), 'utf8');
}

// ── F1. BOTH-mode criterion end-to-end through the gate ──────────────────────
console.log('\n== F1. BOTH AC: deterministic PASS + semantic FAIL ⇒ FAIL; then both PASS ==');
{
  const marker = path.join(ROOT, 's7-f1.marker');
  fs.writeFileSync(marker, '', 'utf8');
  const contentQa = registerFakeQaWorker(CONTENT_SCRIPT(marker));
  const task = await makeTask({
    acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists AND expresses correct status', validationMode: 'BOTH' }],
    qaContract: {
      deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }],
      semantic: { qaWorkerId: contentQa },
    },
  });
  const r1 = await linkRun(task.taskId, { resultText: 'V16_QA\nstatus=wrong' });
  fs.writeFileSync(path.join(r1.workspaceRoot, 'out.txt'), 'V16_QA\nstatus=wrong', 'utf8');
  await receive(task.taskId, r1.runId);
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F1 deterministic PASS + semantic FAIL ⇒ FAIL + remediation (semantic not skippable for BOTH)');
  const att1 = attemptsFor(task.taskId)[0];
  check(att1.deterministic.status === 'PASS' && att1.semantic.status === 'FAIL', 'F1 both layers recorded independently (det PASS kept, not overwritten)');
  check(JSON.stringify(att1.failedCriteria) === JSON.stringify(['AC-01']), 'F1 BOTH AC attributed to failedCriteria');
  // Same Task, same contract, corrected content → both layers PASS.
  const f2 = await completeCurrentRunAndReconcile(task.taskId, {
    resultText: 'V16_QA\nstatus=correct', files: { 'out.txt': 'V16_QA\nstatus=correct' },
  });
  check(f2.outcome === 'PASS_DELIVERED', 'F1 BOTH layers PASS ⇒ PASS + Delivery');
  const t2 = gt.getTask(ROOT, project, task.taskId);
  const run2 = [...t2.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const att2 = attemptsFor(task.taskId).find((a) => a.runId === run2.runId);
  check(att2.deterministic.status === 'PASS' && att2.semantic.status === 'PASS' && att2.failedCriteria.length === 0, 'F1 BOTH evidence present in both layers, failedCriteria empty');
  check(fs.readFileSync(marker, 'utf8').length === 2, 'F1 semantic QA ran exactly once per attempt (mandatory, never skipped, never doubled)');
}

// ── F2. Semantic BLOCKED (garbage worker ×2) → escalate, no remediation ──────
console.log('\n== F2. semantic QA errors twice ⇒ BLOCKED ⇒ escalate, zero remediation ==');
{
  const marker = path.join(ROOT, 's7-f2.marker');
  fs.writeFileSync(marker, '', 'utf8');
  const garbageQa = registerFakeQaWorker(GARBAGE_SCRIPT(marker));
  const task = await makeTask({
    acceptanceCriteria: [{ id: 'AC-01', description: 'semantic intent', validationMode: 'SEMANTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId: garbageQa } },
  });
  const r1 = await linkRun(task.taskId);
  fs.writeFileSync(path.join(r1.workspaceRoot, 'out.txt'), 'ok', 'utf8');
  await receive(task.taskId, r1.runId);
  let res;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    try { res = await gate.reconcileQaGate(ROOT, project, task.taskId); }
    catch (err) { if (cycle === 2) throw err; }
  }
  const marks = fs.readFileSync(marker, 'utf8').length;
  check(res?.outcome === 'BLOCKED_ESCALATED', 'F2 semantic BLOCKED retries are bounded, then escalate');
  check(marks === 6, `F2 three bounded semantic cycles, two invocations each (got ${marks})`);
  check(prepsFor(task.taskId).length === 0, 'F2 BLOCKED consumes no remediation budget');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'F2 no remediation Run on the BLOCKED path');
  check(deliveriesFor(task.taskId).length === 1, 'F2 escalation Delivery minted only after retry budget');
  const att = attemptsFor(task.taskId)[0];
  check(att.deterministic.status === 'PASS' && att.semantic === undefined && att.reason, 'F2 deterministic PASS preserved with BLOCKED reason');
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, pmDel.pmDeliveryIdFor(task.taskId, r1.runId));
  check(packet.qa?.status === 'BLOCKED' && packet.qa?.escalationReason === 'BLOCKED', 'F2 PM sees qa.status=BLOCKED escalation evidence');
}

// ── F3. Deterministic BLOCKED (spawn error) → escalate, semantic never runs ───
console.log('\n== F3. deterministic command spawn error ⇒ BLOCKED, semantic never invoked ==');
{
  const marker = path.join(ROOT, 's7-f3.marker');
  fs.writeFileSync(marker, '', 'utf8');
  const neverQa = registerFakeQaWorker(PASS_SCRIPT(marker));
  const task = await makeTask({
    acceptanceCriteria: [{ id: 'AC-01', description: 'command passes', validationMode: 'SEMANTIC' }],
    qaContract: {
      deterministic: [{ kind: 'command', command: '/nonexistent/s7-binary-xyz', args: [], timeoutMs: 5000, expectExitCode: 0 }],
      semantic: { qaWorkerId: neverQa },
    },
  });
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res.outcome === 'BLOCKED_ESCALATED', 'F3 spawn-error ⇒ BLOCKED escalation (never FAIL)');
  check(fs.readFileSync(marker, 'utf8').length === 0, 'F3 semantic QA Agent never invoked (hard gate)');
  check(prepsFor(task.taskId).length === 0 && deliveriesFor(task.taskId).length === 1, 'F3 no remediation, one escalation Delivery');
}

// ── F4. QA remediation lineage vs GPT CHANGES retry lineage (full loop) ───────
console.log('\n== F4. QA FAIL → QA remediation → PASS → GPT CHANGES → G5 retry → ACCEPT ==');
{
  const task = await detTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F4 run 1 QA FAIL → QA remediation');
  const tAfterQa = gt.getTask(ROOT, project, task.taskId);
  const run2 = [...tAfterQa.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const metaQa = fsKernel.readRunMeta(run2.folder);
  check(metaQa.qaRemediationPreparationId === prepsFor(task.taskId)[0].preparationId, 'F4 QA retry meta carries qaRemediationPreparationId');
  check(metaQa.retryPreparationId === undefined, 'F4 QA retry meta carries NO retryPreparationId (lineages separated)');
  check(tAfterQa.pmState === 'PENDING', 'F4 QA remediation never sets CHANGES_REQUESTED');
  // Run 2 PASSes QA → ordinary Delivery for GPT PM.
  const f2 = await completeCurrentRunAndReconcile(task.taskId, { files: { 'out.txt': 'fixed' } });
  check(f2.outcome === 'PASS_DELIVERED', 'F4 run 2 QA PASS → Delivery');
  const D2 = pmDel.pmDeliveryIdFor(task.taskId, run2.runId);
  // GPT PM judges CHANGES (its own vocabulary) → G5 preparation → G5 retry.
  const g = await goal();
  retryAuth.mintRetryAuthorization(ROOT, project, {
    taskId: task.taskId, goalId: g.goalId, workerId: 's7-worker', workspaceRoot: r1.workspaceRoot,
    scopeFingerprint: retryAuth.computeTaskScopeFingerprint(gt.getTask(ROOT, project, task.taskId)),
    source: 'OWNER_APPROVED_INITIAL_DISPATCH',
  });
  await pmJud.submitPmJudgment(ROOT, project, { deliveryId: D2, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'fix the nits and re-verify' });
  await retryPrep.prepareRetryForJudgment(ROOT, project, D2);
  // PM's CHANGES vocabulary applied by PM's own flow (recorded as a
  // TASK_CHANGES_REQUESTED Event, then canonical READY+PENDING) — never by QA.
  const changesEvents = evk.listEvents(ROOT, project).events.filter((e) => e.taskId === task.taskId && e.type === 'TASK_CHANGES_REQUESTED');
  check(changesEvents.length === 1, 'F4 PM CHANGES recorded as TASK_CHANGES_REQUESTED (PM vocabulary, never QA)');
  const tReady = gt.getTask(ROOT, project, task.taskId);
  check(tReady.executionState === 'READY' && tReady.pmState === 'PENDING', 'F4 G5 preparation moves Task to READY+PENDING canonically');
  const g5 = await retryDispatch.dispatchV1Retry(ROOT, project, { deliveryId: D2 });
  await waitForNoLive(task.taskId);
  check(g5.alreadyDispatched === false && !!g5.runId, 'F4 G5 retry Run 3 dispatched');
  const tAfterG5 = gt.getTask(ROOT, project, task.taskId);
  const run3 = tAfterG5.linkedRuns.find((r) => r.runId === g5.runId);
  const metaG5 = fsKernel.readRunMeta(run3.folder);
  check(typeof metaG5.retryPreparationId === 'string' && metaG5.retryPreparationId.startsWith('RTP-PMJ-'), 'F4 G5 retry meta carries retryPreparationId');
  check(metaG5.qaRemediationPreparationId === undefined, 'F4 G5 retry meta carries NO qaRemediationPreparationId');
  // Run 3 (G5 product) is QA-gated like any Run: PASS → Delivery → GPT ACCEPT.
  const f3 = await completeCurrentRunAndReconcile(task.taskId, { files: { 'out.txt': 'fixed-again' } });
  check(f3.outcome === 'PASS_DELIVERED', 'F4 G5 retry Run is QA-gated too (PASS → Delivery)');
  check(attemptsFor(task.taskId).length === 3, 'F4 three QA attempts, one per implementation Run');
  const D3 = pmDel.pmDeliveryIdFor(task.taskId, run3.runId);
  await pmJud.submitPmJudgment(ROOT, project, { deliveryId: D3, decision: 'ACCEPT', reason: 'loop accept: looks good' });
  const fin = gt.getTask(ROOT, project, task.taskId);
  check(fin.pmState === 'ACCEPTED' && fin.acceptedRunId === run3.runId, 'F4 only GPT ACCEPT accepts (winner = Run 3)');
}

// ── F5. Binding preservation + silent-switch refusal ─────────────────────────
console.log('\n== F5. remediation preserves Worker/workspace; switched binding refuses ==');
{
  const task = await detTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  // Attack: silently switch the source Run's Worker binding mid-flight.
  const metaPath = path.join(r1.folder, 'meta.json');
  const metaRaw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  metaRaw.workerId = 's7-worker-IMPOSTOR';
  fs.writeFileSync(metaPath, JSON.stringify(metaRaw), 'utf8');
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'INVALID_STATE', 'F5 switched Worker binding fails closed (no silent Worker switch)');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'F5 no Run dispatched from switched binding');
  check(prepsFor(task.taskId).length === 0, 'F5 refusal creates NOTHING (no poisoned preparation snapshots the bad binding)');
  // Restore: remediation inherits the frozen binding exactly.
  metaRaw.workerId = 's7-worker';
  fs.writeFileSync(metaPath, JSON.stringify(metaRaw), 'utf8');
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F5 restored binding dispatches');
  const run2 = [...gt.getTask(ROOT, project, task.taskId).linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const meta2 = fsKernel.readRunMeta(run2.folder);
  check(meta2.workerId === 's7-worker' && meta2.workspaceRoot === r1.workspaceRoot, 'F5 remediation preserves Worker + workspace binding');
}

// ── F6. LAUNCH_FAILED post-commit: bound, never duplicated ────────────────────
console.log('\n== F6. remediation dispatch LAUNCH_FAILED → bound best-effort, never duplicated ==');
{
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId: 's7-broken-worker', displayName: 's7 broken worker',
    launchCommand: '/nonexistent/s7-worker-binary', launchArgsPrefix: [], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
  });
  const task = await detTask();
  const r1 = await linkRun(task.taskId, { workerId: 's7-broken-worker' });
  await receive(task.taskId, r1.runId);
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'LAUNCH_FAILED', 'F6 broken worker ⇒ LAUNCH_FAILED (never silent success)');
  // G5-symmetric at-most-once semantics (retry-dispatch.ts:30): the Run that
  // materialized before the spawn failure is bound (marker written), the Task
  // moves to FAILED — exactly like a V1/G5 launch failure. No duplicate is
  // ever launched for the same authorized preparation.
  const prep = prepsFor(task.taskId)[0];
  check(prep !== undefined && prep.dispatchedRunId !== undefined, 'F6 preparation bound to the single materialized Run');
  const tFail = gt.getTask(ROOT, project, task.taskId);
  check(tFail.linkedRuns.length === 2, 'F6 exactly one materialized Run (no duplicate spawn on failure)');
  check(tFail.executionState === 'FAILED', 'F6 Task FAILED (inherited dispatcher semantics, same as G5 launch failure)');
  // Even after the worker is repaired, the bound dead Run is never abandoned
  // for a second spawn — at-most-once holds across repair + restart.
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId: 's7-broken-worker', displayName: 's7 repaired worker',
    launchCommand: NODE, launchArgsPrefix: [EXIT_ZERO_FIXTURE], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
  });
  await resetLocal();
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'BLOCKED', 'F6 repaired reconcile refuses BLOCKED (dead Run has no Result; never a second spawn)');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'F6 still exactly one remediation Run after repair');
  check(prepsFor(task.taskId).length === 1 && deliveriesFor(task.taskId).length === 0, 'F6 no new preparation, no Delivery from the dead Run');
}

// ── F7. Adopt-with-capture fall-through: adopted Run is evaluated normally ────
console.log('\n== F7. adopted Run WITH canonical capture → evaluated, not just reported ==');
{
  const task = await detTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  // Real FAIL → real remediation dispatch of Run 2 (same workspace as Run 1).
  const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F7 run 1 FAIL → remediation dispatched');
  const prep = prepsFor(task.taskId)[0];
  const run2 = [...gt.getTask(ROOT, project, task.taskId).linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  // Crash window (mirrors G5-C S-section technique): strip the consumption
  // marker but LEAVE the correlated Run; the Run then completes and its
  // Result is received while the bridge never fires.
  const prepPath = path.join(ROOT, project, '_relay', 'qa-remediation-preparations', prep.preparationId, 'preparation.json');
  const prepRaw = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  delete prepRaw.dispatchedRunId; delete prepRaw.dispatchedAt; delete prepRaw.consumedAt;
  fs.writeFileSync(prepPath, JSON.stringify(prepRaw, null, 2), 'utf8');
  const meta2 = fsKernel.readRunMeta(run2.folder);
  fs.mkdirSync(path.join(run2.folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(run2.folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(run2.folder, 'result.md'), 'adopted result', 'utf8');
  fs.writeFileSync(path.join(meta2.workspaceRoot, 'out.txt'), 'ok', 'utf8');
  release(task.taskId, run2.runId, meta2.workspaceRoot);
  await receive(task.taskId, run2.runId);
  await resetLocal();
  const runsBefore = gt.getTask(ROOT, project, task.taskId).linkedRuns.length;
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res.outcome === 'PASS_DELIVERED', `F7 adopted captured Run evaluated to PASS + Delivery (got ${res.outcome})`);
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === runsBefore, 'F7 no second Worker spawned');
  check(deliveriesFor(task.taskId).length === 1, 'F7 exactly one Delivery for the adopted Run');
  check(qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId).dispatchedRunId === run2.runId, 'F7 adoption persisted against the evaluated Run');
}

// ── F8. Multi-task isolation under concurrency ───────────────────────────────
console.log('\n== F8. two QA Tasks reconciled concurrently → isolated lineages ==');
{
  const taskA = await detTask();
  const taskB = await detTask();
  const ra = await linkRun(taskA.taskId);
  const rb = await linkRun(taskB.taskId);
  await receive(taskA.taskId, ra.runId);
  await receive(taskB.taskId, rb.runId);
  const results = await Promise.allSettled([
    gate.reconcileQaGate(ROOT, project, taskA.taskId),
    gate.reconcileQaGate(ROOT, project, taskB.taskId),
    gate.reconcileQaGate(ROOT, project, taskA.taskId),
    gate.reconcileQaGate(ROOT, project, taskB.taskId),
  ]);
  await waitForNoLive(taskA.taskId);
  await waitForNoLive(taskB.taskId);
  const outs = results.map((r) => (r.status === 'fulfilled' ? r.value.outcome : r.reason?.code)).sort();
  check(JSON.stringify(outs) === JSON.stringify(['BLOCKED', 'BLOCKED', 'FAIL_REMEDIATION_DISPATCHED', 'FAIL_REMEDIATION_DISPATCHED']), `F8 two dispatches + two resumable-BLOCKED losers (got ${JSON.stringify(outs)})`);
  for (const [t, label] of [[taskA, 'A'], [taskB, 'B']]) {
    check(prepsFor(t.taskId).length === 1, `F8 Task ${label}: exactly one preparation`);
    check(gt.getTask(ROOT, project, t.taskId).linkedRuns.length === 2, `F8 Task ${label}: exactly one remediation Run`);
    const prep = prepsFor(t.taskId)[0];
    const taskNow = gt.getTask(ROOT, project, t.taskId);
    const rem = taskNow.linkedRuns.find((r) => r.runId === prep.dispatchedRunId);
    check(!!rem && fsKernel.readRunMeta(rem.folder).qaRemediationPreparationId === prep.preparationId, `F8 Task ${label}: Run bound to its OWN preparation`);
  }
}

// ── F9. Mid-flight contract hand-edit refusal ────────────────────────────────
console.log('\n== F9. contract edited DURING evaluation ⇒ dispatch refuses ==');
{
  // Slow-FAIL semantic worker opens a real evaluation→dispatch window: the
  // gate derives the contract BEFORE evaluation and re-derives it at
  // dispatch; an edit landing between the two must refuse (defense-in-depth
  // over the creation-time freeze + plan fingerprint authorization). The
  // FAIL ending is required — only the remediation-dispatch window spends
  // autonomous action (PASS escalation is PM-backstopped advisory delivery).
  const slowFail = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nawait new Promise((r) => setTimeout(r, 2500));\nconsole.log('status: FAIL');\nconsole.log('failedCriteria:');\nconsole.log('- AC-01');\nconsole.log('reason: slow fake failure');\nconsole.log('remediationInstruction: fix it');\n`;
  const marker = path.join(ROOT, 's7-f9.marker');
  fs.writeFileSync(marker, '', 'utf8');
  const slowQa = registerFakeQaWorker(slowFail(marker));
  const task = await makeTask({
    acceptanceCriteria: [{ id: 'AC-01', description: 'semantic intent', validationMode: 'SEMANTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId: slowQa } },
  });
  const r1 = await linkRun(task.taskId);
  fs.writeFileSync(path.join(r1.workspaceRoot, 'out.txt'), 'ok', 'utf8');
  await receive(task.taskId, r1.runId);
  // Launch the live reconcile in the background; wait until evaluation has
  // provably STARTED (deterministic evidence persisted ⇒ contract already
  // derived once), then land the hand-edit inside the evaluation window.
  const flight = gate.reconcileQaGate(ROOT, project, task.taskId);
  const qaAttemptId = qa.qaAttemptIdFor(task.taskId, r1.runId);
  const t0 = Date.now();
  for (;;) {
    let att = null;
    try { att = qa.getQaAttempt(ROOT, project, qaAttemptId); } catch { att = null; }
    if (att?.deterministic) break;
    if (Date.now() - t0 > 20000) throw new Error('F9 setup: evaluation never started');
    await sleep(100);
  }
  const raw = readTaskRaw(task.taskId);
  raw.qaContract.deterministic[0].path = 'elsewhere.txt';
  writeTaskRaw(task.taskId, raw);
  await throwsWithCode(() => flight, 'INVALID_STATE', 'F9 mid-evaluation contract change refuses dispatch');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 1, 'F9 no Run dispatched under changed contract');
  // Restore: the same authorized remediation proceeds (refusal wedged nothing).
  const fresh = readTaskRaw(task.taskId);
  fresh.qaContract.deterministic[0].path = 'out.txt';
  writeTaskRaw(task.taskId, fresh);
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', `F9 restored contract resumes the authorized remediation (got ${res.outcome})`);
}

// ── F10. Corrupted contract on disk → fail closed, never remediation ─────────
console.log('\n== F10. disk-corrupted QA contract ⇒ fail closed (no verdict fabricated) ==');
{
  // A §7-violating contract cannot survive creation (rejected) or update
  // (frozen) — only raw disk corruption gets here. The read-time validator
  // (same full §7 rules as creation) rejects it before the gate ever derives
  // from it, so nothing is minted and nothing is mutated. (The gate's
  // in-memory pseudo-attempt BLOCKED branch stays as defense-in-depth for
  // unvalidated in-memory tasks; escalation off a genuinely unreadable Task
  // is structurally impossible — delivery itself needs the Task binding.)
  const task = await detTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  const raw = readTaskRaw(task.taskId);
  raw.qaContract.deterministic[0].kind = 'teleport';
  writeTaskRaw(task.taskId, raw);
  let threw = false;
  try {
    await gate.reconcileQaGate(ROOT, project, task.taskId);
  } catch (err) {
    threw = true;
    check(['NOT_FOUND', 'INVALID_STATE', 'CORRUPT_RECORD'].includes(err?.code), `F10 corrupted contract fails closed (got code=${err?.code})`);
  }
  check(threw, 'F10 corrupted contract never resolves to a verdict');
  check(attemptsFor(task.taskId).length === 0, 'F10 no QA attempt minted from a corrupted contract');
  check(prepsFor(task.taskId).length === 0, 'F10 no remediation from a corrupted contract');
  check(deliveriesFor(task.taskId).length === 0, 'F10 no Delivery from a corrupted contract');
  // Restore: the failed reconcile mutated nothing — the Task resumes cleanly.
  raw.qaContract.deterministic[0].kind = 'fileExists';
  writeTaskRaw(task.taskId, raw);
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'PENDING', 'F10 Task state untouched by the failed reconcile');
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F10 restored contract resumes the authorized path');
}

// ── F11. Duplicate live triggers → single attempt lineage ────────────────────
console.log('\n== F11. duplicate receipt + concurrent triggers → one attempt, one prep ==');
{
  const task = await detTask();
  const r1 = await linkRun(task.taskId);
  await receive(task.taskId, r1.runId);
  await receive(task.taskId, r1.runId); // idempotent replay
  const results = await Promise.allSettled([
    gate.reconcileQaGate(ROOT, project, task.taskId),
    gate.reconcileQaGate(ROOT, project, task.taskId),
    gate.reconcileQaGate(ROOT, project, task.taskId),
  ]);
  await waitForNoLive(task.taskId);
  const dispatches = results.filter((r) => r.status === 'fulfilled' && r.value.outcome === 'FAIL_REMEDIATION_DISPATCHED').length;
  check(dispatches === 1, `F11 exactly one dispatch across three triggers (got ${dispatches})`);
  // Losers that ran after the winner dispatched target the NEW current Run 2
  // (no Result yet) and leave at most one PENDING resume-marker for it — never
  // a duplicate attempt for the same Run (deterministic qaAttemptId dedupe).
  const atts = attemptsFor(task.taskId);
  const ids = atts.map((a) => a.qaAttemptId);
  check(new Set(ids).size === ids.length, 'F11 no duplicate QA attempt for any Run');
  check(atts.filter((a) => a.runId === r1.runId && a.finalQaStatus === 'FAIL').length === 1, 'F11 exactly one terminal FAIL attempt for Run 1');
  check(prepsFor(task.taskId).length === 1, 'F11 exactly one preparation');
  check(gt.getTask(ROOT, project, task.taskId).linkedRuns.length === 2, 'F11 exactly one remediation Run');
}

// ── F12. Integrated authority re-proof: FAIL ⇏ ACCEPT, PASS ⇏ advance, ACCEPT only ──
console.log('\n== F12. authority re-proof: QA FAIL/PASS move nothing; GPT ACCEPT moves the Plan ==');
{
  const g = await goal();
  const wsP = path.join(ROOT, 'ws', 'plan-f12');
  fs.mkdirSync(wsP, { recursive: true });
  const mkPlanTask = (title, extra = {}) => gt.createTask(ROOT, project, {
    goalId: g.goalId, title, goal: title, reason: 'r', scope: 'plan scope; authorized file: out.txt',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING', ...extra,
  });
  const taskA = await mkPlanTask('plan A', {
    acceptanceCriteria: [{ id: 'AC-01', description: 'AC-01', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await mkPlanTask('plan B');
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 's7-plan', orderedTaskIds: [taskA.taskId, taskB.taskId],
    taskBindings: [taskA, taskB].map((t) => ({
      taskId: t.taskId, workerId: 's7-worker', workspaceRoot: wsP, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
    })),
  });
  const authz = {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
  };
  await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authz,
  });
  const cursor = () => plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId;
  check(cursor() === taskA.taskId, 'F12 cursor on A after Owner GO');
  await waitForNoLive(taskA.taskId);
  // QA FAIL → same-Task remediation: nothing accepted, nothing advanced.
  const f1 = await completeCurrentRunAndReconcile(taskA.taskId);
  check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F12 run 1 QA FAIL → SAME-Task remediation');
  check(cursor() === taskA.taskId, 'F12 QA FAIL moves no Plan cursor');
  check(gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 0, 'F12 QA FAIL starts no successor');
  // QA PASS → Delivery: still nothing accepted, nothing advanced.
  const f2 = await completeCurrentRunAndReconcile(taskA.taskId, { files: { 'out.txt': 'fixed' } });
  check(f2.outcome === 'PASS_DELIVERED', 'F12 run 2 QA PASS → Delivery (not ACCEPT)');
  const aMid = gt.getTask(ROOT, project, taskA.taskId);
  check(aMid.pmState === 'VERIFYING' && aMid.acceptedRunId === undefined, 'F12 QA PASS ⇏ Task ACCEPT');
  check(cursor() === taskA.taskId, 'F12 QA PASS moves no Plan cursor');
  // ONLY GPT PM ACCEPT advances: Task ACCEPTED + cursor to B.
  const run2 = [...aMid.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  await pmJud.submitPmJudgment(ROOT, project, {
    deliveryId: pmDel.pmDeliveryIdFor(taskA.taskId, run2.runId), decision: 'ACCEPT', reason: 'accept: good',
  });
  const aAcc = gt.getTask(ROOT, project, taskA.taskId);
  check(aAcc.pmState === 'ACCEPTED' && aAcc.acceptedRunId === run2.runId, 'F12 GPT ACCEPT accepts the Task');
  // The canonical ACCEPT path itself advances the Plan (via task-actions);
  // a follow-up continuation call is a stable no-op, never a double-advance.
  check(cursor() === taskB.taskId, 'F12 GPT ACCEPT advances cursor to B');
  const adv = await planContinuation.continueExecutionPlanAfterTaskAccepted(ROOT, project, aAcc);
  check(adv === 'NOT_ACTIVE' && cursor() === taskB.taskId, `F12 continuation after ACCEPT is a stable no-op (got ${adv})`);
}

console.log(`\nSlice 7 Full QA: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
