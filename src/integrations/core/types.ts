/**
 * Agent-neutral adapter boundary (vNext foundation).
 *
 * An AgentAdapter observes a coding-agent session and reports exactly one
 * thing: an AgentCompletion packet. It NEVER decides whether the product
 * Task itself succeeded — RESPONSE_COMPLETE only means the agent finished
 * producing a response.
 */

export type CompletionKind =
  | 'RESPONSE_COMPLETE'
  | 'PROCESS_FAILED'
  | 'INTERRUPTED'
  | 'BLOCKED'
  | 'UNKNOWN';

export const COMPLETION_KINDS: CompletionKind[] = [
  'RESPONSE_COMPLETE',
  'PROCESS_FAILED',
  'INTERRUPTED',
  'BLOCKED',
  'UNKNOWN',
];

export interface AgentCompletion {
  /** Registered adapter id, e.g. 'opencode'. */
  adapterId: string;
  /** Human-facing agent name, e.g. 'OpenCode'. */
  agentName: string;
  sessionId?: string;
  /** Workspace directory the agent ran in. */
  workspace: string;
  startedAt?: string;
  /** When the adapter observed the terminal signal (ISO 8601). */
  observedAt: string;
  /** Adapter-specific terminal marker, e.g. 'opencode.message.completed'. */
  terminalSignal: string;
  exitCode?: number;
  /** Verbatim final agent response text. Never rewritten by the Core. */
  rawFinalText: string;
  /** Opaque reference into the agent's own protocol/storage, e.g. 'opencode://session/ses_x/message/msg_y'. */
  rawProtocolRef?: string;
  completionKind: CompletionKind;
}

export type AdapterPhase = 'connecting' | 'watching' | 'captured' | 'error' | 'stopped';

/** One observed agent session, enriched with binding-relevant evidence. */
export interface SessionObservation {
  sessionId: string;
  directory?: string;
  title?: string;
  updatedMs?: number;
  /** Session was created at/after the watch arm timestamp (exact identity evidence). */
  isNew: boolean;
  /** The session's last turn is started but not completed (streaming right now). */
  inFlight: boolean;
}

export type AdapterEvent =
  | { type: 'status'; phase: AdapterPhase; detail?: string }
  | { type: 'completion'; completion: AgentCompletion }
  | { type: 'error'; message: string }
  /**
   * Emitted after each poll pass. `armPass` marks the FIRST successful pass —
   * its `inFlight` flags constitute the arm-time snapshot used by binding.
   */
  | { type: 'sessions'; sessions: SessionObservation[]; armPass: boolean };

export interface WatchTarget {
  /** Optional workspace directory hint for scoping observation. */
  workspaceRoot?: string;
}

export interface WatchHandle {
  readonly adapterId: string;
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly agentName: string;
  /**
   * Begin observing. Resolves once observation is armed (or rejects when the
   * agent integration cannot be reached). Events go to `sink`; errors are
   * observable but must never crash the host.
   */
  startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle>;
}

export interface CaptureOutcome {
  ok: boolean;
  /** File names written by this capture (relative to the run folder). */
  written: string[];
  /** Pre-existing files intentionally left untouched. */
  skipped: string[];
  /** True when this exact completion was already persisted before. */
  duplicate: boolean;
  reason?: string;
}
