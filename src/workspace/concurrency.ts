/**
 * Concurrency governor — resource policy.
 *
 * Defaults: Active Builder max = 2, Active QA max = 1.
 * PM performs a turn only when needed (never counted as active).
 * Remaining lanes stay READY/WAITING.
 *
 * `workspace start` does NOT dispatch Tasks; it only assigns
 * RUNNING vs WAITING slots so the later PM<->Builder<->QA loop
 * respects the caps without manual pane juggling.
 */
import * as fs from 'node:fs';
import { workspaceStatePath } from './manifest.js';

export type LaneRunState = 'READY' | 'RUNNING' | 'WAITING';

export interface ConcurrencyState {
  maxActiveBuilders: number;
  maxActiveQa: number;
  /** Lane ids holding an active Builder slot (<= max) */
  activeBuilders: string[];
  /** Lane ids holding an active QA slot (<= max) */
  activeQa: string[];
  laneStates: Record<string, LaneRunState>;
  updatedAt: string;
}

export function applyConcurrency(
  laneIds: string[],
  maxActiveBuilders: number,
  maxActiveQa: number,
): ConcurrencyState {
  const activeBuilders = laneIds.slice(0, Math.max(0, maxActiveBuilders));
  const activeQa = laneIds.slice(0, Math.max(0, maxActiveQa));
  const laneStates: Record<string, LaneRunState> = {};
  for (const id of laneIds) {
    laneStates[id] = activeBuilders.includes(id) || activeQa.includes(id) ? 'RUNNING' : 'WAITING';
    // Lanes with no slot yet are READY to take one when a slot frees.
    if (!activeBuilders.includes(id) && !activeQa.includes(id)) laneStates[id] = 'WAITING';
  }
  // Any lane holding at least one slot is RUNNING; others WAITING (READY pool).
  return { maxActiveBuilders, maxActiveQa, activeBuilders, activeQa, laneStates, updatedAt: new Date().toISOString() };
}

export function readConcurrencyState(hostRoot: string): ConcurrencyState | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(workspaceStatePath(hostRoot), 'utf8'));
    const s = (raw as Record<string, unknown>).concurrency as ConcurrencyState | undefined;
    if (!s || !Array.isArray(s.activeBuilders) || !Array.isArray(s.activeQa)) return null;
    return s;
  } catch {
    return null;
  }
}
