import { SessionObservation } from './types.js';

/**
 * Deterministic Run ↔ OpenCode session binding policy (Correction Pass 01).
 *
 * Invariant: ONE capture Run ↔ ONE explicitly identified sessionId. Once
 * bound, only that exact session may supply a captured result; the bound
 * session can never be silently replaced.
 *
 * Auto-bind uses ONLY exact identity evidence gathered at/after arm time:
 *   unique-new      — exactly ONE session was created after the arm timestamp
 *   unique-inflight — exactly ONE session had a running (incomplete) turn when
 *                     the watch armed
 * Any other situation is ambiguous and MUST be resolved by explicit user
 * selection — never by guessing.
 */

export type BindingReason = 'manual' | 'unique-new' | 'unique-inflight';

export type BindingDecision = 'accept' | 'ignore' | 'need-selection';

export interface BindingInfo {
  sessionId: string;
  reason: BindingReason;
}

function onlyOf(set: Set<string>): string | null {
  if (set.size !== 1) return null;
  return [...set][0] ?? null;
}

export class SessionBindingPolicy {
  private bound: BindingInfo | null = null;
  private ambiguous = false;
  private readonly newSeen = new Set<string>();
  private readonly lastSeen = new Map<string, SessionObservation>();
  private readonly armInFlightIds: Set<string>;

  constructor(armInFlightIds?: Set<string>) {
    this.armInFlightIds = armInFlightIds ?? new Set();
  }

  /**
   * Provide the arm-time in-flight snapshot once the first successful poll
   * pass has been observed. Later calls are ignored (snapshot is immutable).
   */
  seedArmInFlight(sessionIds: string[]): void {
    if (this.bound) return;
    for (const id of sessionIds) this.armInFlightIds.add(id);
  }

  /** Feed one poll pass of observations. Idempotent per pass content. */
  note(sessions: SessionObservation[]): void {
    for (const s of sessions) {
      if (!s.sessionId) continue;
      this.lastSeen.set(s.sessionId, s);
      if (s.isNew) this.newSeen.add(s.sessionId);
    }
  }

  get isAmbiguous(): boolean {
    return this.ambiguous && this.bound === null;
  }

  get binding(): BindingInfo | null {
    return this.bound ? { ...this.bound } : null;
  }

  /**
   * True when deterministic auto-binding has become IMPOSSIBLE (more than one
   * plausible source of truth exists). The caller should surface the
   * selection flow instead of waiting silently.
   */
  candidatesNeedSelection(): boolean {
    if (this.bound) return false;
    const fromNew = onlyOf(this.newSeen);
    const fromInflight = onlyOf(this.armInFlightIds);
    if (this.newSeen.size > 1 || this.armInFlightIds.size > 1) return true;
    if (fromNew && fromInflight && fromNew !== fromInflight) return true;
    return false;
  }

  /**
   * Explicit user selection. Accepted unless the SAME session is already
   * bound; an existing auto/manual binding is never replaced.
   */
  bindManual(sessionId: string): boolean {
    if (!sessionId) return false;
    if (this.bound) return this.bound.sessionId === sessionId;
    this.bound = { sessionId, reason: 'manual' };
    this.ambiguous = false;
    return true;
  }

  /** Candidate list for the minimal user-selection flow (stable order). */
  candidates(): SessionObservation[] {
    const preferred = new Set<string>([...this.newSeen, ...this.armInFlightIds]);
    const out: SessionObservation[] = [];
    for (const id of preferred) {
      const obs = this.lastSeen.get(id);
      if (obs) out.push(obs);
    }
    for (const obs of this.lastSeen.values()) {
      if (!preferred.has(obs.sessionId)) out.push(obs);
    }
    return out;
  }

  /**
   * Decide what to do with a completed turn from `sessionId`.
   *
   * - accept         → completion matches the (possibly just-established)
   *                    deterministic binding; caller persists it.
   * - ignore         → a different, already-bound session owns this Run.
   * - need-selection → binding could not be established without ambiguity;
   *                    caller must surface the picker, never guess.
   */
  decide(sessionId: string): BindingDecision {
    if (!sessionId) return 'need-selection';
    if (this.bound) return sessionId === this.bound.sessionId ? 'accept' : 'ignore';

    const eligible = new Set<string>();
    const reasons = new Map<string, BindingReason>();
    const fromNew = onlyOf(this.newSeen);
    if (fromNew) {
      eligible.add(fromNew);
      reasons.set(fromNew, 'unique-new');
    }
    const fromInflight = onlyOf(this.armInFlightIds);
    if (fromInflight) {
      eligible.add(fromInflight);
      if (!reasons.has(fromInflight)) reasons.set(fromInflight, 'unique-inflight');
    }

    if (eligible.size === 1) {
      const id = onlyOf(eligible)!;
      if (id === sessionId) {
        this.bound = { sessionId: id, reason: reasons.get(id) ?? 'manual' };
        this.ambiguous = false;
        return 'accept';
      }
      // Exactly one plausible session exists, but THIS completion came from a
      // different one — do not capture it; keep waiting for the plausible one.
      return 'need-selection';
    }

    this.ambiguous = true;
    return 'need-selection';
  }
}
