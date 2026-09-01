/**
 * Phase I3 — Pre-CLI Stabilization: Goal activation + PM-work consistency (GOAL-01..GOAL-05).
 *
 * GOAL-01: activateGoal transitions PLANNING → ACTIVE.
 * GOAL-02: activateGoal CAS conflict → RuntimeConflictError when status ≠ PLANNING.
 * GOAL-03: getNextWork does NOT emit GOAL_COMPLETION for PLANNING goals (even when all tasks accepted).
 * GOAL-04: getNextWork DOES emit GOAL_COMPLETION for ACTIVE goals (all tasks accepted).
 * GOAL-05: relay_pm_complete_goal (completeGoalWithExpected) still works for ACTIVE goals.
 *
 * Run `npm run build:server` before this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-i3-goal-${process.pid}-${Date.now()}`);
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
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (fragment && !(msg.includes(fragment) || code === fragment || String(code).includes(fragment))) {
      FAIL(`${label} — expected "${fragment}" in error, got: ${code || ''} ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const pmWork = await import('../dist/server/backend/pm-work.js');

const dataRoot = path.join(TEST_ROOT, 'data');
const project = 'GoalProj';

// ── GOAL-01: activateGoal transitions PLANNING → ACTIVE ──────────────────────
console.log('\n-- GOAL-01: activateGoal PLANNING -> ACTIVE');
{
  const goal = await gt.createGoal(dataRoot, project, {
    title: 'Goal activation test',
    goalStatement: 'Test PLANNING to ACTIVE transition',
    completionCriteria: ['criterion A'],
    permissionPolicy: { mode: 'APPROVE' },
  });
  check(goal.status === 'PLANNING', 'GOAL-01 newly created goal is in PLANNING');

  const activated = rt.activateGoal(dataRoot, project, goal.goalId, {
    expectedGoalStatus: 'PLANNING',
  });
  check(activated.status === 'ACTIVE', 'GOAL-01 activateGoal returns ACTIVE goal');
  check(activated.goalId === goal.goalId, 'GOAL-01 activated goalId matches');

  const reread = gt.getGoal(dataRoot, project, goal.goalId);
  check(reread.status === 'ACTIVE', 'GOAL-01 persisted goal.status === ACTIVE');
}

// ── GOAL-02: activateGoal CAS conflict ───────────────────────────────────────
console.log('\n-- GOAL-02: activateGoal CAS conflict (not PLANNING)');
{
  const goal = await gt.createGoal(dataRoot, project, {
    title: 'CAS conflict test',
    goalStatement: 'Test CAS guard on activateGoal',
    completionCriteria: [],
  });
  // Activate once: PLANNING → ACTIVE
  rt.activateGoal(dataRoot, project, goal.goalId, { expectedGoalStatus: 'PLANNING' });

  // Try to activate again — status is now ACTIVE, not PLANNING → CONFLICT
  await shouldThrow(
    async () => rt.activateGoal(dataRoot, project, goal.goalId, { expectedGoalStatus: 'PLANNING' }),
    'GOAL-02 activateGoal on ACTIVE goal throws CONFLICT',
    'CONFLICT',
  );
}

// ── GOAL-03: getNextWork does NOT emit GOAL_COMPLETION for PLANNING ──────────
console.log('\n-- GOAL-03: PLANNING goal not in GOAL_COMPLETION work items');
{
  const goal = await gt.createGoal(dataRoot, project, {
    title: 'Planning goal completion guard',
    goalStatement: 'Should never appear as GOAL_COMPLETION',
    completionCriteria: [],
    permissionPolicy: { mode: 'APPROVE' },
  });
  check(goal.status === 'PLANNING', 'GOAL-03 goal is PLANNING');

  // Create an ACCEPTED task so evaluateGoalCompletion returns eligible=true.
  // Without the PLANNING guard fix in pm-work.ts, this PLANNING goal WOULD
  // appear as GOAL_COMPLETION — even though PLANNING→COMPLETED is illegal.
  await gt.createTask(dataRoot, project, {
    goalId: goal.goalId,
    title: 'Accepted task (GOAL-03)',
    goal: 'test',
    reason: '',
    scope: '',
    completionCriteria: [],
    executionState: 'RESULT_RECEIVED',
    pmState: 'ACCEPTED',
  });

  const work = pmWork.getNextWork(dataRoot, project);
  const completionItems = work.items.filter(
    (i) => i.kind === 'GOAL_COMPLETION' && i.goalId === goal.goalId,
  );
  check(completionItems.length === 0, 'GOAL-03 PLANNING goal NOT in GOAL_COMPLETION items');
}

// ── GOAL-04: getNextWork DOES emit GOAL_COMPLETION for ACTIVE goals ──────────
console.log('\n-- GOAL-04: ACTIVE goal (all tasks accepted) in GOAL_COMPLETION');
{
  const goal = await gt.createGoal(dataRoot, project, {
    title: 'Active goal completion',
    goalStatement: 'Should appear as GOAL_COMPLETION when all tasks accepted',
    completionCriteria: [],
    permissionPolicy: { mode: 'APPROVE' },
  });
  rt.activateGoal(dataRoot, project, goal.goalId, { expectedGoalStatus: 'PLANNING' });
  check(gt.getGoal(dataRoot, project, goal.goalId).status === 'ACTIVE', 'GOAL-04 goal is ACTIVE');

  // Create an ACCEPTED task so evaluateGoalCompletion returns eligible=true
  await gt.createTask(dataRoot, project, {
    goalId: goal.goalId,
    title: 'Accepted task (GOAL-04)',
    goal: 'test',
    reason: '',
    scope: '',
    completionCriteria: [],
    executionState: 'RESULT_RECEIVED',
    pmState: 'ACCEPTED',
  });

  const work = pmWork.getNextWork(dataRoot, project);
  const completionItems = work.items.filter(
    (i) => i.kind === 'GOAL_COMPLETION' && i.goalId === goal.goalId,
  );
  check(completionItems.length === 1, 'GOAL-04 ACTIVE goal appears in GOAL_COMPLETION');
  check(
    completionItems[0]?.cas?.expectedGoalStatus === 'ACTIVE',
    'GOAL-04 CAS expectedGoalStatus === ACTIVE',
  );
}

// ── GOAL-05: completeGoalWithExpected still works for ACTIVE goals ───────────
console.log('\n-- GOAL-05: completeGoalWithExpected unchanged for ACTIVE goals');
{
  const goal = await gt.createGoal(dataRoot, project, {
    title: 'Complete via CAS',
    goalStatement: 'Test completion of ACTIVE goal',
    completionCriteria: [],
    permissionPolicy: { mode: 'APPROVE' },
  });
  rt.activateGoal(dataRoot, project, goal.goalId, { expectedGoalStatus: 'PLANNING' });

  // Need an accepted task for eligibility
  await gt.createTask(dataRoot, project, {
    goalId: goal.goalId,
    title: 'Accepted task (GOAL-05)',
    goal: 'test',
    reason: '',
    scope: '',
    completionCriteria: [],
    executionState: 'RESULT_RECEIVED',
    pmState: 'ACCEPTED',
  });

  const completed = rt.completeGoalWithExpected(dataRoot, project, goal.goalId, {
    expectedGoalStatus: 'ACTIVE',
  });
  check(completed.status === 'COMPLETED', 'GOAL-05 completeGoalWithExpected returns COMPLETED');

  const reread = gt.getGoal(dataRoot, project, goal.goalId);
  check(reread.status === 'COMPLETED', 'GOAL-05 persisted goal.status === COMPLETED');

  // CAS conflict: COMPLETED goal with ACTIVE expectation
  await shouldThrow(
    async () => rt.completeGoalWithExpected(dataRoot, project, goal.goalId, {
      expectedGoalStatus: 'ACTIVE',
    }),
    'GOAL-05 completeGoalWithExpected on COMPLETED goal throws CONFLICT',
    'CONFLICT',
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nGOAL: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
