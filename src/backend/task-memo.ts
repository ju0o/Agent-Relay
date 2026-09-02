/**
 * Phase I3F-1 — Task Memo durable append-only storage.
 *
 * Physical layout:
 *   <dataRoot>/<project>/_relay/tasks/<taskId>/notes/<noteId>.json  (canonical)
 *   <dataRoot>/<project>/_relay/tasks/<taskId>/notes/<noteId>.md    (mirror)
 *
 * Memo is passive context — NOT Evidence, NOT Event, NOT Worker truth.
 * Does not mutate Task state, readiness, or pmState.
 */

import * as fs from 'fs';
import * as path from 'path';
import { taskFolder, countersPath, writeJsonAtomic, getTask } from './goal-task.js';
import type { CountersRecord } from './goal-task.js';

// ── Types ───────────────────────────────────────────────────────────────────

export const MEMO_SCHEMA_VERSION = 1;

export interface MemoRecord {
  schemaVersion: number;
  noteId: string;
  project: string;
  goalId: string;
  taskId: string;
  authorSurface: 'OWNER_IPC';
  body: string;
  createdAt: string;
}

const NOTE_ID_RE = /^NOTE-(\d+)$/;

// ── Paths ───────────────────────────────────────────────────────────────────

export function notesDir(dataRoot: string, project: string, taskId: string): string {
  return path.join(taskFolder(dataRoot, project, taskId), 'notes');
}

export function noteJsonPath(dataRoot: string, project: string, taskId: string, noteId: string): string {
  return path.join(notesDir(dataRoot, project, taskId), `${noteId}.json`);
}

export function noteMdPath(dataRoot: string, project: string, taskId: string, noteId: string): string {
  return path.join(notesDir(dataRoot, project, taskId), `${noteId}.md`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

function padNoteId(n: number): string {
  return `NOTE-${String(n).padStart(6, '0')}`;
}

function isValidIsoTimestamp(v: string): boolean {
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && typeof v === 'string' && v.includes('T');
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateMemoRecord(m: MemoRecord): void {
  if (m.schemaVersion !== MEMO_SCHEMA_VERSION) {
    throw new Error(`지원하지 않는 Memo schemaVersion: ${m.schemaVersion}`);
  }
  if (!NOTE_ID_RE.test(m.noteId)) throw new Error(`잘못된 Note ID: ${m.noteId}`);
  if (!m.project) throw new Error('Memo project가 필요합니다.');
  if (!m.goalId) throw new Error('Memo goalId가 필요합니다.');
  if (!m.taskId) throw new Error('Memo taskId가 필요합니다.');
  if (m.authorSurface !== 'OWNER_IPC') throw new Error('authorSurface는 OWNER_IPC만 허용됩니다.');
  if (typeof m.body !== 'string' || !m.body.trim()) throw new Error('Memo body가 필요합니다.');
  if (m.body.length > 2000) throw new Error('Memo body는 최대 2000자입니다.');
  if (!m.createdAt || !isValidIsoTimestamp(m.createdAt)) throw new Error('createdAt은 ISO timestamp여야 합니다.');
}

export function validateMemoBody(body: unknown): string {
  if (typeof body !== 'string') throw new Error('Memo body는 문자열이어야 합니다.');
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Memo body는 비어 있을 수 없습니다.');
  if (trimmed.length > 2000) throw new Error('Memo body는 최대 2000자입니다.');
  return trimmed;
}

// ── Counters & Allocation ───────────────────────────────────────────────────

let _noteAllocLock: Promise<void> = Promise.resolve();

function readCountersRaw(dataRoot: string, project: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(countersPath(dataRoot, project), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  } catch { /* missing */ }
  return {};
}

function maxExistingNoteId(dataRoot: string, project: string): number {
  let max = 0;
  // scan all tasks/*/notes/NOTE-*.json
  try {
    const tasksDirPath = path.join(path.resolve(dataRoot, project === '.' ? '' : project), '_relay', 'tasks');
    // Use goal-task helper to avoid path duplication: iterate via projectDir
    // Fallback: scan via tasksDir
    const { tasksDir } = require('./goal-task.js') as typeof import('./goal-task.js');
    const dir = tasksDir(dataRoot, project);
    if (!fs.existsSync(dir)) return 0;
    for (const taskName of fs.readdirSync(dir)) {
      if (!/^TASK-\d+$/.test(taskName)) continue;
      const notesPath = path.join(dir, taskName, 'notes');
      if (!fs.existsSync(notesPath)) continue;
      for (const file of fs.readdirSync(notesPath)) {
        const m = /^(NOTE-\d+)\.json$/.exec(file);
        if (m) {
          const num = parseInt(m[1]!.slice(5), 10);
          if (Number.isFinite(num)) max = Math.max(max, num);
        }
      }
    }
  } catch { /* ignore */ }
  return max;
}

function allocateNoteIdWithCounter(dataRoot: string, project: string): string {
  const raw = readCountersRaw(dataRoot, project);
  const existingMax = maxExistingNoteId(dataRoot, project);
  let n =
    typeof raw.nextNoteNumber === 'number' && Number.isInteger(raw.nextNoteNumber) && raw.nextNoteNumber >= 1
      ? raw.nextNoteNumber
      : existingMax + 1;
  n = Math.max(n, existingMax + 1);

  for (;;) {
    const id = padNoteId(n);
    // Claim via counters increment + check file not exists (file is unique per task but id is global)
    // We don't mkdir; we just reserve the id via counter. Ensure no existing note file with same id in any task.
    // If file exists anywhere, bump.
    let exists = false;
    try {
      const { tasksDir } = require('./goal-task.js') as typeof import('./goal-task.js');
      const dir = tasksDir(dataRoot, project);
      if (fs.existsSync(dir)) {
        for (const taskName of fs.readdirSync(dir)) {
          if (fs.existsSync(path.join(dir, taskName, 'notes', `${id}.json`))) {
            exists = true;
            break;
          }
        }
      }
    } catch { /* ignore */ }
    if (exists) {
      n += 1;
      continue;
    }

    // Reserve via counters
    const latest = readCountersRaw(dataRoot, project);
    let nextGoal = 1;
    let nextTask = 1;
    let nextEvidence: number | undefined;
    let nextEvent: number | undefined;
    if (typeof latest.nextGoalNumber === 'number' && Number.isInteger(latest.nextGoalNumber) && latest.nextGoalNumber >= 1) {
      nextGoal = latest.nextGoalNumber;
    } else if (typeof raw.nextGoalNumber === 'number' && Number.isInteger(raw.nextGoalNumber) && raw.nextGoalNumber >= 1) {
      nextGoal = raw.nextGoalNumber;
    }
    if (typeof latest.nextTaskNumber === 'number' && Number.isInteger(latest.nextTaskNumber) && latest.nextTaskNumber >= 1) {
      nextTask = latest.nextTaskNumber;
    } else if (typeof raw.nextTaskNumber === 'number' && Number.isInteger(raw.nextTaskNumber) && raw.nextTaskNumber >= 1) {
      nextTask = raw.nextTaskNumber;
    }
    if (typeof latest.nextEvidenceNumber === 'number' && Number.isInteger(latest.nextEvidenceNumber) && latest.nextEvidenceNumber >= 1) {
      nextEvidence = latest.nextEvidenceNumber;
    } else if (typeof raw.nextEvidenceNumber === 'number' && Number.isInteger(raw.nextEvidenceNumber) && raw.nextEvidenceNumber >= 1) {
      nextEvidence = raw.nextEvidenceNumber;
    }
    if (typeof latest.nextEventNumber === 'number' && Number.isInteger(latest.nextEventNumber) && latest.nextEventNumber >= 1) {
      nextEvent = latest.nextEventNumber;
    } else if (typeof raw.nextEventNumber === 'number' && Number.isInteger(raw.nextEventNumber) && raw.nextEventNumber >= 1) {
      nextEvent = raw.nextEventNumber;
    }
    const next: CountersRecord = {
      nextGoalNumber: nextGoal,
      nextTaskNumber: nextTask,
      ...(nextEvidence !== undefined ? { nextEvidenceNumber: nextEvidence } : {}),
      ...(nextEvent !== undefined ? { nextEventNumber: nextEvent } : {}),
      nextNoteNumber: n + 1,
    };
    // Ensure monotonic beyond existing max even if counter stale
    const checkMax = maxExistingNoteId(dataRoot, project);
    if (next.nextNoteNumber! <= checkMax) {
      n = checkMax + 1;
      continue;
    }
    writeJsonAtomic(countersPath(dataRoot, project), next);
    return id;
  }
}

// ── Markdown mirror ─────────────────────────────────────────────────────────

export function renderMemoMarkdown(m: MemoRecord): string {
  return [
    `# ${m.noteId}`,
    '',
    `Project: ${m.project}`,
    `Goal: ${m.goalId}`,
    `Task: ${m.taskId}`,
    `Author: ${m.authorSurface}`,
    `Created: ${m.createdAt}`,
    '',
    '## Body',
    '',
    m.body,
    '',
  ].join('\n');
}

function persistMemoFiles(dataRoot: string, project: string, taskId: string, record: MemoRecord): void {
  const jsonPath = noteJsonPath(dataRoot, project, taskId, record.noteId);
  writeJsonAtomic(jsonPath, record);
  try {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(noteMdPath(dataRoot, project, taskId, record.noteId), renderMemoMarkdown(record), 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Memo JSON은 저장됐지만 Markdown 쓰기에 실패했습니다 (복구 가능): ${msg}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CreateMemoInput {
  body: string;
  authorSurface?: string;
}

export function createMemo(
  dataRoot: string,
  project: string,
  taskId: string,
  input: CreateMemoInput,
): Promise<MemoRecord> {
  const p = requireNonEmptyString(project, 'project');
  const tid = requireNonEmptyString(taskId, 'taskId');
  const body = validateMemoBody(input.body);
  const authorSurface = input.authorSurface ?? 'OWNER_IPC';
  if (authorSurface !== 'OWNER_IPC') {
    throw new Error('authorSurface는 OWNER_IPC만 허용됩니다.');
  }

  // Validate task exists and resolve goalId
  const task = getTask(dataRoot, p, tid);
  if (task.project !== p) {
    throw new Error(`교차 프로젝트 Task 참조는 거부됩니다: ${tid}`);
  }
  // Terminal policy: CANCELLED is immutable, no memo
  if (task.executionState === 'CANCELLED') {
    throw new Error('CANCELLED Task에는 Memo를 추가할 수 없습니다.');
  }

  const work = _noteAllocLock.then((): MemoRecord => {
    // Re-validate task still exists at write time
    const freshTask = getTask(dataRoot, p, tid);
    if (freshTask.executionState === 'CANCELLED') {
      throw new Error('CANCELLED Task에는 Memo를 추가할 수 없습니다.');
    }

    const noteId = allocateNoteIdWithCounter(dataRoot, p);
    const record: MemoRecord = {
      schemaVersion: MEMO_SCHEMA_VERSION,
      noteId,
      project: p,
      goalId: freshTask.goalId,
      taskId: tid,
      authorSurface: 'OWNER_IPC',
      body,
      createdAt: nowIso(),
    };
    validateMemoRecord(record);
    persistMemoFiles(dataRoot, p, tid, record);
    // Do NOT mutate Task, do NOT create Evidence, do NOT create Event
    return record;
  });
  _noteAllocLock = work.then(() => undefined, () => undefined);
  return work;
}

export function getMemo(dataRoot: string, project: string, taskId: string, noteId: string): MemoRecord {
  const p = requireNonEmptyString(project, 'project');
  const tid = requireNonEmptyString(taskId, 'taskId');
  const nid = requireNonEmptyString(noteId, 'noteId');
  if (!NOTE_ID_RE.test(nid)) throw new Error(`잘못된 Note ID: ${nid}`);
  const file = noteJsonPath(dataRoot, p, tid, nid);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Memo를 찾을 수 없습니다: ${nid}`);
  }
  let parsed: MemoRecord;
  try {
    parsed = JSON.parse(raw) as MemoRecord;
  } catch {
    throw new Error(`잘못된 Memo JSON 형식입니다: ${nid}`);
  }
  validateMemoRecord(parsed);
  if (parsed.project !== p || parsed.taskId !== tid) {
    throw new Error(`Memo 프로젝트/Task 불일치: ${nid}`);
  }
  return parsed;
}

export interface ListMemosResult {
  memos: MemoRecord[];
  warnings: string[];
}

export function listMemosWithDiagnostics(
  dataRoot: string,
  project: string,
  taskId: string,
): ListMemosResult {
  const p = requireNonEmptyString(project, 'project');
  const tid = requireNonEmptyString(taskId, 'taskId');
  // Validate task exists
  getTask(dataRoot, p, tid);
  const dir = notesDir(dataRoot, p, tid);
  if (!fs.existsSync(dir)) return { memos: [], warnings: [] };
  const out: MemoRecord[] = [];
  const warnings: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    const m = /^(NOTE-\d+)\.json$/.exec(file);
    if (!m) continue;
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = JSON.parse(raw) as MemoRecord;
      validateMemoRecord(parsed);
      if (parsed.project !== p || parsed.taskId !== tid) {
        warnings.push(`Memo ${file} 프로젝트/Task 불일치 — 건너뜀`);
        continue;
      }
      out.push(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Memo ${file} 읽기 실패: ${msg}`);
    }
  }
  // Newest first for TUI default; but keep deterministic sort by noteId desc (which matches creation order)
  out.sort((a, b) => b.noteId.localeCompare(a.noteId));
  return { memos: out, warnings };
}

export function listMemos(dataRoot: string, project: string, taskId: string): MemoRecord[] {
  return listMemosWithDiagnostics(dataRoot, project, taskId).memos;
}

// Test helper
export function _resetMemoLockForTests(): void {
  _noteAllocLock = Promise.resolve();
}
