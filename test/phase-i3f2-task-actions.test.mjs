/**
 * Phase I3F-2 — canonical Accept Result / Request Changes / Retry Core.
 * Permanent regression coverage: F2-A01..A11, F2-C01..C12, F2-R01..R11,
 * permission matrix, immutable Action Events, PM Evidence regression, and
 * cross-mutation CAS race safety.
 *
 * Temporary DATA_ROOT only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-phase-i3f2-${process.pid}-${Date.now()}`);
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

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const evk = await import('../dist/server/backend/event.js');
const evidence = await import('../dist/server/backend/evidence.js');
const perm = await import('../dist/server/backend/permission-gate.js');
const taskActions = await import('../dist/server/backend/task-actions.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');

const project = 'I3F2Proj';
relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

const ACCEPT_CAS = { expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING' };
const RETRY_CAS = { expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED' };
const REASON = 'permanent regression fixture reason text';

async function makeGoal(mode = 'BYPASS', title = 'I3F2 Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title, goalStatement: 'i3f2 goal', permissionPolicy: { mode },
  });
}

async function linkRun(taskId, agent = 'I3F2Agent') {
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

/** RESULT_RECEIVED + CHANGES_REQUESTED Task with one linked (current-attempt) Run. */
async function makeChangesRequestedTask(goalId, title = 'Changes Task') {
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId, title, goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'CHANGES_REQUESTED',
  });
  const { runId } = await linkRun(t.taskId);
  return { task: gt.getTask(TEST_ROOT, project, t.taskId), runId };
}

// ── F2-A: Accept Result ──────────────────────────────────────────────────────
console.log('\n── F2-A01..A11 Accept Result ──');

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'A01');
  const accepted = await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, ...ACCEPT_CAS,
  });
  check(accepted.pmState === 'ACCEPTED' && accepted.acceptedRunId === runId, 'F2-A01 RESULT_RECEIVED+VERIFYING valid accept PASS');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'A02', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'PENDING',
  });
  const { runId } = await linkRun(t.taskId);
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A02 RESULT_RECEIVED+PENDING rejected',
    'CONFLICT',
  );
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'A03', goal: 'g', reason: 'r', scope: 's',
    executionState: 'READY', pmState: 'VERIFYING',
  });
  const { runId } = await linkRun(t.taskId);
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A03 READY+VERIFYING rejected',
    'CONFLICT',
  );
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'A04', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const { runId } = await linkRun(t.taskId);
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A04 stale expectedExecutionState -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-A04 no write on CONFLICT');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'A05', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'CHANGES_REQUESTED',
  });
  const { runId } = await linkRun(t.taskId);
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A05 stale expectedPmState -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-A05 no write on CONFLICT');
}

{
  const g = await makeGoal();
  const { task, runId: r1 } = await makeVerifyingTask(g.goalId, 'A06');
  const { runId: r2 } = await linkRun(task.taskId); // r2 becomes current attempt
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, task.taskId, r1, { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A06 historical run rejected',
  );
  void r2;
}

{
  const g = await makeGoal();
  const { task } = await makeVerifyingTask(g.goalId, 'A07');
  await shouldThrow(
    () => rt.acceptResult(TEST_ROOT, project, task.taskId, 'not-a-linked-run', { goalId: g.goalId, ...ACCEPT_CAS }),
    'F2-A07 run not in linkedRuns rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'A08');
  const accepted = await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS });
  check(accepted.acceptedRunId === runId, 'F2-A08 acceptedRunId set correctly');
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'A09');
  await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, { goalId: g.goalId, ...ACCEPT_CAS });
  const evBefore = evidence.listEvidenceForTask(TEST_ROOT, project, task.taskId, true).length;
  const ev = await evidence.recordPmDecision(TEST_ROOT, project, {
    verdict: 'ACCEPTED', taskId: task.taskId, runId, targetRunId: runId,
  });
  check(ev.type === 'PM_DECISION' && ev.trustLevel === 'ACCEPTED', 'F2-A09 PM accepted Evidence still created');
  const evAfter = evidence.listEvidenceForTask(TEST_ROOT, project, task.taskId, true).length;
  check(evAfter === evBefore + 1, 'F2-A09 Evidence count increments by exactly one PM_DECISION record');
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'A10');
  await taskActions.acceptTaskResult({
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId, runId,
    ...ACCEPT_CAS, callerSurface: 'OWNER_IPC',
  });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED' }).events;
  check(events.length === 1, `F2-A10 TASK_RESULT_ACCEPTED Event created exactly once (got ${events.length})`);
  const e = events[0];
  check(e.runId === runId && e.goalId === g.goalId && e.correlationId === task.taskId, 'F2-A10 Event linkage correct');
  check(e.pmAttention.required === false, 'F2-A11 Event is audit fact — not PM-attention-required');
  check(!('trustLevel' in e) && !('verifiedCount' in e), 'F2-A11 Event is not Evidence (no trustLevel/verifiedCount fields)');
}

// ── F2-C: Request Changes ────────────────────────────────────────────────────
console.log('\n── F2-C01..C12 Request Changes ──');

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C01');
  const changed = await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, reason: REASON, ...ACCEPT_CAS,
  });
  check(changed.pmState === 'CHANGES_REQUESTED', 'F2-C01 valid RESULT_RECEIVED+VERIFYING -> CHANGES_REQUESTED');
  check(changed.executionState === 'RESULT_RECEIVED', 'F2-C02 execution remains RESULT_RECEIVED');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'C03', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const { runId } = await linkRun(t.taskId);
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, reason: REASON, ...ACCEPT_CAS }),
    'F2-C03 stale execution CAS -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-C03 no write');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'C04', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'PENDING',
  });
  const { runId } = await linkRun(t.taskId);
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, t.taskId, runId, { goalId: g.goalId, reason: REASON, ...ACCEPT_CAS }),
    'F2-C04 stale PM CAS -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-C04 no write');
}

{
  const g = await makeGoal();
  const { task } = await makeVerifyingTask(g.goalId, 'C05');
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, task.taskId, '', { goalId: g.goalId, reason: REASON, ...ACCEPT_CAS }),
    'F2-C05 missing runId rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId: r1 } = await makeVerifyingTask(g.goalId, 'C06');
  await linkRun(task.taskId); // becomes current attempt; r1 now historical
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, task.taskId, r1, { goalId: g.goalId, reason: REASON, ...ACCEPT_CAS }),
    'F2-C06 historical run rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C07');
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, task.taskId, runId, { goalId: g.goalId, reason: '', ...ACCEPT_CAS }),
    'F2-C07 empty reason rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C08');
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, task.taskId, runId, { goalId: g.goalId, reason: 'short', ...ACCEPT_CAS }),
    'F2-C08 reason <10 rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C09');
  await shouldThrow(
    () => rt.requestChanges(TEST_ROOT, project, task.taskId, runId, { goalId: g.goalId, reason: 'x'.repeat(2001), ...ACCEPT_CAS }),
    'F2-C09 reason >2000 rejected',
  );
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C10');
  await taskActions.requestTaskChanges({
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId, runId,
    reason: REASON, ...ACCEPT_CAS, callerSurface: 'PM_MCP',
  });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_CHANGES_REQUESTED' }).events;
  check(events.length === 1, `F2-C10 TASK_CHANGES_REQUESTED exactly once (got ${events.length})`);
}

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C11');
  const changed = await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, reason: REASON, ...ACCEPT_CAS,
  });
  check(changed.executionState !== 'READY', 'F2-C11 no automatic READY transition');
  check(changed.retryCount === undefined || changed.retryCount === 0, 'F2-C12 no automatic Retry (retryCount untouched)');
}

// ── F2-R: Retry ───────────────────────────────────────────────────────────────
console.log('\n── F2-R01..R11 Retry ──');

{
  const g = await makeGoal();
  const { task } = await makeChangesRequestedTask(g.goalId, 'R01');
  const before = task.retryCount ?? 0;
  const retried = await rt.requestRetry(TEST_ROOT, project, task.taskId, { goalId: g.goalId, ...RETRY_CAS });
  check(retried.executionState === 'READY' && retried.pmState === 'PENDING', 'F2-R01 RESULT_RECEIVED+CHANGES_REQUESTED -> READY+PENDING');
  check((retried.retryCount ?? 0) === before + 1, 'F2-R02 retryCount increments');
  check(retried.linkedRuns.length === task.linkedRuns.length, 'F2-R03 linkedRuns preserved');
  check(retried.nextTaskRunSequence >= task.nextTaskRunSequence, 'F2-R04 nextTaskRunSequence preserved/monotonic');
  check(retried.linkedRuns.length === 1, 'F2-R05 no new Run created');
}

{
  const g = await makeGoal();
  const { task } = await makeChangesRequestedTask(g.goalId, 'R06');
  await rt.requestRetry(TEST_ROOT, project, task.taskId, { goalId: g.goalId, ...RETRY_CAS });
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === 'READY', 'F2-R06 no dispatch occurs (Task left READY, not DISPATCHED)');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'R07', goal: 'g', reason: 'r', scope: 's',
    executionState: 'FAILED', pmState: 'PENDING',
  });
  await shouldThrow(
    () => rt.requestRetry(TEST_ROOT, project, t.taskId, { goalId: g.goalId, ...RETRY_CAS }),
    'F2-R07 FAILED retry rejected',
    'CONFLICT',
  );
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'R08', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.requestRetry(TEST_ROOT, project, t.taskId, { goalId: g.goalId, ...RETRY_CAS }),
    'F2-R08 stale execution CAS -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-R08 no write');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'R09', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING',
  });
  const before = gt.getTask(TEST_ROOT, project, t.taskId).updatedAt;
  await shouldThrow(
    () => rt.requestRetry(TEST_ROOT, project, t.taskId, { goalId: g.goalId, ...RETRY_CAS }),
    'F2-R09 stale PM CAS -> CONFLICT',
    'CONFLICT',
  );
  check(gt.getTask(TEST_ROOT, project, t.taskId).updatedAt === before, 'F2-R09 no write');
}

{
  const g = await makeGoal();
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: g.goalId, title: 'R10', goal: 'g', reason: 'r', scope: 's',
    executionState: 'RESULT_RECEIVED', pmState: 'ACCEPTED',
  });
  await shouldThrow(
    () => rt.requestRetry(TEST_ROOT, project, t.taskId, { goalId: g.goalId, ...RETRY_CAS }),
    'F2-R10 accepted Task retry rejected',
    'CONFLICT',
  );
}

{
  const g = await makeGoal();
  const { task } = await makeChangesRequestedTask(g.goalId, 'R11');
  await taskActions.requestTaskRetry({
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
    ...RETRY_CAS, callerSurface: 'OWNER_IPC',
  });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RETRY_REQUESTED' }).events;
  check(events.length === 1, `F2-R11 TASK_RETRY_REQUESTED exactly once (got ${events.length})`);
}

// ── F2-P: Permission matrix (frozen — both surfaces, all 3 modes) ────────────
console.log('\n── F2-P Permission matrix ──');

{
  const effects = ['ACCEPT_RESULT', 'REQUEST_CHANGES', 'REQUEST_RETRY'];
  const surfaces = ['OWNER_IPC', 'PM_MCP'];
  const modes = ['PLAN', 'APPROVE', 'BYPASS'];
  for (const effect of effects) {
    for (const callerSurface of surfaces) {
      for (const mode of modes) {
        const result = perm.evaluateEffect({ effect, callerSurface, permissionPolicy: { mode } });
        check(result.allowed === true, `F2-P ${effect} ${callerSurface} ${mode} allowed`);
      }
    }
  }
  // PM does not gain Owner-only effects via this surface.
  for (const effect of ['MERGE_MAIN', 'RELEASE', 'DESTRUCTIVE_ACTION', 'PRODUCTION_DEPLOY', 'SECRET_CHANGE']) {
    const result = perm.evaluateEffect({ effect, callerSurface: 'PM_MCP', permissionPolicy: { mode: 'BYPASS' } });
    check(result.allowed === false, `F2-P PM does not gain Owner-only ${effect} even BYPASS`);
  }
}

// No wrapper-specific bypass: main.ts / pm-tools.ts must route through task-actions.ts
// (the single authoritative authorizeEffect(...) call site), not call
// goal-task-runtime accept/changes/retry directly.
{
  const srcMain = fs.readFileSync(path.resolve('src/backend/main.ts'), 'utf8');
  const srcPmTools = fs.readFileSync(path.resolve('src/mcp/pm-tools.ts'), 'utf8');
  const srcTaskActions = fs.readFileSync(path.resolve('src/backend/task-actions.ts'), 'utf8');

  check(
    /effect:\s*'ACCEPT_RESULT'/.test(srcTaskActions)
      && /effect:\s*'REQUEST_CHANGES'/.test(srcTaskActions)
      && /effect:\s*'REQUEST_RETRY'/.test(srcTaskActions),
    'F2-P task-actions.ts gates all three judgment effects via authorizeEffect',
  );
  check(
    srcMain.includes('taskActions.acceptTaskResult(')
      && srcMain.includes('taskActions.requestTaskChanges(')
      && srcMain.includes('taskActions.requestTaskRetry('),
    'F2-P main.ts (OWNER_IPC) routes accept/changes/retry through task-actions.ts',
  );
  check(
    !/goalTaskRuntime\.acceptResult\(|goalTaskRuntime\.requestChanges\(|goalTaskRuntime\.requestRetry\(/.test(srcMain),
    'F2-P main.ts no longer calls goal-task-runtime accept/changes/retry directly (no bypass)',
  );
  check(
    srcPmTools.includes('taskActions.acceptTaskResult(')
      && srcPmTools.includes('taskActions.requestTaskChanges(')
      && srcPmTools.includes('taskActions.requestTaskRetry('),
    'F2-P pm-tools.ts (PM_MCP) routes accept/changes/retry through task-actions.ts',
  );
  check(
    !/goalTaskRuntime\.acceptResult\(|goalTaskRuntime\.requestChanges\(|goalTaskRuntime\.requestRetry\(/.test(srcPmTools),
    'F2-P pm-tools.ts no longer calls goal-task-runtime accept/changes/retry directly (no bypass)',
  );
}

// ── F2-E: Audit Event tests ──────────────────────────────────────────────────
console.log('\n── F2-E Action Event audit ──');

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'E-immutable');
  const before = gt.getTask(TEST_ROOT, project, task.taskId);
  await taskActions.acceptTaskResult({
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId, runId,
    ...ACCEPT_CAS, reason: REASON, callerSurface: 'PM_MCP',
  });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED' }).events;
  const e = events[0];

  check(e.source.kind === 'pm-mcp' && e.source.subsystem === 'task-actions/accept-result', 'F2-E source kind/subsystem (PM_MCP)');
  check(e.details?.before?.pmState === before.pmState && e.details?.before?.executionState === before.executionState, 'F2-E before snapshot correct');
  check(e.details?.after?.pmState === 'ACCEPTED', 'F2-E after snapshot correct');
  check(e.details?.reason === REASON, 'F2-E bounded reason carried');
  check(!!e.occurredAt && !!e.recordedAt, 'F2-E occurredAt/recordedAt present');

  const eventFile = evk.eventFolder(TEST_ROOT, project, e.eventId);
  const jsonPath = path.join(eventFile, 'event.json');
  const raw1 = fs.readFileSync(jsonPath, 'utf8');
  // Re-read via kernel (no direct mutation API exists) — confirm content stable.
  const reread = evk.getEvent(TEST_ROOT, project, e.eventId);
  check(JSON.stringify(reread) === JSON.stringify(e), 'F2-E immutable event.json (stable re-read)');
  void raw1;

  // Delivery lifecycle untouched — remains PENDING like any other Event.
  const delivery = evk.getDelivery(TEST_ROOT, project, e.eventId);
  check(delivery.status === 'PENDING', 'F2-E delivery semantics untouched (starts PENDING)');
}

{
  const g = await makeGoal();
  const { task } = await makeChangesRequestedTask(g.goalId, 'E-owner-source');
  await taskActions.requestTaskRetry({
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
    ...RETRY_CAS, callerSurface: 'OWNER_IPC',
  });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RETRY_REQUESTED' }).events;
  check(events[0].source.kind === 'owner-ipc' && events[0].source.subsystem === 'task-actions/request-retry', 'F2-E source kind/subsystem (OWNER_IPC)');
  check(typeof events[0].details?.retryCount === 'number', 'F2-E retryCount carried in details');
}

// ── F2-Closed-loop regression: PM MCP tools end-to-end ───────────────────────
console.log('\n── F2 Closed-loop MCP regression ──');

{
  const g = await makeGoal('BYPASS', 'MCP Closed Loop');
  const { task, runId } = await makeVerifyingTask(g.goalId, 'MCP Accept');
  const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const result = await byName.relay_pm_accept_result.handler({
    goalId: g.goalId, taskId: task.taskId, runId, ...ACCEPT_CAS,
  });
  check(result.pmState === 'ACCEPTED', 'F2 relay_pm_accept_result end-to-end via MCP');

  const events = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED' }).events;
  check(events.length === 1, 'F2 MCP accept_result emits exactly one Action Event');
}

{
  const g = await makeGoal('BYPASS', 'MCP Closed Loop Changes/Retry');
  const { task, runId } = await makeVerifyingTask(g.goalId, 'MCP Changes');
  const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const changed = await byName.relay_pm_request_changes.handler({
    goalId: g.goalId, taskId: task.taskId, runId, reason: REASON, ...ACCEPT_CAS,
  });
  check(changed.pmState === 'CHANGES_REQUESTED', 'F2 relay_pm_request_changes end-to-end via MCP');

  const retried = await byName.relay_pm_request_retry.handler({
    goalId: g.goalId, taskId: task.taskId, ...RETRY_CAS,
  });
  check(retried.executionState === 'READY' && retried.pmState === 'PENDING', 'F2 relay_pm_request_retry end-to-end via MCP');

  const changesEvents = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_CHANGES_REQUESTED' }).events;
  const retryEvents = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RETRY_REQUESTED' }).events;
  check(changesEvents.length === 1 && retryEvents.length === 1, 'F2 MCP changes+retry each emit exactly one Action Event');
}

// ── F2-Race: cross-mutation CAS regression ───────────────────────────────────
console.log('\n── F2-Race cross-mutation CAS ──');

{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'Race Accept vs Changes');

  const results = await Promise.allSettled([
    taskActions.acceptTaskResult({
      dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId, runId,
      ...ACCEPT_CAS, callerSurface: 'OWNER_IPC',
    }),
    taskActions.requestTaskChanges({
      dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId, runId,
      reason: REASON, ...ACCEPT_CAS, callerSurface: 'PM_MCP',
    }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.filter((r) => r.status === 'rejected').length;
  check(ok === 1 && fail === 1, `F2-Race Accept vs Changes — exactly one winner (ok=${ok} fail=${fail})`);

  const final = gt.getTask(TEST_ROOT, project, task.taskId);
  const consistent =
    (final.pmState === 'ACCEPTED' && final.acceptedRunId === runId)
    || (final.pmState === 'CHANGES_REQUESTED' && !final.acceptedRunId);
  check(consistent, `F2-Race no impossible combination (pmState=${final.pmState} acceptedRunId=${final.acceptedRunId})`);

  // Exactly one Action Event of the winning type was recorded — loser produced none.
  const acceptEvents = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED' }).events;
  const changesEvents = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_CHANGES_REQUESTED' }).events;
  check(acceptEvents.length + changesEvents.length === 1, 'F2-Race exactly one Action Event recorded for the winner');
}

{
  const g = await makeGoal();
  const { task } = await makeChangesRequestedTask(g.goalId, 'Race Retry vs Retry');

  const results = await Promise.allSettled([
    taskActions.requestTaskRetry({
      dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
      ...RETRY_CAS, callerSurface: 'OWNER_IPC',
    }),
    taskActions.requestTaskRetry({
      dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
      ...RETRY_CAS, callerSurface: 'PM_MCP',
    }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const fail = results.filter((r) => r.status === 'rejected').length;
  check(ok === 1 && fail === 1, `F2-Race stale Retry vs Retry — exactly one winner (ok=${ok} fail=${fail})`);

  const final = gt.getTask(TEST_ROOT, project, task.taskId);
  check(final.executionState === 'READY' && final.pmState === 'PENDING', 'F2-Race final state READY+PENDING (not double-retried)');
  check((final.retryCount ?? 0) === 1, 'F2-Race retryCount incremented exactly once, not twice');

  const retryEvents = evk.listEvents(TEST_ROOT, project, { taskId: task.taskId, type: 'TASK_RETRY_REQUESTED' }).events;
  check(retryEvents.length === 1, 'F2-Race exactly one TASK_RETRY_REQUESTED Event recorded');
}

console.log(`\nPhase I3F-2 tests: ${passed} passed, ${failed} failed`);
try {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
} catch { /* ignore */ }
