/**
 * V2 slice-1 R1 — read-only stuck-work scan.
 *
 * Enumerates the five stuck/interrupted patterns named in
 * docs/V2-HISTORY-RESUME-PLAN.md §2 using ONLY read primitives
 * (listTasks, H1 getTaskHistory, preparation/attempt listers, plain file
 * reads). No execution, no writes, no transitions, no mint/consume/
 * dispatch. Each finding names the blessed R2 action — it never performs it.
 *
 * If a future pattern needs a write-side-effect call just to gather status,
 * it must NOT be added here (report that finding instead, per R1 GO).
 */
import * as fs from 'fs';
import * as path from 'path';
import { listTasks } from './goal-task.js';
import { getTaskHistory } from './task-history.js';
import { listRetryPreparations } from './retry-preparation.js';
import { listQaRemediationPreparations } from './qa-remediation-preparation.js';
import { listQaAttemptsForTask } from './qa-attempt.js';
import type { TaskRecord } from '../shared/types.js';

export type StuckPattern =
  | 'ORPHANED_DISPATCH'
  | 'UNRECOVERED_COMPLETED_RUN'
  | 'CRASHED_PREPARATION'
  | 'QA_GATE_STALLED'
  | 'MISSING_DELIVERY';

export interface ScanFinding {
  pattern: StuckPattern;
  taskId: string;
  runId?: string;
  preparationId?: string;
  detail: string;
  /** Name of the R2 guided action — informational only, never executed here. */
  blessedAction: string;
  updatedAt: string;
}

export interface ResumeScanResult {
  project: string;
  scannedTasks: number;
  findings: ScanFinding[];
}

const TERMINAL_EXEC = new Set(['FAILED', 'CANCELLED', 'BLOCKED']);

/** Historical worker-launch.log separator (scripts/relay-worker-claude.mjs). Read-only mirror of the kernel's tolerant reader. */
const LAUNCH_LOG_SEPARATOR = '\n---\n';

/** Last-block exitCode from worker-launch.log, or null when absent/unparsable. Never throws. */
function readLastLaunchExitCode(folder: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, 'worker-launch.log'), 'utf8');
  } catch {
    return null;
  }
  const blocks = raw.split(LAUNCH_LOG_SEPARATOR);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const chunk = blocks[i]!.trim();
    if (!chunk) continue;
    try {
      const parsed = JSON.parse(chunk) as { exitCode?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.exitCode === 'number') {
        return parsed.exitCode;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function isTerminalTask(t: TaskRecord): boolean {
  return TERMINAL_EXEC.has(t.executionState) || t.pmState === 'ACCEPTED';
}

export function scanStuckWork(dataRoot: string, project: string): ResumeScanResult {
  const tasks = [...listTasks(dataRoot, project)].sort((a, b) => a.taskId.localeCompare(b.taskId));
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const findings: ScanFinding[] = [];

  // Per-task patterns (via H1 read model).
  for (const task of tasks) {
    let hist: ReturnType<typeof getTaskHistory>;
    try {
      hist = getTaskHistory(dataRoot, project, task.taskId);
    } catch {
      continue; // unreadable task record — not a stuck pattern, skip
    }
    const latest = hist.attempts.length ? hist.attempts[hist.attempts.length - 1]! : null;

    // P1 — dispatched/running, outcome unknown from disk alone.
    if (task.executionState === 'DISPATCHED' || task.executionState === 'RUNNING') {
      findings.push({
        pattern: 'ORPHANED_DISPATCH',
        taskId: task.taskId,
        ...(latest ? { runId: latest.runId } : {}),
        detail: `executionState=${task.executionState} since ${task.updatedAt} — may still be live; confirm the worker before acting`,
        blessedAction: 'orphan-resolution: KEEP_WAITING / CONFIRM_FAILED / CONFIRM_CANCELLED (Owner confirm)',
        updatedAt: task.updatedAt,
      });
      // P2 — same task, but the run folder carries a terminal exit-0 launch
      // entry while the Task never reached RESULT_RECEIVED.
      if (latest?.folder) {
        const exitCode = readLastLaunchExitCode(latest.folder);
        if (exitCode === 0) {
          findings.push({
            pattern: 'UNRECOVERED_COMPLETED_RUN',
            taskId: task.taskId,
            runId: latest.runId,
            detail: `worker-launch.log terminal exitCode=0 for run #${latest.taskRunSequence}, task never reached RESULT_RECEIVED`,
            blessedAction: 'relay_pm_recover_completed_run (manual trigger only)',
            updatedAt: task.updatedAt,
          });
        }
      }
    }

    // P4 — QA gate stalled: contracted QA, result received, gate never resolved.
    if (
      task.executionState === 'RESULT_RECEIVED'
      && task.pmState === 'PENDING'
      && task.qaContract
      && latest
    ) {
      let verdict: string | null = null;
      try {
        const attempts = listQaAttemptsForTask(dataRoot, project, task.taskId);
        const current = attempts.filter((a) => a.runId === latest.runId);
        const finaled = current.find((a) => a.finalQaStatus !== 'PENDING');
        verdict = finaled ? finaled.finalQaStatus : null;
      } catch {
        verdict = null;
      }
      if (!verdict) {
        findings.push({
          pattern: 'QA_GATE_STALLED',
          taskId: task.taskId,
          runId: latest.runId,
          detail: `qaContract present, no final QA verdict (PASS/FAIL/BLOCKED) for current run #${latest.taskRunSequence}`,
          blessedAction: 'reconcileQaGate re-run (R2 guided, Owner confirm)',
          updatedAt: task.updatedAt,
        });
      }
    }

    // P5 — verifying without a delivery for the current attempt.
    if (task.executionState === 'RESULT_RECEIVED' && task.pmState === 'VERIFYING' && latest && !latest.delivery) {
      findings.push({
        pattern: 'MISSING_DELIVERY',
        taskId: task.taskId,
        runId: latest.runId,
        detail: `VERIFYING with no PMD delivery for current run #${latest.taskRunSequence}`,
        blessedAction: 'ensurePmDelivery (R2 guided, explicit Owner confirm even though idempotent)',
        updatedAt: task.updatedAt,
      });
    }
  }

  // P3 — preparations crashed mid-pipeline (never reached READY).
  try {
    for (const prep of listRetryPreparations(dataRoot, project)) {
      if (prep.status !== 'RECEIVED' && prep.status !== 'CHANGES_APPLIED') continue;
      const task = byId.get(prep.taskId);
      if (!task || isTerminalTask(task)) continue;
      findings.push({
        pattern: 'CRASHED_PREPARATION',
        taskId: prep.taskId,
        preparationId: prep.preparationId,
        detail: `retry preparation ${prep.preparationId} stuck at ${prep.status} (source run ${prep.sourceRunId.slice(0, 8)})`,
        blessedAction: 'retry-preparation reconcile (R2 guided, Owner confirm)',
        updatedAt: task.updatedAt,
      });
    }
  } catch { /* no preparations dir — no findings */ }
  try {
    for (const prep of listQaRemediationPreparations(dataRoot, project)) {
      if (prep.status !== 'RECEIVED') continue;
      const task = byId.get(prep.taskId);
      if (!task || isTerminalTask(task)) continue;
      findings.push({
        pattern: 'CRASHED_PREPARATION',
        taskId: prep.taskId,
        preparationId: prep.preparationId,
        detail: `qa-remediation preparation ${prep.preparationId} stuck at RECEIVED`,
        blessedAction: 'qa-remediation-preparation reconcile (R2 guided, Owner confirm)',
        updatedAt: task.updatedAt,
      });
    }
  } catch { /* no preparations dir — no findings */ }

  findings.sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId),
  );
  return { project, scannedTasks: tasks.length, findings };
}
