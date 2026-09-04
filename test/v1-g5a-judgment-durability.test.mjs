/**
 * V1-G5-A CORRECTION — Atomic CHANGES intent durability (crash seams).
 *
 * Commit order: intent.json (atomic, FIRST) → judgment.json (commit marker).
 * These tests construct the precise on-disk partial states; they do not rely
 * on "write both then restart".
 *
 *   A. no partial state → identical submit succeeds (fresh commit)
 *   B. intent.json present + judgment.json missing → identical resubmit
 *      verifies bytes and completes the commit
 *   C. same partial + different retryInstruction → CONFLICT
 *   D. same partial + different reason → CONFLICT
 *   E. completed judgment + identical resubmit → idempotent
 *   F. completed judgment + differing payload → CONFLICT
 *   G. Task stays RESULT_RECEIVED + VERIFYING after recovery
 *   H. intent re-readable after recovery (accessor + disk)
 *   I. exactly one judgment record per delivery
 *   J. no retry instruction loss (exact bytes)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g5ac-${process.pid}-${Date.now()}`);
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
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

const project = 'V1G5ACProj';
const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g5ac-worker',
  displayName: 'v1-g5ac-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G5AC crash task',
  goal: 'Intended outcome for V1 worker review',
  reason: 'PM finalized contract reason for review',
  scope: 'Narrow V1 review scope',
  completionCriteria: ['done when worker result received'],
};

const REASON = 'crash seam reason text here';
const INSTR = 'crash seam retry instruction text';

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
    taskId: inc.task.taskId, workerId: 'v1-g5ac-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  if (t.executionState !== 'RESULT_RECEIVED') throw new Error(`setup failed: ${t.executionState}`);
  return { taskId: inc.task.taskId, runId: res.runId };
}

const submit = (args) => get('relay_pm_submit_judgment').handler(args);
// Crash-seam tests target the G5-A intake boundary directly: the MCP surface
// now chains G5-B preparation, which would move the Task past VERIFYING.
const submitBackend = (args) => pmJud.submitPmJudgment(TEST_ROOT, project, args);
const jid = (deliveryId) => `PMJ-${deliveryId}`;
const jfolder = (deliveryId) => pmJud.pmJudgmentFolder(TEST_ROOT, project, jid(deliveryId));

/** Fault injection: crash after intent.json, before judgment.json. */
function simulateCrashAfterIntent(deliveryId) {
  const folder = jfolder(deliveryId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'intent.json'), JSON.stringify({
    schemaVersion: 1,
    judgmentId: jid(deliveryId),
    deliveryId,
    decision: 'CHANGES',
    reason: REASON,
    retryInstruction: INSTR,
  }), 'utf8');
}

// ── partial-state task ──
const tp = await driveToResultReceived('V1 G5AC partial', 'ses-g5ac-p', 'G5AC partial text');
const DP = `PMD-${tp.taskId}-${tp.runId}`;
simulateCrashAfterIntent(DP);
check(!fs.existsSync(path.join(jfolder(DP), 'judgment.json')), 'setup orphan intent without judgment record');

// ── C/D: conflicting payloads against the orphan intent ──
console.log('\n-- C/D: orphan conflicts --');
{
  await shouldThrow(
    () => submit({ deliveryId: DP, decision: 'CHANGES', reason: REASON, retryInstruction: 'different instruction bytes' }),
    'C different instruction vs orphan → CONFLICT',
    'CONFLICT',
  );
  await shouldThrow(
    () => submit({ deliveryId: DP, decision: 'CHANGES', reason: 'a different reason entirely now', retryInstruction: INSTR }),
    'D different reason vs orphan → CONFLICT',
    'CONFLICT',
  );
  check(!fs.existsSync(path.join(jfolder(DP), 'judgment.json')), 'C/D conflicts commit nothing');
}

// ── B: identical resubmit completes the commit ──
console.log('\n-- B: orphan recovery --');
{
  const res = await submitBackend({ deliveryId: DP, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.judgment.status === 'RECEIVED', 'B identical resubmit completes judgment commit');
  check(fs.existsSync(path.join(jfolder(DP), 'judgment.json')), 'B judgment.json now durable');
  const t = gt.getTask(TEST_ROOT, project, tp.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING', 'G Task untouched by recovery');
}

// ── E/F/I: completed-state behavior ──
console.log('\n-- E/F/I: completed --');
{
  const res = await submitBackend({ deliveryId: DP, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.judgment.status === 'RECEIVED', 'E completed + identical resubmit idempotent');
  await shouldThrow(
    () => submit({ deliveryId: DP, decision: 'CHANGES', reason: REASON, retryInstruction: 'other bytes' }),
    'F completed + differing payload → CONFLICT',
    'CONFLICT',
  );
  const mine = pmJud.listPmJudgments(TEST_ROOT, project).filter((j) => j.deliveryId === DP);
  check(mine.length === 1, `I exactly one judgment record (got ${mine.length})`);
}

// ── H/J: durable re-read ──
console.log('\n-- H/J: re-read --');
{
  const disk = JSON.parse(fs.readFileSync(path.join(jfolder(DP), 'judgment.json'), 'utf8'));
  check(disk.status === 'RECEIVED', 'H judgment re-read from disk');
  check(pmJud.getRetryInstructionForDelivery(TEST_ROOT, project, DP) === INSTR, 'J no retry instruction loss');
}

// ── A: fresh commit (no partial state) ──
console.log('\n-- A: fresh --');
{
  const t = await driveToResultReceived('V1 G5AC fresh', 'ses-g5ac-f', 'G5AC fresh text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  check(!fs.existsSync(jfolder(D)), 'A no partial state exists');
  const res = await submitBackend({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.judgment.status === 'RECEIVED', 'A fresh identical submit commits');
  check(fs.existsSync(path.join(jfolder(D), 'intent.json')), 'A intent durable');
  await resetProcessLocal();
}

await resetProcessLocal();
delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G5-A correction Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
