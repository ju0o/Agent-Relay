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

export function renderResumeScanView(
  report: ResumeScanResult | null,
  size: { cols: number; rows: number },
  error?: string,
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
    lines.push('│' + pad(truncate(` findings:${report.findings.length}  tasks:${report.scannedTasks}`, inner), inner) + '│');
    lines.push('│' + ' '.repeat(inner) + '│');
    for (const it of report.findings.slice(0, MAX_ITEMS)) {
      lines.push('│' + pad(truncate(`[${it.pattern}] ${it.taskId}`, inner), inner) + '│');
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

  lines.push('├' + '─'.repeat(inner) + '┤');
  lines.push('│' + pad(' Esc:back  q:quit  r:refresh  (no actions)', inner) + '│');
  lines.push('└' + '─'.repeat(inner) + '┘');
  if (lines.length > size.rows) {
    lines.splice(size.rows - 1, lines.length - size.rows, pad('… truncated — resize', cols));
  }
  return lines.join('\n');
}
