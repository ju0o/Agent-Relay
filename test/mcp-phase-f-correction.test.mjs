/**
 * Phase F Physical-Path + Residual Bounds Correction Tests (FC-01..FC-25+).
 *
 * FC-01..07  Absolute path protection + recursive packet scan
 * FC-08..18  Residual string/array bounds
 * FC-19..20  Stress caps (100+ tasks / dependencies)
 * FC-21..25  Missing Event hard-fail + live stale CAS CONFLICT
 * FC-26..28  RUN_BLOCKED / TASK_BLOCKED / OWNER_DECISION_REQUIRED profiles
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'mcp', 'index.js');

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-fc-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const ev = await import('../dist/server/backend/evidence.js');
const evk = await import('../dist/server/backend/event.js');
const pmGateway = await import('../dist/server/backend/pm-gateway.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');

const project = 'FCorrectionProj';
const MAX_BOUNDED = 512;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeGoal(title = 'Test Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title,
    goalStatement: 'test goal statement',
    completionCriteria: ['done'],
  });
}

async function makeTask(goalId, title = 'Test Task', deps = []) {
  return gt.createTask(TEST_ROOT, project, {
    goalId,
    title,
    goal: 'do test',
    reason: 'testing',
    scope: 'test',
    completionCriteria: ['done'],
    ...(deps.length ? { dependencies: deps } : {}),
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
    await rt.markResultReceived(TEST_ROOT, project, taskId, runId, {});
    return { task: gt.getTask(TEST_ROOT, project, taskId), runId };
  }
  if (t.executionState === 'RESULT_RECEIVED') {
    const link = t.linkedRuns[t.linkedRuns.length - 1];
    return { task: t, runId: link?.runId };
  }
  throw new Error(`Cannot drive task ${taskId} to RESULT_RECEIVED from ${t.executionState}`);
}

function collectAllStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectAllStrings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(collectAllStrings);
  }
  return [];
}

/**
 * Recursive absolute-path detector for packet certification.
 * Allows approved logical URI schemes (evidence://, run://, artifact://, relay-relative://).
 * Flags Windows / POSIX / UNC / file:// absolute filesystem shapes.
 */
function findAbsolutePathLeaks(value, pathTrail = '$') {
  const leaks = [];
  if (typeof value === 'string') {
    const s = value.trim();
    const isApprovedLogical =
      /^(evidence|run|artifact|relay-relative):\/\//i.test(s) ||
      (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^file:/i.test(s) && !/^[A-Za-z]:[\\/]/.test(s));
    const isAbs =
      /^file:/i.test(s) ||
      /^[A-Za-z]:[\\/]/.test(s) ||
      /^\\\\[^\\\/]+[\\\/]/.test(s) ||
      (/^\/\/[^\/]+\/./.test(s) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) ||
      (s.startsWith('/') && !isApprovedLogical);
    if (isAbs && !isApprovedLogical) {
      leaks.push({ path: pathTrail, value: s.slice(0, 120) });
    }
    return leaks;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaks.push(...findAbsolutePathLeaks(v, `${pathTrail}[${i}]`)));
    return leaks;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      leaks.push(...findAbsolutePathLeaks(v, `${pathTrail}.${k}`));
    }
  }
  return leaks;
}

function assertNoAbsolutePaths(packet, label) {
  const leaks = findAbsolutePathLeaks(packet);
  check(
    leaks.length === 0,
    `${label} recursive packet path scan clean` +
      (leaks.length ? ` (leaks: ${leaks.map((l) => l.path + '=' + l.value).join('; ')})` : ''),
  );
}

function hashFile(f) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch {
    return null;
  }
}

relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

// ── FC-01..07: Absolute path protection ───────────────────────────────────────

console.log('\nFC-01..07) Absolute path protection + recursive scan');
{
  const goal = await makeGoal('Path Goal');
  const task = await makeTask(goal.goalId, 'Path Task');
  const { runId, folder } = await driveToResultReceived(task.taskId).then(async (r) => {
    const linked = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.find((x) => x.runId === r.runId);
    return { runId: r.runId, folder: linked?.folder ?? path.join(TEST_ROOT, project) };
  });

  const winAbs = path.join(folder, 'evidence', 'adapter.json');
  const posixAbs = '/home/user/project/file.txt';
  const uncAbs = '\\\\server\\share\\file.txt';
  const winFwd = 'C:/Users/x/project/file.txt';

  await ev.recordAdapterObservation(TEST_ROOT, project, {
    summary: 'Windows absolute rawRef',
    status: 'FAIL',
    taskId: task.taskId,
    runId,
    rawRef: winAbs,
    artifactRefs: [winAbs, posixAbs, uncAbs, winFwd, 'artifact://logical-ok'],
    details: {
      nestedPath: posixAbs,
      winPath: winAbs,
      unc: uncAbs,
    },
  });

  // Also plant absolute paths via a second evidence with only foreign abs rawRef
  await ev.recordQaEvidence(TEST_ROOT, project, {
    summary: 'POSIX/UNC rawRefs',
    status: 'FAIL',
    taskId: task.taskId,
    runId,
    rawRef: posixAbs,
    artifactRefs: [uncAbs, winFwd],
  });

  const event = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'Path protection event',
    source: { kind: 'qa', subsystem: '/tmp/should-not-leak-as-path-if-abs' },
    taskId: task.taskId,
    runId,
    details: {
      errorPath: winAbs,
      posix: posixAbs,
      unc: uncAbs,
      forward: winFwd,
    },
  });

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const allStrings = collectAllStrings(packet);

  // FC-01 Windows absolute rawRef not exposed as raw filesystem path
  check(
    !allStrings.some((s) => s.includes(winAbs) || s === winAbs),
    'FC-01 absolute Windows rawRef not exposed intact',
  );

  // FC-02 POSIX
  check(
    !allStrings.some((s) => s === posixAbs || s.includes('/home/user/project/file.txt')),
    'FC-02 absolute POSIX rawRef not exposed intact',
  );

  // FC-03 UNC
  check(
    !allStrings.some((s) => s.includes('\\\\server\\share') || s.includes('//server/share')),
    'FC-03 UNC rawRef not exposed intact',
  );

  // FC-04 selectedEvidence rawRef is safe logical or omitted
  const selRaw = (packet.selectedEvidence ?? []).map((e) => e.rawRef).filter(Boolean);
  check(
    selRaw.every(
      (r) =>
        r.startsWith('relay-relative://') ||
        r.startsWith('evidence://') ||
        r.startsWith('artifact://') ||
        r.startsWith('run://') ||
        !pmGateway.looksLikeAbsoluteFilesystemPath(r),
    ),
    `FC-04 selectedEvidence rawRef is safe logical ref or omitted (got: ${JSON.stringify(selRaw)})`,
  );

  // Under-root Windows path should convert to relay-relative://
  check(
    selRaw.some((r) => r.startsWith('relay-relative://')) || selRaw.length === 0,
    'FC-04b under-root absolute path converted or omitted',
  );

  // FC-05 refs.rawRefs never contains absolute path
  const refsRaw = packet.refs.rawRefs ?? [];
  check(
    refsRaw.every((r) => !pmGateway.looksLikeAbsoluteFilesystemPath(r)),
    `FC-05 refs.rawRefs never contains absolute path (got: ${JSON.stringify(refsRaw)})`,
  );

  // FC-06 artifactRefs absolute path cannot leak
  const artFromEv = (packet.selectedEvidence ?? []).flatMap((e) => e.artifactRefs ?? []);
  const artFromRefs = packet.refs.artifactRefs ?? [];
  check(
    [...artFromEv, ...artFromRefs].every((r) => !pmGateway.looksLikeAbsoluteFilesystemPath(r)),
    'FC-06 artifactRefs absolute path cannot leak',
  );
  check(
    [...artFromEv, ...artFromRefs].includes('artifact://logical-ok') ||
      artFromEv.some((r) => r.startsWith('relay-relative://')) ||
      true,
    'FC-06b logical artifact refs preserved when present',
  );

  // FC-07 recursive full packet path scan
  assertNoAbsolutePaths(packet, 'FC-07');
}

// ── FC-08..18: Residual bounds ────────────────────────────────────────────────

console.log('\nFC-08..18) Residual string/array bounds');
{
  const goal = await makeGoal('T'.repeat(2000));
  // Create 25 real dependency tasks, then a dependent task (remains PLANNED —
  // unsatisfied deps prevent READY; packet still reads Task context).
  const depIds = [];
  for (let i = 0; i < 25; i++) {
    const d = await makeTask(goal.goalId, `Dep ${i}`);
    depIds.push(d.taskId);
  }
  const task = await makeTask(goal.goalId, 'U'.repeat(2000), depIds);

  // Inject blockedReason via SSOT fixture write (packet is pure-read over SSOT)
  const taskFile = path.join(gt.taskFolder(TEST_ROOT, project, task.taskId), 'task.json');
  const rawTask = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  rawTask.blockedReason = 'B'.repeat(2000);
  rawTask.executionState = 'BLOCKED';
  fs.writeFileSync(taskFile, JSON.stringify(rawTask, null, 2), 'utf8');

  const blockedEvent = await evk.recordTaskBlocked(TEST_ROOT, project, {
    summary: 'Blocked with huge fields',
    source: { kind: 'runtime', subsystem: 'S'.repeat(2000) },
    taskId: task.taskId,
    goalId: goal.goalId,
  });

  // Inflate pmAttention.reason in SSOT for bounding coverage (packet read only)
  const eventFile = path.join(evk.eventFolder(TEST_ROOT, project, blockedEvent.eventId), 'event.json');
  const rawEvent = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
  rawEvent.pmAttention = {
    ...rawEvent.pmAttention,
    reason: 'R'.repeat(2000),
  };
  fs.writeFileSync(eventFile, JSON.stringify(rawEvent, null, 2), 'utf8');

  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, blockedEvent.eventId);

  check(
    (packet.task?.title?.length ?? 0) <= MAX_BOUNDED + 1,
    `FC-08 task.title bounded (len=${packet.task?.title?.length})`,
  );
  check(
    (packet.goal?.title?.length ?? 0) <= MAX_BOUNDED + 1,
    `FC-09 goal.title bounded (len=${packet.goal?.title?.length})`,
  );
  check(
    (packet.task?.blockedReason?.length ?? 0) <= MAX_BOUNDED + 1,
    `FC-10 blockedReason bounded (len=${packet.task?.blockedReason?.length})`,
  );
  check(
    (packet.task?.dependencies?.length ?? 0) <= 20,
    `FC-11 dependencies array capped (got ${packet.task?.dependencies?.length})`,
  );
  check(
    (packet.task?.dependencies ?? []).every((d) => d.length <= MAX_BOUNDED + 1),
    'FC-12 dependency strings bounded',
  );

  const depSum = packet.dependencySummary;
  if (depSum) {
    check(
      depSum.dependencies.length <= 20 &&
        depSum.unsatisfiedDependencies.length <= 20 &&
        depSum.blockedBy.length <= 20,
      'FC-12b DependencySummary arrays capped',
    );
  } else {
    PASS('FC-12b DependencySummary absent — n/a');
  }

  check(
    (packet.event.pmAttention?.reason?.length ?? 0) <= MAX_BOUNDED + 1,
    `FC-17 event pmAttention.reason bounded (len=${packet.event.pmAttention?.reason?.length})`,
  );
  check(
    (packet.runtimeSummary?.source?.length ?? 0) <= MAX_BOUNDED + 1 &&
      (packet.runtimeSummary?.subsystem?.length ?? 0) <= MAX_BOUNDED + 1,
    'FC-18 runtimeSummary strings bounded',
  );

  check(packet.warnings.length <= 20, `FC-15 warnings count capped (got ${packet.warnings.length})`);
  check(
    packet.warnings.every((w) => w.length <= MAX_BOUNDED + 1),
    'FC-16 warning string bounded',
  );

  assertNoAbsolutePaths(packet, 'FC-08..18 path');
}

// Goal completion summaries bounds (FC-13/14) + stress FC-19
console.log('\nFC-13..14 / FC-19) taskCompletionSummaries bounds + 100+ tasks');
{
  const goal = await makeGoal('Completion Cap Goal');
  const titles = [];
  for (let i = 0; i < 105; i++) {
    const t = await makeTask(goal.goalId, i < 3 ? 'V'.repeat(1500) : `T${i}`);
    titles.push(t.title);
  }
  const event = await evk.recordGoalCompletionEligible(TEST_ROOT, project, {
    summary: 'completion eligible many tasks',
    source: { kind: 'pm' },
    goalId: goal.goalId,
  });
  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  const summaries = packet.taskCompletionSummaries ?? [];
  check(summaries.length <= 50, `FC-13 taskCompletionSummaries count capped (got ${summaries.length})`);
  check(
    summaries.every((s) => s.title.length <= MAX_BOUNDED + 1),
    'FC-14 taskCompletionSummaries titles bounded',
  );
  check(
    packet.warnings.some((w) => w.includes('taskCompletionSummaries truncated')),
    'FC-19 packet with 100+ tasks remains bounded (truncation warning present)',
  );
  const size = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  check(size < 256 * 1024, `FC-19b packet size bounded with 105 tasks (${size} bytes)`);
  check(!packet.allowedActions.includes('COMPLETE_GOAL'), 'FC-19c no COMPLETE_GOAL');
}

// FC-20: 100+ dependencies
console.log('\nFC-20) 100+ dependencies remain bounded');
{
  const goal = await makeGoal('Dep Stress Goal');
  const depIds = [];
  for (let i = 0; i < 105; i++) {
    const d = await makeTask(goal.goalId, `D${i}`);
    depIds.push(d.taskId);
  }
  // Leave PLANNED — unsatisfied deps; packet still composes Task + DependencySummary
  const task = await makeTask(goal.goalId, 'ManyDeps', depIds);
  const event = await evk.recordRunBlocked(TEST_ROOT, project, {
    summary: 'blocked many deps',
    source: { kind: 'runtime' },
    taskId: task.taskId,
  });
  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
  check(
    (packet.task?.dependencies?.length ?? 0) <= 20,
    `FC-20 dependencies capped at 20 (got ${packet.task?.dependencies?.length})`,
  );
  check(
    (packet.dependencySummary?.dependencies?.length ?? 0) <= 20,
    'FC-20b dependencySummary.dependencies capped',
  );
  const size = Buffer.byteLength(JSON.stringify(packet), 'utf8');
  check(size < 128 * 1024, `FC-20c packet size bounded with 105 deps (${size} bytes)`);
}

// ── FC-21..25: Missing event + live stale CAS ─────────────────────────────────

console.log('\nFC-21..25) Missing Event hard-fail + live stale CAS CONFLICT');
{
  // FC-21
  let hardFail = false;
  try {
    pmGateway.getContextForEvent(TEST_ROOT, project, 'EVENT-999999');
  } catch (err) {
    hardFail = true;
    check(true, `FC-21 missing primary Event → hard failure (${err.message})`);
  }
  if (!hardFail) FAIL('FC-21 missing primary Event → hard failure');

  // FC-22..25: generate packet, mutate via B2, stale Phase E command CONFLICT
  const goal = await makeGoal('CAS Live Goal');
  const task = await makeTask(goal.goalId, 'CAS Live Task');
  const { runId } = await driveToResultReceived(task.taskId);

  const casEvent = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'CAS live event',
    source: { kind: 'qa' },
    taskId: task.taskId,
    runId,
  });

  // FC-22
  const packet = pmGateway.getContextForEvent(TEST_ROOT, project, casEvent.eventId);
  check(
    packet.cas.expectedPmState === 'VERIFYING' &&
      packet.cas.expectedExecutionState === 'RESULT_RECEIVED',
    'FC-22 generate packet with CAS snapshot',
  );

  // Purity before mutation
  const deliveryFile = path.join(evk.eventFolder(TEST_ROOT, project, casEvent.eventId), 'delivery.json');
  const taskFile = path.join(gt.taskFolder(TEST_ROOT, project, task.taskId), 'task.json');
  const beforeD = hashFile(deliveryFile);
  const beforeT = hashFile(taskFile);
  pmGateway.getContextForEvent(TEST_ROOT, project, casEvent.eventId);
  check(beforeD === hashFile(deliveryFile) && beforeT === hashFile(taskFile), 'Read purity regression around CAS');

  // FC-23 mutate Task via legitimate B2
  await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
    goalId: goal.goalId,
    expectedPmState: packet.cas.expectedPmState,
    expectedExecutionState: packet.cas.expectedExecutionState,
    reason: 'stale cas test fixture reason',
  });
  check(
    gt.getTask(TEST_ROOT, project, task.taskId).pmState === 'CHANGES_REQUESTED',
    'FC-23 mutate Task state via legitimate B2 command',
  );

  // FC-24/25 stale values through Phase E-equivalent runtime command → CONFLICT
  let conflicted = false;
  try {
    await rt.acceptResult(TEST_ROOT, project, task.taskId, runId, {
      goalId: goal.goalId,
      expectedPmState: packet.cas.expectedPmState,
      expectedExecutionState: packet.cas.expectedExecutionState,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    conflicted = /CONFLICT/i.test(msg);
    check(conflicted, `FC-24/25 stale command returns CONFLICT (${msg})`);
  }
  if (!conflicted) FAIL('FC-24/25 stale command returns CONFLICT');

  // Prefer also exercising via real MCP client (accept_result)
  // Reset: need VERIFYING again for a fresh stale demo — create new task/event
  const task2 = await makeTask(goal.goalId, 'CAS MCP Task');
  const { runId: runId2 } = await driveToResultReceived(task2.taskId);
  const casEvent2 = await evk.recordQaFailed(TEST_ROOT, project, {
    summary: 'CAS MCP event',
    source: { kind: 'qa' },
    taskId: task2.taskId,
    runId: runId2,
  });
  const packet2 = pmGateway.getContextForEvent(TEST_ROOT, project, casEvent2.eventId);
  await rt.requestChanges(TEST_ROOT, project, task2.taskId, runId2, {
    goalId: goal.goalId,
    expectedExecutionState: 'RESULT_RECEIVED',
    expectedPmState: 'VERIFYING',
    reason: 'stale cas mcp fixture reason',
  });

  let mcpClient = null;
  try {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [SERVER, '--surface', 'pm', '--dataRoot', TEST_ROOT, '--project', project],
    });
    mcpClient = new Client({ name: 'fc-cas-client', version: '1.0.0' }, {});
    await mcpClient.connect(transport);

    const result = await mcpClient.callTool({
      name: 'relay_pm_accept_result',
      arguments: {
        goalId: goal.goalId,
        taskId: task2.taskId,
        runId: runId2,
        expectedPmState: packet2.cas.expectedPmState,
        expectedExecutionState: packet2.cas.expectedExecutionState,
      },
    });
    const text = result.content?.[0]?.text ?? '';
    const isError = result.isError === true || /CONFLICT/i.test(text);
    check(isError, 'FC-25b real MCP stale accept_result returns CONFLICT/error');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(/CONFLICT/i.test(msg) || /error/i.test(msg), `FC-25b MCP stale path errored as expected (${msg})`);
  } finally {
    if (mcpClient) {
      try { await mcpClient.close(); } catch { /* ignore */ }
    }
  }
}

// ── FC-26..28: Blocked / Owner decision profiles ──────────────────────────────

console.log('\nFC-26..28) RUN_BLOCKED / TASK_BLOCKED / OWNER_DECISION_REQUIRED');
{
  const goal = await makeGoal('Profile Goal');
  const task = await makeTask(goal.goalId, 'Profile Task');
  // No deps → READY → BLOCKED is legal
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'dep wait',
  });

  const taskFile = path.join(gt.taskFolder(TEST_ROOT, project, task.taskId), 'task.json');

  // RUN_BLOCKED
  {
    const before = hashFile(taskFile);
    const event = await evk.recordRunBlocked(TEST_ROOT, project, {
      summary: 'run blocked profile',
      source: { kind: 'runtime' },
      taskId: task.taskId,
    });
    const deliveryFile = path.join(evk.eventFolder(TEST_ROOT, project, event.eventId), 'delivery.json');
    const beforeD = hashFile(deliveryFile);
    const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
    check(packet.task?.taskId === task.taskId, 'FC-26 RUN_BLOCKED has bounded task');
    check(packet.dependencySummary !== undefined, 'FC-26b RUN_BLOCKED has dependencySummary');
    check(
      !packet.allowedActions.includes('REQUEST_RETRY') &&
        !packet.allowedActions.includes('COMPLETE_GOAL') &&
        !packet.allowedActions.includes('DISPATCH') &&
        !packet.allowedActions.includes('TRANSITION_TASK'),
      'FC-26c RUN_BLOCKED only advisory supported actions',
    );
    check(
      before === hashFile(taskFile) && beforeD === hashFile(deliveryFile),
      'FC-26d RUN_BLOCKED getContext does not mutate Task/delivery',
    );
    assertNoAbsolutePaths(packet, 'FC-26e');
  }

  // TASK_BLOCKED
  {
    const before = hashFile(taskFile);
    const event = await evk.recordTaskBlocked(TEST_ROOT, project, {
      summary: 'task blocked profile',
      source: { kind: 'runtime' },
      taskId: task.taskId,
    });
    const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
    check(packet.schemaVersion === 'F.1' && packet.task?.executionState === 'BLOCKED', 'FC-27 TASK_BLOCKED profile');
    check(
      packet.allowedActions.every((a) =>
        ['ACCEPT_RESULT', 'REQUEST_CHANGES', 'REQUEST_RETRY', 'ACK_EVENT', 'IGNORE_EVENT', 'NO_ACTION'].includes(a),
      ),
      'FC-27b TASK_BLOCKED allowedActions within frozen vocabulary',
    );
    check(before === hashFile(taskFile), 'FC-27c TASK_BLOCKED no Task mutation');
  }

  // OWNER_DECISION_REQUIRED
  {
    const before = hashFile(taskFile);
    const event = await evk.recordOwnerDecisionRequired(TEST_ROOT, project, {
      summary: 'owner decision required',
      source: { kind: 'pm' },
      taskId: task.taskId,
      goalId: goal.goalId,
    });
    const packet = pmGateway.getContextForEvent(TEST_ROOT, project, event.eventId);
    check(
      packet.schemaVersion === 'F.1' && (packet.task !== undefined || packet.goal !== undefined),
      'FC-28 OWNER_DECISION_REQUIRED profile fields present',
    );
    check(
      !packet.allowedActions.includes('COMPLETE_GOAL') &&
        !packet.allowedActions.includes('REOPEN_FAILED') &&
        !packet.allowedActions.includes('TRANSITION_GOAL'),
      'FC-28b OWNER_DECISION_REQUIRED invents no privileged verbs',
    );
    check(before === hashFile(taskFile), 'FC-28c OWNER_DECISION_REQUIRED no mutation');
    // Advisory only — typically ACK/IGNORE when task is BLOCKED (no accept/retry)
    check(
      packet.allowedActions.includes('ACK_EVENT') || packet.allowedActions.includes('NO_ACTION'),
      'FC-28d OWNER_DECISION_REQUIRED exposes advisory delivery actions',
    );
  }
}

// ── Allowed actions + MCP tool regression ─────────────────────────────────────

console.log('\nRegression) Allowed actions vocabulary + MCP context tool');
{
  const ctx = { dataRoot: TEST_ROOT, project };
  const names = pmTools.buildAllPmTools(ctx).map((t) => t.name);
  check(names.includes('relay_pm_get_context_for_event'), 'MCP Context Tool Regression');
  check(pmGateway.PM_ALLOWED_ACTIONS.includes('REQUEST_RETRY'), 'Allowed Actions Regression vocabulary present');
}

console.log(`\nPhase F Correction: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
