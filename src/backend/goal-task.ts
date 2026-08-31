/**
 * Goal / Task data kernel (Phase B1 + architecture correction).
 *
 * Local-first filesystem SSOT under Project/_relay/{goals,tasks}/.
 * Physical Run storage unchanged. Logical runId is authoritative for linkage.
 * Task uses split executionState + pmState (schemaVersion=2). Progress is derived.
 */
import * as fs from 'fs';
import * as path from 'path';
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

/** Write JSON via temp file + rename. Avoids leaving a truncated JSON on crash mid-write. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, filePath);
    } catch {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup */ }
    throw err;
  }
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

function allocateExclusiveId(dir: string, prefix: 'GOAL' | 'TASK', re: RegExp): string {
  fs.mkdirSync(dir, { recursive: true });
  let n = maxExistingId(dir, re) + 1;
  for (;;) {
    const id = padId(prefix, n);
    const idDir = path.join(dir, id);
    try {
      fs.mkdirSync(idDir);
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

function withTaskLinkLock<T>(project: string, taskId: string, fn: () => T): Promise<T> {
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

export function normalizeDependencies(
  deps: unknown,
  selfTaskId: string | null,
  existingTaskIds: ReadonlySet<string>,
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
    seen.add(id);
    out.push(id);
  }
  return out;
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
  if (t.acceptedRunId !== undefined) {
    if (typeof t.acceptedRunId !== 'string' || !t.acceptedRunId) {
      throw new Error('acceptedRunId는 비어 있지 않은 문자열이어야 합니다.');
    }
    if (!t.linkedRuns.some((r) => r.runId === t.acceptedRunId)) {
      throw new Error('acceptedRunId는 linkedRuns에 포함된 runId여야 합니다.');
    }
  }
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

function migrateLinkedRuns(raw: unknown): LinkedRunRef[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error('linkedRuns는 배열이어야 합니다.');
  const out: LinkedRunRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('linkedRuns 항목이 잘못되었습니다.');
    const row = item as Record<string, unknown>;
    const folder = typeof row.folder === 'string' ? row.folder : '';
    if (!folder) throw new Error('linkedRuns.folder가 필요합니다.');
    let runId = typeof row.runId === 'string' && row.runId ? row.runId : '';
    if (!runId) {
      if (fs.existsSync(folder)) runId = ensureRunId(folder);
      else throw new Error(`legacy linked Run에 runId가 없고 폴더도 없습니다: ${folder}`);
    }
    const seq = typeof row.taskRunSequence === 'number' ? row.taskRunSequence : NaN;
    if (!Number.isInteger(seq) || seq < 1) throw new Error('linkedRuns.taskRunSequence가 잘못되었습니다.');
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

  const linkedRuns = migrateLinkedRuns(raw.linkedRuns);
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
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
  if (typeof raw.acceptedRunId === 'string' && raw.acceptedRunId) {
    record.acceptedRunId = raw.acceptedRunId;
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
    const dir = goalsDir(dataRoot, project);
    const goalId = allocateExclusiveId(dir, 'GOAL', GOAL_ID_RE);
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

export function listGoals(dataRoot: string, project: string): GoalRecord[] {
  const dir = goalsDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const out: GoalRecord[] = [];
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
      throw new Error(`Goal ${name} 읽기 실패: ${msg}`);
    }
  }
  return out.sort((a, b) => a.goalId.localeCompare(b.goalId));
}

export function updateGoal(
  dataRoot: string,
  project: string,
  goalId: string,
  patch: GoalUpdatePatch,
): GoalRecord {
  const existing = getGoal(dataRoot, project, goalId);
  if (patch.title !== undefined) existing.title = requireNonEmptyString(patch.title, 'title');
  if (patch.goalStatement !== undefined) existing.goalStatement = requireNonEmptyString(patch.goalStatement, 'goalStatement');
  if (patch.status !== undefined) {
    if (!isGoalStatus(patch.status)) throw new Error(`알 수 없는 Goal status: ${String(patch.status)}`);
    existing.status = patch.status;
  }
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
  const existingIds = listTaskIds(dataRoot, project);
  const dependencies = normalizeDependencies(input.dependencies, null, existingIds);

  const work = _taskAllocLock.then((): TaskRecord => {
    const dir = tasksDir(dataRoot, project);
    const taskId = allocateExclusiveId(dir, 'TASK', TASK_ID_RE);
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
      dependencies,
      linkedRuns: [],
      createdAt: ts,
      updatedAt: ts,
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

export function listTasks(dataRoot: string, project: string, goalId?: string): TaskRecord[] {
  const dir = tasksDir(dataRoot, project);
  if (!fs.existsSync(dir)) return [];
  const filterGoal = goalId ? requireNonEmptyString(goalId, 'goalId') : null;
  if (filterGoal && !GOAL_ID_RE.test(filterGoal)) throw new Error(`잘못된 Goal ID: ${filterGoal}`);
  const out: TaskRecord[] = [];
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
      throw new Error(`Task ${name} 읽기 실패: ${msg}`);
    }
  }
  return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function updateTask(
  dataRoot: string,
  project: string,
  taskId: string,
  patch: TaskUpdatePatch,
): TaskRecord {
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
  if (patch.executionState !== undefined) {
    if (!isTaskExecutionState(patch.executionState)) {
      throw new Error(`알 수 없는 Task executionState: ${String(patch.executionState)}`);
    }
    existing.executionState = patch.executionState;
  }
  if (patch.pmState !== undefined) {
    if (!isTaskPmState(patch.pmState)) {
      throw new Error(`알 수 없는 Task pmState: ${String(patch.pmState)}`);
    }
    existing.pmState = patch.pmState;
  }
  if (patch.completionCriteria !== undefined) {
    existing.completionCriteria = normalizeCriteria(patch.completionCriteria);
  }
  if (patch.dependencies !== undefined) {
    const ids = listTaskIds(dataRoot, project);
    existing.dependencies = normalizeDependencies(patch.dependencies, existing.taskId, ids);
  }
  if (patch.clearAcceptedRunId) {
    delete existing.acceptedRunId;
  } else if (patch.acceptedRunId !== undefined) {
    if (typeof patch.acceptedRunId !== 'string' || !patch.acceptedRunId) {
      throw new Error('acceptedRunId는 비어 있지 않은 문자열이어야 합니다.');
    }
    if (!existing.linkedRuns.some((r) => r.runId === patch.acceptedRunId)) {
      throw new Error('acceptedRunId는 linkedRuns에 포함된 runId여야 합니다.');
    }
    existing.acceptedRunId = patch.acceptedRunId;
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

    const nextSeq =
      task.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0) + 1;
    const inferred = inferDateAgentFromFolder(resolved);
    const link: LinkedRunRef = {
      runId,
      folder: resolved,
      taskRunSequence: nextSeq,
      ...inferred,
    };

    task.linkedRuns = [...task.linkedRuns, link];
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
