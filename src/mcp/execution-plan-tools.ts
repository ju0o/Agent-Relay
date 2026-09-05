/**
 * V1.5 Slice 5 — minimal Chat MCP ExecutionPlan surface.
 *
 * Four tools only:
 *   relay_pm_create_execution_plan
 *   relay_pm_dispatch_execution_plan_owner_approved
 *   relay_pm_get_execution_plan
 *   relay_pm_reconcile_execution_plan
 *
 * No Plan-specific judgment, Delivery, or widget. Task review/ACCEPT/CHANGES
 * remain on the existing V1 PM tools; Plan continuation stays Slice 3.
 */
import * as crypto from 'node:crypto';
import {
  computeExecutionPlanScopeFingerprint,
  createExecutionPlan,
  ExecutionPlanError,
  getExecutionPlan,
  listExecutionPlans,
  type ExecutionPlanRecord,
  type ExecutionPlanTaskBinding,
} from '../backend/execution-plan.js';
import { dispatchExecutionPlanOwnerApproved } from '../backend/execution-plan-dispatch.js';
import { reconcileExecutionPlan } from '../backend/execution-plan-reconciliation.js';
import { validateWorkspaceRoot } from '../backend/dispatcher.js';
import { getTask } from '../backend/goal-task.js';
import { computeTaskScopeFingerprint } from '../backend/retry-authorization.js';
import { loadWorkerRegistryRecord } from '../backend/worker-registry.js';
import type { TaskRecord } from '../shared/types.js';
import {
  objectSchema,
  rejectUnknownFields,
  requireEnum,
  requireString,
} from './schemas.js';
import { McpError, mapCoreError } from './errors.js';
import type { McpTool, PmServerContext } from './server.js';

const ACTIVE_PLAN_STATES = new Set(['PLANNED', 'RUNNING', 'BLOCKED']);

function mapPlanError(err: unknown): never {
  if (err instanceof ExecutionPlanError) {
    throw new McpError(err.code === 'IO_FAILURE' ? 'INTERNAL_ERROR' : err.code, err.message);
  }
  throw mapCoreError(err);
}

function requireStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new McpError('INVALID_ARGUMENT', `필수 인자 누락 또는 형식 오류: ${name}`);
  }
  return value.map((item) => (item as string).trim());
}

function requireTaskBindings(args: Record<string, unknown>): ExecutionPlanTaskBinding[] {
  const value = args.taskBindings;
  if (!Array.isArray(value) || value.length === 0) {
    throw new McpError('INVALID_ARGUMENT', '필수 인자 누락 또는 형식 오류: taskBindings');
  }
  const bindings: ExecutionPlanTaskBinding[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new McpError('INVALID_ARGUMENT', 'taskBindings[] must be objects.');
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['taskId', 'workerId', 'workspaceRoot', 'scopeFingerprint'].includes(key)) {
        throw new McpError('INVALID_ARGUMENT', `허용되지 않은 인자: taskBindings[].${key}`);
      }
    }
    for (const required of ['taskId', 'workerId', 'workspaceRoot', 'scopeFingerprint'] as const) {
      if (typeof entry[required] !== 'string' || !(entry[required] as string).trim()) {
        throw new McpError('INVALID_ARGUMENT', `필수 인자 누락 또는 형식 오류: taskBindings[].${required}`);
      }
    }
    bindings.push({
      taskId: (entry.taskId as string).trim(),
      workerId: (entry.workerId as string).trim(),
      workspaceRoot: (entry.workspaceRoot as string).trim(),
      scopeFingerprint: (entry.scopeFingerprint as string).trim(),
    });
  }
  return bindings;
}

function assertTaskAvailableForPlan(
  dataRoot: string,
  project: string,
  taskId: string,
  binding: ExecutionPlanTaskBinding,
): TaskRecord {
  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, taskId);
  } catch (err) {
    throw mapCoreError(err);
  }
  if (task.executionState !== 'READY' || task.pmState !== 'PENDING') {
    throw new McpError(
      'INVALID_STATE',
      `Plan Task must be READY/PENDING before freeze (found ${task.executionState}/${task.pmState}).`,
    );
  }
  if (task.linkedRuns.length !== 0) {
    throw new McpError('CONFLICT', `Plan Task already has a Run and cannot be frozen: ${taskId}`);
  }
  const liveFingerprint = computeTaskScopeFingerprint(task);
  if (binding.scopeFingerprint !== liveFingerprint) {
    throw new McpError('INVALID_STATE', `Task scope fingerprint does not match authoritative Task content: ${taskId}`);
  }
  try {
    loadWorkerRegistryRecord(dataRoot, binding.workerId);
  } catch (err) {
    throw mapCoreError(err);
  }
  try {
    validateWorkspaceRoot(binding.workspaceRoot);
  } catch (err) {
    throw mapCoreError(err);
  }
  return task;
}

function assertTasksNotInActivePlan(dataRoot: string, project: string, taskIds: string[]): void {
  const wanted = new Set(taskIds);
  let plans: ExecutionPlanRecord[];
  try {
    plans = listExecutionPlans(dataRoot, project);
  } catch (err) {
    throw mapCoreError(err);
  }
  for (const plan of plans) {
    if (!ACTIVE_PLAN_STATES.has(plan.state)) continue;
    const overlap = plan.orderedTaskIds.find((taskId) => wanted.has(taskId));
    if (overlap) {
      throw new McpError(
        'CONFLICT',
        `Task ${overlap} already belongs to active ExecutionPlan ${plan.planId}.`,
      );
    }
  }
}

function boundedPlanView(dataRoot: string, project: string, plan: ExecutionPlanRecord) {
  const tasks = plan.orderedTaskIds.map((taskId) => {
    try {
      const task = getTask(dataRoot, project, taskId);
      return {
        taskId,
        executionState: task.executionState,
        pmState: task.pmState,
        linkedRunCount: task.linkedRuns.length,
        ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
      };
    } catch {
      return { taskId, unreadable: true as const };
    }
  });
  return {
    planId: plan.planId,
    title: plan.title,
    state: plan.state,
    orderedTaskIds: [...plan.orderedTaskIds],
    activeTaskId: plan.activeTaskId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(plan.completedAt ? { completedAt: plan.completedAt } : {}),
    ...(plan.terminalAt ? { terminalAt: plan.terminalAt } : {}),
    ...(plan.terminalReason ? { terminalReason: plan.terminalReason.slice(0, 200) } : {}),
    ...(plan.block ? {
      block: {
        code: plan.block.code,
        reason: plan.block.reason.slice(0, 200),
        at: plan.block.at,
        ...(plan.block.taskId ? { taskId: plan.block.taskId } : {}),
      },
    } : {}),
    tasks,
  };
}

function buildOwnerAuthorizationFromFrozenPlan(plan: ExecutionPlanRecord) {
  return {
    authorizationId: `owner-go:${plan.planId}:${crypto.randomUUID()}`,
    approvedAt: new Date().toISOString(),
    approvedBy: 'OWNER' as const,
    planScopeFingerprint: computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(
      plan.taskBindings.map((binding) => [binding.taskId, binding.scopeFingerprint]),
    ),
  };
}

/** Read tools: Plan status only. */
export function buildExecutionPlanReadTools(ctx: PmServerContext): McpTool[] {
  const { dataRoot, project } = ctx;
  return [
    {
      name: 'relay_pm_get_execution_plan',
      description:
        'V1.5: read bounded ExecutionPlan orchestration state by planId. ' +
        'Returns identity, state, ordered Task IDs, active cursor, and high-level per-Task states. ' +
        'Does NOT return prompts, results, transcripts, credentials, or CoT/session logs. ' +
        'Task Result review remains relay_pm_get_verification_context.',
      inputSchema: objectSchema({ planId: { type: 'string' } }, ['planId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['planId']);
        try {
          const plan = getExecutionPlan(dataRoot, project, requireString(args, 'planId'));
          return boundedPlanView(dataRoot, project, plan);
        } catch (err) {
          mapPlanError(err);
        }
      },
    },
  ];
}

/** Write tools: create / Owner GO / explicit reconcile. */
export function buildExecutionPlanWriteTools(ctx: PmServerContext): McpTool[] {
  const { dataRoot, project } = ctx;
  return [
    {
      name: 'relay_pm_create_execution_plan',
      description:
        'V1.5: create ONE frozen sequential ExecutionPlan from ALREADY EXISTING Tasks. ' +
        'Caller supplies title, orderedTaskIds, and taskBindings (taskId/workerId/workspaceRoot/scopeFingerprint). ' +
        'Server validates authoritative Task state/content, Worker registry, and workspace. ' +
        'Does NOT accept Plan state, activeTaskId, authorization fingerprints, timestamps, or out-of-plan bindings. ' +
        'Does NOT dispatch. Owner GO is a separate tool.',
      inputSchema: objectSchema(
        {
          title: { type: 'string' },
          orderedTaskIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          taskBindings: {
            type: 'array',
            minItems: 1,
            items: objectSchema(
              {
                taskId: { type: 'string' },
                workerId: { type: 'string' },
                workspaceRoot: { type: 'string' },
                scopeFingerprint: { type: 'string' },
              },
              ['taskId', 'workerId', 'workspaceRoot', 'scopeFingerprint'],
            ),
          },
        },
        ['title', 'orderedTaskIds', 'taskBindings'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['title', 'orderedTaskIds', 'taskBindings']);
        const title = requireString(args, 'title');
        const orderedTaskIds = requireStringArray(args, 'orderedTaskIds');
        const taskBindings = requireTaskBindings(args);
        if (new Set(orderedTaskIds).size !== orderedTaskIds.length) {
          throw new McpError('INVALID_ARGUMENT', 'orderedTaskIds must not contain duplicates.');
        }
        if (taskBindings.length !== orderedTaskIds.length) {
          throw new McpError('INVALID_ARGUMENT', 'Each ordered Task must have exactly one binding.');
        }
        const bindingIds = taskBindings.map((binding) => binding.taskId);
        if (new Set(bindingIds).size !== bindingIds.length) {
          throw new McpError('INVALID_ARGUMENT', 'taskBindings must not contain duplicate taskId values.');
        }
        for (const taskId of orderedTaskIds) {
          const binding = taskBindings.find((candidate) => candidate.taskId === taskId);
          if (!binding) {
            throw new McpError('INVALID_ARGUMENT', `Missing binding for ordered Task: ${taskId}`);
          }
        }
        for (const binding of taskBindings) {
          if (!orderedTaskIds.includes(binding.taskId)) {
            throw new McpError('INVALID_ARGUMENT', `Out-of-plan binding rejected: ${binding.taskId}`);
          }
        }
        assertTasksNotInActivePlan(dataRoot, project, orderedTaskIds);
        for (const taskId of orderedTaskIds) {
          const binding = taskBindings.find((candidate) => candidate.taskId === taskId)!;
          assertTaskAvailableForPlan(dataRoot, project, taskId, binding);
        }
        try {
          const plan = await createExecutionPlan(dataRoot, project, {
            title,
            orderedTaskIds,
            taskBindings,
          });
          return {
            planId: plan.planId,
            state: plan.state,
            orderedTaskIds: [...plan.orderedTaskIds],
            activeTaskId: plan.activeTaskId,
            createdAt: plan.createdAt,
          };
        } catch (err) {
          mapPlanError(err);
        }
      },
    },
    {
      name: 'relay_pm_dispatch_execution_plan_owner_approved',
      description:
        'V1.5: ONE Owner GO for a frozen ExecutionPlan. Starts PLANNED→RUNNING and dispatches the first ' +
        'frozen Task using Plan bindings only. Caller supplies planId + expectedPlanState=PLANNED. ' +
        'Cannot override first Task, Worker, workspace, scope, ordering, or Plan fingerprint — ' +
        'authorization evidence is derived server-side from the frozen Plan. ' +
        'Duplicate GO does not create another Run. Successors after ACCEPT do not consume Owner GO.',
      inputSchema: objectSchema(
        {
          planId: { type: 'string' },
          expectedPlanState: { type: 'string', enum: ['PLANNED'] },
        },
        ['planId', 'expectedPlanState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['planId', 'expectedPlanState']);
        const planId = requireString(args, 'planId');
        requireEnum(args, 'expectedPlanState', ['PLANNED'] as const);
        try {
          const plan = getExecutionPlan(dataRoot, project, planId);
          const result = await dispatchExecutionPlanOwnerApproved(dataRoot, project, {
            planId,
            expectedPlanState: 'PLANNED',
            ownerAuthorization: buildOwnerAuthorizationFromFrozenPlan(plan),
          });
          const after = result.plan;
          if (result.outcome === 'DISPATCHED') {
            return {
              outcome: result.outcome,
              planId: after.planId,
              state: after.state,
              activeTaskId: after.activeTaskId,
              runId: result.dispatch.runId,
              taskId: result.dispatch.taskId,
            };
          }
          return {
            outcome: result.outcome,
            planId: after.planId,
            state: after.state,
            activeTaskId: after.activeTaskId,
            ...(result.existingRunId ? { runId: result.existingRunId } : {}),
          };
        } catch (err) {
          mapPlanError(err);
        }
      },
    },
    {
      name: 'relay_pm_reconcile_execution_plan',
      description:
        'V1.5: explicit bounded ExecutionPlan reconciliation after restart/interruption. ' +
        'Input is planId only. Uses the canonical Slice 4 reconcileExecutionPlan engine. ' +
        'Caller cannot choose successor Task, Run, Worker, workspace, cursor, or target Plan state. ' +
        'Recovery tool — not part of the normal ACCEPT loop.',
      inputSchema: objectSchema({ planId: { type: 'string' } }, ['planId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['planId']);
        try {
          const result = await reconcileExecutionPlan(dataRoot, project, requireString(args, 'planId'));
          return {
            status: result.status,
            planId: result.planId,
            activeTaskId: result.activeTaskId,
            actionTaken: result.actionTaken,
            ...(result.observedRunId ? { observedRunId: result.observedRunId } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.staleLockRecovered ? { staleLockRecovered: true } : {}),
          };
        } catch (err) {
          mapPlanError(err);
        }
      },
    },
  ];
}
