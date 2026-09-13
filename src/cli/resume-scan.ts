/**
 * V2 R1 CLI — read-only Resume scan.
 *
 * Reuses `scanStuckWork` directly (same read model as TUI). Conventions
 * mirror history.ts / status.ts (schemaVersion, --json).
 */
import { discoverConfig } from './config.js';
import { scanStuckWork } from '../backend/resume-scan.js';
import type { ResumeScanResult } from '../backend/resume-scan.js';

export const RESUME_SCAN_SCHEMA_VERSION = 'cli.resume-scan.v1';

export interface ResumeScanCliResult {
  schemaVersion: string;
  ok: boolean;
  dataRoot?: string;
  project?: string;
  report?: ResumeScanResult;
  error?: string;
}

export function runResumeScan(cwd: string): ResumeScanCliResult {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return { schemaVersion: RESUME_SCAN_SCHEMA_VERSION, ok: false, error: 'not-initialized' };
  }
  const { dataRoot, project } = discovered.config;
  try {
    const report = scanStuckWork(dataRoot, project);
    return {
      schemaVersion: RESUME_SCAN_SCHEMA_VERSION,
      ok: true,
      dataRoot,
      project,
      report,
    };
  } catch (e) {
    return {
      schemaVersion: RESUME_SCAN_SCHEMA_VERSION,
      ok: false,
      dataRoot,
      project,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function renderResumeScanHuman(res: ResumeScanCliResult): string {
  if (!res.ok || !res.report) return `resume-scan failed: ${res.error ?? 'unknown'}`;
  const r = res.report;
  const lines: string[] = [
    `Resume scan — project ${r.project}`,
    `tasks scanned: ${r.scannedTasks}  findings: ${r.findings.length}`,
    '',
  ];
  if (r.findings.length === 0) {
    lines.push('(no stuck / interrupted patterns detected)');
    return lines.join('\n');
  }
  for (const it of r.findings) {
    lines.push(`[${it.pattern}] ${it.taskId}${it.runId ? ` run=${it.runId.slice(0, 8)}` : ''}${it.preparationId ? ` prep=${it.preparationId}` : ''}`);
    lines.push(`  ${it.detail}`);
    lines.push(`  blessedAction: ${it.blessedAction}`);
    lines.push('');
  }
  lines.push('Note: report only — no actions executed (R2 not authorized).');
  return lines.join('\n');
}
