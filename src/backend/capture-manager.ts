import { AdapterEvent, AgentCompletion, SessionObservation, WatchHandle } from '../integrations/core/types.js';
import { SessionBindingPolicy } from '../integrations/core/binding.js';
import { captureCompletion } from '../integrations/core/capture.js';
import { getAdapter, listAdapters, registerAdapter } from '../integrations/core/registry.js';
import { createOpenCodeAdapter } from '../integrations/opencode/watch.js';
import { createClaudeCodeAdapter } from '../integrations/claude/watch.js';
import { createCodexAdapter } from '../integrations/codex/watch.js';
import { createCommandCodeAdapter } from '../integrations/commandcode/watch.js';
import { createClineAdapter } from '../integrations/cline/watch.js';
import { createGrokAdapter } from '../integrations/grok/watch.js';
import { CaptureCandidateView, CaptureStatusView } from '../shared/types.js';

/**
 * Per-run capture context — holds ALL mutable state for one Run folder.
 * Contexts are never shared between folders; arming a new folder never
 * mutates an existing context.
 */
interface CaptureContext {
  readonly folder: string;
  readonly adapterId: string;
  handle: WatchHandle;
  policy: SessionBindingPolicy;
  armSnapshotSeeded: boolean;
  lastPhase: CaptureStatusView['phase'] | null;
  /** Dedupe key for watching/ambiguous status pushes. */
  lastPushKey: string;
  pending: { completion: AgentCompletion; timer: ReturnType<typeof setTimeout> } | null;
}

/**
 * Manages multiple independently armed Run captures simultaneously.
 *
 * Each Run folder owns its own CaptureContext — arm/disarm/events for
 * one Run NEVER affect another Run's watch, policy, or result files.
 *
 * Preferred call pattern:
 *   arm(folderA, 'opencode')   → context A created
 *   arm(folderB, 'claude-code') → context B created (A unaffected)
 *   disarm(folderA)            → A stopped, B unaffected
 *   disarmAll()                → app shutdown / test cleanup
 */
export class CaptureManager {
  /** Settle window before writing files (overridable for tests). */
  private readonly settleMs: number;

  /** Active capture contexts, keyed by absolute run folder path. */
  private readonly contexts = new Map<string, CaptureContext>();

  constructor(
    private readonly push: (s: CaptureStatusView) => void,
    opts: { settleMs?: number } = {},
  ) {
    this.settleMs = opts.settleMs ?? 6_000;

    for (const [id, factory] of [
      ['opencode', createOpenCodeAdapter],
      ['claude-code', createClaudeCodeAdapter],
      ['codex', createCodexAdapter],
      ['commandcode', createCommandCodeAdapter],
      ['cline', createClineAdapter],
      ['grok', createGrokAdapter],
    ] as const) {
      if (!getAdapter(id)) {
        try {
          registerAdapter(factory());
        } catch {
          // duplicate registration — another manager instance already owns it
        }
      }
    }
  }

  listAdapters(): { id: string; agentName: string }[] {
    return listAdapters().map((a) => ({ id: a.id, agentName: a.agentName }));
  }

  /** Agent-neutral display name for an adapter id (falls back to the id). */
  private agentNameOf(id?: string): string | undefined {
    if (!id) return undefined;
    return getAdapter(id)?.agentName ?? listAdapters().find((a) => a.id === id)?.agentName ?? undefined;
  }

  /**
   * True if the specific folder (or any folder) has an active watch.
   * Passing no argument tests whether ANY capture is active.
   */
  isActive(folder?: string): boolean {
    if (folder !== undefined) return this.contexts.has(folder);
    return this.contexts.size > 0;
  }

  /**
   * Arm a specific run folder with the given adapter.
   *
   * Invariant: only THIS folder's existing watch is stopped (if any).
   * All other active captures are completely untouched.
   */
  async arm(folder: string, adapterId = 'opencode'): Promise<void> {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('run folder 경로가 필요합니다.');

    // Stop only this folder's existing context — never touch others.
    await this.stopContextForFolder(folder, false);

    const adapter = getAdapter(adapterId);
    if (!adapter) {
      this.push({ phase: 'error', folder, message: `어댑터를 찾을 수 없습니다: ${adapterId}` });
      throw new Error(`어댑터를 찾을 수 없습니다: ${adapterId}`);
    }

    // Use a no-op handle until the real one is assigned; this lets the context
    // be registered BEFORE startWatch so synchronous sink events (e.g. an
    // immediate 'sessions' armPass) pass the stale-handle guard correctly.
    const noopHandle: WatchHandle = { adapterId: adapter.id, stop: async () => undefined };
    const ctx: CaptureContext = {
      folder,
      adapterId: adapter.id,
      handle: noopHandle,
      policy: new SessionBindingPolicy(),
      armSnapshotSeeded: false,
      lastPhase: null,
      lastPushKey: '',
      pending: null,
    };

    // Register BEFORE startWatch so the sink closure's identity guard works
    // for any events the adapter emits synchronously during startup.
    this.contexts.set(folder, ctx);

    try {
      ctx.handle = await adapter.startWatch({}, (e) => this.onEvent(ctx, e));

      // Guard: a synchronous 'stopped' status during startWatch may have already
      // removed the context — if so, stop the real handle and exit cleanly.
      if (this.contexts.get(folder) !== ctx) {
        await ctx.handle.stop().catch(() => undefined);
        return;
      }

      this.emitToCtx(ctx, { phase: 'watching', folder, adapterId: adapter.id });
    } catch (err) {
      this.contexts.delete(folder);
      this.clearPending(ctx);
      const message = err instanceof Error ? err.message : String(err);
      this.push({ phase: 'error', folder, message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Explicit user selection (ambiguity resolution for ONE run folder).
   * The chosen sessionId becomes THE only source for that Run; other Runs
   * are not affected.
   *
   * @param folder - The run folder whose ambiguity to resolve. When omitted
   *   the method falls back to the single active context (legacy / test usage).
   */
  selectSession(sessionId: string, folder?: string): boolean {
    const ctx = folder !== undefined
      ? this.contexts.get(folder)
      : (this.contexts.size === 1 ? [...this.contexts.values()][0] : undefined);
    if (!ctx) return false;

    const ok = ctx.policy.bindManual(sessionId);
    if (ok) {
      ctx.lastPushKey = '';
      this.emitToCtx(ctx, {
        phase: 'watching',
        folder: ctx.folder,
        adapterId: ctx.adapterId,
        boundSessionId: sessionId,
      });
    }
    return ok;
  }

  /**
   * Disarm a specific run folder. All other active captures are unaffected.
   *
   * When called with no argument the method stops all active contexts
   * (backward-compatible with test/legacy call sites that pre-date multi-run).
   */
  async disarm(folder?: string): Promise<void> {
    if (folder !== undefined) {
      await this.stopContextForFolder(folder, true);
    } else {
      // Legacy / cleanup: disarm every active context with status pushes.
      const folders = [...this.contexts.keys()];
      for (const f of folders) {
        await this.stopContextForFolder(f, true).catch(() => undefined);
      }
    }
  }

  /** Stop all active captures silently (app shutdown / test cleanup). */
  async disarmAll(): Promise<void> {
    const folders = [...this.contexts.keys()];
    await Promise.all(folders.map((f) => this.stopContextForFolder(f, false).catch(() => undefined)));
  }

  /** Alias kept for backward compatibility with the app shutdown path. */
  async dispose(): Promise<void> {
    await this.disarmAll();
  }

  // ── Per-folder internal stop ──────────────────────────────────────────────

  private async stopContextForFolder(folder: string, withStatus: boolean): Promise<void> {
    const ctx = this.contexts.get(folder);
    if (!ctx) {
      if (withStatus) this.push({ phase: 'stopped', folder });
      return;
    }
    this.contexts.delete(folder);
    this.clearPending(ctx);
    ctx.lastPhase = null;
    const h = ctx.handle;
    if (!withStatus) {
      await h.stop().catch(() => undefined);
      return;
    }
    await h.stop().catch(() => undefined);
    this.push({ phase: 'stopped', folder });
  }

  // ── Event routing ─────────────────────────────────────────────────────────

  /**
   * Called by the adapter's sink. The ctx reference is what we use to guard
   * against stale events from a handle that was already replaced or stopped:
   * if the folder now maps to a different context object, this event is stale.
   */
  private onEvent(ctx: CaptureContext, e: AdapterEvent): void {
    if (this.contexts.get(ctx.folder) !== ctx) return; // stale handle — ignore

    switch (e.type) {
      case 'sessions':
        this.onSessions(ctx, e.sessions, e.armPass);
        break;
      case 'status':
        if (e.phase === 'watching') {
          const bound = ctx.policy?.binding?.sessionId;
          this.emitToCtx(ctx, {
            phase: 'watching',
            folder: ctx.folder,
            adapterId: ctx.adapterId,
            ...(bound ? { boundSessionId: bound } : {}),
          });
        } else if (e.phase === 'stopped') {
          // Timeout-driven stop from inside the adapter.
          if (this.contexts.get(ctx.folder) === ctx) {
            this.contexts.delete(ctx.folder);
            this.emitToCtx(ctx, { phase: 'stopped', folder: ctx.folder, message: e.detail });
          }
        }
        break;
      case 'error':
        this.emitToCtx(ctx, { phase: 'error', folder: ctx.folder, message: e.message });
        break;
      case 'completion':
        this.onCompletion(ctx, e.completion);
        break;
    }
  }

  private onSessions(ctx: CaptureContext, sessions: SessionObservation[], armPass: boolean): void {
    if (this.contexts.get(ctx.folder) !== ctx) return;
    if (!ctx.policy) return;

    if (armPass && !ctx.armSnapshotSeeded) {
      ctx.policy.seedArmInFlight(sessions.filter((s) => s.inFlight).map((s) => s.sessionId));
      ctx.armSnapshotSeeded = true;
    }
    ctx.policy.note(sessions);

    // Any bound-but-not-yet-persisted binding is provisional: a rival
    // plausible source revokes it so files are never written on a guess.
    if (ctx.policy.binding && !ctx.policy.isPersisted) {
      const boundId = ctx.policy.binding.sessionId;
      const rival =
        ctx.policy.newSessionIds.some((id) => id !== boundId) ||
        ctx.policy.armInFlightSnapshot.some((id) => id !== boundId) ||
        ctx.policy.postArmInflightSnapshot.some((id) => id !== boundId) ||
        ctx.policy.candidatesNeedSelection();
      if (rival) {
        this.revokeAndAmbiguate(ctx);
        return;
      }
    }

    if (!ctx.policy.binding) {
      if (ctx.armSnapshotSeeded && ctx.policy.tryAutoBind()) {
        // Early deterministic binding — the bound Session identity becomes
        // visible while the agent is still working (Session-Bound Capture UX).
        this.emitWatchingBound(ctx);
        return;
      }
      const ambiguousNow =
        ctx.armSnapshotSeeded && (ctx.policy.isAmbiguous || ctx.policy.candidatesNeedSelection());
      if (ambiguousNow) {
        this.emitAmbiguous(ctx);
      }
    }
  }

  private onCompletion(ctx: CaptureContext, completion: AgentCompletion): void {
    if (this.contexts.get(ctx.folder) !== ctx) return;
    if (!ctx.policy) return;

    const decision = ctx.policy.decide(completion.sessionId ?? '');
    if (decision === 'ignore') return;
    if (decision === 'need-selection') {
      this.emitAmbiguous(ctx);
      return;
    }

    // accept — hold a settle window so a rival session appearing moments
    // later can still revoke the binding before files are written.
    if (ctx.pending) {
      if (ctx.pending.completion.sessionId === completion.sessionId) return; // dup while settling
      this.cancelPendingAndAmbiguate(ctx);
      return;
    }
    const timer = setTimeout(() => void this.settleCapture(ctx), this.settleMs);
    ctx.pending = { completion, timer };
  }

  private async settleCapture(ctx: CaptureContext): Promise<void> {
    if (this.contexts.get(ctx.folder) !== ctx) return;
    const p = ctx.pending;
    if (!p) return;
    ctx.pending = null;
    await this.persist(ctx, p.completion);
  }

  private cancelPendingAndAmbiguate(ctx: CaptureContext): void {
    this.clearPending(ctx);
    ctx.policy?.revoke();
    this.emitAmbiguous(ctx);
  }

  /**
   * Revoke a provisional binding whenever a rival session appears — used for
   * early deterministic bindings with no pending completion yet, and for
   * settle-window rival detection.
   */
  private revokeAndAmbiguate(ctx: CaptureContext): void {
    this.clearPending(ctx);
    ctx.policy?.revoke();
    this.emitAmbiguous(ctx);
  }

  private emitWatchingBound(ctx: CaptureContext): void {
    ctx.lastPushKey = '';
    this.emitToCtx(ctx, {
      phase: 'watching',
      folder: ctx.folder,
      adapterId: ctx.adapterId,
    });
  }

  private clearPending(ctx: CaptureContext): void {
    if (ctx.pending) clearTimeout(ctx.pending.timer);
    ctx.pending = null;
  }

  private async persist(ctx: CaptureContext, completion: AgentCompletion): Promise<void> {
    if (this.contexts.get(ctx.folder) !== ctx) return;
    const binding = ctx.policy?.binding;
    if (!binding || binding.sessionId !== completion.sessionId) return;

    const outcome = captureCompletion(ctx.folder, completion, { bindingReason: binding.reason });
    ctx.policy.markPersisted();
    if (!outcome.ok) {
      this.emitToCtx(ctx, {
        phase: 'error',
        folder: ctx.folder,
        message: outcome.reason ?? '결과 저장에 실패했습니다.',
      });
      return;
    }
    if (outcome.duplicate) return;
    this.emitToCtx(ctx, {
      phase: 'captured',
      folder: ctx.folder,
      adapterId: completion.adapterId,
      files: outcome.written,
      boundSessionId: binding.sessionId,
    });
    // One-shot semantics: silently disarm after a successful capture so a
    // later turn can never surprise-overwrite related files.
    void this.stopContextForFolder(ctx.folder, false);
  }

  private emitAmbiguous(ctx: CaptureContext): void {
    const candidates: CaptureCandidateView[] = ctx.policy!.candidates()
      .slice(0, 8)
      .map((c) => ({
        sessionId: c.sessionId,
        title: c.title,
        directory: c.directory,
      }));
    this.emitToCtx(ctx, {
      phase: 'ambiguous',
      folder: ctx.folder,
      adapterId: ctx.adapterId,
      candidates,
      message:
        '에이전트 세션이 여러 개 후보가 되어 자동 확정할 수 없습니다. 결과를 받을 세션을 선택하세요.',
    });
  }

  /**
   * Enrich and push a status view scoped to one context.
   * Dedupe suppresses repeat watching/ambiguous pushes with an identical key
   * so the UI is not spammed on every poll cycle.
   */
  private emitToCtx(ctx: CaptureContext, s: CaptureStatusView): void {
    const enriched: CaptureStatusView = {
      ...s,
      agentName: s.agentName ?? this.agentNameOf(s.adapterId ?? ctx.adapterId ?? undefined),
    };
    // Provenance: visible Session identity always mirrors the backend binding
    // state (sessionId + reason + title) — never a frontend-only value.
    if (ctx.policy) {
      const binding = ctx.policy.binding;
      if (binding) {
        enriched.boundSessionId = binding.sessionId;
        enriched.bindingReason = binding.reason;
        const obs = ctx.policy.bindingObservation;
        if (obs?.title) enriched.boundSessionTitle = obs.title;
      }
    }
    const key =
      enriched.phase +
      '|' +
      (enriched.phase === 'ambiguous'
        ? JSON.stringify(enriched.candidates?.map((c) => c.sessionId) ?? [])
        : enriched.phase === 'watching'
          ? (enriched.boundSessionId ?? '')
          : '');
    if (key === ctx.lastPushKey && (enriched.phase === 'watching' || enriched.phase === 'ambiguous')) return;
    ctx.lastPushKey = key;
    this.push(enriched);
  }
}
