/**
 * V2 R1 — Resume scan read-only subview (TUI).
 */
import type { ResumeScanResult } from '../../backend/resume-scan.js';

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}
function center(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  const left = Math.floor((n - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - s.length - left);
}

const MAX_ITEMS = 8;

export interface ResumeScanUi {
  selected?: number;
  confirmPrompt?: string;
}

export function renderResumeScanView(
  report: ResumeScanResult | null,
  size: { cols: number; rows: number },
  error?: string,
  ui?: ResumeScanUi,
): string {
  const cols = Math.max(20, size.cols);
  const inner = cols - 2;
  const lines: string[] = [];
  lines.push('┌' + '─'.repeat(inner) + '┐');
  lines.push('│' + center('Resume scan (read-only)', inner) + '│');
  lines.push('│' + ' '.repeat(inner) + '│');

  if (error) {
    lines.push('│' + pad(truncate(` error: ${error}`, inner), inner) + '│');
  } else if (!report) {
    lines.push('│' + center('No scan yet.', inner) + '│');
  } else if (report.findings.length === 0) {
    lines.push('│' + center('No stuck patterns detected.', inner) + '│');
    lines.push('│' + pad(truncate(` tasks scanned: ${report.scannedTasks}`, inner), inner) + '│');
  } else {
    const sel = ui?.selected ?? -1;
    lines.push('│' + pad(truncate(` findings:${report.findings.length}  tasks:${report.scannedTasks}`, inner), inner) + '│');
    lines.push('│' + ' '.repeat(inner) + '│');
    const items = report.findings.slice(0, MAX_ITEMS);
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const marker = i === sel ? '>' : ' ';
      lines.push('│' + pad(truncate(`${marker}${i + 1} [${it.pattern}] ${it.taskId}`, inner), inner) + '│');
      lines.push('│' + pad(truncate(`  ${it.detail}`, inner), inner) + '│');
      lines.push('│' + pad(truncate(`  → ${it.blessedAction}`, inner), inner) + '│');
      if (lines.length >= size.rows - 4) {
        lines.push('│' + center('… more — resize', inner) + '│');
        break;
      }
    }
    if (report.findings.length > MAX_ITEMS) {
      lines.push('│' + center(`showing ${MAX_ITEMS} of ${report.findings.length}`, inner) + '│');
    }
  }

  if (ui?.confirmPrompt && lines.length < size.rows - 3) {
    lines.push('│' + pad(truncate(` ? ${ui.confirmPrompt}`, inner), inner) + '│');
  }

  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(' Esc:back  q:quit  r:refresh  1-8:select  x:act  k/f/c:orphan', inner) + '│');
  lines.push('└' + '─'.repeat(inner) + '┘');
  if (lines.length > size.rows) {
    lines.splice(size.rows - 1, lines.length - size.rows, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
}
