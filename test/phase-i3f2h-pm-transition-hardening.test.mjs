/**
 * Phase I3F-2H — Legacy PM transition bypass hardening.
 * Permanent regression coverage:
 *   H-01 generic transitionPm -> ACCEPTED rejected
 *   H-02 rejected ACCEPTED does not mutate pmState
 *   H-03 rejected ACCEPTED does not set acceptedRunId
 *   H-04 rejected ACCEPTED emits no TASK_RESULT_ACCEPTED Event
 *   H-05 generic transitionPm -> CHANGES_REQUESTED rejected
 *   H-06 rejected Changes emits no TASK_CHANGES_REQUESTED Event
 *   H-07 canonical Accept still succeeds
 *   H-08 canonical Changes still succeeds
 *   H-09 canonical Retry still succeeds
 *   H-10 Result Bridge / VERIFYING flow remains functional
 *   H-11 PM get_next_work remains functional
 *   H-12 Goal completion flow remains functional
 *
 * Temporary DATA_ROOT only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-phase-i3f2h-${process.pid}-${Date.now()}`);
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

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const evk = await import('../dist/server/backend/event.js');
const pmWork = await import('../dist/server/backend/pm-work.js');

const project = 'I3F2HProj';
relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

const ACCEPT_CAS = { expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING' };

async function makeGoal(mode = 'BYPASS', title = 'I3F2H Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title, goalStatement: 'i3f2h goal', permissionPolicy: { mode },
  });
}

async function linkRun(taskId, agent = 'I3F2HAgent') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, runId: link.runId };
}

/** RESULT_RECEIVED + VERIFYING Task with one linked (current-attempt) Run. */
async function makeVerifyingTask(goalId, title = 'Verifying Task') {
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId, title, goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING',
  });
  const { runId } = await linkRun(t.taskId);
  return { task: gt.getTask(TEST_ROOT, project, t.taskId), runId };
}

// ── H-01..H-04: generic transitionPm -> ACCEPTED blocked ────────────────────
console.log('\n── H-01..H-04 generic transitionPm → ACCEPTED blocked ──');
{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'H1');

  await shouldThrow(
    () => rt.transitionTaskPm(TEST_ROOT, project, task.taskId, {
      expectedPmState: 'VERIFYING', to: 'ACCEPTED', acceptedRunId: runId,
    }),
    'H-01 generic transitionPm -> ACCEPTED rejected (INVALID_STATE)',
    'INVALID_STATE',
  );

  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.pmState === 'VERIFYING', 'H-02 rejected ACCEPTED does not mutate pmState');
  check(after.acceptedRunId === undefined, 'H-03 rejected ACCEPTED does not set acceptedRunId');
  const acceptEvents = evk.listEvents(TEST_ROOT, project, {
    taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED',
  }).events;
  check(acceptEvents.length === 0, 'H-04 rejected ACCEPTED emits no TASK_RESULT_ACCEPTED Event');
}

// ── H-05..H-06: generic transitionPm -> CHANGES_REQUESTED blocked ───────────
console.log('\n── H-05..H-06 generic transitionPm → CHANGES_REQUESTED blocked ──');
{
  const g = await makeGoal();
  const { task } = await makeVerifyingTask(g.goalId, 'H5');

  await shouldThrow(
    () => rt.transitionTaskPm(TEST_ROOT, project, task.taskId, {
      expectedPmState: 'VERIFYING', to: 'CHANGES_REQUESTED', reason: 'bypass attempt',
    }),
    'H-05 generic transitionPm -> CHANGES_REQUESTED rejected (INVALID_STATE)',
    'INVALID_STATE',
  );

  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.pmState === 'VERIFYING', 'H-05 rejected CHANGES_REQUESTED does not mutate pmState');
  const chEvents = evk.listEvents(TEST_ROOT, project, {
    taskId: task.taskId, type: 'TASK_CHANGES_REQUESTED',
  }).events;
  check(chEvents.length === 0, 'H-06 rejected Changes emits no TASK_CHANGES_REQUESTED Event');
}

// ── H-07..H-09: canonical actions still succeed ─────────────────────────────
console.log('\n── H-07..H-09 canonical Accept / Changes / Retry still succeed ──');
{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'H7');
  const accepted = await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, ...ACCEPT_CAS,
  });
  check(accepted.pmState === 'ACCEPTED' && accepted.acceptedRunId === runId,
    'H-07 canonical acceptResult still succeeds');

  // Reopen via generic transition (legitimate lifecycle path) then drive to changes.
  await rt.transitionTaskPm(TEST_ROOT, project, task.taskId, {
    expectedPmState: 'ACCEPTED', to: 'PENDING',
  });
  const reopened = gt.getTask(TEST_ROOT, project, task.taskId);
  check(reopened.pmState === 'PENDING' && reopened.acceptedRunId === undefined,
    'H-10a ACCEPTED -> PENDING reopen via generic transition still works (clears acceptedRunId)');

  const reRun = await linkRun(task.taskId, 'I3F2HAgent2');
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, reRun.runId, {
    expectedExecutionState: 'RESULT_RECEIVED',
  });
  const changed = await rt.requestChanges(TEST_ROOT, project, task.taskId, reRun.runId, {
    goalId: g.goalId, reason: 'hardening fixture: please fix', ...ACCEPT_CAS,
  });
  check(changed.pmState === 'CHANGES_REQUESTED', 'H-08 canonical requestChanges still succeeds');

  const retried = await rt.requestRetry(TEST_ROOT, project, task.taskId, {
    goalId: g.goalId,
    expectedExecutionState: 'RESULT_RECEIVED',
    expectedPmState: 'CHANGES_REQUESTED',
  });
  check(
    retried.executionState === 'READY' && retried.pmState === 'PENDING' && (retried.retryCount ?? 0) >= 1,
    'H-09 canonical requestRetry still succeeds',
  );
}

// ── H-10: Result Bridge / VERIFYING flow remains functional ─────────────────
console.log('\n── H-10 Result Bridge / VERIFYING flow regression ──');
{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'H10', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  check(gt.getTask(TEST_ROOT, project, t.taskId).executionState === 'READY', 'H-10a PLANNED -> READY');
  await rt.transitionTaskExecution(TEST_ROOT, project, t.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, t.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
  });
  const { runId } = await linkRun(t.taskId, 'I3F2HAgent3');
  const afterResult = await rt.markResultReceived(TEST_ROOT, project, t.taskId, runId, {
    expectedExecutionState: 'RUNNING',
  });
  check(
    afterResult.executionState === 'RESULT_RECEIVED' && afterResult.pmState === 'VERIFYING',
    'H-10b markResultReceived -> RESULT_RECEIVED + VERIFYING (bridge flow) works',
  );

  // Generic PENDING -> VERIFYING promotion path (PM work preparation) still allowed.
  const t2 = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'H10b', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'PENDING',
  });
  await linkRun(t2.taskId, 'I3F2HAgent4');
  const promoted = await rt.transitionTaskPm(TEST_ROOT, project, t2.taskId, {
    expectedPmState: 'PENDING', to: 'VERIFYING',
  });
  check(promoted.pmState === 'VERIFYING', 'H-10c generic transitionPm PENDING -> VERIFYING still works');
}



// ── H-11: PM get_next_work remains functional ───────────────────────────────
console.log('\n── H-11 PM get_next_work regression ──');
{
  const nw = pmWork.getNextWork(TEST_ROOT, project);
  check(
    nw && typeof nw === 'object' && Array.isArray(nw.items ?? nw.workItems ?? []),
    'H-11 PM get_next_work returns a result without mutation-surface errors',
  );
}

// ── H-12: Goal completion flow remains functional ───────────────────────────
console.log('\n── H-12 Goal completion regression ──');
{
  const g = await makeGoal('BYPASS', 'I3F2H Complete Goal');
  const { task, runId } = await makeVerifyingTask(g.goalId, 'H12');
  await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, ...ACCEPT_CAS,
  });
  await rt.activateGoal(TEST_ROOT, project, g.goalId, { expectedGoalStatus: 'PLANNING' });
  const completed = await rt.completeGoalWithExpected(TEST_ROOT, project, g.goalId, {
    expectedGoalStatus: 'ACTIVE',
    reason: 'hardening fixture: all accepted',
  });
  check(completed.status === 'COMPLETED', 'H-12 Goal completion flow remains functional');
}

console.log(`\n=== I3F-2H: ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;

