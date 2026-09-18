/**
 * §16 second proof — real but low-risk Agent Relay dogfood Task.
 * Disposable DATA_ROOT only. Never touches production data or JuControler.
 *
 * Scenario: 2-task dogfood plan (PASS → NEXT → PASS → GOAL_COMPLETE).
 * Worker writes a real Project-Dogfooding-style note file into the disposable
 * data root to prove the Run had a real effect. Reviewer is the explicit
 * mock-pass path (real ChatGPT transport is down in this headless env —
 * see §14 REVIEW_BLOCKED proof in goal-loop.test.mjs).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist', 'server', 'backend');
const goalLoop = await import(pathToFileURL(path.join(DIST, 'goal-loop.js')).href);
const goalTask = await import(pathToFileURL(path.join(DIST, 'goal-task.js')).href);
const { _resetChatGptMockForTests } = await import(pathToFileURL(path.join(DIST, 'chatgpt-review.js')).href);

_resetChatGptMockForTests();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dogfood-'));
const dataRoot = path.join(tmp, 'data');
const workspaceRoot = path.join(tmp, 'workspace');
fs.mkdirSync(dataRoot, { recursive: true });
fs.mkdirSync(workspaceRoot, { recursive: true });
const project = 'dogfood-proof';
const workerId = 'test-auto-worker';
const workersDir = path.join(dataRoot, '_relay', 'workers');
const workerCwd = path.join(dataRoot, '_work');
fs.mkdirSync(workersDir, { recursive: true });
fs.mkdirSync(workerCwd, { recursive: true });
fs.writeFileSync(path.join(workersDir, `${workerId}.json`), JSON.stringify({
  schemaVersion: 'G.2', workerId, launchCommand: 'node',
  launchArgsPrefix: [path.join(ROOT, 'test', 'helpers', 'goal-loop-worker.mjs')],
  workingDirectory: workerCwd, observationAdapterId: 'opencode',
}, null, 2), 'utf8');

const result = await goalLoop.startGoalLoop({
  dataRoot,
  project,
  goalTitle: 'Dogfood: AUTO loop handles a 2-step note task',
  goalStatement: 'Prove PASS->NEXT on two bounded disposable tasks with real file artifacts.',
  taskPlan: ['Write dogfood note A', 'Write dogfood note B'],
  workerId,
  workspaceRoot,
  transport: 'internal',
  maxTasks: 2,
  maxAttemptsPerTask: 2,
  resultWaitMs: 60000,
  reviewMode: 'mock-pass',
});

let fail = 0;
const check = (n, c, e = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${c ? '' : ` — ${e}`}`); if (!c) fail++; };

check('dogfood goal completes', result.status === 'GOAL_COMPLETE', result.status);
check('two tasks driven (NEXT rule)', result.tasksDriven.length === 2, JSON.stringify(result.tasksDriven));
const tasks = goalTask.listTasks(dataRoot, project, result.goalId);
check('both tasks accepted', tasks.length === 2 && tasks.every((t) => t.pmState === 'ACCEPTED'));
check('each task exactly 1 run (first-try PASS)', tasks.every((t) => t.linkedRuns.length === 1));
check('zero manual actions', result.metrics.gptDrag === 0 && result.metrics.founderClipboardActions === 0);
console.log(`DATA_ROOT=${dataRoot}`);
console.log(`dogfood proof: ${fail ? 'FAILED' : 'OK'}`);
process.exit(fail ? 1 : 0);
