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
 * PM (generic transitionTaskPm — lifecycle only):
 *   PENDING → VERIFYING
 *   VERIFYING → PENDING is illegal (only ACCEPTED → PENDING reopen).
 *   CHANGES_REQUESTED → VERIFYING | PENDING
 *   ACCEPTED → PENDING (explicit reopen; clears acceptedRunId)
 *   ACCEPTED and CHANGES_REQUESTED are NOT reachable via generic
 *   transitionTaskPm — they are canonical-only judgment mutations
 *   (task:acceptResult / task:requestChanges, Phase I3F-2/I3F-2H).
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

    // Phase I3F-2H hardening: canonical judgment states are NOT reachable via
    // the generic PM transition surface. Accept must go through acceptResult
    // (run binding + dual CAS + ACCEPT_RESULT permission + TASK_RESULT_ACCEPTED
    // Event + canonical acceptedRunId); Changes must go through requestChanges
    // (run binding + reason validation + TASK_CHANGES_REQUESTED Event).
    // No mutation occurs on rejection.
    if (input.to === 'ACCEPTED') {
      throw new Error(
        'INVALID_STATE: ACCEPTED must use canonical acceptResult action (task:acceptResult).',
      );
    }
    if (input.to === 'CHANGES_REQUESTED') {
      throw new Error(
        'INVALID_STATE: CHANGES_REQUESTED must use canonical requestChanges action (task:requestChanges).',
      );
    }

    if (task.pmState === input.to) {
      return task; // idempotent
    }

    assertLegalPmTransition(task.pmState, input.to);

    if (task.pmState === 'ACCEPTED' && input.to === 'PENDING') {
      delete task.acceptedRunId;
    }

    task.pmState = input.to;
    if (input.reason?.trim()) task.lastTransitionReason = input.reason.trim();
    task.updatedAt = nowIso();
    // No eager dependent mutation — readiness of dependents is derived on read.
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * Current attempt runId:
 *   acceptedRunId ?? latest linked Run by taskRunSequence
 */
export function resolveCurrentAttemptRunId(task: TaskRecord): string | undefined {
  if (task.acceptedRunId) return task.acceptedRunId;
  if (!task.linkedRuns.length) return undefined;
  const latest = [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  return latest?.runId;
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

/**
 * Phase I3F-2 canonical Accept Result input.
 * expectedExecutionState/expectedPmState are REQUIRED and fixed by contract —
 * no optional CAS, no permissive PENDING compatibility. goalId is required
 * and is verified against the Task's actual goalId (defense in depth).
 */
export interface AcceptResultInput {
  goalId: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  reason?: string;
}

/**
 * Canonical Accept Result correction (frozen I3F-2 contract).
 * Precondition: executionState=RESULT_RECEIVED, pmState=VERIFYING.
 * runId must be linked AND be the current (latest) attempt — historical/stale
 * Run acceptance is rejected. No force flag. No silent retry: a stale CAS
 * always CONFLICTs, including a second accept call after the first succeeded.
 */
export function acceptResult(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  opts: AcceptResultInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  if (!opts || typeof opts !== 'object') {
    throw new Error('잘못된 입력: acceptResult에는 goalId/expectedExecutionState/expectedPmState가 필요합니다.');
  }
  const goalId = requireNonEmptyString(opts.goalId, 'goalId');
  if (opts.expectedExecutionState !== 'RESULT_RECEIVED') {
    throw new Error('잘못된 입력: acceptResult의 expectedExecutionState는 RESULT_RECEIVED만 허용됩니다.');
  }
  if (opts.expectedPmState !== 'VERIFYING') {
    throw new Error('잘못된 입력: acceptResult의 expectedPmState는 VERIFYING만 허용됩니다.');
  }
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.goalId !== goalId) {
      throw new Error(`잘못된 goalId: Task ${id}의 goalId는 ${task.goalId}입니다.`);
    }
    if (!task.linkedRuns.some((r) => r.runId === rid)) {
      throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
    }

    // Strict CAS — no idempotent replay path. Once ACCEPTED, expectedPmState
    // (fixed at VERIFYING) can never match current state again; a second
    // accept call is a stale CAS and CONFLICTs (no silent retry).
    assertExpectedExecution(task.executionState, 'RESULT_RECEIVED');
    assertExpectedPm(task.pmState, 'VERIFYING');

    // Run binding: only the current (latest) attempt may be accepted.
    // acceptedRunId is guaranteed absent here (pmState===VERIFYING).
    const currentAttemptRunId = resolveCurrentAttemptRunId(task);
    if (currentAttemptRunId !== rid) {
      throw new Error(
        '잘못된 runId: 현재 시도(current attempt)가 아닌 과거/오래된 Run은 accept할 수 없습니다.',
      );
    }

    assertLegalPmTransition('VERIFYING', 'ACCEPTED');

    task.acceptedRunId = rid;
    task.pmState = 'ACCEPTED';
    task.lastTransitionReason = opts.reason?.trim() || `acceptResult:${rid}`;
    task.updatedAt = nowIso();
    // No eager dependent mutation
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * Phase I3F-2 canonical Request Changes input.
 * runId + dual CAS + bounded reason are all REQUIRED — no optional CAS.
 */
export interface RequestChangesInput {
  goalId: string;
  reason: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
}

/**
 * Canonical Request Changes correction (frozen I3F-2 contract).
 * Precondition: executionState=RESULT_RECEIVED, pmState=VERIFYING (dual CAS).
 * VERIFYING → CHANGES_REQUESTED; execution axis is left at RESULT_RECEIVED
 * (Changes != Retry — no automatic READY transition here).
 * runId must be linked AND be the current (latest) attempt.
 */
export function requestChanges(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  opts: RequestChangesInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  if (!opts || typeof opts !== 'object') {
    throw new Error('잘못된 입력: requestChanges에는 goalId/reason/expectedExecutionState/expectedPmState가 필요합니다.');
  }
  const goalId = requireNonEmptyString(opts.goalId, 'goalId');
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason.length < 10 || reason.length > 2000) {
    throw new Error('잘못된 reason: 10자 이상 2000자 이하이어야 합니다.');
  }
  if (opts.expectedExecutionState !== 'RESULT_RECEIVED') {
    throw new Error('잘못된 입력: requestChanges의 expectedExecutionState는 RESULT_RECEIVED만 허용됩니다.');
  }
  if (opts.expectedPmState !== 'VERIFYING') {
    throw new Error('잘못된 입력: requestChanges의 expectedPmState는 VERIFYING만 허용됩니다.');
  }
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.goalId !== goalId) {
      throw new Error(`잘못된 goalId: Task ${id}의 goalId는 ${task.goalId}입니다.`);
    }
    if (!task.linkedRuns.some((r) => r.runId === rid)) {
      throw new Error('runId는 이 Task에 연결된 Run이어야 합니다.');
    }

    // Dual CAS — strict, no idempotent replay path (no silent retry).
    assertExpectedExecution(task.executionState, 'RESULT_RECEIVED');
    assertExpectedPm(task.pmState, 'VERIFYING');

    const currentAttemptRunId = resolveCurrentAttemptRunId(task);
    if (currentAttemptRunId !== rid) {
      throw new Error(
        '잘못된 runId: 현재 시도(current attempt)가 아닌 과거/오래된 Run에는 changes를 요청할 수 없습니다.',
      );
    }

    assertLegalPmTransition('VERIFYING', 'CHANGES_REQUESTED');

    delete task.acceptedRunId;
    task.pmState = 'CHANGES_REQUESTED';
    task.lastTransitionReason = reason;
    task.updatedAt = nowIso();
    // Execution axis untouched — Changes != Retry, no automatic READY here.
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * Phase I3F-2 canonical Retry input. Dual CAS REQUIRED — no defaulting.
 */
export interface RequestRetryInput {
  goalId: string;
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  reason?: string;
}

/**
 * Explicit correction retry loop (frozen I3F-2 contract).
 * RESULT_RECEIVED + CHANGES_REQUESTED → READY + PENDING.
 * Preserves all linkedRuns; next attempt requires a NEW linked Run.
 * Does NOT create a new Run, does NOT dispatch, does NOT retry FAILED.
 */
export function requestRetry(
  dataRoot: string,
  project: string,
  taskId: string,
  opts: RequestRetryInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  if (!opts || typeof opts !== 'object') {
    throw new Error('잘못된 입력: requestRetry에는 goalId/expectedExecutionState/expectedPmState가 필요합니다.');
  }
  const goalId = requireNonEmptyString(opts.goalId, 'goalId');
  if (opts.expectedExecutionState !== 'RESULT_RECEIVED') {
    throw new Error('잘못된 입력: requestRetry의 expectedExecutionState는 RESULT_RECEIVED만 허용됩니다.');
  }
  if (opts.expectedPmState !== 'CHANGES_REQUESTED') {
    throw new Error('잘못된 입력: requestRetry의 expectedPmState는 CHANGES_REQUESTED만 허용됩니다.');
  }
  if (opts.reason !== undefined && opts.reason.length > 500) {
    throw new Error('잘못된 reason: 500자 이하이어야 합니다.');
  }
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.goalId !== goalId) {
      throw new Error(`잘못된 goalId: Task ${id}의 goalId는 ${task.goalId}입니다.`);
    }

    // Dual CAS — strict, no silent retry.
    assertExpectedExecution(task.executionState, 'RESULT_RECEIVED');
    assertExpectedPm(task.pmState, 'CHANGES_REQUESTED');

    if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'CHANGES_REQUESTED') {
      throw new Error('requestRetry는 RESULT_RECEIVED + CHANGES_REQUESTED에서만 가능합니다.');
    }
    if (task.acceptedRunId) {
      throw new Error('requestRetry는 acceptedRunId가 없을 때만 가능합니다.');
    }

    task.executionState = 'READY';
    task.pmState = 'PENDING';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastTransitionReason = opts.reason?.trim() || 'requestRetry';
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

/** PM recovery retry for a Run that failed before Result capture. */
export function requestFailedRunRetry(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  opts: { goalId: string; reason?: string },
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  const goalId = requireNonEmptyString(opts?.goalId, 'goalId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    if (task.goalId !== goalId) throw new Error(`잘못된 goalId: Task ${id}의 goalId는 ${task.goalId}입니다.`);
    if (task.executionState !== 'FAILED' || task.pmState !== 'PENDING') throw new RuntimeConflictError(`FAILED recovery requires FAILED+PENDING (found ${task.executionState}+${task.pmState})`);
    if (resolveCurrentAttemptRunId(task) !== rid) throw new RuntimeConflictError(`Run ${rid} is not the current failed attempt.`);
    task.executionState = 'READY';
    task.retryCount = (task.retryCount ?? 0) + 1;
    task.lastTransitionReason = opts.reason?.trim() || `requestFailedRunRetry:${rid}`;
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * V1.6 Slice 4 — QA-gated Result receipt.
 *
 * Same promotion as markResultReceived (DISPATCHED/RUNNING → RESULT_RECEIVED,
 * idempotent replay) EXCEPT pmState is deliberately left at PENDING instead
 * of being flipped to VERIFYING. The QA gate (qa-gate.ts) owns the
 * PENDING → VERIFYING transition itself: only on QA PASS, remediation-budget
 * exhaustion, or QA BLOCKED — never before the verdict is decided (plan §8).
 *
 * Strict CAS: the execution axis must be pre-gate (DISPATCHED/RUNNING, or an
 * idempotent RESULT_RECEIVED replay) AND pmState must be PENDING. A Task
 * that already left PENDING (VERIFYING/CHANGES_REQUESTED/ACCEPTED) is
 * refused — the gate never pulls a Task back into QA.
 */
export function markQaResultReceived(
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
      throw new Error('이미 ACCEPTED된 Task에는 markQaResultReceived를 적용할 수 없습니다.');
    }

    // Idempotent replay: already RESULT_RECEIVED — return as-is regardless
    // of pmState (an escalated VERIFYING Task replays through the gate's
    // delivery-ensure path, never back into QA evaluation).
    if (task.executionState === 'RESULT_RECEIVED') {
      if (opts?.expectedExecutionState && opts.expectedExecutionState !== 'RESULT_RECEIVED') {
        throw new RuntimeConflictError(
          `CONFLICT: expectedExecutionState=${opts.expectedExecutionState} but found RESULT_RECEIVED`,
        );
      }
      return task;
    }

    if (opts?.expectedExecutionState !== undefined) {
      assertExpectedExecution(task.executionState, opts.expectedExecutionState);
    }
    if (task.pmState !== 'PENDING') {
      throw new RuntimeConflictError(
        `CONFLICT: markQaResultReceived requires pmState=PENDING but found ${task.pmState}`,
      );
    }

    if (task.executionState === 'DISPATCHED') {
      assertLegalExecutionTransition('DISPATCHED', 'RUNNING');
      assertLegalExecutionTransition('RUNNING', 'RESULT_RECEIVED');
    } else {
      assertLegalExecutionTransition(task.executionState, 'RESULT_RECEIVED');
    }

    task.executionState = 'RESULT_RECEIVED';
    // pmState deliberately untouched — stays PENDING until the QA gate
    // decides PASS (→ VERIFYING + Delivery), FAIL-remediation (stays
    // PENDING, execution → READY), or BLOCKED/exhausted (→ VERIFYING).
    task.lastTransitionReason = `markQaResultReceived:${rid}`;
    task.updatedAt = nowIso();
    return persistTaskRecord(dataRoot, project, task);
  });
}

/**
 * V1.6 Slice 4 — QA-remediation retry.
 *
 * Canonical RESULT_RECEIVED + PENDING → READY + PENDING for a QA FAIL with
 * remediation budget remaining (plan §11 step 3).
 *
 * Why not reuse requestRetry: that command hard-requires pmState
 * CHANGES_REQUESTED, and QA must NEVER set CHANGES_REQUESTED (that state is
 * exclusively GPT PM's own vocabulary — plan §8 Q5). A narrow additive
 * variant with its own strict CAS is the minimal honest shape; the
 * transition itself (READY + PENDING post-state, linkedRuns preserved, a NEW
 * linked Run required next) is identical.
 *
 * Lineage distinction: `retryCount` (G5 explicit-request metadata) is
 * deliberately NOT incremented — the authoritative QA-remediation budget
 * counter is `qaRemediationNumber` on the QaRemediationPreparationRecord,
 * and the new Run carries `qaRemediationPreparationId` (never
 * `retryPreparationId`). This function creates no Run and dispatches
 * nothing; the gate dispatches after this commits.
 */
export interface RequestQaRemediationRetryInput {
  goalId: string;
  reason?: string;
}

export function requestQaRemediationRetry(
  dataRoot: string,
  project: string,
  taskId: string,
  opts: RequestQaRemediationRetryInput,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  if (!opts || typeof opts !== 'object') {
    throw new Error('잘못된 입력: requestQaRemediationRetry에는 goalId가 필요합니다.');
  }
  const goalId = requireNonEmptyString(opts.goalId, 'goalId');
  if (opts.reason !== undefined && opts.reason.length > 500) {
    throw new Error('잘못된 reason: 500자 이하이어야 합니다.');
  }
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);

    if (task.goalId !== goalId) {
      throw new Error(`잘못된 goalId: Task ${id}의 goalId는 ${task.goalId}입니다.`);
    }

    // Dual CAS — strict, no idempotent replay path (no silent retry).
    assertExpectedExecution(task.executionState, 'RESULT_RECEIVED');
    assertExpectedPm(task.pmState, 'PENDING');

    if (task.acceptedRunId) {
      throw new Error('requestQaRemediationRetry는 acceptedRunId가 없을 때만 가능합니다.');
    }

    task.executionState = 'READY';
    task.pmState = 'PENDING';
    // retryCount intentionally untouched (see docstring — G5 lineage stays clean).
    task.lastTransitionReason = opts.reason?.trim() || 'requestQaRemediationRetry';
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

/**
 * Phase H — CAS-guarded Goal completion.
 * Re-evaluates eligibility at mutation time.
 */
export function completeGoalWithExpected(
  dataRoot: string,
  project: string,
  goalId: string,
  opts: { expectedGoalStatus: GoalStatus; reason?: string },
): GoalRecord {
  const id = requireNonEmptyString(goalId, 'goalId');
  const expected = opts.expectedGoalStatus;
  if (!expected) {
    throw new Error('expectedGoalStatus이(가) 필요합니다.');
  }
  const goal = getGoal(dataRoot, project, id);
  if (goal.status !== expected) {
    throw new RuntimeConflictError(
      `CONFLICT: expectedGoalStatus=${expected} but found ${goal.status}`,
    );
  }
  if (goal.status === 'COMPLETED') {
    return goal; // idempotent
  }
  const evaluation = evaluateGoalCompletion(goal, listTasks(dataRoot, project, goal.goalId));
  if (!evaluation.eligible) {
    throw new Error(
      `INVALID_STATE: Goal 완료 불가: ${evaluation.reasons.join(' / ') || 'eligibility failed'}`,
    );
  }
  return completeGoal(dataRoot, project, id, opts.reason);
}

/**
 * Phase I3 — CAS-guarded PLANNING → ACTIVE transition.
 *
 * Narrowly scoped: ONLY transitions a PLANNING Goal to ACTIVE.
 * Does NOT dispatch Tasks, complete Goals, create Tasks, or start any
 * automated loop.  The PM remains in full control after activation.
 *
 * CAS semantics: expectedGoalStatus MUST equal 'PLANNING'.
 * Any other expected value → INVALID_ARGUMENT.
 * Stale (status already changed) → CONFLICT via RuntimeConflictError.
 * Idempotent: PLANNING→ACTIVE if already ACTIVE returns the current record.
 */
export function activateGoal(
  dataRoot: string,
  project: string,
  goalId: string,
  opts: { expectedGoalStatus: 'PLANNING'; reason?: string },
): GoalRecord {
  const id = requireNonEmptyString(goalId, 'goalId');
  if (opts.expectedGoalStatus !== 'PLANNING') {
    throw new Error(
      `activateGoal에서는 expectedGoalStatus='PLANNING'만 허용됩니다. (got: ${String(opts.expectedGoalStatus)})`,
    );
  }
  const goal = getGoal(dataRoot, project, id);
  if (goal.status !== 'PLANNING') {
    throw new RuntimeConflictError(
      `CONFLICT: expectedGoalStatus=PLANNING but found ${goal.status}`,
    );
  }
  // PLANNING → ACTIVE is legal per GOAL_TRANSITIONS
  assertLegalGoalTransition(goal.status, 'ACTIVE');
  goal.status = 'ACTIVE';
  goal.updatedAt = nowIso();
  void opts.reason;
  return persistGoalRecord(dataRoot, project, goal);
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
