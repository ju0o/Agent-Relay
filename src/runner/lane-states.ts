/**
 * Truthful lane states (§2) — derived from DURABLE records only, never from
 * reservations alone. A lane is ACTIVE only while a turn is genuinely
 * executing with a held slot; mere reservations report WAITING_*.
 */
import type { LaneRunRecord } from './lane-engine.js';
import type { TurnRecord } from './turn-store.js';

export type LaneState =
  | 'ACTIVE'
  | 'WAITING_FOR_SLOT'
  | 'WAITING_FOR_RUNTIME'
  | 'WAITING_FOR_RESULT'
  | 'BLOCKED_TRANSPORT'
  | 'BLOCKED_PROVIDER'
  | 'BLOCKED_CONTEXT'
  | 'BLOCKED'
  | 'HUMAN_GATE'
  | 'DONE'
  | 'IDLE';

export interface LaneStateInput {
  run: LaneRunRecord | null;
  /** Non-terminal turns for this lane, newest last. */
  pendingTurns: TurnRecord[];
  builderSlotHeld: boolean;
  qaSlotHeld: boolean;
  /** Roles currently unbound with reasons (from the last bind attempt). */
  unboundRoles: string[];
}

function classifyBlocked(reason: string): LaneState {
  const r = reason.toUpperCase();
  if (r.includes('BLOCKED_CONTEXT')) return 'BLOCKED_CONTEXT';
  if (r.includes('QA_RUNTIME_UNAVAILABLE') || r.includes('PROVIDER') || r.includes('QUOTA')
    || r.includes('429') || r.includes('RATE LIMIT') || r.includes('AUTH')) return 'BLOCKED_PROVIDER';
  if (r.includes('TRANSPORT') || r.includes('NOT_IDLE') || r.includes('STALE_SESSION')
    || r.includes('PHANTOM') || r.includes('NO_BOUNDARY') || r.includes('TIMEOUT')) return 'BLOCKED_TRANSPORT';
  return 'BLOCKED';
}

export function deriveLaneState(input: LaneStateInput): LaneState {
  const { run, pendingTurns, builderSlotHeld, qaSlotHeld, unboundRoles } = input;
  if (!run) return 'IDLE';
  if (run.outcome === 'ACCEPT_AND_ADVANCE' || run.outcome === 'MILESTONE_COMPLETE' || run.outcome === 'MILESTONE_REPORTED') {
    return 'DONE';
  }
  if (run.outcome === 'HUMAN_GATE_PARKED') return 'HUMAN_GATE';
  if (run.outcome === 'BLOCKED_CONTEXT') return 'BLOCKED_CONTEXT';
  if (run.outcome === 'BLOCKED_RUNTIME') {
    return /PROVIDER|QUOTA|429|RATE LIMIT|AUTH/i.test(run.reason ?? '') ? 'BLOCKED_PROVIDER' : 'BLOCKED_TRANSPORT';
  }
  if (run.outcome && run.outcome !== null) {
    return classifyBlocked(run.reason ?? run.outcome);
  }
  // Live phases below (outcome is null).
  const live = pendingTurns.filter((t) => t.state === 'SENT' || t.state === 'RUNNING');
  if (live.length > 0) return 'ACTIVE';
  if (unboundRoles.length > 0) return 'WAITING_FOR_RUNTIME';
  // Admitted but unsent: needs its phase slot first (BUILDER/QA slots only;
  // PM turns need no slot and are ACTIVE once created).
  const requested = pendingTurns.filter((t) => t.state === 'REQUESTED');
  if (requested.length > 0) {
    const needsBuilderSlot = run.phase === 'BUILD_TURN';
    const needsQaSlot = run.phase === 'QA_TURN';
    if (needsBuilderSlot && !builderSlotHeld) return 'WAITING_FOR_SLOT';
    if (needsQaSlot && !qaSlotHeld) return 'WAITING_FOR_SLOT';
    return 'ACTIVE';
  }
  // Mid-loop between phases with nothing pending: the next step consumes
  // the previous step's result.
  return 'WAITING_FOR_RESULT';
}
