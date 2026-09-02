/**
 * Phase I3F-3 — TUI Owner judgment action bridge (OWNER_IPC only).
 * Permanent regression coverage:
 *   F3-01..06 availability derivation
 *   F3-A01..06 Accept wiring (canonical, banner, conflict, disabled-no-mutation)
 *   F3-C01..08 Changes input + wiring (bounded reason, cancel, stale conflict)
 *   F3-R01..06 Retry wiring
 *   F3-I01..05 Reason input key reducer (q is literal text, Esc cancels, etc.)
 *   Legacy-bypass + Action-Event-via-canonical-Core regressions
 *
 * Temporary DATA_ROOT only. Deterministic — no real TTY / stdin required
 * (mirrors the established I3F-1 pattern: source-text assertions for the
 * imperative tui.ts wiring + real functional/integration calls against the
 * exported, pure src/tui/actions.ts bridge).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-phase-i3f3-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const tuiSrc = fs.readFileSync('src/tui/tui.ts', 'utf8');
const actionsSrc = fs.readFileSync('src/tui/actions.ts', 'utf8');
const renderSrc = fs.readFileSync('src/tui/render.ts', 'utf8');

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const evk = await import('../dist/server/backend/event.js');
const actions = await import('../dist/server/tui/actions.js');

const project = 'I3F3Proj';
relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

async function makeGoal(mode = 'BYPASS', title = 'I3F3 Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title, goalStatement: 'i3f3 goal', permissionPolicy: { mode },
  });
}

async function linkRun(taskId, agent = 'I3F3Agent') {
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

function ctxFrom(task, runId) {
  return {
    dataRoot: TEST_ROOT,
    project,
    goalId: task.goalId,
    taskId: task.taskId,
    runId,
    expectedExecutionState: task.executionState,
    expectedPmState: task.pmState,
  };
}

// ── F3-01..06: Availability derivation (pure) ───────────────────────────────
console.log('\n── F3-01..06 deriveAvailableActions (pure) ──');
{
  const avNull = actions.deriveAvailableActions(null);
  check(avNull.ACCEPT.state === 'DISABLED', 'F3-01a null task -> ACCEPT disabled');
  check(avNull.TASK_DETAIL.state === 'ENABLED', 'F3-01b null task -> TASK_DETAIL still enabled (nav view)');
  check(avNull.EVENTS_VIEW.state === 'ENABLED', 'F3-01c null task -> EVENTS_VIEW still enabled (nav view)');
  check(avNull.MEMO_ADD.state === 'DISABLED', 'F3-01d null task -> MEMO_ADD disabled');

  const avVerify = actions.deriveAvailableActions({
    executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING', currentRunId: 'r1',
  });
  check(avVerify.ACCEPT.state === 'ENABLED', 'F3-02a Accept enabled only RESULT_RECEIVED+VERIFYING');
  check(avVerify.REQUEST_CHANGES.state === 'ENABLED', 'F3-02b Changes enabled only RESULT_RECEIVED+VERIFYING');
  check(avVerify.RETRY.state === 'DISABLED', 'F3-02c Retry disabled while VERIFYING (before Changes)');

  const avNoRun = actions.deriveAvailableActions({
    executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING', currentRunId: undefined,
  });
  check(avNoRun.ACCEPT.state === 'DISABLED', 'F3-03a Accept disabled when no current Run resolvable');
  check(avNoRun.REQUEST_CHANGES.state === 'DISABLED', 'F3-03b Changes disabled when no current Run resolvable');

  const avChanges = actions.deriveAvailableActions({
    executionState: 'RESULT_RECEIVED', pmState: 'CHANGES_REQUESTED',
  });
  check(avChanges.RETRY.state === 'ENABLED', 'F3-03 Retry enabled only RESULT_RECEIVED+CHANGES_REQUESTED');
  check(avChanges.ACCEPT.state === 'DISABLED', 'F3-03c Accept disabled at CHANGES_REQUESTED');

  const avReady = actions.deriveAvailableActions({ executionState: 'READY', pmState: 'PENDING' });
  check(avReady.ACCEPT.state === 'DISABLED', 'F3-04 Accept disabled READY/PENDING');
  check(avReady.REQUEST_CHANGES.state === 'DISABLED', 'F3-04b Changes disabled READY/PENDING');
  check(avReady.RETRY.state === 'DISABLED', 'F3-05 Retry disabled before Changes (READY/PENDING)');

  const avAccepted = actions.deriveAvailableActions({
    executionState: 'RESULT_RECEIVED', pmState: 'ACCEPTED', acceptedRunId: 'r1',
  });
  check(avAccepted.ACCEPT.state === 'DISABLED', 'F3-06a terminal ACCEPTED state safe (Accept disabled)');
  check(avAccepted.RETRY.state === 'DISABLED', 'F3-06b terminal ACCEPTED state safe (Retry disabled — acceptedRunId set)');

  const avCancelled = actions.deriveAvailableActions({ executionState: 'CANCELLED', pmState: 'PENDING' });
  check(
    avCancelled.ACCEPT.state === 'DISABLED' && avCancelled.REQUEST_CHANGES.state === 'DISABLED' && avCancelled.RETRY.state === 'DISABLED',
    'F3-06c terminal/invalid CANCELLED state safe — no action enabled',
  );
}

// ── Action bridge surface: OWNER_IPC only, no PM MCP loopback ───────────────
console.log('\n── OWNER_IPC surface / no PM MCP loopback ──');
{
  check(actionsSrc.includes("callerSurface: 'OWNER_IPC'"), 'OWNER_IPC callerSurface literal present in actions.ts');
  check(!actionsSrc.includes("callerSurface: 'PM_MCP'") && !actionsSrc.includes('"PM_MCP"'), 'actions.ts never assigns callerSurface PM_MCP (comment mentions only)');
  check(!actionsSrc.includes("require('http')") && !actionsSrc.includes("from 'http'"), 'actions.ts makes no HTTP calls');
  check(!actionsSrc.includes('child_process'), 'actions.ts spawns no subprocess');
}

// ── Legacy bypass regression: TUI Accept/Changes never call transitionTaskPm ─
console.log('\n── Legacy bypass regression ──');
{
  check(!actionsSrc.includes('transitionTaskPm('), 'actions.ts never calls transitionTaskPm (canonical only)');
  check(
    actionsSrc.includes('acceptTaskResult') && actionsSrc.includes('requestTaskChanges') && actionsSrc.includes('requestTaskRetry'),
    'actions.ts routes through canonical task-actions.ts (acceptTaskResult/requestTaskChanges/requestTaskRetry)',
  );
  check(!tuiSrc.includes('transitionTaskPm'), 'tui.ts never calls transitionTaskPm directly');
  check(
    tuiSrc.includes('executeOwnerAction') && tuiSrc.includes("from './actions.js'"),
    'tui.ts routes Owner actions through the narrow src/tui/actions.ts bridge',
  );
}

// ── F3-A01..06: Accept wiring ────────────────────────────────────────────────
console.log('\n── F3-A01..06 Accept wiring ──');
{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'A1');
  const av = actions.deriveAvailableActions({
    executionState: task.executionState, pmState: task.pmState, currentRunId: runId,
  });
  check(av.ACCEPT.state === 'ENABLED', 'F3-A01a Accept derived ENABLED before press');

  const result = await actions.executeOwnerAction('ACCEPT', ctxFrom(task, runId));
  check(result.ok === true, 'F3-A01b press A enabled -> canonical Accept succeeds');
  check(result.ok && result.task.pmState === 'ACCEPTED', 'F3-A01c pmState -> ACCEPTED');
  check(result.ok && result.task.acceptedRunId === runId, 'F3-A02 acceptedRunId correct');

  const acceptEvents = evk.listEvents(TEST_ROOT, project, {
    taskId: task.taskId, type: 'TASK_RESULT_ACCEPTED',
  }).events;
  check(acceptEvents.length === 1, 'F3-A03 Action Event (TASK_RESULT_ACCEPTED) exists exactly once');

  // F3-A04: banner text wiring present in tui.ts (transient success banner).
  check(tuiSrc.includes('Result accepted') && tuiSrc.includes('showBanner'), 'F3-A04 transient success banner wired');

  // F3-A05: stale Accept -> CONFLICT, no crash, no second mutation.
  const g2 = await makeGoal();
  const { task: t5, runId: r5 } = await makeVerifyingTask(g2.goalId, 'A5');
  const staleCtx = ctxFrom(t5, r5); // captured BEFORE the race
  // Race: another caller (e.g. PM MCP) requests changes first.
  await rt.requestChanges(TEST_ROOT, project, t5.taskId, r5, {
    goalId: g2.goalId, reason: 'race: changes requested first', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const staleResult = await actions.executeOwnerAction('ACCEPT', staleCtx);
  check(staleResult.ok === false, 'F3-A05a stale Accept rejected, not silently mutated');
  check(!staleResult.ok && staleResult.code === 'CONFLICT', 'F3-A05b stale Accept classified CONFLICT');
  const afterRace = gt.getTask(TEST_ROOT, project, t5.taskId);
  check(afterRace.pmState === 'CHANGES_REQUESTED', 'F3-A05c winner (Changes) state undisturbed by stale Accept');

  // F3-A06: disabled Accept (READY/PENDING) does not mutate.
  const g3 = await makeGoal();
  const t6 = await gt.createTask(TEST_ROOT, project, {
    goalId: g3.goalId, title: 'A6', goal: 'g', reason: 'r', scope: 's',
  });
  const av6 = actions.deriveAvailableActions({ executionState: t6.executionState, pmState: t6.pmState });
  check(av6.ACCEPT.state === 'DISABLED', 'F3-A06a Accept correctly derived DISABLED at PLANNED/PENDING');
  const before6 = gt.getTask(TEST_ROOT, project, t6.taskId);
  // Even if the bridge were invoked directly, no runId/precondition -> rejected, not mutated.
  const result6 = await actions.executeOwnerAction('ACCEPT', {
    dataRoot: TEST_ROOT, project, goalId: g3.goalId, taskId: t6.taskId, runId: undefined,
    expectedExecutionState: t6.executionState, expectedPmState: t6.pmState,
  });
  check(result6.ok === false, 'F3-A06b disabled Accept attempt rejected');
  const after6 = gt.getTask(TEST_ROOT, project, t6.taskId);
  check(after6.pmState === before6.pmState && after6.executionState === before6.executionState, 'F3-A06c disabled Accept does not mutate');
}

// ── F3-C01..08: Changes input + wiring ───────────────────────────────────────
console.log('\n── F3-C01..08 Changes input + wiring ──');
{
  // F3-C01: pressing C opens Reason input — structural wiring.
  check(tuiSrc.includes("s === 'c' || s === 'C'") && tuiSrc.includes('handleChangesKeyOpen'), 'F3-C01 press C opens Reason input (handleChangesKeyOpen)');
  check(tuiSrc.includes("view = 'CHANGES_INPUT'"), 'F3-C01b view transitions to CHANGES_INPUT');

  // F3-C02/C03: bounded reason via reduceReasonInput.
  const short = actions.reduceReasonInput({ draft: 'tiny', error: undefined }, { type: 'submit' });
  check(short.action === 'update' && !!short.state.error, 'F3-C02 <10 reason rejected (no submit)');

  let longState = { draft: '', error: undefined };
  for (let i = 0; i < 2010; i++) {
    const eff = actions.reduceReasonInput(longState, { type: 'char', value: 'x' });
    longState = eff.action === 'update' ? eff.state : longState;
  }
  check(longState.draft.length === 2000, 'F3-C03 >2000 chars prevented at input time (capped at 2000)');
  const overflowSubmit = actions.reduceReasonInput(longState, { type: 'submit' });
  check(overflowSubmit.action === 'submit', 'F3-C03b exactly-2000 char reason submits (boundary ok)');

  // F3-C04: Esc cancels.
  const cancelEff = actions.reduceReasonInput({ draft: 'partial reason text', error: undefined }, { type: 'cancel' });
  check(cancelEff.action === 'cancel', 'F3-C04 Esc cancels (reducer)');
  check(tuiSrc.includes('pendingChangesCtx = null') && tuiSrc.includes("s === '\\x1b'"), 'F3-C04b tui.ts Esc clears pendingChangesCtx, no mutation call');

  // F3-C05/C06/C07: valid submit -> canonical Changes, Action Event, no automatic Retry.
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'C5');
  const validReason = 'hardening: please address the review comments';
  const submitEff = actions.reduceReasonInput({ draft: validReason, error: undefined }, { type: 'submit' });
  check(submitEff.action === 'submit' && submitEff.reason === validReason, 'F3-C05a reducer accepts valid reason');

  const result = await actions.executeOwnerAction('REQUEST_CHANGES', ctxFrom(task, runId), { reason: submitEff.reason });
  check(result.ok === true, 'F3-C05b valid submit -> canonical Changes succeeds');
  check(result.ok && result.task.pmState === 'CHANGES_REQUESTED', 'F3-C05c pmState -> CHANGES_REQUESTED');
  check(result.ok && result.task.executionState === 'RESULT_RECEIVED', 'F3-C07a execution remains RESULT_RECEIVED (no automatic Retry)');
  check(result.ok && (result.task.retryCount ?? 0) === 0, 'F3-C07b retryCount untouched (no automatic Retry)');

  const changesEvents = evk.listEvents(TEST_ROOT, project, {
    taskId: task.taskId, type: 'TASK_CHANGES_REQUESTED',
  }).events;
  check(changesEvents.length === 1, 'F3-C06 Action Event (TASK_CHANGES_REQUESTED) exists exactly once');

  // F3-C08: stale Changes handled — race with a prior Accept.
  const g2 = await makeGoal();
  const { task: t8, runId: r8 } = await makeVerifyingTask(g2.goalId, 'C8');
  const staleCtx = ctxFrom(t8, r8);
  await rt.acceptResult(TEST_ROOT, project, t8.taskId, r8, {
    goalId: g2.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const staleResult = await actions.executeOwnerAction('REQUEST_CHANGES', staleCtx, { reason: 'stale attempt after accept race' });
  check(staleResult.ok === false, 'F3-C08a stale Changes rejected after concurrent Accept');
  check(!staleResult.ok && staleResult.code === 'CONFLICT', 'F3-C08b stale Changes classified CONFLICT');
  const afterRace8 = gt.getTask(TEST_ROOT, project, t8.taskId);
  check(afterRace8.pmState === 'ACCEPTED', 'F3-C08c winner (Accept) state undisturbed by stale Changes');
}

// ── F3-R01..06: Retry wiring ─────────────────────────────────────────────────
console.log('\n── F3-R01..06 Retry wiring ──');
{
  const g = await makeGoal();
  const { task, runId } = await makeVerifyingTask(g.goalId, 'R1');
  const changed = await rt.requestChanges(TEST_ROOT, project, task.taskId, runId, {
    goalId: g.goalId, reason: 'needs fixups before retry', expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  check(changed.pmState === 'CHANGES_REQUESTED', 'R1 fixture: task is CHANGES_REQUESTED before Retry');

  const linkedBefore = changed.linkedRuns.length;
  const result = await actions.executeOwnerAction('RETRY', {
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
    expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  check(result.ok === true, 'F3-R01a R after Changes -> canonical Retry succeeds');
  check(result.ok && result.task.executionState === 'READY' && result.task.pmState === 'PENDING', 'F3-R01b READY+PENDING');
  check(result.ok && (result.task.retryCount ?? 0) === 1, 'F3-R02 retryCount increments');
  check(result.ok && result.task.linkedRuns.length === linkedBefore, 'F3-R03 no new Run created (linkedRuns count unchanged)');
  check(result.ok && result.task.executionState !== 'DISPATCHED', 'F3-R04 no dispatch occurs (not DISPATCHED)');

  const retryEvents = evk.listEvents(TEST_ROOT, project, {
    taskId: task.taskId, type: 'TASK_RETRY_REQUESTED',
  }).events;
  check(retryEvents.length === 1, 'F3-R05 Action Event (TASK_RETRY_REQUESTED) exists exactly once');

  // F3-R06: stale double Retry — second Retry with the same (now stale) CAS context.
  const secondResult = await actions.executeOwnerAction('RETRY', {
    dataRoot: TEST_ROOT, project, goalId: g.goalId, taskId: task.taskId,
    expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  check(secondResult.ok === false, 'F3-R06a stale double Retry rejected');
  check(!secondResult.ok && secondResult.code === 'CONFLICT', 'F3-R06b stale double Retry classified CONFLICT');
  const finalTask = gt.getTask(TEST_ROOT, project, task.taskId);
  check((finalTask.retryCount ?? 0) === 1, 'F3-R06c retryCount not double-incremented');
}

// ── F3-I01..05: Reason input key reducer ─────────────────────────────────────
console.log('\n── F3-I01..05 Reason input key reducer ──');
{
  let s = { draft: '', error: undefined };
  for (const ch of 'hello world') {
    const eff = actions.reduceReasonInput(s, { type: 'char', value: ch });
    s = eff.action === 'update' ? eff.state : s;
  }
  check(s.draft === 'hello world', 'F3-I01 normal characters captured');

  const qEff = actions.reduceReasonInput(s, { type: 'char', value: 'q' });
  check(qEff.action === 'update' && qEff.state.draft === 'hello worldq', 'F3-I02 q is captured as literal Reason text, not a quit signal');
  check(
    tuiSrc.includes("view === 'CHANGES_INPUT'") && tuiSrc.indexOf("view === 'CHANGES_INPUT'") < tuiSrc.indexOf("s === 'q' || s === 'Q'"),
    'F3-I02b tui.ts intercepts CHANGES_INPUT before the global q-quit check',
  );

  const escEff = actions.reduceReasonInput(s, { type: 'cancel' });
  check(escEff.action === 'cancel', 'F3-I03 Esc cancels');

  const bsEff = actions.reduceReasonInput({ draft: 'abc', error: undefined }, { type: 'backspace' });
  check(bsEff.action === 'update' && bsEff.state.draft === 'ab', 'F3-I04 Backspace works');

  const validLen10 = 'x'.repeat(10);
  const submitOk = actions.reduceReasonInput({ draft: validLen10, error: undefined }, { type: 'submit' });
  check(submitOk.action === 'submit' && submitOk.reason === validLen10, 'F3-I05a Enter submits valid input (>=10 chars)');
  const submitBad = actions.reduceReasonInput({ draft: 'short', error: undefined }, { type: 'submit' });
  check(submitBad.action === 'update' && !!submitBad.state.error, 'F3-I05b Enter does not submit invalid input');
}

// ── Action Events via canonical Core (no manual TUI append) ─────────────────
console.log('\n── Action Events via canonical Core only ──');
{
  check(!tuiSrc.includes('recordTaskResultAccepted') && !tuiSrc.includes('recordTaskChangesRequested') && !tuiSrc.includes('recordTaskRetryRequested'), 'tui.ts never records Action Events directly (canonical task-actions.ts does)');
  check(!actionsSrc.includes('recordTaskResultAccepted') && !actionsSrc.includes('recordTaskChangesRequested') && !actionsSrc.includes('recordTaskRetryRequested'), 'actions.ts never records Action Events directly');
}

// ── CAS conflict UX text ─────────────────────────────────────────────────────
console.log('\n── CAS conflict / error UX ──');
{
  check(tuiSrc.includes('Task changed. Review current state and try again.'), 'CONFLICT banner text present');
  check(tuiSrc.includes('Action not allowed by current permission mode.'), 'FORBIDDEN banner text present');
  check(tuiSrc.includes('Action is no longer available.'), 'INVALID_STATE banner text present');
}

// ── Relay Motion / Memo / Events / regressions (structural) ─────────────────
console.log('\n── Regression: Relay motion / Memo / Events / structural ──');
{
  check(renderSrc.includes('renderRelayFrame'), 'render.ts still exports renderRelayFrame');
  check(tuiSrc.includes('createMemo') && tuiSrc.includes('memoDraft'), 'Memo flow (I3F-1) source untouched in shape');
  check(tuiSrc.includes("view = 'EVENTS'"), 'Events view navigation intact');
  check(tuiSrc.includes("view = 'TASK_DETAIL'") && !tuiSrc.includes('[e] Edit') && !tuiSrc.includes('Edit Task'), 'Task Detail stays read-only, no Edit added');
  check(tuiSrc.includes('?1049h') && tuiSrc.includes('?1049l'), 'alt screen enter/leave preserved');
  check(tuiSrc.includes('setRawMode(false)'), 'raw mode cleanup preserved');
  check(tuiSrc.includes("s === 'q' || s === 'Q'") && tuiSrc.includes('process.exit'), 'global q quit preserved (outside CHANGES_INPUT)');
}

console.log(`\n=== I3F-3: ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;
