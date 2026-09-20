/**
 * CLI surface for the night-run controller: start | status | stop | shutdown.
 *
 * - start: records the night cycle and delegates to the durable runner.
 * - status: evaluates completion across lanes (exit 0 complete, 3 open).
 * - stop: delegates to the runner stop (graceful halt, durable resume).
 * - shutdown: gated ordered shutdown; real effects refuse without a passed
 *   completion gate, poweroff refuses without host privilege. Certification
 *   runs the dry-run form only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateStoreCompletion,
  runShutdownSequence,
  type ShutdownRunner,
} from './night-run.js';
import { defaultRunnerStore } from './serve-cli.js';

export interface NightCmdOptions {
  store?: string;
  lanes?: string[];
  cycle?: string;
  dataRoot?: string;
  dryRun?: boolean;
  poweroff?: boolean;
  json?: boolean;
}

async function resolveLanes(cwd: string, lanes?: string[]): Promise<string[]> {
  if (lanes?.length) return lanes;
  try {
    const { loadEffectiveConfig } = await import('../workspace/config-v2.js');
    return loadEffectiveConfig(cwd).config.lanes.map((l) => l.id);
  } catch {
    return ['actl'];
  }
}

function emit(json: boolean | undefined, obj: unknown, text: string): void {
  if (json) console.log(JSON.stringify(obj, null, 2));
  else console.log(text);
}

function defaultCanPowerOff(): { ok: boolean; reason: string } {
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return { ok: true, reason: 'running as uid 0' };
    }
  } catch { /* fall through to sudo probe */ }
  const probe = spawnSync('sudo', ['-n', 'true'], { timeout: 8000 });
  if (probe.status === 0) return { ok: true, reason: 'passwordless sudo available' };
  return { ok: false, reason: 'neither uid 0 nor passwordless sudo; poweroff needs an operator' };
}

function defaultPowerOffHost(): { status: number; detail: string } {
  const r = spawnSync('systemctl', ['poweroff'], { timeout: 15000 });
  return {
    status: r.status ?? 1,
    detail: r.status === 0 ? 'systemctl poweroff issued' : `poweroff failed (status ${r.status})`,
  };
}

function pidAlive(pidFile: string): boolean {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runNightCommand(cwd: string, sub: string, opts: NightCmdOptions): Promise<number> {
  const store = opts.store ?? defaultRunnerStore(cwd);
  const json = opts.json ?? false;
  if (sub === 'status') {
    const lanes = await resolveLanes(cwd, opts.lanes);
    const completion = evaluateStoreCompletion(store, lanes);
    emit(json, { schemaVersion: 'cli.night.v1', ok: true, ...completion },
      [`night completion: ${completion.complete ? 'COMPLETE' : 'OPEN'}`, ...completion.lanes.map((l) =>
        `  ${l.laneId}: ${l.state}${l.taskId ? ` ${l.taskId}` : ''}${l.pendingTurns ? ` (+${l.pendingTurns} pending)` : ''}${l.reason ? ` — ${(l.reason ?? '').slice(0, 120)}` : ''}`),
        `reason: ${completion.reason}`].join('\n'));
    return completion.complete ? 0 : 3;
  }
  if (sub === 'shutdown') {
    const lanes = await resolveLanes(cwd, opts.lanes);
    const runners: ShutdownRunner[] = [{
      name: 'agent-relay-runner',
      alive: () => pidAlive(path.join(store, 'runner.pid')),
      stop: async () => {
        const { runRunnerCommand } = await import('./serve-cli.js');
        const code = await runRunnerCommand(cwd, 'stop', { store, json: true });
        return `runner stop exited ${code}`;
      },
    }];
    const res = await runShutdownSequence({
      storeRoot: store,
      laneIds: lanes,
      dryRun: opts.dryRun ?? false,
      poweroff: opts.poweroff ?? false,
      runners,
      canPowerOff: defaultCanPowerOff,
      powerOffHost: defaultPowerOffHost,
    });
    const text = [
      `shutdown ${res.ok ? 'OK' : 'REFUSED'} (gate: ${res.gatePassed ? 'passed' : 'NOT passed'} — ${res.gateReason})`,
      ...res.steps.map((s) => `  [${s.mode}] ${s.step}${s.target ? ` ${s.target}` : ''}: ${s.status} — ${s.detail}`),
    ].join('\n');
    emit(json, { schemaVersion: 'cli.night.v1', ok: res.ok, gatePassed: res.gatePassed, gateReason: res.gateReason, steps: res.steps }, text);
    return res.ok ? 0 : 1;
  }
  if (sub === 'stop') {
    const { runRunnerCommand } = await import('./serve-cli.js');
    return runRunnerCommand(cwd, 'stop', { store, json });
  }
  if (sub === 'start') {
    const cycleId = opts.cycle ?? `night-${new Date().toISOString().slice(0, 10)}`;
    // LAST_RUN is written by the daemon when the cycle actually completes;
    // start only records the cycle and delegates to the durable runner.
    const { runRunnerCommand } = await import('./serve-cli.js');
    return runRunnerCommand(cwd, 'run', {
      store,
      ...(opts.lanes ? { lanes: opts.lanes } : {}),
      ...(opts.dataRoot ? { dataRoot: opts.dataRoot } : {}),
      nightCycleId: cycleId,
      nightStartedAt: new Date().toISOString(),
      json,
    });
  }
  const msg = `Usage: agent-relay night-run <start|status|stop|shutdown> [--store <dir>] [--lane <id,...>] [--cycle <id>] [--data-root <dir>] [--dry-run] [--poweroff] [--json]`;
  if (json) console.log(JSON.stringify({ schemaVersion: 'cli.night.v1', ok: false, error: msg }, null, 2));
  else console.error(msg);
  return 1;
}
