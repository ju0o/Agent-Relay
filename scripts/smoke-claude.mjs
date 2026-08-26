/* Live Claude Code smoke (Packet 02) — real installed CLI, minimal prompts.
   Requires `claude` on PATH (authenticated as usual).

   Phase A (auto-bind): one completed decoy session exists pre-arm; then ONE
     new target session completes post-arm → deterministic unique-new binding
     must capture ONLY the target's exact final text.
   Phase B (ambiguity): two NEW sessions complete post-arm → policy must
     surface selection and write NOTHING (no silent guessing).

   Usage: node scripts/smoke-claude.mjs [timeoutMs] */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';

process.env['AGENT_RELAY_CAPTURE_DEBUG'] = '1';
const timeoutMs = Number(process.argv[2] ?? 240_000);
const bin =
  process.platform === 'win32'
    ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
    : 'claude';

const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-cc-'));
const runA = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-cc-runA-'));
const runB = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-cc-runB-'));
const wsDecoy = mkws();
const wsTarget = mkws();
const wsB1 = mkws();
const wsB2 = mkws();

function claude(cwd, prompt) {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-p', prompt], { cwd, windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve(-1);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(t);
      resolve(-2);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

function waitForPhase(manager, phase, ms) {
  return new Promise((resolve) => {
    if (manager._phaseNow === phase || (phase === 'ambiguous' && manager._ambiguousSeen)) return resolve(true);
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = phase === 'captured' ? manager._captured : manager._ambiguousSeen;
      if (hit || Date.now() - start > ms) {
        clearInterval(iv);
        resolve(!!hit);
      }
    }, 300);
  });
}

async function main() {
  console.log('[cc-smoke] Phase A setup: decoy turn (pre-arm)...');
  if (await claude(wsDecoy, 'Reply with exactly this single line and nothing else: CC_DECOY_MARKER') !== 0) throw new Error('decoy failed');

  const mgr = new CaptureManager((s) => {
    console.log('[cc-smoke] status:', JSON.stringify(s));
    if (s.phase === 'captured') mgr._captured = true;
    if (s.phase === 'ambiguous') mgr._ambiguousSeen = true;
  });

  try {
    console.log('[cc-smoke] Phase A: armed → single new target session...');
    await mgr.arm(runA, 'claude-code');
    if (await claude(wsTarget, 'Reply with exactly this single line and nothing else: CLAUDE_PACKET02_BOUND_MARKER') !== 0) throw new Error('target failed');
    const okA = await waitForPhase(mgr, 'captured', timeoutMs);
    const raw = okA ? fs.readFileSync(path.join(runA, 'agent-result.md'), 'utf8') : '';
    const ev = okA ? JSON.parse(fs.readFileSync(path.join(runA, 'evidence', 'adapter.json'), 'utf8')) : {};
    console.log('[cc-smoke] A captured:', okA);
    console.log('[cc-smoke] A raw == marker       :', raw.trim() === 'CLAUDE_PACKET02_BOUND_MARKER');
    console.log('[cc-smoke] A decoy text absent   :', !raw.includes('CC_DECOY_MARKER'));
    console.log('[cc-smoke] A evidence.adapterId  :', ev.adapter?.id, '| sessionId:', String(ev.completion?.sessionId ?? '').slice(0, 13) + '…');
    const passA = okA && raw.trim() === 'CLAUDE_PACKET02_BOUND_MARKER' && !raw.includes('CC_DECOY_MARKER') && ev.adapter?.id === 'claude-code';

    console.log('[cc-smoke] Phase B: armed → TWO new sessions complete CONCURRENTLY (must stay ambiguous, write NOTHING)...');
    await mgr.arm(runB, 'claude-code');
    await Promise.all([
      claude(wsB1, 'Reply with exactly this single line and nothing else: CC_RACE_ONE'),
      claude(wsB2, 'Reply with exactly this single line and nothing else: CC_RACE_TWO'),
    ]);
    const amb = await waitForPhase(mgr, 'ambiguous', 30_000);
    await new Promise((r) => setTimeout(r, 5_000));
    const bFiles = fs.existsSync(path.join(runB, 'agent-result.md'));
    console.log('[cc-smoke] B ambiguous surfaced  :', amb);
    console.log('[cc-smoke] B nothing written     :', !bFiles);
    const passB = amb && !bFiles;

    console.log('[cc-smoke] RESULT:', passA && passB ? 'PROVEN' : 'FAILED');
    if (!(passA && passB)) process.exitCode = 1;
  } finally {
    await mgr.disarm().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('[cc-smoke] FAILED:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
