/**
 * Phase I3F-1 — Events read-only subview.
 */

import type { EventRecord } from '../../shared/types.js';

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
  return ' '.repeat(left) + s + ' '.repeat(n - s.length - left);
}

const MAX_EVENTS = 20;

export function renderEventsView(
  events: EventRecord[],
  size: { cols: number; rows: number },
): string {
  const cols = Math.max(20, size.cols);
  const inner = cols - 2;
  const lines: string[] = [];
  lines.push('┌' + '─'.repeat(inner) + '┐');
  lines.push('│' + center('Events', inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');

  if (events.length === 0) {
    lines.push('│' + center('No events yet.', inner) + '│');
    lines.push('│' + ' '.repeat(inner) + '│');
    lines.push('├' + '─'.repeat(inner) + '┤');
    lines.push('│' + pad(' Esc:back  q:quit', inner) + '│');
    lines.push('└' + '─'.repeat(inner) + '┘');
    return lines.join('\n');
  }

  // Sort deterministic: recordedAt desc then eventId
  const sorted = [...events].sort((a, b) => {
    if (b.recordedAt !== a.recordedAt) return b.recordedAt.localeCompare(a.recordedAt);
    return a.eventId.localeCompare(b.eventId);
  });
  const bounded = sorted.slice(0, MAX_EVENTS);

  for (const ev of bounded) {
    const linkage = [ev.goalId, ev.taskId, ev.runId].filter(Boolean).join(' / ') || '';
    const header = `${ev.eventId} ${ev.type} ${ev.severity}`;
    const summary = truncate(ev.summary.replace(/\s+/g, ' ').trim(), inner - 4);
    const metaParts = [
      ev.source.kind,
      ev.occurredAt.slice(0, 19),
      ev.pmAttention.required ? 'PM:required' : 'PM:—',
      linkage ? truncate(linkage, 20) : '',
    ].filter(Boolean);
    const meta = truncate(metaParts.join(' · '), inner - 4);

    lines.push('│' + pad(truncate(header, inner - 1), inner) + '│');
    lines.push('│' + pad(`  ${summary}`, inner) + '│');
    lines.push('│' + pad(`  ${meta}`, inner) + '│');
    if (lines.length >= size.rows - 4) {
      lines.push('│' + center(`… ${events.length - bounded.length} more — resize`, inner) + '│');
      break;
    }
  }

  if (events.length > MAX_EVENTS) {
    lines.push('│' + center(`showing latest ${MAX_EVENTS} of ${events.length}`, inner) + '│');
  }

  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(` Esc:back  q:quit  (${events.length} total)`, inner) + '│');
  lines.push('└' + '─'.repeat(inner) + '┘');
  if (lines.length > size.rows) {
    lines.splice(size.rows - 1, lines.length - size.rows, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
}
