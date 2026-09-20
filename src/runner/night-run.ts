/**
 * Night-run controller — bounded overnight autonomy with a verifiable end.
 *
 * Two evaluation surfaces share one vocabulary (see lane-states.ts):
 *
 * - evaluateNightCompletion (in-memory aggregate): drives the daemon serve
 *   loop. Complete only when every lane rests in an explicit terminal
 *   outcome with no pending turns, no READY backlog, no retryable failures,
 *   and no unresolved QA fallbacks. Anything less keeps the night alive.
 * - evaluateStoreCompletion (durable store): powers `night-run status`
 *   from disk truth alone.
 *
 * Completion is recorded to LAST_RUN.json via buildNightSummary +
 * writeLastRun. The shutdown sequence refuses real effects unless that gate
 * passed; poweroff additionally requires host privilege. Dry-run rehearses
 * every step and changes nothing.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listPendingTurns, type TurnRecord } from './turn-store.js';
import { readLaneRun, type LaneRunRecord } from './lane-engine.js';
import { deriveLaneState, type LaneState } from './lane-states.js';

export const LAST_RUN_SCHEMA = 'night.last-run.v1';

/** Engine outcomes that end a lane for the night (nothing left to decide). */
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'ACCEPT_AND_ADVANCE',
  'MILESTONE_COMPLETE',
  'MILESTONE_REPORTED',
  'HUMAN_GATE_PARKED',
  'BLOCKED',
  'BLOCKED_CONTEXT',
  'BLOCKED_RUNTIME',
  'CHANGES_REWORK_EXHAUSTED',
]);

const TERMINAL_STATES: ReadonlySet<LaneState> = new Set([
  'DONE',
  'HUMAN_GATE',
  'BLOCKED',
  'BLOCKED_CONTEXT',
  'BLOCKED_PROVIDER',
  'BLOCKED_TRANSPORT',
]);

export interface NightLaneStatus {
  laneId: string;
  state: LaneState;
  taskId: string | null;
  outcome: LaneRunRecord['outcome'];
  reason: string | null;
  pendingTurns: number;
}

export interface NightCompletion {
  complete: boolean;
  lanes: NightLaneStatus[];
  reason: string;
  evaluatedAt: string;
}

export function nightDirFor(storeRoot: string): string {
  return path.join(path.dirname(path.resolve(storeRoot)), 'night-run');
}

export function lastRunPath(storeRoot: string): string {
  return path.join(nightDirFor(storeRoot), 'LAST_RUN.json');
}

// ── daemon serve-loop surface (in-memory aggregate) ─────────────────────────

export interface NightEvalInput {
  runs: Array<LaneRunRecord | null>;
  pendingTurns: TurnRecord[];
  readyByLane: Record<string, string[]>;
  retryable: TurnRecord[];
  pendingFallbacks: string[];
  recoverableFailures: string[];
}

export function evaluateNightCompletion(input: NightEvalInput): { complete: boolean; reason: string } {
  const open: string[] = [];
  for (const run of input.runs) {
    if (!run || !run.outcome || !TERMINAL_OUTCOMES.has(run.outcome)) {
      open.push(`${run?.laneId ?? '?'}: ${run?.outcome ?? (run ? run.phase : 'no-run')}`);
    }
  }
  if (input.pendingTurns.length > 0) open.push(`${input.pendingTurns.length} pending turn(s)`);
  const backlog = Object.entries(input.readyByLane)
    .filter(([, tasks]) => tasks.length > 0)
    .map(([lane, tasks]) => `${lane}:READY(${tasks.length})`);
  open.push(...backlog);
  if (input.retryable.length > 0) open.push(`${input.retryable.length} retryable failure(s)`);
  if (input.pendingFallbacks.length > 0) open.push(`pending QA fallback: ${input.pendingFallbacks.join(',')}`);
  if (input.recoverableFailures.length > 0) open.push(`recoverable: ${input.recoverableFailures.join(',')}`);
  return open.length === 0
    ? { complete: true, reason: 'all lanes terminal, no pending turns, no backlog, no retryables' }
    : { complete: false, reason: `open: ${open.join('; ')}` };
}

export interface LastRunRecord {
  schemaVersion: typeof LAST_RUN_SCHEMA;
  cycleId: string;
  startedAt: string;
  evaluatedAt: string;
  finishedAt: string;
  complete: boolean;
  reason: string;
  lanes: NightLaneStatus[];
  accepted: Array<{ laneId: string; taskId: string }>;
  changesLanes: string[];
  fallbacksUsed: string[];
  checkpointShas: Record<string, string | null>;
  runnerSha: string | null;
  errors: string[];
}

export function buildNightSummary(args: {
  cycleId: string;
  startedAt: string;
  lanes: Array<{ id: string; root: string }>;
  runs: Array<LaneRunRecord | null>;
  pendingTurns: TurnRecord[];
  readyByLane: Record<string, string[]>;
  retryable: TurnRecord[];
  pendingFallbacks: string[];
  recoverableFailures: string[];
  accepted: Array<{ laneId: string; taskId: string }>;
  changesLanes: string[];
  fallbacksUsed: string[];
  checkpointShas: Record<string, string | null>;
  errors: string[];
  runnerSha: string | null;
}): { summary: LastRunRecord } {
  const now = new Date().toISOString();
  const byRunId = new Map<string, TurnRecord[]>();
  for (const t of args.pendingTurns) {
    if (!t.runId) continue;
    const list = byRunId.get(t.runId) ?? [];
    list.push(t);
    byRunId.set(t.runId, list);
  }
  const lanes: NightLaneStatus[] = args.lanes.map((l) => {
    const run = args.runs.find((r) => r?.laneId === l.id) ?? null;
    const mine = run?.runId
      ? (byRunId.get(run.runId) ?? []).filter((t) => t.projectId === run.projectId)
      : [];
    return {
      laneId: l.id,
      state: deriveLaneState({ run, pendingTurns: mine, builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }),
      taskId: run?.taskId ?? null,
      outcome: run?.outcome ?? null,
      reason: run?.reason ?? null,
      pendingTurns: mine.length,
    };
  });
  const evalRes = evaluateNightCompletion({
    runs: args.runs,
    pendingTurns: args.pendingTurns,
    readyByLane: args.readyByLane,
    retryable: args.retryable,
    pendingFallbacks: args.pendingFallbacks,
    recoverableFailures: args.recoverableFailures,
  });
  return {
    summary: {
      schemaVersion: LAST_RUN_SCHEMA,
      cycleId: args.cycleId,
      startedAt: args.startedAt,
      evaluatedAt: now,
      finishedAt: now,
      complete: evalRes.complete,
      reason: evalRes.reason,
      lanes,
      accepted: args.accepted,
      changesLanes: args.changesLanes,
      fallbacksUsed: args.fallbacksUsed,
      checkpointShas: args.checkpointShas,
      runnerSha: args.runnerSha,
      errors: args.errors,
    },
  };
}

export function writeLastRun(storeRoot: string, summary: LastRunRecord): string {
  const dir = nightDirFor(storeRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = lastRunPath(storeRoot);
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(summary, null, 2)}\n`);
  fs.renameSync(tmpFile, file);
  return file;
}

export function readLastRun(storeRoot: string): LastRunRecord | null {
  try {
    const raw = fs.readFileSync(lastRunPath(storeRoot), 'utf8');
    const parsed = JSON.parse(raw) as LastRunRecord;
    if (parsed?.schemaVersion !== LAST_RUN_SCHEMA || typeof parsed.complete !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── CLI status surface (durable store) ──────────────────────────────────────

export function evaluateStoreCompletion(storeRoot: string, laneIds: string[]): NightCompletion {
  const evaluatedAt = new Date().toISOString();
  const pending = (() => {
    try {
      return listPendingTurns(storeRoot);
    } catch {
      return [];
    }
  })();
  const lanes: NightLaneStatus[] = laneIds.map((laneId) => {
    const run = readLaneRun(storeRoot, laneId);
    const mine = run ? pending.filter((t) => t.projectId === run.projectId && t.runId === run.runId) : [];
    const state = deriveLaneState({ run, pendingTurns: mine, builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] });
    return {
      laneId,
      state,
      taskId: run?.taskId ?? null,
      outcome: run?.outcome ?? null,
      reason: run?.reason ?? null,
      pendingTurns: mine.length,
    };
  });
  const open = lanes.filter((l) => !TERMINAL_STATES.has(l.state) || l.pendingTurns > 0);
  const complete = open.length === 0;
  return {
    complete,
    lanes,
    reason: complete
      ? `all ${lanes.length} lane(s) terminal with no pending turns`
      : `open: ${open.map((l) => `${l.laneId}=${l.state}${l.pendingTurns ? `+${l.pendingTurns}pending` : ''}`).join(', ')}`,
    evaluatedAt,
  };
}

// ── shutdown sequence ───────────────────────────────────────────────────────

export interface ShutdownRunner {
  name: string;
  alive: () => boolean;
  stop: () => Promise<string>;
}

export interface ShutdownStep {
  step: string;
  target?: string;
  mode: 'dry-run' | 'live';
  status: 'ok' | 'refused' | 'failed';
  detail: string;
}

export interface ShutdownResult {
  gatePassed: boolean;
  gateReason: string;
  steps: ShutdownStep[];
  ok: boolean;
}

/**
 * Ordered shutdown: gate → idle check → runner stops → optional poweroff.
 * Real (non-dry-run) shutdown refuses everything when the completion gate
 * has not passed. Poweroff additionally refuses without host privilege.
 * Dry-run evaluates and reports each step without changing anything.
 */
export async function runShutdownSequence(args: {
  storeRoot: string;
  laneIds: string[];
  dryRun: boolean;
  poweroff: boolean;
  runners: ShutdownRunner[];
  canPowerOff: () => { ok: boolean; reason: string };
  powerOffHost: () => { status: number; detail: string };
}): Promise<ShutdownResult> {
  const mode = args.dryRun ? 'dry-run' : 'live';
  const steps: ShutdownStep[] = [];
  const gate = readLastRun(args.storeRoot);
  const gatePassed = gate?.complete === true;
  const gateReason = gate
    ? `LAST_RUN ${gate.cycleId}: ${gate.complete ? 'complete' : 'incomplete'} (${gate.reason})`
    : 'no LAST_RUN.json: completion gate never evaluated';
  steps.push({ step: 'gate', mode, status: gatePassed ? 'ok' : 'refused', detail: gateReason });
  if (!args.dryRun && !gatePassed) {
    return { gatePassed, gateReason, steps, ok: false };
  }

  const completion = evaluateStoreCompletion(args.storeRoot, args.laneIds);
  const pendingTotal = completion.lanes.reduce((n, l) => n + l.pendingTurns, 0);
  steps.push({
    step: 'idle-check', mode,
    status: 'ok',
    detail: pendingTotal === 0
      ? `no pending turns across ${completion.lanes.length} lane(s)`
      : `${pendingTotal} pending turn(s) remain — durable, resume on next start (${completion.reason})`,
  });

  for (const r of args.runners) {
    if (args.dryRun) {
      steps.push({ step: 'stop-runner', target: r.name, mode, status: 'ok', detail: `would stop (alive=${r.alive()})` });
      continue;
    }
    try {
      const detail = await r.stop();
      steps.push({ step: 'stop-runner', target: r.name, mode, status: 'ok', detail });
    } catch (err) {
      steps.push({
        step: 'stop-runner', target: r.name, mode, status: 'failed',
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  if (args.poweroff) {
    const priv = args.canPowerOff();
    if (!priv.ok) {
      steps.push({ step: 'poweroff', mode, status: 'refused', detail: `POWER_OFF_PRIVILEGE_REQUIRED: ${priv.reason}` });
      return { gatePassed, gateReason, steps, ok: false };
    }
    if (args.dryRun) {
      steps.push({ step: 'poweroff', mode, status: 'ok', detail: `would power off host (${priv.reason})` });
    } else {
      const res = args.powerOffHost();
      steps.push({
        step: 'poweroff', mode,
        status: res.status === 0 ? 'ok' : 'failed',
        detail: res.detail,
      });
      if (res.status !== 0) return { gatePassed, gateReason, steps, ok: false };
    }
  }

  // Uniform gate truth: a refused step fails the sequence in both modes.
  // In dry-run that failure is the rehearsal proving the gate holds.
  const ok = steps.every((s) => s.status === 'ok');
  return { gatePassed, gateReason, steps, ok };
}
