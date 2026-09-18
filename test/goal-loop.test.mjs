/**
 * AUTO Goal Loop — disposable E2E proof (§15) + ChatGPT adapter unit checks.
 * Temporary DATA_ROOT only. No network, no tmux, no clipboard, no JuControler.
 *
 * Proves:
 * Goal created → Task created → Run created → prompt auto-sent (worker writes
 * result.md, no founder paste) → Result auto-captured → mock ChatGPT returns
 * CHANGES → SAME Task Run 2 auto-starts → mock returns PASS → Goal completes.
 * Founder clipboard/tmux/GPT-drag actions: 0 (asserted on loop metrics).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist', 'server', 'backend');

const { reviewRunWithChatGpt, _resetChatGptMockForTests } = await import(pathToFileURL(path.join(DIST, 'chatgpt-review.js')).href);
const goalLoop = await import(pathToFileURL(path.join(DIST, 'goal-loop.js')).href);
const goalTask = await import(pathToFileURL(path.join(DIST, 'goal-task.js')).href);

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ── 1. ChatGPT adapter: mock modes + REVIEW_BLOCKED on dead transport ──
_resetChatGptMockForTests();
const mockPass = await reviewRunWithChatGpt(
  { goalTitle: 'g', goalStatement: 's', taskId: 'TASK-1', taskTitle: 't', acceptanceCriteria: [], runId: 'r1', attemptSequence: 1, resultExcerpt: 'x', diffStat: '', repoSha: 'abc' },
  { reviewMode: 'mock-pass' },
);
check('mock-pass verdict', mockPass.verdict === 'PASS' && mockPass.viaExternalTool === false);

_resetChatGptMockForTests();
const c1 = await reviewRunWithChatGpt(
  { goalTitle: 'g', goalStatement: 's', taskId: 'TASK-1', taskTitle: 't', acceptanceCriteria: [], runId: 'r1', attemptSequence: 1, resultExcerpt: 'x', diffStat: '', repoSha: 'abc' },
  { reviewMode: 'mock-changes-then-pass' },
);
const c2 = await reviewRunWithChatGpt(
  { goalTitle: 'g', goalStatement: 's', taskId: 'TASK-1', taskTitle: 't', acceptanceCriteria: [], runId: 'r2', attemptSequence: 2, resultExcerpt: 'y', diffStat: '', repoSha: 'abc' },
  { reviewMode: 'mock-changes-then-pass' },
);
check('mock-changes-then-pass sequence', c1.verdict === 'CHANGES' && !!c1.retryInstruction && c2.verdict === 'PASS', JSON.stringify([c1.verdict, c2.verdict]));

const blocked = await reviewRunWithChatGpt(
  { goalTitle: 'g', goalStatement: 's', taskId: 'TASK-1', taskTitle: 't', acceptanceCriteria: [], runId: 'r1', attemptSequence: 1, resultExcerpt: 'x', diffStat: '', repoSha: 'abc' },
  { baseUrl: 'http://127.0.0.1:17999/v1', timeoutMs: 1500 },
);
check('real transport down => REVIEW_BLOCKED (never PASS)', blocked.verdict === 'REVIEW_BLOCKED' && !!blocked.blockedLayer, blocked.verdict);

// ── 2. Disposable E2E: CHANGES → SAME-task retry → PASS → GOAL_COMPLETE ──
_resetChatGptMockForTests();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-goalloop-'));
const dataRoot = path.join(tmp, 'data');
const workspaceRoot = path.join(tmp, 'workspace');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });
const project = 'disposable-proof';

// Register a test worker (trusted GLOBAL registry {dataRoot}/_relay/workers).
const workerId = 'test-auto-worker';
const workersDir = path.join(dataRoot, '_relay', 'workers');
const workerCwd = path.join(dataRoot, '_work');
fs.mkdirSync(workerCwd, { recursive: true });
fs.mkdirSync(workersDir, { recursive: true });
fs.writeFileSync(
  path.join(workersDir, `${workerId}.json`),
  JSON.stringify({
    schemaVersion: 'G.2',
    workerId,
    launchCommand: 'node',
    launchArgsPrefix: [path.join(ROOT, 'test', 'helpers', 'goal-loop-worker.mjs')],
    workingDirectory: workerCwd,
    observationAdapterId: 'opencode',
  }, null, 2),
  'utf8',
);

let result = null;
try {
  result = await goalLoop.startGoalLoop({
    dataRoot,
    project,
    goalTitle: 'Disposable proof goal',
    goalStatement: 'Prove AUTO loop on a bounded no-op task.',
    taskPlan: ['Bounded disposable step'],
    workerId,
    workspaceRoot,
    transport: 'internal',
    maxTasks: 1,
    maxAttemptsPerTask: 3,
    resultWaitMs: 60000,
    reviewMode: 'mock-changes-then-pass',
  });
} catch (e) {
  check('goal loop runs without throwing', false, e instanceof Error ? e.message : String(e));
}

if (result) {
  check('goal completes', result.status === 'GOAL_COMPLETE', result.status + (result.stoppedDetail ? ` — ${result.stoppedDetail}` : ''));
  const tasks = goalTask.listTasks(dataRoot, project, result.goalId);
  check('exactly one task (SAME-task retry, no replacement)', tasks.length === 1, `tasks=${tasks.length}`);
  const t = tasks[0];
  check('task accepted', t.pmState === 'ACCEPTED', `${t.executionState}/${t.pmState}`);
  check('two run attempts on SAME task', t.linkedRuns.length === 2, `linked=${t.linkedRuns.length}`);
  check('retry lineage preserved (sequence 1,2)', JSON.stringify(t.linkedRuns.map((r) => r.taskRunSequence).sort()) === '[1,2]');
  check('accepted run is attempt 2', t.acceptedRunId === t.linkedRuns.find((r) => r.taskRunSequence === 2)?.runId);
  check('metrics: zero manual actions', result.metrics.manualPromptCopy === 0 && result.metrics.manualResultPaste === 0 && result.metrics.gptDrag === 0 && result.metrics.founderClipboardActions === 0 && result.metrics.founderTmuxActions === 0, JSON.stringify(result.metrics));
  const artifact = path.join(workspaceRoot, 'auto-proof.txt');
  check('worker executed (workspace artifact)', fs.existsSync(artifact));
}

// ── 3. REVIEW_BLOCKED durability: run stays, no PASS ──
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-goalloop-blocked-'));
  const dr2 = path.join(tmp2, 'data');
  const ws2 = path.join(tmp2, 'workspace');
  fs.mkdirSync(dr2, { recursive: true });
  fs.mkdirSync(ws2, { recursive: true });
  const wdir = path.join(dr2, '_relay', 'workers');
  const wcwd2 = path.join(dr2, '_work');
  fs.mkdirSync(wcwd2, { recursive: true });
  fs.mkdirSync(wdir, { recursive: true });
  fs.writeFileSync(path.join(wdir, `${workerId}.json`), JSON.stringify({
    schemaVersion: 'G.2', workerId, launchCommand: 'node',
    launchArgsPrefix: [path.join(ROOT, 'test', 'helpers', 'goal-loop-worker.mjs')],
    workingDirectory: wcwd2, observationAdapterId: 'opencode',
  }, null, 2), 'utf8');
  // Force the review transport down by pointing at a dead port via env.
  process.env.CODEX_WEB_GPT_RESPONSES_URL = 'http://127.0.0.1:17999/v1';
  let r2 = null;
  try {
    r2 = await goalLoop.startGoalLoop({
      dataRoot: dr2, project, goalTitle: 'Blocked proof', goalStatement: 'Review transport down.',
      taskPlan: ['step'], workerId, workspaceRoot: ws2, transport: 'internal',
      maxTasks: 1, maxAttemptsPerTask: 1, resultWaitMs: 60000, reviewMode: 'real',
    });
  } catch (e) {
    check('blocked loop returns state (no throw)', false, String(e));
  }
  delete process.env.CODEX_WEB_GPT_RESPONSES_URL;
  check('review down => STOPPED_REVIEW_BLOCKED', r2?.status === 'STOPPED_REVIEW_BLOCKED', r2?.status);
  if (r2) {
    const tasks = goalTask.listTasks(dr2, project, r2.goalId);
    check('run remains durable (not deleted)', tasks.length === 1 && tasks[0].linkedRuns.length === 1);
    check('no silent PASS', tasks[0].pmState !== 'ACCEPTED', tasks[0].pmState);
  }
}

console.log(`\n goal-loop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
