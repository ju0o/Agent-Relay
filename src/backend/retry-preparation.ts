/**
 * V1-G5-B — Retry Preparation kernel.
 *
 * Turns one durable CHANGES judgment into a safely prepared retry of the
 * SAME Task: canonical requestTaskChanges() → CHANGES_REQUESTED, then
 * canonical requestTaskRetry() → READY + PENDING (retryCount++ via runtime).
 *
 * No direct Task mutation: both steps go through task-actions.ts (gate +
 * CAS + canonical Events). No Run creation, no dispatch, no prompt work —
 * those belong to G5-C. The retry instruction is REFERENCED (immutable
 * logical pointer to the G5-A intent), never duplicated here.
 *
 * Crash model: the preparation record is recovery bookkeeping; Task state
 * is canonical truth. Every seam resumes from Task state:
 *   prep RECEIVED + task VERIFYING          → requestTaskChanges
 *   prep ≤CHANGES_APPLIED + task CHANGES_REQUESTED → requestTaskRetry (once)
 *   prep <READY + task READY+PENDING        → mark READY, no re-increment
 *   task terminal/displaced                  → FAILED, no mutation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic, getTask } from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { getPmDelivery } from './pm-delivery.js';
import {
  getPmJudgment,
  getRetryInstructionForDelivery,
  markJudgmentApplied,
  pmJudgmentIdFor,
} from './pm-judgment.js';
import { requestTaskChanges, requestTaskRetry } from './task-actions.js';
import type { TaskRecord } from '../shared/types.js';

/** Retry Preparation record schema version. */
export const RETRY_PREPARATION_SCHEMA_VERSION = 1;

export const RETRY_PREPARATION_STATUSES = [
  'RECEIVED',
  'CHANGES_APPLIED',
  'READY',
  'FAILED',
] as const;
export type RetryPreparationStatus = (typeof RETRY_PREPARATION_STATUSES)[number];

export interface RetryPreparationRecord {
  schemaVersion: number;
  preparationId: string;
  project: string;
  judgmentId: string;
  deliveryId: string;
  taskId: string;
  sourceRunId: string;
  /** Predicted next attempt sequence (source run sequence + 1). Advisory. */
  nextAttemptSequence: number;
  status: RetryPreparationStatus;
  reason: string;
  /**
   * Immutable logical reference to the G5-A intent payload (resolved via
   * getRetryInstructionForDelivery). The instruction text is NEVER copied here.
   */
  retryInstructionRef: string;
  retryCountBefore: number;
  createdAt: string;
  updatedAt: string;
  changesAppliedAt?: string;
  readyAt?: string;
  failedAt?: string;
  failureCode?: string;
}

export interface RetryPreparationResult {
  preparation: RetryPreparationRecord;
  task: TaskRecord;
}

export class RetryPreparationError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: RetryPreparationError['code'], message: string) {
    super(message);
    this.name = 'RetryPreparationError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function retryPreparationsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'retry-preparations');
}

export function retryPreparationFolder(dataRoot: string, project: string, preparationId: string): string {
  return path.join(retryPreparationsDir(dataRoot, project), preparationId);
}

function preparationJsonPath(folder: string): string {
  return path.join(folder, 'preparation.json');
}

function preparationMdPath(folder: string): string {
  return path.join(folder, 'preparation.md');
}

// ── locks ────────────────────────────────────────────────────────────────────

const _prepLocks = new Map<string, Promise<void>>();

function prepLockKey(dataRoot: string, project: string, preparationId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${preparationId}`;
}

function withPrepLock<T>(dataRoot: string, project: string, preparationId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = prepLockKey(dataRoot, project, preparationId);
  const prev = _prepLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _prepLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local preparation chains. */
export function _resetRetryPreparationLocksForTests(): void {
  _prepLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const PREP_ID_RE = /^RTP-PMJ-PMD-TASK-\d+-[A-Za-z0-9._-]+$/;

export function retryPreparationIdFor(judgmentId: string): string {
  if (typeof judgmentId !== 'string' || !/^PMJ-PMD-TASK-\d+-[A-Za-z0-9._-]+$/.test(judgmentId)) {
    throw new RetryPreparationError('INVALID_ARGUMENT', `잘못된 judgmentId: ${String(judgmentId)}`);
  }
  return `RTP-${judgmentId}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RetryPreparationError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function validateRetryPreparationRecord(r: RetryPreparationRecord): void {
  if (r.schemaVersion !== RETRY_PREPARATION_SCHEMA_VERSION) {
    throw new RetryPreparationError('INVALID_STATE', `지원하지 않는 Retry Preparation schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.preparationId !== 'string' || !PREP_ID_RE.test(r.preparationId)) {
    throw new RetryPreparationError('INVALID_STATE', `잘못된 preparationId: ${String(r.preparationId)}`);
  }
  if (!r.project || typeof r.project !== 'string') {
    throw new RetryPreparationError('INVALID_STATE', 'Retry Preparation project가 필요합니다.');
  }
  if (!(['RECEIVED', 'CHANGES_APPLIED', 'READY', 'FAILED'] as readonly string[]).includes(r.status)) {
    throw new RetryPreparationError('INVALID_STATE', `알 수 없는 status: ${String(r.status)}`);
  }
  const expected = retryPreparationIdFor(r.judgmentId);
  if (r.preparationId !== expected) {
    throw new RetryPreparationError('INVALID_STATE', `preparationId 불일치: ${r.preparationId} ≠ ${expected}`);
  }
}

function renderPreparationMarkdown(r: RetryPreparationRecord): string {
  return [
    `# ${r.preparationId}`,
    '',
    '## Identity',
    '',
    `- project: ${r.project}`,
    `- judgmentId: ${r.judgmentId}`,
    `- deliveryId: ${r.deliveryId}`,
    `- taskId: ${r.taskId}`,
    `- sourceRunId: ${r.sourceRunId}`,
    `- nextAttemptSequence: ${r.nextAttemptSequence}`,
    '',
    '## Status',
    '',
    r.status,
    '',
    `createdAt: ${r.createdAt}`,
    `updatedAt: ${r.updatedAt}`,
    '',
  ].join('\n');
}

function persistPreparationRecord(folder: string, record: RetryPreparationRecord): void {
  validateRetryPreparationRecord(record);
  writeJsonAtomic(preparationJsonPath(folder), record);
  try {
    fs.writeFileSync(preparationMdPath(folder), renderPreparationMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RetryPreparationError('INVALID_STATE', `Preparation JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

function readPreparationRecord(dataRoot: string, project: string, preparationId: string): RetryPreparationRecord | null {
  if (!PREP_ID_RE.test(preparationId)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(preparationJsonPath(retryPreparationFolder(dataRoot, project, preparationId)), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const record = raw as RetryPreparationRecord;
    validateRetryPreparationRecord(record);
    return record;
  } catch {
    return null;
  }
}

export function getRetryPreparation(dataRoot: string, project: string, preparationId: string): RetryPreparationRecord {
  const record = readPreparationRecord(dataRoot, project, preparationId);
  if (!record) {
    throw new RetryPreparationError('NOT_FOUND', `Retry Preparation을 찾을 수 없습니다: ${preparationId}`);
  }
  return record;
}

/** List all preparation records (malformed siblings skipped deterministically). */
export function listRetryPreparations(dataRoot: string, project: string): RetryPreparationRecord[] {
  const dir = retryPreparationsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: RetryPreparationRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!PREP_ID_RE.test(name)) continue;
    const record = readPreparationRecord(dataRoot, project, name);
    if (record) out.push(record);
  }
  out.sort((a, b) => a.preparationId.localeCompare(b.preparationId));
  return out;
}

// ── prepare / reconcile ──────────────────────────────────────────────────────

/**
 * Prepare a retry for one CHANGES judgment (delivery-derived identity).
 *
 * Validates judgment + intent + delivery + Task binding, ensures exactly one
 * preparation record, then reconciles it to READY through the canonical
 * requestTaskChanges → requestTaskRetry sequence. Idempotent: replays and
 * restarts resume from Task truth without duplicating mutations.
 */
export function prepareRetryForJudgment(
  dataRoot: string,
  project: string,
  deliveryId: string,
): Promise<RetryPreparationResult> {
  const did = requireNonEmptyString(deliveryId, 'deliveryId');
  const judgmentId = pmJudgmentIdFor(did);
  const preparationId = retryPreparationIdFor(judgmentId);

  return withPrepLock(dataRoot, project, preparationId, async (): Promise<RetryPreparationResult> => {
    // 1. Judgment must exist and be a CHANGES intent.
    let judgment;
    try {
      judgment = getPmJudgment(dataRoot, project, judgmentId);
    } catch {
      throw new RetryPreparationError('NOT_FOUND', `CHANGES judgment이 없습니다: ${judgmentId}`);
    }
    if (judgment.decision !== 'CHANGES') {
      throw new RetryPreparationError('INVALID_STATE', 'ACCEPT judgment cannot create retry preparation.');
    }
    if (judgment.status !== 'RECEIVED' && judgment.status !== 'APPLIED') {
      throw new RetryPreparationError('CONFLICT', `Judgment ${judgmentId} is ${judgment.status}; cannot prepare.`);
    }
    // 2. Durable intent must be present (never invent it here).
    let instruction: string;
    try {
      instruction = getRetryInstructionForDelivery(dataRoot, project, did);
    } catch {
      throw new RetryPreparationError('INVALID_STATE', `Durable retry instruction missing for ${did}; refusing to prepare.`);
    }
    void instruction;
    // 3. Delivery binding must still hold (task/run match, source linked).
    const delivery = getPmDeliveryChecked(dataRoot, project, did, judgment);
    // 4. Ensure exactly one preparation record.
    const folder = retryPreparationFolder(dataRoot, project, preparationId);
    let prep = readPreparationRecord(dataRoot, project, preparationId);
    if (!prep) {
      const task = getTask(dataRoot, project, judgment.taskId);
      const sourceLink = task.linkedRuns.find((r) => r.runId === judgment.runId);
      if (!sourceLink) {
        throw new RetryPreparationError('CONFLICT', `Source Run ${judgment.runId} is no longer linked.`);
      }
      const ts = nowIso();
      prep = {
        schemaVersion: RETRY_PREPARATION_SCHEMA_VERSION,
        preparationId,
        project,
        judgmentId,
        deliveryId: did,
        taskId: judgment.taskId,
        sourceRunId: judgment.runId,
        nextAttemptSequence: sourceLink.taskRunSequence + 1,
        status: 'RECEIVED',
        reason: judgment.reason ?? '',
        retryInstructionRef: judgmentId,
        retryCountBefore: task.retryCount ?? 0,
        createdAt: ts,
        updatedAt: ts,
      };
      fs.mkdirSync(folder, { recursive: true });
      persistPreparationRecord(folder, prep);
    } else if (prep.deliveryId !== did || prep.taskId !== judgment.taskId || prep.sourceRunId !== judgment.runId) {
      throw new RetryPreparationError('INVALID_STATE', `Preparation identity mismatch for ${preparationId}.`);
    }
    void delivery;
    // 5. Reconcile to READY from Task truth.
    return reconcilePreparation(dataRoot, project, folder, prep);
  });
}

/**
 * Restart/recovery entry: identical semantics to prepare (validate +
 * ensure + reconcile from Task truth). Safe to call any number of times.
 */
export function reconcileRetryPreparationForJudgment(
  dataRoot: string,
  project: string,
  deliveryId: string,
): Promise<RetryPreparationResult> {
  return prepareRetryForJudgment(dataRoot, project, deliveryId);
}

function getPmDeliveryChecked(
  dataRoot: string,
  project: string,
  deliveryId: string,
  judgment: { taskId: string; runId: string },
): { taskId: string; runId: string } {
  let delivery;
  try {
    delivery = getPmDelivery(dataRoot, project, deliveryId);
  } catch {
    throw new RetryPreparationError('NOT_FOUND', `PM Delivery를 찾을 수 없습니다: ${deliveryId}`);
  }
  if (delivery.kind !== 'TASK_VERIFY') {
    throw new RetryPreparationError('CONFLICT', `TASK_VERIFY delivery가 아닙니다: ${deliveryId}`);
  }
  if (delivery.taskId !== judgment.taskId || delivery.runId !== judgment.runId) {
    throw new RetryPreparationError('CONFLICT', 'Judgment/delivery binding mismatch.');
  }
  return { taskId: delivery.taskId, runId: delivery.runId };
}

function markPrep(
  folder: string,
  prep: RetryPreparationRecord,
  status: RetryPreparationRecord['status'],
  extra?: { failureCode?: string },
): RetryPreparationRecord {
  const ts = nowIso();
  const next: RetryPreparationRecord = {
    ...prep,
    status,
    updatedAt: ts,
    ...(status === 'CHANGES_APPLIED' ? { changesAppliedAt: ts } : {}),
    ...(status === 'READY' ? { readyAt: ts } : {}),
    ...(status === 'FAILED' ? { failedAt: ts, ...(extra?.failureCode ? { failureCode: extra.failureCode } : {}) } : {}),
  };
  persistPreparationRecord(folder, next);
  return next;
}

async function reconcilePreparation(
  dataRoot: string,
  project: string,
  folder: string,
  prep: RetryPreparationRecord,
): Promise<RetryPreparationResult> {
  if (prep.status === 'READY') {
    return { preparation: prep, task: getTask(dataRoot, project, prep.taskId) };
  }
  if (prep.status === 'FAILED') {
    throw new RetryPreparationError('CONFLICT', `Preparation ${prep.preparationId} already FAILED.`);
  }
  const task = getTask(dataRoot, project, prep.taskId);

  // Terminal / displaced states: fail safely, never mutate backward.
  if (
    task.pmState === 'ACCEPTED'
    || task.executionState === 'CANCELLED'
    || task.executionState === 'BLOCKED'
    || task.executionState === 'FAILED'
  ) {
    const failed = markPrep(folder, prep, 'FAILED', { failureCode: 'TASK_TERMINAL' });
    throw new RetryPreparationError('CONFLICT', `Task ${task.taskId} is terminal (${task.executionState}+${task.pmState}); retry refused.`);
  }
  const current = resolveCurrentAttemptRunId(task);
  if (current !== prep.sourceRunId && !(task.executionState === 'READY' && task.pmState === 'PENDING')) {
    // Source attempt displaced (a newer attempt exists and task is not in the
    // reconciled READY state) — never prepare against the wrong attempt.
    const failed = markPrep(folder, prep, 'FAILED', { failureCode: 'SOURCE_DISPLACED' });
    void failed;
    throw new RetryPreparationError('CONFLICT', `Source attempt ${prep.sourceRunId} displaced (current=${current ?? 'none'}).`);
  }

  // Task already READY+PENDING: adopt (case D) — never re-increment retryCount.
  // (READY/FAILED preparations returned above, so this always advances.)
  if (task.executionState === 'READY' && task.pmState === 'PENDING') {
    const advanced = markPrep(folder, prep, 'READY');
    await advanceJudgment(dataRoot, project, prep);
    return { preparation: advanced, task };
  }

  // CHANGES_REQUESTED: continue to retry only (never repeat changes).
  if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'CHANGES_REQUESTED') {
    const applied = prep.status === 'RECEIVED' ? markPrep(folder, prep, 'CHANGES_APPLIED') : prep;
    await callRequestRetry(dataRoot, project, folder, applied, task);
    return finishReady(dataRoot, project, folder, applied);
  }

  // VERIFYING: full sequence, but only from a fresh RECEIVED preparation.
  // A CHANGES_APPLIED preparation facing VERIFYING means external regression
  // (someone moved the Task back) — refuse to duplicate the changes call.
  if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'VERIFYING') {
    if (prep.status !== 'RECEIVED') {
      throw new RetryPreparationError('CONFLICT', `Preparation ${prep.preparationId} is ${prep.status} but Task regressed to VERIFYING; refusing duplicate changes.`);
    }
    const afterChanges = await callRequestChanges(dataRoot, project, folder, prep, task);
    await callRequestRetry(dataRoot, project, folder, afterChanges, task);
    return finishReady(dataRoot, project, folder, afterChanges);
  }

  const failed = markPrep(folder, prep, 'FAILED', { failureCode: 'UNEXPECTED_TASK_STATE' });
  void failed;
  throw new RetryPreparationError('CONFLICT', `Task ${task.taskId} is ${task.executionState}+${task.pmState}; cannot prepare retry.`);
}

async function callRequestChanges(
  dataRoot: string,
  project: string,
  folder: string,
  prep: RetryPreparationRecord,
  task: TaskRecord,
): Promise<RetryPreparationRecord> {
  let after: TaskRecord;
  try {
    after = await requestTaskChanges({
      dataRoot,
      project,
      goalId: task.goalId,
      taskId: task.taskId,
      runId: prep.sourceRunId,
      reason: prep.reason,
      expectedExecutionState: 'RESULT_RECEIVED',
      expectedPmState: 'VERIFYING',
      callerSurface: 'PM_MCP',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markPrep(folder, prep, 'FAILED', { failureCode: 'CHANGES_FAILED' });
    throw new RetryPreparationError('INVALID_STATE', `requestTaskChanges failed: ${msg}`);
  }
  void after;
  return markPrep(folder, prep, 'CHANGES_APPLIED');
}

async function callRequestRetry(
  dataRoot: string,
  project: string,
  folder: string,
  prep: RetryPreparationRecord,
  task: TaskRecord,
): Promise<RetryPreparationRecord> {
  try {
    await requestTaskRetry({
      dataRoot,
      project,
      goalId: task.goalId,
      taskId: task.taskId,
      expectedExecutionState: 'RESULT_RECEIVED',
      expectedPmState: 'CHANGES_REQUESTED',
      reason: `pm-changes:${prep.judgmentId}`,
      callerSurface: 'PM_MCP',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    markPrep(folder, prep, 'FAILED', { failureCode: 'RETRY_FAILED' });
    throw new RetryPreparationError('INVALID_STATE', `requestTaskRetry failed: ${msg}`);
  }
  return prep;
}

async function finishReady(
  dataRoot: string,
  project: string,
  folder: string,
  prep: RetryPreparationRecord,
): Promise<RetryPreparationResult> {
  const task = getTask(dataRoot, project, prep.taskId);
  if (task.executionState !== 'READY' || task.pmState !== 'PENDING') {
    markPrep(folder, prep, 'FAILED', { failureCode: 'NOT_READY_AFTER_RETRY' });
    throw new RetryPreparationError('INVALID_STATE', 'Retry did not reach READY+PENDING.');
  }
  const ready = markPrep(folder, prep, 'READY');
  await advanceJudgment(dataRoot, project, prep);
  return { preparation: ready, task };
}

/** Advance the CHANGES judgment to APPLIED once preparation is READY. */
async function advanceJudgment(
  dataRoot: string,
  project: string,
  prep: RetryPreparationRecord,
): Promise<void> {
  try {
    await markJudgmentApplied(dataRoot, project, prep.judgmentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RetryPreparationError('INVALID_STATE', `Judgment advance failed: ${msg}`);
  }
}
