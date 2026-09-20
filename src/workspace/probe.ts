/**
 * Live tmux pane probe — REUSE FIRST.
 *
 * Never hardcodes pane numbers. At runtime it lists ALL panes
 * (pane_id + pid + cwd + command + dead flag), checks pid liveness and
 * cwd existence, captures a short tail for busy/idle evidence, and matches
 * panes to workspace lanes by cwd prefix (pane cwd startsWith lane root).
 *
 * Session policy:
 *   healthy pane  -> REUSED (no spawn)
 *   missing/DEAD/unrecoverable STALE -> spawn required (reported, not forced)
 *   per-Task pane creation is forbidden; one pane per lane/role at most.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceLane } from './manifest.js';

export type PaneHealth = 'HEALTHY' | 'BUSY' | 'DEAD' | 'STALE';

export interface LivePane {
  paneId: string;
  pid: number;
  cwd: string;
  command: string;
  dead: boolean;
  pidAlive: boolean;
  cwdExists: boolean;
  health: PaneHealth;
  tailEvidence: string;
}

export interface LaneProbe {
  laneId: string;
  root: string;
  rootExists: boolean;
  /** Panes whose cwd falls under the lane root (up to 3 roles expected) */
  matchedPanes: LivePane[];
  /** REUSED when >=1 healthy pane matched, else SPAWN_REQUIRED / ROOT_MISSING */
  decision: 'REUSED' | 'SPAWN_REQUIRED' | 'ROOT_MISSING';
  detail: string;
}

const TMUX_FORMAT = '#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_dead}';

function listRawPanes(): string {
  const out = execFileSync('tmux', ['list-panes', '-a', '-F', TMUX_FORMAT], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return out;
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function captureTail(paneId: string, lines = 8): string {
  try {
    const res = spawnSync('tmux', ['capture-pane', '-p', '-t', paneId, '-S', `-${lines}`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (res.status !== 0) return '';
    return (res.stdout ?? '').slice(-1200);
  } catch {
    return '';
  }
}

function classify(dead: boolean, pidOk: boolean, cwdOk: boolean, tail: string): PaneHealth {
  if (dead || !pidOk || !cwdOk) return 'DEAD';
  if (/esc to interrupt|Working \(|Press enter to continue|Do you trust/i.test(tail)) return 'BUSY';
  if (!tail.trim()) return 'STALE';
  return 'HEALTHY';
}

export function probeAllPanes(): LivePane[] {
  let raw: string;
  try {
    raw = listRawPanes();
  } catch {
    return [];
  }
  const panes: LivePane[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [paneId, pidRaw, cwd, command, deadRaw] = line.split('\t');
    if (!paneId || !pidRaw || !cwd) continue;
    const pid = Number(pidRaw);
    const dead = deadRaw === '1';
    const alive = pidAlive(pid);
    let cwdExists = false;
    try {
      cwdExists = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
    } catch {
      cwdExists = false;
    }
    const tail = dead ? '' : captureTail(paneId);
    panes.push({
      paneId,
      pid,
      cwd: path.resolve(cwd),
      command: command ?? '',
      dead,
      pidAlive: alive,
      cwdExists,
      health: classify(dead, alive, cwdExists, tail),
      tailEvidence: tail.slice(-300),
    });
  }
  return panes;
}

function underRoot(cwd: string, root: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(cwd);
  return c === r || c.startsWith(r + path.sep);
}

export function probeLanes(lanes: WorkspaceLane[], livePanes?: LivePane[]): LaneProbe[] {
  const panes = livePanes ?? probeAllPanes();
  return lanes.map((lane) => {
    let rootExists = false;
    try {
      rootExists = fs.existsSync(lane.root) && fs.statSync(lane.root).isDirectory();
    } catch {
      rootExists = false;
    }
    if (!rootExists) {
      return { laneId: lane.id, root: lane.root, rootExists, matchedPanes: [], decision: 'ROOT_MISSING', detail: `project root missing: ${lane.root}` };
    }
    const matched = panes.filter((p) => underRoot(p.cwd, lane.root));
    // REUSE FIRST: any HEALTHY or BUSY pane counts as a live reusable session.
    // STALE alone is recoverable-unknown -> still reuse unless every match is DEAD.
    const reusable = matched.filter((p) => p.health === 'HEALTHY' || p.health === 'BUSY' || p.health === 'STALE');
    if (reusable.length > 0) {
      const ids = reusable.map((p) => `${p.paneId}:${p.pid}`).join(',');
      return { laneId: lane.id, root: lane.root, rootExists, matchedPanes: matched, decision: 'REUSED', detail: `reused healthy pane(s) ${ids}` };
    }
    if (matched.length > 0) {
      return { laneId: lane.id, root: lane.root, rootExists, matchedPanes: matched, decision: 'SPAWN_REQUIRED', detail: `all ${matched.length} matched pane(s) DEAD/unrecoverable` };
    }
    return { laneId: lane.id, root: lane.root, rootExists, matchedPanes: [], decision: 'SPAWN_REQUIRED', detail: 'no pane under project root (missing)' };
  });
}
