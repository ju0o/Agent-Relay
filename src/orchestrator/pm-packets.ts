import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listEvents } from '../backend/event.js';
import { getTask, listTasks } from '../backend/goal-task.js';
import { listGoals } from '../backend/goal-task.js';
import { getTaskEvidenceSummary } from '../backend/evidence.js';
import { getVerificationContextForDelivery, type VerificationContextPacket } from '../backend/pm-verification-context.js';
import { listQaRemediationPreparations } from '../backend/qa-remediation-preparation.js';
import { listRetryPreparations } from '../backend/retry-preparation.js';
import { listPmJudgments } from '../backend/pm-judgment.js';
import { buildTaskContract, canonicalizeForHash } from '../backend/task-contract.js';
import { CHECK_KINDS } from '../backend/qa-contract.js';
import type { RoleConfig } from '../roles/role-config.js';
import type { TaskRecord } from '../shared/types.js';
import { summarizeAttemptDeterministic, semanticReasonFromAttempt } from '../backend/qa-gate.js';
import type { QaAttemptRecord } from '../backend/qa-attempt.js';

/** Same recipe as task-contract.ts's contract_hash: canonical (sorted-key) JSON, sha256 hex. */
export function contextHash(payload: unknown): string {
  const canonical = canonicalizeForHash(payload);
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function bound(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export type PmOutputContractKind = 'PM_TASK_DECISION v1' | 'PM_JUDGMENT v1';

/** Single source of truth for the plain-text PM response contract appended to every packet. */
export function renderOutputContract(kind: PmOutputContractKind): string {
  if (kind === 'PM_TASK_DECISION v1') {
    const example = buildTaskContract({
      project: 'example', task_id: 'TASK-0001', goal: 'implement the requested change', bounded_scope: 'out.txt only',
      acceptance_criteria: [{ id: 'AC-01', description: 'the output file exists', validationMode: 'DETERMINISTIC' }],
      required_evidence: ['test output'],
      qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] },
      retry_policy: { same_task_only: true, max_qa_remediations: 2, max_pm_changes: 2 },
      owner_gate_conditions: ['public exposure'],
    });
    return [
      '## OUTPUT CONTRACT',
      'You have no tools. Reply with plain text containing exactly one fenced block.',
      'The first line inside the fence must be exactly `PM_TASK_DECISION v1`, followed by one JSON object.',
      'Fields: decision (CREATE_TASK|CHANGES|OWNER_REQUIRED|PROJECT_COMPLETE); task_contract (required only for CREATE_TASK); reason (non-empty explanation).',
      'task_contract input: goal, bounded_scope, acceptance_criteria[{id,description,validationMode: DETERMINISTIC|SEMANTIC|BOTH}], required_evidence[], qa_route, retry_policy{same_task_only,max_qa_remediations,max_pm_changes}, owner_gate_conditions[].',
      'TASK_CONTRACT v1 persisted fields also include schema_version, project, task_id, contract_revision, contract_hash; project/task_id/contract_hash are server-assigned or computed.',
      `qa_route.deterministic checks use only ${[...CHECK_KINDS].join('|')}: fileExists{kind,criterionId?,path}; fileExactContent{kind,criterionId?,path,content}; diffScope{kind,criterionId?,allowedPaths[]}; command{kind,criterionId?,command,args[],cwd?,timeoutMs?,expectExitCode?}. criterionId is required for every DETERMINISTIC/BOTH criterion.`,
      'cwd must be omitted or a workspace-relative path (never absolute).',
      'Every acceptance criterion with validationMode DETERMINISTIC or BOTH must have at least one qa_route.deterministic check whose criterionId equals its id; criteria you cannot check mechanically must be SEMANTIC.',
      'command checks: command is one executable name/path (e.g. node), arguments go in args[].',
      'qa_route.semantic is true|false or an object without qaWorkerId; the orchestrator supplies qaWorkerId from role config and overrides any supplied value.',
      'Minimal valid example:',
      '```json',
      'PM_TASK_DECISION v1',
      JSON.stringify({ decision: 'CREATE_TASK', task_contract: example, reason: 'Implement the bounded change.' }, null, 2),
      '```',
    ].join('\n');
  }
  return [
    '## OUTPUT CONTRACT',
    'You have no tools. Reply with plain text containing exactly one fenced block.',
    'The first line inside the fence must be exactly `PM_JUDGMENT v1`, followed by one JSON object.',
    'Fields: decision (ACCEPT|CHANGES|OWNER_REQUIRED|ACCEPT_AND_NEXT); retry (NONE|SAME_TASK; CHANGES requires SAME_TASK); reason (non-empty explanation); contract_hash (echo the HASHES block contract_hash); context_hash (echo the HASHES block context_hash); retry_instruction (required only for CHANGES); next_task_contract (required only for ACCEPT_AND_NEXT).',
    'Minimal valid example:',
    '```json',
    'PM_JUDGMENT v1',
    '{"decision":"OWNER_REQUIRED","retry":"NONE","reason":"Required information is unavailable.","contract_hash":"<contract_hash from HASHES block>","context_hash":"<context_hash from HASHES block>"}',
    '```',
  ].join('\n');
}

/** Owner locks: role-config.ts's RoleAssignment carries no `ownerGateConditions`
 * field (WBS-1, as committed) — the spec line naming it predates that shape.
 * Fall back to the most recent Task's own contract.owner_gate_conditions when
 * one exists, else the V1_01_TASK_CONTRACT_SPEC.md default list. */
const DEFAULT_OWNER_GATE_CONDITIONS = ['public exposure', 'credential', 'destructive op', 'scope change', 'product direction'];

function readPmContextFile(dataRoot: string, project: string): string {
  const file = path.join(dataRoot, '_relay', 'pm-context', `${project}.md`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export interface PmBootstrapPacket {
  text: string;
  contextHash: string;
}

/**
 * WBS-5 bounded bootstrap packet. Pure read: no canonical mutation.
 * `contextHash` is over the STRUCTURED inputs (not the rendered text), so it
 * is stable across whitespace-only rendering changes and only moves when the
 * underlying durable state actually moves — this is what the
 * "bootstrap blocked, don't re-ask every poll" state-file key relies on.
 */
export function buildPmBootstrapPacket(dataRoot: string, project: string, roleConfig: RoleConfig): PmBootstrapPacket {
  const goals = listGoals(dataRoot, project);
  const tasks = listTasks(dataRoot, project);
  const accepted = tasks.filter((t) => t.pmState === 'ACCEPTED').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const lastAccepted = accepted[0];
  const durableContext = readPmContextFile(dataRoot, project);
  const ownerGateConditions = lastAccepted?.contract?.owner_gate_conditions ?? DEFAULT_OWNER_GATE_CONDITIONS;

  const structured = {
    schemaVersion: 'pm-bootstrap-packet.v1',
    project,
    goals: goals.map((g) => ({ goalId: g.goalId, title: g.title, goalStatement: g.goalStatement, status: g.status })),
    lastAcceptedTask: lastAccepted
      ? { taskId: lastAccepted.taskId, title: lastAccepted.title, goal: bound(lastAccepted.goal, 500), acceptedRunId: lastAccepted.acceptedRunId }
      : null,
    evidenceSummary: lastAccepted ? getTaskEvidenceSummary(dataRoot, project, lastAccepted.taskId) : null,
    durableContext: bound(durableContext, 8000),
    ownerGateConditions,
    pmRole: roleConfig.assignments.find((a) => a.roleId === 'pm') ?? null,
  };

  const lines: string[] = [];
  lines.push(`# PM bootstrap — ${project}`);
  lines.push('');
  lines.push('## Goals');
  if (goals.length === 0) lines.push('(none yet)');
  for (const g of structured.goals) lines.push(`- ${g.goalId} [${g.status}] ${g.title}: ${bound(g.goalStatement, 300)}`);
  lines.push('');
  lines.push('## Last accepted Task');
  lines.push(structured.lastAcceptedTask ? `${structured.lastAcceptedTask.taskId}: ${structured.lastAcceptedTask.title}\ngoal: ${structured.lastAcceptedTask.goal}` : '(none yet — this is the first Task)');
  lines.push('');
  lines.push('## Durable PM context/decisions (_relay/pm-context/<project>.md)');
  lines.push(structured.durableContext || '(none written yet)');
  lines.push('');
  lines.push('## Owner gate conditions');
  lines.push(ownerGateConditions.map((c) => `- ${c}`).join('\n'));
  lines.push('');
  lines.push(renderOutputContract('PM_TASK_DECISION v1'));

  return { text: lines.join('\n'), contextHash: contextHash(structured) };
}

export interface PmFinalGateRetryHistory {
  linkedRuns: Array<{ runId: string; taskRunSequence: number }>;
  qaRemediationPreparations: Array<{ preparationId: string; status: string; sourceQaAttemptId: string; dispatchedRunId?: string }>;
  retryPreparations: Array<{ preparationId: string; status: string; judgmentId: string; dispatchedRunId?: string }>;
}

export interface PmFinalGatePacket {
  schemaVersion: 'pm-final-gate-packet.v1';
  project: string;
  context: VerificationContextPacket;
  retryHistory: PmFinalGateRetryHistory;
  allowedActions: string[];
  contextHash: string;
  text: string;
}

function buildRetryHistory(dataRoot: string, project: string, task: TaskRecord): PmFinalGateRetryHistory {
  return {
    linkedRuns: task.linkedRuns.map((r) => ({ runId: r.runId, taskRunSequence: r.taskRunSequence })),
    qaRemediationPreparations: listQaRemediationPreparations(dataRoot, project)
      .filter((p) => p.taskId === task.taskId)
      .map((p) => ({ preparationId: p.preparationId, status: p.status, sourceQaAttemptId: p.sourceQaAttemptId, ...(p.dispatchedRunId ? { dispatchedRunId: p.dispatchedRunId } : {}) })),
    retryPreparations: listRetryPreparations(dataRoot, project)
      .filter((p) => p.taskId === task.taskId)
      .map((p) => ({ preparationId: p.preparationId, status: p.status, judgmentId: p.judgmentId, ...(p.dispatchedRunId ? { dispatchedRunId: p.dispatchedRunId } : {}) })),
  };
}

/**
 * WBS-8 bounded final-gate packet for one pending TASK_VERIFY delivery.
 * Pure read. `getVerificationContextForDelivery` already enforces the
 * QA-PASS-or-legacy invariant upstream (V1_PACKETS_DESIGN.md §2) — every
 * delivery reachable here is already eligible for PM judgment.
 */
export function buildPmFinalGatePacket(dataRoot: string, project: string, deliveryId: string): PmFinalGatePacket {
  let context = getVerificationContextForDelivery(dataRoot, project, deliveryId);
  const task = getTask(dataRoot, project, context.task.taskId);
  const failedNoResult = task.executionState === 'FAILED' && context.result.source === 'missing';
  if (failedNoResult) {
    context = { ...context, reviewActions: ['REQUEST_CHANGES'], warnings: [...context.warnings, 'Run FAILED before producing a Result; QA not run.'] };
  }
  const retryHistory = buildRetryHistory(dataRoot, project, task);
  const maxChanges = task.contract?.retry_policy?.max_pm_changes ?? 0;
  const usedChanges = listPmJudgments(dataRoot, project).filter((j) => j.taskId === task.taskId && j.decision === 'CHANGES').length;
  const canAct = context.reviewActions.includes('ACCEPT_RESULT');
  const allowedActions = failedNoResult ? ['CHANGES', 'OWNER_REQUIRED'] : canAct ? ['ACCEPT', 'CHANGES', 'OWNER_REQUIRED', 'ACCEPT_AND_NEXT'] : ['OWNER_REQUIRED'];
  const structured = {
    schemaVersion: 'pm-final-gate-packet.v1' as const,
    project,
    context,
    retryHistory,
    allowedActions,
  };
  const lines: string[] = [];
  lines.push(`# PM final gate — ${context.task.taskId} / ${deliveryId}`);
  lines.push('');
  lines.push(`Task: ${context.task.title}`);
  lines.push(`goal: ${context.task.goal}`);
  lines.push(`scope: ${context.task.scope}`);
  if (context.task.contract_hash) lines.push(`contract_hash: ${context.task.contract_hash}`);
  lines.push('');
  lines.push('## Completion criteria');
  for (const c of context.task.completionCriteria) lines.push(`- ${c}`);
  lines.push('');
  lines.push('## Result');
  if (failedNoResult) {
    const runEvents = listEvents(dataRoot, project, { runId: context.attempt.runId }).events;
    const failure = [...runEvents].reverse().find((e) => e.type === 'RUNTIME_ERROR' || e.type === 'RUN_FAILED')?.details;
    const reason = failure && typeof failure === 'object' && typeof (failure as Record<string, unknown>).error === 'string'
      ? (failure as Record<string, unknown>).error as string : task.lastTransitionReason || 'unknown dispatch/runtime failure';
    lines.push(`Run FAILED before producing a Result — reason: ${bound(reason, 1000)}; attempt ${context.attempt.currentAttemptRunId ? task.linkedRuns.find((r) => r.runId === context.attempt.currentAttemptRunId)?.taskRunSequence ?? '?' : '?'} of the Task`);
  } else lines.push(context.result.text || '(no result text)');
  lines.push('');
  lines.push('## Evidence (selected, exact-run)');
  if (context.evidence.selected.length === 0) lines.push('(none — no independently observed evidence for this run)');
  for (const e of context.evidence.selected) lines.push(`- ${e.evidenceId} [${e.type}/${e.trustLevel}/${e.status}]: ${e.summary}`);
  if (context.qa) {
    lines.push('');
    lines.push('## QA');
    lines.push(`status: ${context.qa.status} (attempt #${context.qa.attemptNumber}, escalation: ${context.qa.escalationReason})`);
    lines.push(context.qa.summary);
  } else if (failedNoResult) { lines.push(''); lines.push('## QA'); lines.push('not run'); }
  if (context.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of context.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push(`Allowed actions: ${allowedActions.join(', ')}`);
  lines.push('');
  lines.push('## HASHES TO ECHO EXACTLY');
  lines.push(`contract_hash: ${context.task.contract_hash ?? ''}`);
  lines.push(`context_hash: ${contextHash(structured)}`);
  if (failedNoResult) {
    lines.push('');
    lines.push(`This Run failed before producing a Result due to an infrastructure/runtime failure. Normally choose CHANGES with retry SAME_TASK while retries remain: retries remaining ${Math.max(0, maxChanges - usedChanges)} of ${maxChanges}. Choose OWNER_REQUIRED only when the budget is exhausted or the failure names credentials, public exposure, destructive work, or scope/product direction.`);
  }
  lines.push(renderOutputContract('PM_JUDGMENT v1'));

  return { ...structured, contextHash: contextHash(structured), text: lines.join('\n') };
}

/** QA_PACKET v1 — projection of an existing QaAttemptRecord + its Task contract (Owner §5). */
export function renderQaPacket(attempt: QaAttemptRecord, contract: TaskRecord['contract']): Record<string, unknown> {
  return {
    schema_version: 'qa-packet.v1',
    task_id: attempt.taskId,
    contract_hash: attempt.contractHash ?? contract?.contract_hash,
    acceptance_criteria: contract?.acceptance_criteria ?? [],
    required_evidence: contract?.required_evidence ?? [],
    attempt: { qaAttemptId: attempt.qaAttemptId, qaAttemptNumber: attempt.qaAttemptNumber, runId: attempt.runId },
    deterministic_summary: summarizeAttemptDeterministic(attempt),
  };
}

/** QA_RESULT v1 — projection of an existing QaAttemptRecord's terminal verdict (Owner §5). FAIL is rendered as CHANGES. */
export function renderQaResult(attempt: QaAttemptRecord): Record<string, unknown> {
  const overall = attempt.finalQaStatus === 'FAIL' ? 'CHANGES' : attempt.finalQaStatus;
  const criteria = [
    ...(attempt.deterministic?.checks ?? []).map((c) => ({ id: c.criterionId ?? c.kind, status: c.status, evidence: c.detail })),
    ...(attempt.semantic?.criteria ?? []).map((c) => ({ id: c.id, status: c.status, evidence: c.note })),
  ];
  return {
    schema_version: 'qa-result.v1',
    overall,
    criteria,
    ...(semanticReasonFromAttempt(attempt) ? { failure_reason: semanticReasonFromAttempt(attempt) } : {}),
  };
}
