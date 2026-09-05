/**
 * V1.5 Slice 3 — continuation after a canonical Task ACCEPT.
 *
 * This module owns only the Plan cursor and frozen successor dispatch. The
 * Task is already ACCEPTED when called; Task/Run/PM judgment state remains
 * owned by the existing V1 kernels.
 */
import {
  advanceExecutionPlanActiveTask,
  ExecutionPlanError,
  getExecutionPlan,
  listExecutionPlans,
  transitionExecutionPlan,
  type ExecutionPlanRecord,
} from './execution-plan.js';
import { dispatchFrozenPlanTask, validateFrozenPlanTaskDispatchability } from './execution-plan-dispatch.js';
import { getTask } from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import type { TaskRecord } from '../shared/types.js';

export type ExecutionPlanAcceptContinuationOutcome =
  | 'NO_PLAN'
  | 'NOT_ACTIVE'
  | 'ADVANCED_AND_DISPATCHED'
  | 'COMPLETED'
  | 'ALREADY_ADVANCED_OR_RECOVERY_REQUIRED'
  | 'BLOCKED';

function acceptedRunIsAuthoritative(task: TaskRecord): boolean {
  return task.pmState === 'ACCEPTED'
    && !!task.acceptedRunId
    && resolveCurrentAttemptRunId(task) === task.acceptedRunId
    && task.linkedRuns.some((link) => link.runId === task.acceptedRunId);
}

async function blockPlan(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  code: string,
  reason: string,
  taskId: string,
): Promise<ExecutionPlanRecord | null> {
  try {
    return await transitionExecutionPlan(dataRoot, project, plan.planId, {
      expectedState: 'RUNNING',
      to: 'BLOCKED',
      block: { code, reason: reason.slice(0, 500), taskId },
    });
  } catch {
    return null;
  }
}

async function failOrBlockSuccessorDispatch(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  successorTaskId: string,
  error: unknown,
): Promise<ExecutionPlanAcceptContinuationOutcome> {
  const detail = error instanceof Error ? error.message : String(error);
  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, successorTaskId);
  } catch {
    await blockPlan(dataRoot, project, plan, 'PLAN_SUCCESSOR_TASK_UNREADABLE', detail, successorTaskId);
    return 'BLOCKED';
  }
  if (task.executionState === 'FAILED') {
    try {
      await transitionExecutionPlan(dataRoot, project, plan.planId, {
        expectedState: 'RUNNING',
        to: 'FAILED',
        reason: `Successor canonical dispatch failed: ${detail}`.slice(0, 500),
      });
    } catch { /* an already-blocked/terminal Plan remains fail-closed */ }
    return 'BLOCKED';
  }
  const code = task.linkedRuns.length === 0
    ? 'PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN'
    : 'PLAN_SUCCESSOR_DISPATCH_UNCERTAIN_AFTER_RUN';
  await blockPlan(dataRoot, project, plan, code, detail, successorTaskId);
  return 'BLOCKED';
}

async function advanceOnePlanAfterAccept(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  acceptedTask: TaskRecord,
): Promise<ExecutionPlanAcceptContinuationOutcome> {
  if (plan.state !== 'RUNNING') return 'NOT_ACTIVE';
  if (plan.activeTaskId !== acceptedTask.taskId) return 'NOT_ACTIVE';
  if (!acceptedRunIsAuthoritative(acceptedTask)) {
    await blockPlan(
      dataRoot, project, plan, 'PLAN_ACCEPT_RUN_MISMATCH',
      'Canonical accepted Task does not retain an authoritative accepted Run.', acceptedTask.taskId,
    );
    return 'BLOCKED';
  }

  const currentIndex = plan.orderedTaskIds.indexOf(acceptedTask.taskId);
  if (currentIndex < 0) {
    await blockPlan(dataRoot, project, plan, 'PLAN_ACTIVE_TASK_NOT_IN_ORDER', 'Active Task is absent from frozen order.', acceptedTask.taskId);
    return 'BLOCKED';
  }
  const successorTaskId = plan.orderedTaskIds[currentIndex + 1];
  if (!successorTaskId) {
    try {
      await transitionExecutionPlan(dataRoot, project, plan.planId, {
        expectedState: 'RUNNING', to: 'COMPLETED',
      });
      return 'COMPLETED';
    } catch (error) {
      if (error instanceof ExecutionPlanError && error.code === 'CONFLICT') {
        const current = getExecutionPlan(dataRoot, project, plan.planId);
        if (current.state === 'COMPLETED') return 'COMPLETED';
      }
      return 'ALREADY_ADVANCED_OR_RECOVERY_REQUIRED';
    }
  }

  // Validate before the cursor commits. This rejects frozen worker/workspace/
  // scope divergence without advancing a Plan to a successor it cannot start.
  try {
    validateFrozenPlanTaskDispatchability(dataRoot, project, plan, successorTaskId);
  } catch (error) {
    return failOrBlockSuccessorDispatch(dataRoot, project, plan, successorTaskId, error);
  }

  try {
    plan = await advanceExecutionPlanActiveTask(dataRoot, project, plan.planId, {
      expectedState: 'RUNNING', expectedActiveTaskId: acceptedTask.taskId, nextActiveTaskId: successorTaskId,
    });
  } catch (error) {
    // A concurrent duplicate ACCEPT may have advanced already. Never infer a
    // new dispatch from that state; only Slice 4 may reconcile ambiguity.
    if (error instanceof ExecutionPlanError && error.code === 'CONFLICT') {
      return 'ALREADY_ADVANCED_OR_RECOVERY_REQUIRED';
    }
    return 'ALREADY_ADVANCED_OR_RECOVERY_REQUIRED';
  }

  try {
    await dispatchFrozenPlanTask(dataRoot, project, plan, successorTaskId);
    return 'ADVANCED_AND_DISPATCHED';
  } catch (error) {
    return failOrBlockSuccessorDispatch(dataRoot, project, plan, successorTaskId, error);
  }
}

/**
 * Canonical post-ACCEPT hook. The Plan directory is the only durable Plan
 * index currently available; V1 Tasks intentionally have no Plan dependency.
 */
export async function continueExecutionPlanAfterTaskAccepted(
  dataRoot: string,
  project: string,
  acceptedTask: TaskRecord,
): Promise<ExecutionPlanAcceptContinuationOutcome> {
  let plans: ExecutionPlanRecord[];
  try {
    plans = listExecutionPlans(dataRoot, project)
      .filter((plan) => plan.state === 'RUNNING' && plan.orderedTaskIds.includes(acceptedTask.taskId));
  } catch {
    // Acceptance is already durable; absent a readable Plan index this hook
    // must not guess or dispatch. Slice 4 owns repair/reconciliation.
    return 'ALREADY_ADVANCED_OR_RECOVERY_REQUIRED';
  }
  if (plans.length === 0) return 'NO_PLAN';
  const active = plans.filter((plan) => plan.activeTaskId === acceptedTask.taskId);
  if (active.length === 0) return 'NOT_ACTIVE';
  if (active.length > 1) {
    await Promise.all(active.map((plan) => blockPlan(
      dataRoot, project, plan, 'PLAN_ACTIVE_TASK_AMBIGUITY',
      'More than one RUNNING Plan names the accepted Task as active.', acceptedTask.taskId,
    )));
    return 'BLOCKED';
  }
  return advanceOnePlanAfterAccept(dataRoot, project, active[0]!, acceptedTask);
}
