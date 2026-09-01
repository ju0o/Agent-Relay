/**
 * Single reusable read-only snapshot for TUI.
 * Reuses existing Core snapshot/builders: buildStatusSnapshot, getNextWork,
 * Worker Registry public view, Event reads, workspace tree.
 * TUI components consume snapshot only — no direct Core mutations.
 */
import { buildStatusSnapshot, type StatusSnapshot } from '../cli/status.js';
import * as workerRegistry from '../backend/worker-registry.js';
import { discoverConfig } from '../cli/config.js';
import { buildTree, type TreeNode } from './tree.js';

export const TUI_SNAPSHOT_VERSION = 'tui.snapshot.v1';
export const TUI_REFRESH_MS = 1000; // 500-1500 safe default

export interface TuiWorkerView {
  workerId: string;
  adapter: string; // observationAdapterId
  activity: string; // derived from Task/Run state
  mascot: string;
}

export interface TuiSnapshot {
  version: typeof TUI_SNAPSHOT_VERSION;
  snapshotAt: string;
  initialized: boolean;
  workspaceRoot?: string;
  project?: string;
  dataRoot?: string;
  status: StatusSnapshot;
  workers: TuiWorkerView[];
  tree: TreeNode[];
  treeTruncated: boolean;
  treeTotal: number;
  error?: string;
  warnings: string[];
}

import { mascotForWorker } from './mascot.js';
import { deriveWorkerActivity } from './mapping.js';

export function buildTuiSnapshot(cwd: string): TuiSnapshot {
  const started = new Date().toISOString();
  const warnings: string[] = [];
  let error: string | undefined;

  // Reuse status snapshot directly (which already reuses goal-task, pm-work, event, dispatcher)
  let status: StatusSnapshot;
  try {
    status = buildStatusSnapshot(cwd);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error = msg;
    warnings.push(`status snapshot failed: ${msg}`);
    status = {
      schemaVersion: 'cli.status.v1',
      cwd,
      initialized: false,
      taskCounts: { execution: {}, pm: {}, total: 0 },
      activeTasks: [],
      nextWork: null,
      recentEvents: [],
      warnings: [...warnings],
      error: msg,
    };
  }

  const discovered = discoverConfig(cwd);
  const workspaceRoot = discovered.config?.workspaceRoot ?? status.workspaceRoot;
  const project = discovered.config?.project ?? status.project;
  const dataRoot = discovered.config?.dataRoot ?? status.dataRoot;

  // Workers: public view only, derived activity from tasks
  let workers: TuiWorkerView[] = [];
  if (discovered.initialized && dataRoot) {
    try {
      const records = workerRegistry.listWorkerRegistryRecords(dataRoot);
      workers = records.map((r) => {
        const pub = workerRegistry.toPublicWorkerView(r);
        const adapter = pub.observationAdapterId ?? 'unknown';
        const activity = deriveWorkerActivity(r.workerId, status.activeTasks);
        const mascot = mascotForWorker(r.workerId, adapter);
        return { workerId: pub.workerId, adapter, activity, mascot };
      });
    } catch (e) {
      warnings.push(`worker registry read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Tree
  let tree: TreeNode[] = [];
  let treeTruncated = false;
  let treeTotal = 0;
  if (workspaceRoot) {
    try {
      const res = buildTree(workspaceRoot);
      tree = res.nodes;
      treeTruncated = res.truncated;
      treeTotal = res.total;
    } catch (e) {
      warnings.push(`tree read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Merge warnings from status
  const allWarnings = [...(status.warnings ?? []), ...warnings];

  return {
    version: TUI_SNAPSHOT_VERSION,
    snapshotAt: started,
    initialized: discovered.initialized && !!status.initialized,
    workspaceRoot,
    project,
    dataRoot,
    status,
    workers,
    tree,
    treeTruncated,
    treeTotal,
    ...(error ? { error } : {}),
    warnings: allWarnings,
  };
}
