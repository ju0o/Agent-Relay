/**
 * Goal / Task data kernel (Phase B1 + architecture correction).
 *
 * Local-first filesystem SSOT under Project/_relay/{goals,tasks}/.
 * Physical Run storage unchanged. Logical runId is authoritative for linkage.
 * Task uses split executionState + pmState (schemaVersion=2). Progress is derived.
 *
 * Phase B2: runtime transitions live in goal-task-runtime.ts.
 *
 * Privileged/legacy: `updateTask` / `updateGoal` are narrative-field patches only.
 * They MUST NOT set runtime axes (executionState/pmState/acceptedRunId/Goal status).
 * Future MCP/Event Runtime must call explicit B2 commands, never raw task:update
 * for READY/DISPATCHED/RUNNING/RESULT_RECEIVED/ACCEPTED flows.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  GOAL_STATUSES,
  GOAL_TASK_SCHEMA_VERSION,
  GoalProgress,
  GoalRecord,
  GoalStatus,
  GoalUpdatePatch,
  LEGACY_TASK_STATUSES,
  LegacyTaskStatus,
  LinkedRunRef,
  PERMISSION_MODES,
  PermissionMode,
  PermissionPolicy,
  TASK_EXECUTION_STATES,
  TASK_PM_STATES,
  TaskExecutionState,
  TaskPmState,
  TaskRecord,
  TaskUpdatePatch,
  mapLegacyTaskStatus,
} from '../shared/types.js';
import { ensureRunId, projectDir, readRunMeta, writeRunMeta } from './fs.js';
import { validateTaskQaContractFields } from './qa-contract.js';

const GOAL_ID_RE = /^GOAL-(\d+)$/;
const TASK_ID_RE = /^TASK-(\d+)$/;

const ACTIVE_EXECUTION: ReadonlySet<TaskExecutionState> = new Set([
  'READY',
  'DISPATCHED',
  'RUNNING',
  'RESULT_RECEIVED',
]);

/** Module locks serialize concurrent ID allocation within one process. */
let _goalAllocLock: Promise<void> = Promise.resolve();
let _taskAllocLock: Promise<void> = Promise.resolve();

/** Per-task locks for atomic taskRunSequence allocation. */
const _linkLocks = new Map<string, Promise<void>>();

// ── paths ───────────────────────────────────────────────────────────────────

export function relayDir(dataRoot: string, project: string): string {
  return path.join(projectDir(dataRoot, project), '_relay');
}

export function goalsDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'goals');
}

export function tasksDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'tasks');
}

export function goalFolder(dataRoot: string, project: string, goalId: string): string {
  return path.join(goalsDir(dataRoot, project), goalId);
}

export function taskFolder(dataRoot: string, project: string, taskId: string): string {
  return path.join(tasksDir(dataRoot, project), taskId);
}

// ── atomic JSON write ───────────────────────────────────────────────────────

/** Write JSON via temp file + rename. Avoids leaving a truncated JSON on crash mid-write.
 *  Atomic: write complete tmp in same dir, then renameSync over destination.
 *  If rename fails, cleanup tmp and FAIL — never copyFileSync over live file.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup */ }
    throw err;
  }
}

/**
 * Synchronous ~50 ms sleep using Atomics.wait (avoids async in read path).
 * Used only by the parse-race retry below — not for general use.
 */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read and parse a JSON file.
 *
 * Parse-race guard (STAB-01 / STAB-02): on Windows, `renameSync` inside
 * `writeJsonAtomic` briefly exposes an empty/absent file to concurrent
 * readers. If `JSON.parse` fails we do ONE bounded retry after ~50 ms.
 *
 * Semantics:
 *   - File missing (ENOENT) on FIRST read → throws "파일을 찾을 수 없습니다"
 *     (NOT_FOUND). Never retried — NOT_FOUND must stay NOT_FOUND.
 *   - JSON.parse failure on first read → sleepSync(50 ms) then re-read.
 *     - If re-read succeeds and parses → return value.
 *     - Otherwise → throws "잘못된 JSON 형식입니다" (corrupt).
 */
function readJsonFile<T>(filePath: string): T {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    // File not found on first try — do NOT retry; preserve NOT_FOUND semantics.
    throw new Error(`파일을 찾을 수 없습니다: ${filePath}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Parse failure may be a transient renameSync race — one bounded retry.
    sleepSyncMs(50);
    let raw2: string;
    try {
      raw2 = fs.readFileSync(filePath, 'utf8');
    } catch {
      // File disappeared between retries; surface as corrupt (file WAS present).
      throw new Error(`잘못된 JSON 형식입니다: ${filePath}`);
    }
    try {
      return JSON.parse(raw2) as T;
    } catch {
      throw new Error(`잘못된 JSON 형식입니다: ${filePath}`);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function padId(prefix: 'GOAL' | 'TASK', n: number): string {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

function maxExistingId(dir: string, re: RegExp): number {
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    const m = re.exec(name);
    if (m) max = Math.max(max, parseInt(m[1]!, 10));
  }
  return max;
}

// ── monotonic counters for GOAL/TASK IDs ───────────────────────────────────

export function countersPath(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'counters.json');
}

export interface CountersRecord {
  nextGoalNumber: number;
  nextTaskNumber: number;
  /** Phase C Evidence counter — preserved by Goal/Task allocators. */
  nextEvidenceNumber?: number;
  /** Phase D Event counter — preserved by Goal/Task/Evidence allocators. */
  nextEventNumber?: number;
  /** Phase I3F-1 Memo counter — preserved by Goal/Task/Evidence/Event allocators. */
  nextNoteNumber?: number;
}

function loadCounters(dataRoot: string, project: string): CountersRecord {
  const p = countersPath(dataRoot, project);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    parsed = null;
  }
  const goalsMax = maxExistingId(goalsDir(dataRoot, project), GOAL_ID_RE);
  const tasksMax = maxExistingId(tasksDir(dataRoot, project), TASK_ID_RE);
  let nextGoal: number | undefined;
  let nextTask: number | undefined;
  let nextEvidence: number | undefined;
  let nextEvent: number | undefined;
  let nextNote: number | undefined;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.nextGoalNumber === 'number' && Number.isInteger(obj.nextGoalNumber) && obj.nextGoalNumber >= 1) {
      nextGoal = obj.nextGoalNumber;
    }
    if (typeof obj.nextTaskNumber === 'number' && Number.isInteger(obj.nextTaskNumber) && obj.nextTaskNumber >= 1) {
      nextTask = obj.nextTaskNumber;
    }
    if (typeof obj.nextEvidenceNumber === 'number' && Number.isInteger(obj.nextEvidenceNumber) && obj.nextEvidenceNumber >= 1) {
      nextEvidence = obj.nextEvidenceNumber;
    }
    if (typeof obj.nextEventNumber === 'number' && Number.isInteger(obj.nextEventNumber) && obj.nextEventNumber >= 1) {
      nextEvent = obj.nextEventNumber;
    }
    if (typeof obj.nextNoteNumber === 'number' && Number.isInteger(obj.nextNoteNumber) && obj.nextNoteNumber >= 1) {
      nextNote = obj.nextNoteNumber;
    }
  }
  if (nextGoal === undefined) nextGoal = goalsMax + 1;
  if (nextTask === undefined) nextTask = tasksMax + 1;
  // Ensure monotonic beyond filesystem max (manual folder, stale counter)
  nextGoal = Math.max(nextGoal, goalsMax + 1);
  nextTask = Math.max(nextTask, tasksMax + 1);
  const out: CountersRecord = { nextGoalNumber: nextGoal, nextTaskNumber: nextTask };
  if (nextEvidence !== undefined) out.nextEvidenceNumber = nextEvidence;
  if (nextEvent !== undefined) out.nextEventNumber = nextEvent;
  if (nextNote !== undefined) out.nextNoteNumber = nextNote;
  return out;
}

function allocateGoalIdWithCounter(dataRoot: string, project: string): string {
  // Caller must hold _goalAllocLock serialization; cross-process safety via mkdir EEXIST loop + merge.
  fs.mkdirSync(goalsDir(dataRoot, project), { recursive: true });
  let counters = loadCounters(dataRoot, project);
  let n = counters.nextGoalNumber;
  for (;;) {
    const id = padId('GOAL', n);
    const idDir = path.join(goalsDir(dataRoot, project), id);
    try {
      fs.mkdirSync(idDir);
      // Merge with latest counters to avoid clobbering concurrent Task/Evidence counter increments
      let latestTaskNext = counters.nextTaskNumber;
      let latestEvidenceNext = counters.nextEvidenceNumber;
      let latestEventNext = counters.nextEventNumber;
      let latestNoteNext = counters.nextNoteNumber;
      try {
        const latestRaw = JSON.parse(fs.readFileSync(countersPath(dataRoot, project), 'utf8')) as Record<string, unknown>;
        if (typeof latestRaw.nextTaskNumber === 'number' && Number.isInteger(latestRaw.nextTaskNumber) && latestRaw.nextTaskNumber >= 1) {
          latestTaskNext = Math.max(latestTaskNext, latestRaw.nextTaskNumber);
        }
        if (typeof latestRaw.nextEvidenceNumber === 'number' && Number.isInteger(latestRaw.nextEvidenceNumber) && latestRaw.nextEvidenceNumber >= 1) {
          latestEvidenceNext = latestEvidenceNext === undefined
            ? latestRaw.nextEvidenceNumber
            : Math.max(latestEvidenceNext, latestRaw.nextEvidenceNumber);
        }
        if (typeof latestRaw.nextEventNumber === 'number' && Number.isInteger(latestRaw.nextEventNumber) && latestRaw.nextEventNumber >= 1) {
          latestEventNext = latestEventNext === undefined
            ? latestRaw.nextEventNumber
            : Math.max(latestEventNext, latestRaw.nextEventNumber);
        }
        if (typeof latestRaw.nextNoteNumber === 'number' && Number.isInteger(latestRaw.nextNoteNumber) && latestRaw.nextNoteNumber >= 1) {
          latestNoteNext = latestNoteNext === undefined ? latestRaw.nextNoteNumber : Math.max(latestNoteNext, latestRaw.nextNoteNumber);
        }
      } catch { /* no latest file or malformed — keep ours */ }
      const nextCounters: CountersRecord = {
        nextGoalNumber: n + 1,
        nextTaskNumber: latestTaskNext,
      };
      if (latestEvidenceNext !== undefined) nextCounters.nextEvidenceNumber = latestEvidenceNext;
      if (latestEventNext !== undefined) nextCounters.nextEventNumber = latestEventNext;
      if (latestNoteNext !== undefined) nextCounters.nextNoteNumber = latestNoteNext;
      writeJsonAtomic(countersPath(dataRoot, project), nextCounters);
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

function allocateTaskIdWithCounter(dataRoot: string, project: string): string {
  fs.mkdirSync(tasksDir(dataRoot, project), { recursive: true });
  let counters = loadCounters(dataRoot, project);
  let n = counters.nextTaskNumber;
  for (;;) {
    const id = padId('TASK', n);
    const idDir = path.join(tasksDir(dataRoot, project), id);
    try {
      fs.mkdirSync(idDir);
      let latestGoalNext = counters.nextGoalNumber;
      let latestEvidenceNext = counters.nextEvidenceNumber;
      let latestEventNext = counters.nextEventNumber;
      let latestNoteNext = counters.nextNoteNumber;
      try {
        const latestRaw = JSON.parse(fs.readFileSync(countersPath(dataRoot, project), 'utf8')) as Record<string, unknown>;
        if (typeof latestRaw.nextGoalNumber === 'number' && Number.isInteger(latestRaw.nextGoalNumber) && latestRaw.nextGoalNumber >= 1) {
          latestGoalNext = Math.max(latestGoalNext, latestRaw.nextGoalNumber);
        }
        if (typeof latestRaw.nextEvidenceNumber === 'number' && Number.isInteger(latestRaw.nextEvidenceNumber) && latestRaw.nextEvidenceNumber >= 1) {
          latestEvidenceNext = latestEvidenceNext === undefined
            ? latestRaw.nextEvidenceNumber
            : Math.max(latestEvidenceNext, latestRaw.nextEvidenceNumber);
        }
        if (typeof latestRaw.nextEventNumber === 'number' && Number.isInteger(latestRaw.nextEventNumber) && latestRaw.nextEventNumber >= 1) {
          latestEventNext = latestEventNext === undefined
            ? latestRaw.nextEventNumber
            : Math.max(latestEventNext, latestRaw.nextEventNumber);
        }
        if (typeof latestRaw.nextNoteNumber === 'number' && Number.isInteger(latestRaw.nextNoteNumber) && latestRaw.nextNoteNumber >= 1) {
          latestNoteNext = latestNoteNext === undefined ? latestRaw.nextNoteNumber : Math.max(latestNoteNext, latestRaw.nextNoteNumber);
        }
      } catch { /* keep ours */ }
      const nextCounters: CountersRecord = {
        nextGoalNumber: latestGoalNext,
        nextTaskNumber: n + 1,
      };
      if (latestEvidenceNext !== undefined) nextCounters.nextEvidenceNumber = latestEvidenceNext;
      if (latestEventNext !== undefined) nextCounters.nextEventNumber = latestEventNext;
      if (latestNoteNext !== undefined) nextCounters.nextNoteNumber = latestNoteNext;
      writeJsonAtomic(countersPath(dataRoot, project), nextCounters);
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

/**
 * Per-task serialization for link/unlink and B2 runtime mutations.
 * Same lock key for all Task writers — no check-then-write outside this lock.
 */
export function withTaskLinkLock<T>(project: string, taskId: string, fn: () => T): Promise<T> {
  const key = `${project}::${taskId}`;
  const prev = _linkLocks.get(key) ?? Promise.resolve();
  const work = prev.then(() => fn());
  _linkLocks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

// ── validators ──────────────────────────────────────────────────────────────

export function isGoalStatus(v: unknown): v is GoalStatus {
  return typeof v === 'string' && (GOAL_STATUSES as readonly string[]).includes(v);
}

export function isTaskExecutionState(v: unknown): v is TaskExecutionState {
  return typeof v === 'string' && (TASK_EXECUTION_STATES as readonly string[]).includes(v);
}

export function isTaskPmState(v: unknown): v is TaskPmState {
  return typeof v === 'string' && (TASK_PM_STATES as readonly string[]).includes(v);
}

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

export function normalizePermissionPolicy(input: unknown): PermissionPolicy {
  if (input == null) return { mode: 'PLAN' };
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('permissionPolicy는 객체여야 합니다.');
  }
  const obj = input as Record<string, unknown>;
  if (!isPermissionMode(obj.mode)) {
    throw new Error(`알 수 없는 permissionPolicy.mode: ${String(obj.mode)}`);
  }
  const policy: PermissionPolicy = { mode: obj.mode };
  if (obj.overrides != null) {
    if (typeof obj.overrides !== 'object' || Array.isArray(obj.overrides)) {
      throw new Error('permissionPolicy.overrides는 객체여야 합니다.');
    }
    const raw = obj.overrides as Record<string, unknown>;
    const overrides: PermissionPolicy['overrides'] = {};
    const keys = [
      'dispatch', 'redispatch', 'createTask', 'runTests', 'mergeMain',
      'release', 'destructiveAction', 'productionDeploy', 'secretChange',
    ] as const;
    for (const k of keys) {
      if (raw[k] === undefined) continue;
      if (typeof raw[k] !== 'boolean') throw new Error(`permissionPolicy.overrides.${k}는 boolean이어야 합니다.`);
      overrides[k] = raw[k] as boolean;
    }
    if (Object.keys(overrides).length) policy.overrides = overrides;
  }
  return policy;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function normalizeCriteria(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('completionCriteria는 문자열 배열이어야 합니다.');
  return input.map((x, i) => {
    if (typeof x !== 'string') throw new Error(`completionCriteria[${i}]는 문자열이어야 합니다.`);
    return x;
  });
}

function normalizeTags(input: unknown): string[] | undefined {
  if (input == null) return undefined;
  if (!Array.isArray(input)) throw new Error('tags는 문자열 배열이어야 합니다.');
  return input.map((x, i) => {
    if (typeof x !== 'string') throw new Error(`tags[${i}]는 문자열이어야 합니다.`);
    return x;
  });
}

/**
 * Detect A→…→A cycles for proposed deps of selfTaskId within the given adjacency.
 */
export function wouldCreateDependencyCycle(
  selfTaskId: string,
  deps: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  const adj = new Map<string, readonly string[]>();
  for (const [k, v] of adjacency) adj.set(k, v);
  adj.set(selfTaskId, deps);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adj.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return dfs(selfTaskId);
}

export function normalizeDependencies(
  deps: unknown,
  selfTaskId: string | null,
  existingTaskIds: ReadonlySet<string>,
  opts?: {
    /** When set, every dependency must belong to this Goal (V1). */
    goalId?: string;
    /** taskId → goalId for cross-goal guard. */
    taskGoalById?: ReadonlyMap<string, string>;
    /** taskId → dependencies for cycle detection (same Goal graph). */
    adjacency?: ReadonlyMap<string, readonly string[]>;
  },
): string[] {
  if (deps == null) return [];
  if (!Array.isArray(deps)) throw new Error('dependencies는 Task ID 배열이어야 합니다.');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    if (typeof d !== 'string' || !d.trim()) {
      throw new Error('dependencies 항목은 비어 있지 않은 Task ID여야 합니다.');
    }
    const id = d.trim();
    if (selfTaskId && id === selfTaskId) {
      throw new Error('Task는 자기 자신을 의존할 수 없습니다.');
    }
    if (!TASK_ID_RE.test(id)) {
      throw new Error(`잘못된 Task ID 형식: ${id}`);
    }
    if (seen.has(id)) continue;
    if (!existingTaskIds.has(id)) {
      throw new Error(`의존 Task가 프로젝트에 없습니다: ${id}`);
    }
    if (opts?.goalId && opts.taskGoalById) {
      const depGoal = opts.taskGoalById.get(id);
      if (depGoal !== opts.goalId) {
        throw new Error(`V1에서 Task 의존성은 동일 Goal 안에서만 허용됩니다: ${id} (goal=${depGoal ?? '?'})`);
      }
    }
    seen.add(id);
    out.push(id);
  }
  if (selfTaskId && opts?.adjacency) {
    if (wouldCreateDependencyCycle(selfTaskId, out, opts.adjacency)) {
      throw new Error('Task 의존성 그래프에 순환이 있습니다.');
    }
  } else if (!selfTaskId && opts?.adjacency && out.length) {
    // createTask: self id not yet known — cycle among deps alone cannot include self yet;
    // post-alloc validation happens after id assignment when needed. Direct A→B→A needs self.
  }
  return out;
}

function buildTaskGraphMeta(dataRoot: string, project: string): {
  ids: Set<string>;
  taskGoalById: Map<string, string>;
  adjacency: Map<string, string[]>;
} {
  const ids = listTaskIds(dataRoot, project);
  const taskGoalById = new Map<string, string>();
  const adjacency = new Map<string, string[]>();
  for (const id of ids) {
    try {
      const t = getTask(dataRoot, project, id);
      taskGoalById.set(t.taskId, t.goalId);
      adjacency.set(t.taskId, [...t.dependencies]);
    } catch {
      // Malformed sibling — skip for graph meta (read isolation elsewhere)
    }
  }
  return { ids, taskGoalById, adjacency };
}

export function validateGoalRecord(g: GoalRecord): void {
  if (g.schemaVersion !== 1 && g.schemaVersion !== GOAL_TASK_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 Goal schemaVersion: ${g.schemaVersion}`);
  }
  if (!GOAL_ID_RE.test(g.goalId)) throw new Error(`잘못된 Goal ID: ${g.goalId}`);
  if (!g.project) throw new Error('Goal project가 필요합니다.');
  if (!g.title?.trim()) throw new Error('Goal title이 필요합니다.');
  if (!g.goalStatement?.trim()) throw new Error('Goal goalStatement가 필요합니다.');
  if (!isGoalStatus(g.status)) throw new Error(`알 수 없는 Goal status: ${String(g.status)}`);
  if (!Array.isArray(g.completionCriteria)) throw new Error('completionCriteria는 배열이어야 합니다.');
  normalizePermissionPolicy(g.permissionPolicy);
}

function validateLinkedRuns(links: LinkedRunRef[]): void {
  const runIds = new Set<string>();
  const seqs = new Set<number>();
  for (const r of links) {
    if (!r.runId || typeof r.runId !== 'string') throw new Error('linkedRuns.runId가 필요합니다.');
    if (!r.folder || typeof r.folder !== 'string') throw new Error('linkedRuns.folder가 필요합니다.');
    if (!Number.isInteger(r.taskRunSequence) || r.taskRunSequence < 1) {
      throw new Error('linkedRuns.taskRunSequence는 1 이상의 정수여야 합니다.');
    }
    if (runIds.has(r.runId)) throw new Error(`중복 runId 링크: ${r.runId}`);
    if (seqs.has(r.taskRunSequence)) throw new Error(`중복 taskRunSequence: ${r.taskRunSequence}`);
    runIds.add(r.runId);
    seqs.add(r.taskRunSequence);
  }
}

export function validateTaskRecord(t: TaskRecord): void {
  if (t.schemaVersion !== GOAL_TASK_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 Task schemaVersion: ${t.schemaVersion}`);
  }
  if (!TASK_ID_RE.test(t.taskId)) throw new Error(`잘못된 Task ID: ${t.taskId}`);
  if (!GOAL_ID_RE.test(t.goalId)) throw new Error(`잘못된 Goal ID: ${t.goalId}`);
  if (!t.project) throw new Error('Task project가 필요합니다.');
  if (!t.title?.trim()) throw new Error('Task title이 필요합니다.');
  if (!t.goal?.trim()) throw new Error('Task goal이 필요합니다.');
  if (typeof t.reason !== 'string') throw new Error('Task reason이 필요합니다.');
  if (typeof t.scope !== 'string') throw new Error('Task scope가 필요합니다.');
  if (!isTaskExecutionState(t.executionState)) {
    throw new Error(`알 수 없는 Task executionState: ${String(t.executionState)}`);
  }
  if (!isTaskPmState(t.pmState)) {
    throw new Error(`알 수 없는 Task pmState: ${String(t.pmState)}`);
  }
  if (!Array.isArray(t.completionCriteria)) throw new Error('completionCriteria는 배열이어야 합니다.');
  if (!Array.isArray(t.dependencies)) throw new Error('dependencies는 배열이어야 합니다.');
  if (!Array.isArray(t.linkedRuns)) throw new Error('linkedRuns는 배열이어야 합니다.');
  validateLinkedRuns(t.linkedRuns);
  if (typeof t.nextTaskRunSequence !== 'number' || !Number.isInteger(t.nextTaskRunSequence) || t.nextTaskRunSequence < 1) {
    throw new Error('nextTaskRunSequence는 1 이상의 정수여야 합니다.');
  }
  // nextTaskRunSequence must be beyond any existing sequence to guarantee monotonicity
  const maxSeq = t.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0);
  if (t.nextTaskRunSequence <= maxSeq) {
    throw new Error(`nextTaskRunSequence(${t.nextTaskRunSequence})는 max taskRunSequence(${maxSeq})보다 커야 합니다.`);
  }
  if (t.acceptedRunId !== undefined) {
    if (typeof t.acceptedRunId !== 'string' || !t.acceptedRunId) {
      throw new Error('acceptedRunId는 비어 있지 않은 문자열이어야 합니다.');
    }
    if (!t.linkedRuns.some((r) => r.runId === t.acceptedRunId)) {
      throw new Error('acceptedRunId는 linkedRuns에 포함된 runId여야 합니다.');
    }
  }
  // V1.6 QA Gate (§7): both-or-neither + full contract validation, enforced
  // on every persist/read (fail closed — a malformed persisted contract can
  // never load as a valid Task).
  validateTaskQaContractFields({
    scope: t.scope,
    acceptanceCriteria: t.acceptanceCriteria,
    qaContract: t.qaContract,
  });
}

// ── v1 → v2 Task migration ──────────────────────────────────────────────────

function isLegacyTaskStatus(v: unknown): v is LegacyTaskStatus {
  return typeof v === 'string' && (LEGACY_TASK_STATUSES as readonly string[]).includes(v);
}

function inferDateAgentFromFolder(folder: string): { date?: string; agent?: string } {
  const parts = folder.replace(/\\/g, '/').split('/');
  if (parts.length < 3) return {};
  const run = parts[parts.length - 1] ?? '';
  const agent = parts[parts.length - 2];
  const date = parts[parts.length - 3];
  if (!/^\d+$/.test(run)) return {};
  return {
    ...(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}),
    ...(agent ? { agent } : {}),
  };
}

function migrateLinkedRuns(raw: unknown, rawTaskId?: string): LinkedRunRef[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('linkedRuns는 배열이어야 합니다.');
  const out: LinkedRunRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('linkedRuns 항목이 잘못되었습니다.');
    const row = item as Record<string, unknown>;
    const folder = typeof row.folder === 'string' ? row.folder : '';
    if (!folder) throw new Error('linkedRuns.folder가 필요합니다.');
    let runId = typeof row.runId === 'string' && row.runId ? row.runId : '';
    const seq = typeof row.taskRunSequence === 'number' ? row.taskRunSequence : NaN;
    if (!Number.isInteger(seq) || seq < 1) throw new Error('linkedRuns.taskRunSequence가 잘못되었습니다.');
    if (!runId) {
      if (fs.existsSync(folder)) {
        runId = ensureRunId(folder);
      } else {
        // Dangling legacy link — synthesize stable recoverable ID, do not create folder
        const normalized = path.resolve(folder).replace(/\\/g, '/');
        const seed = `${normalized}|${String(rawTaskId ?? '')}|${String(seq)}`;
        const hash = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
        runId = `legacy-dangling:${hash}`;
      }
    }
    const inferred = inferDateAgentFromFolder(folder);
    const link: LinkedRunRef = {
      runId,
      folder: path.resolve(folder),
      taskRunSequence: seq,
      ...(typeof row.agent === 'string' ? { agent: row.agent } : inferred.agent ? { agent: inferred.agent } : {}),
      ...(typeof row.date === 'string' ? { date: row.date } : inferred.date ? { date: inferred.date } : {}),
    };
    out.push(link);
  }
  return out;
}

/** Normalize raw task.json (v1 or v2) into a validated TaskRecord. Does not rewrite disk. */
export function normalizeTaskRecord(raw: Record<string, unknown>): TaskRecord {
  const schemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  let executionState: TaskExecutionState;
  let pmState: TaskPmState;

  if (schemaVersion === GOAL_TASK_SCHEMA_VERSION) {
    if (!isTaskExecutionState(raw.executionState)) {
      throw new Error(`알 수 없는 Task executionState: ${String(raw.executionState)}`);
    }
    if (!isTaskPmState(raw.pmState)) {
      throw new Error(`알 수 없는 Task pmState: ${String(raw.pmState)}`);
    }
    executionState = raw.executionState;
    pmState = raw.pmState;
  } else if (schemaVersion === 1 || (schemaVersion === 0 && isLegacyTaskStatus(raw.status))) {
    if (!isLegacyTaskStatus(raw.status)) {
      throw new Error(`알 수 없는 legacy Task status: ${String(raw.status)}`);
    }
    const mapped = mapLegacyTaskStatus(raw.status);
    executionState = mapped.executionState;
    pmState = mapped.pmState;
  } else {
    throw new Error(`지원하지 않는 Task schemaVersion: ${schemaVersion}`);
  }

  const rawTaskIdStr = typeof raw.taskId === 'string' ? raw.taskId : '';
  const linkedRuns = migrateLinkedRuns(raw.linkedRuns, rawTaskIdStr);
  // Derive nextTaskRunSequence: explicit if present and valid, else max+1 (legacy)
  let nextTaskRunSequence: number;
  if (typeof raw.nextTaskRunSequence === 'number' && Number.isInteger(raw.nextTaskRunSequence) && raw.nextTaskRunSequence >= 1) {
    nextTaskRunSequence = raw.nextTaskRunSequence;
    // Ensure monotonic beyond current links (handles legacy files where counter lags)
    const maxSeq = linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0);
    if (nextTaskRunSequence <= maxSeq) nextTaskRunSequence = maxSeq + 1;
  } else {
    nextTaskRunSequence = linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0) + 1;
  }
  const record: TaskRecord = {
    schemaVersion: GOAL_TASK_SCHEMA_VERSION,
    taskId: String(raw.taskId ?? ''),
    goalId: String(raw.goalId ?? ''),
    project: String(raw.project ?? ''),
    title: String(raw.title ?? ''),
    goal: String(raw.goal ?? ''),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    scope: typeof raw.scope === 'string' ? raw.scope : '',
    completionCriteria: Array.isArray(raw.completionCriteria)
      ? raw.completionCriteria.filter((x): x is string => typeof x === 'string')
      : [],
    executionState,
    pmState,
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.filter((x): x is string => typeof x === 'string')
      : [],
    linkedRuns,
    nextTaskRunSequence,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
  if (typeof raw.acceptedRunId === 'string' && raw.acceptedRunId) {
    record.acceptedRunId = raw.acceptedRunId;
  }
  if (typeof raw.blockedReason === 'string' && raw.blockedReason) {
    record.blockedReason = raw.blockedReason;
  }
  if (typeof raw.blockedAt === 'string' && raw.blockedAt) {
    record.blockedAt = raw.blockedAt;
  }
  if (typeof raw.lastTransitionReason === 'string' && raw.lastTransitionReason) {
    record.lastTransitionReason = raw.lastTransitionReason;
  }
  if (typeof raw.retryCount === 'number' && Number.isInteger(raw.retryCount) && raw.retryCount >= 0) {
    record.retryCount = raw.retryCount;
  }
  // V1.6 QA Gate (§7): carry the frozen contract through normalization in
  // validated-normalized form (fail closed on a hand-corrupted task.json —
  // validateTaskRecord below re-checks, so a malformed contract can never
  // load as valid).
  if (raw.acceptanceCriteria !== undefined || raw.qaContract !== undefined) {
    const validated = validateTaskQaContractFields({
      scope: record.scope,
      acceptanceCriteria: raw.acceptanceCriteria,
      qaContract: raw.qaContract,
    });
    if (validated) {
      record.acceptanceCriteria = validated.acceptanceCriteria;
      record.qaContract = validated.qaContract;
    }
  }
  validateTaskRecord(record);
  return record;
}

function loadTaskRecord(file: string): TaskRecord {
  const raw = readJsonFile<Record<string, unknown>>(file);
  return normalizeTaskRecord(raw);
}

// ── markdown mirrors ────────────────────────────────────────────────────────

export function renderGoalMarkdown(g: GoalRecord): string {
  const criteria = g.completionCriteria.length
    ? g.completionCriteria.map((c) => `- [ ] ${c}`).join('\n')
    : '- [ ] (none)';
  const lines = [
    `# ${g.goalId} — ${g.title}`,
    '',
    '## Goal',
    '',
    g.goalStatement,
    '',
  ];
  if (g.description?.trim()) {
    lines.push('## Description', '', g.description.trim(), '');
  }
  lines.push('## Completion Criteria', '', criteria, '', '## Status', '', g.status, '');
  if (g.tags?.length) {
    lines.push('## Tags', '', g.tags.map((t) => `- ${t}`).join('\n'), '');
  }
  lines.push(
    '## Permission Policy',
    '',
    `mode: ${g.permissionPolicy.mode}`,
    '',
    `createdAt: ${g.createdAt}`,
    `updatedAt: ${g.updatedAt}`,
    '',
  );
  return lines.join('\n');
}

export function renderTaskMarkdown(t: TaskRecord): string {
  const criteria = t.completionCriteria.length
    ? t.completionCriteria.map((c) => `- [ ] ${c}`).join('\n')
    : '- [ ] (none)';
  const deps = t.dependencies.length
    ? t.dependencies.map((d) => `- ${d}`).join('\n')
    : '- (none)';
  const runs = t.linkedRuns.length
    ? t.linkedRuns
      .slice()
      .sort((a, b) => a.taskRunSequence - b.taskRunSequence)
      .map((r) => `- #${r.taskRunSequence}: ${r.runId} @ ${r.folder}`)
      .join('\n')
    : '- (none)';
  return [
    `# ${t.taskId} — ${t.title}`,
    '',
    '## Goal',
    '',
    t.goal,
    '',
    '## Reason',
    '',
    t.reason || '(none)',
    '',
    '## Scope',
    '',
    t.scope || '(none)',
    '',
    '## Completion Criteria',
    '',
    criteria,
    '',
    '## Execution State',
    '',
    t.executionState,
    '',
    '## PM State',
    '',
    t.pmState,
    '',
    '## Accepted Run',
    '',
    t.acceptedRunId ?? '(none)',
    '',
    '## Dependencies',
    '',
    deps,
    '',
    '## Linked Runs',
    '',
    runs,
    '',
    '## Blocker',
    '',
    t.blockedReason
      ? `${t.blockedReason}${t.blockedAt ? ` @ ${t.blockedAt}` : ''}`
      : '(none)',
    '',
    `goalId: ${t.goalId}`,
    `createdAt: ${t.createdAt}`,
    `updatedAt: ${t.updatedAt}`,
    '',
  ].join('\n');
}

function persistGoalFiles(folder: string, record: GoalRecord): void {
  writeJsonAtomic(path.join(folder, 'goal.json'), record);
  try {
    fs.writeFileSync(path.join(folder, 'goal.md'), renderGoalMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Goal JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

function persistTaskFiles(folder: string, record: TaskRecord): void {
  writeJsonAtomic(path.join(folder, 'task.json'), record);
  try {
    fs.writeFileSync(path.join(folder, 'task.md'), renderTaskMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Task JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

/** Persist a validated Goal record (B2 runtime). */
export function persistGoalRecord(dataRoot: string, project: string, record: GoalRecord): GoalRecord {
  validateGoalRecord(record);
  persistGoalFiles(goalFolder(dataRoot, project, record.goalId), record);
  return record;
}

/** Persist a validated Task record (B2 runtime). */
export function persistTaskRecord(dataRoot: string, project: string, record: TaskRecord): TaskRecord {
  validateTaskRecord(record);
  persistTaskFiles(taskFolder(dataRoot, project, record.taskId), record);
  return record;
}

// ── Goal CRUD ───────────────────────────────────────────────────────────────

export interface GoalCreateInput {
  title: string;
  goalStatement: string;
  description?: string;
  tags?: string[];
  completionCriteria?: string[];
  permissionPolicy?: unknown;
  status?: unknown;
}

export function createGoal(
  dataRoot: string,
  project: string,
  input: GoalCreateInput,
): Promise<GoalRecord> {
  const title = requireNonEmptyString(input.title, 'title');
  const goalStatement = requireNonEmptyString(input.goalStatement, 'goalStatement');
  const status: GoalStatus = input.status == null
    ? 'PLANNING'
    : (isGoalStatus(input.status) ? input.status : (() => { throw new Error(`알 수 없는 Goal status: ${String(input.status)}`); })());
  const completionCriteria = normalizeCriteria(input.completionCriteria);
  const tags = normalizeTags(input.tags);
  const permissionPolicy = normalizePermissionPolicy(input.permissionPolicy);
  const description = typeof input.description === 'string' ? input.description : undefined;

  const work = _goalAllocLock.then((): GoalRecord => {
    const goalId = allocateGoalIdWithCounter(dataRoot, project);
    const ts = nowIso();
    const record: GoalRecord = {
      schemaVersion: GOAL_TASK_SCHEMA_VERSION,
      goalId,
      project,
      title,
      goalStatement,
      status,
      completionCriteria,
      permissionPolicy,
      createdAt: ts,
      updatedAt: ts,
      ...(description !== undefined ? { description } : {}),
      ...(tags !== undefined ? { tags } : {}),
    };
    validateGoalRecord(record);
    persistGoalFiles(goalFolder(dataRoot, project, goalId), record);
    return record;
  });
  _goalAllocLock = work.then(() => undefined, () => undefined);
  return work;
}

export function getGoal(dataRoot: string, project: string, goalId: string): GoalRecord {
  const id = requireNonEmptyString(goalId, 'goalId');
  if (!GOAL_ID_RE.test(id)) throw new Error(`잘못된 Goal ID: ${id}`);
  const file = path.join(goalFolder(dataRoot, project, id), 'goal.json');
  const record = readJsonFile<GoalRecord>(file);
  validateGoalRecord(record);
  return record;
}

export interface ListGoalsResult {
  goals: GoalRecord[];
  warnings: string[];
}

export function listGoalsWithDiagnostics(dataRoot: string, project: string): ListGoalsResult {
  const dir = goalsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return { goals: [], warnings: [] };
  const out: GoalRecord[] = [];
  const warnings: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!GOAL_ID_RE.test(name)) continue;
    const file = path.join(dir, name, 'goal.json');
    if (!fs.existsSync(file)) continue;
    try {
      const record = readJsonFile<GoalRecord>(file);
      validateGoalRecord(record);
      out.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Goal ${name} 읽기 실패: ${msg}`);
    }
  }
  out.sort((a, b) => a.goalId.localeCompare(b.goalId));
  return { goals: out, warnings };
}

export function listGoals(dataRoot: string, project: string): GoalRecord[] {
  return listGoalsWithDiagnostics(dataRoot, project).goals;
}

export function getGoalsDiagnostics(dataRoot: string, project: string): string[] {
  return listGoalsWithDiagnostics(dataRoot, project).warnings;
}

export function updateGoal(
  dataRoot: string,
  project: string,
  goalId: string,
  patch: GoalUpdatePatch,
): GoalRecord {
  if (patch.status !== undefined) {
    throw new Error('Goal status는 goal:transition / goal:complete를 통해 변경해야 합니다.');
  }
  const existing = getGoal(dataRoot, project, goalId);
  if (patch.title !== undefined) existing.title = requireNonEmptyString(patch.title, 'title');
  if (patch.goalStatement !== undefined) existing.goalStatement = requireNonEmptyString(patch.goalStatement, 'goalStatement');
  if (patch.completionCriteria !== undefined) existing.completionCriteria = normalizeCriteria(patch.completionCriteria);
  if (patch.permissionPolicy !== undefined) existing.permissionPolicy = normalizePermissionPolicy(patch.permissionPolicy);
  if (patch.description !== undefined) existing.description = patch.description;
  if (patch.tags !== undefined) existing.tags = normalizeTags(patch.tags);
  existing.schemaVersion = GOAL_TASK_SCHEMA_VERSION;
  existing.updatedAt = nowIso();
  validateGoalRecord(existing);
  persistGoalFiles(goalFolder(dataRoot, project, existing.goalId), existing);
  return existing;
}

// ── Task CRUD ───────────────────────────────────────────────────────────────

export interface TaskCreateInput {
  goalId: string;
  title: string;
  goal: string;
  reason: string;
  scope: string;
  completionCriteria?: string[];
  dependencies?: string[];
  executionState?: unknown;
  pmState?: unknown;
  /**
   * V1.6 QA Gate contract (§7) — both-or-neither, frozen at creation.
   * Validated fail-closed here; absent = no QA Gate for this Task.
   */
  acceptanceCriteria?: unknown;
  qaContract?: unknown;
}

function listTaskIds(dataRoot: string, project: string): Set<string> {
  const dir = tasksDir(dataRoot, project);
  const ids = new Set<string>();
  if (!fs.existsSync(dir)) return ids;
  for (const name of fs.readdirSync(dir)) {
    if (TASK_ID_RE.test(name)) ids.add(name);
  }
  return ids;
}

export function createTask(
  dataRoot: string,
  project: string,
  input: TaskCreateInput,
): Promise<TaskRecord> {
  const goalId = requireNonEmptyString(input.goalId, 'goalId');
  getGoal(dataRoot, project, goalId);

  const title = requireNonEmptyString(input.title, 'title');
  const goal = requireNonEmptyString(input.goal, 'goal');
  if (typeof input.reason !== 'string') throw new Error('reason이 필요합니다.');
  if (typeof input.scope !== 'string') throw new Error('scope가 필요합니다.');

  const executionState: TaskExecutionState = input.executionState == null
    ? 'PLANNED'
    : (isTaskExecutionState(input.executionState)
      ? input.executionState
      : (() => { throw new Error(`알 수 없는 Task executionState: ${String(input.executionState)}`); })());
  const pmState: TaskPmState = input.pmState == null
    ? 'PENDING'
    : (isTaskPmState(input.pmState)
      ? input.pmState
      : (() => { throw new Error(`알 수 없는 Task pmState: ${String(input.pmState)}`); })());

  const completionCriteria = normalizeCriteria(input.completionCriteria);
  // V1.6 QA Gate (§7): validate the frozen contract at creation, fail closed.
  const validatedQa = validateTaskQaContractFields({
    scope: input.scope,
    acceptanceCriteria: input.acceptanceCriteria,
    qaContract: input.qaContract,
  });
  const graph = buildTaskGraphMeta(dataRoot, project);
  const dependencies = normalizeDependencies(input.dependencies, null, graph.ids, {
    goalId,
    taskGoalById: graph.taskGoalById,
    adjacency: graph.adjacency,
  });

  const work = _taskAllocLock.then((): TaskRecord => {
    const taskId = allocateTaskIdWithCounter(dataRoot, project);
    // Re-validate with concrete self id for cycle detection (A→B→A via existing edges).
    const depsFinal = normalizeDependencies(dependencies, taskId, new Set([...graph.ids, taskId]), {
      goalId,
      taskGoalById: graph.taskGoalById,
      adjacency: graph.adjacency,
    });
    const ts = nowIso();
    const record: TaskRecord = {
      schemaVersion: GOAL_TASK_SCHEMA_VERSION,
      taskId,
      goalId,
      project,
      title,
      goal,
      reason: input.reason,
      scope: input.scope,
      completionCriteria,
      executionState,
      pmState,
      dependencies: depsFinal,
      linkedRuns: [],
      nextTaskRunSequence: 1,
      createdAt: ts,
      updatedAt: ts,
      // V1.6 QA Gate (§7): frozen at creation, stored in validated form.
      ...(validatedQa ? { acceptanceCriteria: validatedQa.acceptanceCriteria, qaContract: validatedQa.qaContract } : {}),
    };
    validateTaskRecord(record);
    persistTaskFiles(taskFolder(dataRoot, project, taskId), record);
    return record;
  });
  _taskAllocLock = work.then(() => undefined, () => undefined);
  return work;
}

export function getTask(dataRoot: string, project: string, taskId: string): TaskRecord {
  const id = requireNonEmptyString(taskId, 'taskId');
  if (!TASK_ID_RE.test(id)) throw new Error(`잘못된 Task ID: ${id}`);
  const file = path.join(taskFolder(dataRoot, project, id), 'task.json');
  return loadTaskRecord(file);
}

export interface ListTasksResult {
  tasks: TaskRecord[];
  warnings: string[];
}

export function listTasksWithDiagnostics(dataRoot: string, project: string, goalId?: string): ListTasksResult {
  const dir = tasksDir(dataRoot, project);
  if (!fs.existsSync(dir)) return { tasks: [], warnings: [] };
  const filterGoal = goalId ? requireNonEmptyString(goalId, 'goalId') : null;
  if (filterGoal && !GOAL_ID_RE.test(filterGoal)) throw new Error(`잘못된 Goal ID: ${filterGoal}`);
  const out: TaskRecord[] = [];
  const warnings: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!TASK_ID_RE.test(name)) continue;
    const file = path.join(dir, name, 'task.json');
    if (!fs.existsSync(file)) continue;
    try {
      const record = loadTaskRecord(file);
      if (filterGoal && record.goalId !== filterGoal) continue;
      out.push(record);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Task ${name} 읽기 실패: ${msg}`);
    }
  }
  out.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { tasks: out, warnings };
}

export function listTasks(dataRoot: string, project: string, goalId?: string): TaskRecord[] {
  return listTasksWithDiagnostics(dataRoot, project, goalId).tasks;
}

export function getTasksDiagnostics(dataRoot: string, project: string, goalId?: string): string[] {
  return listTasksWithDiagnostics(dataRoot, project, goalId).warnings;
}

export function updateTask(
  dataRoot: string,
  project: string,
  taskId: string,
  patch: TaskUpdatePatch,
): TaskRecord {
  if (patch.executionState !== undefined) {
    throw new Error('executionState는 task:transitionExecution / markResultReceived를 통해 변경해야 합니다.');
  }
  if (patch.pmState !== undefined) {
    throw new Error('pmState는 task:transitionPm / acceptResult / requestChanges를 통해 변경해야 합니다.');
  }
  if (patch.acceptedRunId !== undefined || patch.clearAcceptedRunId) {
    throw new Error('acceptedRunId는 task:acceptResult / transitionPm(재개방)을 통해 변경해야 합니다.');
  }
  // V1.6 QA Gate (§7): the QA contract is frozen at Task creation — never
  // mutable via task:update (the typed TaskUpdatePatch already excludes
  // these keys; this rejects untyped/JS callers too, fail closed).
  if (
    (patch as Record<string, unknown>).acceptanceCriteria !== undefined
    || (patch as Record<string, unknown>).qaContract !== undefined
  ) {
    throw new Error('acceptanceCriteria/qaContract는 Task 생성 시 고정되며 task:update로 변경할 수 없습니다.');
  }

  const existing = getTask(dataRoot, project, taskId);
  if (patch.title !== undefined) existing.title = requireNonEmptyString(patch.title, 'title');
  if (patch.goal !== undefined) existing.goal = requireNonEmptyString(patch.goal, 'goal');
  if (patch.reason !== undefined) {
    if (typeof patch.reason !== 'string') throw new Error('reason이 필요합니다.');
    existing.reason = patch.reason;
  }
  if (patch.scope !== undefined) {
    if (typeof patch.scope !== 'string') throw new Error('scope가 필요합니다.');
    existing.scope = patch.scope;
  }
  if (patch.completionCriteria !== undefined) {
    existing.completionCriteria = normalizeCriteria(patch.completionCriteria);
  }
  if (patch.dependencies !== undefined) {
    const graph = buildTaskGraphMeta(dataRoot, project);
    existing.dependencies = normalizeDependencies(patch.dependencies, existing.taskId, graph.ids, {
      goalId: existing.goalId,
      taskGoalById: graph.taskGoalById,
      adjacency: graph.adjacency,
    });
  }
  existing.schemaVersion = GOAL_TASK_SCHEMA_VERSION;
  existing.updatedAt = nowIso();
  validateTaskRecord(existing);
  persistTaskFiles(taskFolder(dataRoot, project, existing.taskId), existing);
  return existing;
}

// ── Run linkage (runId authoritative) ───────────────────────────────────────

function normPath(p: string): string {
  return path.resolve(p);
}

function findTaskOwningRunId(dataRoot: string, project: string, runId: string): TaskRecord | null {
  for (const t of listTasks(dataRoot, project)) {
    if (t.linkedRuns.some((r) => r.runId === runId)) return t;
  }
  return null;
}

/** Locate the Task that owns a logical runId (if any). */
export function findTaskByRunId(
  dataRoot: string,
  project: string,
  runId: string,
): TaskRecord | null {
  return findTaskOwningRunId(dataRoot, project, runId);
}

export function linkRunToTask(
  dataRoot: string,
  project: string,
  taskId: string,
  runFolder: string,
): Promise<TaskRecord> {
  const folder = requireNonEmptyString(runFolder, 'runFolder');
  const id = requireNonEmptyString(taskId, 'taskId');

  return withTaskLinkLock(project, id, () => {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error(`Run 폴더가 없습니다: ${folder}`);
    }
    const task = getTask(dataRoot, project, id);
    getGoal(dataRoot, project, task.goalId);

    const resolved = normPath(folder);
    const runId = ensureRunId(folder);
    const meta = readRunMeta(folder);

    // Immutable: never change an existing runId
    if (meta.runId && meta.runId !== runId) {
      throw new Error('Run meta runId 불일치 — runId는 변경할 수 없습니다.');
    }

    if (task.linkedRuns.some((r) => r.runId === runId)) {
      throw new Error('이 Run은 이미 해당 Task에 연결되어 있습니다.');
    }
    if (task.linkedRuns.some((r) => normPath(r.folder) === resolved && r.runId !== runId)) {
      throw new Error('동일 폴더가 다른 runId로 이미 연결되어 있습니다.');
    }

    const owner = findTaskOwningRunId(dataRoot, project, runId);
    if (owner && owner.taskId !== task.taskId) {
      throw new Error(`Run은 이미 다른 Task(${owner.taskId})에 연결되어 있습니다.`);
    }
    if (meta.taskId && meta.taskId !== task.taskId) {
      throw new Error(`Run meta가 이미 다른 Task(${meta.taskId})를 가리킵니다.`);
    }

    // Monotonic sequence: consume only after all precondition checks pass
    // Ensure nextTaskRunSequence exists (legacy migration fallback)
    if (typeof task.nextTaskRunSequence !== 'number' || !Number.isInteger(task.nextTaskRunSequence) || task.nextTaskRunSequence < 1) {
      task.nextTaskRunSequence = task.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0) + 1;
    }
    // Ensure counter is beyond any existing max (defensive)
    const maxExisting = task.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0);
    if (task.nextTaskRunSequence <= maxExisting) {
      task.nextTaskRunSequence = maxExisting + 1;
    }
    const nextSeq = task.nextTaskRunSequence;
    const inferred = inferDateAgentFromFolder(resolved);
    const link: LinkedRunRef = {
      runId,
      folder: resolved,
      taskRunSequence: nextSeq,
      ...inferred,
    };

    task.linkedRuns = [...task.linkedRuns, link];
    task.nextTaskRunSequence = nextSeq + 1;
    task.updatedAt = nowIso();
    validateTaskRecord(task);
    persistTaskFiles(taskFolder(dataRoot, project, task.taskId), task);

    writeRunMeta(folder, {
      ...meta,
      runId,
      goalId: task.goalId,
      taskId: task.taskId,
      taskRunSequence: nextSeq,
    });

    // Consistency check: both directions agree
    const back = readRunMeta(folder);
    if (back.runId !== runId || back.taskId !== task.taskId || back.goalId !== task.goalId || back.taskRunSequence !== nextSeq) {
      throw new Error('Task→Run / Run→Task 백링크 불일치');
    }

    return task;
  });
}

export function unlinkRunFromTask(
  dataRoot: string,
  project: string,
  taskId: string,
  runFolder: string,
): Promise<TaskRecord> {
  const folder = requireNonEmptyString(runFolder, 'runFolder');
  const id = requireNonEmptyString(taskId, 'taskId');

  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    const resolved = normPath(folder);
    let runId: string | undefined;
    try {
      runId = readRunMeta(folder).runId;
    } catch { /* folder may be gone */ }

    const before = task.linkedRuns.length;
    task.linkedRuns = task.linkedRuns.filter((r) => {
      const matchFolder = normPath(r.folder) === resolved;
      const matchId = runId ? r.runId === runId : false;
      return !(matchFolder || matchId);
    });
    if (task.linkedRuns.length === before) {
      throw new Error('해당 Run은 이 Task에 연결되어 있지 않습니다.');
    }

    // Drop acceptedRunId if it pointed at the unlinked run
    if (task.acceptedRunId && !task.linkedRuns.some((r) => r.runId === task.acceptedRunId)) {
      delete task.acceptedRunId;
    }

    task.updatedAt = nowIso();
    validateTaskRecord(task);
    persistTaskFiles(taskFolder(dataRoot, project, task.taskId), task);

    if (fs.existsSync(folder)) {
      const meta = readRunMeta(folder);
      if (!meta.taskId || meta.taskId === task.taskId) {
        writeRunMeta(folder, {
          tags: meta.tags,
          ...(meta.runId ? { runId: meta.runId } : {}),
        });
      }
    }

    return task;
  });
}

/**
 * Narrow helper: unlink exactly one linked Run by runId (Phase G pre-commit rollback).
 * Does not delete the Run folder — caller decides deletion.
 */
export function unlinkRunFromTaskByRunId(
  dataRoot: string,
  project: string,
  taskId: string,
  runId: string,
): Promise<TaskRecord> {
  const id = requireNonEmptyString(taskId, 'taskId');
  const rid = requireNonEmptyString(runId, 'runId');
  return withTaskLinkLock(project, id, () => {
    const task = getTask(dataRoot, project, id);
    const link = task.linkedRuns.find((r) => r.runId === rid);
    if (!link) {
      throw new Error('해당 Run은 이 Task에 연결되어 있지 않습니다.');
    }
    const folder = link.folder;
    task.linkedRuns = task.linkedRuns.filter((r) => r.runId !== rid);
    if (task.acceptedRunId && !task.linkedRuns.some((r) => r.runId === task.acceptedRunId)) {
      delete task.acceptedRunId;
    }
    task.updatedAt = nowIso();
    validateTaskRecord(task);
    persistTaskFiles(taskFolder(dataRoot, project, task.taskId), task);
    if (fs.existsSync(folder)) {
      try {
        const meta = readRunMeta(folder);
        if (!meta.taskId || meta.taskId === task.taskId) {
          writeRunMeta(folder, {
            tags: meta.tags,
            ...(meta.runId ? { runId: meta.runId } : {}),
          });
        }
      } catch { /* folder may be incomplete during rollback */ }
    }
    return task;
  });
}

// ── Progress (derived) ──────────────────────────────────────────────────────

/**
 * Pure Goal progress derivation from split Task states.
 *
 * Semantics:
 * - doneTasks: pmState === ACCEPTED only
 * - blockedTasks: executionState === BLOCKED
 * - activeTasks: READY|DISPATCHED|RUNNING|RESULT_RECEIVED and not ACCEPTED
 * - CANCELLED / FAILED / PLANNED are counted in total only (not success)
 */
export function deriveGoalProgress(goalId: string, tasks: readonly TaskRecord[]): GoalProgress {
  const scoped = tasks.filter((t) => t.goalId === goalId);
  let doneTasks = 0;
  let activeTasks = 0;
  let blockedTasks = 0;
  for (const t of scoped) {
    if (t.pmState === 'ACCEPTED') doneTasks += 1;
    else if (t.executionState === 'BLOCKED') blockedTasks += 1;
    else if (ACTIVE_EXECUTION.has(t.executionState)) activeTasks += 1;
  }
  const totalTasks = scoped.length;
  return {
    goalId,
    totalTasks,
    doneTasks,
    activeTasks,
    blockedTasks,
    weightedProgress: totalTasks === 0 ? 0 : doneTasks / totalTasks,
  };
}

export function getGoalProgress(dataRoot: string, project: string, goalId: string): GoalProgress {
  const id = requireNonEmptyString(goalId, 'goalId');
  getGoal(dataRoot, project, id);
  return deriveGoalProgress(id, listTasks(dataRoot, project, id));
}
