/**
 * V2 slice-1 R2 — guided recovery actions behind explicit Owner confirmation.
 *
 * Each action reuses an existing kernel function (plan §3 invariants apply;
 * no new state transitions are invented here):
 *
 *   ORPHANED_DISPATCH      → orphan-resolution resolveOrphan
 *                              (KEEP_WAITING / CONFIRM_FAILED / CONFIRM_CANCELLED)
 *   UNRECOVERED_COMPLETED_RUN → completed-run-recovery recoverCompletedRunCapture
 *                              (manual trigger only — never automatic)
 *   CRASHED_PREPARATION (RTP-*) → retry-preparation reconcileRetryPreparationForJudgment
 *   CRASHED_PREPARATION (QRP-*) → NO blessed kernel path exists: refuse safely
 *                              (never invent a transition; flag to Owner)
 *   QA_GATE_STALLED        → qa-gate reconcileQaGate
 *   MISSING_DELIVERY       → pm-delivery ensurePmDeliveryForTaskVerify
 *                              (idempotent, but still confirm-gated per locked R2 rule)
 *
 * Confirm firewall: `confirmed` must be true or NOTHING executes — the throw
 * happens before any state is read for mutation. Surfaces (TUI/CLI) set it
 * only after an explicit Owner confirm, every time. A fresh scan validates
 * the finding is still present (stale findings return not-executed).
 */
import { getTask } from './goal-task.js';
import { getTaskHistory } from './task-history.js';
import { resolveOrphan } from './orphan-resolution.js';
import type { OrphanAction } from './orphan-resolution.js';
import { recoverCompletedRunCapture } from './completed-run-recovery.js';
import {
  getRetryPreparation,
  reconcileRetryPreparationForJudgment,
} from './retry-preparation.js';
import { reconcileQaGate } from './qa-gate.js';
import { ensurePmDeliveryForTaskVerify } from './pm-delivery.js';
import { scanStuckWork } from './resume-scan.js';
import type { StuckPattern } from './resume-scan.js';

export class GuidedActionError extends Error {
  readonly code: 'CONFIRM_REQUIRED' | 'INVALID_ARGUMENT';
  constructor(code: GuidedActionError['code'], message: string) {
    super(message);
    this.name = 'GuidedActionError';
    this.code = code;
  }
}

export interface GuidedActionRequest {
  pattern: StuckPattern;
  taskId: string;
  runId?: string;
  preparationId?: string;
  /** Required for ORPHANED_DISPATCH (Owner chooses — no default). */
  orphanAction?: OrphanAction;
  reason?: string;
  /**
   * MUST be true. Surfaces set this only after an explicit Owner confirm.
   * When false the call throws before touching any state.
   */
  confirmed: boolean;
}

export interface GuidedActionResult {
  executed: boolean;
  pattern: StuckPattern;
  taskId: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

const ORPHAN_ACTIONS: ReadonlySet<string> = new Set([
  'KEEP_WAITING',
  'CONFIRM_FAILED',
  'CONFIRM_CANCELLED',
]);

function stale(taskId: string, pattern: StuckPattern): GuidedActionResult {
  return {
    executed: false,
    pattern,
    taskId,
    action: 'none (stale finding)',
    summary: 'finding no longer present in a fresh scan — nothing executed',
  };
}

export async function executeGuidedAction(
  dataRoot: string,
  project: string,
  req: GuidedActionRequest,
): Promise<GuidedActionResult> {
  // ── Confirm firewall: before anything else, including reads-for-mutation.
  if (!req.confirmed) {
    throw new GuidedActionError(
      'CONFIRM_REQUIRED',
      `Owner confirmation required for ${req.pattern} on ${req.taskId} — nothing executed`,
    );
  }
  const taskId = (req.taskId || '').trim();
  if (!taskId) throw new GuidedActionError('INVALID_ARGUMENT', 'taskId가 필요합니다.');
  const reason = typeof req.reason === 'string' && req.reason.trim() ? req.reason.trim() : undefined;

  // ── Stale-finding guard: re-scan and require the finding to still apply.
  const fresh = scanStuckWork(dataRoot, project);
  const match = fresh.findings.find((f) =>
    f.pattern === req.pattern
    && f.taskId === taskId
    && (req.runId ? f.runId === req.runId : true)
    && (req.preparationId ? f.preparationId === req.preparationId : true),
  );
  if (!match) return stale(taskId, req.pattern);

  switch (req.pattern) {
    case 'ORPHANED_DISPATCH': {
      if (!req.orphanAction || !ORPHAN_ACTIONS.has(req.orphanAction)) {
        throw new GuidedActionError(
          'INVALID_ARGUMENT',
          'ORPHANED_DISPATCH에는 Owner 선택 orphanAction(KEEP_WAITING/CONFIRM_FAILED/CONFIRM_CANCELLED)이 필요합니다.',
        );
      }
      const res = await resolveOrphan({
        dataRoot, project, taskId,
        action: req.orphanAction as OrphanAction,
        callerSurface: 'OWNER_IPC',
        ...(reason ? { reason } : {}),
      });
      return {
        executed: true, pattern: req.pattern, taskId,
        action: `resolveOrphan:${res.action}`,
        summary: res.message,
        details: { executionState: res.executionState, recoveryCleared: res.recoveryCleared, dispatchBlocked: res.dispatchBlocked },
      };
    }

    case 'UNRECOVERED_COMPLETED_RUN': {
      if (!req.runId) throw new GuidedActionError('INVALID_ARGUMENT', 'UNRECOVERED_COMPLETED_RUN에는 runId가 필요합니다.');
      const res = await recoverCompletedRunCapture({
        dataRoot, project, taskId, runId: req.runId, callerSurface: 'OWNER_IPC',
      });
      return {
        executed: res.status === 'RECOVERED' || res.status === 'ALREADY_CAPTURED',
        pattern: req.pattern, taskId,
        action: 'recoverCompletedRunCapture',
        summary: `${res.status}: ${res.reason}`,
        details: { status: res.status, resultCaptured: res.resultCaptured, ...(res.deliveryId ? { deliveryId: res.deliveryId } : {}) },
      };
    }

    case 'CRASHED_PREPARATION': {
      if (!req.preparationId) throw new GuidedActionError('INVALID_ARGUMENT', 'CRASHED_PREPARATION에는 preparationId가 필요합니다.');
      if (req.preparationId.startsWith('QRP-')) {
        // No kernel function advances a QRP out of RECEIVED — refuse rather
        // than invent a transition. Owner decision needed (future kernel scope).
        return {
          executed: false, pattern: req.pattern, taskId,
          action: 'refused: no blessed kernel path',
          summary: `QRP ${req.preparationId} has no advancing kernel function — refusing instead of inventing a transition`,
        };
      }
      const prep = getRetryPreparation(dataRoot, project, req.preparationId);
      const res = await reconcileRetryPreparationForJudgment(dataRoot, project, prep.deliveryId);
      return {
        executed: true, pattern: req.pattern, taskId,
        action: 'reconcileRetryPreparationForJudgment',
        summary: `preparation ${res.preparation.preparationId} → ${res.preparation.status}`,
        details: { preparationId: res.preparation.preparationId, status: res.preparation.status },
      };
    }

    case 'QA_GATE_STALLED': {
      const res = await reconcileQaGate(dataRoot, project, taskId);
      return {
        executed: true, pattern: req.pattern, taskId,
        action: 'reconcileQaGate',
        summary: `gate reconciled for ${taskId}`,
        details: JSON.parse(JSON.stringify(res)) as Record<string, unknown>,
      };
    }

    case 'MISSING_DELIVERY': {
      const rec = await ensurePmDeliveryForTaskVerify(dataRoot, project, taskId);
      if (!rec) {
        return {
          executed: false, pattern: req.pattern, taskId,
          action: 'ensurePmDeliveryForTaskVerify',
          summary: 'kernel returned no delivery (state moved under us) — nothing executed',
        };
      }
      return {
        executed: true, pattern: req.pattern, taskId,
        action: 'ensurePmDeliveryForTaskVerify',
        summary: `delivery ${rec.deliveryId} (${rec.status})`,
        details: { deliveryId: rec.deliveryId, status: rec.status },
      };
    }

    default:
      throw new GuidedActionError('INVALID_ARGUMENT', `알 수 없는 패턴: ${String(req.pattern)}`);
  }
}
