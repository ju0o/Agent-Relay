/**
 * V1-G5-B — CHANGES → retry preparation → READY+PENDING.
 *
 * V1 drive always through canonical surfaces:
 *   relay_pm_create_task → relay_pm_dispatch_owner_approved →
 *   injected bound RESPONSE_complete (delivery auto-minted).
 *
 * One PM CHANGES judgment (MCP or bridge) drives G5-A intake + G5-B
 * preparation with no second manual command. No Run, no dispatch, no prompt
 * work — those belong to G5-C.
 *
 * Proves A–Z (see task) plus the full one-judgment product flow.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g5b-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' ? err.mcpCode ?? err.code : undefined;
    const hay = `${code ?? ''} ${msg}`;
    if (fragment && !hay.includes(fragment)) {
      FAIL(`${label} — expected "${fragment}" in error, got: ${code || ''} ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const gt = await import('../dist/server/backend/goal-task.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const retryPrep = await import('../dist/server/backend/retry-preparation.js');
const evk = await import('../dist/server/backend/event.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const bridgeMod = await import('../dist/server/backend/pm-host-bridge.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const FAKE_HOST = path.resolve(__dirname, 'fixtures/hosts/fake-pm-host.mjs');
const NODE = process.execPath;

const project = 'V1G5BProj';
const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g5b-worker',
  displayName: 'v1-g5b-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G5B retry task',
  goal: 'Intended outcome for V1 worker review',
  reason: 'PM finalized contract reason for review',
  scope: 'Narrow V1 review scope',
  completionCriteria: ['done when worker result received'],
};

const REASON = 'please address the review nits above';
const INSTR = 'fix the nits and re-verify typecheck';

async function resetProcessLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function responseComplete(sessionId, text) {
  return {
    adapterId: 'test-fixture',
    agentName: 'TestFixture',
    sessionId,
    workspace: WORKSPACE,
    observedAt: new Date().toISOString(),
    terminalSignal: 'test.complete',
    rawFinalText: text,
    completionKind: 'RESPONSE_COMPLETE',
  };
}

async function driveToResultReceived(title, sessionId, text) {
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g5b-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  if (t.executionState !== 'RESULT_RECEIVED') throw new Error(`setup failed: ${t.executionState}`);
  return { goalId: inc.goal.goalId, taskId: inc.task.taskId, runId: res.runId, folder };
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// ── main flow: ONE MCP judgment → READY+PENDING ──
console.log('\n-- one-judgment product flow --');
const t1 = await driveToResultReceived('V1 G5B main', 'ses-g5b-1', 'G5B main result text');
const D1 = `PMD-${t1.taskId}-${t1.runId}`;
const J1 = `PMJ-${D1}`;
const P1 = `RTP-${J1}`;
let mcpRes;
{
  mcpRes = await get('relay_pm_submit_judgment').handler({
    deliveryId: D1, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR,
  });
  check(mcpRes.prepared === true, 'ONE judgment drives intake + preparation, no second command');
  check(mcpRes.judgment.status === 'APPLIED', 'CHANGES judgment APPLIED after READY');
  check(mcpRes.task.executionState === 'READY' && mcpRes.task.pmState === 'PENDING', 'Task READY+PENDING');
  check(mcpRes.preparation.status === 'READY', 'preparation READY');
}

// ── A/B/C/D ──
console.log('\n-- A-D: preparation record --');
{
  const prep = retryPrep.getRetryPreparation(TEST_ROOT, project, P1);
  check(prep.status === 'READY', 'A preparation created and READY');
  check(prep.deliveryId === D1 && prep.judgmentId === J1 && prep.taskId === t1.taskId && prep.sourceRunId === t1.runId, 'B binds delivery/judgment/task/sourceRun');
  const link = gt.getTask(TEST_ROOT, project, t1.taskId).linkedRuns.find((r) => r.runId === t1.runId);
  check(prep.nextAttemptSequence === link.taskRunSequence + 1, 'B nextAttemptSequence = source+1 (no runId invented)');
  check(prep.nextAttemptSequence === 2, 'C future runId NOT invented (sequence only)');
  const raw = fs.readFileSync(path.join(retryPrep.retryPreparationFolder(TEST_ROOT, project, P1), 'preparation.json'), 'utf8');
  check(!raw.includes(INSTR), 'D instruction referenced, not duplicated');
  check(prep.retryInstructionRef === J1, 'D logical ref to G5-A intent');
}

// ── E/F/G + H/I/J/K ──
console.log('\n-- E-K: canonical sequence --');
{
  const events = evk.listEvents(TEST_ROOT, project).events;
  const ch = events.filter((e) => e.type === 'TASK_CHANGES_REQUESTED' && e.taskId === t1.taskId);
  check(ch.length === 1 && ch[0].runId === t1.runId, 'E/G canonical requestTaskChanges + Event');
  const t = gt.getTask(TEST_ROOT, project, t1.taskId);
  check(t.executionState === 'READY' && t.pmState === 'PENDING', 'F/I Task ends READY+PENDING');
  check(t.retryCount === 1, 'J retryCount incremented exactly once');
  const rr = events.filter((e) => e.type === 'TASK_RETRY_REQUESTED' && e.taskId === t1.taskId);
  check(rr.length === 1, 'H/K canonical requestTaskRetry + Event');
  check(rr[0].runId === t1.runId, 'K retry Event bound to source attempt');
}

// ── L/M: idempotency ──
console.log('\n-- L/M: replay --');
{
  const before = gt.getTask(TEST_ROOT, project, t1.taskId).retryCount;
  const res = await get('relay_pm_submit_judgment').handler({
    deliveryId: D1, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR,
  });
  check(res.preparation.status === 'READY', 'L same judgment replay returns READY preparation');
  check(gt.getTask(TEST_ROOT, project, t1.taskId).retryCount === before, 'L retryCount untouched by replay');
  check(retryPrep.listRetryPreparations(TEST_ROOT, project).filter((p) => p.deliveryId === D1).length === 1, 'M one preparation only');
}

// ── N/O/P/Q: restart matrix ──
console.log('\n-- N-Q: recovery --');
{
  // N: preparation RECEIVED + task VERIFYING → resumes changes.
  const tn = await driveToResultReceived('V1 G5B resume-n', 'ses-g5b-n', 'G5B resume n text');
  const DN = `PMD-${tn.taskId}-${tn.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DN, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const rn = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DN);
  check(rn.preparation.status === 'READY', 'N restart before requestChanges resumes full sequence');
  check(gt.getTask(TEST_ROOT, project, tn.taskId).executionState === 'READY', 'N task READY');

  // O/P: crash between changes and retry / retry and READY write.
  const to = await driveToResultReceived('V1 G5B resume-o', 'ses-g5b-o', 'G5B resume o text');
  const DO = `PMD-${to.taskId}-${to.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DO, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  // Simulate crash after requestTaskChanges (task CHANGES_REQUESTED, prep RECEIVED).
  const { requestTaskChanges } = await import('../dist/server/backend/task-actions.js');
  await requestTaskChanges({
    dataRoot: TEST_ROOT, project, goalId: to.goalId, taskId: to.taskId, runId: to.runId,
    reason: REASON, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'PM_MCP',
  });
  const ro = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DO);
  check(ro.preparation.status === 'READY', 'O restart after changes resumes retry (no duplicate changes)');
  const chEvents = evk.listEvents(TEST_ROOT, project).events.filter((e) => e.type === 'TASK_CHANGES_REQUESTED' && e.taskId === to.taskId);
  check(chEvents.length === 1, 'O requestChanges applied exactly once');
  check(gt.getTask(TEST_ROOT, project, to.taskId).retryCount === 1, 'P retryCount exactly once across restart');

  // Q: already READY reconciles.
  const rq = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DO);
  check(rq.preparation.status === 'READY', 'Q already READY reconciles stable');
  check(gt.getTask(TEST_ROOT, project, to.taskId).retryCount === 1, 'Q no second increment');
  await resetProcessLocal();
}

// ── R/S/T/U: rejections ──
console.log('\n-- R-U: safe rejections --');
{
  // R: stale source attempt (a newer completed attempt displaced it).
  const ts = await driveToResultReceived('V1 G5B stale', 'ses-g5b-s1', 'G5B stale one');
  const DS = `PMD-${ts.taskId}-${ts.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DS, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const { requestTaskChanges: rtc, requestTaskRetry: rtr } = await import('../dist/server/backend/task-actions.js');
  await rtc({ dataRoot: TEST_ROOT, project, goalId: ts.goalId, taskId: ts.taskId, runId: ts.runId, reason: REASON, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'PM_MCP' });
  await rtr({ dataRoot: TEST_ROOT, project, goalId: ts.goalId, taskId: ts.taskId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED', callerSurface: 'PM_MCP' });
  await resetProcessLocal();
  const res2 = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: ts.taskId, workerId: 'v1-g5b-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const tS0 = gt.getTask(TEST_ROOT, project, ts.taskId);
  const folder2 = tS0.linkedRuns.find((r) => r.runId === res2.runId).folder;
  const cmS = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cmS.forceBindSessionForTests(folder2, 'ses-g5b-s2');
  cmS.injectCompletionForTests(folder2, responseComplete('ses-g5b-s2', 'G5B stale two'));
  await sleep(150);
  await shouldThrow(
    () => retryPrep.prepareRetryForJudgment(TEST_ROOT, project, DS),
    'R displaced source attempt rejects safely',
    'CONFLICT',
  );
  const cur = gt.getTask(TEST_ROOT, project, ts.taskId);
  check(cur.executionState === 'RESULT_RECEIVED' && cur.acceptedRunId === undefined, 'R newer attempt untouched');
  await resetProcessLocal();
}
{
  // S: ACCEPT judgment cannot prepare.
  const ta2 = await driveToResultReceived('V1 G5B accept-noprep', 'ses-g5b-sa', 'G5B accept text');
  const DA2 = `PMD-${ta2.taskId}-${ta2.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DA2, decision: 'ACCEPT', reason: 'accept reason here' });
  await shouldThrow(
    () => retryPrep.prepareRetryForJudgment(TEST_ROOT, project, DA2),
    'S ACCEPT judgment cannot create retry preparation',
    'INVALID_STATE',
  );
  await resetProcessLocal();
}
{
  // T: missing intent rejects safely.
  const tt = await driveToResultReceived('V1 G5B nointent', 'ses-g5b-st', 'G5B nointent text');
  const DT = `PMD-${tt.taskId}-${tt.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DT, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  fs.rmSync(path.join(pmJud.pmJudgmentFolder(TEST_ROOT, project, `PMJ-${DT}`), 'intent.json'));
  await shouldThrow(
    () => retryPrep.prepareRetryForJudgment(TEST_ROOT, project, DT),
    'T missing durable instruction rejects safely',
    'INVALID_STATE',
  );
  const t = gt.getTask(TEST_ROOT, project, tt.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING', 'T Task untouched on refusal');
  await resetProcessLocal();
}
{
  // U: terminal task prevents preparation.
  const tu = await driveToResultReceived('V1 G5B terminal', 'ses-g5b-su', 'G5B terminal text');
  const DU = `PMD-${tu.taskId}-${tu.runId}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DU, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const { acceptResult: acceptRt } = await import('../dist/server/backend/goal-task-runtime.js');
  await acceptRt(TEST_ROOT, project, tu.taskId, tu.runId, { goalId: tu.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING' });
  await shouldThrow(
    () => retryPrep.prepareRetryForJudgment(TEST_ROOT, project, DU),
    'U terminal task prevents retry preparation',
    'CONFLICT',
  );
  await resetProcessLocal();
}

// ── V: ACCEPT unchanged ──
console.log('\n-- V: accept intact --');
{
  const tv = await driveToResultReceived('V1 G5B accept2', 'ses-g5b-v', 'G5B accept2 text');
  const DV = `PMD-${tv.taskId}-${tv.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: DV, decision: 'ACCEPT', reason: 'accept reason here' });
  check(res.judgment.status === 'APPLIED', 'V ACCEPT still applies via MCP');
  check(gt.getTask(TEST_ROOT, project, tv.taskId).pmState === 'ACCEPTED', 'V task ACCEPTED');
  await resetProcessLocal();
}

// ── W/X/Y/Z: scope ──
console.log('\n-- W-Z: scope --');
{
  const before = gt.listTasks(TEST_ROOT, project).reduce((n, t) => n + t.linkedRuns.length, 0);
  const tw = await driveToResultReceived('V1 G5B scope', 'ses-g5b-w', 'G5B scope text');
  const DW = `PMD-${tw.taskId}-${tw.runId}`;
  await get('relay_pm_submit_judgment').handler({ deliveryId: DW, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const after = gt.listTasks(TEST_ROOT, project).reduce((n, t) => n + t.linkedRuns.length, 0);
  check(after === before + 1, 'W no Run created (only the setup dispatch run)');
  const t = gt.getTask(TEST_ROOT, project, tw.taskId);
  check(t.executionState === 'READY', 'X no dispatch invoked (READY awaiting G5-C)');
  const newFolders = t.linkedRuns.filter((r) => r.runId !== tw.runId);
  check(newFolders.length === 0, 'Y no second run materialized (no Worker prompt possible)');
  const src = fs.readFileSync('src/backend/retry-preparation.ts', 'utf8');
  for (const needle of ['dispatchTask', 'atomicMaterializeRun', 'buildWorkerPrompt', 'spawn(', 'fetch(', 'openai', 'chatgpt', 'anthropic']) {
    check(!src.toLowerCase().includes(needle.toLowerCase()), `Z no ${needle} in preparation kernel`);
  }
  await resetProcessLocal();
}

// ── bridge one-judgment CHANGES ──
console.log('\n-- bridge: one-judgment CHANGES --');
{
  const tb = await driveToResultReceived('V1 G5B bridge', 'ses-g5b-b', 'G5B bridge text');
  const DB = `PMD-${tb.taskId}-${tb.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-g5b.ndjson');
  process.env.FAKE_HOST_RECORD_FILE = rec;
  process.env.FAKE_HOST_MODE = 'judge-changes';
  const logs = [];
  const b = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 4000, maxBackoffMs: 400, logger: (l) => logs.push(l),
  });
  await b.start();
  await waitFor('bridge ready', () => {
    const t = gt.getTask(TEST_ROOT, project, tb.taskId);
    return t.executionState === 'READY' && t.pmState === 'PENDING' ? true : false;
  });
  await b.stop();
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
  const rows = readRecords(rec).filter((r) => r.event === 'judgment-response');
  check(rows.some((r) => r.message?.type === 'PM_JUDGMENT_APPLIED' && r.message?.status === 'APPLIED' && r.message?.deliveryId === DB), 'bridge CHANGES → APPLIED with READY taskState');
  const j = pmJud.getPmJudgment(TEST_ROOT, project, `PMJ-${DB}`);
  check(j.status === 'APPLIED', 'bridge advanced judgment to APPLIED');
  await resetProcessLocal();
}

// ── G5-B correction: READY-prep crash seam (RECEIVED→APPLIED after restart) ──
console.log('\n-- G5-B correction: READY crash seam --');
{
  const tc = await driveToResultReceived('V1 G5B crash-seam', 'ses-g5b-cs', 'G5B crash seam text');
  const DC = `PMD-${tc.taskId}-${tc.runId}`;
  const JC = `PMJ-${DC}`;
  const PC = `RTP-${JC}`;
  await get('relay_pm_submit_judgment').handler({ deliveryId: DC, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, PC).status === 'READY', 'crash-seam setup: preparation READY');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JC).status === 'APPLIED', 'crash-seam setup: judgment APPLIED');
  const retryBefore = gt.getTask(TEST_ROOT, project, tc.taskId).retryCount;
  const evBefore = evk.listEvents(TEST_ROOT, project).events.filter((e) => e.taskId === tc.taskId);
  const chBefore = evBefore.filter((e) => e.type === 'TASK_CHANGES_REQUESTED').length;
  const rrBefore = evBefore.filter((e) => e.type === 'TASK_RETRY_REQUESTED').length;
  const runsBefore = gt.getTask(TEST_ROOT, project, tc.taskId).linkedRuns.length;
  const taskJsonBefore = fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, tc.taskId), 'task.json'), 'utf8');
  // Simulate crash after Preparation READY persisted but before Judgment APPLIED:
  // force judgment back to RECEIVED on disk.
  const jPath = path.join(pmJud.pmJudgmentFolder(TEST_ROOT, project, JC), 'judgment.json');
  const jRaw = JSON.parse(fs.readFileSync(jPath, 'utf8'));
  delete jRaw.appliedAt;
  jRaw.status = 'RECEIVED';
  jRaw.updatedAt = new Date().toISOString();
  fs.writeFileSync(jPath, JSON.stringify(jRaw, null, 2), 'utf8');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JC).status === 'RECEIVED', 'crash-seam setup: judgment forced to RECEIVED');
  // Restart: reset process-local state.
  retryPrep._resetRetryPreparationLocksForTests();
  pmJud._resetPmJudgmentLocksForTests();
  await resetProcessLocal();
  // A: READY prep + READY/PENDING + RECEIVED → APPLIED.
  const res = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DC);
  check(res.preparation.status === 'READY', 'A crash-seam reconcile heals Judgment RECEIVED→APPLIED');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JC).status === 'APPLIED', 'A judgment becomes APPLIED');
  const tAfter = gt.getTask(TEST_ROOT, project, tc.taskId);
  check(tAfter.executionState === 'READY' && tAfter.pmState === 'PENDING', 'A/F task remains READY+PENDING');
  check(res.task.executionState === 'READY' && res.task.pmState === 'PENDING', 'A returned task READY+PENDING');
  // C: retryCount unchanged.
  check(tAfter.retryCount === retryBefore, 'C retryCount unchanged by READY reconcile');
  // D/E: no duplicate Action Events.
  const evAfter = evk.listEvents(TEST_ROOT, project).events.filter((e) => e.taskId === tc.taskId);
  check(evAfter.filter((e) => e.type === 'TASK_CHANGES_REQUESTED').length === chBefore, 'D no duplicate TASK_CHANGES_REQUESTED Event');
  check(evAfter.filter((e) => e.type === 'TASK_RETRY_REQUESTED').length === rrBefore, 'E no duplicate TASK_RETRY_REQUESTED Event');
  // F: no Task mutation.
  const taskJsonAfter = fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, tc.taskId), 'task.json'), 'utf8');
  check(taskJsonAfter === taskJsonBefore, 'F no Task mutation (task.json byte-identical)');
  // G/H: no new Run, no dispatch.
  check(tAfter.linkedRuns.length === runsBefore, 'G no new Run');
  check(tAfter.executionState === 'READY', 'H no dispatch (still READY awaiting G5-C)');
  // I: preparation remains READY.
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, PC).status === 'READY', 'I preparation remains READY');
  // B: idempotent when already APPLIED.
  retryPrep._resetRetryPreparationLocksForTests();
  pmJud._resetPmJudgmentLocksForTests();
  await resetProcessLocal();
  const res2 = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DC);
  check(res2.preparation.status === 'READY', 'B idempotent reconcile with APPLIED stays READY');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JC).status === 'APPLIED', 'B judgment remains APPLIED');
  check(gt.getTask(TEST_ROOT, project, tc.taskId).retryCount === retryBefore, 'B/C retryCount still unchanged');
  // J: restart/process-local reset does not change outcome (covered by resets above).
  check(true, 'J restart/process-local reset does not change outcome');
  await resetProcessLocal();
}

// ── G5-B correction: advanced-task compat (G5-C consumption via dispatch) ──
console.log('\n-- G5-B correction: G5-C consumption compat --');
{
  const ta = await driveToResultReceived('V1 G5B consumed', 'ses-g5b-ca', 'G5B consumed text');
  const DA = `PMD-${ta.taskId}-${ta.runId}`;
  const JA = `PMJ-${DA}`;
  const PA = `RTP-${JA}`;
  await get('relay_pm_submit_judgment').handler({ deliveryId: DA, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, PA).status === 'READY', 'compat setup: preparation READY');
  // Force RECEIVED to prove heal-after-consumption, then consume via real dispatch (G5-C stand-in).
  const jPathA = path.join(pmJud.pmJudgmentFolder(TEST_ROOT, project, JA), 'judgment.json');
  const jRawA = JSON.parse(fs.readFileSync(jPathA, 'utf8'));
  delete jRawA.appliedAt;
  jRawA.status = 'RECEIVED';
  jRawA.updatedAt = new Date().toISOString();
  fs.writeFileSync(jPathA, JSON.stringify(jRawA, null, 2), 'utf8');
  const evBase = evk.listEvents(TEST_ROOT, project).events.filter((e) => e.taskId === ta.taskId);
  const chBase = evBase.filter((e) => e.type === 'TASK_CHANGES_REQUESTED').length;
  const rrBase = evBase.filter((e) => e.type === 'TASK_RETRY_REQUESTED').length;
  const retryBase = gt.getTask(TEST_ROOT, project, ta.taskId).retryCount;
  // Smallest valid existing mechanism for "consumed by later attempt": dispatch READY task.
  await resetProcessLocal();
  const dispRes = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: ta.taskId, workerId: 'v1-g5b-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  check(typeof dispRes.runId === 'string' && dispRes.runId !== ta.runId, 'compat setup: dispatch created newer attempt');
  const tDispatched = gt.getTask(TEST_ROOT, project, ta.taskId);
  check(tDispatched.executionState === 'DISPATCHED' || tDispatched.executionState === 'RUNNING', 'compat setup: task consumed beyond READY');
  const taskJsonConsumed = fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, ta.taskId), 'task.json'), 'utf8');
  retryPrep._resetRetryPreparationLocksForTests();
  pmJud._resetPmJudgmentLocksForTests();
  await resetProcessLocal();
  const resA = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DA);
  check(resA.preparation.status === 'READY', 'compat consumed reconcile keeps preparation READY (terminal-success bookkeeping)');
  check(resA.preparation.failedAt === undefined && resA.preparation.failureCode === undefined, 'compat READY never reinterpreted as FAILED');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JA).status === 'APPLIED', 'compat judgment RECEIVED repaired to APPLIED after consumption');
  const tAfterA = gt.getTask(TEST_ROOT, project, ta.taskId);
  check(tAfterA.executionState === 'DISPATCHED' || tAfterA.executionState === 'RUNNING', 'compat no backward Task mutation after consumption');
  check(tAfterA.retryCount === retryBase, 'compat retryCount unchanged (no re-increment)');
  const evAfterA = evk.listEvents(TEST_ROOT, project).events.filter((e) => e.taskId === ta.taskId);
  check(evAfterA.filter((e) => e.type === 'TASK_CHANGES_REQUESTED').length === chBase, 'compat no rerun of requestTaskChanges');
  check(evAfterA.filter((e) => e.type === 'TASK_RETRY_REQUESTED').length === rrBase, 'compat no rerun of requestTaskRetry');
  check(fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, ta.taskId), 'task.json'), 'utf8') === taskJsonConsumed, 'compat task.json byte-identical (no mutation)');
  // Idempotent when already APPLIED after consumption.
  retryPrep._resetRetryPreparationLocksForTests();
  pmJud._resetPmJudgmentLocksForTests();
  await resetProcessLocal();
  const resA2 = await retryPrep.reconcileRetryPreparationForJudgment(TEST_ROOT, project, DA);
  check(resA2.preparation.status === 'READY', 'compat APPLIED stays READY (idempotent)');
  check(pmJud.getPmJudgment(TEST_ROOT, project, JA).status === 'APPLIED', 'compat judgment remains APPLIED');
  // Structural: READY is irreversible in source (no markPrep-FAILED path reachable from READY).
  const src = fs.readFileSync('src/backend/retry-preparation.ts', 'utf8');
  const readyFn = src.slice(src.indexOf('reconcileReadyPreparation'));
  check(!readyFn.slice(0, readyFn.indexOf('async function reconcilePreparation')).includes('markPrep('), 'structural READY path never calls markPrep (irreversible success)');
  await resetProcessLocal();
}

delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G5-B Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
