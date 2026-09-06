/**
 * V1.5 Blocker Hotfix 02 — canonical recovery of an EXISTING completed Run
 * whose live capture (CaptureManager watch → Result Bridge) never ran because
 * the process-local MCP/capture runtime was unavailable when the Worker
 * finished.
 *
 * This is NOT a second promotion path. It reconstructs the exact same
 * AgentCompletion the live claude-code adapter would have emitted, then
 * hands it to the SAME canonical primitives the live path uses:
 *
 *   captureCompletion()      (integrations/core/capture.js)  — persist evidence
 *   promoteObservedResult()  (result-bridge.js)               — RESULT_RECEIVED + Delivery
 *
 * No Worker replay. No manually authored result.md/agent-result.md/Event/
 * Delivery. Fail-closed on any ambiguity.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGoal, getTask } from './goal-task.js';
import { readRunMeta } from './fs.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { promoteObservedResult, ResultBridgeError, type ExecutionBinding } from './result-bridge.js';
import { captureCompletion } from '../integrations/core/capture.js';
import { claudeProjectsRoot, listTranscriptFiles } from '../integrations/claude/storage.js';
import { summarizeClaudeTranscript } from '../integrations/claude/extract.js';
import { listExecutionPlans, type ExecutionPlanRecord } from './execution-plan.js';
import { revalidatePlanAuthorization } from './execution-plan-reconciliation.js';
import { authorizeEffect, PermissionDeniedError, type CallerSurface } from './permission-gate.js';
import type { AgentCompletion } from '../integrations/core/types.js';
import type { PermissionPolicy, TaskRecord } from '../shared/types.js';

export type CompletedRunRecoveryStatus =
  | 'RECOVERED'
  | 'ALREADY_CAPTURED'
  | 'REJECTED'
  | 'BLOCKED';

export interface RecoverCompletedRunInput {
  dataRoot: string;
  project: string;
  taskId: string;
  runId: string;
  callerSurface: CallerSurface;
}

export interface RecoverCompletedRunResult {
  status: CompletedRunRecoveryStatus;
  taskId: string;
  runId: string;
  resultCaptured: boolean;
  deliveryId?: string;
  reason: string;
}

export class CompletedRunRecoveryError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'FORBIDDEN' | 'INTERNAL_ERROR';
  constructor(code: CompletedRunRecoveryError['code'], message: string) {
    super(message);
    this.name = 'CompletedRunRecoveryError';
    this.code = code;
  }
}

/** Clock-skew guard, mirrors ARM_SKEW_MS used by the live claude-code adapter. */
const SKEW_MS = 1_500;
/** Historical worker-launch.log entries are separated by this exact literal (scripts/relay-worker-claude.mjs). */
const LAUNCH_LOG_SEPARATOR = '\n---\n';

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CompletedRunRecoveryError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function normalizePath(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function rejected(taskId: string, runId: string, reason: string): RecoverCompletedRunResult {
  return { status: 'REJECTED', taskId, runId, resultCaptured: false, reason };
}

function blocked(taskId: string, runId: string, reason: string): RecoverCompletedRunResult {
  return { status: 'BLOCKED', taskId, runId, resultCaptured: false, reason };
}

interface LaunchLogEntry {
  phase?: string;
  exitCode?: number;
  taskId?: string;
  runId?: string;
}

/**
 * Tolerant reader for worker-launch.log — an append-only sequence of pretty
 * JSON blocks joined by a literal '\n---\n' separator (see relay-worker-claude.mjs
 * writeLaunchLog). Returns the LAST block that parses (the final/terminal entry).
 * Never throws.
 */
function readLastLaunchLogEntry(folder: string): LaunchLogEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, 'worker-launch.log'), 'utf8');
  } catch {
    return null;
  }
  const blocks = raw.split(LAUNCH_LOG_SEPARATOR);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const chunk = blocks[i]!.trim();
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk) as LaunchLogEntry;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find the exact durable Claude Code transcript file for this Run using the
 * strongest available correlation evidence: the transcript's own recorded
 * first-turn `content` must be byte-identical to the exact prompt.md this
 * Dispatcher wrote for this Run. Unlike live-watch timing heuristics, this is
 * effectively unforgeable per-Run identity — each dispatch/retry prompt is
 * unique (it embeds taskId, and for retries the preparationId + PM review
 * text), so an unrelated/historical/other-Task/other-Run transcript can never
 * match by content.
 *
 * Returns exactly one match, or null (no match / ambiguous).
 */
function findCorrelatedTranscript(
  claudeConfigDir: string | undefined,
  promptContent: string,
  windowStartMs: number,
): { path: string; raw: string } | 'AMBIGUOUS' | null {
  const root = claudeProjectsRoot(claudeConfigDir);
  if (!root) return null;
  const candidates: { path: string; raw: string }[] = [];
  for (const f of listTranscriptFiles(root)) {
    // Coarse prefilter only — never the sole discriminator: a transcript for
    // this Run can only exist at/after the Run's own launch time.
    if (f.mtimeMs < windowStartMs - SKEW_MS) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n', 10);
    let matched = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { content?: unknown };
        if (typeof entry.content === 'string' && entry.content === promptContent) {
          matched = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (matched) candidates.push({ path: f.path, raw });
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return 'AMBIGUOUS';
  return candidates[0]!;
}

/**
 * Recover a Run that completed successfully (Worker exit 0, durable terminal
 * transcript boundary) while no live CaptureManager watch was armed to
 * observe it, and promote it through the SAME canonical Result Bridge path a
 * live observation would have used. Idempotent: a second call for an
 * already-promoted Run returns ALREADY_CAPTURED without any further writes.
 *
 * Input is intentionally narrow (taskId + runId only) — every other fact is
 * derived canonically from durable Task/Run/transcript evidence. No Worker
 * replay is ever performed.
 */
export async function recoverCompletedRunCapture(
  input: RecoverCompletedRunInput,
): Promise<RecoverCompletedRunResult> {
  const dataRoot = requireNonEmpty(input.dataRoot, 'dataRoot');
  const project = requireNonEmpty(input.project, 'project');
  const taskId = requireNonEmpty(input.taskId, 'taskId');
  const runId = requireNonEmpty(input.runId, 'runId');

  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, taskId);
  } catch {
    return rejected(taskId, runId, 'TASK_NOT_FOUND');
  }

  // 0. Permission gate — mirrors orphan-resolution.ts: fact-reconciliation of
  //    an already-completed Run, gated the same way as ORPHAN_KEEP_WAITING.
  let policy: PermissionPolicy = { mode: 'PLAN' };
  try {
    policy = getGoal(dataRoot, project, task.goalId).permissionPolicy ?? { mode: 'PLAN' };
  } catch {
    policy = { mode: 'PLAN' };
  }
  try {
    authorizeEffect({ effect: 'RECOVER_COMPLETED_RUN', callerSurface: input.callerSurface, permissionPolicy: policy });
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      throw new CompletedRunRecoveryError('FORBIDDEN', err.message);
    }
    throw err;
  }

  // 1. Run must be linked to the authoritative Task.
  const link = task.linkedRuns.find((r) => r.runId === runId);
  if (!link) return rejected(taskId, runId, 'RUN_NOT_LINKED_TO_TASK');

  // 2. Must be the CURRENT attempt — never promote a superseded/historical Run.
  const currentRunId = resolveCurrentAttemptRunId(task);
  if (!currentRunId || currentRunId !== runId) {
    return blocked(taskId, runId, 'NOT_CURRENT_ATTEMPT_OR_LATER_RUN_EXISTS');
  }

  // 3. Fast idempotent short-circuit — already promoted for this exact Run.
  const evidencePath = path.join(link.folder, 'evidence', 'adapter.json');
  const alreadyCaptured = fs.existsSync(evidencePath)
    && (task.executionState === 'RESULT_RECEIVED' || task.pmState === 'ACCEPTED');
  if (alreadyCaptured) {
    return {
      status: 'ALREADY_CAPTURED',
      taskId,
      runId,
      resultCaptured: true,
      deliveryId: `PMD-${taskId}-${runId}`,
      reason: 'Run already has captured evidence and Task is at/past RESULT_RECEIVED.',
    };
  }

  // 4. Never reopen an ACCEPTED Task via recovery.
  if (task.pmState === 'ACCEPTED') {
    return blocked(taskId, runId, 'TASK_ALREADY_ACCEPTED');
  }

  // 5. Only Tasks still awaiting a result may be recovered.
  if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') {
    return blocked(taskId, runId, `UNSUPPORTED_EXECUTION_STATE:${task.executionState}`);
  }

  // 6. Plan authorization must still hold for any Plan-owned Task.
  // listExecutionPlans fails closed on ANY malformed Plan record (including an
  // authorization fingerprint mismatch — see validateAuthorization). Treating
  // that failure as "no owning Plan" would silently skip the exact check this
  // gate exists for, so a listing failure itself must BLOCK, never fall through.
  let plans: ExecutionPlanRecord[];
  try {
    plans = listExecutionPlans(dataRoot, project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return blocked(taskId, runId, `PLAN_LIST_UNREADABLE:${msg}`);
  }
  const owningPlan = plans.find((p) => p.taskBindings.some((b) => b.taskId === taskId));
  if (owningPlan) {
    const auth = revalidatePlanAuthorization(owningPlan);
    if (!auth.ok) {
      return blocked(taskId, runId, `PLAN_AUTHORIZATION_MISMATCH:${auth.reason}`);
    }
  }

  // 7. Durable Run metadata must be internally consistent.
  const meta = readRunMeta(link.folder);
  if (meta.taskId && meta.taskId !== taskId) return blocked(taskId, runId, 'RUN_META_TASK_MISMATCH');
  if (meta.runId && meta.runId !== runId) return blocked(taskId, runId, 'RUN_META_RUN_MISMATCH');
  if (!meta.workspaceRoot) return rejected(taskId, runId, 'RUN_META_MISSING_WORKSPACE_ROOT');
  if (meta.workerId && meta.workerId !== 'claude-code') {
    return rejected(taskId, runId, `UNSUPPORTED_WORKER:${meta.workerId}`);
  }
  // Retry lineage: a retry Run's declared source attempt must be a real,
  // linked prior Run on this same Task — never a manufactured/foreign source.
  if (meta.sourceRunId && !task.linkedRuns.some((r) => r.runId === meta.sourceRunId)) {
    return blocked(taskId, runId, 'RETRY_LINEAGE_SOURCE_RUN_UNLINKED');
  }

  // 8. Worker process must have exited cleanly (necessary, not sufficient).
  const launchEntry = readLastLaunchLogEntry(link.folder);
  if (!launchEntry || launchEntry.phase !== 'completed') {
    return rejected(taskId, runId, 'WORKER_LAUNCH_NOT_COMPLETED');
  }
  if (launchEntry.exitCode !== 0) {
    return rejected(taskId, runId, `WORKER_EXIT_NONZERO:${String(launchEntry.exitCode)}`);
  }

  // 9. The exact prompt this Dispatcher wrote for this Run is the strongest
  //    available correlation anchor for the durable transcript.
  let promptContent: string;
  try {
    promptContent = fs.readFileSync(path.join(link.folder, 'prompt.md'), 'utf8');
  } catch {
    return rejected(taskId, runId, 'RUN_PROMPT_MISSING');
  }

  let startedAtMs = 0;
  try {
    const raw = fs.readFileSync(path.join(link.folder, 'worker-launch.log'), 'utf8');
    const first = JSON.parse(raw.split(LAUNCH_LOG_SEPARATOR)[0]!.trim()) as { startedAt?: string };
    startedAtMs = first.startedAt ? Date.parse(first.startedAt) : 0;
  } catch {
    startedAtMs = 0;
  }

  const found = findCorrelatedTranscript(meta.claudeConfigDir, promptContent, startedAtMs);
  if (found === 'AMBIGUOUS') {
    return blocked(taskId, runId, 'AMBIGUOUS_TRANSCRIPT_CORRELATION');
  }
  if (!found) {
    return rejected(taskId, runId, 'NO_MATCHING_TRANSCRIPT');
  }

  // 10. Transcript must reach a real terminal successful boundary.
  const summary = summarizeClaudeTranscript(found.raw);
  if (!summary.ready || !summary.messageId || summary.kind !== 'RESPONSE_COMPLETE') {
    return rejected(taskId, runId, 'NO_TERMINAL_END_TURN');
  }

  // 11. Defense in depth — even though content-match already proves Run
  //     identity, reject a turn that completed before the Run even started.
  if (summary.completedAtIso && startedAtMs > 0) {
    const completedMs = Date.parse(summary.completedAtIso);
    if (!Number.isNaN(completedMs) && completedMs < startedAtMs - SKEW_MS) {
      return rejected(taskId, runId, 'HISTORICAL_TRANSCRIPT_BEFORE_RUN_START');
    }
  }

  // 12. Workspace must match the frozen Run binding.
  if (!summary.cwd || normalizePath(summary.cwd) !== normalizePath(meta.workspaceRoot)) {
    return rejected(taskId, runId, 'WORKSPACE_MISMATCH');
  }

  const sessionId = summary.sessionId ?? path.basename(found.path, '.jsonl');
  const completion: AgentCompletion = {
    adapterId: 'claude-code',
    agentName: 'Claude Code',
    sessionId,
    workspace: summary.cwd,
    startedAt: summary.startedAtIso ?? undefined,
    observedAt: new Date().toISOString(),
    terminalSignal: summary.terminalSignal,
    rawFinalText: summary.text,
    rawProtocolRef: `claude://session/${sessionId}/msg/${summary.messageId}`,
    completionKind: 'RESPONSE_COMPLETE',
  };

  // 13. Same normalization primitive the live adapter uses — dedupe-safe,
  //     never overwrites a manual result.md.
  const outcome = captureCompletion(link.folder, completion, { bindingReason: 'recovered-transcript' });
  if (!outcome.ok) {
    return rejected(taskId, runId, `CAPTURE_FAILED:${outcome.reason ?? 'unknown'}`);
  }

  const executionBinding: ExecutionBinding = {
    dataRoot,
    project,
    goalId: task.goalId,
    taskId,
    runId,
  };

  // 14. Same canonical promotion primitive the live Result Bridge uses.
  try {
    const updated = await promoteObservedResult({
      ...executionBinding,
      completion,
      boundFolder: link.folder,
      workspaceRoot: meta.workspaceRoot,
      artifactRefs: outcome.written,
    });
    if (!updated) {
      // A concurrent recovery/live-observation already promoted this Run.
      return {
        status: 'ALREADY_CAPTURED',
        taskId,
        runId,
        resultCaptured: true,
        deliveryId: `PMD-${taskId}-${runId}`,
        reason: 'Result Bridge reported the Run was already promoted (concurrent winner).',
      };
    }
    return {
      status: 'RECOVERED',
      taskId,
      runId,
      resultCaptured: true,
      deliveryId: `PMD-${taskId}-${runId}`,
      reason: `RESULT_RECEIVED via recovered transcript (executionState=${updated.executionState}, pmState=${updated.pmState}).`,
    };
  } catch (err) {
    if (err instanceof ResultBridgeError && err.code === 'CONFLICT') {
      return {
        status: 'ALREADY_CAPTURED',
        taskId,
        runId,
        resultCaptured: true,
        deliveryId: `PMD-${taskId}-${runId}`,
        reason: 'Concurrent promotion already advanced this Task past the expected state.',
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return blocked(taskId, runId, `PROMOTION_FAILED:${msg}`);
  }
}
