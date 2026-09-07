/**
 * V1.6 Slice 1 — durable QA record kernel (QaAttemptRecord +
 * QaRemediationPreparationRecord). Runs against compiled server modules
 * under dist/server. No Worker execution, no result-bridge wiring, no MCP
 * surface — pure storage/validation/transition tests per
 * docs/V16-QA-GATE-PLAN-01.md.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s1-${process.pid}-${Date.now()}`);
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

const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const retryPrep = await import('../dist/server/backend/retry-preparation.js');

const project = 'V16Slice1';
let taskCounter = 0;
function nextTaskId() {
  taskCounter += 1;
  return `TASK-${String(taskCounter).padStart(4, '0')}`;
}

console.log('\n== QA ATTEMPT ==');

console.log('-- 1) valid PENDING creation --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  check(rec.finalQaStatus === 'PENDING', '1a finalQaStatus PENDING');
  check(rec.qaAttemptId === `QA-${taskId}-run-1`, '1b deterministic qaAttemptId');
  check(rec.failedCriteria.length === 0, '1c failedCriteria empty');
  check(rec.completedAt === undefined, '1d no completedAt yet');
}

console.log('-- 2) deterministic-only PASS (no semantic needed) --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'exists', criterionId: 'AC-01' }],
  });
  const done = await qa.completeQaAttempt(ROOT, project, rec.qaAttemptId, { finalQaStatus: 'PASS' });
  check(done.finalQaStatus === 'PASS', '2a finalQaStatus PASS');
  check(done.completedAt !== undefined, '2b completedAt set');
  check(done.semantic === undefined, '2c no semantic evidence recorded — no LLM call');
}

console.log('-- 3) semantic PASS --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, {
    taskId, runId: 'run-1', qaAttemptNumber: 1, qaWorkerId: 'claude-code',
    criteriaValidationModes: { 'AC-02': 'SEMANTIC' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'exists' }],
  });
  const done = await qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    criteria: [{ id: 'AC-02', status: 'PASS', note: 'matches intent' }],
    qaWorkerId: 'claude-code',
  });
  check(done.finalQaStatus === 'PASS', '3a finalQaStatus PASS');
  check(done.semantic.status === 'PASS', '3b semantic recorded PASS');
}

console.log('-- 4) BOTH PASS (both layers cover the same criterion) --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, {
    taskId, runId: 'run-1', qaAttemptNumber: 1,
    criteriaValidationModes: { 'AC-04': 'BOTH' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    checks: [{ checkIndex: 0, kind: 'command', status: 'PASS', detail: 'exit 0', criterionId: 'AC-04' }],
  });
  const done = await qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    criteria: [{ id: 'AC-04', status: 'PASS', note: 'behavior intact' }],
  });
  check(done.finalQaStatus === 'PASS', '4a BOTH PASS accepted when both layers cover it');
}

console.log('-- 5) deterministic FAIL record --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  const done = await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'FAIL',
    checks: [{ checkIndex: 0, kind: 'fileExactContent', status: 'FAIL', detail: 'mismatch', criterionId: 'AC-01' }],
    failedCriteria: ['AC-01'],
  });
  check(done.finalQaStatus === 'FAIL', '5a finalQaStatus FAIL');
  check(done.failedCriteria.length === 1 && done.failedCriteria[0] === 'AC-01', '5b failedCriteria recorded');
  check(done.semantic === undefined, '5c semantic never invoked after deterministic FAIL (hard gate)');
  await throwsWithCode(
    () => qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', criteria: [] }),
    'CONFLICT',
    '5d semantic evidence rejected once deterministic FAILed',
  );
}

console.log('-- 6) deterministic BLOCKED record --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  const done = await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'BLOCKED',
    checks: [{ checkIndex: 0, kind: 'command', status: 'BLOCKED', detail: 'spawn error' }],
  });
  check(done.finalQaStatus === 'BLOCKED', '6a finalQaStatus BLOCKED');
  check(done.failedCriteria.length === 0, '6b BLOCKED carries no failedCriteria (uncertain, not failed)');
  await throwsWithCode(
    () => qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', criteria: [] }),
    'CONFLICT',
    '6c semantic evidence rejected once deterministic BLOCKED (non-override invariant)',
  );
}

console.log('-- 7) semantic FAIL record --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', checks: [] });
  const done = await qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'FAIL',
    criteria: [{ id: 'AC-03', status: 'FAIL', note: 'behavior not implemented' }],
    failedCriteria: ['AC-03'],
    remediationInstruction: 'Implement only the missing AC-03 behavior.',
  });
  check(done.finalQaStatus === 'FAIL', '7a finalQaStatus FAIL even though deterministic PASSed');
  check(done.remediationInstruction === 'Implement only the missing AC-03 behavior.', '7b remediationInstruction recorded');
}

console.log('-- 8) semantic BLOCKED record --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', checks: [] });
  const done = await qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'BLOCKED', criteria: [] });
  check(done.finalQaStatus === 'BLOCKED', '8a finalQaStatus BLOCKED (QA Agent error/unparseable)');
}

console.log('-- 9) PASS + failedCriteria rejected --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', checks: [] });
  await throwsWithCode(
    () => qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', criteria: [], failedCriteria: ['AC-09'] }),
    'INVALID_ARGUMENT',
    '9a PASS with non-empty failedCriteria rejected',
  );
}

console.log('-- 10) BOTH PASS without deterministic evidence rejected --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, {
    taskId, runId: 'run-1', qaAttemptNumber: 1,
    criteriaValidationModes: { 'AC-10': 'BOTH' },
  });
  // deterministic PASS but never attributes AC-10 to any check.
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'unrelated check' }],
  });
  await throwsWithCode(
    () => qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', criteria: [{ id: 'AC-10', status: 'PASS', note: 'ok' }] }),
    'INVALID_STATE',
    '10a BOTH PASS rejected when deterministic never covered the id',
  );
}

console.log('-- 11) BOTH PASS without semantic evidence rejected --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, {
    taskId, runId: 'run-1', qaAttemptNumber: 1,
    criteriaValidationModes: { 'AC-11': 'BOTH' },
  });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'PASS',
    checks: [{ checkIndex: 0, kind: 'fileExists', status: 'PASS', detail: 'ok', criterionId: 'AC-11' }],
  });
  await throwsWithCode(
    // semantic PASS recorded, but its criteria list omits AC-11 entirely.
    () => qa.recordSemanticEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', criteria: [{ id: 'AC-99', status: 'PASS', note: 'unrelated' }] }),
    'INVALID_STATE',
    '11a BOTH PASS rejected when semantic evidence never covered the id',
  );
}

console.log('-- 12) completed record resurrection rejected --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
    status: 'FAIL', checks: [], failedCriteria: ['AC-01'],
  });
  await throwsWithCode(
    () => qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, { status: 'PASS', checks: [] }),
    'CONFLICT',
    '12a re-recording deterministic evidence on a completed record rejected',
  );
  await throwsWithCode(
    () => qa.completeQaAttempt(ROOT, project, rec.qaAttemptId, { finalQaStatus: 'PASS' }),
    'CONFLICT',
    '12b completeQaAttempt on a completed record rejected',
  );
}

console.log('-- 13) malformed persisted QA record rejected (correction 01: NOT_FOUND vs CORRUPT_RECORD) --');
{
  // 13a: genuinely absent → NOT_FOUND.
  const absentId = qa.qaAttemptIdFor(nextTaskId(), 'run-1');
  await throwsWithCode(
    () => Promise.resolve(qa.getQaAttempt(ROOT, project, absentId)),
    'NOT_FOUND',
    '13a absent qa.json → NOT_FOUND',
  );

  // 13b: malformed JSON → explicit corruption failure, never NOT_FOUND.
  {
    const taskId = nextTaskId();
    const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
    const folder = qa.qaAttemptFolder(ROOT, project, rec.qaAttemptId);
    fs.writeFileSync(path.join(folder, 'qa.json'), '{ not valid json', 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qa.getQaAttempt(ROOT, project, rec.qaAttemptId)),
      'CORRUPT_RECORD',
      '13b malformed JSON is a distinct corruption failure, never collapsed into NOT_FOUND',
    );
    // 13b-ii: idempotent create must never recreate/repair over the corruption.
    await throwsWithCode(
      () => qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 }),
      'CORRUPT_RECORD',
      '13b-ii createQaAttempt refuses to recreate over a corrupt record',
    );
    const stillCorrupt = fs.readFileSync(path.join(folder, 'qa.json'), 'utf8');
    check(stillCorrupt === '{ not valid json', '13b-iii corrupt qa.json left byte-for-byte untouched (no silent repair)');
  }

  // 13c: schema-invalid JSON (valid JSON, invalid QaAttemptRecord shape) → corruption.
  {
    const taskId = nextTaskId();
    const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
    const folder = qa.qaAttemptFolder(ROOT, project, rec.qaAttemptId);
    const onDisk = JSON.parse(fs.readFileSync(path.join(folder, 'qa.json'), 'utf8'));
    onDisk.finalQaStatus = 'NOT_A_REAL_STATUS';
    fs.writeFileSync(path.join(folder, 'qa.json'), JSON.stringify(onDisk), 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qa.getQaAttempt(ROOT, project, rec.qaAttemptId)),
      'CORRUPT_RECORD',
      '13c schema-invalid finalQaStatus → CORRUPT_RECORD',
    );
  }

  // 13d: identity-mismatched JSON (taskId inside the record doesn't match
  // the qaAttemptId it's stored under) → corruption.
  {
    const taskId = nextTaskId();
    const otherTaskId = nextTaskId();
    const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
    const folder = qa.qaAttemptFolder(ROOT, project, rec.qaAttemptId);
    const onDisk = JSON.parse(fs.readFileSync(path.join(folder, 'qa.json'), 'utf8'));
    onDisk.taskId = otherTaskId; // qaAttemptId string itself left unchanged
    fs.writeFileSync(path.join(folder, 'qa.json'), JSON.stringify(onDisk), 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qa.getQaAttempt(ROOT, project, rec.qaAttemptId)),
      'CORRUPT_RECORD',
      '13d identity-mismatched taskId/qaAttemptId → CORRUPT_RECORD',
    );
  }
}

console.log('-- 14) duplicate identical create idempotent --');
{
  const taskId = nextTaskId();
  const a = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1, qaWorkerId: 'claude-code' });
  const b = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1, qaWorkerId: 'claude-code' });
  check(a.qaAttemptId === b.qaAttemptId && a.createdAt === b.createdAt, '14a identical create replays same record');
}

console.log('-- 15) conflicting duplicate create rejected --');
{
  const taskId = nextTaskId();
  await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  await throwsWithCode(
    () => qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 2 }),
    'CONFLICT',
    '15a conflicting qaAttemptNumber for the same (taskId, runId) rejected',
  );
}

console.log('-- 16) concurrent mutation serialized --');
{
  const taskId = nextTaskId();
  const [a, b] = await Promise.all([
    qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 }),
    qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 }),
  ]);
  check(a.qaAttemptId === b.qaAttemptId, '16a concurrent identical creates collapse to one record');
  const results = await Promise.allSettled([
    qa.recordDeterministicEvidence(ROOT, project, a.qaAttemptId, { status: 'PASS', checks: [] }),
    qa.recordDeterministicEvidence(ROOT, project, a.qaAttemptId, { status: 'PASS', checks: [] }),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  check(fulfilled.length === 1 && rejected.length === 1, '16b concurrent deterministic-evidence race: exactly one winner, one CONFLICT');
}

console.log('-- 17) atomic persistence round-trip --');
{
  const taskId = nextTaskId();
  const rec = await qa.createQaAttempt(ROOT, project, { taskId, runId: 'run-1', qaAttemptNumber: 1 });
  const folder = qa.qaAttemptFolder(ROOT, project, rec.qaAttemptId);
  const onDisk = JSON.parse(fs.readFileSync(path.join(folder, 'qa.json'), 'utf8'));
  check(JSON.stringify(onDisk) === JSON.stringify(rec), '17a on-disk JSON matches returned record exactly');
  check(fs.existsSync(path.join(folder, 'qa.md')), '17b human-readable markdown mirror written');
}

console.log('\n== QA REMEDIATION PREPARATION ==');

function failingAttemptFixture(taskId, runId = 'run-1') {
  return qa.createQaAttempt(ROOT, project, { taskId, runId, qaAttemptNumber: 1 })
    .then((rec) => qa.recordDeterministicEvidence(ROOT, project, rec.qaAttemptId, {
      status: 'FAIL', checks: [], failedCriteria: ['AC-01'],
    }));
}

console.log('-- 18) valid QA remediation preparation --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId);
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attempt.qaAttemptId,
    taskId,
    sourceRunId: attempt.runId,
    qaRemediationNumber: 1,
    failedCriteria: attempt.failedCriteria,
    remediationInstructionRef: attempt.qaAttemptId,
    workerId: 'claude-code',
    workspaceRoot: path.join(ROOT, 'workspace'),
  });
  check(prep.status === 'READY', '18a preparation created READY');
  check(prep.preparationId === `QRP-${attempt.qaAttemptId}`, '18b deterministic preparationId');
}

console.log('-- 19/20) source QA attempt + Run identity persisted --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId, 'run-42');
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
    qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
    remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
    workspaceRoot: path.join(ROOT, 'workspace'),
  });
  const reread = qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId);
  check(reread.sourceQaAttemptId === attempt.qaAttemptId, '19a sourceQaAttemptId persisted and re-readable');
  check(reread.sourceRunId === 'run-42', '20a sourceRunId persisted and re-readable');
}

console.log('-- 21) qaRemediationNumber validated --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId);
  await throwsWithCode(
    () => qrp.createQaRemediationPreparation(ROOT, project, {
      sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
      qaRemediationNumber: 0, failedCriteria: attempt.failedCriteria,
      remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
      workspaceRoot: path.join(ROOT, 'workspace'),
    }),
    'INVALID_ARGUMENT',
    '21a qaRemediationNumber=0 rejected',
  );
}

console.log('-- 22/23) consume once, second consume idempotent/rejected --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId);
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
    qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
    remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
    workspaceRoot: path.join(ROOT, 'workspace'),
  });
  const consumed = await qrp.consumeQaRemediationPreparation(ROOT, project, prep.preparationId, 'remediation-run-1');
  check(consumed.dispatchedRunId === 'remediation-run-1' && consumed.status === 'READY', '22a first consume succeeds, status stays READY (terminal-success bookkeeping)');
  const replay = await qrp.consumeQaRemediationPreparation(ROOT, project, prep.preparationId, 'remediation-run-1');
  check(replay.consumedAt === consumed.consumedAt, '23a second consume with SAME runId is an idempotent no-op');
  await throwsWithCode(
    () => qrp.consumeQaRemediationPreparation(ROOT, project, prep.preparationId, 'different-run'),
    'CONFLICT',
    '23b second consume with a DIFFERENT runId rejected (never rebinds)',
  );
}

console.log('-- 24) conflicting preparation rejected --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId);
  await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
    qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
    remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
    workspaceRoot: path.join(ROOT, 'workspace'),
  });
  await throwsWithCode(
    () => qrp.createQaRemediationPreparation(ROOT, project, {
      sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
      qaRemediationNumber: 2, failedCriteria: attempt.failedCriteria,   // conflicting qaRemediationNumber
      remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
      workspaceRoot: path.join(ROOT, 'workspace'),
    }),
    'CONFLICT',
    '24a conflicting re-creation for the same sourceQaAttemptId rejected',
  );
}

console.log('-- 25) GPT G5 retry prep remains structurally distinct --');
{
  const taskId = nextTaskId();
  const attempt = await failingAttemptFixture(taskId);
  const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
    qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
    remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
    workspaceRoot: path.join(ROOT, 'workspace'),
  });
  check(prep.preparationId.startsWith('QRP-QA-'), '25a QA remediation preparation id namespace (QRP-QA-…) never collides with G5 (RTP-PMJ-…)');
  check(!fs.existsSync(retryPrep.retryPreparationsDir(ROOT, project)) || fs.readdirSync(retryPrep.retryPreparationsDir(ROOT, project)).length === 0, '25b creating a QA remediation preparation never touches the G5 retry-preparations directory');
  check(retryPrep.retryPreparationIdFor, '25c G5 retry-preparation module remains independently importable/untouched');
}

console.log('-- 27) malformed persisted QA remediation preparation rejected (correction 01) --');
{
  // 27a: genuinely absent → NOT_FOUND.
  const taskId0 = nextTaskId();
  const attempt0 = await failingAttemptFixture(taskId0);
  const absentPrepId = qrp.qaRemediationPreparationIdFor(attempt0.qaAttemptId);
  await throwsWithCode(
    () => Promise.resolve(qrp.getQaRemediationPreparation(ROOT, project, absentPrepId)),
    'NOT_FOUND',
    '27a absent preparation.json → NOT_FOUND',
  );

  // 27b: malformed JSON → explicit corruption failure, never NOT_FOUND, and
  // never silently recreated through idempotent create.
  {
    const taskId = nextTaskId();
    const attempt = await failingAttemptFixture(taskId);
    const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
      sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
      qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
      remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
      workspaceRoot: path.join(ROOT, 'workspace'),
    });
    const folder = qrp.qaRemediationPreparationFolder(ROOT, project, prep.preparationId);
    fs.writeFileSync(path.join(folder, 'preparation.json'), '{ not valid json', 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId)),
      'CORRUPT_RECORD',
      '27b malformed JSON is a distinct corruption failure, never collapsed into NOT_FOUND',
    );
    await throwsWithCode(
      () => qrp.createQaRemediationPreparation(ROOT, project, {
        sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
        qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
        remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
        workspaceRoot: path.join(ROOT, 'workspace'),
      }),
      'CORRUPT_RECORD',
      '27b-ii createQaRemediationPreparation refuses to recreate over a corrupt record',
    );
    const stillCorrupt = fs.readFileSync(path.join(folder, 'preparation.json'), 'utf8');
    check(stillCorrupt === '{ not valid json', '27b-iii corrupt preparation.json left byte-for-byte untouched (no silent repair)');
  }

  // 27c: schema-invalid JSON (valid JSON, invalid record shape) → corruption.
  {
    const taskId = nextTaskId();
    const attempt = await failingAttemptFixture(taskId);
    const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
      sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
      qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
      remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
      workspaceRoot: path.join(ROOT, 'workspace'),
    });
    const folder = qrp.qaRemediationPreparationFolder(ROOT, project, prep.preparationId);
    const onDisk = JSON.parse(fs.readFileSync(path.join(folder, 'preparation.json'), 'utf8'));
    onDisk.status = 'NOT_A_REAL_STATUS';
    fs.writeFileSync(path.join(folder, 'preparation.json'), JSON.stringify(onDisk), 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId)),
      'CORRUPT_RECORD',
      '27c schema-invalid status → CORRUPT_RECORD',
    );
  }

  // 27d: identity-mismatched JSON (sourceQaAttemptId inside the record
  // doesn't match the preparationId it's stored under) → corruption.
  {
    const taskId = nextTaskId();
    const otherTaskId = nextTaskId();
    const attempt = await failingAttemptFixture(taskId);
    const otherAttempt = await failingAttemptFixture(otherTaskId);
    const prep = await qrp.createQaRemediationPreparation(ROOT, project, {
      sourceQaAttemptId: attempt.qaAttemptId, taskId, sourceRunId: attempt.runId,
      qaRemediationNumber: 1, failedCriteria: attempt.failedCriteria,
      remediationInstructionRef: attempt.qaAttemptId, workerId: 'claude-code',
      workspaceRoot: path.join(ROOT, 'workspace'),
    });
    const folder = qrp.qaRemediationPreparationFolder(ROOT, project, prep.preparationId);
    const onDisk = JSON.parse(fs.readFileSync(path.join(folder, 'preparation.json'), 'utf8'));
    onDisk.sourceQaAttemptId = otherAttempt.qaAttemptId; // preparationId string itself left unchanged
    fs.writeFileSync(path.join(folder, 'preparation.json'), JSON.stringify(onDisk), 'utf8');
    await throwsWithCode(
      () => Promise.resolve(qrp.getQaRemediationPreparation(ROOT, project, prep.preparationId)),
      'CORRUPT_RECORD',
      '27d identity-mismatched sourceQaAttemptId/preparationId → CORRUPT_RECORD',
    );
  }
}

console.log('\n== BACKWARD COMPATIBILITY ==');

console.log('-- 26) Task/Run without QA records remains valid --');
{
  const untouchedTaskId = 'TASK-9999';
  const list = qa.listQaAttemptsForTask(ROOT, project, untouchedTaskId);
  check(Array.isArray(list) && list.length === 0, '26a listQaAttemptsForTask returns [] for a Task with no QA history, no error');
  check(!fs.existsSync(qa.qaAttemptFolder(ROOT, project, `QA-${untouchedTaskId}-none`)), '26b no QA folder materialized for a Task that never ran QA');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
