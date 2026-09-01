/**
 * Phase G — Explicit PM-controlled Worker Dispatcher.
 *
 * Owns READY→DISPATCHED and DISPATCHED→RUNNING.
 * Worker never mutates canonical Task state.
 * No auto-dispatch / auto-retry / auto worker selection.
 * Restart does NOT guess FAILED — orphans are process-local ORPHAN_SUSPECTED.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import {
  deleteRun,
  atomicMaterializeRun,
  todayString,
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
  WorkerRegistryError,
} from './worker-registry.js';
import type { TaskExecutionState, TaskRecord } from '../shared/types.js';

// ── Public types ─────────────────────────────────────────────────────────────

export interface DispatchRequest {
  taskId: string;
  workerId: string;
  expectedExecutionState: 'READY';
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
}

/** In-memory live dispatches: key = project::taskId */
const activeDispatches = new Map<string, LiveDispatch>();

/** Process-local orphan / recovery registry — NOT Task SSOT. */
const recoveryRegistry = new Map<string, RecoveryRecord>();

/** Optional spawn injection for tests. */
let spawnImpl: typeof spawn = spawn;

/** Optional hook after link / before READY→DISPATCHED CAS (tests only). */
let afterLinkHook: (() => Promise<void>) | null = null;

export function _setSpawnImplForTests(fn: typeof spawn | null): void {
  spawnImpl = fn ?? spawn;
}

export function _setAfterLinkHookForTests(fn: (() => Promise<void>) | null): void {
  afterLinkHook = fn;
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
  spawnImpl = spawn;
  afterLinkHook = null;
}

function dispatchKey(project: string, taskId: string): string {
  return `${project}::${taskId}`;
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

/** Build Dispatcher-owned dynamic argv — never from Task narrative fields. */
export function buildDispatchArgv(
  launchArgsPrefix: string[],
  binding: { dataRoot: string; project: string; taskId: string; runId: string },
): string[] {
  return [
    ...launchArgsPrefix,
    '--dataRoot', binding.dataRoot,
    '--project', binding.project,
    '--taskId', binding.taskId,
    '--runId', binding.runId,
  ];
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
    const key = dispatchKey(proj, task.taskId);
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

export function isDispatchBlocked(project: string, taskId: string): boolean {
  return recoveryRegistry.has(dispatchKey(project, taskId));
}

export function getRecoveryRecord(project: string, taskId: string): RecoveryRecord | undefined {
  return recoveryRegistry.get(dispatchKey(project, taskId));
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

export function getDispatchStatus(
  dataRoot: string,
  project: string,
  taskId: string,
): DispatchStatusView {
  const id = requireNonEmpty(taskId, 'taskId');
  const key = dispatchKey(project, id);
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
    return;
  }

  // Never set RESULT_RECEIVED / ACCEPTED from process exit.
  if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') {
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
    return;
  }

  // Zero exit: clear tracking only — no RESULT_RECEIVED, no FAILED guess.
}

// ── Rollback ─────────────────────────────────────────────────────────────────

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

  const key = dispatchKey(proj, taskId);

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

    // 3. Orphan block already checked
    // 4. Trusted worker registry
    let worker;
    try {
      worker = loadWorkerRegistryRecord(root, workerId);
    } catch (err) {
      mapRegistryError(err);
    }

    // 5. Materialize NEW Run
    const agentLabel = `worker-${worker.workerId}`;
    const materialized = await atomicMaterializeRun(root, proj, todayString(), agentLabel);
    createdFolder = materialized.folder;
    createdRunId = materialized.runId;

    // 6. Link Run to Task
    await linkRunToTask(root, proj, taskId, materialized.folder);
    live.runId = createdRunId;

    if (afterLinkHook) {
      await afterLinkHook();
    }

    // 7. CAS READY → DISPATCHED
    try {
      task = await transitionTaskExecution(root, proj, taskId, {
        expectedExecutionState: 'READY',
        to: 'DISPATCHED',
        reason: `dispatch:${workerId}`,
      });
    } catch (err) {
      // 8. CAS failure → rollback new Run only
      await rollbackPreCommitRun(root, proj, taskId, createdRunId, createdFolder);
      createdFolder = undefined;
      createdRunId = undefined;
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

    // 9. Spawn child process (shell:false mandatory)
    const argv = buildDispatchArgv(worker.launchArgsPrefix, {
      dataRoot: root,
      project: proj,
      taskId,
      runId: createdRunId,
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

    live.child = child;
    live.pid = child.pid;
    child.on('exit', (code, signal) => {
      void handleChildExit(live, code, signal);
    });

    // 10. Spawn success → Dispatcher CAS DISPATCHED → RUNNING
    try {
      task = await transitionTaskExecution(root, proj, taskId, {
        expectedExecutionState: 'DISPATCHED',
        to: 'RUNNING',
        reason: `spawned:${workerId}:pid=${child.pid ?? 'unknown'}`,
      });
      live.phase = 'running';
    } catch (err) {
      // Process is running but CAS failed — keep handle; surface conflict
      const msg = err instanceof Error ? err.message : String(err);
      throw new DispatcherError('CONFLICT', `Spawned but RUNNING transition failed: ${msg}`);
    }

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
