/**
 * V1.6 Slice 8 — wrapper QA-remediation prompt recompute (narrow correction).
 *
 * The Dispatcher pre-writes prompt.md for QA remediation Runs from
 * composeQaRemediationPrompt (backend-composed). The wrapper used to know
 * only retry-context.json, recomputed the INITIAL prompt for remediation
 * Runs, hit the byte-mismatch refusal, exited 1, and wedged the Task FAILED
 * (proven live in Slice 8 dogfood Run 2). The wrapper now recomputes via the
 * shared QA composer from the same durable inputs. CLAUDE_EXE override keeps
 * this hermetic (no real Claude): prompt agreement is proven by the wrapper
 * proceeding to spawn (exit 0 + echo marker); disagreement would exit 1.
 * POSIX uses the .mjs echo fixture directly (shebang); Windows compiles the
 * tiny C# echo fixture to a real .exe because CreateProcess cannot execute a
 * script with shell:false (EFTYPE) — shell:true/cmd.exe stay forbidden.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const WRAPPER = path.join(REPO, 'scripts', 'relay-worker-claude.mjs');
const ECHO_MJS = path.join(REPO, 'test', 'fixtures', 'workers', 'fake-claude-qa-echo.mjs');
const ECHO_CS = path.join(REPO, 'test', 'fixtures', 'workers', 'fake-claude-qa-echo.cs');

/**
 * Resolve the fake Claude executable for THIS platform.
 *
 * POSIX: the .mjs fixture is directly executable (shebang + exec bit).
 * Windows: CreateProcess cannot execute a .mjs with shell:false (EFTYPE) —
 * shell:true/cmd.exe are forbidden production-wide — so compile the tiny C#
 * echo fixture (same argv contract + echo marker) to a real .exe, test-only,
 * under the disposable TEST_ROOT. No production code is involved.
 */
function resolveFakeClaudeExe() {
  if (process.platform !== 'win32') return ECHO_MJS;
  const exe = path.join(ROOT, 'fake-claude-qa-echo.exe');
  if (!fs.existsSync(exe)) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(ECHO_CS)})) -OutputAssembly ${q(exe)} -OutputType ConsoleApplication`,
    ], { shell: false, encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(exe)) {
      throw new Error(`fake Claude .exe compile failed (status=${r.status}): ${(r.stderr || '').slice(0, 500)}`);
    }
  }
  return exe;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-v16-s8-qaremed-'));
const project = 'V16S8WrapRemed';

const gt = await import('../dist/server/backend/goal-task.js');
const gtr = await import('../dist/server/backend/goal-task-runtime.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

let passed = 0; let failed = 0;
const check = (c, m) => {
  if (c) { console.log(`  PASS  ${m}`); passed += 1; }
  else { console.log(`  FAIL  ${m}`); failed += 1; process.exitCode = 1; }
};

// Fixture implementation worker (never actually spawned here — the wrapper is
// invoked directly with relay args, exactly as the Dispatcher would).
wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'wrap-remed-worker', displayName: 'wrap fixture',
  launchCommand: process.execPath, launchArgsPrefix: [resolveFakeClaudeExe()],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const goal = await gt.createGoal(ROOT, project, { title: 'g', goalStatement: 'g' });
const task = await gt.createTask(ROOT, project, {
  goalId: goal.goalId, title: 'QA remediation recompute', goal: 'fix the file', reason: 'fixture',
  scope: 'fixture scope; authorized file: out.txt',
  completionCriteria: ['done'], executionState: 'RUNNING', pmState: 'PENDING',
  acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' }],
  qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
});

// Real Run 1 → real QA FAIL → real remediation prep + pre-written prompt.md.
const ws1 = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-v16-s8-ws1-'));
const folder1 = path.join(ROOT, project, '_fixture-runs', 'run-1');
fs.mkdirSync(folder1, { recursive: true });
fs.writeFileSync(path.join(folder1, 'meta.json'), JSON.stringify({ tags: [], runId: 'wrap-run-1', workspaceRoot: ws1, workerId: 'wrap-remed-worker' }), 'utf8');
await gt.linkRunToTask(ROOT, project, task.taskId, folder1);
const link1 = gt.getTask(ROOT, project, task.taskId).linkedRuns[0];
fs.mkdirSync(path.join(folder1, 'evidence'), { recursive: true });
fs.writeFileSync(path.join(folder1, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
fs.writeFileSync(path.join(folder1, 'result.md'), 'fixture result (no out.txt)', 'utf8');
observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: ws1, taskId: task.taskId, runId: link1.runId });
await gtr.markQaResultReceived(ROOT, project, task.taskId, link1.runId);
const f1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
check(f1.outcome === 'FAIL_REMEDIATION_DISPATCHED', `fixture Run 1 FAIL → remediation dispatched (got ${f1.outcome})`);
await new Promise((r) => setTimeout(r, 500));
// Drain the fixture live dispatch so Run 2 stays pristine for the wrapper call.
disp._resetDispatcherStateForTests();
await captureSvc._resetCaptureServiceForTests();
testFix.ensureTestFixtureAdapterRegistered();

const t2 = gt.getTask(ROOT, project, task.taskId);
const run2 = [...t2.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
const prewritten = fs.readFileSync(path.join(run2.folder, 'prompt.md'), 'utf8');
check(fs.existsSync(path.join(run2.folder, 'qa-remediation-context.json')), 'Run 2 carries qa-remediation-context.json (not retry-context.json)');
check(!fs.existsSync(path.join(run2.folder, 'retry-context.json')), 'Run 2 carries no retry-context.json (lineages exclusive)');

// 1. Wrapper recomputes the identical QA remediation prompt → agrees → spawns.
{
  const fakeExe = resolveFakeClaudeExe();
  const argvDump = path.join(ROOT, 'fake-argv-1.txt');
  const r = spawnSync(process.execPath, [WRAPPER,
    '--dataRoot', ROOT, '--project', project, '--taskId', task.taskId, '--runId', run2.runId, '--workspaceRoot', ws1,
  ], {
    cwd: ws1, shell: false, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_EXE: fakeExe, CLAUDE_CONFIG_DIR: os.tmpdir(), FAKE_CLAUDE_ARGV_DUMP: argvDump },
  });
  check(r.status === 0, `wrapper agrees with pre-written QA prompt and spawns (got status=${r.status} stderr=${JSON.stringify((r.stderr || '').slice(0, 300))})`);
  check(!(r.stderr || '').includes('DIFFERENT content'), 'no byte-mismatch refusal');
  check(!(r.stderr || '').includes('EFTYPE'), 'no EFTYPE: fake Claude process actually launched via shell:false spawn');
  // The fake really received the Claude argv (not bypassed): it dumped what
  // it was given; the dump must carry --print plus the agreed prompt bytes.
  check(fs.existsSync(argvDump), 'fake Claude process ran and dumped its received argv');
  if (fs.existsSync(argvDump)) {
    const dumped = fs.readFileSync(argvDump, 'utf8');
    check(dumped.split('\n').includes('--print'), 'fake received the --print flag verbatim');
    check(dumped.includes(prewritten.slice(0, 64)), 'fake received the agreed prompt bytes (argv receipt proven)');
  }
}

// 2. Both contexts present → refuses (corruption fails safe, never a guess).
{
  fs.writeFileSync(path.join(run2.folder, 'retry-context.json'), JSON.stringify({
    preparationId: 'RTP-PMJ-x', sourceRunId: run2.runId, taskId: task.taskId, judgmentId: 'j', deliveryId: 'd',
  }), 'utf8');
  const argvDump2 = path.join(ROOT, 'fake-argv-2.txt');
  try { fs.unlinkSync(argvDump2); } catch { /* absent */ }
  const r = spawnSync(process.execPath, [WRAPPER,
    '--dataRoot', ROOT, '--project', project, '--taskId', task.taskId, '--runId', run2.runId, '--workspaceRoot', ws1,
  ], {
    cwd: ws1, shell: false, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CLAUDE_EXE: resolveFakeClaudeExe(), CLAUDE_CONFIG_DIR: os.tmpdir(), FAKE_CLAUDE_ARGV_DUMP: argvDump2 },
  });
  check(r.status === 1 && (r.stderr || '').includes('mutually exclusive'), 'dual-context Run folder refuses safely');
  check(!fs.existsSync(argvDump2), 'refusal happens before spawn: fake Claude never launched');
}

console.log(`\nSlice 8 wrapper QA remediation: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
