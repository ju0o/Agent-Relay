/**
 * Phase I3F-4 — Safe pre-execution Task Edit (OWNER_IPC, narrative-only).
 * Permanent regression coverage:
 *   F4-01..09  canonical editTaskNarrative: PLANNED edit, whitelist fields, CAS
 *   F4-10..15  editable-state policy: DISPATCHED/RUNNING/RESULT_RECEIVED/FAILED/
 *              CANCELLED/ACCEPTED all rejected
 *   F4-16..22  identity/lifecycle fields never touched (taskId/goalId/
 *              executionState/pmState/linkedRuns/nextTaskRunSequence/acceptedRunId)
 *   F4-23      no judgment Action Event emitted
 *   F4-24..30  TUI wiring (Task Detail -> [e] Edit -> field menu -> bounded input)
 *   READY policy: V1 intentionally restricts editing to PLANNED only — see
 *   src/backend/task-edit.ts file header for the documented rationale
 *   (dispatcher state is process-local; the TUI's CLI process cannot prove
 *   "no dispatch in flight" for a dispatch issued by another process).
 *
 * Temporary DATA_ROOT only. Deterministic — no real TTY / stdin required
 * (mirrors the established I3F-1/I3F-3 pattern: source-text assertions for
 * the imperative tui.ts wiring + real functional/integration calls against
 * the exported, pure src/backend/task-edit.ts + src/tui/actions.ts bridge).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_ROOT = path.join(os.tmpdir(), `arl-phase-i3f4-${process.pid}-${Date.now()}`);
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

const taskEditSrc = fs.readFileSync('src/backend/task-edit.ts', 'utf8');
const actionsSrc = fs.readFileSync('src/tui/actions.ts', 'utf8');
const tuiSrc = fs.readFileSync('src/tui/tui.ts', 'utf8');
const taskDetailSrc = fs.readFileSync('src/tui/views/task-detail.ts', 'utf8');
const goalTaskSrc = fs.readFileSync('src/backend/goal-task.ts', 'utf8');

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const evk = await import('../dist/server/backend/event.js');
const taskEdit = await import('../dist/server/backend/task-edit.js');
const actions = await import('../dist/server/tui/actions.js');

const project = 'I3F4Proj';
relay.ensureDataRoot(TEST_ROOT);
relay.createProject(TEST_ROOT, project);

async function makeGoal(title = 'I3F4 Goal') {
  return gt.createGoal(TEST_ROOT, project, { title, goalStatement: 'i3f4 goal', permissionPolicy: { mode: 'BYPASS' } });
}

async function makeTask(goalId, overrides = {}) {
  return gt.createTask(TEST_ROOT, project, {
    goalId, title: 'Edit Task', goal: 'g', reason: 'r', scope: 's',
    ...overrides,
  });
}

// ── F4-01..03: PLANNED edit succeeds, title/goal/reason/scope, updatedAt ────
console.log('\n── F4-01..03 canonical editTaskNarrative on PLANNED ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId);
  check(t.executionState === 'PLANNED', 'F4-01 fixture: fresh Task is PLANNED');

  const before = gt.getTask(TEST_ROOT, project, t.taskId);
  const updated = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: before.updatedAt,
    title: 'New Title',
  });
  check(updated.title === 'New Title', 'F4-01 PLANNED Task edit succeeds');
  check(updated.updatedAt !== before.updatedAt, 'F4-02 title edit updates updatedAt');

  const updated2 = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: updated.updatedAt,
    goal: 'new goal text', reason: 'new reason text', scope: 'new scope text',
  });
  check(
    updated2.goal === 'new goal text' && updated2.reason === 'new reason text' && updated2.scope === 'new scope text',
    'F4-03 goal/reason/scope edits succeed',
  );

  // Bounds: title min 1 / max 5000.
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: updated2.updatedAt, title: '' }),
    'title empty rejected (min 1)',
  );
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: updated2.updatedAt, title: 'x'.repeat(5001) }),
    'title >5000 chars rejected',
  );
  const exact5000 = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: updated2.updatedAt, title: 'x'.repeat(5000),
  });
  check(exact5000.title.length === 5000, 'title exactly 5000 chars accepted (boundary)');
}

// ── F4-04: completionCriteria validation ─────────────────────────────────────
console.log('\n── F4-04 completionCriteria validation ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId);
  let cur = gt.getTask(TEST_ROOT, project, t.taskId);

  const ok = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: cur.updatedAt, completionCriteria: ['c1', 'c2', 'c3'],
  });
  check(ok.completionCriteria.length === 3, 'F4-04a valid completionCriteria (<=20, each<=500) accepted');
  cur = ok;

  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
      expectedUpdatedAt: cur.updatedAt, completionCriteria: Array.from({ length: 21 }, (_, i) => `c${i}`),
    }),
    'F4-04b completionCriteria >20 entries rejected',
  );
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
      expectedUpdatedAt: cur.updatedAt, completionCriteria: ['x'.repeat(501)],
    }),
    'F4-04c completionCriteria entry >500 chars rejected',
  );
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
      expectedUpdatedAt: cur.updatedAt, completionCriteria: ['  '],
    }),
    'F4-04d completionCriteria empty (after trim) entry rejected',
  );
  const cleared = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: cur.updatedAt, completionCriteria: [],
  });
  check(cleared.completionCriteria.length === 0, 'F4-04e empty completionCriteria clears the list');
}

// ── F4-05..07: dependencies validation + dedupe, self-dep, cycle ────────────
console.log('\n── F4-05..07 dependency validation / dedupe / self-dep / cycle ──');
{
  const g = await makeGoal();
  const a = await makeTask(g.goalId, { title: 'A' });
  const b = await makeTask(g.goalId, { title: 'B' });
  const c = await makeTask(g.goalId, { title: 'C' });

  const aAfter = await taskEdit.editTaskNarrative(TEST_ROOT, project, a.taskId, {
    expectedUpdatedAt: a.updatedAt, dependencies: [b.taskId, b.taskId],
  });
  check(aAfter.dependencies.length === 1 && aAfter.dependencies[0] === b.taskId, 'F4-05 dependencies deduped (A->[B,B] => [B])');

  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, a.taskId, {
      expectedUpdatedAt: aAfter.updatedAt, dependencies: [a.taskId],
    }),
    'F4-06 self-dependency rejected',
  );

  // A already depends on B (from F4-05) — B->A would create a cycle A->B->A.
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, b.taskId, {
      expectedUpdatedAt: b.updatedAt, dependencies: [a.taskId],
    }),
    'F4-07 cycle dependency rejected',
  );

  // Max count: 21 distinct, cycle-free dependencies rejected.
  const leaves = [];
  for (let i = 0; i < 21; i++) leaves.push(await makeTask(g.goalId, { title: `leaf${i}` }));
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, c.taskId, {
      expectedUpdatedAt: c.updatedAt, dependencies: leaves.map((x) => x.taskId),
    }),
    'F4-05b dependencies >20 entries rejected',
  );
  const within = await taskEdit.editTaskNarrative(TEST_ROOT, project, c.taskId, {
    expectedUpdatedAt: c.updatedAt, dependencies: leaves.slice(0, 20).map((x) => x.taskId),
  });
  check(within.dependencies.length === 20, 'F4-05c exactly 20 dependencies accepted (boundary)');
}

// ── F4-08/09: stale expectedUpdatedAt -> CONFLICT, no write ─────────────────
console.log('\n── F4-08/09 stale expectedUpdatedAt CAS ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId);
  const staleUpdatedAt = t.updatedAt;
  const winner = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: staleUpdatedAt, title: 'Winner Title',
  });

  // Back-to-back writes can share the same wall-clock millisecond, so nowIso()
  // may leave updatedAt unchanged and the raw captured value is NOT guaranteed
  // stale. 1 ms before the captured timestamp is always <= any current
  // updatedAt, so the CAS conflict is deterministic.
  const definitelyStale = new Date(Date.parse(staleUpdatedAt) - 1).toISOString();
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
      expectedUpdatedAt: definitelyStale, title: 'Loser Title',
    }),
    'F4-08 stale expectedUpdatedAt -> CONFLICT',
    'CONFLICT',
  );
  const after = gt.getTask(TEST_ROOT, project, t.taskId);
  check(after.title === 'Winner Title' && after.updatedAt === winner.updatedAt, 'F4-09 stale conflict causes no write (winner state undisturbed)');
}

// ── F4-10..15: editable-state policy — all non-PLANNED / ACCEPTED rejected ──
console.log('\n── F4-10..15 editable-state policy ──');
{
  const g = await makeGoal();
  const cases = [
    ['F4-10 DISPATCHED edit rejected', { executionState: 'DISPATCHED', pmState: 'PENDING' }],
    ['F4-11 RUNNING edit rejected', { executionState: 'RUNNING', pmState: 'PENDING' }],
    ['F4-12 RESULT_RECEIVED edit rejected', { executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING' }],
    ['F4-13 FAILED edit rejected', { executionState: 'FAILED', pmState: 'PENDING' }],
    ['F4-14 CANCELLED edit rejected', { executionState: 'CANCELLED', pmState: 'PENDING' }],
    ['F4-15 ACCEPTED edit rejected', { executionState: 'PLANNED', pmState: 'ACCEPTED' }],
  ];
  for (const [label, init] of cases) {
    const t = await makeTask(g.goalId, init);
    await shouldThrow(
      () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: t.updatedAt, title: 'blocked edit' }),
      label,
      'INVALID_STATE',
    );
    const after = gt.getTask(TEST_ROOT, project, t.taskId);
    check(after.title === t.title, `${label} — no mutation occurred`);
  }
}

// ── READY policy: intentionally NOT supported in V1 (documented rationale) ──
console.log('\n── READY policy: V1 restricts editing to PLANNED only ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId, { executionState: 'READY', pmState: 'PENDING' });
  check(
    taskEdit.isTaskNarrativeEditable({ executionState: 'READY', pmState: 'PENDING', linkedRunsCount: 0 }) === false,
    'READY (even with no dispatch/linkedRuns) is disabled in V1 — see task-edit.ts rationale',
  );
  await shouldThrow(
    () => taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: t.updatedAt, title: 'ready edit attempt' }),
    'READY edit rejected end-to-end',
    'INVALID_STATE',
  );
  check(
    taskEditSrc.includes('PROCESS-LOCAL') && taskEditSrc.includes('READY is NOT editable in V1'),
    'task-edit.ts documents the process-local dispatch-state rationale for excluding READY',
  );
}

// ── F4-16..22: identity / lifecycle fields never touched ────────────────────
console.log('\n── F4-16..22 identity/lifecycle fields immutable via edit ──');
{
  const g = await makeGoal();
  const g2 = await makeGoal('I3F4 Other Goal');
  const t = await makeTask(g.goalId);
  const before = gt.getTask(TEST_ROOT, project, t.taskId);

  const after = await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, {
    expectedUpdatedAt: before.updatedAt,
    title: 'identity-safe edit',
    // Adversarial extra fields — must be silently ignored (whitelist-by-construction).
    taskId: 'TASK-9999',
    goalId: g2.goalId,
    executionState: 'RUNNING',
    pmState: 'ACCEPTED',
    linkedRuns: [{ runId: 'fake', folder: '/x', taskRunSequence: 1 }],
    acceptedRunId: 'fake-run',
    retryCount: 99,
    nextTaskRunSequence: 99,
  });

  check(after.taskId === before.taskId, 'F4-16 taskId cannot be edited');
  check(after.goalId === before.goalId, 'F4-17 goalId cannot be edited');
  check(after.executionState === 'PLANNED', 'F4-18 executionState cannot be edited');
  check(after.pmState === before.pmState, 'F4-19 pmState cannot be edited');
  check(after.linkedRuns.length === before.linkedRuns.length, 'F4-20 linkedRuns unchanged');
  check(after.nextTaskRunSequence === before.nextTaskRunSequence, 'F4-21 nextTaskRunSequence unchanged');
  check(after.acceptedRunId === before.acceptedRunId, 'F4-22 acceptedRunId unchanged');
  check(after.title === 'identity-safe edit', 'whitelisted title field WAS applied (sanity check)');
}

// ── F4-23: no judgment Action Event emitted ──────────────────────────────────
console.log('\n── F4-23 no judgment Action Event emitted ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId);
  await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: t.updatedAt, title: 'no event edit' });
  const events = evk.listEvents(TEST_ROOT, project, { taskId: t.taskId }).events;
  const judgmentEvents = events.filter((e) => ['TASK_RESULT_ACCEPTED', 'TASK_CHANGES_REQUESTED', 'TASK_RETRY_REQUESTED'].includes(e.type));
  check(judgmentEvents.length === 0, 'F4-23 Task Edit emits no judgment Action Event');
  check(!taskEditSrc.includes('recordTaskResultAccepted') && !taskEditSrc.includes('recordTaskChangesRequested') && !taskEditSrc.includes('recordTaskRetryRequested'), 'task-edit.ts never records judgment Action Events');
}

// ── No legacy bypass: no updateTask / transitionTaskPm inside task-edit.ts ──
console.log('\n── No legacy bypass ──');
{
  check(!taskEditSrc.includes('updateTask('), 'task-edit.ts never calls the old permissive updateTask');
  check(!taskEditSrc.includes('transitionTaskPm('), 'task-edit.ts never calls transitionTaskPm');
  check(!taskEditSrc.includes('transitionTaskExecution('), 'task-edit.ts never calls transitionTaskExecution');
  check(taskEditSrc.includes('withTaskLinkLock'), 'task-edit.ts acquires the shared per-Task write lock');
  check(taskEditSrc.includes('normalizeDependencies'), 'task-edit.ts reuses canonical normalizeDependencies (no duplicate dependency law)');
  check(!goalTaskSrc.includes("expectedUpdatedAt"), 'old permissive updateTask left untouched (no expectedUpdatedAt added there)');
}

// ── TASK_EDIT availability derivation (pure) ─────────────────────────────────
console.log('\n── TASK_EDIT availability derivation ──');
{
  const avPlanned = actions.deriveAvailableActions({ executionState: 'PLANNED', pmState: 'PENDING', linkedRunsCount: 0 });
  check(avPlanned.TASK_EDIT.state === 'ENABLED', 'PLANNED + no linkedRuns -> TASK_EDIT ENABLED');

  const avPlannedWithRuns = actions.deriveAvailableActions({ executionState: 'PLANNED', pmState: 'PENDING', linkedRunsCount: 1 });
  check(avPlannedWithRuns.TASK_EDIT.state === 'DISABLED', 'PLANNED + execution history exists -> TASK_EDIT DISABLED (immutable once history exists)');

  const avReady = actions.deriveAvailableActions({ executionState: 'READY', pmState: 'PENDING' });
  check(avReady.TASK_EDIT.state === 'DISABLED', 'READY -> TASK_EDIT DISABLED (V1 policy)');

  for (const es of ['DISPATCHED', 'RUNNING', 'RESULT_RECEIVED', 'FAILED', 'CANCELLED']) {
    const av = actions.deriveAvailableActions({ executionState: es, pmState: 'PENDING' });
    check(av.TASK_EDIT.state === 'DISABLED', `${es} -> TASK_EDIT DISABLED`);
  }
  const avAccepted = actions.deriveAvailableActions({ executionState: 'PLANNED', pmState: 'ACCEPTED' });
  check(avAccepted.TASK_EDIT.state === 'DISABLED', 'pmState ACCEPTED -> TASK_EDIT DISABLED even at PLANNED');

  const avNull = actions.deriveAvailableActions(null);
  check(avNull.TASK_EDIT.state === 'DISABLED', 'null task -> TASK_EDIT DISABLED');
}

// ── F4-24: T opens Task Detail (regression) ──────────────────────────────────
console.log('\n── F4-24 T opens Task Detail (regression) ──');
{
  check(tuiSrc.includes("s === 't' || s === 'T'") && tuiSrc.includes("view = 'TASK_DETAIL'"), 'F4-24 T opens Task Detail');
}

// ── F4-25/26: e only works when ENABLED, disabled e does not mutate ─────────
console.log('\n── F4-25/26 e gated by TASK_EDIT availability ──');
{
  check(
    tuiSrc.includes('handleEditKeyOpen') && tuiSrc.includes("availability.TASK_EDIT.state !== 'ENABLED'"),
    'F4-25 handleEditKeyOpen checks TASK_EDIT availability before opening the menu',
  );
  check(
    tuiSrc.includes("if (s === 'e' || s === 'E') {") && tuiSrc.includes('handleEditKeyOpen();'),
    'F4-25b [e] wired inside TASK_DETAIL view branch only',
  );
  // Functional: canonical Core rejects regardless of what the TUI displays (Core stays authoritative).
  const g = await makeGoal();
  const t = await makeTask(g.goalId, { executionState: 'RUNNING', pmState: 'PENDING' });
  const bridgeResult = await actions.executeTaskEdit(
    { dataRoot: TEST_ROOT, project, taskId: t.taskId, expectedUpdatedAt: t.updatedAt },
    'title',
    'attempted edit while RUNNING',
  );
  check(bridgeResult.ok === false && bridgeResult.code === 'INVALID_STATE', 'F4-26a disabled Edit attempt rejected via bridge (INVALID_STATE)');
  const after = gt.getTask(TEST_ROOT, project, t.taskId);
  check(after.title === t.title, 'F4-26 disabled e does not mutate');
}

// ── F4-27: edit field menu works ─────────────────────────────────────────────
console.log('\n── F4-27 edit field menu ──');
{
  check(actions.TASK_EDIT_FIELDS.length === 6, 'F4-27a exactly 6 editable fields in the menu');
  const keys = actions.TASK_EDIT_FIELDS.map((f) => f.key).sort();
  check(
    JSON.stringify(keys) === JSON.stringify(['completionCriteria', 'dependencies', 'goal', 'reason', 'scope', 'title'].sort()),
    'F4-27b menu fields match the frozen whitelist exactly',
  );
  const menuKeys = actions.TASK_EDIT_FIELDS.map((f) => f.menuKey);
  check(JSON.stringify(menuKeys) === JSON.stringify(['1', '2', '3', '4', '5', '6']), 'F4-27c menu keys are [1]..[6]');
  check(
    tuiSrc.includes("view === 'TASK_EDIT_MENU'") && tuiSrc.includes('TASK_EDIT_FIELDS.find'),
    'F4-27d tui.ts renders/selects via TASK_EDIT_FIELDS (single source of truth, no duplicated menu law)',
  );
  check(tuiSrc.includes("view = 'TASK_EDIT_FIELD'"), 'F4-27e selecting a field opens the bounded field input view');
}

// ── F4-28: Esc cancels (menu and field input, no mutation) ──────────────────
console.log('\n── F4-28 Esc cancels ──');
{
  const cancelEffect = actions.reduceBoundedTextInput({ draft: 'partial', error: undefined }, { type: 'cancel' }, { min: 1, max: 5000, label: 'Title' });
  check(cancelEffect.action === 'cancel', 'F4-28a reduceBoundedTextInput cancel effect');
  check(
    tuiSrc.includes('function handleTaskEditMenuKey') && tuiSrc.includes("editTaskCtx = null"),
    'F4-28b Esc on the field menu clears editTaskCtx (no mutation call)',
  );
  check(
    tuiSrc.includes('function handleTaskEditFieldKey') && tuiSrc.includes("view = 'TASK_EDIT_MENU';\n      editFieldKey = null;"),
    'F4-28c Esc on the field input clears editFieldKey and returns to the menu (no mutation call)',
  );
}

// ── F4-29: successful edit refreshes Detail ──────────────────────────────────
console.log('\n── F4-29 successful edit refreshes Task Detail ──');
{
  check(
    tuiSrc.includes('async function submitTaskEditField') && tuiSrc.includes("view = 'TASK_DETAIL';") && tuiSrc.includes('handleActionResult(result'),
    'F4-29a submitTaskEditField lands back on TASK_DETAIL and reuses handleActionResult (refresh + banner)',
  );
  // handleActionResult itself refreshes the snapshot on every outcome (shared with I3F-3).
  check(tuiSrc.includes('function handleActionResult') && tuiSrc.includes('doSnapshotRefresh();'), 'F4-29b handleActionResult always refreshes snapshot');
  check(tuiSrc.includes('Task updated'), 'F4-29c success banner text present');
}

// ── F4-30: stale conflict shows banner ───────────────────────────────────────
console.log('\n── F4-30 stale conflict banner ──');
{
  const g = await makeGoal();
  const t = await makeTask(g.goalId);
  const stale = t.updatedAt;
  await taskEdit.editTaskNarrative(TEST_ROOT, project, t.taskId, { expectedUpdatedAt: stale, title: 'first writer' });
  // Same-millisecond writes may leave updatedAt equal to `stale`; 1 ms before
  // is deterministically stale (see F4-08 above).
  const definitelyStale = new Date(Date.parse(stale) - 1).toISOString();
  const result = await actions.executeTaskEdit(
    { dataRoot: TEST_ROOT, project, taskId: t.taskId, expectedUpdatedAt: definitelyStale },
    'title', 'second writer (stale)',
  );
  check(result.ok === false && result.code === 'CONFLICT', 'F4-30a stale conflict classified CONFLICT via bridge');
  check(tuiSrc.includes('Task changed. Review current state and try again.'), 'F4-30b CONFLICT banner text present (shared with I3F-3)');
}

// ── Regression: Memo / Judgment actions / I3F2H / Relay motion untouched ───
console.log('\n── Regression: Memo / Judgment actions / I3F2H / Relay motion ──');
{
  check(tuiSrc.includes('createMemo') && tuiSrc.includes('memoDraft'), 'Memo flow (I3F-1) untouched in shape');
  check(
    actionsSrc.includes('executeAcceptResult') && actionsSrc.includes('executeRequestChanges') && actionsSrc.includes('executeRequestRetry'),
    'I3F-3 judgment action bridge functions still present',
  );
  check(tuiSrc.includes('handleAcceptKey') && tuiSrc.includes('handleChangesKeyOpen') && tuiSrc.includes('handleRetryKey'), 'I3F-3 Accept/Changes/Retry key handlers untouched');
  check(taskDetailSrc.includes('renderTaskDetail') && taskDetailSrc.includes('resolveDetailTask'), 'Task Detail view helpers untouched');
  check(tuiSrc.includes('?1049h') && tuiSrc.includes('?1049l'), 'alt screen enter/leave preserved');
  check(tuiSrc.includes('setRawMode(false)'), 'raw mode cleanup preserved');
}

console.log(`\n=== I3F-4: ${passed} passed, ${failed} failed ===`);
if (failed) process.exitCode = 1;
