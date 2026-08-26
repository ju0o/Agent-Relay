/* Live provenance smoke (Correction Pass 01).
   Proves the deterministic binding invariant against REAL OpenCode 1.18.23:

     1. two unrelated completed sessions exist (decoy + target's first turn)
     2. capture is armed
     3. the TARGET session is bound explicitly (selection flow)
     4. a SECOND turn is produced in the BOUND session only
     5. agent-result.md must contain ONLY the bound session's second-turn text
        — never the decoy text, never the first-turn text, never any other
        concurrently-completing session's output

   Usage: node scripts/smoke-binding.mjs [timeoutMs] */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';

process.env['AGENT_RELAY_CAPTURE_DEBUG'] = '1';
const timeoutMs = Number(process.argv[2] ?? 300_000);
const bin =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    : 'opencode';

const runFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bind-run-'));
const wsTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bind-target-'));
const wsDecoy = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-bind-decoy-'));
console.log('[bind-smoke] run folder :', runFolder);
console.log('[bind-smoke] target ws  :', wsTarget);
console.log('[bind-smoke] decoy  ws  :', wsDecoy);

function ocRun(args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: process.cwd(), windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve(-1);
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

let done = false;
let capturedFiles = [];
const manager = new CaptureManager((s) => {
  if (s.phase !== 'watching') console.log('[bind-smoke] status:', JSON.stringify(s));
  if (s.phase === 'captured') {
    done = true;
    capturedFiles = s.files ?? [];
  }
});

async function findSessionId(directory, sinceMs) {
  // Poll through the adapter's own view: easiest reliable source is a fresh
  // client launch (global bucket covers non-git temp workspaces).
  const { OpenCodeServerClient } = await import('../dist/server/integrations/opencode/client.js');
  const c = await OpenCodeServerClient.launch(undefined);
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const ss = await c.listSessions().catch(() => []);
      const hit = ss.find((x) => x.directory === directory && (x.time?.created ?? 0) >= sinceMs - 1_000);
      if (hit?.id) return hit.id;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  } finally {
    await c.stop();
  }
}

try {
  console.log('[bind-smoke] step 1: target first turn + decoy turn (real opencode)...');
  const t0 = Date.now();
  const codeW = await ocRun(['run', '--dir', wsTarget, 'Reply with exactly this single line and nothing else: FIRST_TURN_MARKER']);
  const codeD = await ocRun(['run', '--dir', wsDecoy, 'Reply with exactly this single line and nothing else: DECOY_TURN_MARKER']);
  console.log('[bind-smoke] first-turn exit codes:', codeW, codeD);
  if (codeW !== 0 || codeD !== 0) throw new Error('setup turns failed');

  const targetSession = await findSessionId(wsTarget, t0);
  console.log('[bind-smoke] step 2: armed; target sessionId =', targetSession);
  await manager.arm(runFolder);
  if (!targetSession) throw new Error('target session not found');

  console.log('[bind-smoke] step 3: explicit selection binds the chosen session...');
  const bound = manager.selectSession(targetSession);
  if (!bound) throw new Error('selectSession refused');

  console.log('[bind-smoke] step 4: second turn ONLY in the bound session...');
  const code2 = await ocRun(['run', '-s', targetSession, '--dir', wsTarget, 'Reply with exactly this single line and nothing else: SECOND_TURN_BOUND']);
  console.log('[bind-smoke] second-turn exit code:', code2);
  if (code2 !== 0) throw new Error('second turn failed');

  const deadline = Date.now() + timeoutMs;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  if (!done) throw new Error('TIMEOUT — bound completion never captured');

  const raw = fs.readFileSync(path.join(runFolder, 'agent-result.md'), 'utf8');
  const okBound = raw.includes('SECOND_TURN_BOUND');
  const noFirst = !raw.includes('FIRST_TURN_MARKER');
  const noDecoy = !raw.includes('DECOY_TURN_MARKER');
  const ev = JSON.parse(fs.readFileSync(path.join(runFolder, 'evidence', 'adapter.json'), 'utf8'));
  const evOk = ev.completion.sessionId === targetSession && ev.binding?.reason === 'manual';
  console.log('[bind-smoke] contains SECOND_TURN_BOUND :', okBound);
  console.log('[bind-smoke] free of FIRST_TURN_MARKER  :', noFirst);
  console.log('[bind-smoke] free of DECOY_TURN_MARKER  :', noDecoy);
  console.log('[bind-smoke] evidence sessionId+binding :', evOk, '| reason =', ev.binding?.reason);
  console.log('[bind-smoke] files:', capturedFiles.join(', '));
  const pass = okBound && noFirst && noDecoy && evOk;
  console.log('[bind-smoke] RESULT:', pass ? 'PROVEN' : 'FAILED');
  if (!pass) process.exitCode = 1;
} catch (e) {
  console.error('[bind-smoke] FAILED:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await manager.disarm().catch(() => undefined);
}
