/**
 * Shared workspace-diff helpers (round 36, P0/P1) — ONE copy of git-status
 * enumeration, NUL-record parsing, path normalization, and bounded content-digest
 * computation used by BOTH sides of the dispatch-time workspace baseline
 * protocol (src/backend/dispatcher.ts capture ↔ src/backend/qa-deterministic-
 * evaluator.ts judgment).
 *
 * Round 36 replaces the round-32/33 textual `--porcelain=v1` parsing (which
 * C-quoted every non-ASCII / quote / backslash path via core.quotePath=true and
 * left the octal escapes undecoded — the round-33 P0 closure gap) with the
 * NUL-separated `-z` record layout: `XY<space>path<0x00>`, path RAW, never
 * C-quoted. `--no-renames` stays on — with `-z` a rename is a second
 * NUL-terminated field. Both sides parse the SAME byte stream with the SAME
 * parser, so baseline keys and current-status keys agree byte-for-byte.
 *
 * Digest definition: sha256 of the working-tree file's bytes at call time,
 * bounded by MAX_DIGEST_FILE_BYTES. Missing → "deleted"; larger than the
 * per-file cap → `oversize:<bytes>` (recorded WITHOUT reading, and never
 * excludable at QA time); not a plain file (directory / gitlink / special) →
 * null (callers fail closed). Symlinks are followed (fsp.stat) — the digest is
 * of the link TARGET's bytes; a broken link reads as "deleted".
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

// ── bounds (round 36 P1) ─────────────────────────────────────────────────────

/** Exact argv used by BOTH the dispatcher and the evaluator. `-z` gives
 * NUL-separated records with raw paths (no C-quoting of non-ASCII / quotes /
 * backslashes — the round-33 P0 fix); `--no-renames` keeps exactly one path
 * per record; `-uall` keeps untracked FILES enumerated, never collapsed. */
export const GIT_STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--no-renames', '-uall'] as const;

/** Timeout for the internal `git status` subprocess (unchanged from round 32). */
export const GIT_STATUS_TIMEOUT_MS = 30_000;

/** stdout capture cap for the NUL status stream. 2000 baseline paths at ~200
 * bytes/path ≈ 400 KB; 4 MiB is a wide margin while still bounded. A workspace
 * whose status stream exceeds this fails the capture (callers fail closed) —
 * a partial record list is never trusted. */
export const GIT_STATUS_MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

/** Per-file digest cap (round 36 P1). A plain file larger than this is recorded
 * as `oversize:<size>` WITHOUT being read into memory or hashed, and is NEVER
 * excluded at QA time (treated as changed if dirty). */
export const MAX_DIGEST_FILE_BYTES = 8 * 1024 * 1024;

/** Total digest cap (round 36 P1). When more than this many paths are dirty the
 * dispatcher skips digesting entirely, writes `truncated: true`, and the
 * evaluator falls back to round-32 path-only subtraction with a visible note. */
export const MAX_BASELINE_PATHS = 2000;

/** Digest value format for a file that exceeded MAX_DIGEST_FILE_BYTES. */
const OVERSIZE_DIGEST_RE = /^oversize:\d+$/;

export function isOversizeDigest(value: string): boolean {
  return OVERSIZE_DIGEST_RE.test(value);
}

// ── shared NUL-record parser (round 36 P0) ───────────────────────────────────

/** NUL-record parser for `git status --porcelain=v1 -z --no-renames -uall`
 * output. Every record is `XY<space>path<0x00>`; the path portion is RAW (never
 * C-quoted), so it is returned byte-for-byte with NO quote stripping, NO octal
 * decoding, and NO trimming (a leading/trailing-space filename is a real path).
 * Empty records (the terminal NUL and any internal NUL) are skipped. */
export function parsePorcelainZRecords(output: Buffer | string): string[] {
  const buf = Buffer.isBuffer(output) ? output : Buffer.from(output, 'utf8');
  const paths: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const nul = buf.indexOf(0, start);
    const end = nul === -1 ? buf.length : nul;
    const record = buf.subarray(start, end).toString('utf8');
    start = nul === -1 ? buf.length : nul + 1;
    if (record.length < 3) continue; // "XY " minimum; empty tail
    const p = record.slice(3); // strip the "XY " status field
    if (p.length > 0) paths.push(p);
  }
  return paths;
}

/** Runs the exact git-status argv BOTH sides use, with a bounded timeout and a
 * bounded byte-hungry capture, and returns the raw NUL-parsed path list — or a
 * fail-closed error reason. ONE spawn implementation for both sides guarantees
 * the dispatcher's baseline keys and the evaluator's current-status keys come
 * from the same byte-stream definition. */
export function runGitStatusZ(
  workspaceRoot: string,
): Promise<{ kind: 'ok'; paths: string[]; bytes: number } | { kind: 'error'; reason: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    try {
      child = spawn('git', [...GIT_STATUS_ARGS], {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        kind: 'error',
        reason: `git status 실행 실패 (authoritative diff 확인 불가): ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (snapshot: { kind: 'ok'; paths: string[]; bytes: number } | { kind: 'error'; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child?.kill('SIGKILL'); // never leave a stray git running
      } catch {
        /* already exited */
      }
      finish({ kind: 'error', reason: 'git status 시간 초과 (authoritative diff 확인 불가)' });
    }, GIT_STATUS_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutOverflow) return;
      if (stdoutBytes + chunk.length > GIT_STATUS_MAX_CAPTURE_BYTES) {
        stdoutOverflow = true;
        stdoutChunks.length = 0; // drop partial capture — never trusted
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= 4096) return;
      stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    child.once('error', (err) =>
      finish({
        kind: 'error',
        reason: `git status 실행 실패 (authoritative diff 확인 불가): ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    child.once('close', (code) => {
      if (timedOut || settled) return;
      if (code !== 0) {
        finish({
          kind: 'error',
          reason: `git status가 exit ${String(code)}로 종료되어 authoritative diff를 확인할 수 없습니다.`,
        });
        return;
      }
      if (stdoutOverflow) {
        finish({ kind: 'error', reason: 'git status 출력이 너무 커 authoritative diff를 완전히 판단할 수 없습니다.' });
        return;
      }
      finish({ kind: 'ok', paths: parsePorcelainZRecords(Buffer.concat(stdoutChunks)), bytes: stdoutBytes });
    });
  });
}

// ── shared normalization + digest (round 33/36) ──────────────────────────────

/** Workspace-relative posix normalization applied on BOTH sides of the
 * dispatch-time baseline protocol. Input is a `-z` RAW path — never C-quoted —
 * so no quote stripping and no backslash-to-separator conversion is performed
 * (a path that literally contains a backslash byte, or begins and ends with a
 * quote, is a real path and is preserved byte-for-byte). Returns the canonical
 * form used for baseline/exclusion/scope comparisons, or null when the string
 * cannot be a valid workspace-relative path (empty, `..` prefix escape,
 * absolute). */
export function normalizeWorkspacePath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  if (!raw) return null;
  const norm = path.posix.normalize(raw);
  if (norm === '.' || norm.startsWith('..') || path.posix.isAbsolute(norm)) return null;
  return norm;
}

/** Content digest of the working-tree file at `workspaceRoot/<relPath>` right
 * now: `"<sha256hex>"` for a readable plain file ≤ MAX_DIGEST_FILE_BYTES, the
 * literal `"deleted"` when the file is missing, `"oversize:<bytes>"` for a
 * plain file larger than MAX_DIGEST_FILE_BYTES (recorded WITHOUT reading or
 * hashing it — the evaluator must treat every `oversize:` digest as changed by
 * the run), or null when the path is not a plain file (directory / gitlink /
 * special) — callers must fail closed on null. Symlinks are followed via
 * fsp.stat → the digest hashes the link TARGET's bytes; a broken link (target
 * missing) reads as "deleted". */
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
  if (stat.size > MAX_DIGEST_FILE_BYTES) return `oversize:${stat.size}`;
  try {
    const buf = await fsp.readFile(absPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return 'deleted';
  }
}
