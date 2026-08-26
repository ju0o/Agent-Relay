/**
 * Pure extraction of the final assistant response from an OpenCode
 * session message list (GET /session/:id/message, identical shape to
 * `opencode export <sessionID>`: [{ info, parts }]).
 *
 * Turn model: everything after the LAST user message is the current turn.
 * The turn is complete when its last assistant message carries
 * info.time.completed (or ended abnormally with info.error set).
 */

export type ExtractKind = 'RESPONSE_COMPLETE' | 'PROCESS_FAILED' | 'INTERRUPTED' | 'UNKNOWN';

export interface ExtractResult {
  /** True when the turn reached a terminal state and text can be captured. */
  ready: boolean;
  /** True when the last user turn has at least one assistant message. */
  hasTurn: boolean;
  kind: ExtractKind;
  /** Verbatim response narration (non-synthetic text parts of the whole turn). */
  text: string;
  messageId: string | null;
  sessionId: string | null;
  startedAtIso: string | null;
  completedAtIso: string | null;
  terminalSignal: string;
}

const NOT_READY: ExtractResult = {
  ready: false,
  hasTurn: false,
  kind: 'UNKNOWN',
  text: '',
  messageId: null,
  sessionId: null,
  startedAtIso: null,
  completedAtIso: null,
  terminalSignal: '',
};

interface MsgInfo {
  id?: unknown;
  role?: unknown;
  sessionID?: unknown;
  error?: unknown;
  time?: { created?: unknown; completed?: unknown };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readInfo(m: unknown): MsgInfo | null {
  const rec = asRecord(m);
  if (!rec) return null;
  const info = asRecord(rec['info']);
  if (!info) return null;
  const timeRec = asRecord(info['time']);
  return {
    id: info['id'],
    role: info['role'],
    sessionID: info['sessionID'],
    error: info['error'],
    time: {
      created: timeRec?.['created'],
      completed: timeRec?.['completed'],
    },
  };
}

function toIso(ms: unknown): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Collect verbatim text from a message's parts. Non-string/empty/synthetic
 * parts are ignored; anything malformed fails safe to ''.
 */
export function messageText(m: unknown): string {
  const rec = asRecord(m);
  if (!rec || !Array.isArray(rec['parts'])) return '';
  const out: string[] = [];
  for (const p of rec['parts']) {
    const part = asRecord(p);
    if (!part || part['type'] !== 'text') continue;
    if (part['synthetic'] === true) continue;
    const t = part['text'];
    if (typeof t === 'string' && t.trim() !== '') out.push(t);
  }
  return out.join('\n\n');
}

/** Slice the message list down to the current (last) user turn. Never throws. */
export function pickLastTurn(messages: unknown): unknown[] {
  if (!Array.isArray(messages)) return [];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = readInfo(messages[i]);
    if (info?.role === 'user') {
      lastUser = i;
      break;
    }
  }
  const start = lastUser >= 0 ? lastUser + 1 : 0;
  return messages.slice(start);
}

/** Summarize the last turn of a session's message list. */
export function summarizeLastTurn(messages: unknown): ExtractResult {
  try {
    if (!Array.isArray(messages)) return NOT_READY;

    let sessionId: string | null = null;
    for (let i = messages.length - 1; i >= 0 && !sessionId; i--) {
      const s = readInfo(messages[i])?.sessionID;
      if (typeof s === 'string') sessionId = s;
    }

    const turn = pickLastTurn(messages);
    const assistants = turn.map((m) => ({ raw: m, info: readInfo(m) })).filter((x) => x.info?.role === 'assistant');
    if (assistants.length === 0) return { ...NOT_READY, sessionId };

    const hasTurn = true;

    const last = assistants[assistants.length - 1]!;
    const info = last.info!;
    const completedAtIso = toIso(info.time?.completed);

    let kind: ExtractKind;
    let terminalSignal: string;
    let ready: boolean;

    const errRec = asRecord(info.error);
    if (errRec) {
      const name = typeof errRec['name'] === 'string' ? errRec['name'] : '';
      ready = true;
      if (name === 'MessageAbortedError') {
        kind = 'INTERRUPTED';
        terminalSignal = 'opencode.message.aborted';
      } else {
        kind = 'PROCESS_FAILED';
        terminalSignal = 'opencode.message.failed';
      }
    } else if (completedAtIso) {
      ready = true;
      kind = 'RESPONSE_COMPLETE';
      terminalSignal = 'opencode.message.completed';
    } else {
      ready = false;
      kind = 'UNKNOWN';
      terminalSignal = '';
    }

    const text = assistants.map((a) => messageText(a.raw)).filter((t) => t !== '').join('\n\n');

    return {
      ready,
      hasTurn,
      kind,
      text,
      messageId: typeof info.id === 'string' ? info.id : null,
      sessionId,
      startedAtIso: toIso(info.time?.created),
      completedAtIso,
      terminalSignal,
    };
  } catch {
    return NOT_READY;
  }
}
