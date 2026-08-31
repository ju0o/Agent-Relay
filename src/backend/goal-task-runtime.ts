/**
 * Phase B2 — Goal/Task deterministic runtime state layer.
 *
 * Relay owns persistent state. Callers (future GPT / MCP / UI) must mutate
 * execution/pm/goal status only through validated transitions below.
 *
 * Documented semantics (chosen for V1):
 *
 * Execution:
 *   PLANNED → READY | BLOCKED | CANCELLED
 *   READY → DISPATCHED | BLOCKED | CANCELLED | PLANNED (refresh: deps unsatisfied)
 *   DISPATCHED → RUNNING | FAILED | CANCELLED
 *   RUNNING → RESULT_RECEIVED | FAILED | CANCELLED
 *   RESULT_RECEIVED → READY | DISPATCHED (correction/retry)
 *   BLOCKED → PLANNED | READY (unblock; target depends on dependency readiness)
 *   FAILED / CANCELLED = terminal (no further execution transitions)
 *
 * PM:
 *   PENDING → VERIFYING
 *   VERIFYING → ACCEPTED | CHANGES_REQUESTED
 *   CHANGES_REQUESTED → VERIFYING | PENDING
 *   ACCEPTED → PENDING (explicit reopen; clears acceptedRunId)
 *   ACCEPTED requires acceptedRunId referencing a linked Run and
 *   executionState=RESULT_RECEIVED. Agent Result alone never implies ACCEPTED.
 *
 * markResultReceived:
 *   Sets executionState=RESULT_RECEIVED.
 *   If pmState is CHANGES_REQUESTED or PENDING → VERIFYING (new result to review).
 *   Never sets ACCEPTED.
 *
 * Dependencies:
 *   Satisfied only when dependency.pmState === ACCEPTED.
 *   Same-Goal only; cycles rejected.
 *   WAITING_DEPENDENCIES is derived readiness, not executionState=BLOCKED.
 *
 * Goal completion:
 *   Task-complete eligible when ≥1 task and every non-CANCELLED task is ACCEPTED.
 *   goal:complete writes COMPLETED only through the gate; reads never auto-complete.
 */
import {
  GoalCompletionEvaluation,
  GoalRecord,
  GoalRuntimeState,
  GoalStatus,
  TaskExecutionState,
  TaskPmState,
  TaskReadiness,
  TaskReadinessKind,
  TaskRecord,
  TaskRuntimeSummary,
} from '../shared/types.js';
import {
  getGoal,
  getGoalProgress,
  getTask,
  listTasks,
  persistGoalRecord,
  persistTaskRecord,
} from './goal-task.js';

export { wouldCreateDependencyCycle } from './goal-task.js';

// ── Transition tables ───────────────────────────────────────────────────────

const EXEC_TRANSITIONS: Readonly<Record<TaskExecutionState, readonly TaskExecutionState[]>> = {
  PLANNED: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['DISPATCHED', 'BLOCKED', 'CANCELLED', 'PLANNED'],
  DISPATCHED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['RESULT_RECEIVED', 'FAILED', 'CANCELLED'],
  RESULT_RECEIVED: ['READY', 'DISPATCHED'],
  BLOCKED: ['PLANNED', 'READY'],
  FAILED: [],
  CANCELLED: [],
};

const PM_TRANSITIONS: Readonly<Record<TaskPmState, readonly TaskPmState[]>> = {
  PENDING: ['VERIFYING'],
  VERIFYING: ['ACCEPTED', 'CHANGES_REQUESTED'],
  CHANGES_REQUESTED: ['VERIFYING', 'PENDING'],
  ACCEPTED: ['PENDING'],
};

const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  PLANNING: ['ACTIVE', 'ABANDONED'],
  ACTIVE: ['WAITING_OWNER', 'BLOCKED', 'COMPLETED', 'ABANDONED'],
  WAITING_OWNER: ['ACTIVE', 'ABANDONED'],
  BLOCKED: ['ACTIVE', 'ABANDONED'],
  COMPLETED: ['ACTIVE'],
  ABANDONED: [],
};

const TERMINAL_EXEC: ReadonlySet<TaskExecutionState> = new Set(['FAILED', 'CANCELLED']);

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

export function isLegalExecutionTransition(from: TaskExecutionState, to: TaskExecutionState): boolean {
  if (from === to) return true; // idempotent no-op
  return EXEC_TRANSITIONS[from].includes(to);
}

export function isLegalPmTransition(from: TaskPmState, to: TaskPmState): boolean {
  if (from === to) return true;
  return PM_TRANSITIONS[from].includes(to);
}

export function isLegalGoalTransition(from: GoalStatus, to: GoalStatus): boolean {
  if (from === to) return true;
  return GOAL_TRANSITIONS[from].includes(to);
}

export function assertLegalExecutionTransition(from: TaskExecutionState, to: TaskExecutionState): void {
  if (!isLegalExecutionTransition(from, to)) {
    throw new Error(`허용되지 않는 execution 전이: ${from} → ${to}`);
  }
}

export function assertLegalPmTransition(from: TaskPmState, to: TaskPmState): void {
  if (!isLegalPmTransition(from, to)) {
    throw new Error(`허용되지 않는 pmState 전이: ${from} → ${to}`);
  }
}

export function assertLegalGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!isLegalGoalTransition(from, to)) {
    throw new Error(`허용되지 않는 Goal status 전이: ${from} → ${to}`);
  }
}

// ── Dependency helpers ──────────────────────────────────────────────────────

/** Dependency satisfied only when pmState === ACCEPTED. */
export function isDependencySatisfied(dep: TaskRecord | undefined): boolean {
  return !!dep && dep.pmState === 'ACCEPTED';
}

export function isHardDependencyBlocker(dep: TaskRecord | undefined): boolean {
  if (!dep) return true; // missing dep is a hard problem
  return (
    dep.executionState === 'FAILED'
    || dep.executionState === 'BLOCKED'
    || dep.executionState === 'CANCELLED'
  );
}

export function collectDependencyInfo(
  task: TaskRecord,
  byId: ReadonlyMap<string, TaskRecord>,
): {
  unsatisfiedDependencies: string[];
  blockedBy: string[];
  dependenciesSatisfied: boolean;
} {
  const unsatisfiedDependencies: string[] = [];
  const blockedBy: string[] = [];
  for (const depId of task.dependencies) {
    const dep = byId.get(depId);
    if (!isDependencySatisfied(dep)) {
      unsatisfiedDependencies.push(depId);
      if (isHardDependencyBlocker(dep)) blockedBy.push(depId);
    }
  }
  return {
    unsatisfiedDependencies,
    blockedBy,
    dependenciesSatisfied: unsatisfiedDependencies.length === 0,
  };
}

// ── Readiness (pure) ────────────────────────────────────────────────────────

/**
 * Pure readiness calculation.
 *
 * WAITING_DEPENDENCIES ≠ explicit BLOCKED.
 * TERMINAL covers FAILED/CANCELLED and ACCEPTED (done).
 */
export function getTaskReadiness(
  task: TaskRecord,
  goalTasks: readonly TaskRecord[],
): TaskReadiness {
  const byId = new Map(goalTasks.filter((t) => t.goalId === task.goalId).map((t) => [t.taskId, t]));
  const depInfo = collectDependencyInfo(task, byId);

  let kind: TaskReadinessKind;
  if (task.pmState === 'ACCEPTED' || TERMINAL_EXEC.has(task.executionState)) {
    kind = 'TERMINAL';
  } else if (task.executionState === 'BLOCKED') {
    kind = 'BLOCKED';
  } else if (
    task.executionState === 'DISPATCHED'
    || task.executionState === 'RUNNING'
    || task.executionState === 'RESULT_RECEIVED'
  ) {
    kind = 'IN_PROGRESS';
  } else if (!depInfo.dependenciesSatisfied) {
    kind = 'WAITING_DEPENDENCIES';
  } else if (task.executionState === 'READY') {
    kind = 'READY';
  } else {
    // PLANNED + deps satisfied → still PLANNED until refresh promotes to READY
    kind = 'PLANNED';
  }

  const parallelizable =
    task.executionState === 'READY'
    && task.pmState !== 'ACCEPTED'
    && depInfo.dependenciesSatisfied;

  return {
    taskId: task.taskId,
    kind,
    executionState: task.executionState,
    pmState: task.pmState,
    dependencies: [...task.dependencies],
    unsatisfiedDependencies: depInfo.unsatisfiedDependencies,
    blockedBy: depInfo.blockedBy,
    dependenciesSatisfied: depInfo.dependenciesSatisfied,
    parallelizable,
  };
}

function loadGoalTaskMap(
  dataRoot: string,
  project: string,
  goalId: string,
): { tasks: TaskRecord[]; byId: Map<string, TaskRecord> } {
  const tasks = listTasks(dataRoot, project, goalId);
  return { tasks, byId: new Map(tasks.map((t) => [t.taskId, t])) };
}

export function getTaskReadinessForId(
  dataRoot: string,
  project: string,
  taskId: string,
): TaskReadiness {
  const task = getTask(dataRoot, project, taskId);
  const { tasks } = loadGoalTaskMap(dataRoot, project, task.goalId);
  return getTaskReadiness(task, tasks);
}

/**
 * Refresh readiness for one Task.
 * Conservative: never mutates RUNNING / RESULT_RECEIVED / ACCEPTED / terminal backwards
 * because a dependency later changed.
 */
export function refreshTaskReadiness(
  dataRoot: string,
  project: string,
  taskId: string,
): TaskRecord {
  const task = getTask(dataRoot, project, taskId);
  if (
    task.pmState === 'ACCEPTED'
    || TERMINAL_EXEC.has(task.executionState)
    || task.executionState === 'DISPATCHED'
    || task.executionState === 'RUNNING'
    || task.executionState === 'RESULT_RECEIVED'
  ) {
    return task; // stable no-op
  }

  const { tasks, byId } = loadGoalTaskMap(dataRoot, project, task.goalId);
  const depInfo = collectDependencyInfo(task, byId);
  const before = task.executionState;

  if (task.executionState === 'BLOCKED') {
    // Explicit blocker stays until transitionExecution unblocks — refresh does not clear it.
    return task;
  }

  if (task.executionState === 'PLANNED' && depInfo.dependenciesSatisfied) {
    task.executionState = 'READY';
  } else if (task.executionState === 'READY' && !depInfo.dependenciesSatisfied) {
    task.executionState = 'PLANNED';
  }

  if (task.executionState === before) return task;

  task.updatedAt = nowIso();
  task.lastTransitionReason = 'refreshReadiness';
  return persistTaskRecord(dataRoot, project, task);
}

/**
 * After a Task becomes ACCEPTED, refresh dependents in the same Goal that are
 * PLANNED/READY so they can become READY when eligible.
 */
export function refreshDependentReadiness(
  dataRoot: string,
  project: string,
  acceptedTaskId: string,
): TaskRecord[] {
  const accepted = getTask(dataRoot, project, acceptedTaskId);
  const dependents = listTasks(dataRoot, project, accepted.goalId).filter((t) =>
    t.dependencies.includes(acceptedTaskId)
  );
  const updated: TaskRecord[] = [];
  for (const d of dependents) {
    const next = refreshTaskReadiness(dataRoot, project, d.taskId);
    updated.push(next);
  }
  return updated;
}

// ── Execution / PM transitions ──────────────────────────────────────────────

export function transitionTaskExecution(
  dataRoot: string,
  project: string,
  taskId: string,
  to: TaskExecutionState,
  reason?: string,
): TaskRecord {
  const task = getTask(dataRoot, project, taskId);
  assertLegalExecutionTransition(task.executionState, to);

  if (task.executionState === to) {
    // Idempotent: still allow refreshing blocker metadata when staying BLOCKED with new reason
    if (to === 'BLOCKED' && reason && reason !== task.blockedReason) {
      task.blockedReason = reason;
      task.blockedAt = task.blockedAt ?? nowIso();
      task.lastTransitionReason = reason;
      task.updatedAt = nowIso();
      return persistTaskRecord(dataRoot, project, task);
    }
    return task;
  }

  // Unblock: choose READY vs PLANNED from dependency readiness when target is ambiguous.
  // Caller may pass READY or PLANNED explicitly; if BLOCKED→READY but deps unsatisfied, reject.
  if (task.executionState === 'BLOCKED' && (to === 'READY' || to === 'PLANNED')) {
    const { byId } = loadGoalTaskMap(dataRoot, project, task.goalId);
    const depInfo = collectDependencyInfo(task, byId);
    if (to === 'READY' && !depInfo.dependenciesSatisfied) {
      throw new Error('의존성이 충족되지 않아 BLOCKED → READY로 해제할 수 없습니다. PLANNED를 사용하세요.');
    }
    delete task.blockedReason;
    delete task.blockedAt;
  }

  if (to === 'BLOCKED') {
    task.blockedReason = reason?.trim() || task.blockedReason || 'explicitly blocked';
    task.blockedAt = nowIso();
  } else if (task.executionState === 'BLOCKED') {
    delete task.blockedReason;
    delete task.blockedAt;
  }

  // Correction retry from RESULT_RECEIVED clears ACCEPTED if somehow set (should not be)
  if (task.executionState === 'RESULT_RECEIVED' && (to === 'READY' || to === 'DISPATCHED')) {
    if (task.pmState === 'ACCEPTED') {
      throw new Error('ACCEPTED Task는 재시도 전에 pmState를 명시적으로 재개방해야 합니다.');
    }
  }

  task.executionState = to;
  if (reason?.trim()) task.lastTransitionReason = reason.trim();
  task.updatedAt = nowIso();
  return persistTaskRecord(dataRoot, project, task);
}

export function transitionTaskPm(
  dataRoot: string,
  project: string,
  taskId: string,
  to: TaskPmState,
  opts?: { reason?: string; acceptedRunId?: string },
): TaskRecord {
  const task = getTask(dataRoot, project, taskId);
  assertLegalPmTransition(task.pmState, to);

  if (task.pmState === to) {
    if (to === 'ACCEPTED' && opts?.acceptedRunId && opts.acceptedRunId === task.acceptedRunId) {
      return task; // idempotent accept
    }
    if (to === 'ACCEPTED') return task;
    return task;
  }

  if (to === 'ACCEPTED') {
    if (task.executionState !== 'RESULT_RECEIVED') {
      throw new Error('ACCEPTED는 executionState=RESULT_RECEIVED일 때만 설정할 수 있습니다.');
    }
    const runId = opts?.acceptedRunId ?? task.acceptedRunId;
    if (!runId) throw new Error('ACCEPTED에는 acceptedRunId가 필요합니다.');
    if (!task.linkedRuns.some((r) => r.runId === runId)) {
      throw new Error('acceptedRunId는 linkedRuns에 포함된 runId여야 합니다.');
    }
    task.acceptedRunId = runId;
  }

  if (task.pmState === 'ACCEPTED' && to === 'PENDING') {
    delete task.acceptedRunId;
  }

  if (to === 'CHANGES_REQUESTED') {
    delete task.acceptedRunId;
  }

  task.pmState = to;
  if (opts?.reason?.trim()) task.lastTransitionReason = opts.reason.trim();
  task.updatedAt = nowIso();
  const saved = persistTaskRecord(dataRoot, project, task);

  if (to === 'ACCEPTED') {
    refreshDependentReadiness(dataRoot, project, saved.taskId);
    return getTask(dataRoot, project, saved.taskId);
  }
  return saved;
}

export function markResultReceived(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
): TaskRecord {
  const id = requireNonEmptyString(runId, 'runId');
  const task = getTask(dataRoot, project, taskId);

  if (!task.linkedRuns.some((r) => r.runId === id)) {
    throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
  }
  if (task.pmState === 'ACCEPTED') {
    throw new Error('이미 ACCEPTED된 Task에는 markResultReceived를 적용할 수 없습니다.');
  }

  // Idempotent: already RESULT_RECEIVED for review
  const already = task.executionState === 'RESULT_RECEIVED';
  if (!already) {
    // Allow from DISPATCHED/RUNNING primarily; also READY/PLANNED would be illegal —
    // use transition table: only RUNNING→RESULT_RECEIVED is preferred, but DISPATCHED may skip?
    // Spec preferred flow includes RUNNING → RESULT_RECEIVED. Also allow DISPATCHED → via RUNNING.
    // Practical: allow DISPATCHED|RUNNING → RESULT_RECEIVED as a safe high-level command.
    if (task.executionState === 'DISPATCHED') {
      // Promote through RUNNING implicitly for this high-level op (single updatedAt bump).
      assertLegalExecutionTransition('DISPATCHED', 'RUNNING');
      assertLegalExecutionTransition('RUNNING', 'RESULT_RECEIVED');
    } else {
      assertLegalExecutionTransition(task.executionState, 'RESULT_RECEIVED');
    }
    task.executionState = 'RESULT_RECEIVED';
  }

  // New result to review: CHANGES_REQUESTED|PENDING → VERIFYING
  if (task.pmState === 'CHANGES_REQUESTED' || task.pmState === 'PENDING') {
    task.pmState = 'VERIFYING';
  }

  if (already && task.pmState === 'VERIFYING') {
    return task; // stable
  }

  task.lastTransitionReason = `markResultReceived:${id}`;
  task.updatedAt = nowIso();
  return persistTaskRecord(dataRoot, project, task);
}

export function acceptResult(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  reason?: string,
): TaskRecord {
  const id = requireNonEmptyString(runId, 'runId');
  const task = getTask(dataRoot, project, taskId);

  if (!task.linkedRuns.some((r) => r.runId === id)) {
    throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
  }
  if (task.executionState !== 'RESULT_RECEIVED') {
    throw new Error('acceptResult는 executionState=RESULT_RECEIVED가 필요합니다.');
  }

  // Idempotent same accept
  if (task.pmState === 'ACCEPTED' && task.acceptedRunId === id) {
    return task;
  }

  // From VERIFYING (preferred) or PENDING (explicit accept without verify step)
  if (task.pmState === 'ACCEPTED' && task.acceptedRunId !== id) {
    throw new Error('이미 다른 Run이 ACCEPTED되어 있습니다. 재개방 후 다시 시도하세요.');
  }
  if (task.pmState === 'CHANGES_REQUESTED') {
    throw new Error('CHANGES_REQUESTED 상태에서는 acceptResult할 수 없습니다. VERIFYING으로 전이하세요.');
  }
  if (task.pmState === 'PENDING') {
    // Allow PENDING → VERIFYING → ACCEPTED in one high-level accept (caller decided).
    assertLegalPmTransition('PENDING', 'VERIFYING');
    assertLegalPmTransition('VERIFYING', 'ACCEPTED');
  } else {
    assertLegalPmTransition(task.pmState, 'ACCEPTED');
  }

  task.acceptedRunId = id;
  task.pmState = 'ACCEPTED';
  if (reason?.trim()) task.lastTransitionReason = reason.trim();
  else task.lastTransitionReason = `acceptResult:${id}`;
  task.updatedAt = nowIso();
  const saved = persistTaskRecord(dataRoot, project, task);
  refreshDependentReadiness(dataRoot, project, saved.taskId);
  return getTask(dataRoot, project, saved.taskId);
}

export function requestChanges(
  dataRoot: string,
  project: string,
  taskId: string,
  reason?: string,
): TaskRecord {
  const task = getTask(dataRoot, project, taskId);

  if (task.pmState === 'CHANGES_REQUESTED') {
    if (reason?.trim() && reason.trim() !== task.lastTransitionReason) {
      task.lastTransitionReason = reason.trim();
      task.updatedAt = nowIso();
      return persistTaskRecord(dataRoot, project, task);
    }
    return task; // idempotent
  }

  assertLegalPmTransition(task.pmState, 'CHANGES_REQUESTED');
  // Preferred from VERIFYING; PENDING→CHANGES_REQUESTED is illegal by table.
  delete task.acceptedRunId;
  task.pmState = 'CHANGES_REQUESTED';
  if (reason?.trim()) task.lastTransitionReason = reason.trim();
  task.updatedAt = nowIso();
  return persistTaskRecord(dataRoot, project, task);
}

// ── Goal completion / transitions ───────────────────────────────────────────

/** CANCELLED tasks are abandoned for completion purposes. */
export function isAbandonedTask(t: TaskRecord): boolean {
  return t.executionState === 'CANCELLED';
}

export function evaluateGoalCompletion(
  goal: GoalRecord,
  tasks: readonly TaskRecord[],
): GoalCompletionEvaluation {
  const scoped = tasks.filter((t) => t.goalId === goal.goalId);
  const reasons: string[] = [];
  const incompleteTasks: string[] = [];
  const blockedTasks: string[] = [];
  const abandonedTasks: string[] = [];
  let acceptedTasks = 0;

  if (scoped.length === 0) {
    reasons.push('Goal에 Task가 없습니다.');
  }

  for (const t of scoped) {
    if (isAbandonedTask(t)) {
      abandonedTasks.push(t.taskId);
      continue;
    }
    if (t.pmState === 'ACCEPTED') {
      acceptedTasks += 1;
      continue;
    }
    incompleteTasks.push(t.taskId);
    if (t.executionState === 'BLOCKED') blockedTasks.push(t.taskId);
  }

  if (incompleteTasks.length > 0) {
    reasons.push(`미완료 Task: ${incompleteTasks.join(', ')}`);
  }
  if (blockedTasks.length > 0) {
    reasons.push(`명시적 BLOCKED Task: ${blockedTasks.join(', ')}`);
  }

  const active = scoped.filter((t) => !isAbandonedTask(t));
  const eligibleFinal =
    scoped.length > 0
    && active.length > 0
    && active.every((t) => t.pmState === 'ACCEPTED');

  if (!eligibleFinal && scoped.length > 0 && active.length === 0) {
    reasons.push('모든 Task가 ABANDONED(CANCELLED)입니다.');
  }

  const criteriaCount = goal.completionCriteria?.length ?? 0;
  if (criteriaCount > 0) {
    reasons.push(
      `completionCriteria ${criteriaCount}개가 있으나 B2는 텍스트 기준의 객관적 충족을 검증하지 않습니다 (task-complete eligible만 판정).`,
    );
  }

  return {
    eligible: eligibleFinal,
    reasons,
    totalTasks: scoped.length,
    acceptedTasks,
    incompleteTasks,
    blockedTasks,
    abandonedTasks,
    completionCriteriaPresent: criteriaCount > 0,
    completionCriteriaCount: criteriaCount,
  };
}

export function evaluateGoalCompletionForId(
  dataRoot: string,
  project: string,
  goalId: string,
): GoalCompletionEvaluation {
  const goal = getGoal(dataRoot, project, goalId);
  const tasks = listTasks(dataRoot, project, goal.goalId);
  return evaluateGoalCompletion(goal, tasks);
}

export function transitionGoalStatus(
  dataRoot: string,
  project: string,
  goalId: string,
  to: GoalStatus,
  reason?: string,
): GoalRecord {
  const goal = getGoal(dataRoot, project, goalId);
  assertLegalGoalTransition(goal.status, to);

  if (goal.status === to) return goal;

  if (to === 'COMPLETED') {
    const evaluation = evaluateGoalCompletion(goal, listTasks(dataRoot, project, goal.goalId));
    if (!evaluation.eligible) {
      throw new Error(`Goal 완료 불가: ${evaluation.reasons.join(' / ') || 'eligibility failed'}`);
    }
  }

  goal.status = to;
  goal.updatedAt = nowIso();
  // GoalRecord has no lastTransitionReason — reason only used for error context / future
  void reason;
  return persistGoalRecord(dataRoot, project, goal);
}

export function completeGoal(
  dataRoot: string,
  project: string,
  goalId: string,
  reason?: string,
): GoalRecord {
  return transitionGoalStatus(dataRoot, project, goalId, 'COMPLETED', reason);
}

// ── Runtime state / PM context ──────────────────────────────────────────────

function toTaskSummary(task: TaskRecord, goalTasks: readonly TaskRecord[]): TaskRuntimeSummary {
  const readiness = getTaskReadiness(task, goalTasks);
  const latestRun = task.linkedRuns.length
    ? [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0]
    : undefined;
  return {
    taskId: task.taskId,
    title: task.title,
    executionState: task.executionState,
    pmState: task.pmState,
    dependencies: [...task.dependencies],
    unsatisfiedDependencies: readiness.unsatisfiedDependencies,
    blockedBy: readiness.blockedBy,
    linkedRunsCount: task.linkedRuns.length,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
    ...(latestRun ? { latestRun } : {}),
    readiness: readiness.kind,
    parallelizable: readiness.parallelizable,
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
  };
}

export function getGoalRuntimeState(
  dataRoot: string,
  project: string,
  goalId: string,
): GoalRuntimeState {
  const goal = getGoal(dataRoot, project, goalId);
  const tasks = listTasks(dataRoot, project, goal.goalId);
  const progress = getGoalProgress(dataRoot, project, goal.goalId);
  const completionEligibility = evaluateGoalCompletion(goal, tasks);
  const summaries = tasks.map((t) => toTaskSummary(t, tasks));

  return {
    goal,
    progress,
    completionEligibility,
    tasks: summaries,
    readyTasks: summaries.filter((t) => t.parallelizable),
    workingTasks: summaries.filter((t) =>
      t.executionState === 'DISPATCHED' || t.executionState === 'RUNNING'
    ),
    resultReceivedTasks: summaries.filter((t) => t.executionState === 'RESULT_RECEIVED'),
    verifyingTasks: summaries.filter((t) => t.pmState === 'VERIFYING'),
    changesRequestedTasks: summaries.filter((t) => t.pmState === 'CHANGES_REQUESTED'),
    blockedTasks: summaries.filter((t) => t.executionState === 'BLOCKED'),
    waitingDependencyTasks: summaries.filter((t) => t.readiness === 'WAITING_DEPENDENCIES'),
    acceptedTasks: summaries.filter((t) => t.pmState === 'ACCEPTED'),
  };
}

/**
 * Deterministic PM-facing context seed for future relay.get_pm_context / MCP.
 * No LLM summarization. No Prompt/Result bodies.
 */
export function buildGoalRuntimeContext(
  dataRoot: string,
  project: string,
  goalId: string,
): GoalRuntimeState {
  return getGoalRuntimeState(dataRoot, project, goalId);
}
