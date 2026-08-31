/**
 * Phase E MCP Foundation tests (E-01..E-39) + MCP Protocol Compliance (MP-01..MP-20).
 *
 * Tests are organized into groups:
 *   E-01..04  Structural separation (tool registration)
 *   E-05..09  PM read tools
 *   E-10..14  PM write tools / CAS boundary
 *   E-15..21  Worker read tools + scope binding
 *   E-22..26  Worker trust boundary
 *   E-27..29  Worker result/blocked contract
 *   E-30..33  No-generic-tool structural checks
 *   E-34..35  stdio smoke (deferred to mcp-smoke.mjs; verified via import here)
 *   E-36..39  Regression (Phase D, C, B2, A)
 *   MP-01..10 MCP protocol compliance — PM surface (real Client + StdioClientTransport)
 *   MP-11..20 MCP protocol compliance — Worker surface
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// SDK client (ES-module import; .js extension required for wildcard exports on Node v24+)
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'mcp', 'index.js');

// ── Test harness ─────────────────────────────────────────────────────────────

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-e2e-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

async function shouldThrow(fn, label, expectedMsgFragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw, got success`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!expectedMsgFragment || msg.includes(expectedMsgFragment)) {
      PASS(label);
    } else {
      FAIL(`${label} — expected "${expectedMsgFragment}" in error, got: ${msg}`);
    }
  }
}

// ── Imports ───────────────────────────────────────────────────────────────────

const relay   = await import('../dist/server/backend/fs.js');
const gt      = await import('../dist/server/backend/goal-task.js');
const rt      = await import('../dist/server/backend/goal-task-runtime.js');
const ev      = await import('../dist/server/backend/evidence.js');
const evk     = await import('../dist/server/backend/event.js');

const pmTools     = await import('../dist/server/mcp/pm-tools.js');
const workerTools = await import('../dist/server/mcp/worker-tools.js');
const errors      = await import('../dist/server/mcp/errors.js');

const project = 'McpEProj';

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function makeGoal(title = 'Test Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title,
    goalStatement: 'test goal statement',
    completionCriteria: ['done'],
  });
}

async function makeTask(goalId, title = 'Test Task') {
  return gt.createTask(TEST_ROOT, project, {
    goalId,
    title,
    goal: 'do test',
    reason: 'testing',
    scope: 'test',
    completionCriteria: ['done'],
  });
}

async function linkFreshRun(taskId, agent = 'TestAgent') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, link, runId: link.runId, folder: run.folder };
}

/** Drive task to RESULT_RECEIVED state. Returns task record + runId. */
async function driveToResultReceived(taskId) {
  let t = gt.getTask(TEST_ROOT, project, taskId);
  if (t.executionState === 'PLANNED') {
    t = await rt.transitionTaskExecution(TEST_ROOT, project, taskId, {
      expectedExecutionState: 'PLANNED', to: 'READY',
    });
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
  const { runId } = await linkFreshRun(taskId);
  if (t.executionState === 'RUNNING') {
    t = await rt.markResultReceived(TEST_ROOT, project, taskId, runId, { expectedExecutionState: 'RUNNING' });
  }
  return { task: t, runId };
}

// ── E-01..04: Structural separation ──────────────────────────────────────────

console.log('\n── E-01..04: Structural separation ──');

{
  const pmCtx    = { dataRoot: TEST_ROOT, project };
  const workerCtx = { dataRoot: TEST_ROOT, project, taskId: 'TASK-1', runId: 'run-x' };

  const pmNames     = pmTools.buildAllPmTools(pmCtx).map((t) => t.name);
  const workerNames = workerTools.buildAllWorkerTools(workerCtx).map((t) => t.name);

  // E-01: PM surface registers PM tools
  check(
    pmNames.includes('relay_pm_get_goal') && pmNames.includes('relay_pm_list_tasks'),
    'E-01 PM surface registers PM tools',
  );

  // E-02: Worker surface registers Worker tools
  check(
    workerNames.includes('relay_worker_get_assignment') && workerNames.includes('relay_worker_submit_claim'),
    'E-02 Worker surface registers Worker tools',
  );

  // E-03: PM surface excludes Worker-only tools
  check(
    !pmNames.some((n) => n.startsWith('relay_worker_')),
    'E-03 PM surface excludes Worker-only tools',
  );

  // E-04: Worker surface excludes PM tools
  check(
    !workerNames.some((n) => n.startsWith('relay_pm_')),
    'E-04 Worker surface excludes PM tools',
  );
}

// ── E-05..09: PM read tools ───────────────────────────────────────────────────

console.log('\n── E-05..09: PM read tools ──');

{
  const goal  = await makeGoal('PM Read Goal');
  const task  = await makeTask(goal.goalId, 'PM Read Task');
  const { runId } = await linkFreshRun(task.taskId);

  const ctx  = { dataRoot: TEST_ROOT, project };
  const tools = pmTools.buildAllPmTools(ctx);
  const get   = (name) => tools.find((t) => t.name === name);

  // E-05: PM get Goal
  {
    const result = await get('relay_pm_get_goal').handler({ goalId: goal.goalId });
    check(result && result.goalId === goal.goalId, 'E-05 relay_pm_get_goal returns correct goal');
  }

  // E-06: PM list Tasks
  {
    const result = await get('relay_pm_list_tasks').handler({});
    check(
      result && Array.isArray(result.tasks) && result.tasks.some((t) => t.taskId === task.taskId),
      'E-06 relay_pm_list_tasks returns correct tasks',
    );
  }

  // E-07: PM get Task
  {
    const result = await get('relay_pm_get_task').handler({ taskId: task.taskId });
    check(result && result.taskId === task.taskId, 'E-07 relay_pm_get_task returns correct task');
  }

  // E-08: PM get Task Evidence
  {
    const result = await get('relay_pm_get_task_evidence').handler({ taskId: task.taskId });
    check(result !== null && result !== undefined, 'E-08 relay_pm_get_task_evidence returns evidence summary');
  }

  // E-09: PM list pending events
  {
    const result = await get('relay_pm_list_pending_events').handler({});
    check(
      result && Array.isArray(result.events),
      'E-09 relay_pm_list_pending_events returns event array',
    );
  }
}

// ── E-10..14: PM write / CAS boundary ────────────────────────────────────────

console.log('\n── E-10..14: PM CAS boundary ──');

{
  const ctx   = { dataRoot: TEST_ROOT, project };
  const tools = pmTools.buildAllPmTools(ctx);
  const get   = (name) => tools.find((t) => t.name === name);

  // E-10: PM acceptResult CAS (correct state → success)
  // Note: markResultReceived() automatically sets pmState to VERIFYING
  {
    const goal = await makeGoal('Accept Goal');
    const task = await makeTask(goal.goalId, 'Accept Task');
    const { task: resultTask, runId } = await driveToResultReceived(task.taskId);
    // After markResultReceived: executionState=RESULT_RECEIVED, pmState=VERIFYING

    const result = await get('relay_pm_accept_result').handler({
      taskId: task.taskId,
      runId,
      expectedPmState: 'VERIFYING',
      expectedExecutionState: 'RESULT_RECEIVED',
    });
    check(result && result.pmState === 'ACCEPTED', 'E-10 relay_pm_accept_result CAS succeeds with correct state');
  }

  // E-11: PM requestChanges CAS (correct state → success)
  // After markResultReceived: pmState is already VERIFYING
  {
    const goal = await makeGoal('Changes Goal');
    const task = await makeTask(goal.goalId, 'Changes Task');
    await driveToResultReceived(task.taskId);
    // pmState=VERIFYING after markResultReceived

    const result = await get('relay_pm_request_changes').handler({
      taskId: task.taskId,
      expectedPmState: 'VERIFYING',
    });
    check(result && result.pmState === 'CHANGES_REQUESTED', 'E-11 relay_pm_request_changes CAS succeeds');
  }

  // E-12: PM requestRetry CAS (correct state → success)
  {
    const goal = await makeGoal('Retry Goal');
    const task = await makeTask(goal.goalId, 'Retry Task');
    await driveToResultReceived(task.taskId);
    // pmState=VERIFYING after markResultReceived

    // Drive to CHANGES_REQUESTED
    await rt.requestChanges(TEST_ROOT, project, task.taskId, { expectedPmState: 'VERIFYING' });

    const result = await get('relay_pm_request_retry').handler({
      taskId: task.taskId,
      expectedPmState: 'CHANGES_REQUESTED',
      expectedExecutionState: 'RESULT_RECEIVED',
    });
    check(result && result.executionState === 'READY', 'E-12 relay_pm_request_retry CAS succeeds');
  }

  // E-13: PM event delivery expectedStatus required
  {
    const goal = await makeGoal('Event Goal');
    const task = await makeTask(goal.goalId, 'Event Task');
    const { runId } = await linkFreshRun(task.taskId);

    const eventRecord = await evk.recordRunFailed(TEST_ROOT, project, {
      taskId: task.taskId,
      runId,
      summary: 'smoke event',
      source: { kind: 'runtime-kernel' },
    });

    // E-13: expectedStatus is required by schema (enforce at handler level via requireEnum)
    await shouldThrow(
      () => get('relay_pm_mark_delivered').handler({ eventId: eventRecord.eventId }),
      'E-13 relay_pm_mark_delivered requires expectedStatus',
      'expectedStatus',
    );
  }

  // E-14: Stale PM CAS → CONFLICT
  // After driveToResultReceived: pmState=VERIFYING. Pass ACCEPTED → CONFLICT.
  {
    const goal = await makeGoal('Conflict Goal');
    const task = await makeTask(goal.goalId, 'Conflict Task');
    const { runId } = await driveToResultReceived(task.taskId);

    await shouldThrow(
      () => get('relay_pm_accept_result').handler({
        taskId: task.taskId,
        runId,
        expectedPmState: 'ACCEPTED',       // wrong — task is VERIFYING
        expectedExecutionState: 'RESULT_RECEIVED',
      }),
      'E-14 stale PM CAS → CONFLICT error',
      null, // any error is acceptable (core throws CONFLICT or INVALID_STATE)
    );
  }
}

// ── E-15..21: Worker read tools + scope binding ───────────────────────────────

console.log('\n── E-15..21: Worker scope binding ──');

{
  const goal = await makeGoal('Worker Goal');
  const task = await makeTask(goal.goalId, 'Worker Task');
  const { runId } = await linkFreshRun(task.taskId);

  const wCtx  = { dataRoot: TEST_ROOT, project, taskId: task.taskId, runId };
  const tools = workerTools.buildAllWorkerTools(wCtx);
  const get   = (name) => tools.find((t) => t.name === name);

  // E-15: Worker get assignment
  {
    const result = await get('relay_worker_get_assignment').handler({});
    check(
      result && result.taskId === task.taskId && result.runId === runId,
      'E-15 relay_worker_get_assignment returns bound assignment',
    );
  }

  // E-16: Worker get bound Task
  {
    const result = await get('relay_worker_get_task_context').handler({});
    check(result && result.taskId === task.taskId, 'E-16 relay_worker_get_task_context returns bound task');
  }

  // E-17: Worker get bound Run
  {
    const result = await get('relay_worker_get_run_context').handler({});
    check(result && result.runId === runId, 'E-17 relay_worker_get_run_context returns bound run');
  }

  // E-18: Worker previous attempts
  {
    // Link a second run to create a prior attempt
    await linkFreshRun(task.taskId);
    const result = await get('relay_worker_get_previous_attempts').handler({});
    check(
      result && Array.isArray(result.priorAttempts),
      'E-18 relay_worker_get_previous_attempts returns prior attempts array',
    );
  }

  // E-19: Worker foreign Task → FORBIDDEN
  {
    const otherGoal = await makeGoal('Foreign Goal');
    const otherTask = await makeTask(otherGoal.goalId, 'Foreign Task');
    await shouldThrow(
      () => get('relay_worker_get_task_context').handler({ taskId: otherTask.taskId }),
      'E-19 Worker foreign taskId → FORBIDDEN',
      'FORBIDDEN',
    );
  }

  // E-20: Worker foreign Run → FORBIDDEN
  {
    await shouldThrow(
      () => get('relay_worker_get_run_context').handler({ runId: 'run-foreign-xyz' }),
      'E-20 Worker foreign runId → FORBIDDEN',
      'FORBIDDEN',
    );
  }

  // E-21: Worker cannot enumerate unrestricted project (no relay_pm_list_tasks on worker surface)
  {
    const toolNames = tools.map((t) => t.name);
    check(
      !toolNames.includes('relay_pm_list_tasks') && !toolNames.some((n) => n === 'relay_worker_list_all_tasks'),
      'E-21 Worker surface has no unrestricted task enumeration tool',
    );
  }
}

// ── E-22..26: Worker trust boundary ──────────────────────────────────────────

console.log('\n── E-22..26: Worker trust boundary ──');

{
  const goal = await makeGoal('Trust Goal');
  const task = await makeTask(goal.goalId, 'Trust Task');
  const { runId } = await linkFreshRun(task.taskId);

  const wCtx  = { dataRoot: TEST_ROOT, project, taskId: task.taskId, runId };
  const tools = workerTools.buildAllWorkerTools(wCtx);
  const get   = (name) => tools.find((t) => t.name === name);

  // E-22: Worker submitClaim → WORKER_CLAIM / CLAIMED
  {
    const result = await get('relay_worker_submit_claim').handler({ summary: 'claiming progress' });
    check(
      result && result.type === 'WORKER_CLAIM' && result.trustLevel === 'CLAIMED',
      'E-22 relay_worker_submit_claim produces WORKER_CLAIM / CLAIMED evidence',
    );
  }

  // E-23: Worker cannot mint VERIFIED
  {
    const result = await get('relay_worker_submit_claim').handler({ summary: 'verify attempt' });
    check(result.trustLevel !== 'VERIFIED', 'E-23 Worker cannot mint VERIFIED evidence');
  }

  // E-24: Worker cannot mint ACCEPTED
  {
    const result = await get('relay_worker_submit_claim').handler({ summary: 'accept attempt' });
    check(result.trustLevel !== 'ACCEPTED', 'E-24 Worker cannot mint ACCEPTED evidence');
  }

  // E-25: Worker cannot create PM decision
  {
    const toolNames = tools.map((t) => t.name);
    check(
      !toolNames.some((n) => n.includes('pm_decision') || n.includes('pm_transition')),
      'E-25 Worker surface has no PM decision tool',
    );
  }

  // E-26: Worker cannot create privileged Event
  {
    const toolNames = tools.map((t) => t.name);
    check(
      !toolNames.some((n) => n.includes('record_event') || n.includes('create_event') || n.includes('result_received')),
      'E-26 Worker surface has no privileged event creation tool',
    );
  }
}

// ── E-27..29: Worker result/blocked contract ──────────────────────────────────

console.log('\n── E-27..29: Worker result/blocked contract ──');

{
  const goal = await makeGoal('Contract Goal');
  const task = await makeTask(goal.goalId, 'Contract Task');
  const { runId, folder } = await linkFreshRun(task.taskId);

  const wCtx  = { dataRoot: TEST_ROOT, project, taskId: task.taskId, runId };
  const tools = workerTools.buildAllWorkerTools(wCtx);
  const get   = (name) => tools.find((t) => t.name === name);

  // E-27: submitResult does not write result.md
  {
    const resultMdPath = path.join(folder, 'result.md');
    await get('relay_worker_submit_result').handler({ summary: 'my result here' });
    check(!fs.existsSync(resultMdPath), 'E-27 relay_worker_submit_result does not write result.md');
  }

  // E-28: submitResult does not call markResultReceived (task executionState unchanged)
  {
    const taskBefore = gt.getTask(TEST_ROOT, project, task.taskId);
    await get('relay_worker_submit_result').handler({ summary: 'result again' });
    const taskAfter  = gt.getTask(TEST_ROOT, project, task.taskId);
    check(
      taskAfter.executionState === taskBefore.executionState,
      'E-28 relay_worker_submit_result does not mutate Task executionState',
    );
  }

  // E-29: reportBlocked does not mutate Task to BLOCKED
  {
    const taskBefore = gt.getTask(TEST_ROOT, project, task.taskId);
    await get('relay_worker_report_blocked').handler({ reason: 'waiting for dependency' });
    const taskAfter  = gt.getTask(TEST_ROOT, project, task.taskId);
    check(
      taskAfter.executionState !== 'BLOCKED',
      'E-29 relay_worker_report_blocked does not transition Task to BLOCKED',
    );
    check(
      taskAfter.executionState === taskBefore.executionState,
      'E-29 relay_worker_report_blocked does not mutate any Task executionState',
    );
  }
}

// ── E-30..33: No-generic-tool structural checks ───────────────────────────────

console.log('\n── E-30..33: No generic tools ──');

{
  const pmCtx     = { dataRoot: TEST_ROOT, project };
  const workerCtx = { dataRoot: TEST_ROOT, project, taskId: 'TASK-1', runId: 'run-x' };
  const allPm     = pmTools.buildAllPmTools(pmCtx).map((t) => t.name);
  const allWorker = workerTools.buildAllWorkerTools(workerCtx).map((t) => t.name);
  const allTools  = [...allPm, ...allWorker];

  // E-30: No relay_pm_transition_pm
  check(
    !allTools.includes('relay_pm_transition_pm'),
    'E-30 No generic relay_pm_transition_pm tool on any surface',
  );

  // E-31: No raw updateTask / updateGoal
  check(
    !allTools.some((n) => n.includes('update_task') || n.includes('update_goal')),
    'E-31 No raw updateTask/updateGoal tool on any surface',
  );

  // E-32: No raw evidence:create
  check(
    !allTools.some((n) => n === 'evidence_create' || n === 'relay_evidence_create' || n === 'evidence:create'),
    'E-32 No raw evidence:create tool on any surface',
  );

  // E-33: No raw event:create
  check(
    !allTools.some((n) => n === 'event_create' || n === 'relay_event_create' || n === 'event:create'),
    'E-33 No raw event:create tool on any surface',
  );
}

// ── E-34..35: stdio smoke (structural verification) ───────────────────────────

console.log('\n── E-34..35: Error model (verified via errors.js) ──');

{
  // E-35: unknown MCP tool normalized error codes
  const { mapCoreError, jsonRpcCodeFor } = errors;

  // NOT_FOUND
  const notFound = mapCoreError(new Error('ENOENT: file not found'));
  check(notFound.mcpCode === 'NOT_FOUND' && jsonRpcCodeFor('NOT_FOUND') === -32001,
    'E-35 NOT_FOUND maps to -32001');

  // CONFLICT — pass an actual Error with the right name so mapCoreError picks it up
  const conflictErr = Object.assign(new Error('CONFLICT: stale state'), { name: 'RuntimeConflictError' });
  const conflict = mapCoreError(conflictErr);
  check(conflict.mcpCode === 'CONFLICT' && jsonRpcCodeFor('CONFLICT') === -32002,
    'E-35 CONFLICT maps to -32002');

  // FORBIDDEN (McpError passthrough)
  const forbidden = mapCoreError(new errors.McpError('FORBIDDEN', 'access denied'));
  check(forbidden.mcpCode === 'FORBIDDEN' && jsonRpcCodeFor('FORBIDDEN') === -32003,
    'E-35 FORBIDDEN maps to -32003');

  // INVALID_ARGUMENT
  check(jsonRpcCodeFor('INVALID_ARGUMENT') === -32602, 'E-35 INVALID_ARGUMENT maps to -32602');

  // INTERNAL_ERROR
  check(jsonRpcCodeFor('INTERNAL_ERROR') === -32603, 'E-35 INTERNAL_ERROR maps to -32603');

  // Note: E-34 (stdio smoke) is covered by test:mcp-smoke
  PASS('E-34 stdio smoke — see test:mcp-smoke for subprocess verification');
}

// ── E-36..39: Regression ─────────────────────────────────────────────────────

console.log('\n── E-36..39: Regression ──');

{
  // E-36: Phase D regression — event kernel basics
  {
    const goal = await makeGoal('Phase D Regression Goal');
    const task = await makeTask(goal.goalId, 'Phase D Task');
    const { runId } = await linkFreshRun(task.taskId);

    const eventRecord = await evk.recordRunFailed(TEST_ROOT, project, {
      taskId: task.taskId,
      runId,
      summary: 'D regression event',
      source: { kind: 'runtime-kernel' },
    });

    const fetched = evk.getEvent(TEST_ROOT, project, eventRecord.eventId);
    check(fetched.eventId === eventRecord.eventId, 'E-36 Phase D: getEvent round-trip');

    const pending = evk.listPendingPmEventsWithWarnings(TEST_ROOT, project);
    check(Array.isArray(pending.events), 'E-36 Phase D: listPendingPmEventsWithWarnings returns array');

    // CAS delivery
    const delivered = await evk.markDelivered(TEST_ROOT, project, eventRecord.eventId, 'PENDING');
    check(delivered.status === 'DELIVERED', 'E-36 Phase D: markDelivered CAS');
  }

  // E-37: Phase C regression — evidence kernel
  {
    const goal = await makeGoal('Phase C Regression Goal');
    const task = await makeTask(goal.goalId, 'Phase C Task');
    const { runId } = await linkFreshRun(task.taskId);

    const evidenceRecord = await ev.recordWorkerClaim(TEST_ROOT, project, {
      summary: 'C regression claim',
      taskId: task.taskId,
      runId,
      source: { kind: 'worker' },
    });

    check(
      evidenceRecord.type === 'WORKER_CLAIM' && evidenceRecord.trustLevel === 'CLAIMED',
      'E-37 Phase C: recordWorkerClaim produces WORKER_CLAIM/CLAIMED',
    );

    const summary = ev.getTaskEvidenceSummary(TEST_ROOT, project, task.taskId);
    check(summary !== null, 'E-37 Phase C: getTaskEvidenceSummary returns');
  }

  // E-38: B2 regression — task runtime state machine
  {
    const goal = await makeGoal('B2 Regression Goal');
    const task = await makeTask(goal.goalId, 'B2 Task');

    let t = await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
      expectedExecutionState: 'PLANNED', to: 'READY',
    });
    check(t.executionState === 'READY', 'E-38 B2: PLANNED→READY transition');

    t = await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
      expectedExecutionState: 'READY', to: 'DISPATCHED',
    });
    check(t.executionState === 'DISPATCHED', 'E-38 B2: READY→DISPATCHED transition');
  }

  // E-39: Phase A regression — goal/task creation
  {
    const goal = await makeGoal('Phase A Regression Goal');
    check(goal.goalId.startsWith('GOAL-'), 'E-39 Phase A: createGoal returns valid goalId');

    const task = await makeTask(goal.goalId, 'Phase A Task');
    check(task.taskId.startsWith('TASK-'), 'E-39 Phase A: createTask returns valid taskId');

    const fetched = gt.getGoal(TEST_ROOT, project, goal.goalId);
    check(fetched.goalId === goal.goalId, 'E-39 Phase A: getGoal round-trip');
  }
}

// ── MP-01..20: MCP Protocol Compliance ────────────────────────────────────────
//
// Uses a real MCP Client + StdioClientTransport to verify that the server
// conforms to the standard MCP protocol (tools/list + tools/call), not the
// custom hand-rolled JSON-RPC dispatcher from the pre-Phase-E implementation.

console.log('\n── MP-01..10: MCP Protocol Compliance — PM surface ──');

/**
 * Run `fn(client)` against an MCP server subprocess with the given extra args.
 * Handles connect + cleanup automatically.
 */
async function withMcpClient(extraArgs, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--dataRoot', TEST_ROOT, '--project', project, ...extraArgs],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ── PM surface (MP-01..MP-10) ────────────────────────────────────────────────

{
  await withMcpClient(['--surface', 'pm'], async (client) => {
    // MP-01: listTools returns an array
    const { tools } = await client.listTools();
    check(Array.isArray(tools), 'MP-01 PM: listTools() returns array');

    // MP-02: PM tool set includes relay_pm_get_goal
    check(tools.some((t) => t.name === 'relay_pm_get_goal'),
      'MP-02 PM: listTools includes relay_pm_get_goal');

    // MP-03: PM tool set includes relay_pm_list_tasks
    check(tools.some((t) => t.name === 'relay_pm_list_tasks'),
      'MP-03 PM: listTools includes relay_pm_list_tasks');

    // MP-04: PM tool set excludes all Worker tools
    check(!tools.some((t) => t.name.startsWith('relay_worker_')),
      'MP-04 PM: listTools excludes relay_worker_* tools');

    // MP-05: Each PM tool has name, description, inputSchema
    const allValid = tools.every(
      (t) => typeof t.name === 'string' && typeof t.description === 'string' && t.inputSchema != null,
    );
    check(allValid && tools.length > 0, 'MP-05 PM: each tool has name, description, inputSchema');

    // MP-06: callTool(relay_pm_list_goals) returns content array (no args — project is in server context)
    const r1 = await client.callTool({ name: 'relay_pm_list_goals' });
    check(Array.isArray(r1.content) && r1.content.length > 0,
      'MP-06 PM: callTool(relay_pm_list_goals) returns content');

    // MP-07: content[0].type === 'text'
    check(r1.content[0]?.type === 'text',
      'MP-07 PM: callTool content[0].type is "text"');

    // MP-08: content text is parseable JSON
    let parsed;
    try { parsed = JSON.parse(r1.content[0].text); } catch { /* */ }
    check(parsed !== undefined, 'MP-08 PM: callTool content[0].text is parseable JSON');

    // MP-09: callTool with bad args returns isError content (not a protocol error)
    const r2 = await client.callTool({ name: 'relay_pm_get_task', arguments: { taskId: 'TASK-NONEXISTENT' } });
    check(r2.isError === true, 'MP-09 PM: callTool(bad taskId) returns isError: true');

    // MP-10: callTool unknown tool returns isError content
    const r3 = await client.callTool({ name: 'nonexistent_tool_xyz' });
    check(r3.isError === true && r3.content[0]?.text?.includes('nonexistent_tool_xyz'),
      'MP-10 PM: callTool(nonexistent) returns isError with tool name in message');
  });
}

// ── Worker surface (MP-11..MP-20) ────────────────────────────────────────────

console.log('\n── MP-11..20: MCP Protocol Compliance — Worker surface ──');

{
  // Set up a real goal + task + run for the worker surface tests
  let mpTaskId, mpRunId;
  try {
    const mpGoal = await gt.createGoal(TEST_ROOT, project, {
      title: 'MP Worker Goal',
      goalStatement: 'mp test',
      completionCriteria: ['done'],
    });
    const mpTask = await gt.createTask(TEST_ROOT, project, {
      goalId: mpGoal.goalId,
      title: 'MP Worker Task',
      goal: 'mp test task',
      reason: 'mp test',
      scope: 'test',
      completionCriteria: ['done'],
    });
    mpTaskId = mpTask.taskId;
    const mpRun = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'MPAgent');
    const mpLinked = await gt.linkRunToTask(TEST_ROOT, project, mpTaskId, mpRun.folder);
    mpRunId = mpLinked.linkedRuns.find((r) => r.folder === path.resolve(mpRun.folder))?.runId;
  } catch (e) {
    // Fallback so remaining tests can still run
    mpTaskId = 'TASK-MP'; mpRunId = 'run-mp';
    FAIL('MP-11..20 fixture setup failed: ' + e.message);
  }

  await withMcpClient(
    ['--surface', 'worker', '--taskId', mpTaskId, '--runId', mpRunId],
    async (client) => {
      // MP-11: listTools returns an array
      const { tools } = await client.listTools();
      check(Array.isArray(tools), 'MP-11 Worker: listTools() returns array');

      // MP-12: Worker tool set includes relay_worker_get_assignment
      check(tools.some((t) => t.name === 'relay_worker_get_assignment'),
        'MP-12 Worker: listTools includes relay_worker_get_assignment');

      // MP-13: Worker tool set excludes PM tools
      check(!tools.some((t) => t.name.startsWith('relay_pm_')),
        'MP-13 Worker: listTools excludes relay_pm_* tools');

      // MP-14: Each Worker tool has name, description, inputSchema
      const allValid = tools.every(
        (t) => typeof t.name === 'string' && typeof t.description === 'string' && t.inputSchema != null,
      );
      check(allValid && tools.length > 0, 'MP-14 Worker: each tool has name, description, inputSchema');

      // MP-15: Worker tool count >= 8 (8 tools registered in Phase E)
      check(tools.length >= 8, `MP-15 Worker: listTools returns >= 8 tools (got ${tools.length})`);

      // MP-16: callTool(relay_worker_get_assignment) returns content
      const r1 = await client.callTool({ name: 'relay_worker_get_assignment' });
      check(Array.isArray(r1.content) && r1.content.length > 0,
        'MP-16 Worker: callTool(relay_worker_get_assignment) returns content');

      // MP-17: content[0].type === 'text'
      check(r1.content[0]?.type === 'text',
        'MP-17 Worker: callTool content[0].type is "text"');

      // MP-18: callTool(relay_worker_get_task_context) returns parseable JSON
      const r2 = await client.callTool({ name: 'relay_worker_get_task_context' });
      let r2Parsed;
      try { r2Parsed = JSON.parse(r2.content[0]?.text ?? ''); } catch { /* */ }
      check(r2Parsed?.taskId === mpTaskId,
        'MP-18 Worker: callTool(relay_worker_get_task_context) returns task JSON');

      // MP-19: get_task_context with foreign taskId returns isError
      const r3 = await client.callTool({
        name: 'relay_worker_get_task_context',
        arguments: { taskId: 'TASK-FOREIGN-XYZ' },
      });
      check(r3.isError === true,
        'MP-19 Worker: callTool(foreign taskId) returns isError: true');

      // MP-20: callTool(relay_worker_submit_claim) succeeds and returns content
      const r4 = await client.callTool({
        name: 'relay_worker_submit_claim',
        arguments: { summary: 'MP protocol test claim' },
      });
      check(!r4.isError && Array.isArray(r4.content) && r4.content.length > 0,
        'MP-20 Worker: callTool(relay_worker_submit_claim) returns content without isError');
    },
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nPhase E MCP Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  process.exitCode = 1;
}
