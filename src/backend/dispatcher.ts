/**
 * Phase G + H — Explicit PM-controlled Worker Dispatcher.
 *
 * Owns READY→DISPATCHED and DISPATCHED→RUNNING.
 * Phase H: workspaceRoot + observationAdapterId + Capture arm before spawn +
 * observation concurrency lock. Worker never mutates canonical Task state.
 * No auto-dispatch / auto-retry / auto worker selection.
 * Restart does NOT guess FAILED — orphans are process-local ORPHAN_SUSPECTED.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deleteRun,
  atomicMaterializeRun,
  todayString,
  readRunMeta,
  writeRunMeta,
} from './fs.js';
import {
  getTask,
  linkRunToTask,
  listTasks,
  unlinkRunFromTaskByRunId,
} from './goal-task.js';
import {
  RuntimeConflictError,
  transitionTaskExecution,
} from './goal-task-runtime.js';
import {
  recordRunFailed,
  recordRuntimeError,
  recordRuntimeWarning,
} from './event.js';
import {
  loadWorkerRegistryRecord,
  listWorkerRegistryRecords,
  toPublicWorkerView,
  type WorkerRegistryPublicView,
  type ClaudePermissionMode,
  WorkerRegistryError,
} from './worker-registry.js';
import { getAdapter } from '../integrations/core/registry.js';
import { resolveClaudeConfigContext } from '../integrations/claude/profile.js';
import { ensureDispatchCaptureManager } from './capture-service.js';
import {
  tryAcquireObservationLock,
  releaseObservationLock,
  releaseObservationLockByBinding,
  bindObservationLockRunId,
  _resetObservationLocksForTests,
  type ObservationLockHandle,
  ObservationLockError,
} from './observation-lock.js';
import type { ExecutionBinding } from './result-bridge.js';
import type { TaskExecutionState, TaskRecord } from '../shared/types.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface DispatchRequest {
  taskId: string;
  workerId: string;
  expectedExecutionState: 'READY';
  /** Coding repository / Adapter observation scope — NOT Relay Run folder. */
  workspaceRoot: string;
  /**
   * V1-G5-C trusted internal retry correlation. ONLY the retry-dispatch
   * backend may set this; it is never accepted from MCP/host/owner surfaces.
   * When present the Dispatcher persists the correlation on the new Run meta
   * and pre-writes the backend-composed retry prompt (the Claude wrapper
   * recomputes the identical prompt via retry-prompt.js for its idempotent
   * prompt.md write). Ordinary initial dispatch omits this entirely.
   */
  retryContext?: {
    preparationId: string;
    sourceRunId: string;
    judgmentId: string;
    deliveryId: string;
    prompt: string;
  };
  /**
   * V1-G5-C correction trusted internal owner-approval context. ONLY
   * dispatchV1OwnerApproved sets this, using a fingerprint computed
   * server-side from the canonical Task BEFORE the initial dispatch. The
   * Dispatcher persists it on the initial RunMeta so a missing retry
   * authorization can be reconstructed without re-fingerprinting mutable
   * current Task state. Never accepted from PM/MCP/Worker/Adapter/retry
   * surfaces. Mutually exclusive with retryContext (a dispatch is either the
   * initial owner dispatch or an automatic retry).
   */
  ownerApprovalContext?: {
    scopeFingerprint: string;
  };
  /**
   * V1.6 Slice 4 trusted internal QA-remediation correlation. ONLY the QA
   * gate backend (qa-gate.ts) may set this; it is never accepted from
   * MCP/host/owner/PM/Worker/Adapter surfaces. When present the Dispatcher
   * persists the correlation on the new Run meta
   * (`qaRemediationPreparationId`, never `retryPreparationId`) and
   * pre-writes the backend-composed remediation prompt. Mutually exclusive
   * with retryContext/ownerApprovalContext: a dispatch is the initial owner
   * dispatch, a G5 CHANGES retry, or a QA remediation — never two at once,
   * so the two retry lineages stay durably distinct.
   */
  qaRemediationContext?: {
    preparationId: string;
    sourceRunId: string;
    prompt: string;
  };
}

export interface DispatchResult {
  taskId: string;
  runId: string;
  workerId: string;
  pid?: number;
  dispatchedAt: string;
  executionState: TaskExecutionState;
}

export type RecoveryStatus = 'ORPHAN_SUSPECTED';

export interface RecoveryRecord {
  taskId: string;
  canonicalExecutionState: TaskExecutionState;
  status: RecoveryStatus;
  detectedAt: string;
}

export interface ActiveDispatchRecord {
  taskId: string;
  runId?: string;
  workerId: string;
  pid?: number;
  dispatchedAt: string;
  phase: 'preparing' | 'dispatched' | 'running';
}

export interface DispatchStatusView {
  taskId: string;
  executionState?: TaskExecutionState;
  active?: ActiveDispatchRecord;
  recovery?: RecoveryRecord;
  dispatchBlocked: boolean;
}

export class DispatcherError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_STATE'
    | 'INVALID_ARGUMENT'
    | 'WORKER_UNAVAILABLE'
    | 'LAUNCH_FAILED'
    | 'ORPHAN_SUSPECTED'
    | 'INTERNAL_ERROR';

  constructor(code: DispatcherError['code'], message: string) {
    super(message);
    this.name = 'DispatcherError';
    this.code = code;
  }
}

// ── Process-local state ──────────────────────────────────────────────────────

interface LiveDispatch {
  key: string;
  dataRoot: string;
  project: string;
  taskId: string;
  runId?: string;
  workerId: string;
  pid?: number;
  child?: ChildProcess;
  dispatchedAt: string;
  phase: 'preparing' | 'dispatched' | 'running';
  exitHandled?: boolean;
  /** Process-local H observation lifecycle — never exposed in public dispatch result. */
  observationAdapterId?: string;
  workspaceRoot?: string;
  captureFolder?: string;
  observationLock?: ObservationLockHandle;
  /** Idempotent cleanup guard for capture disarm + observation lock release. */
  observationCleanupDone?: boolean;
}

/** In-memory live dispatches: key = resolve(dataRoot)@@project::taskId */
const activeDispatches = new Map<string, LiveDispatch>();

/** Process-local orphan / recovery registry — NOT Task SSOT.
 *  Key: resolve(dataRoot)@@project::taskId  */
const recoveryRegistry = new Map<string, RecoveryRecord>();

/** Optional spawn injection for tests. */
let spawnImpl: typeof spawn = spawn;

/** Optional hook after link / before READY→DISPATCHED CAS (tests only). */
let afterLinkHook: (() => Promise<void>) | null = null;

/** Optional hook after spawn success + exit listener / before DISPATCHED→RUNNING CAS (tests only). */
let afterSpawnHook: (() => Promise<void>) | null = null;

/** Lazy one-shot recovery keys already scanned: resolve(dataRoot)@@project */
const recoveryScanned = new Set<string>();

export function _setSpawnImplForTests(fn: typeof spawn | null): void {
  spawnImpl = fn ?? spawn;
}

export function _setAfterLinkHookForTests(fn: (() => Promise<void>) | null): void {
  afterLinkHook = fn;
}

export function _setAfterSpawnHookForTests(fn: (() => Promise<void>) | null): void {
  afterSpawnHook = fn;
}

export function _resetDispatcherStateForTests(): void {
  for (const live of activeDispatches.values()) {
    try {
      live.child?.removeAllListeners();
      if (live.child && live.child.exitCode === null && !live.child.killed) {
        live.child.kill();
      }
    } catch { /* ignore */ }
  }
  activeDispatches.clear();
  recoveryRegistry.clear();
  recoveryScanned.clear();
  spawnImpl = spawn;
  afterLinkHook = null;
  afterSpawnHook = null;
  _resetObservationLocksForTests();
}

/**
 * Narrow trusted helper — clear recovery registry entry after successful
 * owner-authorized orphan transition. Do NOT expose arbitrary mutation.
 */
export function clearRecoveryRecordTrusted(
  dataRoot: string,
  project: string,
  taskId: string,
): boolean {
  const key = dispatchKey(dataRoot, project, taskId);
  return recoveryRegistry.delete(key);
}

/** Validate workspaceRoot as observation scope (NOT Relay Run / dataRoot inference). */
export function validateWorkspaceRoot(workspaceRoot: unknown): string {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new DispatcherError('INVALID_ARGUMENT', 'workspaceRoot이(가) 필요합니다.');
  }
  const raw = workspaceRoot.trim();
  if (raw.includes('\0')) {
    throw new DispatcherError('INVALID_ARGUMENT', 'workspaceRoot must not contain NUL.');
  }
  if (!path.isAbsolute(raw)) {
    throw new DispatcherError('INVALID_ARGUMENT', 'workspaceRoot must be an absolute path.');
  }
  let resolved: string;
  try {
    resolved = path.resolve(raw);
  } catch {
    throw new DispatcherError('INVALID_ARGUMENT', 'workspaceRoot could not be resolved.');
  }
  if (!fs.existsSync(resolved)) {
    throw new DispatcherError('INVALID_ARGUMENT', `workspaceRoot does not exist: ${resolved}`);
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new DispatcherError('INVALID_ARGUMENT', `workspaceRoot is not accessible: ${resolved}`);
  }
  if (!st.isDirectory()) {
    throw new DispatcherError('INVALID_ARGUMENT', `workspaceRoot must be a directory: ${resolved}`);
  }
  return resolved;
}

async function ensureRecoveryScanned(dataRoot: string, project: string): Promise<void> {
  const key = `${path.resolve(dataRoot)}@@${project}`;
  if (recoveryScanned.has(key)) return;
  recoveryScanned.add(key);
  await initializeDispatcherRecovery(dataRoot, project);
}

/** Process-local dispatch key including canonical dataRoot to prevent cross-dataRoot collisions. */
function dispatchKey(dataRoot: string, project: string, taskId: string): string {
  return `${path.resolve(dataRoot)}@@${project}::${taskId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DispatcherError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function mapRegistryError(err: unknown): never {
  if (err instanceof WorkerRegistryError) {
    if (err.code === 'NOT_FOUND') {
      throw new DispatcherError('WORKER_UNAVAILABLE', err.message);
    }
    throw new DispatcherError(err.code === 'INVALID_STATE' ? 'INVALID_STATE' : 'INVALID_ARGUMENT', err.message);
  }
  throw err;
}

/**
 * Build Dispatcher-owned dynamic argv — never from Task narrative fields.
 *
 * Phase I: includes --workspaceRoot for the relay wrapper protocol.
 * The wrapper consumes it and uses it only as spawn cwd; it is never
 * forwarded directly as arbitrary Claude CLI syntax.
 *
 * Phase I correction: includes --permissionMode when worker registry specifies
 * a Claude driver permission mode. Only 'acceptEdits' is injected (by enum);
 * 'default' and absent mode are equivalent (no flag → least privilege).
 */
export function buildDispatchArgv(
  launchArgsPrefix: string[],
  binding: {
    dataRoot: string;
    project: string;
    taskId: string;
    runId: string;
    workspaceRoot?: string;
    /** Run-bound Claude config directory, derived only by Dispatcher. */
    claudeConfigDir?: string;
    /** Trusted worker registry permission mode — never from Task/Goal/PM narrative. */
    permissionMode?: ClaudePermissionMode;
  },
): string[] {
  const argv = [
    ...launchArgsPrefix,
    '--dataRoot', binding.dataRoot,
    '--project', binding.project,
    '--taskId', binding.taskId,
    '--runId', binding.runId,
  ];
  if (binding.workspaceRoot) {
    argv.push('--workspaceRoot', binding.workspaceRoot);
  }
  if (binding.claudeConfigDir) {
    argv.push('--claudeConfigDir', binding.claudeConfigDir);
  }
  // Only inject --permissionMode when explicitly set to 'acceptEdits'.
  // 'default' and absent are equivalent (no flag); omitting preserves least privilege.
  if (binding.permissionMode === 'acceptEdits') {
    argv.push('--permissionMode', 'acceptEdits');
  }
  return argv;
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Scan Tasks in DISPATCHED/RUNNING without a live process handle.
 * Marks ORPHAN_SUSPECTED in process-local registry only — never mutates executionState.
 */
export async function initializeDispatcherRecovery(
  dataRoot: string,
  project: string,
): Promise<RecoveryRecord[]> {
  const root = requireNonEmpty(dataRoot, 'dataRoot');
  const proj = requireNonEmpty(project, 'project');
  const created: RecoveryRecord[] = [];

  const tasks = listTasks(root, proj);
  for (const task of tasks) {
    if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') continue;
    const key = dispatchKey(root, proj, task.taskId);
    const live = activeDispatches.get(key);
    if (live && live.phase !== 'preparing' && live.child && live.child.exitCode === null) {
      continue; // live process present
    }
    // No live handle — orphan suspected (do NOT transition to FAILED)
    if (recoveryRegistry.has(key)) continue;
    const rec: RecoveryRecord = {
      taskId: task.taskId,
      canonicalExecutionState: task.executionState,
      status: 'ORPHAN_SUSPECTED',
      detectedAt: nowIso(),
    };
    recoveryRegistry.set(key, rec);
    created.push(rec);
    try {
      await recordRuntimeWarning(root, proj, {
        summary: `ORPHAN_SUSPECTED: Task ${task.taskId} is ${task.executionState} without a live Dispatcher process handle after recovery scan.`,
        taskId: task.taskId,
        goalId: task.goalId,
        source: { kind: 'dispatcher', subsystem: 'recovery' },
        details: {
          status: 'ORPHAN_SUSPECTED',
          executionState: task.executionState,
          detectedAt: rec.detectedAt,
        },
        sourceEventId: `orphan:${proj}:${task.taskId}:${rec.detectedAt}`,
      });
    } catch {
      // Event emission failure must not block recovery classification.
    }
  }
  return created;
}

export function isDispatchBlocked(dataRoot: string, project: string, taskId: string): boolean {
  return recoveryRegistry.has(dispatchKey(dataRoot, project, taskId));
}

export function getRecoveryRecord(dataRoot: string, project: string, taskId: string): RecoveryRecord | undefined {
  return recoveryRegistry.get(dispatchKey(dataRoot, project, taskId));
}

// ── Status / list ────────────────────────────────────────────────────────────

export function listActiveDispatches(project?: string): ActiveDispatchRecord[] {
  const out: ActiveDispatchRecord[] = [];
  for (const live of activeDispatches.values()) {
    if (project && live.project !== project) continue;
    if (live.phase === 'preparing' && !live.runId) {
      out.push({
        taskId: live.taskId,
        workerId: live.workerId,
        dispatchedAt: live.dispatchedAt,
        phase: live.phase,
      });
      continue;
    }
    out.push({
      taskId: live.taskId,
      runId: live.runId,
      workerId: live.workerId,
      pid: live.pid,
      dispatchedAt: live.dispatchedAt,
      phase: live.phase,
    });
  }
  return out;
}

export async function getDispatchStatus(
  dataRoot: string,
  project: string,
  taskId: string,
): Promise<DispatchStatusView> {
  await ensureRecoveryScanned(dataRoot, project);
  const id = requireNonEmpty(taskId, 'taskId');
  const key = dispatchKey(dataRoot, project, id);
  let executionState: TaskExecutionState | undefined;
  try {
    executionState = getTask(dataRoot, project, id).executionState;
  } catch {
    executionState = undefined;
  }
  const live = activeDispatches.get(key);
  const recovery = recoveryRegistry.get(key);
  const active = live
    ? {
        taskId: live.taskId,
        runId: live.runId,
        workerId: live.workerId,
        pid: live.pid,
        dispatchedAt: live.dispatchedAt,
        phase: live.phase,
      }
    : undefined;
  return {
    taskId: id,
    ...(executionState ? { executionState } : {}),
    ...(active ? { active } : {}),
    ...(recovery ? { recovery } : {}),
    dispatchBlocked: !!recovery || !!live,
  };
}

export function listWorkersPublic(dataRoot: string): WorkerRegistryPublicView[] {
  return listWorkerRegistryRecords(dataRoot).map(toPublicWorkerView);
}

// ── Observation lifecycle cleanup (idempotent) ───────────────────────────────

/**
 * Stop Dispatcher-bound Capture and release observation lock.
 * Safe to call multiple times (exit race vs Adapter completion / Result Bridge).
 * Does NOT mutate Task SSOT.
 */
async function cleanupObservationLifecycle(live: LiveDispatch): Promise<void> {
  if (live.observationCleanupDone) return;
  live.observationCleanupDone = true;

  const folder = live.captureFolder;
  try {
    if (folder) {
      const cm = ensureDispatchCaptureManager();
      await cm.disarm(folder).catch(() => undefined);
    }
  } catch { /* ignore */ }

  if (live.observationLock) {
    releaseObservationLock(live.observationLock);
    live.observationLock = undefined;
  } else if (live.observationAdapterId && live.workspaceRoot) {
    releaseObservationLockByBinding({
      observationAdapterId: live.observationAdapterId,
      workspaceRoot: live.workspaceRoot,
      taskId: live.taskId,
      ...(live.runId ? { runId: live.runId } : {}),
    });
  }
}

// ── Exit handling ────────────────────────────────────────────────────────────

async function handleChildExit(
  live: LiveDispatch,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  if (live.exitHandled) return;
  live.exitHandled = true;

  // Clear live process tracking
  const key = live.key;
  const still = activeDispatches.get(key);
  if (still === live) {
    activeDispatches.delete(key);
  }

  const exitCode = code ?? (signal ? 1 : 0);
  let task: TaskRecord;
  try {
    task = getTask(live.dataRoot, live.project, live.taskId);
  } catch {
    // Still release observation resources if Task record is gone.
    if (exitCode !== 0) {
      await cleanupObservationLifecycle(live);
    }
    return;
  }

  // Never set RESULT_RECEIVED / ACCEPTED from process exit.
  if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') {
    // Already terminal / advanced (e.g. FAILED via arm/spawn, or RESULT_RECEIVED via bridge).
    // Non-zero exit still must not leak observation slot if still held.
    if (exitCode !== 0) {
      await cleanupObservationLifecycle(live);
    }
    return;
  }

  if (exitCode !== 0) {
    try {
      await transitionTaskExecution(live.dataRoot, live.project, live.taskId, {
        expectedExecutionState: task.executionState,
        to: 'FAILED',
        reason: `worker process exit code=${exitCode}` + (signal ? ` signal=${signal}` : ''),
      });
    } catch {
      // CAS race — leave state as-is
    }
    try {
      await recordRunFailed(live.dataRoot, live.project, {
        summary: `Worker process exited non-zero for Task ${live.taskId} (code=${exitCode}).`,
        taskId: live.taskId,
        runId: live.runId,
        goalId: task.goalId,
        source: { kind: 'dispatcher', subsystem: 'process-exit' },
        details: { exitCode, signal, runId: live.runId, workerId: live.workerId },
      });
    } catch { /* ignore */ }

    // Non-zero: disarm capture + release observation lock (idempotent).
    await cleanupObservationLifecycle(live);
    return;
  }

  // Zero exit: clear process tracking only — no RESULT_RECEIVED, no FAILED,
  // and do NOT release observation lock (Adapter may still observe RESPONSE_COMPLETE).
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/** Atomic small-file write (tmp + rename) inside a Run folder. */
function writeFileAtomicText(folder: string, name: string, content: string): void {
  const filePath = path.join(folder, name);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup */ }
    throw err;
  }
}

async function rollbackPreCommitRun(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  folder: string,
): Promise<void> {
  try {
    await unlinkRunFromTaskByRunId(dataRoot, project, taskId, runId);
  } catch { /* may already be unlinked */ }
  try {
    deleteRun(folder);
  } catch { /* best effort */ }
}

// ── dispatchTask ─────────────────────────────────────────────────────────────

export async function dispatchTask(
  dataRoot: string,
  project: string,
  request: DispatchRequest,
): Promise<DispatchResult> {
  const root = requireNonEmpty(dataRoot, 'dataRoot');
  const proj = requireNonEmpty(project, 'project');
  const taskId = requireNonEmpty(request?.taskId, 'taskId');
  const workerId = requireNonEmpty(request?.workerId, 'workerId');

  if (request.expectedExecutionState !== 'READY') {
    throw new DispatcherError(
      'INVALID_ARGUMENT',
      `expectedExecutionState must be READY, got: ${String(request.expectedExecutionState)}`,
    );
  }

  // Phase H: workspaceRoot required + validated
  const workspaceRoot = validateWorkspaceRoot(request?.workspaceRoot);

  // V1-G5-C: trusted internal retry correlation (never from external callers).
  // V1.6 Slice 4: trusted internal QA-remediation correlation (same posture).
  const retryContext = request?.retryContext;
  const ownerApprovalContext = request?.ownerApprovalContext;
  const qaRemediationContext = request?.qaRemediationContext;
  const correlationCount = [retryContext, ownerApprovalContext, qaRemediationContext].filter((c) => c !== undefined).length;
  if (correlationCount > 1) {
    throw new DispatcherError(
      'INVALID_ARGUMENT',
      'retryContext, ownerApprovalContext, and qaRemediationContext are mutually exclusive.',
    );
  }
  if (retryContext !== undefined) {
    if (!retryContext || typeof retryContext !== 'object') {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext must be an object.');
    }
    if (typeof retryContext.preparationId !== 'string' || !/^RTP-PMJ-PMD-TASK-\d+-[A-Za-z0-9._-]+$/.test(retryContext.preparationId)) {
      throw new DispatcherError('INVALID_ARGUMENT', `잘못된 retry preparationId: ${String(retryContext.preparationId)}`);
    }
    if (typeof retryContext.sourceRunId !== 'string' || !retryContext.sourceRunId) {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext.sourceRunId가 필요합니다.');
    }
    if (typeof retryContext.judgmentId !== 'string' || !retryContext.judgmentId) {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext.judgmentId가 필요합니다.');
    }
    if (typeof retryContext.deliveryId !== 'string' || !retryContext.deliveryId) {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext.deliveryId가 필요합니다.');
    }
    if (typeof retryContext.prompt !== 'string' || !retryContext.prompt) {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext.prompt가 필요합니다.');
    }
    if (Buffer.byteLength(retryContext.prompt, 'utf8') > 16 * 1024) {
      throw new DispatcherError('INVALID_ARGUMENT', 'retryContext.prompt exceeds the 16 KiB Worker prompt cap.');
    }
  }
  if (ownerApprovalContext !== undefined) {
    if (!ownerApprovalContext || typeof ownerApprovalContext !== 'object') {
      throw new DispatcherError('INVALID_ARGUMENT', 'ownerApprovalContext must be an object.');
    }
    const fp = ownerApprovalContext.scopeFingerprint;
    if (typeof fp !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(fp)) {
      throw new DispatcherError('INVALID_ARGUMENT', `잘못된 ownerApprovedScopeFingerprint: ${String(fp)}`);
    }
  }
  if (qaRemediationContext !== undefined) {
    if (!qaRemediationContext || typeof qaRemediationContext !== 'object') {
      throw new DispatcherError('INVALID_ARGUMENT', 'qaRemediationContext must be an object.');
    }
    if (
      typeof qaRemediationContext.preparationId !== 'string'
      || !/^QRP-QA-TASK-\d+-[A-Za-z0-9._-]+$/.test(qaRemediationContext.preparationId)
    ) {
      throw new DispatcherError(
        'INVALID_ARGUMENT',
        `잘못된 QA remediation preparationId: ${String(qaRemediationContext.preparationId)}`,
      );
    }
    if (typeof qaRemediationContext.sourceRunId !== 'string' || !qaRemediationContext.sourceRunId) {
      throw new DispatcherError('INVALID_ARGUMENT', 'qaRemediationContext.sourceRunId가 필요합니다.');
    }
    if (typeof qaRemediationContext.prompt !== 'string' || !qaRemediationContext.prompt) {
      throw new DispatcherError('INVALID_ARGUMENT', 'qaRemediationContext.prompt가 필요합니다.');
    }
    if (Buffer.byteLength(qaRemediationContext.prompt, 'utf8') > 16 * 1024) {
      throw new DispatcherError('INVALID_ARGUMENT', 'qaRemediationContext.prompt exceeds the 16 KiB Worker prompt cap.');
    }
  }

  const key = dispatchKey(root, proj, taskId);

  // Lazy process-local orphan scan (never mutates Task SSOT; never guesses FAILED)
  await ensureRecoveryScanned(root, proj);

  // 1. Acquire per-task dispatch lock (synchronous claim)
  if (activeDispatches.has(key)) {
    throw new DispatcherError('CONFLICT', `CONFLICT: Task ${taskId} already has an active dispatch.`);
  }
  if (recoveryRegistry.has(key)) {
    throw new DispatcherError(
      'ORPHAN_SUSPECTED',
      `ORPHAN_SUSPECTED: Task ${taskId} is blocked from re-dispatch until owner recovery.`,
    );
  }

  const dispatchedAt = nowIso();
  const live: LiveDispatch = {
    key,
    dataRoot: root,
    project: proj,
    taskId,
    workerId,
    dispatchedAt,
    phase: 'preparing',
  };
  activeDispatches.set(key, live);

  let createdFolder: string | undefined;
  let createdRunId: string | undefined;
  let committedDispatch = false;
  let observationLock: ObservationLockHandle | undefined;
  let captureArmed = false;
  let observationAdapterId: string | undefined;
  let claudeConfigDir: string | undefined;

  try {
    // 2. Validate Task + READY
    let task: TaskRecord;
    try {
      task = getTask(root, proj, taskId);
    } catch {
      throw new DispatcherError('NOT_FOUND', `Task '${taskId}' 찾을 수 없습니다.`);
    }

    if (task.executionState !== 'READY') {
      throw new DispatcherError(
        'INVALID_STATE',
        `Task executionState must be READY to dispatch (found ${task.executionState}).`,
      );
    }

    // 3. Trusted worker registry + observation adapter resolution
    let worker;
    try {
      worker = loadWorkerRegistryRecord(root, workerId);
    } catch (err) {
      mapRegistryError(err);
    }

    observationAdapterId = worker.observationAdapterId?.trim();
    if (!observationAdapterId) {
      throw new DispatcherError(
        'WORKER_UNAVAILABLE',
        `Worker '${workerId}' has no observationAdapterId (required for H observed dispatch).`,
      );
    }
    // Ensure CaptureManager adapter registry is initialized, then validate.
    ensureDispatchCaptureManager();
    if (!getAdapter(observationAdapterId)) {
      throw new DispatcherError(
        'INVALID_ARGUMENT',
        `Unknown observation adapter '${observationAdapterId}' for worker '${workerId}'.`,
      );
    }

    // Resolve once, before Run persistence and capture arm. This is the
    // Worker launch context that must be shared with Claude observation.
    if (observationAdapterId === 'claude-code') {
      claudeConfigDir = resolveClaudeConfigContext(workspaceRoot).configDir;
    }

    // 4. workspaceRoot already validated above
    // 5. Acquire/reserve observation lock BEFORE any Run / DISPATCHED commitment.
    //    Contention → CONFLICT; Task remains READY; no Run; no spawn.
    try {
      observationLock = tryAcquireObservationLock({
        observationAdapterId,
        workspaceRoot,
        taskId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      activeDispatches.delete(key);
      if (err instanceof ObservationLockError) {
        throw new DispatcherError('CONFLICT', msg);
      }
      throw new DispatcherError('CONFLICT', msg);
    }
    live.observationAdapterId = observationAdapterId;
    live.workspaceRoot = workspaceRoot;
    live.observationLock = observationLock;

    // 6. Materialize NEW Run
    const agentLabel = `worker-${worker.workerId}`;
    const materialized = await atomicMaterializeRun(root, proj, todayString(), agentLabel);
    createdFolder = materialized.folder;
    createdRunId = materialized.runId;
    observationLock = bindObservationLockRunId(observationLock, createdRunId);
    live.observationLock = observationLock;
    live.runId = createdRunId;
    live.captureFolder = createdFolder;

    // Audit + G5-C binding: persist workspaceRoot on Run meta, plus the
    // authoritative workerId for this attempt and (retry only) the
    // preparation correlation BEFORE link so linkRunToTask preserves it.
    // The ORIGINAL owner-approved scope fingerprint is persisted only on the
    // initial owner dispatch (ownerApprovalContext); retry Runs never write
    // it, so they cannot redefine the original approval.
    // For Claude, claudeConfigDir is also the observer's authority boundary:
    // do not arm or spawn if the Run cannot durably retain that context.
    const meta = readRunMeta(createdFolder);
    writeRunMeta(createdFolder, {
      ...meta,
      workspaceRoot,
      workerId,
      ...(claudeConfigDir ? { claudeConfigDir } : {}),
      ...(retryContext
        ? { retryPreparationId: retryContext.preparationId, sourceRunId: retryContext.sourceRunId }
        : {}),
      ...(qaRemediationContext
        ? { qaRemediationPreparationId: qaRemediationContext.preparationId, sourceRunId: qaRemediationContext.sourceRunId }
        : {}),
      ...(ownerApprovalContext
        ? { ownerApprovedScopeFingerprint: ownerApprovalContext.scopeFingerprint }
        : {}),
    });

    // 7. Link Run to Task
    await linkRunToTask(root, proj, taskId, materialized.folder);

    if (afterLinkHook) {
      await afterLinkHook();
    }

    // 7b. Retry only: persist retry-context.json + backend-composed prompt.md
    // into the NEW Run folder (prior Runs untouched). Written pre-commit so a
    // CAS failure rolls the files back with the Run; post-commit failures
    // preserve them with the Run. The Claude wrapper recomputes the identical
    // prompt from retry-context.json (see retry-prompt.js).
    if (retryContext) {
      try {
        writeFileAtomicText(
          createdFolder,
          'retry-context.json',
          JSON.stringify(
            {
              schemaVersion: 1,
              preparationId: retryContext.preparationId,
              sourceRunId: retryContext.sourceRunId,
              taskId,
              judgmentId: retryContext.judgmentId,
              deliveryId: retryContext.deliveryId,
            },
            null,
            2,
          ) + '\n',
        );
        writeFileAtomicText(createdFolder, 'prompt.md', retryContext.prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await rollbackPreCommitRun(root, proj, taskId, createdRunId, createdFolder);
        createdFolder = undefined;
        createdRunId = undefined;
        live.captureFolder = undefined;
        live.runId = undefined;
        if (observationLock) {
          releaseObservationLock(observationLock);
          observationLock = undefined;
          live.observationLock = undefined;
        }
        throw new DispatcherError('INTERNAL_ERROR', `Retry context persist failed: ${msg}`);
      }
    }

    // 7c. QA remediation only: persist qa-remediation-context.json +
    // backend-composed prompt.md into the NEW Run folder. A SEPARATE file
    // from retry-context.json (never both — the correlations are mutually
    // exclusive above) so the two lineages stay distinguishable on disk:
    // retry-context.json always means GPT PM CHANGES lineage,
    // qa-remediation-context.json always means QA FAIL lineage.
    if (qaRemediationContext) {
      try {
        writeFileAtomicText(
          createdFolder,
          'qa-remediation-context.json',
          JSON.stringify(
            {
              schemaVersion: 1,
              preparationId: qaRemediationContext.preparationId,
              qaRemediationPreparationId: qaRemediationContext.preparationId,
              sourceRunId: qaRemediationContext.sourceRunId,
              taskId,
            },
            null,
            2,
          ) + '\n',
        );
        writeFileAtomicText(createdFolder, 'prompt.md', qaRemediationContext.prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await rollbackPreCommitRun(root, proj, taskId, createdRunId, createdFolder);
        createdFolder = undefined;
        createdRunId = undefined;
        live.captureFolder = undefined;
        live.runId = undefined;
        if (observationLock) {
          releaseObservationLock(observationLock);
          observationLock = undefined;
          live.observationLock = undefined;
        }
        throw new DispatcherError('INTERNAL_ERROR', `QA remediation context persist failed: ${msg}`);
      }
    }

    // 8. CAS READY → DISPATCHED  ← commitment
    try {
      task = await transitionTaskExecution(root, proj, taskId, {
        expectedExecutionState: 'READY',
        to: 'DISPATCHED',
        reason: `dispatch:${workerId}`,
      });
    } catch (err) {
      // Pre-commit failure → rollback new Run + release observation reservation
      await rollbackPreCommitRun(root, proj, taskId, createdRunId, createdFolder);
      createdFolder = undefined;
      createdRunId = undefined;
      live.captureFolder = undefined;
      live.runId = undefined;
      if (observationLock) {
        releaseObservationLock(observationLock);
        observationLock = undefined;
        live.observationLock = undefined;
      }
      if (err instanceof RuntimeConflictError) {
        throw new DispatcherError('CONFLICT', err.message);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('CONFLICT')) {
        throw new DispatcherError('CONFLICT', msg);
      }
      throw new DispatcherError('INVALID_STATE', msg);
    }

    committedDispatch = true;
    live.phase = 'dispatched';

    // 9. Arm CaptureManager against SAME Run (post-commit)
    const executionBinding: ExecutionBinding = {
      dataRoot: root,
      project: proj,
      goalId: task.goalId,
      taskId,
      runId: createdRunId,
    };

    try {
      const cm = ensureDispatchCaptureManager();
      await cm.arm(createdFolder, observationAdapterId, {
        folder: createdFolder,
        isDraft: false,
        workspaceRoot,
        ...(claudeConfigDir ? { claudeConfigDir } : {}),
        executionBinding,
      });
      captureArmed = true;
    } catch (err) {
      // Post-commit arm failure: DISPATCHED → FAILED, preserve Run, release observation, no spawn
      await cleanupObservationLifecycle(live);
      observationLock = undefined;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await transitionTaskExecution(root, proj, taskId, {
          expectedExecutionState: 'DISPATCHED',
          to: 'FAILED',
          reason: `capture arm failure: ${msg}`,
        });
      } catch { /* ignore */ }
      try {
        await recordRuntimeError(root, proj, {
          summary: `RUN_FAILED: Capture arm failed for Task ${taskId}; Run preserved; no spawn.`,
          taskId,
          runId: createdRunId,
          goalId: task.goalId,
          source: { kind: 'dispatcher', subsystem: 'capture-arm' },
          details: { workerId, observationAdapterId, error: msg },
        });
      } catch { /* ignore */ }
      activeDispatches.delete(key);
      throw new DispatcherError('LAUNCH_FAILED', `Capture arm failed: ${msg}`);
    }

    // 9. Spawn child process (shell:false mandatory)
    // Phase I: pass workspaceRoot to relay wrapper protocol so wrapper can
    // use it as spawn cwd for Claude. Never forwarded as arbitrary CLI syntax.
    // Phase I correction: pass permissionMode from trusted worker registry only.
    // Task/Goal/PM narrative cannot supply or override this value.
    const permissionMode = worker.driverOptions?.claude?.permissionMode;
    const argv = buildDispatchArgv(worker.launchArgsPrefix, {
      dataRoot: root,
      project: proj,
      taskId,
      runId: createdRunId,
      workspaceRoot,
      ...(claudeConfigDir ? { claudeConfigDir } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    });

    const spawnOpts: Parameters<typeof spawn>[2] = {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    };
    if (worker.workingDirectory) {
      spawnOpts.cwd = worker.workingDirectory;
    }

    let child: ChildProcess;
    try {
      child = spawnImpl(worker.launchCommand, argv, spawnOpts);
    } catch (err) {
      // Known spawn failure after DISPATCHED — preserve Run, CAS → FAILED
      const msg = err instanceof Error ? err.message : String(err);
      await cleanupObservationLifecycle(live);
      observationLock = undefined;
      try {
        await transitionTaskExecution(root, proj, taskId, {
          expectedExecutionState: 'DISPATCHED',
          to: 'FAILED',
          reason: `spawn failure: ${msg}`,
        });
      } catch { /* ignore */ }
      try {
        await recordRuntimeError(root, proj, {
          summary: `LAUNCH_FAILED: spawn threw for Task ${taskId}: ${msg}`,
          taskId,
          runId: createdRunId,
          goalId: task.goalId,
          source: { kind: 'dispatcher', subsystem: 'spawn' },
          details: { workerId, error: msg },
        });
      } catch { /* ignore */ }
      activeDispatches.delete(key);
      throw new DispatcherError('LAUNCH_FAILED', `Spawn failed: ${msg}`);
    }

    // spawn() is sync for creating the handle; 'error' event signals launch failure
    const launchError = await new Promise<Error | null>((resolve) => {
      let settled = false;
      const onError = (e: Error) => {
        if (settled) return;
        settled = true;
        resolve(e);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
      child.once('error', onError);
      // Node emits 'spawn' on successful OS spawn (Node 15.1+)
      child.once('spawn', onSpawn);
      // Fallback: if already spawned with pid and no immediate error
      if (typeof child.pid === 'number' && child.pid > 0) {
        // Give error event a tick to fire for nonexistent executables on some platforms
        setImmediate(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        });
      } else {
        setTimeout(() => {
          if (!settled) {
            settled = true;
            // No pid and no spawn event — treat as failure
            resolve(new Error('Process spawn produced no pid'));
          }
        }, 50);
      }
    });

    if (launchError) {
      await cleanupObservationLifecycle(live);
      observationLock = undefined;
      try {
        await transitionTaskExecution(root, proj, taskId, {
          expectedExecutionState: 'DISPATCHED',
          to: 'FAILED',
          reason: `spawn failure: ${launchError.message}`,
        });
      } catch { /* ignore */ }
      try {
        await recordRunFailed(root, proj, {
          summary: `LAUNCH_FAILED: could not start worker for Task ${taskId}.`,
          taskId,
          runId: createdRunId,
          goalId: task.goalId,
          source: { kind: 'dispatcher', subsystem: 'spawn' },
          details: { workerId, error: launchError.message },
        });
      } catch { /* ignore */ }
      activeDispatches.delete(key);
      throw new DispatcherError('LAUNCH_FAILED', `Spawn failed: ${launchError.message}`);
    }

    // Spawn confirmed: install exit listener before yielding to event loop.
    live.child = child;
    live.pid = child.pid;
    child.on('exit', (code, signal) => {
      void handleChildExit(live, code, signal);
    });

    // Test-only hook: runs after child is tracked + exit listener installed,
    // before DISPATCHED→RUNNING CAS. Allows tests to inject a state race.
    if (afterSpawnHook) {
      await afterSpawnHook();
    }

    // 10. Spawn success → Dispatcher CAS DISPATCHED → RUNNING
    try {
      task = await transitionTaskExecution(root, proj, taskId, {
        expectedExecutionState: 'DISPATCHED',
        to: 'RUNNING',
        reason: `spawned:${workerId}:pid=${child.pid ?? 'unknown'}`,
      });
      live.phase = 'running';
    } catch (err) {
      // Process is alive and tracked, but RUNNING CAS failed (concurrent state change).
      // Keep child in activeDispatches — exit handler is installed and WILL clean up.
      // Emit a durable RUNTIME_WARNING so operators can observe the ambiguity.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await recordRuntimeWarning(root, proj, {
          summary: `DISPATCH_RUNNING_CAS_FAILED: worker process pid=${child.pid ?? 'unknown'} spawned for Task ${taskId} but DISPATCHED→RUNNING CAS failed. Child is tracked; manual review required.`,
          taskId,
          runId: createdRunId,
          goalId: task.goalId,
          source: { kind: 'dispatcher', subsystem: 'spawn' },
          details: {
            reason: 'DISPATCH_RUNNING_CAS_FAILED',
            workerId,
            pid: child.pid,
            casError: msg,
            runId: createdRunId,
          },
        });
      } catch {
        // Event emission failure must NOT lose child tracking or mask the CAS conflict.
      }
      throw new DispatcherError('CONFLICT', `Spawned but RUNNING transition failed: ${msg}`);
    }

    // Do NOT release observation lock merely after spawn success — held until
    // trusted capture terminal (RESPONSE_COMPLETE / non-response persist) or non-zero exit.
    void captureArmed;

    // 11. Safe result — no folder / path / launchCommand
    return {
      taskId,
      runId: createdRunId,
      workerId,
      pid: child.pid,
      dispatchedAt,
      executionState: task.executionState,
    };
  } catch (err) {
    if (!committedDispatch && createdFolder && createdRunId) {
      await rollbackPreCommitRun(root, proj, taskId, createdRunId, createdFolder);
    }
    if (!committedDispatch && observationLock) {
      releaseObservationLock(observationLock);
      live.observationLock = undefined;
    }
    if (activeDispatches.get(key)?.phase === 'preparing') {
      activeDispatches.delete(key);
    }
    if (err instanceof DispatcherError) throw err;
    if (err instanceof RuntimeConflictError) {
      throw new DispatcherError('CONFLICT', err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new DispatcherError('INTERNAL_ERROR', msg);
  }
}

/** Path helper used by tests to assert trusted registry root. */
export function trustedWorkersRoot(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '_relay', 'workers');
}
