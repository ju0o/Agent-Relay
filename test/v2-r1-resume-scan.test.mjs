/**
 * V2 R1 — read-only resume scan.
 *
 * Covers:
 *   R1-01  empty project → no findings
 *   R1-02  DISPATCHED without result → ORPHANED_DISPATCH
 *   R1-03  DISPATCHED + launch exit 0 → also UNRECOVERED_COMPLETED_RUN
 *   R1-04  RESULT_RECEIVED+PENDING+qaContract → QA_GATE_STALLED
 *   R1-05  RESULT_RECEIVED+VERIFYING without delivery → MISSING_DELIVERY
 *   R1-06  retry prep stuck at RECEIVED → CRASHED_PREPARATION
 *   R1-07  READ-ONLY: task.json bytes identical before/after scan
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TEST_ROOT = path.join(os.tmpdir(), `arl-v2-r1-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const gt = await import('../dist/server/backend/goal-task.js');
const relay = await import('../dist/server/backend/fs.js');
const scan = await import('../dist/server/backend/resume-scan.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');

const project = 'V2R1Proj';
const date = '2026-09-12';
const agent = 'OpenCode';

const goal = await gt.createGoal(TEST_ROOT, project, {
  title: 'V2 R1 goal',
  goalStatement: 'resume scan test goal',
});

console.log('\n-- R1-01: empty project --');
{
  const r = scan.scanStuckWork(TEST_ROOT, project);
  check(r.scannedTasks === 0, 'no tasks');
  check(r.findings.length === 0, 'no findings');
}

const orphanTask = await gt.createTask(TEST_ROOT, project, {
  goalId: goal.goalId,
  title: 'orphaned dispatch',
  goal: 'outcome',
  reason: 'test',
  scope: 'narrow',
});
const folder1 = relay.ensureRunFolder(TEST_ROOT, project, date, agent, '01');
relay.writeMarkdown(folder1, 'prompt.md', '# p\n', false);
await gt.linkRunToTask(TEST_ROOT, project, orphanTask.taskId, folder1);
// Force DISPATCHED without going through live dispatcher (test bookkeeping).
{
  const taskPath = path.join(TEST_ROOT, project, '_relay', 'tasks', orphanTask.taskId, 'task.json');
  const t = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  t.executionState = 'DISPATCHED';
  t.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskPath, JSON.stringify(t, null, 2) + '\n');
}

console.log('\n-- R1-02: ORPHANED_DISPATCH --');
{
  const r = scan.scanStuckWork(TEST_ROOT, project);
  const f = r.findings.filter((x) => x.pattern === 'ORPHANED_DISPATCH');
  check(f.length === 1, 'one orphan finding');
  check(f[0].taskId === orphanTask.taskId, 'orphan taskId');
  check(f[0].blessedAction.includes('orphan-resolution'), 'blessed orphan action named');
}

console.log('\n-- R1-03: UNRECOVERED_COMPLETED_RUN via launch exit 0 --');
{
  const launch = path.join(folder1, 'worker-launch.log');
  fs.writeFileSync(launch, JSON.stringify({ exitCode: 0, at: new Date().toISOString() }) + '\n', 'utf8');
  const r = scan.scanStuckWork(TEST_ROOT, project);
  const f = r.findings.filter((x) => x.pattern === 'UNRECOVERED_COMPLETED_RUN');
  check(f.length === 1, 'one unrecovered finding');
  check(f[0].blessedAction.includes('recover_completed_run'), 'blessed recover action named');
}

const qaTask = await gt.createTask(TEST_ROOT, project, {
  goalId: goal.goalId,
  title: 'qa stalled',
  goal: 'outcome',
  reason: 'test',
  scope: 'fixture scope; authorized file: out.txt',
  acceptanceCriteria: [
    { id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' },
  ],
  qaContract: {
    deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }],
  },
});
const folderQa = relay.ensureRunFolder(TEST_ROOT, project, date, agent, '02');
relay.writeMarkdown(folderQa, 'prompt.md', '# p\n', false);
relay.writeMarkdown(folderQa, 'result.md', '# r\n', false);
await gt.linkRunToTask(TEST_ROOT, project, qaTask.taskId, folderQa);
{
  const taskPath = path.join(TEST_ROOT, project, '_relay', 'tasks', qaTask.taskId, 'task.json');
  const t = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  t.executionState = 'RESULT_RECEIVED';
  t.pmState = 'PENDING';
  t.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskPath, JSON.stringify(t, null, 2) + '\n');
}

console.log('\n-- R1-04: QA_GATE_STALLED --');
{
  const r = scan.scanStuckWork(TEST_ROOT, project);
  const f = r.findings.filter((x) => x.pattern === 'QA_GATE_STALLED' && x.taskId === qaTask.taskId);
  check(f.length === 1, 'qa gate stalled finding');
  check(f[0].blessedAction.includes('reconcileQaGate'), 'blessed qa action named');
}

const delTask = await gt.createTask(TEST_ROOT, project, {
  goalId: goal.goalId,
  title: 'missing delivery',
  goal: 'outcome',
  reason: 'test',
  scope: 'narrow',
});
const folderDel = relay.ensureRunFolder(TEST_ROOT, project, date, agent, '03');
relay.writeMarkdown(folderDel, 'result.md', '# r\n', false);
await gt.linkRunToTask(TEST_ROOT, project, delTask.taskId, folderDel);
{
  const taskPath = path.join(TEST_ROOT, project, '_relay', 'tasks', delTask.taskId, 'task.json');
  const t = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  t.executionState = 'RESULT_RECEIVED';
  t.pmState = 'VERIFYING';
  t.updatedAt = new Date().toISOString();
  fs.writeFileSync(taskPath, JSON.stringify(t, null, 2) + '\n');
}

console.log('\n-- R1-05: MISSING_DELIVERY --');
{
  const r = scan.scanStuckWork(TEST_ROOT, project);
  const f = r.findings.filter((x) => x.pattern === 'MISSING_DELIVERY' && x.taskId === delTask.taskId);
  check(f.length === 1, 'missing delivery finding');
  check(f[0].blessedAction.includes('ensurePmDelivery'), 'blessed delivery action named');
}

console.log('\n-- R1-06: CRASHED_PREPARATION (retry) --');
{
  // Minimal prep folder the lister will accept — use real API if available.
  const prepMod = await import('../dist/server/backend/retry-preparation.js');
  // Write a stuck RECEIVED prep by placing a valid-looking record if helpers exist;
  // otherwise skip gracefully when schema is too strict for hand-written JSON.
  // PREP_ID_RE = /^RTP-PMJ-PMD-TASK-\d+-[A-Za-z0-9._-]+$/
  const id = 'RTP-PMJ-PMD-TASK-0001-run99fixture';
  const prepsDir = path.join(TEST_ROOT, project, '_relay', 'retry-preparations');
  const folder = path.join(prepsDir, id);
  fs.mkdirSync(folder, { recursive: true });
  const prep = {
    schemaVersion: 1,
    preparationId: id,
    project,
    judgmentId: 'PMJ-PMD-TASK-0001-run99fixture',
    deliveryId: 'PMD-TASK-0001-run99fixture',
    taskId: orphanTask.taskId,
    sourceRunId: '00000000-0000-0000-0000-000000000099',
    nextAttemptSequence: 2,
    status: 'RECEIVED',
    reason: 'test stuck prep',
    retryInstructionRef: 'intent:test',
    retryCountBefore: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(folder, 'preparation.json'), JSON.stringify(prep, null, 2) + '\n');
  const listed = prepMod.listRetryPreparations(TEST_ROOT, project);
  check(listed.some((p) => p.preparationId === id), 'prep listed by kernel');
  const r = scan.scanStuckWork(TEST_ROOT, project);
  const f = r.findings.filter((x) => x.pattern === 'CRASHED_PREPARATION' && x.preparationId === id);
  check(f.length === 1, 'crashed prep finding present');
}

console.log('\n-- R1-07: READ-ONLY proof --');
{
  const taskPath = path.join(TEST_ROOT, project, '_relay', 'tasks', orphanTask.taskId, 'task.json');
  const before = fs.readFileSync(taskPath);
  scan.scanStuckWork(TEST_ROOT, project);
  const after = fs.readFileSync(taskPath);
  check(Buffer.compare(before, after) === 0, 'task.json bytes unchanged');
}

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
