/**
 * Preload script — runs inside every renderer process before the UI loads.
 * Exposes a single 'relay' bridge on the browser window so React can ask the
 * Electron main process to perform local filesystem operations.
 *
 * Security: this is the ONLY thing we intentionally expose to the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { RelayRequest, RelayResponse } from '../shared/types.js';

const api = {
  call<T>(req: RelayRequest): Promise<RelayResponse<T>> {
    return ipcRenderer.invoke('relay', req) as Promise<RelayResponse<T>>;
  },
};

contextBridge.exposeInMainWorld('relayApi', api);

// Keep a concrete signature for the frontend bridge declaration.
export type RelayApi = typeof api;