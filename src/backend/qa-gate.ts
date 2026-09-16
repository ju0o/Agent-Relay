/**
 * V1.6 Slice 4 — QA FAIL → same-Task remediation gate.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §8, §11, §12, §14, §16
 * (accepted commit f1c8959; Slice 1 kernel c57d996 + correction dac4ed6;
 * Slice 2 evaluator 8380dda; Slice 3 semantic 85808d2).
 *
 * This module connects the accepted QA machinery into the Result lifecycle:
 *
 *   Worker Run completes → canonical Result captured → QA Attempt →
 *   deterministic QA → semantic QA when required → final QA outcome →
 *   QA FAIL ⇒ same Task / same Worker / same workspace remediation Run.
 *
 * Entry points:
 *   - `reconcileQaGate(dataRoot, project, taskId)` — the bounded internal
 *     reconciliation operation (§14). Explicit, not a startup daemon, not an
 *     MCP surface. Covers seams 1–5, 7, 8.
 *   - `runOrResumeQaGate(...)` — the live result-bridge trigger (§16). It is
 *     EXACTLY reconcileQaGate (same function, aliased): restart
 *     reconciliation and the live trigger are one code path, the same way
 *     promoteObservedResult already serves both live and recovered
 *     observations.
 *
 * Authority invariants (absolute, tested):
 *   - QA PASS ≠ Task ACCEPT, QA PASS ≠ Plan advancement. This module never
 *     calls acceptResult/requestChanges, never sets ACCEPTED or
 *     CHANGES_REQUESTED, never imports execution-plan-continuation. The only
 *     Task mutations it performs are markQaResultReceived-adjacent NONE
 *     (the bridge owns receipt), RESULT_RECEIVED+PENDING → READY+PENDING
 *     (remediation retry), and PENDING → VERIFYING (escalation review
 *     state). GPT PM ACCEPT remains the sole Plan-advancement authority.
 *   - QA FAIL authorizes remediation of the SAME Task only. Never a
 *     replacement Task, never a mutated contract/binding, never a Plan move.
 *   - QA remediation lineage (QRP-…/qaRemediationPreparationId/
 *     qa-remediation-context.json) never shares state with the GPT PM G5
 *     CHANGES lineage (RTP-PMJ-…/retryPreparationId/retry-context.json).
 *
 * Idempotency/concurrency: durable state is the authority (deterministic
 * QaAttempt ids, deterministic QRP ids, dispatchedRunId terminal
 * bookkeeping, meta-correlation scan, CAS Task transitions). A per-task
 * process-local lock supplements durability for the evaluate→prepare→
 * dispatch sequence but is never the sole correctness authority — a
 * concurrent caller that loses a CAS falls into adoption, never into a
 * second dispatch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTask } from './goal-task.js';
import {
  requestQaRemediationRetry,
  resolveCurrentAttemptRunId,
  transitionTaskPm,
} from './goal-task-runtime.js';
import {
  consumeQaRemediationPreparation,
  createQaRemediationPreparation,
  getQaRemediationPreparation,
  listQaRemediationPreparations,
  qaRemediationPreparationIdFor,
  type QaRemediationPreparationRecord,
} from './qa-remediation-preparation.js';
import {
  completeQaAttempt,
  createQaAttempt,
  getQaAttempt,
  linkRemediationPreparation,
  qaAttemptIdFor,
  type QaAttemptRecord,
  type QaFinalStatus,
} from './qa-attempt.js';
import {
  deriveQaEvaluationContract,
  QaContractError,
  type DerivedQaEvaluationContract,
} from './qa-contract.js';
import {
  evaluateDeterministicQa,
  QaDeterministicEvaluatorError,
} from './qa-deterministic-evaluator.js';
import {
  evaluateSemanticQa,
  QaSemanticEvaluatorError,
} from './qa-semantic-evaluator.js';
import { ensurePmDeliveryForTaskVerify } from './pm-delivery.js';
import { dispatchTask, validateWorkspaceRoot, DispatcherError } from './dispatcher.js';
import { loadWorkerRegistryRecord } from './worker-registry.js';
import { readRunMeta } from './fs.js';
import {
  closeActlManagedReservation,
  readRuntimeBinding,
  writeRuntimeBinding,
  type ActlRuntimeBinding,
} from './actl-bridge.js';
import {
  composeQaRemediationPrompt,
  readPriorResultExcerpt,
} from './qa-remediation-prompt.js';
import type { TaskRecord } from '../shared/types.js';

// ── errors ───────────────────────────────────────────────────────────────────

export class QaGateError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_STATE'
    | 'INVALID_ARGUMENT'
    | 'CORRUPT_RECORD'
    | 'BLOCKED'
    | 'LAUNCH_FAILED';
  constructor(code: QaGateError['code'], message: string) {
    super(message);
    this.name = 'QaGateError';
    this.code = code;
  }
}

// ── outcome ──────────────────────────────────────────────────────────────────

export type ReconcileQaGateOutcome =
  | 'SKIPPED_NO_CONTRACT'
  | 'PASS_DELIVERED'
  | 'FAIL_REMEDIATION_DISPATCHED'
  | 'FAIL_REMEDIATION_ADOPTED'
  | 'FAIL_ESCALATED_BUDGET_EXHAUSTED'
  | 'BLOCKED_ESCALATED';

export interface ReconcileQaGateResult {
  outcome: ReconcileQaGateOutcome;
  taskId: string;
  runId?: string;
  qaAttemptId?: string;
  finalQaStatus?: Extract<QaFinalStatus, 'PASS' | 'FAIL' | 'BLOCKED'>;
  remediationRunId?: string;
  alreadyDispatched?: boolean;
  deliveryId?: string | null;
  sourceSeatReleased?: { runId: string; reservationId: string };
}

export interface QaRemediationDispatchInput {
  taskId: string;
  workerId: string;
  workspaceRoot: string;
  preparationId: string;
  sourceRunId: string;
  prompt: string;
}

export type QaRemediationDispatchHook = (
  dataRoot: string,
  project: string,
  input: QaRemediationDispatchInput,
) => Promise<{ runId: string }>;

export interface ReconcileQaGateOptions {
  dispatchRemediation?: QaRemediationDispatchHook;
}

// ── locks (process-local supplement; durable state is the authority) ─────────

const _qaGateLocks = new Map<string, Promise<void>>();

function qaGateLockKey(dataRoot: string, project: string, taskId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${taskId}`;
}

function withQaGateLock<T>(dataRoot: string, project: string, taskId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = qaGateLockKey(dataRoot, project, taskId);
  const prev = _qaGateLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _qaGateLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local QA gate lock chains. */
export function _resetQaGateLocksForTests(): void {
  _qaGateLocks.clear();
}

// ── helpers ──────────────────────────────────────────────────────────────────

function requireTask(dataRoot: string, project: string, taskId: string): TaskRecord {
  try {
    return getTask(dataRoot, project, taskId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('NOT_FOUND', `QA gate: canonical Task를 찾을 수 없습니다: ${taskId} (${msg})`);
  }
}

/** Authoritative QA-remediation count for the budget: every non-FAILED
 * preparation for this Task authorized exactly one remediation Run
 * (terminal-success bookkeeping binds at most one Run each). FAILED
 * preparations never produced a Run and never consume budget. */
export function countQaRemediationsForTask(dataRoot: string, project: string, taskId: string): number {
  return listQaRemediationPreparations(dataRoot, project).filter(
    (p) => p.taskId === taskId && p.status !== 'FAILED',
  ).length;
}

/**
 * Deterministic linkage: find the remediation Run produced by this
 * preparation by scanning linked Run metas for qaRemediationPreparationId.
 * Survives crashes between the dispatch commit and the consumption-marker
 * write (mirrors retry-dispatch.ts findRetryRunForPreparation, namespace-
 * separated so the two lineages can never adopt each other's Runs).
 */
export function findQaRemediationRunForPreparation(
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
    if (meta.qaRemediationPreparationId === preparationId) {
      return { runId: link.runId, folder: link.folder, taskRunSequence: link.taskRunSequence };
    }
  }
  return null;
}

/** Bounded deterministic verdict summary from the durable attempt (check
 * ids + verdicts only — never raw stdout dumps).
 *
 * Exported for scripts/relay-worker-claude.mjs, which recomputes the
 * byte-identical QA remediation prompt from the same durable inputs
 * (V1-G5-C pattern: dispatcher pre-write vs wrapper recompute must agree).
 */
export function summarizeAttemptDeterministic(attempt: QaAttemptRecord): string {
  const checks = attempt.deterministic?.checks ?? [];
  if (checks.length === 0) return '(no deterministic checks recorded)';
  return checks
    .map((c) => `- [${c.status}] ${c.kind}${c.criterionId ? ` (${c.criterionId})` : ''}: ${c.detail}`)
    .join('\n')
    .slice(0, 2000);
}

/** Semantic failure reason from the durable attempt: the distinct notes
 * attached to the failed criteria (the parser stores the bounded `reason`
 * there), joined and bounded.
 *
 * Exported for scripts/relay-worker-claude.mjs (same recompute contract as
 * summarizeAttemptDeterministic above). */
export function semanticReasonFromAttempt(attempt: QaAttemptRecord): string | undefined {
  if (!attempt.semantic || attempt.semantic.status !== 'FAIL') return undefined;
  const failed = new Set(attempt.failedCriteria);
  const notes = new Set<string>();
  for (const c of attempt.semantic.criteria) {
    if (failed.has(c.id) && c.note && c.note !== 'semantic FAIL') notes.add(c.note);
  }
  if (notes.size === 0) return undefined;
  return [...notes].join(' | ').slice(0, 1000);
}

function wrapGateError(err: unknown, fallback: QaGateError['code'] = 'INVALID_STATE'): never {
  if (err instanceof QaGateError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  if (
    code === 'NOT_FOUND'
    || code === 'CONFLICT'
    || code === 'INVALID_STATE'
    || code === 'INVALID_ARGUMENT'
    || code === 'CORRUPT_RECORD'
    || code === 'BLOCKED'
    || code === 'LAUNCH_FAILED'
  ) {
    throw new QaGateError(code, `QA gate: ${msg}`);
  }
  throw new QaGateError(fallback, `QA gate: ${msg}`);
}

// ── escalation (PASS / budget-exhausted FAIL / BLOCKED verdict) ──────────────
//
// Treated the same as PASS for delivery purposes (plan §8): pmState
// PENDING → VERIFYING (the existing idempotent "ensure review state"
// transition), then the ordinary Delivery is minted. Never ACCEPTs, never
// touches CHANGES_REQUESTED, never advances a Plan.

async function ensureQaReviewState(dataRoot: string, project: string, task: TaskRecord): Promise<TaskRecord> {
  const fresh = requireTask(dataRoot, project, task.taskId);
  if (fresh.pmState === 'VERIFYING') return fresh;
  // A PM judgment already owns this Task (ACCEPTED / CHANGES_REQUESTED) —
  // the gate never overrides it; escalation is a no-op (duplicate-safe).
  if (fresh.pmState === 'ACCEPTED' || fresh.pmState === 'CHANGES_REQUESTED') return fresh;
  if (fresh.executionState !== 'RESULT_RECEIVED' || fresh.pmState !== 'PENDING') {
    throw new QaGateError(
      'CONFLICT',
      `QA gate: escalation requires RESULT_RECEIVED+PENDING but Task ${task.taskId} is ${fresh.executionState}+${fresh.pmState}; refusing.`,
    );
  }
  try {
    return await transitionTaskPm(dataRoot, project, task.taskId, {
      expectedPmState: 'PENDING',
      expectedExecutionState: 'RESULT_RECEIVED',
      to: 'VERIFYING',
      reason: 'qa-gate:escalate:verdict decided, GPT PM review required',
    });
  } catch (err) {
    wrapGateError(err, 'CONFLICT');
  }
}

async function escalateWithDelivery(
  dataRoot: string,
  project: string,
  task: TaskRecord,
  outcome: ReconcileQaGateOutcome,
  attempt: QaAttemptRecord,
): Promise<ReconcileQaGateResult> {
  await ensureQaReviewState(dataRoot, project, task);
  let deliveryId: string | null = null;
  try {
    const delivery = await ensurePmDeliveryForTaskVerify(dataRoot, project, task.taskId);
    deliveryId = delivery ? delivery.deliveryId : null;
  } catch (err) {
    wrapGateError(err);
  }
  return {
    outcome,
    taskId: task.taskId,
    runId: attempt.runId,
    qaAttemptId: attempt.qaAttemptId,
    finalQaStatus: attempt.finalQaStatus as Extract<QaFinalStatus, 'PASS' | 'FAIL' | 'BLOCKED'>,
    deliveryId,
  };
}

// ── evaluation (seams 1–2) ───────────────────────────────────────────────────
//
// Runs deterministic QA, then semantic QA iff the contract requires it,
// for one PENDING attempt. Precondition failures from the evaluators
// (broken canonical binding, missing capture, missing worker) are
// fail-closed QaGateError BLOCKEDs with NO state mutation — the Task stays
// RESULT_RECEIVED+PENDING so a later reconciliation can resume (seam 6).

async function evaluateAttemptToTerminal(
  dataRoot: string,
  project: string,
  attempt: QaAttemptRecord,
  derived: DerivedQaEvaluationContract,
  task: TaskRecord,
): Promise<QaAttemptRecord> {
  let current = attempt;
  if (current.deterministic === undefined) {
    try {
      const res = await evaluateDeterministicQa(dataRoot, project, {
        qaAttemptId: current.qaAttemptId,
        checks: derived.checks,
      });
      current = res.record;
    } catch (err) {
      if (err instanceof QaDeterministicEvaluatorError && err.code === 'BLOCKED') {
        throw new QaGateError('BLOCKED', `QA gate: deterministic QA precondition failed, no state changed: ${err.message}`);
      }
      wrapGateError(err);
    }
  }
  // Terminal FAIL/BLOCKED already finalized inside recordDeterministicEvidence
  // (Slice 1 structural non-override) — semantic is structurally unreachable.
  if (current.finalQaStatus !== 'PENDING') return current;
  // Deterministic PASS, still PENDING: semantic is mandatory iff configured.
  if (derived.semanticCriteriaIds.length === 0) {
    // No SEMANTIC/BOTH AC — but the attempt is still PENDING, which means
    // the deterministic evaluator left it for Slice 3 while the contract
    // needs no semantic. Finish PASS directly (same call the evaluator
    // itself would have made; idempotent-safe: completeQaAttempt refuses
    // when semantic is required, so this can never bypass the mandatory
    // rule — derived.semanticCriteriaIds is empty exactly when no
    // SEMANTIC/BOTH mode exists).
    try {
      current = await completeQaAttempt(dataRoot, project, current.qaAttemptId, { finalQaStatus: 'PASS' });
    } catch (err) {
      wrapGateError(err);
    }
    return current;
  }
  try {
    const res = await evaluateSemanticQa(dataRoot, project, {
      qaAttemptId: current.qaAttemptId,
      task: { title: task.title, goal: task.goal, reason: task.reason, scope: task.scope },
      criteriaText: derived.semanticCriteriaText,
    });
    current = res.record;
  } catch (err) {
    if (err instanceof QaSemanticEvaluatorError && err.code === 'BLOCKED') {
      throw new QaGateError('BLOCKED', `QA gate: semantic QA precondition failed, no state changed: ${err.message}`);
    }
    wrapGateError(err);
  }
  return current;
}

// ── remediation dispatch (seams 3–4) ─────────────────────────────────────────

async function dispatchFromPreparation(
  dataRoot: string,
  project: string,
  prep: QaRemediationPreparationRecord,
  attempt: QaAttemptRecord,
  evaluatedDerived: DerivedQaEvaluationContract,
  options?: ReconcileQaGateOptions,
): Promise<ReconcileQaGateResult> {
  const preparationId = prep.preparationId;
  let sourceSeatReleased: { runId: string; reservationId: string } | undefined;

  // Already-remediated failure is never redispatched (terminal-success
  // bookkeeping — plan §11 Q13, seam 8).
  let task = requireTask(dataRoot, project, prep.taskId);
  if (prep.dispatchedRunId) {
    const linked = task.linkedRuns.find((r) => r.runId === prep.dispatchedRunId);
    if (!linked) {
      throw new QaGateError(
        'CONFLICT',
        `QA gate: preparation ${preparationId} claims Run ${prep.dispatchedRunId} which is no longer linked; refusing.`,
      );
    }
    return {
      outcome: 'FAIL_REMEDIATION_ADOPTED',
      taskId: task.taskId,
      runId: attempt.runId,
      qaAttemptId: attempt.qaAttemptId,
      finalQaStatus: 'FAIL',
      remediationRunId: linked.runId,
      alreadyDispatched: true,
    };
  }

  // Crash seam 4: a Run folder already exists/linked — adopt it, never spawn
  // a second Worker.
  const correlated = findQaRemediationRunForPreparation(task, preparationId);
  if (correlated) {
    const consumed = await consumeQaRemediationPreparation(dataRoot, project, preparationId, correlated.runId);
    void consumed;
    return {
      outcome: 'FAIL_REMEDIATION_ADOPTED',
      taskId: task.taskId,
      runId: attempt.runId,
      qaAttemptId: attempt.qaAttemptId,
      finalQaStatus: 'FAIL',
      remediationRunId: correlated.runId,
      alreadyDispatched: true,
    };
  }

  // Defense in depth: an authorized-but-over-budget preparation never
  // dispatches (the creation-time budget check is the primary gate; this
  // closes any race where the budget was consumed between creation and
  // dispatch — exhausted budget cannot race into another Run).
  if (prep.qaRemediationNumber > evaluatedDerived.maxQaRemediationAttempts) {
    throw new QaGateError(
      'CONFLICT',
      `QA gate: preparation ${preparationId} remediation #${prep.qaRemediationNumber} exceeds budget ${evaluatedDerived.maxQaRemediationAttempts}; refusing dispatch.`,
    );
  }

  // Canonical remediation transition: RESULT_RECEIVED+PENDING → READY+PENDING.
  // A Task already READY+PENDING took this transition before a crash between
  // commit and dispatch — proceed (never re-increment, never re-transition).
  // Any other state with no correlated Run fails closed.
  task = requireTask(dataRoot, project, prep.taskId);
  if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'PENDING') {
    try {
      task = await requestQaRemediationRetry(dataRoot, project, task.taskId, {
        goalId: task.goalId,
        reason: `qa-remediation:${preparationId}`,
      });
    } catch (err) {
      wrapGateError(err, 'CONFLICT');
    }
  } else if (!(task.executionState === 'READY' && task.pmState === 'PENDING')) {
    const retry = findQaRemediationRunForPreparation(task, preparationId);
    if (retry) {
      const consumed = await consumeQaRemediationPreparation(dataRoot, project, preparationId, retry.runId);
      void consumed;
      return {
        outcome: 'FAIL_REMEDIATION_ADOPTED',
        taskId: task.taskId,
        runId: attempt.runId,
        qaAttemptId: attempt.qaAttemptId,
        finalQaStatus: 'FAIL',
        remediationRunId: retry.runId,
        alreadyDispatched: true,
      };
    }
    throw new QaGateError(
      'CONFLICT',
      `QA gate: Task ${task.taskId} is ${task.executionState}+${task.pmState} with no correlated remediation Run; refusing dispatch.`,
    );
  }

  // Frozen-binding validation, all server-side from durable state:
  // the source Run must still be linked, and its authoritative workerId /
  // workspaceRoot must still equal the preparation snapshots (a silently
  // switched Worker or workspace fails closed here).
  task = requireTask(dataRoot, project, prep.taskId);
  const sourceLink = task.linkedRuns.find((r) => r.runId === prep.sourceRunId);
  if (!sourceLink) {
    throw new QaGateError('INVALID_STATE', `QA gate: source Run ${prep.sourceRunId} is no longer linked to Task ${task.taskId}.`);
  }
  const sourceMeta = readRunMeta(sourceLink.folder);
  if (!sourceMeta.workerId || !sourceMeta.workspaceRoot) {
    throw new QaGateError('INVALID_STATE', `QA gate: source Run ${prep.sourceRunId} has no authoritative worker/workspace binding.`);
  }
  if (sourceMeta.workerId !== prep.workerId) {
    throw new QaGateError(
      'INVALID_STATE',
      `QA gate: source Run worker '${sourceMeta.workerId}' differs from preparation binding '${prep.workerId}'; refusing (no silent Worker switch).`,
    );
  }
  if (path.resolve(sourceMeta.workspaceRoot) !== path.resolve(prep.workspaceRoot)) {
    throw new QaGateError(
      'INVALID_STATE',
      'QA gate: source Run workspace differs from preparation binding; refusing (no silent workspace switch).',
    );
  }
  // QA remediation follows Result capture without a PM judgment. Release the
  // source Run's FINAL_BOUND seat before reserving the same worker again;
  // this is the same canonical closeout used by PM ACCEPT/CHANGES.
  try {
    const sourceBinding = readRuntimeBinding(sourceLink.folder);
    const sourceWorker = loadWorkerRegistryRecord(dataRoot, prep.workerId);
    if (sourceBinding?.collectStatus === 'FINAL_BOUND' && sourceBinding.closeoutStatus !== 'RELEASED' && sourceWorker.driverOptions?.actl) {
      const reservationId = String(sourceBinding.reservationId ?? '');
      const released = await closeActlManagedReservation(sourceWorker.launchCommand, sourceBinding as ActlRuntimeBinding, { accepted: false });
      writeRuntimeBinding(sourceLink.folder, released);
      if (reservationId) sourceSeatReleased = { runId: prep.sourceRunId, reservationId };
    }
  } catch (err) {
    throw new QaGateError('BLOCKED', `QA gate: source Run seat closeout failed; remediation not dispatched: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    loadWorkerRegistryRecord(dataRoot, prep.workerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: remediation worker unavailable: ${msg}`);
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspaceRoot(prep.workspaceRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: remediation workspace revalidation failed: ${msg}`);
  }

  // Contract continuity: the Task contract the remediation executes must be
  // the contract QA evaluated — a mid-flight contract change fails closed
  // (the Task contract is frozen at creation; this closes the hand-edit
  // window between evaluation and dispatch inside one reconciliation).
  const freshTask = requireTask(dataRoot, project, prep.taskId);
  let freshDerived: DerivedQaEvaluationContract;
  try {
    freshDerived = deriveQaEvaluationContract(freshTask);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: Task contract changed mid-flight, refusing remediation: ${msg}`);
  }
  if (
    JSON.stringify(freshDerived.checks) !== JSON.stringify(evaluatedDerived.checks)
    || JSON.stringify(freshDerived.criteriaValidationModes) !== JSON.stringify(evaluatedDerived.criteriaValidationModes)
    || (freshDerived.qaWorkerId ?? null) !== (evaluatedDerived.qaWorkerId ?? null)
    || freshDerived.maxQaRemediationAttempts !== evaluatedDerived.maxQaRemediationAttempts
  ) {
    throw new QaGateError('INVALID_STATE', 'QA gate: Task QA contract changed between evaluation and dispatch; refusing remediation.');
  }

  // Bounded remediation prompt from authoritative frozen evidence only
  // (frozen Task text, durable failed criteria/evidence, durable semantic
  // reason/instruction, bounded prior excerpt).
  let prompt: string;
  try {
    const prior = readPriorResultExcerpt(sourceLink.folder);
    prompt = composeQaRemediationPrompt({
      task: {
        taskId: freshTask.taskId,
        title: freshTask.title,
        goal: freshTask.goal,
        reason: freshTask.reason,
        scope: freshTask.scope,
        completionCriteria: freshTask.completionCriteria,
        ...(freshTask.acceptanceCriteria ? { acceptanceCriteria: freshTask.acceptanceCriteria } : {}),
      },
      preparationId,
      sourceRunId: prep.sourceRunId,
      qaRemediationNumber: prep.qaRemediationNumber,
      failedCriteria: [...attempt.failedCriteria],
      deterministicSummary: summarizeAttemptDeterministic(attempt),
      ...(semanticReasonFromAttempt(attempt) ? { semanticReason: semanticReasonFromAttempt(attempt) as string } : {}),
      ...(attempt.remediationInstruction ? { remediationInstruction: attempt.remediationInstruction } : {}),
      priorExcerpt: prior.excerpt,
      priorAvailable: prior.available,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: remediation prompt composition failed: ${msg}`);
  }

  // Canonical dispatch with trusted internal QA-remediation correlation —
  // a real canonical implementation Run linked into Task.linkedRuns.
  let newRunId: string;
  try {
    const dispatch = options?.dispatchRemediation
      ? await options.dispatchRemediation(dataRoot, project, {
        taskId: task.taskId,
        workerId: prep.workerId,
        workspaceRoot,
        preparationId,
        sourceRunId: prep.sourceRunId,
        prompt,
      })
      : await dispatchTask(dataRoot, project, {
        taskId: task.taskId,
        workerId: prep.workerId,
        workspaceRoot,
        expectedExecutionState: 'READY',
        qaRemediationContext: {
          preparationId,
          sourceRunId: prep.sourceRunId,
          prompt,
        },
      });
    newRunId = dispatch.runId;
  } catch (err) {
    // Post-commit failures (capture arm / spawn) preserve the correlated
    // Run: bind it best-effort so no duplicate is ever launched, then still
    // report the failure — a failed dispatch must never look like a
    // successfully started remediation.
    try {
      const after = requireTask(dataRoot, project, prep.taskId);
      const found = findQaRemediationRunForPreparation(after, preparationId);
      if (found) await consumeQaRemediationPreparation(dataRoot, project, preparationId, found.runId);
    } catch { /* binding best-effort; the error below is authoritative */ }
    if (err instanceof DispatcherError && err.code === 'LAUNCH_FAILED') {
      throw new QaGateError('LAUNCH_FAILED', `QA gate: remediation dispatch failed: ${err.message}`);
    }
    wrapGateError(err, 'CONFLICT');
  }

  // Consumption binds only after the remediation Run is durably materialized.
  try {
    await consumeQaRemediationPreparation(dataRoot, project, preparationId, newRunId);
  } catch (err) {
    wrapGateError(err, 'CONFLICT');
  }
  return {
    outcome: 'FAIL_REMEDIATION_DISPATCHED',
    taskId: task.taskId,
    runId: attempt.runId,
    qaAttemptId: attempt.qaAttemptId,
    finalQaStatus: 'FAIL',
      remediationRunId: newRunId,
      alreadyDispatched: false,
      ...(sourceSeatReleased ? { sourceSeatReleased } : {}),
  };
}

// ── FAIL handling (seam 3 + budget §12) ──────────────────────────────────────

async function handleTerminalFail(
  dataRoot: string,
  project: string,
  task: TaskRecord,
  attempt: QaAttemptRecord,
  derived: DerivedQaEvaluationContract,
  options?: ReconcileQaGateOptions,
): Promise<ReconcileQaGateResult> {
  // QA remediation proceeds ONLY from PENDING — a Task already owned by a
  // PM judgment (VERIFYING after escalation, CHANGES_REQUESTED, ACCEPTED)
  // is never pulled back into remediation. The VERIFYING-after-exhaustion
  // case re-escalates idempotently below via the budget check; every other
  // non-PENDING state fails closed here.
  if (task.pmState !== 'PENDING') {
    const used = countQaRemediationsForTask(dataRoot, project, task.taskId);
    if (task.pmState === 'VERIFYING' && used >= derived.maxQaRemediationAttempts) {
      return escalateWithDelivery(dataRoot, project, task, 'FAIL_ESCALATED_BUDGET_EXHAUSTED', attempt);
    }
    throw new QaGateError(
      'CONFLICT',
      `QA gate: Task ${task.taskId} is ${task.executionState}+${task.pmState}; refusing QA remediation (PM judgment owns this Task).`,
    );
  }

  const preparationId = qaRemediationPreparationIdFor(attempt.qaAttemptId);
  if (attempt.remediationPreparationId && attempt.remediationPreparationId !== preparationId) {
    throw new QaGateError(
      'INVALID_STATE',
      `QA gate: attempt ${attempt.qaAttemptId} linked to unexpected preparation ${attempt.remediationPreparationId}; refusing.`,
    );
  }

  // Existing preparation? Reuse it (idempotent replay / crash resume) —
  // never mint a second preparation for the same eligible failure (seam 8).
  let prep: QaRemediationPreparationRecord | null = null;
  try {
    prep = getQaRemediationPreparation(dataRoot, project, preparationId);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'CORRUPT_RECORD') {
      throw new QaGateError(
        'CORRUPT_RECORD',
        `QA gate: remediation preparation ${preparationId} is corrupt (no recreation over corrupt state): ${(err as Error).message}`,
      );
    }
    if (code !== 'NOT_FOUND') wrapGateError(err);
    prep = null;
  }
  if (prep) {
    if (prep.taskId !== task.taskId || prep.sourceRunId !== attempt.runId) {
      throw new QaGateError(
        'INVALID_STATE',
        `QA gate: preparation ${preparationId} identity mismatch (task/run); refusing.`,
      );
    }
    if (JSON.stringify([...prep.failedCriteria].sort()) !== JSON.stringify([...attempt.failedCriteria].sort())) {
      throw new QaGateError(
        'INVALID_STATE',
        `QA gate: preparation ${preparationId} failedCriteria diverged from attempt; refusing.`,
      );
    }
    return dispatchFromPreparation(dataRoot, project, prep, attempt, derived, options);
  }

  // No preparation yet (seam 3): enforce the frozen remediation budget
  // BEFORE creating anything. Exhausted ⇒ escalate, never Run 4 (plan §12).
  const used = countQaRemediationsForTask(dataRoot, project, task.taskId);
  if (used >= derived.maxQaRemediationAttempts) {
    return escalateWithDelivery(dataRoot, project, task, 'FAIL_ESCALATED_BUDGET_EXHAUSTED', attempt);
  }

  // Create the preparation from authoritative QA failure — every identity
  // derived server-side from durable state (failing Run binding for
  // worker/workspace; attempt for criteria/instruction ref).
  const sourceLink = task.linkedRuns.find((r) => r.runId === attempt.runId);
  if (!sourceLink) {
    throw new QaGateError('INVALID_STATE', `QA gate: failing Run ${attempt.runId} is no longer linked to Task ${task.taskId}.`);
  }
  const sourceMeta = readRunMeta(sourceLink.folder);
  if (!sourceMeta.workerId || !sourceMeta.workspaceRoot) {
    throw new QaGateError('INVALID_STATE', `QA gate: failing Run ${attempt.runId} has no authoritative worker/workspace binding.`);
  }
  // Binding pre-validation (validate before authorizing): the remediation
  // binding is checked BEFORE any preparation is created. A preparation
  // snapshots the failing Run's binding at creation and later reconciles
  // reuse the existing preparation instead of re-snapshotting — so creating
  // one from a currently-invalid binding (transient registry/workspace
  // failure, corrupted Run meta) would poison the durable record and wedge
  // the Task permanently, with no sanctioned recourse. Failures here create
  // nothing and consume no budget; the Task stays RESULT_RECEIVED+PENDING
  // and a later reconcile retries from fresh durable state.
  // (dispatchFromPreparation re-validates for the creation→dispatch crash
  // window — each check guards its own window.)
  try {
    loadWorkerRegistryRecord(dataRoot, sourceMeta.workerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: remediation worker unavailable: ${msg}`);
  }
  try {
    validateWorkspaceRoot(sourceMeta.workspaceRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaGateError('INVALID_STATE', `QA gate: remediation workspace revalidation failed: ${msg}`);
  }
  let created: QaRemediationPreparationRecord;
  try {
    created = await createQaRemediationPreparation(dataRoot, project, {
      sourceQaAttemptId: attempt.qaAttemptId,
      taskId: task.taskId,
      sourceRunId: attempt.runId,
      qaRemediationNumber: used + 1,
      failedCriteria: [...attempt.failedCriteria],
      // Logical pointer to the source attempt's remediationInstruction —
      // the instruction text is never copied (plan §6).
      remediationInstructionRef: attempt.qaAttemptId,
      workerId: sourceMeta.workerId,
      workspaceRoot: sourceMeta.workspaceRoot,
    });
  } catch (err) {
    wrapGateError(err, 'CONFLICT');
  }
  try {
    await linkRemediationPreparation(dataRoot, project, attempt.qaAttemptId, created.preparationId);
  } catch (err) {
    wrapGateError(err, 'CONFLICT');
  }
  const freshAttempt = getQaAttempt(dataRoot, project, attempt.qaAttemptId);
  return dispatchFromPreparation(dataRoot, project, created, freshAttempt, derived, options);
}

// ── main reconciliation ──────────────────────────────────────────────────────

/** Same "canonically captured" marker resolveAuthoritativeRunBinding uses
 * (mirrors completed-run-recovery.ts): evidence/adapter.json exists. */
function hasCanonicalCapture(runFolder: string): boolean {
  try {
    return fs.existsSync(path.join(runFolder, 'evidence', 'adapter.json'));
  } catch {
    return false;
  }
}

/**
 * Seam 4 pre-check (plan §14): adopt already-materialized remediation Runs
 * for READY undispatched preparations BEFORE evaluating anything — a crash
 * between the dispatch commit and the consumption-marker write must never
 * spawn a second Worker. Returns the adopted binding when the adopted Run
 * is the current attempt and has no captured Result yet (nothing further
 * to do this call); otherwise the adoption is persisted and reconciliation
 * proceeds normally (a completed adopted Run is QA-evaluated like any
 * other — its preparation stays correctly consumed).
 */
async function adoptMaterializedRemediationRuns(
  dataRoot: string,
  project: string,
  task: TaskRecord,
): Promise<{ prep: QaRemediationPreparationRecord; runId: string; folder: string } | null> {
  let adopted: { prep: QaRemediationPreparationRecord; runId: string; folder: string } | null = null;
  let preps: QaRemediationPreparationRecord[];
  try {
    preps = listQaRemediationPreparations(dataRoot, project);
  } catch {
    return null;
  }
  for (const p of preps) {
    if (p.taskId !== task.taskId || p.status !== 'READY' || p.dispatchedRunId) continue;
    const correlated = findQaRemediationRunForPreparation(task, p.preparationId);
    if (!correlated) continue;
    // The preparation must belong to a terminal FAIL attempt of the same
    // Task/Run — anything else is an impossible persisted state, fail closed.
    let source: QaAttemptRecord;
    try {
      source = getQaAttempt(dataRoot, project, p.sourceQaAttemptId);
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 'CORRUPT_RECORD') {
        throw new QaGateError(
          'CORRUPT_RECORD',
          `QA gate: seam-4 source attempt ${p.sourceQaAttemptId} is corrupt (no recreation over corrupt state): ${(err as Error).message}`,
        );
      }
      throw new QaGateError(
        'INVALID_STATE',
        `QA gate: seam-4 preparation ${p.preparationId} has no source attempt; refusing: ${(err as Error).message}`,
      );
    }
    if (source.finalQaStatus !== 'FAIL' || source.taskId !== task.taskId || source.runId !== p.sourceRunId) {
      throw new QaGateError(
        'INVALID_STATE',
        `QA gate: seam-4 preparation ${p.preparationId} source attempt is not a FAIL of this Task/Run; refusing.`,
      );
    }
    try {
      await consumeQaRemediationPreparation(dataRoot, project, p.preparationId, correlated.runId);
    } catch (err) {
      wrapGateError(err, 'CONFLICT');
    }
    adopted = { prep: p, runId: correlated.runId, folder: correlated.folder };
  }
  return adopted;
}

async function reconcileQaGateInner(dataRoot: string, project: string, taskId: string, options?: ReconcileQaGateOptions): Promise<ReconcileQaGateResult> {
  const task = requireTask(dataRoot, project, taskId);

  // Backward-compatibility seam: Tasks without a QA contract behave exactly
  // as before (the bridge mints the Delivery unconditionally). The gate is
  // a no-op for them — V1/V1.5 Tasks are never retroactively QA-gated.
  if (!task.qaContract) {
    const currentRun = resolveCurrentAttemptRunId(task);
    return { outcome: 'SKIPPED_NO_CONTRACT', taskId, ...(currentRun ? { runId: currentRun } : {}) };
  }

  // Seam 4 before anything else (see adoptMaterializedRemediationRuns).
  const adoptedSeam4 = await adoptMaterializedRemediationRuns(dataRoot, project, task);

  const runId = resolveCurrentAttemptRunId(task);
  if (!runId) {
    throw new QaGateError('INVALID_STATE', `QA gate: Task ${taskId} has no linked Run to evaluate; refusing.`);
  }
  // Crash seam resolved by adoption alone: the adopted Run is current and
  // has no captured Result yet — report the adoption, evaluate nothing.
  if (adoptedSeam4 && adoptedSeam4.runId === runId && !hasCanonicalCapture(adoptedSeam4.folder)) {
    return {
      outcome: 'FAIL_REMEDIATION_ADOPTED',
      taskId,
      runId: adoptedSeam4.prep.sourceRunId,
      qaAttemptId: adoptedSeam4.prep.sourceQaAttemptId,
      finalQaStatus: 'FAIL',
      remediationRunId: adoptedSeam4.runId,
      alreadyDispatched: true,
    };
  }
  const qaAttemptId = qaAttemptIdFor(taskId, runId);

  // Server-side contract derivation (throws on malformed contract). A
  // malformed contract fails closed via escalation: no verdict is
  // fabricated, no remediation is dispatched, and GPT PM receives the
  // Result knowingly instead of the Task deadlocking in PENDING.
  let derived: DerivedQaEvaluationContract;
  try {
    derived = deriveQaEvaluationContract(task);
  } catch (err) {
    if (err instanceof QaContractError) {
      const pseudoAttempt: QaAttemptRecord = {
        schemaVersion: 1,
        qaAttemptId,
        project,
        taskId,
        runId,
        qaAttemptNumber: 1,
        finalQaStatus: 'BLOCKED',
        failedCriteria: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
      return escalateWithDelivery(dataRoot, project, task, 'BLOCKED_ESCALATED', pseudoAttempt);
    }
    wrapGateError(err);
  }

  // Seam 1/7: fetch or create the attempt (corrupt records fail closed —
  // never treated as absent, never recreated).
  let attempt: QaAttemptRecord;
  try {
    attempt = getQaAttempt(dataRoot, project, qaAttemptId);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'CORRUPT_RECORD') {
      throw new QaGateError(
        'CORRUPT_RECORD',
        `QA gate: attempt ${qaAttemptId} is corrupt (no recreation over corrupt state): ${(err as Error).message}`,
      );
    }
    if (code !== 'NOT_FOUND') wrapGateError(err);
    try {
      attempt = await createQaAttempt(dataRoot, project, {
        taskId,
        runId,
        qaAttemptNumber:
          task.linkedRuns.find((r) => r.runId === runId)?.taskRunSequence ?? 1,
        ...(derived!.qaWorkerId ? { qaWorkerId: derived!.qaWorkerId } : {}),
        criteriaValidationModes: { ...derived!.criteriaValidationModes },
        ...(task.contract?.contract_hash
          ? { contractHash: task.contract.contract_hash }
          : {}),
      });
    } catch (createErr) {
      wrapGateError(createErr, 'CONFLICT');
    }
  }

  // Evaluate to a terminal verdict unless already terminal (duplicate
  // reconciliation of a decided attempt is a bounded no-op read — seam 7).
  let terminal: QaAttemptRecord = attempt!;
  if (terminal.finalQaStatus === 'PENDING') {
    try {
      terminal = await evaluateAttemptToTerminal(dataRoot, project, terminal, derived!, task);
    } catch (err) {
      // Precondition-BLOCKED (broken binding, missing capture/worker)
      // propagates WITHOUT state change — resumable later (seam 6).
      if (err instanceof QaGateError) throw err;
      wrapGateError(err);
    }
  }

  // Terminal handling. All branches re-read Task truth fresh inside their
  // helpers; a Task that already moved on (ACCEPTED, new attempt running)
  // is never pulled backward.
  const freshTask = requireTask(dataRoot, project, taskId);
  switch (terminal.finalQaStatus) {
    case 'PASS':
      return escalateWithDelivery(dataRoot, project, freshTask, 'PASS_DELIVERED', terminal);
    case 'FAIL':
      return handleTerminalFail(dataRoot, project, freshTask, terminal, derived!, options);
    case 'BLOCKED':
      // QA BLOCKED is never automatic remediation (release-blocking rule).
      return escalateWithDelivery(dataRoot, project, freshTask, 'BLOCKED_ESCALATED', terminal);
    default:
      throw new QaGateError(
        'INVALID_STATE',
        `QA gate: attempt ${qaAttemptId} has non-terminal status ${terminal.finalQaStatus} after evaluation; refusing to guess.`,
      );
  }
}

/**
 * Bounded internal QA-gate reconciliation (plan §14). Resumes from durable
 * evidence at every seam; duplicate calls collapse to idempotent no-ops;
 * concurrent calls collapse to one remediation Run via CAS + adoption.
 */
export function reconcileQaGate(dataRoot: string, project: string, taskId: string, options?: ReconcileQaGateOptions): Promise<ReconcileQaGateResult> {
  const tid = typeof taskId === 'string' ? taskId.trim() : '';
  if (!tid) return Promise.reject(new QaGateError('INVALID_ARGUMENT', 'QA gate: taskId가 필요합니다.'));
  return withQaGateLock(dataRoot, project, tid, async (): Promise<ReconcileQaGateResult> => {
    try {
      return await reconcileQaGateInner(dataRoot, project, tid, options);
    } catch (err) {
      if (err instanceof QaGateError) throw err;
      wrapGateError(err);
    }
  });
}

/**
 * Live result-bridge trigger (plan §16): exactly reconcileQaGate — restart
 * reconciliation and the live trigger are the same function.
 */
export function runOrResumeQaGate(
  dataRoot: string,
  project: string,
  taskId: string,
  options?: ReconcileQaGateOptions,
): Promise<ReconcileQaGateResult> {
  return reconcileQaGate(dataRoot, project, taskId, options);
}
