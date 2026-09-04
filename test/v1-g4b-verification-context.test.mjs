/**
 * V1-G4-B — PM Verification Context delivery.
 *
 * Full path begins through V1 surfaces (never manufactured):
 *   relay_pm_create_task → relay_pm_dispatch_owner_approved →
 *   injected bound RESPONSE_COMPLETE → RESULT_RECEIVED + VERIFYING →
 *   durable TASK_VERIFY delivery → relay_pm_get_verification_context.
 *
 * Proves:
 *   A. current delivery → one verification packet
 *   B. input is deliveryId only
 *   C. packet binds exact taskId/runId from the delivery
 *   D. result.md read and included
 *   E. agent-result.md fallback
 *   F. missing both → warning, no fabricated text
 *   G. hard-cap truncation
 *   H. no session-store / reasoning-trace reads
 *   I. no absolute Run folder leak
 *   J. Task human context included and bounded
 *   K. completionCriteria included
 *   L. ADAPTER_OBSERVATION selected for the exact run
 *   M. OBSERVED remains OBSERVED
 *   N. selected-Evidence bound enforced
 *   O. isCurrentAttempt=true on the current packet
 *   P. displaced delivery → isCurrentAttempt=false + warning + NO_JUDGMENT
 *   Q. CAS snapshot matches Task + Delivery state
 *   R. composer is PURE READ (state + deterministic output identical)
 *   S. G5 methods never called
 *   T. Phase F PM Gateway behavior unchanged
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g4b-${process.pid}-${Date.now()}`);
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
const evidence = await import('../dist/server/backend/evidence.js');
const evk = await import('../dist/server/backend/event.js');
const pmWork = await import('../dist/server/backend/pm-work.js');
const pmGateway = await import('../dist/server/backend/pm-gateway.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

const project = 'V1G4BProj';
const ctx = { dataRoot: TEST_ROOT, project };
const tools = pmTools.buildAllPmTools(ctx);
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g4b-worker',
  displayName: 'v1-g4b-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G4B verify task',
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
    taskId: inc.task.taskId, workerId: 'v1-g4b-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
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

const getCtx = (deliveryId) => get('relay_pm_get_verification_context').handler({ deliveryId });

// ── main task → delivery ──
const t1 = await driveToResultReceived('V1 G4B main', 'ses-g4b-1', 'G4B synthetic final result main');
const D1 = `PMD-${t1.taskId}-${t1.runId}`;

// ── A/C/D: one packet, exact binding, result text ──
console.log('\n-- A/C/D: packet composition --');
let p1;
{
  p1 = await getCtx(D1);
  check(p1.schemaVersion === 'V1-G4B.1', 'A packet schema version');
  check(p1.project === project, 'A packet project');
  check(p1.delivery.deliveryId === D1 && p1.delivery.kind === 'TASK_VERIFY', 'C delivery view from delivery');
  check(p1.task.taskId === t1.taskId, 'C task binding exact');
  check(p1.attempt.runId === t1.runId, 'C attempt binding exact');
  check(p1.result.text === 'G4B synthetic final result main', 'D result.md text included verbatim');
  check(p1.result.truncated === false && p1.result.source === 'result.md', 'D source result.md, not truncated');
  check(
    Array.isArray(p1.reviewActions) && p1.reviewActions.includes('ACCEPT_RESULT') && p1.reviewActions.includes('REQUEST_CHANGES'),
    'A current valid packet advises ACCEPT/CHANGES (advisory only)',
  );
}

// ── B: deliveryId only ──
console.log('\n-- B: narrow input --');
{
  await shouldThrow(() => getCtx('PMD-TASK-0001-nope'), 'B unknown delivery NOT_FOUND', 'NOT_FOUND');
  await shouldThrow(
    () => get('relay_pm_get_verification_context').handler({ deliveryId: D1, taskId: t1.taskId }),
    'B taskId injection rejected',
    'taskId',
  );
  await shouldThrow(
    () => get('relay_pm_get_verification_context').handler({ deliveryId: D1, runId: t1.runId }),
    'B runId injection rejected',
    'runId',
  );
  await shouldThrow(
    () => get('relay_pm_get_verification_context').handler({ deliveryId: D1, folder: t1.folder }),
    'B path injection rejected',
    'folder',
  );
  const schema = get('relay_pm_get_verification_context').inputSchema;
  check(schema.additionalProperties === false, 'B schema additionalProperties=false');
}

// ── E/F: fallback + missing ──
console.log('\n-- E/F: result fallback --');
{
  fs.rmSync(path.join(t1.folder, 'result.md'));
  const fb = await getCtx(D1);
  check(fb.result.source === 'agent-result.md', 'E agent-result.md fallback');
  check(fb.result.text === 'G4B synthetic final result main', 'E fallback text intact');
  check(fb.warnings.some((w) => w.includes('fell back')), 'E fallback warning');
  fs.rmSync(path.join(t1.folder, 'agent-result.md'));
  const miss = await getCtx(D1);
  check(miss.result.text === '' && miss.result.source === 'missing' && miss.result.truncated === false, 'F missing files → empty, no fabrication');
  check(miss.warnings.some((w) => w.includes('both missing')), 'F missing warning');
}

// ── G: hard cap ──
console.log('\n-- G: truncation --');
{
  const tb = await driveToResultReceived('V1 G4B big', 'ses-g4b-big', 'short seed');
  fs.writeFileSync(path.join(tb.folder, 'result.md'), 'X'.repeat(15000), 'utf8');
  const pkt = await getCtx(`PMD-${tb.taskId}-${tb.runId}`);
  check(pkt.result.truncated === true, 'G oversized result truncated');
  check(pkt.result.text.length === 10000, `G hard cap 10000 chars (got ${pkt.result.text.length})`);
  check(pkt.warnings.some((w) => w.includes('truncated')), 'G truncation warning');
}

// ── H/I: no forbidden reads or leaks ──
console.log('\n-- H/I: safety --');
{
  const src = fs.readFileSync('src/backend/pm-verification-context.ts', 'utf8');
  for (const needle of ['transcript', 'chain-of-thought', 'chainOfThought', 'rawFinalText', 'sessionId', 'environment', 'process.env']) {
    check(!src.includes(needle), `H composer never touches ${needle}`);
  }
  const json = JSON.stringify(p1);
  check(!json.includes(t1.folder), 'I no absolute Run folder leaked');
  check(!json.includes(WORKSPACE), 'I no workspace path leaked');
  check(!json.includes('sessionId'), 'I no session identity leaked');
}

// ── J/K: bounded Task context ──
console.log('\n-- J/K: task context --');
{
  check(p1.task.title === 'V1 G4B main', 'J title included');
  for (const [k, v] of [['goal', p1.task.goal], ['reason', p1.task.reason], ['scope', p1.task.scope]]) {
    check(typeof v === 'string' && v.length > 0 && v.length <= 2000, `J ${k} present and bounded`);
  }
  check(JSON.stringify(p1.task.completionCriteria) === JSON.stringify(CONTRACT.completionCriteria), 'K completionCriteria included');
  check(!JSON.stringify(p1).includes('linkedRuns'), 'J no attempt history leaked');
}

// ── L/M: exact-run evidence, trust preserved ──
console.log('\n-- L/M: evidence --');
{
  check(p1.evidence.summary.totalCount >= 1, 'L evidence summary present');
  const obs = p1.evidence.selected.filter((e) => e.type === 'ADAPTER_OBSERVATION');
  check(obs.length >= 1, 'L ADAPTER_OBSERVATION selected');
  for (const e of obs) {
    const full = evidence.getEvidence(TEST_ROOT, project, e.evidenceId);
    check(full.runId === t1.runId && full.taskId === t1.taskId, `L ${e.evidenceId} stamped exact run`);
  }
  check(obs.every((e) => e.trustLevel === 'OBSERVED'), 'M OBSERVED remains OBSERVED (never VERIFIED)');
}

// ── N: selection bound ──
console.log('\n-- N: evidence cap --');
{
  for (let i = 0; i < 6; i++) {
    await evidence.recordWorkerClaim(TEST_ROOT, project, {
      summary: `extra claim ${i}`, goalId: t1.goalId, taskId: t1.taskId, runId: t1.runId, source: { kind: 'worker' },
    });
  }
  const pkt = await getCtx(D1);
  check(pkt.evidence.selected.length === 5, `N selected capped at 5 (got ${pkt.evidence.selected.length})`);
  check(pkt.warnings.some((w) => w.includes('capped')), 'N cap warning');
  check(pkt.evidence.selected[0].type === 'ADAPTER_OBSERVATION', 'N observation keeps priority');
}

// ── O: current attempt ──
console.log('\n-- O: current --');
{
  check(p1.attempt.isCurrentAttempt === true, 'O isCurrentAttempt=true');
  check(p1.attempt.currentAttemptRunId === t1.runId, 'O currentAttemptRunId exact');
}

// ── P: displaced delivery ──
console.log('\n-- P: stale safety --');
{
  await rt.requestChanges(TEST_ROOT, project, t1.taskId, t1.runId, {
    goalId: t1.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'g4b changes fixture reason',
  });
  await rt.requestRetry(TEST_ROOT, project, t1.taskId, {
    goalId: t1.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  await resetProcessLocal();
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: t1.taskId, workerId: 'v1-g4b-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, t1.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, 'ses-g4b-2');
  cm.injectCompletionForTests(folder, responseComplete('ses-g4b-2', 'G4B second attempt text'));
  await sleep(150);
  const stale = await getCtx(D1);
  check(stale.attempt.isCurrentAttempt === false, 'P displaced delivery explicit false');
  check(stale.attempt.currentAttemptRunId === res.runId, 'P current attempt exposed, not substituted');
  check(stale.warnings.some((w) => w.includes('displaced historical attempt')), 'P stale warning');
  check(stale.reviewActions.length === 1 && stale.reviewActions[0] === 'NO_JUDGMENT', 'P no judgment advisory on stale');
  check(stale.result.text === '' && stale.result.source === 'missing', 'P stale packet does not borrow newer result');
}

// ── Q: CAS snapshot ──
console.log('\n-- Q: CAS --');
{
  await get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D1, expectedStatus: 'PENDING' });
  const pkt = await getCtx(D1);
  check(pkt.cas.expectedExecutionState === 'RESULT_RECEIVED', 'Q execution CAS');
  check(pkt.cas.expectedPmState === 'VERIFYING', 'Q pm CAS');
  check(pkt.cas.expectedDeliveryStatus === 'DELIVERED', `Q delivery CAS tracks status (got ${pkt.cas.expectedDeliveryStatus})`);
}

// ── R: pure read ──
console.log('\n-- R: read-only --');
{
  const taskBefore = fs.readFileSync(path.join(TEST_ROOT, project, '_relay', 'tasks', t1.taskId, 'task.json'), 'utf8');
  const delBefore = fs.readFileSync(path.join(TEST_ROOT, project, '_relay', 'pm-deliveries', D1, 'delivery.json'), 'utf8');
  const evBefore = evk.listEvents(TEST_ROOT, project).events.length;
  const evdBefore = evidence.listEvidenceForTask(TEST_ROOT, project, t1.taskId, true).length;
  const a = await getCtx(D1);
  const b = await getCtx(D1);
  check(JSON.stringify(a) === JSON.stringify(b), 'R deterministic rebuild');
  check(fs.readFileSync(path.join(TEST_ROOT, project, '_relay', 'tasks', t1.taskId, 'task.json'), 'utf8') === taskBefore, 'R Task untouched');
  check(fs.readFileSync(path.join(TEST_ROOT, project, '_relay', 'pm-deliveries', D1, 'delivery.json'), 'utf8') === delBefore, 'R Delivery untouched');
  check(evk.listEvents(TEST_ROOT, project).events.length === evBefore, 'R no Event minted');
  check(evidence.listEvidenceForTask(TEST_ROOT, project, t1.taskId, true).length === evdBefore, 'R no Evidence created');
}

// ── S: no judgment surface ──
console.log('\n-- S: scope --');
{
  const src = fs.readFileSync('src/backend/pm-verification-context.ts', 'utf8');
  for (const needle of ['acceptTaskResult', 'requestTaskChanges', 'requestTaskRetry', 'dispatchTask', 'completeGoal',
    'markResultReceived', 'recordAdapterObservation', 'recordRunResultReceived', 'markPmDeliveryDelivered',
    'acknowledgePmDelivery', 'ignorePmDelivery', 'markDelivered(', 'recordEvent', 'createEvidence', 'fetch(']) {
    check(!src.includes(needle), `S composer never calls ${needle}`);
  }
  const names = tools.map((t) => t.name);
  check(!names.some((n) => n.includes('wake') || n.includes('deliver_result')), 'S no wake/delivery-push tool');
}

// ── T: Phase F gateway unchanged ──
console.log('\n-- T: gateway intact --');
{
  check(pmGateway.PM_GATEWAY_SCHEMA_VERSION === 'F.1', 'T gateway schema still F.1');
  const events = evk.listEvents(TEST_ROOT, project).events;
  const recv = events.find((e) => e.type === 'RUN_RESULT_RECEIVED' && e.taskId === t1.taskId);
  check(!!recv, 'T RUN_RESULT_RECEIVED event present');
  const pkt = pmGateway.getContextForEvent(TEST_ROOT, project, recv.eventId);
  check(pkt.event.type === 'RUN_RESULT_RECEIVED', 'T gateway still serves the event');
  check(pkt.task === undefined, 'T informational thin packet (no Task profile) unchanged');
  check(Array.isArray(pkt.allowedActions) && pkt.allowedActions.every((a) => ['ACK_EVENT', 'IGNORE_EVENT', 'NO_ACTION'].includes(a)), 'T informational actions unchanged');
}

await resetProcessLocal();
delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G4-B Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
