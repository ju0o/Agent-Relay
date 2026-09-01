/**
 * Phase H — Process-local observed-dispatch concurrency lock.
 *
 * Key: `${observationAdapterId}@@${path.resolve(workspaceRoot)}`
 * At most ONE concurrent auto-observed dispatch per (adapterId, workspaceRoot).
 */
import * as path from 'node:path';

export class ObservationLockError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ObservationLockError';
  }
}

export interface ObservationLockHandle {
  readonly key: string;
  readonly observationAdapterId: string;
  readonly workspaceRoot: string;
  readonly taskId: string;
  readonly runId: string;
  readonly acquiredAt: string;
}

/** Live locks keyed by observation key. */
const locks = new Map<string, ObservationLockHandle>();

export function observationLockKey(observationAdapterId: string, workspaceRoot: string): string {
  return `${observationAdapterId}@@${path.resolve(workspaceRoot)}`;
}

export function tryAcquireObservationLock(input: {
  observationAdapterId: string;
  workspaceRoot: string;
  taskId: string;
  runId: string;
}): ObservationLockHandle {
  const adapterId = String(input.observationAdapterId || '').trim();
  const workspace = String(input.workspaceRoot || '').trim();
  if (!adapterId) {
    throw new ObservationLockError('observationAdapterId is required for observation lock.');
  }
  if (!workspace) {
    throw new ObservationLockError('workspaceRoot is required for observation lock.');
  }
  const key = observationLockKey(adapterId, workspace);
  const existing = locks.get(key);
  if (existing) {
    throw new ObservationLockError(
      `CONFLICT: observation lock held for adapter=${adapterId} workspace=${path.resolve(workspace)} `
        + `(heldBy taskId=${existing.taskId} runId=${existing.runId})`,
    );
  }
  const handle: ObservationLockHandle = {
    key,
    observationAdapterId: adapterId,
    workspaceRoot: path.resolve(workspace),
    taskId: input.taskId,
    runId: input.runId,
    acquiredAt: new Date().toISOString(),
  };
  locks.set(key, handle);
  return handle;
}

export function releaseObservationLock(keyOrHandle: string | ObservationLockHandle | null | undefined): void {
  if (!keyOrHandle) return;
  const key = typeof keyOrHandle === 'string' ? keyOrHandle : keyOrHandle.key;
  locks.delete(key);
}

export function releaseObservationLockByBinding(input: {
  observationAdapterId: string;
  workspaceRoot: string;
  taskId?: string;
  runId?: string;
}): boolean {
  const key = observationLockKey(input.observationAdapterId, input.workspaceRoot);
  const existing = locks.get(key);
  if (!existing) return false;
  if (input.taskId && existing.taskId !== input.taskId) return false;
  if (input.runId && existing.runId !== input.runId) return false;
  locks.delete(key);
  return true;
}

export function getObservationLock(
  observationAdapterId: string,
  workspaceRoot: string,
): ObservationLockHandle | undefined {
  return locks.get(observationLockKey(observationAdapterId, workspaceRoot));
}

export function listObservationLocks(): ObservationLockHandle[] {
  return [...locks.values()];
}

/** Test-only reset. */
export function _resetObservationLocksForTests(): void {
  locks.clear();
}
