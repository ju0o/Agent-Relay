import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only access to Codex CLI on-disk session transcripts:
 *   ~/.codex/sessions/YYYY/MM/DD/<title>-<uuid>.jsonl
 *
 * The session UUID is encoded in the filename after the last '-' group,
 * and also present inside every transcript as the session_meta payload.
 * We extract from the filename and confirm via session_meta when parsing.
 */

export interface CodexSessionFile {
  path: string;
  /** UUID extracted from filename. */
  sessionId: string;
  size: number;
  mtimeMs: number;
}

/** Root of Codex session storage. Returns null when absent. */
export function codexSessionsRoot(): string | null {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** UUID-4 / UUID-7 pattern (lowercase hex + dashes). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractSessionIdFromFilename(name: string): string | null {
  // Filename format: <title>-<uuid>.jsonl
  // The UUID is the LAST UUID-shaped segment in the stem.
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  // Find all UUID matches; last one wins (title may also contain date-like segments).
  const matches = [...stem.matchAll(new RegExp(UUID_RE.source, 'gi'))];
  if (!matches.length) return null;
  return matches[matches.length - 1]![0].toLowerCase();
}

/**
 * Recursively scan the sessions tree for JSONL files.
 * The tree is structured as YYYY/MM/DD/<file>.jsonl.
 * Never throws.
 */
export function listCodexSessionFiles(root: string): CodexSessionFile[] {
  const out: CodexSessionFile[] = [];
  scanDir(root, out);
  return out;
}

function scanDir(dir: string, out: CodexSessionFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      scanDir(full, out);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const sessionId = extractSessionIdFromFilename(e.name);
    if (!sessionId) continue;
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({ path: full, sessionId, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
}
