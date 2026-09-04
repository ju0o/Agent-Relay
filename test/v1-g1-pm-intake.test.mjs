/**
 * V1-G1 — PM MCP Single Task Intake regression.
 *
 * Covers:
 *   G1-01  successful relay_pm_create_task intake
 *   G1-02  canonical Task persistence (getTask round-trip)
 *   G1-03  internal Goal/container behavior (deterministic reuse, tagged internal)
 *   G1-04  default Task state READY + PENDING (dispatch-suitable, no auto-dispatch)
 *   G1-05  invalid/missing fields rejected
 *   G1-06  forbidden runtime fields cannot be injected (unknown-field rejection)
 *   G1-07  repeated creation does not corrupt counters/container state
 *   G1-08  structural safety: no raw updateTask/updateGoal, no auto-dispatch/accept/complete
 *   G1-09  concurrent first intake: Promise.all from fresh project yields one container
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g1-${process.pid}-${Date.now()}`);
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
const pmTools = await import('../dist/server/mcp/pm-tools.js');

const project = 'V1G1Proj';
const ctx = { dataRoot: TEST_ROOT, project };
const tools = pmTools.buildAllPmTools(ctx);
const get = (name) => tools.find((t) => t.name === name);
const CONTRACT = {
  title: 'V1 intake task',
  goal: 'Intended outcome for V1 worker',
  reason: 'PM finalized contract reason',
  scope: 'Narrow V1 scope',
  completionCriteria: ['done when worker result received'],
};

// G1-01: successful intake
console.log('\n-- G1-01: successful intake --');
let first;
{
  const res = await get('relay_pm_create_task').handler({ ...CONTRACT });
  first = res;
  check(res && res.task && res.task.taskId.startsWith('TASK-'), 'G1-01 intake returns canonical taskId');
  check(res && res.goal && res.goal.goalId.startsWith('GOAL-'), 'G1-01 intake returns container goalId');
  check(res.containerReused === false, 'G1-01 first intake creates container (reused=false)');
}

// G1-02: canonical persistence
console.log('\n-- G1-02: canonical persistence --');
{
  const reread = gt.getTask(TEST_ROOT, project, first.task.taskId);
  check(reread.title === CONTRACT.title, 'G1-02 persisted title matches contract');
  check(reread.goal === CONTRACT.goal, 'G1-02 persisted goal matches contract');
  check(reread.goalId === first.goal.goalId, 'G1-02 persisted goalId points at container');
  const rgoal = gt.getGoal(TEST_ROOT, project, first.goal.goalId);
  check(rgoal.goalId === first.goal.goalId, 'G1-02 container goal persists');
}

// G1-03: container behavior
console.log('\n-- G1-03: container behavior --');
{
  check(
    Array.isArray(first.goal.tags) && first.goal.tags.includes('v1-internal'),
    'G1-03 container is tagged v1-internal',
  );
  const second = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 second task' });
  check(second.goal.goalId === first.goal.goalId, 'G1-03 second intake reuses same container');
  check(second.containerReused === true, 'G1-03 second intake reports reused=true');
  const goals = gt.listGoals(TEST_ROOT, project).filter((g) =>
    (g.tags ?? []).includes('v1-internal'),
  );
  check(goals.length === 1, `G1-03 exactly one internal container (got ${goals.length})`);
}

// G1-04: default state
console.log('\n-- G1-04: default state --');
{
  const t = gt.getTask(TEST_ROOT, project, first.task.taskId);
  check(t.executionState === 'READY', `G1-04 executionState is READY (got ${t.executionState})`);
  check(t.pmState === 'PENDING', `G1-04 pmState is PENDING (got ${t.pmState})`);
  check(t.linkedRuns.length === 0, 'G1-04 no auto-dispatch (no linked runs)');
  check(t.acceptedRunId === undefined, 'G1-04 no auto-accept (no acceptedRunId)');
}

// G1-05: invalid/missing fields rejected
console.log('\n-- G1-05: invalid fields --');
{
  await shouldThrow(
    () => get('relay_pm_create_task').handler({ goal: 'g', reason: 'r', scope: 's' }),
    'G1-05 missing title rejected',
    'title',
  );
  await shouldThrow(
    () => get('relay_pm_create_task').handler({ title: 't', goal: '   ', reason: 'r', scope: 's' }),
    'G1-05 blank goal rejected',
    'goal',
  );
  await shouldThrow(
    () => get('relay_pm_create_task').handler({ ...CONTRACT, completionCriteria: 'done' }),
    'G1-05 non-array completionCriteria rejected',
    'completionCriteria',
  );
  await shouldThrow(
    () => get('relay_pm_create_task').handler({ ...CONTRACT, completionCriteria: [42] }),
    'G1-05 non-string criterion rejected',
    'completionCriteria',
  );
}

// G1-06: forbidden runtime fields cannot be injected
console.log('\n-- G1-06: forbidden fields --');
{
  for (const field of ['goalId', 'executionState', 'pmState', 'runId', 'acceptedRunId', 'linkedRuns', 'workspaceRoot', 'folder']) {
    await shouldThrow(
      () => get('relay_pm_create_task').handler({ ...CONTRACT, [field]: 'INJECT' }),
      `G1-06 forbidden field ${field} rejected`,
      field,
    );
  }
  // Tool surface itself exposes no raw mutation / auto lifecycle tools beyond pre-existing ones
  const names = tools.map((t) => t.name);
  check(!names.some((n) => n.includes('update_task') || n.includes('update_goal')), 'G1-06 no raw update tools');
  check(first.task.executionState !== 'DISPATCHED' && first.task.executionState !== 'RUNNING', 'G1-06 no auto-dispatch state');
}

// G1-07: repeated creation / counters
console.log('\n-- G1-07: counters/container stability --');
{
  const beforeGoals = gt.listGoals(TEST_ROOT, project).length;
  const beforeTasks = gt.listTasks(TEST_ROOT, project).length;
  const a = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'Repeat A' });
  const b = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'Repeat B' });
  check(a.task.taskId !== b.task.taskId, 'G1-07 repeated intakes yield distinct taskIds');
  check(a.goal.goalId === b.goal.goalId, 'G1-07 repeated intakes share container');
  check(gt.listGoals(TEST_ROOT, project).length === beforeGoals, 'G1-07 goal count stable (no duplicate containers)');
  check(gt.listTasks(TEST_ROOT, project).length === beforeTasks + 2, 'G1-07 task count grows by exactly 2');
  const ids = gt.listTasks(TEST_ROOT, project).map((t) => t.taskId).sort();
  check(new Set(ids).size === ids.length, 'G1-07 taskIds unique, counters monotonic');
}

// G1-08: structural safety (source assertions)
console.log('\n-- G1-08: structural safety --');
{
  const pmSrc = fs.readFileSync('src/mcp/pm-tools.ts', 'utf8');
  const intakeSrc = fs.readFileSync('src/backend/v1-intake.ts', 'utf8');
  check(pmSrc.includes('relay_pm_create_task'), 'G1-08 intake tool registered');
  check(!intakeSrc.includes('dispatchTask'), 'G1-08 intake never calls dispatchTask');
  check(!intakeSrc.includes('acceptResult') && !intakeSrc.includes('completeGoal'), 'G1-08 intake never accepts/completes');
}

// G1-09: concurrent first intake — check-then-create race regression
console.log('\n-- G1-09: concurrent first intake --');
{
  const concProject = 'V1G1ConcProj';
  const concTools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project: concProject });
  const concGet = (name) => concTools.find((t) => t.name === name);
  check(
    gt.listGoals(TEST_ROOT, concProject).length === 0,
    'G1-09 fresh project starts with no goals',
  );
  const [r1, r2] = await Promise.all([
    concGet('relay_pm_create_task').handler({ ...CONTRACT, title: 'Conc task A' }),
    concGet('relay_pm_create_task').handler({ ...CONTRACT, title: 'Conc task B' }),
  ]);
  check(r1.goal.goalId === r2.goal.goalId, 'G1-09 concurrent intakes share the same container goalId');
  check(r1.task.taskId !== r2.task.taskId, 'G1-09 concurrent intakes yield two distinct taskIds');
  const concGoals = gt.listGoals(TEST_ROOT, concProject).filter((g) =>
    (g.tags ?? []).includes('v1-internal'),
  );
  check(concGoals.length === 1, `G1-09 exactly one internal container after concurrent intake (got ${concGoals.length})`);
  const concTasks = gt.listTasks(TEST_ROOT, concProject);
  check(concTasks.length === 2, `G1-09 exactly two tasks after concurrent intake (got ${concTasks.length})`);
  const concIds = concTasks.map((t) => t.taskId).sort();
  check(new Set(concIds).size === concIds.length, 'G1-09 taskIds unique, counters valid');
  check(
    concTasks.every((t) => t.goalId === concGoals[0].goalId),
    'G1-09 both tasks point at the single container',
  );
  for (const t of concTasks) {
    const reread = gt.getTask(TEST_ROOT, concProject, t.taskId);
    check(reread.executionState === 'READY', `G1-09 task ${t.taskId} is READY (got ${reread.executionState})`);
    check(reread.pmState === 'PENDING', `G1-09 task ${t.taskId} is PENDING (got ${reread.pmState})`);
    check(reread.linkedRuns.length === 0, `G1-09 task ${t.taskId} has no auto-dispatch (no linked runs)`);
  }
  // Sequential reuse still holds after the concurrent first intake.
  const third = await concGet('relay_pm_create_task').handler({ ...CONTRACT, title: 'Conc task C' });
  check(third.goal.goalId === concGoals[0].goalId, 'G1-09 post-race sequential intake reuses container');
  check(
    gt.listGoals(TEST_ROOT, concProject).filter((g) => (g.tags ?? []).includes('v1-internal')).length === 1,
    'G1-09 container count stays at one after sequential reuse',
  );
}

fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G1 Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
