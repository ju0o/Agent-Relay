/**
 * TEMPORARY Windows EBUSY diagnostic — verify branch ONLY, never merge.
 * Reproduces INIT-18 (runCli init --yes, then immediate rmSync) and records:
 *  1. CLI child exit status (spawnSync reaps by definition on return).
 *  2. Whether config files are readable immediately after return.
 *  3. Whether any descendant process of THIS test process exists.
 *  4. Whether immediate rmSync succeeds (EBUSY?) and, if not, whether a
 *     short bounded retry loop eventually succeeds (transient OS timing)
 *     or fails indefinitely (leaked product-owned handle).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'server', 'cli', 'index.js');
const say = (o) => console.log('DIAG ' + JSON.stringify(o));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-initdiag-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });

const r = spawnSync(process.execPath, [CLI, 'init', '--yes'], { cwd: ws, encoding: 'utf8', timeout: 30000 });
say({ cliStatus: r.status, cliSpawnError: r.error ? String(r.error) : null });

const cfg = path.join(ws, '.agent-relay', 'config.json');
say({ configReadableImmediately: fs.existsSync(cfg) });

let descendants = 'probe-failed';
try {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | Select-Object -ExpandProperty ProcessId`,
  ], { encoding: 'utf8', timeout: 60000 });
  descendants = (ps.stdout || '').trim().split(/\s+/).filter(Boolean);
} catch (e) {
  descendants = 'probe-error: ' + String(e);
}
say({ nodePid: process.pid, liveDescendantPids: descendants });

let immediate = 'unknown';
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  immediate = 'deleted-immediately';
} catch (e) {
  immediate = 'failed: ' + (e && e.code ? e.code : String(e));
}
say({ immediateRm: immediate });

if (fs.existsSync(tmp)) {
  const t0 = Date.now();
  let attempts = 0;
  let done = false;
  let last = '';
  while (Date.now() - t0 < 15000 && !done) {
    attempts += 1;
    await new Promise((r2) => setTimeout(r2, 200));
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      done = true;
    } catch (e) {
      last = (e && e.code ? e.code : String(e));
    }
  }
  say({ retrySucceeded: done, attempts, elapsedMs: Date.now() - t0, lastError: last, stillExists: fs.existsSync(tmp) });
}
say({ done: true });
