/**
 * V1 W-A3 — provider quota exhaustion as a first-class runtime signal.
 *
 * Why this module exists: a seat that runs out of provider quota produces
 * output that no downstream parser recognizes ("usage limit reached, resets
 * 11:30pm"), so every strict parser reports its own local failure instead —
 * the semantic QA parser reported `"status:" 라인을 찾을 수 없습니다`, which the
 * QA gate then treated as a work defect, retried 3x against the same
 * exhausted seat, and finally escalated OWNER_REQUIRED. That escalation is
 * what pulled the Founder back into the loop on 2026-09-16 (Phase B run 2,
 * QA-TASK-0006) and it is a release-contract FAIL: an infrastructure limit
 * is never a Founder decision.
 *
 * This module owns exactly two things and nothing else:
 *
 *   1. DETECTION — recognizing a provider quota message in raw adapter output
 *      (`detectQuotaSignal`), including the reset time when one is stated.
 *   2. LEDGER — a durable seat→signal store (`recordQuotaExhaustion` /
 *      `isQuotaExhausted`) so a known-exhausted seat is skipped by every
 *      role's fallback walker until its reset passes, and is re-admitted
 *      automatically afterwards (W-A5 reset queuing).
 *
 * It deliberately does NOT choose fallbacks, enforce the independence
 * invariant, or write audit rows — those belong to the callers that know the
 * role semantics (qa-semantic-evaluator.ts, role-loop.ts, main.ts).
 *
 * Fail-closed bias: detection only fires on explicit provider limit language.
 * A generic error, a timeout, or an empty reply is NOT a quota signal —
 * misclassifying a real defect as "quota, wait for reset" would silently
 * stall the loop, which is worse than the escalation this replaces.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Reason prefix every quota-caused BLOCKED carries, so callers can classify
 * one without re-running detection over persisted text. */
export const QUOTA_EXHAUSTED_REASON_PREFIX = 'QUOTA_EXHAUSTED';

/** A seat with no provider-stated reset time is held this long before it is
 * retried. Short on purpose: an unparsed reset must never park a seat
 * indefinitely — the loop self-heals by re-probing. */
export const DEFAULT_QUOTA_HOLD_MS = 45 * 60 * 1000;
/** Upper bound on any accepted reset time (weekly limits exist; a parsed
 * timestamp beyond this is treated as garbage and replaced by the default
 * hold). */
export const MAX_QUOTA_HOLD_MS = 8 * 24 * 60 * 60 * 1000;

export interface QuotaSignal {
  /** Seat identity exactly as the role config names it — e.g.
   * `qa-worker:claude-code`, `actl-managed:w-v1cert-codex-001`,
   * `opencode/big-pickle`. Opaque to this module. */
  seatId: string;
  /** ISO timestamp of detection. */
  detectedAt: string;
  /** Provider-stated reset time, ISO, when one could be parsed. */
  resetAt?: string;
  /** ISO time before which this seat must not be selected. Always present:
   * `resetAt` when known and sane, else detectedAt + DEFAULT_QUOTA_HOLD_MS. */
  holdUntil: string;
  /** The matched provider line, bounded — evidence, not a claim. */
  matched: string;
  /** Free-form origin marker (e.g. `qa-semantic:QA-3 stdout`). */
  source?: string;
}

export type QuotaDetection = { matched: string; resetAt?: string };

const MATCHED_MAX_CHARS = 300;

/**
 * Explicit provider limit language only. Each entry is a line-level probe;
 * ordering does not matter (first match wins for the evidence string).
 * Sources: Claude Code session/weekly limit lines, Codex "usage limit
 * reached … resets", OpenAI/OpenRouter quota errors, and 429 bodies that
 * name the limit.
 */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /\busage limit (?:reached|exceeded)\b/i,
  /\busage limit resets\b/i,
  /\b(?:weekly|monthly|daily|session|5-hour|five-hour)\s+limit\s+(?:reached|exceeded)\b/i,
  /\byou(?:’ve|'ve| have)\s+reached\s+your\s+(?:usage|plan|weekly|monthly)?\s*limit\b/i,
  /\b(?:quota|credits?)\s+exceeded\b/i,
  /\binsufficient\s+(?:quota|credits?|balance)\b/i,
  /\bout of (?:credits|quota)\b/i,
  /\brate limit(?:ed)?\s*(?:exceeded|reached)\b/i,
  /\bplan limit reached\b/i,
  /"?(?:error|code|type)"?\s*[:=]\s*"?(?:insufficient_quota|rate_limit_exceeded|quota_exceeded)"?/i,
  /\b429\b[^\n]{0,80}\b(?:too many requests|rate limit|quota)\b/i,
];

function bound(value: string): string {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > MATCHED_MAX_CHARS ? `${one.slice(0, MATCHED_MAX_CHARS)}…` : one;
}

/** Next wall-clock occurrence of hour:minute strictly after `now`, in the
 * host local zone — providers state reset times in the operator's own zone
 * ("resets 11:30pm (Asia/Seoul)") and the orchestrator runs there. */
function nextLocalClockTime(now: Date, hour: number, minute: number): Date {
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function sane(at: Date, now: Date): string | undefined {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= now.getTime()) return undefined;
  if (ms - now.getTime() > MAX_QUOTA_HOLD_MS) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Best-effort reset-time extraction. Returns undefined rather than guessing:
 * an absent reset time falls back to DEFAULT_QUOTA_HOLD_MS, so a wrong guess
 * is strictly worse than no guess.
 */
export function parseResetAt(text: string, now: Date = new Date()): string | undefined {
  // 1. Explicit ISO / RFC3339 ("resets at 2026-09-16T23:30:00+09:00").
  const iso = /reset(?:s|ting)?\s*(?:at|on)?\s*[:=]?\s*"?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  if (iso) {
    const parsed = sane(new Date(iso[1]!.replace(' ', 'T')), now);
    if (parsed) return parsed;
  }
  // 2. Epoch seconds/millis in a structured error body.
  const epoch = /"?reset(?:_at|At|s_at|sAt)"?\s*[:=]\s*"?(\d{10,13})"?/i.exec(text);
  if (epoch) {
    const raw = Number(epoch[1]);
    const parsed = sane(new Date(raw > 1e12 ? raw : raw * 1000), now);
    if (parsed) return parsed;
  }
  // 3. 12-hour clock ("resets 11:30pm", "limit resets at 4 PM").
  const twelve = /reset(?:s|ting)?\s*(?:at|on)?\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i.exec(text);
  if (twelve) {
    let hour = Number(twelve[1]);
    const minute = twelve[2] ? Number(twelve[2]) : 0;
    const pm = twelve[3]!.toLowerCase() === 'p';
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (hour === 12) hour = 0;
      if (pm) hour += 12;
      const parsed = sane(nextLocalClockTime(now, hour, minute), now);
      if (parsed) return parsed;
    }
  }
  // 4. 24-hour clock ("resets at 23:30").
  const twentyFour = /reset(?:s|ting)?\s*(?:at|on)?\s*(\d{1,2}):(\d{2})\b(?!\s*[ap]\.?m)/i.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour <= 23 && minute <= 59) {
      const parsed = sane(nextLocalClockTime(now, hour, minute), now);
      if (parsed) return parsed;
    }
  }
  // 5. Relative ("resets in 3 hours", "try again in 45 minutes").
  const relative = /(?:reset(?:s|ting)?|try again|available|retry)\s*(?:in|after)\s*(\d{1,4})\s*(second|sec|s|minute|min|m|hour|hr|h|day|d)\b/i.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const factor = unit.startsWith('s') ? 1_000
      : unit === 'm' || unit.startsWith('min') ? 60_000
        : unit.startsWith('h') ? 3_600_000
          : 86_400_000;
    const parsed = sane(new Date(now.getTime() + amount * factor), now);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Detect a provider quota/limit message in raw adapter output. Returns null
 * for anything that is not explicit limit language — see the fail-closed
 * note in the module header.
 */
export function detectQuotaSignal(text: string | undefined, now: Date = new Date()): QuotaDetection | null {
  if (!text) return null;
  for (const line of text.split('\n')) {
    for (const pattern of QUOTA_PATTERNS) {
      if (!pattern.test(line)) continue;
      // The reset time is often on a neighbouring line, so parse against the
      // whole text while quoting only the matched line as evidence.
      const resetAt = parseResetAt(text, now);
      return { matched: bound(line), ...(resetAt ? { resetAt } : {}) };
    }
  }
  return null;
}

// ── durable seat ledger ──────────────────────────────────────────────────────

/** Seat-scoped, not project-scoped: a provider limit applies to the account
 * behind the seat, so every project must observe the same state. Mirrors the
 * `{dataRoot}/_relay/roles/` convention role-config.ts already uses. */
export function quotaStatePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '_relay', 'quota', 'state.json');
}

type QuotaLedger = { schemaVersion: 'quota-ledger.v1'; seats: Record<string, QuotaSignal> };

function readLedger(dataRoot: string): QuotaLedger {
  try {
    const raw = JSON.parse(fs.readFileSync(quotaStatePath(dataRoot), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schemaVersion: 'quota-ledger.v1', seats: {} };
    const seats = (raw as QuotaLedger).seats;
    return { schemaVersion: 'quota-ledger.v1', seats: seats && typeof seats === 'object' && !Array.isArray(seats) ? seats : {} };
  } catch {
    // A missing or corrupt ledger must never block dispatch: unknown seat
    // state means "try it", and the provider itself corrects that.
    return { schemaVersion: 'quota-ledger.v1', seats: {} };
  }
}

function writeLedger(dataRoot: string, ledger: QuotaLedger): void {
  const file = quotaStatePath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Record (or refresh) one seat's exhaustion. Returns the stored signal. */
export function recordQuotaExhaustion(
  dataRoot: string,
  seatId: string,
  detection: QuotaDetection,
  options: { now?: Date; source?: string } = {},
): QuotaSignal {
  const now = options.now ?? new Date();
  const holdUntil = detection.resetAt && sane(new Date(detection.resetAt), now)
    ? detection.resetAt
    : new Date(now.getTime() + DEFAULT_QUOTA_HOLD_MS).toISOString();
  const signal: QuotaSignal = {
    seatId,
    detectedAt: now.toISOString(),
    ...(detection.resetAt ? { resetAt: detection.resetAt } : {}),
    holdUntil,
    matched: bound(detection.matched),
    ...(options.source ? { source: options.source } : {}),
  };
  const ledger = readLedger(dataRoot);
  ledger.seats[seatId] = signal;
  writeLedger(dataRoot, ledger);
  return signal;
}

/**
 * Active exhaustion for a seat, or null. A hold whose time has passed is
 * dropped here — reset queuing needs no separate sweeper, the next selection
 * pass re-admits the seat on its own.
 */
export function isQuotaExhausted(dataRoot: string, seatId: string, now: Date = new Date()): QuotaSignal | null {
  const ledger = readLedger(dataRoot);
  const signal = ledger.seats[seatId];
  if (!signal) return null;
  const holdMs = Date.parse(signal.holdUntil ?? '');
  if (!Number.isFinite(holdMs) || holdMs <= now.getTime()) {
    delete ledger.seats[seatId];
    try { writeLedger(dataRoot, ledger); } catch { /* best-effort expiry */ }
    return null;
  }
  return signal;
}

/** Explicit clear — used when a seat answers successfully, so a stale hold
 * can never outlive the real limit. */
export function clearQuotaExhaustion(dataRoot: string, seatId: string): void {
  const ledger = readLedger(dataRoot);
  if (!(seatId in ledger.seats)) return;
  delete ledger.seats[seatId];
  try { writeLedger(dataRoot, ledger); } catch { /* best-effort */ }
}

/** Earliest hold expiry across the given seats — the "resume at" time when a
 * whole role chain is exhausted (W-A5). undefined if none are held. */
export function earliestQuotaRelease(dataRoot: string, seatIds: readonly string[], now: Date = new Date()): string | undefined {
  let best: number | undefined;
  for (const seatId of seatIds) {
    const signal = isQuotaExhausted(dataRoot, seatId, now);
    if (!signal) continue;
    const ms = Date.parse(signal.holdUntil);
    if (Number.isFinite(ms) && (best === undefined || ms < best)) best = ms;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

/** Full ledger snapshot for the `quota-status` reporter / TUI. */
export function listQuotaSignals(dataRoot: string, now: Date = new Date()): QuotaSignal[] {
  const ledger = readLedger(dataRoot);
  return Object.keys(ledger.seats)
    .map((seatId) => isQuotaExhausted(dataRoot, seatId, now))
    .filter((signal): signal is QuotaSignal => signal !== null)
    .sort((a, b) => a.holdUntil.localeCompare(b.holdUntil));
}

/** The canonical machine-parsable reason string for a quota block. */
export function quotaExhaustedReason(seatIds: readonly string[], releaseAt: string | undefined): string {
  const seats = seatIds.length ? seatIds.join(', ') : '(none)';
  return `${QUOTA_EXHAUSTED_REASON_PREFIX}: every configured seat is out of provider quota [${seats}]${releaseAt ? `; resetAt=${releaseAt}` : '; resetAt=unknown'}`;
}

/** True when a reason string was produced by the quota path. */
export function isQuotaExhaustedReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && reason.includes(QUOTA_EXHAUSTED_REASON_PREFIX);
}

/** Extract `resetAt=<iso>` from a quota reason string, when present. */
export function resetAtFromReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const match = /resetAt=(\d{4}-\d{2}-\d{2}T[^\s;,\]]+)/.exec(reason);
  return match ? match[1] : undefined;
}
