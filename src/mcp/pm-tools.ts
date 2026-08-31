/**
 * PM-facing MCP tool registration (Phase E).
 *
 * Read tools + explicit B2 CAS commands only.
 *   NO relay_pm_transition_pm (Architecture Review: defer generic transition).
 *   NO raw updateTask/updateGoal.
 *   NO raw evidence:create / event:create.
 * Scope (dataRoot, project) is process configuration — never a tool argument.
 *
 * CAS fields (expectedPmState, expectedExecutionState, expectedStatus) are
 * REQUIRED at the MCP boundary. Stale expected state → CONFLICT.
 */
import * as goalTask from '../backend/goal-task.js';
import * as goalTaskRuntime from '../backend/goal-task-runtime.js';
import * as evidence from '../backend/evidence.js';
import * as eventKernel from '../backend/event.js';
import type { TaskPmState, TaskExecutionState, EventDeliveryStatus } from '../shared/types.js';
import {
  objectSchema,
  optionalString,
  rejectUnknownFields,
  requireEnum,
  requireString,
} from './schemas.js';
import { McpError } from './errors.js';
import type { McpTool, PmServerContext } from './server.js';

const PM_STATES: readonly TaskPmState[] = ['PENDING', 'VERIFYING', 'CHANGES_REQUESTED', 'ACCEPTED'];
const EXEC_STATES: readonly TaskExecutionState[] = [
  'PLANNED', 'READY', 'DISPATCHED', 'RUNNING', 'RESULT_RECEIVED', 'BLOCKED', 'CANCELLED',
];
const DELIVERY_STATUSES: readonly EventDeliveryStatus[] = ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED'];

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
  ];
}

/** All PM tools (read + write). No Worker tools included. */
export function buildAllPmTools(ctx: PmServerContext): McpTool[] {
  return [...buildPmReadTools(ctx), ...buildPmWriteTools(ctx)];
}
