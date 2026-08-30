import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only access to Cline CLI on-disk session state:
 *   ~/.cline/data/sessions/<sessionId>/
 *     <sessionId>.json         — session metadata (id, cwd, status, timestamps)
 *     <sessionId>.messages.json — conversation messages (JSON array wrapper)
 *
 * Session IDs are the directory names (e.g. "1787315828266_beynt").
 */

export interface ClineSessionEntry {
  sessionId: string;
  dir: string;
  metaPath: string;
  messagesPath: string;
  /** Max mtime of both session files — used for freshness gating. */
  mtimeMs: number;
}

/** Root of Cline session storage. Returns null when absent. */
export function clineSessionsRoot(): string | null {
  const root = path.join(os.homedir(), '.cline', 'data', 'sessions');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * List all session directories under the sessions root.
 * Never throws.
 */
export function listClineSessions(root: string): ClineSessionEntry[] {
  const out: ClineSessionEntry[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const sessionId = d.name;
    const dir = path.join(root, sessionId);
    const metaPath = path.join(dir, `${sessionId}.json`);
    const messagesPath = path.join(dir, `${sessionId}.messages.json`);

    let metaMtime = 0;
    let msgMtime = 0;
    try {
      metaMtime = fs.statSync(metaPath).mtimeMs;
    } catch { /* file may not exist yet */ }
    try {
      msgMtime = fs.statSync(messagesPath).mtimeMs;
    } catch { /* file may not exist yet */ }

    const mtimeMs = Math.max(metaMtime, msgMtime);
    if (mtimeMs === 0) continue; // session dir has no readable files yet

    out.push({ sessionId, dir, metaPath, messagesPath, mtimeMs });
  }
  return out;
}
