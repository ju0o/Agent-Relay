/* Live integration smoke test for the OpenCode auto-capture path (Packet 01).
   Requires the real `opencode` CLI on PATH (authenticated as usual).

   Arms the full production chain — OpenCodeAdapter -> AgentCompletion ->
   ResultCaptureService — against a throwaway run folder, then drives one REAL
   OpenCode turn (`opencode run "<trivial prompt>"`) and waits until that
   completion is observed and persisted automatically.

   Usage: node scripts/smoke-capture.mjs [timeoutMs]
   Never touches user data outside temporary folders it creates. */
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';

const timeoutMs = Number(process.argv[2] ?? 240_000);
/** Optional explicit workspace (e.g. a git repo) for the workload turn. */
const explicitWs = process.argv[3] ?? '';
const runFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-smoke-'));
const workCwd = explicitWs || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-smoke-ws-'));
console.log('[smoke] run folder:', runFolder);
console.log('[smoke] workspace:', workCwd);

const bin =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : 'opencode';

process.env['AGENT_RELAY_CAPTURE_DEBUG'] = '1';

let done = false;
const manager = new CaptureManager((s) => {
  console.log('[smoke] status:', JSON.stringify(s));
  if (s.phase === 'captured') {
    done = true;
    const raw = fs.readFileSync(path.join(runFolder, 'agent-result.md'), 'utf8');
    console.log('[smoke] agent-result.md bytes:', Buffer.byteLength(raw, 'utf8'));
    console.log('[smoke] preview:\n' + raw.slice(0, 400));
    const ev = JSON.parse(fs.readFileSync(path.join(runFolder, 'evidence', 'adapter.json'), 'utf8'));
    console.log('[smoke] evidence:', JSON.stringify(ev.completion, null, 2).slice(0, 600));
  }
});

/** Spawn the real workload ONLY after the watch is armed — arming first is
    also what real users do (they start watching, then the agent finishes).
    NOTE: `opencode run` stalls when its stdout is piped; storage (not its
    console output) is the source of truth here, so stdio is ignored. */
let killWorkload = () => undefined;
async function runWorkload() {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      ['run', '--dir', workCwd, 'Reply with exactly this single line and nothing else: AGENT_RELAY_SMOKE_TURN_COMPLETE'],
      { cwd: workCwd, windowsHide: true, stdio: 'ignore' },
    );
    let settled = false;
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    });
    const t = setTimeout(() => killWorkload(), timeoutMs);
    killWorkload = () => {
      clearTimeout(t);
      if (!settled) {
        settled = true;
        try { child.kill(); } catch { /* already gone */ }
        resolve(null);
      }
    };
  });
}

try {
  await manager.arm(runFolder);
  console.log('[smoke] armed — starting a real OpenCode turn now...');
  const workload = runWorkload();
  const deadline = Date.now() + timeoutMs;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (!done) {
    console.log('[smoke] RESULT: TIMEOUT — no completion observed within', timeoutMs, 'ms');
    process.exitCode = 1;
  } else {
    const mirrorExists = fs.existsSync(path.join(runFolder, 'result.md'));
    console.log('[smoke] RESULT: CAPTURED — result.md mirror exists:', mirrorExists);
  }
} finally {
  await manager.disarm().catch(() => undefined);
}
