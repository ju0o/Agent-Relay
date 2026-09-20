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
  /** Cancel other READY tasks in scope after a successful intake (they are
   *  superseded by the new task and must never redispatch). */
  supersedeStaleReady?: (lane: LaneConfigV2, keepTaskId: string) => Promise<string[]>;
  /** Advance past terminal ACCEPT outcomes: archive the lane-run and start a
   *  fresh cycle (continuous night scheduling). Other terminals stay put. */
  autoContinue?: boolean;
  /**
   * Night mode: after every pass, evaluate NIGHT_RUN_COMPLETE. On completion
   * the summary is written, scheduling stops, and serve() returns (exit 0).
   * The machine power-off itself is a SEPARATE explicit step
   * (`night-run shutdown --poweroff`), never automatic here.
   */
  night?: { cycleId: string; startedAt: string };
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
    authoritativeFor?: (lane: LaneConfigV2) => Promise<{ ok: boolean; reason?: string }>;
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

/** Archive a terminally completed lane-run so a fresh cycle can begin. */
export function archiveLaneRun(storeRoot: string, laneId: string, outcome: string): string | null {
  const file = path.join(path.resolve(storeRoot), 'lane-runs', `${laneId}.json`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const dir = path.join(path.resolve(storeRoot), 'lane-runs', 'archive');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${laneId}-${stamp}-${outcome}.json`);
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}

/** Clear the intake marker so the next cycle re-proposes (bounded rounds). */
export function clearIntakeMarker(storeRoot: string, laneId: string): void {
  try {
    fs.unlinkSync(path.join(path.resolve(storeRoot), 'intake', `${laneId}.json`));
  } catch { /* absent is fine */ }
}

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
            ...(opts.intake.authoritativeFor ? { authoritative: () => opts.intake!.authoritativeFor!(lane) } : {}),
            timeoutMs: opts.turnTimeoutMs,
            maxAttempts: opts.turnMaxAttempts,
            audit: opts.audit,
          });
          if (!ready) {
            // Parked (HUMAN_GATE) or context-blocked: lane-run already holds
            // the terminal outcome; do not advance further this pass.
            opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'intake_parked' });
            return;
          }
          opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'intake', taskId: ready.taskId });
          if (opts.supersedeStaleReady) {
            try {
              const dropped = await opts.supersedeStaleReady(lane, ready.taskId);
              if (dropped.length) {
                opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'supersede', dropped, kept: ready.taskId });
              }
            } catch (err) {
              opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'supersede_error', error: err instanceof Error ? err.message : String(err) });
            }
          }
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
          if (res.outcome === 'ACCEPT_AND_ADVANCE' && opts.autoContinue) {
            // Continuous night scheduling: archive the completed cycle and
            // immediately begin the next (re-resolve current, next intake).
            // Other terminals (BLOCKED_*, HUMAN_GATE, exhausted) stay put.
            archiveLaneRun(opts.storeRoot, lane.id, res.outcome);
            clearIntakeMarker(opts.storeRoot, lane.id);
            opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, step: 'cycle_rollover', from: res.laneRun.taskId });
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
          }
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
      if (opts.night && await checkNightComplete(opts)) break;
      if (opts.once || stop) break;
      await sleep(opts.pollMs ?? 5000);
    }
  } finally {
    clearPid(opts.storeRoot);
  }
}

async function checkNightComplete(opts: DaemonOptions): Promise<boolean> {
  if (!opts.night) return false;
  try {
    const { evaluateNightCompletion, writeLastRun } = await import('./night-run.js');
    const { listTurns } = await import('./turn-store.js');
    const runs = opts.lanes.map((l) => readLaneRun(opts.storeRoot, l.id));
    const allTurns = listTurns(opts.storeRoot);
    const pending = allTurns.filter((t) => !['VERIFIED', 'FAILED'].includes(t.state));
    const readyByLane: Record<string, string[]> = {};
    for (const lane of opts.lanes) {
      try {
        readyByLane[lane.id] = opts.stores.listReadyTasks(lane)
          .filter((t) => t.executionState === 'READY').map((t) => t.taskId);
      } catch {
        readyByLane[lane.id] = [];
      }
    }
    const retryable = allTurns.filter((t) => t.state === 'FAILED' && t.transient && t.attempt < t.maxAttempts);
    // Task->lane map from active lane-runs for failure attribution.
    const laneOfTask = new Map<string, string>();
    for (const r of runs) {
      if (r?.taskId) laneOfTask.set(r.taskId, r.laneId);
    }
    const recoverable = [...new Set(retryable.map((t) => laneOfTask.get(t.taskId) ?? t.taskId))];
    const pendingFallbacks: string[] = [];
    for (const t of allTurns) {
      if (t.role !== 'qa' || t.state !== 'VERIFIED' || !t.resultBody) continue;
      let isUnavailable = false;
      try {
        const { parseQaTurn } = await import('./result-parse.js');
        isUnavailable = parseQaTurn(t.resultBody).verdict === 'QA_UNAVAILABLE';
      } catch { continue; }
      if (!isUnavailable) continue;
      const followed = allTurns.some((u) => u.role === 'qa' && u.taskId === t.taskId && u.runId === t.runId
        && u.attempt > t.attempt);
      if (!followed) {
        const lane = laneOfTask.get(t.taskId) ?? t.taskId;
        if (!pendingFallbacks.includes(lane)) pendingFallbacks.push(lane);
      }
    }
    const completion = evaluateNightCompletion({
      runs, pendingTurns: pending, readyByLane, retryable,
      pendingFallbacks, recoverableFailures: recoverable,
    });
    if (!completion.complete) return false;
    const { buildNightSummary } = await import('./night-run.js');
    const accepted = runs.filter((r) => r && /ACCEPT/.test(r.outcome ?? '')).map((r) => ({ laneId: r!.laneId, taskId: r!.taskId ?? '' }));
    const changesLanes = [...new Set(runs.filter((r) => (r?.attempt ?? 0) > 1).map((r) => r!.laneId))];
    const fallbacksUsed = [...new Set(runs.filter((r) => r?.qaMode.startsWith('fallback:')).map((r) => `${r!.laneId}:${r!.qaMode}`))];
    const checkpointShas: Record<string, string | null> = {};
    for (const lane of opts.lanes) {
      try {
        const { execFileSync } = await import('node:child_process');
        checkpointShas[lane.id] = execFileSync('git', ['-C', lane.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
      } catch {
        checkpointShas[lane.id] = null;
      }
    }
    const { summary } = buildNightSummary({
      cycleId: opts.night!.cycleId,
      startedAt: opts.night!.startedAt,
      lanes: opts.lanes.map((l) => ({ id: l.id, root: l.root })),
      runs, pendingTurns: pending, readyByLane, retryable, pendingFallbacks, recoverableFailures: recoverable,
      accepted, changesLanes, fallbacksUsed, checkpointShas, errors: [],
      runnerSha: await currentRunnerSha(),
    });
    const { writeLastRun: write } = await import('./night-run.js');
    write(opts.storeRoot, summary);
    opts.audit?.({ ts: new Date().toISOString(), step: 'night_complete', cycle: opts.night!.cycleId });
    return true;
  } catch (err) {
    // Evaluation itself must never kill the night: audit and continue.
    opts.audit?.({ ts: new Date().toISOString(), step: 'night_eval_error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

async function currentRunnerSha(): Promise<string | null> {
  try {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim() || null;
  } catch {
    return null;
  }
}

export function stopRunner(storeRoot: string): boolean {  const pid = readPid(storeRoot);
  if (pid === null) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
