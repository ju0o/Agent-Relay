/**
 * Pure extraction of the last completed turn from Grok CLI session files.
 *
 * Grok session storage:
 *   summary.json — {info:{id, cwd}, created_at, updated_at, num_messages, ...}
 *   chat_history.jsonl — newline-delimited messages:
 *     {"type":"system","content":"..."}
 *     {"type":"user","content":[{type,text,...}], ...}
 *     {"type":"assistant","content":[{type,text,...}], ...}
 *     {"type":"tool","content":[{type:"tool_result",...}], ...}
 *
 * Turn boundary: last "user" message with real text content (not synthetic
 * system reminders) marks the start of the current turn. All "assistant"
 * messages after that form the current turn.
 * Turn is complete when the final assistant message has no tool_use blocks.
 *
 * "user" messages with synthetic_reason:"system_reminder" are NOT turn starters.
 */

export type GrokExtractKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface GrokSessionSummary {
  ready: boolean;
  hasTurn: boolean;
  kind: GrokExtractKind;
  text: string;
  /** Content hash of the final assistant message text — used as dedupe key. */
  turnKey: string | null;
  sessionId: string | null;
  cwd: string | null;
  createdAtIso: string | null;
  updatedAtIso: string | null;
  startedAtIso: string | null;
  completedAtIso: string | null;
  terminalSignal: string;
}

const EMPTY: GrokSessionSummary = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  turnKey: null,
  sessionId: null,
  cwd: null,
  createdAtIso: null,
  updatedAtIso: null,
  startedAtIso: null,
  completedAtIso: null,
  terminalSignal: '',
};

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function toIso(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const ms = typeof v === 'number' ? v : Date.parse(v as string);
  return isNaN(ms) ? null : new Date(ms).toISOString();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseEntry(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return asRecord(v);
  } catch {
    return null;
  }
}

function isToolUse(block: unknown): boolean {
  const b = asRecord(block);
  return b !== null && b['type'] === 'tool_use';
}

function hasToolUseInContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isToolUse);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b) continue;
    if (b['type'] === 'text') {
      const t = b['text'];
      if (typeof t === 'string' && t.trim()) parts.push(t.trim());
    }
  }
  return parts.join('\n\n');
}

/** Simple non-crypto hash for dedupe purposes (no Node crypto needed). */
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0; // keep uint32
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Summarize a Grok session from summary.json and chat_history.jsonl content.
 * Never throws.
 */
export function summarizeGrokSession(
  summaryRaw: string,
  chatHistoryRaw: string,
): GrokSessionSummary {
  try {
    if (typeof chatHistoryRaw !== 'string') return { ...EMPTY };

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let createdAtIso: string | null = null;
    let updatedAtIso: string | null = null;

    // Parse summary.json
    if (typeof summaryRaw === 'string') {
      try {
        const summary = asRecord(JSON.parse(summaryRaw));
        if (summary) {
          const info = asRecord(summary['info']);
          if (info) {
            sessionId = str(info['id']);
            cwd = str(info['cwd']);
          }
          createdAtIso = toIso(summary['created_at']);
          updatedAtIso = toIso(summary['updated_at']);
        }
      } catch { /* ignore */ }
    }

    // Parse chat_history.jsonl
    interface MsgItem {
      type: string;
      content: unknown;
      isSynthetic: boolean;
      timestamp: string | null;
    }

    const messages: MsgItem[] = [];

    for (const line of chatHistoryRaw.split('\n')) {
      if (!line.trim()) continue;
      const e = parseEntry(line);
      if (!e) continue;

      const type = str(e['type']);
      if (!type) continue;
      // Skip system entries
      if (type === 'system') continue;

      const isSynthetic = str(e['synthetic_reason']) !== null;
      const timestamp = toIso(e['timestamp'] ?? e['ts'] ?? null);

      messages.push({ type, content: e['content'], isSynthetic, timestamp });
    }

    if (messages.length === 0) return { ...EMPTY, sessionId, cwd, createdAtIso, updatedAtIso };

    // Find last real user message (not synthetic)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.type === 'user' && !m.isSynthetic) {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx < 0) {
      return { ...EMPTY, sessionId, cwd, createdAtIso, updatedAtIso };
    }

    const turnAssistants = messages
      .slice(lastUserIdx + 1)
      .filter((m) => m.type === 'assistant');

    if (turnAssistants.length === 0) {
      return { ...EMPTY, sessionId, cwd, createdAtIso, updatedAtIso, hasTurn: false };
    }

    const lastAsst = turnAssistants[turnAssistants.length - 1]!;
    if (hasToolUseInContent(lastAsst.content)) {
      // Still in flight
      return {
        ...EMPTY,
        hasTurn: true,
        sessionId,
        cwd,
        createdAtIso,
        updatedAtIso,
        startedAtIso: turnAssistants[0]!.timestamp,
      };
    }

    // Complete — aggregate text
    const text = turnAssistants
      .map((m) => extractTextFromContent(m.content))
      .filter((t) => t !== '')
      .join('\n\n');

    // Turn key for dedupe: hash of content + session + last-assistant position
    const turnKey = `${sessionId ?? ''}:${simpleHash(text)}`;
    const completedAtIso = lastAsst.timestamp ?? updatedAtIso;

    return {
      ready: true,
      hasTurn: true,
      kind: 'RESPONSE_COMPLETE',
      text,
      turnKey,
      sessionId,
      cwd,
      createdAtIso,
      updatedAtIso,
      startedAtIso: turnAssistants[0]!.timestamp,
      completedAtIso,
      terminalSignal: 'grok.turn.complete',
    };
  } catch {
    return { ...EMPTY };
  }
}
