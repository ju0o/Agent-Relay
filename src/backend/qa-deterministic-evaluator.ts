/**
 * V1.6 Slice 2 — deterministic QA evaluator.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §7, §8, §9 (accepted
 * commit f1c8959; Slice 1 kernel accepted commits c57d996, dac4ed6). This
 * file implements the four frozen deterministic check kinds and the
 * deterministic-half of the QA Attempt state machine ONLY. It does NOT:
 *
 *   - invoke a Semantic QA Agent (Slice 3) or fabricate semantic evidence
 *   - wire into result-bridge.ts or auto-run on RUN_RESULT_RECEIVED (Slice 4)
 *   - expose any MCP tool
 *   - read a Task's `qaContract`/`acceptanceCriteria` (those fields do not
 *     exist on TaskRecord yet — this Slice takes an already-materialized
 *     `checks: QaDeterministicCheckDef[]` array as a trusted fixture input,
 *     exactly as §22 allows for the isolated-test period before Slice 4
 *     wires this engine to the real frozen Task contract)
 *
 * Domain authority (unchanged): this module never mutates TaskRecord/RunMeta;
 * it only reads them to validate the canonical binding (§ "RUN / TASK
 * VALIDATION" below) and calls Slice 1's own `recordDeterministicEvidence`/
 * `completeQaAttempt` to persist evidence onto the QaAttemptRecord they own.
 *
 * ── Check kinds (§9) ─────────────────────────────────────────────────────
 * fileExists / fileExactContent: `fs` read + byte-exact comparison, workspace-
 *   relative paths only, symlink-escape-safe (realpath must resolve under
 *   `workspaceRoot`). fileExactContent is byte-exact — a trailing-newline
 *   difference IS a mismatch (FAIL), never normalized away.
 * diffScope: `spawn('git', ['status','--porcelain=v1','-z','--no-renames',
 *   '-uall'], {cwd: workspaceRoot, shell:false})` — NUL-separated records,
 *   `XY<space>path<0x00>`, path RAW (never C-quoted, so non-ASCII / quotes /
 *   backslashes survive byte-for-byte, round 36 P0) — parsed and compared
 *   against `allowedPaths` with boundary-aware prefix matching (`src` never
 *   matches `srcx/...`). Round 33: the dispatch-time workspace baseline is
 *   content-aware — a path dirty NOW is subtracted as pre-existing ONLY when
 *   its working-tree content digest still equals the digest recorded at
 *   dispatch (`pre-existing (excluded): …`). If the content differs (or a
 *   baseline digest was never recorded for it), the path counts as changed by
 *   THIS run and is reported as `pre-existing but modified by this run: …`.
 *   An `oversize:` digest (round 36 P1) never proves equality — such a path is
 *   always treated as changed by the run. A baseline WITHOUT content digests
 *   (round-32 array, `{ paths }` object, or `truncated: true`) falls back to
 *   the round-32 path-only subtraction and is noted
 *   `baseline: path-only (legacy)` (with `, truncated` when the count cap was
 *   exceeded). No baseline file = legacy behavior.
 * command: `spawn(command, args, {cwd, shell:false})` — argv only, never a
 *   shell string; bounded timeout, bounded/truncated stdout+stderr, no env
 *   dump. A completed run with the wrong exit code is FAIL; a spawn error,
 *   timeout, or unobserved exit code is BLOCKED — never guessed as PASS/FAIL.
 *
 * ── Aggregation (§8) ─────────────────────────────────────────────────────
 * Any BLOCKED → deterministic BLOCKED. Else any FAIL → FAIL. Else PASS.
 * Precedence fails closed: BLOCKED > FAIL > PASS.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────
 * Every ambiguous condition (unsafe/escaping path, spawn failure, timeout,
 * unavailable authoritative diff, malformed per-check config) resolves to
 * that check's status=BLOCKED — never guessed as PASS. A batch-level shape
 * violation (an unfrozen check `kind`) is rejected up front as
 * INVALID_ARGUMENT before anything runs, never silently coerced into a
 * BLOCKED check result (persisting a check with a non-frozen `kind` would
 * itself violate Slice 1's own schema validation).
 *
 * Precondition failures that are NOT about any one check — the canonical
 * Run/Task binding itself is missing, unlinked, or the Run's Result was
 * never canonically captured — are refused via a thrown
 * QaDeterministicEvaluatorError('BLOCKED', …) WITHOUT touching the
 * QaAttemptRecord at all. This is a deliberate narrower choice than writing
 * a synthetic BLOCKED deterministic evidence for them: evidence should
 * describe what the frozen checks actually found, never a broken caller
 * binding that has nothing to do with the qaContract being evaluated.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getTask } from './goal-task.js';
import { readRunMeta } from './fs.js';
import {
  QA_DETERMINISTIC_CHECK_KINDS,
  type QaAttemptRecord,
  type QaCheckStatus,
  type QaDeterministicCheckKind,
  type QaDeterministicCheckResult,
  type QaSubVerdict,
  completeQaAttempt,
  getQaAttempt,
  recordDeterministicEvidence,
} from './qa-attempt.js';
import { recordQaAttemptVerifiedEvidence } from './qa-evidence.js';
import {
  computeWorkspacePathDigest,
  isOversizeDigest,
  normalizeWorkspacePath,
  runGitStatusZ,
} from './workspace-diff-common.js';

// ── bounds ───────────────────────────────────────────────────────────────────

/** Per-stream stdout/stderr cap for the `command` check (the internal
 * `git status` for diffScope has its own byte budget in workspace-diff-common.ts
 * since round 36) — same discipline as pm-verification-context.ts's
 * VERIFICATION_RESULT_TEXT_MAX_CHARS, sized for a bounded diagnostic
 * excerpt, never a full transcript. */
export const MAX_COMMAND_OUTPUT_CHARS = 4_000;
/** Frozen ceiling from §7 item 2 ("≤ a frozen ceiling, e.g. 300000ms"). */
export const MAX_COMMAND_TIMEOUT_MS = 300_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
/** Bounded byte window around the first mismatching byte in fileExactContent. */
const MISMATCH_SNIPPET_CONTEXT_BYTES = 40;

// ── check definitions (frozen kinds only, §9) ───────────────────────────────

export interface FileExistsCheckDef {
  kind: 'fileExists';
  criterionId?: string;
  /** Workspace-relative; absolute paths and `..` traversal are rejected. */
  path: string;
}

export interface FileExactContentCheckDef {
  kind: 'fileExactContent';
  criterionId?: string;
  path: string;
  expectedContent: string;
}

export interface DiffScopeCheckDef {
  kind: 'diffScope';
  criterionId?: string;
  /** Workspace-relative paths/prefixes the Run was authorized to change.
   * `.` means the entire workspace. Must already be a subset of the Task's
   * own frozen `scope` per §7 item 3 — not re-verified here (that belongs
   * to Task-creation validation, not yet wired in Slice 2). */
  allowedPaths: string[];
}

export interface CommandCheckDef {
  kind: 'command';
  criterionId?: string;
  /** Executable name/path — never a shell string. */
  command: string;
  /** argv, passed to spawn() verbatim — shell metacharacters stay literal. */
  args: string[];
  /** Workspace-relative; defaults to the workspace root itself. */
  cwd?: string;
  /** 1..MAX_COMMAND_TIMEOUT_MS; defaults to DEFAULT_COMMAND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Defaults to 0. */
  expectExitCode?: number;
}

export type QaDeterministicCheckDef =
  | FileExistsCheckDef
  | FileExactContentCheckDef
  | DiffScopeCheckDef
  | CommandCheckDef;

// ── errors ───────────────────────────────────────────────────────────────────

export class QaDeterministicEvaluatorError extends Error {
  /**
   * INVALID_ARGUMENT: a batch-level shape violation in the caller's input
   * (not a per-check runtime condition) — an unfrozen check `kind`, or
   * `checks` not being an array. Never partially executed.
   * BLOCKED: the canonical Run/Task binding precondition failed (Task
   * missing, Run not linked to the Task, no workspaceRoot binding, or the
   * Run's Result was never canonically captured) — refused before any check
   * runs, and the QaAttemptRecord is never touched (see module docstring).
   */
  readonly code: 'INVALID_ARGUMENT' | 'BLOCKED';
  constructor(code: QaDeterministicEvaluatorError['code'], message: string) {
    super(message);
    this.name = 'QaDeterministicEvaluatorError';
    this.code = code;
  }
}

// ── path safety ──────────────────────────────────────────────────────────────

type PathResolution = { kind: 'ok'; absPath: string } | { kind: 'blocked'; reason: string };

/** Resolve a caller-supplied workspace-relative path under `workspaceRoot`
 * lexically — rejects absolute paths and any `..` traversal that would
 * escape the root. Does NOT touch the filesystem (see resolveExistingPath
 * for the symlink-escape check, which requires the path to exist). */
function resolveWorkspaceRelativePath(workspaceRoot: string, relPath: unknown): PathResolution {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { kind: 'blocked', reason: 'path가 비어 있지 않은 문자열이어야 합니다.' };
  }
  if (relPath.includes('\0')) {
    return { kind: 'blocked', reason: '경로에 허용되지 않는 문자가 포함되어 있습니다.' };
  }
  if (path.isAbsolute(relPath)) {
    return { kind: 'blocked', reason: `절대 경로는 허용되지 않습니다: ${relPath}` };
  }
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { kind: 'blocked', reason: `workspace 밖으로 벗어나는 경로입니다 (traversal): ${relPath}` };
  }
  return { kind: 'ok', absPath: abs };
}

type ExistingPathResolution =
  | { kind: 'ok'; real: string }
  | { kind: 'missing' }
  | { kind: 'blocked'; reason: string };

function isUnderRoot(candidate: string, root: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c === r) return true;
  const rel = path.relative(r, c);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Fully resolve `absPath` through every symlink in its chain (node's
 * realpath does this for every path component, not just the leaf) and
 * confirm the result still lands under `workspaceRoot` — the symlink-escape
 * guard. A path that does not exist yet resolves to 'missing' (never
 * 'blocked'), matching §9's "missing file is FAIL, unreadable/unsafe is
 * BLOCKED" split. */
async function resolveExistingPathUnderRoot(workspaceRoot: string, absPath: string): Promise<ExistingPathResolution> {
  let real: string;
  try {
    real = await fsp.realpath(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'blocked', reason: `경로를 확인할 수 없습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Canonicalize BOTH sides before the containment check. `real` is fully
  // resolved while `workspaceRoot` may be spelled via a junction/symlink, an
  // 8.3 short name, or differing on-disk case for the SAME directory
  // (notably Windows Temp: RUNNER~1 vs runneradmin). Comparing a canonical
  // path against a non-canonical root with a lexical check falsely reports
  // containment failure — a spurious BLOCKED that finalizes the QA attempt
  // and escalates BLOCKED_ESCALATED without semantic QA ever running.
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(workspaceRoot);
  } catch (err) {
    return { kind: 'blocked', reason: `workspace 루트를 확인할 수 없습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isUnderRoot(real, realRoot)) {
    return { kind: 'blocked', reason: `심볼릭 링크가 workspace 밖을 가리킵니다: ${real}` };
  }
  return { kind: 'ok', real };
}

// ── check result helper ─────────────────────────────────────────────────────

function baseResult(
  checkIndex: number,
  kind: QaDeterministicCheckKind,
  criterionId: string | undefined,
): { checkIndex: number; kind: QaDeterministicCheckKind; criterionId?: string } {
  return criterionId !== undefined ? { checkIndex, kind, criterionId } : { checkIndex, kind };
}

function makeResult(
  base: { checkIndex: number; kind: QaDeterministicCheckKind; criterionId?: string },
  status: QaCheckStatus,
  detail: string,
  extra?: { evidence?: Record<string, unknown>; durationMs?: number },
): QaDeterministicCheckResult {
  return {
    ...base,
    status,
    detail,
    ...(extra?.evidence !== undefined ? { evidence: extra.evidence } : {}),
    ...(extra?.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
  };
}

// ── CHECK 1: fileExists ──────────────────────────────────────────────────────

async function runFileExistsCheck(
  workspaceRoot: string,
  checkIndex: number,
  def: FileExistsCheckDef,
): Promise<QaDeterministicCheckResult> {
  const base = baseResult(checkIndex, 'fileExists', def.criterionId);
  const resolved = resolveWorkspaceRelativePath(workspaceRoot, def.path);
  if (resolved.kind === 'blocked') return makeResult(base, 'BLOCKED', resolved.reason);
  const existing = await resolveExistingPathUnderRoot(workspaceRoot, resolved.absPath);
  if (existing.kind === 'blocked') return makeResult(base, 'BLOCKED', existing.reason);
  if (existing.kind === 'missing') return makeResult(base, 'FAIL', `파일이 존재하지 않습니다: ${def.path}`);
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(existing.real);
  } catch (err) {
    return makeResult(base, 'BLOCKED', `stat 실패: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stat.isFile()) return makeResult(base, 'FAIL', `일반 파일이 아닙니다: ${def.path}`);
  return makeResult(base, 'PASS', `파일이 존재합니다: ${def.path}`, { evidence: { byteLength: stat.size } });
}

// ── CHECK 2: fileExactContent ────────────────────────────────────────────────

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function firstMismatchIndex(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

function boundedSnippet(buf: Buffer, at: number): string {
  const start = Math.max(0, at - MISMATCH_SNIPPET_CONTEXT_BYTES);
  const end = Math.min(buf.length, at + MISMATCH_SNIPPET_CONTEXT_BYTES);
  return buf.subarray(start, end).toString('utf8');
}

async function runFileExactContentCheck(
  workspaceRoot: string,
  checkIndex: number,
  def: FileExactContentCheckDef,
): Promise<QaDeterministicCheckResult> {
  const base = baseResult(checkIndex, 'fileExactContent', def.criterionId);
  if (typeof def.expectedContent !== 'string') {
    return makeResult(base, 'BLOCKED', 'expectedContent는 문자열이어야 합니다.');
  }
  const resolved = resolveWorkspaceRelativePath(workspaceRoot, def.path);
  if (resolved.kind === 'blocked') return makeResult(base, 'BLOCKED', resolved.reason);
  const existing = await resolveExistingPathUnderRoot(workspaceRoot, resolved.absPath);
  if (existing.kind === 'blocked') return makeResult(base, 'BLOCKED', existing.reason);
  if (existing.kind === 'missing') return makeResult(base, 'FAIL', `파일이 존재하지 않습니다: ${def.path}`);

  let actual: Buffer;
  try {
    actual = await fsp.readFile(existing.real);
  } catch (err) {
    return makeResult(base, 'BLOCKED', `파일을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Byte-exact comparison — trailing newline is significant. A file that
  // differs from expectedContent only by a trailing newline is a mismatch
  // (FAIL), never normalized/stripped before comparing.
  const expected = Buffer.from(def.expectedContent, 'utf8');
  const expectedHash = sha256Hex(expected);
  const actualHash = sha256Hex(actual);
  if (actual.equals(expected)) {
    return makeResult(base, 'PASS', `내용이 바이트 단위로 일치합니다: ${def.path}`, {
      evidence: { expectedHash, actualHash, byteLength: actual.length },
    });
  }
  const mismatchIndex = firstMismatchIndex(actual, expected);
  return makeResult(base, 'FAIL', `내용이 일치하지 않습니다 (byte ${mismatchIndex}부터 불일치): ${def.path}`, {
    evidence: {
      expectedHash,
      actualHash,
      expectedByteLength: expected.length,
      actualByteLength: actual.length,
      mismatchIndex,
      // Bounded, non-secret context around the first differing byte —
      // never the full file contents.
      actualSnippet: boundedSnippet(actual, mismatchIndex),
      expectedSnippet: boundedSnippet(expected, mismatchIndex),
    },
  });
}

// ── process execution (shared by `command`/`diffScope`'s git status, and
// reused as-is by qa-semantic-evaluator.ts for the QA Agent's own dispatch —
// same shell:false/timeout/bounded-capture discipline, one implementation) ──

export interface ProcessOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  stderrTruncated: boolean;
  durationMs: number;
  spawnError?: string;
}

/** spawn(cmd, args, {cwd, shell:false}) with a bounded timeout and
 * bounded/truncated stdout+stderr capture. Never a shell string — argv
 * elements (including shell metacharacters) are passed through literally
 * and never interpreted, globbed, piped, or redirected by a shell. */
export function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PWD: cwd } });
    } catch (err) {
      resolve({
        exitCode: null,
        timedOut: false,
        stdout: '',
        stdoutTruncated: false,
        stderr: '',
        stderrTruncated: false,
        durationMs: Date.now() - start,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let stdout = '';
    let stdoutTruncated = false;
    let stderr = '';
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL'); // kill the timed-out process safely — never left running
      } catch {
        /* already exited */
      }
    }, timeoutMs);
    const appendBounded = (current: string, truncated: boolean, chunk: Buffer): [string, boolean] => {
      if (truncated) return [current, true];
      const next = current + chunk.toString('utf8');
      if (next.length > MAX_COMMAND_OUTPUT_CHARS) return [next.slice(0, MAX_COMMAND_OUTPUT_CHARS), true];
      return [next, false];
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      [stdout, stdoutTruncated] = appendBounded(stdout, stdoutTruncated, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      [stderr, stderrTruncated] = appendBounded(stderr, stderrTruncated, chunk);
    });
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        stdout,
        stdoutTruncated,
        stderr,
        stderrTruncated,
        durationMs: Date.now() - start,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };
    child.once('error', (err) => finish(null, err instanceof Error ? err.message : String(err)));
    child.once('close', (code) => finish(code));
  });
}

// ── CHECK 3: diffScope ───────────────────────────────────────────────────────

// Path normalization + porcelain parsing are shared with the dispatcher
// (workspace-diff-common.ts) so BOTH sides of the dispatch-time baseline
// protocol compare the SAME normalized shape — one copy, not two.

async function runGitStatusPorcelain(
  workspaceRoot: string,
): Promise<{ kind: 'ok'; paths: string[] } | { kind: 'blocked'; reason: string }> {
  const status = await runGitStatusZ(workspaceRoot);
  if (status.kind === 'error') return { kind: 'blocked', reason: status.reason };
  return { kind: 'ok', paths: status.paths };
}

function isPathWithinAllowed(changed: string, allowed: string): boolean {
  if (allowed === '' || allowed === '.') return true;
  return changed === allowed || changed.startsWith(`${allowed}/`);
}

function toPosixRelative(root: string, absPath: string): string {
  const rel = path.relative(path.resolve(root), absPath);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/** Bounded path listing for detail strings (never unbounded output). */
function formatPathSample(paths: string[]): string {
  const sample = paths.slice(0, 10);
  return sample.join(', ') + (paths.length > sample.length ? ` 외 ${paths.length - sample.length}개` : '');
}

/** Dispatch-time dirty-path snapshot written by the dispatcher
 * (workspace-baseline.json). Round 33+ shape `{ paths, entries, truncated?,
 * capturedAt }`: `entries` maps each path to the sha256 content digest of the
 * working-tree file at dispatch ("deleted" when it was already gone,
 * `oversize:<bytes>` when it exceeded the per-file hash cap — such a path is
 * NEVER excludable at QA time because byte equality above the cap cannot be
 * proven). A baseline WITHOUT content digests (round-32 array form, `{ paths }`
 * object, or round 36's `truncated: true` count-cap marker) falls back to the
 * round-32 path-only behavior — the diffScope detail notes
 * `baseline: path-only (legacy)` (with `, truncated` when marked). Absent
 * (older runs / capture unavailable) → legacy behavior. A PRESENT but malformed
 * baseline fails closed (BLOCKED) — a corrupt snapshot is never silently
 * trusted to hide out-of-scope changes. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

type LoadedBaseline =
  | { kind: 'ok'; mode: 'content'; paths: Set<string>; entries: Readonly<Record<string, string>>; truncated?: boolean }
  | { kind: 'ok'; mode: 'path-only-legacy'; paths: Set<string>; truncated?: boolean }
  | { kind: 'absent' }
  | { kind: 'blocked'; reason: string };

async function loadWorkspaceBaseline(runFolder: string): Promise<LoadedBaseline> {
  const baselinePath = path.join(runFolder, 'workspace-baseline.json');
  let raw: string;
  try {
    raw = await fsp.readFile(baselinePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'blocked', reason: `workspace-baseline.json을 읽을 수 없습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'blocked', reason: `workspace-baseline.json 파싱 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
  const paths = new Set<string>();
  // Adds a normalized path to the set. Returns false only for a HARD shape
  // violation (non-string) that must fail closed; empty/un-normalizable
  // entries are skipped the same way round-32 skipped them silently.
  const addNormalizedPath = (p: unknown): boolean => {
    if (typeof p !== 'string') return false;
    if (!p) return true;
    const norm = normalizeWorkspacePath(p);
    if (norm !== null) paths.add(norm);
    return true;
  };
  if (Array.isArray(parsed)) {
    // Round-32 array form → path-only legacy fallback.
    if (parsed.some((p) => !addNormalizedPath(p))) {
      return { kind: 'blocked', reason: 'workspace-baseline.json은 문자열 경로 배열이어야 합니다 (형식 오류 → fail closed).' };
    }
    return { kind: 'ok', mode: 'path-only-legacy', paths };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'blocked', reason: 'workspace-baseline.json은 문자열 경로 배열 또는 { paths, entries?, truncated?, capturedAt? } 객체여야 합니다 (형식 오류 → fail closed).' };
  }
  const obj = parsed as { paths?: unknown; entries?: unknown; truncated?: unknown };
  if (!Array.isArray(obj.paths) || obj.paths.some((p) => !addNormalizedPath(p))) {
    return { kind: 'blocked', reason: 'workspace-baseline.json 의 paths 는 문자열 경로 배열이어야 합니다 (형식 오류 → fail closed).' };
  }
  let truncated = false;
  if (obj.truncated !== undefined) {
    if (typeof obj.truncated !== 'boolean') {
      return { kind: 'blocked', reason: 'workspace-baseline.json 의 truncated 는 boolean 이어야 합니다 (형식 오류 → fail closed).' };
    }
    truncated = obj.truncated;
  }
  if (obj.entries === undefined) {
    // `{ paths }` object WITHOUT entries → round-32 path-only legacy fallback.
    return { kind: 'ok', mode: 'path-only-legacy', paths, ...(truncated ? { truncated: true } : {}) };
  }
  if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) {
    return { kind: 'blocked', reason: 'workspace-baseline.json 의 entries 는 { path: sha256 | "deleted" | "oversize:<bytes>" } 객체여야 합니다 (형식 오류 → fail closed).' };
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj.entries)) {
    const norm = normalizeWorkspacePath(key);
    if (
      norm === null ||
      typeof value !== 'string' ||
      !(value === 'deleted' || SHA256_HEX_RE.test(value) || isOversizeDigest(value))
    ) {
      return { kind: 'blocked', reason: 'workspace-baseline.json entries 는 { path: sha256 | "deleted" | "oversize:<bytes>" } 여야 합니다 (형식 오류 → fail closed).' };
    }
    entries[norm] = value;
  }
  if (truncated) {
    // Round 36 P1: a count-capped baseline skipped digests entirely at
    // dispatch → content matching would be meaningless; fall back to path-only
    // subtraction on the recorded (bounded) path list, visibly noted.
    return { kind: 'ok', mode: 'path-only-legacy', paths, truncated: true };
  }
  return { kind: 'ok', mode: 'content', paths, entries };
}

async function runDiffScopeCheck(
  workspaceRoot: string,
  runFolder: string,
  checkIndex: number,
  def: DiffScopeCheckDef,
): Promise<QaDeterministicCheckResult> {
  const base = baseResult(checkIndex, 'diffScope', def.criterionId);
  if (!Array.isArray(def.allowedPaths) || def.allowedPaths.some((p) => typeof p !== 'string')) {
    return makeResult(base, 'BLOCKED', 'allowedPaths는 문자열 배열이어야 합니다.');
  }
  const normalizedAllowed: string[] = [];
  for (const raw of def.allowedPaths) {
    const resolved = resolveWorkspaceRelativePath(workspaceRoot, raw);
    if (resolved.kind === 'blocked') {
      return makeResult(base, 'BLOCKED', `허용 경로가 workspace 상대 경로가 아닙니다: ${raw} (${resolved.reason})`);
    }
    normalizedAllowed.push(toPosixRelative(workspaceRoot, resolved.absPath));
  }
  const status = await runGitStatusPorcelain(workspaceRoot);
  if (status.kind === 'blocked') return makeResult(base, 'BLOCKED', status.reason);

  const baseline = await loadWorkspaceBaseline(runFolder);
  if (baseline.kind === 'blocked') return makeResult(base, 'BLOCKED', baseline.reason);
  const legacy = baseline.kind === 'ok' && baseline.mode === 'path-only-legacy';
  // Round 36 P1: a truncated (count-capped) baseline gets its own visible note
  // on top of the path-only-legacy disclosure.
  const legacyNote = legacy
    ? baseline.truncated === true
      ? ' baseline: path-only (legacy, truncated)'
      : ' baseline: path-only (legacy)'
    : '';

  const outOfScope: string[] = [];
  const preExisting: string[] = [];
  const modifiedPreExisting: string[] = [];
  for (const raw of status.paths) {
    const norm = normalizeWorkspacePath(raw);
    if (baseline.kind === 'ok' && norm !== null && baseline.paths.has(norm)) {
      if (baseline.mode === 'content') {
        const baselineDigest = baseline.entries[norm];
        // Round 33 content-aware: a path dirty NOW that was ALSO dirty at
        // dispatch is excluded ONLY when its working-tree content is provably
        // unchanged (same sha256, or both deleted). A digest that differs now,
        // or a path that never got a recorded digest (not a plain file), is
        // treated as changed by THIS run — a Builder must not be able to hide
        // an out-of-scope edit behind a file that merely was dirty already.
        // Round 36 P1: an `oversize:` digest on EITHER side proves nothing
        // (the file was above the hash cap, never fully read) — such a path
        // is NEVER excluded, always treated as changed by this run.
        if (baselineDigest !== undefined) {
          const currentDigest = await computeWorkspacePathDigest(workspaceRoot, norm);
          if (isOversizeDigest(baselineDigest) || isOversizeDigest(currentDigest ?? '')) {
            modifiedPreExisting.push(norm);
          } else if (currentDigest !== null && currentDigest === baselineDigest) {
            preExisting.push(norm);
            continue;
          } else {
            modifiedPreExisting.push(norm);
          }
        } else {
          modifiedPreExisting.push(norm);
        }
      } else {
        // path-only (legacy) baseline → round-32 behavior: subtracted
        // regardless of content (live defect, Phase B run 3 / TASK-0010).
        preExisting.push(norm);
        continue;
      }
    }
    // An unparseable/escaping raw path is never silently dropped — treat it
    // conservatively as an out-of-scope change (fail closed, never PASS).
    if (norm === null || !normalizedAllowed.some((a) => isPathWithinAllowed(norm, a))) {
      outOfScope.push(norm ?? raw);
    }
  }
  const preExistingNote =
    preExisting.length > 0 ? ` pre-existing (excluded): ${formatPathSample(preExisting)}` : '';
  const modifiedNote =
    modifiedPreExisting.length > 0
      ? ` pre-existing but modified by this run: ${formatPathSample(modifiedPreExisting)}`
      : '';
  const baselineEvidence =
    baseline.kind === 'ok'
      ? {
          baselineApplied: true,
          baselineMode: baseline.mode,
          ...(baseline.truncated === true ? { baselineTruncated: true } : {}),
          preExistingCount: preExisting.length,
          preExistingSample: preExisting.slice(0, 10),
          modifiedPreExistingCount: modifiedPreExisting.length,
          modifiedPreExistingSample: modifiedPreExisting.slice(0, 10),
        }
      : {};
  if (outOfScope.length > 0) {
    const sample = outOfScope.slice(0, 10);
    return makeResult(
      base,
      'FAIL',
      `허용되지 않은 경로가 변경되었습니다: ${formatPathSample(outOfScope)}${preExistingNote}${modifiedNote}${legacyNote}`,
      {
        evidence: {
          outOfScopeCount: outOfScope.length,
          outOfScopeSample: sample,
          changedCount: status.paths.length,
          ...baselineEvidence,
        },
      },
    );
  }
  const allPreExisting = preExisting.length > 0 && preExisting.length === status.paths.length;
  const passDetail =
    status.paths.length === 0
      ? 'workspace에 변경 사항이 없습니다 (clean).'
      : allPreExisting
        ? '이 Run이 변경한 경로가 없습니다 (변경 사항은 모두 dispatch 시점 baseline에 이미 존재).'
        : '변경된 모든 경로가 허용된 scope 내에 있습니다.';
  return makeResult(base, 'PASS', `${passDetail}${preExistingNote}${modifiedNote}${legacyNote}`, {
    evidence: { changedCount: status.paths.length, ...baselineEvidence },
  });
}

// ── CHECK 4: command ─────────────────────────────────────────────────────────

async function resolveCommandCwd(
  workspaceRoot: string,
  relCwd: string | undefined,
): Promise<{ kind: 'ok'; abs: string } | { kind: 'blocked'; reason: string }> {
  const resolved = resolveWorkspaceRelativePath(workspaceRoot, relCwd ?? '.');
  if (resolved.kind === 'blocked') return { kind: 'blocked', reason: resolved.reason };
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(resolved.absPath);
  } catch (err) {
    return { kind: 'blocked', reason: `cwd를 사용할 수 없습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!stat.isDirectory()) return { kind: 'blocked', reason: `cwd가 디렉터리가 아닙니다: ${relCwd}` };
  return { kind: 'ok', abs: resolved.absPath };
}

async function runCommandCheck(
  workspaceRoot: string,
  checkIndex: number,
  def: CommandCheckDef,
): Promise<QaDeterministicCheckResult> {
  const base = baseResult(checkIndex, 'command', def.criterionId);
  if (typeof def.command !== 'string' || !def.command.trim()) {
    return makeResult(base, 'BLOCKED', 'command가 비어 있지 않은 문자열이어야 합니다.');
  }
  if (!Array.isArray(def.args) || def.args.some((a) => typeof a !== 'string')) {
    return makeResult(base, 'BLOCKED', 'args는 문자열 배열이어야 합니다.');
  }
  const timeoutMs = def.timeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : def.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    return makeResult(base, 'BLOCKED', `timeoutMs가 유효하지 않습니다 (1..${MAX_COMMAND_TIMEOUT_MS}): ${String(def.timeoutMs)}`);
  }
  const expectExitCode = def.expectExitCode === undefined ? 0 : def.expectExitCode;
  if (typeof expectExitCode !== 'number' || !Number.isInteger(expectExitCode)) {
    return makeResult(base, 'BLOCKED', `expectExitCode가 유효하지 않습니다: ${String(def.expectExitCode)}`);
  }
  const cwdResolved = await resolveCommandCwd(workspaceRoot, def.cwd);
  if (cwdResolved.kind === 'blocked') return makeResult(base, 'BLOCKED', cwdResolved.reason);

  const outcome = await runProcess(def.command, def.args, cwdResolved.abs, timeoutMs);
  const evidence: Record<string, unknown> = {
    // argv/cwd are recorded for audit — reviewable proof of exactly what ran
    // and where, never a shell string (argv is passed to spawn verbatim).
    argv: [def.command, ...def.args],
    cwd: toPosixRelative(workspaceRoot, cwdResolved.abs),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    stdout: outcome.stdout,
    stdoutTruncated: outcome.stdoutTruncated,
    stderr: outcome.stderr,
    stderrTruncated: outcome.stderrTruncated,
  };
  if (outcome.spawnError) {
    return makeResult(base, 'BLOCKED', `명령 실행 실패: ${outcome.spawnError}`, {
      evidence: { ...evidence, spawnError: outcome.spawnError },
      durationMs: outcome.durationMs,
    });
  }
  if (outcome.timedOut) {
    return makeResult(base, 'BLOCKED', `명령이 시간 초과되었습니다 (${timeoutMs}ms)`, { evidence, durationMs: outcome.durationMs });
  }
  if (outcome.exitCode === null) {
    return makeResult(base, 'BLOCKED', '명령의 종료 코드를 확인할 수 없습니다.', { evidence, durationMs: outcome.durationMs });
  }
  if (outcome.exitCode !== expectExitCode) {
    return makeResult(base, 'FAIL', `종료 코드 불일치: expected=${expectExitCode} actual=${outcome.exitCode}`, {
      evidence,
      durationMs: outcome.durationMs,
    });
  }
  return makeResult(base, 'PASS', `종료 코드 일치 (exit ${outcome.exitCode})`, { evidence, durationMs: outcome.durationMs });
}

// ── dispatch + aggregation ───────────────────────────────────────────────────

function validateCheckKindsOrThrow(checks: unknown): asserts checks is QaDeterministicCheckDef[] {
  if (!Array.isArray(checks)) {
    throw new QaDeterministicEvaluatorError('INVALID_ARGUMENT', 'checks는 배열이어야 합니다.');
  }
  for (const c of checks) {
    const kind = (c as { kind?: unknown } | null)?.kind;
    if (!c || typeof c !== 'object' || !(QA_DETERMINISTIC_CHECK_KINDS as readonly string[]).includes(kind as string)) {
      throw new QaDeterministicEvaluatorError('INVALID_ARGUMENT', `허용되지 않은 deterministic check kind: ${String(kind)}`);
    }
    if (c.criterionId !== undefined && (typeof c.criterionId !== 'string' || !c.criterionId.trim())) {
      throw new QaDeterministicEvaluatorError('INVALID_ARGUMENT', `criterionId는 비어 있지 않은 문자열이어야 합니다: ${String(c.criterionId)}`);
    }
  }
}

async function runOneCheck(workspaceRoot: string, runFolder: string, checkIndex: number, def: QaDeterministicCheckDef): Promise<QaDeterministicCheckResult> {
  switch (def.kind) {
    case 'fileExists':
      return runFileExistsCheck(workspaceRoot, checkIndex, def);
    case 'fileExactContent':
      return runFileExactContentCheck(workspaceRoot, checkIndex, def);
    case 'diffScope':
      return runDiffScopeCheck(workspaceRoot, runFolder, checkIndex, def);
    case 'command':
      return runCommandCheck(workspaceRoot, checkIndex, def);
  }
}

/** BLOCKED > FAIL > PASS — fails closed (§8 aggregation). `INFO` results (not
 * produced by any Slice 2 check kind) never affect the aggregate. Never
 * SKIPPED — that sub-verdict is reserved for semantic evidence Slice 2 never
 * produces. */
export function aggregateDeterministicStatus(
  checks: QaDeterministicCheckResult[],
): Extract<QaSubVerdict, 'PASS' | 'FAIL' | 'BLOCKED'> {
  if (checks.some((c) => c.status === 'BLOCKED')) return 'BLOCKED';
  if (checks.some((c) => c.status === 'FAIL')) return 'FAIL';
  return 'PASS';
}

/** Every FAILed check contributes its `criterionId` to failedCriteria; a
 * FAILed check with no criterionId (a bare scope/infra guard, §6) falls
 * back to a synthetic `"{kind}#{checkIndex}"` identifier so failedCriteria
 * is never silently empty (Slice 1 requires it non-empty on FAIL) while
 * staying visibly distinct from a real AC id. */
function deriveFailedCriteria(checks: QaDeterministicCheckResult[]): string[] {
  const ids = new Set<string>();
  for (const c of checks) {
    if (c.status !== 'FAIL') continue;
    ids.add(c.criterionId ?? `${c.kind}#${c.checkIndex}`);
  }
  return [...ids];
}

// ── RUN / TASK VALIDATION ────────────────────────────────────────────────────

export interface QaRunBinding {
  workspaceRoot: string;
  /** Absolute path to the implementation Run's folder — e.g. to read its
   * result.md/agent-result.md (used by qa-semantic-evaluator.ts). */
  runFolder: string;
}

/**
 * Resolves the authoritative workspaceRoot + Run folder for this attempt's
 * Run, failing closed (never persisting anything) if the canonical binding
 * is broken: Task missing, Run not linked to that Task, no workspaceRoot
 * bound on the Run, or the Run's Result was never canonically captured
 * (mirrors completed-run-recovery.ts's own `evidence/adapter.json`
 * existence check — the same marker used there to decide a Result is
 * durably captured). Shared by both the deterministic and semantic
 * evaluators — the canonical-binding rule must never drift between them.
 */
export function resolveAuthoritativeRunBinding(dataRoot: string, project: string, attempt: QaAttemptRecord): QaRunBinding {
  let task;
  try {
    task = getTask(dataRoot, project, attempt.taskId);
  } catch {
    throw new QaDeterministicEvaluatorError('BLOCKED', `canonical Task를 찾을 수 없습니다: ${attempt.taskId}`);
  }
  const link = task.linkedRuns.find((r) => r.runId === attempt.runId);
  if (!link) {
    throw new QaDeterministicEvaluatorError('BLOCKED', `Run이 canonical Task에 연결되어 있지 않습니다: ${attempt.runId}`);
  }
  const meta = readRunMeta(link.folder);
  if (!meta.workspaceRoot) {
    throw new QaDeterministicEvaluatorError('BLOCKED', `Run에 authoritative workspaceRoot 바인딩이 없습니다: ${attempt.runId}`);
  }
  // Same "canonically captured" marker completed-run-recovery.ts uses.
  const evidencePath = path.join(link.folder, 'evidence', 'adapter.json');
  if (!fs.existsSync(evidencePath)) {
    throw new QaDeterministicEvaluatorError('BLOCKED', `Run의 Result가 아직 canonical하게 capture되지 않았습니다: ${attempt.runId}`);
  }
  return { workspaceRoot: meta.workspaceRoot, runFolder: link.folder };
}

// ── locking (mirrors qa-attempt.ts's per-attempt lock convention) ──────────
//
// Exported and reused by qa-semantic-evaluator.ts under the SAME key space —
// deterministic and semantic evaluation for one qaAttemptId must never run
// concurrently with each other either (semantic requires deterministic
// already PASS, so they're sequential by construction, but a shared lock
// closes any scheduling race between the two evaluators, not just within one).

const _evaluatorLocks = new Map<string, Promise<void>>();

function evaluatorLockKey(dataRoot: string, project: string, qaAttemptId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${qaAttemptId}`;
}

export function withQaEvaluatorLock<T>(dataRoot: string, project: string, qaAttemptId: string, fn: () => Promise<T>): Promise<T> {
  const key = evaluatorLockKey(dataRoot, project, qaAttemptId);
  const prev = _evaluatorLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _evaluatorLocks.set(
    key,
    work.then(() => undefined, () => undefined),
  );
  return work;
}

/** Test-only reset for the process-local evaluator lock chains. */
export function _resetQaDeterministicEvaluatorLocksForTests(): void {
  _evaluatorLocks.clear();
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface EvaluateDeterministicQaInput {
  qaAttemptId: string;
  /** Trusted fixture-materialized deterministic check contract (Slice 2 —
   * see module docstring; Slice 4 derives this from the frozen Task
   * qaContract instead of accepting it as a plain caller input). */
  checks: QaDeterministicCheckDef[];
}

export type QaDeterministicEvaluationOutcome =
  | { outcome: 'EVALUATED'; record: QaAttemptRecord }
  | { outcome: 'ALREADY_EVALUATED'; record: QaAttemptRecord };

/**
 * Evaluate the frozen deterministic checks for one PENDING QaAttemptRecord
 * and persist the result via Slice 1's own recordDeterministicEvidence/
 * completeQaAttempt — this function performs no persistence of its own.
 *
 * Idempotent: an attempt that already has deterministic evidence (whatever
 * its finalQaStatus — terminal FAIL/BLOCKED, or PASS-and-still-PENDING
 * awaiting Slice 3 semantic) is never re-evaluated; the existing record is
 * returned as ALREADY_EVALUATED without rerunning any check (no duplicate
 * command execution). Concurrent calls for the same qaAttemptId are
 * serialized by a process-local lock so at most one evaluation actually
 * runs the checks; the other observes the persisted result.
 *
 * Transition (§8): FAIL/BLOCKED finalizes immediately (already atomic
 * inside recordDeterministicEvidence — semantic QA is then structurally
 * unreachable, Slice 1's non-override invariant). PASS with no SEMANTIC/BOTH
 * AC configured completes PASS immediately with no LLM call. PASS with at
 * least one SEMANTIC/BOTH AC leaves the attempt PENDING, deterministic
 * evidence persisted, ready for Slice 3 — semantic evidence is never
 * fabricated here.
 */
export function evaluateDeterministicQa(
  dataRoot: string,
  project: string,
  input: EvaluateDeterministicQaInput,
): Promise<QaDeterministicEvaluationOutcome> {
  return withQaEvaluatorLock(dataRoot, project, input.qaAttemptId, async (): Promise<QaDeterministicEvaluationOutcome> => {
    // getQaAttempt propagates NOT_FOUND / CORRUPT_RECORD (correction 01)
    // untouched — this evaluator never treats a corrupt attempt as absent
    // or attempts to repair/recreate it.
    const attempt = getQaAttempt(dataRoot, project, input.qaAttemptId);
    if (attempt.deterministic !== undefined) {
      // Round 38 replay: reconcile the VERIFIED Evidence + attempt linkage
      // idempotently (the Evidence kernel dedupes on
      // `qa-attempt:{qaAttemptId}`, so no second record is ever written —
      // this only heals a crash between the evidence write and the linkage
      // persist), then re-read so the returned record reflects durable state.
      await recordQaAttemptVerifiedEvidence(dataRoot, project, attempt);
      return { outcome: 'ALREADY_EVALUATED', record: getQaAttempt(dataRoot, project, input.qaAttemptId) };
    }

    validateCheckKindsOrThrow(input.checks);
    const { workspaceRoot, runFolder } = resolveAuthoritativeRunBinding(dataRoot, project, attempt);

    const results: QaDeterministicCheckResult[] = [];
    for (let i = 0; i < input.checks.length; i += 1) {
      // Sequential, not parallel: command checks may have ordering-sensitive
      // side effects (e.g. build then test) and this keeps execution
      // trivially bounded/predictable — no concurrency surprises to reason
      // about beyond the top-level per-attempt lock.
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOneCheck(workspaceRoot, runFolder, i, input.checks[i]));
    }

    const status = aggregateDeterministicStatus(results);
    let afterDeterministic = await recordDeterministicEvidence(dataRoot, project, input.qaAttemptId, {
      status,
      checks: results,
      ...(status === 'FAIL' ? { failedCriteria: deriveFailedCriteria(results) } : {}),
    });

    // Round 38 — root-cause fix: the deterministic QA gate now mints exactly
    // one VERIFIED TEST/QA Evidence record per attempt (PASS/FAIL aggregates
    // only) through recordTestEvidence/recordQaEvidence, so a Task contract
    // requiring machine-level proof of the QA run is satisfiable. The write
    // runs BEFORE any completion so a final PASS/FAIL attempt is never
    // observable without its Evidence; replay never duplicates it (the
    // Evidence kernel dedupes on the `qa-attempt:{qaAttemptId}` sourceEventId).
    const evidenced = await recordQaAttemptVerifiedEvidence(dataRoot, project, afterDeterministic);
    afterDeterministic = evidenced.updatedAttempt ?? afterDeterministic;

    if (status !== 'PASS') {
      // recordDeterministicEvidence already finalized FAIL/BLOCKED in the
      // same call (Slice 1's structural non-override invariant) — semantic
      // QA is now structurally unreachable for this attempt.
      return { outcome: 'EVALUATED', record: afterDeterministic };
    }

    const needsSemantic = afterDeterministic.criteriaValidationModes
      ? Object.values(afterDeterministic.criteriaValidationModes).some((m) => m === 'SEMANTIC' || m === 'BOTH')
      : false;
    if (!needsSemantic) {
      const completed = await completeQaAttempt(dataRoot, project, input.qaAttemptId, { finalQaStatus: 'PASS' });
      return { outcome: 'EVALUATED', record: completed };
    }
    // One or more SEMANTIC/BOTH ACs configured — stays PENDING, deterministic
    // evidence persisted, ready for Slice 3. No semantic evidence fabricated.
    return { outcome: 'EVALUATED', record: afterDeterministic };
  });
}
