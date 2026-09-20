/**
 * Session binding — configured role -> discovered live session -> bound
 * live_session_identity. REUSE FIRST: healthy panes under the lane root are
 * matched by cwd (pane numbers are runtime evidence, never config); a lane
 * spawns nothing here — missing/DEAD lanes report, they don't improvise.
 *
 * Roles may alternatively bind to subprocess commands (headless lanes,
 * certification fixtures) via explicit per-role command overrides.
 */
import { execFileSync } from 'node:child_process';
import type { LaneConfigV2 } from '../workspace/config-v2.js';
import { probeAllPanes, type LivePane } from '../workspace/probe.js';
import { SubprocessTransport, TmuxTransport, type TurnSession } from './transport.js';
import type { BoundTransport, EngineBindings } from './lane-engine.js';

export interface BindOptions {
  subprocessCommands?: Partial<Record<'pm' | 'builder' | 'qa' | 'qaFallback', { command: string; args?: string[]; env?: Record<string, string> }>>;
  /** Minimum distinct healthy panes required for tmux roles (default 2: QA independence). */
  minPanes?: number;
  /** Durable per-turn output dir for subprocess transports (kill -9 safe). */
  ioDir?: string;
  /** Live capture provider (injectable for tests; defaults to tmux capture). */
  captureTail?: (paneId: string) => string;
  /** Pre-probed pane pool (injectable for tests; defaults to live probe). */
  candidates?: LivePane[];
}

/**
 * Runtime signature discovery: classify a pane's visible tail into engine
 * tokens. Matching is evidence-based (what the pane shows), never positional
 * (pane numbers) and never assumed from cwd alone.
 */
export function classifyPaneRuntime(tail: string): string[] {
  const t = tail.toLowerCase();
  const tokens = new Set<string>();
  if (/gpt-5[^,\n]*luna|codex.*luna|luna.*codex/.test(t)) {
    tokens.add('codex');
    tokens.add('luna');
  } else if (/chatgpt-web|ask codex/.test(t)) {
    tokens.add('codex');
    tokens.add('chatgpt-web');
    tokens.add('chatgpt');
  }
  if (/grok/.test(t)) tokens.add('grok');
  if (/claude/.test(t)) {
    tokens.add('claude');
    if (/team/.test(t)) tokens.add('team');
  }
  if (/opencode|muse spark|muse-spark/.test(t)) tokens.add('opencode');
  // CommandCode's banner is ASCII-art wrapped ("Code" alone on a line), so
  // match its distinctive model/UX markers instead of the full brand string.
  if (/command code|commandcode/.test(t)
    || ((/laguna|taste-1/.test(t)) && /ask your question/i.test(t))) {
    tokens.add('commandcode');
  }
  if (/\bcline\b/.test(t)) tokens.add('cline');
  if (/cursor/.test(t)) tokens.add('cursor');
  return [...tokens];
}

/**
 * A configured runtime label matches when every token of the label is
 * evidenced: 'codex-luna' needs {codex,luna}; 'chatgpt' needs {chatgpt};
 * 'claude-team' needs {claude,team}; 'commandcode' needs {commandcode}.
 */
export function matchConfiguredRuntime(configured: string, tokens: string[]): boolean {
  const parts = configured.trim().toLowerCase().split(/[-_]/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every((p) => tokens.includes(p));
}

export interface LaneBinding {
  bindings: EngineBindings;
  boundPanes: string[];
  /** Roles that could not be bound with concrete reasons (lane proceeds
   *  through bound phases; missing roles block only their own phase). */
  missing: string[];
  deferred: string | null;
}

function defaultCapture(paneId: string): string {
  try {
    return execFileSync('tmux', ['capture-pane', '-J', '-p', '-t', paneId, '-S', '-60'], {
      encoding: 'utf8',
      timeout: 8000,
    });
  } catch {
    return '';
  }
}

export function bindLaneSessions(lane: LaneConfigV2, opts: BindOptions = {}): LaneBinding {
  const sub = opts.subprocessCommands ?? {};
  const ioDir = opts.ioDir ? `${opts.ioDir}/turn-io` : undefined;
  const capture = opts.captureTail ?? defaultCapture;
  const mkSub = (role: 'pm' | 'builder' | 'qa' | 'qaFallback'): BoundTransport | null => {
    const c = sub[role];
    if (!c) return null;
    const session: TurnSession = { kind: 'subprocess', target: c.command, args: c.args ?? [], ...(c.env ? { env: c.env } : {}) };
    return { transport: new SubprocessTransport(ioDir), session, sessionId: `sub:${c.command}` };
  };

  const needTmux = (['pm', 'builder', 'qa'] as const).some((r) => !mkSub(r));
  type Candidate = { paneId: string; pid: number; tokens: string[] };
  let pool: Candidate[] = [];
  if (needTmux) {
    const all = opts.candidates ?? probeAllPanes();
    pool = all
      .filter((p) => {
        const root = lane.root.endsWith('/') ? lane.root : `${lane.root}/`;
        return (p.cwd === lane.root || p.cwd.startsWith(root))
          && (p.health === 'HEALTHY' || p.health === 'BUSY' || p.health === 'STALE');
      })
      .map((p) => ({ paneId: p.paneId, pid: p.pid, tokens: classifyPaneRuntime(capture(p.paneId)) }));
  }

  const missing: string[] = [];
  const boundPanes: string[] = [];
  const take = (role: 'pm' | 'builder' | 'qa', configured: string): BoundTransport | null => {
    const s = mkSub(role);
    if (s) {
      boundPanes.push(s.sessionId);
      return s;
    }
    const idx = pool.findIndex((p) => matchConfiguredRuntime(configured, p.tokens));
    if (idx < 0) {
      missing.push(`${role}: no healthy ${configured} session under ${lane.root}`);
      return null;
    }
    const [hit] = pool.splice(idx, 1);
    const session: TurnSession = { kind: 'tmux', target: hit!.paneId };
    const bound: BoundTransport = {
      transport: new TmuxTransport(), session, sessionId: `${hit!.paneId}:${hit!.pid}`,
    };
    boundPanes.push(bound.sessionId);
    return bound;
  };

  const pm = take('pm', lane.pm.runtime);
  const builder = take('builder', lane.builder.runtime);
  const qa = take('qa', lane.qa.runtime);
  if (!pm) {
    return {
      bindings: null as unknown as EngineBindings,
      boundPanes,
      missing,
      deferred: `lane ${lane.id}: PM unbound (${missing.join('; ')}) — lane deferred, no spawn, no dispatch`,
    };
  }
  const qaFallback = mkSub('qaFallback') ?? undefined;
  return {
    bindings: {
      pm,
      builder: builder as BoundTransport | null,
      qa: qa as BoundTransport | null,
      ...(qaFallback ? { qaFallback } : {}),
    } as EngineBindings,
    boundPanes,
    missing,
    deferred: missing.length ? `lane ${lane.id} partial: ${missing.join('; ')}` : null,
  };
}
