/**
 * V1-G5-C — Narrow retry authorization kernel.
 *
 * The initial owner-approved dispatch (G2) authorizes retries of the SAME
 * Task with the SAME Worker and SAME Workspace only. This module persists
 * that narrow binding durably:
 *
 *   DATA_ROOT/<project>/_relay/retry-authorizations/<taskId>/authorization.json
 *
 * Security properties:
 *   - Binds exact taskId / goalId / workerId / workspaceRoot / scopeFingerprint.
 *   - Stores NO worker command, env, secrets, or permission policy.
 *   - Goal permissionPolicy is never mutated; no reusable broad OWNER token.
 *   - Authorization alone can NEVER dispatch — an ACTIVE authorization plus a
 *     READY unconsumed G5-B Retry Preparation are both required (see
 *     retry-dispatch.ts).
 *   - Revocation is implicit via Task state: ACCEPTED / CANCELLED / BLOCKED /
 *     FAILED tasks make the authorization unusable. Explicit REVOKED status
 *     is reserved for operator repair (see revokeRetryAuthorization).
 *
 * Crash model: the authorization is minted only AFTER the canonical initial
 * dispatch has succeeded (see v1-dispatch.ts), so no usable authorization
 * ever precedes a real Task/Run binding. If minting fails after dispatch,
 * the dispatch is NOT rolled back; a bounded warning is recorded and the
 * binding can be repaired later from the trusted first-run binding
 * (see ensureRetryAuthorization in retry-dispatch.ts).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir, writeJsonAtomic } from './goal-task.js';
import type { TaskRecord } from '../shared/types.js';

/** Retry authorization record schema version. */
export const RETRY_AUTHORIZATION_SCHEMA_VERSION = 1;

export const RETRY_AUTHORIZATION_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export type RetryAuthorizationStatus = (typeof RETRY_AUTHORIZATION_STATUSES)[number];

export interface RetryAuthorizationRecord {
  schemaVersion: number;
  taskId: string;
  goalId: string;
  /** Narrow trusted Worker binding — resolved server-side, never from PM input. */
  workerId: string;
  /** Narrow trusted Workspace binding — revalidated at every retry. */
  workspaceRoot: string;
  /** Deterministic fingerprint of the approved Task contract (see below). */
  scopeFingerprint: string;
  source: string;
  status: RetryAuthorizationStatus;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
  revokeReason?: string;
}

export class RetryAuthorizationError extends Error {
  readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: RetryAuthorizationError['code'], message: string) {
    super(message);
    this.name = 'RetryAuthorizationError';
    this.code = code;
  }
}

// ── paths ────────────────────────────────────────────────────────────────────

export function retryAuthorizationsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'retry-authorizations');
}

export function retryAuthorizationFolder(dataRoot: string, project: string, taskId: string): string {
  return path.join(retryAuthorizationsDir(dataRoot, project), taskId);
}

export function retryAuthorizationFile(dataRoot: string, project: string, taskId: string): string {
  return path.join(retryAuthorizationFolder(dataRoot, project, taskId), 'authorization.json');
}

// ── scope fingerprint ────────────────────────────────────────────────────────

/**
 * Deterministic fingerprint of the owner-approved Task contract.
 *
 * Canonical bounded inputs only: taskId, goal, reason, scope,
 * completionCriteria. Mutable runtime state (executionState, pmState,
 * retryCount, linkedRuns, acceptedRunId, …) is deliberately EXCLUDED so a
 * legitimately advanced Task still matches its own authorization.
 */
export function computeTaskScopeFingerprint(task: Pick<TaskRecord, 'taskId' | 'goal' | 'reason' | 'scope' | 'completionCriteria'>): string {
  const canonical = JSON.stringify([
    task.taskId,
    task.goal ?? '',
    task.reason ?? '',
    task.scope ?? '',
    Array.isArray(task.completionCriteria) ? task.completionCriteria : [],
  ]);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

// ── record IO ────────────────────────────────────────────────────────────────

const TASK_ID_RE = /^TASK-\d+$/;

function requireTaskId(taskId: unknown): string {
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
    throw new RetryAuthorizationError('INVALID_ARGUMENT', `잘못된 taskId: ${String(taskId)}`);
  }
  return taskId;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateAuthorizationRecord(r: RetryAuthorizationRecord): void {
  if (r.schemaVersion !== RETRY_AUTHORIZATION_SCHEMA_VERSION) {
    throw new RetryAuthorizationError('INVALID_STATE', `지원하지 않는 retry authorization schemaVersion: ${r.schemaVersion}`);
  }
  requireTaskId(r.taskId);
  if (!r.goalId || typeof r.goalId !== 'string') {
    throw new RetryAuthorizationError('INVALID_STATE', 'Retry authorization goalId가 필요합니다.');
  }
  if (!r.workerId || typeof r.workerId !== 'string') {
    throw new RetryAuthorizationError('INVALID_STATE', 'Retry authorization workerId가 필요합니다.');
  }
  if (!r.workspaceRoot || typeof r.workspaceRoot !== 'string') {
    throw new RetryAuthorizationError('INVALID_STATE', 'Retry authorization workspaceRoot이 필요합니다.');
  }
  if (!r.scopeFingerprint || typeof r.scopeFingerprint !== 'string') {
    throw new RetryAuthorizationError('INVALID_STATE', 'Retry authorization scopeFingerprint가 필요합니다.');
  }
  if (r.status !== 'ACTIVE' && r.status !== 'REVOKED') {
    throw new RetryAuthorizationError('INVALID_STATE', `알 수 없는 authorization status: ${String(r.status)}`);
  }
}

function readAuthorizationRecord(dataRoot: string, project: string, taskId: string): RetryAuthorizationRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(retryAuthorizationFile(dataRoot, project, taskId), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  try {
    const record = raw as RetryAuthorizationRecord;
    validateAuthorizationRecord(record);
    if (record.taskId !== taskId) return null;
    return record;
  } catch {
    return null;
  }
}

export function getRetryAuthorization(dataRoot: string, project: string, taskId: string): RetryAuthorizationRecord {
  const id = requireTaskId(taskId);
  const record = readAuthorizationRecord(dataRoot, project, id);
  if (!record) {
    throw new RetryAuthorizationError('NOT_FOUND', `Retry authorization을 찾을 수 없습니다: ${id}`);
  }
  return record;
}

/**
 * Mint (or refresh on manual re-dispatch) the narrow retry binding.
 * Latest owner-approved worker/workspace wins; status returns to ACTIVE.
 * createdAt is preserved across refreshes; scopeFingerprint is recomputed
 * by the caller from the current Task and stored verbatim.
 */
export function mintRetryAuthorization(
  dataRoot: string,
  project: string,
  input: {
    taskId: string;
    goalId: string;
    workerId: string;
    workspaceRoot: string;
    scopeFingerprint: string;
    source: string;
  },
): RetryAuthorizationRecord {
  const taskId = requireTaskId(input.taskId);
  if (!input.goalId || typeof input.goalId !== 'string') {
    throw new RetryAuthorizationError('INVALID_ARGUMENT', 'goalId가 필요합니다.');
  }
  if (!input.workerId || typeof input.workerId !== 'string' || !input.workerId.trim()) {
    throw new RetryAuthorizationError('INVALID_ARGUMENT', 'workerId가 필요합니다.');
  }
  if (!input.workspaceRoot || typeof input.workspaceRoot !== 'string' || !input.workspaceRoot.trim()) {
    throw new RetryAuthorizationError('INVALID_ARGUMENT', 'workspaceRoot이 필요합니다.');
  }
  if (!input.scopeFingerprint || typeof input.scopeFingerprint !== 'string') {
    throw new RetryAuthorizationError('INVALID_ARGUMENT', 'scopeFingerprint가 필요합니다.');
  }
  const ts = nowIso();
  const prev = readAuthorizationRecord(dataRoot, project, taskId);
  const record: RetryAuthorizationRecord = {
    schemaVersion: RETRY_AUTHORIZATION_SCHEMA_VERSION,
    taskId,
    goalId: input.goalId,
    workerId: input.workerId.trim(),
    workspaceRoot: input.workspaceRoot,
    scopeFingerprint: input.scopeFingerprint,
    source: typeof input.source === 'string' && input.source ? input.source : 'OWNER_APPROVED_INITIAL_DISPATCH',
    status: 'ACTIVE',
    createdAt: prev?.createdAt ?? ts,
    updatedAt: ts,
  };
  validateAuthorizationRecord(record);
  writeJsonAtomic(retryAuthorizationFile(dataRoot, project, taskId), record);
  return record;
}

/** Operator repair: explicitly revoke a binding (retained for audit). */
export function revokeRetryAuthorization(
  dataRoot: string,
  project: string,
  taskId: string,
  reason: string,
): RetryAuthorizationRecord {
  const current = getRetryAuthorization(dataRoot, project, taskId);
  const ts = nowIso();
  const revoked: RetryAuthorizationRecord = {
    ...current,
    status: 'REVOKED',
    updatedAt: ts,
    revokedAt: ts,
    revokeReason: typeof reason === 'string' && reason ? reason.slice(0, 500) : 'revoked',
  };
  validateAuthorizationRecord(revoked);
  writeJsonAtomic(retryAuthorizationFile(dataRoot, project, taskId), revoked);
  return revoked;
}

/**
 * Usability gate: an authorization is usable only while ACTIVE and the Task
 * is not in a state that revokes retry effects. A FAILED task (e.g. worker
 * launch failure) is NOT auto-retried here — existing canonical Task
 * semantics own that path; G5-C requires READY+PENDING at dispatch time.
 */
export function isRetryAuthorizationUsableForTask(task: TaskRecord, auth: RetryAuthorizationRecord): boolean {
  if (auth.status !== 'ACTIVE') return false;
  if (auth.taskId !== task.taskId) return false;
  if (task.pmState === 'ACCEPTED') return false;
  if (task.executionState === 'CANCELLED' || task.executionState === 'BLOCKED' || task.executionState === 'FAILED') return false;
  return computeTaskScopeFingerprint(task) === auth.scopeFingerprint;
}
