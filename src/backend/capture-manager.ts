import { AdapterEvent, AgentCompletion, SessionObservation, WatchHandle } from '../integrations/core/types.js';
import { SessionBindingPolicy } from '../integrations/core/binding.js';
import { captureCompletion } from '../integrations/core/capture.js';
import { getAdapter, listAdapters, registerAdapter } from '../integrations/core/registry.js';
import { createOpenCodeAdapter } from '../integrations/opencode/watch.js';
import { CaptureCandidateView, CaptureStatusView } from '../shared/types.js';

/**
 * Binds one adapter watch to one run folder and funnels completions into
 * the Core capture service. A deterministic session binding policy decides
 * WHICH OpenCode session may supply the Run's result; anything else is
 * ignored. Auto-capture is strictly additive: any failure here is observable
 * (status push) but can never block or corrupt a Run.
 */
export class CaptureManager {
  private handle: WatchHandle | null = null;
  private folder: string | null = null;
  private lastPhase: CaptureStatusView['phase'] | null = null;
  private policy: SessionBindingPolicy | null = null;
  private armSnapshotSeeded = false;
  /** Dedupe of pushed binding/ambiguity state so the UI is not spammed. */
  private lastPushKey = '';

  constructor(private readonly push: (s: CaptureStatusView) => void) {
    if (!getAdapter('opencode')) {
      try {
        registerAdapter(createOpenCodeAdapter());
      } catch {
        // duplicate registration — another manager instance already owns it
      }
    }
  }

  listAdapters(): { id: string; agentName: string }[] {
    return listAdapters().map((a) => ({ id: a.id, agentName: a.agentName }));
  }

  isActive(folder?: string): boolean {
    if (!this.handle) return false;
    return folder ? this.folder === folder : true;
  }

  /** Bind the OpenCode adapter to a run folder. Replaces any active watch. */
  async arm(folder: string): Promise<void> {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('run folder 경로가 필요합니다.');
    await this.stopInternal(false);

    const adapter = getAdapter('opencode');
    if (!adapter) {
      this.emit({ phase: 'error', folder, message: 'OpenCode 어댑터를 찾을 수 없습니다.' });
      throw new Error('OpenCode 어댑터를 찾을 수 없습니다.');
    }

    this.folder = folder;
    this.policy = new SessionBindingPolicy();
    this.armSnapshotSeeded = false;
    this.lastPushKey = '';
    try {
      this.handle = await adapter.startWatch({}, (e) => this.onEvent(e));
      this.emit({ phase: 'watching', folder, adapterId: 'opencode' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handle = null;
      this.folder = null;
      this.policy = null;
      this.emit({ phase: 'error', folder, message });
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
        adapterId: 'opencode',
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
    if (h) await h.stop().catch(() => undefined);
  }

  private async stopInternal(withStatus: boolean): Promise<void> {
    const h = this.handle;
    const f = this.folder;
    this.handle = null;
    this.folder = null;
    this.policy = null;
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
            adapterId: 'opencode',
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

    if (!this.policy.binding) {
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

    const binding = policy.binding!;
    const outcome = captureCompletion(folder, completion, { bindingReason: binding.reason });
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
      adapterId: 'opencode',
      candidates,
      message:
        'OpenCode 세션이 여러 개여서 자동 확정할 수 없습니다. 결과를 받을 세션을 선택하세요.',
    });
  }

  private emit(s: CaptureStatusView): void {
    const key =
      s.phase +
      '|' +
      (s.phase === 'ambiguous'
        ? JSON.stringify(s.candidates?.map((c) => c.sessionId) ?? [])
        : s.phase === 'watching'
          ? (s.boundSessionId ?? '')
          : '');
    if (key === this.lastPushKey && (s.phase === 'watching' || s.phase === 'ambiguous')) return;
    this.lastPushKey = key;
    this.push(s);
  }
}
