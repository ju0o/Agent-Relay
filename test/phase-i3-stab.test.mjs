/**
 * Phase I3 — Pre-CLI Stabilization: atomic read/write hardening (STAB-01..STAB-05).
 *
 * Tests the bounded parse-race retry in readJsonFile (goal-task.ts) and the
 * atomic writeRunMeta in fs.ts.
 *
 * These tests run against the built dist/ output; run `npm run build:server`
 * before running this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-i3-stab-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (fragment && !msg.includes(fragment)) {
      FAIL(`${label} — expected "${fragment}" in error, got: ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const gt = await import('../dist/server/backend/goal-task.js');
const fsMod = await import('../dist/server/backend/fs.js');

const dataRoot = path.join(TEST_ROOT, 'data');
const project = 'StabProj';

// ── Setup: one Goal + one Task ──────────────────────────────────────────────

const goal = await gt.createGoal(dataRoot, project, {
  title: 'Stab test goal',
  goalStatement: 'Test atomic read/write stability',
  completionCriteria: ['criteria 1'],
});

const task = await gt.createTask(dataRoot, project, {
  goalId: goal.goalId,
  title: 'Stab test task',
  goal: 'Test stability',
  reason: 'parse-race regression',
  scope: 'unit',
});

// ── STAB-01: readJsonFile succeeds normally (no race) ────────────────────────
console.log('\n── STAB-01: normal read succeeds ───────────────────────────────────');
{
  const t = gt.getTask(dataRoot, project, task.taskId);
  check(t.taskId === task.taskId, `STAB-01 getTask returns correct taskId`);
  check(t.goalId === goal.goalId, `STAB-01 getTask returns correct goalId`);
  check(t.executionState === 'PLANNED', `STAB-01 task starts in PLANNED state`);
}

// ── STAB-02: readJsonFile parse retry — simulate empty file race ─────────────
console.log('\n── STAB-02: parse-race retry — corrupt then valid JSON ─────────────');
{
  // Write a valid task to disk, then deliberately corrupt task.json to simulate
  // a brief mid-rename window, then immediately overwrite with valid JSON.
  // We cannot race a real concurrent write in a sync test, but we can verify
  // that after a corrupt + overwrite sequence the correct value is returned.

  const taskFolder = path.join(
    dataRoot, project.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim(), '_relay', 'tasks', task.taskId
  );
  const taskFile = path.join(taskFolder, 'task.json');

  // Corrupt: write empty string (what renameSync mid-write looks like)
  fs.writeFileSync(taskFile, '', 'utf8');
  // Wait 10ms then write valid JSON (simulates the rename completing)
  await new Promise((r) => setTimeout(r, 10));
  gt.persistTaskRecord(dataRoot, project, task);

  // Now getTask should succeed (may use the retry path if the empty write was
  // read on the first attempt)
  try {
    const t = gt.getTask(dataRoot, project, task.taskId);
    check(t.taskId === task.taskId, `STAB-02 getTask returns correct task after corrupt+repair`);
  } catch (err) {
    // This is acceptable if the retry itself still found valid JSON
    FAIL(`STAB-02 getTask failed after corrupt+repair: ${err.message}`);
  }
}

// ── STAB-03: writeRunMeta is atomic (meta.json is valid after write) ──────────
console.log('\n── STAB-03: writeRunMeta atomic — meta.json always valid ───────────');
{
  const runFolder = path.join(TEST_ROOT, 'run-stab-03');
  fs.mkdirSync(runFolder, { recursive: true });

  fsMod.writeRunMeta(runFolder, { tags: ['a', 'b'], runId: 'run-stab-03' });

  const metaFile = path.join(runFolder, 'meta.json');
  check(fs.existsSync(metaFile), `STAB-03 meta.json exists after writeRunMeta`);

  const content = fs.readFileSync(metaFile, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    FAIL(`STAB-03 meta.json is not valid JSON`);
    parsed = null;
  }
  if (parsed !== null) {
    check(parsed.runId === 'run-stab-03', `STAB-03 meta.json.runId correct`);
    check(Array.isArray(parsed.tags) && parsed.tags.includes('a'), `STAB-03 meta.json.tags correct`);
  }

  // Verify no .tmp files are left over after write
  const entries = fs.readdirSync(runFolder);
  const tmpFiles = entries.filter((e) => e.endsWith('.tmp'));
  check(tmpFiles.length === 0, `STAB-03 no stray .tmp files after writeRunMeta`);
}

// ── STAB-04: NOT_FOUND error is preserved (no retry on ENOENT) ──────────────
console.log('\n── STAB-04: NOT_FOUND preserved on ENOENT ──────────────────────────');
{
  await shouldThrow(
    async () => gt.getTask(dataRoot, project, 'TASK-9999'),
    `STAB-04 getTask(missing) throws NOT_FOUND`,
    '파일을 찾을 수 없습니다',
  );

  await shouldThrow(
    async () => gt.getGoal(dataRoot, project, 'GOAL-9999'),
    `STAB-04 getGoal(missing) throws NOT_FOUND`,
    '파일을 찾을 수 없습니다',
  );
}

// ── STAB-05: persistent corrupt JSON surfaces as parse error ─────────────────
console.log('\n── STAB-05: persistent corrupt JSON → parse error (not NOT_FOUND) ─');
{
  // Create a scratch goal folder with a permanently corrupt goal.json
  const corruptGoalId = 'GOAL-8888';
  const corruptFolder = path.join(
    dataRoot, project.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').trim(), '_relay', 'goals', corruptGoalId
  );
  fs.mkdirSync(corruptFolder, { recursive: true });
  const corruptFile = path.join(corruptFolder, 'goal.json');
  fs.writeFileSync(corruptFile, '{ "broken": true, "nope":', 'utf8');

  await shouldThrow(
    async () => gt.getGoal(dataRoot, project, corruptGoalId),
    `STAB-05 getGoal(corrupt) throws parse error`,
    '잘못된 JSON 형식입니다',
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nSTAB: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
