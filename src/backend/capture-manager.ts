import { AdapterEvent, WatchHandle } from '../integrations/core/types.js';
import { captureCompletion } from '../integrations/core/capture.js';
import { getAdapter, listAdapters, registerAdapter } from '../integrations/core/registry.js';
import { createOpenCodeAdapter } from '../integrations/opencode/watch.js';
import { CaptureStatusView } from '../shared/types.js';

/**
 * Binds one adapter watch to one run folder and funnels completions into
 * the Core capture service. Auto-capture is strictly additive: any failure
 * here is observable (status push) but can never block or corrupt a Run.
 */
export class CaptureManager {
  private handle: WatchHandle | null = null;
  private folder: string | null = null;
  private lastPhase: CaptureStatusView['phase'] | null = null;

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
    try {
      this.handle = await adapter.startWatch({}, (e) => this.onEvent(e));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.handle = null;
      this.folder = null;
      this.emit({ phase: 'error', folder, message });
    }
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
    if (h) await h.stop().catch(() => undefined);
  }

  private async stopInternal(withStatus: boolean): Promise<void> {
    const h = this.handle;
    const f = this.folder;
    this.handle = null;
    this.folder = null;
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
      case 'status': {
        if (e.phase === 'captured') break;
        if (e.phase === 'error') break;
        if (e.phase === 'watching') {
          this.emit({ phase: 'watching', folder: this.folder ?? undefined, adapterId: 'opencode' });
        } else if (e.phase === 'stopped') {
          // timeout-driven stop from inside the adapter
          if (this.handle) {
            this.handle = null;
            const folder = this.folder ?? undefined;
            this.folder = null;
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
        const folder = this.folder;
        if (!folder) return;
        const outcome = captureCompletion(folder, e.completion);
        if (!outcome.ok) {
          this.emit({ phase: 'error', folder, message: outcome.reason ?? '결과 저장에 실패했습니다.' });
          return;
        }
        if (outcome.duplicate) return;
        this.emit({ phase: 'captured', folder, adapterId: e.completion.adapterId, files: outcome.written });
        // One-shot semantics: disarm silently after a successful capture so a
        // later turn can never surprise-overwrite related files.
        void this.stopInternal(false);
        break;
      }
    }
  }

  private emit(s: CaptureStatusView): void {
    if (s.phase === 'watching' && this.lastPhase === 'watching') return;
    this.lastPhase = s.phase;
    this.push(s);
  }
}
