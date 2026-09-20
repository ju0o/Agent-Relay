import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { listTurns } from '../dist/server/runner/turn-store.js';

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');

const RESPONDER = path.resolve('test/helpers/turn-responder.mjs');

function writeDriver(dir) {
  const file = path.join(dir, 'driver.mjs');
  const lines = [
    "import * as fs from 'node:fs';",
    'const [storeRoot, dataRoot, project, laneRoot, counter, sleepMs] = process.argv.slice(2);',
    "const le = await import(process.cwd() + '/dist/server/runner/lane-engine.js');",
    "const sch = await import(process.cwd() + '/dist/server/workspace/scheduler.js');",
    "const gt = await import(process.cwd() + '/dist/server/backend/goal-task.js');",
    "const rt = await import(process.cwd() + '/dist/server/backend/goal-task-runtime.js');",
    "const tr = await import(process.cwd() + '/dist/server/runner/transport.js');",
    'const ioDir = storeRoot;',
    `const RESPONDER = ${JSON.stringify(RESPONDER)};`,
    "const B = (role) => ({ transport: new tr.SubprocessTransport(ioDir), session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: role, RR_COUNTER: counter, RR_SLEEP_MS: sleepMs } }, sessionId: 'sub:' + role });",
    "const lane = { id: 'e2e', label: 'E2E', root: laneRoot, goal: 'durable e2e', pm: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'read-only' } }, builder: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'write-workspace' } }, qa: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'read-only' } }, qaFallback: { runtime: 't', model: 'm' } };",
    'const stores = {',
    "  listReadyTasks: () => gt.listTasks(dataRoot, project).filter((t) => t.executionState === 'READY').map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState })),",
    '  readTask: (l, id) => { try { const t = gt.getTask(dataRoot, project, id); return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState }; } catch { return null; } },',
    '  taskContract: () => ({}), acceptanceCriteria: () => [],',
    '};',
    "const dispatchLog = storeRoot + '/dispatch.log';",
    'const seams = {',
    '  dispatch: async (l, t) => {',
    "    fs.appendFileSync(dispatchLog, t.taskId + '\\n');",
    '    const cur = gt.getTask(dataRoot, project, t.taskId);',
    "    if (cur.executionState === 'READY') await rt.transitionTaskExecution(dataRoot, project, t.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'restart e2e' });",
    "    return { runId: 'e2e-run-1' };",
    '  },',
    "  accept: async (l, t, runId) => { fs.appendFileSync(storeRoot + '/accept.log', t.taskId + ' ' + runId + '\\n'); },",
    '  nextTask: async () => null,',
    '};',
    "const out = await le.advanceLane(lane, stores, seams, { pm: B('pm'), builder: B('builder'), qa: B('qa') }, new sch.LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), { storeRoot, correlationId: 'e2e-restart', projectId: project, turnTimeoutMs: 30000, maxTurnsPerAdvance: 60 });",
    "console.log('DRIVER_OUTCOME ' + JSON.stringify({ outcome: out.outcome, taskId: out.laneRun.taskId }));",
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function waitFor(cond, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`wait timeout: ${label}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

test('kill -9 mid-build resumes from durable state with exactly one Builder execution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-restart-'));
  const laneRoot = path.join(dir, 'lane');
  const dataRoot = path.join(dir, 'data');
  const storeRoot = path.join(dir, 'store');
  const counter = path.join(dir, 'builder.counter');
  fs.mkdirSync(laneRoot, { recursive: true });
  const project = 'RST';
  const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'restart fixture' });
  const created = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's',
  });
  await rt.transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
  });
  const driver = writeDriver(dir);
  const runDriver = () => spawn(process.execPath, [driver, storeRoot, dataRoot, project, laneRoot, counter, '4000'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Process A runs until the builder turn is RUNNING, then dies by SIGKILL.
  const a = runDriver();
  let aErr = '';
  a.stderr.on('data', (c) => { aErr += c; });
  waitFor(() => {
    try {
      return listTurns(storeRoot).some((t) => t.role === 'builder' && t.state === 'RUNNING');
    } catch { return false; }
  }, 60000, 'builder RUNNING');
  await new Promise((r) => setTimeout(r, 1000));
  a.kill('SIGKILL');
  await new Promise((resolve) => a.on('exit', resolve));

  // Process B resumes the same store and must finish without re-running work.
  const b = runDriver();
  let bOut = '';
  let bErr = '';
  b.stdout.on('data', (c) => { bOut += c; });
  b.stderr.on('data', (c) => { bErr += c; });
  const bExit = new Promise((resolve) => b.on('exit', (code) => resolve(code)));
  const done = waitFor(() => {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(storeRoot, 'lane-runs', 'e2e.json'), 'utf8'));
      return rec.phase === 'DONE' ? rec : null;
    } catch { return null; }
  }, 90000, 'lane DONE');
  const code = await bExit;
  assert.equal(code, 0, `driver B exit 0 (stderr: ${bErr.slice(0, 500)}${aErr ? ` | A stderr: ${aErr.slice(0, 300)}` : ''})`);
  assert.equal(done.outcome, 'ACCEPT_AND_ADVANCE');

  // Exactly one Builder execution across both processes (durable proof).
  const builds = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(builds.length, 1, `builder executed once across kill -9 (got ${builds.length})`);
  const turns = listTurns(storeRoot);
  assert.equal(turns.filter((t) => t.role === 'builder' && t.state === 'VERIFIED').length, 1);
  assert.equal(turns.filter((t) => t.role === 'qa' && t.state === 'VERIFIED').length, 1);
  const pmTurns = turns.filter((t) => t.role === 'pm' && t.state === 'VERIFIED');
  assert.equal(pmTurns.length, 2, 'one DISPATCH turn + one review turn, no duplicates');
  assert.ok(bOut.includes('DRIVER_OUTCOME'));
  const dispatches = fs.readFileSync(path.join(storeRoot, 'dispatch.log'), 'utf8').trim().split('\n');
  assert.deepEqual(dispatches, [created.taskId]);
  assert.ok(fs.readFileSync(path.join(storeRoot, 'accept.log'), 'utf8').includes('e2e-run-1'));
}, { timeout: 180000 });
