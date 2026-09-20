/**
 * Durable Owner authorization (Owner GO) for live workspace execution.
 *
 * After ONE Owner Workspace GO, the LOCAL persistent Runner is authorized
 * to perform bounded live execution. The GO is a durable artifact in the
 * runner store; every live send/dispatch/intake verifies it first.
 *
 * A GO authorizes ONLY:
 * - normal canonical Task intake from existing approved Goal/SSOT/WBS
 * - dispatch to the listed project lanes
 * - PM / Builder / QA transport turns (bounded by maxTasks/turn budget)
 * - retries caused by REQUEST_CHANGES
 * - advancement after ACCEPT
 * - scheduler movement to next eligible lane
 *
 * It NEVER authorizes: new Product direction, irreversible external
 * actions, bypassing Human Gates, fabricated Tasks/history, or
 * destructive system actions. Enforcement points call requireOwnerGo()
 * with the lane + action; violations throw before any effect.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type OwnerGoAction =
  | 'tmux-send'
  | 'dispatch'
  | 'intake'
  | 'advance'
  | 'retry';

export interface OwnerGo {
  schemaVersion: 'owner-go.v1';
  goId: string;
  cycleId: string;
  lanes: string[];
  maxTasksPerLane: number;
  allowNewTasks: boolean;
  allowTmuxSends: boolean;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  note: string;
}

export function ownerGoPath(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), 'owner-go.json');
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function recordOwnerGo(storeRoot: string, input: {
  cycleId: string;
  lanes: string[];
  maxTasksPerLane?: number;
  allowNewTasks?: boolean;
  allowTmuxSends?: boolean;
  ttlHours?: number;
  note?: string;
}): OwnerGo {
  if (!input.cycleId.trim()) throw new Error('Owner GO requires cycleId');
  if (!input.lanes.length) throw new Error('Owner GO requires at least one lane');
  const createdAt = new Date().toISOString();
  const go: OwnerGo = {
    schemaVersion: 'owner-go.v1',
    goId: `go-${Date.now().toString(36)}`,
    cycleId: input.cycleId.trim(),
    lanes: [...input.lanes],
    maxTasksPerLane: input.maxTasksPerLane ?? 3,
    allowNewTasks: input.allowNewTasks ?? true,
    allowTmuxSends: input.allowTmuxSends ?? true,
    createdAt,
    expiresAt: new Date(Date.now() + (input.ttlHours ?? 72) * 3600 * 1000).toISOString(),
    revoked: false,
    note: input.note ?? 'Owner Workspace GO: bounded live execution for listed lanes only',
  };
  atomicWrite(ownerGoPath(storeRoot), go);
  return go;
}

export function readOwnerGo(storeRoot: string): OwnerGo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(ownerGoPath(storeRoot), 'utf8')) as OwnerGo;
    if (raw.schemaVersion !== 'owner-go.v1') return null;
    return raw;
  } catch {
    return null;
  }
}

export function revokeOwnerGo(storeRoot: string): void {
  const go = readOwnerGo(storeRoot);
  if (!go) return;
  atomicWrite(ownerGoPath(storeRoot), { ...go, revoked: true });
}

/**
 * Fail-closed gate: returns the covering GO or throws. Expired, revoked,
 * out-of-scope-lane, and action-not-allowed GOs all throw with distinct
 * reasons (auditable, never silent).
 */
export function requireOwnerGo(storeRoot: string, laneId: string, action: OwnerGoAction): OwnerGo {
  const go = readOwnerGo(storeRoot);
  if (!go) throw new Error('OWNER_GO_REQUIRED: no Owner GO on file; live effects refused');
  if (go.revoked) throw new Error('OWNER_GO_REVOKED: live effects refused');
  if (Date.now() > Date.parse(go.expiresAt)) throw new Error('OWNER_GO_EXPIRED: live effects refused');
  if (!go.lanes.includes(laneId)) throw new Error(`OWNER_GO_SCOPE: lane ${laneId} not covered (covered: ${go.lanes.join(',')})`);
  if (action === 'tmux-send' && !go.allowTmuxSends) {
    throw new Error('OWNER_GO_SCOPE: tmux sends not authorized by this GO');
  }
  if (action === 'intake' && !go.allowNewTasks) {
    throw new Error('OWNER_GO_SCOPE: new task intake not authorized by this GO');
  }
  return go;
}
