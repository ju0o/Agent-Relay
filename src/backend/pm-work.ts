/**
 * Phase H — Pure get_next_work discovery.
 *
 * No writes. No claiming. No markDelivered. No dispatch.
 * Logical IDs only — no physical Run folders / workspace paths.
 */
import { listPendingPmEvents } from './event.js';
import { listGoals, listTasks } from './goal-task.js';
import { evaluateGoalCompletion, resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { getRecoveryRecord, isDispatchBlocked } from './dispatcher.js';
import type {
  GoalStatus,
  PermissionMode,
  TaskExecutionState,
  TaskPmState,
  TaskRecord,
} from '../shared/types.js';

function currentAttemptRunId(task: TaskRecord): string | undefined {
  return resolveCurrentAttemptRunId(task);
}

export type WorkItemKind =
  | 'EVENT_ATTENTION'
  | 'TASK_VERIFY'
  | 'TASK_RETRY_READY'
  | 'TASK_DISPATCH_READY'
  | 'GOAL_COMPLETION'
  | 'STOP_ORPHAN'
  | 'STOP_FAILED'
  | 'STOP_BLOCKED'
  | 'STOP_OWNER_REQUIRED'
  | 'STOP_POLICY';

export interface WorkItem {
  kind: WorkItemKind;
  priority: number;
  project: string;
  goalId?: string;
  taskId?: string;
  runId?: string;
  eventId?: string;
  reason?: string;
  cas?: {
    expectedExecutionState?: TaskExecutionState;
    expectedPmState?: TaskPmState;
    expectedGoalStatus?: GoalStatus;
  };
  policy?: { mode: PermissionMode };
  workerHint?: string;
}

export interface GetNextWorkResult {
  items: WorkItem[];
  truncated: boolean;
  warning?: string;
}

const GLOBAL_MAX = 50;

/** Deterministic kind order (lower = earlier). */
const KIND_ORDER: Record<WorkItemKind, number> = {
  STOP_ORPHAN: 10,
  STOP_FAILED: 11,
  STOP_BLOCKED: 12,
  STOP_OWNER_REQUIRED: 13,
  STOP_POLICY: 14,
  EVENT_ATTENTION: 20,
  TASK_VERIFY: 30,
  GOAL_COMPLETION: 40,
  TASK_RETRY_READY: 50,
  TASK_DISPATCH_READY: 60,
};

const SEVERITY_PRIORITY: Record<string, number> = {
  CRITICAL: 0,
  ERROR: 1,
  WARNING: 2,
  INFO: 3,
};

export function getNextWork(dataRoot: string, project: string): GetNextWorkResult {
  const root = requireNonEmpty(dataRoot, 'dataRoot');
  const proj = requireNonEmpty(project, 'project');

  const items: WorkItem[] = [];
  const goals = listGoals(root, proj);
  const tasks = listTasks(root, proj);
  const goalById = new Map(goals.map((g) => [g.goalId, g]));

  // STOP_* from task states / recovery
  for (const task of tasks) {
    const goal = goalById.get(task.goalId);
    const mode = goal?.permissionPolicy?.mode ?? 'PLAN';

    if (isDispatchBlocked(root, proj, task.taskId) || getRecoveryRecord(root, proj, task.taskId)) {
      items.push({
        kind: 'STOP_ORPHAN',
        priority: KIND_ORDER.STOP_ORPHAN,
        project: proj,
        goalId: task.goalId,
        taskId: task.taskId,
        reason: 'ORPHAN_SUSPECTED — owner recovery required',
        policy: { mode },
      });
    }

    if (task.executionState === 'FAILED') {
      items.push({
        kind: 'STOP_FAILED',
        priority: KIND_ORDER.STOP_FAILED,
        project: proj,
        goalId: task.goalId,
        taskId: task.taskId,
        reason: 'FAILED is terminal — owner may create a replacement Task manually',
        policy: { mode },
      });
    }

    if (task.executionState === 'BLOCKED') {
      items.push({
        kind: 'STOP_BLOCKED',
        priority: KIND_ORDER.STOP_BLOCKED,
        project: proj,
        goalId: task.goalId,
        taskId: task.taskId,
        reason: task.blockedReason || 'Task is BLOCKED',
        policy: { mode },
      });
    }
  }

  // Goals waiting on owner
  for (const goal of goals) {
    if (goal.status === 'WAITING_OWNER') {
      items.push({
        kind: 'STOP_OWNER_REQUIRED',
        priority: KIND_ORDER.STOP_OWNER_REQUIRED,
        project: proj,
        goalId: goal.goalId,
        reason: 'Goal status is WAITING_OWNER',
        policy: { mode: goal.permissionPolicy?.mode ?? 'PLAN' },
        cas: { expectedGoalStatus: goal.status },
      });
    }
  }

  // EVENT_ATTENTION — respect D severity ordering
  const pendingEvents = listPendingPmEvents(root, proj);
  for (const ev of pendingEvents) {
    const sev = SEVERITY_PRIORITY[ev.severity] ?? 9;
    items.push({
      kind: 'EVENT_ATTENTION',
      priority: KIND_ORDER.EVENT_ATTENTION + sev,
      project: proj,
      goalId: ev.goalId,
      taskId: ev.taskId,
      runId: ev.runId,
      eventId: ev.eventId,
      reason: ev.summary,
    });
  }

  // TASK_VERIFY / RETRY_READY / DISPATCH_READY / STOP_POLICY
  for (const task of tasks) {
    const goal = goalById.get(task.goalId);
    const mode: PermissionMode = goal?.permissionPolicy?.mode ?? 'PLAN';
    const runId = currentAttemptRunId(task);

    if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'VERIFYING') {
      items.push({
        kind: 'TASK_VERIFY',
        priority: KIND_ORDER.TASK_VERIFY,
        project: proj,
        goalId: task.goalId,
        taskId: task.taskId,
        ...(runId ? { runId } : {}),
        reason: 'Result ready for PM verification',
        cas: {
          expectedExecutionState: 'RESULT_RECEIVED',
          expectedPmState: 'VERIFYING',
        },
        policy: { mode },
      });
    }

    if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'CHANGES_REQUESTED') {
      items.push({
        kind: 'TASK_RETRY_READY',
        priority: KIND_ORDER.TASK_RETRY_READY,
        project: proj,
        goalId: task.goalId,
        taskId: task.taskId,
        ...(runId ? { runId } : {}),
        reason: 'CHANGES_REQUESTED — explicit requestRetry required (no auto-dispatch)',
        cas: {
          expectedExecutionState: 'RESULT_RECEIVED',
          expectedPmState: 'CHANGES_REQUESTED',
        },
        policy: { mode },
      });
    }

    if (task.executionState === 'READY' && task.pmState === 'PENDING') {
      if (mode === 'PLAN') {
        items.push({
          kind: 'STOP_POLICY',
          priority: KIND_ORDER.STOP_POLICY,
          project: proj,
          goalId: task.goalId,
          taskId: task.taskId,
          reason: 'PLAN mode: owner-dispatch-required (PM MCP DISPATCH denied)',
          policy: { mode },
          cas: { expectedExecutionState: 'READY', expectedPmState: 'PENDING' },
        });
      } else {
        // APPROVE / BYPASS — actionable to PM; still requires explicit workerId + workspaceRoot
        items.push({
          kind: 'TASK_DISPATCH_READY',
          priority: KIND_ORDER.TASK_DISPATCH_READY,
          project: proj,
          goalId: task.goalId,
          taskId: task.taskId,
          reason: 'Task READY+PENDING — explicit dispatch required (workerId + workspaceRoot)',
          policy: { mode },
          cas: { expectedExecutionState: 'READY', expectedPmState: 'PENDING' },
          workerHint: 'explicit workerId required',
        });
      }
    }
  }

  // GOAL_COMPLETION
  for (const goal of goals) {
    if (goal.status === 'COMPLETED' || goal.status === 'ABANDONED') continue;
    // GOAL-03: PLANNING→COMPLETED is illegal (GOAL_TRANSITIONS: PLANNING → ['ACTIVE','ABANDONED']).
    // A PLANNING goal must not surface as GOAL_COMPLETION work — the PM would receive a CAS
    // that fails at mutation time.  Only ACTIVE / WAITING_OWNER / BLOCKED can complete.
    if (goal.status === 'PLANNING') continue;
    const scoped = tasks.filter((t) => t.goalId === goal.goalId);
    const evaluation = evaluateGoalCompletion(goal, scoped);
    if (evaluation.eligible) {
      items.push({
        kind: 'GOAL_COMPLETION',
        priority: KIND_ORDER.GOAL_COMPLETION,
        project: proj,
        goalId: goal.goalId,
        reason: `Goal eligible for completion (${evaluation.acceptedTasks}/${evaluation.totalTasks} accepted)`,
        cas: { expectedGoalStatus: goal.status },
        policy: { mode: goal.permissionPolicy?.mode ?? 'PLAN' },
      });
    }
  }

  items.sort(compareWorkItems);

  const truncated = items.length > GLOBAL_MAX;
  const sliced = items.slice(0, GLOBAL_MAX);
  return {
    items: sliced,
    truncated,
    ...(truncated
      ? { warning: `Work queue truncated to ${GLOBAL_MAX} items (had ${items.length})` }
      : {}),
  };
}

function compareWorkItems(a: WorkItem, b: WorkItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ga = a.goalId ?? '';
  const gb = b.goalId ?? '';
  if (ga !== gb) return ga.localeCompare(gb);
  const ta = a.taskId ?? '';
  const tb = b.taskId ?? '';
  if (ta !== tb) return ta.localeCompare(tb);
  const ea = a.eventId ?? '';
  const eb = b.eventId ?? '';
  if (ea !== eb) return ea.localeCompare(eb);
  return a.kind.localeCompare(b.kind);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}
