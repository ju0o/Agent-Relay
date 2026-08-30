/**
 * Pure extraction of the last completed turn from a Codex CLI session JSONL.
 *
 * Codex session format (newline-delimited JSON):
 *   session_meta — session identity (session_id, cwd, timestamp, cli_version)
 *   event_msg    — structured events; key subtypes:
 *                    task_started (turn_id, started_at unix-seconds)
 *                    task_complete (turn_id, last_agent_message, completed_at)
 *                    turn_failed / error → PROCESS_FAILED
 *   response_item — individual streaming items (not used for completion detection)
 *   turn_context, world_state — ignored
 *
 * IMPORTANT: do not rely on exit codes for completion semantics.
 * A task_complete event present → RESPONSE_COMPLETE, even if exit code was non-zero.
 * Conversely a missing task_complete after task_started → turn still in flight.
 */

export type CodexExtractKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface CodexSessionSummary {
  /** True when the current turn reached a terminal state. */
  ready: boolean;
  /** True when at least one task_started was seen in this session. */
  hasTurn: boolean;
  kind: CodexExtractKind;
  /** Verbatim final agent response (last_agent_message). */
  text: string;
  /** turn_id of the last completed turn — used as dedupe / protocol ref. */
  turnId: string | null;
  /** session_id from session_meta. */
  sessionId: string | null;
  /** Working directory from session_meta. */
  cwd: string | null;
  /** ISO-8601 of turn start (task_started.started_at converted from unix-seconds). */
  startedAtIso: string | null;
  /** ISO-8601 of turn completion (task_complete.completed_at from unix-seconds). */
  completedAtIso: string | null;
  /** Adapter-specific terminal marker string. */
  terminalSignal: string;
}

const EMPTY: CodexSessionSummary = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  turnId: null,
  sessionId: null,
  cwd: null,
  startedAtIso: null,
  completedAtIso: null,
  terminalSignal: '',
};

interface RawEntry {
  timestamp?: unknown;
  type?: unknown;
  payload?: Record<string, unknown>;
}

function parseEntry(line: string): RawEntry | null {
  try {
    const v = JSON.parse(line);
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as RawEntry;
  } catch { /* ignore */ }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** Convert a unix-seconds integer to an ISO-8601 string. */
function unixSecondsToIso(secs: unknown): string | null {
  const n = num(secs);
  if (n === null) return null;
  // Codex stores started_at/completed_at as unix seconds (not ms).
  // Rough sanity: 2020-2040 range is 1577836800 – 2208988800.
  const ms = n > 1e12 ? n : n * 1000; // already ms if > 1e12
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Summarize a complete Codex session JSONL. Never throws. */
export function summarizeCodexSession(raw: string): CodexSessionSummary {
  try {
    if (typeof raw !== 'string') return { ...EMPTY };

    let sessionId: string | null = null;
    let cwd: string | null = null;

    // Per-turn tracking: maps turn_id → {startedAtIso}
    const turnStarts = new Map<string, { startedAtIso: string | null }>();
    // Last completed turn
    let lastComplete: {
      turnId: string;
      text: string;
      startedAtIso: string | null;
      completedAtIso: string | null;
    } | null = null;
    // Track failure signals
    let hasFailed = false;
    let hasInterrupted = false;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const e = parseEntry(line);
      if (!e) continue;

      const type = str(e.type);
      const p = e.payload;

      if (type === 'session_meta' && p) {
        sessionId = str(p['session_id']) ?? str(p['id']) ?? sessionId;
        cwd = str(p['cwd']) ?? cwd;
        continue;
      }

      if (type === 'event_msg' && p) {
        const subtype = str(p['type']);

        if (subtype === 'task_started') {
          const turnId = str(p['turn_id']);
          if (turnId) {
            const startedAtIso = unixSecondsToIso(p['started_at']);
            turnStarts.set(turnId, { startedAtIso });
          }
          continue;
        }

        if (subtype === 'task_complete') {
          const turnId = str(p['turn_id']);
          const text = str(p['last_agent_message']) ?? '';
          const completedAtIso = unixSecondsToIso(p['completed_at']);
          if (turnId) {
            const start = turnStarts.get(turnId);
            lastComplete = {
              turnId,
              text,
              startedAtIso: start?.startedAtIso ?? null,
              completedAtIso,
            };
          }
          continue;
        }

        // Failure/interruption event subtypes
        if (subtype === 'turn_failed' || subtype === 'task_failed' || subtype === 'error') {
          hasFailed = true;
          continue;
        }
        if (subtype === 'turn_interrupted' || subtype === 'task_interrupted') {
          hasInterrupted = true;
          continue;
        }
      }
    }

    const hasTurn = turnStarts.size > 0;

    if (!hasTurn) return { ...EMPTY, sessionId, cwd };

    if (!lastComplete) {
      // task_started seen, no task_complete yet — in flight or failed
      if (hasFailed) {
        return {
          ...EMPTY,
          hasTurn: true,
          ready: true,
          kind: 'PROCESS_FAILED',
          terminalSignal: 'codex.task.failed',
          sessionId,
          cwd,
        };
      }
      if (hasInterrupted) {
        return {
          ...EMPTY,
          hasTurn: true,
          ready: true,
          kind: 'INTERRUPTED',
          terminalSignal: 'codex.task.interrupted',
          sessionId,
          cwd,
        };
      }
      // Still in flight
      return { ...EMPTY, hasTurn: true, sessionId, cwd };
    }

    // Have a complete turn
    let kind: CodexExtractKind = 'RESPONSE_COMPLETE';
    let terminalSignal = 'codex.task_complete';
    if (hasFailed) {
      // Failure event AND a task_complete — trust the structured failure signal.
      kind = 'PROCESS_FAILED';
      terminalSignal = 'codex.task_complete+failed';
    } else if (hasInterrupted) {
      kind = 'INTERRUPTED';
      terminalSignal = 'codex.task_complete+interrupted';
    }

    return {
      ready: true,
      hasTurn: true,
      kind,
      text: lastComplete.text,
      turnId: lastComplete.turnId,
      sessionId,
      cwd,
      startedAtIso: lastComplete.startedAtIso,
      completedAtIso: lastComplete.completedAtIso,
      terminalSignal,
    };
  } catch {
    return { ...EMPTY };
  }
}
