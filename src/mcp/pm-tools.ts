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
import * as v1Intake from '../backend/v1-intake.js';
import * as v1Dispatch from '../backend/v1-dispatch.js';
import * as pmDelivery from '../backend/pm-delivery.js';
import * as pmVerificationContext from '../backend/pm-verification-context.js';
import * as pmJudgment from '../backend/pm-judgment.js';
import * as retryPreparation from '../backend/retry-preparation.js';
import * as retryDispatch from '../backend/retry-dispatch.js';
import * as orphanResolution from '../backend/orphan-resolution.js';
import * as completedRunRecovery from '../backend/completed-run-recovery.js';
import * as taskActions from '../backend/task-actions.js';
import { startGoalLoop } from '../backend/goal-loop.js';
import { authorizeEffect, PermissionDeniedError } from '../backend/permission-gate.js';
import type { GoalStatus, EventDeliveryStatus } from '../shared/types.js';
import {
  objectSchema,
  optionalString,
  rejectUnknownFields,
  requireEnum,
  requireString,
} from './schemas.js';
import { McpError, mapCoreError } from './errors.js';
import type { McpTool, PmServerContext } from './server.js';
import { buildPmWakeTools } from './app/pm-wake-tools.js';
import { buildExecutionPlanReadTools, buildExecutionPlanWriteTools } from './execution-plan-tools.js';

// Phase I3F-2: accept/changes/retry CAS values are frozen single-value enums
// (no permissive multi-state compatibility) — see ACCEPT_EXEC_ONLY etc. below.
const ACCEPT_EXEC_ONLY = ['RESULT_RECEIVED'] as const;
const ACCEPT_PM_ONLY = ['VERIFYING'] as const;
const RETRY_PM_ONLY = ['CHANGES_REQUESTED'] as const;
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
    ...buildExecutionPlanReadTools(ctx),
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
      name: 'relay_pm_list_pending_deliveries',
      description:
        'V1-G4-A: list durable PM Delivery records awaiting host consumption ' +
        '(status PENDING or DELIVERED-awaiting-ACK). Terminal ACKNOWLEDGED/IGNORED never resurface. ' +
        'Identity/state only — no result text. Pure read.',
      inputSchema: objectSchema({}),
      handler: async (args) => {
        rejectUnknownFields(args, []);
        try {
          await pmDelivery.reconcileFinalizedPmDeliveries(dataRoot, project);
          return { project, deliveries: pmDelivery.listPendingPmDeliveries(dataRoot, project) };
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_get_delivery',
      description:
        'V1-G4-A: read one durable PM Delivery record by deliveryId. ' +
        'Identity/state only — no result text. Pure read.',
      inputSchema: objectSchema({ deliveryId: { type: 'string' } }, ['deliveryId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId']);
        try {
          return pmDelivery.getPmDelivery(dataRoot, project, requireString(args, 'deliveryId'));
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_get_verification_context',
      description:
        'V1-G4-B: compose ONE bounded verification packet for a pending TASK_VERIFY PM Delivery. ' +
        'Input is deliveryId only — the Delivery owns Task/run identity; no taskId/runId/path injection. ' +
        'Includes bounded result text (result.md, agent-result.md fallback), Task context, exact-run ' +
        'Evidence, current-attempt safety, advisory CAS and review actions. ' +
        'PURE READ — never marks DELIVERED/ACKs, never judges, never dispatches.',
      inputSchema: objectSchema({ deliveryId: { type: 'string' } }, ['deliveryId']),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId']);
        try {
          return pmVerificationContext.getVerificationContextForDelivery(
            dataRoot, project, requireString(args, 'deliveryId'),
          );
        } catch (err) {
          throw mapCoreError(err);
        }
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
  const tools: McpTool[] = [
    ...buildExecutionPlanWriteTools(ctx),
    {
      name: 'relay_pm_create_task',
      description:
        'V1-G1 PM Task intake: create ONE canonical V1 Task from a finalized Task Contract. ' +
        'The mandatory goalId is handled internally via a deterministic V1 technical container Goal ' +
        '(create/reuse, no manual Goal management). ' +
        'Task is prepared to READY+PENDING via the frozen PLANNED→READY transition for the next dispatch stage. ' +
        'Does NOT dispatch, accept, complete any Goal, or orchestrate. ' +
        'Runtime fields (goalId/executionState/pmState/runId/paths) are not accepted.',
      inputSchema: objectSchema(
        {
          title: { type: 'string' },
          goal: { type: 'string' },
          reason: { type: 'string' },
          scope: { type: 'string' },
          completionCriteria: { type: 'array', items: { type: 'string' } },
        },
        ['title', 'goal', 'reason', 'scope'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['title', 'goal', 'reason', 'scope', 'completionCriteria']);
        const title = requireString(args, 'title');
        const goalText = requireString(args, 'goal');
        if (typeof args.reason !== 'string') {
          throw new McpError('INVALID_ARGUMENT', '필수 인자 누락 또는 형식 오류: reason');
        }
        if (typeof args.scope !== 'string') {
          throw new McpError('INVALID_ARGUMENT', '필수 인자 누락 또는 형식 오류: scope');
        }
        let completionCriteria: string[] | undefined;
        if (args.completionCriteria !== undefined) {
          if (!Array.isArray(args.completionCriteria) || !args.completionCriteria.every((x) => typeof x === 'string')) {
            throw new McpError('INVALID_ARGUMENT', '잘못된 인자 형식: completionCriteria');
          }
          completionCriteria = [...(args.completionCriteria as string[])];
        }
        try {
          return await v1Intake.createV1TaskFromContract(dataRoot, project, {
            title,
            goal: goalText,
            reason: args.reason as string,
            scope: args.scope as string,
            ...(completionCriteria !== undefined ? { completionCriteria } : {}),
          });
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
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
        'Phase I3F-2: canonical Accept Result. Requires goalId + runId + REQUIRED dual CAS ' +
        '(expectedExecutionState=RESULT_RECEIVED, expectedPmState=VERIFYING). No optional CAS. ' +
        'runId must be the current (latest) attempt — historical/stale Run is rejected. ' +
        'Permission gate: PLAN/APPROVE/BYPASS all allow PM_MCP. Stale CAS → CONFLICT (no write).',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          taskId: { type: 'string' },
          runId: { type: 'string' },
          reason: { type: 'string' },
          expectedPmState: { type: 'string', enum: ACCEPT_PM_ONLY },
          expectedExecutionState: { type: 'string', enum: ACCEPT_EXEC_ONLY },
        },
        ['goalId', 'taskId', 'runId', 'expectedPmState', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'taskId', 'runId', 'reason', 'expectedPmState', 'expectedExecutionState']);
        try {
          return await taskActions.acceptTaskResult({
            dataRoot, project,
            goalId: requireString(args, 'goalId'),
            taskId: requireString(args, 'taskId'),
            runId: requireString(args, 'runId'),
            reason: optionalString(args, 'reason'),
            expectedPmState: requireEnum(args, 'expectedPmState', ACCEPT_PM_ONLY),
            expectedExecutionState: requireEnum(args, 'expectedExecutionState', ACCEPT_EXEC_ONLY),
            callerSurface: 'PM_MCP',
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
    {
      name: 'relay_pm_request_changes',
      description:
        'Phase I3F-2: canonical Request Changes. Resets VERIFYING → CHANGES_REQUESTED (execution stays ' +
        'RESULT_RECEIVED — Changes != Retry). Requires goalId + runId + REQUIRED dual CAS + bounded ' +
        'reason (10..2000 chars). runId must be the current attempt. Stale CAS → CONFLICT (no write).',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          taskId: { type: 'string' },
          runId: { type: 'string' },
          reason: { type: 'string', minLength: 10, maxLength: 2000 },
          expectedPmState: { type: 'string', enum: ACCEPT_PM_ONLY },
          expectedExecutionState: { type: 'string', enum: ACCEPT_EXEC_ONLY },
        },
        ['goalId', 'taskId', 'runId', 'reason', 'expectedPmState', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'taskId', 'runId', 'reason', 'expectedPmState', 'expectedExecutionState']);
        try {
          return await taskActions.requestTaskChanges({
            dataRoot, project,
            goalId: requireString(args, 'goalId'),
            taskId: requireString(args, 'taskId'),
            runId: requireString(args, 'runId'),
            reason: requireString(args, 'reason'),
            expectedPmState: requireEnum(args, 'expectedPmState', ACCEPT_PM_ONLY),
            expectedExecutionState: requireEnum(args, 'expectedExecutionState', ACCEPT_EXEC_ONLY),
            callerSurface: 'PM_MCP',
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
    {
      name: 'relay_pm_request_retry',
      description:
        'Phase I3F-2: canonical Retry. Reset RESULT_RECEIVED+CHANGES_REQUESTED Task back to READY+PENDING ' +
        'for a fresh attempt. Does NOT create a new Run or dispatch. Requires goalId + REQUIRED dual CAS ' +
        '(expectedExecutionState=RESULT_RECEIVED, expectedPmState=CHANGES_REQUESTED). Stale → CONFLICT.',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          taskId: { type: 'string' },
          reason: { type: 'string', maxLength: 500 },
          expectedExecutionState: { type: 'string', enum: ACCEPT_EXEC_ONLY },
          expectedPmState: { type: 'string', enum: RETRY_PM_ONLY },
        },
        ['goalId', 'taskId', 'expectedPmState', 'expectedExecutionState'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'taskId', 'reason', 'expectedExecutionState', 'expectedPmState']);
        try {
          return await taskActions.requestTaskRetry({
            dataRoot, project,
            goalId: requireString(args, 'goalId'),
            taskId: requireString(args, 'taskId'),
            reason: optionalString(args, 'reason'),
            expectedExecutionState: requireEnum(args, 'expectedExecutionState', ACCEPT_EXEC_ONLY),
            expectedPmState: requireEnum(args, 'expectedPmState', RETRY_PM_ONLY),
            callerSurface: 'PM_MCP',
          });
        } catch (err) {
          mapPermissionError(err);
        }
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
      name: 'relay_pm_dispatch_owner_approved',
      description:
        'V1-G2 owner-approved single dispatch: dispatch ONE READY Task to ONE trusted workerId ' +
        'with workspaceRoot. Represents the owner\'s explicit one-time "GO" for THIS Task dispatch only. ' +
        'The owning Goal permissionPolicy is NOT mutated and remains PLAN; authorization is enforced ' +
        'through the central permission gate with OWNER_IPC-equivalent semantics for this one DISPATCH ' +
        'effect only (no token, no persisted elevation, no other effect). ' +
        'Delegates to the canonical dispatcher.dispatchTask (Run materialization, READY→DISPATCHED→RUNNING, ' +
        'Capture arm, Worker spawn, observation binding). ' +
        'expectedExecutionState must be READY. No goalId/permission/runId/launch/CLI/env/shell inputs. ' +
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
        const workerId = requireString(args, 'workerId');
        const workspaceRoot = requireString(args, 'workspaceRoot');
        try {
          return await v1Dispatch.dispatchV1OwnerApproved(dataRoot, project, {
            taskId,
            workerId,
            workspaceRoot,
            expectedExecutionState,
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
    {
      name: 'relay_pm_mark_delivery_delivered',
      description:
        'V1-G4-A: mark a PENDING PM Delivery as DELIVERED (host has been given the delivery). ' +
        'Requires expectedStatus CAS guard. Identity/state only — no judgment, no context payload.',
      inputSchema: objectSchema(
        {
          deliveryId: { type: 'string' },
          expectedStatus: { type: 'string', enum: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED'] },
        },
        ['deliveryId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId', 'expectedStatus']);
        try {
          return await pmDelivery.markPmDeliveryDelivered(
            dataRoot, project,
            requireString(args, 'deliveryId'),
            requireEnum(args, 'expectedStatus', pmDelivery.PM_DELIVERY_STATUSES),
          );
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_ack_delivery',
      description:
        'V1-G4-A: acknowledge a DELIVERED PM Delivery (host consumed it). Terminal state. ' +
        'Requires expectedStatus CAS guard. ACK means consumed, never judged.',
      inputSchema: objectSchema(
        {
          deliveryId: { type: 'string' },
          expectedStatus: { type: 'string', enum: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED'] },
        },
        ['deliveryId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId', 'expectedStatus']);
        try {
          return await pmDelivery.acknowledgePmDelivery(
            dataRoot, project,
            requireString(args, 'deliveryId'),
            requireEnum(args, 'expectedStatus', pmDelivery.PM_DELIVERY_STATUSES),
          );
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_ignore_delivery',
      description:
        'V1-G4-A: ignore a PM Delivery (host dismisses without consuming). Terminal state. ' +
        'Legal from PENDING or DELIVERED. Requires expectedStatus CAS guard.',
      inputSchema: objectSchema(
        {
          deliveryId: { type: 'string' },
          expectedStatus: { type: 'string', enum: ['PENDING', 'DELIVERED', 'ACKNOWLEDGED', 'IGNORED'] },
        },
        ['deliveryId', 'expectedStatus'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId', 'expectedStatus']);
        try {
          return await pmDelivery.ignorePmDelivery(
            dataRoot, project,
            requireString(args, 'deliveryId'),
            requireEnum(args, 'expectedStatus', pmDelivery.PM_DELIVERY_STATUSES),
          );
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    },
    {
      name: 'relay_pm_submit_judgment',
      description:
        'V1-G5-A: submit a structured PM judgment for a TASK_VERIFY PM Delivery. ' +
        'ACCEPT applies the canonical acceptTaskResult; CHANGES validates and durably records intent only ' +
        '(retry preparation belongs to G5-B). Input is deliveryId + decision + bounded reason/retryInstruction; ' +
        'no taskId/runId/path injection. Same backend as the stdio host bridge.',
      inputSchema: objectSchema(
        {
          deliveryId: { type: 'string' },
          decision: { type: 'string', enum: ['ACCEPT', 'CHANGES'] },
          reason: { type: 'string' },
          retryInstruction: { type: 'string' },
        },
        ['deliveryId', 'decision'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['deliveryId', 'decision', 'reason', 'retryInstruction']);
        const reason = optionalString(args, 'reason');
        const retryInstruction = optionalString(args, 'retryInstruction');
        try {
          const submitted = await pmJudgment.submitPmJudgment(dataRoot, project, {
            deliveryId: requireString(args, 'deliveryId'),
            decision: requireEnum(args, 'decision', pmJudgment.PM_JUDGMENT_DECISIONS),
            ...(reason !== undefined ? { reason } : {}),
            ...(retryInstruction !== undefined ? { retryInstruction } : {}),
          });
          // V1-G5-B: one PM judgment drives intake + retry preparation.
          // CHANGES with a durable RECEIVED intent automatically continues to
          // READY+PENDING preparation here (no second manual PM command).
          // ACCEPT is already fully applied by the intake itself.
          if (submitted.judgment.decision === 'CHANGES') {
            const prepared = await retryPreparation.prepareRetryForJudgment(
              dataRoot, project, submitted.judgment.deliveryId,
            );
            const judgment = pmJudgment.getPmJudgment(dataRoot, project, submitted.judgment.judgmentId);
            // V1-G5-C: READY preparation automatically continues to same-Task
            // redispatch (no second owner GO). A redispatch failure returns a
            // bounded operational failure; the durable preparation stays
            // recoverable via retry-dispatch reconciliation.
            try {
              const redispatched = await retryDispatch.dispatchV1Retry(
                dataRoot, project, { deliveryId: submitted.judgment.deliveryId },
              );
              return {
                judgment,
                preparation: redispatched.preparation,
                task: redispatched.task,
                prepared: true,
                redispatch: {
                  ok: true,
                  retryRunId: redispatched.runId,
                  workerId: redispatched.workerId,
                  executionState: redispatched.executionState,
                  alreadyDispatched: redispatched.alreadyDispatched,
                },
              };
            } catch (err) {
              const code = (err as { code?: string } | null)?.code ?? 'REDISPATCH_FAILED';
              const message = err instanceof Error ? err.message : String(err);
              return {
                judgment,
                preparation: prepared.preparation,
                task: prepared.task,
                prepared: true,
                redispatch: { ok: false, code: String(code), message: message.slice(0, 500) },
              };
            }
          }
          return submitted;
        } catch (err) {
          throw mapCoreError(err);
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
    {
      name: 'relay_pm_recover_completed_run',
      description:
        'V1.5 Blocker Hotfix 02: recover a Run that completed successfully (Worker exit 0, ' +
        'durable terminal transcript boundary) while no live capture watch observed it, and ' +
        'promote it through the SAME canonical Result Bridge path a live observation would ' +
        'have used. Input is taskId + runId only — every other fact (transcript identity, ' +
        'workspace, exit status, Plan authorization) is derived canonically; the caller cannot ' +
        'supply transcript paths, result text, a delivery ID, or a desired Task state. ' +
        'Never replays the Worker. Idempotent: a second call on an already-recovered Run is a ' +
        'bounded no-op. Fails closed (BLOCKED/REJECTED) on any ambiguity.',
      inputSchema: objectSchema(
        { taskId: { type: 'string' }, runId: { type: 'string' } },
        ['taskId', 'runId'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['taskId', 'runId']);
        try {
          return await completedRunRecovery.recoverCompletedRunCapture({
            dataRoot,
            project,
            taskId: requireString(args, 'taskId'),
            runId: requireString(args, 'runId'),
            callerSurface: 'PM_MCP',
          });
        } catch (err) {
          mapPermissionError(err);
        }
      },
    },
  ];
  tools.unshift({
    name: 'relay_pm_start_goal_loop',
      description:
        'Founder-confirmed automatic PM loop: creates or resolves a Goal, dispatches bounded Worker tasks, ' +
        'captures results, sends them to the configured ChatGPT reviewer, retries the same Task on CHANGES, ' +
        'and stops fail-closed on REVIEW_BLOCKED. Worker and workspace are process-bound, never tool inputs.',
      inputSchema: objectSchema(
        {
          goalId: { type: 'string' },
          goalTitle: { type: 'string' },
          goalStatement: { type: 'string' },
          workerId: { type: 'string' },
          workspaceRoot: { type: 'string' },
          ownerConfirmed: { type: 'boolean' },
        },
        ['ownerConfirmed'],
      ),
      handler: async (args) => {
        rejectUnknownFields(args, ['goalId', 'goalTitle', 'goalStatement', 'workerId', 'workspaceRoot', 'ownerConfirmed']);
        if (args.ownerConfirmed !== true) {
          throw new McpError('FORBIDDEN', '자동 Goal Loop은 Founder 확인(ownerConfirmed=true)이 필요합니다.');
        }
        const goalId = optionalString(args, 'goalId');
        const goalTitle = optionalString(args, 'goalTitle');
        const goalStatement = optionalString(args, 'goalStatement');
        const workerId = optionalString(args, 'workerId') ?? ctx.goalLoop?.workerId;
        const workspaceRoot = optionalString(args, 'workspaceRoot') ?? ctx.goalLoop?.workspaceRoot;
        if (!workerId || !workspaceRoot) {
          throw new McpError('INVALID_ARGUMENT', 'workerId+workspaceRoot 또는 서버의 Goal Loop 설정이 필요합니다.');
        }
        if (!goalId && (!goalTitle || !goalStatement)) {
          throw new McpError('INVALID_ARGUMENT', 'goalId 또는 goalTitle+goalStatement이 필요합니다.');
        }
        try {
          return await startGoalLoop({
            dataRoot,
            project,
            ...(goalId ? { goalId } : {}),
            ...(goalTitle ? { goalTitle } : {}),
            ...(goalStatement ? { goalStatement } : {}),
            workerId,
            workspaceRoot,
            transport: ctx.goalLoop?.transport ?? 'internal',
            ...(ctx.goalLoop?.actlAgent ? { actlAgent: ctx.goalLoop.actlAgent } : {}),
          });
        } catch (err) {
          throw mapCoreError(err);
        }
      },
    });
  return tools;
}

/** All PM tools (read + write + wake). No Worker tools included. */
export function buildAllPmTools(ctx: PmServerContext): McpTool[] {
  return [...buildPmReadTools(ctx), ...buildPmWriteTools(ctx), ...buildPmWakeTools(ctx)];
}
