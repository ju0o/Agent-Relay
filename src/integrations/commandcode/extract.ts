/**
 * Pure extraction of the last completed turn from a CommandCode (cmdc) session JSONL.
 *
 * CommandCode session format (newline-delimited JSON):
 *   {type:"session", id, timestamp, cwd, version}         — first entry
 *   {type:"model_change", id, parentId, timestamp, model} — model selection
 *   {type:"message", id, parentId, timestamp,
 *     message:{role, content:[...blocks], meta:{source, createdAt, messageId}},
 *     usage?}                                             — conversation messages
 *
 * Turn boundary: the LAST "message" entry with role:"user" whose content
 * contains real text (not tool_result blocks) marks the start of the current turn.
 * All assistant messages after that constitute the current turn.
 * Turn is complete when the final assistant message has no tool_use blocks.
 *
 * Exit code 8 = max-turns. But since we observe file storage, we detect
 * this as an assistant message with only text content (terminal state).
 * The packet spec: separate "transport completed" from "task success".
 */

export type CmdcExtractKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface CmdcSessionSummary {
  ready: boolean;
  hasTurn: boolean;
  kind: CmdcExtractKind;
  /** Concatenated text from all assistant entries in the last turn. */
  text: string;
  /** messageId of the final assistant entry (from meta.messageId). */
  messageId: string | null;
  sessionId: string | null;
  cwd: string | null;
  startedAtIso: string | null;
  completedAtIso: string | null;
  terminalSignal: string;
}

const EMPTY: CmdcSessionSummary = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  messageId: null,
  sessionId: null,
  cwd: null,
  startedAtIso: null,
  completedAtIso: null,
  terminalSignal: '',
};

interface RawEntry {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    meta?: Record<string, unknown>;
  };
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

/** True when a content block is a tool_result (not a real user turn marker). */
function isToolResultBlock(block: unknown): boolean {
  const b = asRecord(block);
  return b !== null && b['type'] === 'tool_result';
}

/** True when this message represents a real user prompt (not a tool-result relay). */
function isRealUserMessage(entry: RawEntry): boolean {
  if (str(entry.message?.role) !== 'user') return false;
  const content = entry.message?.content;
  if (Array.isArray(content)) {
    // If ALL blocks are tool_result, this is just tool output, not a user prompt.
    if (content.length > 0 && content.every((b) => isToolResultBlock(b))) return false;
  }
  return true;
}

/** Concatenate text blocks from one assistant message. */
function assistantText(entry: RawEntry): string {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b || b['type'] !== 'text') continue;
    const t = b['text'];
    if (typeof t === 'string' && t.trim()) out.push(t);
  }
  return out.join('\n\n');
}

/** True when an assistant message has at least one tool_use block (turn not finished). */
function hasToolUse(entry: RawEntry): boolean {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    const r = asRecord(b);
    return r !== null && r['type'] === 'tool_use';
  });
}

/** Summarize a complete CommandCode session JSONL. Never throws. */
export function summarizeCmdcSession(raw: string): CmdcSessionSummary {
  try {
    if (typeof raw !== 'string') return { ...EMPTY };

    let sessionId: string | null = null;
    let cwd: string | null = null;

    // Collect all message entries in order
    interface MsgEntry {
      role: string;
      entry: RawEntry;
      timestamp: string | null;
      messageId: string | null;
    }

    const messages: MsgEntry[] = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const e = parseEntry(line);
      if (!e) continue;

      const type = str(e.type);

      if (type === 'session') {
        sessionId = str(e.id) ?? sessionId;
        cwd = str(e.cwd) ?? cwd;
        continue;
      }

      if (type === 'message') {
        const role = str(e.message?.role);
        if (!role) continue;
        const meta = e.message?.meta;
        const messageId = meta ? str(meta['messageId']) : null;
        const timestamp = str(e.timestamp) ? toIso(e.timestamp) : null;
        messages.push({ role, entry: e, timestamp, messageId });
      }
    }

    if (messages.length === 0) return { ...EMPTY, sessionId, cwd };

    // Find last real user message index (marks start of current turn)
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isRealUserMessage(messages[i]!.entry)) {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx < 0) return { ...EMPTY, sessionId, cwd };

    // Collect assistant messages in current turn
    const turnAssistants = messages
      .slice(lastUserIdx + 1)
      .filter((m) => m.role === 'assistant');

    if (turnAssistants.length === 0) {
      return { ...EMPTY, sessionId, cwd, hasTurn: false };
    }

    const lastAssistant = turnAssistants[turnAssistants.length - 1]!;
    const inFlight = hasToolUse(lastAssistant.entry);

    if (inFlight) {
      // Last assistant message has pending tool calls — turn not complete.
      const startedAtIso = turnAssistants[0]!.timestamp;
      return {
        ...EMPTY,
        hasTurn: true,
        sessionId,
        cwd,
        startedAtIso,
      };
    }

    // Turn complete: concatenate all text from assistant turn
    const text = turnAssistants
      .map((m) => assistantText(m.entry))
      .filter((t) => t !== '')
      .join('\n\n');

    return {
      ready: true,
      hasTurn: true,
      kind: 'RESPONSE_COMPLETE',
      text,
      messageId: lastAssistant.messageId,
      sessionId,
      cwd,
      startedAtIso: turnAssistants[0]!.timestamp,
      completedAtIso: lastAssistant.timestamp,
      terminalSignal: 'cmdc.turn.complete',
    };
  } catch {
    return { ...EMPTY };
  }
}
