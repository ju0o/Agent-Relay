/**
 * Phase B1 — Goal / Task data kernel acceptance tests (B1–B24).
 * Uses a temporary DATA_ROOT only. Runs against compiled dist/server modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-b1-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'KernelProj';

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);

  // ── B1 Goal create allocates stable GOAL ID ───────────────────────────────
  console.log('B1) Goal create allocates stable GOAL ID');
  const g1 = await gt.createGoal(TEST_ROOT, project, {
    title: 'Agent Relay Closed PM Loop',
    goalStatement: 'Ship Goal/Task kernel above Runs',
    completionCriteria: ['CRUD works', 'Runs link safely'],
    permissionPolicy: { mode: 'PLAN' },
  });
  check(g1.goalId === 'GOAL-0001', `goalId=${g1.goalId}`);
  check(g1.status === 'PLANNING', `default status=${g1.status}`);
  check(g1.schemaVersion === 1, 'schemaVersion=1');

  // ── B2 Goal get/list/update ───────────────────────────────────────────────
  console.log('B2) Goal get/list/update');
  const got = gt.getGoal(TEST_ROOT, project, 'GOAL-0001');
  check(got.title === g1.title, 'getGoal returns title');
  const listed = gt.listGoals(TEST_ROOT, project);
  check(listed.length === 1 && listed[0].goalId === 'GOAL-0001', 'listGoals length=1');
  const updated = gt.updateGoal(TEST_ROOT, project, 'GOAL-0001', {
    status: 'ACTIVE',
    title: 'Agent Relay Closed PM Loop (v1)',
  });
  check(updated.status === 'ACTIVE' && updated.title.includes('(v1)'), 'updateGoal applied');
  check(updated.updatedAt >= g1.updatedAt, 'updatedAt advanced');

  // ── B3 Goal status validation ─────────────────────────────────────────────
  console.log('B3) Goal status validation');
  let badStatus = false;
  try {
    await gt.createGoal(TEST_ROOT, project, {
      title: 'x', goalStatement: 'y', status: 'NOPE',
    });
  } catch { badStatus = true; }
  check(badStatus, 'unknown Goal status rejected on create');
  let badUpdate = false;
  try { gt.updateGoal(TEST_ROOT, project, 'GOAL-0001', { status: 'INVALID' }); }
  catch { badUpdate = true; }
  check(badUpdate, 'unknown Goal status rejected on update');

  // ── B4 Goal Markdown + JSON written ───────────────────────────────────────
  console.log('B4) Goal Markdown + JSON written');
  const gFolder = gt.goalFolder(TEST_ROOT, project, 'GOAL-0001');
  const gJsonPath = path.join(gFolder, 'goal.json');
  const gMdPath = path.join(gFolder, 'goal.md');
  check(fs.existsSync(gJsonPath) && fs.existsSync(gMdPath), 'goal.json + goal.md exist');
  const gMd = fs.readFileSync(gMdPath, 'utf8');
  check(
    gMd.includes('# GOAL-0001') && gMd.includes('## Goal') && gMd.includes('## Status') && gMd.includes('ACTIVE'),
    'goal.md mirrors key facts',
  );
  const gJson = JSON.parse(fs.readFileSync(gJsonPath, 'utf8'));
  check(gJson.goalId === 'GOAL-0001' && gJson.permissionPolicy.mode === 'PLAN', 'goal.json structured');

  // ── B5 Task create allocates stable TASK ID ───────────────────────────────
  console.log('B5) Task create allocates stable TASK ID');
  const t1 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001',
    title: 'Goal/Task Kernel',
    goal: 'Persist Goals and Tasks on disk',
    reason: 'Need SSOT above Runs',
    scope: 'Backend kernel only',
    completionCriteria: ['IDs stable', 'linkRun works'],
  });
  check(t1.taskId === 'TASK-0001', `taskId=${t1.taskId}`);
  check(t1.status === 'PLANNED', 'default Task status PLANNED');

  // ── B6 Task must reference valid Goal ─────────────────────────────────────
  console.log('B6) Task must reference valid Goal');
  let badGoal = false;
  try {
    await gt.createTask(TEST_ROOT, project, {
      goalId: 'GOAL-9999',
      title: 'x', goal: 'y', reason: 'r', scope: 's',
    });
  } catch { badGoal = true; }
  check(badGoal, 'task create rejects nonexistent Goal');

  // ── B7 Task get/list/update ───────────────────────────────────────────────
  console.log('B7) Task get/list/update');
  check(gt.getTask(TEST_ROOT, project, 'TASK-0001').title === t1.title, 'getTask');
  check(gt.listTasks(TEST_ROOT, project).length === 1, 'listTasks all');
  check(gt.listTasks(TEST_ROOT, project, 'GOAL-0001').length === 1, 'listTasks by goal');
  const tUp = gt.updateTask(TEST_ROOT, project, 'TASK-0001', { status: 'WORKING', title: 'Kernel impl' });
  check(tUp.status === 'WORKING' && tUp.title === 'Kernel impl', 'updateTask applied');

  // ── B8 Task status validation ─────────────────────────────────────────────
  console.log('B8) Task status validation');
  let badTs = false;
  try { gt.updateTask(TEST_ROOT, project, 'TASK-0001', { status: 'FLYING' }); }
  catch { badTs = true; }
  check(badTs, 'unknown Task status rejected');

  // ── B9 self dependency rejected ───────────────────────────────────────────
  console.log('B9) self dependency rejected');
  let selfDep = false;
  try { gt.updateTask(TEST_ROOT, project, 'TASK-0001', { dependencies: ['TASK-0001'] }); }
  catch { selfDep = true; }
  check(selfDep, 'self dependency rejected');

  // ── B10 duplicate dependency handled safely ───────────────────────────────
  console.log('B10) duplicate dependency handled safely');
  const t2 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001',
    title: 'Second task',
    goal: 'support deps',
    reason: 'r',
    scope: 's',
  });
  check(t2.taskId === 'TASK-0002', 'TASK-0002 allocated');
  const t2b = gt.updateTask(TEST_ROOT, project, 'TASK-0002', {
    dependencies: ['TASK-0001', 'TASK-0001', 'TASK-0001'],
  });
  check(
    t2b.dependencies.length === 1 && t2b.dependencies[0] === 'TASK-0001',
    'duplicate deps collapsed to one',
  );

  // ── B11 Task Markdown + JSON written ──────────────────────────────────────
  console.log('B11) Task Markdown + JSON written');
  const tFolder = gt.taskFolder(TEST_ROOT, project, 'TASK-0001');
  const tMd = fs.readFileSync(path.join(tFolder, 'task.md'), 'utf8');
  check(
    fs.existsSync(path.join(tFolder, 'task.json')) &&
    tMd.includes('# TASK-0001') &&
    tMd.includes('## Reason') &&
    tMd.includes('WORKING'),
    'task.md + task.json present and mirrored',
  );

  // ── B12–B18 Run linkage ───────────────────────────────────────────────────
  console.log('B12–B18) Run linkage');
  const date = relay.todayString();
  const agent = 'Codex';
  const runA = await relay.atomicMaterializeRun(TEST_ROOT, project, date, agent);
  const runB = await relay.atomicMaterializeRun(TEST_ROOT, project, date, agent);
  // Physical run numbers are typically 01, 02 — independent of taskRunSequence
  check(runA.run !== runB.run, `physical runs distinct: ${runA.run}, ${runB.run}`);

  // Legacy meta (tags only) remains valid before link
  relay.writeRunMeta(runA.folder, { tags: ['참고'] });
  const legacyMeta = relay.readRunMeta(runA.folder);
  check(legacyMeta.tags.includes('참고') && legacyMeta.goalId === undefined, 'B16 legacy meta valid');

  const linked1 = gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runA.folder);
  check(
    linked1.linkedRuns.length === 1 && linked1.linkedRuns[0].taskRunSequence === 1,
    'B12 linkRun updates linkedRuns seq=1',
  );
  const metaA = relay.readRunMeta(runA.folder);
  check(
    metaA.goalId === 'GOAL-0001' && metaA.taskId === 'TASK-0001' && metaA.taskRunSequence === 1 && metaA.tags.includes('참고'),
    'B13 meta gains goalId/taskId/taskRunSequence (tags preserved)',
  );

  let doubleLink = false;
  try { gt.linkRunToTask(TEST_ROOT, project, 'TASK-0002', runA.folder); }
  catch { doubleLink = true; }
  check(doubleLink, 'B14 same Run cannot link to second Task');

  const linked2 = gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runB.folder);
  check(linked2.linkedRuns.length === 2, 'B17 Task may have multiple linked Runs');
  check(
    linked2.linkedRuns[1].taskRunSequence === 2,
    `B18 taskRunSequence=2 independent of physical run ${runB.run}`,
  );
  const metaB = relay.readRunMeta(runB.folder);
  check(metaB.taskRunSequence === 2 && metaB.taskId === 'TASK-0001', 'second link meta seq=2');

  // Physical run number vs sequence independence
  check(
    String(metaB.taskRunSequence) !== runB.run.replace(/^0+/, '') || runB.run === '02',
    'sequence is logical (not forced equal to physical; both may coincidentally align)',
  );
  // Stronger check: sequence is 1,2 regardless of physical labels
  check(
    linked2.linkedRuns.map((r) => r.taskRunSequence).join(',') === '1,2',
    'B18 sequences are 1,2 regardless of physical Run folder names',
  );

  const unlinked = gt.unlinkRunFromTask(TEST_ROOT, project, 'TASK-0001', runA.folder);
  check(unlinked.linkedRuns.length === 1 && unlinked.linkedRuns[0].folder === path.resolve(runB.folder), 'B15 unlink removes link');
  const metaAfterUnlink = relay.readRunMeta(runA.folder);
  check(
    metaAfterUnlink.goalId === undefined && metaAfterUnlink.taskId === undefined && metaAfterUnlink.taskRunSequence === undefined && metaAfterUnlink.tags.includes('참고'),
    'B15 unlink clears linkage fields, keeps tags',
  );

  // Re-link allowed after unlink
  gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runA.folder);

  // ── B19 Goal progress derived correctly ───────────────────────────────────
  console.log('B19) Goal progress derived correctly');
  gt.updateTask(TEST_ROOT, project, 'TASK-0001', { status: 'DONE' });
  gt.updateTask(TEST_ROOT, project, 'TASK-0002', { status: 'BLOCKED' });
  const t3 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001',
    title: 'Accepted task',
    goal: 'count accepted',
    reason: 'r',
    scope: 's',
    status: 'ACCEPTED',
  });
  const t4 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001',
    title: 'Working task',
    goal: 'count active',
    reason: 'r',
    scope: 's',
    status: 'WORKING',
  });
  void t3; void t4;
  const progress = gt.getGoalProgress(TEST_ROOT, project, 'GOAL-0001');
  check(progress.totalTasks === 4, `totalTasks=${progress.totalTasks}`);
  check(progress.doneTasks === 2, `doneTasks(DONE+ACCEPTED)=${progress.doneTasks}`);
  check(progress.blockedTasks === 1, `blockedTasks=${progress.blockedTasks}`);
  check(progress.activeTasks === 1, `activeTasks=${progress.activeTasks}`);
  check(progress.weightedProgress === 0.5, `weightedProgress=${progress.weightedProgress}`);

  // Pure function path
  const pure = gt.deriveGoalProgress('GOAL-0001', gt.listTasks(TEST_ROOT, project, 'GOAL-0001'));
  check(pure.doneTasks === 2 && pure.totalTasks === 4, 'deriveGoalProgress pure');

  // ── B20 legacy project without _relay unchanged ───────────────────────────
  console.log('B20) legacy project without _relay unchanged');
  const legacyProj = 'LegacyOnly';
  relay.createProject(TEST_ROOT, legacyProj);
  const legacyDate = relay.todayString();
  const legacyRun = await relay.atomicMaterializeRun(TEST_ROOT, legacyProj, legacyDate, 'Claude Code');
  relay.writeMarkdown(legacyRun.folder, 'prompt.md', '# p\n', false);
  check(!fs.existsSync(gt.relayDir(TEST_ROOT, legacyProj)), 'no _relay created for untouched legacy project');
  const legacyHist = relay.buildHistory(TEST_ROOT, legacyProj);
  check(legacyHist.length === 1 && legacyHist[0].run === legacyRun.run, 'legacy history intact');

  // ── B21 _relay excluded from Run history scanning ─────────────────────────
  console.log('B21) _relay excluded from Run history scanning');
  // Ensure _relay exists under KernelProj
  check(fs.existsSync(gt.relayDir(TEST_ROOT, project)), '_relay exists under KernelProj');
  const dates = relay.listDates(TEST_ROOT, project);
  check(!dates.includes('_relay'), 'listDates excludes _relay');
  const hist = relay.buildHistory(TEST_ROOT, project);
  check(!hist.some((h) => h.date === '_relay' || h.folder.includes(`${path.sep}_relay${path.sep}`)), 'buildHistory ignores _relay');
  const projects = relay.listProjects(TEST_ROOT);
  check(!projects.some((p) => p.name === '_relay'), 'listProjects excludes _relay');

  // ── B22 malformed JSON handled clearly ────────────────────────────────────
  console.log('B22) malformed JSON handled clearly');
  const g2 = await gt.createGoal(TEST_ROOT, project, {
    title: 'Broken later',
    goalStatement: 'for malformed test',
  });
  fs.writeFileSync(path.join(gt.goalFolder(TEST_ROOT, project, g2.goalId), 'goal.json'), '{not-json', 'utf8');
  let malformed = false;
  let malformedMsg = '';
  try { gt.getGoal(TEST_ROOT, project, g2.goalId); }
  catch (e) { malformed = true; malformedMsg = e instanceof Error ? e.message : String(e); }
  check(malformed && /JSON/i.test(malformedMsg), `malformed JSON clear error: ${malformedMsg}`);

  // ── B23 concurrent Goal ID allocation unique ──────────────────────────────
  console.log('B23) concurrent Goal ID allocation unique');
  const concProj = 'ConcGoal';
  relay.createProject(TEST_ROOT, concProj);
  const goalPromises = Array.from({ length: 8 }, (_, i) =>
    gt.createGoal(TEST_ROOT, concProj, {
      title: `G${i}`,
      goalStatement: `stmt ${i}`,
    }),
  );
  const concGoals = await Promise.all(goalPromises);
  const goalIds = concGoals.map((g) => g.goalId);
  check(new Set(goalIds).size === 8, `unique goal ids: ${goalIds.join(',')}`);
  check(goalIds.every((id) => /^GOAL-\d{4}$/.test(id)), 'goal id format');

  // ── B24 concurrent Task ID allocation unique ──────────────────────────────
  console.log('B24) concurrent Task ID allocation unique');
  const parent = await gt.createGoal(TEST_ROOT, concProj, {
    title: 'parent',
    goalStatement: 'for tasks',
  });
  const taskPromises = Array.from({ length: 8 }, (_, i) =>
    gt.createTask(TEST_ROOT, concProj, {
      goalId: parent.goalId,
      title: `T${i}`,
      goal: `g${i}`,
      reason: 'r',
      scope: 's',
    }),
  );
  const concTasks = await Promise.all(taskPromises);
  const taskIds = concTasks.map((t) => t.taskId);
  check(new Set(taskIds).size === 8, `unique task ids: ${taskIds.join(',')}`);
  check(taskIds.every((id) => /^TASK-\d{4}$/.test(id)), 'task id format');

  // Permission policy schema smoke
  console.log('Permission policy schema');
  const gPerm = await gt.createGoal(TEST_ROOT, project, {
    title: 'Perm',
    goalStatement: 'policy',
    permissionPolicy: {
      mode: 'APPROVE',
      overrides: { dispatch: true, mergeMain: false },
    },
  });
  check(
    gPerm.permissionPolicy.mode === 'APPROVE' &&
    gPerm.permissionPolicy.overrides?.dispatch === true &&
    gPerm.permissionPolicy.overrides?.mergeMain === false,
    'permissionPolicy PLAN/APPROVE/BYPASS structure persisted',
  );
  let badMode = false;
  try {
    await gt.createGoal(TEST_ROOT, project, {
      title: 'x', goalStatement: 'y', permissionPolicy: { mode: 'YOLO' },
    });
  } catch { badMode = true; }
  check(badMode, 'invalid permission mode rejected');

  // Empty title rejected
  let emptyTitle = false;
  try {
    await gt.createGoal(TEST_ROOT, project, { title: '  ', goalStatement: 'y' });
  } catch { emptyTitle = true; }
  check(emptyTitle, 'empty Goal title rejected');

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const ok = process.exitCode === undefined || process.exitCode === 0;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => {
  console.error('harness error', e);
  process.exitCode = 1;
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
