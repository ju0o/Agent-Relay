/**
 * GOAL INTAKE 01 — ONE Founder action: submit Goal → first real dispatch.
 *
 * Conceptual API:
 *   submitGoalAndRun({ goal, workspaceRoot, workerId })
 *
 * That ONE action means: (1) submit the Founder Goal, (2) authorize the
 * resulting frozen ExecutionPlan to begin. The Founder is never asked for a
 * second GO. Internally the flow reuses the existing canonical
 * `dispatchExecutionPlanOwnerApproved` path so authorization evidence remains
 * durable.
 *
 * Required flow (no new orchestration engine, no new dispatcher, no new
 * state model):
 *   ONE Founder Goal
 *   → persist real Founder Goal (Goal kernel; genuine Goal, NOT the V1
 *     technical container — generated Tasks carry this same goalId)
 *   → REAL PM planner (goal-planner.ts; Codex subscription provider)
 *   → strictly validated structured Plan Draft (fail closed: malformed or
 *     failed planner output creates NO Task, NO Plan, NO dispatch)
 *   → canonical Task creation (goal-task kernel + PLANNED→READY preparation,
 *     the same narrow step V1 intake performs — but under the Founder Goal)
 *   → canonical ExecutionPlan creation (frozen order + worker bindings)
 *   → existing Owner-approved Plan dispatch path (exactly ONE Owner GO)
 *   → first real Worker Run (STOP there; Closed-Loop E2E is the next task)
 *
 * workerId/workspaceRoot come from the one Founder submission and are
 * validated against the trusted worker registry / dispatcher root checks.
 * The PM never hallucinates paths or Worker IDs. Goal permission policy is
 * never mutated to bypass authorization.
 */
import { createGoal, createTask } from './goal-task.js';
import { transitionTaskExecution } from './goal-task-runtime.js';
import {
  computeExecutionPlanScopeFingerprint,
  createExecutionPlan,
  type ExecutionPlanAuthorization,
  type ExecutionPlanRecord,
} from './execution-plan.js';
import { dispatchExecutionPlanOwnerApproved } from './execution-plan-dispatch.js';
import { computeTaskScopeFingerprint } from './retry-authorization.js';
import { loadWorkerRegistryRecord } from './worker-registry.js';
import { validateWorkspaceRoot, type DispatchResult } from './dispatcher.js';
import {
  planDraftFromFounderGoal,
  type FounderGoalInput,
  type ValidatedPlanDraft,
} from './goal-planner.js';
import type { GoalRecord, TaskRecord } from '../shared/types.js';

export class GoalIntakeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoalIntakeError';
    this.code = code;
  }
}

/** Injected Plan Draft provider. Default is the REAL Codex PM planner. */
export type PlanDraftProvider = (goal: FounderGoalInput) => Promise<ValidatedPlanDraft>;

export interface SubmitGoalAndRunInput {
  dataRoot: string;
  project: string;
  goal: FounderGoalInput;
  workspaceRoot: string;
  workerId: string;
  /** Test seam only — production always uses the real planner. */
  planDraftProvider?: PlanDraftProvider;
}

export interface SubmitGoalAndRunResult {
  goal: GoalRecord;
  tasks: TaskRecord[];
  plan: ExecutionPlanRecord;
  /** Durable Owner authorization evidence ID (exactly one per submit). */
  ownerAuthorizationId: string;
  dispatch: DispatchResult;
  firstRunId: string;
  ownerInteractionCount: 1;
  ownerGoEvidenceCount: 1;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GoalIntakeError('INVALID_ARGUMENT', `${field} is required.`);
  }
  return value.trim();
}

/**
 * ONE Founder submit: persist Goal → real plan → canonical Tasks → frozen
 * Plan → ONE Owner GO → first dispatch. Throws fail-closed (no partial
 * Plan/dispatch) when the planner output is malformed or the planner fails.
 */
export async function submitGoalAndRun(
  input: SubmitGoalAndRunInput,
): Promise<SubmitGoalAndRunResult> {
  const dataRoot = requireNonEmptyString(input?.dataRoot, 'dataRoot');
  const project = requireNonEmptyString(input?.project, 'project');
  const workspaceRoot = requireNonEmptyString(input?.workspaceRoot, 'workspaceRoot');
  const workerId = requireNonEmptyString(input?.workerId, 'workerId');
  if (!input?.goal || typeof input.goal !== 'object') {
    throw new GoalIntakeError('INVALID_ARGUMENT', 'goal is required.');
  }
  const founderGoal: FounderGoalInput = {
    title: requireNonEmptyString(input.goal.title, 'goal.title'),
    goalStatement: requireNonEmptyString(input.goal.goalStatement, 'goal.goalStatement'),
  };

  // Trusted binding first, before ANY durable write: registry + root checks
  // are authoritative, never planner-supplied.
  loadWorkerRegistryRecord(dataRoot, workerId);
  validateWorkspaceRoot(workspaceRoot);

  // Genuine Founder Goal via the Goal kernel (NOT the V1 technical container).
  const goal = await createGoal(dataRoot, project, {
    title: founderGoal.title,
    goalStatement: founderGoal.goalStatement,
    status: 'ACTIVE',
  });

  // REAL PM planner. Malformed/failed output throws BEFORE any Task/Plan/
  // dispatch durable write (the Goal above is the submitted Founder intent).
  const provider: PlanDraftProvider = input.planDraftProvider ?? planDraftFromFounderGoal;
  let draft: ValidatedPlanDraft;
  try {
    draft = await provider({ title: goal.title, goalStatement: goal.goalStatement });
  } catch (err) {
    throw new GoalIntakeError(
      'PLANNER_FAILED',
      `Real PM planner failed (fail closed, no Tasks/Plan/dispatch): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!draft || !Array.isArray(draft.tasks) || draft.tasks.length < 1) {
    throw new GoalIntakeError(
      'MALFORMED_DRAFT',
      'Real PM planner returned an empty draft (fail closed, no Tasks/Plan/dispatch).',
    );
  }

  // Canonical Tasks under the SAME Founder goalId + narrow READY preparation
  // (the same frozen PLANNED→READY step V1 intake performs).
  const tasks: TaskRecord[] = [];
  for (const entry of draft.tasks) {
    const created = await createTask(dataRoot, project, {
      goalId: goal.goalId,
      title: entry.title,
      goal: entry.goal,
      reason: entry.reason,
      scope: entry.scope,
      completionCriteria: entry.completionCriteria,
    });
    const ready = await transitionTaskExecution(dataRoot, project, created.taskId, {
      expectedExecutionState: 'PLANNED',
      to: 'READY',
      reason: 'goal-intake:ready-for-dispatch',
    });
    tasks.push(ready);
  }

  // Canonical frozen ExecutionPlan: draft order + submission bindings.
  const taskBindings = tasks.map((task) => ({
    taskId: task.taskId,
    workerId,
    workspaceRoot,
    scopeFingerprint: computeTaskScopeFingerprint(task),
  }));
  const plan = await createExecutionPlan(dataRoot, project, {
    title: draft.title,
    orderedTaskIds: tasks.map((task) => task.taskId),
    taskBindings,
  });

  // Exactly ONE Owner authorization for this ONE frozen Plan. The Founder
  // submit action IS the GO — no second GO is ever requested or constructed.
  const ownerAuthorization: ExecutionPlanAuthorization = {
    authorizationId: `owner-go:${plan.planId}`,
    approvedAt: new Date().toISOString(),
    approvedBy: 'OWNER',
    planScopeFingerprint: computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(
      plan.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint]),
    ),
  };

  const go = await dispatchExecutionPlanOwnerApproved(dataRoot, project, {
    planId: plan.planId,
    expectedPlanState: 'PLANNED',
    ownerAuthorization,
  });
  if (go.outcome !== 'DISPATCHED') {
    throw new GoalIntakeError(
      'DISPATCH_NOT_FIRST',
      `Owner GO did not perform the first dispatch (outcome=${go.outcome}).`,
    );
  }

  return {
    goal,
    tasks,
    plan: go.plan,
    ownerAuthorizationId: ownerAuthorization.authorizationId,
    dispatch: go.dispatch,
    firstRunId: go.dispatch.runId,
    ownerInteractionCount: 1,
    ownerGoEvidenceCount: 1,
  };
}
