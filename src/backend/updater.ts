/**
 * In-app updater — electron-updater with the GitHub Release provider.
 *
 * v0.3 policy (사용자 통제):
 *   - autoDownload OFF, autoInstallOnAppQuit OFF
 *   - background check after launch is silent: a new version only raises a
 *     small notification; download/install happen on explicit user action.
 *
 * Private-repo note: the GitHub provider cannot read releases of a private
 * repository without credentials. We never embed tokens in the app. As an
 * explicit per-machine opt-in, AGENT_RELAY_GH_TOKEN (env var) is attached as
 * a request header when present — nothing is stored or shipped in the binary.
 */
import { autoUpdater } from 'electron-updater';
import { UpdateEvent } from '../shared/types.js';

export interface UpdaterHooks {
  /** Forward one updater event to the app (IPC push / state machine). */
  emit(event: UpdateEvent): void;
  /** Is the current check cycle user-initiated? Resolved per-event. */
  isManual(): boolean;
}

/** True when running packaged — electron-updater needs app-update.yml at runtime. */
export function updaterSupported(isPackaged: boolean): boolean {
  return isPackaged;
}

/** Wire electron-updater listeners and apply policy. */
export function initUpdater(hooks: UpdaterHooks): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  const token = process.env.AGENT_RELAY_GH_TOKEN;
  if (token) {
    // Opt-in, per-machine credential for private repos. Never bundled.
    autoUpdater.requestHeaders = { Authorization: `Bearer ${token}` };
  }

  autoUpdater.on('checking-for-update', () => {
    hooks.emit({ type: 'check-started', manual: hooks.isManual() });
  });
  autoUpdater.on('update-available', (info) => {
    hooks.emit({ type: 'available', nextVersion: info?.version ?? '' });
  });
  autoUpdater.on('update-not-available', () => {
    hooks.emit({ type: 'not-available' });
  });
  autoUpdater.on('download-progress', (progress) => {
    hooks.emit({ type: 'download-progress', percent: progress?.percent ?? 0 });
  });
  autoUpdater.on('update-downloaded', () => {
    hooks.emit({ type: 'downloaded' });
  });
  autoUpdater.on('error', (err) => {
    hooks.emit({ type: 'error', message: err?.message ?? String(err), manual: hooks.isManual() });
  });
}

/** Start an update check. Errors surface only for user-initiated checks. */
export async function checkForUpdates(): Promise<void> {
  await autoUpdater.checkForUpdates();
}

/** Download the offered update (user clicked 업데이트). */
export function downloadUpdate(): void {
  void autoUpdater.downloadUpdate();
}

/** Quit and install the downloaded update (user clicked 재시작하여 설치). */
export function installUpdate(): void {
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
