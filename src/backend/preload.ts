/**
 * Preload script — runs inside every renderer process before the UI loads.
 * Exposes a single 'relay' bridge on the browser window so React can ask the
 * Electron main process to perform local filesystem operations.
 *
 * Security: this is the ONLY thing we intentionally expose to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CaptureStatusView, RelayRequest, RelayResponse, UpdateStatus } from '../shared/types.js';

const api = {
  call<T>(req: RelayRequest): Promise<RelayResponse<T>> {
    return ipcRenderer.invoke('relay', req) as Promise<RelayResponse<T>>;
  },
  /**
   * Start an OS-native drag of a local file (used to drag result.md onto
   * ChatGPT's input). Fire-and-forget; must be called from a user gesture.
   */
  dragFile(filePath: string): void {
    ipcRenderer.send('relay-drag-file', filePath);
  },
  /**
   * In-app updater 상태 푸시 구독 (main이 relay-update-status로 방송한다).
   * Returns an unsubscribe function.
   */
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
    const listener = (_e: unknown, s: UpdateStatus): void => cb(s);
    ipcRenderer.on('relay-update-status', listener as never);
    return () => ipcRenderer.removeListener('relay-update-status', listener as never);
  },
  /** Agent adapter 자동 수신 상태 푸시 구독 (main이 relay-capture-status로 방송한다). */
  onCaptureStatus(cb: (s: CaptureStatusView) => void): () => void {
    const listener = (_e: unknown, s: CaptureStatusView): void => cb(s);
    ipcRenderer.on('relay-capture-status', listener as never);
    return () => ipcRenderer.removeListener('relay-capture-status', listener as never);
  },
};

contextBridge.exposeInMainWorld('relayApi', api);

// Keep a concrete signature for the frontend bridge declaration.
export type RelayApi = typeof api;
