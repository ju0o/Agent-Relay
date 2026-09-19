/**
 * V2 slice-1 H1 — read-only Task timeline model.
 *
 * Joins existing SSOT records (Task, linked Runs, per-attempt Delivery +
 * Judgment, linked Events and Evidence) into one browsable view. PURE READ:
 * no writes, no transitions, no mint/consume/dispatch, no readiness
 * side-effects. Anything missing (no Delivery yet, no Judgment yet, vanished
 * Run folder) surfaces as `null`/empty — never throws except when the Task
 * itself does not exist.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getTask } from './goal-task.js';
import { readRunMeta } from './fs.js';
import { getPmDelivery, pmDeliveryIdFor } from './pm-delivery.js';
import type { PmDeliveryRecord } from './pm-delivery.js';
import { getPmJudgment, getRetryInstructionForDelivery, pmJudgmentIdFor } from './pm-judgment.js';
import type { PmJudgmentRecord } from './pm-judgment.js';
import { listEvents } from './event.js';
import { listEvidenceForTask } from './evidence.js';
import type {
  EvidenceRecord,
  EventRecord,
  TaskRecord,
} from '../shared/types.js';

export interface TaskHistoryAttempt {
  taskRunSequence: number;
  runId: string;
  folder: string;
  agent?: string;
  date?: string;
  /** Run folder still on disk (false = moved/deleted after linking). */
  folderExists: boolean;
  hasPrompt: boolean;
  hasResult: boolean;
  tags: string[];
  delivery: Pick<PmDeliveryRecord, 'deliveryId' | 'status' | 'deliveredAt'> | null;
  judgment: (Pick<PmJudgmentRecord, 'judgmentId' | 'decision' | 'status' | 'reason'> & { retryInstruction?: string }) | null;
}

export interface TaskHistoryEvent {
  eventId: string;
  type: EventRecord['type'];
  severity: EventRecord['severity'];
  occurredAt: string;
  runId?: string;
}

export interface TaskHistoryEvidence {
  evidenceId: string;
  type: EvidenceRecord['type'];
  trustLevel: EvidenceRecord['trustLevel'];
  status: EvidenceRecord['status'];
  runId?: string;
  summary: string;
}

export interface TaskHistory {
  task: TaskRecord;
  attempts: TaskHistoryAttempt[];
  events: TaskHistoryEvent[];
  evidence: TaskHistoryEvidence[];
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the full read-only timeline for one Task.
 * Attempts follow `linkedRuns[].taskRunSequence` ascending.
 */
export function getTaskHistory(dataRoot: string, project: string, taskId: string): TaskHistory {
  const task = getTask(dataRoot, project, taskId);

  const attempts: TaskHistoryAttempt[] = [...task.linkedRuns]
    .sort((a, b) => a.taskRunSequence - b.taskRunSequence)
    .map((ref) => {
      const folderExists = !!ref.folder && dirExists(ref.folder);
      const meta = ref.folder ? readRunMeta(ref.folder) : { tags: [] as string[] };
      let delivery: TaskHistoryAttempt['delivery'] = null;
      let judgment: TaskHistoryAttempt['judgment'] = null;
      try {
        const rec = getPmDelivery(dataRoot, project, pmDeliveryIdFor(taskId, ref.runId));
        delivery = { deliveryId: rec.deliveryId, status: rec.status, deliveredAt: rec.deliveredAt };
        try {
          const j = getPmJudgment(dataRoot, project, pmJudgmentIdFor(rec.deliveryId));
          // V0 workspace shell: surface the durable CHANGES retry instruction
          // (pure read of the immutable intent payload; null when absent).
          let retryInstruction: string | undefined;
          if (j.decision === 'CHANGES') {
            try {
              retryInstruction = getRetryInstructionForDelivery(dataRoot, project, rec.deliveryId);
            } catch {
              retryInstruction = undefined;
            }
          }
          judgment = {
            judgmentId: j.judgmentId,
            decision: j.decision,
            status: j.status,
            reason: j.reason,
            ...(retryInstruction !== undefined ? { retryInstruction } : {}),
          };
        } catch {
          judgment = null; // delivery exists, judgment not submitted yet
        }
      } catch {
        delivery = null; // no delivery minted for this attempt yet
      }
      return {
        taskRunSequence: ref.taskRunSequence,
        runId: ref.runId,
        folder: ref.folder,
        agent: ref.agent,
        date: ref.date,
        folderExists,
        hasPrompt: folderExists && fileExists(path.join(ref.folder, 'prompt.md')),
        hasResult: folderExists && fileExists(path.join(ref.folder, 'result.md')),
        tags: meta.tags,
        delivery,
        judgment,
      };
    });

  const runIds = new Set(task.linkedRuns.map((r) => r.runId));
  const events: TaskHistoryEvent[] = listEvents(dataRoot, project, { taskId })
    .events.filter((e) => !e.runId || runIds.has(e.runId))
    .map((e) => ({
      eventId: e.eventId,
      type: e.type,
      severity: e.severity,
      occurredAt: e.occurredAt,
      ...(e.runId ? { runId: e.runId } : {}),
    }))
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  const evidence: TaskHistoryEvidence[] = listEvidenceForTask(dataRoot, project, taskId, true)
    .map((e) => ({
      evidenceId: e.evidenceId,
      type: e.type,
      trustLevel: e.trustLevel,
      status: e.status,
      ...(e.runId ? { runId: e.runId } : {}),
      summary: e.summary,
    }))
    .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));

  return { task, attempts, events, evidence };
}
