/**
 * Phase 2 §9.3 — dataRoot-wide OS exclusive advisory lock for actl-managed controller.
 *
 * Path: `{dataRoot}/_relay/locks/actl-managed-controller.lock.d/`
 * Implementation: atomic `mkdir` exclusive create (POSIX). Equivalent advisory
 * exclusivity to flock without orphan `-c` shell FD retention.
 * Stale locks (dead pid) are removed on acquire.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ACTL_MANAGED_DATAROOT_LOCK_REL = path.join(
  '_relay',
  'locks',
  'actl-managed-controller.lock.d',
);

export class ActlDataRootLockError extends Error {
  readonly code = 'CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ActlDataRootLockError';
  }
}

export interface ActlDataRootLockHandle {
  readonly dataRoot: string;
  readonly lockPath: string;
  release(): void;
}

const held = new Map<string, ActlDataRootLockHandle>();

export function actlManagedDataRootLockPath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), ACTL_MANAGED_DATAROOT_LOCK_REL);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHolderPid(lockDir: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(lockDir, 'holder.json'), 'utf8')) as { pid?: number };
    return typeof raw.pid === 'number' ? raw.pid : null;
  } catch {
    return null;
  }
}

/**
 * Acquire exclusive dataRoot controller lock.
 * Throws ActlDataRootLockError if another live process holds it.
 */
export async function tryAcquireActlManagedDataRootLock(dataRoot: string): Promise<ActlDataRootLockHandle> {
  const root = path.resolve(dataRoot);
  const existing = held.get(root);
  if (existing) return existing;

  const lockPath = actlManagedDataRootLockPath(root);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const tryMkdir = (): boolean => {
    try {
      fs.mkdirSync(lockPath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryMkdir()) {
    const holderPid = readHolderPid(lockPath);
    if (holderPid !== null && !pidAlive(holderPid)) {
      // Stale lock from dead controller — clear and retry once.
      fs.rmSync(lockPath, { recursive: true, force: true });
      if (!tryMkdir()) {
        throw new ActlDataRootLockError(
          `CONFLICT: actl-managed dataRoot lock contended at ${lockPath} `
            + `(another Relay controller holds §9.3 lock).`,
        );
      }
    } else {
      throw new ActlDataRootLockError(
        `CONFLICT: actl-managed dataRoot lock contended at ${lockPath} `
          + `(another Relay controller holds §9.3 lock`
          + (holderPid ? `, pid=${holderPid}` : '')
          + ').',
      );
    }
  }

  fs.writeFileSync(
    path.join(lockPath, 'holder.json'),
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + '\n',
    'utf8',
  );

  let released = false;
  const handle: ActlDataRootLockHandle = {
    dataRoot: root,
    lockPath,
    release(): void {
      if (released) return;
      released = true;
      held.delete(root);
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
  held.set(root, handle);
  return handle;
}

/** Test helper — release all held dataRoot locks. */
export function _resetActlDataRootLocksForTests(): void {
  for (const handle of [...held.values()]) {
    handle.release();
  }
  held.clear();
}
