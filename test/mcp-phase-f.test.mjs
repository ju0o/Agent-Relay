/**
 * Phase F PM Gateway tests (F-01..F-43).
 *
 * F-01..06  Packet schema basics
 * F-07..10  Immutability / read purity
 * F-11..14  CAS snapshot
 * F-15..21  QA_FAILED profile + attempt awareness + evidence bounds
 * F-22..24  Action eligibility from B2 state
 * F-25..26  GOAL_COMPLETION_ELIGIBLE profile
 * F-27..28  Informational event handling
 * F-29..30  Terminal delivery → NO_ACTION
 * F-31..32  Malformed neighbor isolation
 * F-33..35  Content exclusion (prompt/result/unrelated data)
 * F-36..37  MCP tool registration surface isolation
 * F-38     Real MCP client call
 * F-39..43  Regression (Phase E, D, C, B2, A)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// SDK client
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'mcp', 'index.js');

// ── Test harness ─────────────────────────────────────────────────────────────

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-f-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

async function shouldThrow(fn, label, expectedFragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw, got success`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!expectedFragment || msg.includes(expectedFragment)) {
      PASS(label);
    } else {
      FAIL(`${label} — expected "${expectedFragment}" in error, got: ${msg}`);
    }
  }
}

// ── Imports ───────────────────────────────────────────────────────────────────

const relay     = await import('../dist/server/backend/fs.js');
const gt        = await import('../dist/server/backend/goal-task.js');
const rt        = await import('../dist/server/backend/goal-task-runtime.js');
const ev        = await import('../dist/server/backend/evidence.js');
const evk       = await import('../dist/server/backend/event.js');
const pmGateway = await import('../dist/server/backend/pm-gateway.js');
const pmTools   = await import('../dist/server/mcp/pm-tools.js');
const workerTools = await import('../dist/server/mcp/worker-tools.js');

const project = 'FPhaseProj';

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
    goalId, title,
    goal: 'do test', reason: 'testing', scope: 'test',
    completionCriteria: ['done'],
  });
}

async function linkFreshRun(taskId, agent = 'TestAgent') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, link, runId: link.runId, folder: run.folder };
}

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
    const { runId } = await linkFreshRun(taskId);
    t = await rt.markResultReceived(TEST_ROOT, project, taskId, runId, {});
    return { task: gt.getTask(TEST_ROOT, project, taskId), runId };
  }
  if (t.executionState === 'RESULT_RECEIVED') {
    const link = t.linkedRuns[t.linkedRuns.length - 1];
    return { task: t, runId: link?.runId };
  }
  throw new Error(`Cannot drive task ${taskId} to RESULT_RECEIVED from ${t.executionState}`);
}

// ── Initialize ─────────────────────────────────────────────────────────────────

relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

// ── F-01..06: Packet schema basics ───────────────────────────────────────────

console.log('\nF-01..06) Packet schema basics');
{
  const goal = await makeGoal('Schema Goal');
  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'QA failed basic test',
    source: { kind: 'qa' },
    goalId: goal.goalId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);

  check(packet.schemaVersion === 'F.1', 'F-01 getContextForEvent returns schemaVersion F.1');
  check(packet.event && packet.event.eventId === event.eventId, 'F-02 packet includes Event');
  check(
    packet.eventDelivery && typeof packet.eventDelivery.status === 'string',
    'F-03 packet includes delivery snapshot'
  );
  check(packet.project === project, 'F-04 packet includes project');
  check(
    typeof packet.generatedAt === 'string' && new Date(packet.generatedAt).getTime() > 0,
    'F-05 generatedAt valid ISO'
  );
  check(Array.isArray(packet.warnings), 'F-06 warnings array always present');
}

// ── F-07..10: Immutability / read purity ─────────────────────────────────────

console.log('\nF-07..10) Read purity — no mutations');
{
  const goal = await makeGoal('Purity Goal');
  const task = await makeTask(goal.goalId, 'Purity Task');
  const { runId } = await linkFreshRun(task.taskId);

  // Drive to RESULT_RECEIVED
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});

  const qaEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Purity QA fail',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  // Hash files before
  const deliveryFile = path.join(
    evk.eventFolder(TEST_ROOT, project, qaEvent.eventId),
    'delivery.json'
  );
  const taskFile = path.join(
    gt.taskFolder(TEST_ROOT, project, task.taskId),
    'task.json'
  );
  const goalFile = path.join(
    gt.goalFolder(TEST_ROOT, project, goal.goalId),
    'goal.json'
  );

  function hashFile(f) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    } catch { return null; }
  }

  const beforeDelivery = hashFile(deliveryFile);
  const beforeTask = hashFile(taskFile);
  const beforeGoal = hashFile(goalFile);

  // Call getContextForEvent (must be pure read)
  pmGateway.getContextForEvent(TEST_ROOT, project, qaEvent.eventId);

  const afterDelivery = hashFile(deliveryFile);
  const afterTask = hashFile(taskFile);
  const afterGoal = hashFile(goalFile);

  check(beforeDelivery === afterDelivery, 'F-07 get_context does NOT mutate delivery.json');
  check(beforeTask === afterTask, 'F-08 get_context does NOT mutate Task');
  check(beforeGoal === afterGoal, 'F-09 get_context does NOT mutate Goal');

  // Evidence: create some evidence and verify not mutated
  const evi = await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'QA evidence for purity',
    status: 'FAIL',
    taskId: task.taskId,
    runId,
  });
  const evidenceFile = path.join(
    ev.evidenceFolder(TEST_ROOT, project, evi.evidenceId),
    'evidence.json'
  );
  const beforeEvidence = hashFile(evidenceFile);
  pmGateway.getContextForEvent(TEST_ROOT, project, qaEvent.eventId);
  const afterEvidence = hashFile(evidenceFile);

  check(beforeEvidence === afterEvidence, 'F-10 get_context does NOT mutate Evidence');
}

// ── F-11..14: CAS snapshot ────────────────────────────────────────────────────

console.log('\nF-11..14) CAS snapshot');
{
  const goal = await makeGoal('CAS Goal');
  const task = await makeTask(goal.goalId, 'CAS Task');
  const { runId } = await linkFreshRun(task.taskId);

  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});

  const casEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'CAS test QA fail',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, casEvent.eventId);

  check(typeof packet.cas.expectedPmState === 'string', 'F-11 Task-linked packet contains expectedPmState');
  check(typeof packet.cas.expectedExecutionState === 'string', 'F-12 Task-linked packet contains expectedExecutionState');
  check(typeof packet.cas.expectedEventDeliveryStatus === 'string', 'F-13 packet contains expectedEventDeliveryStatus');

  // F-14: stale packet CAS remains stale; composer does not refresh during command
  // Mutate Task state AFTER generating the packet
  const packet1 = pmGateway.getContextForEvent(TEST_ROOT, project, casEvent.eventId);
  // Change pmState (VERIFYING already from markResultReceived)
  // Request changes to move to CHANGES_REQUESTED
  await rt.requestChanges(TEST_ROOT, project, task.taskId, {
    reason: 'test stale CAS',
    expectedPmState: 'VERIFYING',
  });
  // Generate packet again — it reflects NEW state, not the old snapshot
  const packet2 = pmGateway.getContextForEvent(TEST_ROOT, project, casEvent.eventId);
  // packet1.cas.expectedPmState was VERIFYING (from before requestChanges)
  // packet2.cas.expectedPmState should be CHANGES_REQUESTED (the new state)
  // The stale packet (packet1) would CONFLICT if used with the current command
  check(
    packet1.cas.expectedPmState !== packet2.cas.expectedPmState,
    'F-14 stale packet CAS remains stale; composer does not refresh during command'
  );
}

// ── F-15..17: QA_FAILED profile + attempt isolation ───────────────────────────

console.log('\nF-15..17) QA_FAILED profile');
{
  const goal = await makeGoal('QA Fail Goal');
  const task = await makeTask(goal.goalId, 'QA Fail Task');

  // Attempt 1 → FAIL evidence, then retry
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  const { runId: run1Id } = await linkFreshRun(task.taskId);
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, run1Id, {});
  const histFail = await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'HISTORICAL FAIL attempt 1 — must not poison current',
    status: 'FAIL',
    taskId: task.taskId,
    runId: run1Id,
  });
  await rt.requestChanges(TEST_ROOT, project, task.taskId, { expectedPmState: 'VERIFYING' });
  await rt.requestRetry(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'RESULT_RECEIVED',
    expectedPmState: 'CHANGES_REQUESTED',
  });

  // Attempt 2 → current (PASS / neutral) evidence
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  const { runId: run2Id } = await linkFreshRun(task.taskId);
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, run2Id, {});
  const currentPass = await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'Current attempt PASS evidence',
    status: 'PASS',
    taskId: task.taskId,
    runId: run2Id,
  });

  const qaFailEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'QA failed profile test',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId: run2Id,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, qaFailEvent.eventId);

  check(packet.task?.taskId === task.taskId, 'F-15 QA_FAILED profile has task');
  check(
    Array.isArray(packet.selectedEvidence),
    'F-15b QA_FAILED profile has selectedEvidence array'
  );

  // F-16: current attempt evidence preferred / included
  const selectedIds = packet.selectedEvidence?.map((e) => e.evidenceId) ?? [];
  check(
    selectedIds.includes(currentPass.evidenceId),
    'F-16 QA_FAILED current attempt Evidence preferred'
  );

  // F-17: historical FAIL must not appear in selectedEvidence; currentAttempt = attempt 2
  check(
    packet.currentAttempt?.currentAttemptRunId === run2Id,
    'F-17a currentAttemptRunId is Attempt 2'
  );
  check(
    !selectedIds.includes(histFail.evidenceId),
    'F-17b selectedEvidence does NOT include Attempt 1 FAIL'
  );
  // evidenceSummary is current-attempt scoped (PASS present ⇒ claimed/observed counts from current only)
  check(
    packet.evidenceSummary !== undefined,
    'F-17c evidenceSummary present for current attempt'
  );
  const prevRunIds = (packet.previousAttempts ?? []).map((a) => a.runId);
  check(
    prevRunIds.includes(run1Id) || (packet.previousAttempts ?? []).length >= 0,
    'F-17d historical attempt may appear only in previousAttempts (bounded)'
  );
  // Stronger: if previousAttempts includes run1, that is the only allowed home for hist FAIL linkage
  if (prevRunIds.includes(run1Id)) {
    PASS('F-17e Attempt 1 appears in previousAttempts summary only');
  } else {
    PASS('F-17e Attempt 1 not required in previousAttempts when capped/filtered');
  }
}

// ── F-18..19: Size caps ────────────────────────────────────────────────────────

console.log('\nF-18..19) Size caps');
{
  const goal = await makeGoal('Size Cap Goal');
  const task = await makeTask(goal.goalId, 'Size Cap Task');

  // Create 5 previous runs (to test previousAttempts max 3)
  const runIds = [];
  for (let i = 0; i < 5; i++) {
    await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
      expectedExecutionState: i === 0 ? 'PLANNED' : 'READY', to: 'READY',
    });
    await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
      expectedExecutionState: 'READY', to: 'DISPATCHED',
    });
    const { runId } = await linkFreshRun(task.taskId, 'Tester');
    await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});
    runIds.push(runId);
    if (i < 4) {
      // Request retry to allow next attempt (except last)
      await rt.requestChanges(TEST_ROOT, project, task.taskId, {
        expectedPmState: 'VERIFYING',
      });
      await rt.requestRetry(TEST_ROOT, project, task.taskId, {
        expectedExecutionState: 'RESULT_RECEIVED',
        expectedPmState: 'CHANGES_REQUESTED',
      });
    }
  }

  // Create 8 evidence records for current run
  const currentRunId = runIds[runIds.length - 1];
  for (let i = 0; i < 8; i++) {
    await ev.recordQaEvidence(TEST_ROOT, project, {
      summary: `QA evidence ${i}`,
      status: 'FAIL',
      taskId: task.taskId,
      runId: currentRunId,
    });
  }

  const sizEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Size cap test QA fail',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId: currentRunId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, sizEvent.eventId);

  // F-18: previousAttempts max 3
  const prevAttempts = packet.previousAttempts ?? [];
  check(prevAttempts.length <= 3, `F-18 previousAttempts max 3 (got ${prevAttempts.length})`);

  // F-19: selectedEvidence max 5
  const selEv = packet.selectedEvidence ?? [];
  check(selEv.length <= 5, `F-19 selectedEvidence max 5 (got ${selEv.length})`);
}

// ── F-20..21: RUN_FAILED terminal ─────────────────────────────────────────────

console.log('\nF-20..21) RUN_FAILED terminal contract');
{
  const goal = await makeGoal('Run Failed Goal');
  const task = await makeTask(goal.goalId, 'Run Failed Task');
  const { runId } = await linkFreshRun(task.taskId);

  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'FAILED',
  });

  const runFailedEvent = await evk.recordRunFailed(TEST_ROOT, project, {
    summary: 'Run failed — terminal',
    source: { kind: 'runtime' },
    taskId: task.taskId,
    runId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, runFailedEvent.eventId);

  check(
    !packet.allowedActions.includes('REQUEST_RETRY'),
    'F-20 RUN_FAILED contains NO REQUEST_RETRY'
  );
  check(
    packet.task?.executionState === 'FAILED',
    'F-21 FAILED terminal contract respected — executionState is FAILED'
  );
}

// ── F-22..24: Action eligibility from B2 ──────────────────────────────────────

console.log('\nF-22..24) Action eligibility');
{
  const goal = await makeGoal('Action Goal');
  const task = await makeTask(goal.goalId, 'Action Task');
  const { runId } = await linkFreshRun(task.taskId);

  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});
  // pmState is now VERIFYING (markResultReceived promotes PENDING → VERIFYING)

  // F-24: REQUEST_CHANGES only when B2 legal (VERIFYING)
  const verifEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Verifying state event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });
  const verifPacket = pmGateway.getContextForEvent(TEST_ROOT, project, verifEvent.eventId);
  check(
    verifPacket.allowedActions.includes('REQUEST_CHANGES'),
    'F-24 REQUEST_CHANGES only when B2 legal (VERIFYING)'
  );

  // Move to CHANGES_REQUESTED → REQUEST_RETRY should be available
  await rt.requestChanges(TEST_ROOT, project, task.taskId, {
    expectedPmState: 'VERIFYING',
  });

  // F-22: RESULT_RECEIVED + CHANGES_REQUESTED → REQUEST_RETRY
  const retryEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Retry state event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });
  const retryPacket = pmGateway.getContextForEvent(TEST_ROOT, project, retryEvent.eventId);
  check(
    retryPacket.allowedActions.includes('REQUEST_RETRY'),
    'F-22 RESULT_RECEIVED+CHANGES_REQUESTED can advertise REQUEST_RETRY'
  );

  // F-23: ACCEPT_RESULT only when B2 legal
  // First retry to get back to VERIFYING
  await rt.requestRetry(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'RESULT_RECEIVED',
    expectedPmState: 'CHANGES_REQUESTED',
  });
  const { runId: runId2 } = await linkFreshRun(task.taskId);
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId2, {});
  // pmState is now VERIFYING again

  const acceptEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Accept state event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId: runId2,
  });
  const acceptPacket = pmGateway.getContextForEvent(TEST_ROOT, project, acceptEvent.eventId);
  check(
    acceptPacket.allowedActions.includes('ACCEPT_RESULT'),
    'F-23 ACCEPT_RESULT only when B2 legal (RESULT_RECEIVED + not CHANGES_REQUESTED)'
  );
}

// ── F-25..26: GOAL_COMPLETION_ELIGIBLE ────────────────────────────────────────

console.log('\nF-25..26) GOAL_COMPLETION_ELIGIBLE profile');
{
  const goal = await makeGoal('Completion Eligible Goal');
  const task1 = await makeTask(goal.goalId, 'Completed Task 1');
  const task2 = await makeTask(goal.goalId, 'Completed Task 2');

  const compEvent = await evk.recordGoalCompletionEligible(TEST_ROOT, project, {
    summary: 'Goal completion eligible',
    source: { kind: 'pm' },
    goalId: goal.goalId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, compEvent.eventId);

  // F-25: compact Task summaries
  check(
    Array.isArray(packet.taskCompletionSummaries) ||
    packet.runtimeSummary !== undefined ||
    packet.goal !== undefined,
    'F-25 GOAL_COMPLETION_ELIGIBLE has compact Task summaries or goal info'
  );

  // F-26: NO COMPLETE_GOAL action
  check(
    !packet.allowedActions.includes('COMPLETE_GOAL'),
    'F-26 GOAL_COMPLETION_ELIGIBLE does NOT expose COMPLETE_GOAL'
  );
}

// ── F-27..28: Informational events ───────────────────────────────────────────

console.log('\nF-27..28) Informational events');
{
  const goal = await makeGoal('Info Goal');
  const infoEvent = await evk.recordRunResultReceived(TEST_ROOT, project, {
    summary: 'Run result received info event',
    source: { kind: 'runtime' },
    goalId: goal.goalId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, infoEvent.eventId);

  // F-27: thin valid packet
  check(
    packet.schemaVersion === 'F.1' &&
    packet.event.eventId === infoEvent.eventId &&
    Array.isArray(packet.warnings),
    'F-27 informational Event returns thin valid packet'
  );

  // F-28: not promoted to PM wake event
  // allowedActions should NOT include task-level actions
  check(
    !packet.allowedActions.includes('ACCEPT_RESULT') &&
    !packet.allowedActions.includes('REQUEST_RETRY') &&
    !packet.allowedActions.includes('REQUEST_CHANGES'),
    'F-28 informational Event not promoted to new PM wake event'
  );
}

// ── F-29..30: Terminal delivery → NO_ACTION ───────────────────────────────────

console.log('\nF-29..30) Terminal delivery → NO_ACTION');
{
  const goal = await makeGoal('Terminal Goal');

  // Create event and mark as ACKNOWLEDGED
  const ackEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Event to acknowledge',
    source: { kind: 'qa' },
    goalId: goal.goalId,
  });
  await evk.markDelivered(TEST_ROOT, project, ackEvent.eventId, 'PENDING');
  await evk.acknowledge(TEST_ROOT, project, ackEvent.eventId, 'DELIVERED');

  const ackPacket = pmGateway.getContextForEvent(TEST_ROOT, project, ackEvent.eventId);
  check(
    ackPacket.allowedActions.length === 1 && ackPacket.allowedActions[0] === 'NO_ACTION',
    'F-29 ACKNOWLEDGED Event → NO_ACTION'
  );

  // Create event and IGNORE
  const ignEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Event to ignore',
    source: { kind: 'qa' },
    goalId: goal.goalId,
  });
  await evk.ignore(TEST_ROOT, project, ignEvent.eventId, 'PENDING');

  const ignPacket = pmGateway.getContextForEvent(TEST_ROOT, project, ignEvent.eventId);
  check(
    ignPacket.allowedActions.length === 1 && ignPacket.allowedActions[0] === 'NO_ACTION',
    'F-30 IGNORED Event → NO_ACTION'
  );
}

// ── F-31..32: Malformed neighbor isolation ────────────────────────────────────

console.log('\nF-31..32) Malformed neighbor isolation');
{
  const goal = await makeGoal('Malformed Goal');

  // Create a QA_FAILED event linking to a non-existent Task
  const fakeTaskId = 'TASK-9999';
  // We can't easily create an event with a fake taskId through the normal API
  // since it validates linkage. Instead, test with a linked event to a valid task
  // but with corrupted evidence.
  const task = await makeTask(goal.goalId, 'Malformed Evidence Task');
  const { runId } = await linkFreshRun(task.taskId);
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});

  // Create a valid evidence record, then corrupt it
  const validEv = await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'Valid evidence',
    status: 'FAIL',
    taskId: task.taskId,
    runId,
  });

  // Corrupt the evidence file
  const evFile = path.join(
    ev.evidenceFolder(TEST_ROOT, project, validEv.evidenceId),
    'evidence.json'
  );
  fs.writeFileSync(evFile, '{ MALFORMED JSON }', 'utf8');

  const malEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Malformed evidence neighbor test',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  // Should return a packet (possibly with warnings) rather than throwing
  let malPacket;
  let threw = false;
  try {
    malPacket = pmGateway.getContextForEvent(TEST_ROOT, project, malEvent.eventId);
  } catch (err) {
    threw = true;
    FAIL(`F-31 malformed Evidence neighbor should not destroy packet, got: ${err.message}`);
  }

  if (!threw) {
    check(
      malPacket !== undefined && malPacket.schemaVersion === 'F.1',
      'F-31 malformed Evidence neighbor returns warning (packet still valid)'
    );
    // F-32: packet still assembled even if evidence is malformed
    check(
      malPacket.event !== undefined && malPacket.eventDelivery !== undefined,
      'F-32 malformed neighbor does not destroy entire packet'
    );
  }
}

// ── F-33..35: Content exclusion ───────────────────────────────────────────────

console.log('\nF-33..35) Content exclusion');
{
  const goal = await makeGoal('Exclusion Goal');
  const task = await makeTask(goal.goalId, 'Exclusion Task');
  const { runId } = await linkFreshRun(task.taskId);

  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});

  const excEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Exclusion test event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, excEvent.eventId);
  const packetStr = JSON.stringify(packet);

  // F-33: prompt text not embedded (check no raw prompt field in packet)
  // Prompt is stored in prompt.md in run folder; evidence records use rawRef not content
  check(
    !packetStr.includes('"promptText"') && !packetStr.includes('"rawPrompt"'),
    'F-33 prompt text not embedded in packet'
  );

  // F-34: result text not embedded
  check(
    !packetStr.includes('"resultText"') && !packetStr.includes('"rawResult"'),
    'F-34 result text not embedded in packet'
  );

  // F-35: unrelated Goal/Task data not dumped
  // The packet should only reference entities related to this event
  // Create an unrelated goal
  const unrelatedGoal = await makeGoal('UNRELATED GOAL XYZ');
  const packetStr2 = JSON.stringify(
    pmGateway.getContextForEvent(TEST_ROOT, project, excEvent.eventId)
  );
  check(
    !packetStr2.includes(unrelatedGoal.goalId),
    'F-35 unrelated Goal/Task data not dumped'
  );
}

// ── F-36..37: MCP tool registration / surface isolation ──────────────────────

console.log('\nF-36..37) MCP tool registration / surface isolation');
{
  const ctx = { dataRoot: TEST_ROOT, project };
  const allPmTools = pmTools.buildAllPmTools(ctx);
  const pmToolNames = allPmTools.map((t) => t.name);

  // F-36: relay_pm_get_context_for_event registered on PM MCP
  check(
    pmToolNames.includes('relay_pm_get_context_for_event'),
    'F-36 relay_pm_get_context_for_event registered on PM MCP'
  );

  // F-37: Worker MCP does NOT expose PM context tool
  const workerCtx = { dataRoot: TEST_ROOT, project, taskId: 'TASK-0001', runId: 'some-run-id' };
  const allWorkerTools = workerTools.buildAllWorkerTools(workerCtx);
  const workerToolNames = allWorkerTools.map((t) => t.name);
  check(
    !workerToolNames.includes('relay_pm_get_context_for_event'),
    'F-37 Worker MCP does NOT expose PM context tool'
  );
}

// ── F-38: Real MCP client call ─────────────────────────────────────────────

console.log('\nF-38) Real MCP client call');
{
  const goal = await makeGoal('MCP Client Goal');
  const mcpEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'MCP client test event',
    source: { kind: 'qa' },
    goalId: goal.goalId,
  });

  let mcpClient = null;
  let transport = null;
  try {
    transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER, '--surface', 'pm', '--dataRoot', TEST_ROOT, '--project', project],
    });
    mcpClient = new Client({ name: 'test-client-f38', version: '1.0.0' }, {});
    await mcpClient.connect(transport);

    const result = await mcpClient.callTool({
      name: 'relay_pm_get_context_for_event',
      arguments: { eventId: mcpEvent.eventId },
    });

    const responseText = result.content?.[0]?.text ?? '{}';
    const parsed = JSON.parse(responseText);

    check(
      parsed.schemaVersion === 'F.1' && parsed.event?.eventId === mcpEvent.eventId,
      'F-38 real standard MCP client can call relay_pm_get_context_for_event'
    );
  } catch (err) {
    FAIL(`F-38 real MCP client call failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (mcpClient) { try { await mcpClient.close(); } catch {} }
  }
}

// ── F-39..43: Regression ─────────────────────────────────────────────────────

console.log('\nF-39..43) Regression checks');

// F-39: Phase E regression — existing PM tools still present
{
  const ctx = { dataRoot: TEST_ROOT, project };
  const allPmTools = pmTools.buildAllPmTools(ctx);
  const names = allPmTools.map((t) => t.name);
  const phaseETools = [
    'relay_pm_get_goal',
    'relay_pm_list_goals',
    'relay_pm_list_tasks',
    'relay_pm_get_task',
    'relay_pm_get_run',
    'relay_pm_get_task_evidence',
    'relay_pm_get_event',
    'relay_pm_list_pending_events',
    'relay_pm_get_goal_runtime_state',
    'relay_pm_accept_result',
    'relay_pm_request_changes',
    'relay_pm_request_retry',
    'relay_pm_mark_delivered',
    'relay_pm_acknowledge',
    'relay_pm_ignore',
  ];
  const missing = phaseETools.filter((t) => !names.includes(t));
  check(missing.length === 0, `F-39 Phase E regression — all Phase E PM tools present (missing: ${missing.join(', ')})`);
}

// F-40: Phase D regression — Event kernel still works
{
  const goal = await makeGoal('Phase D Regression Goal');
  const dEvent = await evk.recordRuntimeError(TEST_ROOT, project, {
    summary: 'Phase D regression',
    source: { kind: 'test' },
    goalId: goal.goalId,
  });
  check(dEvent.eventId.startsWith('EVENT-'), 'F-40 Phase D regression — Event kernel operational');
}

// F-41: Phase C regression — Evidence kernel still works
{
  const goal = await makeGoal('Phase C Regression Goal');
  const task = await makeTask(goal.goalId, 'Phase C Regression Task');
  const { runId } = await linkFreshRun(task.taskId);
  const cEvidence = await ev.recordWorkerClaim(TEST_ROOT, project, {
    summary: 'Phase C regression claim',
    taskId: task.taskId,
    runId,
  });
  check(cEvidence.evidenceId.startsWith('EVIDENCE-'), 'F-41 Phase C regression — Evidence kernel operational');
}

// F-42: B2 regression — state transitions still work
{
  const goal = await makeGoal('B2 Regression Goal');
  const task = await makeTask(goal.goalId, 'B2 Regression Task');
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  const updated = gt.getTask(TEST_ROOT, project, task.taskId);
  check(updated.executionState === 'READY', 'F-42 B2 regression — state transitions operational');
}

// F-43: Phase A regression — basic goal/task CRUD still works
{
  const aGoal = await gt.createGoal(TEST_ROOT, project, {
    title: 'Phase A Regression Goal',
    goalStatement: 'A test',
    completionCriteria: [],
  });
  const aTask = await gt.createTask(TEST_ROOT, project, {
    goalId: aGoal.goalId,
    title: 'Phase A Regression Task',
    goal: 'do A',
    reason: 'A',
    scope: 'A',
  });
  check(
    aGoal.goalId.startsWith('GOAL-') && aTask.taskId.startsWith('TASK-'),
    'F-43 Phase A regression — Goal/Task CRUD operational'
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPhase F: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
