/**
 * Durable lane engine — automatic PM → Builder → QA → PM handoff with
 * crash recovery. All progress lives in the turn store on disk; the engine
 * itself holds no state, so a Runner/process restart simply calls
 * advanceLane() again and resumes from the durable phase:
 *
 * - turns already VERIFIED are reused (Builder never re-executes,
 *   QA/PM turns never duplicate)
 * - SENT/RUNNING turns are re-collected by their requestId boundary
 *   (no re-send, no new turn)
 * - RESULT_RECEIVED turns advance the handoff without transport contact
 *
 * Transport timeouts become FAILED(transient) turns; retries mint a NEW
 * attempt turn (attempt+1, new requestId) up to maxAttempts. Task state is
 * never lost: every attempt is preserved in history.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LaneConfigV2 } from '../workspace/config-v2.js';
import type { LaneScheduler } from '../workspace/scheduler.js';
import {
  createTurn,
  latestTurnFor,
  listTurns,
  readTurn,
  transitionTurn,
  type TurnRecord,
  type TurnRole,
} from './turn-store.js';
import { DeliveryDeferredError, type CollectResult, type TurnSession, type TurnTransport } from './transport.js';
import { parseBuilderTurn, parseBuilderTurnLenient, parsePmTurn, parseQaTurn, parseTaskProposal, routeForTaskType, assertExecutableContract, type ExecutableEnvelope, type TaskProposal, type TaskType } from './result-parse.js';
import { gitHeadSha } from './project-current.js';
import { requireOwnerGo } from './owner-go.js';
import { recordSessionFailure, resetSessionHealth } from './session-health.js';
import { assertQaIndependent, buildVerificationPacket } from '../workspace/verification-packet.js';
import { assertLaneBinding } from '../workspace/lane-runner.js';

export type LanePhase =
  | 'PM_TURN'
  | 'BUILD_TURN'
  | 'QA_TURN'
  | 'PM_REVIEW'
  | 'DONE';

export type LaneEngineOutcome =
  | 'ACCEPT_AND_ADVANCE'
  | 'CHANGES_REWORK_EXHAUSTED'
  | 'BLOCKED'
  | 'BLOCKED_RUNTIME'
  | 'BLOCKED_CONTEXT'
  | 'HUMAN_GATE_PARKED'
  | 'MILESTONE_COMPLETE'
  | 'MILESTONE_REPORTED'
  | 'NO_DISPATCHABLE_TASK'
  | 'WAITING_FOR_SLOT'
  | 'PM_TURN_DEFERRED'
  | 'IN_PROGRESS';

export interface LaneRunRecord {
  laneRunId: string;
  correlationId: string;
  laneId: string;
  projectId: string;
  taskId: string | null;
  runId: string | null;
  attempt: number;
  phase: LanePhase;
  outcome: LaneEngineOutcome | null;
  reason: string | null;
  qaMode: string;
  /** Task route (§5): 'full' runs Builder, 'review' goes PM→QA→PM. */
  route: 'full' | 'review';
  /** §4 executable envelope (set at intake; null for legacy READY tasks). */
  envelope: ExecutableEnvelope | null;
  updatedAt: string;
}

export function patchLaneRun(storeRoot: string, laneId: string, patch: Partial<LaneRunRecord>): LaneRunRecord | null {
  const rec = readLaneRun(storeRoot, laneId);
  if (!rec) return null;
  return writeLaneRun(storeRoot, { ...rec, ...patch });
}

export interface TaskView {
  taskId: string;
  executionState: string;
  pmState: string;
  goal?: string;
  scope?: string;
}

export interface BoundTransport {
  transport: TurnTransport;
  session: TurnSession;
  sessionId: string;
}

export interface EngineStores {
  listReadyTasks(lane: LaneConfigV2): TaskView[];
  readTask(lane: LaneConfigV2, taskId: string): TaskView | null;
  /** All open (non-ACCEPTED) task ids in lane scope — GO task-budget gate. */
  listOpenTaskIds?(lane: LaneConfigV2): string[];
  taskContract(lane: LaneConfigV2, taskId: string): unknown;
  acceptanceCriteria(lane: LaneConfigV2, taskId: string): unknown;
}

export interface EngineSeams {
  dispatch(lane: LaneConfigV2, task: TaskView): Promise<{ runId: string }>;
  accept(
    lane: LaneConfigV2,
    task: TaskView,
    runId: string,
    ctx?: { envelope: ExecutableEnvelope | null; route: 'full' | 'review' },
  ): Promise<void>;
  nextTask(lane: LaneConfigV2, task: TaskView): Promise<{ taskId: string } | null>;
}

export interface EngineBindings {
  pm: BoundTransport;
  /** Null when no healthy session matches the configured Builder runtime:
   *  phases up to dispatch proceed; the build waits (never improvises). */
  builder: BoundTransport | null;
  /** Null when no healthy session matches the configured QA runtime:
   *  verified results wait for QA instead of self-certifying. */
  qa: BoundTransport | null;
  qaFallback?: BoundTransport;
  /** Health check for a fallback runtime label (default: installed). */
  detectQaRuntime?: (runtime: string) => { installed: boolean };
  /** Resolve a live session for a fallback runtime label (or null). */
  resolveSession?: (runtime: string) => BoundTransport | null;
}

export interface EngineOptions {
  storeRoot: string;
  scheduler: LaneScheduler;
  maxTurnsPerAdvance?: number;
  maxReworks?: number;
  turnTimeoutMs?: number;
  turnMaxAttempts?: number;
  audit?(event: Record<string, unknown>): void;
}

function laneRunPath(storeRoot: string, laneId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(laneId)) throw new Error(`bad laneId: ${laneId}`);
  return path.join(path.resolve(storeRoot), 'lane-runs', `${laneId}.json`);
}

function atomicWrite(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readLaneRun(storeRoot: string, laneId: string): LaneRunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(laneRunPath(storeRoot, laneId), 'utf8')) as LaneRunRecord;
  } catch {
    return null;
  }
}

function writeLaneRun(storeRoot: string, rec: LaneRunRecord): LaneRunRecord {
  atomicWrite(laneRunPath(storeRoot, rec.laneId), { ...rec, updatedAt: new Date().toISOString() });
  return rec;
}

function slug(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 48);
}

function rand(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8);
}

function lineageRequestId(taskId: string, role: TurnRole, runId: string, attempt: number, scope = ''): string {
  return `turn-${slug(taskId)}-${role}-${slug(runId)}-a${attempt}${scope ? `-${slug(scope)}` : ''}`;
}

function maxAttempt(storeRoot: string, projectId: string, taskId: string, role: TurnRole, runId: string | null): number {
  let m = 0;
  for (const t of listTurns(storeRoot)) {
    if (t.projectId === projectId && t.taskId === taskId && t.role === role && (runId === null || t.runId === runId)) {
      m = Math.max(m, t.attempt);
    }
  }
  return m;
}

export interface ExecutedTurn {
  turn: TurnRecord;
  text: string;
}

/**
 * Execute (or resume) one role turn to VERIFIED. Dedupe rules:
 * - a VERIFIED turn for (task, role, runId[, scope]) is reused outright —
 *   the transport is never touched again for it;
 * - otherwise the attempt number is max(existing)+1 with a DETERMINISTIC
 *   requestId, so a re-entered phase after a restart resumes the SAME
 *   pending turn (collect by boundary) instead of minting a duplicate;
 * - transport timeouts fail the turn transiently and loop to a fresh
 *   attempt, up to maxAttempts. Task state is never lost.
 */
export async function executeTurn(
  storeRoot: string,
  identity: { projectId: string; taskId: string; runId: string; correlationId: string },
  role: TurnRole,
  body: string,
  bound: BoundTransport,
  opts: { timeoutMs: number; maxAttempts: number; scope?: string; audit?: EngineOptions['audit'] },
): Promise<ExecutedTurn> {
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    opts.audit?.({ ts: new Date().toISOString(), role, taskId: identity.taskId, step, ...extra });
  const scope = opts.scope ?? '';
  const reused = verifiedTurn(storeRoot, identity.taskId, role, identity.runId, identity.projectId);
  if (reused && (scope === '' || reused.requestId.endsWith(`-${scope}`))) {
    log('turn_reuse', { turnId: reused.turnId, attempt: reused.attempt });
    return { turn: reused, text: reused.resultBody! };
  }
  // Crash-window resume: a non-terminal turn for this lineage (any attempt)
  // is resumed in place — never duplicated, never re-sent from scratch.
  const pending = listTurns(storeRoot)
    .filter((t) => t.projectId === identity.projectId && t.taskId === identity.taskId && t.role === role && t.runId === identity.runId
      && (t.state === 'REQUESTED' || t.state === 'SENT' || t.state === 'RUNNING' || t.state === 'RESULT_RECEIVED'))
    .sort((a, b) => b.attempt - a.attempt)[0];
  let turn: TurnRecord;
  if (pending) {
    turn = pending;
    log('turn_resume', { turnId: turn.turnId, state: turn.state, attempt: turn.attempt });
  } else {
    const attempt = maxAttempt(storeRoot, identity.projectId, identity.taskId, role, identity.runId) + 1;
    if (attempt > opts.maxAttempts) {
      throw new Error(`TURN_ATTEMPTS_EXHAUSTED: ${role} ${identity.taskId} after ${opts.maxAttempts} attempts`);
    }
    turn = createTurn(storeRoot, {
      projectId: identity.projectId,
      taskId: identity.taskId,
      runId: identity.runId,
      role,
      requestId: lineageRequestId(identity.taskId, role, identity.runId, attempt, scope),
      correlationId: identity.correlationId,
      attempt,
      timeoutMs: opts.timeoutMs,
      maxAttempts: opts.maxAttempts,
      requestBody: body,
    });
    log('turn', { state: turn.state, attempt: turn.attempt, resumed: false, target: bound.session.target });
  }
  for (;;) {
    try {
      if (turn.state === 'REQUESTED') {
        try {
          await bound.transport.sendTurn(turn, bound.session);
        } catch (sendErr) {
          const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          // Delivery never landed (busy/dead pane, lost wire): defer WITHOUT
          // a FAILED record and WITHOUT consuming the content-attempt budget.
          // The next poll retries the same REQUESTED turn.
          if (/NOT_IDLE|TRANSPORT_LOST/.test(msg)) throw new DeliveryDeferredError(msg);
          throw sendErr;
        }
        turn = transitionTurn(storeRoot, turn.turnId, 'SENT', { expected: 'REQUESTED' });
      }
      if (turn.state === 'SENT') {
        turn = transitionTurn(storeRoot, turn.turnId, 'RUNNING', { expected: 'SENT' });
      }
      if (turn.state === 'RUNNING') {
        const col: CollectResult = await bound.transport.collectTurn(turn, bound.session, turn.timeoutMs);
        if (col.requestId !== turn.requestId) throw new Error('TRANSPORT_IDENTITY_MISMATCH');
        turn = transitionTurn(storeRoot, turn.turnId, 'RESULT_RECEIVED', {
          expected: 'RUNNING', resultBody: col.text,
        });
      }
      if (turn.state === 'RESULT_RECEIVED') {
        if (!turn.resultBody || !turn.resultBody.trim()) {
          throw new Error('TURN_EMPTY_RESULT');
        }
        turn = transitionTurn(storeRoot, turn.turnId, 'VERIFIED', { expected: 'RESULT_RECEIVED' });
        try { resetSessionHealth(storeRoot, bound.sessionId); } catch { /* best-effort */ }
        return { turn, text: turn.resultBody! };
      }
      // A VERIFIED turn with usable body (resumed path).
      if (turn.state === 'VERIFIED' && turn.resultBody && turn.resultBody.trim()) {
        return { turn, text: turn.resultBody };
      }
      throw new Error(`TURN_UNUSABLE_STATE: ${turn.state}`);
    } catch (err) {
      // Delivery deferrals and shutdown aborts propagate untouched: no
      // FAILED record, no budget. The next start resumes the same turn.
      const code = (err as { code?: string } | null)?.code;
      if (code === 'DELIVERY_DEFERRED' || code === 'SHUTDOWN_ABORT') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      // Endpoint-attributable failures feed quarantine (frozen/dead panes
      // stop counting as ACTIVE after repeated failures); a later VERIFIED
      // turn resets the session. Parse/content errors do not (agent spoke).
      if (/TRANSPORT_LOST|TURN_TIMEOUT|NOT_IDLE|TURN_NO_BOUNDARY/.test(msg)) {
        try {
          const h = recordSessionFailure(storeRoot, bound.sessionId, msg);
          log('session_health', { session: bound.sessionId, failures: h.failures, quarantined: h.quarantined });
        } catch { /* health best-effort */ }
      }
      const retryable = /TURN_TIMEOUT|TURN_NO_BOUNDARY|TURN_EMPTY_RESULT|TRANSPORT_LOST/.test(msg);
      try {
        turn = transitionTurn(storeRoot, turn.turnId, 'FAILED', { error: msg, transient: retryable });
      } catch {
        // Already terminal — re-read current state below.
        turn = readTurn(storeRoot, turn.turnId);
      }
      log('turn_failed', { error: msg.slice(0, 200), retryable });
      if (!retryable) throw err;
      // Mint the next attempt explicitly (never spin on a terminal record).
      const attempt = maxAttempt(storeRoot, identity.projectId, identity.taskId, role, identity.runId) + 1;
      if (attempt > opts.maxAttempts) {
        throw new Error(`TURN_ATTEMPTS_EXHAUSTED: ${role} ${identity.taskId} after ${opts.maxAttempts} attempts`);
      }
      turn = createTurn(storeRoot, {
        projectId: identity.projectId,
        taskId: identity.taskId,
        runId: identity.runId,
        role,
        requestId: lineageRequestId(identity.taskId, role, identity.runId, attempt, scope),
        correlationId: identity.correlationId,
        attempt,
        timeoutMs: opts.timeoutMs,
        maxAttempts: opts.maxAttempts,
        requestBody: body,
      });
      log('turn_retry', { attempt: turn.attempt, turnId: turn.turnId });
    }
  }
}

/** Resume-only read: the newest VERIFIED turn for this lineage, if any. */
export function verifiedTurn(
  storeRoot: string,
  taskId: string,
  role: TurnRole,
  runId: string | null,
  projectId?: string,
): TurnRecord | null {
  const hits = listTurns(storeRoot).filter(
    (t) => t.taskId === taskId && t.role === role && t.state === 'VERIFIED'
      && (runId === null || t.runId === runId)
      && (projectId === undefined || t.projectId === projectId)
      && t.resultBody && t.resultBody.trim(),
  );
  return hits.length ? hits[hits.length - 1]! : null;
}

export const PM_EXPECT = /^[•>*\-\s]*(DISPATCH|REQUEST_CHANGES|ACCEPT|HUMAN_GATE|MILESTONE_COMPLETE)\b/m;
export const BUILDER_EXPECT = /RESULT_PACKET/;
export const QA_EXPECT = /^[•>*\-\s]*(QA_PASS|QA_CHANGES|QA_UNAVAILABLE)\b/m;

export interface AdvanceResult {
  outcome: LaneEngineOutcome;
  laneRun: LaneRunRecord;
}

type AuditFn = (step: string, extra?: Record<string, unknown>) => void;
type CountFn = () => void;

/**
 * Collect-then-parse with stale-partial recovery: if a VERIFIED turn's body
 * fails to parse (premature collect of a still-streaming reply), the partial
 * record is preserved but superseded (VERIFIED->FAILED, audited) and a fresh
 * attempt collects the now-complete reply. Bounded by the caller's turn
 * budget (countTurn) and the transport attempt budget.
 */
async function collectParsed<T>(
  storeRoot: string,
  run: () => Promise<ExecutedTurn>,
  parse: (text: string) => T,
  log: AuditFn,
  countTurn: CountFn,
): Promise<{ value: T; turn: TurnRecord }> {
  for (;;) {
    const { turn, text } = await run();
    try {
      return { value: parse(text), turn };
    } catch (err) {
      countTurn();
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await transitionTurn(storeRoot, turn.turnId, 'FAILED', {
          error: `STALE_PARTIAL: ${msg.slice(0, 160)}`,
          transient: true,
        });
      } catch {
        // Already terminal superseded elsewhere; retry anyway (bounded).
      }
      log('stale_partial', { turnId: turn.turnId, error: msg.slice(0, 160) });
    }
  }
}

/**
 * Advance one lane by at most maxTurnsPerAdvance transport turns.
 * Pure function of (durable store + lane + bindings): safe to call after
 * any restart; completed phases are never re-executed.
 */
export async function advanceLane(
  lane: LaneConfigV2,
  stores: EngineStores,
  seams: EngineSeams,
  bindings: EngineBindings,
  scheduler: LaneScheduler,
  opts: {
    storeRoot: string;
    correlationId: string;
    projectId: string;
    maxTurnsPerAdvance?: number;
    maxReworks?: number;
    turnTimeoutMs?: number;
    turnMaxAttempts?: number;
    /**
     * When true, every tmux send and every dispatch/intake first requires a
     * covering Owner GO (fail-closed). Dry/test runs leave it false.
     */
    requireOwnerGo?: boolean;
    audit?: EngineOptions['audit'];
  },
): Promise<AdvanceResult> {
  const { storeRoot, correlationId, projectId } = opts;
  const maxTurns = opts.maxTurnsPerAdvance ?? 20;
  const maxReworks = opts.maxReworks ?? 2;
  const tTimeout = opts.turnTimeoutMs ?? 60000;
  const tAttempts = opts.turnMaxAttempts ?? 3;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, correlationId, step, ...extra });
  let transportTurns = 0;
  const countTurn = () => {
    transportTurns += 1;
    if (transportTurns > maxTurns) throw new Error('LANE_TURN_BUDGET_EXHAUSTED');
  };

  let rec = readLaneRun(storeRoot, lane.id);
  if (!rec) {
    rec = writeLaneRun(storeRoot, {
      laneRunId: `lrun-${Date.now().toString(36)}${rand()}`,  // rand: distinct lanes starting in the same ms must never share turn lineage
      correlationId,
      laneId: lane.id,
      projectId,
      taskId: null,
      runId: null,
      attempt: 0,
      phase: 'PM_TURN',
      outcome: null,
      reason: null,
      qaMode: `primary:${lane.qa.runtime}`,
      route: 'full',
      envelope: null,
      updatedAt: new Date().toISOString(),
    });
    log('lane_run_start', { root: lane.root });
  }
  const save = (patch: Partial<LaneRunRecord>): LaneRunRecord => {
    rec = writeLaneRun(storeRoot, { ...rec!, ...patch });
    return rec!;
  };
  if (rec!.outcome) return { outcome: rec!.outcome as LaneEngineOutcome, laneRun: rec! };
  if (rec!.correlationId !== correlationId) {
    log('correlation_continue', { stored: rec!.correlationId, current: correlationId });
  }

  const sess = (b: BoundTransport): void => {
    if (!b.sessionId.trim() || !b.session.target.trim()) throw new Error('STALE_SESSION_BLOCKED: unbound role session');
  };
  sess(bindings.pm);
  if (bindings.builder) sess(bindings.builder);
  if (bindings.qa) {
    sess(bindings.qa);
    if (bindings.pm.sessionId === bindings.qa.sessionId
      || (bindings.builder && bindings.builder.sessionId === bindings.qa.sessionId)) {
      throw new Error('QA_NOT_INDEPENDENT: QA shares a session with PM/Builder');
    }
  }

  // Owner GO gate + role-shaped expectations, applied to every transport turn.
  // Any live turn (tmux or subprocess) requires a covering GO; tmux sends
  // additionally require the GO's explicit tmux allowance.
  const go = opts.requireOwnerGo ? requireOwnerGo(storeRoot, lane.id, 'advance') : null;
  if (go) log('owner_go', { goId: go.goId, cycle: go.cycleId });
  const gated = (bound: BoundTransport, expect?: RegExp): BoundTransport => {
    if (opts.requireOwnerGo) {
      requireOwnerGo(storeRoot, lane.id, bound.transport.kind === 'tmux' ? 'tmux-send' : 'advance');
    }
    return expect === undefined ? bound : { ...bound, session: { ...bound.session, expect } };
  };
  const asPm = (b: BoundTransport): BoundTransport => gated(b, PM_EXPECT);
  // Builder turns collect on settle+idle with NO content expect: agents
  // return rich evidence without the envelope, and parseBuilderTurnLenient
  // (strict envelope, then turn-bound substantive fallback) is the validator.
  // A verb/expect gate here would block exactly what the engine accepts.
  const asBuilder = (b: BoundTransport): BoundTransport => gated(b);
  const asQa = (b: BoundTransport): BoundTransport => gated(b, QA_EXPECT);

  const execOpts = { timeoutMs: tTimeout, maxAttempts: tAttempts, audit: opts.audit };
  const ident = (runId: string, taskId: string) => ({ projectId, taskId, runId, correlationId });

  for (;;) {
    if (rec!.phase === 'PM_TURN') {
      const ready = stores.listReadyTasks(lane);
      log('context', { readyTasks: ready.map((t) => t.taskId) });
      if (ready.length === 0) {
        save({ outcome: null, reason: 'no approved/READY Task in lane scope' });
        return { outcome: 'NO_DISPATCHABLE_TASK', laneRun: rec! };
      }
      // Builder slots are acquired lazily at BUILD_TURN only: QA/review-only
      // work never consumes a Builder slot (scheduler §6).
      countTurn();
      const pmBody = [
        'PM TURN. Lines starting with AR_TURN_ are transport framing, NOT content: never search for them or ask about them.',
        `PROJECT ${lane.id} root=${lane.root}`,
        `READY: ${ready.map((t) => t.taskId).join(',')}`,
        'Reply with EXACTLY ONE line first: DISPATCH {"taskId":"..."} for exactly one existing READY task, no other tasks.',
        `End your reply with exactly this line: REF:pm-${rec!.laneRunId}`,
      ].join('\n');
      countTurn();
      const { value: dec } = await collectParsed(storeRoot,
        () => executeTurn(storeRoot, ident(`pm-${rec!.laneRunId}`, ready[0]!.taskId), 'pm', pmBody, asPm(bindings.pm), execOpts),
        parsePmTurn, log, countTurn);
      log('pm_decide', { decision: dec.kind });
      if (dec.kind === 'HUMAN_GATE') {
        scheduler.park(lane.id);
        save({ outcome: 'HUMAN_GATE_PARKED', reason: dec.reason, phase: 'DONE' });
        return { outcome: 'HUMAN_GATE_PARKED', laneRun: rec! };
      }
      if (dec.kind === 'MILESTONE_COMPLETE') {
        scheduler.release(lane.id, 'builder');
        save({ outcome: 'MILESTONE_REPORTED', reason: dec.reason, phase: 'DONE' });
        return { outcome: 'MILESTONE_REPORTED', laneRun: rec! };
      }
      if (dec.kind !== 'DISPATCH') {
        scheduler.release(lane.id, 'builder');
        save({ outcome: 'BLOCKED', reason: `PM must DISPATCH an existing READY task (got ${dec.kind})`, phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      const task = stores.readTask(lane, dec.taskId);
      if (!task || task.executionState !== 'READY') {
        scheduler.release(lane.id, 'builder');
        save({ outcome: 'BLOCKED', reason: `DISPATCH requires an existing READY Task (got ${dec.taskId})`, phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      if (task.pmState === 'ACCEPTED') {
        scheduler.release(lane.id, 'builder');
        save({ outcome: 'BLOCKED', reason: `DISPATCH refused: ${task.taskId} is ACCEPTED-terminal`, phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      save({ taskId: task.taskId, phase: 'BUILD_TURN' });
    }

    if (rec!.phase === 'BUILD_TURN') {
      const taskId = rec!.taskId!;
      const task = stores.readTask(lane, taskId)!;
      if (task.executionState === 'CANCELLED' || task.executionState === 'FAILED') {
        save({ outcome: 'BLOCKED', reason: `task left dispatchable state (${task.executionState}); refusing stale dispatch`, phase: 'DONE' });
        scheduler.release(lane.id, 'builder');
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      if (rec!.route === 'review') {
        // REVIEW_ONLY/VERIFICATION: no Builder, no dispatch. QA verifies the
        // review target directly under a stable route run identity.
        save({ runId: `route-${taskId}`, phase: 'QA_TURN' });
        log('route_skip_build', { taskId, runId: rec!.runId });
        continue;
      }
      if (!bindings.builder) {
        // Builder role unbound: hold the task, free the slot, wait for a
        // matching session. Never dispatch-or-send into a wrong session.
        scheduler.release(lane.id, 'builder');
        log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'builder-unbound' });
        return { outcome: 'IN_PROGRESS', laneRun: rec! };
      }
      if (!scheduler.snapshot().builders.includes(lane.id) && !scheduler.acquire(lane.id, 'builder')) {
        log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'builder' });
        return { outcome: 'IN_PROGRESS', laneRun: rec! };
      }
      const bBound: BoundTransport = bindings.builder;
      let runId = rec!.runId;
      if (!runId) {
        if (opts.requireOwnerGo) requireOwnerGo(storeRoot, lane.id, 'dispatch');
        try {
          ({ runId } = await seams.dispatch(lane, task));
        } catch (err) {
          save({ outcome: 'BLOCKED', reason: `dispatch refused: ${err instanceof Error ? err.message : String(err)}`, phase: 'DONE' });
          scheduler.release(lane.id, 'builder');
          return { outcome: 'BLOCKED', laneRun: rec! };
        }
        save({ runId });
        log('dispatched', { taskId, runId });
      } else {
        // Rework continues the SAME canonical Run with a new attempt turn
        // (no second dispatch: exactly one active Run per lane run).
        log('dispatch_reuse', { taskId, runId });
      }
      countTurn();
      const env = rec!.envelope;
      const buildBody = [
        'BUILD TURN. Lines starting with AR_TURN_ are transport framing, NOT content: never search for them or ask about them.',
        `TASK ${taskId} RUN ${runId} ATTEMPT ${rec!.attempt + 1}`,
        `ROOT ${lane.root}`,
        ...(env ? [
          `GOAL ${env.taskType}: ${task.goal ?? ''}`.trim(),
          `WHY_NOW ${env.whyNow}`,
          `BASE ${env.currentBaseSha}`,
          `IN_SCOPE ${env.inScope.join(' | ')}`,
          `OUT_OF_SCOPE ${env.outOfScope.join(' | ')}`,
          `ACCEPTANCE ${env.acceptanceCriteria.map((a) => `${a.id}: ${a.description}`).join(' | ')}`,
          `REQUIRED_TESTS ${env.requiredTests.join(' | ')}`,
          `REQUIRED_EVIDENCE ${env.requiredEvidence.join(' | ')}`,
          `FILE_SCOPE ${env.fileScope.join(' | ')}`,
          `ROLE_PLAN ${env.rolePlan}`,
          `SOURCES ${env.sourceReferences.join(' | ')}`,
        ] : []),
        'Your reply MUST start with a RESULT_PACKET block in exactly this shape (fill every line):',
        'RESULT_PACKET',
        `Task: ${taskId}`,
        `Run: ${runId}`,
        'Commands: <commands you ran, comma separated>',
        'Tests: <tests with exit codes / pass counts>',
        'Known risks: <risks or none>',
        'HEAD: <repo HEAD sha if you touched the repo>',
        'Then, AFTER the block, paste the full command outputs as evidence.',
        `End your reply with exactly this line: REF:${runId}`,
      ].join('\n');
      countTurn();
      const { value: built } = await collectParsed(storeRoot,
        () => executeTurn(storeRoot, ident(runId, taskId), 'builder', buildBody, asBuilder(bBound), execOpts),
        (text) => parseBuilderTurnLenient(text, taskId, runId, (m) => log('result_fallback', { note: m })), log, countTurn);
      if (built.taskId !== taskId || built.runId !== runId) {
        save({ outcome: 'BLOCKED', reason: `builder identity mismatch (expected ${taskId}/${runId})`, phase: 'DONE' });
        scheduler.release(lane.id, 'builder');
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      scheduler.release(lane.id, 'builder');
      save({ attempt: rec!.attempt + 1, phase: 'QA_TURN' });
      log('builder_result', { taskId, runId, attempt: rec!.attempt });
      // Stash the verified builder text for the QA phase (durable: the turn).
      save({ reason: null });
    }

    if (rec!.phase === 'QA_TURN') {
      const taskId = rec!.taskId!;
      const runId = rec!.runId!;
      const task = stores.readTask(lane, taskId);
      if (!task || task.executionState === 'CANCELLED' || task.executionState === 'FAILED') {
        save({ outcome: 'BLOCKED', reason: `task left dispatchable state (${task?.executionState ?? 'missing'}); QA refused`, phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      // QA binding resolution: primary first; when unbound, walk the ordered
      // fallback chain and USE the first resolvable candidate immediately
      // (same Task/Result, qaMode recorded). An exhausted chain is terminal
      // truth, not an endless wait.
      let qBound: BoundTransport | null = bindings.qa;
      if (!qBound) {
        const chain = lane.fallbackChain?.length ? [...lane.fallbackChain] : [lane.qaFallback.runtime];
        for (const runtime of chain) {
          const binding = runtime === lane.qaFallback.runtime
            ? (bindings.qaFallback ?? null)
            : (bindings.resolveSession ? bindings.resolveSession(runtime) : null);
          if (!binding) {
            log('qa_fallback_skip', { runtime, reason: 'no binding' });
            continue;
          }
          const det = bindings.detectQaRuntime ? bindings.detectQaRuntime(runtime) : { installed: true };
          if (!det.installed) {
            log('qa_fallback_skip', { runtime, reason: 'runtime unavailable' });
            continue;
          }
          qBound = binding;
          save({ qaMode: `fallback:${runtime}` });
          log('qa_fallback', { to: runtime, direct: true });
          break;
        }
        if (!qBound) {
          save({
            outcome: 'BLOCKED_RUNTIME', phase: 'DONE',
            reason: `BLOCKED_RUNTIME: no QA endpoint (primary ${lane.qa.runtime} unbound; chain [${chain.join(',')}] unresolvable); Task/Result preserved`,
          });
          log('blocked_runtime', { reason: 'qa chain unresolvable' });
          return { outcome: 'BLOCKED_RUNTIME', laneRun: rec! };
        }
      }
      // Review routes verify the task target directly (no Builder turn).
      let verifyText: string;
      let verifyCommands: string[];
      let verifyTests: string[];
      let verifyRisks: string[];
      let verifyHead: string | undefined;
      let verifyBuilderSession: string;
      if (rec!.route === 'review' || !bindings.builder) {
        const env = rec!.envelope;
        verifyText = [
          `REVIEW_TARGET TASK ${taskId}`,
          `GOAL ${task.goal ?? ''}`.trim(),
          `SCOPE ${task.scope ?? ''}`.trim(),
          ...(env ? [`IN_SCOPE ${env.inScope.join(' | ')}`, `EVIDENCE_REQUIRED ${env.requiredEvidence.join(' | ')}`] : []),
        ].join('\n');
        verifyCommands = [];
        verifyTests = env?.requiredTests ?? [];
        verifyRisks = env?.knownRisks ?? [];
        verifyHead = env?.currentBaseSha;
        verifyBuilderSession = `route:${taskId}`;
      } else {
        const bturn = verifiedTurn(storeRoot, taskId, 'builder', runId, projectId);
        if (!bturn) throw new Error('QA_TURN without verified builder result');
        const built = parseBuilderTurn(bturn.resultBody!);
        verifyText = built.resultPacket;
        verifyCommands = built.commands;
        verifyTests = built.tests;
        verifyRisks = built.knownRisks;
        verifyHead = built.headSha;
        verifyBuilderSession = bindings.builder.sessionId;
      }
      let packet = buildVerificationPacket({
        laneId: lane.id,
        project: projectId,
        projectRoot: lane.root,
        taskId,
        attempt: rec!.attempt,
        runId,
        taskContract: stores.taskContract(lane, taskId),
        acceptanceCriteria: stores.acceptanceCriteria(lane, taskId),
        builderResult: verifyText,
        commands: verifyCommands,
        tests: verifyTests,
        knownRisks: verifyRisks,
        ...(verifyHead ? { headSha: verifyHead } : {}),
        builderSessionId: verifyBuilderSession,
        qaSessionId: qBound.sessionId,
      });
      assertQaIndependent(packet);
      assertLaneBinding(packet, lane);
      if (!scheduler.acquire(lane.id, 'qa')) return { outcome: 'IN_PROGRESS', laneRun: rec! };
      try {
        countTurn();
        const qaBody = [
          'QA VERIFICATION TURN. Your FIRST reply line must be exactly one of:',
          '  QA_PASS <one-line reason naming the evidence you checked>',
          '  QA_CHANGES',
          'Lines starting with AR_TURN_ are transport framing, NOT content: never search for them, quote them, or ask about them.',
          `TASK ${taskId}  RUN ${runId}  ATTEMPT ${rec!.attempt}`,
          `PROJECT ${lane.id}  ROOT ${lane.root}`,
          `ACCEPTANCE (all must hold): ${(stores.acceptanceCriteria(lane, taskId) as Array<{ id?: string; description?: string }> | null ?? []).map((a) => `${a.id ?? '?'}: ${a.description ?? ''}`).join(' | ').slice(0, 1200)}`,
          `EVIDENCE (builder result, truncated):`,
          verifyText.slice(0, 3500),
        'Reply with EXACTLY ONE of the two verdicts above. Do not ask clarifying questions: judge on this evidence. Insufficient evidence IS a QA_CHANGES finding (list what is missing).',
        `End your reply with exactly this line: REF:${runId}`,
      ].join('\n');
        let verdict: ReturnType<typeof parseQaTurn>;
        let qaFirstTurn: TurnRecord;
        try {
          countTurn();
          const qaFirst = await collectParsed(storeRoot,
            () => executeTurn(storeRoot, ident(runId, taskId), 'qa', qaBody, asQa(qBound), execOpts),
            parseQaTurn, log, countTurn);
          verdict = qaFirst.value;
          qaFirstTurn = qaFirst.turn;
        } catch (err) {
          throw err;
        }
        log('qa_verdict', { verdict: verdict.verdict });
        if (verdict.verdict === 'QA_UNAVAILABLE') {
          // Ordered fallback chain (§3): same Task, same Result, same target
          // preserved across every hop; the Builder is never re-run. Each
          // candidate is resolved + health-checked before routing; the first
          // healthy one wins. Exhaustion is explicit QA_RUNTIME_UNAVAILABLE.
          //
          // The exhausted primary turn is FAILED (transient service failure),
          // never VERIFIED: otherwise turn-reuse would serve the same
          // QA_UNAVAILABLE text to the fallback hop instead of asking the
          // next runtime. The failure also feeds session quarantine.
          try {
            transitionTurn(storeRoot, qaFirstTurn.turnId, 'FAILED', {
              error: `QA_UNAVAILABLE: ${verdict.cause}`.slice(0, 300),
              transient: true,
            });
          } catch { /* already terminal; fallback still proceeds */ }
          try {
            recordSessionFailure(storeRoot, qBound.sessionId, `QA_UNAVAILABLE: ${verdict.cause}`);
          } catch { /* quarantine is best-effort */ }
          const chain = lane.fallbackChain?.length ? [...lane.fallbackChain] : [lane.qaFallback.runtime];
          let routed: { runtime: string; binding: BoundTransport } | null = null;
          for (const runtime of chain) {
            const binding = runtime === lane.qaFallback.runtime
              ? (bindings.qaFallback ?? null)
              : (bindings.resolveSession ? bindings.resolveSession(runtime) : null);
            if (!binding) {
              log('qa_fallback_skip', { runtime, reason: 'no binding' });
              continue;
            }
            const det = bindings.detectQaRuntime
              ? bindings.detectQaRuntime(runtime)
              : { installed: true };
            if (!det.installed) {
              log('qa_fallback_skip', { runtime, reason: 'runtime unavailable' });
              continue;
            }
            routed = { runtime, binding };
            break;
          }
          if (!routed) {
            save({
              outcome: 'BLOCKED_RUNTIME', phase: 'DONE',
              reason: `BLOCKED_RUNTIME: QA_RUNTIME_UNAVAILABLE (primary ${lane.qa.runtime}: ${verdict.cause}; chain [${chain.join(',')}] exhausted); Task/Result preserved, no Builder re-run`,
            });
            log('blocked_runtime', { reason: 'qa chain exhausted after QA_UNAVAILABLE' });
            return { outcome: 'BLOCKED_RUNTIME', laneRun: rec! };
          }
          const qaMode = `fallback:${routed.runtime}`;
          save({ qaMode });
          log('qa_fallback', { cause: verdict.cause, to: routed.runtime });
          packet = buildVerificationPacket({ ...packet, qaSessionId: `${routed.binding.sessionId}:fallback` });
          assertQaIndependent(packet);
          assertLaneBinding(packet, lane);
          countTurn();
          const fb = routed.binding;
          const qaFb = await collectParsed(storeRoot,
            () => executeTurn(storeRoot, ident(runId, taskId), 'qa', qaBody, asQa(fb), execOpts),
            parseQaTurn, log, countTurn);
          verdict = qaFb.value;
          log('qa_verdict', { verdict: verdict.verdict, via: qaMode });
        }
        if (verdict.verdict === 'QA_CHANGES') {
          if (rec!.attempt > (opts.maxReworks ?? 2)) {
            save({ outcome: 'CHANGES_REWORK_EXHAUSTED', reason: 'rework budget exhausted; Task preserved', phase: 'DONE' });
            return { outcome: 'CHANGES_REWORK_EXHAUSTED', laneRun: rec! };
          }
          if (!scheduler.acquire(lane.id, 'builder')) return { outcome: 'IN_PROGRESS', laneRun: rec! };
          save({ phase: 'BUILD_TURN' });
          log('rework', { attempt: rec!.attempt + 1 });
          continue;
        }
        // QA_PASS -> PM review. Stash verdict via a durable review turn below.
        save({ phase: 'PM_REVIEW' });
      } finally {
        scheduler.release(lane.id, 'qa');
      }
    }

    if (rec!.phase === 'PM_REVIEW') {
      const taskId = rec!.taskId!;
      const runId = rec!.runId!;
      const qturn = verifiedTurn(storeRoot, taskId, 'qa', runId, projectId);
      if (!qturn) throw new Error('PM_REVIEW without verified QA verdict');
      const verdict = parseQaTurn(qturn.resultBody!);
      if (verdict.verdict !== 'QA_PASS') {
        save({ outcome: 'BLOCKED', reason: 'PM review requires QA PASS', phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      countTurn();
      const reviewBody = [
        'PM FINAL REVIEW. Lines starting with AR_TURN_ are transport framing, NOT content: never search for them or ask about them.',
        `REVIEW TASK ${taskId} RUN ${runId} QA_PASS: ${verdict.reason.slice(0, 500)}`,
        'Reply with EXACTLY ONE first line: ACCEPT {"reason":"..."} or REQUEST_CHANGES {"changes":"..."} or HUMAN_GATE {"reason":"..."}.',
        `End your reply with exactly this line: REF:review-${runId}`,
      ].join('\n');
      countTurn();
      const { value: dec } = await collectParsed(storeRoot,
        () => executeTurn(storeRoot, ident(`review-${runId}`, taskId), 'pm', reviewBody, asPm(bindings.pm), execOpts),
        parsePmTurn, log, countTurn);
      log('pm_review', { decision: dec.kind });
      const task = stores.readTask(lane, taskId)!;
      if (dec.kind === 'HUMAN_GATE') {
        scheduler.park(lane.id);
        save({ outcome: 'HUMAN_GATE_PARKED', reason: dec.reason, phase: 'DONE' });
        return { outcome: 'HUMAN_GATE_PARKED', laneRun: rec! };
      }
      if (dec.kind === 'REQUEST_CHANGES') {
        if (rec!.attempt > (opts.maxReworks ?? 2)) {
          save({ outcome: 'CHANGES_REWORK_EXHAUSTED', reason: 'rework budget exhausted; Task preserved', phase: 'DONE' });
          return { outcome: 'CHANGES_REWORK_EXHAUSTED', laneRun: rec! };
        }
        if (!scheduler.acquire(lane.id, 'builder')) return { outcome: 'IN_PROGRESS', laneRun: rec! };
        save({ phase: 'BUILD_TURN' });
        continue;
      }
      if (dec.kind !== 'ACCEPT') {
        save({ outcome: 'BLOCKED', reason: `PM review must ACCEPT/REQUEST_CHANGES/HUMAN_GATE (got ${dec.kind})`, phase: 'DONE' });
        return { outcome: 'BLOCKED', laneRun: rec! };
      }
      await seams.accept(lane, task, runId, { envelope: rec!.envelope, route: rec!.route });
      const next = await seams.nextTask(lane, task);
      save({ outcome: 'ACCEPT_AND_ADVANCE', reason: next ? `next: ${next.taskId}` : 'no further approved task', phase: 'DONE' });
      scheduler.release(lane.id);
      return { outcome: 'ACCEPT_AND_ADVANCE', laneRun: rec! };
    }

    if (rec!.phase === 'DONE') {
      return { outcome: (rec!.outcome ?? 'BLOCKED') as LaneEngineOutcome, laneRun: rec! };
    }
  }
}

export { latestTurnFor };

export interface IntakeSeams {
  validateProposal(lane: LaneConfigV2, proposal: TaskProposal, fileScope: string[]): Promise<void>;
  createTask(lane: LaneConfigV2, proposal: TaskProposal, fileScope: string[]): Promise<TaskView>;
  markReady(lane: LaneConfigV2, taskId: string): Promise<TaskView>;
}

interface IntakeMarker {
  proposal: TaskProposal | null;
  taskId: string | null;
  readyMarked: boolean;
  rounds: number;
  updatedAt: string;
}

function intakeMarkerPath(storeRoot: string, laneId: string): string {
  return path.join(path.resolve(storeRoot), 'intake', `${laneId}.json`);
}

function readIntakeMarker(storeRoot: string, laneId: string): IntakeMarker {
  try {
    return JSON.parse(fs.readFileSync(intakeMarkerPath(storeRoot, laneId), 'utf8')) as IntakeMarker;
  } catch {
    return { proposal: null, taskId: null, readyMarked: false, rounds: 0, updatedAt: new Date().toISOString() };
  }
}

function writeIntakeMarker(storeRoot: string, laneId: string, m: IntakeMarker): void {
  atomicWrite(intakeMarkerPath(storeRoot, laneId), { ...m, updatedAt: new Date().toISOString() });
}

/**
 * Canonical intake for a lane with no READY task: ask the project PM for
 * the smallest legitimate next task from the approved Goal/SSOT/WBS,
 * validate the structured contract, create the canonical Task, mark READY.
 * Every step is marker-durable: restarts resume without duplicate Tasks.
 * Requires a covering Owner GO (action 'intake').
 */
export async function intakeNextTask(
  lane: LaneConfigV2,
  pm: BoundTransport,
  seams: IntakeSeams,
  opts: {
    storeRoot: string;
    correlationId: string;
    projectId: string;
    goalBrief: string;
    timeoutMs?: number;
    maxAttempts?: number;
    /** Bounded PROJECT_CURRENT evidence for grounding proposals (tool-less PM). */
    projectCurrent?: () => Promise<string>;
    /** Authoritative-basis check; a negative parks BLOCKED_CONTEXT. */
    authoritative?: () => Promise<{ ok: boolean; reason?: string }>;
    audit?: EngineOptions['audit'];
  },
): Promise<TaskView | null> {
  const { storeRoot, correlationId, projectId } = opts;
  requireOwnerGo(storeRoot, lane.id, 'intake');
  if (pm.transport.kind === 'tmux') requireOwnerGo(storeRoot, lane.id, 'tmux-send');
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, correlationId, step, ...extra });
  if (!pm.sessionId.trim() || !pm.session.target.trim()) {
    throw new Error('STALE_SESSION_BLOCKED: PM session unbound for intake');
  }
  // Authoritative-context gate (§4): no intake from thin air. When neither
  // git, README/docs, nor canonical goals ground the lane, park the
  // decision as BLOCKED_CONTEXT instead of inventing Product work.
  if (opts.authoritative) {
    const auth = await opts.authoritative();
    if (!auth.ok) {
      patchLaneRun(storeRoot, lane.id, {
        outcome: 'BLOCKED_CONTEXT', phase: 'DONE',
        reason: `BLOCKED_CONTEXT: ${auth.reason ?? 'no authoritative current available'}`,
      });
      log('blocked_context', { reason: auth.reason ?? '' });
      return null;
    }
  }
  let marker = readIntakeMarker(storeRoot, lane.id);
  // §4 executable gate BEFORE canonical intake: incomplete contracts never
  // reach a Builder (TASK_NOT_EXECUTABLE fails the intake, audited).
  const gateEnvelope = (proposal: TaskProposal) =>
    assertExecutableContract(proposal, { baseSha: gitHeadSha(lane.root) });
  let currentPacket = '';
  try {
    if (opts.projectCurrent) currentPacket = (await opts.projectCurrent()).slice(0, 4000);
  } catch {
    currentPacket = '';
  }
  if (!marker.proposal) {
    // Bounded rounds: at most 3 proposal rounds per lane (persisted), each
    // with at most one re-ask. A persistently unparseable/unexecutable PM
    // stops getting pinged and the lane waits for founder attention.
    const rounds = marker.rounds ?? 0;
    if (rounds >= 3) {
      throw new Error('INTAKE_ROUNDS_EXHAUSTED: PM proposals unparseable/unexecutable after 3 rounds; founder attention required');
    }
    const body = [
      `PROJECT ${lane.id} root=${lane.root}`,
      `APPROVED GOAL: ${opts.goalBrief}`,
      ...(currentPacket ? [`CURRENT REPOSITORY STATE (Runner-assembled evidence; you have no local tools):\n${currentPacket}`] : []),
      'No READY task exists. Reply with exactly one fenced block:',
      '```json TASK_PROPOSAL v1 {',
      '  "goal":"...", "whyNow":"...",',
      '  "taskType":"IMPLEMENTATION|FIX|REVIEW_ONLY|VERIFICATION|PLANNING",',
      '  "bounded_scope":"...", "inScope":["..."], "outOfScope":["..."],',
      '  "acceptance_criteria":[{"id":"AC-1","description":"..."}],',
      '  "requiredTests":["..."], "requiredEvidence":["..."],',
      '  "knownRisks":["..."], "sourceReferences":["SSOT/WBS refs..."],',
      '  "rolePlan":"...", "fileScope":["paths the Builder may touch, named in bounded_scope"]',
      '}```',
      'Choose the SMALLEST legitimate next task from the approved Goal/SSOT/WBS. Propose nothing outside approved scope.',
      'For REVIEW_ONLY/VERIFICATION (no Builder), fileScope may be [].',
      'End your reply with a line containing REF: followed by the request id from the AR_TURN_BEGIN line above.',
    ].join('\n');
    const turnOpts = {
      timeoutMs: opts.timeoutMs ?? 600000,
      maxAttempts: opts.maxAttempts ?? 2,
      audit: opts.audit,
    };
    const { text } = await executeTurn(
      storeRoot,
      { projectId, taskId: `intake-${lane.id}`, runId: `intake-${lane.id}`, correlationId },
      'pm',
      body,
      { ...pm, session: { ...pm.session, expect: undefined } },
      turnOpts,
    );
    let proposal: TaskProposal;
    try {
      proposal = parseTaskProposal(text);
      gateEnvelope(proposal);
    } catch (first) {
      // Bounded validation feedback (mirrors the PM re-ask pattern): the
      // first reply is preserved in its turn; exactly ONE follow-up turn
      // (distinct lineage so the bad VERIFIED turn is not reused) carries
      // the precise error. A second failure blocks without spamming the PM.
      const errText = first instanceof Error ? first.message : String(first);
      log('proposal_reask', { error: errText.slice(0, 200) });
      const retry = await executeTurn(
        storeRoot,
        { projectId, taskId: `intake-${lane.id}`, runId: `intake-${lane.id}-r${rounds}`, correlationId },
        'pm',
        `${body}\n\n---\nVALIDATION_ERROR: ${errText}\nYour previous reply is preserved; reply again with exactly one COMPLETE executable proposal.`,
        { ...pm, session: { ...pm.session, expect: undefined } },
        turnOpts,
      );
      proposal = parseTaskProposal(retry.text);
      gateEnvelope(proposal);
    }
    const envelope = gateEnvelope(proposal);
    await seams.validateProposal(lane, proposal, envelope.fileScope);
    // Founder-owned holds: a proposal matching a hold parks the lane as
    // HUMAN_GATE instead of creating work (e.g. unapproved implementation).
    const haystack = `${proposal.goal} ${proposal.bounded_scope}`.toLowerCase();
    const hold = (lane.holds ?? []).find((h) => h.trim() && haystack.includes(h.trim().toLowerCase()));
    if (hold) {
      patchLaneRun(storeRoot, lane.id, {
        outcome: 'HUMAN_GATE_PARKED', phase: 'DONE',
        reason: `HUMAN_GATE: proposal matches lane hold '${hold.trim()}'`,
      });
      log('held', { hold: hold.trim(), goal: proposal.goal.slice(0, 120) });
      return null;
    }
    marker = { proposal, taskId: null, readyMarked: false, rounds: rounds + 1, updatedAt: new Date().toISOString() };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('proposal', { goal: proposal.goal.slice(0, 160) });
  }
  if (!marker.taskId) {
    const envelope = gateEnvelope(marker.proposal!);
    const created = await seams.createTask(lane, marker.proposal!, envelope.fileScope);
    marker = { ...marker, taskId: created.taskId };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('intake_created', { taskId: created.taskId });
  }
  if (!marker.readyMarked) {
    const ready = await seams.markReady(lane, marker.taskId!);
    const envelope = gateEnvelope(marker.proposal!);
    patchLaneRun(storeRoot, lane.id, {
      taskId: ready.taskId,
      route: routeForTaskType(envelope.taskType),
      envelope,
    });
    marker = { ...marker, readyMarked: true };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('intake_ready', { taskId: ready.taskId, route: routeForTaskType(envelope.taskType) });
    return ready;
  }
  return { taskId: marker.taskId!, executionState: 'READY', pmState: 'PENDING' };
}
