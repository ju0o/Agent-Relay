/**
 * Durable turn store — every PM/Builder/QA turn is a persisted record.
 *
 * A turn carries full structured identity:
 *   projectId, taskId, runId, role, requestId/correlationId, attempt
 *
 * Lifecycle (no screen-string DONE is ever canonical):
 *   REQUESTED -> SENT -> RUNNING -> RESULT_RECEIVED -> VERIFIED | FAILED
 *   FAILED(transient, attempts left) -> a NEW attempt turn is created;
 *   the failed record is preserved, never rewritten.
 *
 * Recovery: after a Runner/process restart the engine re-reads the store
 * and resumes from the current durable state — SENT/RUNNING turns are
 * re-collected by requestId boundary, RESULT_RECEIVED turns advance
 * without re-sending. Completed work is never re-executed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type TurnRole = 'pm' | 'builder' | 'qa';
export type TurnState =
  | 'REQUESTED'
  | 'SENT'
  | 'RUNNING'
  | 'RESULT_RECEIVED'
  | 'VERIFIED'
  | 'FAILED';

const LEGAL: Record<TurnState, TurnState[]> = {
  REQUESTED: ['SENT', 'FAILED'],
  SENT: ['RUNNING', 'FAILED'],
  RUNNING: ['RESULT_RECEIVED', 'FAILED'],
  RESULT_RECEIVED: ['VERIFIED', 'FAILED'],
  VERIFIED: [],
  FAILED: [],
};

export interface TurnRecord {
  turnId: string;
  projectId: string;
  taskId: string;
  runId: string;
  role: TurnRole;
  requestId: string;
  correlationId: string;
  attempt: number;
  state: TurnState;
  timeoutMs: number;
  maxAttempts: number;
  requestBody: string;
  resultBody: string | null;
  resultRef: string | null;
  error: string | null;
  transient: boolean;
  createdAt: string;
  updatedAt: string;
  history: Array<{ state: TurnState; at: string; note?: string }>;
}

export interface NewTurn {
  projectId: string;
  taskId: string;
  runId: string;
  role: TurnRole;
  requestId?: string;
  correlationId: string;
  attempt?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  requestBody: string;
}

export function turnStoreDir(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), 'turns');
}

function turnPath(storeRoot: string, turnId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(turnId)) throw new Error(`bad turnId: ${turnId}`);
  return path.join(turnStoreDir(storeRoot), `${turnId}.json`);
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Create a turn. Idempotent per (requestId, role, taskId): if a
 * non-terminal turn already exists for the same request identity, it is
 * returned instead of creating a duplicate (no duplicate turns across
 * restarts/retries of the submit path).
 */
export function createTurn(storeRoot: string, input: NewTurn): TurnRecord {
  for (const f of ['projectId', 'taskId', 'runId', 'role', 'correlationId', 'requestBody'] as const) {
    const v = input[f];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`turn requires ${f}`);
  }
  if (input.role !== 'pm' && input.role !== 'builder' && input.role !== 'qa') {
    throw new Error(`bad role: ${input.role}`);
  }
  const requestId = input.requestId?.trim() || `req-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const existing = listTurns(storeRoot).find(
    (t) => t.requestId === requestId && t.role === input.role && t.taskId === input.taskId
      && t.projectId === input.projectId.trim()
      && t.state !== 'VERIFIED' && t.state !== 'FAILED',
  );
  if (existing) return existing;
  const ts = now();
  const record: TurnRecord = {
    turnId: `turn-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    projectId: input.projectId.trim(),
    taskId: input.taskId.trim(),
    runId: input.runId.trim(),
    role: input.role,
    requestId,
    correlationId: input.correlationId.trim(),
    attempt: input.attempt ?? 1,
    state: 'REQUESTED',
    timeoutMs: input.timeoutMs ?? 120000,
    maxAttempts: input.maxAttempts ?? 3,
    requestBody: input.requestBody,
    resultBody: null,
    resultRef: null,
    error: null,
    transient: false,
    createdAt: ts,
    updatedAt: ts,
    history: [{ state: 'REQUESTED', at: ts }],
  };
  atomicWrite(turnPath(storeRoot, record.turnId), record);
  return record;
}

export function readTurn(storeRoot: string, turnId: string): TurnRecord {
  return JSON.parse(fs.readFileSync(turnPath(storeRoot, turnId), 'utf8')) as TurnRecord;
}

export function listTurns(storeRoot: string): TurnRecord[] {
  const dir = turnStoreDir(storeRoot);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith('turn-') && n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as TurnRecord)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Non-terminal turns: the exact resume set after a restart. */
export function listPendingTurns(storeRoot: string): TurnRecord[] {
  return listTurns(storeRoot).filter((t) => t.state !== 'VERIFIED' && t.state !== 'FAILED');
}

/**
 * CAS transition with expected-state guard. Illegal jumps throw and change
 * nothing. On FAILED, `transient: true` (attempts remain) vs false
 * (terminal) is recorded explicitly.
 */
export function transitionTurn(
  storeRoot: string,
  turnId: string,
  to: TurnState,
  opts?: { expected?: TurnState; note?: string; error?: string; transient?: boolean; resultBody?: string; resultRef?: string },
): TurnRecord {
  const cur = readTurn(storeRoot, turnId);
  if (opts?.expected && cur.state !== opts.expected) {
    throw new Error(`TURN_CAS_CONFLICT: ${turnId} is ${cur.state}, expected ${opts.expected}`);
  }
  if (!LEGAL[cur.state].includes(to)) {
    throw new Error(`TURN_ILLEGAL: ${cur.state} -> ${to} for ${turnId}`);
  }
  const ts = now();
  const next: TurnRecord = {
    ...cur,
    state: to,
    updatedAt: ts,
    history: [...cur.history, { state: to, at: ts, ...(opts?.note ? { note: opts.note } : {}) }],
    ...(opts?.error !== undefined ? { error: opts.error } : {}),
    ...(opts?.transient !== undefined ? { transient: opts.transient } : {}),
    ...(opts?.resultBody !== undefined ? { resultBody: opts.resultBody } : {}),
    ...(opts?.resultRef !== undefined ? { resultRef: opts.resultRef } : {}),
  };
  atomicWrite(turnPath(storeRoot, turnId), next);
  return next;
}

/** Latest terminal-or-live turn per (taskId, role), newest first. */
export function latestTurnFor(storeRoot: string, taskId: string, role: TurnRole): TurnRecord | null {
  const hits = listTurns(storeRoot).filter((t) => t.taskId === taskId && t.role === role);
  return hits.length ? hits[hits.length - 1]! : null;
}
