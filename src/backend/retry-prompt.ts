/**
 * V1-G5-C — Bounded retry Worker prompt composition.
 *
 * Pure, deterministic, shared by the retry-dispatch backend AND the
 * relay-worker-claude wrapper (which imports this compiled module to
 * recompute the identical prompt for its idempotent prompt.md write).
 *
 * Composed from:
 *   A. canonical original Task contract (title/goal/reason/scope/criteria)
 *   B. PM change reason (bounded)
 *   C. durable retryInstruction from the G5-A intent (bounded)
 *   D. prior attempt identity (source runId, retry runId)
 *   E. bounded prior result excerpt (MAX 2000 chars, result.md then
 *      agent-result.md fallback; "Prior result unavailable" marker otherwise)
 *
 * No full transcript, no chain of thought, no session logs. Total output is
 * capped at 16 KiB (same cap as the initial Worker prompt).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskRecord } from '../shared/types.js';

/** Same cap as the initial Worker prompt (scripts/relay-worker-claude.mjs). */
export const RETRY_PROMPT_SIZE_LIMIT_BYTES = 16 * 1024;

/** Prior result excerpt bound (chars). */
export const MAX_PRIOR_RESULT_EXCERPT_CHARS = 2000;

export interface PriorResultExcerpt {
  excerpt: string;
  /** False when no canonical prior result artifact existed. */
  available: boolean;
}

/**
 * Read only canonical prior source-run artifacts: result.md, then
 * agent-result.md fallback. Never blocks the caller when missing — returns
 * the unavailable marker instead.
 */
export function readPriorResultExcerpt(sourceRunFolder: string): PriorResultExcerpt {
  const candidates = ['result.md', 'agent-result.md'];
  for (const name of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(sourceRunFolder, name), 'utf8');
    } catch {
      continue;
    }
    if (!text || !text.trim()) continue;
    return { excerpt: text.slice(0, MAX_PRIOR_RESULT_EXCERPT_CHARS), available: true };
  }
  return { excerpt: 'Prior result unavailable.', available: false };
}

export interface RetryPromptInput {
  task: Pick<TaskRecord, 'taskId' | 'title' | 'goal' | 'reason' | 'scope' | 'completionCriteria'>;
  /** Stable identity of the retry attempt (one preparation → at most one Run). */
  preparationId: string;
  /** The PM-judged prior attempt. */
  sourceRunId: string;
  /** PM change reason (CHANGES judgment). */
  reason: string;
  /** Durable retry instruction (G5-A intent). */
  retryInstruction: string;
  priorExcerpt: string;
  priorAvailable: boolean;
}

function boundText(value: unknown, maxChars: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.slice(0, maxChars);
}

/**
 * Compose the bounded retry prompt. Throws when the result would exceed the
 * Worker prompt cap (caller must fail safely — never truncate silently into
 * a misleading instruction; inputs are already bounded upstream).
 */
export function composeRetryPrompt(input: RetryPromptInput): string {
  const criteria = (input.task.completionCriteria ?? [])
    .map((c) => `- ${c}`)
    .join('\n') || '- (none)';
  const prompt = [
    'You are executing one Agent Relay Task (retry attempt).',
    '',
    `Task ID: ${input.task.taskId}`,
    `Preparation ID: ${input.preparationId}`,
    '',
    'ORIGINAL TASK',
    'Title:',
    boundText(input.task.title, 2000),
    '',
    'Goal:',
    boundText(input.task.goal, 4000),
    '',
    'Reason:',
    boundText(input.task.reason, 2000) || '(none)',
    '',
    'Scope:',
    boundText(input.task.scope, 2000) || '(none)',
    '',
    'Completion criteria:',
    boundText(criteria, 2000),
    '',
    'PM REVIEW — CHANGES REQUIRED',
    'Reason:',
    boundText(input.reason, 1000),
    '',
    'Retry instruction:',
    boundText(input.retryInstruction, 4000),
    '',
    'PRIOR ATTEMPT',
    `Run: ${input.sourceRunId}`,
    '',
    'Prior result excerpt:',
    input.priorAvailable ? boundText(input.priorExcerpt, MAX_PRIOR_RESULT_EXCERPT_CHARS) : 'Prior result unavailable.',
    '',
    'RULE',
    'Continue the SAME Task.',
    'Address the PM review.',
    'Do not expand scope beyond the original Task contract.',
  ].join('\n');

  const encoded = Buffer.byteLength(prompt, 'utf8');
  if (encoded > RETRY_PROMPT_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Retry prompt exceeds size limit: ${encoded} bytes > ${RETRY_PROMPT_SIZE_LIMIT_BYTES} bytes (16 KiB).`,
    );
  }
  return prompt;
}
