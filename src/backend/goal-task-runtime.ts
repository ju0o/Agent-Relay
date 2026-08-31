/**
 * Phase B2 — Goal/Task deterministic runtime state layer
 * (+ architecture review addendum: CAS, derived deps, requestRetry).
 *
 * B2 is a state kernel + validated commands + derived read model —
 * NOT a workflow engine / orchestrator / scheduler.
 *
 * Documented semantics:
 *
 * Execution (persisted):
 *   PLANNED → READY | BLOCKED | CANCELLED
 *   READY → DISPATCHED | BLOCKED | CANCELLED | PLANNED (explicit only)
 *   DISPATCHED → RUNNING | FAILED | CANCELLED
 *   RUNNING → RESULT_RECEIVED | FAILED | CANCELLED
 *   RESULT_RECEIVED → (no direct exec transition; use task:requestRetry)
 *   BLOCKED → PLANNED | READY
 *   FAILED / CANCELLED = terminal
 *
 * Correction retry (explicit command, not raw transition):
 *   RESULT_RECEIVED + CHANGES_REQUESTED → requestRetry → READY + PENDING
 *   Does NOT delete prior linkedRuns; next attempt needs a NEW linked Run.
 *
 * PM:
 *   PENDING → VERIFYING
 *   VERIFYING → ACCEPTED | CHANGES_REQUESTED
 *   CHANGES_REQUESTED → VERIFYING | PENDING
 *   ACCEPTED → PENDING (explicit reopen; clears acceptedRunId)
 *
 * Dependencies (DERIVED only):
 *   Satisfied iff dependency.pmState === ACCEPTED.
 *   WAITING_DEPENDENCIES is never persisted.
 *   Accepting/failing a dependency does NOT mutate dependents.
 *
 * refreshReadiness:
 *   May only promote PLANNED → READY when deps ACCEPTED and not explicitly blocked.
 *   No demotion, no cascade, no auto-BLOCK.
 *
 * All Task mutations: per-task lock + CAS expected-from validation.
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
  withTaskLinkLock,
} from './goal-task.js';

export { wouldCreateDependencyCycle } from './goal-task.js';

// ── Transition tables ───────────────────────────────────────────────────────

const EXEC_TRANSITIONS: Readonly<Record<TaskExecutionState, readonly TaskExecutionState[]>> = {
  PLANNED: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['DISPATCHED', 'BLOCKED', 'CANCELLED', 'PLANNED'],
  DISPATCHED: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['RESULT_RECEIVED', 'FAILED', 'CANCELLED'],
  // Correction retry is task:requestRetry — not a raw RESULT_RECEIVED → DISPATCHED jump.
  RESULT_RECEIVED: [],
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

/** Deterministic CAS conflict — no partial write occurred. */
export class RuntimeConflictError extends Error {
  readonly code = 'RUNTIME_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConflictError';
  }
}

export function isLegalExecutionTransition(from: TaskExecutionState, to: TaskExecutionState): boolean {
  if (from === to) return true;
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

function assertExpectedExecution(actual: TaskExecutionState, expected: TaskExecutionState): void {
  if (actual !== expected) {
    throw new RuntimeConflictError(
      `CONFLICT: expectedExecutionState=${expected} but found ${actual}`,
    );
  }
}

function assertExpectedPm(actual: TaskPmState, expected: TaskPmState): void {
  if (actual !== expected) {
    throw new RuntimeConflictError(
      `CONFLICT: expectedPmState=${expected} but found ${actual}`,
    );
  }
}

// ── Dependency helpers (derived) ────────────────────────────────────────────

/** Dependency satisfied only when pmState === ACCEPTED. */
export function isDependencySatisfied(dep: TaskRecord | undefined): boolean {
  return !!dep && dep.pmState === 'ACCEPTED';
}

export function isHardDependencyBlocker(dep: TaskRecord | undefined): boolean {
  if (!dep) return true;
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

// ── Readiness (pure / derived) ──────────────────────────────────────────────

/**
 * Pure readiness calculation.
 * WAITING_DEPENDENCIES is derived — never persisted.
 * isEligibleForReady ≠ persisted READY.
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
    kind = 'PLANNED';
  }

  const isEligibleForReady =
    depInfo.dependenciesSatisfied
    && task.executionState === 'PLANNED'
    && task.pmState !== 'ACCEPTED'
    && !TERMINAL_EXEC.has(task.executionState);

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
    isEligibleForReady,
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
 * refreshReadiness: may ONLY promote PLANNED → READY when deps ACCEPTED
 * and Task is not explicitly BLOCKED. No demotion, no cascade, no auto-BLOCK.
 */
export function refreshTaskReadiness(
  dataRoot: string,
  project: string,
  taskId: string,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.executionState !== 'PLANNED') {
      return task; // no-op — never demote or touch other states
    }
    if (task.pmState === 'ACCEPTED') return task;

    const { byId } = loadGoalTaskMap(dataRoot, project, task.goalId);
    const depInfo = collectDependencyInfo(task, byId);
    if (!depInfo.dependenciesSatisfied) {
      return task; // stays PLANNED; WAITING is derived only
    }

    task.executionState = 'READY';
    task.updatedAt = nowIso();
    task.lastTransitionReason = 'refreshReadiness';
    return persistTaskRecord(dataRoot, project, task);
  });
}

// ── Execution / PM transitions (CAS + lock) ─────────────────────────────────

export interface TransitionExecutionInput {
  expectedExecutionState: TaskExecutionState;
  to: TaskExecutionState;
  reason?: string;
}

export function transitionTaskExecution(
  dataRoot: string,
  project: string,
  taskId: string,
  input: TransitionExecutionInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const expected = input.expectedExecutionState;
  const to = input.to;
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    assertExpectedExecution(task.executionState, expected);

    if (task.executionState === to) {
      if (to === 'BLOCKED' && input.reason?.trim() && input.reason.trim() !== task.blockedReason) {
        task.blockedReason = input.reason.trim();
        task.blockedAt = task.blockedAt ?? nowIso();
        task.lastTransitionReason = input.reason.trim();
        task.updatedAt = nowIso();
        return persistTaskRecord(dataRoot, project, task);
      }
      return task; // idempotent replay
    }

    assertLegalExecutionTransition(task.executionState, to);

    if (to === 'READY') {
      const { byId } = loadGoalTaskMap(dataRoot, project, task.goalId);
      const depInfo = collectDependencyInfo(task, byId);
      if (!depInfo.dependenciesSatisfied) {
        throw new Error('의존성이 충족되지 않아 READY로 전이할 수 없습니다.');
      }
    }

    if (task.executionState === 'BLOCKED' && (to === 'READY' || to === 'PLANNED')) {
      delete task.blockedReason;
      delete task.blockedAt;
    }

    if (to === 'BLOCKED') {
      task.blockedReason = input.reason?.trim() || task.blockedReason || 'explicitly blocked';
      task.blockedAt = nowIso();
    } else if (task.executionState === 'BLOCKED') {
      delete task.blockedReason;
      delete task.blockedAt;
    }

    task.executionState = to;
    if (input.reason?.trim()) task.lastTransitionReason = input.reason.trim();
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

export interface TransitionPmInput {
  expectedPmState: TaskPmState;
  to: TaskPmState;
  reason?: string;
  acceptedRunId?: string;
  /** When accepting, optionally assert execution axis too. */
  expectedExecutionState?: TaskExecutionState;
}

export function transitionTaskPm(
  dataRoot: string,
  project: string,
  taskId: string,
  input: TransitionPmInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    assertExpectedPm(task.pmState, input.expectedPmState);
    if (input.expectedExecutionState !== undefined) {
      assertExpectedExecution(task.executionState, input.expectedExecutionState);
    }

    if (task.pmState === input.to) {
      if (
        input.to === 'ACCEPTED'
        && input.acceptedRunId
        && input.acceptedRunId === task.acceptedRunId
      ) {
        return task;
      }
      return task; // idempotent
    }

    assertLegalPmTransition(task.pmState, input.to);

    if (input.to === 'ACCEPTED') {
      if (task.executionState !== 'RESULT_RECEIVED') {
        throw new Error('ACCEPTED는 executionState=RESULT_RECEIVED일 때만 설정할 수 있습니다.');
      }
      const runId = input.acceptedRunId ?? task.acceptedRunId;
      if (!runId) throw new Error('ACCEPTED에는 acceptedRunId가 필요합니다.');
      if (!task.linkedRuns.some((r) => r.runId === runId)) {
        throw new Error('acceptedRunId는 linkedRuns에 포함된 runId여야 합니다.');
      }
      task.acceptedRunId = runId;
    }

    if (task.pmState === 'ACCEPTED' && input.to === 'PENDING') {
      delete task.acceptedRunId;
    }
    if (input.to === 'CHANGES_REQUESTED') {
      delete task.acceptedRunId;
    }

    task.pmState = input.to;
    if (input.reason?.trim()) task.lastTransitionReason = input.reason.trim();
    task.updatedAt = nowIso();
    // No eager dependent mutation — readiness of dependents is derived on read.
    return persistTaskRecord(dataRoot, project, task);
  });
}

export function markResultReceived(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  opts?: { expectedExecutionState?: TaskExecutionState },
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (!task.linkedRuns.some((r) => r.runId === rid)) {
      throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
    }
    if (task.pmState === 'ACCEPTED') {
      throw new Error('이미 ACCEPTED된 Task에는 markResultReceived를 적용할 수 없습니다.');
    }

    // Idempotent replay: already RESULT_RECEIVED
    if (task.executionState === 'RESULT_RECEIVED') {
      if (opts?.expectedExecutionState && opts.expectedExecutionState !== 'RESULT_RECEIVED') {
        throw new RuntimeConflictError(
          `CONFLICT: expectedExecutionState=${opts.expectedExecutionState} but found RESULT_RECEIVED`,
        );
      }
      // Ensure review state
      if (task.pmState === 'CHANGES_REQUESTED' || task.pmState === 'PENDING') {
        task.pmState = 'VERIFYING';
        task.lastTransitionReason = `markResultReceived:${rid}`;
        task.updatedAt = nowIso();
        return persistTaskRecord(dataRoot, project, task);
      }
      return task;
    }

    if (opts?.expectedExecutionState !== undefined) {
      assertExpectedExecution(task.executionState, opts.expectedExecutionState);
    }

    if (task.executionState === 'DISPATCHED') {
      assertLegalExecutionTransition('DISPATCHED', 'RUNNING');
      assertLegalExecutionTransition('RUNNING', 'RESULT_RECEIVED');
    } else {
      assertLegalExecutionTransition(task.executionState, 'RESULT_RECEIVED');
    }

    task.executionState = 'RESULT_RECEIVED';
    if (task.pmState === 'CHANGES_REQUESTED' || task.pmState === 'PENDING') {
      task.pmState = 'VERIFYING';
    }
    task.lastTransitionReason = `markResultReceived:${rid}`;
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

export function acceptResult(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  opts?: {
    reason?: string;
    expectedPmState?: TaskPmState;
    expectedExecutionState?: TaskExecutionState;
  },
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (!task.linkedRuns.some((r) => r.runId === rid)) {
      throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
    }

    // Idempotent same accept
    if (task.pmState === 'ACCEPTED' && task.acceptedRunId === rid) {
      if (opts?.expectedPmState && opts.expectedPmState !== 'ACCEPTED') {
        // Replay of accept after success: treat as idempotent success when already accepted same run
        // unless caller insisted on a different expected — then conflict
        throw new RuntimeConflictError(
          `CONFLICT: expectedPmState=${opts.expectedPmState} but found ACCEPTED`,
        );
      }
      return task;
    }

    const expectedExec = opts?.expectedExecutionState ?? 'RESULT_RECEIVED';
    assertExpectedExecution(task.executionState, expectedExec);

    const expectedPm = opts?.expectedPmState ?? task.pmState;
    assertExpectedPm(task.pmState, expectedPm);

    if (task.pmState === 'CHANGES_REQUESTED') {
      throw new RuntimeConflictError(
        'CONFLICT: CHANGES_REQUESTED 상태에서는 acceptResult할 수 없습니다.',
      );
    }
    if (task.pmState === 'ACCEPTED' && task.acceptedRunId !== rid) {
      throw new Error('이미 다른 Run이 ACCEPTED되어 있습니다. 재개방 후 다시 시도하세요.');
    }

    if (task.pmState === 'PENDING') {
      assertLegalPmTransition('PENDING', 'VERIFYING');
      assertLegalPmTransition('VERIFYING', 'ACCEPTED');
    } else {
      assertLegalPmTransition(task.pmState, 'ACCEPTED');
    }

    task.acceptedRunId = rid;
    task.pmState = 'ACCEPTED';
    if (opts?.reason?.trim()) task.lastTransitionReason = opts.reason.trim();
    else task.lastTransitionReason = `acceptResult:${rid}`;
    task.updatedAt = nowIso();
    // No eager dependent mutation
    return persistTaskRecord(dataRoot, project, task);
  });
}

export function requestChanges(
  dataRoot: string,
  project: string,
  taskId: string,
  opts?: { reason?: string; expectedPmState?: TaskPmState },
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.pmState === 'CHANGES_REQUESTED') {
      if (opts?.expectedPmState && opts.expectedPmState !== 'CHANGES_REQUESTED') {
        throw new RuntimeConflictError(
          `CONFLICT: expectedPmState=${opts.expectedPmState} but found CHANGES_REQUESTED`,
        );
      }
      if (opts?.reason?.trim() && opts.reason.trim() !== task.lastTransitionReason) {
        task.lastTransitionReason = opts.reason.trim();
        task.updatedAt = nowIso();
        return persistTaskRecord(dataRoot, project, task);
      }
      return task; // idempotent
    }

    const expectedPm = opts?.expectedPmState ?? 'VERIFYING';
    assertExpectedPm(task.pmState, expectedPm);
    assertLegalPmTransition(task.pmState, 'CHANGES_REQUESTED');

    delete task.acceptedRunId;
    task.pmState = 'CHANGES_REQUESTED';
    if (opts?.reason?.trim()) task.lastTransitionReason = opts.reason.trim();
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * Explicit correction retry loop.
 * RESULT_RECEIVED + CHANGES_REQUESTED → READY + PENDING.
 * Preserves all linkedRuns; next attempt requires a NEW linked Run.
 */
export function requestRetry(
  dataRoot: string,
  project: string,
  taskId: string,
  opts?: {
    reason?: string;
    expectedExecutionState?: TaskExecutionState;
    expectedPmState?: TaskPmState;
  },
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    const expectedExec = opts?.expectedExecutionState ?? 'RESULT_RECEIVED';
    const expectedPm = opts?.expectedPmState ?? 'CHANGES_REQUESTED';

    assertExpectedExecution(task.executionState, expectedExec);
    assertExpectedPm(task.pmState, expectedPm);

    if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'CHANGES_REQUESTED') {
      throw new Error('requestRetry는 RESULT_RECEIVED + CHANGES_REQUESTED에서만 가능합니다.');
    }
    if (task.acceptedRunId) {
      throw new Error('requestRetry는 acceptedRunId가 없을 때만 가능합니다.');
    }

    task.executionState = 'READY';
    task.pmState = 'PENDING';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastTransitionReason = opts?.reason?.trim() || 'requestRetry';
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

// ── Goal completion / transitions ───────────────────────────────────────────

/** CANCELLED tasks are abandoned for completion purposes. */
export function isAbandonedTask(t: TaskRecord): boolean {
  return t.executionState === 'CANCELLED';
}

/** Pure / read-only — never writes Goal status. */
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
  void reason;
  return persistGoalRecord(dataRoot, project, goal);
}

/** Explicit write only — never called from progress/accept/refresh. */
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
    isEligibleForReady: readiness.isEligibleForReady,
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

/** Deterministic PM context seed — no LLM summarization. */
export function buildGoalRuntimeContext(
  dataRoot: string,
  project: string,
  goalId: string,
): GoalRuntimeState {
  return getGoalRuntimeState(dataRoot, project, goalId);
}
