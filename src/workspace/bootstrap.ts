/**
 * Workspace auto bootstrap — single entry point.
 *
 * `workspace start` (AUTOMATION_STARTED):
 *   1. load or create workspace manifest (stable lane registry, no pane ids)
 *   2. verify each project root exists
 *   3. probe live tmux panes (pane_id + pid + cwd + health), REUSE FIRST
 *   4. resolve QA fallback per lane (Cursor CLI detection; else QA_RUNTIME_UNAVAILABLE)
 *   5. apply concurrency caps (builders<=2, qa<=1, PM on demand)
 *   6. persist ephemeral runtime state (pane bindings live in state file only)
 *   7. NEVER dispatch multi-project Tasks here (Bootstrap ACCEPT owns that gate)
 *   8. NEVER ask the Founder for per-pane manual role prompts
 *
 * `workspace status` is read-only: manifest + state + fresh probe.
 */
import * as fs from 'node:fs';
import {
  defaultWorkspaceManifest,
  readWorkspaceManifest,
  validateWorkspaceManifest,
  workspaceManifestPath,
  workspaceStatePath,
  writeWorkspaceManifest,
  type WorkspaceLane,
  type WorkspaceManifest,
} from './manifest.js';
import { probeAllPanes, probeLanes, type LaneProbe, type LivePane } from './probe.js';
import { detectCursorRuntime, resolveQaFallback } from './qa-fallback.js';
import { applyConcurrency, type ConcurrencyState } from './concurrency.js';

export const WORKSPACE_START_SCHEMA = 'workspace.start.v1' as const;
export const WORKSPACE_STATUS_SCHEMA = 'workspace.status.v1' as const;
export const WORKSPACE_STATE_SCHEMA = 'workspace-state.v1' as const;

export interface LaneStartInfo {
  id: string;
  label: string;
  root: string;
  rootExists: boolean;
  goal: string;
  roles: WorkspaceLane['roles'];
  probeDecision: LaneProbe['decision'];
  probeDetail: string;
  reusedPanes: Array<{ paneId: string; pid: number; cwd: string; health: string }>;
  spawned: boolean;
  roleReadiness: Record<'pm' | 'builder' | 'qa', 'READY' | 'NOT_READY'>;
  qa: { primary: string; effective: string; mode: string; detail: string };
  runState: 'RUNNING' | 'WAITING' | 'READY';
}

export interface WorkspaceStartResult {
  schemaVersion: typeof WORKSPACE_START_SCHEMA;
  ok: boolean;
  automation: 'AUTOMATION_STARTED' | 'AUTOMATION_DEGRADED';
  manifestPath: string;
  statePath: string;
  manifestCreated: boolean;
  lanes: LaneStartInfo[];
  reusedSessions: string[];
  spawnedSessions: string[];
  roleReadiness: Record<string, Record<'pm' | 'builder' | 'qa', string>>;
  fallbackQa: Record<string, { effective: string; mode: string; detail: string }>;
  concurrency: ConcurrencyState;
  dispatch: 'NOT_DISPATCHED';
  warnings: string[];
  error?: string;
}

export interface WorkspaceStateFile {
  schemaVersion: typeof WORKSPACE_STATE_SCHEMA;
  automation: string;
  updatedAt: string;
  lanes: LaneStartInfo[];
  concurrency: ConcurrencyState;
  reusedSessions: string[];
  spawnedSessions: string[];
}

function atomicWriteJson(file: string, data: unknown): void {
  fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readStateFile(hostRoot: string): WorkspaceStateFile | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(workspaceStatePath(hostRoot), 'utf8'));
    const s = raw as WorkspaceStateFile;
    if (s.schemaVersion !== WORKSPACE_STATE_SCHEMA) return null;
    return s;
  } catch {
    return null;
  }
}

export function runWorkspaceStart(hostRoot: string, opts?: { qaUnavailableLanes?: string[] }): WorkspaceStartResult {
  const warnings: string[] = [];
  const manifestPath = workspaceManifestPath(hostRoot);
  const statePath = workspaceStatePath(hostRoot);

  let manifest = readWorkspaceManifest(hostRoot);
  let manifestCreated = false;
  if (!manifest) {
    manifest = defaultWorkspaceManifest();
    // Only keep lanes whose default roots are absolute (always true); actual
    // existence is verified per lane below, never fatal for other lanes.
    writeWorkspaceManifest(hostRoot, manifest);
    manifestCreated = true;
  } else {
    try {
      validateWorkspaceManifest(manifest);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        schemaVersion: WORKSPACE_START_SCHEMA, ok: false, automation: 'AUTOMATION_DEGRADED',
        manifestPath, statePath, manifestCreated, lanes: [], reusedSessions: [], spawnedSessions: [],
        roleReadiness: {}, fallbackQa: {},
        concurrency: applyConcurrency([], manifest.maxActiveBuilders, manifest.maxActiveQa),
        dispatch: 'NOT_DISPATCHED', warnings, error: msg,
      };
    }
  }
  const activeManifest: WorkspaceManifest = manifest;

  let livePanes: LivePane[] = [];
  try {
    livePanes = probeAllPanes();
  } catch (e) {
    warnings.push(`tmux probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const probes = probeLanes(activeManifest.lanes, livePanes);
  const probeById = new Map(probes.map((p) => [p.laneId, p]));

  const cursorDet = detectCursorRuntime();
  if (!cursorDet.installed) {
    warnings.push('Cursor fallback CLI not installed (QA_RUNTIME_UNAVAILABLE will be recorded if a primary QA fails).');
  }

  const qaUnavailable = new Set(opts?.qaUnavailableLanes ?? []);
  const lanes: LaneStartInfo[] = activeManifest.lanes.map((lane) => {
    const probe = probeById.get(lane.id)!;
    const reused = probe.matchedPanes
      .filter((p) => p.health === 'HEALTHY' || p.health === 'BUSY' || p.health === 'STALE')
      .map((p) => ({ paneId: p.paneId, pid: p.pid, cwd: p.cwd, health: p.health }));
    const ready = probe.decision === 'REUSED' && probe.rootExists;
    const roleReadiness: LaneStartInfo['roleReadiness'] = {
      pm: ready ? 'READY' : 'NOT_READY',
      builder: ready ? 'READY' : 'NOT_READY',
      qa: ready ? 'READY' : 'NOT_READY',
    };
    const fb = resolveQaFallback(lane.primaryQa, qaUnavailable.has(lane.id), activeManifest.qaFallbackRuntime, cursorDet);
    return {
      id: lane.id, label: lane.label, root: lane.root, rootExists: probe.rootExists, goal: lane.goal,
      roles: lane.roles, probeDecision: probe.decision, probeDetail: probe.detail,
      reusedPanes: reused, spawned: false,
      roleReadiness, qa: { primary: lane.primaryQa, effective: fb.effectiveQa, mode: fb.kind, detail: fb.detail },
      runState: 'READY',
    };
  });

  // Concurrency slots over lanes with verified roots (order = manifest order).
  const eligible = lanes.filter((l) => l.rootExists).map((l) => l.id);
  const concurrency = applyConcurrency(eligible, activeManifest.maxActiveBuilders, activeManifest.maxActiveQa);
  for (const lane of lanes) {
    lane.runState = concurrency.laneStates[lane.id] ?? 'WAITING';
    if (!lane.rootExists) lane.runState = 'WAITING';
  }

  const reusedSessions = lanes.flatMap((l) => l.reusedPanes.map((p) => `${l.id}:${p.paneId}:${p.pid}`));
  const spawnedSessions: string[] = [];
  // REUSE FIRST: no new pane is spawned when a healthy pane was reused.
  // Spawn is reported (not executed) only for missing/DEAD/unrecoverable lanes,
  // and per-Task pane creation is forbidden.
  for (const lane of lanes) {
    if (lane.probeDecision === 'SPAWN_REQUIRED' && lane.rootExists) {
      warnings.push(`lane ${lane.id}: ${lane.probeDetail} — spawn required on next operator-approved step (no auto-spawn in this slice)`);
    }
    if (!lane.rootExists) warnings.push(`lane ${lane.id}: ${lane.probeDetail}`);
  }

  const roleReadiness: Record<string, Record<'pm' | 'builder' | 'qa', string>> = {};
  const fallbackQa: Record<string, { effective: string; mode: string; detail: string }> = {};
  for (const lane of lanes) {
    roleReadiness[lane.id] = { ...lane.roleReadiness };
    fallbackQa[lane.id] = { effective: lane.qa.effective, mode: lane.qa.mode, detail: lane.qa.detail };
  }

  const degraded = lanes.some((l) => !l.rootExists || l.probeDecision !== 'REUSED');
  const result: WorkspaceStartResult = {
    schemaVersion: WORKSPACE_START_SCHEMA,
    ok: true,
    automation: degraded ? 'AUTOMATION_DEGRADED' : 'AUTOMATION_STARTED',
    manifestPath, statePath, manifestCreated, lanes,
    reusedSessions, spawnedSessions, roleReadiness, fallbackQa,
    concurrency, dispatch: 'NOT_DISPATCHED', warnings,
  };

  const state: WorkspaceStateFile = {
    schemaVersion: WORKSPACE_STATE_SCHEMA,
    automation: result.automation,
    updatedAt: new Date().toISOString(),
    lanes, concurrency, reusedSessions, spawnedSessions,
  };
  try {
    atomicWriteJson(statePath, state);
  } catch (e) {
    warnings.push(`state persist failed: ${e instanceof Error ? e.message : String(e)}`);
    result.warnings = [...warnings];
  }

  return result;
}

export interface WorkspaceStatusResult {
  schemaVersion: typeof WORKSPACE_STATUS_SCHEMA;
  ok: boolean;
  automation: string;
  manifestPath: string;
  statePath: string;
  manifestPresent: boolean;
  lanes: LaneStartInfo[];
  builders: string;
  qa: string;
  concurrency: ConcurrencyState | null;
  warnings: string[];
}

export function runWorkspaceStatus(hostRoot: string): WorkspaceStatusResult {
  const warnings: string[] = [];
  const manifestPath = workspaceManifestPath(hostRoot);
  const statePath = workspaceStatePath(hostRoot);
  const manifest = readWorkspaceManifest(hostRoot);
  if (!manifest) {
    return {
      schemaVersion: WORKSPACE_STATUS_SCHEMA, ok: false, automation: 'NOT_STARTED',
      manifestPath, statePath, manifestPresent: false, lanes: [],
      builders: '0/0', qa: '0/0', concurrency: null,
      warnings: ['workspace manifest missing — run: agent-relay workspace start'],
    };
  }
  const cached = readStateFile(hostRoot);
  // Fresh probe for status (read-only, no state write).
  let livePanes: LivePane[] = [];
  try {
    livePanes = probeAllPanes();
  } catch (e) {
    warnings.push(`tmux probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const probes = probeLanes(manifest.lanes, livePanes);
  const probeById = new Map(probes.map((p) => [p.laneId, p]));
  const cursorDet = detectCursorRuntime();
  const lanes: LaneStartInfo[] = manifest.lanes.map((lane) => {
    const probe = probeById.get(lane.id)!;
    const reused = probe.matchedPanes
      .filter((p) => p.health === 'HEALTHY' || p.health === 'BUSY' || p.health === 'STALE')
      .map((p) => ({ paneId: p.paneId, pid: p.pid, cwd: p.cwd, health: p.health }));
    const ready = probe.decision === 'REUSED' && probe.rootExists;
    const fb = resolveQaFallback(lane.primaryQa, false, manifest.qaFallbackRuntime, cursorDet);
    const prev = cached?.lanes.find((l) => l.id === lane.id);
    return {
      id: lane.id, label: lane.label, root: lane.root, rootExists: probe.rootExists, goal: lane.goal,
      roles: lane.roles, probeDecision: probe.decision, probeDetail: probe.detail,
      reusedPanes: reused, spawned: prev?.spawned ?? false,
      roleReadiness: { pm: ready ? 'READY' : 'NOT_READY', builder: ready ? 'READY' : 'NOT_READY', qa: ready ? 'READY' : 'NOT_READY' },
      qa: { primary: lane.primaryQa, effective: fb.effectiveQa, mode: fb.kind, detail: fb.detail },
      runState: cached?.concurrency.laneStates[lane.id] ?? (ready ? 'READY' : 'WAITING'),
    };
  });
  const concurrency = cached?.concurrency ?? applyConcurrency(lanes.filter((l) => l.rootExists).map((l) => l.id), manifest.maxActiveBuilders, manifest.maxActiveQa);
  const builders = `${concurrency.activeBuilders.length}/${concurrency.maxActiveBuilders}`;
  const qa = `${concurrency.activeQa.length}/${concurrency.maxActiveQa}`;
  return {
    schemaVersion: WORKSPACE_STATUS_SCHEMA, ok: true,
    automation: cached?.automation ?? 'UNKNOWN',
    manifestPath, statePath, manifestPresent: true, lanes, builders, qa, concurrency, warnings,
  };
}

export function renderWorkspaceStatusHuman(st: WorkspaceStatusResult): string {
  const lines: string[] = [];
  lines.push(st.automation === 'AUTOMATION_STARTED' ? 'AUTOMATION_STARTED' : st.automation);
  lines.push('');
  if (!st.ok || !st.manifestPresent) {
    lines.push('Workspace: (not started)');
    for (const w of st.warnings) lines.push(`! ${w}`);
    lines.push('Run: agent-relay workspace start');
    return lines.join('\n');
  }
  for (const lane of st.lanes) {
    const ready = lane.roleReadiness.pm === 'READY' && lane.roleReadiness.builder === 'READY' && lane.roleReadiness.qa === 'READY';
    lines.push(`${lane.label.padEnd(12)} ${ready ? 'READY' : 'NOT_READY'}/${lane.runState}`);
  }
  lines.push('');
  lines.push(`Builders: ${st.builders}`);
  lines.push(`QA: ${st.qa}`);
  return lines.join('\n');
}

export function renderWorkspaceStartHuman(r: WorkspaceStartResult): string {
  const lines: string[] = [];
  lines.push(r.automation);
  lines.push('');
  for (const lane of r.lanes) {
    lines.push(`${lane.label.padEnd(12)} ${lane.runState} (${lane.probeDecision})`);
  }
  lines.push('');
  lines.push(`Builders: ${r.concurrency.activeBuilders.length}/${r.concurrency.maxActiveBuilders}`);
  lines.push(`QA: ${r.concurrency.activeQa.length}/${r.concurrency.maxActiveQa}`);
  if (r.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of r.warnings) lines.push(`! ${w}`);
  }
  return lines.join('\n');
}
