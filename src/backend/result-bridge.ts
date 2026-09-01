/**
 * Phase H — Trusted Adapter Result Bridge.
 *
 * Narrow INTERNAL_TRUSTED surface. NOT MCP. NOT Worker-callable.
 *
 * Only promotes RUNNING/DISPATCHED → RESULT_RECEIVED when ALL trust signals hold:
 *   executionBinding + RESPONSE_COMPLETE + session binding accepted + settle done +
 *   capture persisted into bound Run + current attempt + legal Task state.
 */
import * as path from 'node:path';
import type { AgentCompletion } from '../integrations/core/types.js';
import { getTask } from './goal-task.js';
import {
  markResultReceived,
  resolveCurrentAttemptRunId,
  RuntimeConflictError,
} from './goal-task-runtime.js';
import { recordAdapterObservation } from './evidence.js';
import { recordRunResultReceived } from './event.js';
import { releaseObservationLockByBinding } from './observation-lock.js';
import type { TaskRecord } from '../shared/types.js';

export { resolveCurrentAttemptRunId };

export interface ExecutionBinding {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  runId: string;
}

export interface PromoteObservedResultInput {
  dataRoot: string;
  project: string;
  goalId: string;
  taskId: string;
  runId: string;
  completion: AgentCompletion;
  /** Absolute bound Run folder where captureCompletion already persisted. */
  boundFolder: string;
  /** Optional observation adapter id used for lock release. */
  observationAdapterId?: string;
  workspaceRoot?: string;
  /** Artifact refs already written by captureCompletion. */
  artifactRefs?: string[];
}

export class ResultBridgeError extends Error {
  readonly code: 'REJECTED' | 'INVALID_STATE' | 'CONFLICT' | 'INTERNAL_ERROR';
  constructor(code: ResultBridgeError['code'], message: string) {
    super(message);
    this.name = 'ResultBridgeError';
    this.code = code;
  }
}

/**
 * Promote a trusted bound Adapter RESPONSE_COMPLETE into RESULT_RECEIVED.
 * Returns the updated Task, or null when promotion is deliberately skipped
 * (non-RESPONSE_COMPLETE / historical / already ACCEPTED / validation fail).
 *
 * Throws only on unexpected internal failures after partial trusted writes
 * that callers must surface; soft rejects return null.
 */
export async function promoteObservedResult(
  input: PromoteObservedResultInput,
): Promise<TaskRecord | null> {
  const dataRoot = requireNonEmpty(input.dataRoot, 'dataRoot');
  const project = requireNonEmpty(input.project, 'project');
  const taskId = requireNonEmpty(input.taskId, 'taskId');
  const runId = requireNonEmpty(input.runId, 'runId');
  const goalId = requireNonEmpty(input.goalId, 'goalId');
  const completion = input.completion;

  // Soft gate: only RESPONSE_COMPLETE may promote.
  if (!completion || completion.completionKind !== 'RESPONSE_COMPLETE') {
    return null;
  }

  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, taskId);
  } catch {
    throw new ResultBridgeError('INVALID_STATE', `Task '${taskId}' not found for result bridge.`);
  }

  // Reject ACCEPTED — bridge must never reopen via observation.
  if (task.pmState === 'ACCEPTED') {
    return null;
  }

  // runId must be linked
  if (!task.linkedRuns.some((r) => r.runId === runId)) {
    return null;
  }

  // Current attempt isolation — historical completions must not promote newer retries.
  const currentRunId = resolveCurrentAttemptRunId(task);
  if (!currentRunId || currentRunId !== runId) {
    return null;
  }

  // Legal execution states for promotion (or idempotent RESULT_RECEIVED replay).
  const exec = task.executionState;
  if (exec !== 'DISPATCHED' && exec !== 'RUNNING' && exec !== 'RESULT_RECEIVED') {
    return null;
  }

  // Bound folder must match linked Run folder for this runId.
  const linked = task.linkedRuns.find((r) => r.runId === runId);
  if (!linked) return null;
  const boundFolder = path.resolve(input.boundFolder);
  const linkedFolder = path.resolve(linked.folder);
  if (boundFolder !== linkedFolder) {
    return null;
  }

  // 1. captureCompletion already persisted (caller responsibility)
  // 2. recordAdapterObservation (OBSERVED provenance; deterministic sourceEventId)
  const sourceEventId = `adapter-obs:${project}:${taskId}:${runId}:${completion.observedAt}:${completion.terminalSignal}`;
  try {
    await recordAdapterObservation(dataRoot, project, {
      summary: `Adapter RESPONSE_COMPLETE observed for Task ${taskId} Run ${runId}`,
      goalId,
      taskId,
      runId,
      source: {
        kind: 'adapter',
        adapter: completion.adapterId,
        agent: completion.agentName,
      },
      details: {
        completionKind: completion.completionKind,
        terminalSignal: completion.terminalSignal,
        sessionId: completion.sessionId,
        observedAt: completion.observedAt,
        workspace: completion.workspace,
      },
      artifactRefs: input.artifactRefs,
      sourceEventId,
    });
  } catch (err) {
    // Evidence failure → do NOT promote
    const msg = err instanceof Error ? err.message : String(err);
    throw new ResultBridgeError('REJECTED', `ADAPTER_OBSERVATION failed; not promoting: ${msg}`);
  }

  // 3. Re-validate Task/run/current-attempt after evidence write
  task = getTask(dataRoot, project, taskId);
  if (task.pmState === 'ACCEPTED') return null;
  if (!task.linkedRuns.some((r) => r.runId === runId)) return null;
  const currentAfter = resolveCurrentAttemptRunId(task);
  if (!currentAfter || currentAfter !== runId) return null;
  if (
    task.executionState !== 'DISPATCHED'
    && task.executionState !== 'RUNNING'
    && task.executionState !== 'RESULT_RECEIVED'
  ) {
    return null;
  }

  // 4. markResultReceived (B2 — idempotent)
  let updated: TaskRecord;
  try {
    updated = await markResultReceived(dataRoot, project, taskId, runId, {
      expectedExecutionState: task.executionState,
    });
  } catch (err) {
    if (err instanceof RuntimeConflictError) {
      throw new ResultBridgeError('CONFLICT', err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ResultBridgeError('INVALID_STATE', msg);
  }

  // 5. recordRunResultReceived (non-waking fact Event per Phase D)
  try {
    await recordRunResultReceived(dataRoot, project, {
      summary: `RESULT_RECEIVED for Task ${taskId} Run ${runId} via trusted Adapter observation`,
      goalId,
      taskId,
      runId,
      source: { kind: 'result-bridge', subsystem: 'promoteObservedResult' },
      details: {
        completionKind: completion.completionKind,
        adapterId: completion.adapterId,
        executionState: updated.executionState,
        pmState: updated.pmState,
      },
      sourceEventId: `run-result-received:${project}:${taskId}:${runId}`,
    });
  } catch {
    // Fact Event failure must not roll back RESULT_RECEIVED (B2 state already committed).
  }

  // Release observation lock after successful terminal promotion.
  if (input.observationAdapterId && input.workspaceRoot) {
    releaseObservationLockByBinding({
      observationAdapterId: input.observationAdapterId,
      workspaceRoot: input.workspaceRoot,
      taskId,
      runId,
    });
  }

  return updated;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ResultBridgeError('INVALID_STATE', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}
