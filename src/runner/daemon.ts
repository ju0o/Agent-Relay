/**
 * Runner daemon — the persistent autonomous service.
 *
 * Lifetime: own pidfile + lock under the store dir; survives SSH shell
 * exit when launched via systemd --user (unit shipped as
 * packaging/agent-relay-runner.service) or any other persistent host.
 * Restart recovery is structural: all progress lives in the turn store,
 * so a new process resumes by re-running advanceLane() — never by replay.
 *
 * Safety: tmux-pane sends (writes into live external sessions) happen ONLY
 * with explicit allowTmuxSends. Without it, tmux-bound lanes defer (audited
 * IN_PROGRESS) instead of touching foreign sessions.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LaneScheduler } from '../workspace/scheduler.js';
import type { LaneConfigV2 } from '../workspace/config-v2.js';
import { advanceLane, intakeNextTask, readLaneRun, type EngineBindings, type EngineSeams, type EngineStores, type IntakeSeams } from './lane-engine.js';
import type { BoundTransport } from './lane-engine.js';
import { clearTransportShutdown, requestTransportShutdown } from './transport.js';
import { requireOwnerGo } from './owner-go.js';

export interface DaemonOptions {
  storeRoot: string;
  lanes: LaneConfigV2[];
  projectId: string;
  correlationId: string;
  pollMs?: number;
  once?: boolean;
  maxTurnsPerAdvance?: number;
  resolveBindings: (lane: LaneConfigV2) => Promise<EngineBindings>;
  stores: EngineStores;
  seams: EngineSeams;
  scheduler?: LaneScheduler;
  turnTimeoutMs?: number;
  turnMaxAttempts?: number;
  allowTmuxSends?: boolean;
  ownerGoRequired?: boolean;
  /**
   * Empty-lane intake: when advanceLane finds no READY task and the Owner
   * GO allows new tasks, the Runner asks the project PM for the smallest
   * legitimate next task and performs canonical intake, then advances again
   * in the same pass. Never stops merely for lack of READY tasks.
   */
  intake?: {
    enabled: boolean;
    goalBrief?: string;
    goalBriefFor?: (lane: LaneConfigV2) => string;
    projectCurrentFor?: (lane: LaneConfigV2) => Promise<string>;
    seams: IntakeSeams;
  };
  audit?: (event: Record<string, unknown>) => void;
}

export function pidFile(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), 'runner.pid');
}

export function statusFile(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), 'status.json');
}

export function readPid(storeRoot: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile(storeRoot), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function writePid(storeRoot: string): void {
  fs.mkdirSync(path.resolve(storeRoot), { recursive: true });
  fs.writeFileSync(pidFile(storeRoot), `${process.pid}\n`, 'utf8');
}

function clearPid(storeRoot: string): void {
  try {
    if (readPid(storeRoot) === process.pid) fs.unlinkSync(pidFile(storeRoot));
  } catch { /* gone */ }
}

export interface RunnerStatusSnapshot {
  running: boolean;
  pid: number | null;
  lanes: Array<{
    laneId: string;
    phase: string;
    taskId: string | null;
    runId: string | null;
    attempt: number;
    outcome: string | null;
  }>;
  updatedAt: string;
}

export function readRunnerStatus(storeRoot: string, laneIds: string[]): RunnerStatusSnapshot {
  const pid = readPid(storeRoot);
  return {
    running: pid !== null,
    pid,
    lanes: laneIds.map((laneId) => {
      const rec = readLaneRun(storeRoot, laneId);
      return {
        laneId,
        phase: rec?.phase ?? 'IDLE',
        taskId: rec?.taskId ?? null,
        runId: rec?.runId ?? null,
        attempt: rec?.attempt ?? 0,
        outcome: rec?.outcome ?? null,
      };
    }),
    updatedAt: new Date().toISOString(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function serveOnce(opts: DaemonOptions): Promise<RunnerStatusSnapshot> {
  const scheduler = opts.scheduler ?? new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const laneIds = opts.lanes.map((l) => l.id);
  // Pass heartbeat FIRST: a pass blocked in long bounded collects still
  // proves liveness (consumers distinguish stuck-with-no-heartbeat from
  // waiting-inside-bounds).
  opts.audit?.({ ts: new Date().toISOString(), step: 'pass_start', lanes: laneIds });
  // Lanes advance CONCURRENTLY (shared scheduler): one lane's long-bounded
  // collect must never starve the others. Turn/store files are per-lane and
  // audit appends are atomic; the scheduler caps hold across lanes.
  await Promise.allSettled(opts.lanes.map(async (lane) => {
    let bindings: EngineBindings;
    try {
      bindings = await opts.resolveBindings(lane);
    } catch (err) {
      opts.audit?.({
        ts: new Date().toISOString(), laneId: lane.id, step: 'bind_error',
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!opts.allowTmuxSends) {
      const usesTmux = [bindings.pm, bindings.builder, bindings.qa, bindings.qaFallback]
        .filter(Boolean)
        .some((b) => (b as BoundTransport).transport.kind === 'tmux');
      if (usesTmux) {
        opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'tmux_deferred', reason: 'allowTmuxSends not set; lane deferred (no pane writes)' });
        return;
      }
    }
    try {
      let res = await advanceLane(lane, opts.stores, opts.seams, bindings as EngineBindings, scheduler, {
        storeRoot: opts.storeRoot,
        correlationId: opts.correlationId,
        projectId: opts.projectId,
        maxTurnsPerAdvance: opts.maxTurnsPerAdvance ?? 20,
        requireOwnerGo: opts.ownerGoRequired ?? false,
        turnTimeoutMs: opts.turnTimeoutMs,
        turnMaxAttempts: opts.turnMaxAttempts,
        audit: opts.audit,
      });
      opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'advance', outcome: res.outcome });
      if (res.outcome === 'NO_DISPATCHABLE_TASK' && opts.intake?.enabled) {
        try {
          if (opts.ownerGoRequired) {
            const goNow = requireOwnerGo(opts.storeRoot, lane.id, 'intake');
            const open = opts.stores.listOpenTaskIds ? opts.stores.listOpenTaskIds(lane).length : 0;
            if (open >= goNow.maxTasksPerLane) {
              opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'intake_deferred', reason: `GO task budget reached (${open}/${goNow.maxTasksPerLane})` });
              return;
            }
          }
          const ready = await intakeNextTask(lane, bindings.pm, opts.intake.seams, {
            storeRoot: opts.storeRoot,
            correlationId: opts.correlationId,
            projectId: opts.projectId,
            goalBrief: opts.intake.goalBriefFor ? opts.intake.goalBriefFor(lane) : (opts.intake.goalBrief ?? lane.goal),
            ...(opts.intake.projectCurrentFor ? { projectCurrent: () => opts.intake!.projectCurrentFor!(lane) } : {}),
            timeoutMs: opts.turnTimeoutMs,
            maxAttempts: opts.turnMaxAttempts,
            audit: opts.audit,
          });
          opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'intake', taskId: ready.taskId });
          res = await advanceLane(lane, opts.stores, opts.seams, bindings as EngineBindings, scheduler, {
            storeRoot: opts.storeRoot,
            correlationId: opts.correlationId,
            projectId: opts.projectId,
            maxTurnsPerAdvance: opts.maxTurnsPerAdvance ?? 20,
            requireOwnerGo: opts.ownerGoRequired ?? false,
            turnTimeoutMs: opts.turnTimeoutMs,
            turnMaxAttempts: opts.turnMaxAttempts,
            audit: opts.audit,
          });
          opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'advance', outcome: res.outcome });
        } catch (err) {
          opts.audit?.({
            ts: new Date().toISOString(), laneId: lane.id, step: 'intake_error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      // Shutdown aborts the whole pass immediately (no per-lane continue).
      if ((err as { code?: string } | null)?.code === 'SHUTDOWN_ABORT') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Delivery-deferred lanes (busy pane, lost wire) simply wait for the
      // next poll with the same REQUESTED turn — no failure recorded.
      const waiting = /DELIVERY_DEFERRED|NOT_IDLE|TRANSPORT_LOST|STALE_SESSION/.test(msg);
      opts.audit?.({
        ts: new Date().toISOString(), laneId: lane.id,
        step: waiting ? 'session_wait' : 'advance_error',
        ...(waiting ? { outcome: 'IN_PROGRESS' } : {}),
        error: waiting ? undefined : msg,
        ...(waiting ? { reason: msg.slice(0, 160) } : {}),
      });
    }
  }));
  const snap = readRunnerStatus(opts.storeRoot, laneIds);
  fs.writeFileSync(statusFile(opts.storeRoot), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  return snap;
}

export async function serve(opts: DaemonOptions): Promise<void> {
  const existing = readPid(opts.storeRoot);
  if (existing !== null) throw new Error(`runner already running (pid ${existing})`);
  writePid(opts.storeRoot);
  clearTransportShutdown();
  let stop = false;
  const onSignal = (): void => {
    stop = true;
    // Unblock in-flight collects at once: SIGTERM must complete WITHOUT
    // SIGKILL even mid-turn. Turns keep durable state and resume cleanly.
    requestTransportShutdown();
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    for (;;) {
      await serveOnce(opts);
      if (opts.once || stop) break;
      await sleep(opts.pollMs ?? 5000);
    }
  } finally {
    clearPid(opts.storeRoot);
  }
}

export function stopRunner(storeRoot: string): boolean {
  const pid = readPid(storeRoot);
  if (pid === null) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
