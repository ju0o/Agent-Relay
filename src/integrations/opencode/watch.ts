import { AgentAdapter, AgentCompletion, AdapterEvent, WatchHandle, WatchTarget } from '../core/types.js';
import { discoverRunningServers, OpenCodeServerClient, OcSessionInfo } from './client.js';
import { summarizeLastTurn } from './extract.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
/** Clock-skew guard: sessions updated slightly "before" arm time still count. */
const ARM_SKEW_MS = 1_500;

/**
 * Pure candidate filter — which sessions should be polled for a fresh turn.
 * A session qualifies when it was updated at/after `sinceMs` and (optionally)
 * its directory equals or lies inside workspaceRoot.
 */
export function selectCandidateSessions(
  sessions: OcSessionInfo[],
  opts: { sinceMs: number; workspaceRoot?: string },
): OcSessionInfo[] {
  const root = opts.workspaceRoot
    ? opts.workspaceRoot.replace(/[\\/]+$/, '')
    : null;
  return sessions.filter((s) => {
    if (!s.id) return false;
    const updated = s.time?.updated;
    if (typeof updated === 'number' && updated < opts.sinceMs - ARM_SKEW_MS) return false;
    if (root && s.directory) {
      const dir = s.directory.replace(/[\\/]+$/, '');
      const eq = dir.toLowerCase() === root.toLowerCase();
      const inside = dir.toLowerCase().startsWith(root.toLowerCase() + '\\') || dir.toLowerCase().startsWith(root.toLowerCase() + '/');
      if (!eq && !inside) return false;
    }
    return true;
  });
}

class OpenCodeWatchHandle implements WatchHandle {
  readonly adapterId = 'opencode';
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private server?: OpenCodeServerClient;
  private stopWaiters: (() => void)[] = [];

  constructor(private readonly sink: (e: AdapterEvent) => void) {}

  attach(server: OpenCodeServerClient): void {
    this.server = server;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    try {
      await this.server?.stop();
    } catch {
      // stopping is best-effort; never surface teardown errors
    }
    for (const w of this.stopWaiters.splice(0)) w();
    this.sink({ type: 'status', phase: 'stopped' });
  }
}

/**
 * OpenCode adapter — passive completion observation via a local headless
 * opencode server. Polls session/message state; no plugins, no terminal
 * scraping, no OpenCode configuration changes.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id = 'opencode';
  readonly agentName = 'OpenCode';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new OpenCodeWatchHandle(sink);

    // Baseline time MUST be taken before the server launches — sessions that
    // appear while the server is still starting up are exactly the ones the
    // user wants to catch (they armed the watch right before working).
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';

    let server: OpenCodeServerClient;
    try {
      sink({ type: 'status', phase: 'connecting' });
      server = await OpenCodeServerClient.launch(target.workspaceRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sink({ type: 'status', phase: 'error', detail: message });
      throw err;
    }
    if (handle.isStopped()) {
      await server.stop();
      return handle;
    }
    handle.attach(server);

    // Observe BOTH worlds: the user's already-running OpenCode processes
    // (their TUI server sees git-project sessions we can never see from a
    // neutral directory) plus our own global-bucket instance.
    const endpoints: OpenCodeServerClient[] = [];
    try {
      for (const discovered of await discoverRunningServers(server.endpointPort)) {
        endpoints.push(discovered);
      }
    } catch {
      // discovery is best-effort
    }
    endpoints.push(server);

    const emittedTurns = new Set<string>();
    /** `${port}:${sessionId}` → session.time.updated at last fetch. Unchanged ⇒ skip refetch. */
    const fetchedAtUpdated = new Map<string, number | undefined>();
    let lastErrorMessage = '';

    const reportOnce = (message: string): void => {
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      sink({ type: 'error', message });
    };

    /** One poll pass over one endpoint. Returns the emitted completion, if any. */
    const pollEndpoint = async (
      client: OpenCodeServerClient,
      workspaceRoot?: string,
    ): Promise<AgentCompletion | null> => {
      let sessions: OcSessionInfo[];
      try {
        sessions = await client.listSessions();
      } catch (err) {
        reportOnce(`OpenCode 서버(${client.endpointPort}) 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }

      const candidates = selectCandidateSessions(sessions, { sinceMs, workspaceRoot }).sort(
        (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
      );

      for (const s of candidates) {
        if (handle.isStopped()) return null;
        const cacheKey = `${client.endpointPort}:${s.id}`;
        const updated = s.time?.updated;
        if (fetchedAtUpdated.has(cacheKey) && fetchedAtUpdated.get(cacheKey) === updated) continue;

        let summary;
        try {
          summary = summarizeLastTurn(await client.listMessages(s.id));
          fetchedAtUpdated.set(cacheKey, updated);
        } catch (err) {
          reportOnce(
            `세션 ${s.id} 조회 실패: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (!summary.ready || !summary.messageId) continue;
        const key = `${summary.sessionId ?? s.id}:${summary.messageId}`;
        if (emittedTurns.has(key)) continue;

        emittedTurns.add(key);
        return {
          adapterId: this.id,
          agentName: this.agentName,
          sessionId: summary.sessionId ?? s.id,
          workspace: s.directory ?? '',
          startedAt: summary.startedAtIso ?? undefined,
          observedAt: new Date().toISOString(),
          terminalSignal: summary.terminalSignal,
          rawFinalText: summary.text,
          rawProtocolRef: `opencode://session/${summary.sessionId ?? s.id}/message/${summary.messageId}`,
          completionKind:
            summary.kind === 'RESPONSE_COMPLETE' || summary.kind === 'INTERRUPTED' || summary.kind === 'PROCESS_FAILED'
              ? summary.kind
              : 'UNKNOWN',
        };
      }
      return null;
    };

    const tick = async (): Promise<void> => {
      if (handle.isStopped()) return;
      try {
        let failures = 0;
        for (const client of endpoints) {
          if (handle.isStopped()) return;
          let completion: AgentCompletion | null = null;
          try {
            completion = await pollEndpoint(client, target.workspaceRoot);
          } catch {
            failures++;
            continue;
          }
          if (completion) {
            sink({ type: 'completion', completion });
            return;
          }
        }
        if (debug && !handle.isStopped()) {
          console.error(
            `[opencode-adapter] poll: endpoints=${endpoints.length} failures=${failures} emitted=${emittedTurns.size}`,
          );
        }
        if (!handle.isStopped()) sink({ type: 'status', phase: 'watching' });
      } finally {
        handle.later(() => void tick(), POLL_MS);
      }
    };

    handle.later(() => void tick(), POLL_MS);
    handle.later(() => {
      if (!handle.isStopped()) {
        sink({ type: 'status', phase: 'stopped', detail: '감시 시간이 초과되어 자동 수신을 종료했습니다.' });
        void handle.stop();
      }
    }, WATCH_TIMEOUT_MS);

    return handle;
  }
}

export function createOpenCodeAdapter(): OpenCodeAdapter {
  return new OpenCodeAdapter();
}
