/**
 * V1.5 Slice 4 — durable, fail-closed ExecutionPlan reconciliation.
 *
 * This is an explicit internal operation, not a startup daemon and not an MCP
 * surface. It reads Plan/Task/Run/Delivery/Retry records and either observes,
 * applies one provably-missing authorized dispatch, or blocks the Plan.
 */
import * as path from 'node:path';
import {
  advanceExecutionPlanActiveTaskWhileLocked,
  computeExecutionPlanScopeFingerprint,
  ExecutionPlanError,
  getExecutionPlan,
  recoverStaleExecutionPlanLock,
  transitionExecutionPlanWhileLocked,
  withExecutionPlanLock,
  type ExecutionPlanRecord,
} from './execution-plan.js';
import { dispatchFrozenPlanTask, getFrozenPlanTaskBinding, validateFrozenPlanTaskDispatchability } from './execution-plan-dispatch.js';
import { buildHistory, readRunMeta } from './fs.js';
import { getTask, listTasks } from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { listPmDeliveries } from './pm-delivery.js';
import { listRetryPreparations } from './retry-preparation.js';
import { dispatchV1Retry } from './retry-dispatch.js';
import type { TaskRecord } from '../shared/types.js';

export const EXECUTION_PLAN_RECONCILIATION_STATUSES = [
  'HEALTHY_RUNNING',
  'WAITING_FOR_RESULT',
  'WAITING_FOR_PM',
  'SUCCESSOR_ALREADY_DISPATCHED',
  'SAFE_TO_DISPATCH_MISSING_SUCCESSOR',
  'PLAN_COMPLETE',
  'PLAN_FAILED',
  'BLOCKED_REQUIRES_OWNER',
] as const;
export type ExecutionPlanReconciliationStatus = (typeof EXECUTION_PLAN_RECONCILIATION_STATUSES)[number];

export interface ExecutionPlanReconciliationResult {
  status: ExecutionPlanReconciliationStatus;
  planId: string;
  activeTaskId: string | null;
  actionTaken: string;
  observedRunId?: string;
  reason?: string;
  staleLockRecovered?: boolean;
}

function result(
  plan: ExecutionPlanRecord,
  status: ExecutionPlanReconciliationStatus,
  actionTaken: string,
  extras?: Pick<ExecutionPlanReconciliationResult, 'observedRunId' | 'reason' | 'staleLockRecovered'>,
): ExecutionPlanReconciliationResult {
  return { status, planId: plan.planId, activeTaskId: plan.activeTaskId, actionTaken, ...extras };
}

function unreadablePlanResult(planId: string, reason: string): ExecutionPlanReconciliationResult {
  return {
    status: 'BLOCKED_REQUIRES_OWNER',
    planId,
    activeTaskId: null,
    actionTaken: 'RECONCILIATION_FAILED_CLOSED',
    reason: reason.slice(0, 200),
  };
}

function currentRunId(task: TaskRecord): string | undefined {
  return resolveCurrentAttemptRunId(task);
}

function acceptedRunIsAuthoritative(task: TaskRecord): boolean {
  return task.pmState === 'ACCEPTED'
    && !!task.acceptedRunId
    && task.acceptedRunId === currentRunId(task)
    && task.linkedRuns.some((link) => link.runId === task.acceptedRunId);
}

function linkedRunEvidenceIsConsistent(task: TaskRecord): { ok: true; runId?: string } | { ok: false; reason: string } {
  for (const link of task.linkedRuns) {
    if (!link.folder || !path.isAbsolute(link.folder)) {
      return { ok: false, reason: 'Task linked Run folder is invalid.' };
    }
    const meta = readRunMeta(link.folder);
    if (meta.runId && meta.runId !== link.runId) {
      return { ok: false, reason: 'Task linked Run metadata runId conflicts.' };
    }
    if (meta.taskId && meta.taskId !== task.taskId) {
      return { ok: false, reason: 'Task linked Run metadata taskId conflicts.' };
    }
  }
  return { ok: true, runId: currentRunId(task) };
}

/**
 * A pre-link crash leaves a materialized Run folder but no Task link. Because
 * initial Run metadata is not sufficient to prove Task identity before link,
 * any unlinked folder in the frozen Worker directory is ambiguous and blocks.
 */
function hasAmbiguousUnlinkedRunCandidate(
  dataRoot: string,
  project: string,
  workerId: string,
): boolean {
  const linkedFolders = new Set(listTasks(dataRoot, project)
    .flatMap((task) => task.linkedRuns.map((link) => path.resolve(link.folder))));
  const expectedAgent = `worker-${workerId}`;
  for (const item of buildHistory(dataRoot, project)) {
    if (item.agent !== expectedAgent || linkedFolders.has(path.resolve(item.folder))) continue;
    // Any unlinked folder under the exact dispatcher Worker label is enough to
    // make a replay unsafe; do not infer ownership from transient state.
    return true;
  }
  return false;
}

/**
 * Revalidate frozen Owner authorization before any cursor repair or dispatch.
 * Authorization mismatch is never silently repaired.
 */
function revalidatePlanAuthorization(plan: ExecutionPlanRecord): { ok: true } | { ok: false; reason: string } {
  if (!plan.ownerAuthorization) {
    return { ok: false, reason: 'RUNNING Plan is missing ownerAuthorization evidence.' };
  }
  const expected = computeExecutionPlanScopeFingerprint(plan);
  if (plan.ownerAuthorization.planScopeFingerprint !== expected) {
    return { ok: false, reason: 'Plan authorization fingerprint no longer matches frozen definition.' };
  }
  if (plan.ownerAuthorization.approvedBy !== 'OWNER') {
    return { ok: false, reason: 'Plan authorization approvedBy is not OWNER.' };
  }
  for (const binding of plan.taskBindings) {
    const authorized = plan.ownerAuthorization.taskScopeFingerprints[binding.taskId];
    if (authorized !== binding.scopeFingerprint) {
      return { ok: false, reason: `Plan authorization fingerprint mismatch for ${binding.taskId}.` };
    }
  }
  return { ok: true };
}

function blockWhileLocked(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  code: string,
  reason: string,
  taskId: string,
): ExecutionPlanReconciliationResult {
  try {
    const blocked = transitionExecutionPlanWhileLocked(dataRoot, project, plan.planId, {
      expectedState: 'RUNNING',
      to: 'BLOCKED',
      block: { code, reason: reason.slice(0, 500), taskId },
    });
    return result(blocked, 'BLOCKED_REQUIRES_OWNER', 'PLAN_BLOCKED', { reason: code });
  } catch {
    return result(plan, 'BLOCKED_REQUIRES_OWNER', 'PLAN_LOCKED_FAIL_CLOSED', { reason: code });
  }
}

function completeWhileLocked(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
): ExecutionPlanReconciliationResult {
  for (const taskId of plan.orderedTaskIds) {
    let task: TaskRecord;
    try {
      task = getTask(dataRoot, project, taskId);
    } catch (error) {
      return blockWhileLocked(
        dataRoot, project, plan, 'PLAN_COMPLETION_TASK_UNREADABLE',
        error instanceof Error ? error.message : String(error), taskId,
      );
    }
    if (task.pmState !== 'ACCEPTED' || !acceptedRunIsAuthoritative(task)) {
      return blockWhileLocked(
        dataRoot, project, plan, 'PLAN_COMPLETION_ACCEPT_INCOMPLETE',
        `Declared Task ${taskId} is not canonically ACCEPTED.`, taskId,
      );
    }
  }
  try {
    const completed = transitionExecutionPlanWhileLocked(dataRoot, project, plan.planId, {
      expectedState: 'RUNNING',
      to: 'COMPLETED',
    });
    return result(completed, 'PLAN_COMPLETE', 'COMPLETED_PLAN');
  } catch {
    return result(plan, 'BLOCKED_REQUIRES_OWNER', 'PLAN_COMPLETION_UNCERTAIN', { reason: 'PLAN_COMPLETION_UNCERTAIN' });
  }
}

async function reconcileAcceptedActiveTask(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  task: TaskRecord,
): Promise<ExecutionPlanReconciliationResult> {
  const auth = revalidatePlanAuthorization(plan);
  if (!auth.ok) {
    return blockWhileLocked(dataRoot, project, plan, 'PLAN_AUTHORIZATION_MISMATCH', auth.reason, task.taskId);
  }
  if (!acceptedRunIsAuthoritative(task)) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACCEPT_RUN_MISMATCH',
      'Accepted Task has no authoritative accepted Run.', task.taskId,
    );
  }
  const index = plan.orderedTaskIds.indexOf(task.taskId);
  if (index < 0) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_TASK_NOT_IN_ORDER',
      'Active Task is missing from frozen order.', task.taskId,
    );
  }
  const successorTaskId = plan.orderedTaskIds[index + 1];
  if (!successorTaskId) return completeWhileLocked(dataRoot, project, plan);

  let successor: TaskRecord;
  try {
    successor = getTask(dataRoot, project, successorTaskId);
    getFrozenPlanTaskBinding(plan, successorTaskId);
  } catch (error) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_SUCCESSOR_UNREADABLE',
      error instanceof Error ? error.message : String(error), successorTaskId,
    );
  }
  const successorEvidence = linkedRunEvidenceIsConsistent(successor);
  if (!successorEvidence.ok) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_SUCCESSOR_RUN_LINKAGE_CONFLICT',
      successorEvidence.reason, successorTaskId,
    );
  }
  if (successor.linkedRuns.length > 1) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_SUCCESSOR_MULTIPLE_RUNS',
      'Successor has multiple Runs before cursor repair.', successorTaskId,
    );
  }
  if (successor.linkedRuns.length === 1) {
    try {
      const advanced = advanceExecutionPlanActiveTaskWhileLocked(dataRoot, project, plan.planId, {
        expectedState: 'RUNNING',
        expectedActiveTaskId: task.taskId,
        nextActiveTaskId: successorTaskId,
      });
      return result(advanced, 'SUCCESSOR_ALREADY_DISPATCHED', 'ADVANCED_CURSOR_TO_EXISTING_SUCCESSOR', {
        observedRunId: successorEvidence.runId,
      });
    } catch (error) {
      return blockWhileLocked(
        dataRoot, project, plan, 'PLAN_CURSOR_REPAIR_CONFLICT',
        error instanceof Error ? error.message : String(error), task.taskId,
      );
    }
  }

  try {
    validateFrozenPlanTaskDispatchability(dataRoot, project, plan, successorTaskId);
  } catch (error) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_SUCCESSOR_BINDING_INVALID',
      error instanceof Error ? error.message : String(error), successorTaskId,
    );
  }
  const binding = getFrozenPlanTaskBinding(plan, successorTaskId);
  if (hasAmbiguousUnlinkedRunCandidate(dataRoot, project, binding.workerId)) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_SUCCESSOR_UNLINKED_RUN_AMBIGUITY',
      'An unlinked Run folder may belong to the successor.', successorTaskId,
    );
  }
  let advanced: ExecutionPlanRecord;
  try {
    advanced = advanceExecutionPlanActiveTaskWhileLocked(dataRoot, project, plan.planId, {
      expectedState: 'RUNNING',
      expectedActiveTaskId: task.taskId,
      nextActiveTaskId: successorTaskId,
    });
  } catch (error) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_CURSOR_ADVANCE_CONFLICT',
      error instanceof Error ? error.message : String(error), task.taskId,
    );
  }
  try {
    const dispatch = await dispatchFrozenPlanTask(dataRoot, project, advanced, successorTaskId);
    return result(
      getExecutionPlan(dataRoot, project, plan.planId),
      'SAFE_TO_DISPATCH_MISSING_SUCCESSOR',
      'ADVANCED_AND_DISPATCHED_SUCCESSOR',
      { observedRunId: dispatch.runId },
    );
  } catch (error) {
    const successorAfter = getTask(dataRoot, project, successorTaskId);
    if (successorAfter.executionState === 'FAILED') {
      try {
        const failed = transitionExecutionPlanWhileLocked(dataRoot, project, plan.planId, {
          expectedState: 'RUNNING',
          to: 'FAILED',
          reason: 'Successor canonical dispatch failed during reconciliation.',
        });
        return result(failed, 'PLAN_FAILED', 'MARKED_PLAN_FAILED');
      } catch { /* fall through to fail-closed response */ }
    }
    return blockWhileLocked(
      dataRoot, project, getExecutionPlan(dataRoot, project, plan.planId),
      'PLAN_SUCCESSOR_DISPATCH_UNCERTAIN',
      error instanceof Error ? error.message : String(error), successorTaskId,
    );
  }
}

async function reconcileReadyActiveTask(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  task: TaskRecord,
): Promise<ExecutionPlanReconciliationResult> {
  const auth = revalidatePlanAuthorization(plan);
  if (!auth.ok) {
    return blockWhileLocked(dataRoot, project, plan, 'PLAN_AUTHORIZATION_MISMATCH', auth.reason, task.taskId);
  }

  // Same-Task G5 retry seam: prior Runs exist, Task is READY/PENDING again.
  if (task.linkedRuns.length > 0) {
    const readyPreps = listRetryPreparations(dataRoot, project)
      .filter((prep) => prep.taskId === task.taskId && prep.status === 'READY' && !prep.dispatchedRunId);
    if (readyPreps.length !== 1) {
      return blockWhileLocked(
        dataRoot, project, plan, 'PLAN_RETRY_AMBIGUITY',
        'READY Task with prior Runs lacks exactly one unconsumed G5 retry preparation.',
        task.taskId,
      );
    }
    try {
      const retry = await dispatchV1Retry(dataRoot, project, { preparationId: readyPreps[0]!.preparationId });
      return result(
        getExecutionPlan(dataRoot, project, plan.planId),
        'WAITING_FOR_RESULT',
        retry.alreadyDispatched ? 'ADOPTED_G5_RETRY_RUN' : 'DISPATCHED_G5_RETRY_RUN',
        { observedRunId: retry.runId },
      );
    } catch (error) {
      return blockWhileLocked(
        dataRoot, project, plan, 'PLAN_RETRY_RECONCILIATION_FAILED',
        error instanceof Error ? error.message : String(error), task.taskId,
      );
    }
  }

  let binding;
  try {
    binding = validateFrozenPlanTaskDispatchability(dataRoot, project, plan, task.taskId);
  } catch (error) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_BINDING_INVALID',
      error instanceof Error ? error.message : String(error), task.taskId,
    );
  }
  if (hasAmbiguousUnlinkedRunCandidate(dataRoot, project, binding.workerId)) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_UNLINKED_RUN_AMBIGUITY',
      'An unlinked Run folder may belong to the active Task.', task.taskId,
    );
  }
  try {
    const dispatch = await dispatchFrozenPlanTask(dataRoot, project, plan, task.taskId);
    return result(
      getExecutionPlan(dataRoot, project, plan.planId),
      'SAFE_TO_DISPATCH_MISSING_SUCCESSOR',
      'DISPATCHED_MISSING_ACTIVE_TASK',
      { observedRunId: dispatch.runId },
    );
  } catch (error) {
    const after = getTask(dataRoot, project, task.taskId);
    if (after.executionState === 'FAILED') {
      const failed = transitionExecutionPlanWhileLocked(dataRoot, project, plan.planId, {
        expectedState: 'RUNNING',
        to: 'FAILED',
        reason: 'Active Task canonical dispatch failed during reconciliation.',
      });
      return result(failed, 'PLAN_FAILED', 'MARKED_PLAN_FAILED');
    }
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_DISPATCH_UNCERTAIN',
      error instanceof Error ? error.message : String(error), task.taskId,
    );
  }
}

async function reconcileRunningPlanWhileLocked(
  dataRoot: string,
  project: string,
  planId: string,
): Promise<ExecutionPlanReconciliationResult> {
  const plan = getExecutionPlan(dataRoot, project, planId);
  if (plan.state === 'COMPLETED') return result(plan, 'PLAN_COMPLETE', 'NOOP_TERMINAL');
  if (plan.state === 'FAILED' || plan.state === 'CANCELLED') {
    return result(plan, 'PLAN_FAILED', 'NOOP_TERMINAL');
  }
  if (plan.state === 'BLOCKED') {
    return result(plan, 'BLOCKED_REQUIRES_OWNER', 'NOOP_BLOCKED', { reason: plan.block?.code });
  }
  if (plan.state === 'PLANNED') {
    return result(plan, 'BLOCKED_REQUIRES_OWNER', 'OWNER_GO_REQUIRED', { reason: 'PLAN_NOT_STARTED' });
  }
  if (!plan.activeTaskId) {
    return result(plan, 'BLOCKED_REQUIRES_OWNER', 'PLAN_BLOCKED', { reason: 'PLAN_RUNNING_WITHOUT_ACTIVE_TASK' });
  }

  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, plan.activeTaskId);
  } catch (error) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_TASK_UNREADABLE',
      error instanceof Error ? error.message : String(error), plan.activeTaskId,
    );
  }
  const evidence = linkedRunEvidenceIsConsistent(task);
  if (!evidence.ok) {
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_ACTIVE_RUN_LINKAGE_CONFLICT',
      evidence.reason, task.taskId,
    );
  }
  if (task.executionState === 'FAILED') {
    try {
      const failed = transitionExecutionPlanWhileLocked(dataRoot, project, plan.planId, {
        expectedState: 'RUNNING',
        to: 'FAILED',
        reason: 'Active Task is canonically FAILED.',
      });
      return result(failed, 'PLAN_FAILED', 'MARKED_PLAN_FAILED', { observedRunId: evidence.runId });
    } catch {
      return result(plan, 'BLOCKED_REQUIRES_OWNER', 'PLAN_FAILURE_TRANSITION_UNCERTAIN');
    }
  }
  if (task.pmState === 'ACCEPTED') {
    return reconcileAcceptedActiveTask(dataRoot, project, plan, task);
  }
  if (task.executionState === 'RUNNING') {
    return result(plan, 'HEALTHY_RUNNING', 'OBSERVE_ACTIVE_WORKER', { observedRunId: evidence.runId });
  }
  if (task.executionState === 'DISPATCHED') {
    return result(plan, 'WAITING_FOR_RESULT', 'OBSERVE_DISPATCHED_RUN', { observedRunId: evidence.runId });
  }
  if (task.executionState === 'RESULT_RECEIVED') {
    if (task.pmState === 'CHANGES_REQUESTED') {
      // Durable CHANGES exists; G5 preparation/retry remains the sole retry
      // authority. Do not invent a Plan-owned retry engine.
      return result(plan, 'WAITING_FOR_PM', 'WAIT_FOR_G5_RETRY_PREPARATION', {
        observedRunId: evidence.runId,
        reason: 'CHANGES_REQUESTED',
      });
    }
    if (task.pmState === 'VERIFYING' || task.pmState === 'PENDING') {
      const delivery = evidence.runId
        ? listPmDeliveries(dataRoot, project).find((item) => item.taskId === task.taskId && item.runId === evidence.runId)
        : undefined;
      return result(plan, 'WAITING_FOR_PM', delivery ? 'WAIT_FOR_PM_JUDGMENT' : 'WAIT_FOR_PM_DELIVERY_RECONCILIATION', {
        observedRunId: evidence.runId,
      });
    }
    return blockWhileLocked(
      dataRoot, project, plan, 'PLAN_RESULT_PM_STATE_UNSUPPORTED',
      `${task.executionState}/${task.pmState}`, task.taskId,
    );
  }
  if ((task.executionState === 'READY' || task.executionState === 'PLANNED') && task.pmState === 'PENDING') {
    return reconcileReadyActiveTask(dataRoot, project, plan, task);
  }
  return blockWhileLocked(
    dataRoot, project, plan, 'PLAN_ACTIVE_STATE_UNSUPPORTED',
    `${task.executionState}/${task.pmState}`, task.taskId,
  );
}

/** Explicit, idempotent, local reconciliation. No startup daemon/MCP surface. */
export async function reconcileExecutionPlan(
  dataRoot: string,
  project: string,
  planId: string,
): Promise<ExecutionPlanReconciliationResult> {
  let staleLockRecovered = false;
  const run = async (): Promise<ExecutionPlanReconciliationResult> => withExecutionPlanLock(
    dataRoot, project, planId, () => reconcileRunningPlanWhileLocked(dataRoot, project, planId),
  );
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ExecutionPlanError) || error.code !== 'CONFLICT') {
      try {
        const plan = getExecutionPlan(dataRoot, project, planId);
        return result(plan, 'BLOCKED_REQUIRES_OWNER', 'RECONCILIATION_FAILED_CLOSED', {
          reason: error instanceof Error ? error.message.slice(0, 200) : String(error),
        });
      } catch {
        return unreadablePlanResult(planId, error instanceof Error ? error.message : String(error));
      }
    }
    staleLockRecovered = await recoverStaleExecutionPlanLock(dataRoot, project, planId);
    if (!staleLockRecovered) {
      try {
        const plan = getExecutionPlan(dataRoot, project, planId);
        return result(plan, 'BLOCKED_REQUIRES_OWNER', 'LIVE_OR_UNRESOLVED_PLAN_LOCK', {
          reason: 'PLAN_LOCK_UNRESOLVED',
        });
      } catch {
        return unreadablePlanResult(planId, 'PLAN_LOCK_UNRESOLVED');
      }
    }
    const recovered = await run();
    return { ...recovered, staleLockRecovered: true };
  }
}

/** Alias retained for call-site clarity; identical to reconcileExecutionPlan. */
export async function reconcileRunningExecutionPlan(
  dataRoot: string,
  project: string,
  planId: string,
): Promise<ExecutionPlanReconciliationResult> {
  return reconcileExecutionPlan(dataRoot, project, planId);
}
