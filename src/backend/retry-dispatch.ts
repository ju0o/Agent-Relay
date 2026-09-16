/**
 * V1-G5-C — Automatic same-Task redispatch kernel.
 *
 * Closes the G5 loop: a READY G5-B Retry Preparation + an ACTIVE narrow
 * retry authorization together authorize exactly one canonical retry
 * dispatch of the SAME Task with the SAME Worker and SAME Workspace.
 *
 * Permission model: this backend proves the durable prior owner
 * authorization (retry-authorization.ts, minted at the initial G2 owner
 * dispatch) plus a fresh READY unconsumed preparation, then invokes the
 * canonical dispatcher.dispatchTask(). It does NOT call the generic PM_MCP
 * DISPATCH path, does NOT reuse OWNER_IPC, and never asks the user for
 * another GO. Authorization alone can never dispatch (a READY preparation
 * is required); a preparation alone can never dispatch (an ACTIVE
 * authorization is required).
 *
 * No-double-dispatch: one preparation binds at most one retry Run.
 *   - Fresh dispatch validates everything, then delegates to the canonical
 *     Dispatcher with trusted internal retry correlation
 *     (preparationId/sourceRunId/prompt). The Dispatcher persists the
 *     correlation on the new Run meta BEFORE the READY→DISPATCHED commit.
 *   - Crash between commit and consumption-marker write is healed by
 *     adoption: restart scans Task.linkedRuns Run metas for
 *     retryPreparationId and binds the existing Run instead of launching
 *     another. Adoption never creates effects.
 *   - Consumption (preparation.dispatchedRunId) is written only after the
 *     correlated retry Run is durably materialized.
 *
 * Worker launch failure: the canonical Dispatcher preserves the Run and
 * moves the Task to FAILED. The correlation is retained (marker written
 * best-effort, meta scan otherwise); no duplicate Run is ever launched
 * automatically.
 */

import { getTask } from './goal-task.js';
import * as fs from 'node:fs';
import { workerRegistryPath, loadWorkerRegistryRecord } from './worker-registry.js';
import { getPmJudgment, getRetryInstructionForDelivery, pmJudgmentIdFor } from './pm-judgment.js';
import {
  getRetryPreparation,
  listRetryPreparations,
  markRetryPreparationConsumed,
  retryPreparationIdFor,
  withRetryPreparationLock,
  type RetryPreparationRecord,
} from './retry-preparation.js';
import {
  computeTaskScopeFingerprint,
  getRetryAuthorization,
  isRetryAuthorizationUsableForTask,
  mintRetryAuthorization,
  type RetryAuthorizationRecord,
} from './retry-authorization.js';
import { dispatchTask, validateWorkspaceRoot, DispatcherError } from './dispatcher.js';
import { readRunMeta } from './fs.js';
import { composeRetryPrompt, readPriorResultExcerpt } from './retry-prompt.js';
import type { TaskExecutionState, TaskRecord } from '../shared/types.js';

export class RetryDispatchError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT' | 'LAUNCH_FAILED';
  constructor(code: RetryDispatchError['code'], message: string) {
    super(message);
    this.name = 'RetryDispatchError';
    this.code = code;
  }
}

export interface RetryDispatchResult {
  preparation: RetryPreparationRecord;
  task: TaskRecord;
  runId: string;
  workerId: string;
  executionState: TaskExecutionState;
  /** True when an existing correlated Run was adopted (no new dispatch). */
  alreadyDispatched: boolean;
}

export interface RetryReconcileOutcome {
  preparationId: string;
  outcome: 'adopted' | 'dispatched' | 'skipped';
  runId?: string;
  reason?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolvePreparationId(input: { deliveryId?: string; preparationId?: string }): string {
  const hasDelivery = typeof input.deliveryId === 'string' && input.deliveryId.trim();
  const hasPrep = typeof input.preparationId === 'string' && input.preparationId.trim();
  if (hasDelivery && hasPrep) {
    throw new RetryDispatchError('INVALID_ARGUMENT', 'deliveryId와 preparationId 중 하나만 지정하십시오.');
  }
  if (hasPrep) {
    const id = input.preparationId!.trim();
    try {
      retryPreparationIdFor(id.replace(/^RTP-/, ''));
    } catch {
      throw new RetryDispatchError('INVALID_ARGUMENT', `잘못된 preparationId: ${id}`);
    }
    return id;
  }
  if (hasDelivery) {
    let judgmentId: string;
    try {
      judgmentId = pmJudgmentIdFor(input.deliveryId!.trim());
    } catch {
      throw new RetryDispatchError('INVALID_ARGUMENT', `잘못된 deliveryId: ${String(input.deliveryId)}`);
    }
    return retryPreparationIdFor(judgmentId);
  }
  throw new RetryDispatchError('INVALID_ARGUMENT', 'deliveryId 또는 preparationId가 필요합니다.');
}

/**
 * Deterministic linkage: find the Task Run produced by this preparation by
 * scanning linked Run metas for retryPreparationId. Survives crashes
 * between the dispatch commit and the consumption-marker write.
 */
export function findRetryRunForPreparation(
  task: TaskRecord,
  preparationId: string,
): { runId: string; folder: string; taskRunSequence: number } | null {
  for (const link of task.linkedRuns) {
    let meta: ReturnType<typeof readRunMeta>;
    try {
      meta = readRunMeta(link.folder);
    } catch {
      continue;
    }
    if (meta.retryPreparationId === preparationId) {
      return { runId: link.runId, folder: link.folder, taskRunSequence: link.taskRunSequence };
    }
  }
  return null;
}

/**
 * Repair a missing authorization from the trusted first-run binding: the
 * earliest linked Run WITHOUT retryPreparationId is, by construction, an
 * initial owner-approved dispatch product. Repair is ONLY safe when the
 * first-run RunMeta carries the ORIGINAL owner-approved scope fingerprint
 * (persisted pre-auth by dispatchV1OwnerApproved) alongside workerId and
 * workspaceRoot. The repaired authorization mint uses that stored original
 * fingerprint — the mutable current Task is NEVER fingerprinted as
 * owner-approved scope. Any missing component (including pre-G5-C / legacy
 * runs without the fingerprint) → safe denial, no guess.
 */
function ensureAuthorizationFromFirstRunBinding(
  dataRoot: string,
  project: string,
  task: TaskRecord,
): RetryAuthorizationRecord {
  const ordered = [...task.linkedRuns].sort((a, b) => a.taskRunSequence - b.taskRunSequence);
  for (const link of ordered) {
    let meta: ReturnType<typeof readRunMeta>;
    try {
      meta = readRunMeta(link.folder);
    } catch {
      continue;
    }
    if (meta.retryPreparationId) continue; // retry product, not an owner binding
    if (!meta.workerId || !meta.workspaceRoot || !meta.ownerApprovedScopeFingerprint) {
      throw new RetryDispatchError(
        'CONFLICT',
        `Retry authorization missing for Task ${task.taskId} and original owner-approved scope cannot be reconstructed safely (first-run binding lacks the original fingerprint).`,
      );
    }
    return mintRetryAuthorization(dataRoot, project, {
      taskId: task.taskId,
      goalId: task.goalId,
      workerId: meta.workerId,
      workspaceRoot: meta.workspaceRoot,
      scopeFingerprint: meta.ownerApprovedScopeFingerprint,
      source: 'REPAIRED_FROM_FIRST_RUN_BINDING',
    });
  }
  throw new RetryDispatchError('CONFLICT', `Task ${task.taskId} has no retry authorization and no repairable first-run binding.`);
}

function loadAuthorizationOrRepair(
  dataRoot: string,
  project: string,
  task: TaskRecord,
): RetryAuthorizationRecord {
  try {
    return getRetryAuthorization(dataRoot, project, task.taskId);
  } catch {
    return ensureAuthorizationFromFirstRunBinding(dataRoot, project, task);
  }
}

function assertRetryWorkerRecord(dataRoot: string, workerId: string): void {
  try {
    loadWorkerRegistryRecord(dataRoot, workerId);
    return;
  } catch (strictError) {
    // actl-managed records are consumed raw by the certified dispatcher; the
    // public registry validator predates driverOptions.actl and rejects them.
    try {
      const raw = JSON.parse(fs.readFileSync(workerRegistryPath(dataRoot, workerId), 'utf8')) as Record<string, any>;
      if (raw.workerId === workerId && raw.role === 'implementation' && raw.driverOptions?.actl?.runtimeId && raw.launchCommand) return;
    } catch { /* preserve the strict-loader error below */ }
    throw strictError;
  }
}

function mapDispatcherError(err: DispatcherError): RetryDispatchError {
  const msg = err.message;
  switch (err.code) {
    case 'NOT_FOUND':
      return new RetryDispatchError('NOT_FOUND', msg);
    case 'CONFLICT':
      return new RetryDispatchError('CONFLICT', msg);
    case 'INVALID_ARGUMENT':
      return new RetryDispatchError('INVALID_ARGUMENT', msg);
    case 'LAUNCH_FAILED':
      return new RetryDispatchError('LAUNCH_FAILED', msg);
    default:
      return new RetryDispatchError('INVALID_STATE', msg);
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Dispatch ONE automatic retry for a READY preparation (or adopt its
 * existing correlated Run). All identity is resolved server-side from
 * deliveryId/preparationId — no workerId/workspaceRoot/taskId/runId input.
 */
export function dispatchV1Retry(
  dataRoot: string,
  project: string,
  input: { deliveryId?: string; preparationId?: string },
): Promise<RetryDispatchResult> {
  const preparationId = resolvePreparationId(input);
  return withRetryPreparationLock(dataRoot, project, preparationId, async (): Promise<RetryDispatchResult> => {
    // 1. Preparation must exist and Task binding must hold.
    let prep: RetryPreparationRecord;
    try {
      prep = getRetryPreparation(dataRoot, project, preparationId);
    } catch {
      throw new RetryDispatchError('NOT_FOUND', `Retry Preparation을 찾을 수 없습니다: ${preparationId}`);
    }
    let task = getTask(dataRoot, project, prep.taskId);

    // 2. Adoption first (never creates effects): an already-produced Run —
    //    via consumption marker or deterministic meta linkage — is bound.
    if (prep.dispatchedRunId) {
      const linked = task.linkedRuns.find((r) => r.runId === prep.dispatchedRunId);
      if (!linked) {
        throw new RetryDispatchError('CONFLICT', `Preparation ${preparationId} claims Run ${prep.dispatchedRunId} which is no longer linked.`);
      }
      return {
        preparation: prep,
        task,
        runId: linked.runId,
        workerId: workerIdForAdopted(dataRoot, project, task, linked.folder),
        executionState: task.executionState,
        alreadyDispatched: true,
      };
    }
    const correlated = findRetryRunForPreparation(task, preparationId);
    if (correlated) {
      const consumed = markRetryPreparationConsumed(dataRoot, project, preparationId, correlated.runId);
      task = getTask(dataRoot, project, prep.taskId);
      return {
        preparation: consumed,
        task,
        runId: correlated.runId,
        workerId: workerIdForAdopted(dataRoot, project, task, correlated.folder),
        executionState: task.executionState,
        alreadyDispatched: true,
      };
    }

    // 3. Fresh dispatch validation (all must hold; no partial effects yet).
    if (prep.status !== 'READY') {
      throw new RetryDispatchError('CONFLICT', `Preparation ${preparationId} is ${prep.status}, not READY; cannot dispatch retry.`);
    }
    let judgment;
    try {
      judgment = getPmJudgment(dataRoot, project, prep.judgmentId);
    } catch {
      throw new RetryDispatchError('NOT_FOUND', `CHANGES judgment이 없습니다: ${prep.judgmentId}`);
    }
    if (judgment.decision !== 'CHANGES') {
      throw new RetryDispatchError('INVALID_STATE', 'ACCEPT judgment cannot dispatch a retry.');
    }
    if (judgment.status !== 'APPLIED') {
      throw new RetryDispatchError('CONFLICT', `Judgment ${prep.judgmentId} is ${judgment.status}, not APPLIED; G5-B must complete first.`);
    }
    if (prep.deliveryId !== judgment.deliveryId || prep.taskId !== judgment.taskId || prep.sourceRunId !== judgment.runId) {
      throw new RetryDispatchError('INVALID_STATE', `Preparation identity mismatch for ${preparationId}.`);
    }
    if (task.executionState !== 'READY' || task.pmState !== 'PENDING') {
      throw new RetryDispatchError('CONFLICT', `Task ${task.taskId} is ${task.executionState}+${task.pmState}; retry requires READY+PENDING.`);
    }
    const auth = loadAuthorizationOrRepair(dataRoot, project, task);
    if (auth.taskId !== task.taskId) {
      throw new RetryDispatchError('CONFLICT', `Retry authorization binds ${auth.taskId}, not ${task.taskId}; denied.`);
    }
    if (computeTaskScopeFingerprint(task) !== auth.scopeFingerprint) {
      throw new RetryDispatchError('CONFLICT', 'Task scope changed since owner approval; retry denied.');
    }
    if (!isRetryAuthorizationUsableForTask(task, auth)) {
      throw new RetryDispatchError('CONFLICT', `Retry authorization for ${task.taskId} is not usable (status=${auth.status}).`);
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = validateWorkspaceRoot(auth.workspaceRoot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RetryDispatchError('INVALID_STATE', `Retry workspace revalidation failed: ${msg}`);
    }
    try {
      assertRetryWorkerRecord(dataRoot, auth.workerId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RetryDispatchError('INVALID_STATE', `Retry worker unavailable: ${msg}`);
    }
    const sourceLink = task.linkedRuns.find((r) => r.runId === prep.sourceRunId);
    if (!sourceLink) {
      throw new RetryDispatchError('CONFLICT', `Source Run ${prep.sourceRunId} is no longer linked.`);
    }
    try {
      const sourceMeta = readRunMeta(sourceLink.folder);
      if (sourceMeta.workerId && sourceMeta.workerId !== auth.workerId) {
        throw new RetryDispatchError('CONFLICT', 'Source attempt worker differs from retry authorization; retry denied.');
      }
    } catch (err) {
      if (err instanceof RetryDispatchError) throw err;
      // Unreadable meta: cannot cross-check; continue (dispatcher revalidates worker).
    }

    // 4. Compose the bounded retry prompt (no runId invented: the stable
    //    preparationId identifies the attempt; the Run binds via meta).
    let instruction: string;
    try {
      instruction = getRetryInstructionForDelivery(dataRoot, project, prep.deliveryId);
    } catch {
      throw new RetryDispatchError('INVALID_STATE', `Durable retry instruction missing for ${prep.deliveryId}; refusing retry.`);
    }
    const prior = readPriorResultExcerpt(sourceLink.folder);
    const prompt = composeRetryPrompt({
      task,
      preparationId: prep.preparationId,
      sourceRunId: prep.sourceRunId,
      reason: prep.reason || judgment.reason || '',
      retryInstruction: instruction,
      priorExcerpt: prior.excerpt,
      priorAvailable: prior.available,
    });

    // 5. Canonical dispatch with trusted internal retry correlation.
    let dispatch: { runId: string; executionState: TaskExecutionState };
    try {
      dispatch = await dispatchTask(dataRoot, project, {
        taskId: task.taskId,
        workerId: auth.workerId,
        workspaceRoot,
        expectedExecutionState: 'READY',
        retryContext: {
          preparationId: prep.preparationId,
          sourceRunId: prep.sourceRunId,
          judgmentId: prep.judgmentId,
          deliveryId: prep.deliveryId,
          prompt,
        },
      });
    } catch (err) {
      // Post-commit failures (capture arm / spawn) preserve the correlated
      // Run: retain the binding best-effort so no duplicate is ever launched.
      try {
        const after = getTask(dataRoot, project, prep.taskId);
        const found = findRetryRunForPreparation(after, preparationId);
        if (found) markRetryPreparationConsumed(dataRoot, project, preparationId, found.runId);
      } catch { /* binding best-effort; the error below is authoritative */ }
      if (err instanceof DispatcherError) throw mapDispatcherError(err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new RetryDispatchError('INVALID_STATE', msg);
    }

    // 6. Consumption binds only after the retry Run is durably materialized.
    const consumed = markRetryPreparationConsumed(dataRoot, project, preparationId, dispatch.runId);
    task = getTask(dataRoot, project, prep.taskId);
    return {
      preparation: consumed,
      task,
      runId: dispatch.runId,
      workerId: auth.workerId,
      executionState: dispatch.executionState,
      alreadyDispatched: false,
    };
  });
}

function workerIdForAdopted(dataRoot: string, project: string, task: TaskRecord, folder: string): string {
  try {
    const meta = readRunMeta(folder);
    if (meta.workerId) return meta.workerId;
  } catch { /* fall through */ }
  try {
    return getRetryAuthorization(dataRoot, project, task.taskId).workerId;
  } catch { /* fall through */ }
  return 'unknown';
}

// ── restart reconciliation ───────────────────────────────────────────────────

/**
 * Narrow startup reconciliation: only READY unconsumed Retry Preparations
 * are eligible. For each: adopt an already-correlated Run, else dispatch
 * when the Task is READY+PENDING (dispatchV1Retry revalidates everything),
 * else skip safely with a reason. Never throws for eligible preps —
 * failures are collected as skipped outcomes.
 */
export async function reconcileReadyRetryDispatches(
  dataRoot: string,
  project: string,
): Promise<RetryReconcileOutcome[]> {
  const out: RetryReconcileOutcome[] = [];
  let preps: RetryPreparationRecord[];
  try {
    preps = listRetryPreparations(dataRoot, project);
  } catch {
    return out;
  }
  for (const prep of preps) {
    if (prep.status !== 'READY' || prep.dispatchedRunId) continue;
    let task: TaskRecord;
    try {
      task = getTask(dataRoot, project, prep.taskId);
    } catch (err) {
      out.push({ preparationId: prep.preparationId, outcome: 'skipped', reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const correlated = (() => {
      try {
        return findRetryRunForPreparation(task, prep.preparationId);
      } catch {
        return null;
      }
    })();
    if (correlated) {
      try {
        await withRetryPreparationLock(dataRoot, project, prep.preparationId, async () => {
          markRetryPreparationConsumed(dataRoot, project, prep.preparationId, correlated.runId);
        });
        out.push({ preparationId: prep.preparationId, outcome: 'adopted', runId: correlated.runId });
      } catch (err) {
        out.push({ preparationId: prep.preparationId, outcome: 'skipped', reason: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if (task.executionState !== 'READY' || task.pmState !== 'PENDING') {
      out.push({
        preparationId: prep.preparationId,
        outcome: 'skipped',
        reason: `Task ${task.taskId} is ${task.executionState}+${task.pmState}; not READY+PENDING and no correlated Run.`,
      });
      continue;
    }
    try {
      const res = await dispatchV1Retry(dataRoot, project, { preparationId: prep.preparationId });
      out.push({ preparationId: prep.preparationId, outcome: res.alreadyDispatched ? 'adopted' : 'dispatched', runId: res.runId });
    } catch (err) {
      out.push({ preparationId: prep.preparationId, outcome: 'skipped', reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }
  return out;
}
