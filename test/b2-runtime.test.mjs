/**
 * Phase B2 — Goal/Task deterministic runtime behavior.
 * Temporary DATA_ROOT only. Covers B2-01 .. B2-35.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as rt from '../dist/server/backend/goal-task-runtime.js';

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-b2-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'B2Proj';

async function linkFreshRun(taskId, agent = 'Codex') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, link, runId: link.runId };
}

async function driveToResultReceived(taskId, agent = 'Codex') {
  let t = gt.getTask(TEST_ROOT, project, taskId);
  if (t.executionState === 'PLANNED') {
    t = rt.refreshTaskReadiness(TEST_ROOT, project, taskId);
    if (t.executionState === 'PLANNED') {
      t = rt.transitionTaskExecution(TEST_ROOT, project, taskId, 'READY');
    }
  }
  if (t.executionState === 'READY') {
    t = rt.transitionTaskExecution(TEST_ROOT, project, taskId, 'DISPATCHED');
  }
  if (t.executionState === 'DISPATCHED') {
    t = rt.transitionTaskExecution(TEST_ROOT, project, taskId, 'RUNNING');
  }
  const { runId } = await linkFreshRun(taskId, agent);
  t = rt.markResultReceived(TEST_ROOT, project, taskId, runId);
  return { task: t, runId };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);

  const goal = await gt.createGoal(TEST_ROOT, project, {
    title: 'B2 Runtime',
    goalStatement: 'Deterministic Goal/Task runtime',
    completionCriteria: ['tasks accepted'],
  });
  check(goal.goalId === 'GOAL-0001', `goal created ${goal.goalId}`);

  // ── Readiness / dependencies ──────────────────────────────────────────────
  console.log('B2-01..06) readiness & blocking');
  const tA = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'A', goal: 'g', reason: 'r', scope: 's',
  });
  const readyA0 = rt.getTaskReadiness(tA, [tA]);
  check(readyA0.kind === 'PLANNED' && readyA0.dependenciesSatisfied, 'B2-01 zero-dep PLANNED eligible');
  const aReady = rt.refreshTaskReadiness(TEST_ROOT, project, tA.taskId);
  check(aReady.executionState === 'READY', 'B2-01 zero-dep refresh → READY');

  const tB = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'B', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tA.taskId],
  });
  const bRead = rt.getTaskReadinessForId(TEST_ROOT, project, tB.taskId);
  check(bRead.kind === 'WAITING_DEPENDENCIES', 'B2-02 unsatisfied dep → WAITING_DEPENDENCIES');
  check(bRead.unsatisfiedDependencies.includes(tA.taskId), 'B2-02 lists unsatisfied dep');
  const bRefresh = rt.refreshTaskReadiness(TEST_ROOT, project, tB.taskId);
  check(bRefresh.executionState === 'PLANNED', 'B2-02 refresh does not force READY');

  // Accept A → unlock B
  const { runId: aRun } = await driveToResultReceived(tA.taskId, 'AgentA');
  const aAccepted = rt.acceptResult(TEST_ROOT, project, tA.taskId, aRun);
  check(aAccepted.pmState === 'ACCEPTED' && aAccepted.acceptedRunId === aRun, 'accept A');
  const bAfter = gt.getTask(TEST_ROOT, project, tB.taskId);
  check(bAfter.executionState === 'READY', 'B2-03 ACCEPTED dep unlocks dependent via refreshDependentReadiness');

  // RESULT_RECEIVED does not unlock
  const tC = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'C', goal: 'g', reason: 'r', scope: 's',
  });
  const tD = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'D depends C', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tC.taskId],
  });
  await driveToResultReceived(tC.taskId, 'AgentC');
  const dWait = rt.getTaskReadinessForId(TEST_ROOT, project, tD.taskId);
  check(dWait.kind === 'WAITING_DEPENDENCIES', 'B2-04 RESULT_RECEIVED does NOT unlock dependent');
  check(gt.getTask(TEST_ROOT, project, tD.taskId).executionState === 'PLANNED', 'B2-04 D stays PLANNED');

  // FAILED dependency
  const tE = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'E', goal: 'g', reason: 'r', scope: 's',
    executionState: 'FAILED', pmState: 'PENDING',
  });
  const tF = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'F', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tE.taskId],
  });
  const fRead = rt.getTaskReadinessForId(TEST_ROOT, project, tF.taskId);
  check(fRead.kind === 'WAITING_DEPENDENCIES' && fRead.blockedBy.includes(tE.taskId), 'B2-05 FAILED dep not satisfied + blockedBy');

  // Explicit BLOCKED vs waiting
  const tG = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'G wait', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tA.taskId], // A is ACCEPTED — satisfied
  });
  // Create H that waits on unfinished C (RESULT_RECEIVED not accepted)
  const tH = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'H wait C', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tC.taskId],
  });
  const hWait = rt.getTaskReadinessForId(TEST_ROOT, project, tH.taskId);
  check(hWait.kind === 'WAITING_DEPENDENCIES', 'B2-06 waiting ≠ BLOCKED');
  check(gt.getTask(TEST_ROOT, project, tH.taskId).executionState !== 'BLOCKED', 'B2-06 execution not BLOCKED while waiting');
  rt.refreshTaskReadiness(TEST_ROOT, project, tG.taskId);
  const gBlocked = rt.transitionTaskExecution(TEST_ROOT, project, tG.taskId, 'BLOCKED', 'owner decision');
  check(gBlocked.executionState === 'BLOCKED' && gBlocked.blockedReason === 'owner decision', 'B2-06 explicit BLOCKED with reason');
  const gRead = rt.getTaskReadinessForId(TEST_ROOT, project, tG.taskId);
  check(gRead.kind === 'BLOCKED', 'B2-06 readiness BLOCKED distinct');

  // ── Cycles / cross-goal ───────────────────────────────────────────────────
  console.log('B2-07..09) dependency graph guards');
  const tX = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'X', goal: 'g', reason: 'r', scope: 's',
  });
  const tY = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Y', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tX.taskId],
  });
  let cycle2 = false;
  try { gt.updateTask(TEST_ROOT, project, tX.taskId, { dependencies: [tY.taskId] }); }
  catch { cycle2 = true; }
  check(cycle2, 'B2-07 direct cycle A→B→A rejected');

  const tP = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'P', goal: 'g', reason: 'r', scope: 's',
  });
  const tQ = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Q', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tP.taskId],
  });
  const tR = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'R', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tQ.taskId],
  });
  let cycle3 = false;
  try { gt.updateTask(TEST_ROOT, project, tP.taskId, { dependencies: [tR.taskId] }); }
  catch { cycle3 = true; }
  check(cycle3, 'B2-08 3-node cycle rejected');

  const otherGoal = await gt.createGoal(TEST_ROOT, project, {
    title: 'Other', goalStatement: 'other goal',
  });
  const tOther = await gt.createTask(TEST_ROOT, project, {
    goalId: otherGoal.goalId, title: 'OtherTask', goal: 'g', reason: 'r', scope: 's',
  });
  let cross = false;
  try {
    await gt.createTask(TEST_ROOT, project, {
      goalId: goal.goalId, title: 'Cross', goal: 'g', reason: 'r', scope: 's',
      dependencies: [tOther.taskId],
    });
  } catch { cross = true; }
  check(cross, 'B2-09 cross-Goal dependency rejected');

  // ── Execution / PM transitions ────────────────────────────────────────────
  console.log('B2-10..13) transitions');
  const tFlow = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Flow', goal: 'g', reason: 'r', scope: 's',
  });
  rt.refreshTaskReadiness(TEST_ROOT, project, tFlow.taskId);
  rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'DISPATCHED');
  rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'RUNNING');
  const { runId: flowRun } = await linkFreshRun(tFlow.taskId, 'FlowAgent');
  rt.markResultReceived(TEST_ROOT, project, tFlow.taskId, flowRun);
  check(gt.getTask(TEST_ROOT, project, tFlow.taskId).executionState === 'RESULT_RECEIVED', 'B2-10 legal execution path');

  let illegalExec = false;
  try { rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'PLANNED'); }
  catch { illegalExec = true; }
  check(illegalExec, 'B2-11 illegal execution jump rejected');

  rt.transitionTaskPm(TEST_ROOT, project, tFlow.taskId, 'CHANGES_REQUESTED', { reason: 'nits' });
  check(gt.getTask(TEST_ROOT, project, tFlow.taskId).pmState === 'CHANGES_REQUESTED', 'B2-12 VERIFYING→CHANGES_REQUESTED');
  // markResult again after correction run
  rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'READY');
  rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'DISPATCHED');
  rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, 'RUNNING');
  const { runId: flowRun2 } = await linkFreshRun(tFlow.taskId, 'FlowAgent2');
  rt.markResultReceived(TEST_ROOT, project, tFlow.taskId, flowRun2);
  check(gt.getTask(TEST_ROOT, project, tFlow.taskId).pmState === 'VERIFYING', 'B2-12 CHANGES_REQUESTED→VERIFYING on new result');

  let illegalPm = false;
  try { rt.transitionTaskPm(TEST_ROOT, project, tFlow.taskId, 'PENDING'); }
  catch { illegalPm = true; }
  check(illegalPm, 'B2-13 illegal PM VERIFYING→PENDING rejected');

  // ── Accept / changes / result semantics ───────────────────────────────────
  console.log('B2-14..20) accept / changes / result');
  const tAcc = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'AcceptMe', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: accRun } = await driveToResultReceived(tAcc.taskId, 'AccAgent');
  const afterResult = gt.getTask(TEST_ROOT, project, tAcc.taskId);
  check(afterResult.executionState === 'RESULT_RECEIVED' && afterResult.pmState === 'VERIFYING', 'B2-14 RESULT_RECEIVED does not imply ACCEPTED');
  check(afterResult.pmState !== 'ACCEPTED', 'B2-14 pm not ACCEPTED');

  let badLink = false;
  try { rt.acceptResult(TEST_ROOT, project, tAcc.taskId, 'not-linked-run'); }
  catch { badLink = true; }
  check(badLink, 'B2-15 acceptResult requires linked run');

  const tEarly = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Early', goal: 'g', reason: 'r', scope: 's',
  });
  rt.refreshTaskReadiness(TEST_ROOT, project, tEarly.taskId);
  const { runId: earlyRun } = await linkFreshRun(tEarly.taskId, 'EarlyAgent');
  let badState = false;
  try { rt.acceptResult(TEST_ROOT, project, tEarly.taskId, earlyRun); }
  catch { badState = true; }
  check(badState, 'B2-16 acceptResult requires RESULT_RECEIVED');

  const accepted = rt.acceptResult(TEST_ROOT, project, tAcc.taskId, accRun);
  check(accepted.pmState === 'ACCEPTED' && accepted.acceptedRunId === accRun, 'B2-17 accept sets acceptedRunId + ACCEPTED');
  const accepted2 = rt.acceptResult(TEST_ROOT, project, tAcc.taskId, accRun);
  check(accepted2.pmState === 'ACCEPTED' && accepted2.acceptedRunId === accRun, 'B2-18 repeated acceptResult idempotent');
  check(accepted2.linkedRuns.length >= 1, 'B2-18 history preserved');

  // requestChanges loop
  const tCh = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Changes', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: chRun1 } = await driveToResultReceived(tCh.taskId, 'Ch1');
  const beforeRuns = gt.getTask(TEST_ROOT, project, tCh.taskId).linkedRuns.length;
  rt.requestChanges(TEST_ROOT, project, tCh.taskId, 'please fix');
  const afterCh = gt.getTask(TEST_ROOT, project, tCh.taskId);
  check(afterCh.pmState === 'CHANGES_REQUESTED' && !afterCh.acceptedRunId, 'B2-19 requestChanges → CHANGES_REQUESTED');
  check(afterCh.linkedRuns.length === beforeRuns, 'B2-19 preserves Run history');
  rt.requestChanges(TEST_ROOT, project, tCh.taskId, 'please fix'); // idempotent
  rt.transitionTaskExecution(TEST_ROOT, project, tCh.taskId, 'READY');
  rt.transitionTaskExecution(TEST_ROOT, project, tCh.taskId, 'DISPATCHED');
  rt.transitionTaskExecution(TEST_ROOT, project, tCh.taskId, 'RUNNING');
  const { runId: chRun2 } = await linkFreshRun(tCh.taskId, 'Ch2');
  rt.markResultReceived(TEST_ROOT, project, tCh.taskId, chRun2);
  const retried = gt.getTask(TEST_ROOT, project, tCh.taskId);
  check(retried.executionState === 'RESULT_RECEIVED' && retried.pmState === 'VERIFYING', 'B2-20 correction retry possible');
  check(retried.linkedRuns.length === beforeRuns + 1, 'B2-20 second run linked');
  void chRun1;

  // ── Goal completion ───────────────────────────────────────────────────────
  console.log('B2-21..27) goal completion');
  const g2 = await gt.createGoal(TEST_ROOT, project, {
    title: 'CompleteMe', goalStatement: 'finish',
  });
  rt.transitionGoalStatus(TEST_ROOT, project, g2.goalId, 'ACTIVE');
  const c1 = await gt.createTask(TEST_ROOT, project, {
    goalId: g2.goalId, title: 'c1', goal: 'g', reason: 'r', scope: 's',
  });
  const c2 = await gt.createTask(TEST_ROOT, project, {
    goalId: g2.goalId, title: 'c2', goal: 'g', reason: 'r', scope: 's',
  });
  let ev = rt.evaluateGoalCompletionForId(TEST_ROOT, project, g2.goalId);
  check(!ev.eligible && ev.incompleteTasks.length === 2, 'B2-21 unfinished → not eligible');

  const { runId: c1run } = await driveToResultReceived(c1.taskId, 'C1a');
  rt.acceptResult(TEST_ROOT, project, c1.taskId, c1run);
  ev = rt.evaluateGoalCompletionForId(TEST_ROOT, project, g2.goalId);
  check(!ev.eligible, 'B2-21 still incomplete with one unfinished');

  const { runId: c2run } = await driveToResultReceived(c2.taskId, 'C2a');
  rt.acceptResult(TEST_ROOT, project, c2.taskId, c2run);
  ev = rt.evaluateGoalCompletionForId(TEST_ROOT, project, g2.goalId);
  check(ev.eligible && ev.acceptedTasks === 2, 'B2-22 all ACCEPTED → eligible');

  const gEmpty = await gt.createGoal(TEST_ROOT, project, {
    title: 'Empty', goalStatement: 'no tasks',
  });
  const evEmpty = rt.evaluateGoalCompletionForId(TEST_ROOT, project, gEmpty.goalId);
  check(!evEmpty.eligible, 'B2-23 zero-task Goal not eligible');

  const gAbd = await gt.createGoal(TEST_ROOT, project, {
    title: 'Abd', goalStatement: 'abandoned semantics',
  });
  rt.transitionGoalStatus(TEST_ROOT, project, gAbd.goalId, 'ACTIVE');
  const keep = await gt.createTask(TEST_ROOT, project, {
    goalId: gAbd.goalId, title: 'keep', goal: 'g', reason: 'r', scope: 's',
  });
  const drop = await gt.createTask(TEST_ROOT, project, {
    goalId: gAbd.goalId, title: 'drop', goal: 'g', reason: 'r', scope: 's',
    executionState: 'CANCELLED', pmState: 'PENDING',
  });
  const { runId: keepRun } = await driveToResultReceived(keep.taskId, 'KeepA');
  rt.acceptResult(TEST_ROOT, project, keep.taskId, keepRun);
  const evAbd = rt.evaluateGoalCompletionForId(TEST_ROOT, project, gAbd.goalId);
  check(evAbd.eligible && evAbd.abandonedTasks.includes(drop.taskId), 'B2-24 abandoned CANCELLED excluded; remaining ACCEPTED eligible');

  let rejectComplete = false;
  try { rt.completeGoal(TEST_ROOT, project, goal.goalId); }
  catch { rejectComplete = true; }
  check(rejectComplete, 'B2-25 goal:complete rejects if ineligible');

  const completed = rt.completeGoal(TEST_ROOT, project, g2.goalId);
  check(completed.status === 'COMPLETED', 'B2-26 legal Goal complete succeeds');

  const reopened = rt.transitionGoalStatus(TEST_ROOT, project, g2.goalId, 'ACTIVE');
  check(reopened.status === 'ACTIVE', 'B2-27 reopen COMPLETED→ACTIVE');
  const stillTasks = gt.listTasks(TEST_ROOT, project, g2.goalId);
  check(stillTasks.length === 2 && stillTasks.every((t) => t.pmState === 'ACCEPTED'), 'B2-27 reopen preserves Tasks');

  // ── Runtime state lists ───────────────────────────────────────────────────
  console.log('B2-28..30) runtime state');
  const g3 = await gt.createGoal(TEST_ROOT, project, {
    title: 'RuntimeSnap', goalStatement: 'lists',
  });
  rt.transitionGoalStatus(TEST_ROOT, project, g3.goalId, 'ACTIVE');
  const r1 = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'ready1', goal: 'g', reason: 'r', scope: 's',
  });
  const r2 = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'ready2', goal: 'g', reason: 'r', scope: 's',
  });
  const rWait = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'waiter', goal: 'g', reason: 'r', scope: 's',
    dependencies: [r1.taskId],
  });
  const rWork = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'worker', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const rBlk = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'blocked', goal: 'g', reason: 'r', scope: 's',
    executionState: 'BLOCKED', pmState: 'PENDING',
  });
  const rVer = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'verifying', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING',
  });
  const rAcc = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'accepted', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'ACCEPTED',
  });
  rt.refreshTaskReadiness(TEST_ROOT, project, r1.taskId);
  rt.refreshTaskReadiness(TEST_ROOT, project, r2.taskId);

  const snap = rt.getGoalRuntimeState(TEST_ROOT, project, g3.goalId);
  const ctx = rt.buildGoalRuntimeContext(TEST_ROOT, project, g3.goalId);
  check(snap.readyTasks.length === 2, `B2-28/30 readyTasks=${snap.readyTasks.length}`);
  check(snap.workingTasks.some((t) => t.taskId === rWork.taskId), 'B2-28 workingTasks');
  check(snap.blockedTasks.some((t) => t.taskId === rBlk.taskId), 'B2-28 blockedTasks');
  check(snap.verifyingTasks.some((t) => t.taskId === rVer.taskId), 'B2-28 verifyingTasks');
  check(snap.acceptedTasks.some((t) => t.taskId === rAcc.taskId), 'B2-28 acceptedTasks');
  check(snap.waitingDependencyTasks.some((t) => t.taskId === rWait.taskId), 'B2-29 waitingDependencyTasks');
  check(
    snap.readyTasks.map((t) => t.taskId).sort().join(',') === [r1.taskId, r2.taskId].sort().join(','),
    'B2-30 parallel ready Tasks surfaced together',
  );
  check(ctx.tasks.every((t) => !('prompt' in t) && !('result' in t)), 'PM context has no Prompt/Result bodies');
  check(snap.completionEligibility && snap.progress, 'runtime includes progress + eligibility');

  // ── B1 / Phase A regressions ──────────────────────────────────────────────
  console.log('B2-31..35) regressions');
  const malformedDir = gt.taskFolder(TEST_ROOT, project, 'TASK-9999');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, 'task.json'), '{not-json', 'utf8');
  const listed = gt.listTasksWithDiagnostics(TEST_ROOT, project, g3.goalId);
  check(listed.tasks.every((t) => t.goalId === g3.goalId), 'B2-31 malformed unrelated Task isolated');
  check(listed.warnings.some((w) => w.includes('TASK-9999')) || gt.getTasksDiagnostics(TEST_ROOT, project).some((w) => w.includes('TASK-9999')), 'B2-31 warning recorded');

  // schema migration
  const migGoal = await gt.createGoal(TEST_ROOT, project, { title: 'mig', goalStatement: 'm' });
  const migId = 'TASK-8888';
  const migFolder = gt.taskFolder(TEST_ROOT, project, migId);
  fs.mkdirSync(migFolder, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(migFolder, 'task.json'), JSON.stringify({
    schemaVersion: 1,
    taskId: migId,
    goalId: migGoal.goalId,
    project,
    title: 'legacy',
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: [],
    status: 'VERIFYING',
    dependencies: [],
    linkedRuns: [],
    createdAt: ts,
    updatedAt: ts,
  }, null, 2), 'utf8');
  const migrated = gt.getTask(TEST_ROOT, project, migId);
  check(migrated.schemaVersion === 2 && migrated.executionState === 'RESULT_RECEIVED' && migrated.pmState === 'VERIFYING', 'B2-32 schema migration regression');

  // runId / linkage / monotonic
  const linkTask = await gt.createTask(TEST_ROOT, project, {
    goalId: migGoal.goalId, title: 'link', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: L1 } = await linkFreshRun(linkTask.taskId, 'L1');
  const { runId: L2 } = await linkFreshRun(linkTask.taskId, 'L2');
  const linked = gt.getTask(TEST_ROOT, project, linkTask.taskId);
  const seqs = linked.linkedRuns.map((x) => x.taskRunSequence).sort((a, b) => a - b);
  check(seqs[0] === 1 && seqs[1] === 2 && L1 !== L2, 'B2-33/34 runId linkage + monotonic sequence');
  check(linked.nextTaskRunSequence === 3, 'B2-34 nextTaskRunSequence=3');

  // Phase A smoke: materialize + ensureRunId still works
  const pa = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'PhaseA');
  check(typeof pa.runId === 'string' && pa.runId.length > 8, 'B2-35 Phase A materialize runId');
  check(fs.existsSync(path.join(pa.folder, 'meta.json')), 'B2-35 Phase A meta.json exists');

  // Bypass guards
  let bypassExec = false;
  try { gt.updateTask(TEST_ROOT, project, linkTask.taskId, { executionState: 'RUNNING' }); }
  catch { bypassExec = true; }
  check(bypassExec, 'updateTask rejects raw executionState');
  let bypassGoal = false;
  try { gt.updateGoal(TEST_ROOT, project, g3.goalId, { status: 'COMPLETED' }); }
  catch { bypassGoal = true; }
  check(bypassGoal, 'updateGoal rejects raw status');

  console.log('\nB2 runtime tests done. exitCode=' + (process.exitCode || 0));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
