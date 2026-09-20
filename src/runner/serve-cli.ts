/**
 * `agent-relay runner ...` command wiring (kept out of cli/index.ts).
 *
 *   runner run    [--store D] [--lane L]... [--project P] [--cycle C]
 *                 [--once] [--poll-ms N] [--allow-tmux-sends]
 *                 [--transport-file F] [--worker W] [--data-root D]
 *   runner status [--store D] [--lanes a,b]
 *   runner stop   [--store D]
 *
 * Foreground `run` is systemd-ExecStart compatible; `--once` performs a
 * single pass (tests, debugging). Default store:
 * `<cwd>/.agent-relay/runner`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LaneScheduler } from '../workspace/scheduler.js';
import { loadEffectiveConfig } from '../workspace/config-v2.js';
import { serve, serveOnce, stopRunner, readRunnerStatus } from './daemon.js';
import { bindLaneSessions } from './session-bind.js';
import { dispatchV1OwnerApproved } from '../backend/v1-dispatch.js';
import * as goalTask from '../backend/goal-task.js';
import { transitionTaskExecution } from '../backend/goal-task-runtime.js';

export interface RunnerCmdOptions {
  store?: string;
  lanes?: string[];
  project?: string;
  cycle?: string;
  once?: boolean;
  pollMs?: number;
  allowTmuxSends?: boolean;
  transportFile?: string;
  worker?: string;
  dataRoot?: string;
  turnTimeoutMs?: number;
  turnMaxAttempts?: number;
  goalBriefDir?: string;
  json?: boolean;
}

export function defaultRunnerStore(cwd: string): string {
  return path.join(path.resolve(cwd), '.agent-relay', 'runner');
}

function resolveDataRoot(cwd: string, override?: string): string {
  if (override) return path.resolve(override);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.resolve(cwd), '.agent-relay', 'config.json'), 'utf8')) as { dataRoot?: string };
    if (cfg.dataRoot) return path.resolve(cfg.dataRoot);
  } catch { /* fall through */ }
  return path.join(process.env.HOME ?? osHomedir(), '.local', 'share', 'agent-relay');
}

function osHomedir(): string {
  return process.env.HOME ?? '/tmp';
}

function auditTo(storeRoot: string) {
  const file = path.join(path.resolve(storeRoot), 'runner-audit.jsonl');
  return (event: Record<string, unknown>): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    } catch { /* audit best-effort */ }
  };
}

export async function runRunnerCommand(cwd: string, verb: string, o: RunnerCmdOptions): Promise<number> {
  const storeRoot = path.resolve(o.store ?? defaultRunnerStore(cwd));
  if (verb === 'stop') {
    const stopped = stopRunner(storeRoot);
    if (o.json) console.log(JSON.stringify({ ok: stopped }));
    else console.log(stopped ? 'runner stopping (SIGTERM sent)' : 'runner not running');
    return 0;
  }
  if (verb === 'status') {
    const laneIds = o.lanes ?? loadEffectiveConfig(cwd).config.lanes.map((l) => l.id);
    const snap = readRunnerStatus(storeRoot, laneIds);
    if (o.json) console.log(JSON.stringify({ schemaVersion: 'runner.status.v1', store: storeRoot, ...snap }, null, 2));
    else {
      console.log(`runner: ${snap.running ? `running (pid ${snap.pid})` : 'stopped'}`);
      for (const l of snap.lanes) {
        console.log(`${l.laneId}: ${l.outcome ?? l.phase}${l.taskId ? ` ${l.taskId}` : ''}`);
      }
    }
    return 0;
  }
  if (verb !== 'run') throw new Error(`unknown runner verb: ${verb}`);

  const { config } = loadEffectiveConfig(cwd);
  const wanted = o.lanes ?? config.lanes.map((l) => l.id);
  const lanes = config.lanes.filter((l) => wanted.includes(l.id));
  if (lanes.length === 0) throw new Error(`no such lanes: ${wanted.join(',')}`);
  const dataRoot = resolveDataRoot(cwd, o.dataRoot);
  const projectDefault = o.project;
  const transportOverrides = o.transportFile
    ? JSON.parse(fs.readFileSync(path.resolve(o.transportFile), 'utf8')) as Record<string, Record<string, { command: string; args?: string[] }>>
    : {};
  const audit = auditTo(storeRoot);
  const briefFor = (laneId: string, fallback: string): string => {
    if (o.goalBriefDir) {
      try {
        const text = fs.readFileSync(path.join(path.resolve(o.goalBriefDir), `${laneId}.txt`), 'utf8').trim();
        if (text) return text.slice(0, 4000);
      } catch { /* fall through to lane goal */ }
    }
    return fallback;
  };
  const scheduler = new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const correlationId = o.cycle?.trim() || `c-${Date.now().toString(36)}`;

  const stores = {
    listReadyTasks: (lane: (typeof lanes)[number]) => {
      const project = projectDefault ?? lane.id;
      try {
        return goalTask.listTasks(dataRoot, project)
          .filter((t) => t.executionState === 'READY')
          .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState }));
      } catch {
        return [];
      }
    },
    readTask: (lane: (typeof lanes)[number], taskId: string) => {
      const project = projectDefault ?? lane.id;
      try {
        const t = goalTask.getTask(dataRoot, project, taskId);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch {
        return null;
      }
    },
    listOpenTaskIds: (lane: (typeof lanes)[number]) => {
      const project = projectDefault ?? lane.id;
      try {
        return goalTask.listTasks(dataRoot, project)
          .filter((t) => t.pmState !== 'ACCEPTED')
          .map((t) => t.taskId);
      } catch {
        return [];
      }
    },
    taskContract: (lane: (typeof lanes)[number], taskId: string) => {
      const project = projectDefault ?? lane.id;
      try {
        return (goalTask.getTask(dataRoot, project, taskId).contract ?? null) as unknown;
      } catch {
        return null;
      }
    },
    acceptanceCriteria: (lane: (typeof lanes)[number], taskId: string) => {
      const project = projectDefault ?? lane.id;
      try {
        const c = goalTask.getTask(dataRoot, project, taskId).contract as { acceptance_criteria?: unknown } | undefined;
        return (c?.acceptance_criteria ?? null) as unknown;
      } catch {
        return null;
      }
    },
  };

  const seams = {
    dispatch: async (lane: (typeof lanes)[number], task: { taskId: string }) => {
      const project = projectDefault ?? lane.id;
      if (o.worker) {
        const res = await dispatchV1OwnerApproved(dataRoot, project, {
          taskId: task.taskId,
          workerId: o.worker,
          workspaceRoot: lane.root,
          expectedExecutionState: 'READY',
        });
        audit({ laneId: lane.id, step: 'dispatch', mode: 'owner-approved', runId: res.runId });
        return { runId: res.runId };
      }
      // Default: canonical CAS transition only (READY->DISPATCHED). Worker
      // spawn stays owned by the dispatcher; labeled as such in audit.
      const after = await transitionTaskExecution(dataRoot, project, task.taskId, {
        expectedExecutionState: 'READY',
        to: 'DISPATCHED',
        reason: 'durable-runner dispatch (CAS only; spawn owned by dispatcher)',
      });
      void after;
      const runId = `drun-${Date.now().toString(36)}`;
      audit({ laneId: lane.id, step: 'dispatch', mode: 'cas-only', runId, taskId: task.taskId });
      return { runId };
    },
    accept: async (
      lane: (typeof lanes)[number],
      task: { taskId: string },
      runId: string,
      ctx?: { envelope?: { taskType: string; fileScope: string[] } | null; route?: string },
    ) => {
      // §8 accepted-work delivery: commit ONLY the task's fileScope on the
      // project's current branch, then push (no merges, ever). Without a
      // fileScope there is nothing the Builder was allowed to touch.
      const fileScope = ctx?.envelope?.fileScope ?? [];
      const route = ctx?.route ?? 'full';
      const needsDelivery = route === 'full' && fileScope.length > 0;
      if (!needsDelivery) {
        audit({
          laneId: lane.id, step: 'accept', taskId: task.taskId, runId, route,
          note: fileScope.length === 0
            ? 'record-only accept (no fileScope: Builder touched nothing committable)'
            : 'record-only accept (review route: no build output to commit)',
        });
        return;
      }
      try {
        const { execFileSync } = await import('node:child_process');
        const run = (args: string[]): string =>
          execFileSync('git', ['-C', lane.root, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
        const existing = new Set<string>();
        for (const f of fileScope) {
          try {
            const st = fs.statSync(path.join(lane.root, f));
            if (st.isFile() || st.isDirectory()) existing.add(f);
          } catch { /* absent: not committable */ }
        }
        if (existing.size === 0) {
          audit({ laneId: lane.id, step: 'deliver', taskId: task.taskId, outcome: 'nothing-to-commit' });
          return;
        }
        const before = run(['status', '--porcelain=v1', '--untracked-files=no']);
        const touched = before.split('\n').filter(Boolean)
          .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, '$1'));
        const inScope = touched.filter((t) => [...existing].some((f) => t === f || t.startsWith(`${f}/`)));
        if (inScope.length === 0) {
          audit({ laneId: lane.id, step: 'deliver', taskId: task.taskId, outcome: 'tree-clean' });
          return;
        }
        run(['add', '--', ...inScope]);
        const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
        const msg = `cert(${task.taskId}): ${task.taskId} accepted (QA PASS, PM ACCEPT, run ${runId})`;
        run(['commit', '-m', msg]);
        const sha = run(['rev-parse', 'HEAD']);
        let pushed: string | null = null;
        try {
          run(['push', 'origin', branch]);
          pushed = `origin/${branch}`;
        } catch (err) {
          audit({
            laneId: lane.id, step: 'deliver_push_failed', taskId: task.taskId, sha,
            error: err instanceof Error ? err.message.slice(0, 300) : String(err),
          });
        }
        audit({ laneId: lane.id, step: 'deliver', taskId: task.taskId, sha, branch, pushed, files: inScope });
      } catch (err) {
        audit({
          laneId: lane.id, step: 'deliver_blocked', taskId: task.taskId,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      }
    },
    nextTask: async (lane: (typeof lanes)[number], task: { taskId: string }) => {
      const project = projectDefault ?? lane.id;
      try {
        const hit = goalTask.listTasks(dataRoot, project).find((t) => t.executionState === 'READY' && t.taskId !== task.taskId);
        return hit ? { taskId: hit.taskId } : null;
      } catch {
        return null;
      }
    },
  };

  const resolveBindings = async (lane: (typeof lanes)[number]) => {
    const bound = bindLaneSessions(lane, {
      ioDir: storeRoot,
      ...(transportOverrides[lane.id] ? { subprocessCommands: transportOverrides[lane.id] as never } : {}),
    });
    if (!bound.bindings) throw new Error(bound.deferred ?? 'unbound lane');
    if (bound.missing.length) {
      audit({ laneId: lane.id, step: 'bind_partial', missing: bound.missing, bound: bound.boundPanes });
    }
    return bound.bindings;
  };

  const projectCurrentFor = async (lane: (typeof lanes)[number]): Promise<string> => {
    const { resolveProjectCurrent, renderProjectCurrentPacket } = await import('./project-current.js');
    const cur = await resolveProjectCurrent(lane.id, lane.root, {
      laneRoots: config.lanes.map((l) => l.root),
      dataRoot,
      project: projectDefault ?? lane.id,
      listOpenTasks: (dr, project) => {
        try {
          return goalTask.listTasks(dr, project).map((t) => ({
            taskId: t.taskId, executionState: t.executionState, pmState: t.pmState,
          }));
        } catch {
          return [];
        }
      },
    });
    return renderProjectCurrentPacket(cur);
  };
  const intakeSeams = {
    validateProposal: async (lane: (typeof lanes)[number], proposal: { goal: string; bounded_scope: string; acceptance_criteria: Array<{ id: string; description: string }> }, fileScope: string[]) => {
      const { validateTaskQaContractFields } = await import('../backend/qa-contract.js');
      // Canonical QA gate for intake: SEMANTIC criteria (verified by the
      // independent QA agent) + diffScope guard pinned to the task's own
      // fileScope (read-only tasks: [] — zero file changes permitted).
      validateTaskQaContractFields({
        scope: proposal.bounded_scope,
        acceptanceCriteria: proposal.acceptance_criteria.map((ac) => ({ id: ac.id, description: ac.description, validationMode: 'SEMANTIC' })),
        qaContract: {
          deterministic: [{ kind: 'diffScope', allowedPaths: [...fileScope] }],
          semantic: { qaWorkerId: `${lane.qa.runtime}-live` },
        },
      });
    },
    createTask: async (lane: (typeof lanes)[number], proposal: { goal: string; bounded_scope: string; acceptance_criteria: Array<{ id: string; description: string }> }, fileScope: string[]) => {
      const project = projectDefault ?? lane.id;
      const goals = goalTask.listGoals(dataRoot, project);
      if (goals.length === 0) throw new Error(`intake refused: no approved Goal in scope project ${project}`);
      const goal = goals[0]!;
      const acs = proposal.acceptance_criteria.map((ac) => ({ id: ac.id, description: ac.description, validationMode: 'SEMANTIC' as const }));
      const created = await goalTask.createTask(dataRoot, project, {
        goalId: goal.goalId,
        title: proposal.goal.length > 80 ? `${proposal.goal.slice(0, 80)}…` : proposal.goal,
        goal: proposal.goal,
        reason: `owner-go intake (${correlationId})`,
        scope: proposal.bounded_scope,
        acceptanceCriteria: acs,
        qaContract: {
          deterministic: [{ kind: 'diffScope', allowedPaths: [...fileScope] }],
          semantic: { qaWorkerId: `${lane.qa.runtime}-live` },
        },
      });
      return { taskId: created.taskId, executionState: created.executionState, pmState: created.pmState };
    },
    markReady: async (lane: (typeof lanes)[number], taskId: string) => {
      const project = projectDefault ?? lane.id;
      const ready = await transitionTaskExecution(dataRoot, project, taskId, {
        expectedExecutionState: 'PLANNED',
        to: 'READY',
        reason: 'owner-go intake',
      });
      return { taskId: ready.taskId, executionState: ready.executionState, pmState: ready.pmState };
    },
  };
  const serveOpts = {
    storeRoot,
    lanes,
    projectId: projectDefault ?? 'lane',
    correlationId,
    pollMs: o.pollMs ?? 5000,
    once: o.once ?? false,
    ...(o.turnTimeoutMs !== undefined ? { turnTimeoutMs: o.turnTimeoutMs } : {}),
    ...(o.turnMaxAttempts !== undefined ? { turnMaxAttempts: o.turnMaxAttempts } : {}),
    resolveBindings,
    stores,
    seams,
    scheduler,
    allowTmuxSends: o.allowTmuxSends ?? false,
    intake: {
      enabled: true,
      goalBriefFor: (l: { id: string; goal: string }) => briefFor(l.id, l.goal),
      projectCurrentFor,
      seams: intakeSeams,
    },
    // The durable live path never performs live effects without a covering
    // Owner GO (fail-closed); tests drive advanceLane directly instead.
    ownerGoRequired: true,
    audit,
  };
  if (o.once) {
    const snap = await serveOnce(serveOpts);
    if (o.json) console.log(JSON.stringify({ schemaVersion: 'runner.once.v1', ...snap }, null, 2));
    else {
      for (const l of snap.lanes) console.log(`${l.laneId}: ${l.outcome ?? l.phase}${l.taskId ? ` ${l.taskId}` : ''}`);
    }
    return 0;
  }
  await serve(serveOpts);
  return 0;
}
