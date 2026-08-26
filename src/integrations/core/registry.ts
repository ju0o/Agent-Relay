import { AgentAdapter } from './types.js';

const adapters = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`어댑터가 이미 등록되어 있습니다: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
}

export function getAdapter(id: string): AgentAdapter | null {
  return adapters.get(id) ?? null;
}

export function listAdapters(): AgentAdapter[] {
  return [...adapters.values()];
}

/** Test-only reset. */
export function clearAdapters(): void {
  adapters.clear();
}
