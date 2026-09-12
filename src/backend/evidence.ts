/**
 * Evidence kernel (Phase C — trust-boundary correction).
 *
 * Local-first filesystem SSOT under Project/_relay/evidence/<EVIDENCE-ID>/.
 * Append-oriented: identity / linkage / type / trustLevel are immutable after create.
 * Higher confidence later = create NEW Evidence — never patch CLAIMED → VERIFIED.
 * Evidence is immutable: only createdAt, no updatedAt. metadata.supersedes may link corrections.
 *
 * AGENT RESULT ≠ TASK OUTCOME.
 * Does NOT implement Event Bus, collectors, MCP, PM Gateway, or auto-acceptance.
 *
 * Trust boundary:
 *   - Public IPC derives trustLevel server-side; callers never choose trustLevel.
 *   - Internal primitive createEvidenceInternal may accept resolved trustLevel but is
 *     NOT exposed via frontend/MCP-facing IPC.
 *   - Worker-safe helpers always mint CLAIMED; adapter helpers always OBSERVED;
 *     collector helpers always VERIFIED (require runId); PM helper derives ACCEPTED.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CommandEvidenceDetails,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_STATUSES,
  EVIDENCE_TRUST_LEVELS,
  EVIDENCE_TYPES,
  EvidenceCreateInput,
  EvidenceDetails,
  EvidenceRecord,
  EvidenceSource,
  EvidenceStatus,
  EvidenceSummary,
  EvidenceTrustLevel,
  EvidenceType,
  GitEvidenceDetails,
  LegacyAdapterEvidenceView,
  PM_DECISION_VERDICTS,
  PmDecisionDetails,
  PmDecisionVerdict,
  QaEvidenceDetails,
  TaskAttemptEvidenceSummary,
  TaskEvidenceEvaluation,
  TaskEvidenceSummary,
  TaskRecord,
} from '../shared/types.js';
import { buildHistory, readRunMeta } from './fs.js';
import {
  countersPath,
  findTaskByRunId,
  getGoal,
  getTask,
  relayDir,
  writeJsonAtomic,
  CountersRecord,
} from './goal-task.js';

const EVIDENCE_ID_RE = /^EVIDENCE-(\d+)$/;
const GOAL_ID_RE = /^GOAL-(\d+)$/;
const TASK_ID_RE = /^TASK-(\d+)$/;

/** Module lock serializes concurrent Evidence ID allocation within one process. */
let _evidenceAllocLock: Promise<void> = Promise.resolve();

// ── paths ───────────────────────────────────────────────────────────────────

export function evidenceDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'evidence');
}

export function evidenceFolder(dataRoot: string, project: string, evidenceId: string): string {
  return path.join(evidenceDir(dataRoot, project), evidenceId);
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

function padEvidenceId(n: number): string {
  return `EVIDENCE-${String(n).padStart(6, '0')}`;
}

function maxExistingEvidenceId(dir: string): number {
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    const m = EVIDENCE_ID_RE.exec(name);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

function readJsonFile<T>(filePath: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`잘못된 JSON 형식입니다: ${filePath}`);
  }
}

export function isEvidenceTrustLevel(v: unknown): v is EvidenceTrustLevel {
  return typeof v === 'string' && (EVIDENCE_TRUST_LEVELS as readonly string[]).includes(v);
}

export function isEvidenceType(v: unknown): v is EvidenceType {
  return typeof v === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(v);
}

export function isEvidenceStatus(v: unknown): v is EvidenceStatus {
  return typeof v === 'string' && (EVIDENCE_STATUSES as readonly string[]).includes(v);
}

export function isPmDecisionVerdict(v: unknown): v is PmDecisionVerdict {
  return typeof v === 'string' && (PM_DECISION_VERDICTS as readonly string[]).includes(v);
}

// ── counters (shared counters.json with Goal/Task) ──────────────────────────

function readCountersRaw(dataRoot: string, project: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(countersPath(dataRoot, project), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch { /* missing/malformed */ }
  return {};
}

function allocateEvidenceIdWithCounter(dataRoot: string, project: string): string {
  const dir = evidenceDir(dataRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  const evidenceMax = maxExistingEvidenceId(dir);
  const raw = readCountersRaw(dataRoot, project);
  let n =
    typeof raw.nextEvidenceNumber === 'number' && Number.isInteger(raw.nextEvidenceNumber) && raw.nextEvidenceNumber >= 1
      ? raw.nextEvidenceNumber
      : evidenceMax + 1;
  n = Math.max(n, evidenceMax + 1);

  for (;;) {
    const id = padEvidenceId(n);
    const idDir = path.join(dir, id);
    try {
      fs.mkdirSync(idDir);
      // Merge Goal/Task counters so we do not clobber concurrent allocators
      const latest = readCountersRaw(dataRoot, project);
      let nextGoal =
        typeof latest.nextGoalNumber === 'number' && Number.isInteger(latest.nextGoalNumber) && latest.nextGoalNumber >= 1
          ? latest.nextGoalNumber
          : 1;
      let nextTask =
        typeof latest.nextTaskNumber === 'number' && Number.isInteger(latest.nextTaskNumber) && latest.nextTaskNumber >= 1
          ? latest.nextTaskNumber
          : 1;
      if (typeof raw.nextGoalNumber === 'number' && Number.isInteger(raw.nextGoalNumber)) {
        nextGoal = Math.max(nextGoal, raw.nextGoalNumber);
      }
      if (typeof raw.nextTaskNumber === 'number' && Number.isInteger(raw.nextTaskNumber)) {
        nextTask = Math.max(nextTask, raw.nextTaskNumber);
      }
      const next: CountersRecord = {
        nextGoalNumber: nextGoal,
        nextTaskNumber: nextTask,
        nextEvidenceNumber: n + 1,
        ...(typeof raw.nextEventNumber === 'number' && Number.isInteger(raw.nextEventNumber) && raw.nextEventNumber >= 1
          ? { nextEventNumber: raw.nextEventNumber }
          : {}),
        ...(typeof raw.nextNoteNumber === 'number' && Number.isInteger(raw.nextNoteNumber) && raw.nextNoteNumber >= 1
          ? { nextNoteNumber: raw.nextNoteNumber }
          : typeof latest.nextNoteNumber === 'number' && Number.isInteger(latest.nextNoteNumber) && latest.nextNoteNumber >= 1
            ? { nextNoteNumber: latest.nextNoteNumber as number }
            : {}),
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

// ── validation ──────────────────────────────────────────────────────────────

function normalizeSource(input: unknown): EvidenceSource {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('source는 객체여야 합니다.');
  }
  const obj = input as Record<string, unknown>;
  const kind = requireNonEmptyString(obj.kind, 'source.kind');
  const source: EvidenceSource = { kind };
  if (typeof obj.agent === 'string' && obj.agent.trim()) source.agent = obj.agent.trim();
  if (typeof obj.adapter === 'string' && obj.adapter.trim()) source.adapter = obj.adapter.trim();
  if (typeof obj.command === 'string' && obj.command.trim()) source.command = obj.command.trim();
  if (typeof obj.tool === 'string' && obj.tool.trim()) source.tool = obj.tool.trim();
  if (typeof obj.actor === 'string' && obj.actor.trim()) source.actor = obj.actor.trim();
  return source;
}

function normalizeArtifactRefs(input: unknown): string[] | undefined {
  if (input == null) return undefined;
  if (!Array.isArray(input)) throw new Error('artifactRefs는 문자열 배열이어야 합니다.');
  return input.map((x, i) => {
    if (typeof x !== 'string' || !x.trim()) throw new Error(`artifactRefs[${i}]는 비어 있지 않은 문자열이어야 합니다.`);
    return x.trim();
  });
}

function normalizeMetadata(input: unknown): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('metadata는 객체여야 합니다.');
  }
  return { ...(input as Record<string, unknown>) };
}

/**
 * Enforce cross-field trust invariants (SHOULD 1).
 * MANUAL is internal-only; public helpers never mint MANUAL. Kernel allows it internally
 * but still enforces runId for VERIFIED and PM verdict coupling.
 */
function assertTypeTrustCompatibility(
  type: EvidenceType,
  trustLevel: EvidenceTrustLevel,
  source: EvidenceSource,
  linkage: { runId?: string },
  details?: EvidenceDetails,
): void {
  // Strict per-type trust
  if (type === 'WORKER_CLAIM' && trustLevel !== 'CLAIMED') {
    throw new Error('WORKER_CLAIM은 CLAIMED만 가질 수 있습니다.');
  }
  if (type === 'ADAPTER_OBSERVATION' && trustLevel !== 'OBSERVED') {
    throw new Error('ADAPTER_OBSERVATION은 OBSERVED만 가질 수 있습니다.');
  }
  if ((type === 'GIT' || type === 'TEST' || type === 'BUILD' || type === 'QA') && trustLevel !== 'VERIFIED') {
    throw new Error(`${type}은 VERIFIED만 가질 수 있습니다.`);
  }
  // MANUAL is allowed any but public path never exposes it; if caller tries VERIFIED via MANUAL loophole, require runId still
  if (type !== 'MANUAL') {
    // WORKER_CLAIM cannot become VERIFIED/ACCEPTED, etc already enforced above
    if (type === 'WORKER_CLAIM' && (trustLevel === 'VERIFIED' || trustLevel === 'ACCEPTED')) {
      throw new Error('WORKER_CLAIM은 VERIFIED/ACCEPTED trustLevel을 가질 수 없습니다 — 새 Evidence를 만드세요.');
    }
    if (type === 'ADAPTER_OBSERVATION' && (trustLevel === 'VERIFIED' || trustLevel === 'ACCEPTED')) {
      throw new Error('ADAPTER_OBSERVATION은 VERIFIED/ACCEPTED trustLevel을 가질 수 없습니다 — 새 Evidence를 만드세요.');
    }
    if (type === 'PM_DECISION' && trustLevel === 'VERIFIED') {
      throw new Error('PM_DECISION은 VERIFIED가 아닙니다 — ACCEPTED(수락) 또는 OBSERVED(그 외 결정)을 사용하세요.');
    }
  }
  // PM_DECISION verdict coupling
  if (type === 'PM_DECISION') {
    const d = details as PmDecisionDetails | undefined;
    const verdict = d?.verdict;
    if (verdict) {
      if (!isPmDecisionVerdict(verdict)) throw new Error(`알 수 없는 PM verdict: ${String(verdict)}`);
      if (verdict === 'ACCEPTED' && trustLevel !== 'ACCEPTED') {
        throw new Error('PM_DECISION verdict ACCEPTED는 trustLevel ACCEPTED여야 합니다.');
      }
      if (verdict !== 'ACCEPTED' && trustLevel === 'ACCEPTED') {
        throw new Error('PM_DECISION non-ACCEPTED verdict는 ACCEPTED trustLevel을 가질 수 없습니다.');
      }
    } else {
      // No verdict supplied via generic create path — still enforce trust level not VERIFIED
      if (trustLevel === 'VERIFIED') throw new Error('PM_DECISION은 VERIFIED가 아닙니다.');
    }
  }
  // VERIFIED requires non-anonymous source
  if (trustLevel === 'VERIFIED' && source.kind === 'anonymous') {
    throw new Error('익명 source로는 VERIFIED Evidence를 만들 수 없습니다 (MANUAL 제외).');
  }
  if (trustLevel === 'VERIFIED' && !source.kind.trim()) {
    throw new Error('VERIFIED Evidence에는 source.kind가 필요합니다.');
  }
  // GIT / TEST / BUILD / QA VERIFIED require runId
  if ((type === 'GIT' || type === 'TEST' || type === 'BUILD' || type === 'QA') && trustLevel === 'VERIFIED') {
    if (!linkage.runId) {
      throw new Error(`${type} VERIFIED Evidence는 runId가 필요합니다.`);
    }
  }
  // ARTIFACT/RUNTIME generally not VERIFIED without runId either? enforce if needed
}

export function validateEvidenceRecord(e: EvidenceRecord): void {
  if (e.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 Evidence schemaVersion: ${e.schemaVersion}`);
  }
  if (!EVIDENCE_ID_RE.test(e.evidenceId)) throw new Error(`잘못된 Evidence ID: ${e.evidenceId}`);
  if (!e.project) throw new Error('Evidence project가 필요합니다.');
  if (!isEvidenceType(e.type)) throw new Error(`알 수 없는 Evidence type: ${String(e.type)}`);
  if (!isEvidenceTrustLevel(e.trustLevel)) throw new Error(`알 수 없는 Evidence trustLevel: ${String(e.trustLevel)}`);
  if (!isEvidenceStatus(e.status)) throw new Error(`알 수 없는 Evidence status: ${String(e.status)}`);
  if (!e.summary?.trim()) throw new Error('Evidence summary가 필요합니다.');
  if (!e.source || typeof e.source !== 'object') throw new Error('Evidence source가 필요합니다.');
  if (!e.source.kind?.trim()) throw new Error('Evidence source.kind가 필요합니다.');
  if (e.goalId !== undefined && !GOAL_ID_RE.test(e.goalId)) throw new Error(`잘못된 Goal ID: ${e.goalId}`);
  if (e.taskId !== undefined && !TASK_ID_RE.test(e.taskId)) throw new Error(`잘못된 Task ID: ${e.taskId}`);
  if (e.runId !== undefined && (typeof e.runId !== 'string' || !e.runId.trim())) {
    throw new Error('runId는 비어 있지 않은 문자열이어야 합니다.');
  }
  if (e.createdAt && typeof e.createdAt !== 'string') throw new Error('createdAt은 문자열이어야 합니다.');
  // updatedAt is NOT allowed (immutability) — if present in persisted file, treat as malformed for new writes
  // but tolerate reading legacy files: do not throw, just ignore. Validation should not require it.
  assertTypeTrustCompatibility(e.type, e.trustLevel, e.source, { runId: e.runId }, e.details);
}

/** Resolve a logical runId to a physical folder within the project (if present). */
export function findRunFolderByRunId(
  dataRoot: string,
  project: string,
  runId: string,
): string | null {
  const id = requireNonEmptyString(runId, 'runId');
  for (const item of buildHistory(dataRoot, project)) {
    const meta = readRunMeta(item.folder);
    if (meta.runId === id) return item.folder;
  }
  // Also check Task linkedRuns (folder may still exist or be the only locator)
  const owner = findTaskByRunId(dataRoot, project, id);
  if (owner) {
    const link = owner.linkedRuns.find((r) => r.runId === id);
    if (link?.folder && fs.existsSync(link.folder)) return link.folder;
    if (link?.folder) return link.folder;
  }
  return null;
}

/**
 * Validate linkage identities exist and are consistent.
 * Rejects fabricated runId/taskId/goalId relationships and cross-project refs.
 */
function validateLinkage(
  dataRoot: string,
  project: string,
  input: { goalId?: string; taskId?: string; runId?: string },
): { goalId?: string; taskId?: string; runId?: string } {
  let goalId = input.goalId ? requireNonEmptyString(input.goalId, 'goalId') : undefined;
  let taskId = input.taskId ? requireNonEmptyString(input.taskId, 'taskId') : undefined;
  let runId = input.runId ? requireNonEmptyString(input.runId, 'runId') : undefined;

  let task: TaskRecord | null = null;

  if (goalId) {
    if (!GOAL_ID_RE.test(goalId)) throw new Error(`잘못된 Goal ID: ${goalId}`);
    const goal = getGoal(dataRoot, project, goalId);
    if (goal.project !== project) {
      throw new Error(`교차 프로젝트 Goal 참조는 거부됩니다: ${goalId}`);
    }
  }

  if (taskId) {
    if (!TASK_ID_RE.test(taskId)) throw new Error(`잘못된 Task ID: ${taskId}`);
    task = getTask(dataRoot, project, taskId);
    if (task.project !== project) {
      throw new Error(`교차 프로젝트 Task 참조는 거부됩니다: ${taskId}`);
    }
    if (goalId && task.goalId !== goalId) {
      throw new Error(`Task/Goal 불일치: ${taskId}는 ${task.goalId}에 속합니다 (요청 goalId=${goalId}).`);
    }
    if (!goalId) goalId = task.goalId;
  }

  if (runId) {
    const folder = findRunFolderByRunId(dataRoot, project, runId);
    const owner = findTaskByRunId(dataRoot, project, runId);
    if (!folder && !owner) {
      throw new Error(`존재하지 않는 runId: ${runId}`);
    }
    if (folder) {
      const meta = readRunMeta(folder);
      if (meta.runId && meta.runId !== runId) {
        throw new Error(`Run meta runId 불일치: ${meta.runId} vs ${runId}`);
      }
      // Prefer meta back-link when present
      if (meta.taskId) {
        if (taskId && meta.taskId !== taskId) {
          throw new Error(`Run/Task 불일치: runId=${runId}는 Task ${meta.taskId}에 연결됨 (요청 taskId=${taskId}).`);
        }
        if (!taskId) {
          taskId = meta.taskId;
          task = getTask(dataRoot, project, taskId);
        }
      }
      if (meta.goalId) {
        if (goalId && meta.goalId !== goalId) {
          throw new Error(`Run/Goal 불일치: runId=${runId}는 Goal ${meta.goalId}에 연결됨 (요청 goalId=${goalId}).`);
        }
        if (!goalId) goalId = meta.goalId;
      }
    }
    if (owner) {
      if (taskId && owner.taskId !== taskId) {
        throw new Error(`Run/Task 불일치: runId=${runId}는 Task ${owner.taskId}에 연결됨 (요청 taskId=${taskId}).`);
      }
      if (!taskId) {
        taskId = owner.taskId;
        task = owner;
      }
      if (goalId && owner.goalId !== goalId) {
        throw new Error(`Run/Goal 불일치: runId=${runId} 소유 Task의 Goal은 ${owner.goalId}입니다.`);
      }
      if (!goalId) goalId = owner.goalId;
    }
  }

  // Final consistency: if both task and goal resolved, confirm
  if (taskId && goalId) {
    const t = task ?? getTask(dataRoot, project, taskId);
    if (t.goalId !== goalId) {
      throw new Error(`Task/Goal 불일치: ${taskId}는 ${t.goalId}에 속합니다.`);
    }
    if (t.project !== project) {
      throw new Error(`교차 프로젝트 Task 참조는 거부됩니다: ${taskId}`);
    }
  }

  return { goalId, taskId, runId };
}

/**
 * Exported alias for the Event kernel's linkage validation reuse.
 * Rejects fabricated cross-project / mismatched Goal-Task-Run relationships.
 */
export function validateEvidenceLinkage(
  dataRoot: string,
  project: string,
  input: { goalId?: string; taskId?: string; runId?: string },
): { goalId?: string; taskId?: string; runId?: string } {
  return validateLinkage(dataRoot, project, input);
}

// ── markdown mirror ─────────────────────────────────────────────────────────

export function renderEvidenceMarkdown(e: EvidenceRecord): string {
  const lines = [
    `# ${e.evidenceId}`,
    '',
    '## Summary',
    '',
    e.summary,
    '',
    '## Classification',
    '',
    `- type: ${e.type}`,
    `- trustLevel: ${e.trustLevel}`,
    `- status: ${e.status}`,
    '',
    '## Linkage',
    '',
    `- project: ${e.project}`,
    `- goalId: ${e.goalId ?? '(none)'}`,
    `- taskId: ${e.taskId ?? '(none)'}`,
    `- runId: ${e.runId ?? '(none)'}`,
    '',
    '## Source',
    '',
    `- kind: ${e.source.kind}`,
  ];
  if (e.source.agent) lines.push(`- agent: ${e.source.agent}`);
  if (e.source.adapter) lines.push(`- adapter: ${e.source.adapter}`);
  if (e.source.command) lines.push(`- command: ${e.source.command}`);
  if (e.source.tool) lines.push(`- tool: ${e.source.tool}`);
  if (e.source.actor) lines.push(`- actor: ${e.source.actor}`);
  lines.push('');
  if (e.details && Object.keys(e.details).length) {
    lines.push('## Details', '', '```json', JSON.stringify(e.details, null, 2), '```', '');
  }
  if (e.rawRef) lines.push(`rawRef: ${e.rawRef}`);
  if (e.artifactRefs?.length) {
    lines.push('## Artifacts', '', ...e.artifactRefs.map((a) => `- ${a}`), '');
  }
  if (e.sourceEventId) lines.push(`sourceEventId: ${e.sourceEventId}`);
  lines.push('', `createdAt: ${e.createdAt}`, '');
  return lines.join('\n');
}

function persistEvidenceFiles(folder: string, record: EvidenceRecord): void {
  writeJsonAtomic(path.join(folder, 'evidence.json'), record);
  try {
    fs.writeFileSync(path.join(folder, 'evidence.md'), renderEvidenceMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Evidence JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

// ── idempotency index (rebuildable, not SSOT) ───────────────────────────────

function sourceEventIndexPath(dataRoot: string, project: string): string {
  return path.join(evidenceDir(dataRoot, project), '_source-event-index.json');
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
  } catch { /* missing/malformed — rebuild on demand */ }
  return {};
}

function saveSourceEventIndex(dataRoot: string, project: string, index: Record<string, string>): void {
  writeJsonAtomic(sourceEventIndexPath(dataRoot, project), index);
}

function findBySourceEventId(
  dataRoot: string,
  project: string,
  sourceEventId: string,
): EvidenceRecord | null {
  const index = loadSourceEventIndex(dataRoot, project);
  const mapped = index[sourceEventId];
  if (mapped) {
    try {
      return getEvidence(dataRoot, project, mapped);
    } catch {
      // stale index entry — fall through to scan
    }
  }
  // Rebuildable scan (SSOT is evidence folders)
  const { evidence } = listEvidenceWithDiagnostics(dataRoot, project);
  for (const e of evidence) {
    if (e.sourceEventId === sourceEventId) {
      index[sourceEventId] = e.evidenceId;
      try { saveSourceEventIndex(dataRoot, project, index); } catch { /* best-effort */ }
      return e;
    }
  }
  return null;
}

// ── CRUD (internal primitive + public safe helpers) ─────────────────────────

/**
 * Internal primitive — accepts resolved trustLevel.
 * NOT exposed via public IPC. `trustedCreatedAt` may only be supplied by
 * trusted server-side collectors; public IPC must never forward caller timestamps.
 */
export function createEvidenceInternal(
  dataRoot: string,
  project: string,
  input: EvidenceCreateInput,
  opts?: { trustedCreatedAt?: string },
): Promise<EvidenceRecord> {
  if (!isEvidenceType(input.type)) throw new Error(`알 수 없는 Evidence type: ${String(input.type)}`);
  if (!isEvidenceTrustLevel(input.trustLevel)) {
    throw new Error(`알 수 없는 Evidence trustLevel: ${String(input.trustLevel)}`);
  }
  if (!isEvidenceStatus(input.status)) throw new Error(`알 수 없는 Evidence status: ${String(input.status)}`);
  const summary = requireNonEmptyString(input.summary, 'summary');
  const source = normalizeSource(input.source);

  const sourceEventId =
    typeof input.sourceEventId === 'string' && input.sourceEventId.trim()
      ? input.sourceEventId.trim()
      : undefined;

  // Validate trusted timestamp if supplied (internal collectors only)
  let trustedCreatedAt: string | undefined;
  if (opts?.trustedCreatedAt !== undefined) {
    if (typeof opts.trustedCreatedAt !== 'string' || !isValidIsoTimestamp(opts.trustedCreatedAt)) {
      throw new Error('trustedCreatedAt는 ISO timestamp 문자열이어야 합니다.');
    }
    trustedCreatedAt = opts.trustedCreatedAt;
  }

  const work = _evidenceAllocLock.then((): EvidenceRecord => {
    if (sourceEventId) {
      const existing = findBySourceEventId(dataRoot, project, sourceEventId);
      if (existing) return existing;
    }

    const linkage = validateLinkage(dataRoot, project, {
      goalId: input.goalId,
      taskId: input.taskId,
      runId: input.runId,
    });

    // Cross-field invariants (must be after linkage resolves runId)
    assertTypeTrustCompatibility(input.type, input.trustLevel, source, { runId: linkage.runId }, input.details);

    const evidenceId = allocateEvidenceIdWithCounter(dataRoot, project);
    const ts = trustedCreatedAt ?? nowIso();
    const artifactRefs = normalizeArtifactRefs(input.artifactRefs);
    const metadata = normalizeMetadata(input.metadata);
    const record: EvidenceRecord = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      evidenceId,
      project,
      type: input.type,
      trustLevel: input.trustLevel,
      status: input.status,
      source,
      summary,
      createdAt: ts,
      ...(linkage.goalId ? { goalId: linkage.goalId } : {}),
      ...(linkage.taskId ? { taskId: linkage.taskId } : {}),
      ...(linkage.runId ? { runId: linkage.runId } : {}),
      ...(input.details !== undefined ? { details: input.details } : {}),
      ...(typeof input.rawRef === 'string' && input.rawRef.trim() ? { rawRef: input.rawRef.trim() } : {}),
      ...(artifactRefs ? { artifactRefs } : {}),
      ...(metadata ? { metadata } : {}),
      ...(sourceEventId ? { sourceEventId } : {}),
    };
    validateEvidenceRecord(record);
    persistEvidenceFiles(evidenceFolder(dataRoot, project, evidenceId), record);

    if (sourceEventId) {
      const index = loadSourceEventIndex(dataRoot, project);
      index[sourceEventId] = evidenceId;
      try { saveSourceEventIndex(dataRoot, project, index); } catch { /* best-effort */ }
    }
    return record;
  });
  _evidenceAllocLock = work.then(() => undefined, () => undefined);
  return work;
}

/**
 * Legacy public entry — retained as internal/admin primitive.
 * NOT exposed via IPC. Prefer typed safe helpers.
 */
export function createEvidence(
  dataRoot: string,
  project: string,
  input: EvidenceCreateInput,
): Promise<EvidenceRecord> {
  return createEvidenceInternal(dataRoot, project, input);
}

export function getEvidence(dataRoot: string, project: string, evidenceId: string): EvidenceRecord {
  const id = requireNonEmptyString(evidenceId, 'evidenceId');
  if (!EVIDENCE_ID_RE.test(id)) throw new Error(`잘못된 Evidence ID: ${id}`);
  const file = path.join(evidenceFolder(dataRoot, project, id), 'evidence.json');
  const record = readJsonFile<EvidenceRecord>(file);
  validateEvidenceRecord(record);
  if (record.project !== project) {
    throw new Error(`교차 프로젝트 Evidence 참조는 거부됩니다: ${id}`);
  }
  return record;
}

export interface ListEvidenceResult {
  evidence: EvidenceRecord[];
  warnings: string[];
}

export function listEvidenceWithDiagnostics(
  dataRoot: string,
  project: string,
  filter?: { runId?: string; taskId?: string; goalId?: string },
): ListEvidenceResult {
  const dir = evidenceDir(dataRoot, project);
  if (!fs.existsSync(dir)) return { evidence: [], warnings: [] };
  const out: EvidenceRecord[] = [];
  const warnings: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!EVIDENCE_ID_RE.test(name)) continue;
    const file = path.join(dir, name, 'evidence.json');
    if (!fs.existsSync(file)) continue;
    try {
      const record = readJsonFile<EvidenceRecord>(file);
      validateEvidenceRecord(record);
      if (record.project !== project) {
        warnings.push(`Evidence ${name} 프로젝트 불일치 — 건너뜀`);
        continue;
      }
      if (filter?.runId && record.runId !== filter.runId) continue;
      if (filter?.taskId && record.taskId !== filter.taskId) continue;
      if (filter?.goalId && record.goalId !== filter.goalId) continue;
      out.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Evidence ${name} 읽기 실패: ${msg}`);
    }
  }
  out.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  return { evidence: out, warnings };
}

export function listEvidenceForRun(
  dataRoot: string,
  project: string,
  runId: string,
): EvidenceRecord[] {
  const id = requireNonEmptyString(runId, 'runId');
  return listEvidenceWithDiagnostics(dataRoot, project, { runId: id }).evidence;
}

/** Direct Task-scoped evidence only (taskId match; ignores Run-linked evidence without taskId). */
export function listDirectTaskEvidence(
  dataRoot: string,
  project: string,
  taskId: string,
): EvidenceRecord[] {
  const id = requireNonEmptyString(taskId, 'taskId');
  getTask(dataRoot, project, id);
  return listEvidenceWithDiagnostics(dataRoot, project, { taskId: id }).evidence;
}

/**
 * Task evidence listing.
 * includeRunEvidence=true (default): also include evidence whose runId is linked to the Task
 * even if taskId was not stamped on the record.
 */
export function listEvidenceForTask(
  dataRoot: string,
  project: string,
  taskId: string,
  includeRunEvidence = true,
): EvidenceRecord[] {
  const id = requireNonEmptyString(taskId, 'taskId');
  const task = getTask(dataRoot, project, id);
  const direct = listEvidenceWithDiagnostics(dataRoot, project, { taskId: id }).evidence;
  if (!includeRunEvidence) return direct;

  const runIds = new Set(task.linkedRuns.map((r) => r.runId));
  if (runIds.size === 0) return direct;

  const { evidence: all } = listEvidenceWithDiagnostics(dataRoot, project);
  const byId = new Map(direct.map((e) => [e.evidenceId, e]));
  for (const e of all) {
    if (e.runId && runIds.has(e.runId) && !byId.has(e.evidenceId)) {
      byId.set(e.evidenceId, e);
    }
  }
  return [...byId.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

export function listEvidenceForGoal(
  dataRoot: string,
  project: string,
  goalId: string,
): EvidenceRecord[] {
  const id = requireNonEmptyString(goalId, 'goalId');
  getGoal(dataRoot, project, id);
  return listEvidenceWithDiagnostics(dataRoot, project, { goalId: id }).evidence;
}

// ── aggregation (pure read-side) ────────────────────────────────────────────

export function summarizeEvidence(records: readonly EvidenceRecord[]): EvidenceSummary {
  const types = new Set<EvidenceType>();
  let claimedCount = 0;
  let observedCount = 0;
  let verifiedCount = 0;
  let acceptedCount = 0;
  let passCount = 0;
  let failCount = 0;
  let inconclusiveCount = 0;
  let infoCount = 0;
  let latestEvidenceAt: string | undefined;

  for (const e of records) {
    types.add(e.type);
    if (e.trustLevel === 'CLAIMED') claimedCount += 1;
    else if (e.trustLevel === 'OBSERVED') observedCount += 1;
    else if (e.trustLevel === 'VERIFIED') verifiedCount += 1;
    else if (e.trustLevel === 'ACCEPTED') acceptedCount += 1;

    if (e.status === 'PASS') passCount += 1;
    else if (e.status === 'FAIL') failCount += 1;
    else if (e.status === 'INCONCLUSIVE') inconclusiveCount += 1;
    else if (e.status === 'INFO') infoCount += 1;

    if (!latestEvidenceAt || e.createdAt > latestEvidenceAt) latestEvidenceAt = e.createdAt;
  }

  return {
    claimedCount,
    observedCount,
    verifiedCount,
    acceptedCount,
    passCount,
    failCount,
    inconclusiveCount,
    infoCount,
    ...(latestEvidenceAt ? { latestEvidenceAt } : {}),
    evidenceTypes: [...types].sort(),
    totalCount: records.length,
  };
}

export function getRunEvidenceSummary(
  dataRoot: string,
  project: string,
  runId: string,
): EvidenceSummary {
  return summarizeEvidence(listEvidenceForRun(dataRoot, project, runId));
}

export function getTaskEvidenceSummary(
  dataRoot: string,
  project: string,
  taskId: string,
): TaskEvidenceSummary {
  const records = listEvidenceForTask(dataRoot, project, taskId, true);
  const base = summarizeEvidence(records);
  let workerClaimCount = 0;
  let adapterObservationCount = 0;
  let objectiveVerificationCount = 0;
  let pmAcceptanceCount = 0;
  for (const e of records) {
    if (e.type === 'WORKER_CLAIM') workerClaimCount += 1;
    if (e.type === 'ADAPTER_OBSERVATION') adapterObservationCount += 1;
    if (
      e.trustLevel === 'VERIFIED' &&
      (e.type === 'TEST' || e.type === 'BUILD' || e.type === 'GIT' || e.type === 'QA')
    ) {
      objectiveVerificationCount += 1;
    }
    if (e.type === 'PM_DECISION' && e.trustLevel === 'ACCEPTED') {
      const d = e.details as PmDecisionDetails | undefined;
      if (d && d.verdict === 'ACCEPTED') pmAcceptanceCount += 1;
    }
  }
  // Attempt-aware decomposition
  const task = getTask(dataRoot, project, requireNonEmptyString(taskId, 'taskId'));
  const sortedRuns = [...task.linkedRuns].sort((a, b) => a.taskRunSequence - b.taskRunSequence);
  const maxSeq = sortedRuns.length ? sortedRuns[sortedRuns.length - 1]!.taskRunSequence : 0;
  const acceptedRunId = task.acceptedRunId;
  // Map runId -> evidence
  const byRunId = new Map<string, EvidenceRecord[]>();
  for (const e of records) {
    if (e.runId) {
      const arr = byRunId.get(e.runId) ?? [];
      arr.push(e);
      byRunId.set(e.runId, arr);
    }
  }
  const attempts: TaskAttemptEvidenceSummary[] = sortedRuns.map((link) => {
    const recs = byRunId.get(link.runId) ?? [];
    // Include only run-linked evidence; task-level direct evidence is counted separately
    const summary = summarizeEvidence(recs);
    return {
      runId: link.runId,
      taskRunSequence: link.taskRunSequence,
      isAcceptedAttempt: acceptedRunId === link.runId,
      isLatestAttempt: link.taskRunSequence === maxSeq,
      summary,
    };
  });
  const currentAttemptRunId = acceptedRunId ?? (sortedRuns.length ? sortedRuns[sortedRuns.length - 1]!.runId : undefined);
  const directTaskEvidenceCount = records.filter((e) => !e.runId || !sortedRuns.some((r) => r.runId === e.runId)).length;
  // Actually direct means taskId match but not linked to a run; we count as above
  return {
    ...base,
    workerClaimCount,
    adapterObservationCount,
    objectiveVerificationCount,
    pmAcceptanceCount,
    attempts,
    ...(currentAttemptRunId ? { currentAttemptRunId } : {}),
    ...(acceptedRunId ? { acceptedRunId } : {}),
    directTaskEvidenceCount,
  };
}

/**
 * Advisory evaluation only — MUST NOT mutate Task pmState.
 * hasVerificationFailure reflects CURRENT relevant attempt (acceptedRunId or latest),
 * not any historical failure. Historical failures remain visible via TaskEvidenceSummary.attempts.
 */
export function evaluateTaskEvidence(
  dataRoot: string,
  project: string,
  taskId: string,
): TaskEvidenceEvaluation {
  const records = listEvidenceForTask(dataRoot, project, taskId, true);
  const task = getTask(dataRoot, project, requireNonEmptyString(taskId, 'taskId'));
  const sortedRuns = [...task.linkedRuns].sort((a, b) => a.taskRunSequence - b.taskRunSequence);
  const currentRunId = task.acceptedRunId ?? (sortedRuns.length ? sortedRuns[sortedRuns.length - 1]!.runId : undefined);

  let hasWorkerClaim = false;
  let hasObservation = false;
  let hasObjectiveVerification = false;
  let hasVerificationFailure = false;
  let hasPmAcceptanceEvidence = false;
  const blockers: string[] = [];

  // Overall flags (except verification failure which is attempt-aware)
  for (const e of records) {
    if (e.type === 'WORKER_CLAIM') hasWorkerClaim = true;
    if (e.type === 'ADAPTER_OBSERVATION' || e.trustLevel === 'OBSERVED') hasObservation = true;
    if (
      e.trustLevel === 'VERIFIED' &&
      (e.type === 'TEST' || e.type === 'BUILD' || e.type === 'GIT' || e.type === 'QA')
    ) {
      hasObjectiveVerification = true;
    }
    if (e.type === 'PM_DECISION') {
      const d = e.details as PmDecisionDetails | undefined;
      if (e.trustLevel === 'ACCEPTED' && d?.verdict === 'ACCEPTED') {
        hasPmAcceptanceEvidence = true;
      }
      if (d?.verdict === 'REJECTED' || d?.verdict === 'CHANGES_REQUESTED') {
        blockers.push(`${e.evidenceId}: PM ${d.verdict}${d.reason ? ` — ${d.reason}` : ''}`);
      }
      if (d?.verdict === 'OWNER_REQUIRED') {
        blockers.push(`${e.evidenceId}: OWNER_REQUIRED${d.reason ? ` — ${d.reason}` : ''}`);
      }
    }
  }
  // Current-attempt verification failure (advisory)
  if (currentRunId) {
    for (const e of records) {
      if (e.runId !== currentRunId) continue;
      if (
        e.trustLevel === 'VERIFIED' &&
        (e.type === 'TEST' || e.type === 'BUILD' || e.type === 'GIT' || e.type === 'QA') &&
        e.status === 'FAIL'
      ) {
        hasVerificationFailure = true;
        blockers.push(`${e.evidenceId}: ${e.type} FAIL (current attempt) — ${e.summary}`);
      }
    }
    // If current attempt has no verification evidence but historical did, do NOT surface historical as current failure
  } else {
    // No linked run — consider direct task evidence for failure? Direct Task-level evidence is reported separately
    // but for advisory we can check direct VERIFIED FAIL without runId (should be none per invariants)
    for (const e of records) {
      if (e.runId) continue;
      if (
        e.trustLevel === 'VERIFIED' &&
        (e.type === 'TEST' || e.type === 'BUILD' || e.type === 'GIT' || e.type === 'QA') &&
        e.status === 'FAIL'
      ) {
        hasVerificationFailure = true;
        blockers.push(`${e.evidenceId}: ${e.type} FAIL — ${e.summary}`);
      }
    }
  }

  if (!hasWorkerClaim && !hasObservation && !hasObjectiveVerification && !hasPmAcceptanceEvidence) {
    blockers.push('No evidence recorded for this Task yet');
  }

  return {
    hasWorkerClaim,
    hasObservation,
    hasObjectiveVerification,
    hasVerificationFailure,
    hasPmAcceptanceEvidence,
    blockers,
    ...(currentRunId ? { currentAttemptRunId: currentRunId } : {}),
    ...(task.acceptedRunId ? { acceptedRunId: task.acceptedRunId } : {}),
  };
}

// ── specialized helpers (same EvidenceRecord model) ─────────────────────────

export function recordWorkerClaim(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    source?: Partial<EvidenceSource>;
    status?: EvidenceStatus;
    details?: EvidenceDetails;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  return createEvidenceInternal(dataRoot, project, {
    type: 'WORKER_CLAIM',
    trustLevel: 'CLAIMED',
    status: input.status ?? 'INFO',
    source: { kind: input.source?.kind ?? 'worker', ...input.source },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordAdapterObservation(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    source?: Partial<EvidenceSource>;
    status?: EvidenceStatus;
    details?: EvidenceDetails;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  return createEvidenceInternal(dataRoot, project, {
    type: 'ADAPTER_OBSERVATION',
    trustLevel: 'OBSERVED',
    status: input.status ?? 'INFO',
    source: { kind: input.source?.kind ?? 'adapter', ...input.source },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordGitEvidence(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    details?: GitEvidenceDetails;
    status?: EvidenceStatus;
    source?: Partial<EvidenceSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  return createEvidenceInternal(dataRoot, project, {
    type: 'GIT',
    trustLevel: 'VERIFIED',
    status: input.status ?? 'INFO',
    source: { kind: input.source?.kind ?? 'git-collector', ...input.source },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordTestEvidence(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    details?: CommandEvidenceDetails;
    status?: EvidenceStatus;
    source?: Partial<EvidenceSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  const exitCode = input.details?.exitCode;
  const status: EvidenceStatus =
    input.status ??
    (typeof exitCode === 'number' ? (exitCode === 0 ? 'PASS' : 'FAIL') : 'INCONCLUSIVE');
  return createEvidenceInternal(dataRoot, project, {
    type: 'TEST',
    trustLevel: 'VERIFIED',
    status,
    source: {
      kind: input.source?.kind ?? 'test-executor',
      ...(input.details?.command ? { command: input.details.command } : {}),
      ...input.source,
    },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordBuildEvidence(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    details?: CommandEvidenceDetails;
    status?: EvidenceStatus;
    source?: Partial<EvidenceSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  const exitCode = input.details?.exitCode;
  const status: EvidenceStatus =
    input.status ??
    (typeof exitCode === 'number' ? (exitCode === 0 ? 'PASS' : 'FAIL') : 'INCONCLUSIVE');
  return createEvidenceInternal(dataRoot, project, {
    type: 'BUILD',
    trustLevel: 'VERIFIED',
    status,
    source: {
      kind: input.source?.kind ?? 'build-executor',
      ...(input.details?.command ? { command: input.details.command } : {}),
      ...input.source,
    },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordQaEvidence(
  dataRoot: string,
  project: string,
  input: {
    summary: string;
    details?: QaEvidenceDetails;
    status?: EvidenceStatus;
    source?: Partial<EvidenceSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  return createEvidenceInternal(dataRoot, project, {
    type: 'QA',
    trustLevel: 'VERIFIED',
    status: input.status ?? 'INFO',
    source: { kind: input.source?.kind ?? 'qa', ...input.source },
    summary: input.summary,
    details: input.details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

export function recordPmDecision(
  dataRoot: string,
  project: string,
  input: {
    verdict: PmDecisionVerdict;
    summary?: string;
    reason?: string;
    targetRunId?: string;
    source?: Partial<EvidenceSource>;
    goalId?: string;
    taskId?: string;
    runId?: string;
    rawRef?: string;
    artifactRefs?: string[];
    metadata?: Record<string, unknown>;
    sourceEventId?: string;
  },
): Promise<EvidenceRecord> {
  if (!isPmDecisionVerdict(input.verdict)) {
    throw new Error(`알 수 없는 PM decision verdict: ${String(input.verdict)}`);
  }
  const details: PmDecisionDetails = {
    verdict: input.verdict,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.targetRunId ? { targetRunId: input.targetRunId } : {}),
  };
  const trustLevel: EvidenceTrustLevel = input.verdict === 'ACCEPTED' ? 'ACCEPTED' : 'OBSERVED';
  const status: EvidenceStatus =
    input.verdict === 'ACCEPTED'
      ? 'PASS'
      : input.verdict === 'OWNER_REQUIRED'
        ? 'INFO'
        : 'FAIL';
  const summary =
    input.summary ??
    (input.verdict === 'ACCEPTED'
      ? 'PM accepted outcome'
      : `PM decision: ${input.verdict}`);

  return createEvidenceInternal(dataRoot, project, {
    type: 'PM_DECISION',
    trustLevel,
    status,
    source: { kind: input.source?.kind ?? 'pm', ...input.source },
    summary,
    details,
    goalId: input.goalId,
    taskId: input.taskId,
    runId: input.runId ?? input.targetRunId,
    rawRef: input.rawRef,
    artifactRefs: input.artifactRefs,
    metadata: input.metadata,
    sourceEventId: input.sourceEventId,
  });
}

// ── legacy adapter.json compatibility (read-side only) ──────────────────────

/**
 * Read Run/evidence/adapter.json without rewriting.
 * Returns present=false when missing/malformed — never throws for absence.
 */
export function getLegacyAdapterEvidence(runFolder: string): LegacyAdapterEvidenceView {
  const folder = requireNonEmptyString(runFolder, 'runFolder');
  const evidencePath = path.join(folder, 'evidence', 'adapter.json');
  if (!fs.existsSync(evidencePath)) {
    return { present: false, folder };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as Record<string, unknown>;
    const adapter = raw.adapter && typeof raw.adapter === 'object' && !Array.isArray(raw.adapter)
      ? (raw.adapter as Record<string, unknown>)
      : undefined;
    const completion = raw.completion && typeof raw.completion === 'object' && !Array.isArray(raw.completion)
      ? (raw.completion as Record<string, unknown>)
      : undefined;
    const binding = raw.binding && typeof raw.binding === 'object' && !Array.isArray(raw.binding)
      ? (raw.binding as Record<string, unknown>)
      : undefined;
    return {
      present: true,
      folder,
      ...(typeof raw.dedupeKey === 'string' ? { dedupeKey: raw.dedupeKey } : {}),
      ...(typeof raw.capturedAt === 'string' ? { capturedAt: raw.capturedAt } : {}),
      ...(typeof adapter?.id === 'string' ? { adapterId: adapter.id } : {}),
      ...(typeof adapter?.agentName === 'string' ? { agentName: adapter.agentName } : {}),
      ...(typeof completion?.sessionId === 'string' ? { sessionId: completion.sessionId } : {}),
      ...(typeof binding?.reason === 'string' ? { bindingReason: binding.reason } : {}),
      raw,
    };
  } catch {
    return { present: false, folder };
  }
}

/**
 * Normalize legacy adapter.json into an EvidenceCreateInput-shaped view.
 * Does NOT write Evidence — callers may pass the result to createEvidence if desired.
 * Internal helper — not a public trust-spoofing route.
 */
export function normalizeLegacyAdapterEvidence(
  runFolder: string,
  opts?: { runId?: string; taskId?: string; goalId?: string; project?: string },
): EvidenceCreateInput | null {
  const legacy = getLegacyAdapterEvidence(runFolder);
  if (!legacy.present) return null;
  return {
    type: 'ADAPTER_OBSERVATION',
    trustLevel: 'OBSERVED',
    status: 'INFO',
    source: {
      kind: 'adapter',
      ...(legacy.adapterId ? { adapter: legacy.adapterId } : {}),
      ...(legacy.agentName ? { agent: legacy.agentName } : {}),
    },
    summary: legacy.sessionId
      ? `Legacy adapter capture observed (session ${legacy.sessionId})`
      : 'Legacy adapter capture observed',
    details: {
      legacy: true,
      dedupeKey: legacy.dedupeKey,
      capturedAt: legacy.capturedAt,
      bindingReason: legacy.bindingReason,
      sessionId: legacy.sessionId,
    },
    ...(opts?.runId ? { runId: opts.runId } : {}),
    ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    ...(opts?.goalId ? { goalId: opts.goalId } : {}),
    rawRef: path.join(runFolder, 'evidence', 'adapter.json'),
    ...(legacy.dedupeKey ? { sourceEventId: `legacy-adapter:${legacy.dedupeKey}` } : {}),
  };
}
