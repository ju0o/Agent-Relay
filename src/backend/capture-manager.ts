import * as path from 'path';
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
import { CaptureCandidateView, CaptureStatusView, MaterializeParams } from '../shared/types.js';

/**
 * Per-capture context — holds ALL mutable state for one Draft or materialized Run.
 *
 * Before materialization: folder = null.
 * After materialization:  folder = absolute run folder path.
 *
 * Contexts are NEVER shared; arming a new captureId never mutates an existing one.
 */
interface CaptureContext {
  /** Stable identity — never changes after arm, independent of physical folder. */
  readonly captureId: string;
  /** Physical run folder. null means the Draft has not yet materialized. */
  folder: string | null;
  readonly adapterId: string;
  handle: WatchHandle;
  policy: SessionBindingPolicy;
  armSnapshotSeeded: boolean;
  lastPhase: CaptureStatusView['phase'] | null;
  /** Dedupe key for watching/ambiguous status pushes. */
  lastPushKey: string;
  pending: { completion: AgentCompletion; timer: ReturnType<typeof setTimeout> } | null;
  /** Parameters for on-demand folder creation when folder is null. */
  materializeParams?: MaterializeParams;
}

/** Callback that atomically creates a physical Run folder for a Draft. */
export type MaterializeFn = (captureId: string, params: MaterializeParams) => Promise<{ folder: string; run: string }>;

/**
 * Manages multiple independently armed Run captures simultaneously.
 *
 * Phase A2: contexts are keyed by captureId (not folder). A Draft can be armed
 * with no physical folder; the folder is set lazily on first meaningful data.
 *
 * Backward compatibility:
 *   arm(folderPath, adapterId)  — legacy; captureId = folderPath, folder = folderPath
 *   arm(captureId, adapterId, { isDraft: true, materializeParams })  — Phase A2 Draft
 *   arm(captureId, adapterId, { folder })                            — Phase A2 materialized
 */
export class CaptureManager {
  private readonly settleMs: number;
  private readonly materializeFn?: MaterializeFn;

  /** Active capture contexts, keyed by captureId. */
  private readonly contexts = new Map<string, CaptureContext>();

  constructor(
    private readonly push: (s: CaptureStatusView) => void,
    opts: { settleMs?: number; materializeFn?: MaterializeFn } = {},
  ) {
    this.settleMs = opts.settleMs ?? 6_000;
    this.materializeFn = opts.materializeFn;

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

  private agentNameOf(id?: string): string | undefined {
    if (!id) return undefined;
    return getAdapter(id)?.agentName ?? listAdapters().find((a) => a.id === id)?.agentName ?? undefined;
  }

  /**
   * True if the specific captureId (or folder for legacy callers) has an active watch.
   * Passing no argument tests whether ANY capture is active.
   */
  isActive(captureIdOrFolder?: string): boolean {
    if (captureIdOrFolder !== undefined) {
      if (this.contexts.has(captureIdOrFolder)) return true;
      return this.findByFolder(captureIdOrFolder) !== undefined;
    }
    return this.contexts.size > 0;
  }

  /**
   * Arm a Draft or existing Run.
   *
   * @param captureId  Stable identity for this capture (passed from the tab).
   * @param adapterId  Adapter to use (default 'opencode').
   * @param opts.folder         Physical folder (undefined = derive from captureId for
   *                            legacy callers; null / opts.isDraft=true = Draft).
   * @param opts.isDraft        Explicitly arm as Draft (folder = null, no legacy fallback).
   * @param opts.materializeParams  Required when isDraft=true to enable auto-materialization.
   *
   * Backward compatibility: arm(folderPath, adapterId) with no opts treats
   * folderPath as both captureId AND folder.
   */
  async arm(
    captureId: string,
    adapterId = 'opencode',
    opts?: { folder?: string; isDraft?: boolean; materializeParams?: MaterializeParams },
  ): Promise<void> {
    if (typeof captureId !== 'string' || !captureId.trim()) {
      throw new Error('captureId가 필요합니다.');
    }

    // Resolve folder:
    //   isDraft=true  → null (Draft)
    //   folder given  → use it
    //   neither       → treat captureId as folder (legacy: arm(folderPath, adapterid))
    const folder: string | null =
      opts?.isDraft === true ? null :
      opts?.folder !== undefined ? opts.folder :
      captureId;

    // Stop only this captureId's existing context — never touch others.
    await this.stopById(captureId, false);

    const adapter = getAdapter(adapterId);
    if (!adapter) {
      this.push({ phase: 'error', captureId, folder: folder ?? undefined, message: `어댑터를 찾을 수 없습니다: ${adapterId}` });
      throw new Error(`어댑터를 찾을 수 없습니다: ${adapterId}`);
    }

    const noopHandle: WatchHandle = { adapterId: adapter.id, stop: async () => undefined };
    const ctx: CaptureContext = {
      captureId,
      folder,
      adapterId: adapter.id,
      handle: noopHandle,
      policy: new SessionBindingPolicy(),
      armSnapshotSeeded: false,
      lastPhase: null,
      lastPushKey: '',
      pending: null,
      materializeParams: opts?.materializeParams,
    };

    // Register BEFORE startWatch so synchronous sink events pass the stale-handle guard.
    this.contexts.set(captureId, ctx);

    try {
      ctx.handle = await adapter.startWatch({}, (e) => this.onEvent(ctx, e));

      if (this.contexts.get(captureId) !== ctx) {
        await ctx.handle.stop().catch(() => undefined);
        return;
      }

      this.emitToCtx(ctx, {
        phase: 'watching',
        captureId,
        folder: folder ?? undefined,
        adapterId: adapter.id,
      });
    } catch (err) {
      this.contexts.delete(captureId);
      this.clearPending(ctx);
      const message = err instanceof Error ? err.message : String(err);
      this.push({ phase: 'error', captureId, folder: folder ?? undefined, message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Assign a physical folder to an existing Draft context without resetting
   * SessionBindingPolicy. Called when the frontend materializes a Run manually
   * (e.g. on non-empty Prompt save) while capture is already armed.
   *
   * If no context exists for captureId this is a no-op (returns false).
   */
  assignFolder(captureId: string, folder: string): boolean {
    const ctx = this.contexts.get(captureId);
    if (!ctx) return false;
    if (ctx.folder === folder) return true;
    ctx.folder = folder;
    ctx.lastPushKey = '';
    this.emitToCtx(ctx, {
      phase: 'watching',
      captureId,
      folder,
      adapterId: ctx.adapterId,
    });
    return true;
  }

  /**
   * Disarm a specific capture (by captureId or folder for legacy callers).
   * With no argument stops ALL active contexts.
   */
  async disarm(captureIdOrFolder?: string): Promise<void> {
    if (captureIdOrFolder !== undefined) {
      if (this.contexts.has(captureIdOrFolder)) {
        await this.stopById(captureIdOrFolder, true);
      } else {
        const ctx = this.findByFolder(captureIdOrFolder);
        if (ctx) {
          await this.stopById(ctx.captureId, true);
        } else {
          this.push({ phase: 'stopped', folder: captureIdOrFolder });
        }
      }
    } else {
      const ids = [...this.contexts.keys()];
      for (const id of ids) {
        await this.stopById(id, true).catch(() => undefined);
      }
    }
  }

  /** Stop all active captures silently (app shutdown / test cleanup). */
  async disarmAll(): Promise<void> {
    const ids = [...this.contexts.keys()];
    await Promise.all(ids.map((id) => this.stopById(id, false).catch(() => undefined)));
  }

  async dispose(): Promise<void> {
    await this.disarmAll();
  }

  /**
   * Explicit user selection (ambiguity resolution).
   * Accepts captureId (preferred) or folder path (legacy).
   */
  selectSession(sessionId: string, captureIdOrFolder?: string): boolean {
    let ctx: CaptureContext | undefined;
    if (captureIdOrFolder !== undefined) {
      ctx = this.contexts.get(captureIdOrFolder) ?? this.findByFolder(captureIdOrFolder);
    } else if (this.contexts.size === 1) {
      ctx = [...this.contexts.values()][0];
    }
    if (!ctx) return false;

    const ok = ctx.policy.bindManual(sessionId);
    if (ok) {
      ctx.lastPushKey = '';
      this.emitToCtx(ctx, {
        phase: 'watching',
        captureId: ctx.captureId,
        folder: ctx.folder ?? undefined,
        adapterId: ctx.adapterId,
        boundSessionId: sessionId,
      });
    }
    return ok;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private findByFolder(folder: string): CaptureContext | undefined {
    for (const ctx of this.contexts.values()) {
      if (ctx.folder === folder) return ctx;
    }
    return undefined;
  }

  private async stopById(captureId: string, withStatus: boolean): Promise<void> {
    const ctx = this.contexts.get(captureId);
    if (!ctx) {
      if (withStatus) this.push({ phase: 'stopped', captureId, folder: undefined });
      return;
    }
    this.contexts.delete(captureId);
    this.clearPending(ctx);
    ctx.lastPhase = null;
    await ctx.handle.stop().catch(() => undefined);
    if (withStatus) {
      this.push({ phase: 'stopped', captureId, folder: ctx.folder ?? undefined });
    }
  }

  // ── Event routing ─────────────────────────────────────────────────────────

  private onEvent(ctx: CaptureContext, e: AdapterEvent): void {
    if (this.contexts.get(ctx.captureId) !== ctx) return; // stale — ignore

    switch (e.type) {
      case 'sessions':
        this.onSessions(ctx, e.sessions, e.armPass);
        break;
      case 'status':
        if (e.phase === 'watching') {
          const bound = ctx.policy?.binding?.sessionId;
          this.emitToCtx(ctx, {
            phase: 'watching',
            captureId: ctx.captureId,
            folder: ctx.folder ?? undefined,
            adapterId: ctx.adapterId,
            ...(bound ? { boundSessionId: bound } : {}),
          });
        } else if (e.phase === 'stopped') {
          if (this.contexts.get(ctx.captureId) === ctx) {
            this.contexts.delete(ctx.captureId);
            this.emitToCtx(ctx, {
              phase: 'stopped',
              captureId: ctx.captureId,
              folder: ctx.folder ?? undefined,
              message: e.detail,
            });
          }
        }
        break;
      case 'error':
        this.emitToCtx(ctx, {
          phase: 'error',
          captureId: ctx.captureId,
          folder: ctx.folder ?? undefined,
          message: e.message,
        });
        break;
      case 'completion':
        this.onCompletion(ctx, e.completion);
        break;
    }
  }

  private onSessions(ctx: CaptureContext, sessions: SessionObservation[], armPass: boolean): void {
    if (this.contexts.get(ctx.captureId) !== ctx) return;
    if (!ctx.policy) return;

    if (armPass && !ctx.armSnapshotSeeded) {
      ctx.policy.seedArmInFlight(sessions.filter((s) => s.inFlight).map((s) => s.sessionId));
      ctx.armSnapshotSeeded = true;
    }
    ctx.policy.note(sessions);

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
    if (this.contexts.get(ctx.captureId) !== ctx) return;
    if (!ctx.policy) return;

    const decision = ctx.policy.decide(completion.sessionId ?? '');
    if (decision === 'ignore') return;
    if (decision === 'need-selection') {
      this.emitAmbiguous(ctx);
      return;
    }

    if (ctx.pending) {
      if (ctx.pending.completion.sessionId === completion.sessionId) return;
      this.cancelPendingAndAmbiguate(ctx);
      return;
    }
    const timer = setTimeout(() => void this.settleCapture(ctx), this.settleMs);
    ctx.pending = { completion, timer };
  }

  private async settleCapture(ctx: CaptureContext): Promise<void> {
    if (this.contexts.get(ctx.captureId) !== ctx) return;
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

  private revokeAndAmbiguate(ctx: CaptureContext): void {
    this.clearPending(ctx);
    ctx.policy?.revoke();
    this.emitAmbiguous(ctx);
  }

  private emitWatchingBound(ctx: CaptureContext): void {
    ctx.lastPushKey = '';
    this.emitToCtx(ctx, {
      phase: 'watching',
      captureId: ctx.captureId,
      folder: ctx.folder ?? undefined,
      adapterId: ctx.adapterId,
    });
  }

  private clearPending(ctx: CaptureContext): void {
    if (ctx.pending) clearTimeout(ctx.pending.timer);
    ctx.pending = null;
  }

  private async persist(ctx: CaptureContext, completion: AgentCompletion): Promise<void> {
    if (this.contexts.get(ctx.captureId) !== ctx) return;
    const binding = ctx.policy?.binding;
    if (!binding || binding.sessionId !== completion.sessionId) return;

    // ── Lazy materialization (Phase A2) ──────────────────────────────────────
    // If no physical folder exists yet (Draft arm), atomically create one now.
    let runLabel: string | undefined;
    if (ctx.folder === null) {
      if (!ctx.materializeParams || !this.materializeFn) {
        this.emitToCtx(ctx, {
          phase: 'error',
          captureId: ctx.captureId,
          message: '런 폴더를 확정할 수 없습니다. 프로젝트를 선택한 뒤 캡처를 재시작하세요.',
        });
        return;
      }
      try {
        const { folder, run } = await this.materializeFn(ctx.captureId, ctx.materializeParams);
        if (this.contexts.get(ctx.captureId) !== ctx) return; // disarmed during await
        ctx.folder = folder;
        runLabel = run;
      } catch (err) {
        if (this.contexts.get(ctx.captureId) !== ctx) return;
        const message = err instanceof Error ? err.message : String(err);
        this.emitToCtx(ctx, { phase: 'error', captureId: ctx.captureId, message });
        return;
      }
    }

    const folder = ctx.folder!;
    if (!runLabel) runLabel = path.basename(folder);

    const outcome = captureCompletion(folder, completion, { bindingReason: binding.reason });
    ctx.policy.markPersisted();
    if (!outcome.ok) {
      this.emitToCtx(ctx, {
        phase: 'error',
        captureId: ctx.captureId,
        folder,
        message: outcome.reason ?? '결과 저장에 실패했습니다.',
      });
      return;
    }
    if (outcome.duplicate) return;
    this.emitToCtx(ctx, {
      phase: 'captured',
      captureId: ctx.captureId,
      folder,
      run: runLabel,
      adapterId: completion.adapterId,
      files: outcome.written,
      boundSessionId: binding.sessionId,
    });
    void this.stopById(ctx.captureId, false);
  }

  private emitAmbiguous(ctx: CaptureContext): void {
    const candidates: CaptureCandidateView[] = ctx.policy!.candidates()
      .slice(0, 8)
      .map((c) => ({ sessionId: c.sessionId, title: c.title, directory: c.directory }));
    this.emitToCtx(ctx, {
      phase: 'ambiguous',
      captureId: ctx.captureId,
      folder: ctx.folder ?? undefined,
      adapterId: ctx.adapterId,
      candidates,
      message: '에이전트 세션이 여러 개 후보가 되어 자동 확정할 수 없습니다. 결과를 받을 세션을 선택하세요.',
    });
  }

  private emitToCtx(ctx: CaptureContext, s: CaptureStatusView): void {
    const enriched: CaptureStatusView = {
      ...s,
      captureId: ctx.captureId,
      folder: s.folder ?? (ctx.folder ?? undefined),
      agentName: s.agentName ?? this.agentNameOf(s.adapterId ?? ctx.adapterId ?? undefined),
    };
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
