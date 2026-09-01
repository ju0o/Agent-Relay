import type { TuiSnapshot } from './snapshot.js';
import { executionSymbol, taskDisplaySymbol, mapExecutionToActivity } from './mapping.js';

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export function renderFull(snap: TuiSnapshot, size: { cols: number; rows: number }, refreshError?: string): string {
  const cols = Math.max(10, size.cols);
  // Build four panels as strings
  const goalPanel = renderGoalPanel(snap, cols);
  const workerPanel = renderWorkerPanel(snap, cols);
  const treePanel = renderTreePanel(snap, cols);
  const eventsPanel = renderEventsPanel(snap, cols);
  const nextLine = renderNextWork(snap, cols);

  // Layout: simple stacked with separators; 4 panels boxed via lines
  const lines: string[] = [];
  lines.push(pad(` Agent Relay — ${snap.project ?? '(no project)'}  ${snap.workspaceRoot ?? ''}`, cols));
  lines.push('─'.repeat(cols));
  // Goal panel
  lines.push(...splitAndPad(goalPanel, cols));
  lines.push('─'.repeat(cols));
  // Workers
  lines.push(...splitAndPad(workerPanel, cols));
  lines.push('─'.repeat(cols));
  // Tree
  lines.push(...splitAndPad(treePanel, cols));
  lines.push('─'.repeat(cols));
  // Events
  lines.push(...splitAndPad(eventsPanel, cols));
  lines.push('─'.repeat(cols));
  lines.push(...splitAndPad(nextLine, cols));
  lines.push('─'.repeat(cols));
  if (refreshError) {
    lines.push(pad(`! State refresh failed — retrying: ${truncate(refreshError, cols - 30)}`, cols));
  }
  if (snap.warnings.length) {
    lines.push(pad(`Warnings: ${snap.warnings.slice(0, 2).map((w) => truncate(w, 30)).join(' | ')}`, cols));
  }
  lines.push(pad('q:exit  Ctrl-C:exit  r:refresh  Tab:focus', cols));
  // Ensure bounded height: trim to rows
  if (lines.length > size.rows) {
    const extra = lines.length - size.rows;
    lines.splice(size.rows - 1, extra, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
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
  // Worker
  if (snap.workers.length) {
    const w = snap.workers[0]!;
    lines.push(pad(`Worker: ${w.mascot} ${w.workerId} ${w.activity}`, cols));
  } else {
    lines.push(pad('Worker: (none)', cols));
  }
  // Next
  const nw = snap.status.nextWork?.items[0] as any;
  if (nw) {
    lines.push(pad(`Next: ${nw.kind} · ${nw.taskId ?? nw.goalId ?? ''}`, cols));
  } else {
    lines.push(pad('Next: (none)', cols));
  }
  lines.push(pad('Resize terminal for full dashboard.', cols));
  return lines.join('\n');
}

function splitAndPad(text: string, cols: number): string[] {
  return text.split('\n').map((l) => pad(truncate(l, cols), cols));
}

function renderGoalPanel(snap: TuiSnapshot, cols: number): string {
  const lines: string[] = [];
  lines.push('A. Goal / Task');
  if (snap.status.goal) {
    const g = snap.status.goal;
    lines.push(` ${g.goalId}  ${g.status}  Permission:${g.permissionMode}`);
    lines.push(` ${truncate(g.title, cols - 2)}`);
  } else {
    lines.push(' (no goal)');
  }
  lines.push('');
  if (snap.status.activeTasks.length === 0) {
    lines.push(' Tasks: (none)');
  } else {
    for (const t of snap.status.activeTasks.slice(0, 8)) {
      const sym = taskDisplaySymbol(t.executionState, t.pmState);
      const shortTitle = truncate(t.title, Math.max(10, cols - 28));
      lines.push(` ${t.taskId}  ${sym} ${pad(t.executionState, 12)} ${pad(t.pmState, 14)} ${shortTitle}`);
    }
    if (snap.status.activeTasks.length > 8) lines.push(` ... +${snap.status.activeTasks.length - 8} more`);
  }
  return lines.join('\n');
}

function renderWorkerPanel(snap: TuiSnapshot, cols: number): string {
  const lines: string[] = [];
  lines.push('B. Workers');
  if (snap.workers.length === 0) {
    lines.push(' (no workers)');
  } else {
    for (const w of snap.workers.slice(0, 6)) {
      lines.push(` ${w.mascot} ${pad(w.workerId, 18)} ${pad(w.adapter, 14)} ${w.activity}`);
    }
    if (snap.workers.length > 6) lines.push(` ... +${snap.workers.length - 6} more`);
  }
  return lines.join('\n');
}

function renderTreePanel(snap: TuiSnapshot, cols: number): string {
  const lines: string[] = [];
  lines.push('C. Project Tree');
  if (!snap.tree.length) {
    lines.push(' (empty)');
  } else {
    function walk(nodes: any[], prefix: string) {
      for (const n of nodes) {
        const icon = n.isDir ? '📁' : '  ';
        const name = truncate(n.name, cols - prefix.length - 4);
        lines.push(`${prefix}${icon} ${name}`);
        if (n.children && lines.length < 20) {
          walk(n.children, prefix + '  ');
        }
      }
    }
    walk(snap.tree, ' ');
    if (snap.treeTruncated) {
      const more = Math.max(0, snap.treeTotal - 50);
      lines.push(` ... +${more} more`);
    }
  }
  return lines.join('\n');
}

function renderEventsPanel(snap: TuiSnapshot, cols: number): string {
  const lines: string[] = [];
  lines.push('D. Events');
  const evs = snap.status.recentEvents.slice(0, 10);
  if (evs.length === 0) {
    lines.push(' (no events)');
  } else {
    for (const ev of evs) {
      const time = ev.eventId?.slice(0, 5) ?? '';
      // Use summary truncated, include type
      const type = pad(ev.type, 22);
      const summary = truncate(ev.summary, Math.max(10, cols - 32));
      lines.push(` ${type} ${summary}`);
      // time prefix optional if we had timestamp; using recordedAt? status doesn't store time, so show eventId
    }
  }
  return lines.join('\n');
}

function renderNextWork(snap: TuiSnapshot, cols: number): string {
  const nw = snap.status.nextWork;
  if (!nw || nw.items.length === 0) return 'Next: (none)';
  const first = nw.items[0] as any;
  const kind = first.kind ?? 'UNKNOWN';
  const id = first.taskId ?? first.goalId ?? '';
  return `Next: ${kind} · ${id}`;
}
