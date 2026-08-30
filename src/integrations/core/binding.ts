import { SessionObservation } from './types.js';

/**
 * Deterministic Run ↔ Claude/OpenCode session binding policy (Correction Pass 01).
 *
 * Invariant: ONE capture Run ↔ ONE explicitly identified sessionId. Once
 * bound, only that exact session may supply a captured result; the bound
 * session can never be silently replaced.
 *
 * Auto-bind uses ONLY exact identity evidence gathered at/after arm time:
 *   unique-new           — exactly ONE session was created after the arm timestamp
 *   unique-inflight      — exactly ONE session had a running (incomplete) turn when
 *                          the watch armed
 *   unique-post-inflight — exactly ONE pre-existing session started a NEW turn after
 *                          arm time (Case B: launch agent → arm Relay → send message)
 *   unique-sole-observed — exactly ONE fresh session was ever observed, and it is the
 *                          only one that arrived with a post-arm completion (fast
 *                          completion case: turn completed between polls)
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

/**
 * Freshness gate: only turns whose terminal timestamp lies at/after the arm
 * moment may ever be captured. This prevents historical end_turn entries
 * (first observation of an OLD transcript) from being mistaken for new work.
 */
export function turnCompletedAfterArm(
  completedAtIso: string | null | undefined,
  sinceMs: number,
  skewMs = 1_500,
): boolean {
  return isoAtOrAfterArm(completedAtIso, sinceMs, skewMs);
}

/**
 * Same gate for turn STARTS: an "in-flight" turn that began long before the
 * watch armed is a stale zombie (file merely touched), never the user's
 * current work — it must not enter the arm-time binding snapshot.
 */
export function turnStartedAfterArm(
  startedAtIso: string | null | undefined,
  sinceMs: number,
  skewMs = 1_500,
): boolean {
  return isoAtOrAfterArm(startedAtIso, sinceMs, skewMs);
}

function isoAtOrAfterArm(iso: string | null | undefined, sinceMs: number, skewMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= sinceMs - skewMs;
}

export class SessionBindingPolicy {
  private bound: BindingInfo | null = null;
  private ambiguous = false;
  private readonly newSeen = new Set<string>();
  private readonly lastSeen = new Map<string, SessionObservation>();
  private readonly armInFlightIds: Set<string>;
  /**
   * Sessions NOT in armInFlightIds but observed as in-flight (turn started
   * after arm time) in any later poll pass. Populated by note() whenever
   * a session's inFlight flag is true and it wasn't already in armInFlightIds.
   * Enables auto-binding for Case B: agent was launched before arming, then
   * the user sends the first post-arm message (file mtime is stale at arm
   * time, so the session missed the arm-snapshot seed pass).
   */
  private readonly postArmInflightIds = new Set<string>();
  /**
   * Sessions that arrived via decide() with no prior early-binding evidence
   * (eligible was empty at decide() time). Used exclusively for the
   * fast-completion path: if exactly ONE fresh session was ever observed AND
   * it is the only post-arm completion we have seen, we can safely auto-bind.
   */
  private readonly postArmCompletions = new Set<string>();

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
      // Track sessions that start a NEW turn after arm time but were NOT
      // captured in the arm-time snapshot (i.e. they weren't in-flight when
      // arming happened — the file was stale so the session was excluded from
      // the first poll pass, or it completed too fast for the first pass).
      // The adapter's inFlight flag already implies turnStartedAfterArm, so
      // adding here is safe without re-checking the timestamp.
      if (s.inFlight && !this.armInFlightIds.has(s.sessionId)) {
        this.postArmInflightIds.add(s.sessionId);
      }
    }
  }

  get isAmbiguous(): boolean {
    return this.ambiguous && this.bound === null;
  }

  get binding(): BindingInfo | null {
    return this.bound ? { ...this.bound } : null;
  }

  /** Latest observed metadata (title/directory) of the CURRENTLY bound session. */
  get bindingObservation(): SessionObservation | null {
    if (!this.bound) return null;
    return this.lastSeen.get(this.bound.sessionId) ?? null;
  }

  /**
   * True when deterministic auto-binding has become IMPOSSIBLE (more than one
   * plausible source of truth exists). The caller should surface the
   * selection flow instead of waiting silently.
   */
  candidatesNeedSelection(): boolean {
    if (this.bound) return false;
    return this.eligibleFromSets().size > 1;
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

  /**
   * Undo a binding that was established but NOT yet persisted. Used by the
   * settle window when a rival session appears before the result is written.
   * After revocation the policy is unresolved again and will demand fresh
   * evidence (or explicit selection).
   */
  revoke(): void {
    if (!this.bound || !this.persistable) return;
    this.bound = null;
    this.ambiguous = false;
  }

  /** True while the current binding has not been written to disk yet. */
  private persistable = true;

  /** True once the current binding has been persisted (permanent). */
  get isPersisted(): boolean {
    return !this.persistable;
  }

  /** Called right after files are written — the binding becomes permanent. */
  markPersisted(): void {
    this.persistable = false;
  }

  /**
   * Establish an EARLY deterministic binding from unique identity evidence
   * (exactly one new session, arm-time inflight session, or post-arm inflight
   * session). Session-Bound Capture UX: the bound identity becomes visible
   * while the agent is still working, not only at completion time. Never
   * guesses — any multiplicity leaves the policy unresolved.
   */
  tryAutoBind(): boolean {
    if (this.bound) return true;
    const eligible = this.eligibleFromSets();
    if (eligible.size !== 1) return false;
    const id = [...eligible][0]!;
    const reason: BindingReason = this.newSeen.has(id) ? 'unique-new' : 'unique-inflight';
    this.bound = { sessionId: id, reason };
    this.ambiguous = false;
    return true;
  }

  /** Ids of sessions created after arm (read-only view for settle checks). */
  get newSessionIds(): string[] {
    return [...this.newSeen];
  }

  /** Ids that were mid-turn at arm time (read-only view). */
  get armInFlightSnapshot(): string[] {
    return [...this.armInFlightIds];
  }

  /** Ids that became mid-turn AFTER arm time (not in armInFlightSnapshot). */
  get postArmInflightSnapshot(): string[] {
    return [...this.postArmInflightIds];
  }

  /** Candidate list for the minimal user-selection flow (stable order). */
  candidates(): SessionObservation[] {
    const preferred = new Set<string>([
      ...this.newSeen,
      ...this.armInFlightIds,
      ...this.postArmInflightIds,
      ...this.postArmCompletions,
    ]);
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

    const eligible = this.eligibleFromSets();

    if (eligible.size === 1) {
      // Exactly ONE plausible source identified from early evidence.
      const id = onlyOf(eligible)!;
      if (id === sessionId) {
        const reason: BindingReason = this.newSeen.has(id) ? 'unique-new' : 'unique-inflight';
        this.bound = { sessionId: id, reason };
        this.ambiguous = false;
        return 'accept';
      }
      // Exactly one plausible session exists, but THIS completion came from a
      // different one — do not capture it; keep waiting for the plausible one.
      return 'need-selection';
    }

    if (eligible.size > 1) {
      // Multiple plausible sources → ambiguous, never guess.
      this.ambiguous = true;
      return 'need-selection';
    }

    // eligible is empty: no early binding evidence from any tracked set.
    // Fast-completion path (Case B): the agent completed its turn between
    // poll intervals so inFlight was never observed as true.
    // Auto-bind ONLY when this is the SOLE live session that was ever
    // observed by the adapter (lastSeen has exactly one entry and it matches).
    // This prevents incorrectly binding to one of several concurrent sessions.
    this.postArmCompletions.add(sessionId);
    if (
      this.lastSeen.size === 1 &&
      this.lastSeen.has(sessionId) &&
      this.postArmCompletions.size === 1
    ) {
      this.bound = { sessionId, reason: 'unique-inflight' };
      this.ambiguous = false;
      return 'accept';
    }
    this.ambiguous = true;
    return 'need-selection';
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Union of all sets that carry early binding evidence gathered at or after
   * arm time (excluding postArmCompletions, which is only for the decide()
   * fast-completion fallback). Used by tryAutoBind() and candidatesNeedSelection().
   */
  private eligibleFromSets(): Set<string> {
    return new Set<string>([
      ...this.newSeen,
      ...this.armInFlightIds,
      ...this.postArmInflightIds,
    ]);
  }
}
