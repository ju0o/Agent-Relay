/**
 * PM Gateway — Phase F: Pure Context Composer.
 *
 * getContextForEvent() is PURE READ. It MUST NOT:
 *   - mutate Goal, Task, Run, Evidence, or Event delivery state
 *   - mint ACCEPTED, PM_DECISION, or any Event
 *   - launch Workers, retry Workers, or complete Goals
 *   - call GPT APIs or any remote service
 *   - write any files
 *
 * Packet is derived/rebuildable. Repeated calls for unchanged SSOT produce the
 * same packet (except generatedAt, which is always the current time).
 *
 * Missing primary Event → HARD FAIL.
 * Malformed/missing linked neighbor → partial packet + warnings[].
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  EventRecord,
  EventDeliveryRecord,
  EventDeliveryStatus,
  EventType,
  EventSeverity,
  EventSource,
  PmAttention,
  TaskRecord,
  TaskExecutionState,
  TaskPmState,
  GoalRecord,
  GoalStatus,
  LinkedRunRef,
  EvidenceRecord,
  EvidenceSummary,
  EvidenceStatus,
  EvidenceTrustLevel,
  EvidenceType,
  EvidenceSource,
  EvidenceDetails,
} from '../shared/types.js';
import { getEvent, getDelivery, eventFolder } from './event.js';
import { getTask, getGoal, listTasks } from './goal-task.js';
import {
  evaluateGoalCompletion,
  collectDependencyInfo,
} from './goal-task-runtime.js';
import {
  listEvidenceForTask,
  listEvidenceWithDiagnostics,
  summarizeEvidence,
} from './evidence.js';

// ── Phase F schema version ──────────────────────────────────────────────────

export const PM_GATEWAY_SCHEMA_VERSION = 'F.1' as const;

// ── Phase F size contract bounds ─────────────────────────────────────────────

/** Maximum string length for bounded string fields in the PM context packet. */
const MAX_BOUNDED_STRING = 512;
/** Maximum evidenceIds exposed in refs. */
const MAX_REFS_EVIDENCE_IDS = 10;
/** Maximum rawRefs exposed in refs. */
const MAX_REFS_RAW = 5;
/** Maximum artifactRefs exposed in refs. */
const MAX_REFS_ARTIFACT = 5;
/** Maximum artifactRefs per BoundedEvidenceRecord. */
const MAX_EVIDENCE_ARTIFACT_REFS = 5;
/** Maximum items in arrays within bounded details. */
const MAX_DETAILS_ARRAY_ITEMS = 10;
/** Maximum keys in objects within bounded details. */
const MAX_DETAILS_OBJECT_KEYS = 20;
/** Maximum nesting depth for bounded details sanitizer. */
const MAX_DETAILS_DEPTH = 3;

// ── Allowed actions vocabulary ──────────────────────────────────────────────

export const PM_ALLOWED_ACTIONS = [
  'ACCEPT_RESULT',
  'REQUEST_CHANGES',
  'REQUEST_RETRY',
  'ACK_EVENT',
  'IGNORE_EVENT',
  'NO_ACTION',
] as const;

export type PmAllowedAction = (typeof PM_ALLOWED_ACTIONS)[number];

// ── CAS snapshot ────────────────────────────────────────────────────────────

export interface CasSnapshot {
  /** Delivery status at packet generation time (stale if SSOT changed since). */
  expectedEventDeliveryStatus: EventDeliveryStatus;
  /** Present when Task-linked. */
  expectedPmState?: TaskPmState;
  /** Present when Task-linked. */
  expectedExecutionState?: TaskExecutionState;
}

// ── Logical refs ────────────────────────────────────────────────────────────

export interface PmContextRefs {
  eventId: string;
  goalId?: string;
  taskId?: string;
  runId?: string;
  evidenceIds?: string[];
  rawRefs?: string[];
  artifactRefs?: string[];
}

// ── Compact shapes ──────────────────────────────────────────────────────────

export interface CompactGoalSummary {
  goalId: string;
  title: string;
  status: GoalStatus;
  completionCriteriaCount: number;
}

export interface CompactTaskSummary {
  taskId: string;
  title: string;
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  acceptedRunId?: string;
  linkedRunsCount: number;
}

/**
 * Bounded PM Task context snapshot — replaces full TaskRecord in the packet.
 *
 * Deliberately excludes:
 *   - linkedRuns (full attempt history)
 *   - folder paths
 *   - audit timestamps (createdAt / updatedAt) unless essential
 *   - large narrative fields (goal / reason / scope text) unless documented
 * Includes latestRunId as a logical-ID convenience.
 */
export interface PmTaskContext {
  taskId: string;
  goalId: string;
  title: string;
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  acceptedRunId?: string;
  dependencies: string[];
  completionCriteriaCount: number;
  blockedReason?: string;
  retryCount?: number;
  /** Logical run ID of the most-recent linked run (no folder path). */
  latestRunId?: string;
}

/**
 * Bounded run reference for the packet — physical folder path excluded.
 *
 * Physical locator (folder) remains internal Relay data and MUST NOT appear
 * in the PM context packet.
 */
export interface BoundedRunRef {
  runId: string;
  taskRunSequence: number;
  agent?: string;
  date?: string;
  // folder intentionally excluded — physical locator is internal
}

/**
 * Bounded Event record for the packet — details sanitized and metadata stripped.
 *
 * Preserves identity / classification / linkage fields.
 * details is recursively bounded to prevent large prompt/result payloads.
 * metadata intentionally excluded — may be oversized.
 */
export interface BoundedEventRecord {
  schemaVersion: number;
  eventId: string;
  project: string;
  type: EventType;
  severity: EventSeverity;
  goalId?: string;
  taskId?: string;
  runId?: string;
  evidenceId?: string;
  source: EventSource;
  /** Bounded to MAX_BOUNDED_STRING characters. */
  summary: string;
  /** Sanitized details — large strings truncated, large arrays capped. */
  details?: Record<string, unknown>;
  occurredAt: string;
  recordedAt: string;
  attentionClassifierVersion: number;
  sourceEventId?: string;
  correlationId?: string;
  causationId?: string;
  pmAttention: PmAttention;
  // metadata intentionally excluded — may be oversized
}

/** Bounded evidence record: metadata stripped to avoid oversized blobs. */
export interface BoundedEvidenceRecord {
  evidenceId: string;
  project: string;
  type: EvidenceType;
  trustLevel: EvidenceTrustLevel;
  status: EvidenceStatus;
  source: EvidenceSource;
  /** Bounded to MAX_BOUNDED_STRING characters. */
  summary: string;
  createdAt: string;
  goalId?: string;
  taskId?: string;
  runId?: string;
  /**
   * Type-specific structured details — recursively bounded.
   * Large strings are truncated; large arrays are capped.
   * No prompt/result raw text can pass through.
   */
  details?: EvidenceDetails;
  rawRef?: string;
  /** Capped at MAX_EVIDENCE_ARTIFACT_REFS. */
  artifactRefs?: string[];
  /** metadata intentionally excluded — may be oversized. */
}

export interface CurrentAttemptInfo {
  currentAttemptRunId?: string;
  acceptedRunId?: string;
  latestRunId?: string;
}

export interface AttemptSummary {
  runId: string;
  taskRunSequence: number;
  isAccepted: boolean;
  isLatest: boolean;
  evidenceSummary: EvidenceSummary;
}

export interface DependencySummary {
  dependencies: string[];
  unsatisfiedDependencies: string[];
  blockedBy: string[];
  dependenciesSatisfied: boolean;
}

export interface RuntimeSummaryInfo {
  source?: string;
  subsystem?: string;
}

// ── Packet ──────────────────────────────────────────────────────────────────

export interface PmContextPacket {
  /** Always 'F.1'. */
  schemaVersion: typeof PM_GATEWAY_SCHEMA_VERSION;
  project: string;
  /**
   * Bounded Event record (the triggering event).
   * details are sanitized; metadata excluded to prevent unbounded payload.
   */
  event: BoundedEventRecord;
  /** Current delivery snapshot at packet generation time. */
  eventDelivery: EventDeliveryRecord;
  /** Advisory actions — map to existing Phase E commands. MUST NOT invent new commands. */
  allowedActions: PmAllowedAction[];
  /**
   * CAS snapshot. stale packet WILL CONFLICT when used in a subsequent command.
   * Composer MUST NOT refresh stale CAS during packet generation.
   */
  cas: CasSnapshot;
  /** Logical refs — no absolute paths. */
  refs: PmContextRefs;
  /** ISO timestamp at packet generation. Only non-authoritative field that changes on replay. */
  generatedAt: string;
  /** Always present (empty array when no issues). */
  warnings: string[];

  // ── Profile-driven optional fields ──────────────────────────────────────
  /** Compact Goal summary (profile-driven). */
  goal?: CompactGoalSummary;
  /**
   * Bounded PM Task context snapshot (profile-driven, present when Task-linked).
   * Does NOT expose linkedRuns, folder paths, or full audit history.
   */
  task?: PmTaskContext;
  /**
   * Bounded run reference for the current attempt (profile-driven).
   * Physical folder path excluded — only logical IDs and metadata.
   */
  run?: BoundedRunRef;
  /** Evidence summary for the current attempt (profile-driven). */
  evidenceSummary?: EvidenceSummary;
  /** Selected judgment-relevant Evidence records (max 5, no prompt/result text). */
  selectedEvidence?: BoundedEvidenceRecord[];
  /** Attempt awareness fields (profile-driven). */
  currentAttempt?: CurrentAttemptInfo;
  /** Previous attempt summaries (max 3). */
  previousAttempts?: AttemptSummary[];
  /** Dependency summary (profile-driven). */
  dependencySummary?: DependencySummary;
  /** Runtime source/subsystem info (profile-driven). */
  runtimeSummary?: RuntimeSummaryInfo;
  /** Compact Task summaries for GOAL_COMPLETION_ELIGIBLE (no full Task dumps). */
  taskCompletionSummaries?: CompactTaskSummary[];
}

// ── Informational event types ────────────────────────────────────────────────

const INFORMATIONAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'RUN_RESULT_RECEIVED',
  'EVIDENCE_READY',
  'TASK_BECAME_READY',
  'GOAL_COMPLETED',
  'RUNTIME_WARNING',
]);

// ── Action eligibility (derived from canonical B2 state) ─────────────────────

/**
 * Derive advisory allowed actions.
 *
 * Rules (from Phase F contract):
 * - Terminal delivery (ACKNOWLEDGED/IGNORED) → NO_ACTION only.
 * - ACK_EVENT/IGNORE_EVENT: available when delivery is not terminal.
 * - REQUEST_RETRY: ONLY when executionState=RESULT_RECEIVED + pmState=CHANGES_REQUESTED
 *   + no acceptedRunId. FAILED is terminal — never advertise REQUEST_RETRY for FAILED.
 * - ACCEPT_RESULT: only when executionState=RESULT_RECEIVED + pmState≠CHANGES_REQUESTED
 *   + pmState≠ACCEPTED.
 * - REQUEST_CHANGES: only when pmState=VERIFYING (the only B2-legal source state for
 *   VERIFYING→CHANGES_REQUESTED transition).
 */
function deriveAllowedActions(
  delivery: EventDeliveryRecord,
  task: TaskRecord | undefined,
  taskWarning: boolean,
): PmAllowedAction[] {
  const status = delivery.status;

  // Terminal delivery → NO_ACTION only
  if (status === 'ACKNOWLEDGED' || status === 'IGNORED') {
    return ['NO_ACTION'];
  }

  // Non-terminal delivery: advisory delivery actions
  const actions: Set<PmAllowedAction> = new Set(['ACK_EVENT', 'IGNORE_EVENT']);

  if (!task || taskWarning) {
    // No Task or Task read failed → only delivery actions
    return [...actions];
  }

  const { executionState, pmState, acceptedRunId } = task;

  // REQUEST_RETRY: RESULT_RECEIVED + CHANGES_REQUESTED + no acceptedRunId
  if (
    executionState === 'RESULT_RECEIVED' &&
    pmState === 'CHANGES_REQUESTED' &&
    !acceptedRunId
  ) {
    actions.add('REQUEST_RETRY');
  }

  // ACCEPT_RESULT: RESULT_RECEIVED + not CHANGES_REQUESTED + not ACCEPTED
  if (
    executionState === 'RESULT_RECEIVED' &&
    pmState !== 'CHANGES_REQUESTED' &&
    pmState !== 'ACCEPTED'
  ) {
    actions.add('ACCEPT_RESULT');
  }

  // REQUEST_CHANGES: only when VERIFYING (the only legal source for →CHANGES_REQUESTED)
  if (pmState === 'VERIFYING') {
    actions.add('REQUEST_CHANGES');
  }

  return [...actions];
}

// ── Bounded details sanitizer ────────────────────────────────────────────────

/**
 * Recursively sanitize an arbitrary value to enforce Phase F size bounds.
 *
 * Guarantees:
 *   - Strings capped at MAX_BOUNDED_STRING characters
 *   - Arrays capped at MAX_DETAILS_ARRAY_ITEMS items
 *   - Objects capped at MAX_DETAILS_OBJECT_KEYS keys
 *   - Nesting capped at MAX_DETAILS_DEPTH levels
 *
 * This ensures prompt/result/raw log bodies cannot be embedded through
 * an arbitrary details payload.
 */
function sanitizeDetailsValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DETAILS_DEPTH) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_BOUNDED_STRING
      ? value.slice(0, MAX_BOUNDED_STRING) + '…'
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_DETAILS_ARRAY_ITEMS);
    return capped.map((v) => sanitizeDetailsValue(v, depth + 1));
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [k, v] of entries) {
      if (count >= MAX_DETAILS_OBJECT_KEYS) {
        out['…'] = '[truncated]';
        break;
      }
      out[k] = sanitizeDetailsValue(v, depth + 1);
      count++;
    }
    return out;
  }
  return String(value);
}

/** Sanitize evidence details field — no prompt/result raw body can pass through. */
function boundEvidenceDetails(details: EvidenceDetails | undefined): EvidenceDetails | undefined {
  if (details === undefined) return undefined;
  return sanitizeDetailsValue(details, 0) as EvidenceDetails;
}

/** Sanitize event details record — prevents arbitrarily large payloads in the packet. */
function boundEventDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return sanitizeDetailsValue(details, 0) as Record<string, unknown>;
}

// ── Bounded entity converters ────────────────────────────────────────────────

/** Convert a full EventRecord to a bounded packet-safe record. */
function toBoundedEventRecord(event: EventRecord): BoundedEventRecord {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    project: event.project,
    type: event.type,
    severity: event.severity,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.evidenceId ? { evidenceId: event.evidenceId } : {}),
    source: event.source,
    summary: event.summary.length > MAX_BOUNDED_STRING
      ? event.summary.slice(0, MAX_BOUNDED_STRING) + '…'
      : event.summary,
    ...(event.details !== undefined ? { details: boundEventDetails(event.details) } : {}),
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    attentionClassifierVersion: event.attentionClassifierVersion,
    ...(event.sourceEventId ? { sourceEventId: event.sourceEventId } : {}),
    ...(event.correlationId ? { correlationId: event.correlationId } : {}),
    ...(event.causationId ? { causationId: event.causationId } : {}),
    pmAttention: event.pmAttention,
    // metadata intentionally excluded — may be oversized
  };
}

/**
 * Convert a full TaskRecord to a bounded PM Task context snapshot.
 *
 * Excludes: linkedRuns (full attempt history), folder paths, audit timestamps,
 * and large narrative fields that are not needed for PM judgment.
 */
function toTaskContext(task: TaskRecord): PmTaskContext {
  const sortedRuns = [...task.linkedRuns].sort(
    (a, b) => a.taskRunSequence - b.taskRunSequence,
  );
  const latestRun = sortedRuns.length ? sortedRuns[sortedRuns.length - 1] : undefined;
  return {
    taskId: task.taskId,
    goalId: task.goalId,
    title: task.title,
    executionState: task.executionState,
    pmState: task.pmState,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
    dependencies: [...task.dependencies],
    completionCriteriaCount: task.completionCriteria.length,
    ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
    ...(task.retryCount !== undefined ? { retryCount: task.retryCount } : {}),
    ...(latestRun ? { latestRunId: latestRun.runId } : {}),
  };
}

/**
 * Convert a LinkedRunRef to a bounded run reference — physical folder excluded.
 *
 * Physical locator (folder) is internal Relay data and MUST NOT appear in the
 * PM context packet.
 */
function toBoundedRunRef(link: LinkedRunRef): BoundedRunRef {
  return {
    runId: link.runId,
    taskRunSequence: link.taskRunSequence,
    ...(link.agent ? { agent: link.agent } : {}),
    ...(link.date ? { date: link.date } : {}),
    // folder intentionally excluded
  };
}

// ── Bounded evidence converter ───────────────────────────────────────────────

function boundEvidence(e: EvidenceRecord): BoundedEvidenceRecord {
  // Strip metadata (may be oversized); sanitize details to prevent embedded payloads
  return {
    evidenceId: e.evidenceId,
    project: e.project,
    type: e.type,
    trustLevel: e.trustLevel,
    status: e.status,
    source: e.source,
    summary: e.summary.length > MAX_BOUNDED_STRING
      ? e.summary.slice(0, MAX_BOUNDED_STRING) + '…'
      : e.summary,
    createdAt: e.createdAt,
    ...(e.goalId ? { goalId: e.goalId } : {}),
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.details !== undefined ? { details: boundEvidenceDetails(e.details) } : {}),
    ...(e.rawRef ? { rawRef: e.rawRef } : {}),
    ...(e.artifactRefs?.length
      ? { artifactRefs: e.artifactRefs.slice(0, MAX_EVIDENCE_ARTIFACT_REFS) }
      : {}),
    // metadata intentionally excluded
  };
}

// ── Evidence selection (max 5, current-attempt preferred) ───────────────────

/**
 * Select judgment-relevant Evidence records for the current attempt.
 * Prioritizes QA failure, objective verification, PM decision, failure/blocker.
 * Excludes historical attempt evidence when currentRunId is known.
 * Hard cap: max 5.
 */
function selectEvidence(
  allTaskEvidence: EvidenceRecord[],
  currentRunId: string | undefined,
  maxCount = 5,
): EvidenceRecord[] {
  // Prefer current-attempt evidence when we know the current run
  let candidates = currentRunId
    ? allTaskEvidence.filter((e) => e.runId === currentRunId || !e.runId)
    : allTaskEvidence;

  // Priority scoring (lower = higher priority)
  function priority(e: EvidenceRecord): number {
    // QA FAIL — highest priority
    if (e.type === 'QA' && e.status === 'FAIL') return 0;
    // Other FAIL verification evidence
    if ((e.type === 'TEST' || e.type === 'BUILD') && e.status === 'FAIL') return 1;
    // PM decision
    if (e.type === 'PM_DECISION') return 2;
    // Objective verification
    if (e.trustLevel === 'VERIFIED') return 3;
    // Failure/blocker claim
    if (e.status === 'FAIL' || e.status === 'INCONCLUSIVE') return 4;
    // Everything else
    return 5;
  }

  candidates = [...candidates].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    // Within same priority: most recent first
    return b.createdAt.localeCompare(a.createdAt);
  });

  return candidates.slice(0, maxCount);
}

// ── Dependency summary builder ───────────────────────────────────────────────

function buildDependencySummary(
  dataRoot: string,
  project: string,
  task: TaskRecord,
  warnings: string[],
): DependencySummary {
  try {
    const allTasks = listTasks(dataRoot, project, task.goalId);
    const byId = new Map(allTasks.map((t) => [t.taskId, t]));
    const info = collectDependencyInfo(task, byId);
    return {
      dependencies: [...task.dependencies],
      unsatisfiedDependencies: info.unsatisfiedDependencies,
      blockedBy: info.blockedBy,
      dependenciesSatisfied: info.dependenciesSatisfied,
    };
  } catch (err) {
    warnings.push(`DependencySummary 구축 실패: ${err instanceof Error ? err.message : String(err)}`);
    return {
      dependencies: [...task.dependencies],
      unsatisfiedDependencies: [],
      blockedBy: [],
      dependenciesSatisfied: false,
    };
  }
}

// ── Attempt-awareness helpers ────────────────────────────────────────────────

function buildAttemptInfo(task: TaskRecord): CurrentAttemptInfo {
  const sortedRuns = [...task.linkedRuns].sort((a, b) => a.taskRunSequence - b.taskRunSequence);
  const latestRun = sortedRuns.length ? sortedRuns[sortedRuns.length - 1] : undefined;
  return {
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
    ...(latestRun ? { latestRunId: latestRun.runId } : {}),
    ...(task.acceptedRunId
      ? { currentAttemptRunId: task.acceptedRunId }
      : latestRun
      ? { currentAttemptRunId: latestRun.runId }
      : {}),
  };
}

function buildPreviousAttempts(
  task: TaskRecord,
  allTaskEvidence: EvidenceRecord[],
  currentRunId: string | undefined,
): AttemptSummary[] {
  const MAX_PREV = 3;
  const sortedRuns = [...task.linkedRuns].sort((a, b) => a.taskRunSequence - b.taskRunSequence);
  const maxSeq = sortedRuns.length ? sortedRuns[sortedRuns.length - 1]!.taskRunSequence : 0;

  // Collect previous attempts (exclude current)
  const previous = sortedRuns
    .filter((r) => r.runId !== currentRunId)
    .slice(-MAX_PREV); // most recent MAX_PREV

  return previous.map((link) => {
    const runEvidence = allTaskEvidence.filter((e) => e.runId === link.runId);
    return {
      runId: link.runId,
      taskRunSequence: link.taskRunSequence,
      isAccepted: task.acceptedRunId === link.runId,
      isLatest: link.taskRunSequence === maxSeq,
      evidenceSummary: summarizeEvidence(runEvidence),
    };
  });
}

// ── Profile builders ──────────────────────────────────────────────────────────

/**
 * Read Task gracefully — returns null + appends warning on failure.
 */
function tryGetTask(
  dataRoot: string,
  project: string,
  taskId: string,
  warnings: string[],
): TaskRecord | null {
  try {
    return getTask(dataRoot, project, taskId);
  } catch (err) {
    warnings.push(`Task ${taskId} 읽기 실패 (partial packet): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function tryGetGoal(
  dataRoot: string,
  project: string,
  goalId: string,
  warnings: string[],
): GoalRecord | null {
  try {
    return getGoal(dataRoot, project, goalId);
  } catch (err) {
    warnings.push(`Goal ${goalId} 읽기 실패 (partial packet): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function tryListTaskEvidence(
  dataRoot: string,
  project: string,
  taskId: string,
  warnings: string[],
): EvidenceRecord[] {
  try {
    return listEvidenceForTask(dataRoot, project, taskId, true);
  } catch (err) {
    warnings.push(`Task Evidence 읽기 실패 (${taskId}): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function collectEvidenceRefs(
  evidence: EvidenceRecord[],
): { evidenceIds: string[]; rawRefs: string[]; artifactRefs: string[] } {
  const evidenceIds = evidence.map((e) => e.evidenceId);
  const rawRefs: string[] = [];
  const artifactRefs: string[] = [];
  for (const e of evidence) {
    if (e.rawRef) rawRefs.push(e.rawRef);
    if (e.artifactRefs) artifactRefs.push(...e.artifactRefs);
  }
  return { evidenceIds, rawRefs, artifactRefs };
}

function toCompactGoal(goal: GoalRecord): CompactGoalSummary {
  return {
    goalId: goal.goalId,
    title: goal.title,
    status: goal.status,
    completionCriteriaCount: goal.completionCriteria.length,
  };
}

function toCompactTask(task: TaskRecord): CompactTaskSummary {
  return {
    taskId: task.taskId,
    title: task.title,
    executionState: task.executionState,
    pmState: task.pmState,
    linkedRunsCount: task.linkedRuns.length,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
  };
}

// ── Profile: QA_FAILED ───────────────────────────────────────────────────────

function buildQaFailedProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push('QA_FAILED Event에 taskId가 없습니다 — partial packet');
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task);

  // Goal
  const goal = tryGetGoal(dataRoot, project, task.goalId, warnings);
  if (goal) out.goal = toCompactGoal(goal);

  // Current attempt info
  const attemptInfo = buildAttemptInfo(task);
  out.currentAttempt = attemptInfo;

  // Current run — bounded ref (no folder)
  const currentRunId = attemptInfo.currentAttemptRunId;
  if (currentRunId) {
    const link = task.linkedRuns.find((r) => r.runId === currentRunId);
    if (link) out.run = toBoundedRunRef(link);
  }

  // Evidence
  const allEvidence = tryListTaskEvidence(dataRoot, project, taskId, warnings);
  const currentEvidence = currentRunId
    ? allEvidence.filter((e) => e.runId === currentRunId || !e.runId)
    : allEvidence;

  out.evidenceSummary = summarizeEvidence(currentEvidence);
  const selected = selectEvidence(allEvidence, currentRunId, 5);
  out.selectedEvidence = selected.map(boundEvidence);

  // Previous attempts (max 3) — historical failures must NOT poison current attempt status
  out.previousAttempts = buildPreviousAttempts(task, allEvidence, currentRunId);

  return out;
}

// ── Profile: RUN_FAILED ──────────────────────────────────────────────────────

function buildRunFailedProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push('RUN_FAILED Event에 taskId가 없습니다 — partial packet');
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task);

  const goal = tryGetGoal(dataRoot, project, task.goalId, warnings);
  if (goal) out.goal = toCompactGoal(goal);

  // Current run — bounded ref (no folder)
  const runId = event.runId ?? task.linkedRuns[task.linkedRuns.length - 1]?.runId;
  if (runId) {
    const link = task.linkedRuns.find((r) => r.runId === runId);
    if (link) out.run = toBoundedRunRef(link);
  }

  // Relevant failure evidence (limited)
  const allEvidence = tryListTaskEvidence(dataRoot, project, taskId, warnings);
  const failureEvidence = allEvidence.filter(
    (e) => e.status === 'FAIL' && (e.runId === runId || !e.runId),
  );
  out.selectedEvidence = failureEvidence.slice(0, 5).map(boundEvidence);

  // Dependency summary
  out.dependencySummary = buildDependencySummary(dataRoot, project, task, warnings);

  // NOTE: REQUEST_RETRY is NOT included — FAILED is terminal under B2.
  // This is enforced in deriveAllowedActions() because FAILED executionState
  // does not satisfy RESULT_RECEIVED + CHANGES_REQUESTED.

  return out;
}

// ── Profile: RUN_BLOCKED / TASK_BLOCKED ─────────────────────────────────────

function buildBlockedProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push(`${event.type} Event에 taskId가 없습니다 — partial packet`);
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task);

  const goal = tryGetGoal(dataRoot, project, task.goalId, warnings);
  if (goal) out.goal = toCompactGoal(goal);

  // Blocker evidence
  const allEvidence = tryListTaskEvidence(dataRoot, project, taskId, warnings);
  const blockerEvidence = allEvidence.filter(
    (e) => e.status === 'FAIL' || e.status === 'INCONCLUSIVE',
  );
  out.selectedEvidence = blockerEvidence.slice(0, 5).map(boundEvidence);
  if (allEvidence.length > 0) out.evidenceSummary = summarizeEvidence(allEvidence);

  // Dependency summary
  out.dependencySummary = buildDependencySummary(dataRoot, project, task, warnings);

  // Previous attempts (bounded)
  const attemptInfo = buildAttemptInfo(task);
  out.currentAttempt = attemptInfo;
  out.previousAttempts = buildPreviousAttempts(task, allEvidence, attemptInfo.currentAttemptRunId);

  return out;
}

// ── Profile: OWNER_DECISION_REQUIRED ─────────────────────────────────────────

function buildOwnerDecisionProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  const taskId = event.taskId;
  if (taskId) {
    const task = tryGetTask(dataRoot, project, taskId, warnings);
    if (task) {
      // Bounded task context snapshot — no linkedRuns, no folder paths
      out.task = toTaskContext(task);
      const goal = tryGetGoal(dataRoot, project, task.goalId, warnings);
      if (goal) out.goal = toCompactGoal(goal);
    }
  } else if (event.goalId) {
    const goal = tryGetGoal(dataRoot, project, event.goalId, warnings);
    if (goal) out.goal = toCompactGoal(goal);
  }

  // NOTE: Only currently supported advisory actions (no new decision commands invented).
  // Allowed actions derived from delivery + task state in main function.

  return out;
}

// ── Profile: GOAL_COMPLETION_ELIGIBLE ────────────────────────────────────────

function buildGoalCompletionEligibleProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  const goalId = event.goalId;
  if (!goalId) {
    warnings.push('GOAL_COMPLETION_ELIGIBLE Event에 goalId가 없습니다 — partial packet');
    return out;
  }

  const goal = tryGetGoal(dataRoot, project, goalId, warnings);
  if (!goal) return out;
  out.goal = toCompactGoal(goal);

  // Goal completion evaluation
  try {
    const tasks = listTasks(dataRoot, project, goalId);
    const completion = evaluateGoalCompletion(goal, tasks);

    // Compact Task summaries only (not full Task records, not sibling Tasks)
    out.taskCompletionSummaries = tasks.map(toCompactTask);

    // Runtime summary with completion evaluation details
    out.runtimeSummary = {
      source: `goal-completion-evaluation:${goalId}`,
      subsystem: `eligible=${String(completion.eligible)};accepted=${completion.acceptedTasks}/${completion.totalTasks}`,
    };
  } catch (err) {
    warnings.push(`Goal completion evaluation 실패 (${goalId}): ${err instanceof Error ? err.message : String(err)}`);
  }

  // NOTE: COMPLETE_GOAL is NOT included in allowedActions — Phase E has no complete-goal MCP command.

  return out;
}

// ── Profile: RUNTIME_ERROR ───────────────────────────────────────────────────

function buildRuntimeErrorProfile(
  dataRoot: string,
  project: string,
  event: EventRecord,
  warnings: string[],
): Partial<PmContextPacket> {
  const out: Partial<PmContextPacket> = {};

  // Source/subsystem info
  out.runtimeSummary = {
    source: event.source.kind,
    subsystem: event.source.subsystem,
  };

  // Linked Goal/Task/Run if available (no project-wide dump)
  if (event.taskId) {
    const task = tryGetTask(dataRoot, project, event.taskId, warnings);
    if (task) {
      // Bounded task context snapshot — no linkedRuns, no folder paths
      out.task = toTaskContext(task);
      if (event.goalId ?? task.goalId) {
        const goal = tryGetGoal(dataRoot, project, event.goalId ?? task.goalId, warnings);
        if (goal) out.goal = toCompactGoal(goal);
      }
    }
  } else if (event.goalId) {
    const goal = tryGetGoal(dataRoot, project, event.goalId, warnings);
    if (goal) out.goal = toCompactGoal(goal);
  }

  // rawRef/artifactRefs from event details (if any)
  if (event.details) {
    const d = event.details as Record<string, unknown>;
    if (typeof d.rawRef === 'string' && d.rawRef) {
      // Surface ref without filesystem browsing
    }
  }

  return out;
}

// ── Thin profile for informational events ─────────────────────────────────────

function buildInformationalProfile(
  _dataRoot: string,
  _project: string,
  _event: EventRecord,
  _warnings: string[],
): Partial<PmContextPacket> {
  // Thin packet — no PM wake event, no promoted action eligibility.
  // allowedActions will only include ACK_EVENT / IGNORE_EVENT / NO_ACTION
  // based on delivery state (enforced in main composer).
  return {};
}

// ── Main composer (pure read) ────────────────────────────────────────────────

/**
 * getContextForEvent — Phase F pure context composer.
 *
 * PURE READ. No file writes. No delivery state mutations.
 * PENDING delivery state is NOT advanced to DELIVERED here.
 *
 * @throws Error if the primary Event does not exist or is malformed.
 */
export function getContextForEvent(
  dataRoot: string,
  project: string,
  eventId: string,
): PmContextPacket {
  // ── 1. Read primary Event (HARD FAIL if missing) ──────────────────────────
  const event = getEvent(dataRoot, project, eventId);

  // ── 2. Read delivery (pure read — MUST NOT change PENDING → DELIVERED) ────
  const delivery = getDelivery(dataRoot, project, eventId);

  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();

  // ── 3. Determine if informational ─────────────────────────────────────────
  const isInformational = INFORMATIONAL_EVENT_TYPES.has(event.type);

  // ── 4. Read primary Task (gracefully) ────────────────────────────────────
  let primaryTask: TaskRecord | null = null;
  let taskReadFailed = false;
  if (event.taskId && !isInformational) {
    primaryTask = tryGetTask(dataRoot, project, event.taskId, warnings);
    taskReadFailed = primaryTask === null;
  }

  // ── 5. Derive allowed actions ─────────────────────────────────────────────
  let allowedActions: PmAllowedAction[];
  if (isInformational) {
    // Informational events: only delivery-level actions; no Task-level promotion
    const status = delivery.status;
    if (status === 'ACKNOWLEDGED' || status === 'IGNORED') {
      allowedActions = ['NO_ACTION'];
    } else {
      allowedActions = ['ACK_EVENT', 'IGNORE_EVENT'];
    }
  } else {
    allowedActions = deriveAllowedActions(delivery, primaryTask ?? undefined, taskReadFailed);
  }

  // ── 6. Build CAS snapshot ─────────────────────────────────────────────────
  const cas: CasSnapshot = {
    expectedEventDeliveryStatus: delivery.status,
  };
  if (primaryTask) {
    cas.expectedPmState = primaryTask.pmState;
    cas.expectedExecutionState = primaryTask.executionState;
  }

  // ── 7. Build profile-specific fields ─────────────────────────────────────
  let profileFields: Partial<PmContextPacket> = {};

  if (isInformational) {
    profileFields = buildInformationalProfile(dataRoot, project, event, warnings);
  } else {
    switch (event.type) {
      case 'QA_FAILED':
        profileFields = buildQaFailedProfile(dataRoot, project, event, warnings);
        break;
      case 'RUN_FAILED':
        profileFields = buildRunFailedProfile(dataRoot, project, event, warnings);
        break;
      case 'RUN_BLOCKED':
      case 'TASK_BLOCKED':
      case 'TASK_TIMEOUT':
        profileFields = buildBlockedProfile(dataRoot, project, event, warnings);
        break;
      case 'OWNER_DECISION_REQUIRED':
        profileFields = buildOwnerDecisionProfile(dataRoot, project, event, warnings);
        break;
      case 'GOAL_COMPLETION_ELIGIBLE':
        profileFields = buildGoalCompletionEligibleProfile(dataRoot, project, event, warnings);
        break;
      case 'RUNTIME_ERROR':
        profileFields = buildRuntimeErrorProfile(dataRoot, project, event, warnings);
        break;
      default:
        // Unknown non-informational event: partial packet with warnings
        warnings.push(`알 수 없는 Event type에 대한 profile을 구축할 수 없습니다: ${event.type}`);
        break;
    }
  }

  // ── 8. Build refs (bounded) ───────────────────────────────────────────────
  const task = profileFields.task ?? undefined;
  const selectedEvidence = profileFields.selectedEvidence;
  const allTaskEvidence =
    task && !isInformational
      ? tryListTaskEvidence(dataRoot, project, task.taskId, warnings)
      : [];

  // Cap evidenceIds to MAX_REFS_EVIDENCE_IDS — only selected or top-N task evidence
  const rawEvidenceIds =
    selectedEvidence?.map((e) => e.evidenceId) ??
    allTaskEvidence.slice(0, 5).map((e) => e.evidenceId);
  const evidenceIds = rawEvidenceIds.slice(0, MAX_REFS_EVIDENCE_IDS);

  // Collect rawRefs and artifactRefs from selected evidence only; apply hard caps
  const rawRefs: string[] = [];
  const artifactRefs: string[] = [];
  for (const e of selectedEvidence ?? []) {
    if (e.rawRef && rawRefs.length < MAX_REFS_RAW) rawRefs.push(e.rawRef);
    if (e.artifactRefs) {
      for (const ref of e.artifactRefs) {
        if (artifactRefs.length >= MAX_REFS_ARTIFACT) break;
        artifactRefs.push(ref);
      }
    }
  }

  const refs: PmContextRefs = {
    eventId: event.eventId,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(evidenceIds.length ? { evidenceIds } : {}),
    ...(rawRefs.length ? { rawRefs } : {}),
    ...(artifactRefs.length ? { artifactRefs } : {}),
  };

  // ── 9. Assemble packet ────────────────────────────────────────────────────
  const packet: PmContextPacket = {
    schemaVersion: PM_GATEWAY_SCHEMA_VERSION,
    project,
    // Bounded event record — details sanitized, metadata excluded
    event: toBoundedEventRecord(event),
    eventDelivery: delivery,
    allowedActions,
    cas,
    refs,
    generatedAt,
    warnings,
    ...profileFields,
  };

  return packet;
}
