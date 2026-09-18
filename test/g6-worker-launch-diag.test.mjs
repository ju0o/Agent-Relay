/**
 * V1-G6 Worker Launch Diagnostics — focused tests.
 *
 * Proves the bounded worker-launch diagnostic behavior added to
 * scripts/relay-worker-claude.mjs:
 *   1. non-zero worker stderr captured
 *   2. diagnostic output bounded
 *   3. no env/secrets logged
 *   4. successful worker launch unchanged (exit 0, no diag fields)
 *   5. redacted argv shape (no full prompt leak)
 *
 * These run the wrapper logic against a simulated child via a tiny local
 * "fake worker" node script (NOT the claude-code worker) so they are hermetic
 * and need no Claude auth.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const TEST_ROOT = path.join(os.tmpdir(), `arl-g6-launch-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A hermetic fake worker executable: prints a bounded error to stderr and
// exits 1. CLAUDE_EXE env points the wrapper at it (operator override).
const FAKE_WORKER = path.join(TEST_ROOT, 'fake-worker.mjs');
fs.writeFileSync(
  FAKE_WORKER,
  `#!/usr/bin/env node\n` +
  `process.stderr.write('LAUNCH_ERROR_ABORT\\n');\n` +
  `process.stdout.write('some stdout\\n');\n` +
  `process.exit(1);\n`,
  'utf8',
);
fs.chmodSync(FAKE_WORKER, 0o755);

// Windows: CreateProcess cannot start a .mjs/shebang fake with the wrapper's
// shell:false spawn (ENOENT before any fake output exists; the diagnostic
// excerpt stays empty and the test trips on the absent field) —
// shell:true/cmd.exe stay forbidden — so run the SAME fake scripts through
// the tiny test-only C# node-runner .exe (argv forwarded verbatim, stdio
// pumped as raw bytes, exit code propagated, env inherited). POSIX keeps the
// direct .mjs fakes; production is untouched.
const NODE_RUNNER_CS = path.resolve(__dirname, 'fixtures/g6/fake-node-script-launcher.cs');
const NODE_RUNNER_EXE = path.join(TEST_ROOT, 'fake-node-runner.exe');
if (process.platform === 'win32') {
  if (!fs.existsSync(NODE_RUNNER_EXE)) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(NODE_RUNNER_CS)})) -OutputAssembly ${q(NODE_RUNNER_EXE)} -OutputType ConsoleApplication`,
    ], { shell: false, encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(NODE_RUNNER_EXE)) {
      throw new Error(`fake node-runner .exe compile failed (status=${r.status}): ${(r.stderr || '').slice(0, 500)}`);
    }
  }
  process.env.G6_NODE_BIN = process.execPath;
}
// Resolve the wrapper child target for THIS platform. The argv-shape
// expectation follows the resolved executable (same semantic both ways:
// resolved exe + flags, no prompt leak).
function workerTarget(script) {
  if (process.platform !== 'win32') return { CLAUDE_EXE: script };
  return { CLAUDE_EXE: NODE_RUNNER_EXE, G6_NODE_SCRIPT: script };
}
const expectedArgvExe = (script) => (process.platform === 'win32' ? NODE_RUNNER_EXE : script);

// Sentinel that the wrapper must NEVER write into any log (env leakage test).
const SENTINEL_SECRET = 'G6_SENTINEL_SECRET_VALUE';

const SMOKE = path.join(TEST_ROOT, 'data'); // dataRoot
const PROJECT = 'smoke';                     // project under dataRoot
const PROJECT_DIR = path.join(SMOKE, PROJECT);
fs.mkdirSync(path.join(PROJECT_DIR, '_relay/goals/GOAL-0001'), { recursive: true });
fs.mkdirSync(path.join(PROJECT_DIR, '_relay/tasks/TASK-0001'), { recursive: true });
const RUN = path.join(PROJECT_DIR, '2026-09-05/worker-claude-code/01');
fs.mkdirSync(RUN, { recursive: true });
const WORK = path.join(TEST_ROOT, 'work');
fs.mkdirSync(WORK, { recursive: true });

const goal = { schemaVersion: 2, goalId: 'GOAL-0001', project: 'smoke', title: 'g', goalStatement: 'g', status: 'PLANNING', completionCriteria: [], permissionPolicy: { mode: 'PLAN' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const task = { schemaVersion: 2, taskId: 'TASK-0001', goalId: 'GOAL-0001', project: 'smoke', title: 't', goal: 'g', reason: 'r', scope: 's', completionCriteria: ['c'], executionState: 'RUNNING', pmState: 'PENDING', dependencies: [], linkedRuns: [{ runId: '11111111-1111-1111-1111-111111111111', folder: RUN, taskRunSequence: 1, agent: 'worker-claude-code', date: '2026-09-05' }], nextTaskRunSequence: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
fs.writeFileSync(path.join(PROJECT_DIR, '_relay/goals/GOAL-0001/goal.json'), JSON.stringify(goal, null, 2));
fs.writeFileSync(path.join(PROJECT_DIR, '_relay/tasks/TASK-0001/task.json'), JSON.stringify(task, null, 2));
fs.writeFileSync(path.join(RUN, 'meta.json'), JSON.stringify({ tags: [], runId: '11111111-1111-1111-1111-111111111111', goalId: 'GOAL-0001', taskId: 'TASK-0001', taskRunSequence: 1, workspaceRoot: WORK, workerId: 'claude-code' }, null, 2));

const WRAPPER = path.resolve(__dirname, '../scripts/relay-worker-claude.mjs');
const args = [WRAPPER, '--dataRoot', SMOKE, '--project', PROJECT, '--taskId', 'TASK-0001', '--runId', '11111111-1111-1111-1111-111111111111', '--workspaceRoot', WORK];

async function runWrapper(env, extraArgs = []) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [...args, ...extraArgs], { env: { ...process.env, ...env }, cwd: path.resolve(__dirname, '..') });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// A Run-bound profile must become the child environment, not merely a log field.
const PROFILE_DIR = path.join(TEST_ROOT, 'run-bound-profile');
const PROFILE_SEEN = path.join(TEST_ROOT, 'run-bound-profile-seen.txt');
fs.mkdirSync(PROFILE_DIR, { recursive: true });
const PROFILE_WORKER = path.join(TEST_ROOT, 'profile-worker.mjs');
fs.writeFileSync(
  PROFILE_WORKER,
  `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(PROFILE_SEEN)}, process.env.CLAUDE_CONFIG_DIR || '');\nprocess.exit(0);\n`,
  'utf8',
);
fs.chmodSync(PROFILE_WORKER, 0o755);

function readLaunchLog() {
  return JSON.parse(fs.readFileSync(path.join(RUN, 'worker-launch.log'), 'utf8').split('\n---\n').pop());
}

// ── 1/2/3: non-zero worker stderr captured, bounded, no secrets ──
console.log('\n-- non-zero diagnostics --');
{
  const res = await runWrapper({ ...workerTarget(FAKE_WORKER), G6_SENTINEL_SECRET: SENTINEL_SECRET });
  const log = readLaunchLog();
  check(res.code === 1, '1 wrapper propagates non-zero exit');
  check(typeof log.stderrExcerpt === 'string' && log.stderrExcerpt.includes('LAUNCH_ERROR_ABORT'), '1 non-zero stderr captured');
  check(log.stderrExcerpt.length <= 16 * 1024, '2 diagnostic bounded (<=16KiB)');
  check(!JSON.stringify(log).includes(SENTINEL_SECRET), '3 no env/secret leaked into launch log');
  check(Array.isArray(log.argvShape) && log.argvShape[0] === expectedArgvExe(FAKE_WORKER) && log.argvShape.includes('--print'), '5 argv shape recorded (resolved exe + flags)');
  check(!log.argvShape.some((a) => typeof a === 'string' && a.includes(SENTINEL_SECRET)), '5 argv shape has no secret');
  check(typeof log.stdoutExcerpt === 'string' && log.stdoutExcerpt.includes('some stdout'), '1 stdout captured when relevant');
  check(log.stderrExcerpt === undefined || typeof log.stderrExcerpt === 'string', '2 stderr excerpt is a bounded string');
}

// ── 4: successful worker unchanged (exit 0, no diag fields) ──
console.log('\n-- success path --');
{
  const OK_WORKER = path.join(TEST_ROOT, 'ok-worker.mjs');
  fs.writeFileSync(OK_WORKER, `#!/usr/bin/env node\nprocess.stdout.write('RESPONSE_OK\\n');\nprocess.exit(0);\n`, 'utf8');
  fs.chmodSync(OK_WORKER, 0o755);
  const run = await runWrapper({ ...workerTarget(OK_WORKER) });
  check(run.code === 0, '4 successful worker exit 0');
  const log = readLaunchLog();
  check(log.phase === 'completed' && log.exitCode === 0, '4 success recorded');
  check(log.stderrExcerpt === undefined && log.stdoutExcerpt === undefined, '4 no diagnostic excerpts on success');
}

console.log('\n-- run-bound profile propagation --');
{
  const run = await runWrapper(
    { ...workerTarget(PROFILE_WORKER), CLAUDE_CONFIG_DIR: path.join(TEST_ROOT, 'wrong-ambient-profile') },
    ['--claudeConfigDir', PROFILE_DIR],
  );
  const log = readLaunchLog();
  check(run.code === 0, '6 run-bound profile worker exits 0');
  check(log.claudeConfigProfile === 'run-bound', '6 wrapper selects Run-bound profile over ambient env');
  check(fs.existsSync(PROFILE_SEEN) && fs.readFileSync(PROFILE_SEEN, 'utf8') === PROFILE_DIR, '6 child receives exact Run-bound CLAUDE_CONFIG_DIR');
}

console.log(`\nG6 Worker Launch Diagnostics Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
