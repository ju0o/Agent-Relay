/**
 * V2 slice-1 H1 — read-only Task timeline model.
 *
 * Covers:
 *   H1-01  empty Task (no linked runs) → empty attempts/events/evidence
 *   H1-02  one linked Run → attempt seq 1, prompt/result presence, tags,
 *           delivery/judgment null (none minted yet)
 *   H1-03  two linked Runs → attempts ordered by taskRunSequence
 *   H1-04  vanished Run folder → folderExists false, no throw
 *   H1-05  unknown taskId → throws
 *   H1-06  READ-ONLY proof: task.json + meta.json bytes identical
 *           before/after getTaskHistory
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v2-h1-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const gt = await import('../dist/server/backend/goal-task.js');
const relay = await import('../dist/server/backend/fs.js');
const hist = await import('../dist/server/backend/task-history.js');

const project = 'V2H1Proj';
const date = '2026-09-12';
const agent = 'OpenCode';

const goal = await gt.createGoal(TEST_ROOT, project, {
  title: 'V2 H1 goal',
  goalStatement: 'history test goal',
});
const task = await gt.createTask(TEST_ROOT, project, {
  goalId: goal.goalId,
  title: 'V2 H1 task',
  goal: 'intended outcome',
  reason: 'test reason',
  scope: 'narrow scope',
});

// H1-01: empty task
console.log('\n-- H1-01: empty task --');
{
  const h = hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  check(h.task.taskId === task.taskId, 'task record returned');
  check(Array.isArray(h.attempts) && h.attempts.length === 0, 'no attempts');
  check(Array.isArray(h.events) && h.events.length === 0, 'no events');
  check(Array.isArray(h.evidence) && h.evidence.length === 0, 'no evidence');
}

// link run 1 (with prompt+result+tags)
const folder1 = relay.ensureRunFolder(TEST_ROOT, project, date, agent, '01');
relay.writeMarkdown(folder1, 'prompt.md', '# p1\n', false);
relay.writeMarkdown(folder1, 'result.md', '# r1\n', false);
await gt.linkRunToTask(TEST_ROOT, project, task.taskId, folder1);
{
  const meta = relay.readRunMeta(folder1);
  relay.writeRunMeta(folder1, { ...meta, tags: ['성공'] });
}

// H1-02: one attempt
console.log('\n-- H1-02: one linked run --');
{
  const h = hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  check(h.attempts.length === 1, 'one attempt');
  const a = h.attempts[0];
  check(a.taskRunSequence === 1, 'sequence 1');
  check(a.folderExists && a.hasPrompt && a.hasResult, 'files present');
  check(a.tags.includes('성공'), 'tags joined');
  check(a.delivery === null && a.judgment === null, 'no delivery/judgment yet → null');
}

// link run 2 (result only)
const folder2 = relay.ensureRunFolder(TEST_ROOT, project, date, agent, '02');
relay.writeMarkdown(folder2, 'result.md', '# r2\n', false);
await gt.linkRunToTask(TEST_ROOT, project, task.taskId, folder2);

// H1-03: ordering
console.log('\n-- H1-03: two runs ordered --');
{
  const h = hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  check(h.attempts.length === 2, 'two attempts');
  check(h.attempts[0].taskRunSequence === 1 && h.attempts[1].taskRunSequence === 2, 'sequence ascending');
  check(h.attempts[1].hasResult && !h.attempts[1].hasPrompt, 'partial files reflected');
}

// H1-06: read-only proof (bytes before/after)
console.log('\n-- H1-06: read-only proof --');
{
  const taskFile = path.join(TEST_ROOT, project, '_relay', 'tasks', task.taskId, 'task.json');
  const metaFile = path.join(folder1, 'meta.json');
  const beforeTask = fs.readFileSync(taskFile);
  const beforeMeta = fs.readFileSync(metaFile);
  hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  check(fs.readFileSync(taskFile).equals(beforeTask), 'task.json bytes unchanged');
  check(fs.readFileSync(metaFile).equals(beforeMeta), 'meta.json bytes unchanged');
}

// H1-04: vanished folder
console.log('\n-- H1-04: vanished run folder --');
{
  fs.rmSync(folder2, { recursive: true, force: true });
  const h = hist.getTaskHistory(TEST_ROOT, project, task.taskId);
  const a = h.attempts.find((x) => x.taskRunSequence === 2);
  check(!!a && !a.folderExists && !a.hasPrompt && !a.hasResult, 'missing folder degrades gracefully');
}

// H1-05: unknown task
console.log('\n-- H1-05: unknown task throws --');
{
  let threw = false;
  try { hist.getTaskHistory(TEST_ROOT, project, 'TASK-9999'); }
  catch { threw = true; }
  check(threw, 'unknown taskId throws');
}

console.log(`\n결과: ${passed} passed, ${failed} failed`);
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
