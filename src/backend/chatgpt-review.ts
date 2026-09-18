/**
 * AUTO Goal Loop — ChatGPT Runtime Adapter.
 *
 * Boundary (frozen):
 * - Treats `codex-chatgpt-web` as an EXTERNAL tool only.
 * - Never vendors, copies, or forks its source into Agent Relay.
 * - Talks to it only via its external surfaces:
 *   1. Responses-compatible HTTP listener (default http://127.0.0.1:17841/v1)
 *   2. External CLI (`bun .../app/cli.js`) only for status probing — never bundled.
 *
 * Failure contract (§14):
 * - If the launcher/session/model/connector/transport is unavailable,
 *   return { verdict: 'REVIEW_BLOCKED', blockedLayer, detail }.
 * - NEVER silently mark PASS.
 * - The current Run/Result stays durable; the caller must stop the loop.
 *
 * Reviewer role (§6): independent reviewer / PM judgment helper.
 * Bounded canonical context only: Goal, Task, acceptance criteria, Run
 * identity, current Result (truncated), diff stat (bounded), repo SHA
 * (bounded). Never asserts "Worker completed successfully" as fact.
 */

import * as http from 'node:http';
import * as https from 'node:https';

export const CHATGPT_VERDICTS = ['PASS', 'CHANGES', 'BLOCKED', 'OWNER_REQUIRED', 'REVIEW_BLOCKED'] as const;
export type ChatGptVerdict = (typeof CHATGPT_VERDICTS)[number];

export type ChatGptBlockedLayer =
  | 'launcher-unavailable'
  | 'session-unavailable'
  | 'model-unavailable'
  | 'connector-unavailable'
  | 'transport-error'
  | 'mock'; // explicit test-only path, never used by default

export interface ChatGptReviewContext {
  goalTitle: string;
  goalStatement: string;
  taskId: string;
  taskTitle: string;
  acceptanceCriteria: string[];
  runId: string;
  /** Task-scoped attempt sequence (1-based). */
  attemptSequence: number;
  /** Bounded result text (already truncated by caller). */
  resultExcerpt: string;
  /** Bounded diff stat (already truncated by caller). */
  diffStat: string;
  /** Bounded repo SHA (short). */
  repoSha: string;
  /** Retry instruction from previous CHANGES, if any (bounded). */
  priorRetryInstruction?: string;
}

export interface ChatGptReviewResult {
  verdict: ChatGptVerdict;
  reason: string;
  /** Present only for CHANGES (bounded retry instruction for SAME-task retry). */
  retryInstruction?: string;
  /** Present only for REVIEW_BLOCKED (exact missing layer). */
  blockedLayer?: ChatGptBlockedLayer;
  /** Raw detail for diagnostics (bounded). */
  detail?: string;
  /** True when a real ChatGPT transport answered (false for mock/blocked). */
  viaExternalTool: boolean;
}

export interface ChatGptReviewOptions {
  /** Responses base URL. Default from env CODEX_WEB_GPT_RESPONSES_URL or 127.0.0.1:17841/v1. */
  baseUrl?: string;
  /** Milliseconds per HTTP call. Default 15000. */
  timeoutMs?: number;
  /** Model row to request (passed through only). Default 'auto'. */
  model?: string;
  /**
   * Test-only deterministic verdict. NEVER set in production paths.
   * Allowed values: 'mock-pass' | 'mock-changes' | 'mock-blocked' |
   * 'mock-changes-then-pass' (first call CHANGES, later calls PASS — E2E proof only).
   * When set, no external tool is touched and viaExternalTool=false.
   */
  reviewMode?: 'real' | 'mock-pass' | 'mock-changes' | 'mock-blocked' | 'mock-changes-then-pass';
}

export const REVIEW_RESULT_MAX_CHARS = 8000;
export const REVIEW_REASON_MAX_CHARS = 1000;
export const REVIEW_INSTRUCTION_MAX_CHARS = 4000;

/** Test-only call counter for mock-changes-then-pass. Resettable in tests. */
let mockCalls = 0;
export function _resetChatGptMockForTests(): void {
  mockCalls = 0;
}

function bound(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function defaultBaseUrl(): string {
  const env = (process.env.CODEX_WEB_GPT_RESPONSES_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  return 'http://127.0.0.1:17841/v1';
}

function httpJson(
  url: string,
  opts: { method: string; timeoutMs: number; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), 'utf8');
      const req = lib.request(
        u,
        {
          method: opts.method,
          timeout: opts.timeoutMs,
          headers: {
            'content-type': 'application/json',
            ...(payload ? { 'content-length': String(payload.length) } : {}),
            ...(opts.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function buildReviewPrompt(ctx: ChatGptReviewContext): string {
  const criteria = ctx.acceptanceCriteria.length
    ? ctx.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '(none stated — judge only what is evidenced)';
  return [
    'You are an INDEPENDENT reviewer for a coding-agent run. Do NOT assume success.',
    'Inspect only the evidence below. Never claim the worker succeeded as fact.',
    '',
    `Goal: ${ctx.goalTitle}`,
    `Goal statement: ${ctx.goalStatement}`,
    `Task: ${ctx.taskId} — ${ctx.taskTitle}`,
    `Run: ${ctx.runId} (attempt ${ctx.attemptSequence})`,
    `Repo SHA: ${ctx.repoSha}`,
    'Acceptance criteria:',
    criteria,
    '',
    'Diff stat (bounded):',
    ctx.diffStat || '(none)',
    '',
    'Result excerpt (bounded, this is the CLAIM to verify — not proof):',
    ctx.resultExcerpt || '(empty)',
    ctx.priorRetryInstruction ? `\nPrior retry instruction (context only):\n${ctx.priorRetryInstruction}` : '',
    '',
    'Return EXACTLY one verdict line first: PASS, CHANGES, BLOCKED, or OWNER_REQUIRED.',
    'PASS = evidence satisfies acceptance criteria. CHANGES = concrete fixable gaps remain (then give a bounded retry instruction).',
    'BLOCKED = cannot proceed without external unblock (state what). OWNER_REQUIRED = genuine human product/security/credential decision needed (state what).',
    'Then a short reason (<=10 lines). For CHANGES, add a final "RETRY:" paragraph with the concrete next instruction.',
  ].join('\n');
}

function parseVerdictText(text: string): { verdict: ChatGptVerdict; reason: string; retryInstruction?: string } {
  const first = (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || '').toUpperCase();
  let verdict: ChatGptVerdict = 'BLOCKED';
  if (first.startsWith('PASS')) verdict = 'PASS';
  else if (first.startsWith('CHANGES')) verdict = 'CHANGES';
  else if (first.startsWith('OWNER_REQUIRED') || first.startsWith('OWNER-REQUIRED') || first.startsWith('OWNER')) verdict = 'OWNER_REQUIRED';
  else verdict = 'BLOCKED';
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const reason = bound(lines.slice(1, 11).join(' ') || lines[0] || 'no reason given', REVIEW_REASON_MAX_CHARS);
  let retryInstruction: string | undefined;
  const retryIdx = text.toUpperCase().lastIndexOf('RETRY:');
  if (verdict === 'CHANGES' && retryIdx >= 0) {
    retryInstruction = bound(text.slice(retryIdx + 'RETRY:'.length).trim(), REVIEW_INSTRUCTION_MAX_CHARS);
  }
  if (verdict === 'CHANGES' && !retryInstruction) {
    retryInstruction = bound(reason, REVIEW_INSTRUCTION_MAX_CHARS);
  }
  return { verdict, reason, retryInstruction };
}

/**
 * Independent review of one canonical Run result.
 * Real path touches ONLY the external Responses HTTP surface.
 */
export async function reviewRunWithChatGpt(
  ctx: ChatGptReviewContext,
  opts: ChatGptReviewOptions = {},
): Promise<ChatGptReviewResult> {
  const mode = opts.reviewMode ?? 'real';
  if (mode !== 'real') {
    if (mode === 'mock-pass') {
      return { verdict: 'PASS', reason: 'mock reviewer (explicit test mode)', viaExternalTool: false, blockedLayer: 'mock' };
    }
    if (mode === 'mock-changes-then-pass') {
      mockCalls += 1;
      if (mockCalls === 1) {
        return {
          verdict: 'CHANGES',
          reason: 'mock reviewer found a gap on attempt 1 (explicit E2E proof mode)',
          retryInstruction: 'Mock retry instruction: fix the gap from attempt 1 and resubmit.',
          viaExternalTool: false,
          blockedLayer: 'mock',
        };
      }
      return { verdict: 'PASS', reason: 'mock reviewer satisfied on retry (explicit E2E proof mode)', viaExternalTool: false, blockedLayer: 'mock' };
    }
    if (mode === 'mock-changes') {
      return {
        verdict: 'CHANGES',
        reason: 'mock reviewer found a gap (explicit test mode)',
        retryInstruction: 'Mock retry instruction: fix the gap and resubmit.',
        viaExternalTool: false,
        blockedLayer: 'mock',
      };
    }
    return { verdict: 'BLOCKED', reason: 'mock reviewer blocked (explicit test mode)', viaExternalTool: false, blockedLayer: 'mock' };
  }

  const baseUrl = (opts.baseUrl ?? defaultBaseUrl()).replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 15000;
  const model = opts.model ?? 'auto';

  // Layer 1: transport / listener reachable?
  let modelsText: string;
  let modelsStatus: number;
  try {
    const r = await httpJson(`${baseUrl}/models`, { method: 'GET', timeoutMs: Math.min(timeoutMs, 8000) });
    modelsStatus = r.status;
    modelsText = r.text;
  } catch (e) {
    return {
      verdict: 'REVIEW_BLOCKED',
      blockedLayer: 'transport-error',
      reason: 'ChatGPT Responses listener unreachable.',
      detail: bound(e instanceof Error ? e.message : String(e), 500),
      viaExternalTool: false,
    };
  }
  if (modelsStatus < 200 || modelsStatus >= 300) {
    return {
      verdict: 'REVIEW_BLOCKED',
      blockedLayer: 'launcher-unavailable',
      reason: 'ChatGPT launcher listener answered with an error.',
      detail: bound(`GET /models -> ${modelsStatus} ${modelsText.slice(0, 300)}`, 500),
      viaExternalTool: false,
    };
  }

  // Layer 2: ask the external tool for a review completion.
  // Try Responses-style endpoints in order; treat 404 as connector/model issue, not PASS.
  const prompt = buildReviewPrompt(ctx);
  const bodies: Array<{ path: string; body: unknown }> = [
    { path: '/responses', body: { model, input: prompt } },
    { path: '/chat/completions', body: { model, messages: [{ role: 'user', content: prompt }] } },
  ];
  let lastDetail = '';
  for (const b of bodies) {
    try {
      const r = await httpJson(`${baseUrl}${b.path}`, { method: 'POST', timeoutMs, body: b.body });
      if (r.status === 404) {
        lastDetail = `POST ${b.path} -> 404`;
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        lastDetail = `POST ${b.path} -> ${r.status} ${r.text.slice(0, 300)}`;
        continue;
      }
      const text = extractCompletionText(r.text);
      if (!text) {
        lastDetail = `POST ${b.path} -> empty completion`;
        continue;
      }
      const parsed = parseVerdictText(bound(text, REVIEW_RESULT_MAX_CHARS));
      if (parsed.verdict === 'OWNER_REQUIRED' || parsed.verdict === 'BLOCKED') {
        return { ...parsed, viaExternalTool: true };
      }
      return { ...parsed, viaExternalTool: true };
    } catch (e) {
      lastDetail = `${b.path}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const layer: ChatGptBlockedLayer = /timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(lastDetail)
    ? 'transport-error'
    : 'connector-unavailable';
  return {
    verdict: 'REVIEW_BLOCKED',
    blockedLayer: layer,
    reason: 'ChatGPT review transport answered but no usable completion endpoint.',
    detail: bound(lastDetail || 'unknown', 500),
    viaExternalTool: false,
  };
}

function extractCompletionText(raw: string): string {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const choice = (j['choices'] as Array<Record<string, unknown>> | undefined)?.[0];
    const msg = choice?.['message'] as Record<string, unknown> | undefined;
    if (typeof msg?.['content'] === 'string' && msg['content'].trim()) return msg['content'];
    if (Array.isArray(msg?.['content'])) {
      const parts = (msg['content'] as Array<Record<string, unknown>>)
        .map((p) => (typeof p['text'] === 'string' ? p['text'] : typeof p['content'] === 'string' ? (p['content'] as string) : ''))
        .join('\n');
      if (parts.trim()) return parts;
    }
    if (typeof choice?.['text'] === 'string' && (choice['text'] as string).trim()) return choice['text'] as string;
    const out = j['output'];
    if (typeof out === 'string' && out.trim()) return out;
    if (Array.isArray(out)) {
      const parts: string[] = [];
      for (const item of out as Array<Record<string, unknown>>) {
        const content = item['content'];
        if (typeof content === 'string') parts.push(content);
        else if (Array.isArray(content)) {
          for (const c of content as Array<Record<string, unknown>>) {
            if (typeof c['text'] === 'string') parts.push(c['text']);
          }
        }
      }
      if (parts.join('\n').trim()) return parts.join('\n');
    }
    if (typeof j['output_text'] === 'string' && (j['output_text'] as string).trim()) return j['output_text'] as string;
  } catch {
    // fall through — raw may already be plain text
  }
  const t = raw.trim();
  return t.length > 0 && t.length < 20000 ? t : '';
}
