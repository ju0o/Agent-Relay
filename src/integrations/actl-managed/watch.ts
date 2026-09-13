/**
 * Phase 2 — actl-managed observation adapter.
 *
 * Does not scrape provider files itself. The Dispatcher/actl-bridge drives
 * collect, then delivers an exact FINAL as AgentCompletion through this
 * adapter's sink after CaptureManager.selectSession claims ownership.
 * forceBindSessionForTests / injectCompletionForTests are not used.
 */
import type { AgentAdapter, AdapterEvent, AgentCompletion, WatchHandle, WatchTarget } from '../core/types.js';
import { getAdapter, registerAdapter } from '../core/registry.js';

export const ACTL_MANAGED_ADAPTER_ID = 'actl-managed';

type Sink = (e: AdapterEvent) => void;

interface ActiveWatch {
  sink: Sink;
  target: WatchTarget;
  stopped: boolean;
}

const watches = new Map<string, ActiveWatch>();
let seq = 0;

function watchKeyFromTarget(target: WatchTarget): string {
  const cmd = target.actlManaged?.commandId;
  const runtime = target.actlManaged?.runtimeId;
  if (cmd && runtime) return `${ACTL_MANAGED_ADAPTER_ID}:${runtime}:${cmd}`;
  return `${ACTL_MANAGED_ADAPTER_ID}:anon:${++seq}`;
}

export function createActlManagedAdapter(): AgentAdapter {
  return {
    id: ACTL_MANAGED_ADAPTER_ID,
    agentName: 'ActlManaged',
    async startWatch(target: WatchTarget, sink: Sink): Promise<WatchHandle> {
      const key = watchKeyFromTarget(target);
      const active: ActiveWatch = { sink, target, stopped: false };
      watches.set(key, active);

      const sessionId = target.actlManaged?.sessionId;
      sink({
        type: 'sessions',
        sessions: sessionId
          ? [{ sessionId, directory: target.workspaceRoot, isNew: false, inFlight: false }]
          : [],
        armPass: true,
      });
      sink({ type: 'status', phase: 'watching', detail: 'actl-managed armed' });

      return {
        adapterId: ACTL_MANAGED_ADAPTER_ID,
        stop: async () => {
          active.stopped = true;
          watches.delete(key);
        },
      };
    },
  };
}

export function ensureActlManagedAdapterRegistered(): void {
  if (!getAdapter(ACTL_MANAGED_ADAPTER_ID)) {
    try {
      registerAdapter(createActlManagedAdapter());
    } catch {
      // already registered
    }
  }
}

/**
 * Production delivery path for bridge-admitted FINAL packets.
 * Matches watches by commandId (preferred) or runtimeId.
 */
export function deliverActlManagedCompletion(
  completion: AgentCompletion,
  match?: { commandId?: string; runtimeId?: string },
): number {
  let delivered = 0;
  for (const [key, watch] of watches) {
    if (watch.stopped) continue;
    const binding = watch.target.actlManaged;
    if (match?.commandId && binding?.commandId && binding.commandId !== match.commandId) continue;
    if (match?.runtimeId && binding?.runtimeId && binding.runtimeId !== match.runtimeId) continue;
    if (match?.commandId && !binding?.commandId && !key.includes(match.commandId)) continue;
    watch.sink({ type: 'completion', completion });
    delivered += 1;
  }
  return delivered;
}

/** Test helper — clear active watches. */
export function _resetActlManagedWatchesForTests(): void {
  watches.clear();
  seq = 0;
}
