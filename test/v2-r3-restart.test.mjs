/**
 * V2 slice-1 R3 — restart integration (scan at bridge reconcile points).
 *
 * Covers (fixture: instant-exit dispatch stuck in RUNNING):
 *   R3-01  start() logs the resume-scan report and still starts/stops cleanly
 *   R3-02  runOnce() result carries the scan snapshot (additive field)
 *   R3-03  empty project → zeroed snapshot, no scan lines, start/stop clean
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v2-r3-${process.pid}-${Date.now()}`);
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
const bridgeMod = await import('../dist/server/backend/pm-host-bridge.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const FAKE_HOST = path.resolve(__dirname, 'fixtures/hosts/fake-pm-host.mjs');
const NODE = process.execPath;
const project = 'V2R3Proj';

disp._resetDispatcherStateForTests();

process.env.FAKE_HOST_RECORD_FILE = path.join(TEST_ROOT, 'rec.ndjson');
process.env.FAKE_HOST_MODE = 'ack';

function makeBridge(logs) {
  return new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 500, maxBackoffMs: 200,
    logger: (l) => logs.push(l),
  });
}

// Stuck fixture: instant-exit dispatch, never promoted.
const goal = await gt.createGoal(TEST_ROOT, project, {
  title: 'V2 R3 goal', goalStatement: 'restart scan goal',
  permissionPolicy: { mode: 'BYPASS' },
});
{
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'stuck task', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2', workerId: 'w-r3', launchCommand: NODE,
    launchArgsPrefix: [FIX_ZERO], capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
  });
  const ws = path.join(WORKSPACE, t.taskId);
  fs.mkdirSync(ws, { recursive: true });
  await disp.dispatchTask(TEST_ROOT, project, {
    taskId: t.taskId, workerId: 'w-r3', workspaceRoot: ws, expectedExecutionState: 'READY',
  });
}

// R3-01: start() surfaces the scan and still runs cleanly
console.log('\n-- R3-01: start() scan lines --');
{
  const logs = [];
  const bridge = makeBridge(logs);
  await bridge.start();
  await bridge.stop();
  check(logs.some((l) => l.includes('Bridge started')), 'bridge still starts');
  check(logs.some((l) => l.includes('Resume scan:')), 'scan summary logged');
  check(logs.some((l) => l.includes('[ORPHANED_DISPATCH]')), 'finding detail logged');
  check(logs.some((l) => l.includes('Bridge stopped')), 'bridge still stops');
}

// R3-02: runOnce() carries the snapshot
console.log('\n-- R3-02: runOnce() snapshot --');
{
  const logs = [];
  const bridge = makeBridge(logs);
  const res = await bridge.runOnce();
  await bridge.stop();
  check(res.resumeScan && res.resumeScan.scannedTasks >= 1, 'snapshot present');
  check(res.resumeScan.findings.some((f) => f.pattern === 'ORPHANED_DISPATCH'), 'finding in snapshot');
  check(Array.isArray(res.reconciled) && Array.isArray(res.delivered), 'drain fields intact');
}

// R3-03: empty project → zeroed, quiet
console.log('\n-- R3-03: empty project --');
{
  const logs = [];
  const bridge = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project: 'V2R3Empty', hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 500, maxBackoffMs: 200,
    logger: (l) => logs.push(l),
  });
  await bridge.start();
  await bridge.stop();
  check(!logs.some((l) => l.includes('Resume scan:')), 'no scan lines when clean');
  const res = await bridge.runOnce();
  await bridge.stop();
  check(res.resumeScan.scannedTasks === 0 && res.resumeScan.findings.length === 0, 'zeroed snapshot');
}

console.log(`\n결과: ${passed} passed, ${failed} failed`);
delete process.env.FAKE_HOST_RECORD_FILE;
delete process.env.FAKE_HOST_MODE;
disp._resetDispatcherStateForTests();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
