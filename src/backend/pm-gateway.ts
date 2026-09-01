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
  EventPriority,
} from '../shared/types.js';
import { getEvent, getDelivery } from './event.js';
import { getTask, getGoal, listTasks } from './goal-task.js';
import {
  evaluateGoalCompletion,
  collectDependencyInfo,
} from './goal-task-runtime.js';
import {
  listEvidenceForTask,
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
/** Maximum Task.dependencies exposed in packet Task / DependencySummary. */
const MAX_DEPENDENCIES = 20;
/** Maximum compact Task summaries for GOAL_COMPLETION_ELIGIBLE. */
const MAX_TASK_COMPLETION_SUMMARIES = 50;
/** Maximum warnings[] entries in the packet. */
const MAX_WARNINGS = 20;

/** Prefix for packet-safe refs relativized under Relay dataRoot/project. */
const RELAY_RELATIVE_PREFIX = 'relay-relative://';

/** Context for packet-safe ref conversion (pure read; does not mutate SSOT). */
interface PacketRefContext {
  dataRoot: string;
  project: string;
  warnings: string[];
}

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

// ── String / path helpers ────────────────────────────────────────────────────

function boundString(value: string): string {
  return value.length > MAX_BOUNDED_STRING
    ? value.slice(0, MAX_BOUNDED_STRING) + '…'
    : value;
}

/**
 * Detect absolute filesystem path shapes across Windows / POSIX / UNC / file://.
 * Does NOT treat logical URI schemes (evidence://, run://, artifact://,
 * relay-relative://) as filesystem paths.
 */
export function looksLikeAbsoluteFilesystemPath(value: string): boolean {
  const s = value.trim();
  if (!s) return false;

  if (/^file:/i.test(s)) return true;

  // Windows drive: C:\... or C:/...
  if (/^[A-Za-z]:[\\/]/.test(s)) return true;

  // UNC: \\server\share\...
  if (/^\\\\[^\\\/]+[\\\/]/.test(s)) return true;

  // Scheme-bearing URI (evidence://, relay-relative://, http://, ...) — not a raw FS path
  // unless scheme is file: (handled above).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false;

  // Protocol-relative / UNC-like: //server/share/...
  if (/^\/\/[^\/]+\/./.test(s)) return true;

  // POSIX absolute: /home/..., /tmp/...
  if (s.startsWith('/')) return true;

  return false;
}

function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

function stripFileUri(value: string): string {
  let s = value.trim();
  if (!/^file:/i.test(s)) return s;
  // file:///C:/... or file://C:/... or file:///home/...
  s = s.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  return s;
}

/**
 * Attempt to express absPath as a path relative to root using separator-normalized
 * prefix matching (works for foreign path syntax, not only current OS).
 */
function prefixRelative(absPath: string, root: string): string | null {
  const aRaw = normalizePathSeparators(stripFileUri(absPath)).replace(/\/+$/, '');
  const rRaw = normalizePathSeparators(root).replace(/\/+$/, '');
  if (!aRaw || !rRaw) return null;

  const caseFold = /^[A-Za-z]:/.test(aRaw) || /^[A-Za-z]:/.test(rRaw);
  const a = caseFold ? aRaw.toLowerCase() : aRaw;
  const r = caseFold ? rRaw.toLowerCase() : rRaw;

  if (a === r) return '';
  if (!a.startsWith(r + '/')) return null;
  // Slice using original (non-folded) string length of root
  return aRaw.slice(rRaw.length + 1);
}

/**
 * Convert a rawRef/artifactRef into a packet-safe logical reference.
 * Absolute paths under dataRoot/project (or dataRoot) become relay-relative://...
 * Absolute paths outside Relay root are omitted (+ warning).
 * Already-logical / opaque / relative refs are preserved (length-bounded).
 * Does NOT mutate Evidence SSOT.
 */
function toPacketSafeRef(
  value: string | undefined,
  ctx: PacketRefContext,
  label: string,
): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (!looksLikeAbsoluteFilesystemPath(trimmed)) {
    return boundString(trimmed);
  }

  const projectRoot = path.resolve(ctx.dataRoot, ctx.project);
  const dataRootResolved = path.resolve(ctx.dataRoot);
  for (const root of [projectRoot, dataRootResolved]) {
    const rel = prefixRelative(trimmed, root);
    if (rel != null) {
      const logical =
        RELAY_RELATIVE_PREFIX +
        rel
          .split(/[\\/]/)
          .filter(Boolean)
          .join('/');
      return boundString(logical);
    }
  }

  ctx.warnings.push(`${label}: absolute filesystem path omitted (not under Relay root)`);
  return undefined;
}

/** Display/context string: length-bounded; absolute path shapes redacted. */
function boundDisplayString(value: string): string {
  const s = boundString(value);
  if (looksLikeAbsoluteFilesystemPath(s)) return '[path-omitted]';
  return s;
}

function boundStringList(
  values: string[],
  maxItems: number,
  ctx: PacketRefContext | undefined,
  label: string,
): string[] {
  if (values.length > maxItems && ctx) {
    ctx.warnings.push(`${label} truncated to ${maxItems} of ${values.length}`);
  }
  return values.slice(0, maxItems).map((v) => boundDisplayString(v));
}

function finalizeWarnings(warnings: string[]): string[] {
  const bounded = warnings.map((w) => boundString(w));
  if (bounded.length <= MAX_WARNINGS) return bounded;
  const kept = bounded.slice(0, MAX_WARNINGS - 1);
  kept.push(boundString(`warnings truncated: showing ${MAX_WARNINGS - 1} of ${bounded.length}`));
  return kept;
}

function boundPmAttention(attention: PmAttention): PmAttention {
  const out: PmAttention = { required: attention.required };
  if (attention.reason !== undefined) out.reason = boundDisplayString(attention.reason);
  if (attention.priority !== undefined) out.priority = attention.priority as EventPriority;
  return out;
}

function boundEventSource(source: EventSource): EventSource {
  return {
    kind: boundDisplayString(source.kind),
    ...(source.actor ? { actor: boundDisplayString(source.actor) } : {}),
    ...(source.agent ? { agent: boundDisplayString(source.agent) } : {}),
    ...(source.adapter ? { adapter: boundDisplayString(source.adapter) } : {}),
    ...(source.subsystem ? { subsystem: boundDisplayString(source.subsystem) } : {}),
  };
}

function boundEvidenceSource(source: EvidenceSource): EvidenceSource {
  return {
    kind: boundDisplayString(source.kind),
    ...(source.agent ? { agent: boundDisplayString(source.agent) } : {}),
    ...(source.adapter ? { adapter: boundDisplayString(source.adapter) } : {}),
    ...(source.command ? { command: boundDisplayString(source.command) } : {}),
    ...(source.tool ? { tool: boundDisplayString(source.tool) } : {}),
    ...(source.actor ? { actor: boundDisplayString(source.actor) } : {}),
  };
}

function boundRuntimeSummary(info: RuntimeSummaryInfo): RuntimeSummaryInfo {
  return {
    ...(info.source !== undefined ? { source: boundDisplayString(info.source) } : {}),
    ...(info.subsystem !== undefined ? { subsystem: boundDisplayString(info.subsystem) } : {}),
  };
}

// ── Bounded details sanitizer ────────────────────────────────────────────────

/**
 * Recursively sanitize an arbitrary value to enforce Phase F size bounds
 * and strip absolute filesystem path strings from nested payloads.
 */
function sanitizeDetailsValue(
  value: unknown,
  depth = 0,
  ctx?: PacketRefContext,
): unknown {
  if (depth > MAX_DETAILS_DEPTH) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (looksLikeAbsoluteFilesystemPath(value)) {
      if (ctx) {
        const safe = toPacketSafeRef(value, ctx, 'details');
        return safe ?? '[path-omitted]';
      }
      return '[path-omitted]';
    }
    return boundString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_DETAILS_ARRAY_ITEMS);
    return capped.map((v) => sanitizeDetailsValue(v, depth + 1, ctx));
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
      out[k] = sanitizeDetailsValue(v, depth + 1, ctx);
      count++;
    }
    return out;
  }
  return boundString(String(value));
}

/** Sanitize evidence details field — no prompt/result raw body can pass through. */
function boundEvidenceDetails(
  details: EvidenceDetails | undefined,
  ctx?: PacketRefContext,
): EvidenceDetails | undefined {
  if (details === undefined) return undefined;
  return sanitizeDetailsValue(details, 0, ctx) as EvidenceDetails;
}

/** Sanitize event details record — prevents arbitrarily large payloads in the packet. */
function boundEventDetails(
  details: Record<string, unknown> | undefined,
  ctx?: PacketRefContext,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  return sanitizeDetailsValue(details, 0, ctx) as Record<string, unknown>;
}

// ── Bounded entity converters ────────────────────────────────────────────────

/** Convert a full EventRecord to a bounded packet-safe record. */
function toBoundedEventRecord(event: EventRecord, ctx: PacketRefContext): BoundedEventRecord {
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
    source: boundEventSource(event.source),
    summary: boundString(event.summary),
    ...(event.details !== undefined ? { details: boundEventDetails(event.details, ctx) } : {}),
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    attentionClassifierVersion: event.attentionClassifierVersion,
    ...(event.sourceEventId ? { sourceEventId: boundString(event.sourceEventId) } : {}),
    ...(event.correlationId ? { correlationId: boundString(event.correlationId) } : {}),
    ...(event.causationId ? { causationId: boundString(event.causationId) } : {}),
    pmAttention: boundPmAttention(event.pmAttention),
    // metadata intentionally excluded — may be oversized
  };
}

/**
 * Convert a full TaskRecord to a bounded PM Task context snapshot.
 *
 * Excludes: linkedRuns (full attempt history), folder paths, audit timestamps,
 * and large narrative fields that are not needed for PM judgment.
 */
function toTaskContext(task: TaskRecord, ctx?: PacketRefContext): PmTaskContext {
  const sortedRuns = [...task.linkedRuns].sort(
    (a, b) => a.taskRunSequence - b.taskRunSequence,
  );
  const latestRun = sortedRuns.length ? sortedRuns[sortedRuns.length - 1] : undefined;
  return {
    taskId: task.taskId,
    goalId: task.goalId,
    title: boundDisplayString(task.title),
    executionState: task.executionState,
    pmState: task.pmState,
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
    dependencies: boundStringList(task.dependencies, MAX_DEPENDENCIES, ctx, 'task.dependencies'),
    completionCriteriaCount: task.completionCriteria.length,
    ...(task.blockedReason
      ? { blockedReason: boundDisplayString(task.blockedReason) }
      : {}),
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
    ...(link.agent ? { agent: boundDisplayString(link.agent) } : {}),
    ...(link.date ? { date: boundDisplayString(link.date) } : {}),
    // folder intentionally excluded
  };
}

// ── Bounded evidence converter ───────────────────────────────────────────────

function boundEvidence(e: EvidenceRecord, ctx: PacketRefContext): BoundedEvidenceRecord {
  const safeRaw = toPacketSafeRef(e.rawRef, ctx, `Evidence ${e.evidenceId} rawRef`);
  const safeArtifacts = (e.artifactRefs ?? [])
    .slice(0, MAX_EVIDENCE_ARTIFACT_REFS)
    .map((ref, i) =>
      toPacketSafeRef(ref, ctx, `Evidence ${e.evidenceId} artifactRefs[${i}]`),
    )
    .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);

  // Strip metadata (may be oversized); sanitize details to prevent embedded payloads
  return {
    evidenceId: e.evidenceId,
    project: e.project,
    type: e.type,
    trustLevel: e.trustLevel,
    status: e.status,
    source: boundEvidenceSource(e.source),
    summary: boundString(e.summary),
    createdAt: e.createdAt,
    ...(e.goalId ? { goalId: e.goalId } : {}),
    ...(e.taskId ? { taskId: e.taskId } : {}),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.details !== undefined ? { details: boundEvidenceDetails(e.details, ctx) } : {}),
    ...(safeRaw ? { rawRef: safeRaw } : {}),
    ...(safeArtifacts.length ? { artifactRefs: safeArtifacts } : {}),
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
  const ctx: PacketRefContext = { dataRoot, project, warnings };
  try {
    const allTasks = listTasks(dataRoot, project, task.goalId);
    const byId = new Map(allTasks.map((t) => [t.taskId, t]));
    const info = collectDependencyInfo(task, byId);
    return {
      dependencies: boundStringList(task.dependencies, MAX_DEPENDENCIES, ctx, 'dependencySummary.dependencies'),
      unsatisfiedDependencies: boundStringList(
        info.unsatisfiedDependencies,
        MAX_DEPENDENCIES,
        ctx,
        'dependencySummary.unsatisfiedDependencies',
      ),
      blockedBy: boundStringList(info.blockedBy, MAX_DEPENDENCIES, ctx, 'dependencySummary.blockedBy'),
      dependenciesSatisfied: info.dependenciesSatisfied,
    };
  } catch (err) {
    warnings.push(`DependencySummary 구축 실패: ${err instanceof Error ? err.message : String(err)}`);
    return {
      dependencies: boundStringList(task.dependencies, MAX_DEPENDENCIES, ctx, 'dependencySummary.dependencies'),
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

function toCompactGoal(goal: GoalRecord): CompactGoalSummary {
  return {
    goalId: goal.goalId,
    title: boundDisplayString(goal.title),
    status: goal.status,
    completionCriteriaCount: goal.completionCriteria.length,
  };
}

function toCompactTask(task: TaskRecord): CompactTaskSummary {
  return {
    taskId: task.taskId,
    title: boundDisplayString(task.title),
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
  const ctx: PacketRefContext = { dataRoot, project, warnings };

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push('QA_FAILED Event에 taskId가 없습니다 — partial packet');
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task, ctx);

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
  out.selectedEvidence = selected.map((e) => boundEvidence(e, ctx));

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
  const ctx: PacketRefContext = { dataRoot, project, warnings };

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push('RUN_FAILED Event에 taskId가 없습니다 — partial packet');
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task, ctx);

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
  out.selectedEvidence = failureEvidence.slice(0, 5).map((e) => boundEvidence(e, ctx));

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
  const ctx: PacketRefContext = { dataRoot, project, warnings };

  const taskId = event.taskId;
  if (!taskId) {
    warnings.push(`${event.type} Event에 taskId가 없습니다 — partial packet`);
    return out;
  }

  const task = tryGetTask(dataRoot, project, taskId, warnings);
  if (!task) return out;
  // Bounded task context snapshot — no linkedRuns, no folder paths
  out.task = toTaskContext(task, ctx);

  const goal = tryGetGoal(dataRoot, project, task.goalId, warnings);
  if (goal) out.goal = toCompactGoal(goal);

  // Blocker evidence
  const allEvidence = tryListTaskEvidence(dataRoot, project, taskId, warnings);
  const blockerEvidence = allEvidence.filter(
    (e) => e.status === 'FAIL' || e.status === 'INCONCLUSIVE',
  );
  out.selectedEvidence = blockerEvidence.slice(0, 5).map((e) => boundEvidence(e, ctx));
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
  const ctx: PacketRefContext = { dataRoot, project, warnings };

  const taskId = event.taskId;
  if (taskId) {
    const task = tryGetTask(dataRoot, project, taskId, warnings);
    if (task) {
      // Bounded task context snapshot — no linkedRuns, no folder paths
      out.task = toTaskContext(task, ctx);
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

    // Compact Task summaries only — capped (not full Task dumps)
    if (tasks.length > MAX_TASK_COMPLETION_SUMMARIES) {
      warnings.push(
        `taskCompletionSummaries truncated to ${MAX_TASK_COMPLETION_SUMMARIES} of ${tasks.length}`,
      );
    }
    out.taskCompletionSummaries = tasks
      .slice(0, MAX_TASK_COMPLETION_SUMMARIES)
      .map(toCompactTask);

    // Runtime summary with completion evaluation details
    out.runtimeSummary = boundRuntimeSummary({
      source: `goal-completion-evaluation:${goalId}`,
      subsystem: `eligible=${String(completion.eligible)};accepted=${completion.acceptedTasks}/${completion.totalTasks}`,
    });
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
  const ctx: PacketRefContext = { dataRoot, project, warnings };

  // Source/subsystem info
  out.runtimeSummary = boundRuntimeSummary({
    source: event.source.kind,
    subsystem: event.source.subsystem,
  });

  // Linked Goal/Task/Run if available (no project-wide dump)
  if (event.taskId) {
    const task = tryGetTask(dataRoot, project, event.taskId, warnings);
    if (task) {
      // Bounded task context snapshot — no linkedRuns, no folder paths
      out.task = toTaskContext(task, ctx);
      if (event.goalId ?? task.goalId) {
        const goal = tryGetGoal(dataRoot, project, event.goalId ?? task.goalId, warnings);
        if (goal) out.goal = toCompactGoal(goal);
      }
    }
  } else if (event.goalId) {
    const goal = tryGetGoal(dataRoot, project, event.goalId, warnings);
    if (goal) out.goal = toCompactGoal(goal);
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

  // ── 8. Build refs (bounded + path-safe) ───────────────────────────────────
  const ctx: PacketRefContext = { dataRoot, project, warnings };
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

  // Collect already-converted packet-safe refs from selectedEvidence; dedupe + cap
  const rawRefSet = new Set<string>();
  const artifactRefSet = new Set<string>();
  for (const e of selectedEvidence ?? []) {
    if (e.rawRef) rawRefSet.add(e.rawRef);
    if (e.artifactRefs) {
      for (const ref of e.artifactRefs) artifactRefSet.add(ref);
    }
  }
  const rawRefs = [...rawRefSet].slice(0, MAX_REFS_RAW);
  const artifactRefs = [...artifactRefSet].slice(0, MAX_REFS_ARTIFACT);

  const refs: PmContextRefs = {
    eventId: event.eventId,
    ...(event.goalId ? { goalId: event.goalId } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(evidenceIds.length ? { evidenceIds } : {}),
    ...(rawRefs.length ? { rawRefs } : {}),
    ...(artifactRefs.length ? { artifactRefs } : {}),
  };

  // Bound optional runtimeSummary if a profile set it without going through helper
  if (profileFields.runtimeSummary) {
    profileFields.runtimeSummary = boundRuntimeSummary(profileFields.runtimeSummary);
  }

  // ── 9. Assemble packet ────────────────────────────────────────────────────
  // Event bounding may append path-omission warnings; finalize after that.
  const boundedEvent = toBoundedEventRecord(event, ctx);
  const packet: PmContextPacket = {
    schemaVersion: PM_GATEWAY_SCHEMA_VERSION,
    project,
    event: boundedEvent,
    eventDelivery: delivery,
    allowedActions,
    cas,
    refs,
    generatedAt,
    warnings: finalizeWarnings(warnings),
    ...profileFields,
  };
  // profileFields must not override finalized warnings
  packet.warnings = finalizeWarnings(warnings);

  return packet;
}
