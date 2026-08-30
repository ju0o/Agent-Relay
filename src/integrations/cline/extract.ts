/**
 * Pure extraction of the last completed turn from Cline CLI session files.
 *
 * Cline session storage:
 *   <sessionId>.json — metadata: {id, cwd, status, createdAt, updatedAt, title}
 *   <sessionId>.messages.json — messages wrapper:
 *     {version, updated_at, sessionId, messages:[{id, role, content:[...blocks]}]}
 *
 * Turn boundary: last "user" message whose content is not tool_result marks
 * the start of the current turn. All assistant messages after it form the turn.
 * Turn is complete when the final assistant message has no tool_use blocks.
 *
 * Note: Cline messages do not always carry per-message timestamps. We rely on
 * the messages.json updated_at field as the completedAt proxy, and file mtime
 * for isNew / in-flight detection.
 */

export type ClineExtractKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface ClineSessionSummary {
  ready: boolean;
  hasTurn: boolean;
  kind: ClineExtractKind;
  text: string;
  /** id of the final assistant message — used as dedupe key. */
  messageId: string | null;
  sessionId: string | null;
  cwd: string | null;
  /** ISO timestamp from messages.json updated_at (best proxy for completion time). */
  completedAtIso: string | null;
  startedAtIso: string | null;
  terminalSignal: string;
}

const EMPTY: ClineSessionSummary = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  messageId: null,
  sessionId: null,
  cwd: null,
  completedAtIso: null,
  startedAtIso: null,
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

function isToolResultBlock(block: unknown): boolean {
  const b = asRecord(block);
  return b !== null && b['type'] === 'tool_result';
}

function isRealUserContent(content: unknown): boolean {
  if (!Array.isArray(content)) return typeof content === 'string';
  if (content.length === 0) return true;
  return !content.every((b) => isToolResultBlock(b));
}

function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    const r = asRecord(b);
    return r !== null && r['type'] === 'tool_use';
  });
}

function extractText(content: unknown): string {
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

/** Parse Cline session from raw meta JSON and raw messages JSON. Never throws. */
export function summarizeClineSession(
  metaRaw: string | null,
  messagesRaw: string,
): ClineSessionSummary {
  try {
    if (typeof messagesRaw !== 'string') return { ...EMPTY };

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let updatedAtIso: string | null = null;

    // Parse session metadata
    if (metaRaw && typeof metaRaw === 'string') {
      try {
        const meta = asRecord(JSON.parse(metaRaw));
        if (meta) {
          sessionId = str(meta['id']) || null;
          cwd = str(meta['cwd']) || null;
          // Note: createdAt/updatedAt may be empty strings in some versions.
          const upd = meta['updatedAt'];
          if (upd && str(upd)) updatedAtIso = toIso(upd);
        }
      } catch { /* bad JSON */ }
    }

    // Parse messages
    let messagesJson: Record<string, unknown> | null = null;
    try {
      messagesJson = asRecord(JSON.parse(messagesRaw));
    } catch { return { ...EMPTY, sessionId, cwd }; }

    if (!messagesJson) return { ...EMPTY, sessionId, cwd };

    // Prefer session ID from messages wrapper if not in meta
    if (!sessionId) sessionId = str(messagesJson['sessionId']);

    // Updated_at from messages wrapper (reliable write timestamp)
    const msgUpdatedAt = messagesJson['updated_at'];
    if (msgUpdatedAt) updatedAtIso = toIso(msgUpdatedAt) ?? updatedAtIso;

    const rawMessages = messagesJson['messages'];
    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      return { ...EMPTY, sessionId, cwd };
    }

    // Build typed message list
    interface MsgItem {
      id: string | null;
      role: string;
      content: unknown;
      timestamp: string | null;
    }

    const messages: MsgItem[] = [];
    for (const m of rawMessages) {
      const r = asRecord(m);
      if (!r) continue;
      const role = str(r['role']);
      if (!role) continue;
      messages.push({
        id: str(r['id']),
        role,
        content: r['content'],
        // Some Cline versions include a ts field; fall back to null.
        timestamp: toIso(r['ts'] ?? r['timestamp']),
      });
    }

    if (messages.length === 0) return { ...EMPTY, sessionId, cwd };

    // Find last real user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'user' && isRealUserContent(m.content)) {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx < 0) return { ...EMPTY, sessionId, cwd };

    const turnAssistants = messages
      .slice(lastUserIdx + 1)
      .filter((m) => m.role === 'assistant');

    if (turnAssistants.length === 0) {
      return { ...EMPTY, sessionId, cwd, hasTurn: false };
    }

    const lastAsst = turnAssistants[turnAssistants.length - 1]!;
    if (hasToolUse(lastAsst.content)) {
      // Turn still in flight
      return {
        ...EMPTY,
        hasTurn: true,
        sessionId,
        cwd,
        startedAtIso: turnAssistants[0]!.timestamp,
      };
    }

    // Complete turn
    const text = turnAssistants
      .map((m) => extractText(m.content))
      .filter((t) => t !== '')
      .join('\n\n');

    const completedAtIso = lastAsst.timestamp ?? updatedAtIso;

    return {
      ready: true,
      hasTurn: true,
      kind: 'RESPONSE_COMPLETE',
      text,
      messageId: lastAsst.id,
      sessionId,
      cwd,
      completedAtIso,
      startedAtIso: turnAssistants[0]!.timestamp,
      terminalSignal: 'cline.turn.complete',
    };
  } catch {
    return { ...EMPTY };
  }
}
