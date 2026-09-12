/**
 * V2 slice-1 R2 CLI surface — guided recovery actions.
 *
 * `agent-relay resume act ...` maps one R1 finding to its blessed kernel
 * action via the R2 dispatcher. The dispatcher itself enforces the confirm
 * firewall (`confirmed` must be true); this module only translates CLI
 * input and renders the outcome. Conventions mirror history.ts.
 */
import { discoverConfig } from './config.js';
import { executeGuidedAction } from '../backend/resume-actions.js';
import type { StuckPattern } from '../backend/resume-scan.js';
import type { OrphanAction } from '../backend/orphan-resolution.js';

export const RESUME_SCHEMA_VERSION = 'cli.resume.v1';

export interface ResumeActOptions {
  pattern: string;
  taskId: string;
  runId?: string;
  preparationId?: string;
  orphanAction?: string;
  reason?: string;
  /** Set only after explicit Owner confirm (interactive prompt or --yes). */
  confirmed: boolean;
}

export interface ResumeActResult {
  schemaVersion: string;
  ok: boolean;
  executed?: boolean;
  pattern?: StuckPattern;
  taskId?: string;
  action?: string;
  summary?: string;
  details?: Record<string, unknown>;
  error?: string;
}

const PATTERNS: ReadonlySet<string> = new Set([
  'ORPHANED_DISPATCH',
  'UNRECOVERED_COMPLETED_RUN',
  'CRASHED_PREPARATION',
  'QA_GATE_STALLED',
  'MISSING_DELIVERY',
]);

const ORPHAN_ACTIONS: ReadonlySet<string> = new Set([
  'KEEP_WAITING',
  'CONFIRM_FAILED',
  'CONFIRM_CANCELLED',
]);

export function resumeActUsage(): string {
  return 'Usage: agent-relay resume act --task <TASK-ID> --pattern <PATTERN> [--run <RUN-ID>] [--prep <PREP-ID>] [--orphan-action <KEEP_WAITING|CONFIRM_FAILED|CONFIRM_CANCELLED>] [--reason <text>] [--yes] [--json]';
}

export async function runResumeAct(cwd: string, opts: ResumeActOptions): Promise<ResumeActResult> {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return { schemaVersion: RESUME_SCHEMA_VERSION, ok: false, error: 'not-initialized' };
  }
  if (!PATTERNS.has(opts.pattern)) {
    return {
      schemaVersion: RESUME_SCHEMA_VERSION, ok: false,
      error: `unknown pattern: ${opts.pattern} (expected one of ${[...PATTERNS].join(', ')})`,
    };
  }
  if (!opts.taskId) {
    return { schemaVersion: RESUME_SCHEMA_VERSION, ok: false, error: 'taskId가 필요합니다. (--task)' };
  }
  if (opts.pattern === 'ORPHANED_DISPATCH' && (!opts.orphanAction || !ORPHAN_ACTIONS.has(opts.orphanAction))) {
    return {
      schemaVersion: RESUME_SCHEMA_VERSION, ok: false,
      error: 'ORPHANED_DISPATCH에는 --orphan-action KEEP_WAITING|CONFIRM_FAILED|CONFIRM_CANCELLED이 필요합니다.',
    };
  }
  const { dataRoot, project } = discovered.config;
  try {
    const res = await executeGuidedAction(dataRoot, project, {
      pattern: opts.pattern as StuckPattern,
      taskId: opts.taskId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.preparationId ? { preparationId: opts.preparationId } : {}),
      ...(opts.orphanAction ? { orphanAction: opts.orphanAction as OrphanAction } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      confirmed: opts.confirmed,
    });
    return {
      schemaVersion: RESUME_SCHEMA_VERSION, ok: true,
      executed: res.executed, pattern: res.pattern, taskId: res.taskId,
      action: res.action, summary: res.summary,
      ...(res.details ? { details: res.details } : {}),
    };
  } catch (e) {
    return {
      schemaVersion: RESUME_SCHEMA_VERSION, ok: false,
      pattern: opts.pattern as StuckPattern, taskId: opts.taskId,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function renderResumeActHuman(res: ResumeActResult): string {
  if (!res.ok) return `resume act failed: ${res.error ?? 'unknown'}`;
  const flag = res.executed ? 'executed' : 'NOT executed';
  const lines = [
    `[${flag}] ${res.pattern} ${res.taskId ?? ''}`.trim(),
    `action: ${res.action ?? '—'}`,
    `summary: ${res.summary ?? '—'}`,
  ];
  if (res.details && Object.keys(res.details).length) {
    lines.push(`details: ${JSON.stringify(res.details)}`);
  }
  return lines.join('\n');
}
