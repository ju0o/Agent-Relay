/**
 * V1.6 Slice 3 — Semantic QA Agent dispatch. Runs against compiled server
 * modules under dist/server. Uses fake `node -e` QA workers registered in
 * the trusted worker registry — never a real Claude/GPT call. No
 * result-bridge wiring, no remediation dispatch, no MCP surface.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s3-${process.pid}-${Date.now()}`);
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
const wr = await import('../dist/server/backend/worker-registry.js');
const sem = await import('../dist/server/backend/qa-semantic-evaluator.js');

const project = 'V16Slice3';
let runCounter = 0;
let workerCounter = 0;

async function makeTaskWithRun() {
  const goal = await gt.createGoal(ROOT, project, { title: 'S3 goal', goalStatement: 'S3 fixture goal' });
  const task = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'S3 task', goal: 'S3 fixture task', reason: 'fixture', scope: 'fixture-only',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  runCounter += 1;
  const workspaceRoot = path.join(ROOT, 'ws', String(runCounter));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', String(runCounter));
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s3-run-${runCounter}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 'claude-code' }), 'utf8');
  await gt.linkRunToTask(ROOT, project, task.taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(folder, 'result.md'), 'Implemented the requested change.', 'utf8');
  return { task, runId, folder, workspaceRoot };
}

// Fake QA workers are real `.mjs` files run as `node <file> --print <prompt>`
// — NOT `node -e "<script>" --print <prompt>`. Node's `-e`/`-p` REPL-eval
// flag parsing treats a later `--print` specially (it gets reinterpreted as
// Node's OWN -p flag and swallows the next argv as a second eval — this bit
// a first draft of this test). Running an actual file sidesteps that
// entirely: `--print` and the prompt land as plain process.argv[2]/[3].
const FAKE_WORKERS_DIR = path.join(ROOT, '_fake-qa-workers');
fs.mkdirSync(FAKE_WORKERS_DIR, { recursive: true });

function registerFakeQaWorker(script) {
  workerCounter += 1;
  const workerId = `fake-qa-${workerCounter}`;
  const scriptPath = path.join(FAKE_WORKERS_DIR, `${workerId}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: process.execPath, launchArgsPrefix: [scriptPath], role: 'qa',
  });
  return workerId;
}

/** Well-behaved worker: echoes PASS for whatever AC ids appear in the prompt. */
function passWorkerScript(markerPath) {
  return `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(markerPath)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: PASS');\nconsole.log('criteria:');\nfor (const id of ids) console.log('- ' + id + ': PASS');\n`;
}

/** Fails the first AC id it finds in the prompt. */
function failWorkerScript(markerPath) {
  return `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(markerPath)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: FAIL');\nconsole.log('failedCriteria:');\nconsole.log('- ' + ids[0]);\nconsole.log('reason: fake failure reason');\nconsole.log('remediationInstruction: fake remediation instruction');\n`;
}

function garbageWorkerScript(markerPath) {
  return `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(markerPath)}, 'x');\nconsole.log('this is not a structured status block at all');\n`;
}

function timeoutWorkerScript(markerPath) {
  return `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(markerPath)}, 'x');\nsetTimeout(() => {}, 999999);\n`;
}

// Fixture setup: an untagged implementation-role worker row (no `role`
// field, exactly like every pre-Slice-3 registry entry) to prove the
// additive field never disturbs existing rows.
wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'claude-code', launchCommand: process.execPath, launchArgsPrefix: ['-e', "console.log('placeholder')"],
});
// A default QA-role worker for tests that don't care which fake worker is used.
wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'fake-qa-default', launchCommand: process.execPath, launchArgsPrefix: ['-e', "console.log('placeholder')"], role: 'qa',
});

console.log('\n== PARSER (direct unit tests) ==');

console.log('-- 1) valid PASS block parses --');
{
  const out = sem.parseSemanticQaOutput('status: PASS\ncriteria:\n- AC-1: PASS\n- AC-2: PASS\n', ['AC-1', 'AC-2']);
  check(out.kind === 'pass', `1a parses as pass (got ${out.kind})`);
}

console.log('-- 2) valid FAIL block parses --');
{
  const out = sem.parseSemanticQaOutput('status: FAIL\nfailedCriteria:\n- AC-1\nreason: broke it\nremediationInstruction: fix it\n', ['AC-1', 'AC-2']);
  check(out.kind === 'fail' && out.failedCriteria[0] === 'AC-1' && out.reason === 'broke it' && out.remediationInstruction === 'fix it', `2a parses as fail with reason/remediation (got ${JSON.stringify(out)})`);
}

console.log('-- 3) missing status line → unparseable --');
{
  const out = sem.parseSemanticQaOutput('criteria:\n- AC-1: PASS\n', ['AC-1']);
  check(out.kind === 'unparseable', '3a missing status → unparseable');
}

console.log('-- 4) PASS omitting a required id → unparseable --');
{
  const out = sem.parseSemanticQaOutput('status: PASS\ncriteria:\n- AC-1: PASS\n', ['AC-1', 'AC-2']);
  check(out.kind === 'unparseable', '4a PASS missing required AC-2 → unparseable, never partially trusted');
}

console.log('-- 5) PASS referencing an unrequested id → unparseable (no new requirements) --');
{
  const out = sem.parseSemanticQaOutput('status: PASS\ncriteria:\n- AC-1: PASS\n- AC-BOGUS: PASS\n', ['AC-1']);
  check(out.kind === 'unparseable', '5a PASS with an unrequested id → unparseable');
}

console.log('-- 6) FAIL citing an unrequested id → unparseable --');
{
  const out = sem.parseSemanticQaOutput('status: FAIL\nfailedCriteria:\n- AC-BOGUS\n', ['AC-1']);
  check(out.kind === 'unparseable', '6a FAIL citing an unrequested id → unparseable');
}

console.log('-- 7) FAIL with empty failedCriteria → unparseable --');
{
  const out = sem.parseSemanticQaOutput('status: FAIL\nfailedCriteria:\n', ['AC-1']);
  check(out.kind === 'unparseable', '7a empty failedCriteria → unparseable');
}

console.log('-- 8) unknown status value → unparseable --');
{
  const out = sem.parseSemanticQaOutput('status: MAYBE\n', ['AC-1']);
  check(out.kind === 'unparseable', '8a unknown status value → unparseable, never guessed');
}

console.log('\n== PROMPT COMPOSITION (direct unit tests) ==');

console.log('-- 9) composed prompt stays under the 16 KiB cap for a normal input --');
{
  const prompt = sem.composeSemanticQaPrompt({
    qaAttemptId: 'QA-TASK-0001-run-1',
    task: { title: 'x', goal: 'y', reason: 'z', scope: 'w' },
    criteria: [{ id: 'AC-1', text: 'must do the thing' }],
    workerResult: { text: 'did the thing', truncated: false, source: 'result.md' },
    deterministicSummary: '- [PASS] fileExists: ok',
  });
  check(Buffer.byteLength(prompt, 'utf8') <= sem.SEMANTIC_QA_PROMPT_SIZE_LIMIT_BYTES, '9a prompt within 16 KiB cap');
  check(prompt.includes('AC-1') && prompt.includes('must do the thing'), '9b prompt carries the criterion text');
  check(!prompt.includes('chain-of-thought') , '9c sanity: no accidental placeholder text leaked');
}

console.log('-- 10) oversized composition throws INVALID_ARGUMENT rather than silently truncating --');
{
  const bigCriteria = Array.from({ length: 30 }, (_, i) => ({ id: `AC-${i}`, text: 'X'.repeat(1000) }));
  await throwsWithCode(
    async () => sem.composeSemanticQaPrompt({
      qaAttemptId: 'QA-TASK-0002-run-1',
      task: { title: 'x', goal: 'y', reason: 'z', scope: 'w' },
      criteria: bigCriteria,
      workerResult: { text: 'x', truncated: false, source: 'result.md' },
      deterministicSummary: 'x',
    }),
    'INVALID_ARGUMENT',
    '10a oversized prompt fails safe, never silently truncated',
  );
}

console.log('\n== DISPATCH (fake QA worker, end-to-end) ==');

console.log('-- 11) SEMANTIC PASS → finalQaStatus PASS --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-11');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
  });
  check(out.outcome === 'EVALUATED', '11a outcome EVALUATED');
  check(out.record.finalQaStatus === 'PASS', `11b finalQaStatus PASS (got ${out.record.finalQaStatus})`);
  check(out.record.semantic.status === 'PASS', '11c semantic.status PASS');
  check(fs.readFileSync(marker, 'utf8') === 'x', '11d exactly one invocation on first-try success');
}

console.log('-- 12) SEMANTIC FAIL → finalQaStatus FAIL, remediationInstruction persisted --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-12');
  const workerId = registerFakeQaWorker(failWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
  });
  check(out.record.finalQaStatus === 'FAIL', `12a finalQaStatus FAIL (got ${out.record.finalQaStatus})`);
  check(out.record.remediationInstruction === 'fake remediation instruction', '12b remediationInstruction persisted from Agent output');
  check(out.record.failedCriteria.length === 1 && out.record.failedCriteria[0] === 'AC-1', '12c failedCriteria = [AC-1]');
}

console.log('-- 13) BOTH-mode: deterministic + semantic both PASS → finalQaStatus PASS --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-13');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'BOTH' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, {
    status: 'PASS', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'ok', criterionId: 'AC-1' }],
  });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
  });
  check(out.record.finalQaStatus === 'PASS', `13a BOTH mode with both layers PASS → finalQaStatus PASS (got ${out.record.finalQaStatus})`);
}

console.log('-- 14) unparseable output on both attempts → BLOCKED, exactly 2 invocations --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-14');
  const workerId = registerFakeQaWorker(garbageWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'x' },
  });
  check(out.record.finalQaStatus === 'BLOCKED', `14a finalQaStatus BLOCKED after unparseable output (got ${out.record.finalQaStatus})`);
  check(fs.readFileSync(marker, 'utf8') === 'xx', '14b exactly 2 invocations — one bounded auto-reattempt, never more');
}

console.log('-- 15) first attempt unparseable, second attempt succeeds → uses the second result --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-15');
  const counter = path.join(ROOT, 'marker-15-count');
  const script = `import * as fs from 'node:fs';\nlet n = 0;\ntry { n = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length; } catch {}\nfs.appendFileSync(${JSON.stringify(counter)}, 'x');\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nif (n === 0) {\n  console.log('garbage first try');\n} else {\n  const p = process.argv[3] || '';\n  const ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\n  console.log('status: PASS');\n  console.log('criteria:');\n  for (const id of ids) console.log('- ' + id + ': PASS');\n}\n`;
  const workerId = registerFakeQaWorker(script);
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'x' },
  });
  check(out.record.finalQaStatus === 'PASS', `15a bounded reattempt recovers a genuine PASS (got ${out.record.finalQaStatus})`);
  check(fs.readFileSync(marker, 'utf8') === 'xx', '15b exactly 2 invocations occurred');
}

console.log('-- 16) timeout on both attempts → BLOCKED --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-16');
  const workerId = registerFakeQaWorker(timeoutWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'x' },
    timeoutMs: 300,
  });
  check(out.record.finalQaStatus === 'BLOCKED', `16a timeout on both attempts → BLOCKED (got ${out.record.finalQaStatus})`);
}

console.log('-- 17) spawn failure (nonexistent executable) → BLOCKED --');
{
  const { task, runId } = await makeTaskWithRun();
  workerCounter += 1;
  const workerId = `fake-qa-${workerCounter}`;
  wr.writeWorkerRegistryRecord(ROOT, { schemaVersion: 'G.2', workerId, launchCommand: '/nonexistent/qa-worker-xyz-123', launchArgsPrefix: [], role: 'qa' });
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'x' },
  });
  check(out.record.finalQaStatus === 'BLOCKED', `17a spawn failure → BLOCKED (got ${out.record.finalQaStatus})`);
}

console.log('\n== PRECONDITIONS / FAIL CLOSED ==');

console.log('-- 18) deterministic not yet PASS → refused, nothing dispatched --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-18');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
    'BLOCKED',
    '18a refused before deterministic PASS (non-override invariant)',
  );
  check(!fs.existsSync(marker), '18b QA Agent never dispatched');
}

console.log('-- 19) no SEMANTIC/BOTH criteria → INVALID_ARGUMENT --');
{
  const { task, runId } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-1': 'DETERMINISTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: {} }),
    'INVALID_ARGUMENT',
    '19a nothing to evaluate semantically → refused',
  );
}

console.log('-- 20) criteriaText id set mismatch → INVALID_ARGUMENT --');
{
  const { task, runId } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-1': 'SEMANTIC', 'AC-2': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
    'INVALID_ARGUMENT',
    '20a caller cannot under- or over-declare the derived SEMANTIC/BOTH set',
  );
}

console.log('-- 21) no qaWorkerId configured → BLOCKED --');
{
  const { task, runId } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
    'BLOCKED',
    '21a no qaWorkerId on the attempt → refused',
  );
}

console.log('-- 22) unresolvable qaWorkerId → BLOCKED --');
{
  const { task, runId } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: 'no-such-worker-registered', criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
    'BLOCKED',
    '22a qaWorkerId not in the worker registry → refused',
  );
}

console.log('-- 23) missing QaAttempt → NOT_FOUND --');
{
  const missingId = qa.qaAttemptIdFor('TASK-88888888', 'no-such-run');
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: missingId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: {} }),
    'NOT_FOUND',
    '23a absent attempt propagates untouched',
  );
}

console.log('-- 24) corrupt QaAttempt → CORRUPT_RECORD, never repaired --');
{
  const { task, runId } = await makeTaskWithRun();
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1 });
  const jsonPath = path.join(qa.qaAttemptFolder(ROOT, project, attempt.qaAttemptId), 'qa.json');
  fs.writeFileSync(jsonPath, '{ not valid json', 'utf8');
  await throwsWithCode(
    () => sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: {} }),
    'CORRUPT_RECORD',
    '24a corrupt attempt propagates untouched',
  );
  check(fs.readFileSync(jsonPath, 'utf8') === '{ not valid json', '24b corrupt qa.json left byte-for-byte untouched');
}

console.log('\n== IDEMPOTENCY / CONCURRENCY ==');

console.log('-- 25) second call is idempotent, no re-dispatch --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-25');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const first = await sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } });
  check(first.outcome === 'EVALUATED', '25a first call EVALUATED');
  const second = await sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } });
  check(second.outcome === 'ALREADY_EVALUATED', `25b second call ALREADY_EVALUATED (got ${second.outcome})`);
  check(fs.readFileSync(marker, 'utf8') === 'x', '25c QA Agent never re-dispatched on the second call');
}

console.log('-- 26) concurrent calls dispatch exactly once --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-26');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const [a, b] = await Promise.all([
    sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
    sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  check(JSON.stringify(outcomes) === JSON.stringify(['ALREADY_EVALUATED', 'EVALUATED']), `26a exactly one EVALUATED, one ALREADY_EVALUATED (got ${JSON.stringify(outcomes)})`);
  check(fs.readFileSync(marker, 'utf8') === 'x', '26b QA Agent dispatched exactly once despite concurrent calls');
}

console.log('\n== AUTHORITY BOUNDARY ==');

console.log('-- 27) semantic PASS never mutates the Task record --');
{
  const { task, runId } = await makeTaskWithRun();
  const marker = path.join(ROOT, 'marker-27');
  const workerId = registerFakeQaWorker(passWorkerScript(marker));
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: workerId, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const before = gt.getTask(ROOT, project, task.taskId);
  const out = await sem.evaluateSemanticQa(ROOT, project, { qaAttemptId: attempt.qaAttemptId, task: { title: 't', goal: 'g', reason: 'r', scope: 's' }, criteriaText: { 'AC-1': 'x' } });
  check(out.record.finalQaStatus === 'PASS', '27a fixture reached QA PASS (precondition for this test)');
  const after = gt.getTask(ROOT, project, task.taskId);
  check(after.updatedAt === before.updatedAt, '27b Task record byte-identical after semantic QA PASS');
  check(after.executionState === before.executionState && after.pmState === before.pmState, '27c executionState/pmState unchanged — semantic QA PASS never ACCEPTs a Task or advances a Plan');
}

console.log('\n== worker-registry role field ==');

console.log('-- 28) role field additive, untagged rows remain valid --');
{
  const untagged = wr.loadWorkerRegistryRecord(ROOT, 'claude-code');
  check(untagged.role === undefined, `28a existing untagged worker row has no role (backward compatible) (got ${untagged.role})`);
  const tagged = wr.loadWorkerRegistryRecord(ROOT, 'fake-qa-default');
  check(tagged.role === 'qa', `28b role:'qa' round-trips through storage (got ${tagged.role})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
