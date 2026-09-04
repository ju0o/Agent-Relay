/**
 * V1-G3 — Result Return Path integration (synthetic/injected).
 *
 * The full path MUST begin through the V1 surfaces (never by manufacturing
 * a RESULT_RECEIVED Task):
 *   A. relay_pm_create_task
 *   B. relay_pm_dispatch_owner_approved
 *   C. exactly one Dispatcher Run linked
 *   D. Capture armed to that exact execution binding
 *   E. inject one trusted RESPONSE_COMPLETE for the bound session
 *   F. settle/persist
 *   G. exact Run artifacts: agent-result.md + result.md + evidence/adapter.json
 *   H. durable Evidence includes ADAPTER_OBSERVATION provenance
 *   I. Task executionState=RESULT_RECEIVED, pmState=VERIFYING
 *   J. RUN_RESULT_RECEIVED Event exists
 *   K. runId is the exact current linked Run
 *
 * Negatives (deep variants already proven by Phase H closed-loop; here
 * re-proven through the V1 surface where cheap):
 *   N1. non-RESPONSE_COMPLETE does NOT promote
 *   N2. wrong/historical run does NOT promote
 *   N3. wrong bound folder does NOT promote
 *   N4. process exit 0 alone does NOT promote
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g3-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const bridge = await import('../dist/server/backend/result-bridge.js');
const evidence = await import('../dist/server/backend/evidence.js');
const evk = await import('../dist/server/backend/event.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const NODE = process.execPath;

const project = 'V1G3Proj';
const ctx = { dataRoot: TEST_ROOT, project };
const tools = pmTools.buildAllPmTools(ctx);
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

// Keep fixture children alive across assertions; reset kills them.
process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

function registerWorker(workerId, scriptPath) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId,
    displayName: workerId,
    launchCommand: NODE,
    launchArgsPrefix: [scriptPath],
    capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
  });
}
registerWorker('v1-g3-worker', FIX_ALIVE);
registerWorker('v1-g3-zero', FIX_ZERO);

const CONTRACT = {
  title: 'V1 G3 result task',
  goal: 'Intended outcome for V1 worker',
  reason: 'PM finalized contract reason',
  scope: 'Narrow V1 scope',
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

// ── A/B/C: V1 intake + owner-approved dispatch, one Run ──
console.log('\n-- A/B/C: V1 surfaces to dispatch --');
const intake = await get('relay_pm_create_task').handler({ ...CONTRACT });
const taskId = intake.task.taskId;
const goalId = intake.goal.goalId;
check(intake.goal.permissionPolicy?.mode === 'PLAN', 'A V1 container Goal is PLAN');
{
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.executionState === 'READY' && t.pmState === 'PENDING', 'A task READY+PENDING, no auto-dispatch');
}
const dispatchRes = await get('relay_pm_dispatch_owner_approved').handler({
  taskId, workerId: 'v1-g3-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
});
const runId = dispatchRes.runId;
check(dispatchRes.executionState === 'RUNNING', 'B owner-approved dispatch reaches RUNNING');
{
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.linkedRuns.length === 1, `C exactly one Dispatcher Run linked (got ${t.linkedRuns.length})`);
  check(t.linkedRuns[0].runId === runId, 'C linked run is the dispatch runId');
}
const runFolder = gt.getTask(TEST_ROOT, project, taskId).linkedRuns.find((r) => r.runId === runId).folder;
// NOTE: prompt.md is written by the real relay-worker-claude.mjs wrapper, not by
// fixture workers — its presence is proven by the Step 3 real-Claude proof, not here.
check(fs.existsSync(runFolder) && fs.statSync(runFolder).isDirectory(), 'C Dispatcher Run folder exists');

// ── D: Capture armed to the exact execution binding ──
console.log('\n-- D: capture armed on exact binding --');
{
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  check(cm.isActive(runFolder), 'D capture active on the exact Dispatcher Run folder');
  const status = await disp.getDispatchStatus(TEST_ROOT, project, taskId);
  check(status.dispatchBlocked === true, 'D dispatch status blocked while active');
  check(status.active?.runId === runId, 'D active dispatch tracks the exact runId');
}

// ── E/F: trusted RESPONSE_COMPLETE for the bound session ──
console.log('\n-- E/F: inject + settle --');
{
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  check(cm.forceBindSessionForTests(runFolder, 'ses-v1-g3'), 'E bound session force-bound (no guessing)');
  cm.injectCompletionForTests(runFolder, responseComplete('ses-v1-g3', 'V1 G3 synthetic final result'));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.executionState === 'RESULT_RECEIVED', `F settled to RESULT_RECEIVED (got ${t.executionState})`);
}

// ── G: exact Run artifacts ──
console.log('\n-- G: run artifacts --');
{
  const agentResult = path.join(runFolder, 'agent-result.md');
  const resultMd = path.join(runFolder, 'result.md');
  const adapterJson = path.join(runFolder, 'evidence', 'adapter.json');
  check(fs.existsSync(agentResult), 'G agent-result.md persisted');
  check(fs.existsSync(resultMd), 'G result.md persisted');
  check(fs.existsSync(adapterJson), 'G evidence/adapter.json persisted');
  check(
    fs.readFileSync(agentResult, 'utf8') === 'V1 G3 synthetic final result',
    'G agent-result.md holds the exact observed text',
  );
  const parsed = JSON.parse(fs.readFileSync(adapterJson, 'utf8'));
  check(parsed?.completion?.sessionId === 'ses-v1-g3', 'G adapter.json bound to the exact session');
}

// ── H: ADAPTER_OBSERVATION provenance ──
console.log('\n-- H: evidence provenance --');
{
  const listed = evidence.listEvidenceForTask(TEST_ROOT, project, taskId, true);
  const obs = listed.filter((e) => e.type === 'ADAPTER_OBSERVATION');
  check(obs.length >= 1, `H ADAPTER_OBSERVATION evidence recorded (got ${obs.length})`);
  check(obs.some((e) => e.taskId === taskId && e.runId === runId), 'H observation belongs to same taskId/runId');
  check(obs.every((e) => e.trustLevel === 'OBSERVED'), 'H observation trust stays OBSERVED (never VERIFIED)');
}

// ── I/J/K: task state, event, current attempt ──
console.log('\n-- I/J/K: durable outcome --');
{
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.executionState === 'RESULT_RECEIVED', `I executionState RESULT_RECEIVED (got ${t.executionState})`);
  check(t.pmState === 'VERIFYING', `I pmState VERIFYING (got ${t.pmState})`);
  check(t.acceptedRunId === undefined, 'I no Accept performed (no acceptedRunId)');
  const events = evk.listEvents(TEST_ROOT, project).events;
  const recv = events.filter((e) => e.type === 'RUN_RESULT_RECEIVED' && e.taskId === taskId);
  check(recv.length >= 1, `J RUN_RESULT_RECEIVED Event exists (got ${recv.length})`);
  check(recv.some((e) => e.runId === runId), 'J event belongs to same taskId/runId');
  check(rt.resolveCurrentAttemptRunId(t) === runId, 'K runId is the exact current linked Run');
}

// ── N1: non-RESPONSE_COMPLETE does NOT promote ──
console.log('\n-- N1: non-RESPONSE_COMPLETE --');
await resetProcessLocal();
{
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G3 N1' });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g3-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, 'ses-v1-g3-n1');
  cm.injectCompletionForTests(folder, { ...responseComplete('ses-v1-g3-n1', 'partial'), completionKind: 'PROCESS_FAILED' });
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  check(t.executionState !== 'RESULT_RECEIVED', `N1 PROCESS_FAILED never promotes (got ${t.executionState})`);
}

// ── N2/N3: wrong run / wrong folder rejected at the bridge ──
console.log('\n-- N2/N3: bridge identity gates --');
await resetProcessLocal();
{
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G3 N2' });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g3-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const wrongFolder = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G3 N3 folder' })
    .then(() => path.join(TEST_ROOT, 'wrong-folder'));
  fs.mkdirSync(wrongFolder, { recursive: true });
  const historical = await bridge.promoteObservedResult({
    dataRoot: TEST_ROOT, project, goalId: inc.goal.goalId,
    taskId: inc.task.taskId, runId: 'run-does-not-exist',
    boundFolder: folder, completion: responseComplete('ses-hist', 'stale'),
  });
  check(historical === null, 'N2 unlinked/historical runId never promotes');
  const wrongBound = await bridge.promoteObservedResult({
    dataRoot: TEST_ROOT, project, goalId: inc.goal.goalId,
    taskId: inc.task.taskId, runId: res.runId,
    boundFolder: wrongFolder, completion: responseComplete('ses-hist', 'stale'),
  });
  check(wrongBound === null, 'N3 wrong bound folder never promotes');
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  check(t.executionState === 'RUNNING', `N2/N3 task still RUNNING (got ${t.executionState})`);
}

// ── N4: exit 0 alone does NOT promote ──
console.log('\n-- N4: exit-zero alone --');
await resetProcessLocal();
{
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G3 N4' });
  await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g3-zero', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  await sleep(900);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  check(t.executionState === 'RUNNING', `N4 exit 0 alone leaves RUNNING, not RESULT_RECEIVED (got ${t.executionState})`);
  check(t.pmState === 'PENDING', `N4 pmState stays PENDING (got ${t.pmState})`);
}

// ── structural: V1 surfaces only, no wake/accept/delivery ──
console.log('\n-- structural --');
{
  const names = tools.map((t) => t.name);
  check(!names.some((n) => n.includes('wake') || n.includes('deliver_result')), 'S no PM Wake / result-delivery tool added');
  const g3Src = fs.readFileSync('test/v1-g3-result-return.test.mjs', 'utf8');
  check(!/\bawait markResultReceived\(/.test(g3Src), 'S test never calls markResultReceived directly');
  const pmSrc = fs.readFileSync('src/mcp/pm-tools.ts', 'utf8');
  check(!pmSrc.includes('relay_pm_wake') && !pmSrc.includes('relay_pm_deliver'), 'S production MCP unchanged (no wake/delivery)');
}

// ── R: adapter honors CLAUDE_CONFIG_DIR (V1-G3 real-run correction) ──
console.log('\n-- R: transcript root resolution --');
{
  const storage = await import('../dist/server/integrations/claude/storage.js');
  const saved = process.env.CLAUDE_CONFIG_DIR;
  try {
    const altRoot = path.join(TEST_ROOT, 'alt-claude-home');
    fs.mkdirSync(path.join(altRoot, 'projects'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = altRoot;
    check(
      storage.claudeProjectsRoot() === path.join(altRoot, 'projects'),
      'R CLAUDE_CONFIG_DIR relocation honored',
    );
    delete process.env.CLAUDE_CONFIG_DIR;
    const fallback = storage.claudeProjectsRoot();
    check(
      fallback === null || fallback.endsWith(path.join('.claude', 'projects')),
      'R fallback is ~/.claude/projects (or null when absent)',
    );
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

await resetProcessLocal();
delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G3 Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
