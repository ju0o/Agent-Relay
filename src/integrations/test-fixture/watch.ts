/**
 * Deterministic observation adapter for Phase H tests / synthetic closed-loop.
 * Does not talk to real coding agents or APIs.
 */
import type { AgentAdapter, AdapterEvent, WatchHandle, WatchTarget } from '../core/types.js';
import { getAdapter, registerAdapter } from '../core/registry.js';

export const TEST_FIXTURE_ADAPTER_ID = 'test-fixture';

type Sink = (e: AdapterEvent) => void;

const sinks = new Map<string, Sink>();
let seq = 0;

export function createTestFixtureAdapter(): AgentAdapter {
  return {
    id: TEST_FIXTURE_ADAPTER_ID,
    agentName: 'TestFixture',
    async startWatch(_target: WatchTarget, sink: Sink): Promise<WatchHandle> {
      const watchKey = `${TEST_FIXTURE_ADAPTER_ID}:${++seq}`;
      sinks.set(watchKey, sink);
      // Seed empty arm pass so binding policy can accept manual bind.
      sink({ type: 'sessions', sessions: [], armPass: true });
      return {
        adapterId: TEST_FIXTURE_ADAPTER_ID,
        stop: async () => {
          sinks.delete(watchKey);
        },
      };
    },
  };
}

/** Ensure the test fixture adapter is registered (idempotent). */
export function ensureTestFixtureAdapterRegistered(): void {
  if (!getAdapter(TEST_FIXTURE_ADAPTER_ID)) {
    try {
      registerAdapter(createTestFixtureAdapter());
    } catch {
      // already registered
    }
  }
}

/** Emit a completion to all active test-fixture watches (best-effort). */
export function emitTestFixtureCompletion(completion: import('../core/types.js').AgentCompletion): void {
  for (const sink of sinks.values()) {
    sink({ type: 'completion', completion });
  }
}
