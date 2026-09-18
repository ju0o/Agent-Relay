/**
 * AUTO Goal Loop — Goal→Task→Run→dispatch→capture→ChatGPT review→PASS/CHANGES→retry|NEXT→GOAL_COMPLETE.
 *
 * Reuses ONLY existing canonical machinery:
 * - goal-task.ts (Goal/Task records, linkRunToTask)
 * - goal-task-runtime.ts (READY→DISPATCHED→RUNNING→RESULT_RECEIVED, VERIFYING→ACCEPTED/CHANGES_REQUESTED, retry, goal completion)
 * - task-actions.ts (canonical accept/changes/retry with permission gate + events)
 * - dispatcher.ts via runtime-transport.ts (automatic dispatch, default internal)
 * - fs.ts (Run folders, prompt.md/result.md/meta.json)
 * - chatgpt-review.ts (external-tool-only independent reviewer)
 * - pm-delivery.ts / pm-judgment.ts + evidence.ts + event.ts for audit linkage (best-effort)
 *
 * What it does NOT do:
 * - No new Task DB / Run model / Result format / retry engine / PM state machine.
 * - No JuAgent, no orchestration engine, no JuControler touch.
 * - No Founder clipboard / pane lookup / tmux interaction (transport layer owns it).
 * - No silent PASS on review failure (REVIEW_BLOCKED stops the loop, Run stays durable).
 * - CHANGES keeps the SAME Task and creates a NEW Run attempt (retry lineage via linkedRuns).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createGoal,
  createTask,
  getGoal,
  getTask,
  listTasks,
  relayDir,
  writeJsonAtomic,
} from './goal-task.js';
import {
  evaluateGoalCompletionForId,
  activateGoal,
  completeGoal,
  getTaskReadinessForId,
  markResultReceived,
  refreshTaskReadiness,
  resolveCurrentAttemptRunId,
  transitionTaskExecution,
} from './goal-task-runtime.js';
import { acceptTaskResult, requestTaskChanges, requestTaskRetry } from './task-actions.js';
import { ensurePmDeliveryForTaskVerify } from './pm-delivery.js';
import { submitPmJudgment } from './pm-judgment.js';
import { recordAdapterObservation } from './evidence.js';
import { readRun } from './fs.js';
import { reviewRunWithChatGpt, type ChatGptReviewOptions } from './chatgpt-review.js';
import { autoDispatch, type RuntimeTransportKind } from './runtime-transport.js';
import { loadWorkerRegistryRecord } from './worker-registry.js';
import { releaseObservationLockByBinding } from './observation-lock.js';
import { ensureDispatchCaptureManager } from './capture-service.js';
import type { GoalRecord, TaskRecord } from '../shared/types.js';

export const GOAL_LOOP_SCHEMA_VERSION = 1;
export const GOAL_LOOP_MAX_TASKS_DEFAULT = 10;
export const GOAL_LOOP_MAX_ATTEMPTS_PER_TASK_DEFAULT = 3;
export const GOAL_LOOP_RESULT_WAIT_MS_DEFAULT = 120000;
export const GOAL_LOOP_RESULT_POLL_MS = 2000;

export type GoalLoopStatus =
  | 'RUNNING'
  | 'GOAL_COMPLETE'
  | 'STOPPED_OWNER_REQUIRED'
  | 'STOPPED_BLOCKED'
  | 'STOPPED_REVIEW_BLOCKED'
  | 'STOPPED_FAILED';

export interface GoalLoopStartInput {
  dataRoot: string;
  project: string;
  /** Existing goal to drive. If absent with goalTitle/goalStatement, a new GOAL is created. */
  goalId?: string;
  goalTitle?: string;
  goalStatement?: string;
  /** Optional bounded plan: titles for Task 1..N. When omitted, one bounded Task is used. */
  taskPlan?: string[];
  workerId: string;
  workspaceRoot: string;
  transport?: RuntimeTransportKind;
  actlAgent?: string;
  maxTasks?: number;
  maxAttemptsPerTask?: number;
  /** How long to wait for a dispatched Run result before failing stopped (ms). */
  resultWaitMs?: number;
  /** Test-only deterministic reviewer. NEVER set in production. */
  reviewMode?: ChatGptReviewOptions['reviewMode'];
}

export interface GoalLoopState {
  schemaVersion: number;
  goalId: string;
  project: string;
  status: GoalLoopStatus;
  currentTaskId: string | null;
  tasksDriven: string[];
  attempts: Record<string, number>;
  metrics: {
    manualPromptCopy: number;
    manualResultPaste: number;
    gptDrag: number;
    manualChatGptSend: number;
    manualResultRecovery: number;
    manualRetryDispatch: number;
    manualNextWake: number;
    founderClipboardActions: number;
    founderTmuxActions: number;
  };
  lastVerdict?: string;
  lastReason?: string;
  stoppedDetail?: string;
  updatedAt: string;
}

export interface GoalLoopResult extends GoalLoopState {
  goal: GoalRecord;
}

function loopDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'goal-loops');
}

function loopPath(dataRoot: string, project: string, goalId: string): string {
  return path.join(loopDir(dataRoot, project), `${goalId}.json`);
}

function persistState(dataRoot: string, project: string, state: GoalLoopState): void {
  fs.mkdirSync(loopDir(dataRoot, project), { recursive: true });
  writeJsonAtomic(loopPath(dataRoot, project, state.goalId), state);
}

export function getGoalLoopStatus(dataRoot: string, project: string, goalId: string): GoalLoopState {
  const p = loopPath(dataRoot, project, goalId);
  if (!fs.existsSync(p)) throw new Error(`Goal loop state not found: ${goalId}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as GoalLoopState;
}

function bound(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

function shortSha(workspaceRoot: string): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8', timeout: 5000 });
    const s = String(r.stdout ?? '').trim();
    if (s && /^[0-9a-f]{4,40}$/i.test(s)) return s;
  } catch { /* best-effort */ }
  return 'unknown';
}

function diffStat(workspaceRoot: string): string {
  try {
    const r = spawnSync('git', ['diff', '--stat', '--', '.'], { cwd: workspaceRoot, encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) return bound(String(r.stdout ?? '').trim().slice(0, 2000) || '(clean)', 2000);
  } catch { /* best-effort */ }
  return '(unavailable)';
}

function isOwnerGate(text: string): boolean {
  return /credential|login|password|secret|destructi|rm -rf|mkfs|release|production deploy|final acceptance|ambiguous|product direction|security|permission/i.test(text);
}

/**
 * Release per-attempt observation resources so SAME-task retry can
 * re-acquire the adapter lock on the same workspace. Best-effort only —
 * canonical Task/Run state is never mutated here.
 */
function releaseAttemptResources(
  dataRoot: string,
  workerId: string,
  workspaceRoot: string,
  taskId: string,
  runId: string,
  folder: string,
): void {
  try {
    const worker = loadWorkerRegistryRecord(dataRoot, workerId);
    const adapterId = worker.observationAdapterId?.trim();
    if (adapterId) {
      releaseObservationLockByBinding({ observationAdapterId: adapterId, workspaceRoot, taskId, runId });
    }
  } catch { /* best-effort */ }
  try {
    const cm = ensureDispatchCaptureManager();
    void cm.disarm(folder).catch(() => undefined);
  } catch { /* best-effort */ }
}

async function waitForTaskResult(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  timeoutMs: number,
): Promise<{ folder: string; resultText: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastFolder = '';
  for (;;) {
    const task = getTask(dataRoot, project, taskId);
    const linked = task.linkedRuns.find((r) => r.runId === runId);
    const folder = linked?.folder ?? lastFolder;
    if (folder) {
      lastFolder = folder;
      try {
        const run = readRun(folder);
        const text = String((run as { result?: string }).result ?? '').trim();
        if (text) {
          // Canonical capture point: mark RESULT_RECEIVED (idempotent best-effort).
          try {
            const cur = getTask(dataRoot, project, taskId);
            if (cur.executionState === 'RUNNING' || cur.executionState === 'DISPATCHED') {
              await markResultReceived(dataRoot, project, taskId, runId, { expectedExecutionState: cur.executionState });
            }
          } catch { /* already received / raced — durable state wins */ }
          return { folder, resultText: bound(text, 8000) };
        }
      } catch { /* folder not yet materialized */ }
    }
    const cur = getTask(dataRoot, project, taskId);
    if (cur.executionState === 'RESULT_RECEIVED') {
      const l = cur.linkedRuns.find((r) => r.runId === runId);
      if (l?.folder) {
        try {
          const run = readRun(l.folder);
          const text = String((run as { result?: string }).result ?? '').trim();
          return { folder: l.folder, resultText: bound(text, 8000) };
        } catch { /* fall through */ }
      }
    }
    if (cur.executionState === 'FAILED' || cur.executionState === 'CANCELLED') {
      throw new Error(`Task ${taskId} run ${runId} ended in ${cur.executionState} before a Result was captured.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Result of run ${runId} (${timeoutMs}ms). Run remains durable; no PASS was marked.`);
    }
    await new Promise((r) => setTimeout(r, GOAL_LOOP_RESULT_POLL_MS));
  }
}

/**
 * Drive one Goal to completion (or to a genuine human gate / durable stop).
 * Synchronous stepwise runner — safe to invoke from IPC/MCP/CLI headless.
 */
export async function startGoalLoop(input: GoalLoopStartInput): Promise<GoalLoopResult> {
  const dataRoot = input.dataRoot;
  const project = input.project;
  if (!dataRoot) throw new Error('dataRoot가 필요합니다.');
  if (!project) throw new Error('project가 필요합니다.');
  if (!input.workerId) throw new Error('workerId가 필요합니다.');
  if (!input.workspaceRoot) throw new Error('workspaceRoot가 필요합니다.');
  const transport: RuntimeTransportKind = input.transport ?? 'internal';
  const maxTasks = Math.max(1, Math.min(input.maxTasks ?? GOAL_LOOP_MAX_TASKS_DEFAULT, 25));
  const maxAttempts = Math.max(1, Math.min(input.maxAttemptsPerTask ?? GOAL_LOOP_MAX_ATTEMPTS_PER_TASK_DEFAULT, 5));
  const resultWaitMs = input.resultWaitMs ?? GOAL_LOOP_RESULT_WAIT_MS_DEFAULT;
  const reviewMode = input.reviewMode ?? 'real';

  // 1. Goal resolve/create.
  let goal: GoalRecord;
  if (input.goalId) {
    goal = getGoal(dataRoot, project, input.goalId);
  } else {
    if (!input.goalTitle || !input.goalStatement) throw new Error('goalId 또는 goalTitle+goalStatement이 필요합니다.');
    goal = await createGoal(dataRoot, project, {
      title: bound(input.goalTitle, 200),
      goalStatement: bound(input.goalStatement, 2000),
    });
  }

  const state: GoalLoopState = {
    schemaVersion: GOAL_LOOP_SCHEMA_VERSION,
    goalId: goal.goalId,
    project,
    status: 'RUNNING',
    currentTaskId: null,
    tasksDriven: [],
    attempts: {},
    metrics: {
      manualPromptCopy: 0,
      manualResultPaste: 0,
      gptDrag: 0,
      manualChatGptSend: 0,
      manualResultRecovery: 0,
      manualRetryDispatch: 0,
      manualNextWake: 0,
      founderClipboardActions: 0,
      founderTmuxActions: 0,
    },
    updatedAt: new Date().toISOString(),
  };
  persistState(dataRoot, project, state);

  const finish = (status: GoalLoopStatus, detail?: string): GoalLoopResult => {
    state.status = status;
    if (detail) state.stoppedDetail = bound(detail, 1000);
    state.updatedAt = new Date().toISOString();
    persistState(dataRoot, project, state);
    return { ...state, goal: getGoal(dataRoot, project, goal.goalId) };
  };

  // AUTO loop owns execution: PLANNING → ACTIVE (idempotent best-effort).
  try {
    const g = getGoal(dataRoot, project, goal.goalId);
    if (g.status === 'PLANNING') {
      goal = await activateGoal(dataRoot, project, goal.goalId, { expectedGoalStatus: 'PLANNING', reason: 'AUTO goal loop started' });
    }
  } catch { /* already active or raced — completion checks below fail closed */ }

  // 2. Task plan resolve: existing READY tasks first, else create from taskPlan (or one bounded task).
  let plan = (input.taskPlan ?? []).map((t) => bound(t, 200)).filter((t) => t.length > 0).slice(0, maxTasks);
  const existing = listTasks(dataRoot, project, goal.goalId).filter((t) =>
    ['PLANNED', 'READY', 'DISPATCHED', 'RUNNING', 'RESULT_RECEIVED'].includes(t.executionState),
  );
  if (existing.length === 0 && plan.length === 0) {
    plan = [`${goal.title} — bounded attempt 1`];
  }

  for (let taskIdx = 0; taskIdx < maxTasks; taskIdx++) {
    // Pick next task: first READY (deps satisfied), else create next from plan, else evaluate goal.
    let task: TaskRecord | null = null;
    const candidates = listTasks(dataRoot, project, goal.goalId);
    for (const c of candidates) {
      if (c.executionState === 'READY') {
        try {
          const readiness = getTaskReadinessForId(dataRoot, project, c.taskId);
          if (readiness.kind === 'READY') {
            task = c;
            break;
          }
        } catch { /* treat as not ready */ }
      }
    }
    if (!task) {
      const nextTitle = plan[taskIdx];
      if (nextTitle && candidates.length < maxTasks) {
        const created = await createTask(dataRoot, project, {
          goalId: goal.goalId,
          title: nextTitle,
          goal: bound(`Goal ${goal.goalId}: ${goal.title}`, 500),
          reason: 'AUTO goal loop task (bounded, owner-approved plan).',
          scope: bound(nextTitle, 500),
          completionCriteria: goal.completionCriteria ?? [],
        });
        task = created;
        // PLANNED→READY when dependencies allow (no deps → READY).
        try {
          await refreshTaskReadiness(dataRoot, project, task.taskId);
        } catch { /* keep PLANNED and fail closed below */ }
        task = getTask(dataRoot, project, task.taskId);
        if (task.executionState === 'PLANNED') {
          try {
            await transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'PLANNED', to: 'READY', reason: 'AUTO loop: bounded task ready' });
            task = getTask(dataRoot, project, task.taskId);
          } catch { /* fail closed below */ }
        }
      }
    }
    if (!task || task.executionState !== 'READY') {
      // No further READY work — evaluate goal completion.
      const evalRes = evaluateGoalCompletionForId(dataRoot, project, goal.goalId);
      if (evalRes.eligible) {
        await completeGoal(dataRoot, project, goal.goalId, 'AUTO goal loop: all tasks accepted.');
        return finish('GOAL_COMPLETE');
      }
      return finish('STOPPED_BLOCKED', 'No READY task available and goal is not complete — owner decision required.');
    }

    state.currentTaskId = task.taskId;
    if (!state.tasksDriven.includes(task.taskId)) state.tasksDriven.push(task.taskId);
    state.updatedAt = new Date().toISOString();
    persistState(dataRoot, project, state);

    // 3. Attempt loop for SAME task (CHANGES → NEW run, lineage via linkedRuns).
    for (let attempt = (state.attempts[task.taskId] ?? 0) + 1; attempt <= maxAttempts; attempt++) {
      state.attempts[task.taskId] = attempt;
      persistState(dataRoot, project, state);

      // 3a. Automatic dispatch (no founder clipboard/pane/enter).
      let runId: string;
      try {
        const d = await autoDispatch({
          dataRoot,
          project,
          taskId: task.taskId,
          workerId: input.workerId,
          workspaceRoot: input.workspaceRoot,
          transport,
          actlAgent: input.actlAgent,
        });
        runId = d.runId;
      } catch (e) {
        return finish('STOPPED_FAILED', `Automatic dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 3b. Automatic result capture (canonical Run result.md).
      let folder: string;
      let resultText: string;
      try {
        const w = await waitForTaskResult(dataRoot, project, task.taskId, runId, resultWaitMs);
        folder = w.folder;
        resultText = w.resultText;
      } catch (e) {
        return finish('STOPPED_FAILED', e instanceof Error ? e.message : String(e));
      }
      // Free the adapter observation slot so SAME-task retry can re-acquire it.
      releaseAttemptResources(dataRoot, input.workerId, input.workspaceRoot, task.taskId, runId, folder);

      // 3c. Audit linkage best-effort (Delivery mint; never breaks the loop).
      let deliveryId: string | null = null;
      try {
        const cur = getTask(dataRoot, project, task.taskId);
        if (cur.executionState === 'RESULT_RECEIVED' && cur.pmState === 'VERIFYING') {
          const del = await ensurePmDeliveryForTaskVerify(dataRoot, project, task.taskId);
          deliveryId = del ? del.deliveryId : null;
        }
      } catch { /* audit only */ }

      // 3d. Automatic ChatGPT independent review (bounded context).
      const curTask = getTask(dataRoot, project, task.taskId);
      const seq = curTask.linkedRuns.find((r) => r.runId === runId)?.taskRunSequence ?? attempt;
      const review = await reviewRunWithChatGpt(
        {
          goalTitle: goal.title,
          goalStatement: goal.goalStatement,
          taskId: task.taskId,
          taskTitle: curTask.title,
          acceptanceCriteria: curTask.completionCriteria ?? [],
          runId,
          attemptSequence: seq,
          resultExcerpt: resultText,
          diffStat: diffStat(input.workspaceRoot),
          repoSha: shortSha(input.workspaceRoot),
        },
        { reviewMode },
      );
      state.lastVerdict = review.verdict;
      state.lastReason = bound(review.reason, 300);
      persistState(dataRoot, project, state);

      // Audit: adapter observation + judgment (best-effort).
      try {
        await recordAdapterObservation(dataRoot, project, {
          runId,
          taskId: task.taskId,
          ...(goal ? { goalId: goal.goalId } : {}),
          source: { kind: 'adapter', agent: 'auto-goal-loop' },
          summary: bound(`AUTO review ${review.verdict}: ${review.reason}`, 500),
          metadata: { sessionId: `goal-loop:${goal.goalId}` },
        });
      } catch { /* audit only */ }
      void folder;

      if (review.verdict === 'REVIEW_BLOCKED') {
        return finish('STOPPED_REVIEW_BLOCKED', `ChatGPT unavailable [${review.blockedLayer}]: ${review.reason} ${review.detail ?? ''}`);
      }
      if (review.verdict === 'OWNER_REQUIRED') {
        return finish('STOPPED_OWNER_REQUIRED', `Owner decision required: ${review.reason}`);
      }
      if (review.verdict === 'BLOCKED') {
        if (isOwnerGate(review.reason)) return finish('STOPPED_OWNER_REQUIRED', review.reason);
        return finish('STOPPED_BLOCKED', review.reason);
      }

      if (review.verdict === 'PASS') {
        try {
          const t = getTask(dataRoot, project, task.taskId);
          if (deliveryId) {
            try {
              await submitPmJudgment(dataRoot, project, { deliveryId, decision: 'ACCEPT', reason: bound(review.reason, 1000) });
            } catch { /* fall back to canonical accept below */ }
          }
          const after = getTask(dataRoot, project, task.taskId);
          if (after.pmState !== 'ACCEPTED') {
            await acceptTaskResult({
              dataRoot,
              project,
              goalId: goal.goalId,
              taskId: task.taskId,
              runId,
              reason: bound(`AUTO ChatGPT PASS: ${review.reason}`, 500),
              expectedExecutionState: after.executionState,
              expectedPmState: after.pmState,
              callerSurface: 'PM_MCP',
            });
          }
        } catch (e) {
          return finish('STOPPED_FAILED', `PASS apply failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        break; // NEXT task (outer loop).
      }

      // CHANGES → SAME task, NEW run attempt.
      const instruction = bound(review.retryInstruction ?? review.reason, 4000);
      try {
        const t = getTask(dataRoot, project, task.taskId);
        if (deliveryId) {
          try {
            await submitPmJudgment(dataRoot, project, {
              deliveryId,
              decision: 'CHANGES',
              reason: bound(review.reason, 1000),
              retryInstruction: instruction,
            });
          } catch { /* continue with canonical path */ }
        }
        const after = getTask(dataRoot, project, task.taskId);
        if (after.pmState === 'VERIFYING') {
          await requestTaskChanges({
            dataRoot,
            project,
            goalId: goal.goalId,
            taskId: task.taskId,
            runId,
            reason: bound(`AUTO ChatGPT CHANGES: ${review.reason}`, 500),
            expectedExecutionState: after.executionState,
            expectedPmState: after.pmState,
            callerSurface: 'PM_MCP',
          });
        }
        const ready = getTask(dataRoot, project, task.taskId);
        await requestTaskRetry({
          dataRoot,
          project,
          goalId: goal.goalId,
          taskId: task.taskId,
          reason: bound(`AUTO retry attempt ${attempt + 1}: ${instruction.slice(0, 200)}`, 500),
          expectedExecutionState: ready.executionState,
          expectedPmState: ready.pmState,
          callerSurface: 'PM_MCP',
        });
      } catch (e) {
        return finish('STOPPED_FAILED', `CHANGES→retry failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      task = getTask(dataRoot, project, task.taskId);
      if (attempt >= maxAttempts) {
        return finish('STOPPED_BLOCKED', `Task ${task.taskId} exceeded max attempts (${maxAttempts}). Last: ${review.reason}`);
      }
      continue; // SAME task, NEW run.
    }
  }

  const evalRes = evaluateGoalCompletionForId(dataRoot, project, goal.goalId);
  if (evalRes.eligible) {
    await completeGoal(dataRoot, project, goal.goalId, 'AUTO goal loop: plan exhausted, all accepted.');
    return finish('GOAL_COMPLETE');
  }
  return finish('STOPPED_BLOCKED', 'Plan exhausted but goal not complete — owner decision required.');
}
