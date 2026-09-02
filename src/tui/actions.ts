/**
 * Phase I3F-3 — narrow TUI Owner action bridge.
 *
 * TUI is an OWNER surface (callerSurface: 'OWNER_IPC' only, never PM_MCP).
 * No lifecycle/mutation logic is duplicated here — every judgment mutation
 * delegates straight to the frozen I3F-2/I3F-2H canonical contract in
 * src/backend/task-actions.ts (authorizeEffect → goal-task-runtime CAS
 * mutation → best-effort Action Event). This module only:
 *
 *   1. derives ENABLED/DISABLED/HIDDEN action availability for display
 *      (pure — no fs, no Event, no persisted UI state), and
 *   2. bridges a captured CAS context to the canonical task-actions.ts
 *      entry points, classifying the result into a small typed shape the
 *      TUI can render as a transient banner.
 *
 * Availability here is a DISPLAY hint only — task-actions.ts / goal-task-
 * runtime.ts remain authoritative. A stale/raced context still reaches the
 * canonical CAS check and comes back CONFLICT; this bridge never retries.
 */
import {
  acceptTaskResult,
  requestTaskChanges,
  requestTaskRetry,
} from '../backend/task-actions.js';
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
}

/**
 * Minimal read-only Task projection availability derivation needs.
 * `currentRunId` must be resolved by the caller using the existing
 * current-attempt law (goal-task-runtime.resolveCurrentAttemptRunId, or the
 * equivalent "latest linkedRun by taskRunSequence" already computed by the
 * lightweight status/TUI snapshot) — never re-derived differently here.
 */
export interface AvailabilityInput {
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  acceptedRunId?: string;
  currentRunId?: string;
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

  return {
    ACCEPT: accept,
    REQUEST_CHANGES: changes,
    RETRY: retry,
    TASK_DETAIL: ENABLED,
    MEMO_ADD: ENABLED,
    EVENTS_VIEW: ENABLED,
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

// ── Bounded Reason input (Request Changes) ──────────────────────────────────
// Pure reducer for the "Reason >" input widget — no lifecycle logic, purely
// bounded text editing (min 10 / max 2000, Enter submit, Esc cancel,
// Backspace edit). Kept separate from the Owner action bridge above so
// keystroke handling stays independently testable from the Core mutation.

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

export function reduceReasonInput(state: ReasonInputState, key: ReasonInputKey): ReasonInputEffect {
  if (key.type === 'cancel') {
    return { action: 'cancel' };
  }
  if (key.type === 'backspace') {
    return { action: 'update', state: { draft: state.draft.slice(0, -1), error: undefined } };
  }
  if (key.type === 'char') {
    if (state.draft.length >= REASON_MAX) {
      return { action: 'update', state: { draft: state.draft, error: `Reason max ${REASON_MAX} chars.` } };
    }
    return { action: 'update', state: { draft: state.draft + key.value, error: undefined } };
  }
  // submit
  const trimmed = state.draft.trim();
  if (trimmed.length < REASON_MIN) {
    return {
      action: 'update',
      state: { draft: state.draft, error: `Reason must be at least ${REASON_MIN} characters.` },
    };
  }
  if (trimmed.length > REASON_MAX) {
    return {
      action: 'update',
      state: { draft: state.draft, error: `Reason must be at most ${REASON_MAX} characters.` },
    };
  }
  return { action: 'submit', reason: trimmed };
}
