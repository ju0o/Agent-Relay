/**
 * Phase I3F-1 — Memo History read-only subview.
 */

import type { MemoRecord } from '../../backend/task-memo.js';

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

const MAX_LIST = 20;
const PREVIEW_CHARS = 120;

export function renderMemoHistory(
  memos: MemoRecord[],
  taskId: string | undefined,
  size: { cols: number; rows: number },
): string {
  const cols = Math.max(20, size.cols);
  const inner = cols - 2;
  const lines: string[] = [];
  lines.push('┌' + '─'.repeat(inner) + '┐');
  lines.push('│' + center(`Memos ${taskId ?? ''}`.trim(), inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');

  if (memos.length === 0) {
    lines.push('│' + center('No memos yet.', inner) + '│');
    lines.push('│' + center('Press M on main to add one.', inner) + '│');
    lines.push('│' + ' '.repeat(inner) + '│');
    lines.push('├' + '─'.repeat(inner) + '┤');
    lines.push('│' + pad(' Esc:back  q:quit', inner) + '│');
    lines.push('└' + '─'.repeat(inner) + '┘');
    return lines.join('\n');
  }

  const bounded = memos.slice(0, MAX_LIST);
  // memos already newest-first from listMemos
  for (const m of bounded) {
    const preview = truncate(m.body.replace(/\s+/g, ' ').trim(), PREVIEW_CHARS);
    const header = `${m.noteId} · ${truncate(m.createdAt, 19)} · ${m.authorSurface}`;
    lines.push('│' + pad(truncate(header, inner - 1), inner) + '│');
    lines.push('│' + pad(`  ${truncate(preview, inner - 3)}`, inner) + '│');
    if (lines.length >= size.rows - 3) {
      lines.push('│' + center(`… ${memos.length - bounded.length} more — resize`, inner) + '│');
      break;
    }
  }

  if (memos.length > MAX_LIST) {
    lines.push('│' + center(`showing latest ${MAX_LIST} of ${memos.length}`, inner) + '│');
  }

  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(` Esc:back  q:quit  (${memos.length} total)`, inner) + '│');
  lines.push('└' + '─'.repeat(inner) + '┘');
  if (lines.length > size.rows) {
    lines.splice(size.rows - 1, lines.length - size.rows, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
}
