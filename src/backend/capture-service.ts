/**
 * Phase H — Shared CaptureManager access for Dispatcher + Electron main.
 *
 * Electron main may install the UI-backed instance via setCaptureManager.
 * Headless MCP / tests fall back to a process-local manager with fast settle.
 */
import { CaptureManager } from './capture-manager.js';

let shared: CaptureManager | null = null;
let headless: CaptureManager | null = null;

export function setCaptureManager(manager: CaptureManager | null): void {
  shared = manager;
}

export function getCaptureManager(): CaptureManager | null {
  return shared ?? headless;
}

/**
 * CaptureManager used by Dispatcher-bound observed dispatch.
 * Prefers the Electron-installed instance; otherwise creates a headless one.
 */
export function ensureDispatchCaptureManager(opts?: {
  settleMs?: number;
}): CaptureManager {
  if (shared) return shared;
  if (!headless) {
    headless = new CaptureManager(() => undefined, {
      settleMs: opts?.settleMs ?? 0,
    });
  }
  return headless;
}

/** Test-only: dispose headless manager and clear shared pointer. */
export async function _resetCaptureServiceForTests(): Promise<void> {
  if (headless) {
    await headless.disarmAll().catch(() => undefined);
    await headless.dispose().catch(() => undefined);
    headless = null;
  }
  shared = null;
}
