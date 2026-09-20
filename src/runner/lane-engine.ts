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
import type { CollectResult, TurnSession, TurnTransport } from './transport.js';
import { parseBuilderTurn, parsePmTurn, parseQaTurn, parseTaskProposal, type TaskProposal } from './result-parse.js';
import { requireOwnerGo } from './owner-go.js';
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
  | 'HUMAN_GATE_PARKED'
  | 'MILESTONE_REPORTED'
  | 'NO_DISPATCHABLE_TASK'
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
  updatedAt: string;
}

export interface TaskView {
  taskId: string;
  executionState: string;
  pmState: string;
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
  accept(lane: LaneConfigV2, task: TaskView, runId: string): Promise<void>;
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
    log('turn', { state: turn.state, attempt: turn.attempt, resumed: false });
  }
  for (;;) {
    try {
      if (turn.state === 'REQUESTED') {
        await bound.transport.sendTurn(turn, bound.session);
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
        return { turn, text: turn.resultBody! };
      }
      // A VERIFIED turn with usable body (resumed path).
      if (turn.state === 'VERIFIED' && turn.resultBody && turn.resultBody.trim()) {
        return { turn, text: turn.resultBody };
      }
      throw new Error(`TURN_UNUSABLE_STATE: ${turn.state}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
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
  const gated = (bound: BoundTransport, expect: RegExp): BoundTransport => {
    if (opts.requireOwnerGo) {
      requireOwnerGo(storeRoot, lane.id, bound.transport.kind === 'tmux' ? 'tmux-send' : 'advance');
    }
    return { ...bound, session: { ...bound.session, expect } };
  };
  const asPm = (b: BoundTransport): BoundTransport => gated(b, PM_EXPECT);
  const asBuilder = (b: BoundTransport): BoundTransport => gated(b, BUILDER_EXPECT);
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
      if (!scheduler.acquire(lane.id, 'builder')) {
        return { outcome: 'IN_PROGRESS', laneRun: rec! };
      }
      // Builder slot is held from here until the build result lands; every
      // terminal exit below releases it (park() releases internally).
      countTurn();
      const pmBody = [
        `PROJECT ${lane.id} root=${lane.root}`,
        `READY: ${ready.map((t) => t.taskId).join(',')}`,
        'Reply DISPATCH {"taskId":"..."} for exactly one existing READY task.',
      ].join('\n');
      const { text } = await executeTurn(storeRoot, ident(`pm-${rec!.laneRunId}`, ready[0]!.taskId), 'pm', pmBody, asPm(bindings.pm), execOpts);
      const dec = parsePmTurn(text);
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
      const buildBody = [
        `TASK ${taskId} RUN ${runId} ATTEMPT ${rec!.attempt + 1}`,
        `ROOT ${lane.root}`,
        'Reply with a RESULT_PACKET carrying Task/Run identity, commands, tests, known risks.',
      ].join('\n');
      const { text } = await executeTurn(storeRoot, ident(runId, taskId), 'builder', buildBody, asBuilder(bindings.builder), execOpts);
      const built = parseBuilderTurn(text);
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
      if (!bindings.builder || !bindings.qa) {
        // QA role unbound (or builder gone): the verified result waits
        // durably. Never self-certify, never reroute to a wrong session.
        const missing = [!bindings.builder ? 'builder' : null, !bindings.qa ? 'qa' : null].filter(Boolean).join('+');
        log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: `${missing}-unbound` });
        return { outcome: 'IN_PROGRESS', laneRun: rec! };
      }
      const bturn = verifiedTurn(storeRoot, taskId, 'builder', runId, projectId);
      if (!bturn) throw new Error('QA_TURN without verified builder result');
      const built = parseBuilderTurn(bturn.resultBody!);
      let packet = buildVerificationPacket({
        laneId: lane.id,
        project: projectId,
        projectRoot: lane.root,
        taskId,
        attempt: rec!.attempt,
        runId,
        taskContract: stores.taskContract(lane, taskId),
        acceptanceCriteria: stores.acceptanceCriteria(lane, taskId),
        builderResult: built.resultPacket,
        commands: built.commands,
        tests: built.tests,
        knownRisks: built.knownRisks,
        ...(built.headSha ? { headSha: built.headSha } : {}),
        builderSessionId: bindings.builder.sessionId,
        qaSessionId: bindings.qa.sessionId,
      });
      assertQaIndependent(packet);
      assertLaneBinding(packet, lane);
      if (!scheduler.acquire(lane.id, 'qa')) return { outcome: 'IN_PROGRESS', laneRun: rec! };
      try {
        countTurn();
        const qaBody = [
          `VERIFY TASK ${taskId} RUN ${runId}`,
          `CONTRACT ${JSON.stringify(stores.taskContract(lane, taskId)).slice(0, 2000)}`,
          `RESULT ${built.resultPacket.slice(0, 4000)}`,
          'Reply QA_PASS <reason> or QA_CHANGES with concrete findings lines.',
        ].join('\n');
        let verdict: ReturnType<typeof parseQaTurn>;
        try {
          const { text } = await executeTurn(storeRoot, ident(runId, taskId), 'qa', qaBody, asQa(bindings.qa), execOpts);
          verdict = parseQaTurn(text);
        } catch (err) {
          throw err;
        }
        log('qa_verdict', { verdict: verdict.verdict });
        if (verdict.verdict === 'QA_UNAVAILABLE') {
          if (!bindings.qaFallback) throw new Error(`QA_RUNTIME_UNAVAILABLE: ${verdict.cause}; no fallback configured`);
          save({ qaMode: 'fallback' });
          log('qa_fallback', { cause: verdict.cause });
          packet = buildVerificationPacket({ ...packet, qaSessionId: `${bindings.qaFallback.sessionId}:fallback` });
          assertQaIndependent(packet);
          assertLaneBinding(packet, lane);
          const { text } = await executeTurn(storeRoot, ident(runId, taskId), 'qa', qaBody, asQa(bindings.qaFallback), execOpts);
          verdict = parseQaTurn(text);
          log('qa_verdict', { verdict: verdict.verdict, via: 'fallback' });
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
        `REVIEW TASK ${taskId} RUN ${runId} QA_PASS: ${verdict.reason.slice(0, 500)}`,
        'Reply ACCEPT {"reason":"..."} or REQUEST_CHANGES {"changes":"..."} or HUMAN_GATE {"reason":"..."}.',
      ].join('\n');
      const { text } = await executeTurn(storeRoot, ident(`review-${runId}`, taskId), 'pm', reviewBody, asPm(bindings.pm), execOpts);
      const dec = parsePmTurn(text);
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
      await seams.accept(lane, task, runId);
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
  validateProposal(lane: LaneConfigV2, proposal: TaskProposal): Promise<void>;
  createTask(lane: LaneConfigV2, proposal: TaskProposal): Promise<TaskView>;
  markReady(lane: LaneConfigV2, taskId: string): Promise<TaskView>;
}

interface IntakeMarker {
  proposal: TaskProposal | null;
  taskId: string | null;
  readyMarked: boolean;
  updatedAt: string;
}

function intakeMarkerPath(storeRoot: string, laneId: string): string {
  return path.join(path.resolve(storeRoot), 'intake', `${laneId}.json`);
}

function readIntakeMarker(storeRoot: string, laneId: string): IntakeMarker {
  try {
    return JSON.parse(fs.readFileSync(intakeMarkerPath(storeRoot, laneId), 'utf8')) as IntakeMarker;
  } catch {
    return { proposal: null, taskId: null, readyMarked: false, updatedAt: new Date().toISOString() };
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
    audit?: EngineOptions['audit'];
  },
): Promise<TaskView> {
  const { storeRoot, correlationId, projectId } = opts;
  requireOwnerGo(storeRoot, lane.id, 'intake');
  if (pm.transport.kind === 'tmux') requireOwnerGo(storeRoot, lane.id, 'tmux-send');
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    opts.audit?.({ ts: new Date().toISOString(), laneId: lane.id, correlationId, step, ...extra });
  if (!pm.sessionId.trim() || !pm.session.target.trim()) {
    throw new Error('STALE_SESSION_BLOCKED: PM session unbound for intake');
  }
  let marker = readIntakeMarker(storeRoot, lane.id);
  if (!marker.proposal) {
    const body = [
      `PROJECT ${lane.id} root=${lane.root}`,
      `APPROVED GOAL: ${opts.goalBrief}`,
      'No READY task exists. Reply with exactly one fenced block:',
      '```json TASK_PROPOSAL v1 {"goal":"...","bounded_scope":"...","acceptance_criteria":[{"id":"AC-1","description":"..."}]}```',
      'Choose the SMALLEST legitimate next task from the approved Goal/SSOT/WBS. Propose nothing outside approved scope.',
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
    } catch (first) {
      // Bounded validation feedback (mirrors the PM re-ask pattern): the
      // first reply is preserved in its turn; exactly ONE follow-up turn
      // (distinct lineage so the bad VERIFIED turn is not reused) carries
      // the precise error. A second failure blocks without spamming the PM.
      const errText = first instanceof Error ? first.message : String(first);
      log('proposal_reask', { error: errText.slice(0, 200) });
      const retry = await executeTurn(
        storeRoot,
        { projectId, taskId: `intake-${lane.id}`, runId: `intake-${lane.id}-reask`, correlationId },
        'pm',
        `${body}\n\n---\nVALIDATION_ERROR: ${errText}\nYour previous reply is preserved; reply again with exactly one COMPLETE fenced block ending with a closing \`\`\` fence line.`,
        { ...pm, session: { ...pm.session, expect: undefined } },
        turnOpts,
      );
      proposal = parseTaskProposal(retry.text);
    }
    await seams.validateProposal(lane, proposal);
    marker = { proposal, taskId: null, readyMarked: false, updatedAt: new Date().toISOString() };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('proposal', { goal: proposal.goal.slice(0, 160) });
  }
  if (!marker.taskId) {
    const created = await seams.createTask(lane, marker.proposal!);
    marker = { ...marker, taskId: created.taskId };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('intake_created', { taskId: created.taskId });
  }
  if (!marker.readyMarked) {
    const ready = await seams.markReady(lane, marker.taskId!);
    marker = { ...marker, readyMarked: true };
    writeIntakeMarker(storeRoot, lane.id, marker);
    log('intake_ready', { taskId: ready.taskId });
    return ready;
  }
  return { taskId: marker.taskId!, executionState: 'READY', pmState: 'PENDING' };
}
