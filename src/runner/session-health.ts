/**
 * Session health + quarantine — frozen/unresponsive endpoint detection.
 *
 * Every transport-affecting failure (send refusals, timeouts) against a
 * bound session is recorded durably per session identity. After
 * QUARANTINE_AFTER consecutive failures the session is quarantined:
 * binding resolution skips it, so a dead pane is never counted ACTIVE and
 * a healthy configured session is reused when one exists. A single
 * VERIFIED turn resets the counter. Quarantine is per store (survives
 * restarts) and always audited where recorded.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const QUARANTINE_AFTER = 3;

export interface SessionHealth {
  sessionId: string;
  failures: number;
  quarantined: boolean;
  lastFailure: string | null;
  updatedAt: string;
}

function slug(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'unknown';
}

function healthPath(storeRoot: string, sessionId: string): string {
  return path.join(path.resolve(storeRoot), 'session-health', `${slug(sessionId)}.json`);
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readSessionHealth(storeRoot: string, sessionId: string): SessionHealth {
  try {
    const raw = JSON.parse(fs.readFileSync(healthPath(storeRoot, sessionId), 'utf8')) as SessionHealth;
    if (raw.sessionId === sessionId) return raw;
  } catch { /* none */ }
  return { sessionId, failures: 0, quarantined: false, lastFailure: null, updatedAt: new Date().toISOString() };
}

export function recordSessionFailure(storeRoot: string, sessionId: string, reason: string): SessionHealth {
  const cur = readSessionHealth(storeRoot, sessionId);
  const next: SessionHealth = {
    sessionId,
    failures: cur.failures + 1,
    quarantined: cur.quarantined || cur.failures + 1 >= QUARANTINE_AFTER,
    lastFailure: reason.slice(0, 200),
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(healthPath(storeRoot, sessionId), next);
  return next;
}

export function resetSessionHealth(storeRoot: string, sessionId: string): void {
  const cur = readSessionHealth(storeRoot, sessionId);
  if (cur.failures === 0 && !cur.quarantined) return;
  atomicWrite(healthPath(storeRoot, sessionId), {
    sessionId, failures: 0, quarantined: false, lastFailure: null, updatedAt: new Date().toISOString(),
  });
}

/** Quarantine reader for binding resolution (quarantined panes are skipped). */
export function readQuarantine(storeRoot: string): { isQuarantined(sessionId: string): boolean } {
  return {
    isQuarantined: (sessionId: string) => {
      try {
        return readSessionHealth(storeRoot, sessionId).quarantined;
      } catch {
        return false;
      }
    },
  };
}
