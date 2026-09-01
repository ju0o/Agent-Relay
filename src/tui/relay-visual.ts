/**
 * Phase I3E — Pure Relay visual derivation + animation.
 * No mutation, no persistence, snapshot in → visual out.
 */
import type { TuiSnapshot } from './snapshot.js';

export type RelayVisualState =
  | 'IDLE'
  | 'PROMPT_TRANSIT'
  | 'WORKING'
  | 'RESULT_TRANSIT'
  | 'VERIFYING'
  | 'CHANGES_REQUESTED'
  | 'ACCEPTED'
  | 'BLOCKED'
  | 'FAILED'
  | 'GOAL_COMPLETED';

const VALID_PROMPT_STATES = new Set(['TASK_DISPATCH_READY', 'DISPATCHED', 'RUNNING']);
const VALID_RESULT_STATES = new Set(['RUN_RESULT_RECEIVED', 'RESULT_RECEIVED', 'VERIFYING']);

export function isValidPromptVisualSource(snapshot: TuiSnapshot): boolean {
  // Check nextWork kind TASK_DISPATCH_READY
  const hasDispatchReady = !!(snapshot.status.nextWork?.items as any[])?.some(
    (it: any) => it.kind === 'TASK_DISPATCH_READY',
  );
  if (hasDispatchReady) return true;
  const active = snapshot.status.activeTasks ?? [];
  // DISPATCHED is explicit prompt transit; early RUNNING also qualifies
  if (active.some((t) => t.executionState === 'DISPATCHED')) return true;
  // early RUNNING considered prompt transit only if still DISPATCHED-like? we treat RUNNING as WORKING normally,
  // but spec allows early RUNNING to also be prompt transit — we allow it if task just became RUNNING
  // To keep pure, we consider DISPATCHED only for prompt transit, not RUNNING. RUNNING alone -> WORKING.
  return false;
}

export function isValidResultVisualSource(snapshot: TuiSnapshot): boolean {
  const active = snapshot.status.activeTasks ?? [];
  if (active.some((t) => t.executionState === 'RESULT_RECEIVED')) return true;
  // Also event-driven RUN_RESULT_RECEIVED marker via recentEvents (if type exists)
  const evs = snapshot.status.recentEvents ?? [];
  if (evs.some((e) => e.type === 'RUN_RESULT_RECEIVED')) return true;
  return false;
}

export function deriveRelayVisualState(snapshot: TuiSnapshot): RelayVisualState {
  // GOAL_COMPLETED highest
  if (snapshot.status.goal?.status === 'COMPLETED') return 'GOAL_COMPLETED';
  const active = snapshot.status.activeTasks ?? [];

  // Check for ACCEPTED (any task pmState ACCEPTED) -> priority after goal completed
  if (active.some((t) => t.pmState === 'ACCEPTED')) return 'ACCEPTED';

  if (active.some((t) => t.pmState === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';

  if (active.some((t) => t.executionState === 'FAILED')) return 'FAILED';
  if (active.some((t) => t.executionState === 'BLOCKED')) return 'BLOCKED';

  // VERIFYING: execution RESULT_RECEIVED + pm VERIFYING
  if (active.some((t) => t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING')) {
    return 'VERIFYING';
  }

  // RESULT_TRANSIT: execution RESULT_RECEIVED (but not already VERIFYING which returned above)
  // This handles RESULT_RECEIVED with pm PENDING or other, plus RUN_RESULT_RECEIVED event.
  // Only valid if source is valid result state.
  if (active.some((t) => t.executionState === 'RESULT_RECEIVED')) {
    // Guard: must be valid result visual source
    if (isValidResultVisualSource(snapshot)) return 'RESULT_TRANSIT';
  }
  // Also check event-only result without active task marker (rare)
  if (
    snapshot.status.recentEvents.some((e) => e.type === 'RUN_RESULT_RECEIVED') &&
    isValidResultVisualSource(snapshot)
  ) {
    return 'RESULT_TRANSIT';
  }

  // PROMPT_TRANSIT: valid prompt source
  if (isValidPromptVisualSource(snapshot)) return 'PROMPT_TRANSIT';
  // Also direct TASK_DISPATCH_READY via nextWork qualifies even without DISPATCHED task yet
  const hasDispatchReady = !!(snapshot.status.nextWork?.items as any[])?.some(
    (it: any) => it.kind === 'TASK_DISPATCH_READY',
  );
  if (hasDispatchReady) return 'PROMPT_TRANSIT';

  // WORKING: DISPATCHED / RUNNING (if not already prompt transit)
  // DISPATCHED already consumed as PROMPT_TRANSIT, so remaining WORKING is RUNNING
  // But spec 7 says DISPATCHED/RUNNING settled -> waiting WORKING, so if PROMPT_TRANSIT already handled
  // we still need WORKING for RUNNING. For DISPATCHED we treat as PROMPT_TRANSIT, not WORKING.
  if (active.some((t) => t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED')) {
    // If it was DISPATCHED it would have been PROMPT_TRANSIT, so here we return WORKING for RUNNING
    // However spec says WORKING derives from DISPATCHED/RUNNING — we honor both but prioritize PROMPT_TRANSIT
    // If we are here and still have DISPATCHED, it means PROMPT_TRANSIT condition not met? fallback to WORKING
    return 'WORKING';
  }

  // IDLE: no goal / no task
  if (!snapshot.status.goal || active.length === 0) {
    // If there are PLANNED tasks but not active, still IDLE-ish unless goal active?
    // Spec says when no Goal/Task -> Relay Ready
    const hasAnyTask = snapshot.status.taskCounts.total > 0;
    if (!snapshot.status.goal && !hasAnyTask) return 'IDLE';
    // If goal exists but tasks are PLANNED only, not active, still IDLE
    if (active.length === 0) return 'IDLE';
  }

  // Fallback IDLE
  return 'IDLE';
}

// Pure animation: given lane length and frameIndex, return position index 0..len-1
export function animationFramePosition(laneLen: number, frameIndex: number): number {
  if (laneLen <= 0) return 0;
  // deterministic cycle
  return ((frameIndex % laneLen) + laneLen) % laneLen;
}

// Build a lane string with moving marker at position
export function buildPromptLane(laneLen: number, pos: number, isResult: boolean): string {
  // isResult=false: marker ✉ moves left→right, arrow →
  // isResult=true: marker 📄 moves right→left, arrow ←
  const arr = new Array(laneLen).fill('-');
  const p = Math.max(0, Math.min(laneLen - 1, pos));
  if (!isResult) {
    arr[p] = '✉';
    return arr.join(' ') + ' →';
  } else {
    // reverse direction: pos 0 = near worker (right), pos max = near GPT (left)
    // We'll fill reversed: marker at p from right
    const revPos = laneLen - 1 - p;
    const rev = new Array(laneLen).fill('-');
    rev[revPos] = '📄';
    return '← ' + rev.join(' ');
  }
}
