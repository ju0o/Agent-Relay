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

// ── STAB-06: concurrent writeRunMeta + readRunMeta polling → only full records ──
console.log('\n── STAB-06: atomic writeRunMeta — concurrent polling sees only full old/new ──');
{
  const runFolder = path.join(TEST_ROOT, 'run-stab-06');
  fs.mkdirSync(runFolder, { recursive: true });
  // Seed initial
  fsMod.writeRunMeta(runFolder, { tags: ['init'], runId: 'run-id-0' });

  const snapshots = [];
  let pollErrors = 0;
  let inconsistent = 0;

  // Interleaved writer + polling: each write yields to let poller run
  for (let i = 1; i <= 80; i++) {
    fsMod.writeRunMeta(runFolder, { tags: [`v-${i}`], runId: `run-id-${i}` });
    // Immediate poll after each write — should see either old or new, never truncated
    try {
      const raw = fs.readFileSync(path.join(runFolder, 'meta.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.runId !== 'string' || !Array.isArray(parsed.tags)) {
        pollErrors++;
        FAIL(`STAB-06 polling saw malformed parsed object at i=${i}: ${JSON.stringify(parsed)}`);
      } else {
        const m = /^run-id-(\d+)$/.exec(parsed.runId);
        if (!m) { inconsistent++; }
        else {
          const n = parseInt(m[1], 10);
          const expectedTag = n === 0 ? 'init' : `v-${n}`;
          if (!parsed.tags.includes(expectedTag) || parsed.tags.length !== 1) inconsistent++;
        }
        snapshots.push(parsed);
      }
      // Also verify readRunMeta returns same consistent view
      const meta = fsMod.readRunMeta(runFolder);
      if (meta.runId !== parsed.runId || JSON.stringify(meta.tags) !== JSON.stringify(parsed.tags)) {
        // readRunMeta sanitizes but should match raw for our controlled values
        if (meta.runId !== parsed.runId) {
          pollErrors++;
          FAIL(`STAB-06 readRunMeta mismatch raw runId at i=${i}: meta=${meta.runId} raw=${parsed.runId}`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Unexpected') || msg.includes('JSON') || msg.includes('parse')) {
        pollErrors++;
        FAIL(`STAB-06 polling saw JSON parse error (truncated) at i=${i}: ${msg}`);
      }
    }
    // Yield to event loop to allow any async fs flushing (and simulate concurrent reader)
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 1));
  }

  check(pollErrors === 0, `STAB-06 no poll parse errors (truncated JSON) — got ${pollErrors}`);
  check(inconsistent === 0, `STAB-06 all ${snapshots.length} snapshots are full old/new records — inconsistent=${inconsistent}`);
  check(snapshots.length >= 80, `STAB-06 collected ${snapshots.length} snapshots during writes`);

  // No stray tmps
  const entries = fs.readdirSync(runFolder);
  check(entries.filter((e) => e.endsWith('.tmp')).length === 0, `STAB-06 no stray .tmp after concurrent writes`);
}

// ── STAB-07: writeRunMeta rename failure — preserves old file, reports error, cleans tmp ──
console.log('\n── STAB-07: writeRunMeta rename failure preserves old file ────────────');
{
  const runFolder = path.join(TEST_ROOT, 'run-stab-07');
  fs.mkdirSync(runFolder, { recursive: true });
  const filePath = path.join(runFolder, 'meta.json');
  // Seed known good content
  fsMod.writeRunMeta(runFolder, { tags: ['original'], runId: 'run-orig-07' });
  const originalContent = fs.readFileSync(filePath, 'utf8');
  const originalParsed = JSON.parse(originalContent);
  check(originalParsed.runId === 'run-orig-07', `STAB-07 seed written`);

  // Inject rename failure via CJS fs patch (ESM namespace is read-only)
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const fsCjs = require('node:fs');
  const realRenameSync = fsCjs.renameSync;
  let renameCalled = false;
  fsCjs.renameSync = function patchedRename() { renameCalled = true; throw Object.assign(new Error('injected rename failure'), { code: 'EPERM' }); };
  let threw = false;
  try {
    fsMod.writeRunMeta(runFolder, { tags: ['new-value'], runId: 'run-new-07' });
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    check(msg.includes('injected rename failure') || msg.includes('EPERM'), `STAB-07 writeRunMeta throws injected error`);
  } finally {
    fsCjs.renameSync = realRenameSync;
  }
  check(renameCalled, `STAB-07 injected rename was called`);
  check(threw, `STAB-07 writeRunMeta reported failure on rename error`);

  // Original destination must remain intact — valid JSON, old content
  const afterContent = fs.readFileSync(filePath, 'utf8');
  check(afterContent === originalContent, `STAB-07 original destination preserved exactly`);
  let afterParsed;
  try { afterParsed = JSON.parse(afterContent); } catch { afterParsed = null; }
  check(afterParsed !== null && afterParsed.runId === 'run-orig-07', `STAB-07 destination still valid original JSON`);
  check(afterParsed !== null && afterParsed.tags[0] === 'original', `STAB-07 destination tags still original`);

  // No partial destination, no stray tmp (best-effort cleanup)
  const entries = fs.readdirSync(runFolder);
  const tmps = entries.filter((e) => e.endsWith('.tmp'));
  check(tmps.length === 0, `STAB-07 tmp cleaned up after failure (found ${tmps.length})`);
  // Ensure destination is not truncated / empty
  check(afterContent.length > 10 && afterContent.includes('run-orig-07'), `STAB-07 destination not truncated`);
}

// ── STAB-08: writeJsonAtomic rename failure — same guarantees ─────────────────
console.log('\n── STAB-08: writeJsonAtomic rename failure preserves old file ────────');
{
  const folder = path.join(TEST_ROOT, 'run-stab-08');
  fs.mkdirSync(folder, { recursive: true });
  const filePath = path.join(folder, 'data.json');
  gt.writeJsonAtomic(filePath, { v: 'original', n: 1 });
  const originalContent = fs.readFileSync(filePath, 'utf8');
  const { createRequire } = await import('node:module');
  const require2 = createRequire(import.meta.url);
  const fsCjs2 = require2('node:fs');
  const realRenameSync = fsCjs2.renameSync;
  let renameCalled = false;
  fsCjs2.renameSync = function patchedRename2() { renameCalled = true; throw Object.assign(new Error('injected rename failure 2'), { code: 'EACCES' }); };
  let threw = false;
  try {
    gt.writeJsonAtomic(filePath, { v: 'new', n: 2 });
  } catch (e) { threw = true; }
  finally { fsCjs2.renameSync = realRenameSync; }
  check(renameCalled, `STAB-08 injected rename was called`);
  check(threw, `STAB-08 writeJsonAtomic reported failure`);
  const afterContent = fs.readFileSync(filePath, 'utf8');
  check(afterContent === originalContent, `STAB-08 original file preserved exactly`);
  let parsed; try { parsed = JSON.parse(afterContent); } catch { parsed = null; }
  check(parsed !== null && parsed.v === 'original', `STAB-08 destination still valid original JSON`);
  const entries = fs.readdirSync(folder);
  check(entries.filter((e) => e.endsWith('.tmp')).length === 0, `STAB-08 tmp cleaned up`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nSTAB: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
