/**
 * V1-G5-A — Structured PM Judgment intake + ACCEPT apply.
 *
 * Relay Core does NOT judge Worker output. The PM Host / GPT decides; Relay
 * only validates the structured judgment, resolves canonical identity from
 * deliveryId, persists judgment intent durably, and applies the canonical
 * action for the slice it owns:
 *   ACCEPT  → canonical acceptTaskResult()
 *   CHANGES → validate + durably record intent ONLY (G5-B prepares retry)
 *
 * Identity comes ONLY from deliveryId. No caller-supplied taskId/runId/
 * goalId/path/command is accepted. Reason/retryInstruction are data —
 * never executed, never used as paths or commands.
 *
 * Durability: one judgment intent per deliveryId
 *   {dataRoot}/{project}/_relay/pm-judgments/{judgmentId}/judgment.json
 * plus immutable intent.json for CHANGES (consumed by G5-B).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic, getTask } from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { getPmDelivery } from './pm-delivery.js';
import { acceptTaskResult } from './task-actions.js';
import { recordPmDecision } from './evidence.js';
import { closeActlManagedReservationForTask } from './actl-bridge.js';
import { recordRuntimeWarning } from './event.js';
import type { TaskRecord } from '../shared/types.js';

/** PM Judgment record schema version. */
export const PM_JUDGMENT_SCHEMA_VERSION = 1;

/** Host protocol version accepted for judgment messages. */
export const PM_JUDGMENT_PROTOCOL_VERSION = 1;

export const PM_JUDGMENT_DECISIONS = ['ACCEPT', 'CHANGES'] as const;
export type PmJudgmentDecision = (typeof PM_JUDGMENT_DECISIONS)[number];

export const PM_JUDGMENT_STATUSES = [
  'RECEIVED',
  'APPLYING',
  'APPLIED',
  'FAILED',
  'REJECTED',
] as const;
export type PmJudgmentStatus = (typeof PM_JUDGMENT_STATUSES)[number];

/** CHANGES reason bounds (canonical minimum 10, cap 1000). */
export const JUDGMENT_REASON_MIN_CHARS = 10;
export const JUDGMENT_REASON_MAX_CHARS = 1000;
/** ACCEPT reason cap (optional, bounded). */
export const JUDGMENT_ACCEPT_REASON_MAX_CHARS = 1000;
/** Retry instruction bounds (required for CHANGES, durable for G5-B). */
export const JUDGMENT_RETRY_INSTRUCTION_MAX_CHARS = 4000;

export interface PmJudgmentInput {
  deliveryId: string;
  decision: PmJudgmentDecision;
  reason?: string;
  retryInstruction?: string;
  /** Transport framing version; required from stdio hosts, optional on MCP. */
  protocolVersion?: unknown;
}

export interface PmJudgmentRecord {
  schemaVersion: number;
  judgmentId: string;
  project: string;
  deliveryId: string;
  taskId: string;
  runId: string;
  decision: PmJudgmentDecision;
  status: PmJudgmentStatus;
  reason?: string;
  /** True when the immutable CHANGES intent payload was committed. */
  retryInstructionPresent: boolean;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  failedAt?: string;
  failureCode?: string;
}

export interface PmJudgmentResult {
  judgment: PmJudgmentRecord;
  /** True when the canonical Task action was applied by this call. */
  applied: boolean;
  /** Task snapshot after apply (ACCEPT) or at resolve time (CHANGES). */
  task: TaskRecord;
}

async function persistDecisionEvidence(
  dataRoot: string,
  project: string,
  result: PmJudgmentResult,
): Promise<PmJudgmentResult> {
  const { judgment, task } = result;
  if (task.taskId === 'unknown' || !judgment.runId || judgment.runId === 'unknown') return result;
  if (judgment.decision !== 'ACCEPT') {
    await closeActlManagedReservationForTask({
      dataRoot, project, task, runId: judgment.runId, disposition: 'FAILED',
    });
    return result;
  }
  if (judgment.status !== 'APPLIED') return result;
  await closeActlManagedReservationForTask({ dataRoot, project, task, runId: judgment.runId });
  try {
    await recordPmDecision(dataRoot, project, {
      verdict: 'ACCEPTED',
      summary: `PM judgment ACCEPT for delivery ${judgment.deliveryId}`,
      reason: judgment.reason,
      goalId: task.goalId,
      taskId: task.taskId,
      runId: judgment.runId,
      targetRunId: judgment.runId,
      source: { kind: 'pm' },
      sourceEventId: `pm-decision:${judgment.judgmentId}`,
    });
  } catch (err) {
    await recordRuntimeWarning(dataRoot, project, {
      summary: `PM_DECISION evidence failed for applied Task ${task.taskId}; judgment remains applied.`,
      taskId: task.taskId,
      runId: judgment.runId,
      goalId: task.goalId,
      source: { kind: 'pm-judgment', subsystem: 'evidence' },
      details: { error: err instanceof Error ? err.message : String(err) },
    }).catch(() => undefined);
  }
  return result;
}

export class PmJudgmentError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: PmJudgmentError['code'], message: string) {
    super(message);
    this.name = 'PmJudgmentError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function pmJudgmentsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'pm-judgments');
}

export function pmJudgmentFolder(dataRoot: string, project: string, judgmentId: string): string {
  return path.join(pmJudgmentsDir(dataRoot, project), judgmentId);
}

function judgmentJsonPath(folder: string): string {
  return path.join(folder, 'judgment.json');
}

function judgmentMdPath(folder: string): string {
  return path.join(folder, 'judgment.md');
}

/**
 * Immutable intent payload path (CHANGES only).
 *
 * intent.json is the ONE immutable PM intent payload per deliveryId. It is
 * written atomically BEFORE judgment.json, so judgment.json acts as the
 * commit marker: an orphan intent.json without judgment.json is recoverable
 * (identical resubmit verifies bytes and completes the commit), and a
 * present judgment.json always implies its intent is durable.
 */
function judgmentIntentPath(folder: string): string {
  return path.join(folder, 'intent.json');
}

/** Immutable CHANGES intent payload (atomic unit; compared on resubmit). */
export interface PmJudgmentIntent {
  schemaVersion: number;
  judgmentId: string;
  deliveryId: string;
  decision: 'CHANGES';
  reason: string;
  retryInstruction: string;
}

/** PM intent payload schema version. */
export const PM_JUDGMENT_INTENT_SCHEMA_VERSION = 1;

function validateJudgmentIntent(raw: unknown): PmJudgmentIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PmJudgmentError('INVALID_STATE', '잘못된 judgment intent 형식입니다.');
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== PM_JUDGMENT_INTENT_SCHEMA_VERSION) {
    throw new PmJudgmentError('INVALID_STATE', `지원하지 않는 intent schemaVersion: ${String(o.schemaVersion)}`);
  }
  if (typeof o.judgmentId !== 'string' || typeof o.deliveryId !== 'string') {
    throw new PmJudgmentError('INVALID_STATE', '잘못된 judgment intent identity.');
  }
  if (o.decision !== 'CHANGES') {
    throw new PmJudgmentError('INVALID_STATE', 'judgment intent decision은 CHANGES여야 합니다.');
  }
  if (typeof o.reason !== 'string' || typeof o.retryInstruction !== 'string') {
    throw new PmJudgmentError('INVALID_STATE', '잘못된 judgment intent payload.');
  }
  return o as unknown as PmJudgmentIntent;
}

/** Read the immutable intent payload, or null when absent/unreadable. */
function readJudgmentIntent(dataRoot: string, project: string, judgmentId: string): PmJudgmentIntent | null {
  if (!JUDGMENT_ID_RE.test(judgmentId)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(judgmentIntentPath(pmJudgmentFolder(dataRoot, project, judgmentId)), 'utf8'));
  } catch {
    return null;
  }
  try {
    return validateJudgmentIntent(raw);
  } catch {
    return null;
  }
}

/**
 * G5-B accessor: exact durable retry instruction bytes for a delivery.
 * Throws NOT_FOUND when no CHANGES intent was committed.
 */
export function getRetryInstructionForDelivery(
  dataRoot: string,
  project: string,
  deliveryId: string,
): string {
  const judgmentId = pmJudgmentIdFor(deliveryId);
  const intent = readJudgmentIntent(dataRoot, project, judgmentId);
  if (!intent || intent.deliveryId !== deliveryId) {
    throw new PmJudgmentError('NOT_FOUND', `Retry instruction을 찾을 수 없습니다: ${deliveryId}`);
  }
  return intent.retryInstruction;
}

// ── locks ────────────────────────────────────────────────────────────────────

const _judgmentLocks = new Map<string, Promise<void>>();

function judgmentLockKey(dataRoot: string, project: string, judgmentId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${judgmentId}`;
}

function withJudgmentLock<T>(dataRoot: string, project: string, judgmentId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = judgmentLockKey(dataRoot, project, judgmentId);
  const prev = _judgmentLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _judgmentLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local judgment chains. */
export function _resetPmJudgmentLocksForTests(): void {
  _judgmentLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const JUDGMENT_ID_RE = /^PMJ-PMD-TASK-\d+-[A-Za-z0-9._-]+$/;

export function pmJudgmentIdFor(deliveryId: string): string {
  const did = requireNonEmptyString(deliveryId, 'deliveryId');
  // Delivery IDs are deterministic PMD-{taskId}-{runId}; the judgment ID
  // derives from them so one delivery maps to at most one judgment intent.
  if (!/^PMD-TASK-\d+-[A-Za-z0-9._-]+$/.test(did)) {
    throw new PmJudgmentError('INVALID_ARGUMENT', `잘못된 deliveryId: ${did}`);
  }
  return `PMJ-${did}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PmJudgmentError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateMessageShape(input: PmJudgmentInput): {
  deliveryId: string;
  decision: PmJudgmentDecision;
  reason?: string;
  retryInstruction?: string;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PmJudgmentError('INVALID_ARGUMENT', 'Judgment must be an object.');
  }
  const allowed = new Set(['deliveryId', 'decision', 'reason', 'retryInstruction', 'protocolVersion', 'type']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new PmJudgmentError('INVALID_ARGUMENT', `허용되지 않은 judgment field: ${key}`);
    }
  }
  if (input.protocolVersion !== undefined && input.protocolVersion !== PM_JUDGMENT_PROTOCOL_VERSION) {
    throw new PmJudgmentError('INVALID_ARGUMENT', `Unsupported protocolVersion: ${String(input.protocolVersion)}`);
  }
  const deliveryId = requireNonEmptyString(input.deliveryId, 'deliveryId');
  pmJudgmentIdFor(deliveryId); // validates deliveryId shape
  if (input.decision !== 'ACCEPT' && input.decision !== 'CHANGES') {
    throw new PmJudgmentError('INVALID_ARGUMENT', `Unsupported decision: ${String(input.decision)}`);
  }
  const decision = input.decision;
  let reason: string | undefined;
  if (input.reason !== undefined) {
    if (typeof input.reason !== 'string' || !input.reason.trim()) {
      throw new PmJudgmentError('INVALID_ARGUMENT', 'reason must be a non-empty string when provided.');
    }
    reason = input.reason.trim();
  }
  let retryInstruction: string | undefined;
  if (input.retryInstruction !== undefined) {
    if (typeof input.retryInstruction !== 'string' || !input.retryInstruction.trim()) {
      throw new PmJudgmentError('INVALID_ARGUMENT', 'retryInstruction must be a non-empty string when provided.');
    }
    retryInstruction = input.retryInstruction.trim();
  }
  if (decision === 'ACCEPT') {
    if (retryInstruction !== undefined) {
      throw new PmJudgmentError('INVALID_ARGUMENT', 'ACCEPT must not carry retryInstruction.');
    }
    if (reason !== undefined && reason.length > JUDGMENT_ACCEPT_REASON_MAX_CHARS) {
      throw new PmJudgmentError('INVALID_ARGUMENT', `ACCEPT reason exceeds ${JUDGMENT_ACCEPT_REASON_MAX_CHARS} chars.`);
    }
  } else {
    if (reason === undefined || reason.length < JUDGMENT_REASON_MIN_CHARS) {
      throw new PmJudgmentError('INVALID_ARGUMENT', `CHANGES reason requires at least ${JUDGMENT_REASON_MIN_CHARS} chars.`);
    }
    if (reason.length > JUDGMENT_REASON_MAX_CHARS) {
      throw new PmJudgmentError('INVALID_ARGUMENT', `CHANGES reason exceeds ${JUDGMENT_REASON_MAX_CHARS} chars.`);
    }
    if (retryInstruction === undefined || retryInstruction.length < 1) {
      throw new PmJudgmentError('INVALID_ARGUMENT', 'CHANGES requires retryInstruction.');
    }
    if (retryInstruction.length > JUDGMENT_RETRY_INSTRUCTION_MAX_CHARS) {
      throw new PmJudgmentError('INVALID_ARGUMENT', `retryInstruction exceeds ${JUDGMENT_RETRY_INSTRUCTION_MAX_CHARS} chars.`);
    }
  }
  return {
    deliveryId,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    ...(retryInstruction !== undefined ? { retryInstruction } : {}),
  };
}

export function validatePmJudgmentRecord(r: PmJudgmentRecord): void {
  if (r.schemaVersion !== PM_JUDGMENT_SCHEMA_VERSION) {
    throw new PmJudgmentError('INVALID_STATE', `지원하지 않는 PM Judgment schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.judgmentId !== 'string' || !JUDGMENT_ID_RE.test(r.judgmentId)) {
    throw new PmJudgmentError('INVALID_STATE', `잘못된 judgmentId: ${String(r.judgmentId)}`);
  }
  if (r.decision !== 'ACCEPT' && r.decision !== 'CHANGES') {
    throw new PmJudgmentError('INVALID_STATE', `알 수 없는 decision: ${String(r.decision)}`);
  }
  if (!(['RECEIVED', 'APPLYING', 'APPLIED', 'FAILED', 'REJECTED'] as readonly string[]).includes(r.status)) {
    throw new PmJudgmentError('INVALID_STATE', `알 수 없는 status: ${String(r.status)}`);
  }
  const expected = pmJudgmentIdFor(r.deliveryId);
  if (r.judgmentId !== expected) {
    throw new PmJudgmentError('INVALID_STATE', `judgmentId 불일치: ${r.judgmentId} ≠ ${expected}`);
  }
}

function renderJudgmentMarkdown(r: PmJudgmentRecord): string {
  return [
    `# ${r.judgmentId}`,
    '',
    '## Identity',
    '',
    `- project: ${r.project}`,
    `- deliveryId: ${r.deliveryId}`,
    `- taskId: ${r.taskId}`,
    `- runId: ${r.runId}`,
    '',
    '## Decision',
    '',
    `- decision: ${r.decision}`,
    `- status: ${r.status}`,
    ...(r.reason ? [`- reason: ${r.reason.slice(0, 500)}`] : []),
    `- retryInstructionPresent: ${r.retryInstructionPresent}`,
    '',
    `createdAt: ${r.createdAt}`,
    `updatedAt: ${r.updatedAt}`,
    '',
  ].join('\n');
}

function persistJudgmentRecord(folder: string, record: PmJudgmentRecord): void {
  validatePmJudgmentRecord(record);
  writeJsonAtomic(judgmentJsonPath(folder), record);
  try {
    fs.writeFileSync(judgmentMdPath(folder), renderJudgmentMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PmJudgmentError('INVALID_STATE', `Judgment JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

function readJudgmentRecord(dataRoot: string, project: string, judgmentId: string): PmJudgmentRecord | null {
  if (!JUDGMENT_ID_RE.test(judgmentId)) return null;
  const file = judgmentJsonPath(pmJudgmentFolder(dataRoot, project, judgmentId));
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const record = raw as PmJudgmentRecord;
    validatePmJudgmentRecord(record);
    return record;
  } catch {
    return null;
  }
}

export function getPmJudgment(dataRoot: string, project: string, judgmentId: string): PmJudgmentRecord {
  const record = readJudgmentRecord(dataRoot, project, judgmentId);
  if (!record) {
    throw new PmJudgmentError('NOT_FOUND', `PM Judgment를 찾을 수 없습니다: ${judgmentId}`);
  }
  return record;
}

/** List all judgment records (malformed siblings skipped deterministically). */
export function listPmJudgments(dataRoot: string, project: string): PmJudgmentRecord[] {
  const dir = pmJudgmentsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: PmJudgmentRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!JUDGMENT_ID_RE.test(name)) continue;
    const record = readJudgmentRecord(dataRoot, project, name);
    if (record) out.push(record);
  }
  out.sort((a, b) => a.judgmentId.localeCompare(b.judgmentId));
  return out;
}

// ── canonical identity resolution ────────────────────────────────────────────

/**
 * Resolve delivery → Task → current attempt and require the verifiable
 * judgment state. Throws PmJudgmentError (CONFLICT) when the delivery is
 * historical or the Task left the judicable state — no mutation in that path.
 */
function resolveJudicable(
  dataRoot: string,
  project: string,
  deliveryId: string,
): { task: TaskRecord; runId: string } {
  let delivery;
  try {
    delivery = getPmDelivery(dataRoot, project, deliveryId);
  } catch {
    throw new PmJudgmentError('NOT_FOUND', `PM Delivery를 찾을 수 없습니다: ${deliveryId}`);
  }
  if (delivery.kind !== 'TASK_VERIFY') {
    throw new PmJudgmentError('CONFLICT', `TASK_VERIFY delivery가 아닙니다: ${deliveryId}`);
  }
  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, delivery.taskId);
  } catch {
    throw new PmJudgmentError('CONFLICT', `Delivery Task을 찾을 수 없습니다: ${delivery.taskId}`);
  }
  if (!task.linkedRuns.some((r) => r.runId === delivery.runId)) {
    throw new PmJudgmentError('CONFLICT', `Delivery Run ${delivery.runId} is no longer linked to Task ${task.taskId}.`);
  }
  const current = resolveCurrentAttemptRunId(task);
  if (current !== delivery.runId) {
    throw new PmJudgmentError(
      'CONFLICT',
      `Delivery refers to a displaced historical attempt (delivery runId=${delivery.runId}, current=${current ?? 'none'}).`,
    );
  }
  if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'VERIFYING') {
    throw new PmJudgmentError(
      'CONFLICT',
      `Task ${task.taskId} is ${task.executionState}+${task.pmState}, not RESULT_RECEIVED+VERIFYING.`,
    );
  }
  return { task, runId: delivery.runId };
}

// ── intake ───────────────────────────────────────────────────────────────────

/**
 * Compare an incoming CHANGES payload against the immutable committed intent.
 * Legacy pre-correction retry-instruction.md companions (no intent.json) are
 * honored read-only for byte equality so old dev/test data never poisons a
 * resubmit; new code never writes the legacy file.
 */
function changesPayloadMatches(
  dataRoot: string,
  project: string,
  judgmentId: string,
  reason: string | undefined,
  retryInstruction: string | undefined,
  storedReason: string | undefined,
): boolean {
  if (storedReason !== reason) return false;
  const intent = readJudgmentIntent(dataRoot, project, judgmentId);
  if (intent) return intent.retryInstruction === retryInstruction;
  if (retryInstruction === undefined) return true;
  try {
    const legacy = fs.readFileSync(
      path.join(pmJudgmentFolder(dataRoot, project, judgmentId), 'retry-instruction.md'),
      'utf8',
    );
    return legacy === retryInstruction;
  } catch {
    return false;
  }
}

/**
 * Commit (or verify-then-commit) the immutable CHANGES intent payload.
 *
 * Crash-safe order: intent.json is written atomically FIRST; judgment.json
 * is the commit marker written only after intent durability succeeds.
 *   - no intent.json → write it (atomic), then commit judgment.json
 *   - intent.json present + byte-identical payload → commit judgment.json
 *   - intent.json present + different payload → CONFLICT (never overwrite)
 */
function commitChangesIntent(
  dataRoot: string,
  project: string,
  folder: string,
  judgmentId: string,
  deliveryId: string,
  reason: string,
  retryInstruction: string,
): void {
  fs.mkdirSync(folder, { recursive: true });
  const present = readJudgmentIntent(dataRoot, project, judgmentId);
  if (present) {
    if (
      present.deliveryId !== deliveryId
      || present.decision !== 'CHANGES'
      || present.reason !== reason
      || present.retryInstruction !== retryInstruction
    ) {
      throw new PmJudgmentError('CONFLICT', `Delivery ${deliveryId} already has a different retry instruction.`);
    }
    return;
  }
  writeJsonAtomic(path.join(folder, 'intent.json'), {
    schemaVersion: PM_JUDGMENT_INTENT_SCHEMA_VERSION,
    judgmentId,
    deliveryId,
    decision: 'CHANGES',
    reason,
    retryInstruction,
  } satisfies PmJudgmentIntent);
}

/**
 * Submit a structured PM judgment for one TASK_VERIFY delivery.
 *
 * ACCEPT  → persists intent, applies canonical acceptTaskResult, APPLIED.
 * CHANGES → validates + commits immutable intent (intent.json FIRST, then
 *           judgment.json as the marker), leaves the Task untouched (G5-B
 *           prepares retry). Returns RECORDED.
 *
 * Same delivery + same decision + same payload → existing record (idempotent;
 * APPLIED replays as applied). Same delivery + different decision/payload →
 * CONFLICT. Stale/wrong-state deliveries → stable REJECTED, no Task mutation.
 */
export function submitPmJudgment(
  dataRoot: string,
  project: string,
  input: PmJudgmentInput,
): Promise<PmJudgmentResult> {
  const { deliveryId, decision, reason, retryInstruction } = validateMessageShape(input);
  const judgmentId = pmJudgmentIdFor(deliveryId);

  return withJudgmentLock(dataRoot, project, judgmentId, async (): Promise<PmJudgmentResult> => {
    const folder = pmJudgmentFolder(dataRoot, project, judgmentId);
    const existing = readJudgmentRecord(dataRoot, project, judgmentId);
    if (existing) {
      const payloadSame = existing.decision === decision
        && (decision === 'ACCEPT'
          ? (existing.reason ?? undefined) === reason
          : changesPayloadMatches(dataRoot, project, judgmentId, reason, retryInstruction, existing.reason ?? undefined));
      if (!payloadSame) {
        throw new PmJudgmentError('CONFLICT', `Delivery ${deliveryId} already has a different PM judgment intent.`);
      }
      // Idempotent replay of the identical judgment.
      if (existing.status === 'APPLIED') {
        return persistDecisionEvidence(dataRoot, project, { judgment: existing, applied: false, task: getTask(dataRoot, project, existing.taskId) });
      }
      if (existing.status === 'REJECTED' || existing.status === 'FAILED') {
        return persistDecisionEvidence(dataRoot, project, { judgment: existing, applied: false, task: getTask(dataRoot, project, existing.taskId) });
      }
      if (decision === 'ACCEPT') {
        // RECEIVED or APPLYING: (re)run apply — reconciles an already
        // ACCEPTED same run idempotently (crash between persist and apply).
        return resumeAcceptApply(dataRoot, project, folder, existing).then(result => persistDecisionEvidence(dataRoot, project, result));
      }
      // CHANGES RECEIVED: intent already durable; nothing further in G5-A.
      return persistDecisionEvidence(dataRoot, project, { judgment: existing, applied: false, task: getTask(dataRoot, project, existing.taskId) });
    }

    // Fresh intake: resolve identity BEFORE persisting any intent.
    // Stale/wrong-state deliveries persist a stable REJECTED record (no Task
    // mutation) so identical re-submits replay deterministically.
    let resolved: { task: TaskRecord; runId: string };
    try {
      resolved = resolveJudicable(dataRoot, project, deliveryId);
    } catch (err) {
      if (err instanceof PmJudgmentError && err.code === 'CONFLICT') {
        persistRejected(dataRoot, project, deliveryId, decision, 'STALE_OR_WRONG_STATE');
      }
      throw err;
    }

    const ts = nowIso();
    if (decision === 'CHANGES') {
      // Crash-safe commit order: immutable intent FIRST (atomic), then
      // judgment.json as the commit marker. An orphan intent.json without
      // judgment.json (crash between the two writes) is verified byte-equal
      // here and the commit completes; differing payload → CONFLICT.
      commitChangesIntent(dataRoot, project, folder, judgmentId, deliveryId, reason!, retryInstruction!);
      const record: PmJudgmentRecord = {
        schemaVersion: PM_JUDGMENT_SCHEMA_VERSION,
        judgmentId,
        project,
        deliveryId,
        taskId: resolved.task.taskId,
        runId: resolved.runId,
        decision,
        status: 'RECEIVED',
        ...(reason !== undefined ? { reason } : {}),
        retryInstructionPresent: true,
        createdAt: ts,
        updatedAt: ts,
      };
      persistJudgmentRecord(folder, record);
      return persistDecisionEvidence(dataRoot, project, { judgment: record, applied: false, task: resolved.task });
    }

    // ACCEPT: RECEIVED → APPLYING → canonical apply → APPLIED.
    fs.mkdirSync(folder, { recursive: true });
    let record: PmJudgmentRecord = {
      schemaVersion: PM_JUDGMENT_SCHEMA_VERSION,
      judgmentId,
      project,
      deliveryId,
      taskId: resolved.task.taskId,
      runId: resolved.runId,
      decision,
      status: 'RECEIVED',
      ...(reason !== undefined ? { reason } : {}),
      retryInstructionPresent: false,
      createdAt: ts,
      updatedAt: ts,
    };
    persistJudgmentRecord(folder, record);
    record = { ...record, status: 'APPLYING', updatedAt: nowIso() };
    persistJudgmentRecord(folder, record);
    return applyAccept(dataRoot, project, folder, record).then(result => persistDecisionEvidence(dataRoot, project, result));
  });
}

/**
 * Persist a stable REJECTED record for a non-judicable delivery (no Task
 * mutation). Returns the existing record when one is already present, so
 * identical stale re-submits replay the same rejection.
 */
function persistRejected(
  dataRoot: string,
  project: string,
  deliveryId: string,
  decision: PmJudgmentDecision,
  failureCode: string,
): PmJudgmentRecord {
  const judgmentId = pmJudgmentIdFor(deliveryId);
  const folder = pmJudgmentFolder(dataRoot, project, judgmentId);
  fs.mkdirSync(folder, { recursive: true });
  const existing = readJudgmentRecord(dataRoot, project, judgmentId);
  if (existing) return existing;
  let taskId = 'unknown';
  let runId = 'unknown';
  try {
    const delivery = getPmDelivery(dataRoot, project, deliveryId);
    taskId = delivery.taskId;
    runId = delivery.runId;
  } catch { /* keep placeholders */ }
  const ts = nowIso();
  const record: PmJudgmentRecord = {
    schemaVersion: PM_JUDGMENT_SCHEMA_VERSION,
    judgmentId,
    project,
    deliveryId,
    taskId,
    runId,
    decision,
    status: 'REJECTED',
    retryInstructionPresent: false,
    createdAt: ts,
    updatedAt: ts,
    failedAt: ts,
    failureCode,
  };
  persistJudgmentRecord(folder, record);
  return record;
}

async function applyAccept(
  dataRoot: string,
  project: string,
  folder: string,
  record: PmJudgmentRecord,
): Promise<PmJudgmentResult> {
  // Re-resolve inside apply: the Task may have moved since intake.
  let task: TaskRecord;
  try {
    task = getTask(dataRoot, project, record.taskId);
  } catch (err) {
    return failRecord(dataRoot, project, folder, record, err);
  }
  // Idempotent reconcile: already ACCEPTED for the same run → APPLIED.
  if (task.pmState === 'ACCEPTED' && task.acceptedRunId === record.runId) {
    const done: PmJudgmentRecord = { ...record, status: 'APPLIED', updatedAt: nowIso(), appliedAt: nowIso() };
    persistJudgmentRecord(folder, done);
    return { judgment: done, applied: false, task };
  }
  let after: TaskRecord;
  try {
    // Canonical path ONLY (PM_MCP surface: judgment actions allowed in PLAN).
    after = await acceptTaskResult({
      dataRoot,
      project,
      goalId: task.goalId,
      taskId: record.taskId,
      runId: record.runId,
      expectedExecutionState: 'RESULT_RECEIVED',
      expectedPmState: 'VERIFYING',
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      callerSurface: 'PM_MCP',
    });
  } catch (err) {
    return failRecord(dataRoot, project, folder, record, err);
  }
  const done: PmJudgmentRecord = { ...record, status: 'APPLIED', updatedAt: nowIso(), appliedAt: nowIso() };
  persistJudgmentRecord(folder, done);
  return { judgment: done, applied: true, task: after };
}

/**
 * Canonical CHANGES lifecycle advance (V1-G5-B only).
 *
 * Moves a RECEIVED CHANGES judgment to APPLIED once retry preparation
 * reached READY. Idempotent when already APPLIED. Rejects ACCEPT judgments
 * (their APPLIED transition belongs to the apply flow) and any other state.
 * This is the ONLY sanctioned writer of judgment lifecycle outside intake.
 */
export function markJudgmentApplied(
  dataRoot: string,
  project: string,
  judgmentId: string,
): Promise<PmJudgmentRecord> {
  if (!JUDGMENT_ID_RE.test(judgmentId)) {
    throw new PmJudgmentError('INVALID_ARGUMENT', `잘못된 judgmentId: ${judgmentId}`);
  }
  return withJudgmentLock(dataRoot, project, judgmentId, (): PmJudgmentRecord => {
    const current = readJudgmentRecord(dataRoot, project, judgmentId);
    if (!current) {
      throw new PmJudgmentError('NOT_FOUND', `PM Judgment를 찾을 수 없습니다: ${judgmentId}`);
    }
    if (current.decision !== 'CHANGES') {
      throw new PmJudgmentError('INVALID_STATE', 'markJudgmentApplied applies to CHANGES judgments only.');
    }
    if (current.status === 'APPLIED') return current;
    if (current.status !== 'RECEIVED') {
      throw new PmJudgmentError('CONFLICT', `Judgment ${judgmentId} is ${current.status}, not RECEIVED.`);
    }
    const done: PmJudgmentRecord = { ...current, status: 'APPLIED', updatedAt: nowIso(), appliedAt: nowIso() };
    persistJudgmentRecord(pmJudgmentFolder(dataRoot, project, judgmentId), done);
    return done;
  });
}

async function resumeAcceptApply(  dataRoot: string,
  project: string,
  folder: string,
  record: PmJudgmentRecord,
): Promise<PmJudgmentResult> {
  // Possible crash between RECEIVED and apply completion: re-run apply,
  // which reconciles an already-ACCEPTED same run idempotently.
  return applyAccept(dataRoot, project, folder, record);
}

async function failRecord(
  _dataRoot: string,
  _project: string,
  folder: string,
  record: PmJudgmentRecord,
  err: unknown,
): Promise<PmJudgmentResult> {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? 'APPLY_FAILED';
  const failed: PmJudgmentRecord = {
    ...record,
    status: 'FAILED',
    updatedAt: nowIso(),
    failedAt: nowIso(),
    failureCode: String(code),
  };
  persistJudgmentRecord(folder, failed);
  throw new PmJudgmentError('INVALID_STATE', `ACCEPT apply failed: ${msg}`);
}
