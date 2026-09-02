/**
 * Phase I3F-4 — canonical, narrow, PRE-EXECUTION Task narrative edit.
 *
 * V1 scope is deliberately limited: this is a narrative edit, never a
 * general Task mutation surface. It can only ever touch the whitelisted
 * fields below — it never touches executionState, pmState, linkedRuns,
 * acceptedRunId, retryCount, nextTaskRunSequence, or any identity field
 * (taskId/project/goalId/schemaVersion), because it simply never reads
 * those keys off the input.
 *
 * Whitelist (frozen contract #3): title / goal / reason / scope /
 * completionCriteria / dependencies.
 *
 * ── Editable-state policy (frozen contract #2, #6, #19) ─────────────────────
 * V1 restricts editing to executionState === 'PLANNED' only. The frozen
 * contract allows READY too, but ONLY if "no active dispatch / no recovery
 * or orphan state / no current Worker run in flight" can be PROVEN safely,
 * and explicitly says: "If this cannot be safely guaranteed: restrict V1
 * editing to PLANNED only and report why." It cannot be guaranteed here:
 *
 *   The only canonical read helpers for that (dispatcher.isDispatchBlocked /
 *   listActiveDispatches / getRecoveryRecord) read PROCESS-LOCAL in-memory
 *   maps in dispatcher.ts (`activeDispatches`, `recoveryRegistry`) — never
 *   persisted to task.json or any shared file. dispatchTask() is invoked
 *   only from the Electron main process (main.ts, OWNER_IPC) and the
 *   standalone PM MCP server process (pm-tools.ts, spawned via
 *   `npm run mcp:pm`). The CLI process that hosts the TUI (`agent-relay` /
 *   launchTui, src/cli/index.ts) is a THIRD, separate OS process that never
 *   calls dispatchTask itself — its own dispatcher.ts module instance
 *   therefore always starts with EMPTY activeDispatches/recoveryRegistry
 *   maps, regardless of what is really happening in the other processes.
 *   Reading those maps from the TUI process can never prove "no dispatch in
 *   flight" for a dispatch issued by another process: it would silently
 *   read back as "safe" even while a Worker is actually running. That is an
 *   unacceptable false negative for a safety gate.
 *
 *   Therefore: READY is NOT editable in V1. Only PLANNED is. (See
 *   isTaskNarrativeEditable below.) A future phase could support READY by
 *   giving the TUI a real round-trip read of the process that actually owns
 *   dispatch state, rather than an in-process read of a different process's
 *   memory.
 *
 * Also denied even at PLANNED (defense in depth — structurally near
 * unreachable today, but cheap to guard): pmState === 'ACCEPTED', and any
 * Task that already has a non-empty linkedRuns (execution history exists —
 * prefer immutable once it does, frozen contract #19).
 *
 * No PM MCP route exists for this — OWNER_IPC (TUI) only (frozen contract
 * #15). No new Action Event is recorded — task.json's own updatedAt +
 * durable persistence is the V1 audit trail (frozen contract #16).
 */
import {
  getTask,
  listTasks,
  persistTaskRecord,
  withTaskLinkLock,
  normalizeDependencies,
} from './goal-task.js';
import { RuntimeConflictError } from './goal-task-runtime.js';
import type { TaskExecutionState, TaskPmState, TaskRecord } from '../shared/types.js';

function nowIso(): string {
  return new Date().toISOString();
}

// ── Frozen V1 bounds (contract #9) ──────────────────────────────────────────
const TEXT_MIN = 1;
const TEXT_MAX = 5000;
const CRITERIA_MAX_COUNT = 20;
const CRITERIA_MAX_LEN = 500;
const DEPENDENCIES_MAX_COUNT = 20;

function requireBoundedText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field}은(는) 문자열이어야 합니다.`);
  const trimmed = value.trim();
  if (trimmed.length < TEXT_MIN) throw new Error(`${field}은(는) 최소 ${TEXT_MIN}자 이상이어야 합니다.`);
  if (trimmed.length > TEXT_MAX) throw new Error(`${field}은(는) 최대 ${TEXT_MAX}자까지 허용됩니다.`);
  return trimmed;
}

function normalizeEditCriteria(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('completionCriteria는 문자열 배열이어야 합니다.');
  if (input.length > CRITERIA_MAX_COUNT) {
    throw new Error(`completionCriteria는 최대 ${CRITERIA_MAX_COUNT}개까지 허용됩니다.`);
  }
  return input.map((x, i) => {
    if (typeof x !== 'string') throw new Error(`completionCriteria[${i}]는 문자열이어야 합니다.`);
    const t = x.trim();
    if (!t) throw new Error(`completionCriteria[${i}]는 비어 있을 수 없습니다.`);
    if (t.length > CRITERIA_MAX_LEN) throw new Error(`completionCriteria[${i}]는 최대 ${CRITERIA_MAX_LEN}자까지 허용됩니다.`);
    return t;
  });
}

/** Minimal read-only projection isTaskNarrativeEditable needs — reused by TUI availability derivation. */
export interface NarrativeEditabilityInput {
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  linkedRunsCount: number;
}

/**
 * Single source of truth for "is this Task's narrative editable right now".
 * Reused verbatim by src/tui/actions.ts (deriveAvailableActions) — never
 * re-derive a subtly different law in the TUI.
 */
export function isTaskNarrativeEditable(task: NarrativeEditabilityInput): boolean {
  if (task.executionState !== 'PLANNED') return false; // see file header — READY excluded in V1
  if (task.pmState === 'ACCEPTED') return false;
  if (task.linkedRunsCount > 0) return false;
  return true;
}

/** Human-readable reason mirroring isTaskNarrativeEditable, for TUI display. */
export function taskNarrativeEditDisabledReason(task: NarrativeEditabilityInput): string | undefined {
  if (task.executionState !== 'PLANNED') {
    return 'Task Edit is only available while PLANNED (V1).';
  }
  if (task.pmState === 'ACCEPTED') {
    return 'Task Edit unavailable once judgment is ACCEPTED.';
  }
  if (task.linkedRunsCount > 0) {
    return 'Task Edit unavailable once execution history exists.';
  }
  return undefined;
}

export interface EditTaskNarrativeInput {
  /** CAS token — captured task.updatedAt at edit-open time. Mismatch = CONFLICT, no partial write, no retry. */
  expectedUpdatedAt: string;
  title?: string;
  goal?: string;
  reason?: string;
  scope?: string;
  completionCriteria?: unknown;
  dependencies?: unknown;
}

/**
 * Canonical, narrow pre-execution narrative edit.
 *
 *   acquire existing Task lock (withTaskLinkLock — same lock every other
 *   canonical Task writer uses) → reload Task → check expectedUpdatedAt →
 *   verify allowed execution/pm state (isTaskNarrativeEditable) → apply
 *   whitelist only → validate dependencies (reuses normalizeDependencies,
 *   including its cycle check) → update updatedAt → persist atomically
 *   (persistTaskRecord).
 *
 * Whitelist-by-construction: only reads input.title/goal/reason/scope/
 * completionCriteria/dependencies — any other property on `input` (taskId,
 * goalId, executionState, pmState, linkedRuns, acceptedRunId, retryCount,
 * nextTaskRunSequence, …) is simply never looked at.
 */
export function editTaskNarrative(
  dataRoot: string,
  project: string,
  taskId: string,
  input: EditTaskNarrativeInput,
): Promise<TaskRecord> {
  if (!input || typeof input !== 'object') {
    throw new Error('editTaskNarrative에는 expectedUpdatedAt이 필요합니다.');
  }
  const expectedUpdatedAt = input.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
    throw new Error('expectedUpdatedAt이 필요합니다.');
  }

  const hasTitle = input.title !== undefined;
  const hasGoal = input.goal !== undefined;
  const hasReason = input.reason !== undefined;
  const hasScope = input.scope !== undefined;
  const hasCriteria = input.completionCriteria !== undefined;
  const hasDeps = input.dependencies !== undefined;

  // Pre-validate whitelist fields that don't need Task/graph state — fail fast, before the lock.
  const title = hasTitle ? requireBoundedText(input.title, 'title') : undefined;
  const goal = hasGoal ? requireBoundedText(input.goal, 'goal') : undefined;
  const reason = hasReason ? requireBoundedText(input.reason, 'reason') : undefined;
  const scope = hasScope ? requireBoundedText(input.scope, 'scope') : undefined;
  const completionCriteria = hasCriteria ? normalizeEditCriteria(input.completionCriteria) : undefined;

  const id = taskId;
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.updatedAt !== expectedUpdatedAt) {
      throw new RuntimeConflictError(
        `CONFLICT: expectedUpdatedAt=${expectedUpdatedAt} but found ${task.updatedAt}`,
      );
    }
    if (!isTaskNarrativeEditable({
      executionState: task.executionState,
      pmState: task.pmState,
      linkedRunsCount: task.linkedRuns.length,
    })) {
      const reasonMsg = taskNarrativeEditDisabledReason({
        executionState: task.executionState,
        pmState: task.pmState,
        linkedRunsCount: task.linkedRuns.length,
      }) ?? 'Task Edit is not available for this Task.';
      throw new Error(`INVALID_STATE: ${reasonMsg}`);
    }

    // Dependencies need the current task graph — computed inside the lock,
    // fully validated (including cycle check) BEFORE any field is applied,
    // so a rejected edit never partially mutates the in-memory record.
    let dependencies: string[] | undefined;
    if (hasDeps) {
      const allTasks = listTasks(dataRoot, project);
      const ids = new Set(allTasks.map((t) => t.taskId));
      const taskGoalById = new Map(allTasks.map((t) => [t.taskId, t.goalId] as const));
      const adjacency = new Map(allTasks.map((t) => [t.taskId, t.dependencies] as const));
      dependencies = normalizeDependencies(input.dependencies, task.taskId, ids, {
        goalId: task.goalId,
        taskGoalById,
        adjacency,
      });
      if (dependencies.length > DEPENDENCIES_MAX_COUNT) {
        throw new Error(`dependencies는 최대 ${DEPENDENCIES_MAX_COUNT}개까지 허용됩니다.`);
      }
    }

    if (hasTitle) task.title = title!;
    if (hasGoal) task.goal = goal!;
    if (hasReason) task.reason = reason!;
    if (hasScope) task.scope = scope!;
    if (hasCriteria) task.completionCriteria = completionCriteria!;
    if (hasDeps) task.dependencies = dependencies!;

    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}
