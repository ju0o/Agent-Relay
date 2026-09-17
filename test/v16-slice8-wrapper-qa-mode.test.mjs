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
fs.writeFileSync(ARGV, "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join('|') + '|CONFIG=' + (process.env.CLAUDE_CONFIG_DIR || '') + '|PWD=' + (process.env.PWD || ''));\n", 'utf8');
fs.chmodSync(ARGV, 0o755);

// Round 35/37 shared relay fixture: a minimal canonical Task/Run so the Builder
// relay path loads the Task, writes prompt.md, and records worker-launch.log
// with the redacted argvShape of the spawned (fake) Claude.
const makeRelayFixture = () => {
  const relayRoot = path.join(CWD, 'relay-data');
  const relayProj = 'relay';
  const relayProjDir = path.join(relayRoot, relayProj);
  fs.mkdirSync(path.join(relayProjDir, '_relay/goals/GOAL-0001'), { recursive: true });
  fs.mkdirSync(path.join(relayProjDir, '_relay/tasks/TASK-0001'), { recursive: true });
  const tripRunId = '11111111-1111-1111-1111-111111111111';
  const relayRun = path.join(relayProjDir, '2026-09-05/worker-claude-code/01');
  fs.mkdirSync(relayRun, { recursive: true });
  const wsDir = path.join(CWD, 'relay-workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  const iso = new Date().toISOString();
  fs.writeFileSync(
    path.join(relayProjDir, '_relay/goals/GOAL-0001/goal.json'),
    JSON.stringify({ schemaVersion: 2, goalId: 'GOAL-0001', project: relayProj, title: 'g', goalStatement: 'g', status: 'PLANNING', completionCriteria: [], permissionPolicy: { mode: 'PLAN' }, createdAt: iso, updatedAt: iso }, null, 2),
  );
  fs.writeFileSync(
    path.join(relayProjDir, '_relay/tasks/TASK-0001/task.json'),
    JSON.stringify({
      schemaVersion: 2, taskId: 'TASK-0001', goalId: 'GOAL-0001', project: relayProj, title: 't', goal: 'g', reason: 'r', scope: 's',
      completionCriteria: ['c'], executionState: 'RUNNING', pmState: 'PENDING', dependencies: [],
      linkedRuns: [{ runId: tripRunId, folder: relayRun, taskRunSequence: 1, agent: 'worker-claude-code', date: '2026-09-05' }],
      nextTaskRunSequence: 2, createdAt: iso, updatedAt: iso,
    }, null, 2),
  );
  fs.writeFileSync(path.join(relayRun, 'meta.json'), JSON.stringify({ tags: [], runId: tripRunId, goalId: 'GOAL-0001', taskId: 'TASK-0001', taskRunSequence: 1, workspaceRoot: wsDir, workerId: 'claude-code' }, null, 2));
  return { relayRoot, relayProj, relayRun, wsDir, tripRunId };
};

// Read the LAST worker-launch.log argvShape (the log appends entries).
const lastArgvShape = (relayRun) => {
  const logTail = JSON.parse(fs.readFileSync(path.join(relayRun, 'worker-launch.log'), 'utf8').split('\n---\n').pop());
  return Array.isArray(logTail.argvShape) ? logTail.argvShape : [];
};

// The wrapper redacts argv elements: flags verbatim, longer values trimmed to
// first 40 chars + '…(truncated)'. Mirror it for byte-identical assertions.
const redactArgvElem = (a) => (/^-/.test(a) ? a : a.length <= 80 ? a : a.slice(0, 40) + '…(truncated)');

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
  check(r.status === 0 && (r.stdout || '').includes(`--add-dir|${CWD}|--print|OPTIONS-PROMPT`) && (r.stdout || '').includes(`CONFIG=${profile}`) && (r.stdout || '').includes(`PWD=${CWD}`), 'QA passthrough applies config, add-dir, and spawn PWD without permission mode');
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

// 5. Round 37: Builder relay argv ORDER — the positional prompt comes
//    immediately after --print, --allowedTools comes AFTER the prompt, and its
//    value is ONE comma-joined string (the real claude CLI treats
//    --allowedTools as VARIADIC and would otherwise swallow the prompt).
{
  const { relayRoot, relayProj, tripRunId, relayRun, wsDir } = makeRelayFixture();
  const patterns = ['Bash(node:*)', 'Read', 'Bash(git status:*)', 'Grep'];
  const relayArgv = [
    WRAPPER,
    '--dataRoot', relayRoot, '--project', relayProj, '--taskId', 'TASK-0001', '--runId', tripRunId,
    '--workspaceRoot', wsDir,
    ...patterns.flatMap((p) => ['--allowedTool', p]),
  ];
  const r = spawnSync(process.execPath, relayArgv, {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ARGV },
  });
  check(r.status === 0, `Builder relay with allowedTools exits 0 (got ${r.status}, stderr=${JSON.stringify((r.stderr || '').slice(0, 200))})`);
  // The Builder relay path captures Claude's stdout/stderr for bounded diagnostics
  // only, so the forwarded argv is asserted from the run's worker-launch.log
  // argvShape (g6 convention), never from wrapper stdout.
  const shape = lastArgvShape(relayRun);
  const printIdx = shape.indexOf('--print');
  const toolIdx = shape.indexOf('--allowedTools');
  const promptElem = shape[printIdx + 1];
  check(
    shape[0] === ARGV && printIdx !== -1 && promptElem !== undefined && promptElem.startsWith('You are executing one Agent Relay Task.'),
    'Builder relay argv places the positional prompt immediately after --print',
  );
  check(
    toolIdx !== -1 && toolIdx > printIdx && shape[toolIdx + 2] === undefined,
    '--allowedTools appears AFTER the prompt and consumes exactly one following argv element',
  );
  check(
    shape[toolIdx + 1] === patterns.join(','),
    `--allowedTools value is a single comma-joined string (got ${JSON.stringify(shape[toolIdx + 1])})`,
  );
  check(!shape.includes('--permission-mode'), 'Builder relay argv emits no --permission-mode without the relay flag (default permission mode)');
}

// 5b. Round 37: a pattern containing a comma is a fatal ArgError with its own
//     message (patterns share one comma-joined --allowedTools value).
{
  for (const commaPattern of ['Read,Glob', 'Bash(node:*),Bash(test:*)']) {
    const r = spawnSync(process.execPath, [
      WRAPPER, '--dataRoot', '/nonexistent-root-xyz', '--project', 'P', '--taskId', 'T', '--runId', 'R',
      '--workspaceRoot', CWD, '--allowedTool', commaPattern,
    ], {
      cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CLAUDE_EXE: ARGV },
    });
    check(r.status === 1, `allowedTool pattern with a comma is fatal: ${commaPattern}`);
    check(
      (r.stderr || '').includes('Fatal') && (r.stderr || '').includes('contains a comma') && (r.stderr || '').includes(commaPattern),
      `comma rejection names the comma with its own message: ${commaPattern}`,
    );
    check(!(r.stdout || '').includes('--allowedTools'), `comma pattern never reaches Claude argv: ${commaPattern}`);
  }
}

// 5c. Round 37: with NO allowedTools in the record the Builder relay argv is
//     byte-identical to the pre-round-35 shape (default permission mode →
//     `--add-dir <ws> --print <prompt>`, no tool or permission flags at all).
{
  const { relayRoot, relayProj, tripRunId, relayRun, wsDir } = makeRelayFixture();
  const r = spawnSync(process.execPath, [
    WRAPPER,
    '--dataRoot', relayRoot, '--project', relayProj, '--taskId', 'TASK-0001', '--runId', tripRunId,
    '--workspaceRoot', wsDir,
  ], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ARGV },
  });
  check(r.status === 0, `Builder relay without allowedTools exits 0 (got ${r.status}, stderr=${JSON.stringify((r.stderr || '').slice(0, 200))})`);
  const shape = lastArgvShape(relayRun);
  // Replicate the wrapper's deterministic buildWorkerPrompt for this fixture
  // (task TASK-0001, title 't', goal 'g', reason 'r', scope 's', one criterion)
  // and apply the same redactedArgvShape truncation for a byte-identical match.
  const expectedPrompt = [
    'You are executing one Agent Relay Task.',
    '',
    `Task ID: TASK-0001`,
    `Run ID: ${tripRunId}`,
    '',
    'Title:',
    't',
    '',
    'Goal:',
    'g',
    '',
    'Reason:',
    'r',
    '',
    'Scope:',
    's',
    '',
    'Completion criteria:',
    '- c',
    '',
    'Instructions:',
    '- Work only inside the provided coding workspace.',
    '- Complete the requested task.',
    '- Do not alter Agent Relay state files directly.',
    '- When finished, provide a concise final response describing what changed,',
    '  verification performed, and remaining blockers.',
  ].join('\n');
  const expectedShape = [
    ARGV,
    '--add-dir', wsDir, '--print',
    redactArgvElem(expectedPrompt),
  ];
  check(
    JSON.stringify(shape) === JSON.stringify(expectedShape),
    'no allowedTools → Builder relay argv is byte-identical to the pre-round-35 shape',
  );
}


// 6. Round 35: a forbidden --allowedTool pattern is a fatal ArgError on the Builder path.
{
  for (const bad of ['Bash(*)', 'Bash(rm:*)', 'Bash(git push:*)', 'Bash(sudo:*)', 'Bash(pkill:*)']) {
    const r = spawnSync(process.execPath, [
      WRAPPER, '--dataRoot', '/nonexistent-root-xyz', '--project', 'P', '--taskId', 'T', '--runId', 'R',
      '--workspaceRoot', CWD, '--allowedTool', bad,
    ], {
      cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CLAUDE_EXE: ARGV },
    });
    check(r.status === 1, `forbidden allowedTool pattern is fatal: ${bad}`);
    check((r.stderr || '').includes('Fatal') && (r.stderr || '').includes('Invalid --allowedTool pattern') && (r.stderr || '').includes(bad), `forbidden pattern error names the rejected pattern: ${bad}`);
    check(!(r.stdout || '').includes('--allowedTools'), `forbidden pattern never reaches Claude argv: ${bad}`);
  }
}

// 7. Round 35: the QA passthrough rejects --allowedTool (never reaches Claude).
{
  const r = spawnSync(process.execPath, [WRAPPER, '--allowedTool', 'Bash(node:*)', '--print', 'QA-TOOL-PROMPT'], {
    cwd: CWD, shell: false, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CLAUDE_EXE: ARGV },
  });
  check(r.status === 1, `QA passthrough rejects allowedTool (got ${r.status})`);
  check((r.stderr || '').includes('forbidden') && !(r.stdout || '').includes('QA-TOOL-PROMPT'), 'QA passthrough fails closed before Claude when allowedTool is supplied');
}

console.log(`\nSlice 8 wrapper QA mode: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
