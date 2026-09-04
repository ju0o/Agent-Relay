/**
 * V1-G4-B — PM Verification Context composer (PURE READ).
 *
 * For one pending TASK_VERIFY PM Delivery, composes ONE bounded verification
 * packet with enough information for the PM Host / GPT PM to judge the
 * result without manually locating Task, Run, result text, and Evidence.
 *
 * Canonical input is deliveryId ONLY. The Delivery owns the Task/run
 * identity; callers can never substitute a taskId/runId/path.
 *
 * Safety rules:
 *   - Never accept a caller-provided filesystem path. The Run folder is
 *     resolved server-side from Task.linkedRuns for the delivery runId only.
 *   - Never substitute another Run: a displaced (non-current) delivery
 *     yields isCurrentAttempt=false + warning + NO_JUDGMENT actions.
 *   - Result text comes only from the canonical permitted artifacts
 *     (result.md, agent-result.md fallback), hard-capped. No reasoning
 *     traces or session stores are ever read.
 *   - Trust is never upgraded: OBSERVED stays OBSERVED.
 *   - No mutation: no Task/Delivery/Event/Evidence writes, no GPT calls.
 *   - The packet is rebuildable derived context, not authoritative SSOT.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTask } from './goal-task.js';
import { resolveCurrentAttemptRunId } from './goal-task-runtime.js';
import { getPmDelivery } from './pm-delivery.js';
import {
  getTaskEvidenceSummary,
  listEvidenceForTask,
} from './evidence.js';
import { boundString } from './pm-gateway.js';
import type {
  EvidenceSummary,
  EvidenceStatus,
  EvidenceTrustLevel,
  EvidenceType,
  TaskExecutionState,
  TaskPmState,
} from '../shared/types.js';
import type { PmDeliveryStatus } from './pm-delivery.js';

/** Verification packet schema version. */
export const PM_VERIFICATION_CONTEXT_SCHEMA_VERSION = 'V1-G4B.1' as const;

/**
 * Hard cap for Worker result text in the packet (characters, UTF-16 code
 * units). Large enough for real final responses, small enough to keep the
 * packet bounded for PM consumption. Overflow sets truncated=true.
 */
export const VERIFICATION_RESULT_TEXT_MAX_CHARS = 10_000;

/** Maximum selected Evidence records in the packet. */
export const VERIFICATION_MAX_SELECTED_EVIDENCE = 5;

/** Maximum completion criteria entries exposed. */
const VERIFICATION_MAX_CRITERIA = 20;
/** Maximum characters per completion criterion (matches task-edit bounds). */
const VERIFICATION_MAX_CRITERION_CHARS = 500;
/** Maximum characters per Task narrative field (goal/reason/scope). */
const VERIFICATION_MAX_NARRATIVE_CHARS = 2_000;

export type VerificationResultSource = 'result.md' | 'agent-result.md' | 'missing';

export type VerificationReviewAction = 'ACCEPT_RESULT' | 'REQUEST_CHANGES' | 'NO_JUDGMENT';

export interface VerificationDeliveryView {
  deliveryId: string;
  kind: 'TASK_VERIFY';
  status: PmDeliveryStatus;
}

export interface VerificationTaskView {
  taskId: string;
  title: string;
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  goal: string;
  reason: string;
  scope: string;
  completionCriteria: string[];
}

export interface VerificationAttemptView {
  runId: string;
  isCurrentAttempt: boolean;
  currentAttemptRunId?: string;
  acceptedRunId?: string;
}

export interface VerificationResultView {
  text: string;
  truncated: boolean;
  source: VerificationResultSource;
}

export interface VerificationSelectedEvidence {
  evidenceId: string;
  type: EvidenceType;
  trustLevel: EvidenceTrustLevel;
  status: EvidenceStatus;
  summary: string;
  createdAt: string;
}

export interface VerificationCasSnapshot {
  expectedExecutionState: TaskExecutionState;
  expectedPmState: TaskPmState;
  expectedDeliveryStatus: PmDeliveryStatus;
}

export interface VerificationContextPacket {
  schemaVersion: typeof PM_VERIFICATION_CONTEXT_SCHEMA_VERSION;
  project: string;
  delivery: VerificationDeliveryView;
  task: VerificationTaskView;
  attempt: VerificationAttemptView;
  result: VerificationResultView;
  evidence: {
    summary: EvidenceSummary;
    selected: VerificationSelectedEvidence[];
  };
  /** Advisory only — never executed by the composer. */
  reviewActions: VerificationReviewAction[];
  cas: VerificationCasSnapshot;
  warnings: string[];
}

export class VerificationContextError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_ARGUMENT';
  constructor(code: VerificationContextError['code'], message: string) {
    super(message);
    this.name = 'VerificationContextError';
    this.code = code;
  }
}

function boundNarrative(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > VERIFICATION_MAX_NARRATIVE_CHARS
    ? trimmed.slice(0, VERIFICATION_MAX_NARRATIVE_CHARS) + '…'
    : trimmed;
}

/**
 * Compose the bounded verification packet for one TASK_VERIFY delivery.
 * PURE READ — no writes to Task, Delivery, Event, or Evidence.
 */
export function getVerificationContextForDelivery(
  dataRoot: string,
  project: string,
  deliveryId: string,
): VerificationContextPacket {
  const warnings: string[] = [];

  // 1. Primary identity: the Delivery owns Task/run binding.
  let delivery;
  try {
    delivery = getPmDelivery(dataRoot, project, deliveryId);
  } catch {
    throw new VerificationContextError('NOT_FOUND', `PM Delivery를 찾을 수 없습니다: ${deliveryId}`);
  }
  if (delivery.kind !== 'TASK_VERIFY') {
    throw new VerificationContextError('INVALID_STATE', `TASK_VERIFY delivery가 아닙니다: ${deliveryId}`);
  }
  if (delivery.project !== project) {
    throw new VerificationContextError('INVALID_STATE', `Delivery project 불일치: ${deliveryId}`);
  }

  // 2. Canonical Task truth.
  let task;
  try {
    task = getTask(dataRoot, project, delivery.taskId);
  } catch {
    throw new VerificationContextError('INVALID_STATE', `Delivery Task을 찾을 수 없습니다: ${delivery.taskId}`);
  }

  // 3. The delivery runId must still be linked — never substitute another Run.
  const linked = task.linkedRuns.find((r) => r.runId === delivery.runId);
  if (!linked) {
    throw new VerificationContextError(
      'INVALID_STATE',
      `Delivery Run ${delivery.runId} is no longer linked to Task ${task.taskId}; refusing to compose.`,
    );
  }

  // 4. Current-attempt determination (explicit, never silent).
  const currentAttemptRunId = resolveCurrentAttemptRunId(task);
  const isCurrentAttempt = currentAttemptRunId === delivery.runId;
  if (!isCurrentAttempt) {
    warnings.push(
      `Delivery refers to a displaced historical attempt (delivery runId=${delivery.runId}, ` +
      `current=${currentAttemptRunId ?? 'none'}). Result and actions below describe the historical ` +
      `attempt only; G5 must never judge the newer attempt from this packet.`,
    );
  }

  // 5. Result text from canonical permitted artifacts only.
  const result = readBoundedResultText(linked.folder, warnings);

  // 6. Evidence: summary + exact-run selection (ADAPTER_OBSERVATION first).
  const summary = getTaskEvidenceSummary(dataRoot, project, task.taskId);
  const selected = selectExactRunEvidence(dataRoot, project, task.taskId, delivery.runId, warnings);

  // 7. Advisory review actions — current valid verification only.
  const reviewActions: VerificationReviewAction[] =
    isCurrentAttempt
    && task.executionState === 'RESULT_RECEIVED'
    && task.pmState === 'VERIFYING'
      ? ['ACCEPT_RESULT', 'REQUEST_CHANGES']
      : ['NO_JUDGMENT'];

  return {
    schemaVersion: PM_VERIFICATION_CONTEXT_SCHEMA_VERSION,
    project,
    delivery: {
      deliveryId: delivery.deliveryId,
      kind: delivery.kind,
      status: delivery.status,
    },
    task: {
      taskId: task.taskId,
      title: boundNarrative(task.title).slice(0, VERIFICATION_MAX_NARRATIVE_CHARS),
      executionState: task.executionState,
      pmState: task.pmState,
      goal: boundNarrative(task.goal),
      reason: boundNarrative(task.reason),
      scope: boundNarrative(task.scope),
      completionCriteria: task.completionCriteria
        .filter((c) => typeof c === 'string')
        .slice(0, VERIFICATION_MAX_CRITERIA)
        .map((c) => (c.length > VERIFICATION_MAX_CRITERION_CHARS
          ? c.slice(0, VERIFICATION_MAX_CRITERION_CHARS) + '…'
          : c)),
    },
    attempt: {
      runId: delivery.runId,
      isCurrentAttempt,
      ...(currentAttemptRunId ? { currentAttemptRunId } : {}),
      ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
    },
    result,
    evidence: { summary, selected },
    reviewActions,
    cas: {
      expectedExecutionState: task.executionState,
      expectedPmState: task.pmState,
      expectedDeliveryStatus: delivery.status,
    },
    warnings,
  };
}

/**
 * Read Worker result text from the exact bound Run folder.
 * Priority: result.md, then agent-result.md fallback. Missing/empty both →
 * empty text with source 'missing' + warning (never fabricated).
 * Folder is server-resolved canonical state, never caller input.
 */
function readBoundedResultText(runFolder: string, warnings: string[]): VerificationResultView {
  const folder = path.resolve(runFolder);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(folder);
  } catch {
    stat = undefined;
  }
  if (!stat || !stat.isDirectory()) {
    warnings.push('Bound Run folder is not accessible; result text unavailable.');
    return { text: '', truncated: false, source: 'missing' };
  }
  const readArtifact = (name: 'result.md' | 'agent-result.md'): string | undefined => {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(folder, name), 'utf8');
    } catch {
      return undefined;
    }
    return raw.trim().length > 0 ? raw : undefined;
  };
  const fromResult = readArtifact('result.md');
  if (fromResult !== undefined) {
    return boundResult(fromResult, 'result.md', warnings);
  }
  const fromAgent = readArtifact('agent-result.md');
  if (fromAgent !== undefined) {
    warnings.push('result.md empty/missing; fell back to agent-result.md.');
    return boundResult(fromAgent, 'agent-result.md', warnings);
  }
  warnings.push('result.md and agent-result.md both missing/empty; no result text composed.');
  return { text: '', truncated: false, source: 'missing' };
}

function boundResult(
  text: string,
  source: 'result.md' | 'agent-result.md',
  warnings: string[],
): VerificationResultView {
  if (text.length > VERIFICATION_RESULT_TEXT_MAX_CHARS) {
    warnings.push(
      `Result text truncated to ${VERIFICATION_RESULT_TEXT_MAX_CHARS} chars (was ${text.length}).`,
    );
    return { text: text.slice(0, VERIFICATION_RESULT_TEXT_MAX_CHARS), truncated: true, source };
  }
  return { text, truncated: false, source };
}

/**
 * Select up to VERIFICATION_MAX_SELECTED_EVIDENCE records stamped with the
 * exact delivery runId. ADAPTER_OBSERVATION first (observation provenance is
 * what promoted the result), then remaining in evidenceId order. Trust
 * levels pass through untouched — OBSERVED is never upgraded.
 */
function selectExactRunEvidence(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
  warnings: string[],
): VerificationSelectedEvidence[] {
  let records;
  try {
    records = listEvidenceForTask(dataRoot, project, taskId, true);
  } catch {
    warnings.push('Evidence listing unavailable; selected evidence empty.');
    return [];
  }
  const exact = records.filter((e) => e.runId === runId);
  if (exact.length === 0) {
    warnings.push(`No Evidence stamped with delivery runId=${runId}; selected evidence empty.`);
    return [];
  }
  const rank = (type: EvidenceType): number => (type === 'ADAPTER_OBSERVATION' ? 0 : 1);
  const sorted = [...exact].sort(
    (a, b) => rank(a.type) - rank(b.type) || a.evidenceId.localeCompare(b.evidenceId),
  );
  const kept = sorted.slice(0, VERIFICATION_MAX_SELECTED_EVIDENCE);
  if (sorted.length > kept.length) {
    warnings.push(`Selected evidence capped to ${kept.length} of ${sorted.length} exact-run records.`);
  }
  return kept.map((e) => ({
    evidenceId: e.evidenceId,
    type: e.type,
    trustLevel: e.trustLevel,
    status: e.status,
    summary: boundString(e.summary),
    createdAt: e.createdAt,
  }));
}
