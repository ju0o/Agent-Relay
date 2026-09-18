/**
 * AUTO Goal Loop — Runtime Transport abstraction (§12-§13).
 *
 * Two transports, explicit failure, no silent fallback:
 * - 'internal': existing canonical dispatcher.dispatchTask() (spawn-based
 *   workers from the trusted Worker Registry + observation lock + Capture arm).
 *   This is the default AUTO path — no Founder clipboard, pane, or tmux action.
 * - 'actl': external `actl` binary as a development/runtime tool. Resolves the
 *   agent target read-only (`actl --print-config` / `actl --status`) and refuses
 *   to guess pane IDs. If the actl runtime JSON contract for send/collect is
 *   unavailable, it fails explicitly with layer 'actl-runtime-unavailable'
 *   instead of silently falling back to another agent.
 *
 * SSH/tmux safety (§13): this module never runs `tmux kill-server`, never
 * touches unrelated panes, and never sends to a stale/ambiguous target.
 * Founder-visible identifiers (pane IDs, sockets, PIDs) are kept in server
 * logs only — never required from the Founder.
 */

import { spawnSync } from 'node:child_process';
import { dispatchTask, type DispatchResult } from './dispatcher.js';

export type RuntimeTransportKind = 'internal' | 'actl';

export interface AutoDispatchInput {
  dataRoot: string;
  project: string;
  taskId: string;
  /** Trusted workerId (registry). Never derived from Task narrative. */
  workerId: string;
  /** Coding repo root (NOT the Relay Run folder). Validated by dispatcher. */
  workspaceRoot: string;
  transport?: RuntimeTransportKind;
  /** actl agent name (e.g. 'claude-team', 'codex', 'opencode'). Required for actl. */
  actlAgent?: string;
}

export interface AutoDispatchOutcome {
  transport: RuntimeTransportKind;
  runId: string;
  workerId: string;
  pid?: number;
  dispatchedAt: string;
}

export class RuntimeTransportError extends Error {
  readonly code: 'ACTL_UNAVAILABLE' | 'ACTL_AMBIGUOUS_TARGET' | 'INVALID_ARGUMENT' | 'LAUNCH_FAILED';
  readonly layer: string;
  constructor(code: RuntimeTransportError['code'], layer: string, message: string) {
    super(message);
    this.name = 'RuntimeTransportError';
    this.code = code;
    this.layer = layer;
  }
}

function runActl(args: string[], timeoutMs = 8000): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('actl', args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    ok: r.status === 0,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    status: r.status,
  };
}

/** Read-only target resolution — never mutates tmux state. */
export function resolveActlTarget(actlAgent: string): { target: string; raw: string } {
  if (!actlAgent || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(actlAgent)) {
    throw new RuntimeTransportError('INVALID_ARGUMENT', 'actl-target', `Invalid actl agent name: ${actlAgent}`);
  }
  const cfg = runActl(['--print-config']);
  if (!cfg.ok) {
    throw new RuntimeTransportError('ACTL_UNAVAILABLE', 'actl-target', `actl --print-config failed: ${cfg.stderr.slice(0, 300)}`);
  }
  let target = '';
  try {
    const j = JSON.parse(cfg.stdout) as { agents?: Record<string, { target?: string }> };
    target = String(j.agents?.[actlAgent]?.target ?? '');
  } catch {
    throw new RuntimeTransportError('ACTL_UNAVAILABLE', 'actl-target', 'actl config is not valid JSON.');
  }
  if (!target || target === '-') {
    throw new RuntimeTransportError(
      'ACTL_AMBIGUOUS_TARGET',
      'actl-target',
      `actl agent '${actlAgent}' is UNMAPPED — refusing to guess a pane. Map it first (actl map) or use internal transport.`,
    );
  }
  return { target, raw: cfg.stdout.slice(0, 500) };
}

/**
 * Automatic dispatch — no Founder clipboard / pane lookup / Enter.
 * Default transport is 'internal' (canonical dispatcher).
 */
export async function autoDispatch(input: AutoDispatchInput): Promise<AutoDispatchOutcome> {
  const transport: RuntimeTransportKind = input.transport ?? 'internal';
  if (transport === 'internal') {
    const r: DispatchResult = await dispatchTask(input.dataRoot, input.project, {
      taskId: input.taskId,
      workerId: input.workerId,
      workspaceRoot: input.workspaceRoot,
      expectedExecutionState: 'READY',
    });
    return { transport, runId: r.runId, workerId: r.workerId, pid: r.pid, dispatchedAt: r.dispatchedAt };
  }
  // actl transport: resolve read-only; the actual prompt handoff goes through
  // the canonical Run prompt.md + a bounded send request. The JSON runtime
  // contract (socketPath-based send/collect) differs per actl version, so we
  // fail explicitly instead of inventing a payload that could hit the wrong pane.
  const agent = (input.actlAgent || '').trim();
  if (!agent) {
    throw new RuntimeTransportError('INVALID_ARGUMENT', 'actl-agent', 'actl transport requires actlAgent.');
  }
  resolveActlTarget(agent);
  throw new RuntimeTransportError(
    'ACTL_UNAVAILABLE',
    'actl-runtime-unavailable',
    `actl runtime send/collect contract not wired for agent '${agent}' in this build — refusing silent fallback. Use internal transport or wire the versioned actl runtime schema first.`,
  );
}
