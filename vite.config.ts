import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Builds the React + TypeScript UI (src/frontend) into dist/client
 * as a set of static files that Electron loads via loadFile('/index.html').
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    rollupOptions: {
      input: 'index.html',
    },
  },
});