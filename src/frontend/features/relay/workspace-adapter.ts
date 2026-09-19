/**
 * WORKSPACE SHELL V0 — single frontend read adapter.
 *
 * Maps existing Relay backend/API data into WorkspaceViewModel.
 * UI components must not understand raw filesystem paths and must not
 * perform Relay business logic. No duplicated state machine in React.
 *
 * READ-ONLY: this module only issues read ops:
 *   settings:get, projects:list, goal:list, goal:getRuntimeState,
 *   goal:progress, task:list, task:get, history:get,
 *   event:listPendingPm, event:getSummary, workers:list
 * Any mutation op here is a bug (covered by focused tests).
 */

import { must } from '../../bridge.js';
import type {
  EventRecord,
  GoalRecord,
  GoalRuntimeState,
  TaskRecord,
} from '../../../shared/types.js';
import type { TaskHistory } from '../../../backend/task-history.js';

/** READ-ONLY ops allowed in the V0 workspace shell. */
export const WORKSPACE_READ_OPS = [
  'settings:get',
  'projects:list',
  'goal:list',
  'goal:getRuntimeState',
  'goal:progress',
  'task:list',
  'task:get',
  'history:get',
  'event:listPendingPm',
  'event:getSummary',
  'workers:list',
] as const;

export interface WorkspaceProject {
  name: string;
  path: string;
}

export interface WorkspaceWorker {
  workerId: string;
  label: string;
}

export interface WorkspaceHistoryAttempt {
  seq: number;
  runId: string;
  agent: string;
  hasPrompt: boolean;
  hasResult: boolean;
  deliveryStatus: string | null;
  judgmentDecision: string | null;
  judgmentReason: string | null;
  retryInstruction: string | null;
  isAccepted: boolean;
}

export interface WorkspaceTaskHistory {
  taskId: string;
  title: string;
  executionState: string;
  pmState: string;
  acceptedRunId?: string;
  attempts: WorkspaceHistoryAttempt[];
}

export interface WorkspacePmActivity {
  pendingCount: number;
  latestSummary: string | null;
  latestAt: string | null;
}

export interface WorkspaceViewModel {
  project: WorkspaceProject;
  currentGoal: GoalRecord | null;
  goalRuntime: GoalRuntimeState | null;
  currentTask: TaskRecord | null;
  currentRun: { runId: string; agent: string; seq: number } | null;
  worker: WorkspaceWorker | null;
  pmState: string | null;
  executionState: string | null;
  latestResultState: string | null;
  nextAction: string;
  nextTask: TaskRecord | null;
  taskHistory: WorkspaceTaskHistory | null;
  pmActivity: WorkspacePmActivity;
  /** True when goal/task/run/pm came from real Relay records. */
  isRealRelayData: boolean;
}

export function emptyWorkspaceViewModel(project: WorkspaceProject): WorkspaceViewModel {
  return {
    project,
    currentGoal: null,
    goalRuntime: null,
    currentTask: null,
    currentRun: null,
    worker: null,
    pmState: null,
    executionState: null,
    latestResultState: null,
    nextAction: '새 목표 대기',
    nextTask: null,
    taskHistory: null,
    pmActivity: { pendingCount: 0, latestSummary: null, latestAt: null },
    isRealRelayData: false,
  };
}

/** Pure builder — no IPC. Picks current goal/task from already-fetched records. */
export function buildWorkspaceViewModel(input: {
  project: WorkspaceProject;
  goals: GoalRecord[];
  goalRuntime: GoalRuntimeState | null;
  tasks: TaskRecord[];
  history: TaskHistory | null;
  pendingEvents: EventRecord[];
  workers: { workerId: string }[];
}): WorkspaceViewModel {
  const base = emptyWorkspaceViewModel(input.project);
  const goals = input.goals ?? [];
  const tasks = input.tasks ?? [];

  const currentGoal =
    goals.find((g) => g.status === 'ACTIVE') ??
    goals.find((g) => g.status === 'PLANNING') ??
    goals[0] ??
    null;

  // Current task: prefer in-progress axes, then READY, then most recent.
  const rank = (t: TaskRecord): number => {
    if (t.pmState === 'CHANGES_REQUESTED') return 0;
    if (t.pmState === 'VERIFYING') return 1;
    if (t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED') return 2;
    if (t.executionState === 'RESULT_RECEIVED' && t.pmState !== 'ACCEPTED') return 3;
    if (t.executionState === 'READY') return 4;
    if (t.executionState === 'PLANNED') return 5;
    if (t.pmState === 'ACCEPTED') return 7;
    return 6;
  };
  const sorted = [...tasks].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  const currentTask = sorted.find((t) => t.pmState !== 'ACCEPTED') ?? sorted[0] ?? null;
  const nextTask =
    (currentTask
      ? sorted.find((t) => t.taskId !== currentTask.taskId && t.pmState !== 'ACCEPTED')
      : null) ?? null;

  const latestLinked = currentTask?.linkedRuns
    ? [...currentTask.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0]
    : undefined;
  const currentRun = latestLinked
    ? { runId: latestLinked.runId, agent: latestLinked.agent ?? '', seq: latestLinked.taskRunSequence }
    : null;

  const worker: WorkspaceWorker | null = currentRun?.agent
    ? { workerId: currentRun.agent, label: currentRun.agent }
    : null;

  const latestResultState = currentTask
    ? currentTask.executionState === 'RESULT_RECEIVED'
      ? '결과 도착'
      : currentTask.executionState
    : null;

  const nextAction = deriveNextAction(currentTask, nextTask);

  let taskHistory: WorkspaceTaskHistory | null = null;
  if (input.history && currentTask && input.history.task.taskId === currentTask.taskId) {
    taskHistory = toWorkspaceHistory(input.history);
  } else if (currentTask) {
    // Adapter fallback: same-Task / multiple-Run grouping from Task record alone
    // (no second store — purely derived from the SSOT Task).
    taskHistory = {
      taskId: currentTask.taskId,
      title: currentTask.title,
      executionState: currentTask.executionState,
      pmState: currentTask.pmState,
      acceptedRunId: currentTask.acceptedRunId,
      attempts: [...(currentTask.linkedRuns ?? [])]
        .sort((a, b) => a.taskRunSequence - b.taskRunSequence)
        .map((r) => ({
          seq: r.taskRunSequence,
          runId: r.runId,
          agent: r.agent ?? '',
          hasPrompt: false,
          hasResult: false,
          deliveryStatus: null,
          judgmentDecision: null,
          judgmentReason: null,
          retryInstruction: null,
          isAccepted: currentTask.acceptedRunId === r.runId,
        })),
    };
  }

  const pending = [...(input.pendingEvents ?? [])].sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt),
  );
  const pmActivity: WorkspacePmActivity = {
    pendingCount: pending.length,
    latestSummary: pending[0]?.summary ?? null,
    latestAt: pending[0]?.occurredAt ?? null,
  };

  return {
    ...base,
    currentGoal,
    goalRuntime: input.goalRuntime,
    currentTask,
    currentRun,
    worker,
    pmState: currentTask?.pmState ?? null,
    executionState: currentTask?.executionState ?? null,
    latestResultState,
    nextAction,
    nextTask,
    taskHistory,
    pmActivity,
    isRealRelayData: currentGoal !== null || currentTask !== null,
  };
}

function deriveNextAction(currentTask: TaskRecord | null, nextTask: TaskRecord | null): string {
  if (!currentTask) return nextTask ? '다음 작업 시작 대기' : '새 목표 대기';
  if (currentTask.executionState === 'BLOCKED') return '막힘 해소 필요';
  if (currentTask.pmState === 'ACCEPTED') return nextTask ? '다음 작업으로 이동' : '목표 완료 확인';
  if (currentTask.pmState === 'CHANGES_REQUESTED') return '수정 후 재실행';
  if (currentTask.pmState === 'VERIFYING') return 'PM 판단 대기';
  if (currentTask.executionState === 'RESULT_RECEIVED') return 'PM 검토 대기';
  if (currentTask.executionState === 'RUNNING' || currentTask.executionState === 'DISPATCHED')
    return '작업자 결과 대기';
  if (currentTask.executionState === 'READY') return '실행 대기';
  return '상태 확인';
}

export function toWorkspaceHistory(h: TaskHistory): WorkspaceTaskHistory {
  return {
    taskId: h.task.taskId,
    title: h.task.title,
    executionState: h.task.executionState,
    pmState: h.task.pmState,
    acceptedRunId: h.task.acceptedRunId,
    attempts: [...h.attempts]
      .sort((a, b) => a.taskRunSequence - b.taskRunSequence)
      .map((a) => ({
        seq: a.taskRunSequence,
        runId: a.runId,
        agent: a.agent ?? '',
        hasPrompt: a.hasPrompt,
        hasResult: a.hasResult,
        deliveryStatus: a.delivery?.status ?? null,
        judgmentDecision: a.judgment?.decision ?? null,
        judgmentReason: a.judgment?.reason ?? null,
        retryInstruction:
          (a.judgment as { retryInstruction?: string } | null)?.retryInstruction ?? null,
        isAccepted: h.task.acceptedRunId === a.runId,
      })),
  };
}

/** IPC loader — read-only. Throws on transport errors; empty states on missing data. */
export async function loadWorkspaceViewModel(
  dataRoot: string,
  project: WorkspaceProject,
): Promise<WorkspaceViewModel> {
  const goals = await must<GoalRecord[]>({ op: 'goal:list', dataRoot, project: project.name }).catch(
    () => [] as GoalRecord[],
  );
  const currentGoal =
    goals.find((g) => g.status === 'ACTIVE') ??
    goals.find((g) => g.status === 'PLANNING') ??
    goals[0] ??
    null;

  let goalRuntime: GoalRuntimeState | null = null;
  if (currentGoal) {
    goalRuntime = await must<GoalRuntimeState>({
      op: 'goal:getRuntimeState',
      dataRoot,
      project: project.name,
      goalId: currentGoal.goalId,
    }).catch(() => null);
  }

  let tasks: TaskRecord[] = [];
  if (currentGoal) {
    tasks = await must<TaskRecord[]>({
      op: 'task:list',
      dataRoot,
      project: project.name,
      goalId: currentGoal.goalId,
    }).catch(() => [] as TaskRecord[]);
  }

  // Draft view to find the current task before fetching its history.
  const draft = buildWorkspaceViewModel({
    project,
    goals,
    goalRuntime,
    tasks,
    history: null,
    pendingEvents: [],
    workers: [],
  });

  let history: TaskHistory | null = null;
  if (draft.currentTask) {
    history = await must<TaskHistory>({
      op: 'history:get',
      dataRoot,
      project: project.name,
      taskId: draft.currentTask.taskId,
    }).catch(() => null);
  }

  const pendingEvents = await must<EventRecord[]>({
    op: 'event:listPendingPm',
    dataRoot,
    project: project.name,
  }).catch(() => [] as EventRecord[]);

  const workers = await must<{ workerId: string }[]>({ op: 'workers:list', dataRoot }).catch(
    () => [] as { workerId: string }[],
  );

  return buildWorkspaceViewModel({ project, goals, goalRuntime, tasks, history, pendingEvents, workers });
}
