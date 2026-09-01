/**
 * Pure mapping Task/PM/Event → TUI activity label.
 * No timers pretending work.
 */

export function executionSymbol(state: string): string {
  switch (state) {
    case 'RUNNING': return '●';
    case 'DISPATCHED': return '◐';
    case 'READY': return '○';
    case 'RESULT_RECEIVED': return '◑';
    case 'PLANNED': return '·';
    case 'FAILED': return '✕';
    case 'BLOCKED': return '■';
    case 'CANCELLED': return '✕';
    default: return '·';
  }
}

export function pmSymbol(pmState: string): string {
  switch (pmState) {
    case 'PENDING': return '○';
    case 'VERIFYING': return '◑';
    case 'CHANGES_REQUESTED': return '↻';
    case 'ACCEPTED': return '✓';
    default: return '·';
  }
}

export function taskDisplaySymbol(executionState: string, pmState: string): string {
  if (pmState === 'ACCEPTED') return '✓';
  if (executionState === 'FAILED') return '✕';
  if (executionState === 'BLOCKED') return '■';
  if (executionState === 'RUNNING') return '●';
  if (executionState === 'DISPATCHED') return '◐';
  if (executionState === 'READY') return '○';
  if (executionState === 'RESULT_RECEIVED' && pmState === 'VERIFYING') return '◑';
  if (executionState === 'RESULT_RECEIVED') return '◑';
  return '·';
}

export function deriveWorkerActivity(
  workerId: string,
  activeTasks: Array<{ workerId?: string; executionState: string; pmState: string }>,
): string {
  // Find tasks bound to this worker
  const mine = activeTasks.filter((t) => t.workerId === workerId);
  if (mine.length === 0) {
    // Check global activeTasks for any RUNNING/DISPATCHED -> may be unassigned but overall busy
    const anyRunning = activeTasks.some((t) => t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED');
    if (anyRunning) return 'WORKING';
    const anyVerifying = activeTasks.some((t) => t.pmState === 'VERIFYING');
    if (anyVerifying) return 'VERIFYING';
    const anyBlocked = activeTasks.some((t) => t.executionState === 'BLOCKED');
    if (anyBlocked) return 'BLOCKED';
    const anyReady = activeTasks.some((t) => t.executionState === 'READY');
    if (anyReady) return 'READY';
    const anyResult = activeTasks.some((t) => t.executionState === 'RESULT_RECEIVED');
    if (anyResult) return 'RESULT';
    return 'IDLE';
  }
  // For bound worker, derive from its tasks
  const hasFailed = mine.some((t) => t.executionState === 'FAILED');
  if (hasFailed) return 'FAILED';
  const hasBlocked = mine.some((t) => t.executionState === 'BLOCKED');
  if (hasBlocked) return 'BLOCKED';
  const hasVerifying = mine.some((t) => t.pmState === 'VERIFYING');
  if (hasVerifying) return 'VERIFYING';
  const hasResult = mine.some((t) => t.executionState === 'RESULT_RECEIVED');
  if (hasResult) return 'RESULT';
  const hasWorking = mine.some((t) => t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED');
  if (hasWorking) return 'WORKING';
  const hasReady = mine.some((t) => t.executionState === 'READY');
  if (hasReady) return 'READY';
  return 'IDLE';
}

export function mapExecutionToActivity(executionState: string, pmState: string): string {
  if (executionState === 'READY') return 'READY';
  if (executionState === 'DISPATCHED' || executionState === 'RUNNING') return 'WORKING';
  if (executionState === 'RESULT_RECEIVED' && pmState === 'VERIFYING') return 'VERIFYING';
  if (executionState === 'RESULT_RECEIVED' && pmState === 'ACCEPTED') return 'DONE';
  if (executionState === 'RESULT_RECEIVED') return 'RESULT';
  if (executionState === 'FAILED') return 'FAILED';
  if (executionState === 'BLOCKED') return 'BLOCKED';
  if (executionState === 'PLANNED') return 'IDLE';
  return executionState || 'IDLE';
}
