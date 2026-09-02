/**
 * Phase I3F-1 — Task Detail read-only subview (pure render + task resolution).
 */

import type { TuiSnapshot } from '../snapshot.js';
import * as goalTask from '../../backend/goal-task.js';
import { getTaskReadiness } from '../../backend/goal-task-runtime.js';
import type { TaskRecord, TaskReadiness } from '../../shared/types.js';

export interface TaskDetailModel {
  task: TaskRecord | null;
  readiness: TaskReadiness | null;
  error?: string;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function center(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  const left = Math.floor((n - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - s.length - left);
}

/**
 * Resolve the "current/relevant" Task for detail view.
 * Priority: first activeTasks entry, else first task sorted by taskId.
 * Returns null if no task exists.
 */
export function resolveDetailTask(
  snapshot: TuiSnapshot,
  dataRoot: string | undefined,
  project: string | undefined,
): TaskDetailModel {
  if (!dataRoot || !project) return { task: null, readiness: null };
  try {
    // Prefer active task from snapshot
    const activeId = snapshot.status.activeTasks[0]?.taskId;
    if (activeId) {
      try {
        const task = goalTask.getTask(dataRoot, project, activeId);
        let readiness: TaskReadiness | null = null;
        try {
          const all = goalTask.listTasks(dataRoot, project, task.goalId);
          readiness = getTaskReadiness(task, all);
        } catch { /* ignore */ }
        return { task, readiness };
      } catch { /* fallthrough */ }
    }
    // Fallback: first task sorted
    const allTasks = goalTask.listTasks(dataRoot, project);
    if (allTasks.length === 0) return { task: null, readiness: null };
    const task = allTasks[0]!;
    let readiness: TaskReadiness | null = null;
    try {
      readiness = getTaskReadiness(task, goalTask.listTasks(dataRoot, project, task.goalId));
    } catch { /* ignore */ }
    return { task, readiness };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { task: null, readiness: null, error: msg };
  }
}

export function renderTaskDetail(
  model: TaskDetailModel,
  size: { cols: number; rows: number },
): string {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(10, size.rows);
  const inner = cols - 2;
  const lines: string[] = [];

  lines.push('┌' + '─'.repeat(inner) + '┐');
  lines.push('│' + center('Task Detail', inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');

  if (!model.task) {
    const msg = model.error ? `Error: ${truncate(model.error, inner - 2)}` : 'No active Task.';
    lines.push('│' + center(truncate(msg, inner), inner) + '│');
    lines.push('│' + ' '.repeat(inner) + '│');
    lines.push('│' + center(truncate('Press Esc to return', inner), inner) + '│');
    lines.push('├' + '─'.repeat(inner) + '┤');
    lines.push('│' + pad(' Esc:back  q:quit  M:Memos', inner) + '│');
    lines.push('└' + '─'.repeat(inner) + '┘');
    return lines.join('\n');
  }

  const t = model.task;
  const readiness = model.readiness?.kind ?? '—';

  const fields: Array<[string, string]> = [
    ['taskId', t.taskId],
    ['title', truncate(t.title, inner - 12)],
    ['executionState', t.executionState],
    ['pmState', t.pmState],
    ['readiness', String(readiness)],
    ['goalId', t.goalId],
    ['dependencies', t.dependencies.length ? t.dependencies.join(', ') : '(none)'],
    ['completionCriteria', t.completionCriteria.length ? `${t.completionCriteria.length} criteria` : '(none)'],
    ['blockedReason', t.blockedReason ?? '(none)'],
    ['retryCount', String(t.retryCount ?? 0)],
    ['acceptedRunId', t.acceptedRunId ?? '(none)'],
    ['nextTaskRunSequence', String(t.nextTaskRunSequence)],
    ['linkedRuns', t.linkedRuns.length ? t.linkedRuns.map(r => `#${r.taskRunSequence}:${r.runId.slice(0,8)}`).join(', ') : '(none)'],
    ['createdAt', truncate(t.createdAt, inner - 12)],
    ['updatedAt', truncate(t.updatedAt, inner - 12)],
  ];

  for (const [k, v] of fields) {
    const label = `${k}:`;
    const val = truncate(v, inner - label.length - 2);
    const line = ` ${label} ${val}`;
    lines.push('│' + pad(truncate(line, inner), inner) + '│');
    if (lines.length >= rows - 3) {
      lines.push('│' + center('… truncated — resize', inner) + '│');
      break;
    }
  }

  // Bounded extra: show first  Items of completionCriteria if present
  if (t.completionCriteria.length > 0 && lines.length < rows - 4) {
    lines.push('│' + ' '.repeat(inner) + '│');
    lines.push('│' + pad(' Criteria:', inner) + '│');
    for (let i = 0; i < Math.min(5, t.completionCriteria.length); i++) {
      const c = truncate(`  - ${t.completionCriteria[i] ?? ''}`, inner - 1);
      lines.push('│' + pad(c, inner) + '│');
      if (lines.length >= rows - 3) break;
    }
  }

  // goal/reason/scope truncated single line already; detail view keeps bounded
  if (t.goal && lines.length < rows - 3) {
    lines.push('│' + pad(truncate(` goal: ${t.goal}`, inner), inner) + '│');
  }

  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(' Esc:back  q:quit  M:Memos  e:Edit', inner) + '│');
  lines.push('└' + '─'.repeat(inner) + '┘');

  if (lines.length > rows) {
    lines.splice(rows - 1, lines.length - rows, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
}
