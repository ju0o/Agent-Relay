/**
 * V1.5 Blocker Hotfix 02 — completed-run capture recovery.
 * Runs against compiled server modules under dist/server.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-crr-${process.pid}-${Date.now()}`);
const CLAUDE_DIR = path.join(ROOT, '.claude-fixture');
fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(path.join(CLAUDE_DIR, 'projects', 'p1'), { recursive: true });

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};

const gt = await import('../dist/server/backend/goal-task.js');
const recovery = await import('../dist/server/backend/completed-run-recovery.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const pmDelivery = await import('../dist/server/backend/pm-delivery.js');

const project = 'CRR';
const workspaceRoot = path.join(ROOT, 'workspace');
fs.mkdirSync(workspaceRoot, { recursive: true });

let runCounter = 0;
let sessionCounter = 0;

function writeTranscript({ sessionId, cwd, promptContent, stopReason = 'end_turn', completedAtIso, text = 'Done.' }) {
  const file = path.join(CLAUDE_DIR, 'projects', 'p1', `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(Date.now() - 5000).toISOString(), sessionId, cwd, content: promptContent }),
    JSON.stringify({
      type: 'assistant',
      uuid: `msg-${sessionId}`,
      timestamp: completedAtIso ?? new Date().toISOString(),
      sessionId,
      cwd,
      message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function writeLaunchLog(folder, { startedAt, exitCode = 0, phase = 'completed' }) {
  const first = JSON.stringify({ startedAt, taskId: 'x', runId: 'y', phase: 'spawning' }, null, 2);
  const second = JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), phase, exitCode }, null, 2);
  fs.writeFileSync(path.join(folder, 'worker-launch.log'), `${first}\n---\n${second}\n`, 'utf8');
}

async function makeGoalAndTask(overrides = {}, proj = project) {
  const goal = await gt.createGoal(ROOT, proj, { title: 'CRR goal', goalStatement: 'CRR fixture goal' });
  const task = await gt.createTask(ROOT, proj, {
    goalId: goal.goalId,
    title: 'CRR task',
    goal: 'CRR task goal',
    reason: 'fixture',
    scope: 'fixture-only',
    executionState: 'RUNNING',
    pmState: 'PENDING',
    ...overrides,
  });
  return { goal, task };
}

/** Materialize a Run folder + meta + prompt.md + worker-launch.log, link it, and
 * (unless skipTranscript) write a matching durable transcript. Returns {task, runId, folder}. */
async function makeRun(taskId, {
  promptText,
  exitCode = 0,
  launchPhase = 'completed',
  stopReason = 'end_turn',
  cwd = workspaceRoot,
  transcriptCwd = cwd,
  skipTranscript = false,
  sourceRunId,
  startedAtOffsetMs = -10_000,
  proj = project,
} = {}) {
  runCounter += 1;
  sessionCounter += 1;
  const folder = path.join(ROOT, proj, '2099-01-01', 'worker-claude-code', String(runCounter).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const runId = `crr-run-${runCounter}-${Date.now()}`;
  const prompt = promptText ?? `Task ID: ${taskId}\nrun=${runCounter}\nnonce=${Math.random()}`;
  fs.writeFileSync(path.join(folder, 'prompt.md'), prompt, 'utf8');
  const startedAt = new Date(Date.now() + startedAtOffsetMs).toISOString();
  writeLaunchLog(folder, { startedAt, exitCode, phase: launchPhase });

  const metaFile = path.join(folder, 'meta.json');
  fs.writeFileSync(metaFile, JSON.stringify({
    tags: [], runId, workspaceRoot: cwd, workerId: 'claude-code', claudeConfigDir: CLAUDE_DIR,
    ...(sourceRunId ? { sourceRunId } : {}),
  }, null, 2), 'utf8');

  await gt.linkRunToTask(ROOT, proj, taskId, folder);

  const sessionId = `sess-${sessionCounter}-${Date.now()}`;
  if (!skipTranscript) {
    writeTranscript({ sessionId, cwd: transcriptCwd, promptContent: prompt, stopReason });
  }
  return { runId, folder, prompt, sessionId };
}

console.log('\n-- 1) clean completed Run + correlated transcript → recovered exactly once --');
{
  const { task } = await makeGoalAndTask();
  const { runId } = await makeRun(task.taskId);
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(result.status === 'RECOVERED', `status RECOVERED (got ${result.status}: ${result.reason})`);
  check(result.resultCaptured === true, 'resultCaptured true');
  check(result.deliveryId === `PMD-${task.taskId}-${runId}`, `deliveryId = PMD-${task.taskId}-${runId}`);
  const after = gt.getTask(ROOT, project, task.taskId);
  check(after.executionState === 'RESULT_RECEIVED', `Task executionState RESULT_RECEIVED (got ${after.executionState})`);
  check(after.pmState === 'VERIFYING', `Task pmState VERIFYING (got ${after.pmState})`);
  const folder = path.join(ROOT, project, '2099-01-01', 'worker-claude-code', String(runCounter).padStart(2, '0'));
  check(fs.existsSync(path.join(folder, 'agent-result.md')), 'agent-result.md written');
  check(fs.existsSync(path.join(folder, 'result.md')), 'result.md written');
  check(fs.existsSync(path.join(folder, 'evidence', 'adapter.json')), 'evidence/adapter.json written');
  const delivery = pmDelivery.getPmDelivery(ROOT, project, result.deliveryId);
  check(!!delivery, 'ordinary PM Delivery exists (not Plan-specific)');

  console.log('-- 3) second recovery call → ALREADY_CAPTURED no-op --');
  const second = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(second.status === 'ALREADY_CAPTURED', `second call ALREADY_CAPTURED (got ${second.status})`);
  const afterSecond = gt.getTask(ROOT, project, task.taskId);
  check(afterSecond.updatedAt === after.updatedAt, 'no further Task mutation on second call');

  console.log('-- 4) concurrent recovery calls → one winner, no duplicate Delivery/Event --');
  const { task: task2 } = await makeGoalAndTask();
  const { runId: runId2 } = await makeRun(task2.taskId);
  const [a, b] = await Promise.all([
    recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task2.taskId, runId: runId2 }),
    recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task2.taskId, runId: runId2 }),
  ]);
  const statuses = [a.status, b.status].sort();
  check(
    JSON.stringify(statuses) === JSON.stringify(['ALREADY_CAPTURED', 'RECOVERED']) || JSON.stringify(statuses) === JSON.stringify(['RECOVERED', 'RECOVERED']),
    `concurrent calls: exactly one durable winner (got ${statuses.join(',')})`,
  );
  const deliveries2 = pmDelivery.listPmDeliveries(ROOT, project).filter((d) => d.taskId === task2.taskId);
  check(deliveries2.length === 1, `exactly one PM Delivery for concurrent Task (got ${deliveries2.length})`);
}

console.log('\n-- 2) retry Run with sourceRunId → recovered correctly --');
{
  const { task } = await makeGoalAndTask();
  const first = await makeRun(task.taskId);
  // First attempt must be off the "current attempt" path for the retry to be current.
  await gt.linkRunToTask; // no-op reference to keep import used
  const retry = await makeRun(task.taskId, { sourceRunId: first.runId });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId: retry.runId });
  check(result.status === 'RECOVERED', `retry Run recovered (got ${result.status}: ${result.reason})`);
}

console.log('\n-- 2b) retry Run whose sourceRunId is NOT linked to this Task → BLOCKED --');
{
  const { task } = await makeGoalAndTask();
  const retry = await makeRun(task.taskId, { sourceRunId: 'never-linked-run-id' });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId: retry.runId });
  check(result.status === 'BLOCKED' && result.reason === 'RETRY_LINEAGE_SOURCE_RUN_UNLINKED', `unlinked source Run blocked (got ${result.status}/${result.reason})`);
}

console.log('\n-- 5) transcript that completed BEFORE the Run started → rejected --');
{
  const { task } = await makeGoalAndTask();
  runCounter += 1; sessionCounter += 1;
  const folder = path.join(ROOT, project, '2099-01-01', 'worker-claude-code', String(runCounter).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const runId = `crr-run-${runCounter}`;
  const prompt = `Task ID: ${task.taskId}\nhistorical=${Math.random()}`;
  fs.writeFileSync(path.join(folder, 'prompt.md'), prompt, 'utf8');
  // Run genuinely started "now" (transcript file mtime will be >= this), but its
  // recorded turn-completion timestamp is long before that — the defense-in-depth
  // check (#11 in completed-run-recovery.ts), independent of the content-match gate.
  const startedAt = new Date(Date.now() - 5_000).toISOString();
  writeLaunchLog(folder, { startedAt, exitCode: 0, phase: 'completed' });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({
    tags: [], runId, workspaceRoot, workerId: 'claude-code', claudeConfigDir: CLAUDE_DIR,
  }, null, 2), 'utf8');
  await gt.linkRunToTask(ROOT, project, task.taskId, folder);
  const sessionId = `sess-hist-${sessionCounter}`;
  writeTranscript({ sessionId, cwd: workspaceRoot, promptContent: prompt, completedAtIso: new Date(Date.now() - 120_000).toISOString() });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(result.status === 'REJECTED' && result.reason === 'HISTORICAL_TRANSCRIPT_BEFORE_RUN_START', `historical pre-run end_turn rejected (got ${result.status}/${result.reason})`);
}

console.log('\n-- 6/7) transcript content belongs to a different Task/Run → no match found (never mistaken) --');
{
  const { task: taskA } = await makeGoalAndTask();
  const { task: taskB } = await makeGoalAndTask();
  await makeRun(taskA.taskId, { promptText: `Task ID: ${taskA.taskId}\nunique-a` });
  const runB = await makeRun(taskB.taskId, { promptText: `Task ID: ${taskB.taskId}\nunique-b`, skipTranscript: true });
  // Deliberately write taskB's Run folder prompt.md, but the only transcript on disk
  // for that exact content belongs to Task A — so Task B must find nothing.
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: taskB.taskId, runId: runB.runId });
  check(result.status === 'REJECTED' && result.reason === 'NO_MATCHING_TRANSCRIPT', `cross-Task transcript never matched (got ${result.status}/${result.reason})`);
}

console.log('\n-- 8) workspace mismatch → rejected --');
{
  const { task } = await makeGoalAndTask();
  const otherWorkspace = path.join(ROOT, 'other-workspace');
  const { runId } = await makeRun(task.taskId, { cwd: workspaceRoot, transcriptCwd: otherWorkspace });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(result.status === 'REJECTED' && result.reason === 'WORKSPACE_MISMATCH', `workspace mismatch rejected (got ${result.status}/${result.reason})`);
}

console.log('\n-- 10) nonzero Worker exit → rejected --');
{
  const { task } = await makeGoalAndTask();
  const { runId } = await makeRun(task.taskId, { exitCode: 1 });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(result.status === 'REJECTED' && result.reason.startsWith('WORKER_EXIT_NONZERO'), `nonzero exit rejected (got ${result.status}/${result.reason})`);
}

console.log('\n-- 11) no terminal end_turn (still streaming) → rejected --');
{
  const { task } = await makeGoalAndTask();
  const { runId } = await makeRun(task.taskId, { stopReason: 'tool_use' });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(result.status === 'REJECTED' && result.reason === 'NO_TERMINAL_END_TURN', `no end_turn rejected (got ${result.status}/${result.reason})`);
}

console.log('\n-- 14) later Run exists for the same Task → BLOCKED (never promotes a stale attempt) --');
{
  const { task } = await makeGoalAndTask();
  const first = await makeRun(task.taskId);
  await makeRun(task.taskId); // second/current attempt supersedes it
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId: first.runId });
  check(result.status === 'BLOCKED' && result.reason === 'NOT_CURRENT_ATTEMPT_OR_LATER_RUN_EXISTS', `stale attempt blocked (got ${result.status}/${result.reason})`);
}

console.log('\n-- 16) Run not linked to Task → rejected --');
{
  const { task } = await makeGoalAndTask();
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId: 'no-such-run' });
  check(result.status === 'REJECTED' && result.reason === 'RUN_NOT_LINKED_TO_TASK', `unlinked runId rejected (got ${result.status}/${result.reason})`);
}

console.log('\n-- 17) Plan-owned Task with tampered authorization → BLOCKED --');
{
  // Isolated project: a corrupted Plan record makes listExecutionPlans fail
  // closed for the WHOLE project (by design), so it must never share a
  // project namespace with unrelated recovery fixtures below.
  const planProject = `${project}-plancorrupt`;
  const { task } = await makeGoalAndTask({}, planProject);
  const plan = await plans.createExecutionPlan(ROOT, planProject, {
    title: 'CRR plan',
    orderedTaskIds: [task.taskId],
    taskBindings: [{ taskId: task.taskId, workerId: 'claude-code', workspaceRoot, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(gt.getTask(ROOT, planProject, task.taskId)) }],
  });
  await plans.startExecutionPlan(ROOT, planProject, plan.planId, {
    expectedState: 'PLANNED',
    activeTaskId: task.taskId,
    ownerAuthorization: {
      authorizationId: `owner-go:${plan.planId}`,
      approvedAt: new Date().toISOString(),
      approvedBy: 'OWNER',
      planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
      taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
    },
  });
  // Simulate post-approval drift/tampering of the frozen Plan definition on
  // disk (the only way an approved-at-write-time authorization can later go
  // stale) — startExecutionPlan itself refuses a mismatched fingerprint, so a
  // real mismatch can only ever arise this way, which is exactly what
  // revalidatePlanAuthorization exists to catch before recovery ever runs.
  const planPath = plans.executionPlanPath(ROOT, planProject, plan.planId);
  const onDisk = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  onDisk.title = 'CRR plan (tampered after Owner approval)';
  fs.writeFileSync(planPath, JSON.stringify(onDisk, null, 2), 'utf8');

  const { runId } = await makeRun(task.taskId, { proj: planProject });
  const result = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project: planProject, taskId: task.taskId, runId });
  // listExecutionPlans fails closed on the corrupted record itself — recovery
  // must BLOCK rather than silently treat the Task as Plan-less and proceed.
  check(
    result.status === 'BLOCKED' && /PLAN_LIST_UNREADABLE|PLAN_AUTHORIZATION_MISMATCH/.test(result.reason),
    `tampered Plan authorization blocked (got ${result.status}/${result.reason})`,
  );
}

console.log('\n-- 12) existing Result already captured → ALREADY_CAPTURED, no duplicate write --');
{
  const { task } = await makeGoalAndTask();
  const { runId, folder } = await makeRun(task.taskId);
  const first = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(first.status === 'RECOVERED', 'first call recovers');
  const resultMdBefore = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
  const second = await recovery.recoverCompletedRunCapture({ dataRoot: ROOT, callerSurface: 'INTERNAL_TRUSTED', project, taskId: task.taskId, runId });
  check(second.status === 'ALREADY_CAPTURED', `existing Result short-circuits (got ${second.status})`);
  const resultMdAfter = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
  check(resultMdBefore === resultMdAfter, 'result.md content unchanged by no-op recovery');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
