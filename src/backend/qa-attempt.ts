/**
 * V1.6 Slice 1 — durable QA Attempt kernel.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §6, §8, §9, §10 (accepted
 * commit f1c8959, correction 01). This file implements ONLY the durable
 * storage/validation/transition primitives for one QaAttemptRecord — the
 * validation outcome for one specific Worker Run. It does NOT:
 *
 *   - run any deterministic check or spawn any QA Agent (Slice 2/3)
 *   - decide when QA starts, or mint/suppress any PM Delivery (Slice 4)
 *   - read Task or Run storage (kept dependency-free / isolated by design —
 *     a future wiring slice reads the frozen Task contract and passes the
 *     relevant snapshot in, e.g. `criteriaValidationModes`)
 *   - expose any MCP tool
 *
 * Domain authority (unchanged): Task owns lifecycle/PM state, Run owns the
 * execution attempt, PM Delivery owns the communication obligation. This
 * record owns ONLY the QA validation outcome for one Run — a third axis,
 * never written onto TaskRecord (§8).
 *
 * Non-override invariant (§8, §9, §10): a deterministic FAIL or BLOCKED is
 * final — recordDeterministicEvidence() finalizes the record immediately in
 * that case, so there is no later call through which semantic evidence could
 * appear to override it. Semantic evidence may only ever be recorded (or a
 * no-semantic-needed completion applied) once deterministic has recorded
 * PASS. This is enforced structurally by the mutation functions below AND
 * defensively re-checked by validateQaAttemptRecord() on every persist/read,
 * so a hand-corrupted or partially-written record can never load as valid.
 *
 * Storage: {dataRoot}/{project}/_relay/qa-attempts/{qaAttemptId}/
 *   qa.json (SSOT) + qa.md (human mirror). Atomic JSON writes; per-attempt
 * process-local serialization for mutations — same conventions as
 * pm-delivery.ts and retry-preparation.ts.
 *
 * Absent vs. corrupt (correction 01): a qaAttemptId whose qa.json genuinely
 * does not exist is NOT_FOUND. A qa.json that exists but fails to parse, is
 * schema-invalid, or has a taskId/runId identity mismatch is a distinct
 * CORRUPT_RECORD outcome (readQaAttemptRecordRaw below) — never collapsed
 * into NOT_FOUND, and never silently repaired, deleted, or recreated
 * (createQaAttempt's idempotent-replay path refuses to create over a
 * corrupt existing record for the same reason).
 *
 * criteriaValidationModes (§7): the value passed into CreateQaAttemptInput
 * is an INTERNAL materialized snapshot only, stored as-is with no
 * derivation or verification against Task storage (this kernel never reads
 * Task/Run records — see above). When a future slice wires QA to real Tasks
 * (V16-QA-GATE-PLAN-01.md §22, Slice 4), that snapshot MUST be derived
 * server-side from the authoritative frozen Task Acceptance Criteria at the
 * moment the attempt is created — no MCP tool, Worker, or QA Agent caller
 * may supply or override it. Slice 1 accepts it as a plain caller-supplied
 * value ONLY because no such caller exists yet; this is not a precedent for
 * a future trust boundary.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic } from './goal-task.js';

// ── schema ───────────────────────────────────────────────────────────────────

export const QA_ATTEMPT_SCHEMA_VERSION = 1;

/** Frozen deterministic check-kind vocabulary (§6, §9). The evaluator that
 * produces these is Slice 2 — this Slice only stores/validates the shape. */
export const QA_DETERMINISTIC_CHECK_KINDS = [
  'fileExists',
  'fileExactContent',
  'diffScope',
  'command',
] as const;
export type QaDeterministicCheckKind = (typeof QA_DETERMINISTIC_CHECK_KINDS)[number];

/** Per-check status. BLOCKED = the check itself could not run (spawn error,
 * timeout, unreadable path) — distinct from FAIL, which means the check ran
 * and answered "no" (§9). */
export const QA_CHECK_STATUSES = ['PASS', 'FAIL', 'INFO', 'BLOCKED'] as const;
export type QaCheckStatus = (typeof QA_CHECK_STATUSES)[number];

/** Deterministic/semantic layer sub-verdict. SKIPPED = semantic intentionally
 * not run (deterministic did not PASS, or no SEMANTIC/BOTH criterion exists). */
export const QA_SUB_VERDICTS = ['PASS', 'FAIL', 'SKIPPED', 'BLOCKED'] as const;
export type QaSubVerdict = (typeof QA_SUB_VERDICTS)[number];

/** Record-level final verdict. PENDING = created, not yet decided. Terminal
 * once PASS/FAIL/BLOCKED (§6 QaVerdict, extended with PENDING for the
 * pre-decision state this kernel must represent — never SKIPPED here). */
export const QA_FINAL_STATUSES = ['PENDING', 'PASS', 'FAIL', 'BLOCKED'] as const;
export type QaFinalStatus = (typeof QA_FINAL_STATUSES)[number];

/** Acceptance-criterion validation mode (§7, correction 01). Snapshotted onto
 * the attempt at creation time ONLY for the ids this attempt needs to reason
 * about the BOTH-mode "both layers required" invariant — never re-derived
 * here from Task storage (this kernel never reads Task/Run records). */
export const QA_CRITERION_VALIDATION_MODES = ['DETERMINISTIC', 'SEMANTIC', 'BOTH'] as const;
export type QaCriterionValidationMode = (typeof QA_CRITERION_VALIDATION_MODES)[number];

export interface QaDeterministicCheckResult {
  checkIndex: number;
  kind: QaDeterministicCheckKind;
  status: QaCheckStatus;
  detail: string;
  /** Attributes this check to one AC id for failedCriteria/BOTH-coverage
   * reporting; absent for a bare infrastructure/scope guard (§6). */
  criterionId?: string;
  /** Slice 2 additive: wall-clock duration of this check, when meaningful
   * (e.g. `command`). Never validated/required — old checks without it
   * remain valid. */
  durationMs?: number;
  /** Slice 2 additive: bounded, non-secret supporting evidence (hashes,
   * exit codes, truncated/bounded output, byte lengths) — never full file
   * contents, unbounded process output, or environment dumps. See
   * qa-deterministic-evaluator.ts for the per-kind bounding rules. */
  evidence?: Record<string, unknown>;
}

export interface QaDeterministicEvidence {
  status: QaSubVerdict;
  checks: QaDeterministicCheckResult[];
  startedAt?: string;
  completedAt?: string;
  /** Pointer into the Evidence kernel (EvidenceType='QA'); Slice 1 never
   * writes Evidence — this field is carried through for a future slice. */
  evidenceId?: string;
}

export interface QaSemanticCriterionResult {
  id: string;
  status: 'PASS' | 'FAIL';
  note: string;
}

export interface QaSemanticEvidence {
  status: QaSubVerdict;
  criteria: QaSemanticCriterionResult[];
  qaWorkerId?: string;
  /** Disposable QA-Agent sub-run correlation — never a Task.linkedRuns entry. */
  sessionRef?: string;
  startedAt?: string;
  completedAt?: string;
  evidenceId?: string;
}

export interface QaAttemptRecord {
  schemaVersion: number;
  qaAttemptId: string;              // "QA-{taskId}-{runId}" — deterministic, one per Run
  project: string;
  taskId: string;
  runId: string;                    // the IMPLEMENTATION Run being evaluated
  qaAttemptNumber: number;          // >= 1; caller-supplied (= that Run's taskRunSequence)
  qaWorkerId?: string;              // configured semantic QA worker for this attempt, if any
  /** Snapshot of the AC ids relevant to this attempt and their frozen
   * validationMode, provided by the caller at creation time (never read from
   * Task storage by this kernel) — used only to enforce the BOTH-mode
   * "both layers required before PASS" invariant. */
  criteriaValidationModes?: Record<string, QaCriterionValidationMode>;
  /** WBS-4 additive — TASK_CONTRACT hash snapshot at attempt creation (optional). */
  contractHash?: string;
  deterministic?: QaDeterministicEvidence;
  semantic?: QaSemanticEvidence;
  finalQaStatus: QaFinalStatus;
  failedCriteria: string[];
  remediationInstruction?: string;   // only ever set when finalQaStatus === 'FAIL'
  remediationPreparationId?: string; // set once a QaRemediationPreparationRecord references this attempt
  createdAt: string;
  updatedAt: string;
  completedAt?: string;              // set exactly when finalQaStatus leaves PENDING
}

export class QaAttemptError extends Error {
  /**
   * NOT_FOUND: the path/folder genuinely does not exist — no such attempt
   * was ever created (correction 01, see readQaAttemptRecordRaw below).
   * CORRUPT_RECORD: the file exists but its persisted state is not a valid
   * QaAttemptRecord (malformed JSON, schema-invalid, identity-mismatched,
   * or otherwise an impossible persisted state). This is NEVER collapsed
   * into NOT_FOUND — the two are semantically distinct outcomes that a
   * caller (future QA/reconciliation code) must never confuse, because
   * treating "corrupt" as "never created" could permit duplicate QA
   * attempts or remediation preparations against a Run that already has
   * one. A CORRUPT_RECORD is never silently repaired, deleted, or
   * recreated by this module.
   */
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT' | 'CORRUPT_RECORD';
  constructor(code: QaAttemptError['code'], message: string) {
    super(message);
    this.name = 'QaAttemptError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function qaAttemptsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'qa-attempts');
}

export function qaAttemptFolder(dataRoot: string, project: string, qaAttemptId: string): string {
  return path.join(qaAttemptsDir(dataRoot, project), qaAttemptId);
}

function qaAttemptJsonPath(folder: string): string {
  return path.join(folder, 'qa.json');
}

function qaAttemptMdPath(folder: string): string {
  return path.join(folder, 'qa.md');
}

// ── locks ────────────────────────────────────────────────────────────────────

const _qaAttemptLocks = new Map<string, Promise<void>>();

function qaAttemptLockKey(dataRoot: string, project: string, qaAttemptId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${qaAttemptId}`;
}

function withQaAttemptLock<T>(
  dataRoot: string,
  project: string,
  qaAttemptId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const key = qaAttemptLockKey(dataRoot, project, qaAttemptId);
  const prev = _qaAttemptLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _qaAttemptLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local QA attempt lock chains. */
export function _resetQaAttemptLocksForTests(): void {
  _qaAttemptLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const TASK_ID_RE = /^TASK-\d+$/;
const QA_ATTEMPT_ID_RE = /^QA-TASK-\d+-[A-Za-z0-9._-]+$/;

export function qaAttemptIdFor(taskId: string, runId: string): string {
  const tid = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  if (!TASK_ID_RE.test(tid)) {
    throw new QaAttemptError('INVALID_ARGUMENT', `잘못된 Task ID: ${tid}`);
  }
  if (/[/\\]/.test(rid) || rid === '.' || rid === '..') {
    throw new QaAttemptError('INVALID_ARGUMENT', `잘못된 runId: ${rid}`);
  }
  return `QA-${tid}-${rid}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new QaAttemptError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isQaFinalStatus(v: unknown): v is QaFinalStatus {
  return typeof v === 'string' && (QA_FINAL_STATUSES as readonly string[]).includes(v);
}

export function isQaSubVerdict(v: unknown): v is QaSubVerdict {
  return typeof v === 'string' && (QA_SUB_VERDICTS as readonly string[]).includes(v);
}

function validateDeterministicEvidence(d: QaDeterministicEvidence): void {
  if (!isQaSubVerdict(d.status)) {
    throw new QaAttemptError('INVALID_STATE', `알 수 없는 deterministic status: ${String(d.status)}`);
  }
  if (!Array.isArray(d.checks)) {
    throw new QaAttemptError('INVALID_STATE', 'deterministic.checks는 배열이어야 합니다.');
  }
  for (const c of d.checks) {
    if (!(QA_DETERMINISTIC_CHECK_KINDS as readonly string[]).includes(c.kind)) {
      throw new QaAttemptError('INVALID_STATE', `알 수 없는 deterministic check kind: ${String(c.kind)}`);
    }
    if (!(QA_CHECK_STATUSES as readonly string[]).includes(c.status)) {
      throw new QaAttemptError('INVALID_STATE', `알 수 없는 check status: ${String(c.status)}`);
    }
    if (typeof c.checkIndex !== 'number' || !Number.isInteger(c.checkIndex) || c.checkIndex < 0) {
      throw new QaAttemptError('INVALID_STATE', 'checkIndex는 0 이상의 정수여야 합니다.');
    }
  }
}

function validateSemanticEvidence(s: QaSemanticEvidence): void {
  if (!isQaSubVerdict(s.status)) {
    throw new QaAttemptError('INVALID_STATE', `알 수 없는 semantic status: ${String(s.status)}`);
  }
  if (!Array.isArray(s.criteria)) {
    throw new QaAttemptError('INVALID_STATE', 'semantic.criteria는 배열이어야 합니다.');
  }
  for (const c of s.criteria) {
    if (c.status !== 'PASS' && c.status !== 'FAIL') {
      throw new QaAttemptError('INVALID_STATE', `알 수 없는 semantic criterion status: ${String(c.status)}`);
    }
    if (typeof c.id !== 'string' || !c.id.trim()) {
      throw new QaAttemptError('INVALID_STATE', 'semantic.criteria[].id가 필요합니다.');
    }
  }
}

/**
 * Defense-in-depth validator run on EVERY persist and EVERY read. This is
 * what makes the non-override and BOTH-mode invariants unbypassable even by
 * a hand-edited or partially-written qa.json — not just by callers who go
 * through the mutation functions below.
 */
export function validateQaAttemptRecord(r: QaAttemptRecord): void {
  if (r.schemaVersion !== QA_ATTEMPT_SCHEMA_VERSION) {
    throw new QaAttemptError('INVALID_STATE', `지원하지 않는 QaAttempt schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.qaAttemptId !== 'string' || !QA_ATTEMPT_ID_RE.test(r.qaAttemptId)) {
    throw new QaAttemptError('INVALID_STATE', `잘못된 qaAttemptId: ${String(r.qaAttemptId)}`);
  }
  if (!r.project || typeof r.project !== 'string') {
    throw new QaAttemptError('INVALID_STATE', 'QaAttempt project가 필요합니다.');
  }
  if (!TASK_ID_RE.test(r.taskId)) {
    throw new QaAttemptError('INVALID_STATE', `잘못된 Task ID: ${r.taskId}`);
  }
  if (!r.runId || typeof r.runId !== 'string') {
    throw new QaAttemptError('INVALID_STATE', 'QaAttempt runId가 필요합니다.');
  }
  const expected = qaAttemptIdFor(r.taskId, r.runId);
  if (r.qaAttemptId !== expected) {
    throw new QaAttemptError('INVALID_STATE', `qaAttemptId 불일치: ${r.qaAttemptId} ≠ ${expected}`);
  }
  if (typeof r.qaAttemptNumber !== 'number' || !Number.isInteger(r.qaAttemptNumber) || r.qaAttemptNumber < 1) {
    throw new QaAttemptError('INVALID_STATE', 'qaAttemptNumber는 1 이상의 정수여야 합니다.');
  }
  if (r.contractHash !== undefined) {
    if (typeof r.contractHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.contractHash)) {
      throw new QaAttemptError('INVALID_STATE', 'contractHash는 sha256 hex 문자열이어야 합니다.');
    }
  }
  if (!isQaFinalStatus(r.finalQaStatus)) {
    throw new QaAttemptError('INVALID_STATE', `알 수 없는 finalQaStatus: ${String(r.finalQaStatus)}`);
  }
  if (!Array.isArray(r.failedCriteria) || r.failedCriteria.some((c) => typeof c !== 'string')) {
    throw new QaAttemptError('INVALID_STATE', 'failedCriteria는 문자열 배열이어야 합니다.');
  }
  if (r.deterministic !== undefined) validateDeterministicEvidence(r.deterministic);
  if (r.semantic !== undefined) validateSemanticEvidence(r.semantic);

  // ── terminal/PENDING shape ────────────────────────────────────────────────
  if (r.finalQaStatus === 'PENDING') {
    if (r.completedAt !== undefined) {
      throw new QaAttemptError('INVALID_STATE', 'PENDING 레코드에 completedAt이 있으면 안 됩니다.');
    }
    if (r.failedCriteria.length > 0) {
      throw new QaAttemptError('INVALID_STATE', 'PENDING 레코드는 failedCriteria를 가질 수 없습니다.');
    }
    if (r.remediationInstruction !== undefined) {
      throw new QaAttemptError('INVALID_STATE', 'PENDING 레코드에 remediationInstruction이 있으면 안 됩니다.');
    }
  } else {
    if (!r.completedAt) {
      throw new QaAttemptError('INVALID_STATE', `finalQaStatus=${r.finalQaStatus} 레코드에는 completedAt이 필요합니다.`);
    }
  }

  // ── non-override invariant, defense-in-depth (§8, §9, §10) ───────────────
  if (r.finalQaStatus === 'PASS') {
    if (r.failedCriteria.length > 0) {
      throw new QaAttemptError('INVALID_STATE', 'finalQaStatus=PASS는 failedCriteria가 비어 있어야 합니다.');
    }
    if (r.remediationInstruction !== undefined) {
      throw new QaAttemptError('INVALID_STATE', 'finalQaStatus=PASS에는 remediationInstruction이 있으면 안 됩니다.');
    }
    if (!r.deterministic || r.deterministic.status !== 'PASS') {
      throw new QaAttemptError(
        'INVALID_STATE',
        'finalQaStatus=PASS는 deterministic.status=PASS 없이는 성립할 수 없습니다 (non-override invariant).',
      );
    }
    if (r.semantic !== undefined && r.semantic.status !== 'PASS' && r.semantic.status !== 'SKIPPED') {
      throw new QaAttemptError(
        'INVALID_STATE',
        'finalQaStatus=PASS는 semantic.status가 FAIL/BLOCKED인 채로 성립할 수 없습니다 (non-override invariant).',
      );
    }
    // BOTH-mode coverage: every BOTH-id must have evidence in both layers.
    if (r.criteriaValidationModes) {
      for (const [id, mode] of Object.entries(r.criteriaValidationModes)) {
        if (mode !== 'BOTH') continue;
        const hasDeterministic = !!r.deterministic?.checks.some((c) => c.criterionId === id);
        const hasSemantic = !!r.semantic?.criteria.some((c) => c.id === id);
        if (!hasDeterministic) {
          throw new QaAttemptError('INVALID_STATE', `BOTH 기준 ${id}는 deterministic 근거 없이 PASS일 수 없습니다.`);
        }
        if (!hasSemantic) {
          throw new QaAttemptError('INVALID_STATE', `BOTH 기준 ${id}는 semantic 근거 없이 PASS일 수 없습니다.`);
        }
      }
    }
  }
  if (r.finalQaStatus === 'FAIL' && r.failedCriteria.length === 0) {
    throw new QaAttemptError('INVALID_STATE', 'finalQaStatus=FAIL은 failedCriteria가 최소 1개 필요합니다.');
  }
  if (r.remediationInstruction !== undefined && r.finalQaStatus !== 'FAIL') {
    throw new QaAttemptError('INVALID_STATE', 'remediationInstruction은 finalQaStatus=FAIL에만 존재할 수 있습니다.');
  }
}

function renderQaAttemptMarkdown(r: QaAttemptRecord): string {
  return [
    `# ${r.qaAttemptId}`,
    '',
    '## Identity',
    '',
    `- project: ${r.project}`,
    `- taskId: ${r.taskId}`,
    `- runId: ${r.runId}`,
    `- qaAttemptNumber: ${r.qaAttemptNumber}`,
    '',
    '## Status',
    '',
    `finalQaStatus: ${r.finalQaStatus}`,
    `deterministic: ${r.deterministic?.status ?? '(not yet run)'}`,
    `semantic: ${r.semantic?.status ?? '(not yet run)'}`,
    r.failedCriteria.length ? `failedCriteria: ${r.failedCriteria.join(', ')}` : '',
    '',
    `createdAt: ${r.createdAt}`,
    `updatedAt: ${r.updatedAt}`,
    r.completedAt ? `completedAt: ${r.completedAt}` : '',
    '',
  ].join('\n');
}

function persistQaAttemptRecord(folder: string, record: QaAttemptRecord): void {
  validateQaAttemptRecord(record);
  writeJsonAtomic(qaAttemptJsonPath(folder), record);
  try {
    fs.writeFileSync(qaAttemptMdPath(folder), renderQaAttemptMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QaAttemptError('INVALID_STATE', `QaAttempt JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

/**
 * Correction 01 (V1.6 Slice 1): raw tri-state read of the persisted qa.json.
 * This is the ONLY place that touches the filesystem for a read, so every
 * caller below (getQaAttempt, listQaAttemptsForTask, createQaAttempt's
 * existing-record check) sees the same absent/corrupt/ok distinction and
 * cannot accidentally collapse "corrupt" into "absent":
 *
 *   - 'absent': the qaAttemptId is not even shaped like one, or qa.json does
 *     not exist (ENOENT/ENOTDIR) — genuinely never created.
 *   - 'corrupt': qa.json exists but fails to parse as JSON, is not a JSON
 *     object, fails validateQaAttemptRecord's schema checks, or has an
 *     identity mismatch (qaAttemptId ≠ qaAttemptIdFor(taskId, runId)) — an
 *     impossible/invalid persisted state. `reason` carries the underlying
 *     validation message for diagnostics.
 *   - 'ok': a fully valid record.
 */
type QaAttemptRawRead =
  | { kind: 'absent' }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'ok'; record: QaAttemptRecord };

function readQaAttemptRecordRaw(dataRoot: string, project: string, qaAttemptId: string): QaAttemptRawRead {
  if (!QA_ATTEMPT_ID_RE.test(qaAttemptId)) return { kind: 'absent' };
  const jsonPath = qaAttemptJsonPath(qaAttemptFolder(dataRoot, project, qaAttemptId));
  let text: string;
  try {
    text = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    // Exists but unreadable for some other reason (permissions, I/O) —
    // never silently treated as "never created".
    return { kind: 'corrupt', reason: `qa.json을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { kind: 'corrupt', reason: `qa.json이 유효한 JSON이 아닙니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'corrupt', reason: 'qa.json 최상위 값이 JSON 객체가 아닙니다.' };
  }
  try {
    const record = raw as QaAttemptRecord;
    validateQaAttemptRecord(record);
    return { kind: 'ok', record };
  } catch (err) {
    // Schema-invalid or identity-mismatched — an impossible persisted state.
    return { kind: 'corrupt', reason: err instanceof Error ? err.message : String(err) };
  }
}

function throwIfCorrupt(result: QaAttemptRawRead, qaAttemptId: string): void {
  if (result.kind === 'corrupt') {
    throw new QaAttemptError(
      'CORRUPT_RECORD',
      `QA Attempt ${qaAttemptId}의 영구 저장 상태가 손상되었습니다 (자동 복구/삭제/재생성 금지): ${result.reason}`,
    );
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

export function getQaAttempt(dataRoot: string, project: string, qaAttemptId: string): QaAttemptRecord {
  const result = readQaAttemptRecordRaw(dataRoot, project, qaAttemptId);
  if (result.kind === 'absent') {
    throw new QaAttemptError('NOT_FOUND', `QA Attempt를 찾을 수 없습니다: ${qaAttemptId}`);
  }
  throwIfCorrupt(result, qaAttemptId);
  return (result as { kind: 'ok'; record: QaAttemptRecord }).record;
}

/** List all QA attempts for one Task, ordered by qaAttemptNumber. Corrupt
 * siblings are skipped deterministically (a directory scan must not fail
 * wholesale over one bad sibling) — this never mints or repairs anything,
 * it only omits the corrupt entry from the returned list. */
export function listQaAttemptsForTask(dataRoot: string, project: string, taskId: string): QaAttemptRecord[] {
  const tid = requireNonEmptyString(taskId, 'taskId');
  const dir = qaAttemptsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: QaAttemptRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!QA_ATTEMPT_ID_RE.test(name)) continue;
    const result = readQaAttemptRecordRaw(dataRoot, project, name);
    if (result.kind === 'ok' && result.record.taskId === tid) out.push(result.record);
  }
  out.sort((a, b) => a.qaAttemptNumber - b.qaAttemptNumber);
  return out;
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateQaAttemptInput {
  taskId: string;
  runId: string;
  qaAttemptNumber: number;
  qaWorkerId?: string;
  criteriaValidationModes?: Record<string, QaCriterionValidationMode>;
  /** WBS-4 additive optional snapshot of Task.contract.contract_hash. */
  contractHash?: string;
}

/**
 * Idempotent create: identical inputs replaying the same (taskId, runId)
 * return the existing record unchanged; a second call with different
 * qaAttemptNumber/qaWorkerId/criteriaValidationModes for the SAME
 * (taskId, runId) is a CONFLICT (identity mismatch), never silently
 * overwritten — mirrors retry-preparation.ts's own identity-mismatch guard.
 */
export function createQaAttempt(
  dataRoot: string,
  project: string,
  input: CreateQaAttemptInput,
): Promise<QaAttemptRecord> {
  const taskId = requireNonEmptyString(input.taskId, 'taskId');
  const runId = requireNonEmptyString(input.runId, 'runId');
  if (typeof input.qaAttemptNumber !== 'number' || !Number.isInteger(input.qaAttemptNumber) || input.qaAttemptNumber < 1) {
    throw new QaAttemptError('INVALID_ARGUMENT', 'qaAttemptNumber는 1 이상의 정수여야 합니다.');
  }
  const qaAttemptId = qaAttemptIdFor(taskId, runId);

  return withQaAttemptLock(dataRoot, project, qaAttemptId, (): QaAttemptRecord => {
    const folder = qaAttemptFolder(dataRoot, project, qaAttemptId);
    const existingResult = readQaAttemptRecordRaw(dataRoot, project, qaAttemptId);
    // Correction 01: a corrupt persisted record is never treated as absent.
    // Recreating over it would be exactly the silent repair this correction
    // forbids, and could let a second QA attempt be minted for a Run that
    // already has one.
    throwIfCorrupt(existingResult, qaAttemptId);
    if (existingResult.kind === 'ok') {
      const existing = existingResult.record;
      const sameIdentity =
        existing.qaAttemptNumber === input.qaAttemptNumber
        && existing.qaWorkerId === input.qaWorkerId
        && existing.contractHash === input.contractHash
        && JSON.stringify(existing.criteriaValidationModes ?? {}) === JSON.stringify(input.criteriaValidationModes ?? {});
      if (!sameIdentity) {
        throw new QaAttemptError('CONFLICT', `QA Attempt ${qaAttemptId}가 이미 다른 내용으로 존재합니다.`);
      }
      return existing;
    }
    const ts = nowIso();
    const record: QaAttemptRecord = {
      schemaVersion: QA_ATTEMPT_SCHEMA_VERSION,
      qaAttemptId,
      project,
      taskId,
      runId,
      qaAttemptNumber: input.qaAttemptNumber,
      ...(input.qaWorkerId !== undefined ? { qaWorkerId: input.qaWorkerId } : {}),
      ...(input.criteriaValidationModes !== undefined ? { criteriaValidationModes: input.criteriaValidationModes } : {}),
      ...(input.contractHash !== undefined ? { contractHash: input.contractHash } : {}),
      finalQaStatus: 'PENDING',
      failedCriteria: [],
      createdAt: ts,
      updatedAt: ts,
    };
    fs.mkdirSync(folder, { recursive: true });
    persistQaAttemptRecord(folder, record);
    return record;
  });
}

// ── mutate (evidence recording + completion) ─────────────────────────────────

function requireStillPending(current: QaAttemptRecord, qaAttemptId: string): void {
  if (current.finalQaStatus !== 'PENDING') {
    throw new QaAttemptError(
      'CONFLICT',
      `QA Attempt ${qaAttemptId}는 이미 finalQaStatus=${current.finalQaStatus}로 종료되었습니다; 더 이상 전이할 수 없습니다.`,
    );
  }
}

export interface RecordDeterministicEvidenceInput {
  status: Extract<QaSubVerdict, 'PASS' | 'FAIL' | 'BLOCKED'>;
  checks: QaDeterministicCheckResult[];
  /** Required non-empty when status === 'FAIL'; must be omitted/empty otherwise. */
  failedCriteria?: string[];
  startedAt?: string;
  completedAt?: string;
  evidenceId?: string;
}

/**
 * Record the (exactly-once) deterministic evidence for this attempt. A
 * FAIL or BLOCKED status finalizes the record immediately in this SAME
 * call — semantic evidence can never be recorded afterward (non-override
 * invariant, enforced structurally: recordSemanticEvidence requires the
 * record to still be PENDING, which a FAIL/BLOCKED deterministic result
 * makes impossible). A PASS status leaves the record PENDING, awaiting
 * either recordSemanticEvidence() or completeQaAttempt().
 */
export function recordDeterministicEvidence(
  dataRoot: string,
  project: string,
  qaAttemptId: string,
  input: RecordDeterministicEvidenceInput,
): Promise<QaAttemptRecord> {
  return withQaAttemptLock(dataRoot, project, qaAttemptId, (): QaAttemptRecord => {
    const current = getQaAttempt(dataRoot, project, qaAttemptId);
    requireStillPending(current, qaAttemptId);
    if (current.deterministic !== undefined) {
      throw new QaAttemptError('CONFLICT', `QA Attempt ${qaAttemptId}는 이미 deterministic evidence를 가지고 있습니다.`);
    }
    if (input.status === 'FAIL' && !(input.failedCriteria && input.failedCriteria.length > 0)) {
      throw new QaAttemptError('INVALID_ARGUMENT', 'deterministic FAIL은 failedCriteria가 최소 1개 필요합니다.');
    }
    if (input.status !== 'FAIL' && input.failedCriteria && input.failedCriteria.length > 0) {
      throw new QaAttemptError('INVALID_ARGUMENT', 'deterministic PASS/BLOCKED에는 failedCriteria를 줄 수 없습니다.');
    }
    const ts = nowIso();
    const deterministic: QaDeterministicEvidence = {
      status: input.status,
      checks: input.checks,
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : { completedAt: ts }),
      ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
    };
    const terminal = input.status === 'FAIL' || input.status === 'BLOCKED';
    const next: QaAttemptRecord = {
      ...current,
      deterministic,
      ...(terminal
        ? {
            finalQaStatus: input.status,
            failedCriteria: input.status === 'FAIL' ? [...(input.failedCriteria ?? [])] : [],
            completedAt: ts,
          }
        : {}),
      updatedAt: ts,
    };
    persistQaAttemptRecord(qaAttemptFolder(dataRoot, project, qaAttemptId), next);
    return next;
  });
}

export interface RecordSemanticEvidenceInput {
  status: Extract<QaSubVerdict, 'PASS' | 'FAIL' | 'BLOCKED'>;
  criteria: QaSemanticCriterionResult[];
  failedCriteria?: string[];
  qaWorkerId?: string;
  sessionRef?: string;
  startedAt?: string;
  completedAt?: string;
  evidenceId?: string;
  /** Only meaningful (and only accepted) with status === 'FAIL'. */
  remediationInstruction?: string;
}

/**
 * Record the (exactly-once) semantic evidence for this attempt. Requires
 * deterministic evidence to already be PASS (structural non-override
 * enforcement: this is the only way finalQaStatus can still be PENDING with
 * deterministic evidence present at all).
 */
export function recordSemanticEvidence(
  dataRoot: string,
  project: string,
  qaAttemptId: string,
  input: RecordSemanticEvidenceInput,
): Promise<QaAttemptRecord> {
  return withQaAttemptLock(dataRoot, project, qaAttemptId, (): QaAttemptRecord => {
    const current = getQaAttempt(dataRoot, project, qaAttemptId);
    requireStillPending(current, qaAttemptId);
    if (!current.deterministic || current.deterministic.status !== 'PASS') {
      throw new QaAttemptError(
        'CONFLICT',
        `QA Attempt ${qaAttemptId}는 deterministic PASS 없이는 semantic evidence를 받을 수 없습니다 (non-override invariant).`,
      );
    }
    if (current.semantic !== undefined) {
      throw new QaAttemptError('CONFLICT', `QA Attempt ${qaAttemptId}는 이미 semantic evidence를 가지고 있습니다.`);
    }
    if (input.status === 'FAIL' && !(input.failedCriteria && input.failedCriteria.length > 0)) {
      throw new QaAttemptError('INVALID_ARGUMENT', 'semantic FAIL은 failedCriteria가 최소 1개 필요합니다.');
    }
    if (input.status !== 'FAIL' && input.failedCriteria && input.failedCriteria.length > 0) {
      throw new QaAttemptError('INVALID_ARGUMENT', 'semantic PASS/BLOCKED에는 failedCriteria를 줄 수 없습니다.');
    }
    if (input.remediationInstruction !== undefined && input.status !== 'FAIL') {
      throw new QaAttemptError('INVALID_ARGUMENT', 'remediationInstruction은 semantic FAIL에만 줄 수 있습니다.');
    }
    const ts = nowIso();
    const semantic: QaSemanticEvidence = {
      status: input.status,
      criteria: input.criteria,
      ...(input.qaWorkerId !== undefined ? { qaWorkerId: input.qaWorkerId } : {}),
      ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
      ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : { completedAt: ts }),
      ...(input.evidenceId !== undefined ? { evidenceId: input.evidenceId } : {}),
    };
    const finalQaStatus: QaFinalStatus = input.status; // PASS | FAIL | BLOCKED map 1:1 here
    const next: QaAttemptRecord = {
      ...current,
      semantic,
      finalQaStatus,
      failedCriteria: input.status === 'FAIL' ? [...(input.failedCriteria ?? [])] : [],
      ...(input.remediationInstruction !== undefined ? { remediationInstruction: input.remediationInstruction } : {}),
      completedAt: ts,
      updatedAt: ts,
    };
    persistQaAttemptRecord(qaAttemptFolder(dataRoot, project, qaAttemptId), next);
    return next;
  });
}

export interface CompleteQaAttemptInput {
  /** PASS: deterministic PASSed and no SEMANTIC/BOTH criterion needed a QA
   * Agent (§8/§10 "no LLM call" path). BLOCKED: an operational failure with
   * no semantic verdict to record (e.g. the QA Agent invocation itself
   * failed twice, Q9) — never used to record a substantive FAIL verdict,
   * which must always go through recordDeterministicEvidence/
   * recordSemanticEvidence so a reason is always attached. */
  finalQaStatus: Extract<QaFinalStatus, 'PASS' | 'BLOCKED'>;
}

/**
 * Direct completion without recording semantic evidence. Requires
 * deterministic evidence to already be PASS — this can never be used to
 * bypass a deterministic FAIL/BLOCKED (those already finalized the record).
 */
export function completeQaAttempt(
  dataRoot: string,
  project: string,
  qaAttemptId: string,
  input: CompleteQaAttemptInput,
): Promise<QaAttemptRecord> {
  return withQaAttemptLock(dataRoot, project, qaAttemptId, (): QaAttemptRecord => {
    const current = getQaAttempt(dataRoot, project, qaAttemptId);
    requireStillPending(current, qaAttemptId);
    if (!current.deterministic || current.deterministic.status !== 'PASS') {
      throw new QaAttemptError(
        'CONFLICT',
        `QA Attempt ${qaAttemptId}는 deterministic PASS 없이는 completeQaAttempt로 종료될 수 없습니다.`,
      );
    }
    if (current.semantic !== undefined) {
      throw new QaAttemptError(
        'CONFLICT',
        `QA Attempt ${qaAttemptId}는 이미 semantic evidence가 있습니다; recordSemanticEvidence를 통해 종료하세요.`,
      );
    }
    // BOTH-mode / SEMANTIC-mode criteria require a real semantic evaluation —
    // completeQaAttempt(PASS) is only legal when none is configured.
    if (input.finalQaStatus === 'PASS' && current.criteriaValidationModes) {
      const needsSemantic = Object.values(current.criteriaValidationModes).some((m) => m === 'SEMANTIC' || m === 'BOTH');
      if (needsSemantic) {
        throw new QaAttemptError(
          'INVALID_STATE',
          `QA Attempt ${qaAttemptId}는 SEMANTIC/BOTH 기준이 있어 semantic evidence 없이 PASS로 종료될 수 없습니다 (mandatory invocation rule).`,
        );
      }
    }
    const ts = nowIso();
    const next: QaAttemptRecord = {
      ...current,
      finalQaStatus: input.finalQaStatus,
      failedCriteria: [],
      completedAt: ts,
      updatedAt: ts,
    };
    persistQaAttemptRecord(qaAttemptFolder(dataRoot, project, qaAttemptId), next);
    return next;
  });
}

/** Additive, best-effort linkage set by qa-remediation-preparation.ts once a
 * preparation is created for this (FAILed) attempt. Never changes finalQaStatus. */
export function linkRemediationPreparation(
  dataRoot: string,
  project: string,
  qaAttemptId: string,
  remediationPreparationId: string,
): Promise<QaAttemptRecord> {
  return withQaAttemptLock(dataRoot, project, qaAttemptId, (): QaAttemptRecord => {
    const current = getQaAttempt(dataRoot, project, qaAttemptId);
    if (current.finalQaStatus !== 'FAIL') {
      throw new QaAttemptError('CONFLICT', `QA Attempt ${qaAttemptId}는 FAIL이 아니므로 remediation preparation을 연결할 수 없습니다.`);
    }
    if (current.remediationPreparationId === remediationPreparationId) return current; // idempotent replay
    if (current.remediationPreparationId && current.remediationPreparationId !== remediationPreparationId) {
      throw new QaAttemptError('CONFLICT', `QA Attempt ${qaAttemptId}는 이미 다른 remediation preparation에 연결되어 있습니다.`);
    }
    const ts = nowIso();
    const next: QaAttemptRecord = { ...current, remediationPreparationId, updatedAt: ts };
    persistQaAttemptRecord(qaAttemptFolder(dataRoot, project, qaAttemptId), next);
    return next;
  });
}
