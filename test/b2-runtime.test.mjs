/**
 * Phase B2 runtime + architecture addendum (CAS, derived deps, requestRetry).
 * Temporary DATA_ROOT only. Covers B2-01..35 and C1..C11.
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
    t = await rt.refreshTaskReadiness(TEST_ROOT, project, taskId);
    if (t.executionState === 'PLANNED') {
      t = await rt.transitionTaskExecution(TEST_ROOT, project, taskId, {
        expectedExecutionState: 'PLANNED', to: 'READY',
      });
    }
  }
  if (t.executionState === 'READY') {
    t = await rt.transitionTaskExecution(TEST_ROOT, project, taskId, {
      expectedExecutionState: 'READY', to: 'DISPATCHED',
    });
  }
  if (t.executionState === 'DISPATCHED') {
    t = await rt.transitionTaskExecution(TEST_ROOT, project, taskId, {
      expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
    });
  }
  const { runId } = await linkFreshRun(taskId, agent);
  t = await rt.markResultReceived(TEST_ROOT, project, taskId, runId, {
    expectedExecutionState: 'RUNNING',
  });
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

  // ── Readiness / dependencies (derived) ────────────────────────────────────
  console.log('B2-01..06) readiness & blocking');
  const tA = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'A', goal: 'g', reason: 'r', scope: 's',
  });
  const readyA0 = rt.getTaskReadiness(tA, [tA]);
  check(readyA0.isEligibleForReady && readyA0.kind === 'PLANNED', 'B2-01 zero-dep isEligibleForReady');
  const aReady = await rt.refreshTaskReadiness(TEST_ROOT, project, tA.taskId);
  check(aReady.executionState === 'READY', 'B2-01 zero-dep refresh → READY');

  const tB = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'B', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tA.taskId],
  });
  const bRead = rt.getTaskReadinessForId(TEST_ROOT, project, tB.taskId);
  check(bRead.kind === 'WAITING_DEPENDENCIES', 'B2-02 unsatisfied dep → WAITING_DEPENDENCIES derived');
  check(!bRead.isEligibleForReady, 'B2-02 not eligible for READY');
  const bRefresh = await rt.refreshTaskReadiness(TEST_ROOT, project, tB.taskId);
  check(bRefresh.executionState === 'PLANNED', 'B2-02 refresh does not force READY');

  // Accept A — must NOT auto-mutate B
  const { runId: aRun } = await driveToResultReceived(tA.taskId, 'AgentA');
  const aAccepted = await rt.acceptResult(TEST_ROOT, project, tA.taskId, aRun, {
    goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  check(aAccepted.pmState === 'ACCEPTED', 'accept A');
  const bAfterAccept = gt.getTask(TEST_ROOT, project, tB.taskId);
  check(bAfterAccept.executionState === 'PLANNED', 'B2-03/C9 ACCEPTED dep does NOT auto-mutate dependent');
  const bDerived = rt.getTaskReadinessForId(TEST_ROOT, project, tB.taskId);
  check(bDerived.isEligibleForReady && bDerived.dependenciesSatisfied, 'B2-03 derived eligible after dep ACCEPTED');
  const bPromoted = await rt.refreshTaskReadiness(TEST_ROOT, project, tB.taskId);
  check(bPromoted.executionState === 'READY', 'B2-03 explicit refresh promotes dependent');

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

  // FAILED dependency — no auto BLOCK on dependent
  const tE = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'E', goal: 'g', reason: 'r', scope: 's',
    executionState: 'FAILED', pmState: 'PENDING',
  });
  const tF = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'F', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tE.taskId],
  });
  const fRead = rt.getTaskReadinessForId(TEST_ROOT, project, tF.taskId);
  check(fRead.kind === 'WAITING_DEPENDENCIES' && fRead.blockedBy.includes(tE.taskId), 'B2-05 FAILED dep not satisfied');
  check(gt.getTask(TEST_ROOT, project, tF.taskId).executionState === 'PLANNED', 'C10 FAILED does not auto-BLOCK dependent');

  const tG = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'G', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tA.taskId],
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, tG.taskId);
  const tH = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'H wait C', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tC.taskId],
  });
  const hWait = rt.getTaskReadinessForId(TEST_ROOT, project, tH.taskId);
  check(hWait.kind === 'WAITING_DEPENDENCIES', 'B2-06 waiting ≠ BLOCKED');
  const gBlocked = await rt.transitionTaskExecution(TEST_ROOT, project, tG.taskId, {
    expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'owner decision',
  });
  check(gBlocked.executionState === 'BLOCKED' && gBlocked.blockedReason === 'owner decision', 'B2-06 explicit BLOCKED');

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
  check(cycle2, 'B2-07 direct cycle rejected');

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

  // ── Execution / PM / requestRetry ─────────────────────────────────────────
  console.log('B2-10..20) transitions + requestRetry');
  const tFlow = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Flow', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, tFlow.taskId);
  await rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
  });
  const { runId: flowRun } = await linkFreshRun(tFlow.taskId, 'FlowAgent');
  await rt.markResultReceived(TEST_ROOT, project, tFlow.taskId, flowRun, {
    expectedExecutionState: 'RUNNING',
  });
  check(gt.getTask(TEST_ROOT, project, tFlow.taskId).executionState === 'RESULT_RECEIVED', 'B2-10 legal execution path');

  let illegalExec = false;
  try {
    await rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, {
      expectedExecutionState: 'RESULT_RECEIVED', to: 'DISPATCHED',
    });
  } catch { illegalExec = true; }
  check(illegalExec, 'B2-11 RESULT_RECEIVED→DISPATCHED rejected (use requestRetry)');

  await rt.requestChanges(TEST_ROOT, project, tFlow.taskId, flowRun, {
    goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'nits: please address',
  });
  check(gt.getTask(TEST_ROOT, project, tFlow.taskId).pmState === 'CHANGES_REQUESTED', 'B2-12 requestChanges');

  const retried = await rt.requestRetry(TEST_ROOT, project, tFlow.taskId, {
    goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  check(
    retried.executionState === 'READY' && retried.pmState === 'PENDING' && (retried.retryCount ?? 0) >= 1,
    'B2-20/C7 requestRetry → READY+PENDING',
  );
  const runsBeforeRetryDispatch = retried.linkedRuns.length;
  await rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, tFlow.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
  });
  const { runId: flowRun2 } = await linkFreshRun(tFlow.taskId, 'FlowAgent2');
  await rt.markResultReceived(TEST_ROOT, project, tFlow.taskId, flowRun2, {
    expectedExecutionState: 'RUNNING',
  });
  const afterRetry = gt.getTask(TEST_ROOT, project, tFlow.taskId);
  check(afterRetry.linkedRuns.length === runsBeforeRetryDispatch + 1, 'C8 old Runs preserved + new attempt');
  check(afterRetry.pmState === 'VERIFYING', 'new result → VERIFYING');

  let illegalPm = false;
  try {
    await rt.transitionTaskPm(TEST_ROOT, project, tFlow.taskId, {
      expectedPmState: 'VERIFYING', to: 'PENDING',
    });
  } catch { illegalPm = true; }
  check(illegalPm, 'B2-13 illegal PM VERIFYING→PENDING rejected');

  const tAcc = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'AcceptMe', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: accRun } = await driveToResultReceived(tAcc.taskId, 'AccAgent');
  const afterResult = gt.getTask(TEST_ROOT, project, tAcc.taskId);
  check(afterResult.executionState === 'RESULT_RECEIVED' && afterResult.pmState !== 'ACCEPTED', 'B2-14 RESULT ≠ ACCEPTED');

  let badLink = false;
  try {
    await rt.acceptResult(TEST_ROOT, project, tAcc.taskId, 'not-linked-run', {
      goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    });
  } catch { badLink = true; }
  check(badLink, 'B2-15 acceptResult requires linked run');

  const tEarly = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Early', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, tEarly.taskId);
  const { runId: earlyRun } = await linkFreshRun(tEarly.taskId, 'EarlyAgent');
  let badState = false;
  try {
    await rt.acceptResult(TEST_ROOT, project, tEarly.taskId, earlyRun, {
      goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    });
  } catch { badState = true; }
  check(badState, 'B2-16 acceptResult requires RESULT_RECEIVED');

  const accepted = await rt.acceptResult(TEST_ROOT, project, tAcc.taskId, accRun, {
    goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  check(accepted.pmState === 'ACCEPTED' && accepted.acceptedRunId === accRun, 'B2-17 accept sets fields');
  let repeatedConflict = false;
  try {
    await rt.acceptResult(TEST_ROOT, project, tAcc.taskId, accRun, {
      goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    });
  } catch (e) { repeatedConflict = String(e.message).includes('CONFLICT'); }
  check(repeatedConflict, 'B2-18 repeated acceptResult with stale CAS now CONFLICTs (no silent retry, I3F-2)');

  const tCh = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title: 'Changes', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: chRun1 } = await driveToResultReceived(tCh.taskId, 'Ch1');
  const beforeRuns = gt.getTask(TEST_ROOT, project, tCh.taskId).linkedRuns.length;
  await rt.requestChanges(TEST_ROOT, project, tCh.taskId, chRun1, {
    goalId: goal.goalId, reason: 'please fix', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const afterCh = gt.getTask(TEST_ROOT, project, tCh.taskId);
  check(afterCh.pmState === 'CHANGES_REQUESTED' && afterCh.linkedRuns.length === beforeRuns, 'B2-19 requestChanges preserves Runs');
  let chReplayConflict = false;
  try {
    await rt.requestChanges(TEST_ROOT, project, tCh.taskId, chRun1, {
      goalId: goal.goalId, reason: 'please fix', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    });
  } catch (e) { chReplayConflict = String(e.message).includes('CONFLICT'); }
  check(chReplayConflict, 'requestChanges stale CAS replay now CONFLICTs (no silent retry, I3F-2)');

  // ── Goal completion (no auto-write) ───────────────────────────────────────
  console.log('B2-21..27 / C11) goal completion');
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
  check(!ev.eligible, 'B2-21 unfinished → not eligible');

  const { runId: c1run } = await driveToResultReceived(c1.taskId, 'C1a');
  await rt.acceptResult(TEST_ROOT, project, c1.taskId, c1run, {
    goalId: g2.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const { runId: c2run } = await driveToResultReceived(c2.taskId, 'C2a');
  await rt.acceptResult(TEST_ROOT, project, c2.taskId, c2run, {
    goalId: g2.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  ev = rt.evaluateGoalCompletionForId(TEST_ROOT, project, g2.goalId);
  check(ev.eligible && ev.acceptedTasks === 2, 'B2-22 all ACCEPTED → eligible');
  check(gt.getGoal(TEST_ROOT, project, g2.goalId).status === 'ACTIVE', 'C11 all ACCEPTED does NOT auto-write COMPLETED');

  const gEmpty = await gt.createGoal(TEST_ROOT, project, {
    title: 'Empty', goalStatement: 'no tasks',
  });
  check(!rt.evaluateGoalCompletionForId(TEST_ROOT, project, gEmpty.goalId).eligible, 'B2-23 zero-task not eligible');

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
  await rt.acceptResult(TEST_ROOT, project, keep.taskId, keepRun, {
    goalId: gAbd.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const evAbd = rt.evaluateGoalCompletionForId(TEST_ROOT, project, gAbd.goalId);
  check(evAbd.eligible && evAbd.abandonedTasks.includes(drop.taskId), 'B2-24 abandoned semantics');

  let rejectComplete = false;
  try { rt.completeGoal(TEST_ROOT, project, goal.goalId); }
  catch { rejectComplete = true; }
  check(rejectComplete, 'B2-25 goal:complete rejects if ineligible');

  const completed = rt.completeGoal(TEST_ROOT, project, g2.goalId);
  check(completed.status === 'COMPLETED', 'B2-26 legal Goal complete');
  const reopened = rt.transitionGoalStatus(TEST_ROOT, project, g2.goalId, 'ACTIVE');
  check(reopened.status === 'ACTIVE' && gt.listTasks(TEST_ROOT, project, g2.goalId).length === 2, 'B2-27 reopen preserves Tasks');

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
  await rt.refreshTaskReadiness(TEST_ROOT, project, r1.taskId);
  await rt.refreshTaskReadiness(TEST_ROOT, project, r2.taskId);
  const snap = rt.getGoalRuntimeState(TEST_ROOT, project, g3.goalId);
  check(snap.readyTasks.length === 2, `B2-28/30 readyTasks=${snap.readyTasks.length}`);
  check(snap.workingTasks.some((t) => t.taskId === rWork.taskId), 'B2-28 working');
  check(snap.blockedTasks.some((t) => t.taskId === rBlk.taskId), 'B2-28 blocked');
  check(snap.verifyingTasks.some((t) => t.taskId === rVer.taskId), 'B2-28 verifying');
  check(snap.acceptedTasks.some((t) => t.taskId === rAcc.taskId), 'B2-28 accepted');
  check(snap.waitingDependencyTasks.some((t) => t.taskId === rWait.taskId), 'B2-29 waiting');
  check(snap.tasks.every((t) => typeof t.isEligibleForReady === 'boolean'), 'isEligibleForReady present');

  // ── Regressions ───────────────────────────────────────────────────────────
  console.log('B2-31..35) regressions');
  const malformedDir = gt.taskFolder(TEST_ROOT, project, 'TASK-9999');
  fs.mkdirSync(malformedDir, { recursive: true });
  fs.writeFileSync(path.join(malformedDir, 'task.json'), '{not-json', 'utf8');
  const listed = gt.listTasksWithDiagnostics(TEST_ROOT, project, g3.goalId);
  check(listed.tasks.every((t) => t.goalId === g3.goalId), 'B2-31 read isolation');
  check(gt.getTasksDiagnostics(TEST_ROOT, project).some((w) => w.includes('TASK-9999')), 'B2-31 warning');

  const migGoal = await gt.createGoal(TEST_ROOT, project, { title: 'mig', goalStatement: 'm' });
  const migId = 'TASK-8888';
  const migFolder = gt.taskFolder(TEST_ROOT, project, migId);
  fs.mkdirSync(migFolder, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(migFolder, 'task.json'), JSON.stringify({
    schemaVersion: 1, taskId: migId, goalId: migGoal.goalId, project,
    title: 'legacy', goal: 'g', reason: 'r', scope: 's', completionCriteria: [],
    status: 'VERIFYING', dependencies: [], linkedRuns: [], createdAt: ts, updatedAt: ts,
  }, null, 2), 'utf8');
  const migrated = gt.getTask(TEST_ROOT, project, migId);
  check(migrated.schemaVersion === 2 && migrated.pmState === 'VERIFYING', 'B2-32 schema migration');

  const linkTask = await gt.createTask(TEST_ROOT, project, {
    goalId: migGoal.goalId, title: 'link', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: L1 } = await linkFreshRun(linkTask.taskId, 'L1');
  const { runId: L2 } = await linkFreshRun(linkTask.taskId, 'L2');
  const linked = gt.getTask(TEST_ROOT, project, linkTask.taskId);
  check(linked.nextTaskRunSequence === 3 && L1 !== L2, 'B2-33/34 linkage + monotonic');

  const pa = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'PhaseA');
  check(typeof pa.runId === 'string' && fs.existsSync(path.join(pa.folder, 'meta.json')), 'B2-35 Phase A');

  let bypassExec = false;
  try { gt.updateTask(TEST_ROOT, project, linkTask.taskId, { executionState: 'RUNNING' }); }
  catch { bypassExec = true; }
  check(bypassExec, 'privileged task:update rejects executionState');

  // ── Concurrency / CAS races C1–C11 ────────────────────────────────────────
  console.log('C1..C11) CAS + race safety');
  const gRace = await gt.createGoal(TEST_ROOT, project, { title: 'Race', goalStatement: 'cas' });
  const tRace = await gt.createTask(TEST_ROOT, project, {
    goalId: gRace.goalId, title: 'race', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: raceRun } = await driveToResultReceived(tRace.taskId, 'RaceAgent');
  check(gt.getTask(TEST_ROOT, project, tRace.taskId).pmState === 'VERIFYING', 'race setup VERIFYING');

  // C1: acceptResult vs requestChanges — serialized; one full winner
  const c1results = await Promise.allSettled([
    rt.acceptResult(TEST_ROOT, project, tRace.taskId, raceRun, {
      goalId: gRace.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    }),
    rt.requestChanges(TEST_ROOT, project, tRace.taskId, raceRun, {
      goalId: gRace.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'race condition test reason',
    }),
  ]);
  const c1ok = c1results.filter((r) => r.status === 'fulfilled').length;
  const c1fail = c1results.filter((r) => r.status === 'rejected').length;
  check(c1ok === 1 && c1fail === 1, `C1 accept vs requestChanges one winner (ok=${c1ok} fail=${c1fail})`);
  const raceFinal = gt.getTask(TEST_ROOT, project, tRace.taskId);
  const consistent =
    (raceFinal.pmState === 'ACCEPTED' && raceFinal.acceptedRunId === raceRun)
    || (raceFinal.pmState === 'CHANGES_REQUESTED' && !raceFinal.acceptedRunId);
  check(consistent, `C1 no partial mixed state pm=${raceFinal.pmState}`);

  // C2 markResultReceived replay
  const tMark = await gt.createTask(TEST_ROOT, project, {
    goalId: gRace.goalId, title: 'mark', goal: 'g', reason: 'r', scope: 's',
  });
  const { runId: markRun } = await driveToResultReceived(tMark.taskId, 'MarkA');
  const m1 = await rt.markResultReceived(TEST_ROOT, project, tMark.taskId, markRun);
  const m2 = await rt.markResultReceived(TEST_ROOT, project, tMark.taskId, markRun);
  check(m1.executionState === 'RESULT_RECEIVED' && m2.executionState === 'RESULT_RECEIVED', 'C2 markResultReceived idempotent');

  // C3 same transition replay
  await rt.refreshTaskReadiness(TEST_ROOT, project, (
    await gt.createTask(TEST_ROOT, project, {
      goalId: gRace.goalId, title: 'replay', goal: 'g', reason: 'r', scope: 's',
    })
  ).taskId);
  // recreate properly
  const tRep = await gt.createTask(TEST_ROOT, project, {
    goalId: gRace.goalId, title: 'replay2', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, tRep.taskId);
  const tr1 = await rt.transitionTaskExecution(TEST_ROOT, project, tRep.taskId, {
    expectedExecutionState: 'READY', to: 'READY',
  });
  const tr2 = await rt.transitionTaskExecution(TEST_ROOT, project, tRep.taskId, {
    expectedExecutionState: 'READY', to: 'READY',
  });
  check(tr1.executionState === 'READY' && tr2.executionState === 'READY', 'C3 identical transition replay deterministic');

  // C4 stale expectedExecutionState
  let c4 = false;
  const beforeC4 = gt.getTask(TEST_ROOT, project, tRep.taskId).updatedAt;
  try {
    await rt.transitionTaskExecution(TEST_ROOT, project, tRep.taskId, {
      expectedExecutionState: 'PLANNED', to: 'DISPATCHED',
    });
  } catch (e) {
    c4 = String(e.message).includes('CONFLICT');
  }
  check(c4 && gt.getTask(TEST_ROOT, project, tRep.taskId).updatedAt === beforeC4, 'C4 stale expectedExecutionState rejected, no write');

  // C5 stale expectedPmState
  let c5 = false;
  const beforeC5 = gt.getTask(TEST_ROOT, project, tMark.taskId);
  try {
    await rt.transitionTaskPm(TEST_ROOT, project, tMark.taskId, {
      expectedPmState: 'PENDING', to: 'ACCEPTED', acceptedRunId: markRun,
    });
  } catch (e) {
    c5 = String(e.message).includes('CONFLICT');
  }
  check(c5 && gt.getTask(TEST_ROOT, project, tMark.taskId).pmState === beforeC5.pmState, 'C5 stale expectedPmState rejected');

  // C6 refresh racing dependency acceptance — no corruption
  const tDep = await gt.createTask(TEST_ROOT, project, {
    goalId: gRace.goalId, title: 'depParent', goal: 'g', reason: 'r', scope: 's',
  });
  const tChild = await gt.createTask(TEST_ROOT, project, {
    goalId: gRace.goalId, title: 'depChild', goal: 'g', reason: 'r', scope: 's',
    dependencies: [tDep.taskId],
  });
  const { runId: depRun } = await driveToResultReceived(tDep.taskId, 'DepP');
  await Promise.all([
    rt.acceptResult(TEST_ROOT, project, tDep.taskId, depRun, {
      goalId: gRace.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
    }),
    rt.refreshTaskReadiness(TEST_ROOT, project, tChild.taskId),
  ]);
  const childAfter = gt.getTask(TEST_ROOT, project, tChild.taskId);
  const childReady = rt.getTaskReadinessForId(TEST_ROOT, project, tChild.taskId);
  // Child may still be PLANNED (accept does not cascade) or READY if refresh ran after accept
  check(
    childAfter.executionState === 'PLANNED' || childAfter.executionState === 'READY',
    `C6 no corruption exec=${childAfter.executionState}`,
  );
  check(childReady.dependenciesSatisfied === true, 'C6 derived readiness correct after race');
  await rt.refreshTaskReadiness(TEST_ROOT, project, tChild.taskId);
  check(gt.getTask(TEST_ROOT, project, tChild.taskId).executionState === 'READY', 'C6 retry refresh → READY');

  // C7 requestRetry requires CHANGES_REQUESTED
  let c7 = false;
  try {
    await rt.requestRetry(TEST_ROOT, project, tMark.taskId, {
      goalId: gRace.goalId,
      expectedExecutionState: 'RESULT_RECEIVED',
      expectedPmState: 'CHANGES_REQUESTED',
    });
  } catch (e) {
    c7 = String(e.message).includes('CONFLICT') || String(e.message).includes('CHANGES_REQUESTED');
  }
  check(c7, 'C7 requestRetry requires CHANGES_REQUESTED');

  // C8 already covered above with flow retry + new run

  // C9/C10 covered above

  // C11 covered above

  console.log('\nB2 runtime + addendum tests done. exitCode=' + (process.exitCode || 0));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
