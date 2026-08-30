/**
 * Agent display name → registered adapter ID mapping.
 *
 * This is the ONLY place that declares which Run Agents have a registered
 * AgentAdapter in V1. New entries MUST have a corresponding AgentAdapter
 * registered in CaptureManager before being added here.
 *
 * V1 registered adapters: opencode, claude-code, codex, commandcode, cline, grok.
 * Everything else returns null — callers MUST NOT silently fall back to any
 * default adapter.
 */

const AGENT_ADAPTER_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  ['OpenCode', 'opencode'],
  ['Claude Code', 'claude-code'],
  ['Codex', 'codex'],
  ['CommandCode', 'commandcode'],
  ['Cline', 'cline'],
  ['Grok', 'grok'],
]);

/**
 * Derive the registered adapter ID from an agent display name.
 * Returns null when no adapter is registered for the agent.
 * NEVER silently falls back to 'opencode' or any other default.
 */
export function agentNameToAdapterId(agentName: string): string | null {
  return AGENT_ADAPTER_MAP.get(agentName) ?? null;
}

/** True only when the agent name has a registered adapter. */
export function hasRegisteredAdapter(agentName: string): boolean {
  return AGENT_ADAPTER_MAP.has(agentName);
}

/** All agent display names that have registered adapters. */
export function supportedAgentNames(): string[] {
  return [...AGENT_ADAPTER_MAP.keys()];
}
