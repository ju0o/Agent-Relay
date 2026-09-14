/**
 * V1-G5-A — Structured PM Judgment intake + ACCEPT path.
 *
 * V1 drive always through canonical surfaces:
 *   relay_pm_create_task → relay_pm_dispatch_owner_approved →
 *   injected bound RESPONSE_COMPLETE (delivery auto-minted).
 *
 * Proves:
 *   A. valid ACCEPT by deliveryId only
 *   B. valid CHANGES intent by deliveryId only
 *   C. taskId/runId/goalId/path injection rejected
 *   D. unsupported decision rejected
 *   E. bad protocol rejected
 *   F. CHANGES reason <10 rejected
 *   G. CHANGES retryInstruction missing rejected
 *   H. oversized retryInstruction rejected
 *   I. stale historical delivery rejected (REJECTED record, no mutation)
 *   J. wrong Task state rejected
 *   K. ACCEPT uses canonical acceptTaskResult
 *   L. ACCEPT → ACCEPTED + acceptedRunId = delivery.runId
 *   M. TASK_RESULT_ACCEPTED Event via canonical path
 *   N. matching duplicate ACCEPT idempotent
 *   O. conflicting second decision rejected
 *   P. conflicting CHANGES payload rejected
 *   Q. CHANGES persists judgment + retry instruction
 *   R. CHANGES does NOT mutate Task state
 *   S. bridge PM_DELIVERY_RECEIVED unchanged
 *   T. bridge PM_TASK_JUDGMENT round-trip (ACCEPT + CHANGES)
 *   U. MCP uses the same backend
 *   V. no requestTaskChanges called
 *   W. no requestTaskRetry called
 *   X. no dispatch called
 *   Y. no OpenAI/ChatGPT dependency
 *   Z. restart re-reads durable judgment + retry instruction
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g5a-${process.pid}-${Date.now()}`);
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
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const evk = await import('../dist/server/backend/event.js');const captureSvc = await import('../dist/server/backend/capture-service.js');
const bridgeMod = await import('../dist/server/backend/pm-host-bridge.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const FAKE_HOST = path.resolve(__dirname, 'fixtures/hosts/fake-pm-host.mjs');
const NODE = process.execPath;

const project = 'V1G5AProj';
const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g5a-worker',
  displayName: 'v1-g5a-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G5A judgment task',
  goal: 'Intended outcome for V1 worker review',
  reason: 'PM finalized contract reason for review',
  scope: 'Narrow V1 review scope',
  completionCriteria: ['done when worker result received'],
};

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
    taskId: inc.task.taskId, workerId: 'v1-g5a-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
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

const submit = (args) => get('relay_pm_submit_judgment').handler(args);
// Backend intake directly: proves the G5-A boundary (durable intent, no Task
// mutation). The MCP/bridge surfaces now chain G5-B preparation on top.
const submitBackend = (args) => pmJud.submitPmJudgment(TEST_ROOT, project, args);

// ── A/K/L/M: ACCEPT path ──
console.log('\n-- A/K/L/M: ACCEPT --');
const ta = await driveToResultReceived('V1 G5A accept', 'ses-g5a-a', 'G5A accept result text');
const DA = `PMD-${ta.taskId}-${ta.runId}`;
{
  const res = await submit({ deliveryId: DA, decision: 'ACCEPT', reason: 'looks good, accept it' });
  check(res.judgment.status === 'APPLIED' && res.applied === true, 'A valid ACCEPT applied by deliveryId only');
  check(res.judgment.decision === 'ACCEPT', 'A decision recorded');
  const t = gt.getTask(TEST_ROOT, project, ta.taskId);
  check(t.pmState === 'ACCEPTED', 'L pmState ACCEPTED');
  check(t.acceptedRunId === ta.runId, 'L acceptedRunId = delivery.runId');
  const events = evk.listEvents(TEST_ROOT, project).events;
  const acc = events.filter((e) => e.type === 'TASK_RESULT_ACCEPTED' && e.taskId === ta.taskId);
  check(acc.length === 1 && acc[0].runId === ta.runId, 'M TASK_RESULT_ACCEPTED via canonical path');
}

// ── N: duplicate ACCEPT idempotent ──
console.log('\n-- N: duplicate ACCEPT --');
{
  const before = pmJud.listPmJudgments(TEST_ROOT, project).length;
  const res = await submit({ deliveryId: DA, decision: 'ACCEPT', reason: 'looks good, accept it' });
  check(res.judgment.status === 'APPLIED' && res.applied === false, 'N matching duplicate replays applied, no re-apply');
  check(pmJud.listPmJudgments(TEST_ROOT, project).length === before, 'N no duplicate record');
}

// ── N2: finalized Task reconciles a stale PENDING Delivery at widget listing ──
console.log('\n-- N2: finalized Delivery reconciliation --');
{
  const file = path.join(pmDel.pmDeliveryFolder(TEST_ROOT, project, DA), 'delivery.json');
  const stale = JSON.parse(fs.readFileSync(file, 'utf8'));
  stale.status = 'PENDING';
  delete stale.deliveredAt;
  delete stale.acknowledgedAt;
  fs.writeFileSync(file, JSON.stringify(stale, null, 2) + '\n');
  const before = pmJud.listPmJudgments(TEST_ROOT, project).length;
  const listed = await get('relay_pm_list_pending_deliveries').handler({});
  check(listed.deliveries.every((d) => d.deliveryId !== DA), 'N2 widget listing suppresses finalized stale delivery');
  check(pmDel.getPmDelivery(TEST_ROOT, project, DA).status === 'ACKNOWLEDGED', 'N2 PENDING → DELIVERED → ACKNOWLEDGED');
  await pmDel.reconcileFinalizedPmDeliveries(TEST_ROOT, project);
  check(pmDel.getPmDelivery(TEST_ROOT, project, DA).status === 'ACKNOWLEDGED', 'N2 repeated reconciliation is idempotent');
  check(pmJud.listPmJudgments(TEST_ROOT, project).length === before, 'N2 no duplicate judgment record');
}

// ── O: conflicting decision ──
console.log('\n-- O: conflict --');
{
  await shouldThrow(
    () => submit({ deliveryId: DA, decision: 'CHANGES', reason: 'change your mind, please do', retryInstruction: 'do x' }),
    'O conflicting second decision rejected',
    'CONFLICT',
  );
}

// ── B/Q/R: CHANGES intent ──
console.log('\n-- B/Q/R: CHANGES --');
const tc = await driveToResultReceived('V1 G5A changes', 'ses-g5a-c', 'G5A changes result text');
const DC = `PMD-${tc.taskId}-${tc.runId}`;
{
  // Backend intake boundary: durable intent, Task untouched. (MCP/bridge now
  // chain G5-B preparation on top — covered by the G5-B suite.)
  const res = await submitBackend({
    deliveryId: DC, decision: 'CHANGES',
    reason: 'please address the review nits above',
    retryInstruction: 'fix the nits and re-verify typecheck',
  });
  check(res.judgment.status === 'RECEIVED' && res.applied === false, 'B CHANGES intent recorded, not applied');
  check(res.judgment.retryInstructionPresent === true, 'Q retry instruction flagged');
  const folder = pmJud.pmJudgmentFolder(TEST_ROOT, project, `PMJ-${DC}`);
  const intent = JSON.parse(fs.readFileSync(path.join(folder, 'intent.json'), 'utf8'));
  check(intent.decision === 'CHANGES' && intent.deliveryId === DC, 'Q atomic intent payload identity');
  check(intent.retryInstruction === 'fix the nits and re-verify typecheck', 'Q intent retry instruction bytes durable');
  check(pmJud.getRetryInstructionForDelivery(TEST_ROOT, project, DC) === 'fix the nits and re-verify typecheck', 'Q accessor returns exact bytes');
  const t = gt.getTask(TEST_ROOT, project, tc.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING', 'R Task untouched by CHANGES');
  check(t.acceptedRunId === undefined, 'R no acceptance side effect');
}

// ── P: conflicting CHANGES payload ──
console.log('\n-- P: payload conflict --');
{
  await shouldThrow(
    () => submitBackend({ deliveryId: DC, decision: 'CHANGES', reason: 'a different reason entirely here', retryInstruction: 'fix the nits and re-verify typecheck' }),
    'P different reason rejected',
    'CONFLICT',
  );
  await shouldThrow(
    () => submitBackend({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'different instruction' }),
    'P different retryInstruction rejected',
    'CONFLICT',
  );
  // Identical resubmit replays.
  const res = await submitBackend({
    deliveryId: DC, decision: 'CHANGES',
    reason: 'please address the review nits above',
    retryInstruction: 'fix the nits and re-verify typecheck',
  });
  check(res.judgment.status === 'RECEIVED', 'P identical CHANGES replays');
}

// ── C/D/E/F/G/H: validation ──
console.log('\n-- C-H: validation --');
{
  await shouldThrow(() => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'fix the nits and re-verify typecheck', taskId: tc.taskId }), 'C taskId injection rejected', 'taskId');
  await shouldThrow(() => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'fix the nits and re-verify typecheck', runId: tc.runId }), 'C runId injection rejected', 'runId');
  await shouldThrow(() => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'fix the nits and re-verify typecheck', goalId: tc.goalId }), 'C goalId injection rejected', 'goalId');
  await shouldThrow(() => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'fix the nits and re-verify typecheck', workspaceRoot: WORKSPACE }), 'C path injection rejected', 'workspaceRoot');
  await shouldThrow(() => submit({ deliveryId: DC, decision: 'MAYBE' }), 'D unsupported decision rejected', 'INVALID_ARGUMENT');
  await shouldThrow(
    () => pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: DC, decision: 'ACCEPT', protocolVersion: 2 }),
    'E bad protocol rejected',
    'protocolVersion',
  );
  await shouldThrow(
    () => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'too short', retryInstruction: 'fix it' }),
    'F short reason rejected',
    'INVALID_ARGUMENT',
  );
  await shouldThrow(
    () => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above' }),
    'G missing retryInstruction rejected',
    'INVALID_ARGUMENT',
  );
  await shouldThrow(
    () => submit({ deliveryId: DC, decision: 'CHANGES', reason: 'please address the review nits above', retryInstruction: 'x'.repeat(4001) }),
    'H oversized retryInstruction rejected',
    'INVALID_ARGUMENT',
  );
  await shouldThrow(
    () => submit({ deliveryId: DA, decision: 'ACCEPT', reason: 'fine', retryInstruction: 'must not be here' }),
    'ACCEPT with retryInstruction rejected',
    'INVALID_ARGUMENT',
  );
}

// ── I: stale historical delivery ──
console.log('\n-- I: stale --');
{
  const t = await driveToResultReceived('V1 G5A stale', 'ses-g5a-s1', 'G5A stale text one');
  const Dold = `PMD-${t.taskId}-${t.runId}`;
  await rt.requestChanges(TEST_ROOT, project, t.taskId, t.runId, {
    goalId: t.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'g5a stale fixture reason',
  });
  await rt.requestRetry(TEST_ROOT, project, t.taskId, {
    goalId: t.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  await resetProcessLocal();
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: t.taskId, workerId: 'v1-g5a-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, 'ses-g5a-s2');
  cm.injectCompletionForTests(folder, responseComplete('ses-g5a-s2', 'G5A stale text two'));
  await sleep(150);
  await shouldThrow(
    () => submit({ deliveryId: Dold, decision: 'ACCEPT', reason: 'stale accept attempt here' }),
    'I stale delivery rejected',
    'CONFLICT',
  );
  const rej = pmJud.getPmJudgment(TEST_ROOT, project, `PMJ-${Dold}`);
  check(rej.status === 'REJECTED', 'I stable REJECTED record, no mutation');
  const cur = gt.getTask(TEST_ROOT, project, t.taskId);
  check(cur.executionState === 'RESULT_RECEIVED' && cur.acceptedRunId === undefined, 'I newer attempt untouched');
  await resetProcessLocal();
}

// ── J: wrong Task state ──
console.log('\n-- J: wrong state --');
{
  const t = await driveToResultReceived('V1 G5A wrongstate', 'ses-g5a-j', 'G5A wrongstate text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  await rt.requestChanges(TEST_ROOT, project, t.taskId, t.runId, {
    goalId: t.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'g5a wrongstate fixture reason',
  });
  await shouldThrow(
    () => submit({ deliveryId: D, decision: 'ACCEPT', reason: 'accept while changes requested' }),
    'J ACCEPT in CHANGES_REQUESTED rejected',
    'CONFLICT',
  );
  const cur = gt.getTask(TEST_ROOT, project, t.taskId);
  check(cur.pmState === 'CHANGES_REQUESTED', 'J Task state preserved');
  await resetProcessLocal();
}

// ── S: receipt path unchanged ──
console.log('\n-- S: receipt intact --');
{
  const t = await driveToResultReceived('V1 G5A receipt', 'ses-g5a-r', 'G5A receipt text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-s.ndjson');
  process.env.FAKE_HOST_RECORD_FILE = rec;
  process.env.FAKE_HOST_MODE = 'ack';
  const logs = [];
  const b = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 3000, maxBackoffMs: 400, logger: (l) => logs.push(l),
  });
  await b.start();
  await waitFor('s ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await b.stop();
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
  check(true, 'S PM_DELIVERY_RECEIVED still drives ACKNOWLEDGED');
  await resetProcessLocal();
}

// ── T: bridge judgment round-trip ──
console.log('\n-- T: bridge judgment --');
{
  const ta2 = await driveToResultReceived('V1 G5A bridge accept', 'ses-g5a-t1', 'G5A bridge accept text');
  const DA2 = `PMD-${ta2.taskId}-${ta2.runId}`;
  const recA = path.join(TEST_ROOT, 'rec-ta.ndjson');
  process.env.FAKE_HOST_RECORD_FILE = recA;
  process.env.FAKE_HOST_MODE = 'judge-accept';
  const ba = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 4000, maxBackoffMs: 400, logger: () => {},
  });
  await ba.start();
  await waitFor('t accept', () => gt.getTask(TEST_ROOT, project, ta2.taskId).pmState === 'ACCEPTED');
  // PM state becomes durable before the asynchronous stdio acknowledgement is
  // necessarily flushed. Wait for the response contract we assert below before
  // stopping the fixture, rather than racing bridge shutdown against writeLine.
  await waitFor('t accept response', () => readRecords(recA).some((r) =>
    r.event === 'judgment-response'
      && r.message?.type === 'PM_JUDGMENT_APPLIED'
      && r.message?.status === 'APPLIED'
      && r.message?.deliveryId === DA2,
  ));
  await ba.stop();
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
  const rowsA = readRecords(recA).filter((r) => r.event === 'judgment-response');
  check(rowsA.some((r) => r.message?.type === 'PM_JUDGMENT_APPLIED' && r.message?.status === 'APPLIED' && r.message?.deliveryId === DA2), 'T ACCEPT round-trip APPLIED over stdio');
  await resetProcessLocal();

  const tc2 = await driveToResultReceived('V1 G5A bridge changes', 'ses-g5a-t2', 'G5A bridge changes text');
  const DC2 = `PMD-${tc2.taskId}-${tc2.runId}`;
  const recC = path.join(TEST_ROOT, 'rec-tc.ndjson');
  process.env.FAKE_HOST_RECORD_FILE = recC;
  process.env.FAKE_HOST_MODE = 'judge-changes';
  const bc = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 4000, maxBackoffMs: 400, logger: () => {},
  });
  await bc.start();
  await waitFor('t changes', () => {
    try { return pmJud.getPmJudgment(TEST_ROOT, project, `PMJ-${DC2}`).status === 'APPLIED'; } catch { return false; }
  });
  await waitFor('t changes response', () => readRecords(recC).some((r) =>
    r.event === 'judgment-response'
      && r.message?.type === 'PM_JUDGMENT_APPLIED'
      && r.message?.status === 'APPLIED'
      && r.message?.deliveryId === DC2,
  ));
  await bc.stop();
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
  const rowsC = readRecords(recC).filter((r) => r.event === 'judgment-response');
  check(rowsC.some((r) => r.message?.type === 'PM_JUDGMENT_APPLIED' && r.message?.status === 'APPLIED' && r.message?.deliveryId === DC2), 'T CHANGES round-trip APPLIED over stdio (G5-B auto-prepare)');
  const tc2after = gt.getTask(TEST_ROOT, project, tc2.taskId);
  check(tc2after.executionState === 'READY' && tc2after.pmState === 'PENDING', 'T CHANGES via bridge reaches READY+PENDING');
  await resetProcessLocal();
}

// ── U: MCP/backend parity ──
console.log('\n-- U: parity --');
{
  const t = await driveToResultReceived('V1 G5A parity', 'ses-g5a-u', 'G5A parity text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const viaBackend = await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'ACCEPT', reason: 'parity accept reason here' });
  check(viaBackend.judgment.judgmentId === `PMJ-${D}` && viaBackend.judgment.status === 'APPLIED', 'U backend intake applies');
  check(pmJud.getPmJudgment(TEST_ROOT, project, `PMJ-${D}`).status === 'APPLIED', 'U same record readable after MCP-surface flow');
  const pmSrc = fs.readFileSync('src/mcp/pm-tools.ts', 'utf8');
  check(pmSrc.includes('submitPmJudgment'), 'U MCP delegates to the single backend intake');
  await resetProcessLocal();
}

// ── V/W/X/Y: static scope ──
console.log('\n-- V-Y: static scope --');
{
  const src = fs.readFileSync('src/backend/pm-judgment.ts', 'utf8');
  for (const needle of ['requestTaskChanges', 'requestTaskRetry', 'dispatchTask', 'completeGoal', 'markResultReceived', 'spawn(', 'exec(']) {
    check(!src.includes(needle), `V/W/X no ${needle} in judgment kernel`);
  }
  check(src.includes('acceptTaskResult'), 'K canonical acceptTaskResult used');
  const combined = src + fs.readFileSync('src/backend/pm-host-bridge.ts', 'utf8');
  check(!/openai|chatgpt|anthropic/i.test(combined), 'Y no OpenAI/ChatGPT dependency');
}

// ── Z: restart durability ──
console.log('\n-- Z: durability --');
{
  const folder = pmJud.pmJudgmentFolder(TEST_ROOT, project, `PMJ-${DC}`);
  const diskRecord = JSON.parse(fs.readFileSync(path.join(folder, 'judgment.json'), 'utf8'));
  check(diskRecord.status === 'RECEIVED' && diskRecord.decision === 'CHANGES', 'Z judgment re-read from disk');
  check(pmJud.getRetryInstructionForDelivery(TEST_ROOT, project, DC) === 'fix the nits and re-verify typecheck', 'Z retry instruction re-read from disk');
  const res = await submitBackend({
    deliveryId: DC, decision: 'CHANGES',
    reason: 'please address the review nits above',
    retryInstruction: 'fix the nits and re-verify typecheck',
  });
  check(res.judgment.status === 'RECEIVED', 'Z identical resubmit replays durable intent');
}

await resetProcessLocal();
delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G5-A Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
