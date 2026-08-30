import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only access to Grok CLI on-disk session storage:
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/
 *     summary.json        — session metadata (id, cwd, created_at, updated_at, ...)
 *     chat_history.jsonl  — conversation messages (newline-delimited JSON)
 *     events.jsonl        — agent events (typically empty)
 *
 * The CWD is URL-encoded in the directory name (e.g., D:\MyFriend → D%3A%5CMyFriend).
 * We decode it to get the actual workspace path.
 */

export interface GrokSessionEntry {
  sessionId: string;
  /** URL-decoded workspace path from directory structure. */
  cwdEncoded: string;
  dir: string;
  summaryPath: string;
  chatHistoryPath: string;
  /** Max mtime of summary.json and chat_history.jsonl. */
  mtimeMs: number;
}

/** Root of Grok session storage. Returns null when absent. */
export function grokSessionsRoot(): string | null {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** URL-decode a Grok encoded-cwd directory name to a file-system path. */
export function decodeCwdDir(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * List all Grok session directories.
 * Structure: <root>/<cwdEncoded>/<sessionUuid>/
 * Never throws.
 */
export function listGrokSessions(root: string): GrokSessionEntry[] {
  const out: GrokSessionEntry[] = [];

  let cwdDirs: fs.Dirent[];
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    if (cwdDir.name === 'session_search.sqlite') continue; // skip sqlite at root level

    const cwdPath = path.join(root, cwdDir.name);
    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      const sessionId = sessionDir.name;
      // Validate UUID-ish format
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) continue;

      const dir = path.join(cwdPath, sessionId);
      const summaryPath = path.join(dir, 'summary.json');
      const chatHistoryPath = path.join(dir, 'chat_history.jsonl');

      let summaryMtime = 0;
      let chatMtime = 0;
      try { summaryMtime = fs.statSync(summaryPath).mtimeMs; } catch { }
      try { chatMtime = fs.statSync(chatHistoryPath).mtimeMs; } catch { }

      const mtimeMs = Math.max(summaryMtime, chatMtime);
      if (mtimeMs === 0) continue; // no readable files

      out.push({
        sessionId,
        cwdEncoded: cwdDir.name,
        dir,
        summaryPath,
        chatHistoryPath,
        mtimeMs,
      });
    }
  }
  return out;
}
