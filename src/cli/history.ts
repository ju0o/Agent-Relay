/**
 * V2 slice-1 H1 CLI surface — read-only Task history.
 *
 * Reuses the H1 read model (`getTaskHistory`) directly: no second data
 * source. Conventions mirror status.ts/doctor.ts (schemaVersion, --json).
 */
import { discoverConfig } from './config.js';
import { getTaskHistory } from '../backend/task-history.js';
import type { TaskHistory } from '../backend/task-history.js';

export const HISTORY_SCHEMA_VERSION = 'cli.history.v1';

export interface HistoryResult {
  schemaVersion: string;
  ok: boolean;
  dataRoot?: string;
  project?: string;
  history?: TaskHistory;
  error?: string;
}

export function runHistory(cwd: string, taskId: string): HistoryResult {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return { schemaVersion: HISTORY_SCHEMA_VERSION, ok: false, error: 'not-initialized' };
  }
  const { dataRoot, project } = discovered.config;
  try {
    const history = getTaskHistory(dataRoot, project, taskId);
    return { schemaVersion: HISTORY_SCHEMA_VERSION, ok: true, dataRoot, project, history };
  } catch (e) {
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      ok: false,
      dataRoot,
      project,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function renderHistoryHuman(res: HistoryResult): string {
  if (!res.ok || !res.history) return `history failed: ${res.error ?? 'unknown'}`;
  const h = res.history;
  const t = h.task;
  const lines: string[] = [
    `${t.taskId} — ${t.title}`,
    `goal: ${t.goalId}  exec: ${t.executionState}  pm: ${t.pmState}`,
    `acceptedRun: ${t.acceptedRunId ?? '(none)'}`,
    '',
    `attempts (${h.attempts.length}):`,
  ];
  for (const a of h.attempts) {
    const pr = `${a.hasPrompt ? 'P' : '-'}/${a.hasResult ? 'R' : '-'}`;
    const d = a.delivery ? a.delivery.status : '—';
    const j = a.judgment ? `${a.judgment.decision}:${a.judgment.status}` : '—';
    lines.push(
      `  #${a.taskRunSequence} ${a.runId.slice(0, 8)} ${a.agent ?? '?'} ${pr} D:${d} J:${j}${a.folderExists ? '' : ' (folder missing)'}`,
    );
  }
  lines.push(`events: ${h.events.length}  evidence: ${h.evidence.length}`);
  return lines.join('\n');
}
