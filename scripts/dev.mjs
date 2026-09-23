/* Agent Relay dev launcher — dependency-free watch/HMR.
 *
 * Usage: node scripts/dev.mjs [--port N] [--no-electron] [--no-backend-restart]
 *
 * What it does (Node builtins only — no new npm dependencies):
 *   1. Runs an initial `tsc -p tsconfig.server.json` build so
 *      dist/server/backend/{main,preload}.js exist even if watch/HMR fails.
 *   2. Starts the Vite dev server (frontend HMR) on a fixed localhost port.
 *   3. Starts `tsc --watch` for the Electron main/preload backend.
 *   4. Launches Electron with ELECTRON_DEV_URL=http://localhost:<port>
 *      so the app loads the Vite HMR URL instead of dist/client/index.html.
 *   5. Restarts Electron when the compiled backend changes
 *      (frontend changes need no restart — Vite HMR handles them).
 *
 * Offline behavior: everything is localhost + local node_modules binaries
 * (node node_modules/vite/bin/vite.js, node node_modules/typescript/bin/tsc,
 * node node_modules/electron/cli.js). No network install/fetch happens here.
 * If the Vite server never becomes ready, Electron still launches against
 * the step-1 build output (same as the old `dev:once` flow).
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

const ROOT = process.cwd();
const DEFAULT_PORT = 5173;
const DEV_URL_ENV = 'ELECTRON_DEV_URL';

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const PORT = Number(argValue('--port') || process.env.AGENT_RELAY_DEV_PORT || DEFAULT_PORT);
const NO_ELECTRON = args.includes('--no-electron');
const NO_BACKEND_RESTART = args.includes('--no-backend-restart');

const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const TSC_BIN = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const ELECTRON_CLI = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const MAIN_OUT = path.join(ROOT, 'dist', 'server', 'backend', 'main.js');
const PRELOAD_OUT = path.join(ROOT, 'dist', 'server', 'backend', 'preload.js');

const children = new Set();
let electronProc = null;
let shuttingDown = false;
let restartTimer = null;

function log(tag, msg) {
  console.log(`[dev:${tag}] ${msg}`);
}

function spawnTracked(tag, cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, { stdio: 'inherit', ...opts });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!shuttingDown && (tag === 'vite' || tag === 'tsc')) {
      log(tag, `exited code=${code} signal=${signal ?? '-'}`);
    }
  });
  return child;
}

function waitForPort(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const probe = () => {
      if (shuttingDown) return resolve(false);
      const sock = net.connect({ host: '127.0.0.1', port });
      const done = (ok) => {
        sock.destroy();
        if (ok) return resolve(true);
        if (Date.now() - started > timeoutMs) return resolve(false);
        setTimeout(probe, 250);
      };
      sock.on('connect', () => done(true));
      sock.on('error', () => done(false));
    };
    probe();
  });
}

function waitForFile(file, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const probe = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(probe, 250);
    };
    probe();
  });
}

function startElectron(devUrl) {
  if (NO_ELECTRON || shuttingDown) return;
  const env = { ...process.env };
  if (devUrl) env[DEV_URL_ENV] = devUrl;
  else delete env[DEV_URL_ENV];
  log('electron', devUrl ? `starting → ${devUrl}` : 'starting → built files (dev server unavailable)');
  electronProc = spawnTracked('electron', process.execPath, [ELECTRON_CLI, MAIN_OUT], { env });
  electronProc.on('exit', (code) => {
    electronProc = null;
    // Electron quit (window closed) ends the dev session like `electron .` does.
    if (!shuttingDown) {
      log('electron', `exited code=${code} — shutting down watchers`);
      shutdown(code ?? 0);
    }
  });
}

function restartElectron(devUrl) {
  if (NO_BACKEND_RESTART || shuttingDown || !electronProc) return;
  log('electron', 'backend rebuilt — restarting');
  const old = electronProc;
  electronProc = null;
  old.removeAllListeners('exit');
  old.on('exit', () => startElectron(devUrl));
  try { old.kill(); } catch { /* already gone */ }
  // Safety: if the old process ignores SIGTERM, force a fresh start anyway.
  setTimeout(() => {
    try { if (!old.killed) old.kill('SIGKILL'); } catch { /* noop */ }
  }, 5000).unref?.();
}

function watchBackend(devUrl) {
  if (NO_BACKEND_RESTART) return;
  const dir = path.dirname(MAIN_OUT);
  try {
    const watcher = fs.watch(dir, { persistent: false }, (event, name) => {
      if (name !== 'main.js' && name !== 'preload.js') return;
      if (event !== 'change' && event !== 'rename') return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => restartElectron(devUrl), 600);
    });
    watcher.on('error', () => undefined);
    process.on('exit', () => { try { watcher.close(); } catch { /* noop */ } });
  } catch {
    // Backend watch is best-effort; tsc --watch + manual restart still work.
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(restartTimer);
  for (const child of [...children]) {
    try { child.kill(); } catch { /* already gone */ }
  }
  // Give children a moment, then exit with Electron's code.
  setTimeout(() => process.exit(code), 300).unref?.();
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

async function main() {
  if (!fs.existsSync(VITE_BIN)) {
    console.error('[dev] node_modules/vite/bin/vite.js not found — run `npm install` first.');
    process.exit(1);
  }
  if (!fs.existsSync(TSC_BIN)) {
    console.error('[dev] node_modules/typescript/bin/tsc not found — run `npm install` first.');
    process.exit(1);
  }

  // 1. One synchronous backend build — guarantees a launchable Electron
  //    entry point even when watch/HMR cannot start (offline fallback).
  log('tsc', 'initial build (tsconfig.server.json)');
  const built = spawnSync(process.execPath, [TSC_BIN, '-p', 'tsconfig.server.json'], {
    stdio: 'inherit',
  });
  if (built.status !== 0) {
    console.error('[dev] initial tsc build failed — fix type errors and retry.');
    process.exit(built.status ?? 1);
  }

  // 2. Frontend HMR server (localhost only — works offline).
  spawnTracked('vite', process.execPath, [VITE_BIN, '--port', String(PORT), '--strictPort'], {
    env: process.env,
  });

  // 3. Backend watch compiler.
  spawnTracked('tsc', process.execPath, [TSC_BIN, '-p', 'tsconfig.server.json', '--watch', '--preserveWatchOutput'], {
    env: process.env,
  });

  const devUrl = `http://localhost:${PORT}`;
  const [viteReady, backendReady] = await Promise.all([
    waitForPort(PORT, 60000),
    waitForFile(MAIN_OUT, 60000),
  ]);

  if (!backendReady || !fs.existsSync(PRELOAD_OUT)) {
    console.error('[dev] compiled backend missing — aborting Electron launch.');
    shutdown(1);
    return;
  }
  if (!viteReady) {
    log('vite', 'dev server not ready in 60s — falling back to built files');
    watchBackend('');
    startElectron('');
    return;
  }

  log('vite', `ready → ${devUrl}`);
  watchBackend(devUrl);
  startElectron(devUrl);
}

main().catch((err) => {
  console.error('[dev] launcher failed:', err);
  shutdown(1);
});
