/**
 * V1.6 Slice 1 — durable QA Remediation Preparation kernel.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §6, §11, §14 (accepted
 * commit f1c8959). This is the durable authorization/preparation record for
 * one QA-driven same-Task remediation Run — structurally distinct from, and
 * never sharing state with, the existing G5 CHANGES-retry lineage
 * (retry-preparation.ts's RetryPreparationRecord, `RTP-PMJ-...`).
 *
 * Naming note: the architecture doc's domain model names this record's
 * source-attempt field `qaAttemptId` and its sequence field
 * `nextAttemptSequence`. This implementation uses the clearer
 * `sourceQaAttemptId` / `qaRemediationNumber` (identical meaning — the
 * failing QaAttemptRecord this preparation was created from, and this
 * Task's 1-based count of QA remediation attempts) per the Slice 1
 * implementation instruction. The preparationId format (`QRP-{source
 * QaAttemptId}`), the terminal-success bookkeeping shape (`dispatchedRunId`/
 * `dispatchedAt`/`consumedAt`, status stays put once set — mirroring
 * RetryPreparationRecord exactly), and every invariant are unchanged from
 * the frozen doc.
 *
 * This Slice does NOT dispatch anything. It does NOT read Task/Run storage —
 * `workerId`/`workspaceRoot`/`failedCriteria` are snapshotted onto the record
 * by the caller at creation time (a future wiring slice reads them from the
 * frozen Task binding and the source QaAttemptRecord).
 *
 * Storage: {dataRoot}/{project}/_relay/qa-remediation-preparations/{preparationId}/
 *   preparation.json (SSOT) + preparation.md (human mirror). Same atomic-write
 * / per-record-lock conventions as retry-preparation.ts and pm-delivery.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic } from './goal-task.js';

export const QA_REMEDIATION_PREPARATION_SCHEMA_VERSION = 1;

/** Three states suffice (§11) — QA remediation never touches pmState, so it
 * needs no CHANGES_APPLIED-equivalent step. READY is terminal-success
 * bookkeeping: once READY, `dispatchedRunId`/`consumedAt` are the only
 * further mutation, exactly like RetryPreparationRecord. FAILED is reserved
 * for a preparation whose source attempt became invalid before dispatch. */
export const QA_REMEDIATION_PREPARATION_STATUSES = ['RECEIVED', 'READY', 'FAILED'] as const;
export type QaRemediationPreparationStatus = (typeof QA_REMEDIATION_PREPARATION_STATUSES)[number];

export interface QaRemediationPreparationRecord {
  schemaVersion: number;
  preparationId: string;            // "QRP-{sourceQaAttemptId}"
  project: string;
  sourceQaAttemptId: string;        // the FAILing QaAttemptRecord — immutable
  taskId: string;
  sourceRunId: string;              // the FAILing implementation Run — immutable
  qaRemediationNumber: number;      // >= 1, advisory count within this Task's QA-fail lineage
  failedCriteria: string[];         // immutable snapshot copied from the source QaAttemptRecord at creation
  /** Logical pointer to the source QaAttemptRecord's remediationInstruction —
   * the instruction text is NEVER copied here (mirrors retryInstructionRef). */
  remediationInstructionRef: string;
  workerId: string;                 // frozen binding identity, copied from the failing Run — immutable
  workspaceRoot: string;            // frozen binding identity, copied from the failing Run — immutable
  status: QaRemediationPreparationStatus;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  /** Terminal-success bookkeeping — one preparation binds at most one retry
   * Run, identical shape to RetryPreparationRecord's own fields (§11, Q13). */
  dispatchedRunId?: string;
  dispatchedAt?: string;
  consumedAt?: string;
  failedAt?: string;
  failureCode?: string;
}

export class QaRemediationPreparationError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: QaRemediationPreparationError['code'], message: string) {
    super(message);
    this.name = 'QaRemediationPreparationError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function qaRemediationPreparationsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'qa-remediation-preparations');
}

export function qaRemediationPreparationFolder(dataRoot: string, project: string, preparationId: string): string {
  return path.join(qaRemediationPreparationsDir(dataRoot, project), preparationId);
}

function preparationJsonPath(folder: string): string {
  return path.join(folder, 'preparation.json');
}

function preparationMdPath(folder: string): string {
  return path.join(folder, 'preparation.md');
}

// ── locks ────────────────────────────────────────────────────────────────────

const _qaRemediationPrepLocks = new Map<string, Promise<void>>();

function prepLockKey(dataRoot: string, project: string, preparationId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${preparationId}`;
}

function withQaRemediationPrepLock<T>(
  dataRoot: string,
  project: string,
  preparationId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = prepLockKey(dataRoot, project, preparationId);
  const prev = _qaRemediationPrepLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _qaRemediationPrepLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local QA remediation preparation lock chains. */
export function _resetQaRemediationPreparationLocksForTests(): void {
  _qaRemediationPrepLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const TASK_ID_RE = /^TASK-\d+$/;
const QA_ATTEMPT_ID_RE = /^QA-TASK-\d+-[A-Za-z0-9._-]+$/;
const QA_REMEDIATION_PREPARATION_ID_RE = /^QRP-QA-TASK-\d+-[A-Za-z0-9._-]+$/;

export function qaRemediationPreparationIdFor(sourceQaAttemptId: string): string {
  if (typeof sourceQaAttemptId !== 'string' || !QA_ATTEMPT_ID_RE.test(sourceQaAttemptId)) {
    throw new QaRemediationPreparationError('INVALID_ARGUMENT', `잘못된 sourceQaAttemptId: ${String(sourceQaAttemptId)}`);
  }
  return `QRP-${sourceQaAttemptId}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new QaRemediationPreparationError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isQaRemediationPreparationStatus(v: unknown): v is QaRemediationPreparationStatus {
  return typeof v === 'string' && (QA_REMEDIATION_PREPARATION_STATUSES as readonly string[]).includes(v);
}

export function validateQaRemediationPreparationRecord(r: QaRemediationPreparationRecord): void {
  if (r.schemaVersion !== QA_REMEDIATION_PREPARATION_SCHEMA_VERSION) {
    throw new QaRemediationPreparationError('INVALID_STATE', `지원하지 않는 QA Remediation Preparation schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.preparationId !== 'string' || !QA_REMEDIATION_PREPARATION_ID_RE.test(r.preparationId)) {
    throw new QaRemediationPreparationError('INVALID_STATE', `잘못된 preparationId: ${String(r.preparationId)}`);
  }
  if (!r.project || typeof r.project !== 'string') {
    throw new QaRemediationPreparationError('INVALID_STATE', 'QA Remediation Preparation project가 필요합니다.');
  }
  if (!TASK_ID_RE.test(r.taskId)) {
    throw new QaRemediationPreparationError('INVALID_STATE', `잘못된 Task ID: ${r.taskId}`);
  }
  if (!r.sourceRunId || typeof r.sourceRunId !== 'string') {
    throw new QaRemediationPreparationError('INVALID_STATE', 'sourceRunId가 필요합니다.');
  }
  if (!r.workerId || typeof r.workerId !== 'string') {
    throw new QaRemediationPreparationError('INVALID_STATE', 'workerId가 필요합니다.');
  }
  if (!r.workspaceRoot || typeof r.workspaceRoot !== 'string' || !path.isAbsolute(r.workspaceRoot)) {
    throw new QaRemediationPreparationError('INVALID_STATE', 'workspaceRoot는 절대 경로 문자열이어야 합니다.');
  }
  if (!isQaRemediationPreparationStatus(r.status)) {
    throw new QaRemediationPreparationError('INVALID_STATE', `알 수 없는 status: ${String(r.status)}`);
  }
  if (typeof r.qaRemediationNumber !== 'number' || !Number.isInteger(r.qaRemediationNumber) || r.qaRemediationNumber < 1) {
    throw new QaRemediationPreparationError('INVALID_STATE', 'qaRemediationNumber는 1 이상의 정수여야 합니다.');
  }
  if (!Array.isArray(r.failedCriteria) || r.failedCriteria.length === 0 || r.failedCriteria.some((c) => typeof c !== 'string')) {
    throw new QaRemediationPreparationError('INVALID_STATE', 'failedCriteria는 비어 있지 않은 문자열 배열이어야 합니다.');
  }
  const expected = qaRemediationPreparationIdFor(r.sourceQaAttemptId);
  if (r.preparationId !== expected) {
    throw new QaRemediationPreparationError('INVALID_STATE', `preparationId 불일치: ${r.preparationId} ≠ ${expected}`);
  }
  if (r.status === 'FAILED') {
    if (r.dispatchedRunId) {
      throw new QaRemediationPreparationError('INVALID_STATE', 'FAILED 상태는 dispatchedRunId를 가질 수 없습니다.');
    }
  }
  if (r.consumedAt && !r.dispatchedRunId) {
    throw new QaRemediationPreparationError('INVALID_STATE', 'consumedAt은 dispatchedRunId 없이 존재할 수 없습니다.');
  }
}

function renderPreparationMarkdown(r: QaRemediationPreparationRecord): string {
  return [
    `# ${r.preparationId}`,
    '',
    '## Identity',
    '',
    `- project: ${r.project}`,
    `- taskId: ${r.taskId}`,
    `- sourceQaAttemptId: ${r.sourceQaAttemptId}`,
    `- sourceRunId: ${r.sourceRunId}`,
    `- qaRemediationNumber: ${r.qaRemediationNumber}`,
    `- workerId: ${r.workerId}`,
    `- workspaceRoot: ${r.workspaceRoot}`,
    '',
    '## Status',
    '',
    r.status,
    r.dispatchedRunId ? `dispatchedRunId: ${r.dispatchedRunId}` : '',
    '',
    '## Failed Criteria',
    '',
    ...r.failedCriteria.map((c) => `- ${c}`),
    '',
    `createdAt: ${r.createdAt}`,
    `updatedAt: ${r.updatedAt}`,
    '',
  ].join('\n');
}

function persistQaRemediationPreparationRecord(folder: string, record: QaRemediationPreparationRecord): void {
  validateQaRemediationPreparationRecord(record);
  writeJsonAtomic(preparationJsonPath(folder), record);
  try {
    fs.writeFileSync(preparationMdPath(folder), renderPreparationMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaRemediationPreparationError(
      'INVALID_STATE',
      `Preparation JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`,
    );
  }
}

function readQaRemediationPreparationRecord(
  dataRoot: string,
  project: string,
  preparationId: string,
): QaRemediationPreparationRecord | null {
  if (!QA_REMEDIATION_PREPARATION_ID_RE.test(preparationId)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(
      fs.readFileSync(preparationJsonPath(qaRemediationPreparationFolder(dataRoot, project, preparationId)), 'utf8'),
    );
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const record = raw as QaRemediationPreparationRecord;
    validateQaRemediationPreparationRecord(record);
    return record;
  } catch {
    return null;
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

export function getQaRemediationPreparation(
  dataRoot: string,
  project: string,
  preparationId: string,
): QaRemediationPreparationRecord {
  const record = readQaRemediationPreparationRecord(dataRoot, project, preparationId);
  if (!record) {
    throw new QaRemediationPreparationError('NOT_FOUND', `QA Remediation Preparation을 찾을 수 없습니다: ${preparationId}`);
  }
  return record;
}

/** List all preparation records (malformed siblings skipped deterministically). */
export function listQaRemediationPreparations(dataRoot: string, project: string): QaRemediationPreparationRecord[] {
  const dir = qaRemediationPreparationsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: QaRemediationPreparationRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!QA_REMEDIATION_PREPARATION_ID_RE.test(name)) continue;
    const record = readQaRemediationPreparationRecord(dataRoot, project, name);
    if (record) out.push(record);
  }
  out.sort((a, b) => a.preparationId.localeCompare(b.preparationId));
  return out;
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateQaRemediationPreparationInput {
  sourceQaAttemptId: string;
  taskId: string;
  sourceRunId: string;
  qaRemediationNumber: number;
  failedCriteria: string[];
  remediationInstructionRef: string;
  workerId: string;
  workspaceRoot: string;
}

/**
 * Idempotent create keyed by the deterministic `QRP-{sourceQaAttemptId}` id —
 * at most one remediation preparation can ever exist per QA attempt, exactly
 * like at most one PM Delivery exists per Run. Identical inputs replay to
 * the existing record; conflicting inputs for the same id are a CONFLICT.
 * Always created directly in `READY` — Slice 1 has no intermediate business
 * step to model as a transient `RECEIVED` phase (unlike G5-B's
 * requestTaskChanges step); `RECEIVED` remains in the type for shape parity
 * with the frozen doc and for any future slice that needs it.
 */
export function createQaRemediationPreparation(
  dataRoot: string,
  project: string,
  input: CreateQaRemediationPreparationInput,
): Promise<QaRemediationPreparationRecord> {
  const taskId = requireNonEmptyString(input.taskId, 'taskId');
  const sourceRunId = requireNonEmptyString(input.sourceRunId, 'sourceRunId');
  const workerId = requireNonEmptyString(input.workerId, 'workerId');
  const workspaceRoot = requireNonEmptyString(input.workspaceRoot, 'workspaceRoot');
  const remediationInstructionRef = requireNonEmptyString(input.remediationInstructionRef, 'remediationInstructionRef');
  if (typeof input.qaRemediationNumber !== 'number' || !Number.isInteger(input.qaRemediationNumber) || input.qaRemediationNumber < 1) {
    throw new QaRemediationPreparationError('INVALID_ARGUMENT', 'qaRemediationNumber는 1 이상의 정수여야 합니다.');
  }
  if (!Array.isArray(input.failedCriteria) || input.failedCriteria.length === 0) {
    throw new QaRemediationPreparationError('INVALID_ARGUMENT', 'failedCriteria는 비어 있지 않은 배열이어야 합니다.');
  }
  const preparationId = qaRemediationPreparationIdFor(input.sourceQaAttemptId);

  return withQaRemediationPrepLock(dataRoot, project, preparationId, (): QaRemediationPreparationRecord => {
    const folder = qaRemediationPreparationFolder(dataRoot, project, preparationId);
    const existing = readQaRemediationPreparationRecord(dataRoot, project, preparationId);
    if (existing) {
      const sameIdentity =
        existing.taskId === taskId
        && existing.sourceRunId === sourceRunId
        && existing.qaRemediationNumber === input.qaRemediationNumber
        && existing.workerId === workerId
        && existing.workspaceRoot === workspaceRoot
        && JSON.stringify(existing.failedCriteria) === JSON.stringify(input.failedCriteria);
      if (!sameIdentity) {
        throw new QaRemediationPreparationError(
          'CONFLICT',
          `QA Remediation Preparation ${preparationId}가 이미 다른 내용으로 존재합니다.`,
        );
      }
      return existing;
    }
    const ts = nowIso();
    const record: QaRemediationPreparationRecord = {
      schemaVersion: QA_REMEDIATION_PREPARATION_SCHEMA_VERSION,
      preparationId,
      project,
      sourceQaAttemptId: input.sourceQaAttemptId,
      taskId,
      sourceRunId,
      qaRemediationNumber: input.qaRemediationNumber,
      failedCriteria: [...input.failedCriteria],
      remediationInstructionRef,
      workerId,
      workspaceRoot,
      status: 'READY',
      createdAt: ts,
      updatedAt: ts,
      readyAt: ts,
    };
    fs.mkdirSync(folder, { recursive: true });
    persistQaRemediationPreparationRecord(folder, record);
    return record;
  });
}

// ── consume / fail ───────────────────────────────────────────────────────────

/**
 * Record that a preparation produced its one remediation Run. Status stays
 * `READY` (never rewritten — terminal-success bookkeeping, §11); only
 * additive consumption fields are set. Idempotent for the same runId;
 * refuses to rebind to a different runId. Mirrors
 * retry-preparation.ts's `markRetryPreparationConsumed` exactly.
 */
export function consumeQaRemediationPreparation(
  dataRoot: string,
  project: string,
  preparationId: string,
  runId: string,
): Promise<QaRemediationPreparationRecord> {
  const rid = requireNonEmptyString(runId, 'runId');
  return withQaRemediationPrepLock(dataRoot, project, preparationId, (): QaRemediationPreparationRecord => {
    const prep = getQaRemediationPreparation(dataRoot, project, preparationId);
    if (prep.status !== 'READY') {
      throw new QaRemediationPreparationError(
        'CONFLICT',
        `Preparation ${preparationId}는 ${prep.status} 상태이므로 consume할 수 없습니다.`,
      );
    }
    if (prep.dispatchedRunId && prep.dispatchedRunId !== rid) {
      throw new QaRemediationPreparationError(
        'CONFLICT',
        `Preparation ${preparationId}는 이미 ${prep.dispatchedRunId}에 바인딩되어 있어 ${rid}로 재바인딩할 수 없습니다.`,
      );
    }
    if (prep.dispatchedRunId === rid) return prep; // idempotent replay
    const ts = nowIso();
    const next: QaRemediationPreparationRecord = {
      ...prep,
      dispatchedRunId: rid,
      dispatchedAt: prep.dispatchedAt ?? ts,
      consumedAt: ts,
      updatedAt: ts,
    };
    persistQaRemediationPreparationRecord(qaRemediationPreparationFolder(dataRoot, project, preparationId), next);
    return next;
  });
}

/** Terminal failure of a preparation that was never consumed (e.g. its
 * source attempt/Task became invalid before dispatch). Never legal once
 * a Run has been bound. */
export function failQaRemediationPreparation(
  dataRoot: string,
  project: string,
  preparationId: string,
  failureCode: string,
): Promise<QaRemediationPreparationRecord> {
  const code = requireNonEmptyString(failureCode, 'failureCode');
  return withQaRemediationPrepLock(dataRoot, project, preparationId, (): QaRemediationPreparationRecord => {
    const prep = getQaRemediationPreparation(dataRoot, project, preparationId);
    if (prep.status === 'FAILED') return prep; // idempotent replay
    if (prep.dispatchedRunId) {
      throw new QaRemediationPreparationError(
        'CONFLICT',
        `Preparation ${preparationId}는 이미 Run ${prep.dispatchedRunId}에 소비되어 FAILED로 전이할 수 없습니다.`,
      );
    }
    const ts = nowIso();
    const next: QaRemediationPreparationRecord = { ...prep, status: 'FAILED', failedAt: ts, failureCode: code, updatedAt: ts };
    persistQaRemediationPreparationRecord(qaRemediationPreparationFolder(dataRoot, project, preparationId), next);
    return next;
  });
}
