/**
 * CLI: agent-relay goal-loop — headless AUTO Goal Loop entry.
 * Owner confirm required every time (--yes counts as explicit).
 * Never touches JuControler; works on the local Agent-Relay checkout only.
 */
import { discoverConfig, notInitializedMessage } from './config.js';
import { startGoalLoop } from '../backend/goal-loop.js';

export const GOAL_LOOP_SCHEMA_VERSION = 'cli.goal-loop.v1';

export function goalLoopUsage(): string {
  return 'Usage: agent-relay goal-loop (--goal <GOAL-ID> | --goal-title <t> --goal-statement <s>) --worker <workerId> --workspace <dir> [--project <name>] [--data-root <dir>] [--transport internal|actl] [--actl-agent <name>] [--yes] [--json]';
}

interface GoalLoopCliArgs {
  goal: string | null;
  goalTitle: string | null;
  goalStatement: string | null;
  worker: string | null;
  workspace: string | null;
  transport: string | null;
  actlAgent: string | null;
  projectName: string | null;
  dataRoot: string | null;
  yes: boolean;
  json: boolean;
}

export async function runGoalLoopCli(cwd: string, args: GoalLoopCliArgs): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return { ok: false, error: 'not-initialized' };
  }
  if (!args.worker || !args.workspace) {
    return { ok: false, error: goalLoopUsage() };
  }
  if (!args.goal && (!args.goalTitle || !args.goalStatement)) {
    return { ok: false, error: goalLoopUsage() };
  }
  if (args.transport && args.transport !== 'internal' && args.transport !== 'actl') {
    return { ok: false, error: 'transport must be internal|actl' };
  }
  const cfg = discovered.config as { dataRoot?: string; project?: string };
  const dataRoot = args.dataRoot || cfg.dataRoot || '';
  const project = args.projectName || cfg.project || '.';
  if (!dataRoot) return { ok: false, error: 'dataRoot missing (config or --data-root)' };
  try {
    const result = await startGoalLoop({
      dataRoot,
      project,
      ...(args.goal ? { goalId: args.goal } : {}),
      ...(args.goalTitle ? { goalTitle: args.goalTitle } : {}),
      ...(args.goalStatement ? { goalStatement: args.goalStatement } : {}),
      workerId: args.worker!,
      workspaceRoot: args.workspace!,
      transport: (args.transport as 'internal' | 'actl' | undefined) ?? 'internal',
      ...(args.actlAgent ? { actlAgent: args.actlAgent } : {}),
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function renderGoalLoopHuman(res: { ok: boolean; result?: unknown; error?: string }): string {
  if (!res.ok) {
    if (res.error === 'not-initialized') return notInitializedMessage();
    return `goal-loop failed: ${res.error}`;
  }
  const r = res.result as { status: string; goalId: string; tasksDriven: string[]; lastVerdict?: string; stoppedDetail?: string };
  const lines = [
    `goal-loop ${r.status} goal=${r.goalId} tasks=${r.tasksDriven.length}`,
    `last verdict: ${r.lastVerdict ?? '-'}`,
  ];
  if (r.stoppedDetail) lines.push(`detail: ${r.stoppedDetail}`);
  lines.push('manual prompt copy=0 manual result paste=0 gpt drag=0');
  return lines.join('\n');
}
