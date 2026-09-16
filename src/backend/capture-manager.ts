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
import { createActlManagedAdapter } from '../integrations/actl-managed/watch.js';
import type { ActlManagedWatchBinding } from '../integrations/core/types.js';
import { CaptureCandidateView, CaptureStatusView, MaterializeParams } from '../shared/types.js';
import {
  promoteObservedResult,
  type ExecutionBinding,
} from './result-bridge.js';
import { releaseObservationLockByBinding } from './observation-lock.js';

export type { ExecutionBinding };

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
  /**
   * Physical run folder. null means the Draft has not yet materialized.
   *
   * NOTE: this is the RELAY STORAGE folder — the folder where prompt.md,
   * result.md and evidence/ are written. It is NOT the coding workspace where
   * the agent runs (e.g. the source repository). Those are separate concepts.
   * Do not pass this as WatchTarget.workspaceRoot.
   */
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
  /**
   * Phase H — trusted Dispatcher execution binding.
   * When present: folder MUST already exist; materializeOnce MUST NOT run;
   * RESULT_RECEIVED promotion goes only through Result Bridge for RESPONSE_COMPLETE.
   */
  executionBinding?: ExecutionBinding;
  /** Coding workspace used for observation scoping + observation lock release. */
  workspaceRoot?: string;
}

/** Callback that atomically creates a physical Run folder for a Draft. */
export type MaterializeFn = (captureId: string, params: MaterializeParams) => Promise<{ folder: string; run: string }>;

/**
 * Manages multiple independently armed Run captures simultaneously.
 *
 * Phase A2: contexts are keyed by captureId (not folder). A Draft can be armed
 * with no physical folder; the folder is set lazily on first meaningful data.
 *
 * Phase B1 (this file): adds exclusive session ownership so two captures using
 * the same adapter cannot both persist the same agent session's completion.
 *
 *   ONE (adapterId, sessionId) → at most ONE captureId.
 *
 * Backward compatibility:
 *   arm(folderPath, adapterId)  — legacy; captureId = normalized(folderPath),
 *                                 folder = normalized(folderPath)
 *   arm(captureId, adapterId, { isDraft: true, materializeParams })  — Draft
 *   arm(captureId, adapterId, { folder })                            — existing Run
 */
export class CaptureManager {
  private readonly settleMs: number;
  private readonly materializeFn?: MaterializeFn;

  /** Active capture contexts, keyed by captureId. */
  private readonly contexts = new Map<string, CaptureContext>();

  /**
   * Exclusive session ownership registry.
   * Key:   "${adapterId}::${sessionId}"
   * Value: captureId that owns that session
   *
   * Invariant: at most ONE captureId may appear as the value for any key.
   * Before any automatic binding or completion acceptance, the context must
   * successfully claim (or already own) the session here.
   */
  private readonly sessionOwners = new Map<string, string>();

  /**
   * Per-captureId materialization deduplication cache.
   *
   * Maps normalizedId → Promise<{folder, run}>.
   *
   * INVARIANT: At most ONE physical Run is ever allocated for a given captureId.
   * Any concurrent materialization request for the same captureId receives the
   * same Promise and thus the same {folder, run} — preventing split writes where
   * prompt.md ends up in Run 04 and agent-result.md ends up in Run 05.
   *
   * Cleared when:
   *   • arm() replaces the context (new arm, new params, fresh allocation needed)
   *   • stopById() removes the context (disarm — retry after re-arm gets fresh alloc)
   *   • materializeFn throws (failure removed so retry is possible)
   */
  private readonly materializeCache = new Map<string, Promise<{ folder: string; run: string }>>();

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
      ['actl-managed', createActlManagedAdapter],
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
      // Also accept legacy calls with a normalized folder path
      const norm = this.normalizePath(captureIdOrFolder);
      if (norm !== captureIdOrFolder && this.contexts.has(norm)) return true;
      return this.findByFolder(captureIdOrFolder) !== undefined;
    }
    return this.contexts.size > 0;
  }

  /**
   * Arm a Draft or existing Run.
   *
   * @param captureId  Stable identity (from the tab or legacy folder path).
   * @param adapterId  Adapter to use (default 'opencode').
   * @param opts.folder         Physical Relay storage folder (undefined = derive from
   *                            captureId for legacy callers; isDraft=true = null/Draft).
   *                            This is NOT the coding workspace root.
   * @param opts.isDraft        Arm as a Draft with no physical folder yet.
   * @param opts.materializeParams  Required when isDraft=true for auto-materialization.
   * @param opts.workspaceRoot  Optional CODING workspace directory to pass to the adapter
   *                            so it can scope its session observation. This is the repo
   *                            the agent is running in — NOT the Relay storage folder.
   *
   * Backward compat: arm(folderPath, adapterId) with no opts uses normalized folderPath
   * as both captureId AND folder.
   */
  async arm(
    captureId: string,
    adapterId = 'opencode',
    opts?: {
      folder?: string;
      isDraft?: boolean;
      materializeParams?: MaterializeParams;
      workspaceRoot?: string;
      /** Run-bound Claude profile context from the authoritative Worker launch. */
      claudeConfigDir?: string;
      /** Trusted actl-managed binding for the SAME Run (Phase 2). */
      actlManaged?: ActlManagedWatchBinding;
      executionBinding?: ExecutionBinding;
    },
  ): Promise<void> {
    if (typeof captureId !== 'string' || !captureId.trim()) {
      throw new Error('captureId가 필요합니다.');
    }

    // Normalize legacy folder-path captureIds to avoid trivial path-variant duplicates.
    const normalizedId = this.normalizePath(captureId);

    const executionBinding = opts?.executionBinding;

    // Resolve folder:
    //   isDraft=true  → null (Draft; no physical folder yet)
    //   folder given  → use it (this is the Relay storage folder, not coding workspace)
    //   neither       → treat normalizedId as folder (legacy: arm(folderPath, adapterId))
    let folder: string | null =
      opts?.isDraft === true ? null :
      opts?.folder !== undefined ? opts.folder :
      normalizedId;   // legacy backward-compat path

    // Phase H invariant: executionBinding present → folder MUST already exist
    // and MUST NOT create another Run via materializeOnce.
    if (executionBinding) {
      if (!folder) {
        throw new Error(
          'executionBinding present: folder MUST already exist (Dispatcher Run).',
        );
      }
      const resolvedFolder = path.resolve(folder);
      const fs = await import('node:fs');
      if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) {
        throw new Error(
          `executionBinding present: bound Run folder does not exist: ${resolvedFolder}`,
        );
      }
      folder = resolvedFolder;
      if (opts?.isDraft === true) {
        throw new Error('executionBinding present: isDraft MUST be false.');
      }
    }

    // Stop only this captureId's existing context — never touch others.
    await this.stopById(normalizedId, false);

    // Clear any cached materialization so the new arm always gets a fresh allocation
    // with the new adapter/params. (stopById also clears, but arm may be called on a
    // captureId that was never armed — deleting a missing key is always safe.)
    this.materializeCache.delete(normalizedId);

    const adapter = getAdapter(adapterId);
    if (!adapter) {
      this.push({ phase: 'error', captureId: normalizedId, folder: folder ?? undefined, message: `어댑터를 찾을 수 없습니다: ${adapterId}` });
      throw new Error(`어댑터를 찾을 수 없습니다: ${adapterId}`);
    }

    const noopHandle: WatchHandle = { adapterId: adapter.id, stop: async () => undefined };
    const ctx: CaptureContext = {
      captureId: normalizedId,
      folder,
      adapterId: adapter.id,
      handle: noopHandle,
      policy: new SessionBindingPolicy(),
      armSnapshotSeeded: false,
      lastPhase: null,
      lastPushKey: '',
      pending: null,
      materializeParams: executionBinding ? undefined : opts?.materializeParams,
      ...(executionBinding ? { executionBinding } : {}),
      ...(opts?.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
    };

    // Register BEFORE startWatch so synchronous sink events pass the stale-handle guard.
    this.contexts.set(normalizedId, ctx);

    // Build the WatchTarget. workspaceRoot is the CODING workspace — if not provided,
    // pass an empty target (the adapter will observe all accessible sessions).
    const target = {
      ...(opts?.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      ...(opts?.claudeConfigDir ? { claudeConfigDir: opts.claudeConfigDir } : {}),
      ...(opts?.actlManaged ? { actlManaged: opts.actlManaged } : {}),
    };

    try {
      ctx.handle = await adapter.startWatch(target, (e) => this.onEvent(ctx, e));

      if (this.contexts.get(normalizedId) !== ctx) {
        await ctx.handle.stop().catch(() => undefined);
        return;
      }

      this.emitToCtx(ctx, {
        phase: 'watching',
        captureId: normalizedId,
        folder: folder ?? undefined,
        adapterId: adapter.id,
      });
    } catch (err) {
      this.contexts.delete(normalizedId);
      this.clearPending(ctx);
      const message = err instanceof Error ? err.message : String(err);
      this.push({ phase: 'error', captureId: normalizedId, folder: folder ?? undefined, message });
      throw err instanceof Error ? err : new Error(message);
    }
  }

  /**
   * Test/helper: inject a completion into an armed capture (bypasses adapter watch).
   * Still subject to SessionBindingPolicy + ownership + Result Bridge rules.
   */
  injectCompletionForTests(captureId: string, completion: AgentCompletion): void {
    const normalizedId = this.normalizePath(captureId);
    const ctx = this.contexts.get(normalizedId) ?? this.contexts.get(captureId);
    if (!ctx) {
      throw new Error(`No armed capture for injectCompletionForTests: ${captureId}`);
    }
    this.onCompletion(ctx, completion);
  }

  /** Force-bind a session for deterministic synthetic E2E (no ambiguity). */
  forceBindSessionForTests(captureId: string, sessionId: string): boolean {
    const normalizedId = this.normalizePath(captureId);
    const ctx = this.contexts.get(normalizedId) ?? this.contexts.get(captureId);
    if (!ctx) return false;
    return this.selectSession(sessionId, ctx.captureId);
  }

  /**
   * Assign a physical Relay storage folder to an existing Draft context without
   * resetting SessionBindingPolicy. Called when the frontend materializes a Run
   * (e.g. on non-empty Prompt save) while capture is already armed.
   *
   * If no context exists for captureId this is a no-op (returns false).
   */
  assignFolder(captureId: string, folder: string): boolean {
    const normalizedId = this.normalizePath(captureId);
    const ctx = this.contexts.get(normalizedId);
    if (!ctx) return false;
    if (ctx.folder === folder) return true;
    ctx.folder = folder;
    ctx.lastPushKey = '';
    this.emitToCtx(ctx, {
      phase: 'watching',
      captureId: normalizedId,
      folder,
      adapterId: ctx.adapterId,
    });
    return true;
  }

  /**
   * Idempotent physical Run-folder allocation for a Draft.
   *
   * Guarantees: ONE captureId → at most ONE Run folder, ever.
   *
   *   • Cache hit (in-flight or already resolved) → returns the SAME Promise and
   *     thus the same {folder, run}. Concurrent callers (prompt-save IPC and
   *     auto-capture persist()) share one Promise and never get two different runs.
   *
   *   • Context already has a folder (assigned externally) → wraps it and caches.
   *
   *   • No cached entry → starts a fresh allocation via materializeFn, caches it,
   *     and on success assigns the folder to the CaptureContext (only if the same
   *     context object is still live — avoids polluting a new re-armed context).
   *
   *   • materializeFn throws → removes the cache entry so retry is possible.
   */
  materializeOnce(captureId: string, params: MaterializeParams): Promise<{ folder: string; run: string }> {
    const normalizedId = this.normalizePath(captureId);

    // Fast path: in-flight or already resolved.
    const cached = this.materializeCache.get(normalizedId);
    if (cached) return cached;

    // Context already has a physical folder — no new allocation needed.
    const ctx = this.contexts.get(normalizedId);
    if (ctx?.folder) {
      const run = path.basename(ctx.folder);
      const resolved = Promise.resolve({ folder: ctx.folder, run });
      this.materializeCache.set(normalizedId, resolved);
      return resolved;
    }

    if (!this.materializeFn) {
      return Promise.reject(new Error('materializeFn이 설정되지 않았습니다.'));
    }

    // Snapshot the context at allocation start so we only assign the folder back
    // to THIS context object — not to a different context that may later be armed
    // with the same captureId (after a re-arm that cleared the cache).
    const initialCtx = ctx ?? null;

    const promise = this.materializeFn(normalizedId, params).then(
      (result) => {
        // Assign to context only if it's still the same live object AND unfilled.
        if (
          initialCtx !== null &&
          this.contexts.get(normalizedId) === initialCtx &&
          initialCtx.folder === null
        ) {
          initialCtx.folder = result.folder;
          initialCtx.lastPushKey = '';
        }
        return result;
      },
      (err) => {
        // On failure: remove from cache so the next caller can retry.
        if (this.materializeCache.get(normalizedId) === promise) {
          this.materializeCache.delete(normalizedId);
        }
        throw err;
      },
    );

    this.materializeCache.set(normalizedId, promise);
    return promise;
  }

  /**
   * Update the materializeParams for an existing Draft context that has NOT yet
   * been physically allocated (folder is still null, no in-flight allocation).
   *
   * Call this whenever agent/date/project changes in the UI while the Draft is
   * still armed, so that a subsequent auto-capture persist() or manual IPC save
   * uses the CURRENT identity rather than stale arm-time params.
   *
   * Returns true if the update was accepted.
   * Returns false if:
   *   • no context exists for the captureId
   *   • the context has already materialized (folder is assigned)
   *   • materialization is already in-flight (first params win; caller should re-arm)
   */
  updateDraftParams(captureId: string, params: MaterializeParams): boolean {
    const normalizedId = this.normalizePath(captureId);
    const ctx = this.contexts.get(normalizedId);
    if (!ctx) return false;
    if (ctx.folder !== null) return false;              // already materialized
    if (this.materializeCache.has(normalizedId)) return false; // in-flight
    ctx.materializeParams = params;
    return true;
  }

  /**
   * Disarm a specific capture by captureId (preferred) or folder path (legacy).
   *
   * REQUIRES a non-empty identifier. To stop ALL captures use disarmAll() or dispose().
   * Calling disarm() with no argument throws — this prevents accidental mass-disarm
   * from buggy IPC payloads.
   */
  async disarm(captureIdOrFolder: string): Promise<void> {
    if (!captureIdOrFolder || typeof captureIdOrFolder !== 'string' || !captureIdOrFolder.trim()) {
      throw new Error(
        'disarm에는 captureId 또는 folder가 필요합니다. 모든 컨텍스트를 중지하려면 disarmAll()을 사용하세요.',
      );
    }
    const normalizedArg = this.normalizePath(captureIdOrFolder);
    if (this.contexts.has(normalizedArg)) {
      await this.stopById(normalizedArg, true);
    } else if (this.contexts.has(captureIdOrFolder)) {
      await this.stopById(captureIdOrFolder, true);
    } else {
      const ctx = this.findByFolder(captureIdOrFolder) ?? this.findByFolder(normalizedArg);
      if (ctx) {
        await this.stopById(ctx.captureId, true);
      } else {
        this.push({ phase: 'stopped', folder: captureIdOrFolder });
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
   * Explicit user selection (ambiguity resolution for ONE capture).
   * Accepts captureId (preferred) or folder path (legacy).
   *
   * Returns false if:
   *   - no context found for the given id/folder
   *   - the requested session is already owned by a different capture
   *   - the policy rejects the bind (already persisted etc.)
   */
  selectSession(sessionId: string, captureIdOrFolder?: string): boolean {
    let ctx: CaptureContext | undefined;
    if (captureIdOrFolder !== undefined) {
      const normArg = this.normalizePath(captureIdOrFolder);
      ctx = this.contexts.get(normArg)
        ?? this.contexts.get(captureIdOrFolder)
        ?? this.findByFolder(captureIdOrFolder)
        ?? this.findByFolder(normArg);
    } else if (this.contexts.size === 1) {
      ctx = [...this.contexts.values()][0];
    }
    if (!ctx) return false;

    // Exclusive ownership check — another capture may already own this session.
    if (!this.tryClaimSession(ctx.captureId, ctx.adapterId, sessionId)) {
      return false; // Owned by a different capture; caller should surface an error.
    }

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
    } else {
      // Policy rejected (already persisted etc.) — release the claim we just made.
      this.releaseClaim(ctx.captureId, ctx.adapterId, sessionId);
    }
    return ok;
  }

  // ── Session ownership helpers ──────────────────────────────────────────────

  /** Composite key for the ownership registry. */
  private ownerKey(adapterId: string, sessionId: string): string {
    return `${adapterId}::${sessionId}`;
  }

  /**
   * Attempt to claim exclusive ownership of (adapterId, sessionId) for captureId.
   * Returns true if the claim succeeds (or was already owned by the same captureId).
   * Returns false if another captureId already owns this session.
   */
  private tryClaimSession(captureId: string, adapterId: string, sessionId: string): boolean {
    if (!sessionId) return true; // no session identity to guard
    const key = this.ownerKey(adapterId, sessionId);
    const existing = this.sessionOwners.get(key);
    if (!existing) {
      this.sessionOwners.set(key, captureId);
      return true;
    }
    return existing === captureId;
  }

  /**
   * Release a specific (adapterId, sessionId) ownership claim held by captureId.
   * No-op if captureId does not currently own the session.
   */
  private releaseClaim(captureId: string, adapterId: string, sessionId: string): void {
    if (!sessionId) return;
    const key = this.ownerKey(adapterId, sessionId);
    if (this.sessionOwners.get(key) === captureId) {
      this.sessionOwners.delete(key);
    }
  }

  /** Release ALL session ownership claims held by captureId (e.g. on disarm). */
  private releaseSessions(captureId: string): void {
    for (const [key, owner] of this.sessionOwners) {
      if (owner === captureId) this.sessionOwners.delete(key);
    }
  }

  /**
   * True when another active, non-persisted context for the SAME adapter is unbound
   * (or bound to the SAME sessionId), meaning it is a legitimate rival for the session.
   *
   * Used to detect multi-context conflict BEFORE claiming: if a rival exists, we must
   * not automatically assign the session to whichever sink callback runs first.
   */
  private hasSameAdapterRival(captureId: string, adapterId: string, sessionId: string): boolean {
    for (const ctx of this.contexts.values()) {
      if (ctx.captureId === captureId) continue;           // skip self
      if (ctx.adapterId !== adapterId) continue;           // different adapter — no conflict
      if (ctx.policy.isPersisted) continue;                // already done — not a rival
      const b = ctx.policy.binding;
      if (b && b.sessionId !== sessionId) continue;        // bound to a DIFFERENT session — no conflict
      // Unbound context (b === null) or bound to the same session: rival.
      return true;
    }
    return false;
  }

  // ── Internal path helper ──────────────────────────────────────────────────

  /**
   * Normalize a string that may be a filesystem path so trivial variants
   * (mixed separators, trailing slashes, '.' segments) map to the same key.
   * Non-path strings (UUIDs, 'cid-…') are returned unchanged.
   */
  private normalizePath(value: string): string {
    // Heuristic: contains a path separator → treat as a path.
    if (value.includes('/') || value.includes('\\')) {
      try { return path.normalize(value); } catch { /* fall through */ }
    }
    return value;
  }

  // ── Internal stop ─────────────────────────────────────────────────────────

  private async stopById(captureId: string, withStatus: boolean): Promise<void> {
    const ctx = this.contexts.get(captureId);
    if (!ctx) {
      if (withStatus) this.push({ phase: 'stopped', captureId, folder: undefined });
      return;
    }
    this.contexts.delete(captureId);
    this.clearPending(ctx);
    ctx.lastPhase = null;
    // Release all session ownership claims this context held.
    this.releaseSessions(captureId);
    // Clear materialization cache: after stop, a future re-arm or retry
    // must allocate a fresh Run rather than reusing the stopped context's folder.
    this.materializeCache.delete(captureId);
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
            this.releaseSessions(ctx.captureId);
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

    // Revoke a provisional binding when a rival source appears (within-policy check).
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
        const sid = ctx.policy.binding!.sessionId;

        // ── Cross-context rivalry check (Phase B1) ──────────────────────────
        // Before committing an auto-bind, check if another unbound context using the
        // same adapter could also legitimately claim this session. Assigning by
        // event-callback ordering would be arbitrary and wrong — surface ambiguity
        // instead so the user or a stronger identity signal can disambiguate.
        if (this.hasSameAdapterRival(ctx.captureId, ctx.adapterId, sid)) {
          // Multiple eligible contexts — revoke this speculative bind and wait.
          ctx.policy.revoke();
          return; // Stay unbound; neither context captures the session automatically.
        }

        // Only this context is eligible: claim exclusive ownership.
        if (!this.tryClaimSession(ctx.captureId, ctx.adapterId, sid)) {
          // Another context already claimed it (race after the rival check).
          ctx.policy.revoke();
          return;
        }

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

    // accept — verify exclusive ownership before queuing for settlement.
    const sid = completion.sessionId ?? '';
    if (sid && !this.tryClaimSession(ctx.captureId, ctx.adapterId, sid)) {
      // Session is owned by another capture — silently reject this completion.
      return;
    }

    if (ctx.pending) {
      if (ctx.pending.completion.sessionId === completion.sessionId) return; // dup while settling
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
    const sid = ctx.policy?.binding?.sessionId;
    ctx.policy?.revoke();
    if (sid) this.releaseClaim(ctx.captureId, ctx.adapterId, sid);
    this.emitAmbiguous(ctx);
  }

  private revokeAndAmbiguate(ctx: CaptureContext): void {
    this.clearPending(ctx);
    const sid = ctx.policy?.binding?.sessionId;
    ctx.policy?.revoke();
    if (sid) this.releaseClaim(ctx.captureId, ctx.adapterId, sid);
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

    // Final ownership verification: ensure we still exclusively own the session.
    const sid = completion.sessionId ?? '';
    if (sid && !this.tryClaimSession(ctx.captureId, ctx.adapterId, sid)) {
      // Lost ownership between settle and persist (edge case) — abort.
      return;
    }

    // Ambiguity: never promote via Result Bridge.
    if (ctx.policy.isAmbiguous || ctx.policy.candidatesNeedSelection()) {
      this.emitAmbiguous(ctx);
      return;
    }

    // ── Lazy materialization (Phase A2, idempotent via materializeOnce) ─────────
    // Phase H: executionBinding present → NEVER materializeOnce; folder must exist.
    let runLabel: string | undefined;
    if (ctx.executionBinding) {
      if (!ctx.folder) {
        this.emitToCtx(ctx, {
          phase: 'error',
          captureId: ctx.captureId,
          message: 'executionBinding persist requires existing Run folder (materializeOnce forbidden).',
        });
        return;
      }
    } else if (ctx.folder === null) {
      // Legacy Draft path only
      if (!ctx.materializeParams) {
        this.emitToCtx(ctx, {
          phase: 'error',
          captureId: ctx.captureId,
          message: '런 폴더를 확정할 수 없습니다. 프로젝트를 선택한 뒤 캡처를 재시작하세요.',
        });
        return;
      }
      try {
        const { folder: allocFolder, run } = await this.materializeOnce(ctx.captureId, ctx.materializeParams);
        if (this.contexts.get(ctx.captureId) !== ctx) return; // disarmed during await
        // materializeOnce's .then() handler already assigned ctx.folder if the context
        // was still live. Assign manually only if it somehow wasn't set (defensive).
        if (!ctx.folder) ctx.folder = allocFolder;
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
    if (outcome.duplicate) {
      // Idempotent capture replay — still allow Result Bridge idempotent promote for RESPONSE_COMPLETE.
      if (ctx.executionBinding && completion.completionKind === 'RESPONSE_COMPLETE') {
        try {
          await promoteObservedResult({
            dataRoot: ctx.executionBinding.dataRoot,
            project: ctx.executionBinding.project,
            goalId: ctx.executionBinding.goalId,
            taskId: ctx.executionBinding.taskId,
            runId: ctx.executionBinding.runId,
            completion,
            boundFolder: folder,
            observationAdapterId: ctx.adapterId,
            workspaceRoot: ctx.workspaceRoot,
            artifactRefs: outcome.written,
          });
        } catch {
          // Soft: duplicate path already persisted; bridge rejection is non-fatal here.
        }
      }
      return;
    }
    this.emitToCtx(ctx, {
      phase: 'captured',
      captureId: ctx.captureId,
      folder,
      run: runLabel,
      adapterId: completion.adapterId,
      files: outcome.written,
      boundSessionId: binding.sessionId,
    });

    // Phase H: Result Bridge ONLY for RESPONSE_COMPLETE on bound execution.
    // PROCESS_FAILED / INTERRUPTED / BLOCKED / UNKNOWN may persist artifacts but MUST NOT promote.
    if (ctx.executionBinding && completion.completionKind === 'RESPONSE_COMPLETE') {
      try {
        await promoteObservedResult({
          dataRoot: ctx.executionBinding.dataRoot,
          project: ctx.executionBinding.project,
          goalId: ctx.executionBinding.goalId,
          taskId: ctx.executionBinding.taskId,
          runId: ctx.executionBinding.runId,
          completion,
          boundFolder: folder,
          observationAdapterId: ctx.adapterId,
          workspaceRoot: ctx.workspaceRoot,
          artifactRefs: outcome.written,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitToCtx(ctx, {
          phase: 'error',
          captureId: ctx.captureId,
          folder,
          message: `Result Bridge promotion failed: ${message}`,
        });
      }
    } else if (ctx.executionBinding && ctx.workspaceRoot) {
      // Non-response terminal: release observation lock without RESULT_RECEIVED.
      releaseObservationLockByBinding({
        observationAdapterId: ctx.adapterId,
        workspaceRoot: ctx.workspaceRoot,
        taskId: ctx.executionBinding.taskId,
        runId: ctx.executionBinding.runId,
      });
    }

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

  /** Scan by physical folder path (for legacy backward compat). */
  private findByFolder(folder: string): CaptureContext | undefined {
    for (const ctx of this.contexts.values()) {
      if (ctx.folder === folder) return ctx;
    }
    return undefined;
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
