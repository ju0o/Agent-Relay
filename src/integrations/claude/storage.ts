import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only access to Claude Code's on-disk session transcripts:
 *   ~/.claude/projects/<encoded-workspace>/<sessionId>.jsonl
 *   (or $CLAUDE_CONFIG_DIR/projects/... when the CLI config dir is relocated)
 *
 * We never write here. Directory-name encoding differs between Claude Code
 * versions, so instead of re-encoding workspace paths we scan all project
 * folders and take the workspace identity from each transcript's own `cwd`
 * field — stable across versions.
 */

export interface TranscriptFile {
  /** Absolute path of the .jsonl file. */
  path: string;
  /** Session id == file stem (uuid), also present inside every entry. */
  sessionId: string;
  size: number;
  mtimeMs: number;
}

/**
 * Resolve the transcript root the CLI itself persists to.
 *
 * V1-G3 correction: honor the CLI's documented CLAUDE_CONFIG_DIR relocation.
 * When set, the CLI stores session transcripts under
 * $CLAUDE_CONFIG_DIR/projects instead of ~/.claude/projects. Relay's worker
 * inherits the same process env, so the adapter must read from the same root
 * the worker's Claude wrote to — otherwise real runs are never observed.
 * Falls back to ~/.claude/projects when unset.
 */
export function claudeProjectsRoot(): string | null {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  const root = override && override.trim()
    ? path.join(override.trim(), 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
  try {
    return fs.statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Flat scan: every *.jsonl under every project folder. Never throws. */
export function listTranscriptFiles(root: string): TranscriptFile[] {
  const out: TranscriptFile[] = [];
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
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        out.push({ path: full, sessionId: f.slice(0, -'.jsonl'.length), size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // vanished between readdir and stat — skip
      }
    }
  }
  return out;
}
