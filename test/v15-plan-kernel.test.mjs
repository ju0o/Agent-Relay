/** V1.5 Slice 1 — ExecutionPlan kernel only. No dispatch, MCP, or Worker. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v15-plan-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
const PROJECT = 'V15PlanKernel';

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { console.log(`  PASS  ${label}`); passed += 1; }
  else { console.log(`  FAIL  ${label}`); failed += 1; process.exitCode = 1; }
}
async function rejects(fn, label, fragment) {
  try {
    await fn();
    check(false, `${label} — expected rejection`);
  } catch (error) {
    const text = `${error?.code ?? ''} ${error instanceof Error ? error.message : String(error)}`;
    check(!fragment || text.includes(fragment), label);
  }
}

const plans = await import('../dist/server/backend/execution-plan.js');
const tasks = await import('../dist/server/backend/goal-task.js');

const fingerprint = (char) => char.repeat(64);
const bindings = (ids) => ids.map((taskId, index) => ({
  taskId,
  workerId: `worker-${index + 1}`,
  workspaceRoot: `/tmp/v15-workspace-${index + 1}`,
  scopeFingerprint: fingerprint(String(index + 1)),
}));
const input = (ids = ['TASK-1001', 'TASK-1002', 'TASK-1003']) => ({
  title: 'V1.5 kernel test plan',
  orderedTaskIds: ids,
  taskBindings: bindings(ids),
});
const authFor = (record) => ({
  authorizationId: `OWNER-GO-${record.planId}`,
  approvedAt: new Date().toISOString(),
  approvedBy: 'OWNER',
  planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(record),
  taskScopeFingerprints: Object.fromEntries(record.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint])),
});
const start = (record, activeTaskId = record.orderedTaskIds[0]) => plans.startExecutionPlan(
  TEST_ROOT, PROJECT, record.planId, { expectedState: 'PLANNED', activeTaskId, ownerAuthorization: authFor(record) },
);

console.log('\n-- create and round trip --');
const three = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input());
check(three.state === 'PLANNED' && three.activeTaskId === null, 'valid three-Task Plan creates PLANNED with null cursor');
check(three.planId === 'PLAN-0001', 'Plan ID is monotonic and deterministic in fresh project');
const storedPath = plans.executionPlanPath(TEST_ROOT, PROJECT, three.planId);
check(fs.existsSync(storedPath), 'Plan is persisted at canonical plans/{planId}/plan.json path');
const roundTrip = plans.getExecutionPlan(TEST_ROOT, PROJECT, three.planId);
check(JSON.stringify(roundTrip) === JSON.stringify(three), 'atomic persistence round trip preserves canonical record');
check(fs.readdirSync(path.dirname(storedPath)).filter((name) => name.includes('.tmp')).length === 0, 'atomic persistence leaves no temp artifact');
const single = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input(['TASK-2001']));
check(single.orderedTaskIds.length === 1, 'single-Task Plan is valid');
check(plans.listExecutionPlans(TEST_ROOT, PROJECT).length === 2, 'Plan list returns canonical Plans');

console.log('\n-- creation validation --');
await rejects(() => plans.createExecutionPlan(TEST_ROOT, PROJECT, input(['TASK-3001', 'TASK-3001'])), 'duplicate Task IDs rejected', 'duplicates');
await rejects(() => plans.createExecutionPlan(TEST_ROOT, PROJECT, { ...input(['TASK-3002']), taskBindings: [] }), 'missing binding rejected', 'exactly one binding');
await rejects(() => plans.createExecutionPlan(TEST_ROOT, PROJECT, { ...input(['TASK-3003']), taskBindings: [...bindings(['TASK-3003']), ...bindings(['TASK-OUT'])] }), 'extra out-of-plan binding rejected', 'exactly one binding');
await rejects(() => plans.createExecutionPlan(TEST_ROOT, PROJECT, { ...input(['TASK-3004']), taskBindings: [{ ...bindings(['TASK-3004'])[0], workspaceRoot: 'relative/workspace' }] }), 'non-absolute workspace binding rejected', 'absolute');

console.log('\n-- start, transitions, and cursor --');
await rejects(() => start(three, 'TASK-NOT-IN-PLAN'), 'unknown Task cannot become active', 'declared Plan Task');
const running = await start(three);
check(running.state === 'RUNNING' && running.activeTaskId === 'TASK-1001' && !!running.ownerAuthorization, 'PLANNED -> RUNNING persists one authorized active cursor');
check(Date.parse(running.updatedAt) >= Date.parse(running.createdAt), 'timestamps are canonical and monotonic on start');
const completed = await plans.transitionExecutionPlan(TEST_ROOT, PROJECT, three.planId, { expectedState: 'RUNNING', to: 'COMPLETED' });
check(completed.state === 'COMPLETED' && completed.activeTaskId === null && !!completed.completedAt, 'RUNNING -> COMPLETED is controlled and terminal');
await rejects(() => plans.resumeBlockedExecutionPlan(TEST_ROOT, PROJECT, three.planId, { expectedState: 'BLOCKED', ownerRecoveryId: 'OWNER-RECOVERY-1' }), 'terminal resurrection rejected', 'CONFLICT');
const replay = await plans.transitionExecutionPlan(TEST_ROOT, PROJECT, three.planId, { expectedState: 'COMPLETED', to: 'COMPLETED' });
check(JSON.stringify(replay) === JSON.stringify(completed), 'identical terminal transition replay is idempotent');
await rejects(() => plans.transitionExecutionPlan(TEST_ROOT, PROJECT, single.planId, { expectedState: 'PLANNED', to: 'FAILED', reason: 'not legal' }), 'invalid state transition rejected', 'Illegal');

console.log('\n-- frozen authorization evidence tamper rejection --');
async function tamperAndReject(label, mutate) {
  const record = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input([`TASK-${4000 + passed}`]));
  await start(record);
  const file = plans.executionPlanPath(TEST_ROOT, PROJECT, record.planId);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(raw);
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
  await rejects(() => Promise.resolve(plans.getExecutionPlan(TEST_ROOT, PROJECT, record.planId)), label, 'INVALID_STATE');
}
await tamperAndReject('frozen order mutation rejected', (raw) => { raw.orderedTaskIds = ['TASK-OTHER']; });
await tamperAndReject('Worker binding mutation rejected', (raw) => { raw.taskBindings[0].workerId = 'other-worker'; });
await tamperAndReject('workspace binding mutation rejected', (raw) => { raw.taskBindings[0].workspaceRoot = '/tmp/other-workspace'; });
await tamperAndReject('authorization fingerprint mutation rejected', (raw) => { raw.ownerAuthorization.planScopeFingerprint = fingerprint('f'); });

console.log('\n-- malformed durable state --');
const malformedFolder = plans.executionPlanFolder(TEST_ROOT, PROJECT, 'PLAN-9999');
fs.mkdirSync(malformedFolder, { recursive: true });
fs.writeFileSync(path.join(malformedFolder, 'plan.json'), '{not json', 'utf8');
await rejects(() => Promise.resolve(plans.getExecutionPlan(TEST_ROOT, PROJECT, 'PLAN-9999')), 'malformed persisted Plan rejected', 'INVALID_STATE');

console.log('\n-- block/resume and concurrent CAS --');
const blockedSeed = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input(['TASK-5001']));
await start(blockedSeed);
const blocked = await plans.transitionExecutionPlan(TEST_ROOT, PROJECT, blockedSeed.planId, {
  expectedState: 'RUNNING', to: 'BLOCKED', block: { code: 'HOST_UNAVAILABLE', reason: 'bounded test blocker', taskId: 'TASK-5001' },
});
check(blocked.state === 'BLOCKED' && blocked.block?.code === 'HOST_UNAVAILABLE', 'RUNNING -> BLOCKED requires and persists block metadata');
const resumed = await plans.resumeBlockedExecutionPlan(TEST_ROOT, PROJECT, blockedSeed.planId, { expectedState: 'BLOCKED', ownerRecoveryId: 'OWNER-RECOVERY-2' });
check(resumed.state === 'RUNNING' && !resumed.block, 'guarded BLOCKED -> RUNNING primitive clears only block lifecycle data');

const lockSeed = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input(['TASK-5002']));
const externalLock = plans.executionPlanLockPath(TEST_ROOT, PROJECT, lockSeed.planId);
fs.writeFileSync(externalLock, 'external local writer lock\n', 'utf8');
await rejects(() => start(lockSeed), 'existing local mutation lock fails closed', 'CONFLICT');
fs.unlinkSync(externalLock);
check((await start(lockSeed)).state === 'RUNNING', 'released local mutation lock permits canonical mutation');

const concurrentSeed = await plans.createExecutionPlan(TEST_ROOT, PROJECT, input(['TASK-6001']));
await start(concurrentSeed);
const results = await Promise.allSettled([
  plans.transitionExecutionPlan(TEST_ROOT, PROJECT, concurrentSeed.planId, { expectedState: 'RUNNING', to: 'COMPLETED' }),
  plans.transitionExecutionPlan(TEST_ROOT, PROJECT, concurrentSeed.planId, { expectedState: 'RUNNING', to: 'FAILED', reason: 'competing terminal transition' }),
]);
check(results.filter((result) => result.status === 'fulfilled').length === 1, 'concurrent mutation serializes exactly one winning CAS transition');
check(results.filter((result) => result.status === 'rejected').length === 1, 'conflicting stale mutation rejects clearly');
const concurrentFinal = plans.getExecutionPlan(TEST_ROOT, PROJECT, concurrentSeed.planId);
check(['COMPLETED', 'FAILED'].includes(concurrentFinal.state), 'concurrent Plan JSON remains parseable canonical terminal state');

console.log('\n-- V1 storage compatibility --');
const goal = await tasks.createGoal(TEST_ROOT, PROJECT, { title: 'V1 compatibility Goal', goalStatement: 'Keep V1 Task storage independent.' });
const v1Task = await tasks.createTask(TEST_ROOT, PROJECT, {
  goalId: goal.goalId,
  title: 'V1 Task has no Plan', goal: 'Remain valid without planId', reason: 'V1 regression', scope: 'V1 only',
});
const rereadV1 = tasks.getTask(TEST_ROOT, PROJECT, v1Task.taskId);
check(rereadV1.taskId === v1Task.taskId && !Object.hasOwn(rereadV1, 'planId'), 'existing V1 Task without planId remains valid and unchanged');

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
console.log(`\nV1.5 Slice 1 Plan Kernel Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
