/**
 * V1-G6-MCP — Durable PM Wake record kernel (additive).
 *
 * The MCP App widget is a NEW PM Wake Adapter: it observes pending PM
 * Deliveries and wakes GPT PM via ui/message. It must NEVER wake the same
 * delivery repeatedly without bound, and a restart must never lose an
 * undelivered PM obligation.
 *
 * PM Delivery semantics are frozen (pm-delivery.ts owns the obligation +
 * terminal states). This module adds ONLY an additive per-delivery wake
 * bookkeeping record so "wake attempt" is distinguishable from the canonical
 * delivery lifecycle. It NEVER marks a delivery DELIVERED/ACKNOWLEDGED — that
 * remains the receipt/judgment path's job. A delivery may be fully wake-SENT
 * while still PENDING in pm-deliveries (GPT has been woken but has not yet
 * judged); the obligation is preserved.
 *
 * Storage:
 *   {dataRoot}/{project}/_relay/pm-wakes/{deliveryId}/wake.json
 *
 * Claim semantics (the dedupe gate):
 *   - delivery must exist and be actionable (PENDING or DELIVERED)
 *   - wake record starts PENDING
 *   - claim on PENDING        → mark SENT, attemptCount++ , claimable=true
 *   - claim on SENT           → claimable=false (ALREADY_SENT: never re-wake)
 *   - claim on FAILED         → reset to PENDING then claim (explicit recovery)
 *   - attemptCount >= MAX     → claimable=false (MAX_ATTEMPTS: bounded)
 *
 * The wake instruction is FROZEN and identity-based only: deliveryId,
 * project, taskId + the exact instruction to fetch context and submit one
 * judgment. No Result text, no transcript, no evidence payload, no secrets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic } from './goal-task.js';
import { getPmDelivery } from './pm-delivery.js';
import type { PmDeliveryRecord } from './pm-delivery.js';

/** PM Wake record schema version. */
export const PM_WAKE_SCHEMA_VERSION = 1;

export const PM_WAKE_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type PmWakeStatus = (typeof PM_WAKE_STATUSES)[number];

/** Upper bound on automatic wake attempts per delivery (never unbounded). */
export const MAX_WAKE_ATTEMPTS = 5;

export interface PmWakeRecord {
  schemaVersion: number;
  deliveryId: string;
  project: string;
  taskId: string;
  status: PmWakeStatus;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastAttemptAt?: string;
  sentAt?: string;
  failedAt?: string;
  failureReason?: string;
}

export interface ClaimPmWakeResult {
  claimable: boolean;
  reason?: 'ALREADY_SENT' | 'MAX_ATTEMPTS' | 'NOT_ACTIONABLE';
  record: PmWakeRecord;
  instruction?: string;
}

export class PmWakeError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: PmWakeError['code'], message: string) {
    super(message);
    this.name = 'PmWakeError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function pmWakesDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'pm-wakes');
}

export function pmWakeFolder(dataRoot: string, project: string, deliveryId: string): string {
  return path.join(pmWakesDir(dataRoot, project), deliveryId);
}

function wakeJsonPath(folder: string): string {
  return path.join(folder, 'wake.json');
}

// ── locks ────────────────────────────────────────────────────────────────────

const _wakeLocks = new Map<string, Promise<void>>();

function wakeLockKey(dataRoot: string, project: string, deliveryId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${deliveryId}`;
}

function withWakeLock<T>(dataRoot: string, project: string, deliveryId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = wakeLockKey(dataRoot, project, deliveryId);
  const prev = _wakeLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _wakeLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local wake chains. */
export function _resetPmWakeLocksForTests(): void {
  _wakeLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const DELIVERY_ID_RE = /^PMD-TASK-\d+-[A-Za-z0-9._-]+$/;

function requireDeliveryId(value: unknown): string {
  if (typeof value !== 'string' || !DELIVERY_ID_RE.test(value)) {
    throw new PmWakeError('INVALID_ARGUMENT', `잘못된 deliveryId: ${String(value)}`);
  }
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateWakeRecord(r: PmWakeRecord): void {
  if (r.schemaVersion !== PM_WAKE_SCHEMA_VERSION) {
    throw new PmWakeError('INVALID_STATE', `지원하지 않는 PM Wake schemaVersion: ${r.schemaVersion}`);
  }
  requireDeliveryId(r.deliveryId);
  if (!r.project || typeof r.project !== 'string') {
    throw new PmWakeError('INVALID_STATE', 'PM Wake project가 필요합니다.');
  }
  if (!r.taskId || typeof r.taskId !== 'string') {
    throw new PmWakeError('INVALID_STATE', 'PM Wake taskId가 필요합니다.');
  }
  if (!['PENDING', 'SENT', 'FAILED'].includes(r.status)) {
    throw new PmWakeError('INVALID_STATE', `알 수 없는 wake status: ${String(r.status)}`);
  }
  if (!Number.isInteger(r.attemptCount) || r.attemptCount < 0) {
    throw new PmWakeError('INVALID_STATE', 'PM Wake attemptCount가 잘못되었습니다.');
  }
}

function readWakeRecord(dataRoot: string, project: string, deliveryId: string): PmWakeRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(wakeJsonPath(pmWakeFolder(dataRoot, project, deliveryId)), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const record = raw as PmWakeRecord;
    validateWakeRecord(record);
    if (record.deliveryId !== deliveryId) return null;
    return record;
  } catch {
    return null;
  }
}

function persistWakeRecord(folder: string, record: PmWakeRecord): void {
  validateWakeRecord(record);
  writeJsonAtomic(wakeJsonPath(folder), record);
}

export function getPmWake(dataRoot: string, project: string, deliveryId: string): PmWakeRecord | null {
  return readWakeRecord(dataRoot, project, requireDeliveryId(deliveryId));
}

// ── frozen wake instruction ──────────────────────────────────────────────────

/**
 * Machine-readable wake instruction. Identity-based only: deliveryId /
 * project / taskId + the exact instruction to fetch context and submit one
 * judgment. MUST NOT contain Result text, transcripts, evidence, or secrets.
 */
export function buildWakeInstruction(delivery: Pick<PmDeliveryRecord, 'deliveryId' | 'taskId'>, project: string): string {
  return [
    'AGENT_RELAY_PM_WAKE',
    `deliveryId=${delivery.deliveryId}`,
    `project=${project}`,
    `taskId=${delivery.taskId}`,
    '',
    'Instruction:',
    'Fetch the verification context for this delivery using the Agent Relay MCP app.',
    'Review the actual Result and Evidence.',
    'Then submit exactly one judgment:',
    'ACCEPT',
    'or',
    'CHANGES with reason and retryInstruction.',
  ].join('\n');
}

// ── claim / fail ─────────────────────────────────────────────────────────────

/**
 * Atomically claim one wake for an actionable delivery. Dedupe gate for the
 * widget: a SENT wake is never re-claimed (ALREADY_SENT); a FAILED wake may
 * be retried after the widget reports ui/message failure; attemptCount is
 * bounded by MAX_WAKE_ATTEMPTS.
 */
export function claimPmWake(
  dataRoot: string,
  project: string,
  deliveryId: string,
): Promise<ClaimPmWakeResult> {
  const did = requireDeliveryId(deliveryId);
  return withWakeLock(dataRoot, project, did, (): ClaimPmWakeResult => {
    let delivery: PmDeliveryRecord;
    try {
      delivery = getPmDelivery(dataRoot, project, did);
    } catch {
      throw new PmWakeError('NOT_FOUND', `PM Delivery를 찾을 수 없습니다: ${did}`);
    }
    if (delivery.status !== 'PENDING' && delivery.status !== 'DELIVERED') {
      return {
        claimable: false,
        reason: 'NOT_ACTIONABLE',
        record: readWakeRecord(dataRoot, project, did) ?? {
          schemaVersion: PM_WAKE_SCHEMA_VERSION,
          deliveryId: did,
          project,
          taskId: delivery.taskId,
          status: 'PENDING',
          attemptCount: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      };
    }

    const folder = pmWakeFolder(dataRoot, project, did);
    let record = readWakeRecord(dataRoot, project, did);
    if (!record) {
      const ts = nowIso();
      record = {
        schemaVersion: PM_WAKE_SCHEMA_VERSION,
        deliveryId: did,
        project,
        taskId: delivery.taskId,
        status: 'PENDING',
        attemptCount: 0,
        createdAt: ts,
        updatedAt: ts,
      };
      fs.mkdirSync(folder, { recursive: true });
      persistWakeRecord(folder, record);
    } else if (record.taskId !== delivery.taskId || record.project !== project) {
      throw new PmWakeError('INVALID_STATE', `PM Wake identity mismatch for ${did}.`);
    }

    if (record.status === 'SENT') {
      return { claimable: false, reason: 'ALREADY_SENT', record };
    }
    if (record.attemptCount >= MAX_WAKE_ATTEMPTS) {
      return { claimable: false, reason: 'MAX_ATTEMPTS', record };
    }
    // FAILED → explicit recovery: reset to PENDING and re-claim below.
    const ts = nowIso();
    const next: PmWakeRecord = {
      ...record,
      status: 'SENT',
      attemptCount: record.attemptCount + 1,
      updatedAt: ts,
      lastAttemptAt: ts,
      sentAt: ts,
      failedAt: undefined,
      failureReason: undefined,
    };
    persistWakeRecord(folder, next);
    return {
      claimable: true,
      record: next,
      instruction: buildWakeInstruction(delivery, project),
    };
  });
}

/**
 * Widget reports the ui/message attempt failed (e.g. host rejected it).
 * Marks FAILED so a future mount/retry may re-claim (bounded by attempts).
 * Never touches the PM Delivery record.
 */
export function markPmWakeFailed(
  dataRoot: string,
  project: string,
  deliveryId: string,
  reason: string,
): Promise<PmWakeRecord> {
  const did = requireDeliveryId(deliveryId);
  return withWakeLock(dataRoot, project, did, (): PmWakeRecord => {
    const record = readWakeRecord(dataRoot, project, did);
    if (!record) {
      throw new PmWakeError('NOT_FOUND', `PM Wake를 찾을 수 없습니다: ${did}`);
    }
    const ts = nowIso();
    const next: PmWakeRecord = {
      ...record,
      status: 'FAILED',
      updatedAt: ts,
      failedAt: ts,
      failureReason: typeof reason === 'string' && reason ? reason.slice(0, 500) : 'unknown',
    };
    persistWakeRecord(pmWakeFolder(dataRoot, project, did), next);
    return next;
  });
}