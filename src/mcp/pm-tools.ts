/**
 * PM-facing MCP tool registration (Phase E + Phase F).
 *
 * Read tools + explicit B2 CAS commands only.
 *   NO relay_pm_transition_pm (Architecture Review: defer generic transition).
 *   NO raw updateTask/updateGoal.
 *   NO raw evidence:create / event:create.
 * Scope (dataRoot, project) is process configuration — never a tool argument.
 *
 * CAS fields (expectedPmState, expectedExecutionState, expectedStatus) are
 * REQUIRED at the MCP boundary. Stale expected state → CONFLICT.
 *
 * Phase F: relay_pm_get_context_for_event — pure read facade over pm-gateway.
 */
import * as goalTask from '../backend/goal-task.js';
import * as goalTaskRuntime from '../backend/goal-task-runtime.js';
import * as evidence from '../backend/evidence.js';
import * as eventKernel from '../backend/event.js';
import * as pmGateway from '../backend/pm-gateway.js';
import * as dispatcher from '../backend/dispatcher.js';
import * as pmWork from '../backend/pm-work.js';
import * as orphanResolution from '../backend/orphan-resolution.js';
import { authorizeEffect, PermissionDeniedError } from '../backend/permission-gate.js';
import type { GoalStatus, TaskPmState, TaskExecutionState, EventDeliveryStatus } from '../shared/types.js';
import {
  objectSchema,
  optionalString,
  rejectUnknownFields,
  requireEnum,
  requireString,
} from './schemas.js';
import { McpError, mapCoreError } from './errors.js';
import type { McpTool, PmServerContext } from './server.js';

const PM_STATES: readonly TaskPmState[] = ['PENDING', 'VERIFYING', 'CHANGES_REQUESTED', 'ACCEPTED'];
const EXEC_STATES: readonly TaskExecutionState[] = [
  'PLANNED', 'READY', 'DISPATCHED', 'RUNNING', 'RESULT_RECEIVED', 'BLOCKED', 'CANCELLED', 'FAILED',
];
const DELIVERY_STATUSES: readonly EventDeliveryStatus[] = ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED'];
const GOAL_STATUSES: readonly GoalStatus[] = [
  'PLANNING', 'ACTIVE', 'WAITING_OWNER', 'BLOCKED', 'COMPLETED', 'ABANDONED',
];
const ORPHAN_ACTIONS = ['KEEP_WAITING', 'CONFIRM_FAILED', 'CONFIRM_CANCELLED'] as const;

function loadGoalPolicy(dataRoot: string, project: string, goalId: string) {
  try {
    return goalTask.getGoal(dataRoot, project, goalId).permissionPolicy ?? { mode: 'PLAN' as const };
  } catch {
    return { mode: 'PLAN' as const };
  }
}

function mapPermissionError(err: unknown): never {
  if (err instanceof PermissionDeniedError) {
    throw new McpError('FORBIDDEN', err.message);
  }
  throw mapCoreError(err);
}

// ── PM read tools ────────────────────────────────────────────────────────────

/** PM read tools — no state mutation. */
export function buildPmReadTools(ctx: PmServerContext): McpTool[] {
  const { dataRoot, project } = ctx;
  return [
    {
      name: 'relay_pm_get_goal',
      description: 'Read a Goal record by goalId.',
      inputSchema: objectSchema({ goalId: { type: 'string' } }, ['goalId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId']);
        return goalTask.getGoal(dataRoot, project, requireString(args, 'goalId'));
      },
    },
    {
      name: 'relay_pm_list_goals',
      description: 'List all Goal records for the scoped project.',
      inputSchema: objectSchema({}),
      handler: async (args) => {
        rejectUnknownFields(args, []);
        return { project, goals: goalTask.listGoals(dataRoot, project) };
      },
    },
    {
      name: 'relay_pm_list_tasks',
      description: 'List Task records for the scoped project (optionally filtered by goalId).',
      inputSchema: objectSchema({ goalId: { type: 'string' } }),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId']);
        return { project, tasks: goalTask.listTasks(dataRoot, project, optionalString(args, 'goalId')) };
      },
    },
    {
      name: 'relay_pm_get_task',
      description: 'Read a Task record by taskId.',
      inputSchema: objectSchema({ taskId: { type: 'string' } }, ['taskId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId']);
        return goalTask.getTask(dataRoot, project, requireString(args, 'taskId'));
      },
    },
    {
      name: 'relay_pm_get_run',
      description: 'Read run metadata for a given runId (looks up via linked task).',
      inputSchema: objectSchema({ runId: { type: 'string' } }, ['runId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['runId']);
        const runId = requireString(args, 'runId');
        const task = goalTask.findTaskByRunId(dataRoot, project, runId);
        if (!task) {
          throw new McpError('NOT_FOUND', `Run '${runId}' 찾을 수 없습니다.`);
        }
        const link = task.linkedRuns.find((r) => r.runId === runId);
        if (!link) {
          throw new McpError('NOT_FOUND', `Run '${runId}' 링크가 존재하지 않습니다.`);
        }
        return {
          runId: link.runId,
          folder: link.folder,
          taskRunSequence: link.taskRunSequence,
          agent: link.agent,
          date: link.date,
          taskId: task.taskId,
          goalId: task.goalId,
          project,
        };
      },
    },
    {
      name: 'relay_pm_get_task_evidence',
      description: 'Read the Evidence summary for a Task (counts per trust level).',
      inputSchema: objectSchema({ taskId: { type: 'string' } }, ['taskId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId']);
        const taskId = requireString(args, 'taskId');
        goalTask.getTask(dataRoot, project, taskId); // throws NOT_FOUND before evidence listing
        return evidence.getTaskEvidenceSummary(dataRoot, project, taskId);
      },
    },
    {
      name: 'relay_pm_get_event',
      description: 'Read a single Event record by eventId.',
      inputSchema: objectSchema({ eventId: { type: 'string' } }, ['eventId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['eventId']);
        return eventKernel.getEvent(dataRoot, project, requireString(args, 'eventId'));
      },
    },
    {
      name: 'relay_pm_list_pending_events',
      description: 'List Events pending PM attention (pmAttentionRequired + deliveryStatus PENDING).',
      inputSchema: objectSchema({}),
      handler: async (args) => {
        rejectUnknownFields(args, []);
        const res = eventKernel.listPendingPmEventsWithWarnings(dataRoot, project);
        return { project, events: res.events, warnings: res.warnings };
      },
    },
    {
      name: 'relay_pm_get_goal_runtime_state',
      description: 'Read full runtime state for a Goal (tasks, readiness, completion eligibility).',
      inputSchema: objectSchema({ goalId: { type: 'string' } }, ['goalId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId']);
        return goalTaskRuntime.getGoalRuntimeState(dataRoot, project, requireString(args, 'goalId'));
      },
    },
    {
      name: 'relay_pm_get_context_for_event',
      description:
        'Phase F PM Gateway: compose a deterministic read-only PM context packet for the given eventId. ' +
        'Returns Event, delivery snapshot, CAS, allowedActions, and profile-driven context. ' +
        'PURE READ — does NOT mark the event as delivered, mutate Task/Goal/Evidence, or invoke GPT.',
      inputSchema: objectSchema({ eventId: { type: 'string' } }, ['eventId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['eventId']);
        return pmGateway.getContextForEvent(dataRoot, project, requireString(args, 'eventId'));
      },
    },
    {
      name: 'relay_pm_list_workers',
      description:
        'Phase G: list trusted Worker Registry entries (public safe view). ' +
        'Does NOT expose launchCommand, workingDirectory, or environment.',
      inputSchema: objectSchema({}),
      handler: async (args) => {
        rejectUnknownFields(args, []);
        return { workers: dispatcher.listWorkersPublic(dataRoot) };
      },
    },
    {
      name: 'relay_pm_get_next_work',
      description:
        'Phase H: pure derived work discovery (get_next_work). No writes, no claiming, no dispatch. ' +
        'Returns bounded work items (logical IDs only).',
      inputSchema: objectSchema({}, []),
      handler: async (args) => {
        rejectUnknownFields(args, []);
        try {
          return pmWork.getNextWork(dataRoot, project);
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_get_dispatch_status',
      description:
        'Phase G: read Dispatcher status for a Task (active dispatch + process-local recovery). ' +
        'Logical IDs only — no folder/path/launchCommand.',
      inputSchema: objectSchema({ taskId: { type: 'string' } }, ['taskId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId']);
        return dispatcher.getDispatchStatus(dataRoot, project, requireString(args, 'taskId'));
      },
    },
  ];
}

// ── PM write tools ────────────────────────────────────────────────────────────

/**
 * PM write tools — explicit CAS commands only.
 *
 * relay_pm_transition_pm is intentionally EXCLUDED (Architecture Review: defer
 * generic PM transition; expose only explicit domain commands).
 *
 * Every mutation goes through goal-task-runtime or event-kernel which owns
 * expected-state comparison and atomic transitions.
 *
 * CAS fields are REQUIRED at MCP boundary:
 *   acceptResult  → expectedPmState + expectedExecutionState
 *   requestChanges → expectedPmState
 *   requestRetry   → expectedPmState + expectedExecutionState
 *   event delivery → expectedStatus
 */
export function buildPmWriteTools(ctx: PmServerContext): McpTool[] {
  const { dataRoot, project } = ctx;
  return [
    {
      name: 'relay_pm_activate_goal',
      description:
        'Phase I3: transition a PLANNING Goal to ACTIVE. ' +
        'Requires expectedGoalStatus="PLANNING" CAS guard — any other value is rejected. ' +
        'Stale expected state → CONFLICT. ' +
        'Does NOT dispatch Tasks, create Tasks, complete the Goal, or start any automated loop. ' +
        'The PM remains in full control of subsequent dispatch decisions.',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          expectedGoalStatus: { type: 'string', enum: ['PLANNING'] },
          reason: { type: 'string' },
        },
        ['goalId', 'expectedGoalStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'expectedGoalStatus', 'reason']);
        const goalId = requireString(args, 'goalId');
        const expectedGoalStatus = requireEnum(args, 'expectedGoalStatus', ['PLANNING'] as const);
        try {
          return goalTaskRuntime.activateGoal(dataRoot, project, goalId, {
            expectedGoalStatus,
            reason: optionalString(args, 'reason'),
          });
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_accept_result',
      description:
        'Accept a Task result by runId. Requires expectedPmState and expectedExecutionState CAS guards. ' +
        'Stale expected state → CONFLICT.',
      inputSchema: objectSchema(
        {
          taskId: { type: 'string' },
          runId: { type: 'string' },
          reason: { type: 'string' },
          expectedPmState: { type: 'string', enum: PM_STATES },
          expectedExecutionState: { type: 'string', enum: EXEC_STATES },
        },
        ['taskId', 'runId', 'expectedPmState', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'runId', 'reason', 'expectedPmState', 'expectedExecutionState']);
        return goalTaskRuntime.acceptResult(
          dataRoot, project,
          requireString(args, 'taskId'),
          requireString(args, 'runId'),
          {
            reason: optionalString(args, 'reason'),
            expectedPmState: requireEnum(args, 'expectedPmState', PM_STATES),
            expectedExecutionState: requireEnum(args, 'expectedExecutionState', EXEC_STATES),
          },
        );
      },
    },
    {
      name: 'relay_pm_request_changes',
      description:
        'Request changes for a Task. Resets to CHANGES_REQUESTED. Requires expectedPmState CAS guard. ' +
        'Stale expected state → CONFLICT.',
      inputSchema: objectSchema(
        {
          taskId: { type: 'string' },
          reason: { type: 'string' },
          expectedPmState: { type: 'string', enum: PM_STATES },
        },
        ['taskId', 'expectedPmState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'reason', 'expectedPmState']);
        return goalTaskRuntime.requestChanges(
          dataRoot, project,
          requireString(args, 'taskId'),
          {
            reason: optionalString(args, 'reason'),
            expectedPmState: requireEnum(args, 'expectedPmState', PM_STATES),
          },
        );
      },
    },
    {
      name: 'relay_pm_request_retry',
      description:
        'Reset RESULT_RECEIVED+CHANGES_REQUESTED Task back to READY+PENDING for a fresh attempt. ' +
        'Requires expectedPmState + expectedExecutionState CAS guards. Stale → CONFLICT.',
      inputSchema: objectSchema(
        {
          taskId: { type: 'string' },
          reason: { type: 'string' },
          expectedExecutionState: { type: 'string', enum: EXEC_STATES },
          expectedPmState: { type: 'string', enum: PM_STATES },
        },
        ['taskId', 'expectedPmState', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'reason', 'expectedExecutionState', 'expectedPmState']);
        return goalTaskRuntime.requestRetry(
          dataRoot, project,
          requireString(args, 'taskId'),
          {
            reason: optionalString(args, 'reason'),
            expectedExecutionState: requireEnum(args, 'expectedExecutionState', EXEC_STATES),
            expectedPmState: requireEnum(args, 'expectedPmState', PM_STATES),
          },
        );
      },
    },
    {
      name: 'relay_pm_mark_delivered',
      description:
        'Mark an Event as DELIVERED (PM has been notified). Requires expectedStatus CAS guard.',
      inputSchema: objectSchema(
        {
          eventId: { type: 'string' },
          expectedStatus: { type: 'string', enum: DELIVERY_STATUSES },
        },
        ['eventId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['eventId', 'expectedStatus']);
        return eventKernel.markDelivered(
          dataRoot, project,
          requireString(args, 'eventId'),
          requireEnum(args, 'expectedStatus', DELIVERY_STATUSES),
        );
      },
    },
    {
      name: 'relay_pm_acknowledge',
      description:
        'Acknowledge an Event (PM has reviewed and accepted). Terminal state. Requires expectedStatus CAS.',
      inputSchema: objectSchema(
        {
          eventId: { type: 'string' },
          expectedStatus: { type: 'string', enum: DELIVERY_STATUSES },
        },
        ['eventId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['eventId', 'expectedStatus']);
        return eventKernel.acknowledge(
          dataRoot, project,
          requireString(args, 'eventId'),
          requireEnum(args, 'expectedStatus', DELIVERY_STATUSES),
        );
      },
    },
    {
      name: 'relay_pm_ignore',
      description:
        'Ignore an Event (PM dismisses without action). Terminal state. Requires expectedStatus CAS.',
      inputSchema: objectSchema(
        {
          eventId: { type: 'string' },
          expectedStatus: { type: 'string', enum: DELIVERY_STATUSES },
        },
        ['eventId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['eventId', 'expectedStatus']);
        return eventKernel.ignore(
          dataRoot, project,
          requireString(args, 'eventId'),
          requireEnum(args, 'expectedStatus', DELIVERY_STATUSES),
        );
      },
    },
    {
      name: 'relay_pm_dispatch_task',
      description:
        'Phase G/H: explicitly dispatch a READY Task to a trusted workerId with workspaceRoot. ' +
        'Permission gate: PLAN=FORBIDDEN for PM_MCP; APPROVE/BYPASS allowed. ' +
        'Dispatcher owns READY→DISPATCHED and DISPATCHED→RUNNING. No auto-dispatch. ' +
        'Response is logical IDs only (no folder/path/launchCommand).',
      inputSchema: objectSchema(
        {
          taskId: { type: 'string' },
          workerId: { type: 'string' },
          workspaceRoot: { type: 'string' },
          expectedExecutionState: { type: 'string', enum: ['READY'] },
        },
        ['taskId', 'workerId', 'workspaceRoot', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'workerId', 'workspaceRoot', 'expectedExecutionState']);
        const expectedExecutionState = requireEnum(args, 'expectedExecutionState', ['READY'] as const);
        const taskId = requireString(args, 'taskId');
        try {
          const task = goalTask.getTask(dataRoot, project, taskId);
          const policy = loadGoalPolicy(dataRoot, project, task.goalId);
          authorizeEffect({
            effect: 'DISPATCH',
            callerSurface: 'PM_MCP',
            permissionPolicy: policy,
          });
          return await dispatcher.dispatchTask(dataRoot, project, {
            taskId,
            workerId: requireString(args, 'workerId'),
            workspaceRoot: requireString(args, 'workspaceRoot'),
            expectedExecutionState,
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
    {
      name: 'relay_pm_complete_goal',
      description:
        'Phase H: complete a Goal when eligible. Requires expectedGoalStatus CAS. ' +
        'Permission gate: PLAN=FORBIDDEN for PM_MCP; APPROVE/BYPASS allowed. ' +
        'Re-evaluates eligibility at mutation time. Emits GOAL_COMPLETED Event.',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          expectedGoalStatus: { type: 'string', enum: GOAL_STATUSES },
          reason: { type: 'string' },
        },
        ['goalId', 'expectedGoalStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'expectedGoalStatus', 'reason']);
        const goalId = requireString(args, 'goalId');
        const expectedGoalStatus = requireEnum(args, 'expectedGoalStatus', GOAL_STATUSES);
        try {
          const policy = loadGoalPolicy(dataRoot, project, goalId);
          authorizeEffect({
            effect: 'COMPLETE_GOAL',
            callerSurface: 'PM_MCP',
            permissionPolicy: policy,
          });
          const goal = goalTaskRuntime.completeGoalWithExpected(dataRoot, project, goalId, {
            expectedGoalStatus,
            reason: optionalString(args, 'reason'),
          });
          try {
            await eventKernel.recordGoalCompleted(dataRoot, project, {
              summary: `Goal ${goalId} completed`,
              goalId,
              source: { kind: 'pm-mcp', subsystem: 'complete_goal' },
              details: { expectedGoalStatus, status: goal.status },
              sourceEventId: `goal-completed:${project}:${goalId}:${goal.updatedAt}`,
            });
          } catch { /* Event best-effort after successful complete */ }
          return goal;
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
    {
      name: 'relay_pm_resolve_orphan',
      description:
        'Phase H: orphan recovery decision. PM_MCP may only KEEP_WAITING. ' +
        'CONFIRM_FAILED / CONFIRM_CANCELLED are denied for PM even in BYPASS.',
      inputSchema: objectSchema(
        {
          taskId: { type: 'string' },
          action: { type: 'string', enum: ORPHAN_ACTIONS },
          expectedExecutionState: { type: 'string', enum: ['DISPATCHED', 'RUNNING'] },
          reason: { type: 'string' },
        },
        ['taskId', 'action'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'action', 'expectedExecutionState', 'reason']);
        const action = requireEnum(args, 'action', ORPHAN_ACTIONS);
        try {
          return await orphanResolution.resolveOrphan({
            dataRoot,
            project,
            taskId: requireString(args, 'taskId'),
            action,
            callerSurface: 'PM_MCP',
            expectedExecutionState: args.expectedExecutionState !== undefined
              ? requireEnum(args, 'expectedExecutionState', ['DISPATCHED', 'RUNNING'] as const)
              : undefined,
            reason: optionalString(args, 'reason'),
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
  ];
}

/** All PM tools (read + write). No Worker tools included. */
export function buildAllPmTools(ctx: PmServerContext): McpTool[] {
  return [...buildPmReadTools(ctx), ...buildPmWriteTools(ctx)];
}
