/**
 * V1-G4-A — Durable PM Delivery kernel.
 *
 * Keeps three concepts distinct:
 *   Event      = immutable runtime fact/history (event.ts owns delivery of Events)
 *   PM Work    = derived actionable state (pm-work.ts, pure read, no writes)
 *   PM Delivery = persisted communication obligation to a PM Host (this file)
 *
 * A PM Delivery is identity/state ONLY. It never carries result text, prompt
 * text, secrets, environment, Task dumps, workspace paths, or transcripts.
 * Verification context belongs to G4-B.
 *
 * Canonical trigger (TASK_VERIFY derived state):
 *   Task.executionState === 'RESULT_RECEIVED'
 *   Task.pmState === 'VERIFYING'
 *   resolveCurrentAttemptRunId(task) exists
 *
 * Canonical identity: project + taskId + currentRunId + kind='TASK_VERIFY'.
 * At most ONE durable delivery per Task attempt: the deliveryId is
 * deterministic (`PMD-{taskId}-{runId}`), so concurrent mints collapse to one
 * record via exclusive mkdir. Terminal states are never reset by ensure/
 * reconcile. A later retry (new runId) mints a NEW delivery; historical runs
 * can never mint.
 *
 * Storage: {dataRoot}/{project}/_relay/pm-deliveries/{deliveryId}/
 *   delivery.json (SSOT) + delivery.md (human mirror).
 * Atomic JSON writes; per-delivery process-local serialization for mutations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  relayDir,
  writeJsonAtomic,
  getTask,
  listTasks,
} from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';

/** PM Delivery record schema version (starts at 1). */
export const PM_DELIVERY_SCHEMA_VERSION = 1;

/** PM Delivery lifecycle statuses — narrow, terminal ends. */
export const PM_DELIVERY_STATUSES = [
  'PENDING',
  'DELIVERED',
  'ACKNOWLEDGED',
  'IGNORED',
] as const;
export type PmDeliveryStatus = (typeof PM_DELIVERY_STATUSES)[number];

/** V1 delivery kind — fixed vocabulary (single kind for G4-A). */
export const PM_DELIVERY_KINDS = ['TASK_VERIFY'] as const;
export type PmDeliveryKind = (typeof PM_DELIVERY_KINDS)[number];

export interface PmDeliverySource {
  kind: 'pm-work';
  workKind: 'TASK_VERIFY';
}

export interface PmDeliveryRecord {
  schemaVersion: number;
  deliveryId: string;
  project: string;
  kind: PmDeliveryKind;
  taskId: string;
  runId: string;
  status: PmDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  ignoredAt?: string;
  source: PmDeliverySource;
}

export class PmDeliveryError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: PmDeliveryError['code'], message: string) {
    super(message);
    this.name = 'PmDeliveryError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function pmDeliveriesDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'pm-deliveries');
}

export function pmDeliveryFolder(dataRoot: string, project: string, deliveryId: string): string {
  return path.join(pmDeliveriesDir(dataRoot, project), deliveryId);
}

function deliveryJsonPath(folder: string): string {
  return path.join(folder, 'delivery.json');
}

function deliveryMdPath(folder: string): string {
  return path.join(folder, 'delivery.md');
}

// ── locks ────────────────────────────────────────────────────────────────────

/**
 * Per-delivery process-local serialization for mint/mutation.
 * Key includes resolved dataRoot so distinct dataRoots never share a chain.
 */
const _deliveryLocks = new Map<string, Promise<void>>();

function deliveryLockKey(dataRoot: string, project: string, deliveryId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${deliveryId}`;
}

function withDeliveryLock<T>(dataRoot: string, project: string, deliveryId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = deliveryLockKey(dataRoot, project, deliveryId);
  const prev = _deliveryLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _deliveryLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/** Test-only reset for the process-local delivery chains. */
export function _resetPmDeliveryLocksForTests(): void {
  _deliveryLocks.clear();
}

// ── identity / validation ────────────────────────────────────────────────────

const TASK_ID_RE = /^TASK-(\d+)$/;
const DELIVERY_ID_RE = /^PMD-TASK-\d+-[A-Za-z0-9._-]+$/;

export function pmDeliveryIdFor(taskId: string, runId: string): string {
  const tid = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  if (!TASK_ID_RE.test(tid)) {
    throw new PmDeliveryError('INVALID_ARGUMENT', `잘못된 Task ID: ${tid}`);
  }
  if (/[/\\]/.test(rid) || rid === '.' || rid === '..') {
    throw new PmDeliveryError('INVALID_ARGUMENT', `잘못된 runId: ${rid}`);
  }
  return `PMD-${tid}-${rid}`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PmDeliveryError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isPmDeliveryStatus(v: unknown): v is PmDeliveryStatus {
  return typeof v === 'string' && (PM_DELIVERY_STATUSES as readonly string[]).includes(v);
}

export function validatePmDeliveryRecord(r: PmDeliveryRecord): void {
  if (r.schemaVersion !== PM_DELIVERY_SCHEMA_VERSION) {
    throw new PmDeliveryError('INVALID_STATE', `지원하지 않는 PM Delivery schemaVersion: ${r.schemaVersion}`);
  }
  if (typeof r.deliveryId !== 'string' || !DELIVERY_ID_RE.test(r.deliveryId)) {
    throw new PmDeliveryError('INVALID_STATE', `잘못된 deliveryId: ${String(r.deliveryId)}`);
  }
  if (!r.project || typeof r.project !== 'string') {
    throw new PmDeliveryError('INVALID_STATE', 'PM Delivery project가 필요합니다.');
  }
  if (r.kind !== 'TASK_VERIFY') {
    throw new PmDeliveryError('INVALID_STATE', `알 수 없는 PM Delivery kind: ${String(r.kind)}`);
  }
  if (!TASK_ID_RE.test(r.taskId)) {
    throw new PmDeliveryError('INVALID_STATE', `잘못된 Task ID: ${r.taskId}`);
  }
  if (!r.runId || typeof r.runId !== 'string') {
    throw new PmDeliveryError('INVALID_STATE', 'PM Delivery runId가 필요합니다.');
  }
  if (!isPmDeliveryStatus(r.status)) {
    throw new PmDeliveryError('INVALID_STATE', `알 수 없는 PM Delivery status: ${String(r.status)}`);
  }
  const expected = pmDeliveryIdFor(r.taskId, r.runId);
  if (r.deliveryId !== expected) {
    throw new PmDeliveryError('INVALID_STATE', `deliveryId 불일치: ${r.deliveryId} ≠ ${expected}`);
  }
  if (!r.source || r.source.kind !== 'pm-work' || r.source.workKind !== 'TASK_VERIFY') {
    throw new PmDeliveryError('INVALID_STATE', 'PM Delivery source는 pm-work/TASK_VERIFY여야 합니다.');
  }
}

function renderDeliveryMarkdown(r: PmDeliveryRecord): string {
  return [
    `# ${r.deliveryId}`,
    '',
    '## Identity',
    '',
    `- project: ${r.project}`,
    `- kind: ${r.kind}`,
    `- taskId: ${r.taskId}`,
    `- runId: ${r.runId}`,
    '',
    '## Status',
    '',
    r.status,
    '',
    '## Source',
    '',
    `- kind: ${r.source.kind}`,
    `- workKind: ${r.source.workKind}`,
    '',
    `createdAt: ${r.createdAt}`,
    `updatedAt: ${r.updatedAt}`,
    '',
  ].join('\n');
}

function persistDeliveryRecord(folder: string, record: PmDeliveryRecord): void {
  validatePmDeliveryRecord(record);
  writeJsonAtomic(deliveryJsonPath(folder), record);
  try {
    fs.writeFileSync(deliveryMdPath(folder), renderDeliveryMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PmDeliveryError('INVALID_STATE', `Delivery JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

function readDeliveryRecord(dataRoot: string, project: string, deliveryId: string): PmDeliveryRecord {
  const id = requireNonEmptyString(deliveryId, 'deliveryId');
  if (!DELIVERY_ID_RE.test(id)) {
    throw new PmDeliveryError('INVALID_ARGUMENT', `잘못된 deliveryId: ${id}`);
  }
  const file = deliveryJsonPath(pmDeliveryFolder(dataRoot, project, id));
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new PmDeliveryError('NOT_FOUND', `PM Delivery를 찾을 수 없습니다: ${id}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PmDeliveryError('INVALID_STATE', `잘못된 PM Delivery 형식입니다: ${id}`);
  }
  const record = raw as PmDeliveryRecord;
  validatePmDeliveryRecord(record);
  return record;
}

// ── reads ────────────────────────────────────────────────────────────────────

export function getPmDelivery(dataRoot: string, project: string, deliveryId: string): PmDeliveryRecord {
  return readDeliveryRecord(dataRoot, project, deliveryId);
}

/** List all PM Delivery records (malformed siblings skipped deterministically). */
export function listPmDeliveries(dataRoot: string, project: string): PmDeliveryRecord[] {
  const dir = pmDeliveriesDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: PmDeliveryRecord[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!DELIVERY_ID_RE.test(name)) continue;
    try {
      out.push(readDeliveryRecord(dataRoot, project, name));
    } catch {
      // Skip malformed entries deterministically (do not fail the whole list).
    }
  }
  out.sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
  return out;
}

/**
 * Host-consumable queue: non-terminal deliveries (PENDING or DELIVERED awaiting
 * ACK). Terminal ACKNOWLEDGED/IGNORED never resurface here.
 */
export function listPendingPmDeliveries(dataRoot: string, project: string): PmDeliveryRecord[] {
  return listPmDeliveries(dataRoot, project).filter(
    (r) => r.status === 'PENDING' || r.status === 'DELIVERED',
  );
}

/** Reconcile Delivery consumption from already-final Task truth. */
export async function reconcileFinalizedPmDeliveries(
  dataRoot: string,
  project: string,
): Promise<{ acknowledged: string[]; ignored: string[] }> {
  const acknowledged: string[] = [];
  const ignored: string[] = [];
  for (const delivery of listPendingPmDeliveries(dataRoot, project)) {
    let task;
    try {
      task = getTask(dataRoot, project, delivery.taskId);
    } catch {
      continue;
    }
    const finalized = task.pmState === 'ACCEPTED' && task.acceptedRunId === delivery.runId;
    const currentRunId = resolveCurrentAttemptRunId(task);
    if (!finalized && currentRunId === delivery.runId) continue;
    const target = finalized ? 'ACKNOWLEDGED' : 'IGNORED';
    try {
      if (delivery.status === 'PENDING') {
        await markPmDeliveryDelivered(dataRoot, project, delivery.deliveryId, 'PENDING');
      }
      if (finalized) {
        await acknowledgePmDelivery(dataRoot, project, delivery.deliveryId, 'DELIVERED');
        acknowledged.push(delivery.deliveryId);
      } else {
        await ignorePmDelivery(dataRoot, project, delivery.deliveryId, 'DELIVERED');
        ignored.push(delivery.deliveryId);
      }
    } catch (err) {
      if (!(err instanceof PmDeliveryError) || err.code !== 'CONFLICT') throw err;
      const latest = readDeliveryRecord(dataRoot, project, delivery.deliveryId);
      if (latest.status === target) (finalized ? acknowledged : ignored).push(delivery.deliveryId);
    }
  }
  return { acknowledged, ignored };
}

// ── mint / reconcile ─────────────────────────────────────────────────────────

/**
 * Canonical ensure: mint the TASK_VERIFY delivery for a Task's CURRENT attempt
 * when (and only when) the Task is RESULT_RECEIVED + VERIFYING.
 *
 * Idempotent: same attempt → same record (exclusive mkdir collapse); terminal
 * records are never reset. Returns null when the trigger state is absent
 * (no mint for ACCEPTED/CHANGES_REQUESTED/stale/terminal/non-READY states).
 * Historical runs can never mint: runId always resolves to the current attempt.
 */
export function ensurePmDeliveryForTaskVerify(
  dataRoot: string,
  project: string,
  taskId: string,
): Promise<PmDeliveryRecord | null> {
  const tid = requireNonEmptyString(taskId, 'taskId');
  let task;
  try {
    task = getTask(dataRoot, project, tid);
  } catch {
    throw new PmDeliveryError('NOT_FOUND', `Task '${tid}' 찾을 수 없습니다.`);
  }
  if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'VERIFYING') {
    return Promise.resolve(null);
  }
  const runId = resolveCurrentAttemptRunId(task);
  if (!runId) return Promise.resolve(null);
  const deliveryId = pmDeliveryIdFor(tid, runId);

  return withDeliveryLock(dataRoot, project, deliveryId, (): PmDeliveryRecord => {
    // Re-read inside the lock: a concurrent retry may have displaced the attempt.
    const current = getTask(dataRoot, project, tid);
    if (current.executionState !== 'RESULT_RECEIVED' || current.pmState !== 'VERIFYING') {
      throw new PmDeliveryError('CONFLICT', `Task ${tid} is no longer RESULT_RECEIVED+VERIFYING; not minting.`);
    }
    const currentRunId = resolveCurrentAttemptRunId(current);
    if (!currentRunId || currentRunId !== runId) {
      throw new PmDeliveryError('CONFLICT', `Task ${tid} attempt changed during mint; not minting stale delivery.`);
    }
    const folder = pmDeliveryFolder(dataRoot, project, deliveryId);
    const file = deliveryJsonPath(folder);
    fs.mkdirSync(folder, { recursive: true });
    if (fs.existsSync(file)) {
      // Already minted (possibly concurrently, possibly terminal) —
      // return it unchanged. Terminal states are never reset.
      return readDeliveryRecord(dataRoot, project, deliveryId);
    }
    const ts = nowIso();
    const record: PmDeliveryRecord = {
      schemaVersion: PM_DELIVERY_SCHEMA_VERSION,
      deliveryId,
      project,
      kind: 'TASK_VERIFY',
      taskId: tid,
      runId,
      status: 'PENDING',
      createdAt: ts,
      updatedAt: ts,
      source: { kind: 'pm-work', workKind: 'TASK_VERIFY' },
    };
    persistDeliveryRecord(folder, record);
    return record;
  }).catch((err) => {
    // Trigger-absent races surface as CONFLICT from the in-lock re-check;
    // callers (bridge fast-path, reconcile) treat "no longer mintable" as null.
    if (err instanceof PmDeliveryError && err.code === 'CONFLICT') return null;
    throw err;
  });
}

/**
 * Canonical recovery delivery for a dispatch/runtime failure before Result.
 * The delivery keeps TASK_VERIFY identity so the existing PM judgment and
 * retry path can recover the same Task; it never fabricates a Result.
 */
export function ensurePmDeliveryForFailedRun(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
): Promise<PmDeliveryRecord | null> {
  const tid = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  const deliveryId = pmDeliveryIdFor(tid, rid);
  return withDeliveryLock(dataRoot, project, deliveryId, (): PmDeliveryRecord | null => {
    const folder = pmDeliveryFolder(dataRoot, project, deliveryId);
    const file = deliveryJsonPath(folder);
    if (fs.existsSync(file)) return readDeliveryRecord(dataRoot, project, deliveryId);
    const task = getTask(dataRoot, project, tid);
    const currentRunId = resolveCurrentAttemptRunId(task);
    if (task.executionState !== 'FAILED' || task.pmState !== 'PENDING' || currentRunId !== rid) return null;
    const linked = task.linkedRuns.find((r) => r.runId === rid);
    if (!linked || fs.existsSync(path.join(linked.folder, 'result.md')) || fs.existsSync(path.join(linked.folder, 'agent-result.md'))) return null;
    const ts = nowIso();
    const record: PmDeliveryRecord = {
      schemaVersion: PM_DELIVERY_SCHEMA_VERSION, deliveryId, project, kind: 'TASK_VERIFY',
      taskId: tid, runId: rid, status: 'PENDING', createdAt: ts, updatedAt: ts,
      source: { kind: 'pm-work', workKind: 'TASK_VERIFY' },
    };
    fs.mkdirSync(folder, { recursive: true });
    persistDeliveryRecord(folder, record);
    return record;
  });
}

export interface ReconcileResult {
  ensured: string[];
  alreadyPresent: string[];
  skippedTasks: string[];
}

/**
 * Restart-safe reconciliation: scan canonical Task truth and ensure exactly
 * one TASK_VERIFY delivery for every RESULT_RECEIVED + VERIFYING current
 * attempt. Never resets terminal records; never mints for any other state.
 */
export async function reconcilePmDeliveries(
  dataRoot: string,
  project: string,
): Promise<ReconcileResult> {
  const ensured: string[] = [];
  const alreadyPresent: string[] = [];
  const skippedTasks: string[] = [];
  for (const task of listTasks(dataRoot, project)) {
    if (task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'VERIFYING') {
      skippedTasks.push(task.taskId);
      continue;
    }
    const runId = resolveCurrentAttemptRunId(task);
    if (!runId) {
      skippedTasks.push(task.taskId);
      continue;
    }
    const deliveryId = pmDeliveryIdFor(task.taskId, runId);
    const existed = fs.existsSync(deliveryJsonPath(pmDeliveryFolder(dataRoot, project, deliveryId)));
    const rec = await ensurePmDeliveryForTaskVerify(dataRoot, project, task.taskId);
    if (rec) {
      (existed ? alreadyPresent : ensured).push(rec.deliveryId);
    } else {
      skippedTasks.push(task.taskId);
    }
  }
  return { ensured, alreadyPresent, skippedTasks };
}

// ── lifecycle (strict CAS) ───────────────────────────────────────────────────

const DELIVERY_TRANSITIONS: Record<PmDeliveryStatus, readonly PmDeliveryStatus[]> = {
  PENDING: ['DELIVERED', 'IGNORED'],
  DELIVERED: ['ACKNOWLEDGED', 'IGNORED'],
  ACKNOWLEDGED: [],
  IGNORED: [],
};

function transitionDelivery(
  dataRoot: string,
  project: string,
  deliveryId: string,
  to: PmDeliveryStatus,
  expectedStatus: PmDeliveryStatus,
): Promise<PmDeliveryRecord> {
  if (!isPmDeliveryStatus(expectedStatus)) {
    throw new PmDeliveryError('INVALID_ARGUMENT', `잘못된 expectedStatus: ${String(expectedStatus)}`);
  }
  return withDeliveryLock(dataRoot, project, deliveryId, (): PmDeliveryRecord => {
    const current = readDeliveryRecord(dataRoot, project, deliveryId);
    if (current.status !== expectedStatus) {
      throw new PmDeliveryError(
        'CONFLICT',
        `대기 상태 불일치: 현재 ${current.status}, 기대 ${expectedStatus}`,
      );
    }
    if (current.status === to) return current; // idempotent replay
    if (!DELIVERY_TRANSITIONS[current.status].includes(to)) {
      throw new PmDeliveryError('INVALID_STATE', `불가능한 delivery 전이: ${current.status} → ${to}`);
    }
    const ts = nowIso();
    const next: PmDeliveryRecord = {
      ...current,
      status: to,
      updatedAt: ts,
      ...(to === 'DELIVERED' ? { deliveredAt: ts } : {}),
      ...(to === 'ACKNOWLEDGED' ? { acknowledgedAt: ts } : {}),
      ...(to === 'IGNORED' ? { ignoredAt: ts } : {}),
    };
    persistDeliveryRecord(pmDeliveryFolder(dataRoot, project, deliveryId), next);
    return next;
  });
}

export function markPmDeliveryDelivered(
  dataRoot: string,
  project: string,
  deliveryId: string,
  expectedStatus: PmDeliveryStatus,
): Promise<PmDeliveryRecord> {
  return transitionDelivery(dataRoot, project, deliveryId, 'DELIVERED', expectedStatus);
}

export function acknowledgePmDelivery(
  dataRoot: string,
  project: string,
  deliveryId: string,
  expectedStatus: PmDeliveryStatus,
): Promise<PmDeliveryRecord> {
  return transitionDelivery(dataRoot, project, deliveryId, 'ACKNOWLEDGED', expectedStatus);
}

export function ignorePmDelivery(
  dataRoot: string,
  project: string,
  deliveryId: string,
  expectedStatus: PmDeliveryStatus,
): Promise<PmDeliveryRecord> {
  return transitionDelivery(dataRoot, project, deliveryId, 'IGNORED', expectedStatus);
}
