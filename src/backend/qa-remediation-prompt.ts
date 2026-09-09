/**
 * V1.6 Slice 4 — bounded QA-remediation Worker prompt composition.
 *
 * Pure, deterministic, mirrors retry-prompt.ts's own discipline (same 16 KiB
 * cap, same bounded prior-result excerpt). Composed from ONLY:
 *
 *   A. canonical original frozen Task contract (title/goal/reason/scope/
 *      completionCriteria + the failed AC ids with their frozen text)
 *   B. failed criterion ids (derived server-side from the QA attempt —
 *      never Worker prose, never caller input)
 *   C. bounded deterministic failure evidence (check verdicts, truncated)
 *   D. Semantic QA reason + remediationInstruction where applicable
 *      (durable attempt fields — never caller input)
 *   E. bounded prior implementation-result excerpt
 *   F. remediation identity (preparation id, source run, attempt number)
 *
 * No full transcript, no chain of thought, no session logs, no secrets.
 */

import type { TaskRecord } from '../shared/types.js';
import { readPriorResultExcerpt } from './retry-prompt.js';

export { readPriorResultExcerpt };

/** Same cap as the initial Worker prompt and the retry prompt. */
export const QA_REMEDIATION_PROMPT_SIZE_LIMIT_BYTES = 16 * 1024;

export const MAX_QA_REMEDIATION_EVIDENCE_CHARS = 2000;
export const MAX_QA_REMEDIATION_REASON_CHARS = 1000;
export const MAX_QA_REMEDIATION_INSTRUCTION_CHARS = 4000;

export interface QaRemediationPromptInput {
  task: Pick<
    TaskRecord,
    'taskId' | 'title' | 'goal' | 'reason' | 'scope' | 'completionCriteria' | 'acceptanceCriteria'
  >;
  /** Stable identity of the remediation (one preparation → at most one Run). */
  preparationId: string;
  /** The QA-FAILed implementation Run being remediated. */
  sourceRunId: string;
  /** 1-based QA remediation number for this Task (advisory, from the prep). */
  qaRemediationNumber: number;
  /** Failed AC ids, from the durable QA attempt — never caller-supplied. */
  failedCriteria: string[];
  /** Bounded deterministic check-verdict summary, from the durable attempt. */
  deterministicSummary: string;
  /** Semantic failure reason, from the durable attempt (if any). */
  semanticReason?: string;
  /** Semantic remediationInstruction, from the durable attempt (if any). */
  remediationInstruction?: string;
  priorExcerpt: string;
  priorAvailable: boolean;
}

function boundText(value: unknown, maxChars: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.slice(0, maxChars);
}

/**
 * Compose the bounded remediation prompt. Throws when the result would
 * exceed the Worker prompt cap (caller must fail safely — never truncate
 * silently into a misleading instruction; inputs are already bounded
 * upstream).
 */
export function composeQaRemediationPrompt(input: QaRemediationPromptInput): string {
  const failedSet = new Set(input.failedCriteria);
  const failedCriteriaBlock = (input.task.acceptanceCriteria ?? [])
    .filter((c) => failedSet.has(c.id))
    .map((c) => `- ${c.id} [${c.validationMode}]: ${boundText(c.description, 1000)}`)
    .join('\n') || input.failedCriteria.map((id) => `- ${id}`).join('\n') || '- (none recorded)';

  const prompt = [
    'You are executing one Agent Relay Task (QA remediation attempt).',
    '',
    'This is QA remediation for the SAME Task — not a new Task, not a PM review retry.',
    'Fix ONLY the verified failures listed below.',
    'Do NOT reinterpret or expand the original Task scope.',
    'Do NOT invent new requirements beyond the frozen Task and acceptance criteria.',
    '',
    `Task ID: ${input.task.taskId}`,
    `Preparation ID: ${input.preparationId}`,
    `Source Run (failed attempt): ${input.sourceRunId}`,
    `QA remediation attempt: ${input.qaRemediationNumber}`,
    '',
    'ORIGINAL TASK (frozen contract — unchanged)',
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
    'VERIFIED FAILURES (authoritative — derived by the QA gate, not by the prior Worker)',
    'Failed criteria:',
    failedCriteriaBlock,
    '',
    'Deterministic QA evidence (mechanical facts):',
    boundText(input.deterministicSummary, MAX_QA_REMEDIATION_EVIDENCE_CHARS) || '(none)',
    ...(input.semanticReason
      ? ['', 'Semantic QA reason:', boundText(input.semanticReason, MAX_QA_REMEDIATION_REASON_CHARS)]
      : []
    ),
    ...(input.remediationInstruction
      ? ['', 'Remediation instruction:', boundText(input.remediationInstruction, MAX_QA_REMEDIATION_INSTRUCTION_CHARS)]
      : []
    ),
    '',
    'PRIOR ATTEMPT',
    `Run: ${input.sourceRunId}`,
    '',
    'Prior result excerpt:',
    input.priorAvailable ? input.priorExcerpt : 'Prior result unavailable.',
    '',
    'RULE',
    'Continue the SAME Task with the SAME scope.',
    'Address ONLY the verified failures above.',
    'Do not expand scope beyond the original Task contract.',
  ].join('\n');

  const encoded = Buffer.byteLength(prompt, 'utf8');
  if (encoded > QA_REMEDIATION_PROMPT_SIZE_LIMIT_BYTES) {
    throw new Error(
      `QA remediation prompt exceeds size limit: ${encoded} bytes > ${QA_REMEDIATION_PROMPT_SIZE_LIMIT_BYTES} bytes (16 KiB).`,
    );
  }
  return prompt;
}
