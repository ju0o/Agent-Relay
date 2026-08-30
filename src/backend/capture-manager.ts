import { AdapterEvent, AgentCompletion, SessionObservation, WatchHandle } from '../integrations/core/types.js';
import { SessionBindingPolicy } from '../integrations/core/binding.js';
import { captureCompletion } from '../integrations/core/capture.js';
import { getAdapter, listAdapters, registerAdapter } from '../integrations/core/registry.js';
import { createOpenCodeAdapter } from '../integrations/opencode/watch.js';
import { createClaudeCodeAdapter } from '../integrations/claude/watch.js';
import { CaptureCandidateView, CaptureStatusView } from '../shared/types.js';

/**
 * Binds one registered adapter to one run folder and funnels completions
 * into the Core capture service. A deterministic session binding policy
 * decides WHICH agent session may supply the Run's result; anything else is
 * ignored. A short settle window guards each acceptance: if a rival session
 * appears before the result is written, the binding is revoked into the
 * explicit-selection flow — files are never written on a guess.
 */
export class CaptureManager {
  private static SETTLE_MS = 6_000;

  private handle: WatchHandle | null = null;
  private folder: string | null = null;
  private lastPhase: CaptureStatusView['phase'] | null = null;
  private policy: SessionBindingPolicy | null = null;
  private armSnapshotSeeded = false;
  private currentAdapterId: string | null = null;
  /** Dedupe of pushed binding/ambiguity state so the UI is not spammed. */
  private lastPushKey = '';
  private pending: { completion: AgentCompletion; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly push: (s: CaptureStatusView) => void) {
    for (const [id, factory] of [
      ['opencode', createOpenCodeAdapter],
      ['claude-code', createClaudeCodeAdapter],
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

  isActive(folder?: string): boolean {
    if (!this.handle) return false;
    return folder ? this.folder === folder : true;
  }

  /** Bind ONE registered adapter to a run folder. Replaces any active watch. */
  async arm(folder: string, adapterId = 'opencode'): Promise<void> {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('run folder 경로가 필요합니다.');
    await this.stopInternal(false);

    const adapter = getAdapter(adapterId);
    if (!adapter) {
      this.emit({ phase: 'error', folder, message: `어댑터를 찾을 수 없습니다: ${adapterId}` });
      throw new Error(`어댑터를 찾을 수 없습니다: ${adapterId}`);
    }

    this.folder = folder;
    this.policy = new SessionBindingPolicy();
    this.armSnapshotSeeded = false;
    this.lastPushKey = '';
    this.currentAdapterId = adapter.id;
    this.clearPending();
    try {
      this.handle = await adapter.startWatch({}, (e) => this.onEvent(e));
      this.emit({ phase: 'watching', folder, adapterId: adapter.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handle = null;
      this.folder = null;
      this.policy = null;
      this.emit({ phase: 'error', folder, message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Explicit user selection (ambiguity resolution). The chosen sessionId
   * becomes THE only source for this Run; an existing binding is never
   * replaced.
   */
  selectSession(sessionId: string): boolean {
    if (!this.policy || !this.handle) return false;
    const ok = this.policy.bindManual(sessionId);
    if (ok) {
      this.lastPushKey = '';
      this.emit({
        phase: 'watching',
        folder: this.folder ?? undefined,
        ...(this.currentAdapterId ? { adapterId: this.currentAdapterId } : {}),
        boundSessionId: sessionId,
      });
    }
    return ok;
  }

  async disarm(): Promise<void> {
    await this.stopInternal(true);
  }

  /** Teardown without status pushes (app shutdown). */
  async dispose(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    this.folder = null;
    this.lastPhase = null;
    this.policy = null;
    this.clearPending();
    if (h) await h.stop().catch(() => undefined);
  }

  private async stopInternal(withStatus: boolean): Promise<void> {
    const h = this.handle;
    const f = this.folder;
    this.handle = null;
    this.folder = null;
    this.policy = null;
    this.clearPending();
    if (h && !withStatus) {
      // suppress the handle's own 'stopped' event for silent internal stops
      this.lastPhase = null;
      await h.stop().catch(() => undefined);
      return;
    }
    this.lastPhase = null;
    if (h) await h.stop().catch(() => undefined);
    if (withStatus) this.emit({ phase: 'stopped', folder: f ?? undefined });
  }

  private onEvent(e: AdapterEvent): void {
    switch (e.type) {
      case 'sessions': {
        this.onSessions(e.sessions, e.armPass);
        break;
      }
      case 'status': {
        if (e.phase === 'watching') {
          const bound = this.policy?.binding?.sessionId;
          this.emit({
            phase: 'watching',
            folder: this.folder ?? undefined,
            ...(this.currentAdapterId ? { adapterId: this.currentAdapterId } : {}),
            ...(bound ? { boundSessionId: bound } : {}),
          });
        } else if (e.phase === 'stopped') {
          // timeout-driven stop from inside the adapter
          if (this.handle) {
            this.handle = null;
            const folder = this.folder ?? undefined;
            this.folder = null;
            this.policy = null;
            this.emit({ phase: 'stopped', folder, message: e.detail });
          }
        }
        break;
      }
      case 'error': {
        this.emit({ phase: 'error', folder: this.folder ?? undefined, message: e.message });
        break;
      }
      case 'completion': {
        this.onCompletion(e.completion);
        break;
      }
    }
  }

  private onSessions(sessions: SessionObservation[], armPass: boolean): void {
    if (!this.policy) return;
    if (armPass && !this.armSnapshotSeeded) {
      this.policy.seedArmInFlight(sessions.filter((s) => s.inFlight).map((s) => s.sessionId));
      this.armSnapshotSeeded = true;
    }
    this.policy.note(sessions);

    // Any bound-but-not-yet-persisted binding is provisional: a rival
    // plausible source revokes it so files are never written on a guess.
    if (this.policy.binding && !this.policy.isPersisted) {
      const boundId = this.policy.binding.sessionId;
      const rival =
        this.policy.newSessionIds.some((id) => id !== boundId) ||
        this.policy.armInFlightSnapshot.some((id) => id !== boundId) ||
        this.policy.postArmInflightSnapshot.some((id) => id !== boundId) ||
        this.policy.candidatesNeedSelection();
      if (rival) {
        this.revokeAndAmbiguate();
        return;
      }
    }

    if (!this.policy.binding) {
      if (this.armSnapshotSeeded && this.policy.tryAutoBind()) {
        // Early deterministic binding — the bound Session identity becomes
        // visible while the agent is still working (Session-Bound Capture UX),
        // not only at completion time.
        this.emitWatchingBound();
        return;
      }
      const ambiguousNow =
        this.armSnapshotSeeded && (this.policy.isAmbiguous || this.policy.candidatesNeedSelection());
      if (ambiguousNow) {
        this.emitAmbiguous();
      }
    }
  }

  private onCompletion(completion: AgentCompletion): void {
    const folder = this.folder;
    const policy = this.policy;
    if (!folder || !policy) return;

    const decision = policy.decide(completion.sessionId ?? '');
    if (decision === 'ignore') return;
    if (decision === 'need-selection') {
      this.emitAmbiguous();
      return;
    }

    // accept — but do NOT write yet: hold a settle window so a rival session
    // appearing moments later can still revoke the binding pre-write.
    if (this.pending) {
      if (this.pending.completion.sessionId === completion.sessionId) return; // dup while settling
      this.cancelPendingAndAmbiguate();
      return;
    }
    const binding = policy.binding!;
    const timer = setTimeout(() => void this.settleCapture(), CaptureManager.SETTLE_MS);
    this.pending = { completion, timer };
    void binding;
  }

  private async settleCapture(): Promise<void> {
    const p = this.pending;
    if (!p || !this.folder || !this.policy) return;
    this.pending = null;
    await this.persist(p.completion);
  }

  private cancelPendingAndAmbiguate(): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    this.policy?.revoke();
    this.emitAmbiguous();
  }

  /**
   * Revoke a provisional (not-yet-persisted) binding whenever a rival session
   * appears — used for early deterministic bindings that have no pending
   * completion yet, and for settle-window rival detection.
   */
  private revokeAndAmbiguate(): void {
    this.clearPending();
    this.policy?.revoke();
    this.emitAmbiguous();
  }

  /** Push the current watching state with the early-bound Session identity. */
  private emitWatchingBound(): void {
    this.lastPushKey = '';
    this.emit({
      phase: 'watching',
      folder: this.folder ?? undefined,
      ...(this.currentAdapterId ? { adapterId: this.currentAdapterId } : {}),
    });
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private async persist(completion: AgentCompletion): Promise<void> {
    const folder = this.folder;
    const policy = this.policy;
    if (!folder || !policy) return;
    const binding = policy.binding;
    if (!binding || binding.sessionId !== completion.sessionId) return;

    const outcome = captureCompletion(folder, completion, { bindingReason: binding.reason });
    policy.markPersisted();
    if (!outcome.ok) {
      this.emit({ phase: 'error', folder, message: outcome.reason ?? '결과 저장에 실패했습니다.' });
      return;
    }
    if (outcome.duplicate) return;
    this.emit({
      phase: 'captured',
      folder,
      adapterId: completion.adapterId,
      files: outcome.written,
      boundSessionId: binding.sessionId,
    });
    // One-shot semantics: disarm silently after a successful capture so a
    // later turn can never surprise-overwrite related files.
    void this.stopInternal(false);
  }

  private emitAmbiguous(): void {
    const candidates: CaptureCandidateView[] = this.policy!.candidates()
      .slice(0, 8)
      .map((c) => ({
        sessionId: c.sessionId,
        title: c.title,
        directory: c.directory,
      }));
    this.emit({
      phase: 'ambiguous',
      folder: this.folder ?? undefined,
      ...(this.currentAdapterId ? { adapterId: this.currentAdapterId } : {}),
      candidates,
      message:
        '에이전트 세션이 여러 개 후보가 되어 자동 확정할 수 없습니다. 결과를 받을 세션을 선택하세요.',
    });
  }

  private emit(s: CaptureStatusView): void {
    const enriched: CaptureStatusView = {
      ...s,
      agentName: s.agentName ?? this.agentNameOf(s.adapterId ?? this.currentAdapterId ?? undefined),
    };
    // Provenance: visible Session identity always mirrors the backend binding
    // state (sessionId + reason + title) — never a frontend-only value.
    if (this.policy) {
      const binding = this.policy.binding;
      if (binding) {
        enriched.boundSessionId = binding.sessionId;
        enriched.bindingReason = binding.reason;
        const obs = this.policy.bindingObservation;
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
    if (key === this.lastPushKey && (enriched.phase === 'watching' || enriched.phase === 'ambiguous')) return;
    this.lastPushKey = key;
    this.push(enriched);
  }
}
