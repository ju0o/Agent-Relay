/**
 * Thin IPC client — wraps the bridge that the Electron preload script exposes
 * on window.relayApi. The rest of the UI never talks to Electron directly.
 */
import { RelayRequest, RelayResponse, UpdateStatus } from '../shared/types.js';

export interface RelayApi {
  call<T>(req: RelayRequest): Promise<RelayResponse<T>>;
  dragFile?(filePath: string): void;
  onUpdateStatus?(cb: (s: UpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    relayApi?: RelayApi;
  }
}

export function hasBridge(): boolean {
  return typeof window.relayApi !== 'undefined';
}

/** Send a request; returns the full envelope (never throws on business errors). */
export async function relay<T>(req: RelayRequest): Promise<RelayResponse<T>> {
  const api = window.relayApi;
  if (!api) return { ok: false, error: 'IPC 브리지가 준비되지 않았습니다. 앱을 다시 실행하세요.' };
  return api.call<T>(req);
}

/** Send a request and return value, or throw when the backend reported an error. */
export async function must<T>(req: RelayRequest): Promise<T> {
  const res = await relay<T>(req);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

/** Begin a native OS drag of a local file (result.md → ChatGPT). No-op if unsupported. */
export function dragLocalFile(filePath: string): void {
  window.relayApi?.dragFile?.(filePath);
}

/** Subscribe to updater status pushes. Returns an unsubscribe function. */
export function onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
  return window.relayApi?.onUpdateStatus?.(cb) ?? (() => undefined);
}
