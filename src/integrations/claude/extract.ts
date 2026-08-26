/**
 * Pure extraction of the final assistant response from a Claude Code
 * session transcript (~/.claude/projects/<project>/<sessionId>.jsonl).
 *
 * Transcript model: newline-delimited JSON entries appended per message.
 * A turn = everything after the LAST real user prompt. Tool results are also
 * logged as `type:"user"` but carry tool_result payloads and never reset the
 * turn. The turn is COMPLETE when its last assistant entry carries
 * message.stop_reason === 'end_turn'; streaming turns end with
 * 'tool_use'/undefined and are NOT ready.
 */

export type ClaudeExtractKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface ClaudeTranscriptSummary {
  /** True when the current turn reached a terminal state. */
  ready: boolean;
  /** True when the last user prompt has at least one assistant reply line. */
  hasTurn: boolean;
  kind: ClaudeExtractKind;
  /** Verbatim response narration: all text blocks of the turn's assistant lines. */
  text: string;
  /** uuid of the last assistant entry (raw protocol identity). */
  messageId: string | null;
  sessionId: string | null;
  /** Workspace the session runs in (cwd field of transcript entries). */
  cwd: string | null;
  /** Human title when the transcript carries an ai-title entry. */
  title: string | null;
  startedAtIso: string | null;
  completedAtIso: string | null;
  terminalSignal: string;
}

const EMPTY: ClaudeTranscriptSummary = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  messageId: null,
  sessionId: null,
  cwd: null,
  title: null,
  startedAtIso: null,
  completedAtIso: null,
  terminalSignal: '',
};

interface Entry {
  type?: unknown;
  subtype?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  title?: unknown;
  message?: {
    role?: unknown;
    stop_reason?: unknown;
    content?: unknown;
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseEntry(line: string): Entry | null {
  try {
    const rec = asRecord(JSON.parse(line));
    return rec ? (rec as unknown as Entry) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Concatenate all text blocks of one assistant message (thinking/tools excluded). */
function assistantText(entry: Entry): string {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (!b || b['type'] !== 'text') continue;
    const t = b['text'];
    if (typeof t === 'string' && t.trim() !== '') out.push(t);
  }
  return out.join('\n\n');
}

function toIso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

interface TurnInfo {
  assistants: Entry[];
}

/**
 * Real user PROMPTS mark turn boundaries. Tool results are ALSO recorded as
 * `type:"user"` entries by Claude Code — those are continuation records, not
 * boundaries, so they must never reset the current turn.
 */
function isUserPrompt(e: Entry): boolean {
  if (e.type !== 'user') return false;
  const content = e.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = asRecord(block);
      if (b && b['type'] === 'tool_result') return false;
      if (b && (b['type'] === 'text' || b['type'] === 'image')) return true;
    }
    return true;
  }
  return true;
}

function splitTurn(entries: Entry[]): TurnInfo {
  let lastPromptIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserPrompt(entries[i]!)) {
      lastPromptIdx = i;
      break;
    }
  }
  const start = lastPromptIdx >= 0 ? lastPromptIdx + 1 : 0;
  const assistants = entries
    .slice(start)
    .filter((e) => e.type === 'assistant' && asRecord(e.message));
  return { assistants };
}

/**
 * Summarize a whole raw transcript (file contents). Tolerates partial trailing
 * lines and any malformed entries — never throws.
 */
export function summarizeClaudeTranscript(raw: string): ClaudeTranscriptSummary {
  try {
    if (typeof raw !== 'string') return { ...EMPTY };

    const entries: Entry[] = [];
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let title: string | null = null;

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const e = parseEntry(line);
      if (!e) continue;
      entries.push(e);
      sessionId = str(e.sessionId) ?? str(e.session_id) ?? sessionId;
      cwd = str(e.cwd) ?? cwd;
      if (e.type === 'ai-title') title = str(e.title) ?? title;
    }

    if (entries.length === 0) return { ...EMPTY };

    const { assistants } = splitTurn(entries);
    if (assistants.length === 0) {
      return { ...EMPTY, sessionId, cwd, title };
    }

    const last = assistants[assistants.length - 1]!;
    const stop = last.message?.stop_reason;
    const text = assistants.map((a) => assistantText(a)).filter((t) => t !== '').join('\n\n');

    let ready: boolean;
    let kind: ClaudeExtractKind;
    let terminalSignal: string;
    if (stop === 'end_turn') {
      ready = true;
      kind = 'RESPONSE_COMPLETE';
      terminalSignal = 'claude.turn.end_turn';
    } else if (stop === 'max_tokens') {
      // Response exists but was truncated — surfaced separately from success.
      ready = true;
      kind = 'UNKNOWN';
      terminalSignal = 'claude.turn.truncated';
    } else {
      ready = false;
      kind = 'UNKNOWN';
      terminalSignal = '';
    }

    return {
      ready,
      hasTurn: true,
      kind,
      text,
      messageId: str(last.uuid),
      sessionId,
      cwd,
      title,
      startedAtIso: toIso(assistants[0]!.timestamp),
      completedAtIso: toIso(last.timestamp),
      terminalSignal,
    };
  } catch {
    return { ...EMPTY };
  }
}
