/**
 * V1-G1 — PM MCP Single Task Intake.
 *
 * Task-first V1 surface: GPT PM submits ONE finalized Task Contract and gets
 * ONE canonical Task back, without managing a Goal manually.
 *
 * Internal Goal compatibility (no schema redesign):
 *   - The Task kernel requires goalId, so V1 keeps a single deterministic
 *     internal technical container Goal per scoped project.
 *   - Identified by the frozen `V1_CONTAINER_TAG` ('v1-internal') plus the
 *     frozen container title. Ensure/reuse is serialized per scoped project
 *     through a process-local per-project Promise chain (see
 *     `withV1ContainerLock`): inside the lock the code lists matching
 *     containers, reuses the lowest sorted matching goalId when present, and
 *     creates exactly one container only when none exists. Concurrent first
 *     intakes in the same Relay process therefore cannot multiply containers.
 *     Unrelated projects/dataRoots use distinct lock keys and never block
 *     each other. Cross-process races are out of scope for V1-G1.
 *   - The container is ordinary Goal-kernel data (status PLANNING, mode PLAN,
 *     least privilege). No new public Goal UX, no auto-activate, no auto
 *     complete, no permission escalation. PM MCP DISPATCH under PLAN remains
 *     owner-gated (STOP_POLICY) — V1-G2 owns that explicit dispatch decision.
 *
 * State preparation (frozen runtime transition only):
 *   - createTask() persists PLANNED+PENDING. Intake then applies the single
 *     already-frozen canonical transition PLANNED → READY via
 *     transitionTaskExecution (CAS), so the Task is suitable for the next V1
 *     dispatch stage (dispatcher requires READY). No auto-dispatch, no run
 *     linkage, no judgment mutation.
 */

import * as path from 'node:path';
import {
  createGoal,
  createTask,
  listGoals,
} from './goal-task.js';
import { transitionTaskExecution } from './goal-task-runtime.js';
import type { GoalRecord, TaskRecord } from '../shared/types.js';

/** Frozen marker identifying the internal V1 technical container. */
export const V1_CONTAINER_TAG = 'v1-internal';
export const V1_CONTAINER_TITLE = 'V1 Single-Task Inbox (internal technical container)';
export const V1_CONTAINER_GOAL_STATEMENT =
  'Internal V1 technical container for single-task relay. Not user-facing Goal UX. ' +
  'Exists only because the Task schema requires goalId.';

export interface V1TaskContractInput {
  title: string;
  goal: string;
  reason: string;
  scope: string;
  completionCriteria?: string[];
}

export interface V1IntakeResult {
  goal: GoalRecord;
  task: TaskRecord;
  /** True when a pre-existing container was reused; false when just created. */
  containerReused: boolean;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function normalizeCriteria(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('completionCriteria는 문자열 배열이어야 합니다.');
  for (let i = 0; i < input.length; i += 1) {
    if (typeof input[i] !== 'string') {
      throw new Error(`completionCriteria[${i}]는 문자열이어야 합니다.`);
    }
  }
  return [...(input as string[])];
}

function isV1Container(g: GoalRecord): boolean {
  if (g.title === V1_CONTAINER_TITLE) return true;
  return Array.isArray(g.tags) && g.tags.includes(V1_CONTAINER_TAG);
}

/**
 * Process-local per-project serialization for V1 container ensure/create.
 *
 * Key = resolved dataRoot + project, so unrelated projects/dataRoots never
 * block each other. Each key owns an independent Promise chain; every
 * ensure/create runs strictly after the previous one for the same scope.
 * The chain tail never rejects (errors are propagated to the caller but
 * swallowed in the stored tail) so one failure cannot wedge later intakes.
 */
const _v1ContainerChains = new Map<string, Promise<void>>();

function v1ScopeKey(dataRoot: string, project: string): string {
  return `${path.resolve(dataRoot)}@@${project}`;
}

function withV1ContainerLock<T>(
  dataRoot: string,
  project: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = v1ScopeKey(dataRoot, project);
  const prev = _v1ContainerChains.get(key) ?? Promise.resolve();
  const work = prev.then(fn);
  const tail = work.then(
    () => undefined,
    () => undefined,
  );
  _v1ContainerChains.set(key, tail);
  tail.then(() => {
    if (_v1ContainerChains.get(key) === tail) _v1ContainerChains.delete(key);
  });
  return work;
}

/** Test-only reset for the process-local V1 container chains. */
export function _resetV1ContainerLocksForTests(): void {
  _v1ContainerChains.clear();
}

/**
 * Deterministic serialized create/reuse of the internal V1 container Goal.
 * Reuse rule: lowest sorted matching goalId wins. No duplicates on repeats,
 * including concurrent first intakes within this process (serialized above).
 */
export async function ensureV1ContainerGoal(
  dataRoot: string,
  project: string,
): Promise<{ goal: GoalRecord; reused: boolean }> {
  return withV1ContainerLock(dataRoot, project, async () => {
    const existing = listGoals(dataRoot, project)
      .filter(isV1Container)
      .sort((a, b) => a.goalId.localeCompare(b.goalId));
    if (existing.length > 0) {
      return { goal: existing[0]!, reused: true };
    }
    const goal = await createGoal(dataRoot, project, {
      title: V1_CONTAINER_TITLE,
      goalStatement: V1_CONTAINER_GOAL_STATEMENT,
      description: 'V1-G1 internal compatibility container. Do not use as product Goal UX.',
      tags: [V1_CONTAINER_TAG, 'technical-container'],
      completionCriteria: [],
      // Default permissionPolicy (PLAN, least privilege). No escalation in G1.
    });
    return { goal, reused: false };
  });
}

/**
 * Canonical V1 intake: validate contract → ensure container → createTask →
 * narrow PLANNED → READY preparation via the frozen runtime transition.
 */
export async function createV1TaskFromContract(
  dataRoot: string,
  project: string,
  input: V1TaskContractInput,
): Promise<V1IntakeResult> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('잘못된 입력: Task Contract 객체가 필요합니다.');
  }
  const title = requireNonEmptyString(input.title, 'title');
  const goalText = requireNonEmptyString(input.goal, 'goal');
  if (typeof input.reason !== 'string') throw new Error('reason이 필요합니다.');
  if (typeof input.scope !== 'string') throw new Error('scope가 필요합니다.');
  const completionCriteria = normalizeCriteria(input.completionCriteria);

  const { goal, reused } = await ensureV1ContainerGoal(dataRoot, project);

  const created = await createTask(dataRoot, project, {
    goalId: goal.goalId,
    title,
    goal: goalText,
    reason: input.reason,
    scope: input.scope,
    completionCriteria,
  });

  // Narrow frozen preparation: PLANNED → READY so V1-G2 dispatch (which
  // requires READY) can proceed. No dependencies → always eligible.
  const ready = await transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED',
    to: 'READY',
    reason: 'v1-intake:ready-for-dispatch',
  });

  return { goal, task: ready, containerReused: reused };
}
