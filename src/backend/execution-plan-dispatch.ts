/**
 * V1.5 Slice 2 — Owner-approved first-Task Plan dispatch.
 *
 * Plan is the frozen authorization envelope. This module deliberately owns
 * only Plan start and the first dispatch. It delegates every actual Task/Run
 * effect to V1's dispatchV1OwnerApproved(), and contains no successor logic.
 */
import {
  ExecutionPlanError,
  getExecutionPlan,
  startExecutionPlan,
  transitionExecutionPlan,
  type ExecutionPlanAuthorization,
  type ExecutionPlanRecord,
  type ExecutionPlanTaskBinding,
} from './execution-plan.js';
import { getTask } from './goal-task.js';
import { validateWorkspaceRoot, type DispatchResult } from './dispatcher.js';
import { dispatchV1OwnerApproved } from './v1-dispatch.js';
import { computeTaskScopeFingerprint } from './retry-authorization.js';
import { loadWorkerRegistryRecord } from './worker-registry.js';

export interface DispatchExecutionPlanOwnerApprovedInput {
  planId: string;
  expectedPlanState: 'PLANNED';
  ownerAuthorization: ExecutionPlanAuthorization;
}

export type DispatchExecutionPlanOwnerApprovedResult =
  | {
    outcome: 'DISPATCHED';
    plan: ExecutionPlanRecord;
    dispatch: DispatchResult;
  }
  | {
    /** A prior GO has durably started the Plan; this call never replays it. */
    outcome: 'ALREADY_STARTED' | 'START_IN_PROGRESS_OR_RECOVERY_REQUIRED';
    plan: ExecutionPlanRecord;
    existingRunId?: string;
  };

type OwnerDispatch = typeof dispatchV1OwnerApproved;
let ownerDispatch: OwnerDispatch = dispatchV1OwnerApproved;

/** Test-only failure-boundary seam. Production always uses canonical V1 dispatch. */
export function _setExecutionPlanOwnerDispatchForTests(implementation?: OwnerDispatch): void {
  ownerDispatch = implementation ?? dispatchV1OwnerApproved;
}

function requireExactInputShape(input: DispatchExecutionPlanOwnerApprovedInput): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', 'ExecutionPlan Owner GO input must be an object.');
  }
  const allowed = new Set(['planId', 'expectedPlanState', 'ownerAuthorization']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new ExecutionPlanError('INVALID_ARGUMENT', `ExecutionPlan Owner GO does not accept ${key}.`);
    }
  }
  if (input.expectedPlanState !== 'PLANNED') {
    throw new ExecutionPlanError('INVALID_ARGUMENT', 'expectedPlanState must be PLANNED.');
  }
}

export function getFrozenPlanTaskBinding(
  plan: ExecutionPlanRecord,
  taskId: string,
): ExecutionPlanTaskBinding {
  if (!plan.orderedTaskIds.includes(taskId)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', `Task is not declared by ExecutionPlan: ${taskId}`);
  }
  const binding = plan.taskBindings.find((candidate) => candidate.taskId === taskId);
  if (!binding) {
    throw new ExecutionPlanError('INVALID_STATE', `ExecutionPlan Task binding is missing: ${taskId}`);
  }
  return binding;
}

/**
 * Validate the immutable Plan binding against current V1 authority before the
 * Plan leaves PLANNED. No caller-supplied Task/Worker/workspace value exists.
 */
export function validateFrozenPlanTaskDispatchability(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  taskId: string,
): ExecutionPlanTaskBinding {
  const binding = getFrozenPlanTaskBinding(plan, taskId);
  const task = getTask(dataRoot, project, binding.taskId);
  if (task.executionState !== 'READY' || task.pmState !== 'PENDING') {
    throw new ExecutionPlanError(
      'INVALID_STATE',
      `Plan Task must be READY/PENDING (found ${task.executionState}/${task.pmState}).`,
    );
  }
  if (task.linkedRuns.length !== 0) {
    throw new ExecutionPlanError('CONFLICT', 'Plan Task already has a Run; dispatch is unsafe.');
  }
  if (computeTaskScopeFingerprint(task) !== binding.scopeFingerprint) {
    throw new ExecutionPlanError('INVALID_STATE', 'Plan Task scope fingerprint does not match its frozen binding.');
  }
  // These are the same frozen values later supplied to V1. Their validation is
  // deliberately performed before durable Plan start, so obvious mismatch does
  // not convert a PLANNED Plan into a false RUNNING Plan.
  loadWorkerRegistryRecord(dataRoot, binding.workerId);
  validateWorkspaceRoot(binding.workspaceRoot);
  return binding;
}

/**
 * Internal Plan dispatch adapter. It accepts no Worker/workspace/scope input:
 * all execution binding comes from the frozen Plan and V1 remains the actual
 * Task/Run dispatcher.
 */
export async function dispatchFrozenPlanTask(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
  taskId: string,
): Promise<DispatchResult> {
  const binding = validateFrozenPlanTaskDispatchability(dataRoot, project, plan, taskId);
  const dispatch = await ownerDispatch(dataRoot, project, {
    taskId: binding.taskId,
    workerId: binding.workerId,
    workspaceRoot: binding.workspaceRoot,
    expectedExecutionState: 'READY',
  });
  const after = getTask(dataRoot, project, binding.taskId);
  if (after.linkedRuns.length !== 1 || after.linkedRuns[0]?.runId !== dispatch.runId) {
    throw new ExecutionPlanError('CONFLICT', 'Canonical dispatch did not leave exactly one linked Plan Task Run.');
  }
  return dispatch;
}

function resolveAlreadyStarted(
  dataRoot: string,
  project: string,
  plan: ExecutionPlanRecord,
): DispatchExecutionPlanOwnerApprovedResult {
  if (plan.state !== 'RUNNING' || plan.activeTaskId !== plan.orderedTaskIds[0]) {
    throw new ExecutionPlanError('INVALID_STATE', `ExecutionPlan cannot receive Owner GO in state ${plan.state}.`);
  }
  const task = getTask(dataRoot, project, plan.activeTaskId);
  if (task.linkedRuns.length > 1) {
    throw new ExecutionPlanError('CONFLICT', 'First Plan Task has multiple Runs; reconciliation is required.');
  }
  if (task.linkedRuns.length === 1) {
    return { outcome: 'ALREADY_STARTED', plan, existingRunId: task.linkedRuns[0].runId };
  }
  // A caller may observe this tiny interval while the original GO is still
  // dispatching, or after a process interruption. Retrying would risk two V1
  // Runs, so Slice 2 does neither; Slice 4 will reconcile this durable state.
  return { outcome: 'START_IN_PROGRESS_OR_RECOVERY_REQUIRED', plan };
}

async function blockAfterDispatchUncertainty(
  dataRoot: string,
  project: string,
  planId: string,
  taskId: string,
  error: unknown,
): Promise<ExecutionPlanRecord> {
  const message = error instanceof Error ? error.message : String(error);
  const task = getTask(dataRoot, project, taskId);
  if (task.executionState === 'FAILED') {
    return transitionExecutionPlan(dataRoot, project, planId, {
      expectedState: 'RUNNING',
      to: 'FAILED',
      reason: `First Task canonical dispatch failed: ${message}`.slice(0, 500),
    });
  }
  const code = task.linkedRuns.length === 0
    ? 'PLAN_FIRST_DISPATCH_FAILED_BEFORE_RUN'
    : 'PLAN_FIRST_DISPATCH_UNCERTAIN_AFTER_RUN';
  return transitionExecutionPlan(dataRoot, project, planId, {
    expectedState: 'RUNNING',
    to: 'BLOCKED',
    block: {
      code,
      reason: `First Task dispatch did not complete safely: ${message}`.slice(0, 500),
      taskId,
    },
  });
}

/**
 * One Owner GO for one frozen Plan.
 *
 * Ordering is intentionally:
 *   validate frozen Plan + V1 Task binding → durable PLANNED→RUNNING cursor
 *   → canonical V1 owner dispatch → verify Task's durable Run link.
 *
 * The durable RUNNING cursor is the replay fence. A duplicate GO can only
 * return an already-started/in-progress bounded result; it never dispatches.
 */
export async function dispatchExecutionPlanOwnerApproved(
  dataRoot: string,
  project: string,
  input: DispatchExecutionPlanOwnerApprovedInput,
): Promise<DispatchExecutionPlanOwnerApprovedResult> {
  requireExactInputShape(input);
  let plan = getExecutionPlan(dataRoot, project, input.planId);
  if (plan.state !== 'PLANNED') {
    return resolveAlreadyStarted(dataRoot, project, plan);
  }

  const firstTaskId = plan.orderedTaskIds[0];
  if (!firstTaskId) throw new ExecutionPlanError('INVALID_STATE', 'ExecutionPlan has no first Task.');
  const binding = validateFrozenPlanTaskDispatchability(dataRoot, project, plan, firstTaskId);
  try {
    plan = await startExecutionPlan(dataRoot, project, plan.planId, {
      expectedState: input.expectedPlanState,
      activeTaskId: binding.taskId,
      ownerAuthorization: input.ownerAuthorization,
    });
  } catch (error) {
    if (!(error instanceof ExecutionPlanError) || error.code !== 'CONFLICT') throw error;
    return resolveAlreadyStarted(dataRoot, project, getExecutionPlan(dataRoot, project, input.planId));
  }

  try {
    const dispatch = await dispatchFrozenPlanTask(dataRoot, project, plan, binding.taskId);
    return { outcome: 'DISPATCHED', plan: getExecutionPlan(dataRoot, project, plan.planId), dispatch };
  } catch (error) {
    // No rollback and no redispatch: Task/Run remains authoritative. Convert
    // the Plan to FAILED only for a canonical Task failure; otherwise BLOCK
    // the sequence for explicit future reconciliation.
    try {
      await blockAfterDispatchUncertainty(dataRoot, project, plan.planId, binding.taskId, error);
    } catch (transitionError) {
      const detail = transitionError instanceof Error ? transitionError.message : String(transitionError);
      throw new ExecutionPlanError('IO_FAILURE', `Plan dispatch failed and Plan could not be safely blocked: ${detail}`);
    }
    throw error;
  }
}
