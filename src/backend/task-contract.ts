/**
 * WBS-4 / V1-01 — TASK_CONTRACT v1.
 *
 * Frozen acceptance contract for a Task. Hash is the single reference for
 * Builder/QA/PM gates. Additive: Tasks without `contract` behave as before.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AcceptanceCriterion, QaContract } from '../shared/types.js';
import { validateTaskQaContractFields } from './qa-contract.js';

export const TASK_CONTRACT_SCHEMA_VERSION = 'task-contract.v1' as const;

export type TaskContractRetryPolicy = {
  same_task_only: boolean;
  max_qa_remediations: number;
  max_pm_changes: number;
};

export type TaskContract = {
  schema_version: typeof TASK_CONTRACT_SCHEMA_VERSION;
  project: string;
  task_id: string;
  goal: string;
  bounded_scope: string;
  acceptance_criteria: AcceptanceCriterion[];
  required_evidence: string[];
  qa_route: QaContract;
  retry_policy: TaskContractRetryPolicy;
  owner_gate_conditions: string[];
  contract_revision: number;
  contract_hash: string;
};

/** Input for build — hash computed; revision defaults to 1. */
export type TaskContractBuildInput = {
  project: string;
  task_id: string;
  goal: string;
  bounded_scope: string;
  acceptance_criteria: AcceptanceCriterion[] | unknown;
  required_evidence?: string[];
  qa_route: QaContract | unknown;
  retry_policy?: Partial<TaskContractRetryPolicy>;
  owner_gate_conditions?: string[];
  contract_revision?: number;
};

export class TaskContractError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'CONTRACT_FROZEN' | 'INVALID_STATE';
  constructor(code: TaskContractError['code'], message: string) {
    super(message);
    this.name = 'TaskContractError';
    this.code = code;
  }
}

const DEFAULT_RETRY: TaskContractRetryPolicy = {
  same_task_only: true,
  max_qa_remediations: 2,
  max_pm_changes: 2,
};

const DEFAULT_OWNER_GATES = [
  'public exposure',
  'credential',
  'destructive op',
  'scope change',
  'product direction',
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && !!v.trim();
}

/** Recursively sort object keys for stable JSON (arrays keep order). */
export function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = canonicalizeForHash(src[key]);
    }
    return out;
  }
  return value;
}

/** Fields that enter the hash (everything except contract_hash). */
function hashPayload(contract: Omit<TaskContract, 'contract_hash'> | TaskContract): Record<string, unknown> {
  return {
    acceptance_criteria: contract.acceptance_criteria,
    bounded_scope: contract.bounded_scope,
    contract_revision: contract.contract_revision,
    goal: contract.goal,
    owner_gate_conditions: contract.owner_gate_conditions,
    project: contract.project,
    qa_route: contract.qa_route,
    required_evidence: contract.required_evidence,
    retry_policy: contract.retry_policy,
    schema_version: contract.schema_version,
    task_id: contract.task_id,
  };
}

export function computeContractHash(contract: Omit<TaskContract, 'contract_hash'> | TaskContract): string {
  const canonical = canonicalizeForHash(hashPayload(contract));
  const body = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export function validateTaskContract(input: unknown): TaskContract {
  if (!input || typeof input !== 'object') {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.schema_version !== TASK_CONTRACT_SCHEMA_VERSION) {
    throw new TaskContractError(
      'INVALID_ARGUMENT',
      `contract.schema_version must be ${TASK_CONTRACT_SCHEMA_VERSION}`,
    );
  }
  if (!isNonEmptyString(raw.project)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.project is required');
  }
  if (!isNonEmptyString(raw.task_id) || !/^TASK-\d+$/.test(raw.task_id.trim())) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.task_id must look like TASK-NNNN');
  }
  if (!isNonEmptyString(raw.goal)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.goal is required');
  }
  if (!isNonEmptyString(raw.bounded_scope)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.bounded_scope is required');
  }
  if (!Array.isArray(raw.required_evidence) || raw.required_evidence.some((x) => typeof x !== 'string')) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.required_evidence must be a string array');
  }
  if (!Array.isArray(raw.owner_gate_conditions) || raw.owner_gate_conditions.some((x) => typeof x !== 'string')) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.owner_gate_conditions must be a string array');
  }
  if (typeof raw.contract_revision !== 'number' || !Number.isInteger(raw.contract_revision) || raw.contract_revision < 1) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.contract_revision must be an integer >= 1');
  }
  if (!isNonEmptyString(raw.contract_hash) || !/^[0-9a-f]{64}$/.test(raw.contract_hash)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.contract_hash must be a sha256 hex string');
  }
  const retryRaw = raw.retry_policy;
  if (!retryRaw || typeof retryRaw !== 'object') {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.retry_policy is required');
  }
  const retry = retryRaw as Record<string, unknown>;
  if (typeof retry.same_task_only !== 'boolean') {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.retry_policy.same_task_only must be boolean');
  }
  if (typeof retry.max_qa_remediations !== 'number' || !Number.isInteger(retry.max_qa_remediations) || retry.max_qa_remediations < 0) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.retry_policy.max_qa_remediations must be an integer >= 0');
  }
  if (typeof retry.max_pm_changes !== 'number' || !Number.isInteger(retry.max_pm_changes) || retry.max_pm_changes < 0) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.retry_policy.max_pm_changes must be an integer >= 0');
  }

  // Reuse QA contract validation (field-naming + AC/qa_route rules).
  const validatedQa = validateTaskQaContractFields({
    scope: (raw.bounded_scope as string).trim(),
    acceptanceCriteria: raw.acceptance_criteria,
    qaContract: raw.qa_route,
  });
  if (!validatedQa) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.acceptance_criteria and contract.qa_route are required');
  }

  const withoutHash: Omit<TaskContract, 'contract_hash'> = {
    schema_version: TASK_CONTRACT_SCHEMA_VERSION,
    project: (raw.project as string).trim(),
    task_id: (raw.task_id as string).trim(),
    goal: (raw.goal as string).trim(),
    bounded_scope: (raw.bounded_scope as string).trim(),
    acceptance_criteria: validatedQa.acceptanceCriteria,
    required_evidence: (raw.required_evidence as string[]).map((s) => s.trim()),
    qa_route: validatedQa.qaContract,
    retry_policy: {
      same_task_only: retry.same_task_only,
      max_qa_remediations: retry.max_qa_remediations,
      max_pm_changes: retry.max_pm_changes,
    },
    owner_gate_conditions: (raw.owner_gate_conditions as string[]).map((s) => s.trim()),
    contract_revision: raw.contract_revision,
  };
  const expected = computeContractHash(withoutHash);
  if (expected !== raw.contract_hash) {
    throw new TaskContractError(
      'INVALID_ARGUMENT',
      `contract.contract_hash mismatch: expected ${expected}, got ${raw.contract_hash}`,
    );
  }
  return { ...withoutHash, contract_hash: expected };
}

export function buildTaskContract(input: TaskContractBuildInput): TaskContract {
  if (!isNonEmptyString(input.project)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.project is required');
  }
  if (!isNonEmptyString(input.task_id) || !/^TASK-\d+$/.test(input.task_id.trim())) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.task_id must look like TASK-NNNN');
  }
  if (!isNonEmptyString(input.goal)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.goal is required');
  }
  if (!isNonEmptyString(input.bounded_scope)) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.bounded_scope is required');
  }
  const revision = input.contract_revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.contract_revision must be an integer >= 1');
  }
  const validatedQa = validateTaskQaContractFields({
    scope: input.bounded_scope.trim(),
    acceptanceCriteria: input.acceptance_criteria,
    qaContract: input.qa_route,
  });
  if (!validatedQa) {
    throw new TaskContractError('INVALID_ARGUMENT', 'contract.acceptance_criteria and contract.qa_route are required');
  }
  const retry_policy: TaskContractRetryPolicy = {
    same_task_only: input.retry_policy?.same_task_only ?? DEFAULT_RETRY.same_task_only,
    max_qa_remediations: input.retry_policy?.max_qa_remediations ?? DEFAULT_RETRY.max_qa_remediations,
    max_pm_changes: input.retry_policy?.max_pm_changes ?? DEFAULT_RETRY.max_pm_changes,
  };
  const withoutHash: Omit<TaskContract, 'contract_hash'> = {
    schema_version: TASK_CONTRACT_SCHEMA_VERSION,
    project: input.project.trim(),
    task_id: input.task_id.trim(),
    goal: input.goal.trim(),
    bounded_scope: input.bounded_scope.trim(),
    acceptance_criteria: validatedQa.acceptanceCriteria,
    required_evidence: (input.required_evidence ?? ['diff --stat', 'test output']).map((s) => s.trim()),
    qa_route: validatedQa.qaContract,
    retry_policy,
    owner_gate_conditions: (input.owner_gate_conditions ?? DEFAULT_OWNER_GATES).map((s) => s.trim()),
    contract_revision: revision,
  };
  const contract_hash = computeContractHash(withoutHash);
  return validateTaskContract({ ...withoutHash, contract_hash });
}

/** True once the Task has left pre-dispatch (has at least one linked Run). */
export function isTaskDispatched(task: { linkedRuns?: unknown }): boolean {
  return Array.isArray(task.linkedRuns) && task.linkedRuns.length > 0;
}

/**
 * Reject mutating an already-dispatched Task's contract unless the caller is
 * only re-asserting the identical hash (no-op). Revision bumps after dispatch
 * are forbidden in V1 (Owner-gated re-contract is out of scope).
 */
export function freezeCheck(
  task: { linkedRuns?: unknown; contract?: TaskContract },
  incoming: TaskContract,
): void {
  const current = task.contract;
  if (!current) {
    if (isTaskDispatched(task)) {
      throw new TaskContractError('CONTRACT_FROZEN', 'CONTRACT_FROZEN: cannot attach a contract after dispatch');
    }
    return;
  }
  if (current.contract_hash === incoming.contract_hash && current.contract_revision === incoming.contract_revision) {
    return;
  }
  if (isTaskDispatched(task)) {
    throw new TaskContractError(
      'CONTRACT_FROZEN',
      'CONTRACT_FROZEN: contract cannot change after the first dispatch',
    );
  }
  if (incoming.contract_revision <= current.contract_revision) {
    throw new TaskContractError(
      'INVALID_ARGUMENT',
      'contract_revision must increase when changing the contract before dispatch',
    );
  }
}

export function taskContractsDir(dataRoot: string, project: string, taskId: string): string {
  return path.join(dataRoot, project, '_relay', 'task-contracts', taskId);
}

export type TaskContractRevisionRecord = {
  taskId: string;
  contract_revision: number;
  revision_reason: string;
  contract_hash: string;
  previous_hash: string | null;
  createdAt: string;
  contract: TaskContract;
};

export function persistContractRevision(
  dataRoot: string,
  project: string,
  record: TaskContractRevisionRecord,
): string {
  const dir = taskContractsDir(dataRoot, project, record.taskId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rev-${record.contract_revision}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function deriveAcceptanceAndQaFromContract(contract: TaskContract): {
  acceptanceCriteria: AcceptanceCriterion[];
  qaContract: QaContract;
} {
  return {
    acceptanceCriteria: contract.acceptance_criteria,
    qaContract: contract.qa_route,
  };
}
