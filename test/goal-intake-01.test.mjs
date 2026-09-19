/** GOAL INTAKE 01 — focused tests: ONE Founder submit → first real dispatch. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-goal-intake-01-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
let passed = 0;
let failed = 0;
const PASS = (message) => { console.log(`  PASS  ${message}`); passed += 1; };
const FAIL = (message) => { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; };
const check = (condition, message) => condition ? PASS(message) : FAIL(message);

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (error) {
    const detail = `${error?.code ?? ''} ${error instanceof Error ? error.message : String(error)}`;
    if (fragment && !detail.includes(fragment)) {
      FAIL(`${label} — expected ${fragment}, got ${detail}`);
    } else {
      PASS(label);
    }
  }
}

const intake = await import('../dist/server/backend/goal-intake.js');
const planner = await import('../dist/server/backend/goal-planner.js');
const gt = await import('../dist/server/backend/goal-task.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aliveFixture = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '60000';
dispatcher._resetDispatcherStateForTests();
workers.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'gi01-worker',
  displayName: 'Goal Intake 01 fixture worker',
  launchCommand: process.execPath,
  launchArgsPrefix: [aliveFixture],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const workspace = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(workspace, { recursive: true });

const DRAFT_AB = {
  title: 'Seed demo files',
  tasks: [
    {
      title: 'Create task-a.txt',
      goal: 'task-a.txt exists with exactly status=correct',
      reason: 'First file required by the Founder Goal',
      scope: 'Create task-a.txt in the workspace root',
      completionCriteria: ['task-a.txt contains exactly status=correct'],
    },
    {
      title: 'Create task-b.txt',
      goal: 'task-b.txt exists with exactly finished=true',
      reason: 'Second file required by the Founder Goal',
      scope: 'Create task-b.txt in the workspace root',
      completionCriteria: ['task-b.txt contains exactly finished=true'],
    },
  ],
};
const stubAB = async () => JSON.parse(JSON.stringify(DRAFT_AB));
const founderGoal = {
  title: 'Seed demo files A then B',
  goalStatement: 'Create task-a.txt with exactly: status=correct. Then create task-b.txt with exactly: finished=true.',
};

console.log('\n-- goal-intake-01: one submit → first dispatch --');
const project = 'GoalIntake01';
const res = await intake.submitGoalAndRun({
  dataRoot: TEST_ROOT, project, goal: founderGoal, workspaceRoot: workspace, workerId: 'gi01-worker',
  planDraftProvider: stubAB,
});

// 1. one Founder submit
check(res.ownerInteractionCount === 1, '1 one Founder submit (ownerInteractionCount=1)');
// 2. real Goal persisted
const persistedGoal = gt.getGoal(TEST_ROOT, project, res.goal.goalId);
check(persistedGoal.title === founderGoal.title, '2 real Founder Goal persisted via Goal kernel');
check(persistedGoal.status === 'ACTIVE', '2 Founder Goal is ACTIVE');
check(persistedGoal.title !== 'V1 Single-Task Inbox (internal technical container)', '2 not the V1 technical container');
// 4/5. canonical Tasks, same Founder goalId
check(res.tasks.length === 2, '4 exactly 2 canonical Tasks generated');
check(res.tasks.every((t) => t.goalId === res.goal.goalId), '5 both Tasks share the same Founder goalId');
check(res.tasks[0].title === 'Create task-a.txt' && res.tasks[1].title === 'Create task-b.txt', '4 order is Task A → Task B');
// manual authoring counts: every Task matches the draft, in order
const manualTasks = res.tasks.filter((t, i) =>
  t.title !== DRAFT_AB.tasks[i].title || t.goal !== DRAFT_AB.tasks[i].goal ||
  t.reason !== DRAFT_AB.tasks[i].reason || t.scope !== DRAFT_AB.tasks[i].scope);
check(manualTasks.length === 0, '12 manualTaskAuthoringCount = 0');
// 6. ExecutionPlan generated
const storedPlan = plans.getExecutionPlan(TEST_ROOT, project, res.plan.planId);
check(storedPlan.orderedTaskIds.join(',') === res.tasks.map((t) => t.taskId).join(','), '6 ExecutionPlan order is Task A → Task B');
check(plans.listExecutionPlans(TEST_ROOT, project).length === 1, '13 manualPlanAuthoringCount = 0');
// 7. worker/workspace validation (registry authoritative)
check(res.plan.taskBindings.every((b) => b.workerId === 'gi01-worker' && b.workspaceRoot === workspace), '7 worker bindings validated (submission values, frozen)');
// 8. ONE authorization
check(res.ownerGoEvidenceCount === 1, '8 ownerGoEvidenceCount = 1');
check(storedPlan.ownerAuthorization?.authorizationId === `owner-go:${storedPlan.planId}`, '8 ONE Owner authorization evidence persisted');
check(storedPlan.ownerAuthorization?.approvedBy === 'OWNER', '8 approvedBy OWNER');
// 9. first Task dispatched
check(typeof res.firstRunId === 'string' && res.firstRunId.length > 0, '9 first real runId created');
const firstTask = gt.getTask(TEST_ROOT, project, res.tasks[0].taskId);
check(firstTask.linkedRuns.length === 1 && firstTask.linkedRuns[0].runId === res.firstRunId, '9 first Task dispatched with exactly one linked Run');
check(typeof res.dispatch.pid === 'number' && res.dispatch.pid > 0, '10 real Worker process started (pid)');
let alive = false;
try { process.kill(res.dispatch.pid, 0); alive = true; } catch { alive = false; }
check(alive, '10 Worker process is alive');
// 14. second Owner GO = 0 (replay fence: canonical path refuses a second dispatch)
const replay = await planDispatch.dispatchExecutionPlanOwnerApproved(TEST_ROOT, project, {
  planId: storedPlan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: storedPlan.ownerAuthorization,
});
check(replay.outcome === 'ALREADY_STARTED' && replay.existingRunId === res.firstRunId, '14 second Owner GO dispatches nothing (ALREADY_STARTED, same run)');
check(gt.getTask(TEST_ROOT, project, res.tasks[0].taskId).linkedRuns.length === 1, '14 still exactly one Run (secondOwnerGoCount = 0)');

console.log('\n-- goal-intake-01: planner output validation --');
check(planner.validatePlanDraft(JSON.parse(JSON.stringify(DRAFT_AB))).tasks.length === 2, '3 valid draft passes');
await shouldThrow(async () => planner.validatePlanDraft({ title: 'x', tasks: [] }), '3 empty tasks rejected', 'MALFORMED_DRAFT');
await shouldThrow(async () => planner.validatePlanDraft({ title: 'x' }), '3 missing tasks rejected', 'MALFORMED_DRAFT');
await shouldThrow(async () => planner.validatePlanDraft({ title: 'x', tasks: [{ title: 't' }] }), '3 incomplete task rejected', 'MALFORMED_DRAFT');
await shouldThrow(async () => planner.validatePlanDraft({ title: '', tasks: DRAFT_AB.tasks }), '3 empty title rejected', 'MALFORMED_DRAFT');
await shouldThrow(
  async () => planner.validatePlanDraft({ title: 'x', tasks: Array.from({ length: 9 }, (_, i) => ({ ...DRAFT_AB.tasks[0], title: `t${i}` })) }),
  '3 oversized draft rejected', 'MALFORMED_DRAFT',
);
await shouldThrow(
  async () => planner.validatePlanDraft({ title: 'x', tasks: [{ ...DRAFT_AB.tasks[0], bogus: 1 }] }),
  '3 unknown field rejected', 'MALFORMED_DRAFT',
);

console.log('\n-- goal-intake-01: fail closed --');
const badProject = 'GoalIntake01Bad';
await shouldThrow(
  () => intake.submitGoalAndRun({
    dataRoot: TEST_ROOT, project: badProject, goal: founderGoal, workspaceRoot: workspace, workerId: 'gi01-worker',
    planDraftProvider: async () => ({ title: 'bad', tasks: [] }),
  }),
  '10 malformed planner → throw', 'MALFORMED_DRAFT',
);
check(gt.listTasks(TEST_ROOT, badProject).length === 0, '10 malformed planner → zero Tasks');
check(plans.listExecutionPlans(TEST_ROOT, badProject).length === 0, '10 malformed planner → zero Plans');
const failProject = 'GoalIntake01Fail';
await shouldThrow(
  () => intake.submitGoalAndRun({
    dataRoot: TEST_ROOT, project: failProject, goal: founderGoal, workspaceRoot: workspace, workerId: 'gi01-worker',
    planDraftProvider: async () => { throw new Error('LLM down'); },
  }),
  '11 planner failure → throw', 'PLANNER_FAILED',
);
check(gt.listTasks(TEST_ROOT, failProject).length === 0, '11 planner failure → zero Tasks');
check(plans.listExecutionPlans(TEST_ROOT, failProject).length === 0, '11 planner failure → zero Plans');

console.log('\n-- goal-intake-01: binding validation precedes writes --');
await shouldThrow(
  () => intake.submitGoalAndRun({
    dataRoot: TEST_ROOT, project: 'GoalIntake01NoWorker', goal: founderGoal, workspaceRoot: workspace, workerId: 'ghost-worker',
    planDraftProvider: stubAB,
  }),
  '7 unknown worker rejected', 'NOT_FOUND',
);
check(gt.listGoals(TEST_ROOT, 'GoalIntake01NoWorker').length === 0, '7 unknown worker → zero durable writes');
await shouldThrow(
  () => intake.submitGoalAndRun({
    dataRoot: TEST_ROOT, project: 'GoalIntake01NoRoot', goal: founderGoal, workspaceRoot: '/nonexistent-root-xyz', workerId: 'gi01-worker',
    planDraftProvider: stubAB,
  }),
  '7 bad workspace rejected', 'workspaceRoot',
);

try { process.kill(res.dispatch.pid, 'SIGKILL'); } catch { /* ignore */ }
console.log(`\n결과: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
