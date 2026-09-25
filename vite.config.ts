import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds the React + TypeScript UI (src/frontend) into dist/client
 * as a set of static files that Electron loads via loadFile('/index.html').
 *
 * Dev server: `node scripts/dev.mjs` serves the same UI with HMR on
 * localhost:5173 and points Electron at it via ELECTRON_DEV_URL.
 * strictPort keeps that contract stable — the launcher waits on this
 * exact port instead of silently drifting to 5174+.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      input: 'index.html',
    },
  },
});