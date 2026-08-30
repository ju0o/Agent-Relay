import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only access to CommandCode (cmdc) on-disk session transcripts:
 *   ~/.commandcode/projects/<project-slug>/<session-uuid>.jsonl
 *
 * Each project directory may contain:
 *   <uuid>.jsonl              — session transcript (message stream)
 *   <uuid>.checkpoints.jsonl — checkpoint snapshots (excluded)
 *   <uuid>.meta.json         — session title and trace IDs (optional)
 *   config.json              — project config (excluded)
 *
 * Note: ~/.commandcode/sessions/ contains hooks-audit files — NOT session transcripts.
 */

export interface CmdcSessionFile {
  path: string;
  /** Session UUID (file stem). */
  sessionId: string;
  /** Project slug (parent directory name). */
  projectSlug: string;
  size: number;
  mtimeMs: number;
}

/** Root of CommandCode project session storage. Returns null when absent. */
export function commandCodeProjectsRoot(): string | null {
  const root = path.join(os.homedir(), '.commandcode', 'projects');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/**
 * List all session transcript files across all project directories.
 * Excludes .checkpoints.jsonl and non-transcript files.
 * Never throws.
 */
export function listCommandCodeSessionFiles(root: string): CmdcSessionFile[] {
  const out: CmdcSessionFile[] = [];
  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return out;
  }

  for (const dir of projectDirs) {
    const slug = path.basename(dir);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      // Only accept *.jsonl that are NOT checkpoint files
      if (!name.endsWith('.jsonl')) continue;
      if (name.endsWith('.checkpoints.jsonl')) continue;

      const sessionId = name.slice(0, -'.jsonl'.length);
      // Validate it looks like a UUID or session-id
      if (!sessionId || sessionId.includes('.')) continue;

      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        out.push({ path: full, sessionId, projectSlug: slug, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return out;
}
