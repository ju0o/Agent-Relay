/**
 * V1-G4-C — PM Host Wake Bridge automatic delivery.
 *
 * Resident bridge (poll loop, NO user polling) discovers durable TASK_VERIFY
 * deliveries, hands G4-B verification packets to a PM Host child over stdio
 * NDJSON, and ACKs only on valid matching PM_DELIVERY_RECEIVED receipts.
 *
 * V1 drive always goes through canonical surfaces:
 *   relay_pm_create_task → relay_pm_dispatch_owner_approved →
 *   injected bound RESPONSE_COMPLETE (bridge fast-path mints the delivery).
 *
 * The fake PM Host (test/fixtures/hosts/fake-pm-host.mjs) is TEST-ONLY.
 *
 * Proves A–W (see task): auto discovery/delivery/ack, no manual poll,
 * unavailable→retained→recovered, DELIVERED-unacked resend, dedupe,
 * wrong/malformed receipts, crash + backoff + restart, historical
 * NO_JUDGMENT, no judgment mutation, no injection, shell:false, clean logs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g4c-${process.pid}-${Date.now()}`);
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
const pmDel = await import('../dist/server/backend/pm-delivery.js');
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

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

function pmFor(project) {
  const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
  return (name) => tools.find((t) => t.name === name);
}

function registerWorker() {
  wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: 'v1-g4c-worker',
    displayName: 'v1-g4c-worker',
    launchCommand: NODE,
    launchArgsPrefix: [FIX_ALIVE],
    capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
  });
}
registerWorker();

const CONTRACT = {
  title: 'V1 G4C wake task',
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

async function driveToResultReceived(project, title, sessionId, text) {
  const get = pmFor(project);
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g4c-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
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

let bridgeSeq = 0;
function makeBridge(project, recordFile, mode = 'ack', extra = {}) {
  process.env.FAKE_HOST_RECORD_FILE = recordFile;
  process.env.FAKE_HOST_MODE = mode;
  const logs = [];
  const bridge = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT,
    project,
    hostCommand: NODE,
    hostArgs: [FAKE_HOST],
    pollMs: 30,
    receiptTimeoutMs: 4000,
    maxBackoffMs: 400,
    logger: (l) => logs.push(l),
    ...extra,
  });
  bridgeSeq += 1;
  return { bridge, logs };
}

function clearHostEnv() {
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
}

// ── A: idle start/stop ──
console.log('\n-- A: idle bridge --');
{
  const project = 'V1G4C-A';
  const rec = path.join(TEST_ROOT, 'rec-a.ndjson');
  const { bridge, logs } = makeBridge(project, rec);
  await bridge.start();
  await sleep(200);
  await bridge.stop();
  clearHostEnv();
  check(logs.some((l) => l.includes('Bridge started')), 'A bridge starts with no work');
  check(logs.some((l) => l.includes('Waiting')), 'A idle waiting logged');
  check(logs.some((l) => l.includes('Bridge stopped')), 'A bridge stops cleanly');
  await resetProcessLocal();
}

// ── B–F + S + W: full automatic wake proof ──
console.log('\n-- B-F/S/W: automatic wake --');
let autoTask;
{
  const project = 'V1G4C-AUTO';
  const rec = path.join(TEST_ROOT, 'rec-auto.ndjson');
  const { bridge, logs } = makeBridge(project, rec);
  await bridge.start();
  // NO user poll: V1 result path only (intake → dispatch → observation).
  autoTask = await driveToResultReceived(project, 'V1 G4C auto', 'ses-g4c-auto', 'G4C synthetic final result auto');
  const D = `PMD-${autoTask.taskId}-${autoTask.runId}`;
  // Bridge must discover + deliver + ack on its own.
  await waitFor('auto ack', () => {
    try {
      return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED';
    } catch { return false; }
  });
  const rows = readRecords(rec);
  check(rows.some((r) => r.deliveryId === D && r.duplicate !== true), 'B PENDING delivery discovered automatically');
  const got = rows.find((r) => r.deliveryId === D);
  check(got?.packet?.task?.taskId === autoTask.taskId, 'C verification packet sent automatically');
  check(got?.packet?.result?.text === 'G4C synthetic final result auto', 'C packet carries result text');
  check(pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED', 'D/E send→DELIVERED→ACKNOWLEDGED via bridge');
  check(logs.some((l) => l.includes('handed to PM Host')), 'F handoff logged, no manual poll in scenario');
  // S: no judgment.
  const t = gt.getTask(TEST_ROOT, project, autoTask.taskId);
  check(t.pmState === 'VERIFYING' && t.acceptedRunId === undefined, 'S still VERIFYING, never ACCEPTED');
  check(!evk.listEvents(TEST_ROOT, project).events.some((e) => e.type === 'TASK_RESULT_ACCEPTED'), 'S no accept event');
  // W: logs carry identity, never result text.
  check(logs.some((l) => l.includes(D)), 'W logs reference deliveryId');
  check(!logs.some((l) => l.includes('G4C synthetic final result auto')), 'W logs never dump result text');
  await bridge.stop();
  clearHostEnv();
  await resetProcessLocal();
}

// ── G/H: unavailable → retained → recovered ──
console.log('\n-- G/H: host unavailable --');
{
  const project = 'V1G4C-GH';
  const t = await driveToResultReceived(project, 'V1 G4C unavail', 'ses-g4c-g', 'G4C unavail text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const logs = [];
  const bad = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project,
    hostCommand: '/nonexistent-host-binary-xyz', hostArgs: [],
    pollMs: 30, receiptTimeoutMs: 2000, maxBackoffMs: 400, logger: (l) => logs.push(l),
  });
  await bad.start();
  await sleep(400);
  await bad.stop();
  check(pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'PENDING', 'G host unavailable → PENDING retained');
  check(bad.getSpawnAttempts() >= 1, 'G spawn attempted');
  const rec = path.join(TEST_ROOT, 'rec-gh.ndjson');
  const { bridge } = makeBridge(project, rec);
  await bridge.start();
  await waitFor('gh ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await bridge.stop();
  clearHostEnv();
  check(true, 'H host later available → automatic delivery + ack');
  check(readRecords(rec).some((r) => r.deliveryId === D), 'H packet reached the recovered host');
  await resetProcessLocal();
}

// ── I/J/K/L: crash-after-receive → DELIVERED survives → resend → dedupe ──
console.log('\n-- I/J/K/L: delivered-unacked --');
{
  const project = 'V1G4C-IJ';
  const t = await driveToResultReceived(project, 'V1 G4C crash', 'ses-g4c-i', 'G4C crash text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-ij.ndjson');
  const first = makeBridge(project, rec, 'crash-after-receive');
  await first.bridge.start();
  await waitFor('delivered', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED'; } catch { return false; }
  });
  await sleep(300);
  await first.bridge.stop();
  clearHostEnv();
  check(pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED', 'I DELIVERED without ACK survives host death');
  const second = makeBridge(project, rec, 'ack');
  await second.bridge.start();
  await waitFor('ij ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await second.bridge.stop();
  clearHostEnv();
  check(true, 'J restart resends DELIVERED-unacked, then ACKNOWLEDGED');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 1, 'J/K no duplicate delivery record');
  const rows = readRecords(rec).filter((r) => r.deliveryId === D);
  check(rows.length >= 2, `K same deliveryId re-offered (got ${rows.length} receipts)`);
  await resetProcessLocal();
}

// ── L: same-process duplicate flagged (at-least-once evidence) ──
console.log('\n-- L: fixture dedupe --');
{
  const project = 'V1G4C-L';
  const t = await driveToResultReceived(project, 'V1 G4C dupe', 'ses-g4c-l', 'G4C dupe text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-l.ndjson');
  // no-ack host + short receipt timeout: the bridge re-offers to the SAME
  // host process, which flags the repeat with duplicate:true.
  const logs = [];
  const b = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 300, maxBackoffMs: 400, logger: (l) => logs.push(l),
  });
  process.env.FAKE_HOST_RECORD_FILE = rec;
  process.env.FAKE_HOST_MODE = 'no-ack';
  await b.start();
  await waitFor('l dupe', () => readRecords(rec).filter((r) => r.deliveryId === D).length >= 2, 15000);
  await b.stop();
  clearHostEnv();
  const rows = readRecords(rec).filter((r) => r.deliveryId === D);
  check(rows.some((r) => r.duplicate === true), 'L host fixture dedupes repeat deliveryId');
  await resetProcessLocal();
}

// ── M: wrong receipt ──
console.log('\n-- M: wrong receipt --');
{
  const project = 'V1G4C-M';
  const t = await driveToResultReceived(project, 'V1 G4C wrong', 'ses-g4c-m', 'G4C wrong text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-m.ndjson');
  const { bridge, logs } = makeBridge(project, rec, 'wrong-id');
  await bridge.start();
  await waitFor('m delivered', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED'; } catch { return false; }
  });
  await sleep(300);
  await bridge.stop();
  clearHostEnv();
  check(pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED', 'M wrong deliveryId receipt does not ACK');
  await resetProcessLocal();
}

// ── N: malformed receipt ──
console.log('\n-- N: malformed receipt --');
{
  const project = 'V1G4C-N';
  const t = await driveToResultReceived(project, 'V1 G4C malformed', 'ses-g4c-n', 'G4C malformed text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-n.ndjson');
  const { bridge, logs } = makeBridge(project, rec, 'malformed');
  await bridge.start();
  await waitFor('n delivered', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED'; } catch { return false; }
  });
  await sleep(300);
  const alive = bridge.isHostAlive();
  await bridge.stop();
  clearHostEnv();
  check(pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED', 'N malformed receipt does not ACK');
  check(alive, 'N bridge survives malformed host output');
  check(logs.some((l) => l.includes('malformed')), 'N malformed line warned, data intact');
  await resetProcessLocal();
}

// ── O: crash-immediate ──
console.log('\n-- O: host crash --');
{
  const project = 'V1G4C-O';
  const t = await driveToResultReceived(project, 'V1 G4C crash2', 'ses-g4c-o', 'G4C crash2 text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-o.ndjson');
  const { bridge } = makeBridge(project, rec, 'crash-immediate');
  await bridge.start();
  await sleep(400);
  await bridge.stop();
  clearHostEnv();
  // Crash timing races handoff: write may fail (PENDING) or win before the
  // exit is observed (DELIVERED-unacked). Both retain the delivery; neither
  // loses it nor acks without receipt. Recovery below proves no loss.
  const st = pmDel.getPmDelivery(TEST_ROOT, project, D).status;
  check(st === 'PENDING' || st === 'DELIVERED', `O crash does not lose delivery (got ${st})`);
  const rec2 = path.join(TEST_ROOT, 'rec-o2.ndjson');
  const good = makeBridge(project, rec2, 'ack');
  await good.bridge.start();
  await waitFor('o recovered', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await good.bridge.stop();
  clearHostEnv();
  check(true, 'O crashed delivery recovered to ACKNOWLEDGED');
  await resetProcessLocal();
}

// ── P: spawn backoff ──
console.log('\n-- P: backoff --');
{
  const project = 'V1G4C-P';
  const logs = [];
  const bad = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project,
    hostCommand: '/nonexistent-host-binary-xyz', hostArgs: [],
    pollMs: 25, receiptTimeoutMs: 1000, maxBackoffMs: 30000, logger: (l) => logs.push(l),
  });
  await bad.start();
  await sleep(600);
  const attempts = bad.getSpawnAttempts();
  await bad.stop();
  check(attempts <= 2, `P spawn failures bounded with backoff (attempts=${attempts} in 600ms at 25ms cadence)`);
  await resetProcessLocal();
}

// ── Q: no-ack → restart → ack ──
console.log('\n-- Q: bridge restart --');
{
  const project = 'V1G4C-Q';
  const t = await driveToResultReceived(project, 'V1 G4C restart', 'ses-g4c-q', 'G4C restart text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-q.ndjson');
  const first = makeBridge(project, rec, 'no-ack');
  await first.bridge.start();
  await waitFor('q delivered', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'DELIVERED'; } catch { return false; }
  });
  await first.bridge.stop();
  clearHostEnv();
  const second = makeBridge(project, rec, 'ack');
  await second.bridge.start();
  await waitFor('q ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await second.bridge.stop();
  clearHostEnv();
  check(true, 'Q bridge restart recovers DELIVERED-unacked to ACKNOWLEDGED');
  await resetProcessLocal();
}

// ── R: historical packet stays NO_JUDGMENT through the bridge ──
console.log('\n-- R: historical via bridge --');
{
  const project = 'V1G4C-R';
  const t = await driveToResultReceived(project, 'V1 G4C hist', 'ses-g4c-r1', 'G4C hist text one');
  const D1 = `PMD-${t.taskId}-${t.runId}`;
  const get = pmFor(project);
  await rt.requestChanges(TEST_ROOT, project, t.taskId, t.runId, {
    goalId: t.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'g4c changes fixture reason',
  });
  await rt.requestRetry(TEST_ROOT, project, t.taskId, {
    goalId: t.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  await resetProcessLocal();
  // New attempt runs but is NOT completed: D1 is now displaced while PENDING.
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: t.taskId, workerId: 'v1-g4c-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  void res;
  const rec = path.join(TEST_ROOT, 'rec-r.ndjson');
  const { bridge } = makeBridge(project, rec, 'ack');
  await bridge.start();
  await waitFor('r ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D1).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await bridge.stop();
  clearHostEnv();
  const got = readRecords(rec).find((r) => r.deliveryId === D1);
  check(got?.packet?.attempt?.isCurrentAttempt === false, 'R historical packet explicit non-current');
  check(JSON.stringify(got?.packet?.reviewActions) === JSON.stringify(['NO_JUDGMENT']), 'R historical packet NO_JUDGMENT');
  await resetProcessLocal();
}

// ── U: injection safety ──
console.log('\n-- U: command injection --');
{
  const project = 'V1G4C-U';
  const evil = 'G4C `rm -rf /` $(evil) ; cat /etc/passwd && touch /tmp/g4c-pwned';
  const t = await driveToResultReceived(project, 'V1 G4C evil', 'ses-g4c-u', evil);
  const D = `PMD-${t.taskId}-${t.runId}`;
  const rec = path.join(TEST_ROOT, 'rec-u.ndjson');
  const { bridge } = makeBridge(project, rec, 'ack');
  await bridge.start();
  await waitFor('u ack', () => {
    try { return pmDel.getPmDelivery(TEST_ROOT, project, D).status === 'ACKNOWLEDGED'; } catch { return false; }
  });
  await bridge.stop();
  clearHostEnv();
  const got = readRecords(rec).find((r) => r.deliveryId === D);
  check(got?.packet?.result?.text === evil, 'U hostile text passed through verbatim (data, never executed)');
  check(!fs.existsSync('/tmp/g4c-pwned'), 'U no command execution from Task/Result content');
  await resetProcessLocal();
}

// ── T/V: scope + spawn contract ──
console.log('\n-- T/V: static scope --');
{
  const src = fs.readFileSync('src/backend/pm-host-bridge.ts', 'utf8');
  for (const needle of ['acceptTaskResult', 'requestTaskChanges', 'requestTaskRetry', 'dispatchTask',
    'completeGoal', 'acceptResult', 'exec(', 'execSync', 'spawnSync', 'shell: true', 'shell:true']) {
    check(!src.includes(needle), `T/V bridge never uses ${needle}`);
  }
  check(src.includes('shell: false'), 'V argv spawn contract shell:false');
  check(src.includes('PM_DELIVERY_RECEIVED'), 'V receipt contract present');
}

// ── config validation ──
console.log('\n-- config: host.json --');
{
  const dir = path.join(TEST_ROOT, 'cfg-good');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({
    schemaVersion: 1, pmHost: { transport: 'stdio', command: NODE, args: [FAKE_HOST] },
  }));
  const cfg = bridgeMod.loadPmHostConfig(dir);
  check(cfg.pmHost.command === NODE, 'config trusted host.json loads');
  const badDir = path.join(TEST_ROOT, 'cfg-bad');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'host.json'), JSON.stringify({
    schemaVersion: 1, pmHost: { transport: 'stdio', command: NODE, args: [], apiToken: 'x' },
  }));
  let threw = false;
  try { bridgeMod.loadPmHostConfig(badDir); } catch { threw = true; }
  check(threw, 'config secret-like keys rejected');
  let missing = false;
  try { bridgeMod.loadPmHostConfig(path.join(TEST_ROOT, 'cfg-absent')); } catch (e) {
    missing = e instanceof Error && e.message.includes('not found');
  }
  check(missing, 'config missing file hard-fails');
}

delete process.env.WORKER_STAY_MS;
clearHostEnv();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G4-C Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
