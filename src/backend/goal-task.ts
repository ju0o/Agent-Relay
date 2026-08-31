/**
 * Goal / Task data kernel (Phase B1).
 *
 * Local-first filesystem SSOT under Project/_relay/{goals,tasks}/.
 * Does not migrate physical Run storage. Progress is derived, not persisted.
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
  LinkedRunRef,
  PERMISSION_MODES,
  PermissionMode,
  PermissionPolicy,
  TASK_STATUSES,
  TaskRecord,
  TaskStatus,
  TaskUpdatePatch,
} from '../shared/types.js';
import { projectDir, readRunMeta, writeRunMeta } from './fs.js';

const GOAL_ID_RE = /^GOAL-(\d+)$/;
const TASK_ID_RE = /^TASK-(\d+)$/;

const COMPLETE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['DONE', 'ACCEPTED']);
const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'READY',
  'DISPATCHED',
  'WORKING',
  'RESULT_RECEIVED',
  'VERIFYING',
  'CHANGES_REQUESTED',
]);

/** Module locks serialize concurrent ID allocation within one process. */
let _goalAllocLock: Promise<void> = Promise.resolve();
let _taskAllocLock: Promise<void> = Promise.resolve();

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
      // Windows: rename over existing target can fail — replace explicitly.
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

/** Exclusive mkdir allocation — never reuses deleted IDs (max+1 onward). */
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

// ── validators ──────────────────────────────────────────────────────────────

export function isGoalStatus(v: unknown): v is GoalStatus {
  return typeof v === 'string' && (GOAL_STATUSES as readonly string[]).includes(v);
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
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
 * Normalize dependency Task IDs: reject self-deps, drop duplicates.
 * Referenced IDs should exist in the same project when practical.
 * Full cycle detection is deferred to B2 except for the obvious self-cycle.
 */
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
    if (seen.has(id)) continue; // duplicate removed safely
    if (!existingTaskIds.has(id)) {
      throw new Error(`의존 Task가 프로젝트에 없습니다: ${id}`);
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function validateGoalRecord(g: GoalRecord): void {
  if (g.schemaVersion !== GOAL_TASK_SCHEMA_VERSION) {
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
  if (!isTaskStatus(t.status)) throw new Error(`알 수 없는 Task status: ${String(t.status)}`);
  if (!Array.isArray(t.completionCriteria)) throw new Error('completionCriteria는 배열이어야 합니다.');
  if (!Array.isArray(t.dependencies)) throw new Error('dependencies는 배열이어야 합니다.');
  if (!Array.isArray(t.linkedRuns)) throw new Error('linkedRuns는 배열이어야 합니다.');
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
      .map((r) => `- #${r.taskRunSequence}: ${r.folder}`)
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
    '## Status',
    '',
    t.status,
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
  const status: GoalStatus = input.status == null ? 'PLANNING' : (isGoalStatus(input.status) ? input.status : (() => { throw new Error(`알 수 없는 Goal status: ${String(input.status)}`); })());
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
  status?: unknown;
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
  // Must reference a valid Goal
  getGoal(dataRoot, project, goalId);

  const title = requireNonEmptyString(input.title, 'title');
  const goal = requireNonEmptyString(input.goal, 'goal');
  if (typeof input.reason !== 'string') throw new Error('reason이 필요합니다.');
  if (typeof input.scope !== 'string') throw new Error('scope가 필요합니다.');
  const status: TaskStatus = input.status == null
    ? 'PLANNED'
    : (isTaskStatus(input.status) ? input.status : (() => { throw new Error(`알 수 없는 Task status: ${String(input.status)}`); })());
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
      status,
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
  const record = readJsonFile<TaskRecord>(file);
  validateTaskRecord(record);
  return record;
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
      const record = readJsonFile<TaskRecord>(file);
      validateTaskRecord(record);
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
  if (patch.status !== undefined) {
    if (!isTaskStatus(patch.status)) throw new Error(`알 수 없는 Task status: ${String(patch.status)}`);
    existing.status = patch.status;
  }
  if (patch.completionCriteria !== undefined) {
    existing.completionCriteria = normalizeCriteria(patch.completionCriteria);
  }
  if (patch.dependencies !== undefined) {
    const ids = listTaskIds(dataRoot, project);
    existing.dependencies = normalizeDependencies(patch.dependencies, existing.taskId, ids);
  }
  existing.updatedAt = nowIso();
  validateTaskRecord(existing);
  persistTaskFiles(taskFolder(dataRoot, project, existing.taskId), existing);
  return existing;
}

// ── Run linkage ─────────────────────────────────────────────────────────────

function normPath(p: string): string {
  return path.resolve(p);
}

function findTaskOwningRun(dataRoot: string, project: string, runFolder: string): TaskRecord | null {
  const target = normPath(runFolder);
  for (const t of listTasks(dataRoot, project)) {
    if (t.linkedRuns.some((r) => normPath(r.folder) === target)) return t;
  }
  return null;
}

export function linkRunToTask(
  dataRoot: string,
  project: string,
  taskId: string,
  runFolder: string,
): TaskRecord {
  const folder = requireNonEmptyString(runFolder, 'runFolder');
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(`Run 폴더가 없습니다: ${folder}`);
  }
  const task = getTask(dataRoot, project, taskId);
  // Ensure Goal still exists
  getGoal(dataRoot, project, task.goalId);

  const resolved = normPath(folder);
  if (task.linkedRuns.some((r) => normPath(r.folder) === resolved)) {
    throw new Error('이 Run은 이미 해당 Task에 연결되어 있습니다.');
  }

  const owner = findTaskOwningRun(dataRoot, project, resolved);
  if (owner && owner.taskId !== task.taskId) {
    throw new Error(`Run은 이미 다른 Task(${owner.taskId})에 연결되어 있습니다.`);
  }

  const meta = readRunMeta(folder);
  if (meta.taskId && meta.taskId !== task.taskId) {
    throw new Error(`Run meta가 이미 다른 Task(${meta.taskId})를 가리킵니다.`);
  }

  const nextSeq =
    task.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0) + 1;

  const link: LinkedRunRef = { folder: resolved, taskRunSequence: nextSeq };
  task.linkedRuns = [...task.linkedRuns, link];
  task.updatedAt = nowIso();
  validateTaskRecord(task);
  persistTaskFiles(taskFolder(dataRoot, project, task.taskId), task);

  writeRunMeta(folder, {
    ...meta,
    goalId: task.goalId,
    taskId: task.taskId,
    taskRunSequence: nextSeq,
  });

  return task;
}

export function unlinkRunFromTask(
  dataRoot: string,
  project: string,
  taskId: string,
  runFolder: string,
): TaskRecord {
  const folder = requireNonEmptyString(runFolder, 'runFolder');
  const task = getTask(dataRoot, project, taskId);
  const resolved = normPath(folder);
  const before = task.linkedRuns.length;
  task.linkedRuns = task.linkedRuns.filter((r) => normPath(r.folder) !== resolved);
  if (task.linkedRuns.length === before) {
    throw new Error('해당 Run은 이 Task에 연결되어 있지 않습니다.');
  }
  task.updatedAt = nowIso();
  validateTaskRecord(task);
  persistTaskFiles(taskFolder(dataRoot, project, task.taskId), task);

  if (fs.existsSync(folder)) {
    const meta = readRunMeta(folder);
    if (meta.taskId === task.taskId) {
      writeRunMeta(folder, { tags: meta.tags });
    }
  }

  return task;
}

// ── Progress (derived) ──────────────────────────────────────────────────────

/**
 * Pure Goal progress derivation from Task statuses.
 *
 * Semantics:
 * - doneTasks: DONE + ACCEPTED (both contribute complete)
 * - blockedTasks: BLOCKED
 * - activeTasks: READY | DISPATCHED | WORKING | RESULT_RECEIVED | VERIFYING | CHANGES_REQUESTED
 * - PLANNED / ABANDONED are counted in total only
 */
export function deriveGoalProgress(goalId: string, tasks: readonly TaskRecord[]): GoalProgress {
  const scoped = tasks.filter((t) => t.goalId === goalId);
  let doneTasks = 0;
  let activeTasks = 0;
  let blockedTasks = 0;
  for (const t of scoped) {
    if (COMPLETE_TASK_STATUSES.has(t.status)) doneTasks += 1;
    else if (t.status === 'BLOCKED') blockedTasks += 1;
    else if (ACTIVE_TASK_STATUSES.has(t.status)) activeTasks += 1;
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
