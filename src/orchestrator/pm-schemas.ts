/**
 * WBS-5/8 — strict parsers for the PM adapter's one fenced structured-output
 * block. Deliberately JSON-only inside the fence (the spec allows JSON-or-YAML;
 * js-yaml is only a transitive dependency here, not a direct one, and
 * docs/PM_ROLE_INSTRUCTIONS.md tells the PM to always emit JSON, so YAML
 * support is not needed and is not added).
 *
 * Never mutates canonical state. Throws PmSchemaError (INVALID_STRUCTURED_OUTPUT)
 * on any shape/field-naming problem; the caller (role-loop.ts) re-asks once.
 */

export class PmSchemaError extends Error {
  readonly code = 'INVALID_STRUCTURED_OUTPUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PmSchemaError';
  }
}

export type PmTaskDecisionKind = 'CREATE_TASK' | 'CHANGES' | 'OWNER_REQUIRED' | 'PROJECT_COMPLETE';
export const PM_TASK_DECISIONS: readonly PmTaskDecisionKind[] = ['CREATE_TASK', 'CHANGES', 'OWNER_REQUIRED', 'PROJECT_COMPLETE'];

export interface PmTaskDecision {
  decision: PmTaskDecisionKind;
  /** Raw TASK_CONTRACT v1 fields (project/task_id/contract_hash are server-assigned, never read from here). Required iff decision === 'CREATE_TASK'. */
  task_contract?: Record<string, unknown>;
  reason: string;
  /** Additive wire action accepted by the autonomous bootstrap loop. */
  action?: 'DISPATCH' | 'REQUEST_CHANGES' | 'ACCEPT' | 'HUMAN_GATE' | 'MILESTONE_COMPLETE';
  taskId?: string;
}

export type PmJudgmentDecisionKind = 'ACCEPT' | 'CHANGES' | 'OWNER_REQUIRED' | 'ACCEPT_AND_NEXT';
export const PM_JUDGMENT_DECISIONS: readonly PmJudgmentDecisionKind[] = ['ACCEPT', 'CHANGES', 'OWNER_REQUIRED', 'ACCEPT_AND_NEXT'];
export type PmJudgmentRetry = 'NONE' | 'SAME_TASK';

export interface PmJudgment {
  decision: PmJudgmentDecisionKind;
  retry: PmJudgmentRetry;
  reason: string;
  contract_hash: string;
  context_hash: string;
  /** Required iff decision === 'CHANGES'. */
  retry_instruction?: string;
  /** Required iff decision === 'ACCEPT_AND_NEXT'. Raw TASK_CONTRACT v1 fields, same rules as PmTaskDecision.task_contract. */
  next_task_contract?: Record<string, unknown>;
}

function extractFenceBody(text: string, expectedHeader: string): string {
  const fences = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)];
  if (fences.length === 0) {
    throw new PmSchemaError(`no fenced block found; expected exactly one fenced ${expectedHeader} block`);
  }
  if (fences.length > 1) {
    throw new PmSchemaError(`expected exactly one fenced block, found ${fences.length}`);
  }
  const body = fences[0]![1]!;
  const lines = body.split(/\r?\n/);
  const header = (lines[0] ?? '').trim();
  if (header !== expectedHeader) {
    throw new PmSchemaError(`fenced block header must be exactly "${expectedHeader}", got "${header}"`);
  }
  const rest = lines.slice(1).join('\n').trim();
  if (!rest) {
    throw new PmSchemaError(`fenced ${expectedHeader} block has no JSON body`);
  }
  return rest;
}

function parseJsonObject(body: string, expectedHeader: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    throw new PmSchemaError(`fenced ${expectedHeader} body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PmSchemaError(`fenced ${expectedHeader} body must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], header: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PmSchemaError(`${header}: unknown field "${key}" (field-naming error; allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireNonEmptyString(obj: Record<string, unknown>, field: string, header: string): string {
  const v = obj[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw new PmSchemaError(`${header}: field "${field}" must be a non-empty string`);
  }
  return v.trim();
}

export function parsePmTaskDecision(text: string): PmTaskDecision {
  const HEADER = 'PM_TASK_DECISION v1';
  const body = extractFenceBody(text, HEADER);
  const obj = parseJsonObject(body, HEADER);
  rejectUnknownKeys(obj, ['decision', 'task_contract', 'reason'], HEADER);
  const decision = obj['decision'];
  if (typeof decision !== 'string' || !PM_TASK_DECISIONS.includes(decision as PmTaskDecisionKind)) {
    throw new PmSchemaError(`${HEADER}: field "decision" must be one of ${PM_TASK_DECISIONS.join('|')}, got ${JSON.stringify(decision)}`);
  }
  const reason = requireNonEmptyString(obj, 'reason', HEADER);
  if (decision === 'CREATE_TASK') {
    const tc = obj['task_contract'];
    if (!tc || typeof tc !== 'object' || Array.isArray(tc)) {
      throw new PmSchemaError(`${HEADER}: decision CREATE_TASK requires an object field "task_contract"`);
    }
    return { decision: decision as PmTaskDecisionKind, task_contract: tc as Record<string, unknown>, reason };
  }
  if (obj['task_contract'] !== undefined) {
    throw new PmSchemaError(`${HEADER}: field "task_contract" is only allowed when decision === CREATE_TASK`);
  }
  return { decision: decision as PmTaskDecisionKind, reason };
}

export function parsePmJudgment(text: string): PmJudgment {
  const HEADER = 'PM_JUDGMENT v1';
  const body = extractFenceBody(text, HEADER);
  const obj = parseJsonObject(body, HEADER);
  rejectUnknownKeys(obj, ['decision', 'retry', 'reason', 'contract_hash', 'context_hash', 'retry_instruction', 'next_task_contract'], HEADER);
  const decision = obj['decision'];
  if (typeof decision !== 'string' || !PM_JUDGMENT_DECISIONS.includes(decision as PmJudgmentDecisionKind)) {
    throw new PmSchemaError(`${HEADER}: field "decision" must be one of ${PM_JUDGMENT_DECISIONS.join('|')}, got ${JSON.stringify(decision)}`);
  }
  const retry = obj['retry'];
  if (retry !== 'NONE' && retry !== 'SAME_TASK') {
    throw new PmSchemaError(`${HEADER}: field "retry" must be NONE|SAME_TASK, got ${JSON.stringify(retry)}`);
  }
  const reason = requireNonEmptyString(obj, 'reason', HEADER);
  const contract_hash = requireNonEmptyString(obj, 'contract_hash', HEADER);
  const context_hash = requireNonEmptyString(obj, 'context_hash', HEADER);
  const result: PmJudgment = { decision: decision as PmJudgmentDecisionKind, retry, reason, contract_hash, context_hash };
  if (decision === 'CHANGES') {
    if (retry !== 'SAME_TASK') {
      throw new PmSchemaError(`${HEADER}: decision CHANGES requires retry === SAME_TASK`);
    }
    result.retry_instruction = requireNonEmptyString(obj, 'retry_instruction', HEADER);
  } else if (obj['retry_instruction'] !== undefined) {
    throw new PmSchemaError(`${HEADER}: field "retry_instruction" is only allowed when decision === CHANGES`);
  }
  if (decision === 'ACCEPT_AND_NEXT') {
    const ntc = obj['next_task_contract'];
    if (!ntc || typeof ntc !== 'object' || Array.isArray(ntc)) {
      throw new PmSchemaError(`${HEADER}: decision ACCEPT_AND_NEXT requires an object field "next_task_contract"`);
    }
    result.next_task_contract = ntc as Record<string, unknown>;
  } else if (obj['next_task_contract'] !== undefined) {
    throw new PmSchemaError(`${HEADER}: field "next_task_contract" is only allowed when decision === ACCEPT_AND_NEXT`);
  }
  return result;
}
