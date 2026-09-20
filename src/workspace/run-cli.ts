/**
 * `workspace run` execution layer — dry-run certification and bounded live
 * one-lane certification over the SAME lane-runner state machine.
 *
 * Dry-run (default): scratch canonical store (real goal-task API for seed +
 * first-dispatch CAS), scripted PM/Builder/QA seams, full chain to ACCEPT.
 * The canonical ACCEPT itself is record-only here (labeled); the real
 * ACCEPT path is certified by the existing orchestrator suites.
 *
 * Live (explicit --live): real probe binding + real store reads. External
 * seams defer: no pane sends, no dispatches without owner-authorized scope.
 * Expected outcome for actl today: NO_DISPATCHABLE_TASK (no actl project in
 * canonical scope) or a deferred PM turn — both audited, founder actions 0.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadEffectiveConfig, type LaneConfigV2 } from './config-v2.js';
import { probeAllPanes, probeLanes } from './probe.js';
import type { WorkspaceLane } from './manifest.js';
import { LaneScheduler } from './scheduler.js';
import {
  runProjectLane,
  type LaneAdapters,
  type LaneOutcome,
  type TaskView,
} from './lane-runner.js';
import { detectCursorRuntime } from './qa-fallback.js';
import * as goalTask from '../backend/goal-task.js';
import { transitionTaskExecution } from '../backend/goal-task-runtime.js';

export interface DryRunResult {
  mode: 'dry-run';
  laneId: string;
  outcome: LaneOutcome;
  auditFile: string;
  audit: Array<Record<string, unknown>>;
}

export interface LiveRunResult {
  mode: 'live';
  laneId: string;
  outcome: LaneOutcome;
  auditFile: string;
  audit: Array<Record<string, unknown>>;
  boundSessions: { builder: string; qa: string };
  founderRelayActions: 0;
  /**
   * True when the lane stopped WITHOUT any dispatch/send: no authorized
   * READY task (NO_DISPATCHABLE_TASK) or a pre-effect BLOCKED. A safe stop
   * is a guardrail success, NOT a live end-to-end certification — the full
   * PM→Builder→QA→PM chain with a real dispatch is certified only when an
   * authorized canonical READY task exists.
   */
  safeStop: boolean;
}

function auditPath(hostRoot: string, laneId: string, mode: string): string {
  const dir = path.join(path.resolve(hostRoot), '.agent-relay');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `workspace-run-${laneId}-${mode}.jsonl`);
}

function findLane(hostRoot: string, laneId: string): LaneConfigV2 {
  const { config } = loadEffectiveConfig(hostRoot);
  const lane = config.lanes.find((l) => l.id === laneId);
  if (!lane) throw new Error(`unknown lane: ${laneId} (known: ${config.lanes.map((l) => l.id).join(', ')})`);
  return lane;
}

function effectiveLimits(lane: LaneConfigV2, global: { maxActiveBuilders: number; maxActiveQa: number }): { maxActiveBuilders: number; maxActiveQa: number } {
  return {
    maxActiveBuilders: Math.min(global.maxActiveBuilders, lane.concurrency?.maxBuilders ?? global.maxActiveBuilders),
    maxActiveQa: Math.min(global.maxActiveQa, lane.concurrency?.maxQa ?? global.maxActiveQa),
  };
}

/** Seed a scratch canonical scope with ONE READY task (labeled fixture). */
export async function seedDryRunScope(dataRoot: string, project: string): Promise<TaskView> {
  const goal = await goalTask.createGoal(dataRoot, project, {
    title: 'lane-runner dry-run cert',
    goalStatement: 'Clearly labeled dry-run certification fixture (not product scope).',
  });
  const created = await goalTask.createTask(dataRoot, project, {
    goalId: goal.goalId,
    title: 'dry-run cert task',
    goal: 'exercise the lane loop end to end',
    reason: 'certification fixture',
    scope: 'scratch scope only',
  });
  const ready = await transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED',
    to: 'READY',
    reason: 'lane-runner dry-run seed',
  });
  return { taskId: ready.taskId, executionState: ready.executionState, pmState: ready.pmState };
}

export async function runLaneDryRun(
  hostRoot: string,
  laneId: string,
  opts?: { script?: 'accept' | 'changes'; maxTurns?: number; correlationId?: string },
): Promise<DryRunResult> {
  const lane = findLane(hostRoot, laneId);
  const { config } = loadEffectiveConfig(hostRoot);
  const script = opts?.script ?? 'accept';
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-lanerun-'));
  const project = 'CERT-DRYRUN';
  const seeded = await seedDryRunScope(dataRoot, project);
  const audit: Array<Record<string, unknown>> = [];
  const auditFile = auditPath(hostRoot, laneId, 'dryrun');
  const push = (e: Record<string, unknown>) => {
    audit.push(e);
    fs.appendFileSync(auditFile, JSON.stringify(e) + '\n');
  };

  const store = {
    listReadyTasks: (): TaskView[] =>
      goalTask.listTasks(dataRoot, project)
        .filter((t) => t.executionState === 'READY')
        .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState })),
    readTask: (_l: LaneConfigV2, taskId: string): TaskView | null => {
      try {
        const t = goalTask.getTask(dataRoot, project, taskId);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch {
        return null;
      }
    },
  };

  let pmCalls = 0;
  let qaCalls = 0;
  let dispatchCalls = 0;
  const adapters: LaneAdapters = {
    pmDecide: async ({ task, packet, qaVerdict }) => {
      pmCalls += 1;
      if (!task) return { kind: 'DISPATCH', taskId: seeded.taskId, reason: 'dry-run script: reuse seeded READY' };
      if (packet && qaVerdict?.verdict === 'QA_PASS') return { kind: 'ACCEPT', reason: 'dry-run script: verified result accepted' };
      return { kind: 'REQUEST_CHANGES', changes: 'dry-run fallback rework', reason: 'unexpected branch' };
    },
    dispatch: async (_l, task) => {
      dispatchCalls += 1;
      // First attempt exercises the REAL canonical CAS (READY->DISPATCHED).
      // Rework re-arm belongs to the canonical retry reconciler live; the
      // dry fixture simulates it and labels it as such (see audit).
      const current = goalTask.getTask(dataRoot, project, task.taskId);
      if (current.executionState === 'READY') {
        await transitionTaskExecution(dataRoot, project, task.taskId, {
          expectedExecutionState: 'READY',
          to: 'DISPATCHED',
          reason: 'lane-runner dry-run dispatch (real CAS)',
        });
        return { runId: `dryrun-r${dispatchCalls}` };
      }
      push({ laneId, step: 'rearm', note: 'simulated re-arm: canonical retry reconciler owns re-arm live', taskId: task.taskId });
      return { runId: `dryrun-r${dispatchCalls}-re` };
    },
    builderExecute: async (_l, task, attempt, changes) => ({
      taskId: task.taskId,
      runId: `dryrun-r${dispatchCalls}${attempt > 1 ? '-re' : ''}`,
      resultPacket: `RESULT_PACKET attempt=${attempt} task=${task.taskId}${changes ? ` changes=${changes.slice(0, 80)}` : ''}`,
      commands: ['npm test', 'npm run typecheck'],
      tests: ['dry-run cert assertions'],
      knownRisks: ['dry-run fixture only'],
      headSha: 'dryrun-head',
    }),
    qaVerify: async (packet) => {
      qaCalls += 1;
      if (script === 'changes' && qaCalls === 1) {
        return { verdict: 'QA_CHANGES', reason: 'dry-run script: first pass finds a gap', findings: ['evidence gap: missing log line'] };
      }
      if (packet.taskId !== seeded.taskId) throw new Error('packet task drift');
      return { verdict: 'QA_PASS', reason: 'dry-run script: contract + evidence verified' };
    },
    accept: async (_l, task, runId) => {
      push({ laneId, step: 'accept', note: 'record-only in dry-run; canonical ACCEPT covered by orchestrator suites', taskId: task.taskId, runId });
    },
    nextTask: async () => null,
    detectQaRuntime: (runtime) => (runtime === 'cursor' ? { installed: true, version: 'dry-run' } : { installed: true, version: 'dry-run' }),
    audit: push,
  };

  const scheduler = new LaneScheduler(effectiveLimits(lane, config.concurrency));
  const outcome = await runProjectLane(lane, store, adapters, {
    scheduler,
    sessions: { builderSessionId: 'dryrun:builder', qaSessionId: 'dryrun:qa' },
    maxTurns: opts?.maxTurns ?? 12,
    mode: 'dry-run',
    ...(opts?.correlationId ? { correlationId: opts.correlationId } : {}),
  });
  push({ laneId, step: 'dryrun_summary', pmCalls, qaCalls, dispatchCalls, outcome: outcome.outcome });
  return { mode: 'dry-run', laneId, outcome, auditFile, audit };
}

export async function runLaneLive(
  hostRoot: string,
  laneId: string,
  opts?: { project?: string; maxTurns?: number; correlationId?: string },
): Promise<LiveRunResult> {
  const lane = findLane(hostRoot, laneId);
  const { config } = loadEffectiveConfig(hostRoot);
  const audit: Array<Record<string, unknown>> = [];
  const auditFile = auditPath(hostRoot, laneId, 'live');
  const push = (e: Record<string, unknown>) => {
    audit.push(e);
    fs.appendFileSync(auditFile, JSON.stringify(e) + '\n');
  };

  // Live probe binding (read-only discovery; never sends, never spawns here).
  const laneView: WorkspaceLane = {
    id: lane.id, label: lane.label, root: lane.root, goal: lane.goal,
    roles: { pm: lane.pm.runtime, builder: lane.builder.runtime, qa: lane.qa.runtime },
    primaryQa: lane.qa.runtime,
  };
  const probes = probeLanes([laneView], probeAllPanes());
  const probe = probes[0]!;
  const healthy = probe.matchedPanes.filter((p) => p.health === 'HEALTHY' || p.health === 'BUSY' || p.health === 'STALE');
  if (!probe.rootExists || healthy.length < 2) {
    const reason = !probe.rootExists
      ? `project root missing: ${lane.root}`
      : `independent QA needs 2+ distinct sessions (found ${healthy.length}); refusing shared-session certification`;
    push({ laneId, step: 'live_bind', outcome: 'BLOCKED', reason, probe: probe.decision });
    return {
      mode: 'live', laneId,
      outcome: { outcome: 'BLOCKED', laneId, correlationId: opts?.correlationId ?? 'live-bind', attempts: 0, reason },
      auditFile, audit, boundSessions: { builder: '', qa: '' }, founderRelayActions: 0, safeStop: true,
    };
  }
  const builder = `${healthy[0]!.paneId}:${healthy[0]!.pid}`;
  const qa = `${healthy[1]!.paneId}:${healthy[1]!.pid}`;
  push({ laneId, step: 'live_bind', builder, qa, probe: probe.detail });

  // Real canonical scope read (project mapping explicit via --project).
  const scopeProject = opts?.project ?? laneId;
  let dataRoot = '';
  try {
    const cfgRaw: unknown = JSON.parse(fs.readFileSync(path.join(path.resolve(hostRoot), '.agent-relay', 'config.json'), 'utf8'));
    dataRoot = (cfgRaw as { dataRoot?: string }).dataRoot ?? '';
  } catch {
    dataRoot = '';
  }
  const store = {
    listReadyTasks: (): TaskView[] => {
      if (!dataRoot) return [];
      try {
        return goalTask.listTasks(dataRoot, scopeProject)
          .filter((t) => t.executionState === 'READY')
          .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState }));
      } catch {
        return [];
      }
    },
    readTask: (_l: LaneConfigV2, taskId: string): TaskView | null => {
      if (!dataRoot) return null;
      try {
        const t = goalTask.getTask(dataRoot, scopeProject, taskId);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch {
        return null;
      }
    },
  };
  try {
    const n = store.listReadyTasks().length;
    push({ laneId, step: 'live_scope', scopeProject, readyTasks: n });
  } catch (err) {
    push({ laneId, step: 'live_scope', scopeProject, error: String(err) });
  }

  // Deferring external seams: no pane sends, no dispatches in this phase.
  const adapters: LaneAdapters = {
    pmDecide: async ({ task }) => {
      if (!task) {
        const ready = store.listReadyTasks();
        if (ready.length === 0) throw new Error('PM_TURN_DEFERRED: no dispatchable task; runner reports NO_DISPATCHABLE_TASK');
        return { kind: 'DISPATCH', taskId: ready[0]!.taskId, reason: 'live: existing READY reuse candidate' };
      }
      throw new Error('PM_TURN_DEFERRED: external PM turns require owner-authorized scope (no pane sends in cert phase)');
    },
    dispatch: async () => {
      throw new Error('DISPATCH_NOT_AUTHORIZED_IN_CERT: live dispatch needs owner-authorized scope + healthy transport');
    },
    builderExecute: async () => { throw new Error('NOT_REACHED_IN_CERT'); },
    qaVerify: async () => { throw new Error('NOT_REACHED_IN_CERT'); },
    accept: async () => { throw new Error('NOT_REACHED_IN_CERT'); },
    nextTask: async () => null,
    detectQaRuntime: (runtime) => {
      if (runtime === 'cursor' || runtime === 'cursor-agent') {
        const det = detectCursorRuntime();
        return { installed: det.installed, version: det.version ?? det.path };
      }
      return { installed: true, version: 'assumed-present (cert: no turn attempted)' };
    },
    audit: push,
  };

  const scheduler = new LaneScheduler(effectiveLimits(lane, config.concurrency));
  let outcome: LaneOutcome;
  try {
    outcome = await runProjectLane(lane, store, adapters, {
      scheduler,
      sessions: { builderSessionId: builder, qaSessionId: qa, expectedBuilderIdentity: builder, expectedQaIdentity: qa },
      maxTurns: opts?.maxTurns ?? 8,
      mode: 'live',
      ...(opts?.correlationId ? { correlationId: opts.correlationId } : {}),
    });
  } catch (err) {
    // Deferral throws inside pmDecide surface as lane BLOCKED via runner catch;
    // normalize the no-task case explicitly (runner returns it before pmDecide).
    throw err;
  }
  // Safe stop unless a real dispatch happened: this cert phase performs no
  // external sends/dispatches, so anything short of a dispatched chain is a
  // guardrail stop, never an end-to-end pass.
  const dispatched = audit.some((e) => e.step === 'dispatched');
  const safeStop = !dispatched;
  push({ laneId, step: 'live_summary', outcome: outcome.outcome, safeStop, founderRelayActions: 0 });
  return { mode: 'live', laneId, outcome, auditFile, audit, boundSessions: { builder, qa }, founderRelayActions: 0, safeStop };
}
