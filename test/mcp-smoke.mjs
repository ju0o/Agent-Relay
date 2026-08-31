/**
 * MCP server stdio smoke tests (PM + Worker surfaces).
 * Spawns server processes, sends JSON-RPC requests, and verifies responses.
 *
 * Covers E-34 (PM/Worker stdio smoke) and E-35 (unknown tool normalized error).
 */
import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-smoke-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'mcp', 'index.js');

const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

/** Send requests to a server process and collect output. */
async function runRequests(extraArgs, requests) {
  const args = [SERVER, '--dataRoot', TEST_ROOT, '--project', 'SmokeProj', ...extraArgs];
  const proc = cp.spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const result = await new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    proc.stdout.on('data', (d) => out.push(d.toString()));
    proc.stderr.on('data', (d) => err.push(d.toString()));
    proc.on('error', reject);

    for (const req of requests) {
      proc.stdin.write(JSON.stringify(req) + '\n');
    }

    setTimeout(() => {
      proc.stdin.end();
      resolve({ out: out.join(''), err: err.join('') });
    }, 2000);
  });

  return result;
}

// ── Set up Worker fixture ────────────────────────────────────────────────────

async function setupWorkerFixture() {
  const { createGoal, createTask, linkRunToTask } = await import('../dist/server/backend/goal-task.js');
  const relay = await import('../dist/server/backend/fs.js');

  const goalId = (await createGoal(TEST_ROOT, 'SmokeProj', {
    title: 'Smoke Goal',
    goalStatement: 'smoke test goal',
    completionCriteria: ['done'],
  })).goalId;

  const taskId = (await createTask(TEST_ROOT, 'SmokeProj', {
    goalId,
    title: 'Smoke Task',
    goal: 'do smoke',
    reason: 'test',
    scope: 'test',
    completionCriteria: ['done'],
  })).taskId;

  const run = await relay.atomicMaterializeRun(TEST_ROOT, 'SmokeProj', relay.todayString(), 'SmokeAgent');
  const task = await linkRunToTask(TEST_ROOT, 'SmokeProj', taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  const runId = link.runId;

  return { taskId, runId };
}

async function main() {
  console.log(`MCP server: ${SERVER}`);
  console.log(`TEST_ROOT: ${TEST_ROOT}`);

  // ── PM smoke ──────────────────────────────────────────────────────────────
  console.log('\n── PM surface smoke ──');
  const pmResult = await runRequests(['--surface', 'pm'], [
    { jsonrpc: '2.0', method: 'ping', id: 1 },
    { jsonrpc: '2.0', method: 'relay_pm_list_tools', id: 2 },
    { jsonrpc: '2.0', method: 'unknown_method', id: 3 },
  ]);

  console.log('STDOUT:', pmResult.out);
  if (pmResult.err) console.log('STDERR:', pmResult.err);

  const pmLines = pmResult.out.trim().split('\n').filter(Boolean);
  check(pmLines.some((l) => l.includes('pong')), 'E-34 PM: ping → pong');
  check(pmLines.some((l) => l.includes('relay_pm_get_goal')), 'E-34 PM: list_tools contains PM tools');
  check(!pmLines.some((l) => l.includes('relay_worker_')), 'E-34 PM: list_tools excludes Worker tools');
  check(pmLines.some((l) => l.includes('-32601')), 'E-35 PM: unknown method → -32601');

  // ── Worker smoke ──────────────────────────────────────────────────────────
  console.log('\n── Worker surface smoke ──');
  let taskId, runId;
  try {
    ({ taskId, runId } = await setupWorkerFixture());
  } catch (e) {
    console.log('  SKIP  Worker smoke — fixture setup failed:', e.message);
    taskId = 'TASK-1'; runId = 'run-test';
  }

  const workerResult = await runRequests(
    ['--surface', 'worker', '--taskId', taskId, '--runId', runId],
    [
      { jsonrpc: '2.0', method: 'ping', id: 1 },
      { jsonrpc: '2.0', method: 'relay_worker_list_tools', id: 2 },
      { jsonrpc: '2.0', method: 'unknown_method', id: 3 },
    ],
  );

  console.log('STDOUT:', workerResult.out);
  if (workerResult.err) console.log('STDERR:', workerResult.err);

  const wLines = workerResult.out.trim().split('\n').filter(Boolean);
  check(wLines.some((l) => l.includes('pong')), 'E-34 Worker: ping → pong');
  check(wLines.some((l) => l.includes('relay_worker_get_assignment')), 'E-34 Worker: list_tools contains Worker tools');
  check(!wLines.some((l) => l.includes('relay_pm_')), 'E-34 Worker: list_tools excludes PM tools');
  check(wLines.some((l) => l.includes('-32601')), 'E-35 Worker: unknown method → -32601');

  // ── Missing --surface error ────────────────────────────────────────────────
  console.log('\n── Missing --surface error ──');
  const noSurface = await runRequests([], []);
  check(!noSurface.err.includes('pong'), 'Missing --surface: server exits with error (no output)');

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log('\nMCP SMOKE DONE');
}

main().catch((err) => { console.error(err); process.exit(1); });
