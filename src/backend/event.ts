/**
 * Event runtime kernel (Phase D).
 *
 * EVENT ??STATE. Goal/Task/Run/Evidence remain the canonical SSOT. An Event
 * only records that something happened and MAY carry derived PM attention
 * classification. Creating an Event never mutates Goal/Task/Evidence state.
 *
 * Local-first filesystem SSOT under Project/_relay/events/EVENT-NNNNNN/:
 *   event.json    ??immutable core Event payload (append-only)
 *   event.md      ??human-readable mirror
 *   delivery.json ??mutable delivery/acknowledgement state (operational metadata)
 *
 * Identity is project-scoped monotonic EVENT-NNNNNN ??never a path/timestamp.
 * Source replay is idempotent via sourceEventId (same project ??same Event).
 * No MCP / PM Gateway / Dispatcher / event consumer in Phase D (strict non-goals).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
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

// ?? paths ???????????????????????????????????????????????????????????????????

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

// ?? helpers ?????????????????????????????????????????????????????????????????

function nowIso(): string {
  return new Date().toISOString();
}

function isValidIsoTimestamp(v: string): boolean {
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && typeof v === 'string' && v.includes('T');
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}??媛) ?꾩슂?⑸땲??`);
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
}
// ?? counters (shared counters.json with Goal/Task/Evidence) ?????????????????

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
      const next: CountersRecord = {
        nextGoalNumber: nextGoal,
        nextTaskNumber: nextTask,
        nextEvidenceNumber: nextEvidence,
        nextEventNumber: Math.max(n + 1, nextEvent),
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

// ?? PM attention / severity classification (centralized, deterministic) ????

/** Default severity per Event type ??deterministic, no caller override for core types. */
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
    case 'PM_REVIEW_REQUIRED':
    case 'GOAL_COMPLETION_ELIGIBLE':
    case 'RUNTIME_WARNING':
      return 'WARNING';
    case 'RUN_RESULT_RECEIVED':
    case 'EVIDENCE_READY':
    case 'TASK_BECAME_READY':
    case 'ALL_PARALLEL_RUNS_COMPLETED':
    default:
      return 'INFO';
  }
}

/** Centralized PM attention classification. Deterministic; no GPT. */
export function derivePmAttention(type: EventType, severity: EventSeverity): PmAttention {
  switch (type) {
    case 'OWNER_DECISION_REQUIRED':
    case 'PM_REVIEW_REQUIRED':
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
    case 'GOAL_COMPLETED':
      return { required: true, reason: 'Goal lifecycle change', priority: 'NORMAL' };
    case 'RUN_RESULT_RECEIVED':
    case 'EVIDENCE_READY':
      return { required: true, reason: 'Result/evidence ready for review', priority: 'NORMAL' };
    case 'RUNTIME_WARNING':
    case 'ALL_PARALLEL_RUNS_COMPLETED':
    case 'TASK_BECAME_READY':
    default:
      return { required: false, reason: 'Informational', priority: 'LOW' };
  }
}
// ?? validation ??????????????????????????????????????????????????????????????

function normalizeSource(input: unknown): EventSource {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Event source??媛앹껜?ъ빞 ?⑸땲??');
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
    throw new Error('metadata??媛앹껜?ъ빞 ?⑸땲??');
  }
  return { ...(input as Record<string, unknown>) };
}

function normalizeDetails(input: unknown): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('details??媛앹껜?ъ빞 ?⑸땲??');
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

  if (goalId !== undefined && !GOAL_ID_RE.test(goalId)) throw new Error(`?섎せ??Goal ID: ${goalId}`);
  if (taskId !== undefined && !TASK_ID_RE.test(taskId)) throw new Error(`?섎せ??Task ID: ${taskId}`);
  if (evidenceId !== undefined && !EVIDENCE_ID_RE.test(evidenceId)) {
    throw new Error(`?섎せ??Evidence ID: ${evidenceId}`);
  }

  // Late-bound require to avoid a hard import cycle with goal-task/evidence.
  const evidenceMod: typeof import('./evidence.js') = require('./evidence.js');
  const resolved = evidenceMod.validateEvidenceLinkage(dataRoot, project, { goalId, taskId, runId });

  if (evidenceId !== undefined) {
    const ev = evidenceMod.getEvidence(dataRoot, project, evidenceId); // also rejects cross-project
    if (resolved.taskId && ev.taskId && ev.taskId !== resolved.taskId) {
      throw new Error(`Evidence/Task 遺덉씪移? evidenceId=${evidenceId}??Task??${ev.taskId}?낅땲??`);
    }
    if (resolved.goalId && ev.goalId && ev.goalId !== resolved.goalId) {
      throw new Error(`Evidence/Goal 遺덉씪移? evidenceId=${evidenceId}??Goal? ${ev.goalId}?낅땲??`);
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
    throw new Error(`吏?먰븯吏 ?딅뒗 Event schemaVersion: ${e.schemaVersion}`);
  }
  if (!EVENT_ID_RE.test(e.eventId)) throw new Error(`?섎せ??Event ID: ${e.eventId}`);
  if (!e.project) throw new Error('Event project媛 ?꾩슂?⑸땲??');
  if (!isEventType(e.type)) throw new Error(`?????녿뒗 Event type: ${String(e.type)}`);
  if (!isEventSeverity(e.severity)) throw new Error(`?????녿뒗 Event severity: ${String(e.severity)}`);
  if (!e.summary?.trim()) throw new Error('Event summary媛 ?꾩슂?⑸땲??');
  if (!e.source || typeof e.source !== 'object') throw new Error('Event source媛 ?꾩슂?⑸땲??');
  if (!e.source.kind?.trim()) throw new Error('Event source.kind媛 ?꾩슂?⑸땲??');
  if (e.goalId !== undefined && !GOAL_ID_RE.test(e.goalId)) throw new Error(`?섎せ??Goal ID: ${e.goalId}`);
  if (e.taskId !== undefined && !TASK_ID_RE.test(e.taskId)) throw new Error(`?섎せ??Task ID: ${e.taskId}`);
  if (e.evidenceId !== undefined && !EVIDENCE_ID_RE.test(e.evidenceId)) {
    throw new Error(`?섎せ??Evidence ID: ${e.evidenceId}`);
  }
  if (e.runId !== undefined && (typeof e.runId !== 'string' || !e.runId.trim())) {
    throw new Error('runId??鍮꾩뼱 ?덉? ?딆? 臾몄옄?댁씠?댁빞 ?⑸땲??');
  }
  if (!e.occurredAt || !isValidIsoTimestamp(e.occurredAt)) throw new Error('occurredAt? ISO timestamp?ъ빞 ?⑸땲??');
  if (!e.recordedAt || !isValidIsoTimestamp(e.recordedAt)) throw new Error('recordedAt? ISO timestamp?ъ빞 ?⑸땲??');
  if (!e.pmAttention || typeof e.pmAttention !== 'object' || typeof e.pmAttention.required !== 'boolean') {
    throw new Error('pmAttention? required boolean???꾩슂?⑸땲??');
  }
}
// ?? delivery state machine ?????????????????????????????????????????????????

/**
 * Allowed delivery transitions (CAS-like). Illegal transitions are rejected.
 * `expected` is the status the caller believes the record is currently in.
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
 * Apply a delivery transition with CAS expected-status semantics.
 * Returns the resulting EventDeliveryRecord.
 */
function transitionDelivery(
  dataRoot: string,
  project: string,
  eventId: string,
  action: 'markDelivered' | 'acknowledge' | 'ignore',
  expectedStatus?: EventDeliveryStatus,
): EventDeliveryRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`?섎せ??Event ID: ${id}`);
  const folder = eventFolder(dataRoot, project, id);
  const eventFile = eventJsonPath(folder);
  if (!fs.existsSync(eventFile)) throw new Error(`議댁옱?섏? ?딅뒗 Event: ${id}`);

  const current = readDelivery(folder, id) ?? initialDelivery(id, nowIso());
  if (expectedStatus !== undefined && !isEventDeliveryStatus(expectedStatus)) {
    throw new Error(`?섎せ??expectedStatus: ${String(expectedStatus)}`);
  }
  if (expectedStatus !== undefined && current.status !== expectedStatus) {
    throw new Error(`?湲??곹깭 遺덉씪移? ?꾩옱 ${current.status}, 湲곕? ${expectedStatus}`);
  }

  const target: EventDeliveryStatus =
    action === 'markDelivered' ? 'DELIVERED' : action === 'acknowledge' ? 'ACKNOWLEDGED' : 'IGNORED';

  // Idempotent replay where safe: repeated identical non-advancing command is a no-op success.
  if (current.status === target) {
    return current;
  }

  const allowed = DELIVERY_TRANSITIONS[current.status];
  if (!allowed.includes(target)) {
    throw new Error(`遺덇??ν븳 delivery ?꾩씠: ${current.status} ??${target}`);
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
}
// ?? markdown mirror ?????????????????????????????????????????????????????????

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
    throw new Error(`Event JSON? ??λ릱吏留?Markdown ?곌린???ㅽ뙣?덉뒿?덈떎 (蹂듦뎄 媛??: ${msg}`);
  }
}

// ?? idempotency index (rebuildable, not SSOT) ???????????????????????????????

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
    /* missing/malformed ??rebuild on demand */
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
      // stale index entry ??fall through to scan
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

// ?? JSON read helpers (malformed-isolated) ?????????????????????????????????

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
}
// ?? CRUD (internal primitive + typed public helpers) ???????????????????????

/**
 * Internal safe primitive ??accepts resolved pmAttention override for trusted
 * internal callers only. NOT exposed as raw IPC event:create (privileged event
 * types like GOAL_COMPLETED / OWNER_DECISION_REQUIRED / PM_REVIEW_REQUIRED can
 * only be minted through the typed helpers below, never by claiming a type string).
 */
export function recordEventInternal(
  dataRoot: string,
  project: string,
  input: EventCreateInput,
  opts?: { trustedOccurredAt?: string },
): Promise<EventRecord> {
  if (!isEventType(input.type)) throw new Error(`?????녿뒗 Event type: ${String(input.type)}`);
  const summary = requireNonEmptyString(input.summary, 'summary');
  const source = normalizeSource(input.source);

  const sourceEventId =
    typeof input.sourceEventId === 'string' && input.sourceEventId.trim()
      ? input.sourceEventId.trim()
      : undefined;

  let trustedOccurredAt: string | undefined;
  if (opts?.trustedOccurredAt !== undefined) {
    if (typeof opts.trustedOccurredAt !== 'string' || !isValidIsoTimestamp(opts.trustedOccurredAt)) {
      throw new Error('trustedOccurredAt??ISO timestamp 臾몄옄?댁씠?댁빞 ?⑸땲??');
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

    const severity = input.severity !== undefined ? input.severity : defaultSeverityForType(input.type);
    if (!isEventSeverity(severity)) throw new Error(`?????녿뒗 severity: ${String(severity)}`);
    const att = input.pmAttention;
    const pmAttention: PmAttention = att
      ? {
          required: !!att.required,
          ...(att.reason ? { reason: att.reason } : {}),
          ...(att.priority ? { priority: att.priority } : {}),
        }
      : derivePmAttention(input.type, severity);

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
}
/** Shared base for typed helpers ??builds EventCreateInput; pmAttention derived server-side. */
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

/** Typed runtime-facing helpers ??see PHASE D event type list. */
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
export function recordPmReviewRequired(dataRoot: string, project: string, p: Parameters<typeof baseInput>[1]): Promise<EventRecord> {
  return recordEventInternal(dataRoot, project, baseInput('PM_REVIEW_REQUIRED', p));
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
// ?? read API ????????????????????????????????????????????????????????????????

export function getEvent(dataRoot: string, project: string, eventId: string): EventRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`?섎せ??Event ID: ${id}`);
  const rec = tryReadEvent(eventFolder(dataRoot, project, id));
  if (!rec) throw new Error(`Event瑜?李얘굅???쎌쓣 ???놁뒿?덈떎: ${id}`);
  if (rec.project !== project) throw new Error(`援먯감 ?꾨줈?앺듃 Event 李몄“??嫄곕??⑸땲?? ${id}`);
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
      warnings.push(`Event ${name} ?쎄린 ?ㅽ뙣`);
      continue;
    }
    if (rec.project !== project) {
      warnings.push(`Event ${name} ?꾨줈?앺듃 遺덉씪移???嫄대꼫?`);
      continue;
    }
    if (filter) {
      if (filter.goalId && rec.goalId !== filter.goalId) continue;
      if (filter.taskId && rec.taskId !== filter.taskId) continue;
      if (filter.runId && rec.runId !== filter.runId) continue;
      if (filter.evidenceId && rec.evidenceId !== filter.evidenceId) continue;
      if (filter.type && rec.type !== filter.type) continue;
      if (filter.severity && rec.severity !== filter.severity) continue;
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

/** Pending PM events: pmAttention.required === true AND delivery PENDING. */
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

// ?? delivery commands ???????????????????????????????????????????????????????????????

export function markDelivered(dataRoot: string, project: string, eventId: string, expectedStatus?: EventDeliveryStatus): EventDeliveryRecord {
  return transitionDelivery(dataRoot, project, eventId, 'markDelivered', expectedStatus);
}
export function acknowledge(dataRoot: string, project: string, eventId: string, expectedStatus?: EventDeliveryStatus): EventDeliveryRecord {
  return transitionDelivery(dataRoot, project, eventId, 'acknowledge', expectedStatus);
}
export function ignore(dataRoot: string, project: string, eventId: string, expectedStatus?: EventDeliveryStatus): EventDeliveryRecord {
  return transitionDelivery(dataRoot, project, eventId, 'ignore', expectedStatus);
}

/** ReadCurrent delivery state for an Event (pure read). */
export function getDelivery(dataRoot: string, project: string, eventId: string): EventDeliveryRecord {
  const id = requireNonEmptyString(eventId, 'eventId');
  if (!EVENT_ID_RE.test(id)) throw new Error(`?섎せ??Event ID: ${id}`);
  const folder = eventFolder(dataRoot, project, id);
  if (!fs.existsSync(eventJsonPath(folder))) throw new Error(`議댁옱?섏? ?딅뒗 Event: ${id}`);
  return readDelivery(folder, id) ?? initialDelivery(id, nowIso());
}
