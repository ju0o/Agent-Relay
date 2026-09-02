/**
 * Phase I3F-3/I3F-4 — narrow TUI Owner action bridge.
 *
 * TUI is an OWNER surface (callerSurface: 'OWNER_IPC' only, never PM_MCP).
 * No lifecycle/mutation logic is duplicated here — every judgment mutation
 * delegates straight to the frozen I3F-2/I3F-2H canonical contract in
 * src/backend/task-actions.ts (authorizeEffect → goal-task-runtime CAS
 * mutation → best-effort Action Event), and the I3F-4 narrative Task Edit
 * delegates straight to src/backend/task-edit.ts (editTaskNarrative). This
 * module only:
 *
 *   1. derives ENABLED/DISABLED/HIDDEN action availability for display
 *      (pure — no fs, no Event, no persisted UI state), and
 *   2. bridges a captured CAS context to the canonical task-actions.ts /
 *      task-edit.ts entry points, classifying the result into a small typed
 *      shape the TUI can render as a transient banner.
 *
 * Availability here is a DISPLAY hint only — task-actions.ts / task-edit.ts /
 * goal-task-runtime.ts remain authoritative. A stale/raced context still
 * reaches the canonical CAS check and comes back CONFLICT; this bridge
 * never retries.
 */
import {
  acceptTaskResult,
  requestTaskChanges,
  requestTaskRetry,
} from '../backend/task-actions.js';
import {
  editTaskNarrative,
  isTaskNarrativeEditable,
  taskNarrativeEditDisabledReason,
  type EditTaskNarrativeInput,
} from '../backend/task-edit.js';
import { RuntimeConflictError } from '../backend/goal-task-runtime.js';
import { PermissionDeniedError } from '../backend/permission-gate.js';
import type { TaskExecutionState, TaskPmState, TaskRecord } from '../shared/types.js';

// ── Availability derivation ─────────────────────────────────────────────────

export type ActionAvailability =
  | { state: 'ENABLED' }
  | { state: 'DISABLED'; reason: string }
  | { state: 'HIDDEN' };

export interface AvailableActions {
  ACCEPT: ActionAvailability;
  REQUEST_CHANGES: ActionAvailability;
  RETRY: ActionAvailability;
  TASK_DETAIL: ActionAvailability;
  MEMO_ADD: ActionAvailability;
  EVENTS_VIEW: ActionAvailability;
  /** I3F-4 — pre-execution narrative edit. Law lives in backend/task-edit.ts (isTaskNarrativeEditable); never re-derived here. */
  TASK_EDIT: ActionAvailability;
}

/**
 * Minimal read-only Task projection availability derivation needs.
 * `currentRunId` must be resolved by the caller using the existing
 * current-attempt law (goal-task-runtime.resolveCurrentAttemptRunId, or the
 * equivalent "latest linkedRun by taskRunSequence" already computed by the
 * lightweight status/TUI snapshot) — never re-derived differently here.
 * `linkedRunsCount` (I3F-4, TASK_EDIT only) similarly must be
 * task.linkedRuns.length — never a re-derived count.
 */
export interface AvailabilityInput {
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  acceptedRunId?: string;
  currentRunId?: string;
  linkedRunsCount?: number;
}

const ENABLED: ActionAvailability = { state: 'ENABLED' };
function disabled(reason: string): ActionAvailability {
  return { state: 'DISABLED', reason };
}

/**
 * Pure. No fs mutation, no Event mutation, no persisted UI state.
 * `task === null` models "no active Task resolvable right now".
 */
export function deriveAvailableActions(task: AvailabilityInput | null | undefined): AvailableActions {
  if (!task) {
    return {
      ACCEPT: disabled('No active Task.'),
      REQUEST_CHANGES: disabled('No active Task.'),
      RETRY: disabled('No active Task.'),
      // Navigation views handle the empty-task case in their own render
      // (unchanged from I3F-1) — never gated here.
      TASK_DETAIL: ENABLED,
      MEMO_ADD: disabled('No active Task.'),
      EVENTS_VIEW: ENABLED,
      TASK_EDIT: disabled('No active Task.'),
    };
  }

  let accept: ActionAvailability;
  if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'VERIFYING') {
    accept = disabled('Accept requires RESULT_RECEIVED + VERIFYING.');
  } else if (!task.currentRunId) {
    accept = disabled('No current Run to accept.');
  } else {
    accept = ENABLED;
  }

  let changes: ActionAvailability;
  if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'VERIFYING') {
    changes = disabled('Changes requires RESULT_RECEIVED + VERIFYING.');
  } else if (!task.currentRunId) {
    changes = disabled('No current Run to request changes on.');
  } else {
    changes = ENABLED;
  }

  let retry: ActionAvailability;
  if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'CHANGES_REQUESTED') {
    retry = disabled('Retry requires RESULT_RECEIVED + CHANGES_REQUESTED.');
  } else if (task.acceptedRunId) {
    retry = disabled('Retry unavailable once acceptedRunId is set.');
  } else {
    retry = ENABLED;
  }

  const editability = {
    executionState: task.executionState,
    pmState: task.pmState,
    linkedRunsCount: task.linkedRunsCount ?? 0,
  };
  const taskEdit = isTaskNarrativeEditable(editability)
    ? ENABLED
    : disabled(taskNarrativeEditDisabledReason(editability) ?? 'Task Edit unavailable.');

  return {
    ACCEPT: accept,
    REQUEST_CHANGES: changes,
    RETRY: retry,
    TASK_DETAIL: ENABLED,
    MEMO_ADD: ENABLED,
    EVENTS_VIEW: ENABLED,
    TASK_EDIT: taskEdit,
  };
}

// ── Owner action bridge ──────────────────────────────────────────────────────

export type OwnerActionCode = 'CONFLICT' | 'FORBIDDEN' | 'INVALID_STATE' | 'INVALID_INPUT';

export type OwnerActionResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; code: OwnerActionCode; message: string };

/** CAS context captured at action-open time (spec #21) — never re-read at submit. */
export interface OwnerActionContext {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  /** Required for ACCEPT / REQUEST_CHANGES; unused by RETRY. */
  runId?: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
}

function classifyError(err: unknown): { code: OwnerActionCode; message: string } {
  if (err instanceof PermissionDeniedError) {
    return { code: 'FORBIDDEN', message: err.message };
  }
  if (err instanceof RuntimeConflictError) {
    return { code: 'CONFLICT', message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('INVALID_STATE')) {
    return { code: 'INVALID_STATE', message };
  }
  return { code: 'INVALID_INPUT', message };
}

/** Canonical Accept — OWNER_IPC only. No transitionTaskPm bypass. */
export async function executeAcceptResult(ctx: OwnerActionContext): Promise<OwnerActionResult> {
  if (!ctx.runId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'No current Run to accept.' };
  }
  try {
    const task = await acceptTaskResult({
      dataRoot: ctx.dataRoot,
      project: ctx.project,
      goalId: ctx.goalId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      expectedExecutionState: ctx.expectedExecutionState,
      expectedPmState: ctx.expectedPmState,
      callerSurface: 'OWNER_IPC',
    });
    return { ok: true, task };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

const REASON_MIN = 10;
const REASON_MAX = 2000;

/** Canonical Request Changes — OWNER_IPC only. No transitionTaskPm bypass. */
export async function executeRequestChanges(
  ctx: OwnerActionContext,
  reason: string,
): Promise<OwnerActionResult> {
  if (!ctx.runId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'No current Run to request changes on.' };
  }
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < REASON_MIN) {
    return { ok: false, code: 'INVALID_INPUT', message: `Reason must be at least ${REASON_MIN} characters.` };
  }
  if (trimmed.length > REASON_MAX) {
    return { ok: false, code: 'INVALID_INPUT', message: `Reason must be at most ${REASON_MAX} characters.` };
  }
  try {
    const task = await requestTaskChanges({
      dataRoot: ctx.dataRoot,
      project: ctx.project,
      goalId: ctx.goalId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      reason: trimmed,
      expectedExecutionState: ctx.expectedExecutionState,
      expectedPmState: ctx.expectedPmState,
      callerSurface: 'OWNER_IPC',
    });
    return { ok: true, task };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

/** Canonical Retry — OWNER_IPC only. No Run creation, no dispatch, no Changes. */
export async function executeRequestRetry(
  ctx: OwnerActionContext,
  reason?: string,
): Promise<OwnerActionResult> {
  try {
    const task = await requestTaskRetry({
      dataRoot: ctx.dataRoot,
      project: ctx.project,
      goalId: ctx.goalId,
      taskId: ctx.taskId,
      expectedExecutionState: ctx.expectedExecutionState,
      expectedPmState: ctx.expectedPmState,
      reason,
      callerSurface: 'OWNER_IPC',
    });
    return { ok: true, task };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

export type OwnerActionKind = 'ACCEPT' | 'REQUEST_CHANGES' | 'RETRY';

/** Single narrow entry point — TUI → this bridge → canonical task-actions.ts. */
export async function executeOwnerAction(
  kind: OwnerActionKind,
  ctx: OwnerActionContext,
  input?: { reason?: string },
): Promise<OwnerActionResult> {
  if (kind === 'ACCEPT') return executeAcceptResult(ctx);
  if (kind === 'REQUEST_CHANGES') return executeRequestChanges(ctx, input?.reason ?? '');
  return executeRequestRetry(ctx, input?.reason);
}

// ── I3F-4: Task Edit bridge (canonical task-edit.ts only) ──────────────────

/** CAS context captured at Edit-open time (spec #4/#21) — never re-read at submit. */
export interface TaskEditContext {
  dataRoot: string;
  project: string;
  taskId: string;
  expectedUpdatedAt: string;
}

export type EditFieldKey = 'title' | 'goal' | 'reason' | 'scope' | 'completionCriteria' | 'dependencies';

/** Menu order/labels for the [e] Edit field-selection menu — single source of truth (spec #8). */
export const TASK_EDIT_FIELDS: ReadonlyArray<{ key: EditFieldKey; label: string; menuKey: string }> = [
  { key: 'title', label: 'Title', menuKey: '1' },
  { key: 'goal', label: 'Goal', menuKey: '2' },
  { key: 'reason', label: 'Reason', menuKey: '3' },
  { key: 'scope', label: 'Scope', menuKey: '4' },
  { key: 'completionCriteria', label: 'Completion Criteria', menuKey: '5' },
  { key: 'dependencies', label: 'Dependencies', menuKey: '6' },
];

const LIST_FIELDS: ReadonlySet<EditFieldKey> = new Set(['completionCriteria', 'dependencies']);

/** Raw-textbox bounds per field (client-side convenience only — task-edit.ts remains authoritative). */
export function boundsForEditField(field: EditFieldKey): { min: number; max: number } {
  // completionCriteria/dependencies are delimited lists — empty clears the list, and the
  // per-item (20 entries / 500 chars / 20 deps) bounds are enforced canonically, not here.
  return LIST_FIELDS.has(field) ? { min: 0, max: 8000 } : { min: 1, max: 5000 };
}

/** "a, b; c\nd" -> ['a','b','c','d']. Pure split/trim only — dedupe/count/format validated canonically. */
export function parseDelimitedList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build the { [field]: value } patch task-edit.ts expects from one submitted field's raw text. */
export function buildEditPatch(field: EditFieldKey, rawValue: string): Partial<Record<EditFieldKey, string | string[]>> {
  if (LIST_FIELDS.has(field)) {
    return { [field]: parseDelimitedList(rawValue) };
  }
  return { [field]: rawValue };
}

/** Canonical Task Edit — OWNER_IPC only. No transitionTaskPm / updateTask bypass, no lifecycle mutation. */
export async function executeTaskEdit(
  ctx: TaskEditContext,
  field: EditFieldKey,
  rawValue: string,
): Promise<OwnerActionResult> {
  try {
    // buildEditPatch sets exactly one whitelisted field per call; the union return
    // type is looser than EditTaskNarrativeInput's per-field types purely because
    // TS can't see "exactly one key" statically — safe by construction at runtime.
    const patch = buildEditPatch(field, rawValue) as Partial<EditTaskNarrativeInput>;
    const task = await editTaskNarrative(ctx.dataRoot, ctx.project, ctx.taskId, {
      expectedUpdatedAt: ctx.expectedUpdatedAt,
      ...patch,
    });
    return { ok: true, task };
  } catch (err) {
    return { ok: false, ...classifyError(err) };
  }
}

// ── Bounded text input (Request Changes reason / Task Edit fields) ─────────
// Pure reducer for a single-line-or-more bounded input widget — no lifecycle
// logic, purely bounded text editing (Enter submit, Esc cancel, Backspace
// edit). Kept separate from the Owner action bridges above so keystroke
// handling stays independently testable from the Core mutation.

export interface BoundedTextState {
  draft: string;
  error?: string;
}

export type BoundedTextKey =
  | { type: 'char'; value: string }
  | { type: 'backspace' }
  | { type: 'submit' }
  | { type: 'cancel' };

export type BoundedTextEffect =
  | { action: 'update'; state: BoundedTextState }
  | { action: 'cancel' }
  | { action: 'submit'; value: string };

export interface BoundedTextBounds {
  min: number;
  max: number;
  /** Used in bound-violation messages, e.g. "Reason" -> "Reason must be at least 10 characters." */
  label: string;
}

export function reduceBoundedTextInput(
  state: BoundedTextState,
  key: BoundedTextKey,
  bounds: BoundedTextBounds,
): BoundedTextEffect {
  if (key.type === 'cancel') {
    return { action: 'cancel' };
  }
  if (key.type === 'backspace') {
    return { action: 'update', state: { draft: state.draft.slice(0, -1), error: undefined } };
  }
  if (key.type === 'char') {
    if (state.draft.length >= bounds.max) {
      return { action: 'update', state: { draft: state.draft, error: `${bounds.label} max ${bounds.max} chars.` } };
    }
    return { action: 'update', state: { draft: state.draft + key.value, error: undefined } };
  }
  // submit
  const trimmed = state.draft.trim();
  if (trimmed.length < bounds.min) {
    return {
      action: 'update',
      state: { draft: state.draft, error: `${bounds.label} must be at least ${bounds.min} characters.` },
    };
  }
  if (trimmed.length > bounds.max) {
    return {
      action: 'update',
      state: { draft: state.draft, error: `${bounds.label} must be at most ${bounds.max} characters.` },
    };
  }
  return { action: 'submit', value: trimmed };
}

// ── Bounded Reason input (Request Changes) — thin named wrapper (I3F-3 API) ─

export interface ReasonInputState {
  draft: string;
  error?: string;
}

export type ReasonInputKey =
  | { type: 'char'; value: string }
  | { type: 'backspace' }
  | { type: 'submit' }
  | { type: 'cancel' };

export type ReasonInputEffect =
  | { action: 'update'; state: ReasonInputState }
  | { action: 'cancel' }
  | { action: 'submit'; reason: string };

const REASON_BOUNDS: BoundedTextBounds = { min: REASON_MIN, max: REASON_MAX, label: 'Reason' };

export function reduceReasonInput(state: ReasonInputState, key: ReasonInputKey): ReasonInputEffect {
  const effect = reduceBoundedTextInput(state, key, REASON_BOUNDS);
  if (effect.action === 'submit') return { action: 'submit', reason: effect.value };
  return effect;
}
