/**
 * Shared workspace-diff helpers (round 33, P2) — ONE copy of git-porcelain path
 * handling and content-digest computation used by BOTH sides of the
 * dispatch-time workspace baseline protocol:
 *
 *  - src/backend/dispatcher.ts snapshots dirty paths + content digests into
 *    workspace-baseline.json at dispatch time;
 *  - src/backend/qa-deterministic-evaluator.ts re-reads that baseline at
 *    diffScope judgment time and decides whether a currently-dirty path is the
 *    SAME content as at dispatch (excluded) or has been changed by this run.
 *
 * Both sides must compare the SAME normalized shape and the SAME digest
 * definition, so normalization and digest helpers live here instead of being
 * copied into the dispatcher (two copies was the round-32 defect class).
 *
 * Digest definition: sha256 of the working-tree file's bytes at the moment the
 * helper is called. A missing file (deleted) is the literal string "deleted".
 * A path that is NOT a plain file (directory, gitlink/submodule, special file)
 * returns null — the caller must fail closed (never treat "unknown content" as
 * "unchanged").
 */
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/** porcelain=v1 line → the raw (possibly C-quoted, possibly pathno-renames)
 * path portion, unquoted and trimmed, or null when the line cannot carry a
 * path at all. `git status --porcelain=v1 --no-renames` emits one plain path
 * per line ("XY<space>path"), so a leading "XY " is always stripped. */
export function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  let p = line.slice(3);
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  p = p.trim();
  return p || null;
}

/** Workspace-relative posix normalization applied on BOTH sides of the
 * dispatch-time baseline protocol. Accepts any already-unquoted path string and
 * returns the canonical form used for baseline/exclusion/scope comparisons, or
 * null when the string cannot be a valid workspace-relative path (escaping
 * `..` prefix, absolute, empty). Backslashes are converted so Windows-style
 * reporting never escapes a comparison. */
export function normalizeWorkspacePath(raw: string): string | null {
  let p = raw;
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  p = p.trim();
  if (!p) return null;
  const norm = path.posix.normalize(p.replace(/\\/g, '/'));
  if (norm === '.' || norm.startsWith('..') || path.posix.isAbsolute(norm)) return null;
  return norm;
}

/** Content digest of the working-tree file at `workspaceRoot/<relPath>` right
 * now: `"<sha256hex>"` for a readable plain file, the literal `"deleted"` when
 * the file is missing, or null when the path is not a plain file (directory /
 * gitlink / special) — callers must fail closed on null. */
export async function computeWorkspacePathDigest(
  workspaceRoot: string,
  relPath: string,
): Promise<string | null> {
  const absPath = path.join(workspaceRoot, relPath);
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return 'deleted';
  }
  if (!stat.isFile()) return null; // directory/special → not a file, fail closed
  try {
    const buf = await fsp.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return 'deleted';
  }
}
