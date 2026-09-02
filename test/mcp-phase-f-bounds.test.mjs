/**
 * Phase F Bounded-Context Contract Correction Tests (FB-01..FB-22).
 *
 * FB-01  Task packet does NOT expose linkedRuns
 * FB-02  Task packet does NOT expose folder paths (task)
 * FB-03  Run packet does NOT expose folder
 * FB-04  previousAttempts remains <= 3
 * FB-05  No alternate packet field exposes > 3 historical attempts
 *
 * FB-06  selectedEvidence <= 5
 * FB-07  Oversized Evidence details are bounded/sanitized
 * FB-08  Huge string inside Evidence details does not pass through intact
 * FB-09  Huge array inside Evidence details is bounded
 * FB-10  prompt/result-like raw body is not embedded through details
 *
 * FB-11  refs.evidenceIds bounded
 * FB-12  refs.rawRefs bounded
 * FB-13  refs.artifactRefs bounded
 *
 * FB-14  Oversized Event details are bounded/sanitized
 *
 * FB-15  Packet JSON size does not grow linearly without bound when Task
 *        has many historical runs (20+ attempts).
 *
 * FB-16  getContextForEvent is byte-for-byte non-mutating for SSOT files
 *
 * FB-17  Phase F existing tests pass (covered separately by test:mcp-phase-f)
 *
 * FB-18  Phase E regression
 * FB-19  Phase D regression
 * FB-20  Phase C regression
 * FB-21  B2 regression
 * FB-22  Phase A regression
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-fb-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

// ── Imports ───────────────────────────────────────────────────────────────────

const relay     = await import('../dist/server/backend/fs.js');
const gt        = await import('../dist/server/backend/goal-task.js');
const rt        = await import('../dist/server/backend/goal-task-runtime.js');
const ev        = await import('../dist/server/backend/evidence.js');
const evk       = await import('../dist/server/backend/event.js');
const pmGateway = await import('../dist/server/backend/pm-gateway.js');
const pmTools   = await import('../dist/server/mcp/pm-tools.js');
const workerTools = await import('../dist/server/mcp/worker-tools.js');

const project = 'FBoundsProj';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Recursively collect all string values from a JSON-serializable value. */
function collectAllStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectAllStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectAllStrings);
  }
  return [];
}

/** Recursively collect all keys (property names) from a JSON-serializable object. */
function collectAllKeys(value) {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(collectAllKeys);
  const keys = Object.keys(value);
  return [...keys, ...Object.values(value).flatMap(collectAllKeys)];
}

/** Hash a file for byte-for-byte comparison. */
function hashFile(f) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch { return null; }
}

// ── Initialize ─────────────────────────────────────────────────────────────────

relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

// ── FB-01..05: Task packet / run packet bounded-context ───────────────────────

console.log('\nFB-01..05) Task and run bounded-context contract');
{
  const goal = await makeGoal('Bounded Context Goal');
  const task = await makeTask(goal.goalId, 'Bounded Context Task');

  // Create several runs so linkedRuns has multiple entries
  for (let i = 0; i < 4; i++) {
    let t = gt.getTask(TEST_ROOT, project, task.taskId);
    if (t.executionState !== 'DISPATCHED' && t.executionState !== 'RESULT_RECEIVED') {
      await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
        expectedExecutionState: t.executionState, to: 'READY',
      });
      await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
        expectedExecutionState: 'READY', to: 'DISPATCHED',
      });
    }
    const { runId } = await linkFreshRun(task.taskId);
    await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});
    if (i < 3) {
      await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
        goalId: goal.goalId, reason: 'bounded context fixture reason',
        expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
      });
      await rt.requestRetry(TEST_ROOT, project, task.taskId, {
        goalId: goal.goalId,
        expectedExecutionState: 'RESULT_RECEIVED',
        expectedPmState: 'CHANGES_REQUESTED',
      });
    }
  }

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Bounded context QA fail',
    source: { kind: 'qa' },
    taskId: task.taskId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const packetKeys = collectAllKeys(packet);

  // FB-01: task in packet must NOT have linkedRuns
  check(
    !('linkedRuns' in (packet.task ?? {})),
    'FB-01 packet.task does NOT expose linkedRuns',
  );

  // FB-02: task in packet must NOT expose folder paths
  const taskObj = packet.task ?? {};
  const taskStr = JSON.stringify(taskObj);
  // folder paths are absolute paths containing separators
  check(
    !packetKeys.includes('folder') || !Object.keys(taskObj).includes('folder'),
    'FB-02 packet.task does NOT have a "folder" key',
  );

  // Additional check: no absolute path string in task context
  const taskStrings = collectAllStrings(taskObj);
  const hasAbsPath = taskStrings.some((s) => s.includes(':\\') || (s.startsWith('/') && s.length > 1));
  check(!hasAbsPath, 'FB-02b packet.task contains no absolute filesystem path strings');

  // FB-03: run in packet must NOT expose folder
  if (packet.run !== undefined) {
    check(
      !('folder' in packet.run),
      'FB-03 packet.run does NOT expose folder',
    );
  } else {
    PASS('FB-03 packet.run absent (no run in this packet profile) — folder not exposed');
  }

  // FB-04: previousAttempts <= 3
  const prevAttempts = packet.previousAttempts ?? [];
  check(
    prevAttempts.length <= 3,
    `FB-04 previousAttempts.length <= 3 (got ${prevAttempts.length})`,
  );

  // FB-05: no alternate packet field exposes > 3 historical attempts
  // Check that no array-like field in packet contains more than 3 run-like objects
  // with runId and taskRunSequence (AttemptSummary pattern)
  function countAttemptArrays(obj) {
    if (!obj || typeof obj !== 'object') return 0;
    if (Array.isArray(obj)) {
      // Check if this array looks like a run-history list (items have runId)
      const runsLike = obj.filter((item) => item && typeof item === 'object' && 'runId' in item);
      if (runsLike.length > 3) return runsLike.length;
      return Math.max(0, ...obj.map(countAttemptArrays));
    }
    return Math.max(0, ...Object.values(obj).map(countAttemptArrays));
  }
  const maxRunArrayLen = countAttemptArrays(packet);
  check(
    maxRunArrayLen <= 3,
    `FB-05 no alternate packet field exposes > 3 historical attempts (max found: ${maxRunArrayLen})`,
  );
}

// ── FB-06..10: Evidence bounding ──────────────────────────────────────────────

console.log('\nFB-06..10) Evidence bounding');

// FB-06: selectedEvidence <= 5 (with 10+ evidence records)
{
  const goal = await makeGoal('Evidence Count Goal');
  const task = await makeTask(goal.goalId, 'Evidence Count Task');
  const { runId } = await driveToResultReceived(task.taskId).then(async (r) => r);

  for (let i = 0; i < 10; i++) {
    await ev.recordQaEvidence(TEST_ROOT, project, {
      summary: `QA evidence record ${i}`,
      status: 'FAIL',
      taskId: task.taskId,
      runId,
    });
  }

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Evidence count test event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });
  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const selEv = packet.selectedEvidence ?? [];
  check(
    selEv.length <= 5,
    `FB-06 selectedEvidence.length <= 5 (got ${selEv.length})`,
  );
}

// FB-07..10: Evidence details sanitization — use a task where oversized evidence IS selected
// (single evidence record with huge details, so it will be selected)
{
  const HUGE_STRING = 'X'.repeat(10000);
  const HUGE_ARRAY = new Array(500).fill('item-value');
  const PROMPT_BODY = 'You are a coding assistant. Here is the full prompt: ' + 'P'.repeat(5000);
  const RESULT_BODY = 'Here is the complete result output: ' + 'R'.repeat(5000);

  function findMaxArrayLen(value) {
    if (Array.isArray(value)) return Math.max(value.length, ...value.map(findMaxArrayLen));
    if (value !== null && typeof value === 'object') return Math.max(0, ...Object.values(value).map(findMaxArrayLen));
    return 0;
  }

  // Task A: only evidence with huge string details (will be selected)
  const goalA = await makeGoal('Evidence Details Goal A');
  const taskA = await makeTask(goalA.goalId, 'Evidence Details Task A');
  const { runId: runIdA } = await driveToResultReceived(taskA.taskId).then(async (r) => r);
  await ev.recordAdapterObservation(TEST_ROOT, project, {
    summary: 'Adapter observation with huge details',
    status: 'FAIL',  // FAIL status so it gets picked up
    taskId: taskA.taskId,
    runId: runIdA,
    details: {
      resultSummary: HUGE_STRING,
      items: HUGE_ARRAY,
      nested: { deep: { deeper: { value: HUGE_STRING } } },
    },
  });
  const eventA = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Huge details test event A',
    source: { kind: 'qa' },
    taskId: taskA.taskId,
    runId: runIdA,
  });
  const packetA = pmGateway.getContextForEvent(TEST_ROOT, project, eventA.eventId);
  const selEvA = packetA.selectedEvidence ?? [];

  // FB-07: oversized Evidence details are bounded/sanitized
  const detailStringsA = selEvA.flatMap((e) => e.details ? collectAllStrings(e.details) : []);
  const maxDetailStrLen = Math.max(0, ...detailStringsA.map((s) => s.length));
  check(
    maxDetailStrLen <= 600, // 512 + margin for truncation marker
    `FB-07 oversized Evidence details are bounded (max string len in details: ${maxDetailStrLen})`,
  );

  // FB-08: huge string inside Evidence details does not pass through intact
  check(
    !detailStringsA.some((s) => s.length > 600),
    'FB-08 huge string inside Evidence details does not pass through intact',
  );

  // FB-09: huge array inside Evidence details is bounded
  const maxArrLenA = Math.max(0, ...selEvA.map((e) => e.details ? findMaxArrayLen(e.details) : 0));
  check(
    maxArrLenA <= 20, // MAX_DETAILS_ARRAY_ITEMS=10, with some margin
    `FB-09 huge array inside Evidence details is bounded (max array len: ${maxArrLenA})`,
  );

  // Task B: evidence with prompt/result-like bodies in details (will be selected)
  const goalB = await makeGoal('Evidence Details Goal B');
  const taskB = await makeTask(goalB.goalId, 'Evidence Details Task B');
  const { runId: runIdB } = await driveToResultReceived(taskB.taskId).then(async (r) => r);
  await ev.recordWorkerClaim(TEST_ROOT, project, {
    summary: 'Worker claim with prompt-like content',
    taskId: taskB.taskId,
    runId: runIdB,
    details: {
      promptBody: PROMPT_BODY,
      resultBody: RESULT_BODY,
    },
  });
  const eventB = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Prompt-body test event B',
    source: { kind: 'qa' },
    taskId: taskB.taskId,
    runId: runIdB,
  });
  const packetB = pmGateway.getContextForEvent(TEST_ROOT, project, eventB.eventId);
  const packetBStr = JSON.stringify(packetB);

  // FB-10: prompt/result-like raw body is not embedded through details
  check(
    !packetBStr.includes(PROMPT_BODY) && !packetBStr.includes(RESULT_BODY),
    'FB-10 prompt/result-like raw body is not embedded through details',
  );
}

// ── FB-11..13: Refs bounding ──────────────────────────────────────────────────

console.log('\nFB-11..13) Refs bounding');
{
  const goal = await makeGoal('Refs Bounds Goal');
  const task = await makeTask(goal.goalId, 'Refs Bounds Task');
  const { runId } = await driveToResultReceived(task.taskId).then(async (r) => r);

  // Create 15 evidence records with rawRefs and artifactRefs
  for (let i = 0; i < 15; i++) {
    await ev.recordQaEvidence(TEST_ROOT, project, {
      summary: `Refs evidence ${i}`,
      status: 'FAIL',
      taskId: task.taskId,
      runId,
      rawRef: `raw-ref-${i}`,
      artifactRefs: [`artifact-${i}-a`, `artifact-${i}-b`],
    });
  }

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Refs bounds test event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const refs = packet.refs;

  // FB-11: refs.evidenceIds bounded (max MAX_REFS_EVIDENCE_IDS = 10)
  check(
    !refs.evidenceIds || refs.evidenceIds.length <= 10,
    `FB-11 refs.evidenceIds bounded to <= 10 (got ${refs.evidenceIds?.length ?? 0})`,
  );

  // FB-12: refs.rawRefs bounded (max MAX_REFS_RAW = 5)
  check(
    !refs.rawRefs || refs.rawRefs.length <= 5,
    `FB-12 refs.rawRefs bounded to <= 5 (got ${refs.rawRefs?.length ?? 0})`,
  );

  // FB-13: refs.artifactRefs bounded (max MAX_REFS_ARTIFACT = 5)
  check(
    !refs.artifactRefs || refs.artifactRefs.length <= 5,
    `FB-13 refs.artifactRefs bounded to <= 5 (got ${refs.artifactRefs?.length ?? 0})`,
  );
}

// ── FB-14: Event details bounding ────────────────────────────────────────────

console.log('\nFB-14) Event details bounding');
{
  const goal = await makeGoal('Event Details Goal');
  const task = await makeTask(goal.goalId, 'Event Details Task');

  // Manually create an event that would have large details
  // We use recordRuntimeError which accepts details
  const HUGE_DETAIL_STRING = 'E'.repeat(10000);
  const event = await evk.recordRuntimeError(TEST_ROOT, project, {
    summary: 'Runtime error with large details',
    source: { kind: 'test-subsystem', subsystem: 'bounds' },
    goalId: goal.goalId,
    taskId: task.taskId,
    details: {
      errorMessage: HUGE_DETAIL_STRING,
      stackTrace: HUGE_DETAIL_STRING,
      context: new Array(200).fill({ key: 'value', data: HUGE_DETAIL_STRING }),
    },
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);

  // FB-14: Event details in packet are bounded/sanitized
  if (packet.event.details !== undefined) {
    const detailStrings = collectAllStrings(packet.event.details);
    const maxDetailLen = Math.max(0, ...detailStrings.map((s) => s.length));
    check(
      maxDetailLen <= 600, // 512 + some margin for truncation marker
      `FB-14 oversized Event details are bounded/sanitized (max string len: ${maxDetailLen})`,
    );

    // Also verify arrays are bounded
    function findMaxArrayLen(value) {
      if (Array.isArray(value)) return Math.max(value.length, ...value.map(findMaxArrayLen));
      if (value !== null && typeof value === 'object') return Math.max(0, ...Object.values(value).map(findMaxArrayLen));
      return 0;
    }
    const maxArrLen = findMaxArrayLen(packet.event.details);
    check(
      maxArrLen <= 20,
      `FB-14b Event details arrays are bounded (max array len: ${maxArrLen})`,
    );
  } else {
    // details may be absent if the event was created without details support
    PASS('FB-14 Event details absent — no unbounded payload');
    PASS('FB-14b Event details arrays — n/a');
  }
}

// ── FB-15: Packet size does not grow linearly with run history ────────────────

console.log('\nFB-15) Packet size does not grow linearly with run history');
{
  const goal = await makeGoal('Scaling Goal');
  const task = await makeTask(goal.goalId, 'Scaling Task');

  // Drive through 25 retry cycles (many more than the previousAttempts cap of 3)
  const NUM_ATTEMPTS = 22;
  for (let i = 0; i < NUM_ATTEMPTS; i++) {
    let t = gt.getTask(TEST_ROOT, project, task.taskId);
    // Bring to DISPATCHED
    if (t.executionState === 'PLANNED' || t.executionState === 'READY') {
      if (t.executionState === 'PLANNED') {
        t = await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
          expectedExecutionState: 'PLANNED', to: 'READY',
        });
      }
      t = await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
        expectedExecutionState: 'READY', to: 'DISPATCHED',
      });
    }
    const { runId } = await linkFreshRun(task.taskId, `Agent${i}`);
    // Add some evidence per attempt to make it realistic
    await ev.recordQaEvidence(TEST_ROOT, project, {
      summary: `QA fail attempt ${i}`,
      status: 'FAIL',
      taskId: task.taskId,
      runId,
    });
    t = await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {});

    // Retry all but the last attempt
    if (i < NUM_ATTEMPTS - 1) {
      await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
        goalId: goal.goalId, reason: 'scaling fixture reason for retry cycle',
        expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
      });
      await rt.requestRetry(TEST_ROOT, project, task.taskId, {
        goalId: goal.goalId,
        expectedExecutionState: 'RESULT_RECEIVED',
        expectedPmState: 'CHANGES_REQUESTED',
      });
    }
  }

  // Verify the task actually has many linked runs
  const taskAfter = gt.getTask(TEST_ROOT, project, task.taskId);
  check(
    taskAfter.linkedRuns.length >= NUM_ATTEMPTS,
    `FB-15 precondition: task has ${taskAfter.linkedRuns.length} linked runs (>= ${NUM_ATTEMPTS})`,
  );

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Scaling test QA fail',
    source: { kind: 'qa' },
    taskId: task.taskId,
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const packetJson = JSON.stringify(packet);
  const packetSize = Buffer.byteLength(packetJson, 'utf8');

  // The packet must NOT contain the full linkedRuns array
  check(
    !('linkedRuns' in (packet.task ?? {})),
    `FB-15a packet.task has no linkedRuns field (${taskAfter.linkedRuns.length} runs exist in SSOT)`,
  );

  // previousAttempts must be capped at 3
  check(
    (packet.previousAttempts ?? []).length <= 3,
    `FB-15b previousAttempts capped at 3 (got ${(packet.previousAttempts ?? []).length})`,
  );

  // Packet size must be bounded (not grow with 22+ runs)
  // A reasonable bounded packet should be well under 64KB
  check(
    packetSize < 65536,
    `FB-15c packet JSON size is bounded (${packetSize} bytes < 64KB)`,
  );

  console.log(`         (packet size: ${packetSize} bytes, runs: ${taskAfter.linkedRuns.length})`);
}

// ── FB-16: Read purity (byte-for-byte SSOT non-mutating) ─────────────────────

console.log('\nFB-16) Read purity — byte-for-byte SSOT non-mutating');
{
  const goal = await makeGoal('Purity Goal FB');
  const task = await makeTask(goal.goalId, 'Purity Task FB');
  const { runId } = await driveToResultReceived(task.taskId).then(async (r) => r);

  const evi = await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'Purity evidence',
    status: 'FAIL',
    taskId: task.taskId,
    runId,
    details: { exitCode: 1, durationMs: 500 },
  });

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Purity test event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  // Hash all SSOT files before
  const deliveryFile = path.join(
    evk.eventFolder(TEST_ROOT, project, event.eventId), 'delivery.json',
  );
  const taskFile = path.join(
    gt.taskFolder(TEST_ROOT, project, task.taskId), 'task.json',
  );
  const goalFile = path.join(
    gt.goalFolder(TEST_ROOT, project, goal.goalId), 'goal.json',
  );
  const evFile = path.join(
    ev.evidenceFolder(TEST_ROOT, project, evi.evidenceId), 'evidence.json',
  );
  const eventFile = path.join(
    evk.eventFolder(TEST_ROOT, project, event.eventId), 'event.json',
  );

  const before = {
    delivery: hashFile(deliveryFile),
    task: hashFile(taskFile),
    goal: hashFile(goalFile),
    evidence: hashFile(evFile),
    event: hashFile(eventFile),
  };

  // Call getContextForEvent — must be PURE READ
  pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  // Call a second time to be thorough
  pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);

  const after = {
    delivery: hashFile(deliveryFile),
    task: hashFile(taskFile),
    goal: hashFile(goalFile),
    evidence: hashFile(evFile),
    event: hashFile(eventFile),
  };

  check(before.delivery === after.delivery, 'FB-16a delivery.json not mutated by getContextForEvent');
  check(before.task === after.task,         'FB-16b task.json not mutated by getContextForEvent');
  check(before.goal === after.goal,         'FB-16c goal.json not mutated by getContextForEvent');
  check(before.evidence === after.evidence, 'FB-16d evidence.json not mutated by getContextForEvent');
  check(before.event === after.event,       'FB-16e event.json not mutated by getContextForEvent');
}

// ── FB-18..22: Regression checks ─────────────────────────────────────────────

console.log('\nFB-18..22) Regression checks');

// FB-18: Phase E regression — PM tools still present
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
    'relay_pm_get_context_for_event',
  ];
  const missing = phaseETools.filter((t) => !names.includes(t));
  check(missing.length === 0, `FB-18 Phase E regression — all Phase E PM tools present (missing: ${missing.join(', ')})`);
}

// FB-19: Phase D regression — Event kernel still works
{
  const goal = await makeGoal('Phase D Regression FB');
  const dEvent = await evk.recordRuntimeError(TEST_ROOT, project, {
    summary: 'Phase D regression FB',
    source: { kind: 'test' },
    goalId: goal.goalId,
  });
  check(dEvent.eventId.startsWith('EVENT-'), 'FB-19 Phase D regression — Event kernel operational');
}

// FB-20: Phase C regression — Evidence kernel still works
{
  const goal = await makeGoal('Phase C Regression FB');
  const task = await makeTask(goal.goalId, 'Phase C Regression Task FB');
  const { runId } = await linkFreshRun(task.taskId);
  const cEvidence = await ev.recordWorkerClaim(TEST_ROOT, project, {
    summary: 'Phase C regression claim FB',
    taskId: task.taskId,
    runId,
  });
  check(cEvidence.evidenceId.startsWith('EVIDENCE-'), 'FB-20 Phase C regression — Evidence kernel operational');
}

// FB-21: B2 regression — state transitions still work
{
  const goal = await makeGoal('B2 Regression FB');
  const task = await makeTask(goal.goalId, 'B2 Regression Task FB');
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  const updated = gt.getTask(TEST_ROOT, project, task.taskId);
  check(updated.executionState === 'READY', 'FB-21 B2 regression — state transitions operational');
}

// FB-22: Phase A regression — basic goal/task CRUD still works
{
  const aGoal = await gt.createGoal(TEST_ROOT, project, {
    title: 'Phase A Regression Goal FB',
    goalStatement: 'A test',
    completionCriteria: [],
  });
  const aTask = await gt.createTask(TEST_ROOT, project, {
    goalId: aGoal.goalId,
    title: 'Phase A Regression Task FB',
    goal: 'do A',
    reason: 'A',
    scope: 'A',
  });
  check(
    aGoal.goalId.startsWith('GOAL-') && aTask.taskId.startsWith('TASK-'),
    'FB-22 Phase A regression — Goal/Task CRUD operational',
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nPhase F Bounds: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
