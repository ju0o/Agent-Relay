/**
 * Event runtime kernel (Phase D — contract correction).
 *
 * EVENT ≠ STATE, EVENT ≠ EVIDENCE. Goal/Task/Run/Evidence remain the canonical
 * SSOT. An Event is a reaction/signal fact only and never mutates canonical
 * state (no automatic B2 transition, retry, or Goal completion).
 *
 * Local-first filesystem SSOT under Project/_relay/events/EVENT-NNNNNN/:
 *   event.json    — immutable core Event payload (append-only), including the
 *                   frozen attentionClassifierVersion and persisted
 *                   pmAttention classification captured at creation time.
 *   event.md      — human-readable mirror
 *   delivery.json — mutable delivery/acknowledgement state (operational metadata)
 *
 * Identity is project-scoped monotonic EVENT-NNNNNN — never a path/timestamp.
 * Source replay is idempotent via sourceEventId (same project → same Event).
 *
 * Classification boundary (MUST 5): severity and pmAttention are ALWAYS derived
 * internally from the centralized deterministic classifier. Callers may select
 * the Event type via typed helpers; they can never choose severity or PM
 * attention. Privileged lifecycle Events (GOAL_COMPLETED, OWNER_DECISION_REQUIRED,
 * GOAL_COMPLETION_ELIGIBLE) are mintable only through trusted server-side
 * helpers — never via public/Worker-facing input, and never via a raw
 * event:create IPC (which does not exist).
 *
 * Deferred/orchestrator vocabulary (MUST 3/4): ALL_PARALLEL_RUNS_COMPLETED and
 * PM_REVIEW_REQUIRED are intentionally NOT in the active Phase D vocabulary.
 * Phase D records the fact Event + frozen PM classification instead of a
 * duplicate PM_REVIEW_REQUIRED Event; fan-in/orchestration conditions belong
 * later near Dispatcher / Closed Loop.
 *
 * Delivery model stays simple (MUST 7): PENDING / DELIVERED / ACKNOWLEDGED /
 * IGNORED only. ACKNOWLEDGED and IGNORED are terminal. No retry counts, no
 * leases, no subscriptions, no distributed queue.
 *
 * Delivery mutations use process-local per-event CAS locks (MUST CAS):
 * markDelivered / acknowledge / ignore share one lock keyed by project+eventId.
 * expectedStatus is required; stale expected rejects before any write. Idempotent
 * replay is only a no-op when expectedStatus === current === target.
 *
 * No MCP / PM Gateway / Dispatcher / event consumer in Phase D (strict non-goals).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ATTENTION_CLASSIFIER_VERSION,
  EventCreateInput,
  EventDeliveryRecord,
  EventDeliveryStatus,
  EVENT_DELIVERY_STATUSES,
  EVENT_PRIORITIES,
  EVENT_SCHEMA_VERSION,
  EVENT_SEVERITIES,
  EVENT_TYPES,
  EventListFilter,
  EventListResult,
  EventPriority,
  EventRecord,
  EventRuntimeSummary,
  EventSeverity,
  EventSource,
  EventType,
  PmAttention,
} from '../shared/types.js';
import { countersPath, relayDir, writeJsonAtomic, CountersRecord } from './goal-task.js';

const EVENT_ID_RE = /^EVENT-(\d+)$/;
const GOAL_ID_RE = /^GOAL-(\d+)$/;
const TASK_ID_RE = /^TASK-(\d+)$/;
const EVIDENCE_ID_RE = /^EVIDENCE-(\d+)$/;

/** Serializes concurrent Event ID allocation / sourceEventId dedupe within one process. */
let _eventAllocLock: Promise<void> = Promise.resolve();

/**
 * Per-event locks for delivery mutations (markDelivered / acknowledge / ignore).
 * Keyed by project + eventId so different events may mutate in parallel.
 * Process-local only — Phase D is a single Relay process (no multi-process lock).
 */
const _deliveryLocks = new Map<string, Promise<void>>();

// ── paths ───────────────────────────────────────────────────────────────────

export function eventsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'events');
}

export function eventFolder(dataRoot: string, project: string, eventId: string): string {
  return path.join(eventsDir(dataRoot, project), eventId);
}

function eventJsonPath(folder: string): string {
  return path.join(folder, 'event.json');
}

function eventMdPath(folder: string): string {
  return path.join(folder, 'event.md');
}

function deliveryJsonPath(folder: string): string {
  return path.join(folder, 'delivery.json');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function isValidIsoTimestamp(v: string): boolean {
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && typeof v === 'string' && v.includes('T');
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function padEventId(n: number): string {
  return `EVENT-${String(n).padStart(6, '0')}`;
}

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

export function isEventSeverity(v: unknown): v is EventSeverity {
  return typeof v === 'string' && (EVENT_SEVERITIES as readonly string[]).includes(v);
}

export function isEventDeliveryStatus(v: unknown): v is EventDeliveryStatus {
  return typeof v === 'string' && (EVENT_DELIVERY_STATUSES as readonly string[]).includes(v);
}

export function isEventPriority(v: unknown): v is EventPriority {
  return typeof v === 'string' && (EVENT_PRIORITIES as readonly string[]).includes(v);
}// ── counters (shared counters.json with Goal/Task/Evidence) ─────────────────

function readCountersRaw(dataRoot: string, project: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(countersPath(dataRoot, project), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch {
    /* missing/malformed */
  }
  return {};
}

function maxExistingEventId(dir: string): number {
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    const m = EVENT_ID_RE.exec(name);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

function allocateEventIdWithCounter(dataRoot: string, project: string): string {
  const dir = eventsDir(dataRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const eventMax = maxExistingEventId(dir);
  const raw = readCountersRaw(dataRoot, project);
  let n =
    typeof raw.nextEventNumber === 'number' && Number.isInteger(raw.nextEventNumber) && raw.nextEventNumber >= 1
      ? raw.nextEventNumber
      : eventMax + 1;
  n = Math.max(n, eventMax + 1);

  for (;;) {
    const id = padEventId(n);
    const idDir = path.join(dir, id);
    try {
      fs.mkdirSync(idDir);
      const latest = readCountersRaw(dataRoot, project);
      let nextGoal = 1;
      let nextTask = 1;
      let nextEvidence = 1;
      let nextEvent = 1;
      let nextNote: number | undefined;
      if (typeof latest.nextGoalNumber === 'number' && Number.isInteger(latest.nextGoalNumber) && latest.nextGoalNumber >= 1) {
        nextGoal = latest.nextGoalNumber;
      }
      if (typeof latest.nextTaskNumber === 'number' && Number.isInteger(latest.nextTaskNumber) && latest.nextTaskNumber >= 1) {
        nextTask = latest.nextTaskNumber;
      }
      if (typeof latest.nextEvidenceNumber === 'number' && Number.isInteger(latest.nextEvidenceNumber) && latest.nextEvidenceNumber >= 1) {
        nextEvidence = latest.nextEvidenceNumber;
      }
      if (typeof latest.nextEventNumber === 'number' && Number.isInteger(latest.nextEventNumber) && latest.nextEventNumber >= 1) {
        nextEvent = latest.nextEventNumber;
      }
      if (typeof latest.nextNoteNumber === 'number' && Number.isInteger(latest.nextNoteNumber) && latest.nextNoteNumber >= 1) {
        nextNote = latest.nextNoteNumber;
      } else if (typeof raw.nextNoteNumber === 'number' && Number.isInteger(raw.nextNoteNumber) && raw.nextNoteNumber >= 1) {
        nextNote = raw.nextNoteNumber;
      }
      const next: CountersRecord = {
        nextGoalNumber: nextGoal,
        nextTaskNumber: nextTask,
        nextEvidenceNumber: nextEvidence,
        nextEventNumber: Math.max(n + 1, nextEvent),
        ...(nextNote !== undefined ? { nextNoteNumber: nextNote } : {}),
      };
      writeJsonAtomic(countersPath(dataRoot, project), next);
      return id;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        n += 1;
        continue;
      }
      throw err;
    }
  }
}

// ── PM attention / severity classification (centralized, deterministic) ────
//
// MUST 1: fact-only Events (RUN_RESULT_RECEIVED / EVIDENCE_READY) do NOT wake
// PM by default. Attention is reserved for failure / blocker / decision /
// eligibility signals. MUST 2: the resulting classification is frozen onto the
// Event with attentionClassifierVersion; later rule changes never rewrite
// historical Events.

/** Default severity per Event type — deterministic; not caller-selectable. */
export function defaultSeverityForType(type: EventType): EventSeverity {
  switch (type) {
    case 'RUN_FAILED':
    case 'QA_FAILED':
    case 'GOAL_COMPLETED':
    case 'RUN_BLOCKED':
    case 'TASK_TIMEOUT':
    case 'TASK_BLOCKED':
    case 'RUNTIME_ERROR':
      return 'ERROR';
    case 'OWNER_DECISION_REQUIRED':
    case 'GOAL_COMPLETION_ELIGIBLE':
    case 'RUNTIME_WARNING':
      return 'WARNING';
    case 'RUN_RESULT_RECEIVED':
    case 'EVIDENCE_READY':
    case 'TASK_BECAME_READY':
    case 'TASK_RESULT_ACCEPTED':
    case 'TASK_CHANGES_REQUESTED':
    case 'TASK_RETRY_REQUESTED':
    default:
      return 'INFO';
  }
}

/**
 * Centralized deterministic PM attention classification (MUST 1). No GPT.
 * required=true: QA_FAILED, RUN_FAILED, RUN_BLOCKED, TASK_TIMEOUT,
 *                TASK_BLOCKED, OWNER_DECISION_REQUIRED, GOAL_COMPLETION_ELIGIBLE,
 *                RUNTIME_ERROR.
 * required=false: TASK_BECAME_READY, RUN_RESULT_RECEIVED, EVIDENCE_READY,
 *                 RUNTIME_WARNING, GOAL_COMPLETED (fact-only).
 *
 * Phase I3F-2: TASK_RESULT_ACCEPTED / TASK_CHANGES_REQUESTED / TASK_RETRY_REQUESTED
 * are audit FACT events (a canonical mutation occurred) — required=false by design.
 * They must not unnecessarily re-wake PM; PM already discovers the resulting
 * state (VERIFYING/CHANGES_REQUESTED/READY+PENDING) via get_next_work / reads.
 */
export function derivePmAttention(type: EventType, severity: EventSeverity): PmAttention {
  switch (type) {
    case 'OWNER_DECISION_REQUIRED':
      return { required: true, reason: 'Owner/PM decision required', priority: 'HIGH' };
    case 'QA_FAILED':
    case 'RUN_FAILED':
      return { required: true, reason: 'Failure needs review', priority: 'HIGH' };
    case 'RUN_BLOCKED':
    case 'TASK_BLOCKED':
    case 'TASK_TIMEOUT':
    case 'RUNTIME_ERROR':
      return { required: true, reason: 'Runtime error/blocker', priority: 'NORMAL' };
    case 'GOAL_COMPLETION_ELIGIBLE':
      return { required: true, reason: 'Goal completion needs review', priority: 'NORMAL' };
    case 'RUN_RESULT_RECEIVED':
    case 'EVIDENCE_READY':
    case 'TASK_BECAME_READY':
    case 'GOAL_COMPLETED':
    case 'RUNTIME_WARNING':
    case 'TASK_RESULT_ACCEPTED':
    case 'TASK_CHANGES_REQUESTED':
    case 'TASK_RETRY_REQUESTED':
    default:
      return { required: false, reason: 'Fact-only signal; no PM attention by default', priority: 'LOW' };
  }
}// ── validation ──────────────────────────────────────────────────────────────

function normalizeSource(input: unknown): EventSource {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Event source는 객체여야 합니다.');
  }
  const obj = input as Record<string, unknown>;
  const kind = requireNonEmptyString(obj.kind, 'source.kind');
  const source: EventSource = { kind };
  if (typeof obj.actor === 'string' && obj.actor.trim()) source.actor = obj.actor.trim();
  if (typeof obj.agent === 'string' && obj.agent.trim()) source.agent = obj.agent.trim();
  if (typeof obj.adapter === 'string' && obj.adapter.trim()) source.adapter = obj.adapter.trim();
  if (typeof obj.subsystem === 'string' && obj.subsystem.trim()) source.subsystem = obj.subsystem.trim();
  return source;
}

function normalizeMetadata(input: unknown): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('metadata는 객체여야 합니다.');
  }
  return { ...(input as Record<string, unknown>) };
}

function normalizeDetails(input: unknown): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('details는 객체여야 합니다.');
  }
  return { ...(input as Record<string, unknown>) };
}

/**
 * Validate linkage identities exist and are consistent. Delegates Goal/Task/Run
 * cross-validation to the Evidence kernel's linkage validator (which enforces
 * ownership + cross-project rejection), then adds Event's own evidenceId check.
 */
function validateEventLinkage(
  dataRoot: string,
  project: string,
  input: { goalId?: string; taskId?: string; runId?: string; evidenceId?: string },
): { goalId?: string; taskId?: string; runId?: string; evidenceId?: string } {
  const goalId = input.goalId ? requireNonEmptyString(input.goalId, 'goalId') : undefined;
  const taskId = input.taskId ? requireNonEmptyString(input.taskId, 'taskId') : undefined;
  const runId = input.runId ? requireNonEmptyString(input.runId, 'runId') : undefined;
  const evidenceId = input.evidenceId ? requireNonEmptyString(input.evidenceId, 'evidenceId') : undefined;

  if (goalId !== undefined && !GOAL_ID_RE.test(goalId)) throw new Error(`잘못된 Goal ID: ${goalId}`);
  if (taskId !== undefined && !TASK_ID_RE.test(taskId)) throw new Error(`잘못된 Task ID: ${taskId}`);
  if (evidenceId !== undefined && !EVIDENCE_ID_RE.test(evidenceId)) {
    throw new Error(`잘못된 Evidence ID: ${evidenceId}`);
  }

  // Late-bound require to avoid a hard import cycle with goal-task/evidence.
  const evidenceMod: typeof import('./evidence.js') = require('./evidence.js');
  const resolved = evidenceMod.validateEvidenceLinkage(dataRoot, project, { goalId, taskId, runId });

  if (evidenceId !== undefined) {
    const ev = evidenceMod.getEvidence(dataRoot, project, evidenceId); // also rejects cross-project
    if (resolved.taskId && ev.taskId && ev.taskId !== resolved.taskId) {
      throw new Error(`Evidence/Task 불일치: evidenceId=${evidenceId}의 Task는 ${ev.taskId}입니다.`);
    }
    if (resolved.goalId && ev.goalId && ev.goalId !== resolved.goalId) {
      throw new Error(`Evidence/Goal 불일치: evidenceId=${evidenceId}의 Goal은 ${ev.goalId}입니다.`);
    }
  }

  return {
    goalId: resolved.goalId,
    taskId: resolved.taskId,
    runId: resolved.runId,
    ...(evidenceId ? { evidenceId } : {}),
  };
}

export function validateEventRecord(e: EventRecord): void {
  if (e.schemaVersion !== EVENT_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 Event schemaVersion: ${e.schemaVersion}`);
  }
  if (!EVENT_ID_RE.test(e.eventId)) throw new Error(`잘못된 Event ID: ${e.eventId}`);
  if (!e.project) throw new Error('Event project가 필요합니다.');
  if (!isEventType(e.type)) throw new Error(`알 수 없는 Event type: ${String(e.type)}`);
  if (!isEventSeverity(e.severity)) throw new Error(`알 수 없는 Event severity: ${String(e.severity)}`);
  if (!e.summary?.trim()) throw new Error('Event summary가 필요합니다.');
  if (!e.source || typeof e.source !== 'object') throw new Error('Event source가 필요합니다.');
  if (!e.source.kind?.trim()) throw new Error('Event source.kind가 필요합니다.');
  if (e.goalId !== undefined && !GOAL_ID_RE.test(e.goalId)) throw new Error(`잘못된 Goal ID: ${e.goalId}`);
  if (e.taskId !== undefined && !TASK_ID_RE.test(e.taskId)) throw new Error(`잘못된 Task ID: ${e.taskId}`);
  if (e.evidenceId !== undefined && !EVIDENCE_ID_RE.test(e.evidenceId)) {
    throw new Error(`잘못된 Evidence ID: ${e.evidenceId}`);
  }
  if (e.runId !== undefined && (typeof e.runId !== 'string' || !e.runId.trim())) {
    throw new Error('runId는 비어 있지 않은 문자열이어야 합니다.');
  }
  if (!e.occurredAt || !isValidIsoTimestamp(e.occurredAt)) throw new Error('occurredAt은 ISO timestamp여야 합니다.');
  if (!e.recordedAt || !isValidIsoTimestamp(e.recordedAt)) throw new Error('recordedAt은 ISO timestamp여야 합니다.');
  // MUST 2: classifier version must be a persisted positive integer (frozen at
  // creation). Older versions remain readable — classification is never re-derived.
  if (
    typeof e.attentionClassifierVersion !== 'number' ||
    !Number.isInteger(e.attentionClassifierVersion) ||
    e.attentionClassifierVersion < 1
  ) {
    throw new Error('attentionClassifierVersion은 1 이상의 정수여야 합니다.');
  }
  if (!e.pmAttention || typeof e.pmAttention !== 'object' || typeof e.pmAttention.required !== 'boolean') {
    throw new Error('pmAttention은 required boolean이 필요합니다.');
  }
}// ── delivery state machine (MUST 7: simple lifecycle, terminal ends) ───────

/**
 * Allowed delivery transitions (CAS-like). Illegal transitions are rejected.
 * `expected` is the status the caller believes the record is currently in.
 * ACKNOWLEDGED and IGNORED are terminal. No retry/lease/subscription semantics.
 */
const DELIVERY_TRANSITIONS: Record<EventDeliveryStatus, readonly EventDeliveryStatus[]> = {
  PENDING: ['DELIVERED', 'IGNORED'],
  DELIVERED: ['ACKNOWLEDGED', 'IGNORED'],
  ACKNOWLEDGED: [],
  IGNORED: [],
};

function readDelivery(folder: string, eventId: string): EventDeliveryRecord | null {
  const file = deliveryJsonPath(folder);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as EventDeliveryRecord;
    if (!raw || typeof raw !== 'object' || raw.eventId !== eventId || !isEventDeliveryStatus(raw.status)) return null;
    return raw;
  } catch {
    return null;
  }
}

function initialDelivery(eventId: string, occurredAt: string): EventDeliveryRecord {
  return { eventId, status: 'PENDING', updatedAt: occurredAt };
}

function persistDelivery(folder: string, delivery: EventDeliveryRecord): void {
  writeJsonAtomic(deliveryJsonPath(folder), delivery);
}

/**
 * Per-event serialization for delivery mutations.
 * Same lock for markDelivered / acknowledge / ignore — no check-then-write outside.
 */
export function withDeliveryLock<T>(project: string, eventId: string, fn: () => T | Promise<T>): Promise<T> {
  const key = `${requireNonEmptyString(project, 'project')}::${requireNonEmptyString(eventId, 'eventId')}`;
  const prev = _deliveryLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _deliveryLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

/**
 * Apply a delivery transition with strict CAS expected-status semantics.
 * Must run inside withDeliveryLock for the same event.
 *
 * Contract:
 * 1. expectedStatus is required and must equal CURRENT — otherwise reject (no write).
 * 2. If expectedStatus === CURRENT and target === CURRENT → idempotent no-op success.
 * 3. Otherwise apply a legal transition, or reject illegal/terminal exits.
 */
function transitionDelivery(
  dataRoot: string,
  project: string,
  eventId: string,
  action: 'markDelivered' | 'acknowledge' | 'ignore',
  expectedStatus: EventDeliveryStatus,
): EventDeliveryRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`잘못된 Event ID: ${id}`);
  const folder = eventFolder(dataRoot, project, id);
  const eventFile = eventJsonPath(folder);
  if (!fs.existsSync(eventFile)) throw new Error(`존재하지 않는 Event: ${id}`);

  if (!isEventDeliveryStatus(expectedStatus)) {
    throw new Error(`잘못된 expectedStatus: ${String(expectedStatus)}`);
  }

  const current = readDelivery(folder, id) ?? initialDelivery(id, nowIso());

  // Strict CAS: reject stale expected before any idempotent or write path.
  if (current.status !== expectedStatus) {
    throw new Error(`대기 상태 불일치: 현재 ${current.status}, 기대 ${expectedStatus}`);
  }

  const target: EventDeliveryStatus =
    action === 'markDelivered' ? 'DELIVERED' : action === 'acknowledge' ? 'ACKNOWLEDGED' : 'IGNORED';

  // Idempotent replay only when expected matches current and caller requests same state.
  if (current.status === target) {
    return current;
  }

  const allowed = DELIVERY_TRANSITIONS[current.status];
  if (!allowed.includes(target)) {
    throw new Error(`불가능한 delivery 전이: ${current.status} → ${target}`);
  }

  const next: EventDeliveryRecord = {
    eventId: id,
    status: target,
    updatedAt: nowIso(),
    ...(target === 'DELIVERED' ? { deliveredAt: nowIso() } : {}),
    ...(target === 'ACKNOWLEDGED' ? { acknowledgedAt: nowIso() } : {}),
    ...(target === 'IGNORED' ? { ignoredAt: nowIso() } : {}),
  };
  persistDelivery(folder, next);
  return next;
}// ── markdown mirror ─────────────────────────────────────────────────────────

export function renderEventMarkdown(e: EventRecord): string {
  const lines = [
    `# ${e.eventId}`,
    '',
    '## Summary',
    '',
    e.summary,
    '',
    '## Classification',
    '',
    `- type: ${e.type}`,
    `- severity: ${e.severity}`,
    `- attentionClassifierVersion: ${e.attentionClassifierVersion}`,
    `- pmAttention.required: ${e.pmAttention.required}`,
    ...(e.pmAttention.reason ? [`- pmAttention.reason: ${e.pmAttention.reason}`] : []),
    ...(e.pmAttention.priority ? [`- pmAttention.priority: ${e.pmAttention.priority}`] : []),
    '',
    '## Linkage',
    '',
    `- project: ${e.project}`,
    `- goalId: ${e.goalId ?? '(none)'}`,
    `- taskId: ${e.taskId ?? '(none)'}`,
    `- runId: ${e.runId ?? '(none)'}`,
    `- evidenceId: ${e.evidenceId ?? '(none)'}`,
    '',
    '## Source',
    '',
    `- kind: ${e.source.kind}`,
  ];
  if (e.source.actor) lines.push(`- actor: ${e.source.actor}`);
  if (e.source.agent) lines.push(`- agent: ${e.source.agent}`);
  if (e.source.adapter) lines.push(`- adapter: ${e.source.adapter}`);
  if (e.source.subsystem) lines.push(`- subsystem: ${e.source.subsystem}`);
  lines.push('');
  if (e.details && Object.keys(e.details).length) {
    lines.push('## Details', '', '```json', JSON.stringify(e.details, null, 2), '```', '');
  }
  if (e.correlationId) lines.push(`correlationId: ${e.correlationId}`);
  if (e.causationId) lines.push(`causationId: ${e.causationId}`);
  if (e.sourceEventId) lines.push(`sourceEventId: ${e.sourceEventId}`);
  lines.push('', `occurredAt: ${e.occurredAt}`, `recordedAt: ${e.recordedAt}`, '');
  return lines.join('\n');
}

function persistEventFiles(folder: string, record: EventRecord): void {
  writeJsonAtomic(eventJsonPath(folder), record);
  try {
    fs.writeFileSync(eventMdPath(folder), renderEventMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Event JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

// ── idempotency index (rebuildable, not SSOT) ───────────────────────────────

function sourceEventIndexPath(dataRoot: string, project: string): string {
  return path.join(eventsDir(dataRoot, project), '_source-event-index.json');
}

function loadSourceEventIndex(dataRoot: string, project: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(sourceEventIndexPath(dataRoot, project), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' && v) out[k] = v;
      }
      return out;
    }
  } catch {
    /* missing/malformed — rebuild on demand */
  }
  return {};
}

function saveSourceEventIndex(dataRoot: string, project: string, index: Record<string, string>): void {
  writeJsonAtomic(sourceEventIndexPath(dataRoot, project), index);
}

function findBySourceEventId(dataRoot: string, project: string, sourceEventId: string): EventRecord | null {
  const index = loadSourceEventIndex(dataRoot, project);
  const mapped = index[sourceEventId];
  if (mapped) {
    try {
      return getEvent(dataRoot, project, mapped);
    } catch {
      // stale index entry — fall through to scan
    }
  }
  const { events } = listEvents(dataRoot, project, {});
  for (const e of events) {
    if (e.sourceEventId === sourceEventId) {
      index[sourceEventId] = e.eventId;
      try { saveSourceEventIndex(dataRoot, project, index); } catch { /* best-effort */ }
      return e;
    }
  }
  return null;
}

// ── JSON read helpers (malformed-isolated) ─────────────────────────────────

function readJsonFileUnchecked<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function tryReadEvent(folder: string): EventRecord | null {
  const rec = readJsonFileUnchecked<EventRecord>(eventJsonPath(folder));
  if (!rec) return null;
  try {
    validateEventRecord(rec);
  } catch {
    return null;
  }
  return rec;
}// ── creation (internal primitive + typed trusted helpers) ──────────────────

/**
 * Internal primitive — MUST 5/6: severity and pmAttention are ALWAYS derived
 * internally (defaultSeverityForType / derivePmAttention); there is no caller
 * override path. This primitive is intentionally NOT exported as a public API
 * and NOT exposed via IPC: privileged lifecycle Events (GOAL_COMPLETED,
 * OWNER_DECISION_REQUIRED, GOAL_COMPLETION_ELIGIBLE) can only be minted through
 * the typed trusted helpers below from inside the Relay server.
 */
function recordEventInternal(
  dataRoot: string,
  project: string,
  input: EventCreateInput,
  opts?: { trustedOccurredAt?: string },
): Promise<EventRecord> {
  if (!isEventType(input.type)) throw new Error(`알 수 없는 Event type: ${String(input.type)}`);
  const summary = requireNonEmptyString(input.summary, 'summary');
  const source = normalizeSource(input.source);

  const sourceEventId =
    typeof input.sourceEventId === 'string' && input.sourceEventId.trim()
      ? input.sourceEventId.trim()
      : undefined;

  let trustedOccurredAt: string | undefined;
  if (opts?.trustedOccurredAt !== undefined) {
    if (typeof opts.trustedOccurredAt !== 'string' || !isValidIsoTimestamp(opts.trustedOccurredAt)) {
      throw new Error('trustedOccurredAt는 ISO timestamp 문자열이어야 합니다.');
    }
    trustedOccurredAt = opts.trustedOccurredAt;
  }

  const work = _eventAllocLock.then((): EventRecord => {
    if (sourceEventId) {
      const existing = findBySourceEventId(dataRoot, project, sourceEventId);
      if (existing) return existing;
    }

    const linkage = validateEventLinkage(dataRoot, project, {
      goalId: input.goalId,
      taskId: input.taskId,
      runId: input.runId,
      evidenceId: input.evidenceId,
    });

    // MUST 5: classification is server-derived only. No caller override exists
    // in EventCreateInput — even if extra fields are smuggled in they are ignored.
    const severity = defaultSeverityForType(input.type);
    const pmAttention = derivePmAttention(input.type, severity);

    const eventId = allocateEventIdWithCounter(dataRoot, project);
    const occurredAt =
      trustedOccurredAt ?? (input.occurredAt && isValidIsoTimestamp(input.occurredAt) ? input.occurredAt : nowIso());
    const recordedAt = nowIso();
    const details = normalizeDetails(input.details);
    const metadata = normalizeMetadata(input.metadata);

    const record: EventRecord = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId,
      project,
      type: input.type,
      severity,
      source,
      summary,
      occurredAt,
      recordedAt,
      attentionClassifierVersion: ATTENTION_CLASSIFIER_VERSION,
      pmAttention,
      ...(linkage.goalId ? { goalId: linkage.goalId } : {}),
      ...(linkage.taskId ? { taskId: linkage.taskId } : {}),
      ...(linkage.runId ? { runId: linkage.runId } : {}),
      ...(linkage.evidenceId ? { evidenceId: linkage.evidenceId } : {}),
      ...(details !== undefined ? { details } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
      ...(typeof input.correlationId === 'string' && input.correlationId.trim() ? { correlationId: input.correlationId.trim() } : {}),
      ...(typeof input.causationId === 'string' && input.causationId.trim() ? { causationId: input.causationId.trim() } : {}),
      ...(metadata ? { metadata } : {}),
    };

    validateEventRecord(record);
    const folder = eventFolder(dataRoot, project, eventId);
    persistEventFiles(folder, record);
    persistDelivery(folder, initialDelivery(eventId, recordedAt));

    if (sourceEventId) {
      const index = loadSourceEventIndex(dataRoot, project);
      index[sourceEventId] = eventId;
      try { saveSourceEventIndex(dataRoot, project, index); } catch { /* best-effort */ }
    }
    return record;
  });
  _eventAllocLock = work.then(() => undefined, () => undefined);
  return work;
}/** Shared base for typed trusted helpers — builds EventCreateInput; classification derived internally. */
function baseInput(
  type: EventType,
  p: {
    summary: string;
    details?: Record<string, unknown>;
    source?: Partial<EventSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    evidenceId?: string;
    sourceEventId?: string;
    correlationId?: string;
    causationId?: string;
    occurredAt?: string;
  },
): EventCreateInput {
  return {
    type,
    summary: p.summary,
    details: p.details,
    source: { kind: p.source?.kind ?? 'runtime-kernel', ...p.source },
    goalId: p.goalId,
    taskId: p.taskId,
    runId: p.runId,
    evidenceId: p.evidenceId,
    sourceEventId: p.sourceEventId,
    correlationId: p.correlationId,
    causationId: p.causationId,
    occurredAt: p.occurredAt,
  };
}

/**
 * Typed trusted helper surface (MUST 6: closed vocabulary). Each helper fixes
 * the Event type; severity and PM attention are derived internally. There is
 * deliberately NO Worker-safe/public helper for privileged lifecycle Events —
 * the functions below are server-side Relay runtime surfaces only and none of
 * them is reachable through raw IPC creation.
 */
export function recordRunResultReceived(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('RUN_RESULT_RECEIVED', p));
}
export function recordRunFailed(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('RUN_FAILED', p));
}
export function recordRunBlocked(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('RUN_BLOCKED', p));
}
export function recordEvidenceReady(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('EVIDENCE_READY', p));
}
export function recordQaFailed(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('QA_FAILED', p));
}
export function recordTaskTimeout(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_TIMEOUT', p));
}
export function recordTaskBecameReady(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_BECAME_READY', p));
}
export function recordTaskBlocked(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_BLOCKED', p));
}
export function recordOwnerDecisionRequired(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('OWNER_DECISION_REQUIRED', p));
}
export function recordGoalCompletionEligible(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('GOAL_COMPLETION_ELIGIBLE', p));
}
export function recordGoalCompleted(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('GOAL_COMPLETED', p));
}
export function recordRuntimeWarning(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('RUNTIME_WARNING', p));
}
export function recordRuntimeError(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('RUNTIME_ERROR', p));
}

/**
 * Phase I3F-2 canonical Task Action audit facts. Each records that a
 * mutation ALREADY happened (see task-actions.ts) — never a replacement for
 * Evidence, never a Worker claim, never a trustLevel upgrade.
 */
export function recordTaskResultAccepted(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_RESULT_ACCEPTED', p));
}
export function recordTaskChangesRequested(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_CHANGES_REQUESTED', p));
}
export function recordTaskRetryRequested(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('TASK_RETRY_REQUESTED', p));
}
// ── read API ────────────────────────────────────────────────────────────────

export function getEvent(dataRoot: string, project: string, eventId: string): EventRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`잘못된 Event ID: ${id}`);
  const rec = tryReadEvent(eventFolder(dataRoot, project, id));
  if (!rec) throw new Error(`Event를 찾거나 읽을 수 없습니다: ${id}`);
  if (rec.project !== project) throw new Error(`교차 프로젝트 Event 참조는 거부됩니다: ${id}`);
  return rec;
}

/** Malformed-tolerant listing. One bad folder must not poison valid Events. */
export function listEvents(dataRoot: string, project: string, filter?: EventListFilter): EventListResult {
  const dir = eventsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return { events: [], warnings: [] };
  const out: EventRecord[] = [];
  const warnings: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!EVENT_ID_RE.test(name)) continue;
    const folder = path.join(dir, name);
    const rec = tryReadEvent(folder);
    if (!rec) {
      warnings.push(`Event ${name} 읽기 실패`);
      continue;
    }
    if (rec.project !== project) {
      warnings.push(`Event ${name} 프로젝트 불일치 — 건너뜀`);
      continue;
    }
    if (filter) {
      if (filter.goalId && rec.goalId !== filter.goalId) continue;
      if (filter.taskId && rec.taskId !== filter.taskId) continue;
      if (filter.runId && rec.runId !== filter.runId) continue;
      if (filter.evidenceId && rec.evidenceId !== filter.evidenceId) continue;
      if (filter.type && rec.type !== filter.type) continue;
      if (filter.severity && rec.severity !== filter.severity) continue;
      // Reads use the FROZEN persisted classification only (MUST 2) — never re-derived.
      if (filter.pmAttentionRequired !== undefined && rec.pmAttention.required !== filter.pmAttentionRequired) continue;
      if (filter.deliveryStatus !== undefined) {
        const delivery = readDelivery(folder, rec.eventId);
        if (!delivery || delivery.status !== filter.deliveryStatus) continue;
      }
    }
    out.push(rec);
  }
  out.sort((a, b) => a.eventId.localeCompare(b.eventId));
  return { events: out, warnings };
}

const SEVERITY_ORDER: Record<EventSeverity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };

function comparePendingPm(a: EventRecord, b: EventRecord): number {
  const sa = SEVERITY_ORDER[a.severity] ?? 3;
  const sb = SEVERITY_ORDER[b.severity] ?? 3;
  if (sa !== sb) return sa - sb;
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.eventId.localeCompare(b.eventId);
}

/**
 * Pending PM queue: Events whose FROZEN persisted pmAttention.required === true
 * AND delivery PENDING. Ordered severity → occurredAt → eventId. Purely a read
 * model — nothing is delivered automatically.
 */
export function listPendingPmEvents(dataRoot: string, project: string): EventRecord[] {
  const { events } = listEvents(dataRoot, project, { pmAttentionRequired: true, deliveryStatus: 'PENDING' });
  return [...events].sort(comparePendingPm);
}

export function listPendingPmEventsWithWarnings(dataRoot: string, project: string): EventListResult {
  const res = listEvents(dataRoot, project, { pmAttentionRequired: true, deliveryStatus: 'PENDING' });
  res.events.sort(comparePendingPm);
  return res;
}

export function getEventRuntimeSummary(dataRoot: string, project: string): EventRuntimeSummary {
  const { events } = listEvents(dataRoot, project, {});
  const byType: Partial<Record<EventType, number>> = {};
  let pending = 0;
  let pendingPm = 0;
  let critical = 0;
  let error = 0;
  let warning = 0;
  let latestEventAt: string | undefined;
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.severity === 'CRITICAL') critical += 1;
    if (e.severity === 'ERROR') error += 1;
    if (e.severity === 'WARNING') warning += 1;
    const d = readDelivery(eventFolder(dataRoot, project, e.eventId), e.eventId);
    if (d?.status === 'PENDING') pending += 1;
    if (e.pmAttention.required && d?.status === 'PENDING') pendingPm += 1;
    if (!latestEventAt || e.recordedAt > latestEventAt) latestEventAt = e.recordedAt;
  }
  return {
    totalEvents: events.length,
    pendingEvents: pending,
    pendingPmEvents: pendingPm,
    criticalEvents: critical,
    errorEvents: error,
    warningEvents: warning,
    latestEventAt,
    byType,
  };
}

// ── delivery commands (CAS + per-event lock) ────────────────────────────────

export function markDelivered(
  dataRoot: string,
  project: string,
  eventId: string,
  expectedStatus: EventDeliveryStatus,
): Promise<EventDeliveryRecord> {
  return withDeliveryLock(project, eventId, () =>
    transitionDelivery(dataRoot, project, eventId, 'markDelivered', expectedStatus),
  );
}

export function acknowledge(
  dataRoot: string,
  project: string,
  eventId: string,
  expectedStatus: EventDeliveryStatus,
): Promise<EventDeliveryRecord> {
  return withDeliveryLock(project, eventId, () =>
    transitionDelivery(dataRoot, project, eventId, 'acknowledge', expectedStatus),
  );
}

export function ignore(
  dataRoot: string,
  project: string,
  eventId: string,
  expectedStatus: EventDeliveryStatus,
): Promise<EventDeliveryRecord> {
  return withDeliveryLock(project, eventId, () =>
    transitionDelivery(dataRoot, project, eventId, 'ignore', expectedStatus),
  );
}

/** Read current delivery state for an Event (pure read). */
export function getDelivery(dataRoot: string, project: string, eventId: string): EventDeliveryRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`잘못된 Event ID: ${id}`);
  const folder = eventFolder(dataRoot, project, id);
  if (!fs.existsSync(eventJsonPath(folder))) throw new Error(`존재하지 않는 Event: ${id}`);
  return readDelivery(folder, id) ?? initialDelivery(id, nowIso());
}