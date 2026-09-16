/**
 * V1.6 Slice 2 — deterministic QA evaluator. Runs against compiled server
 * modules under dist/server. No Semantic QA Agent, no result-bridge wiring,
 * no MCP surface — pure check-kind + aggregation + QaAttempt-transition
 * tests per docs/V16-QA-GATE-PLAN-01.md §7-§9.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.join(os.tmpdir(), `arl-v16-s2-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};
async function throwsWithCode(fn, code, message) {
  try {
    await fn();
    check(false, `${message} (did not throw)`);
  } catch (err) {
    check(err && err.code === code, `${message} (got code=${err && err.code}: ${err && err.message})`);
  }
}

const gt = await import('../dist/server/backend/goal-task.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const evalr = await import('../dist/server/backend/qa-deterministic-evaluator.js');

const pwdProbe = await evalr.runProcess(process.execPath, ['-e', 'process.stdout.write(process.env.PWD || "")'], ROOT, 5000);
check(pwdProbe.stdout === ROOT, 'runProcess gives child the authoritative cwd as PWD');

const project = 'V16Slice2';
let runCounter = 0;

/** Materialize a real Task + linked Run (with authoritative workspaceRoot
 * binding and a canonical-Result marker), matching the Task/Run validation
 * this evaluator enforces before running any check. */
async function makeTaskWithRun() {
  const goal = await gt.createGoal(ROOT, project, { title: 'S2 goal', goalStatement: 'S2 fixture goal' });
  const task = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'S2 task', goal: 'S2 fixture task', reason: 'fixture', scope: 'fixture-only',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  runCounter += 1;
  const workspaceRoot = path.join(ROOT, 'ws', String(runCounter));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', String(runCounter));
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s2-run-${runCounter}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 'claude-code' }), 'utf8');
  await gt.linkRunToTask(ROOT, project, task.taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  return { task, runId, folder, workspaceRoot };
}

async function makeAttempt(criteriaValidationModes) {
  const { task, runId, workspaceRoot } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, {
    taskId: task.taskId, runId, qaAttemptNumber: 1,
    ...(criteriaValidationModes ? { criteriaValidationModes } : {}),
  });
  return { task, runId, workspaceRoot, attempt };
}

function initGitRepo(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email s2@example.com', { cwd: dir });
  execSync('git config user.name "S2 Fixture"', { cwd: dir });
}

console.log('\n== FILE EXISTS ==');

console.log('-- 1) existing file → PASS --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'present.txt'), 'hi', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'present.txt', criterionId: 'AC-1' }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'PASS', `1a existing file PASS (got ${c.status}: ${c.detail})`);
}

console.log('-- 2) missing file → FAIL --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'nope.txt', criterionId: 'AC-1' }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '2a missing file FAIL');
}

console.log('-- 3) absolute path → BLOCKED --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: '/etc/passwd' }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '3a absolute path BLOCKED');
}

console.log('-- 4) ../ traversal → BLOCKED --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: '../../../etc/passwd' }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '4a traversal BLOCKED');
}

console.log('-- 5) symlink escape → BLOCKED --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const outsideDir = path.join(ROOT, 'outside-secret');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret', 'utf8');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(workspaceRoot, 'escape-link.txt'));
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'escape-link.txt' }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '5a symlink escape BLOCKED');
}

console.log('\n== FILE EXACT CONTENT ==');

console.log('-- 6) exact bytes → PASS --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'exact.txt'), 'hello world', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExactContent', path: 'exact.txt', expectedContent: 'hello world', criterionId: 'AC-1' }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'PASS', `6a exact bytes PASS (got ${c.status})`);
  check(typeof c.evidence.expectedHash === 'string' && typeof c.evidence.actualHash === 'string', '6b hashes present in evidence');
}

console.log('-- 7) mismatch → FAIL --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'mismatch.txt'), 'actual content', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExactContent', path: 'mismatch.txt', expectedContent: 'expected content', criterionId: 'AC-1' }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'FAIL', '7a mismatch FAIL');
  check(typeof c.evidence.mismatchIndex === 'number', '7b mismatchIndex recorded');
}

console.log('-- 8) trailing newline mismatch detected --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'nl.txt'), 'line\n', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExactContent', path: 'nl.txt', expectedContent: 'line' }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '8a trailing-newline-only difference is FAIL (byte-exact, never normalized)');
}

console.log('-- 9) missing file → FAIL --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExactContent', path: 'ghost.txt', expectedContent: 'x' }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '9a missing file FAIL');
}

console.log('-- 10) large file evidence bounded --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const big = 'A'.repeat(50_000);
  fs.writeFileSync(path.join(workspaceRoot, 'big.txt'), big, 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExactContent', path: 'big.txt', expectedContent: 'A'.repeat(50_000 - 1) + 'B' }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'FAIL', '10a large mismatched file FAIL');
  const evidenceSize = JSON.stringify(c.evidence).length;
  check(evidenceSize < 1000, `10b evidence bounded (~${evidenceSize} bytes, never the full 50000-byte file)`);
  check(c.evidence.actualSnippet.length < 200, '10c bounded mismatch snippet, not the full file');
}

console.log('\n== DIFF SCOPE ==');

console.log('-- 11) only allowed files changed → PASS --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  initGitRepo(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'a.txt'), 'a', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['src'], criterionId: 'AC-1' }],
  });
  check(out.record.deterministic.checks[0].status === 'PASS', '11a only allowed files changed → PASS');
}

console.log('-- 12) forbidden file changed → FAIL --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  initGitRepo(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'a.txt'), 'a', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'forbidden.txt'), 'x', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '12a forbidden file changed → FAIL');
}

console.log('-- 12b) untracked directory is expanded to individual paths --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  initGitRepo(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'newdir', 'allowed.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['newdir/allowed.txt'] }],
  });
  check(out.record.deterministic.checks[0].status === 'PASS', '12b one allowed file inside an untracked directory → PASS');
}

console.log('-- 12c) extra file inside an untracked directory is out of scope --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  initGitRepo(workspaceRoot);
  fs.mkdirSync(path.join(workspaceRoot, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'newdir', 'allowed.txt'), 'ok', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'newdir', 'extra.txt'), 'no', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['newdir/allowed.txt'] }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '12c extra file inside an untracked directory → FAIL');
}

console.log('-- 13) no authoritative diff evidence → BLOCKED --');
{
  const { attempt } = await makeAttempt();
  // deliberately NOT a git repo
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '13a no authoritative diff (not a git repo) → BLOCKED');
}

console.log('-- 14) path normalization cannot bypass allowed scope --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  initGitRepo(workspaceRoot);
  // "src-evil" must never be treated as inside allowed "src" via naive prefix matching.
  fs.mkdirSync(path.join(workspaceRoot, 'src-evil'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src-evil', 'x.txt'), 'x', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'diffScope', allowedPaths: ['src'] }],
  });
  check(out.record.deterministic.checks[0].status === 'FAIL', '14a "src-evil" is never matched by allowed "src" (boundary-aware prefix match)');
}

console.log('\n== COMMAND ==');

console.log('-- 15) argv command exit 0 → PASS --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], criterionId: 'AC-1' }],
  });
  check(out.record.deterministic.checks[0].status === 'PASS', '15a exit 0 → PASS');
}

console.log('-- 16) nonzero exit → FAIL --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'process.exit(7)'] }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'FAIL', `16a nonzero exit → FAIL (got ${c.status})`);
  check(c.evidence.exitCode === 7, '16b exit code recorded in evidence');
}

console.log('-- 17) timeout → BLOCKED --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 5000)'], timeoutMs: 200 }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.status === 'BLOCKED', `17a timeout → BLOCKED (got ${c.status})`);
  check(c.evidence.timedOut === true, '17b timedOut flag set');
}

console.log('-- 18) spawn failure → BLOCKED --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: 'this-executable-does-not-exist-xyz-123', args: [] }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '18a spawn failure → BLOCKED');
}

console.log('-- 19) stdout bounded --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', "process.stdout.write('A'.repeat(20000))"] }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.evidence.stdout.length <= evalr.MAX_COMMAND_OUTPUT_CHARS, `19a stdout bounded to ${evalr.MAX_COMMAND_OUTPUT_CHARS} chars (got ${c.evidence.stdout.length})`);
  check(c.evidence.stdoutTruncated === true, '19b stdoutTruncated flag set');
}

console.log('-- 20) stderr bounded --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', "process.stderr.write('B'.repeat(20000))"] }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.evidence.stderr.length <= evalr.MAX_COMMAND_OUTPUT_CHARS, `20a stderr bounded to ${evalr.MAX_COMMAND_OUTPUT_CHARS} chars (got ${c.evidence.stderr.length})`);
  check(c.evidence.stderrTruncated === true, '20b stderrTruncated flag set');
}

console.log('-- 21) shell metacharacters remain literal argv --');
{
  const { attempt } = await makeAttempt();
  const weird = '$(echo hacked); rm -rf /tmp/should-not-run `whoami` && echo pwned > /tmp/pwned';
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])', weird] }],
  });
  const c = out.record.deterministic.checks[0];
  check(c.evidence.stdout === weird, '21a shell metacharacters passed through as one literal argv element, never interpreted');
  check(!fs.existsSync('/tmp/pwned'), '21b no shell side effect executed');
}

console.log('-- 22) cwd escape rejected --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '../../../../../../etc' }],
  });
  check(out.record.deterministic.checks[0].status === 'BLOCKED', '22a cwd escape rejected → BLOCKED');
}

console.log('\n== AGGREGATION ==');

console.log('-- 23) all PASS → deterministic PASS --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [
      { kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' },
      { kind: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], criterionId: 'AC-2' },
    ],
  });
  check(out.record.deterministic.status === 'PASS', '23a all PASS → deterministic PASS');
}

console.log('-- 24) one FAIL → deterministic FAIL --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [
      { kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' },
      { kind: 'fileExists', path: 'missing.txt', criterionId: 'AC-2' },
    ],
  });
  check(out.record.deterministic.status === 'FAIL', '24a one FAIL → deterministic FAIL');
}

console.log('-- 25) one BLOCKED → deterministic BLOCKED --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [
      { kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' },
      { kind: 'fileExists', path: '/etc/passwd', criterionId: 'AC-2' },
    ],
  });
  check(out.record.deterministic.status === 'BLOCKED', '25a one BLOCKED → deterministic BLOCKED');
}

console.log('-- 26) BLOCKED + FAIL → BLOCKED --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [
      { kind: 'fileExists', path: 'missing.txt', criterionId: 'AC-1' }, // FAIL
      { kind: 'fileExists', path: '/etc/passwd', criterionId: 'AC-2' }, // BLOCKED
    ],
  });
  check(out.record.deterministic.status === 'BLOCKED', '26a BLOCKED precedes FAIL (BLOCKED > FAIL > PASS)');
}

console.log('-- 27) failedCriteria attributed correctly --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [
      { kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' },
      { kind: 'fileExists', path: 'missing.txt', criterionId: 'AC-2' },
    ],
  });
  check(out.record.failedCriteria.length === 1 && out.record.failedCriteria[0] === 'AC-2', `27a failedCriteria = [AC-2] (got ${JSON.stringify(out.record.failedCriteria)})`);
}

console.log('\n== QA ATTEMPT TRANSITIONS ==');

console.log('-- 28) deterministic FAIL → finalQaStatus FAIL --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'missing.txt', criterionId: 'AC-1' }],
  });
  check(out.record.finalQaStatus === 'FAIL', '28a finalQaStatus FAIL');
  check(out.record.completedAt !== undefined, '28b completedAt set');
}

console.log('-- 29) deterministic BLOCKED → finalQaStatus BLOCKED --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: '/etc/passwd' }],
  });
  check(out.record.finalQaStatus === 'BLOCKED', '29a finalQaStatus BLOCKED');
}

console.log('-- 30) deterministic PASS + deterministic-only ACs → final PASS --');
{
  const { workspaceRoot, attempt } = await makeAttempt({ 'AC-1': 'DETERMINISTIC' });
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' }],
  });
  check(out.record.finalQaStatus === 'PASS', `30a final PASS with no LLM call (got ${out.record.finalQaStatus})`);
  check(out.record.semantic === undefined, '30b no semantic evidence — no LLM call');
}

console.log('-- 31) deterministic PASS + SEMANTIC AC → stays PENDING --');
{
  const { workspaceRoot, attempt } = await makeAttempt({ 'AC-1': 'SEMANTIC' });
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [], // deterministic layer has nothing to say about a SEMANTIC-only AC
  });
  check(out.record.finalQaStatus === 'PENDING', `31a stays PENDING awaiting semantic (got ${out.record.finalQaStatus})`);
  check(out.record.deterministic.status === 'PASS', '31b deterministic evidence persisted as PASS');
}

console.log('-- 32) deterministic PASS + BOTH AC → stays PENDING --');
{
  const { workspaceRoot, attempt } = await makeAttempt({ 'AC-1': 'BOTH' });
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'ok.txt', criterionId: 'AC-1' }],
  });
  check(out.record.finalQaStatus === 'PENDING', `32a BOTH AC stays PENDING even with deterministic coverage (got ${out.record.finalQaStatus})`);
}

console.log('-- 33) semantic evidence not invented --');
{
  const { workspaceRoot, attempt } = await makeAttempt({ 'AC-1': 'SEMANTIC' });
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'ok.txt' }],
  });
  check(out.record.semantic === undefined, '33a no semantic evidence fabricated anywhere in this Slice');
}

console.log('-- 34) second evaluation is idempotent --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const marker = path.join(workspaceRoot, '.marker-34');
  const checks = [{ kind: 'command', command: process.execPath, args: ['-e', "require('fs').appendFileSync(process.argv[1],'x')", marker], criterionId: 'AC-1' }];
  const first = await evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks });
  check(first.outcome === 'EVALUATED', '34a first call EVALUATED');
  const second = await evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks });
  check(second.outcome === 'ALREADY_EVALUATED', `34b second call ALREADY_EVALUATED (got ${second.outcome})`);
  check(second.record.updatedAt === first.record.updatedAt, '34c no re-persistence on second call');
  check(fs.readFileSync(marker, 'utf8') === 'x', '34d command never re-executed on second call');
}

console.log('-- 35) concurrent evaluation does not duplicate command execution --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const marker = path.join(workspaceRoot, '.marker-35');
  const checks = [{ kind: 'command', command: process.execPath, args: ['-e', "require('fs').appendFileSync(process.argv[1],'x')", marker], criterionId: 'AC-1' }];
  const [a, b] = await Promise.all([
    evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks }),
    evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  check(JSON.stringify(outcomes) === JSON.stringify(['ALREADY_EVALUATED', 'EVALUATED']), `35a exactly one EVALUATED, one ALREADY_EVALUATED (got ${JSON.stringify(outcomes)})`);
  check(fs.readFileSync(marker, 'utf8') === 'x', '35b command executed exactly once despite concurrent calls');
}

console.log('\n== ERROR HANDLING / FAIL CLOSED ==');

console.log('-- 41) unfrozen check kind rejected up front (batch-level, nothing runs) --');
{
  const { attempt } = await makeAttempt();
  await throwsWithCode(
    () => evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks: [{ kind: 'shellExec', path: 'x' }] }),
    'INVALID_ARGUMENT',
    '41a unfrozen check kind rejected before anything runs',
  );
  const reread = qa.getQaAttempt(ROOT, project, attempt.qaAttemptId);
  check(reread.deterministic === undefined, '41b attempt untouched after a rejected batch');
}

console.log('-- 42) Run never linked to canonical Task → BLOCKED precondition, attempt untouched --');
{
  const goal = await gt.createGoal(ROOT, project, { title: 'S2 orphan goal', goalStatement: 'fixture' });
  const task = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'S2 orphan task', goal: 'fixture', reason: 'fixture', scope: 'fixture-only',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId: 'never-linked-run', qaAttemptNumber: 1 });
  await throwsWithCode(
    () => evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks: [] }),
    'BLOCKED',
    '42a unlinked Run refused as a precondition failure',
  );
  const reread = qa.getQaAttempt(ROOT, project, attempt.qaAttemptId);
  check(reread.deterministic === undefined, '42b attempt never touched by a refused precondition');
}

console.log('-- 43) Result not yet canonically captured → BLOCKED precondition --');
{
  const { task, runId, folder, attempt } = await (async () => {
    const goal = await gt.createGoal(ROOT, project, { title: 'S2 nocap goal', goalStatement: 'fixture' });
    const task = await gt.createTask(ROOT, project, {
      goalId: goal.goalId, title: 'S2 nocap task', goal: 'fixture', reason: 'fixture', scope: 'fixture-only',
      executionState: 'RUNNING', pmState: 'PENDING',
    });
    runCounter += 1;
    const workspaceRoot = path.join(ROOT, 'ws', `nocap-${runCounter}`);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const runFolder = path.join(ROOT, project, '_fixture-runs', `nocap-${runCounter}`);
    fs.mkdirSync(runFolder, { recursive: true });
    const rid = `s2-nocap-run-${runCounter}`;
    fs.writeFileSync(path.join(runFolder, 'meta.json'), JSON.stringify({ tags: [], runId: rid, workspaceRoot, workerId: 'claude-code' }), 'utf8');
    await gt.linkRunToTask(ROOT, project, task.taskId, runFolder);
    // deliberately no evidence/adapter.json — Result never canonically captured
    const a = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId: rid, qaAttemptNumber: 1 });
    return { task, runId: rid, folder: runFolder, attempt: a };
  })();
  await throwsWithCode(
    () => evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks: [] }),
    'BLOCKED',
    '43a uncaptured Result refused as a precondition failure',
  );
}

console.log('-- 44) missing QaAttempt → NOT_FOUND propagates untouched --');
{
  const missingId = qa.qaAttemptIdFor('TASK-99999999', 'no-such-run');
  await throwsWithCode(
    () => evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: missingId, checks: [] }),
    'NOT_FOUND',
    '44a evaluator never masks an absent attempt as anything else',
  );
}

console.log('-- 45) corrupt QaAttempt → CORRUPT_RECORD propagates, never repaired/recreated --');
{
  const { attempt } = await makeAttempt();
  const folder = qa.qaAttemptFolder(ROOT, project, attempt.qaAttemptId);
  const qaJsonPath = path.join(folder, 'qa.json');
  fs.writeFileSync(qaJsonPath, '{ not valid json', 'utf8');
  await throwsWithCode(
    () => evalr.evaluateDeterministicQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, checks: [] }),
    'CORRUPT_RECORD',
    '45a corrupt attempt refused, never silently treated as absent-and-recreated',
  );
  check(fs.readFileSync(qaJsonPath, 'utf8') === '{ not valid json', '45b corrupt qa.json left byte-for-byte untouched by the evaluator');
}

console.log('-- 46) command evidence carries argv/cwd for audit --');
{
  const { attempt } = await makeAttempt();
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'command', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.' }],
  });
  const c = out.record.deterministic.checks[0];
  check(Array.isArray(c.evidence.argv) && c.evidence.argv[0] === process.execPath && c.evidence.argv[1] === '-e', '46a argv recorded verbatim in evidence');
  check(c.evidence.cwd === '.', '46b workspace-relative cwd recorded in evidence');
}

console.log('-- 47) unreadable target (permission denied) → BLOCKED, not FAIL --');
{
  const { workspaceRoot, attempt } = await makeAttempt();
  const dir = path.join(workspaceRoot, 'locked');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x', 'utf8');
  fs.chmodSync(dir, 0o000);
  try {
    const out = await evalr.evaluateDeterministicQa(ROOT, project, {
      qaAttemptId: attempt.qaAttemptId,
      checks: [{ kind: 'fileExists', path: 'locked/secret.txt' }],
    });
    const c = out.record.deterministic.checks[0];
    check(c.status === 'BLOCKED', `47a permission-denied path is BLOCKED, never guessed as FAIL (got ${c.status}: ${c.detail})`);
  } finally {
    fs.chmodSync(dir, 0o755); // restore so ROOT cleanup / later fixtures are unaffected
  }
}

console.log('-- 48) QA PASS never mutates the Task record (authority boundary) --');
{
  const { task, workspaceRoot, attempt } = await makeAttempt();
  const before = gt.getTask(ROOT, project, task.taskId);
  fs.writeFileSync(path.join(workspaceRoot, 'ok.txt'), 'ok', 'utf8');
  const out = await evalr.evaluateDeterministicQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    checks: [{ kind: 'fileExists', path: 'ok.txt' }],
  });
  check(out.record.finalQaStatus === 'PASS', '48a fixture actually reached QA PASS (precondition for this test)');
  const after = gt.getTask(ROOT, project, task.taskId);
  check(after.updatedAt === before.updatedAt, '48b Task record byte-identical after QA PASS — no write occurred');
  check(after.executionState === before.executionState && after.pmState === before.pmState, '48c executionState/pmState unchanged — QA PASS never sets ACCEPTED or advances a Plan; only GPT PM ACCEPT may');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
