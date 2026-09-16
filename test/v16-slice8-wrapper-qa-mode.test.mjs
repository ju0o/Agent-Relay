/**
 * V1.6 Slice 8 — wrapper QA passthrough mode (narrow correction).
 *
 * The Semantic QA evaluator spawns the QA worker's own launchCommand +
 * launchArgsPrefix with a trailing `--print <prompt>`. When that row is the
 * production `claude-code` row (node scripts/relay-worker-claude.mjs), the
 * invocation arrives with NO relay args — previously Fatal (missing relay
 * arg → exit 1 → semantic BLOCKED ×2 → escalation, dogfood impossible).
 * The wrapper now serves that exact shape as a direct `claude --print`
 * passthrough. Uses CLAUDE_EXE override (operator escape hatch) so no real
 * Claude invocation is needed.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const WRAPPER = path.join(REPO, 'scripts', 'relay-worker-claude.mjs');
const ECHO = path.join(REPO, 'test', 'fixtures', 'workers', 'fake-claude-qa-echo.mjs');
const FAIL = path.join(REPO, 'test', 'fixtures', 'workers', 'fake-claude-qa-fail.mjs');
for (const f of [ECHO, FAIL]) fs.chmodSync(f, 0o755);

let passed = 0; let failed = 0;
const check = (c, m) => {
  if (c) { console.log(`  PASS  ${m}`); passed += 1; }
  else { console.log(`  FAIL  ${m}`); failed += 1; process.exitCode = 1; }
};

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-v16-s8-wrap-'));
const ARGV = path.join(CWD, 'fake-claude-argv.mjs');
fs.writeFileSync(ARGV, "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join('|') + '|CONFIG=' + (process.env.CLAUDE_CONFIG_DIR || ''));\n", 'utf8');
fs.chmodSync(ARGV, 0o755);

// 1. QA shape forwards prompt verbatim, stdout passes through, exit 0.
{
  const r = spawnSync(process.execPath, [WRAPPER, '--print', 'CANARY-PROMPT-123'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ECHO },
  });
  check(r.status === 0, `QA passthrough exits 0 (got ${r.status}, stderr=${JSON.stringify((r.stderr || '').slice(0, 200))})`);
  check((r.stdout || '').includes('ECHO:CANARY-PROMPT-123'), 'QA passthrough forwards prompt verbatim to claude');
  check((r.stdout || '').includes('status: PASS'), 'QA passthrough relays claude stdout unaltered');
}

// 1b. Explicit profile is allowed, but permission mode is forbidden for QA.
{
  const profile = path.join(CWD, 'qa-profile');
  fs.mkdirSync(profile, { recursive: true });
  const r = spawnSync(process.execPath, [WRAPPER, '--claudeConfigDir', profile, '--permissionMode', 'acceptEdits', '--print', 'OPTIONS-PROMPT'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ARGV },
  });
  check(r.status === 1, `QA passthrough rejects permission mode (got ${r.status})`);
  check((r.stderr || '').includes('forbidden') && !(r.stdout || '').includes('OPTIONS-PROMPT'), 'QA passthrough fails closed before Claude when permission mode is supplied');
}

// 1c. Explicit profile alone is applied to Claude and prompt order is preserved.
{
  const profile = path.join(CWD, 'qa-profile-only');
  fs.mkdirSync(profile, { recursive: true });
  const r = spawnSync(process.execPath, [WRAPPER, '--claudeConfigDir', profile, '--print', 'OPTIONS-PROMPT'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ARGV },
  });
  check(r.status === 0 && (r.stdout || '').includes('OPTIONS-PROMPT') && (r.stdout || '').includes(`CONFIG=${profile}`), 'QA passthrough applies explicit config without permission mode');
}

// 2. Non-zero Claude exit propagates (evaluator treats as reattempt-eligible, not success).
{
  const r = spawnSync(process.execPath, [WRAPPER, '--print', 'anything'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: FAIL },
  });
  check(r.status === 3, `QA passthrough propagates claude exit code (got ${r.status})`);
}

// 3. Missing relay args WITHOUT --print still fails closed (existing behavior preserved).
{
  const r = spawnSync(process.execPath, [WRAPPER], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ECHO },
  });
  check(r.status === 1, `bare invocation without relay args or --print still Fatal (got ${r.status})`);
  check((r.stderr || '').includes('Fatal'), 'bare invocation keeps Fatal diagnostic');
}

// 4. Relay path takes precedence: full relay args + stray --print still parses relay args
//    (proves the QA branch cannot hijack a real implementation dispatch).
{
  const r = spawnSync(process.execPath, [WRAPPER, '--dataRoot', '/nonexistent-root-xyz', '--project', 'P', '--taskId', 'T', '--runId', 'R', '--workspaceRoot', CWD, '--print', 'nope'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ECHO },
  });
  check((r.stderr || '').includes('Task load failed') || r.status === 1, 'relay args present → relay path (Task load attempted, no QA passthrough)');
  check(!(r.stdout || '').includes('ECHO:'), 'relay path never emits QA echo output');
}

console.log(`\nSlice 8 wrapper QA mode: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
