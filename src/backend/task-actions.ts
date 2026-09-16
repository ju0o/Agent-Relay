/**
 * Phase I3F-2 — canonical Task Action mutation path.
 *
 * Single authoritative entry point for ACCEPT_RESULT / REQUEST_CHANGES /
 * REQUEST_RETRY, shared by both OWNER_IPC (main.ts) and PM_MCP (pm-tools.ts).
 * No wrapper-specific bypass: every caller goes through authorizeEffect(...)
 * here before the canonical CAS mutation in goal-task-runtime.ts.
 *
 * Event persist order (frozen contract #20): the canonical Task mutation
 * must succeed FIRST; the matching immutable Action Event is then recorded
 * best-effort. If Event persistence fails after a successful Task mutation,
 * the mutation is NOT rolled back (no unsafe ad-hoc file undo) — the Task
 * state remains the source of truth and the audit Event is simply missing
 * for that one mutation (same best-effort pattern already used for
 * GOAL_COMPLETED in main.ts / pm-tools.ts).
 *
 * Action Events are audit FACTS only — they are never Evidence, never a
 * Worker claim, and never a trustLevel upgrade (see event.ts).
 */
import { getGoal, getTask } from './goal-task.js';
import {
  acceptResult as acceptResultRuntime,
  requestChanges as requestChangesRuntime,
  requestRetry as requestRetryRuntime,
  requestFailedRunRetry as requestFailedRunRetryRuntime,
} from './goal-task-runtime.js';
import { authorizeEffect, type CallerSurface } from './permission-gate.js';
import {
  recordTaskChangesRequested,
  recordTaskResultAccepted,
  recordTaskRetryRequested,
} from './event.js';
import { continueExecutionPlanAfterTaskAccepted } from './execution-plan-continuation.js';
import { closeActlManagedReservationForTask } from './actl-bridge.js';
import type {
  PermissionPolicy,
  TaskExecutionState,
  TaskPmState,
  TaskRecord,
} from '../shared/types.js';

function loadPolicy(dataRoot: string, project: string, goalId: string): PermissionPolicy {
  try {
    return getGoal(dataRoot, project, goalId).permissionPolicy ?? { mode: 'PLAN' };
  } catch {
    return { mode: 'PLAN' };
  }
}

/** Owner/PM canonical Event source.kind — bounded, matches existing convention. */
function sourceKindFor(callerSurface: CallerSurface): string {
  return callerSurface === 'PM_MCP' ? 'pm-mcp' : 'owner-ipc';
}

function beforeSnapshot(task: TaskRecord): Record<string, unknown> {
  return {
    executionState: task.executionState,
    pmState: task.pmState,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
  };
}

function afterSnapshot(task: TaskRecord): Record<string, unknown> {
  return {
    executionState: task.executionState,
    pmState: task.pmState,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
  };
}

function latestLinkedRunId(task: TaskRecord): string | undefined {
  if (!task.linkedRuns.length) return undefined;
  return [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0]?.runId;
}

export interface AcceptTaskResultInput {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  runId: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  reason?: string;
  callerSurface: CallerSurface;
}

/** Canonical Accept Result — permission gate → CAS mutation → best-effort Action Event. */
export async function acceptTaskResult(input: AcceptTaskResultInput): Promise<TaskRecord> {
  const {
    dataRoot, project, goalId, taskId, runId,
    expectedExecutionState, expectedPmState, reason, callerSurface,
  } = input;

  const before = getTask(dataRoot, project, taskId);
  const policy = loadPolicy(dataRoot, project, before.goalId);
  authorizeEffect({ effect: 'ACCEPT_RESULT', callerSurface, permissionPolicy: policy });

  const beforeSnap = beforeSnapshot(before);
  const after = await acceptResultRuntime(dataRoot, project, taskId, runId, {
    goalId, expectedExecutionState, expectedPmState, reason,
  });

  await closeActlManagedReservationForTask({ dataRoot, project, task: after, runId });

  try {
    await recordTaskResultAccepted(dataRoot, project, {
      summary: `Task ${taskId} result accepted (run ${runId})`,
      goalId: after.goalId,
      taskId,
      runId,
      source: { kind: sourceKindFor(callerSurface), subsystem: 'task-actions/accept-result' },
      correlationId: taskId,
      causationId: runId,
      details: {
        before: beforeSnap,
        after: afterSnapshot(after),
        ...(reason ? { reason } : {}),
      },
      sourceEventId: `task-result-accepted:${project}:${taskId}:${after.updatedAt}`,
    });
  } catch {
    // Best-effort: the Task mutation already succeeded and is durable.
    // See file header — Event persistence failure never rolls back state.
  }

  // Slice 3: only after canonical ACCEPT is durable may a matching Plan move.
  // A Plan failure never rolls back the accepted Task or turns V1 acceptance
  // into a second judgment path; the continuation itself fails closed.
  await continueExecutionPlanAfterTaskAccepted(dataRoot, project, after);

  return after;
}

export interface RequestTaskChangesInput {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  runId: string;
  reason: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  callerSurface: CallerSurface;
}

/** Canonical Request Changes — permission gate → dual-CAS mutation → best-effort Action Event. */
export async function requestTaskChanges(input: RequestTaskChangesInput): Promise<TaskRecord> {
  const {
    dataRoot, project, goalId, taskId, runId,
    reason, expectedExecutionState, expectedPmState, callerSurface,
  } = input;

  const before = getTask(dataRoot, project, taskId);
  const policy = loadPolicy(dataRoot, project, before.goalId);
  authorizeEffect({ effect: 'REQUEST_CHANGES', callerSurface, permissionPolicy: policy });

  const beforeSnap = beforeSnapshot(before);
  const after = await requestChangesRuntime(dataRoot, project, taskId, runId, {
    goalId, reason, expectedExecutionState, expectedPmState,
  });

  await closeActlManagedReservationForTask({
    dataRoot, project, task: after, runId, disposition: 'FAILED',
  });

  try {
    await recordTaskChangesRequested(dataRoot, project, {
      summary: `Task ${taskId} changes requested (run ${runId})`,
      goalId: after.goalId,
      taskId,
      runId,
      source: { kind: sourceKindFor(callerSurface), subsystem: 'task-actions/request-changes' },
      correlationId: taskId,
      causationId: runId,
      details: {
        before: beforeSnap,
        after: afterSnapshot(after),
        reason,
      },
      sourceEventId: `task-changes-requested:${project}:${taskId}:${after.updatedAt}`,
    });
  } catch {
    // Best-effort — see file header.
  }

  return after;
}

export interface RequestTaskRetryInput {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  reason?: string;
  callerSurface: CallerSurface;
}

/** Canonical Retry — permission gate → dual-CAS mutation → best-effort Action Event. */
export async function requestTaskRetry(input: RequestTaskRetryInput): Promise<TaskRecord> {
  const {
    dataRoot, project, goalId, taskId,
    expectedExecutionState, expectedPmState, reason, callerSurface,
  } = input;

  const before = getTask(dataRoot, project, taskId);
  const policy = loadPolicy(dataRoot, project, before.goalId);
  authorizeEffect({ effect: 'REQUEST_RETRY', callerSurface, permissionPolicy: policy });

  const beforeSnap = beforeSnapshot(before);
  // Bind the Event to the reviewed run where it can be safely resolved (pre-mutation
  // current attempt) — Retry itself does not require/consume a runId.
  const currentRunId = latestLinkedRunId(before);

  const after = await requestRetryRuntime(dataRoot, project, taskId, {
    goalId, expectedExecutionState, expectedPmState, reason,
  });

  try {
    await recordTaskRetryRequested(dataRoot, project, {
      summary: `Task ${taskId} retry requested`,
      goalId: after.goalId,
      taskId,
      ...(currentRunId ? { runId: currentRunId } : {}),
      source: { kind: sourceKindFor(callerSurface), subsystem: 'task-actions/request-retry' },
      correlationId: taskId,
      ...(currentRunId ? { causationId: currentRunId } : {}),
      details: {
        before: beforeSnap,
        after: afterSnapshot(after),
        retryCount: after.retryCount,
        ...(reason ? { reason } : {}),
      },
      sourceEventId: `task-retry-requested:${project}:${taskId}:${after.updatedAt}`,
    });
  } catch {
    // Best-effort — see file header.
  }

  return after;
}

/** Canonical PM retry for a dispatch-failed Run with no Result. */
export async function requestFailedRunTaskRetry(input: {
  dataRoot: string; project: string; goalId: string; taskId: string; runId: string; reason?: string; callerSurface: CallerSurface;
}): Promise<TaskRecord> {
  const before = getTask(input.dataRoot, input.project, input.taskId);
  authorizeEffect({ effect: 'REQUEST_RETRY', callerSurface: input.callerSurface, permissionPolicy: loadPolicy(input.dataRoot, input.project, before.goalId) });
  const after = await requestFailedRunRetryRuntime(input.dataRoot, input.project, input.taskId, input.runId, { goalId: input.goalId, reason: input.reason });
  try {
    await recordTaskRetryRequested(input.dataRoot, input.project, {
      summary: `Task ${input.taskId} failed-run retry requested`, goalId: after.goalId, taskId: input.taskId, runId: input.runId,
      source: { kind: sourceKindFor(input.callerSurface), subsystem: 'task-actions/request-failed-run-retry' },
      correlationId: input.taskId, causationId: input.runId, details: { before: beforeSnapshot(before), after: afterSnapshot(after), retryCount: after.retryCount, ...(input.reason ? { reason: input.reason } : {}) },
      sourceEventId: `task-failed-run-retry-requested:${input.project}:${input.taskId}:${after.updatedAt}`,
    });
  } catch { /* canonical mutation is durable */ }
  return after;
}
