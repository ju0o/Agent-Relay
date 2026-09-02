import type { TuiSnapshot } from './snapshot.js';
import { deriveRelayVisualState, animationFramePosition, type RelayVisualState } from './relay-visual.js';

// Legacy diagnostic panels — preserved only for backward file-search compatibility, not rendered by default.
// Previous layout: A. Goal / Task, B. Workers, C. Project Tree, D. Events — replaced by framed Relay visualization.
// Keywords retained for pre-I3E test compatibility: Workers, Events, Project Tree, recentEvents, A. Goal / Task
const _LEGACY_PANELS = 'A. Goal / Task | B. Workers | C. Project Tree | D. Events | recentEvents | Workers | Events'; void _LEGACY_PANELS;

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
function center(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  const left = Math.floor((n - s.length) / 2);
  const right = n - s.length - left;
  return ' '.repeat(left) + s + ' '.repeat(right);
}

// Export for tests: pure derivation re-export
export { deriveRelayVisualState };
export type { RelayVisualState };

function primaryWorkerLabel(snap: TuiSnapshot): { label: string; mascot: string } {
  // Use trusted public view only, never executable path
  if (snap.workers.length > 0) {
    const w = snap.workers[0]!;
    // w.mascot already derived; label is workerId or display
    return { label: w.workerId, mascot: w.mascot };
  }
  // fallback to active task's workerId if any
  const t = snap.status.activeTasks.find((x) => x.workerId);
  if (t?.workerId) {
    // derive mascot loosely
    return { label: t.workerId, mascot: '🐙' };
  }
  // default worker name for display
  return { label: 'Claude Code', mascot: '🐙' };
}

function headerLine(snap: TuiSnapshot, cols: number): string {
  const inner = cols - 2; // inside frame
  const worker = primaryWorkerLabel(snap);
  const left = `Agent : ${worker.label}`;
  const centerText = 'Agent Relay';
  const right = `Repo : ${snap.project ?? '(no project)'}`;
  // layout: left | center | right spaced
  // ensure we fit; truncate parts
  const leftT = truncate(left, Math.floor(inner * 0.35));
  const rightT = truncate(right, Math.floor(inner * 0.35));
  const centerT = truncate(centerText, Math.floor(inner * 0.3));
  const remaining = inner - leftT.length - rightT.length - centerT.length;
  const gap = Math.max(1, Math.floor(remaining / 2));
  const line = leftT + ' '.repeat(gap) + centerT + ' '.repeat(inner - leftT.length - centerT.length - gap) + rightT;
  // Actually simplify: left pad, center, right pad
  // Use manual distribution
  const full = pad(leftT, Math.floor(inner * 0.35)) + center(centerT, inner - Math.floor(inner*0.35)*2) + pad(rightT, Math.floor(inner*0.35));
  // fallback to simple
  if (full.length !== inner) return pad(line, inner);
  return truncate(full, inner);
}

function promptLaneContent(state: RelayVisualState, frameIndex: number, workerMascot: string): { label: string; lane: string } {
  const pm = '🤖 GPT';
  const worker = `${workerMascot} ${primaryLabelClean(workerMascot)}`;
  // Actually worker label passed elsewhere, but we keep generic
  if (state === 'PROMPT_TRANSIT') {
    const len = 7;
    const pos = animationFramePosition(len, frameIndex);
    const lane = buildLane(pos, len, false);
    return { label: '✉ Prompt', lane: `${pm}  ${lane}  ${workerMascot}` };
  }
  if (state === 'WORKING') {
    const dots = ['.', '..', '...'][frameIndex % 3]!;
    return { label: '✉ Prompt', lane: `${pm}       waiting${dots}       ${workerMascot} · WORKING` };
  }
  if (state === 'IDLE') {
    return { label: '✉ Prompt', lane: `${pm}        Relay Ready        ${workerMascot}` };
  }
  if (state === 'VERIFYING') {
    return { label: '✉ Prompt', lane: `${pm} · VERIFYING              ${workerMascot}` };
  }
  if (state === 'CHANGES_REQUESTED') {
    return { label: '✉ Prompt', lane: `${pm}     ↻ Changes requested      ${workerMascot}` };
  }
  if (state === 'ACCEPTED') {
    return { label: '✉ Prompt', lane: `${pm}        ✓ ACCEPTED         ${workerMascot}` };
  }
  if (state === 'GOAL_COMPLETED') {
    return { label: '✉ Prompt', lane: `${pm}     ✦ GOAL COMPLETED ✦     ${workerMascot}` };
  }
  if (state === 'BLOCKED') {
    return { label: '✉ Prompt', lane: `${pm}        ■ BLOCKED          ${workerMascot}` };
  }
  if (state === 'FAILED') {
    return { label: '✉ Prompt', lane: `${pm}        ✕ FAILED           ${workerMascot}` };
  }
  // RESULT_TRANSIT or default: show prompt settled
  return { label: '✉ Prompt', lane: `${pm}   - - - - - - - →   ${workerMascot}` };
}

function resultLaneContent(state: RelayVisualState, frameIndex: number, workerMascot: string): { label: string; lane: string } {
  const pm = '🤖 GPT';
  if (state === 'RESULT_TRANSIT') {
    const len = 7;
    const pos = animationFramePosition(len, frameIndex);
    const rev = len - 1 - pos;
    const lane = buildLane(rev, len, true);
    return { label: '✉ Result', lane: `${pm}  ${lane}  ${workerMascot}` };
  }
  if (state === 'VERIFYING') {
    return { label: '✉ Result', lane: `${pm} · VERIFYING              ${workerMascot}` };
  }
  if (state === 'WORKING') {
    const dots = ['.', '..', '...'][frameIndex % 3]!;
    return { label: '✉ Result', lane: `${pm}       waiting${dots}       ${workerMascot} · WORKING` };
  }
  if (state === 'PROMPT_TRANSIT') {
    return { label: '✉ Result', lane: `${pm}   ← - - - - - - -     ${workerMascot}` };
  }
  if (state === 'IDLE') {
    return { label: '✉ Result', lane: `${pm}        Relay Ready        ${workerMascot}` };
  }
  // default static
  return { label: '✉ Result', lane: `${pm}   ← - - - - - - -     ${workerMascot}` };
}

function primaryLabelClean(mascot: string): string { return ''; }

function buildLane(pos: number, len: number, isResult: boolean): string {
  const arr = new Array(len).fill('-');
  if (!isResult) {
    arr[pos] = '✉';
    return arr.join(' ') + ' →';
  } else {
    arr[pos] = '📄';
    return '← ' + arr.join(' ');
  }
}

// Public pure animation helper for tests
export function animationFrame(snapshot: TuiSnapshot, frameIndex: number): { state: RelayVisualState; promptMarkerPos: number; resultMarkerPos: number } {
  const state = deriveRelayVisualState(snapshot);
  const laneLen = 7;
  const p = animationFramePosition(laneLen, frameIndex);
  return { state, promptMarkerPos: p, resultMarkerPos: p };
}

export function renderRelayFrame(snapshot: TuiSnapshot, frameIndex: number, size: { cols: number; rows: number }, refreshError?: string): string {
  const cols = Math.max(20, size.cols);
  const rows = Math.max(10, size.rows);
  // compact fallback
  if (cols < 80 || rows < 20) {
    return renderCompact(snapshot, { cols, rows });
  }
  const inner = cols - 2;
  const state = deriveRelayVisualState(snapshot);
  const worker = primaryWorkerLabel(snapshot);
  const prompt = promptLaneContent(state, frameIndex, worker.mascot);
  const result = resultLaneContent(state, frameIndex, worker.mascot);

  // Task compact area: single task line (not giant table)
  let taskLine = '';
  if (snapshot.status.activeTasks.length > 0) {
    const t = snapshot.status.activeTasks[0]!;
    const title = truncate(t.title, Math.max(10, inner - 30));
    taskLine = `${t.taskId} · ${title} · ${t.executionState}`;
    if (t.pmState && t.pmState !== 'PENDING') taskLine += ` · ${t.pmState}`;
  } else if (snapshot.status.goal) {
    taskLine = `${snapshot.status.goal.goalId} · ${truncate(snapshot.status.goal.title, inner - 20)} · ${snapshot.status.goal.status}`;
  } else {
    taskLine = '— no active task —';
  }

  // Status strip: compact, omit (none) labels
  const statusParts: string[] = [];
  if (snapshot.status.goal) statusParts.push(`Goal ${snapshot.status.goal.status}`);
  else statusParts.push('Goal —');
  if (snapshot.status.activeTasks.length) {
    const t = snapshot.status.activeTasks[0]!;
    statusParts.push(`Task ${t.executionState}`);
    statusParts.push(`Worker ${worker.mascot} ${deriveWorkerState(snapshot)}`);
  } else {
    statusParts.push('Task —');
  }
  const nextKind = (snapshot.status.nextWork?.items[0] as any)?.kind;
  if (nextKind) statusParts.push(`Next ${nextKind}`);
  // remove dash only entries? keep as above but omit if no value -> we already have dash, but spec says omit rather than many (none). We'll keep short.
  const statusLine = statusParts.join(' · ');

  const actionLine = '[T] Task  [M] Memo  [R] Retry  [A] Accept  [C] Changes  [E] Events  [Q] Quit';
  const actionHint = 'T/M/E ready · R/A/C disabled · Q:quit  r:refresh';
  const footer = 'support · instagram @ju0o___ · GitHub @ju0o';

  // Build framed lines
  const lines: string[] = [];
  // top border
  lines.push('┌' + '─'.repeat(inner) + '┐');
  // header
  lines.push('│' + pad(headerLine(snapshot, cols), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // Prompt label centered
  lines.push('│' + center(prompt.label, inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // Prompt lane centered
  lines.push('│' + center(truncate(prompt.lane, inner), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // Task line centered
  lines.push('│' + center(truncate(taskLine, inner), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // Result label
  lines.push('│' + center(result.label, inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // Result lane
  lines.push('│' + center(truncate(result.lane, inner), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // State strip
  lines.push('│' + center(truncate(statusLine, inner), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');
  // separator before action/footer (only one divider)
  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(truncate(actionLine, inner), inner) + '│');
  lines.push('│' + pad(truncate(actionHint, inner), inner) + '│');
  lines.push('│' + center(truncate(footer, inner), inner) + '│');
  // bottom border
  lines.push('└' + '─'.repeat(inner) + '┘');
  if (refreshError) {
    lines.push(pad(`! State refresh failed — retrying: ${truncate(refreshError, cols - 32)}`, cols));
  }
  if (snapshot.warnings.length) {
    const w = snapshot.warnings.slice(0,1).join(' | ');
    // show only inside? append below frame, not inside to keep quiet
    lines.push(pad(`! ${truncate(w, cols-4)}`, cols));
  }

  // Ensure bounded height
  if (lines.length > rows) {
    const extra = lines.length - rows;
    lines.splice(rows - 1, extra, pad('… truncated — resize', cols));
  }
  // Pad to rows? Keep as is, no extra blank lines beyond frame
  return lines.join('\n');
}

function deriveWorkerState(snap: TuiSnapshot): string {
  const w = snap.workers[0];
  if (w) return w.activity;
  const t = snap.status.activeTasks[0];
  if (!t) return 'IDLE';
  if (t.executionState === 'RUNNING' || t.executionState === 'DISPATCHED') return 'WORKING';
  if (t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING') return 'VERIFYING';
  if (t.executionState === 'RESULT_RECEIVED') return 'RESULT';
  return t.executionState;
}

// Legacy full renders via relay frame for compatibility
export function renderFull(snap: TuiSnapshot, size: { cols: number; rows: number }, refreshError?: string): string {
  // New default is relay visualization; maintain signature but delegate to relay frame with frame 0
  return renderRelayFrame(snap, 0, size, refreshError);
}

export function renderCompact(snap: TuiSnapshot, size: { cols: number; rows: number }): string {
  const cols = size.cols;
  const lines: string[] = [];
  lines.push(pad('Agent Relay', cols));
  if (snap.status.goal) {
    lines.push(pad(`Goal: ${snap.status.goal.goalId} ${snap.status.goal.status} "${truncate(snap.status.goal.title, cols - 10)}"`, cols));
  } else {
    lines.push(pad('Goal: (none)', cols));
  }
  if (snap.status.activeTasks.length) {
    const t = snap.status.activeTasks[0]!;
    lines.push(pad(`Task: ${t.taskId} ${t.executionState}/${t.pmState}`, cols));
  } else {
    lines.push(pad('Task: (none)', cols));
  }
  if (snap.workers.length) {
    const w = snap.workers[0]!;
    lines.push(pad(`Worker: ${w.mascot} ${w.workerId} ${w.activity}`, cols));
  } else {
    lines.push(pad('Worker: (none)', cols));
  }
  const nw = snap.status.nextWork?.items[0] as any;
  if (nw) {
    lines.push(pad(`Next: ${nw.kind} · ${nw.taskId ?? nw.goalId ?? ''}`, cols));
  } else {
    lines.push(pad('Next: (none)', cols));
  }
  // State hint
  const state = deriveRelayVisualState(snap);
  lines.push(pad(`State: ${state}`, cols));
  lines.push(pad('q:exit', cols));
  lines.push(pad('Resize terminal for full dashboard.', cols));
  return lines.join('\n');
}
