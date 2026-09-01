/**
 * Phase H — Owner-authorized orphan resolution path.
 *
 * KEEP_WAITING: explicit decision to leave state unchanged (does NOT clear block).
 * CONFIRM_FAILED / CONFIRM_CANCELLED: OWNER_IPC only; clear recovery only AFTER CAS.
 */
import {
  getTask,
} from './goal-task.js';
import {
  transitionTaskExecution,
  RuntimeConflictError,
} from './goal-task-runtime.js';
import {
  getRecoveryRecord,
  clearRecoveryRecordTrusted,
  isDispatchBlocked,
} from './dispatcher.js';
import {
  authorizeEffect,
  type CallerSurface,
} from './permission-gate.js';
import { getGoal } from './goal-task.js';
import { recordRuntimeWarning, recordOwnerDecisionRequired } from './event.js';
import type { PermissionPolicy, TaskExecutionState } from '../shared/types.js';

export type OrphanAction = 'KEEP_WAITING' | 'CONFIRM_FAILED' | 'CONFIRM_CANCELLED';

export class OrphanResolutionError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT' | 'FORBIDDEN';
  constructor(code: OrphanResolutionError['code'], message: string) {
    super(message);
    this.name = 'OrphanResolutionError';
    this.code = code;
  }
}

export interface ResolveOrphanInput {
  dataRoot: string;
  project: string;
  taskId: string;
  action: OrphanAction;
  callerSurface: CallerSurface;
  expectedExecutionState?: TaskExecutionState;
  reason?: string;
}

export interface ResolveOrphanResult {
  taskId: string;
  action: OrphanAction;
  executionState: TaskExecutionState;
  recoveryCleared: boolean;
  dispatchBlocked: boolean;
  message: string;
}

export async function resolveOrphan(input: ResolveOrphanInput): Promise<ResolveOrphanResult> {
  const dataRoot = requireNonEmpty(input.dataRoot, 'dataRoot');
  const project = requireNonEmpty(input.project, 'project');
  const taskId = requireNonEmpty(input.taskId, 'taskId');
  const action = input.action;

  if (
    action !== 'KEEP_WAITING'
    && action !== 'CONFIRM_FAILED'
    && action !== 'CONFIRM_CANCELLED'
  ) {
    throw new OrphanResolutionError('INVALID_ARGUMENT', `Unknown orphan action: ${String(action)}`);
  }

  let task;
  try {
    task = getTask(dataRoot, project, taskId);
  } catch {
    throw new OrphanResolutionError('NOT_FOUND', `Task '${taskId}' 찾을 수 없습니다.`);
  }

  let policy: PermissionPolicy = { mode: 'PLAN' };
  try {
    policy = getGoal(dataRoot, project, task.goalId).permissionPolicy ?? { mode: 'PLAN' };
  } catch {
    policy = { mode: 'PLAN' };
  }

  const effect =
    action === 'KEEP_WAITING'
      ? 'ORPHAN_KEEP_WAITING'
      : action === 'CONFIRM_FAILED'
        ? 'ORPHAN_CONFIRM_FAILED'
        : 'ORPHAN_CONFIRM_CANCELLED';

  try {
    authorizeEffect({
      effect,
      callerSurface: input.callerSurface,
      permissionPolicy: policy,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OrphanResolutionError('FORBIDDEN', msg);
  }

  const recovery = getRecoveryRecord(dataRoot, project, taskId);

  if (action === 'KEEP_WAITING') {
    // Must NOT clear recovery block.
    return {
      taskId,
      action,
      executionState: task.executionState,
      recoveryCleared: false,
      dispatchBlocked: isDispatchBlocked(dataRoot, project, taskId),
      message: recovery
        ? `KEEP_WAITING acknowledged; recovery status=${recovery.status} remains`
        : 'KEEP_WAITING acknowledged; no recovery record present',
    };
  }

  // CONFIRM_* require recovery record + expectedExecutionState DISPATCHED|RUNNING
  if (!recovery) {
    throw new OrphanResolutionError(
      'INVALID_STATE',
      `No recovery record for Task ${taskId}; cannot ${action}`,
    );
  }

  const expected = input.expectedExecutionState;
  if (expected !== 'DISPATCHED' && expected !== 'RUNNING') {
    throw new OrphanResolutionError(
      'INVALID_ARGUMENT',
      `expectedExecutionState must be DISPATCHED or RUNNING for ${action}`,
    );
  }

  if (task.executionState !== expected) {
    throw new OrphanResolutionError(
      'CONFLICT',
      `CONFLICT: expectedExecutionState=${expected} but found ${task.executionState}`,
    );
  }

  const toState: TaskExecutionState = action === 'CONFIRM_FAILED' ? 'FAILED' : 'CANCELLED';

  let updated;
  try {
    updated = await transitionTaskExecution(dataRoot, project, taskId, {
      expectedExecutionState: expected,
      to: toState,
      reason: input.reason?.trim() || `orphan:${action}`,
    });
  } catch (err) {
    if (err instanceof RuntimeConflictError) {
      throw new OrphanResolutionError('CONFLICT', err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new OrphanResolutionError('INVALID_STATE', msg);
  }

  // Clear recovery ONLY AFTER successful canonical transition.
  const cleared = clearRecoveryRecordTrusted(dataRoot, project, taskId);

  try {
    if (action === 'CONFIRM_FAILED') {
      await recordRuntimeWarning(dataRoot, project, {
        summary: `Owner confirmed orphan Task ${taskId} as FAILED`,
        taskId,
        goalId: task.goalId,
        source: { kind: 'owner', subsystem: 'orphan-resolution' },
        details: { action, previousState: expected, recoveryCleared: cleared },
      });
    } else {
      await recordOwnerDecisionRequired(dataRoot, project, {
        summary: `Owner confirmed orphan Task ${taskId} as CANCELLED`,
        taskId,
        goalId: task.goalId,
        source: { kind: 'owner', subsystem: 'orphan-resolution' },
        details: { action, previousState: expected, recoveryCleared: cleared },
      });
    }
  } catch {
    // Event failure must not undo CAS / recovery clear.
  }

  return {
    taskId,
    action,
    executionState: updated.executionState,
    recoveryCleared: cleared,
    dispatchBlocked: isDispatchBlocked(dataRoot, project, taskId),
    message: `${action} applied; recoveryCleared=${cleared}`,
  };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OrphanResolutionError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}
