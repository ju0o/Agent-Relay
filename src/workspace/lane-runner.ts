/**
 * Project-lane runner — ONE lane's canonical loop:
 *
 *   PROJECT CONTEXT -> PM -> DISPATCH existing approved/READY Task
 *   -> Builder -> RESULT_PACKET -> Independent QA -> QA_PASS | QA_CHANGES
 *   -> PM final review -> ACCEPT (next approved WBS) | REQUEST_CHANGES
 *   (same Task rework) | HUMAN_GATE (park lane) | MILESTONE_COMPLETE
 *
 * Safety (all enforced here, all audited):
 * - No duplicate Task: the runner has NO create path (it cannot import
 *   task creation; same-task rework preserves taskId, attempts only grow).
 * - No duplicate active Run: one in-flight run per lane; a second dispatch
 *   while active is BLOCKED; canonical CAS (READY/INVALID_STATE/CONFLICT)
 *   is the backstop and its errors surface as BLOCKED, never retried blindly.
 * - No stale session dispatch: session bindings must be non-empty, distinct
 *   (QA independent), and match the bound live_session_identity or the lane
 *   stops before any effect.
 * - No accepted-terminal re-dispatch: ACCEPTED pmState refuses.
 * - No ACCEPT without QA PASS where QA is required (always, in this version).
 * - No cross-context contamination: every adapter call carries laneId +
 *   projectRoot; packets bind laneId/project/taskId/runId.
 *
 * The runner is effect-agnostic: PM/Builder/QA/dispatch/accept/next are
 * injected seams. Dry-run uses scripted seams + scratch canonical stores;
 * live uses real probe bindings + real store reads with deferring external
 * seams (no external sends/dispatches without owner-authorized scope).
 */
import type { LaneConfigV2 } from './config-v2.js';
import type { LaneScheduler } from './scheduler.js';
import {
  assertQaIndependent,
  buildVerificationPacket,
  validateQaVerdict,
  type QaVerdict,
  type VerificationPacket,
} from './verification-packet.js';

export type LaneOutcomeKind =
  | 'ACCEPT_AND_ADVANCE'
  | 'CHANGES_REWORK_EXHAUSTED'
  | 'BLOCKED'
  | 'HUMAN_GATE_PARKED'
  | 'MILESTONE_REPORTED'
  | 'NO_DISPATCHABLE_TASK'
  | 'WAITING_FOR_SLOT'
  | 'PM_TURN_DEFERRED';

export interface LaneOutcome {
  outcome: LaneOutcomeKind;
  laneId: string;
  /** Request/cycle identity this outcome belongs to (see LaneRunOptions). */
  correlationId: string;
  taskId?: string;
  runId?: string;
  attempts: number;
  nextTaskId?: string | null;
  reason?: string;
  qaMode?: string;
}

export interface TaskView {
  taskId: string;
  executionState: string;
  pmState: string;
}

export type PmDecision =
  | { kind: 'DISPATCH'; taskId: string; reason?: string }
  | { kind: 'REQUEST_CHANGES'; changes: string; reason?: string }
  | { kind: 'ACCEPT'; reason?: string }
  | { kind: 'HUMAN_GATE'; reason: string }
  | { kind: 'MILESTONE_COMPLETE'; reason: string };

export interface BuilderEffect {
  /** Must equal the dispatched Task id — identity mismatch blocks the lane. */
  taskId: string;
  runId: string;
  resultPacket: string;
  commands: string[];
  tests: string[];
  knownRisks: string[];
  headSha?: string;
  diffSummary?: string;
}

export interface LaneSessionBindings {
  builderSessionId: string;
  qaSessionId: string;
  /** Expected live_session_identity values from probe binding (when live). */
  expectedBuilderIdentity?: string;
  expectedQaIdentity?: string;
}

export interface LaneStore {
  listReadyTasks(lane: LaneConfigV2): TaskView[];
  readTask(lane: LaneConfigV2, taskId: string): TaskView | null;
}

export interface LaneAdapters {
  pmDecide(input: {
    lane: LaneConfigV2;
    task: TaskView | null;
    packet: VerificationPacket | null;
    qaVerdict: QaVerdict | null;
  }): Promise<PmDecision>;
  /** Canonical dispatch seam (fake in dry-run, dispatcher-backed when live). */
  dispatch(lane: LaneConfigV2, task: TaskView): Promise<{ runId: string }>;
  builderExecute(lane: LaneConfigV2, task: TaskView, attempt: number, changes?: string): Promise<BuilderEffect>;
  qaVerify(packet: VerificationPacket): Promise<QaVerdict>;
  /** Canonical ACCEPT seam. */
  accept(lane: LaneConfigV2, task: TaskView, runId: string): Promise<void>;
  /** Next approved WBS seam (null = none approved). */
  nextTask(lane: LaneConfigV2, task: TaskView): Promise<{ taskId: string } | null>;
  /** Runtime presence probe for QA fallback routing. */
  detectQaRuntime(runtime: string): { installed: boolean; version?: string };
  audit(event: Record<string, unknown>): void;
}

export interface LaneRunOptions {
  scheduler: LaneScheduler;
  sessions: LaneSessionBindings;
  maxTurns?: number;
  maxReworks?: number;
  mode?: 'dry-run' | 'live';
  /**
   * Unique request/cycle identity (e.g. the authorizing cycle id
   * `runner-fix-1789871385`). Carried on every audit event and on the
   * outcome so handoffs correlate to THIS request only. Defaults to the
   * lane-run id when the caller supplies none.
   */
  correlationId?: string;
}

export type HandoffRole = 'PM' | 'BUILDER' | 'QA';

/**
 * Handoff marker for exactly one request: `AR_RUNNER_<ROLE>_DONE:<cycle>`.
 * Bare fixed strings (no `:id` suffix) NEVER count as completion evidence —
 * pane history from older cycles cannot match a new correlation id.
 */
export function formatHandoffMarker(role: HandoffRole, correlationId: string): string {
  if (!correlationId.trim()) throw new Error('handoff marker requires a correlation id');
  return `AR_RUNNER_${role}_DONE:${correlationId.trim()}`;
}

/**
 * Accept only a marker minted for THIS request: exact role prefix plus the
 * exact `:correlationId` suffix, observed after the request started.
 * Old-history bare markers and foreign-cycle markers both fail.
 */
export function isCurrentCycleMarker(text: string, role: HandoffRole, correlationId: string): boolean {
  const want = formatHandoffMarker(role, correlationId);
  return text.split(/\r?\n/).some((line) => line.trimEnd().endsWith(want));
}

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_REWORKS = 2;

/**
 * Lane-binding guard: a Verification Packet minted for lane A can never be
 * verified or dispatched as lane B. Checks the bound triple
 * (laneId, project, projectRoot) against the running lane — not just a
 * laneId string field in isolation.
 */
export function assertLaneBinding(packet: VerificationPacket, lane: LaneConfigV2): VerificationPacket {
  if (packet.laneId !== lane.id) {
    throw new Error(`LANE_BINDING_MISMATCH: packet lane ${packet.laneId} != running lane ${lane.id}`);
  }
  if (packet.projectRoot !== lane.root) {
    throw new Error(`LANE_BINDING_MISMATCH: packet root ${packet.projectRoot} != lane root ${lane.root}`);
  }
  return packet;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

function checkSessions(lane: LaneConfigV2, s: LaneSessionBindings): void {
  if (!s.builderSessionId.trim() || !s.qaSessionId.trim()) {
    throw new Error(`STALE_SESSION_BLOCKED: lane ${lane.id} has unbound role sessions`);
  }
  if (s.expectedBuilderIdentity && s.builderSessionId !== s.expectedBuilderIdentity) {
    throw new Error(`STALE_SESSION_BLOCKED: lane ${lane.id} builder session does not match bound live_session_identity`);
  }
  if (s.expectedQaIdentity && s.qaSessionId !== s.expectedQaIdentity) {
    throw new Error(`STALE_SESSION_BLOCKED: lane ${lane.id} QA session does not match bound live_session_identity`);
  }
  if (s.builderSessionId === s.qaSessionId) {
    throw new Error(`QA_NOT_INDEPENDENT: lane ${lane.id} builder and QA share a session`);
  }
}

export async function runProjectLane(
  lane: LaneConfigV2,
  store: LaneStore,
  adapters: LaneAdapters,
  opts: LaneRunOptions,
): Promise<LaneOutcome> {
  const runId = `lr-${rand()}`;
  const correlationId = opts.correlationId?.trim() ? opts.correlationId.trim() : runId;
  const mode = opts.mode ?? 'dry-run';
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxReworks = opts.maxReworks ?? DEFAULT_MAX_REWORKS;
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    adapters.audit({ ts: new Date().toISOString(), laneRunId: runId, correlationId, mode, laneId: lane.id, step, ...extra });
  let turns = 0;
  const tick = () => {
    turns += 1;
    if (turns > maxTurns) throw new Error(`TURN_BUDGET_EXHAUSTED: lane ${lane.id} exceeded ${maxTurns} turns`);
  };

  log('lane_start', { root: lane.root, goal: lane.goal.slice(0, 120) });

  // 0. Session binding gate — before ANY effect.
  try {
    checkSessions(lane, opts.sessions);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('session_gate', { outcome: 'BLOCKED', reason });
    return { outcome: 'BLOCKED', laneId: lane.id, correlationId, attempts: 0, reason };
  }
  log('sessions_bound', { builder: opts.sessions.builderSessionId, qa: opts.sessions.qaSessionId });

  // 1. Scheduler: builder slot first (READY != RUNNING).
  if (!opts.scheduler.acquire(lane.id, 'builder')) {
    log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'builder' });
    return { outcome: 'WAITING_FOR_SLOT', laneId: lane.id, correlationId, attempts: 0, reason: 'builder cap reached' };
  }
  log('slot_acquired', { slot: 'builder' });

  try {
    // 2. Project context + dispatchable READY discovery (read-only).
    const ready = store.listReadyTasks(lane);
    log('context', { readyTasks: ready.map((t) => t.taskId) });
    if (ready.length === 0) {
      log('no_task', { outcome: 'NO_DISPATCHABLE_TASK' });
      return { outcome: 'NO_DISPATCHABLE_TASK', laneId: lane.id, correlationId, attempts: 0, reason: 'no approved/READY Task in lane scope' };
    }

    // 3. PM turn: which READY task (reuse only — runner cannot create).
    tick();
    const first = await adapters.pmDecide({ lane, task: null, packet: null, qaVerdict: null });
    log('pm_decide', { decision: first.kind });
    if (first.kind === 'HUMAN_GATE') {
      opts.scheduler.park(lane.id);
      log('parked', { outcome: 'HUMAN_GATE_PARKED', reason: first.reason });
      return { outcome: 'HUMAN_GATE_PARKED', laneId: lane.id, correlationId, attempts: 0, reason: first.reason };
    }
    if (first.kind === 'MILESTONE_COMPLETE') {
      log('milestone', { outcome: 'MILESTONE_REPORTED', reason: first.reason });
      return { outcome: 'MILESTONE_REPORTED', laneId: lane.id, correlationId, attempts: 0, reason: first.reason };
    }
    if (first.kind !== 'DISPATCH' || !first.taskId) {
      const reason = `PM must DISPATCH an existing READY task (got ${first.kind})`;
      log('pm_invalid', { outcome: 'BLOCKED', reason });
      return { outcome: 'BLOCKED', laneId: lane.id, correlationId, attempts: 0, reason };
    }
    let current = store.readTask(lane, first.taskId);
    if (!current || current.executionState !== 'READY') {
      const reason = `DISPATCH requires an existing READY Task (got ${first.taskId || '(none)'})`;
      log('dispatch_guard', { outcome: 'BLOCKED', reason });
      return { outcome: 'BLOCKED', laneId: lane.id, correlationId, attempts: 0, reason };
    }
    if (current.pmState === 'ACCEPTED') {
      const reason = `DISPATCH refused: ${current.taskId} is ACCEPTED-terminal`;
      log('dispatch_guard', { outcome: 'BLOCKED', reason });
      return { outcome: 'BLOCKED', laneId: lane.id, correlationId, attempts: 0, reason };
    }

    // 4. Attempt loop: dispatch -> build -> QA -> PM review.
    let attempts = 0;
    let activeRun: string | null = null;
    let changes: string | undefined;
    let qaMode = `primary:${lane.qa.runtime}`;
    for (;;) {
      if (activeRun !== null) {
        const reason = `duplicate dispatch refused: run ${activeRun} still active for ${current.taskId}`;
        log('dup_guard', { outcome: 'BLOCKED', reason });
        return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId: activeRun, attempts, reason };
      }
      tick();
      let runId: string;
      try {
        ({ runId } = await adapters.dispatch(lane, current));
      } catch (err) {
        const reason = `dispatch refused by canonical guard: ${err instanceof Error ? err.message : String(err)}`;
        log('dispatch_refused', { outcome: 'BLOCKED', reason, taskId: current.taskId });
        return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, attempts, reason };
      }
      activeRun = runId;
      attempts += 1;
      log('dispatched', { taskId: current.taskId, runId, attempt: attempts });

      const effect = await adapters.builderExecute(lane, current, attempts, changes);
      if (effect.taskId !== current.taskId || effect.runId !== runId) {
        const reason = `builder identity mismatch (expected ${current.taskId}/${runId}, got ${effect.taskId}/${effect.runId})`;
        log('identity_mismatch', { outcome: 'BLOCKED', reason });
        return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason };
      }
      opts.scheduler.release(lane.id, 'builder');
      log('builder_result', { taskId: current.taskId, runId, attempt: attempts });
      activeRun = null;

      let packet = buildVerificationPacket({
        laneId: lane.id,
        project: lane.id,
        projectRoot: lane.root,
        taskId: current.taskId,
        attempt: attempts,
        runId: effect.runId,
        taskContract: null,
        acceptanceCriteria: null,
        builderResult: effect.resultPacket,
        commands: effect.commands,
        tests: effect.tests,
        knownRisks: effect.knownRisks,
        ...(effect.headSha ? { headSha: effect.headSha } : {}),
        ...(effect.diffSummary ? { diffSummary: effect.diffSummary } : {}),
        builderSessionId: opts.sessions.builderSessionId,
        qaSessionId: opts.sessions.qaSessionId,
      });
      assertQaIndependent(packet);
      assertLaneBinding(packet, lane);

      if (!opts.scheduler.acquire(lane.id, 'qa')) {
        const reason = 'QA slot unavailable; result preserved for retry';
        log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'qa', taskId: current.taskId, runId });
        return { outcome: 'WAITING_FOR_SLOT', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
      }
      log('slot_acquired', { slot: 'qa' });

      let verdict: QaVerdict;
      try {
        const raw = await adapters.qaVerify(packet);
        verdict = validateQaVerdict(packet, raw);
      } catch (err) {
        opts.scheduler.release(lane.id, 'qa');
        const reason = err instanceof Error ? err.message : String(err);
        log('qa_invalid', { outcome: 'BLOCKED', reason });
        return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
      }
      log('qa_verdict', { verdict: verdict.verdict, reason: verdict.reason.slice(0, 200) });

      // QA fallback: same Task, same Result, same target — only QA re-routed.
      if (verdict.verdict === 'QA_UNAVAILABLE') {
        opts.scheduler.release(lane.id, 'qa');
        const fb = lane.qaFallback;
        const det = adapters.detectQaRuntime(fb.runtime);
        if (!det.installed) {
          const reason = `QA_RUNTIME_UNAVAILABLE: primary ${lane.qa.runtime} (${verdict.unavailabilityCause}) and fallback ${fb.runtime} CLI not installed; Task/Result preserved, no Builder re-run`;
          log('qa_fallback_missing', { outcome: 'BLOCKED', reason });
          return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        qaMode = `fallback:${fb.runtime}`;
        log('qa_fallback', { from: lane.qa.runtime, to: fb.runtime, taskId: current.taskId, runId });
        packet = buildVerificationPacket({ ...packet, qaSessionId: `fallback:${fb.runtime}` });
        assertQaIndependent(packet);
        assertLaneBinding(packet, lane);
        if (!opts.scheduler.acquire(lane.id, 'qa')) {
          const reason = 'QA slot unavailable after fallback; result preserved';
          log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'qa' });
          return { outcome: 'WAITING_FOR_SLOT', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        try {
          verdict = validateQaVerdict(packet, await adapters.qaVerify(packet));
        } catch (err) {
          opts.scheduler.release(lane.id, 'qa');
          const reason = err instanceof Error ? err.message : String(err);
          log('qa_invalid', { outcome: 'BLOCKED', reason });
          return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        log('qa_verdict', { verdict: verdict.verdict, via: qaMode });
      }
      opts.scheduler.release(lane.id, 'qa');

      if (verdict.verdict === 'QA_CHANGES') {
        if (attempts > maxReworks) {
          const reason = `rework budget exhausted (${maxReworks}); Task ${current.taskId} preserved for owner`;
          log('rework_exhausted', { outcome: 'CHANGES_REWORK_EXHAUSTED', reason });
          return { outcome: 'CHANGES_REWORK_EXHAUSTED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        changes = (verdict.findings ?? []).join('\n');
        log('rework', { attempt: attempts + 1, changes: changes.slice(0, 200) });
        if (!opts.scheduler.acquire(lane.id, 'builder')) {
          const reason = 'builder slot unavailable for rework; Task/Result preserved';
          log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'builder' });
          return { outcome: 'WAITING_FOR_SLOT', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        continue;
      }

      // QA_PASS -> PM final review.
      tick();
      const review = await adapters.pmDecide({ lane, task: current, packet, qaVerdict: verdict });
      log('pm_review', { decision: review.kind });
      if (review.kind === 'HUMAN_GATE') {
        opts.scheduler.park(lane.id);
        return { outcome: 'HUMAN_GATE_PARKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason: review.reason, qaMode };
      }
      if (review.kind === 'REQUEST_CHANGES') {
        if (attempts > maxReworks) {
          const reason = `rework budget exhausted (${maxReworks}); Task ${current.taskId} preserved for owner`;
          log('rework_exhausted', { outcome: 'CHANGES_REWORK_EXHAUSTED', reason });
          return { outcome: 'CHANGES_REWORK_EXHAUSTED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        changes = review.changes ?? review.reason ?? 'address PM review';
        log('rework', { attempt: attempts + 1, by: 'pm' });
        if (!opts.scheduler.acquire(lane.id, 'builder')) {
          const reason = 'builder slot unavailable for PM rework; Task/Result preserved';
          log('slot_wait', { outcome: 'WAITING_FOR_SLOT', slot: 'builder' });
          return { outcome: 'WAITING_FOR_SLOT', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
        }
        continue;
      }
      if (review.kind !== 'ACCEPT') {
        const reason = `PM final review must ACCEPT, REQUEST_CHANGES, or HUMAN_GATE (got ${review.kind}); QA PASS does not self-accept`;
        log('pm_invalid', { outcome: 'BLOCKED', reason });
        return { outcome: 'BLOCKED', laneId: lane.id, correlationId, taskId: current.taskId, runId, attempts, reason, qaMode };
      }
      await adapters.accept(lane, current, runId);
      const next = await adapters.nextTask(lane, current);
      log('accepted', { taskId: current.taskId, runId, nextTaskId: next?.taskId ?? null });
      return {
        outcome: 'ACCEPT_AND_ADVANCE', laneId: lane.id, correlationId, taskId: current.taskId, runId,
        attempts, nextTaskId: next?.taskId ?? null, qaMode,
      };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('lane_error', { outcome: 'BLOCKED', reason });
    return { outcome: 'BLOCKED', laneId: lane.id, correlationId, attempts: 0, reason };
  } finally {
    opts.scheduler.release(lane.id);
  }
}
