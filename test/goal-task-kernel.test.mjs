/**
 * Phase B1 Goal/Task kernel + architecture correction tests.
 * Covers legacy B CRUD/ID checks and I1–I30 identity/state requirements.
 * Uses a temporary DATA_ROOT only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as rt from '../dist/server/backend/goal-task-runtime.js';
import { deriveCompatTaskStatus, mapLegacyTaskStatus } from '../dist/server/shared/types.js';

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-b1fix-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'KernelProj';

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);

  // ── Goal CRUD (I27) ───────────────────────────────────────────────────────
  console.log('B/I27) Goal CRUD');
  const g1 = await gt.createGoal(TEST_ROOT, project, {
    title: 'Agent Relay Closed PM Loop',
    goalStatement: 'Ship Goal/Task kernel above Runs',
    completionCriteria: ['CRUD works', 'Runs link safely'],
    permissionPolicy: { mode: 'PLAN' },
  });
  check(g1.goalId === 'GOAL-0001', `goalId=${g1.goalId}`);
  check(g1.schemaVersion === 2, `goal schemaVersion=${g1.schemaVersion}`);
  check(gt.getGoal(TEST_ROOT, project, 'GOAL-0001').title === g1.title, 'getGoal');
  check(gt.listGoals(TEST_ROOT, project).length === 1, 'listGoals');
  const gUp = rt.transitionGoalStatus(TEST_ROOT, project, 'GOAL-0001', 'ACTIVE');
  check(gUp.status === 'ACTIVE', 'goal:transition → ACTIVE');

  // ── Task CRUD defaults (I16, I28) ─────────────────────────────────────────
  console.log('B/I16/I28) Task CRUD defaults');
  const t1 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001',
    title: 'Goal/Task Kernel',
    goal: 'Persist Goals and Tasks on disk',
    reason: 'Need SSOT above Runs',
    scope: 'Backend kernel only',
    completionCriteria: ['IDs stable', 'linkRun works'],
  });
  check(t1.taskId === 'TASK-0001', `taskId=${t1.taskId}`);
  check(t1.executionState === 'PLANNED' && t1.pmState === 'PENDING', 'I16 defaults PLANNED/PENDING');
  check(t1.schemaVersion === 2, 'task schemaVersion=2');
  check(!('status' in JSON.parse(fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, 'TASK-0001'), 'task.json'), 'utf8'))), 'no persisted legacy status');

  let badGoal = false;
  try {
    await gt.createTask(TEST_ROOT, project, {
      goalId: 'GOAL-9999', title: 'x', goal: 'y', reason: 'r', scope: 's',
    });
  } catch { badGoal = true; }
  check(badGoal, 'task requires valid Goal');

  gt.updateTask(TEST_ROOT, project, 'TASK-0001', { title: 'Kernel impl' });
  check(gt.getTask(TEST_ROOT, project, 'TASK-0001').title === 'Kernel impl', 'updateTask narrative title');
  await rt.refreshTaskReadiness(TEST_ROOT, project, 'TASK-0001');
  await rt.transitionTaskExecution(TEST_ROOT, project, 'TASK-0001', {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, 'TASK-0001', {
    expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
  });
  check(gt.getTask(TEST_ROOT, project, 'TASK-0001').executionState === 'RUNNING', 'transitionExecution → RUNNING');

  // ── State validation (I17–I19) ────────────────────────────────────────────
  console.log('I17–I19) State validation');
  let badExec = false;
  try { gt.updateTask(TEST_ROOT, project, 'TASK-0001', { executionState: 'WORKING' }); }
  catch { badExec = true; }
  check(badExec, 'I17 raw/invalid executionState via updateTask rejected');
  let badPm = false;
  try { gt.updateTask(TEST_ROOT, project, 'TASK-0001', { pmState: 'DONE' }); }
  catch { badPm = true; }
  check(badPm, 'I18 raw/invalid pmState via updateTask rejected');

  // Drive to RESULT_RECEIVED without ACCEPTED (needs a linked run for markResultReceived)
  const earlyRun = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'EarlyResult');
  await gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', earlyRun.folder);
  const earlyRunId = relay.readRunMeta(earlyRun.folder).runId;
  await rt.markResultReceived(TEST_ROOT, project, 'TASK-0001', earlyRunId, {
    expectedExecutionState: 'RUNNING',
  });
  const afterResult = gt.getTask(TEST_ROOT, project, 'TASK-0001');
  check(
    afterResult.executionState === 'RESULT_RECEIVED' && afterResult.pmState === 'VERIFYING',
    'I19 RESULT_RECEIVED does not imply ACCEPTED',
  );
  check(deriveCompatTaskStatus(afterResult) === 'VERIFYING', 'compat label VERIFYING not ACCEPTED');

  // ── Stable runId (I1–I4) ──────────────────────────────────────────────────
  console.log('I1–I4) Stable runId');
  const date = relay.todayString();
  const agent = 'Codex';
  const runA = await relay.atomicMaterializeRun(TEST_ROOT, project, date, agent);
  check(typeof runA.runId === 'string' && runA.runId.length > 10, `I1 new Run has runId=${runA.runId}`);
  check(relay.readRunMeta(runA.folder).runId === runA.runId, 'I1 meta.runId matches');

  // Legacy Run without runId
  const legacyFolder = relay.ensureRunFolder(TEST_ROOT, project, date, 'Claude Code', '01');
  relay.writeMarkdown(legacyFolder, 'prompt.md', '# legacy\n', false);
  relay.writeRunMeta(legacyFolder, { tags: ['참고'] });
  const legacyMeta = relay.readRunMeta(legacyFolder);
  check(legacyMeta.runId === undefined && legacyMeta.tags.includes('참고'), 'I2 legacy Run readable without runId');

  const assigned = relay.ensureRunId(legacyFolder);
  check(typeof assigned === 'string' && relay.readRunMeta(legacyFolder).runId === assigned, 'ensureRunId assigns once');
  const again = relay.ensureRunId(legacyFolder);
  check(again === assigned, 'I4 runId immutable on re-ensure');

  // moveRun preserves runId (copies meta.json)
  const moved = relay.moveRun(legacyFolder, TEST_ROOT, project, date, 'OpenCode');
  check(relay.readRunMeta(moved).runId === assigned, 'I4 moveRun preserves runId');

  // ── Linkage (I5–I9, I3, I12) ──────────────────────────────────────────────
  console.log('I5–I9/I3/I12) Run linkage');
  // Fresh legacy without runId for opportunistic assign on link
  const legacy2 = relay.ensureRunFolder(TEST_ROOT, project, date, 'Grok', '01');
  relay.writeRunMeta(legacy2, { tags: ['legacy'] });
  check(relay.readRunMeta(legacy2).runId === undefined, 'pre-link legacy has no runId');

  const linkedLegacy = await gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', legacy2);
  const legacyLink = linkedLegacy.linkedRuns.find((r) => r.folder === path.resolve(legacy2));
  check(!!legacyLink?.runId, 'I3 linking legacy assigns runId into linkedRuns');
  check(relay.readRunMeta(legacy2).runId === legacyLink.runId, 'I3 meta gained runId');

  const runB = await relay.atomicMaterializeRun(TEST_ROOT, project, date, agent);
  const linked1 = await gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runA.folder);
  check(linked1.linkedRuns.some((r) => r.runId === runA.runId), 'I5 linkedRuns stores runId');
  const metaA = relay.readRunMeta(runA.folder);
  check(
    metaA.goalId === 'GOAL-0001' && metaA.taskId === 'TASK-0001' && typeof metaA.taskRunSequence === 'number' && metaA.runId === runA.runId,
    'I6 Run meta backlink goalId/taskId/taskRunSequence',
  );

  const t2 = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001', title: 'Other', goal: 'g', reason: 'r', scope: 's',
  });
  let doubleLink = false;
  try { await gt.linkRunToTask(TEST_ROOT, project, t2.taskId, runA.folder); }
  catch { doubleLink = true; }
  check(doubleLink, 'I7 same Run cannot link to second Task');

  const linkedMulti = await gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runB.folder);
  check(linkedMulti.linkedRuns.length >= 3, `I12 multiple parallel Runs (${linkedMulti.linkedRuns.length})`);

  const unlinked = await gt.unlinkRunFromTask(TEST_ROOT, project, 'TASK-0001', runA.folder);
  check(!unlinked.linkedRuns.some((r) => r.runId === runA.runId), 'I8 Task ref removed');
  const metaAfter = relay.readRunMeta(runA.folder);
  check(
    metaAfter.runId === runA.runId && metaAfter.taskId === undefined && metaAfter.goalId === undefined && metaAfter.taskRunSequence === undefined,
    'I8 backlink cleared, runId kept',
  );

  const relinked = await gt.linkRunToTask(TEST_ROOT, project, 'TASK-0001', runA.folder);
  check(relinked.linkedRuns.some((r) => r.runId === runA.runId), 'I9 relink after unlink works');
  check(relay.readRunMeta(runA.folder).runId === runA.runId, 'I9 runId unchanged across unlink/relink');

  // ── Atomic sequences (I10–I11) ─────────────────────────────────────────────
  console.log('I10–I11) Atomic taskRunSequence');
  const concGoal = await gt.createGoal(TEST_ROOT, project, { title: 'conc', goalStatement: 'seq' });
  const concTask = await gt.createTask(TEST_ROOT, project, {
    goalId: concGoal.goalId, title: 'seq task', goal: 'g', reason: 'r', scope: 's',
  });
  const r1 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'AgentA');
  const r2 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'AgentB');
  const [l1, l2] = await Promise.all([
    gt.linkRunToTask(TEST_ROOT, project, concTask.taskId, r1.folder),
    gt.linkRunToTask(TEST_ROOT, project, concTask.taskId, r2.folder),
  ]);
  // Both resolve to same final task state from last write — re-read
  const afterTwo = gt.getTask(TEST_ROOT, project, concTask.taskId);
  const seqs2 = afterTwo.linkedRuns.map((x) => x.taskRunSequence).sort((a, b) => a - b);
  check(seqs2.length === 2 && new Set(seqs2).size === 2, `I10 unique sequences: ${seqs2.join(',')}`);
  void l1; void l2;

  const fiveFolders = [];
  for (let i = 0; i < 5; i++) {
    fiveFolders.push((await relay.atomicMaterializeRun(TEST_ROOT, project, date, `Agent${i}`)).folder);
  }
  await Promise.all(fiveFolders.map((f) => gt.linkRunToTask(TEST_ROOT, project, concTask.taskId, f)));
  const afterFive = gt.getTask(TEST_ROOT, project, concTask.taskId);
  const seqs5 = afterFive.linkedRuns.map((x) => x.taskRunSequence);
  check(seqs5.length === 7 && new Set(seqs5).size === 7, `I11 5-way+2 unique sequences count=${seqs5.length}`);

  // ── acceptedRunId (I13–I15, I20) ───────────────────────────────────────────
  console.log('I13–I15/I20) acceptedRunId');
  const acceptTask = gt.getTask(TEST_ROOT, project, 'TASK-0001');
  const pickId = acceptTask.linkedRuns[0].runId;
  let badAccept = false;
  try { await rt.acceptResult(TEST_ROOT, project, 'TASK-0001', 'not-a-real-run'); }
  catch { badAccept = true; }
  check(badAccept, 'I13 acceptedRunId must reference linked Run');

  // TASK-0001 is already RESULT_RECEIVED/VERIFYING from I19
  const withAccept = await rt.acceptResult(TEST_ROOT, project, 'TASK-0001', pickId);
  check(withAccept.acceptedRunId === pickId && withAccept.pmState === 'ACCEPTED', 'I20 PM ACCEPTED + acceptedRunId');
  check(withAccept.linkedRuns.length > 1, 'I14 other attempts still linked');
  const cleared = await rt.transitionTaskPm(TEST_ROOT, project, 'TASK-0001', {
    expectedPmState: 'ACCEPTED', to: 'PENDING',
  });
  check(cleared.acceptedRunId === undefined && cleared.pmState === 'PENDING', 'I15 reopen clears acceptedRunId');

  // ── Goal progress (I21–I23) ───────────────────────────────────────────────
  console.log('I21–I23) Goal progress semantics');
  // Reset TASK-0001 to CHANGES_REQUESTED (not complete) via legal transitions
  await rt.transitionTaskPm(TEST_ROOT, project, 'TASK-0001', {
    expectedPmState: 'PENDING', to: 'VERIFYING',
  });
  await rt.requestChanges(TEST_ROOT, project, 'TASK-0001', {
    expectedPmState: 'VERIFYING', reason: 'progress fixture',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, t2.taskId, {
    expectedExecutionState: 'PLANNED', to: 'BLOCKED', reason: 'fixture',
  });
  const tAccepted = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001', title: 'done one', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'ACCEPTED',
  });
  const tActive = await gt.createTask(TEST_ROOT, project, {
    goalId: 'GOAL-0001', title: 'active', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  void tAccepted; void tActive;
  const progress = gt.getGoalProgress(TEST_ROOT, project, 'GOAL-0001');
  // tasks: TASK-0001 CHANGES_REQUESTED, t2 BLOCKED, concTask (other goal), tAccepted ACCEPTED, tActive RUNNING
  // Only GOAL-0001 tasks: 0001, 0002(t2), accepted, active = 4 (+ maybe more from earlier?)
  // Actually concTask is under concGoal, not GOAL-0001.
  // TASK-0001, t2, tAccepted, tActive = 4
  check(progress.doneTasks === 1, `I21 doneTasks(pm ACCEPTED only)=${progress.doneTasks}`);
  check(progress.blockedTasks === 1, `I23 blocked=${progress.blockedTasks}`);
  // TASK-0001 RESULT_RECEIVED+CHANGES_REQUESTED counts active; tActive RUNNING counts active
  check(progress.activeTasks === 2, `I22 CHANGES_REQUESTED not complete; active=${progress.activeTasks}`);
  check(progress.doneTasks !== progress.totalTasks || progress.totalTasks === 1, 'CHANGES_REQUESTED not counted complete');

  // ── v1 migration (I24) ────────────────────────────────────────────────────
  console.log('I24) legacy B1 Task storage read-migrates');
  const migGoal = await gt.createGoal(TEST_ROOT, project, { title: 'mig', goalStatement: 'm' });
  const migDir = path.join(gt.tasksDir(TEST_ROOT, project), 'TASK-MIG1');
  // Use a real allocated id folder name that matches pattern — write as TASK-0099 manually
  const migId = 'TASK-0099';
  const migFolder = gt.taskFolder(TEST_ROOT, project, migId);
  fs.mkdirSync(migFolder, { recursive: true });
  const v1 = {
    schemaVersion: 1,
    taskId: migId,
    goalId: migGoal.goalId,
    project,
    title: 'legacy v1',
    goal: 'migrate me',
    reason: 'r',
    scope: 's',
    completionCriteria: [],
    status: 'VERIFYING',
    dependencies: [],
    linkedRuns: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(migFolder, 'task.json'), JSON.stringify(v1, null, 2), 'utf8');
  const migrated = gt.getTask(TEST_ROOT, project, migId);
  const expectMap = mapLegacyTaskStatus('VERIFYING');
  check(
    migrated.schemaVersion === 2 &&
    migrated.executionState === expectMap.executionState &&
    migrated.pmState === expectMap.pmState,
    `I24 v1 VERIFYING → ${migrated.executionState}/${migrated.pmState}`,
  );
  // folder-only linkedRuns migrate with runId
  const migRun = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'MigAgent');
  // strip runId to simulate absolute legacy link? Better: write v1 task with folder-only link
  const v1bId = 'TASK-0098';
  const v1bFolder = gt.taskFolder(TEST_ROOT, project, v1bId);
  fs.mkdirSync(v1bFolder, { recursive: true });
  // Create a run without going through atomic (folder-only legacy): ensure folder + tags only, then assign via migrate
  const bare = relay.ensureRunFolder(TEST_ROOT, project, date, 'BareAgent', '07');
  relay.writeRunMeta(bare, { tags: [] }); // no runId
  fs.writeFileSync(path.join(v1bFolder, 'task.json'), JSON.stringify({
    schemaVersion: 1,
    taskId: v1bId,
    goalId: migGoal.goalId,
    project,
    title: 'v1 links',
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: [],
    status: 'WORKING',
    dependencies: [],
    linkedRuns: [{ folder: bare, taskRunSequence: 1 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  const migLinks = gt.getTask(TEST_ROOT, project, v1bId);
  check(
    migLinks.executionState === 'RUNNING' &&
    migLinks.linkedRuns[0].runId &&
    relay.readRunMeta(bare).runId === migLinks.linkedRuns[0].runId,
    'I24 folder-only linkedRuns gains runId on read',
  );
  void migRun; void migDir;

  // ── Legacy physical Runs (I25) ────────────────────────────────────────────
  console.log('I25) legacy physical Runs remain valid');
  const hist = relay.buildHistory(TEST_ROOT, project);
  check(hist.length > 0 && hist.every((h) => h.folder && h.run), 'I25 history lists physical runs');
  check(!hist.some((h) => h.date === '_relay'), '_relay excluded from history');

  // ── Permission policy (I29) ───────────────────────────────────────────────
  console.log('I29) permission policy');
  const gPerm = await gt.createGoal(TEST_ROOT, project, {
    title: 'Perm',
    goalStatement: 'policy',
    permissionPolicy: { mode: 'APPROVE', overrides: { dispatch: true } },
  });
  check(gPerm.permissionPolicy.mode === 'APPROVE', 'I29 permission policy persisted');
  let badMode = false;
  try {
    await gt.createGoal(TEST_ROOT, project, {
      title: 'x', goalStatement: 'y', permissionPolicy: { mode: 'YOLO' },
    });
  } catch { badMode = true; }
  check(badMode, 'invalid permission mode rejected');

  // ── Concurrent Goal/Task IDs (I30) ────────────────────────────────────────
  console.log('I30) concurrent Goal/Task ID allocation');
  const concProj = 'ConcIds';
  relay.createProject(TEST_ROOT, concProj);
  const goals = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      gt.createGoal(TEST_ROOT, concProj, { title: `G${i}`, goalStatement: `s${i}` }),
    ),
  );
  check(new Set(goals.map((g) => g.goalId)).size === 8, 'I30 unique Goal IDs');
  const parent = goals[0];
  const tasks = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      gt.createTask(TEST_ROOT, concProj, {
        goalId: parent.goalId, title: `T${i}`, goal: `g${i}`, reason: 'r', scope: 's',
      }),
    ),
  );
  check(new Set(tasks.map((t) => t.taskId)).size === 8, 'I30 unique Task IDs');

  // Markdown mirrors still written
  const tMd = fs.readFileSync(path.join(gt.taskFolder(TEST_ROOT, project, 'TASK-0001'), 'task.md'), 'utf8');
  check(tMd.includes('## Execution State') && tMd.includes('## PM State'), 'task.md mirrors split states');

  // Self-dep / dup deps still work
  let selfDep = false;
  try { gt.updateTask(TEST_ROOT, project, 'TASK-0001', { dependencies: ['TASK-0001'] }); }
  catch { selfDep = true; }
  check(selfDep, 'self dependency rejected');

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const ok = process.exitCode === undefined || process.exitCode === 0;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => {
  console.error('harness error', e);
  process.exitCode = 1;
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});
