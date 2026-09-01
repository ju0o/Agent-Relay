/**
 * Status snapshot builder — pure read-only, reuses existing Core functions.
 * Never duplicates Goal/Task/get_next_work/Worker Registry logic.
 */
import * as fs from 'fs';
import * as path from 'path';
import { discoverConfig, type CliConfig } from './config.js';
import * as goalTask from '../backend/goal-task.js';
import * as pmWork from '../backend/pm-work.js';
import * as eventMod from '../backend/event.js';
import * as dispatcher from '../backend/dispatcher.js';

export const STATUS_SCHEMA_VERSION = 'cli.status.v1';

export interface StatusSnapshot {
  schemaVersion: typeof STATUS_SCHEMA_VERSION;
  cwd: string;
  initialized: boolean;
  project?: string;
  workspaceRoot?: string;
  dataRoot?: string;
  configPath?: string | null;
  goal?: {
    goalId: string;
    title: string;
    status: string;
    permissionMode: string;
  } | null;
  taskCounts: {
    execution: Record<string, number>;
    pm: Record<string, number>;
    total: number;
  };
  activeTasks: Array<{
    taskId: string;
    title: string;
    executionState: string;
    pmState: string;
    runId?: string;
    workerId?: string;
  }>;
  nextWork: {
    items: unknown[];
    truncated: boolean;
    warning?: string;
  } | null;
  recentEvents: Array<{
    eventId: string;
    type: string;
    severity: string;
    summary: string;
  }>;
  warnings: string[];
  error?: string;
}

export function buildStatusSnapshot(cwd: string): StatusSnapshot {
  const discovered = discoverConfig(cwd);
  const base: StatusSnapshot = {
    schemaVersion: STATUS_SCHEMA_VERSION,
    cwd: path.resolve(cwd),
    initialized: discovered.initialized,
    taskCounts: { execution: {}, pm: {}, total: 0 },
    activeTasks: [],
    nextWork: null,
    recentEvents: [],
    warnings: [...discovered.warnings],
  };

  if (!discovered.initialized || !discovered.config) {
    base.error = discovered.error ?? 'NOT_INITIALIZED';
    base.configPath = discovered.configPath;
    return base;
  }

  const cfg = discovered.config;
  base.project = cfg.project;
  base.workspaceRoot = cfg.workspaceRoot;
  base.dataRoot = cfg.dataRoot;
  base.configPath = discovered.configPath;

  // Validate dataRoot exists
  if (!fs.existsSync(cfg.dataRoot)) {
    base.warnings.push(`dataRoot does not exist: ${cfg.dataRoot}`);
  }

  try {
    const goals = goalTask.listGoals(cfg.dataRoot, cfg.project);
    const tasks = goalTask.listTasks(cfg.dataRoot, cfg.project);

    // Choose current goal: first ACTIVE, else first PLANNING, else first
    let currentGoal: typeof goals[number] | undefined;
    if (goals.length > 0) {
      currentGoal = goals.find((g) => g.status === 'ACTIVE') ?? goals.find((g) => g.status === 'PLANNING') ?? goals[0];
      if (currentGoal) {
        base.goal = {
          goalId: currentGoal.goalId,
          title: currentGoal.title,
          status: currentGoal.status,
          permissionMode: currentGoal.permissionPolicy?.mode ?? 'PLAN',
        };
      }
    } else {
      base.goal = null;
    }

    // Task counts
    const execCounts: Record<string, number> = {};
    const pmCounts: Record<string, number> = {};
    for (const t of tasks) {
      execCounts[t.executionState] = (execCounts[t.executionState] ?? 0) + 1;
      pmCounts[t.pmState] = (pmCounts[t.pmState] ?? 0) + 1;
    }
    base.taskCounts = { execution: execCounts, pm: pmCounts, total: tasks.length };

    // Active tasks: DISPATCHED, RUNNING, RESULT_RECEIVED, READY (bounded 10)
    const active = tasks
      .filter((t) => t.executionState === 'DISPATCHED' || t.executionState === 'RUNNING' || t.executionState === 'RESULT_RECEIVED' || t.executionState === 'READY')
      .slice(0, 10)
      .map((t) => {
        const latest = t.linkedRuns.length ? [...t.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0] : undefined;
        // Worker association: try to derive from active dispatch if present
        let workerId: string | undefined;
        try {
          // dispatcher active map is process-local; best-effort
          const actives = dispatcher.listActiveDispatches(cfg.project);
          const hit = actives.find((a) => a.taskId === t.taskId);
          if (hit) workerId = hit.workerId;
        } catch { /* ignore */ }
        return {
          taskId: t.taskId,
          title: t.title,
          executionState: t.executionState,
          pmState: t.pmState,
          ...(latest?.runId ? { runId: latest.runId } : {}),
          ...(workerId ? { workerId } : {}),
        };
      });
    base.activeTasks = active;

    // Next PM work — reuse core logic, not duplicated
    try {
      const nw = pmWork.getNextWork(cfg.dataRoot, cfg.project);
      base.nextWork = { items: nw.items.slice(0, 10), truncated: nw.truncated, ...(nw.warning ? { warning: nw.warning } : {}) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      base.warnings.push(`getNextWork failed: ${msg}`);
      base.nextWork = { items: [], truncated: false };
    }

    // Recent events: last 5-10 safe summaries
    try {
      const { events } = eventMod.listEvents(cfg.dataRoot, cfg.project);
      const recent = [...events].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 10);
      base.recentEvents = recent.map((ev) => ({
        eventId: ev.eventId,
        type: ev.type,
        severity: ev.severity,
        summary: ev.summary,
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      base.warnings.push(`listEvents failed: ${msg}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    base.error = msg;
    base.warnings.push(msg);
  }

  return base;
}

export function renderStatusHuman(snapshot: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push('Agent Relay');
  lines.push('');

  if (!snapshot.initialized) {
    lines.push('Project: (not initialized)');
    const msg = snapshot.error ?? 'NOT_INITIALIZED';
    if (msg !== 'NOT_INITIALIZED') lines.push(`Config error: ${msg}`);
    lines.push('');
    lines.push('Agent Relay is not initialized in this project.');
    lines.push('Run: agent-relay init');
    return lines.join('\n');
  }

  lines.push(`Project: ${snapshot.project ?? '(unknown)'}`);
  lines.push(`Workspace: ${snapshot.workspaceRoot ?? ''}`);
  if (snapshot.dataRoot) lines.push(`DataRoot: ${snapshot.dataRoot}`);
  lines.push('');

  if (snapshot.goal) {
    lines.push('Goal');
    lines.push(`${snapshot.goal.goalId}  ${snapshot.goal.status}`);
    lines.push(`"${snapshot.goal.title}"`);
    lines.push(`Permission: ${snapshot.goal.permissionMode}`);
  } else {
    lines.push('Goal: (none)');
  }
  lines.push('');

  // Task counts
  if (snapshot.taskCounts.total > 0) {
    lines.push('Tasks');
    const exec = snapshot.taskCounts.execution;
    const pm = snapshot.taskCounts.pm;
    const parts: string[] = [];
    for (const k of ['PLANNED', 'READY', 'DISPATCHED', 'RUNNING', 'RESULT_RECEIVED', 'FAILED', 'BLOCKED', 'CANCELLED']) {
      if (exec[k]) parts.push(`${exec[k]} ${k}`);
    }
    if (parts.length) lines.push(parts.join('  '));
    const pmParts: string[] = [];
    for (const k of ['PENDING', 'VERIFYING', 'CHANGES_REQUESTED', 'ACCEPTED']) {
      if (pm[k]) pmParts.push(`${pm[k]} ${k}`);
    }
    if (pmParts.length) lines.push(`PM: ${pmParts.join('  ')}`);
  } else {
    lines.push('Tasks: (none)');
  }
  lines.push('');

  if (snapshot.activeTasks.length > 0) {
    lines.push('Active Tasks');
    for (const t of snapshot.activeTasks) {
      const runPart = t.runId ? ` · ${t.runId}` : '';
      const workerPart = t.workerId ? ` · ${t.workerId}` : '';
      lines.push(`${t.taskId} ${t.executionState}/${t.pmState}${runPart}${workerPart} — ${t.title}`);
    }
    lines.push('');
  }

  if (snapshot.nextWork && snapshot.nextWork.items.length > 0) {
    lines.push('Next');
    for (const it of snapshot.nextWork.items.slice(0, 5) as Array<{ kind: string; taskId?: string; goalId?: string }>) {
      const id = it.taskId ?? it.goalId ?? '';
      lines.push(`${it.kind}${id ? ` · ${id}` : ''}`);
    }
    lines.push('');
  }

  if (snapshot.recentEvents.length > 0) {
    lines.push('Recent Events');
    for (const ev of snapshot.recentEvents.slice(0, 5)) {
      lines.push(`${ev.eventId} ${ev.type} — ${ev.summary}`);
    }
    lines.push('');
  }

  if (snapshot.warnings.length > 0) {
    lines.push('Warnings');
    for (const w of snapshot.warnings) lines.push(`! ${w}`);
    lines.push('');
  }

  if (snapshot.error && snapshot.error !== 'NOT_INITIALIZED') {
    lines.push(`Error: ${snapshot.error}`);
    lines.push('');
  }

  return lines.join('\n');
}
