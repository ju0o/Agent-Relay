import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const night = await import('../dist/server/runner/night-run.js');

function tmp() {
  // Store lives one level down so each test owns an isolated night-run dir
  // (nightDirFor resolves to dirname(store)/night-run).
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-night-')), 'runner');
}

function run(laneId, outcome, extra = {}) {
  return {
    laneRunId: `lr-${laneId}`, correlationId: 'c', laneId, projectId: laneId,
    taskId: 'TASK-1', runId: 'run-1', attempt: 1, phase: 'DONE', outcome,
    reason: null, qaMode: 'primary', route: 'full', envelope: null,
    updatedAt: new Date().toISOString(), ...extra,
  };
}

function turn(state = 'REQUESTED') {
  return {
    turnId: 't1', projectId: 'actl', taskId: 'TASK-1', runId: 'run-1', role: 'builder',
    requestId: 'q1', correlationId: 'c', attempt: 1, state, timeoutMs: 1000, maxAttempts: 3,
    requestBody: 'b', resultBody: null, resultRef: null, error: null, transient: false,
    createdAt: '', updatedAt: '', history: [],
  };
}

const EMPTY = { runs: [], pendingTurns: [], readyByLane: {}, retryable: [], pendingFallbacks: [], recoverableFailures: [] };

test('completion requires every lane terminal with nothing left', () => {
  const done = night.evaluateNightCompletion({
    ...EMPTY,
    runs: [run('actl', 'ACCEPT_AND_ADVANCE'), run('juplan', 'HUMAN_GATE_PARKED')],
  });
  assert.equal(done.complete, true);

  const cases = [
    ['pending turn', { runs: [run('actl', 'ACCEPT_AND_ADVANCE')], pendingTurns: [turn('RUNNING')] }],
    ['READY backlog', { runs: [run('actl', 'ACCEPT_AND_ADVANCE')], readyByLane: { actl: ['TASK-2'] } }],
    ['retryable failure', { runs: [run('actl', 'ACCEPT_AND_ADVANCE')], retryable: [{ ...turn('FAILED'), transient: true }] }],
    ['pending QA fallback', { runs: [run('actl', 'ACCEPT_AND_ADVANCE')], pendingFallbacks: ['actl'] }],
    ['live lane', { runs: [run('actl', null, { phase: 'QA_TURN', outcome: null })] }],
    ['missing lane run', { runs: [null] }],
  ];
  for (const [name, input] of cases) {
    const r = night.evaluateNightCompletion({ ...EMPTY, ...input });
    assert.equal(r.complete, false, name);
    assert.ok(r.reason.length > 0, name);
  }
});

test('buildNightSummary + writeLastRun + readLastRun round-trip', () => {
  const store = tmp();
  const { summary } = night.buildNightSummary({
    cycleId: 'night-1', startedAt: new Date().toISOString(),
    lanes: [{ id: 'actl', root: '/tmp/x' }],
    runs: [run('actl', 'ACCEPT_AND_ADVANCE', { qaMode: 'fallback:cursor', reason: 'ok' })],
    pendingTurns: [], readyByLane: {}, retryable: [], pendingFallbacks: [], recoverableFailures: [],
    accepted: [{ laneId: 'actl', taskId: 'TASK-1' }],
    changesLanes: [], fallbacksUsed: ['actl:fallback:cursor'],
    checkpointShas: { actl: 'abc123' }, errors: [], runnerSha: 'def456',
  });
  assert.equal(summary.complete, true);
  assert.equal(summary.lanes[0].state, 'DONE');
  const file = night.writeLastRun(store, summary);
  assert.equal(file, path.join(path.dirname(store), 'night-run', 'LAST_RUN.json'));
  const back = night.readLastRun(store);
  assert.equal(back.cycleId, 'night-1');
  assert.equal(back.complete, true);
  assert.deepEqual(back.fallbacksUsed, ['actl:fallback:cursor']);
  assert.equal(back.checkpointShas.actl, 'abc123');
});

test('readLastRun rejects foreign schemas', () => {
  const store = tmp();
  const dir = path.join(path.dirname(store), 'night-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'LAST_RUN.json'), JSON.stringify({ schemaVersion: 'other', complete: true }));
  assert.equal(night.readLastRun(store), null);
  assert.equal(night.readLastRun(path.join(tmp(), 'absent')), null);
});

function fakeRunners() {
  const calls = [];
  return {
    calls,
    runners: [
      { name: 'runner-a', alive: () => true, stop: async () => { calls.push('stop:runner-a'); return 'stopped a'; } },
      { name: 'runner-b', alive: () => false, stop: async () => { calls.push('stop:runner-b'); return 'stopped b'; } },
    ],
  };
}

const PRIV_NO = () => ({ ok: false, reason: 'test: unprivileged' });
const PRIV_YES = () => ({ ok: true, reason: 'test: privileged' });

test('live shutdown without a passed gate refuses and touches nothing', async () => {
  const store = tmp();
  const { calls, runners } = fakeRunners();
  let powered = 0;
  const res = await night.runShutdownSequence({
    storeRoot: store, laneIds: ['actl'], dryRun: false, poweroff: true, runners,
    canPowerOff: PRIV_YES, powerOffHost: () => { powered += 1; return { status: 0, detail: 'x' }; },
  });
  assert.equal(res.ok, false);
  assert.equal(res.gatePassed, false);
  assert.deepEqual(calls, []);
  assert.equal(powered, 0);
  assert.equal(res.steps[0].step, 'gate');
  assert.equal(res.steps[0].status, 'refused');
});

test('dry-run with a passed gate rehearses without effects', async () => {
  const store = tmp();
  const { summary } = night.buildNightSummary({
    cycleId: 'night-2', startedAt: new Date().toISOString(),
    lanes: [{ id: 'actl', root: '/tmp/x' }],
    runs: [run('actl', 'ACCEPT_AND_ADVANCE')],
    pendingTurns: [], readyByLane: {}, retryable: [], pendingFallbacks: [], recoverableFailures: [],
    accepted: [{ laneId: 'actl', taskId: 'TASK-1' }],
    changesLanes: [], fallbacksUsed: [], checkpointShas: {}, errors: [], runnerSha: null,
  });
  night.writeLastRun(store, summary);
  const { calls, runners } = fakeRunners();
  let powered = 0;
  const res = await night.runShutdownSequence({
    storeRoot: store, laneIds: ['actl'], dryRun: true, poweroff: true, runners,
    canPowerOff: PRIV_YES, powerOffHost: () => { powered += 1; return { status: 0, detail: 'x' }; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.gatePassed, true);
  assert.deepEqual(calls, [], 'dry-run stops nothing');
  assert.equal(powered, 0, 'dry-run powers off nothing');
  assert.ok(res.steps.some((s) => s.step === 'poweroff' && s.status === 'ok' && /would power off/.test(s.detail)));
});

test('poweroff without privilege aborts POWER_OFF_PRIVILEGE_REQUIRED', async () => {
  const store = tmp();
  const { summary } = night.buildNightSummary({
    cycleId: 'night-3', startedAt: new Date().toISOString(),
    lanes: [{ id: 'actl', root: '/tmp/x' }],
    runs: [run('actl', 'ACCEPT_AND_ADVANCE')],
    pendingTurns: [], readyByLane: {}, retryable: [], pendingFallbacks: [], recoverableFailures: [],
    accepted: [], changesLanes: [], fallbacksUsed: [], checkpointShas: {}, errors: [], runnerSha: null,
  });
  night.writeLastRun(store, summary);
  const { calls, runners } = fakeRunners();
  let powered = 0;
  const res = await night.runShutdownSequence({
    storeRoot: store, laneIds: ['actl'], dryRun: false, poweroff: true, runners,
    canPowerOff: PRIV_NO, powerOffHost: () => { powered += 1; return { status: 0, detail: 'x' }; },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(calls, ['stop:runner-a', 'stop:runner-b'], 'runners stop before the poweroff step');
  assert.equal(powered, 0, 'host never powered off without privilege');
  const po = res.steps.find((s) => s.step === 'poweroff');
  assert.equal(po.status, 'refused');
  assert.match(po.detail, /POWER_OFF_PRIVILEGE_REQUIRED/);
});

test('live shutdown with gate and privilege stops runners then powers off', async () => {
  const store = tmp();
  const { summary } = night.buildNightSummary({
    cycleId: 'night-4', startedAt: new Date().toISOString(),
    lanes: [{ id: 'actl', root: '/tmp/x' }],
    runs: [run('actl', 'ACCEPT_AND_ADVANCE')],
    pendingTurns: [], readyByLane: {}, retryable: [], pendingFallbacks: [], recoverableFailures: [],
    accepted: [], changesLanes: [], fallbacksUsed: [], checkpointShas: {}, errors: [], runnerSha: null,
  });
  night.writeLastRun(store, summary);
  const { calls, runners } = fakeRunners();
  const order = [];
  const res = await night.runShutdownSequence({
    storeRoot: store, laneIds: ['actl'], dryRun: false, poweroff: true, runners,
    canPowerOff: PRIV_YES,
    powerOffHost: () => { order.push(`powered-after:${calls.join(',')}`); return { status: 0, detail: 'off' }; },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(order, ['powered-after:stop:runner-a,stop:runner-b']);
});

test('daemon night mode completes one lane and writes LAST_RUN', async () => {
  const { SubprocessTransport } = await import('../dist/server/runner/transport.js');
  const { LaneScheduler } = await import('../dist/server/workspace/scheduler.js');
  const { defaultWorkspaceConfigV2 } = await import('../dist/server/workspace/config-v2.js');
  const gt = await import('../dist/server/backend/goal-task.js');
  const rt = await import('../dist/server/backend/goal-task-runtime.js');
  const daemon = await import('../dist/server/runner/daemon.js');
  const RESPONDER = path.resolve('test/helpers/turn-responder.mjs');
  const sub = (role) => ({
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: role } },
    sessionId: `sub:${role}`,
  });
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-night-data-'));
  const project = 'actl';
  const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'x' });
  const created = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's' });
  await rt.transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
  });
  const store = tmp();
  const lane = { ...defaultWorkspaceConfigV2().lanes.find((l) => l.id === 'actl'), root: dataRoot };
  const stores = {
    listReadyTasks: () => gt.listTasks(dataRoot, project)
      .filter((t) => t.executionState === 'READY')
      .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState })),
    readTask: (_l, id) => {
      try {
        const t = gt.getTask(dataRoot, project, id);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch { return null; }
    },
    taskContract: () => ({ acceptance: 'fixture' }),
    acceptanceCriteria: () => ['fixture ac'],
  };
  const seams = {
    dispatch: async (_l, task) => {
      const cur = gt.getTask(dataRoot, project, task.taskId);
      if (cur.executionState === 'READY') {
        await rt.transitionTaskExecution(dataRoot, project, task.taskId, {
          expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'night e2e',
        });
      }
      return { runId: 'night-run-1' };
    },
    accept: async () => {},
    nextTask: async () => null,
  };
  const audit = [];
  await daemon.serve({
    storeRoot: store, lanes: [lane], stores, seams,
    resolveBindings: async () => ({ pm: sub('pm'), builder: sub('builder'), qa: sub('qa') }),
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    correlationId: 'night-e2e', projectId: project, once: true,
    night: { cycleId: 'night-e2e', startedAt: new Date().toISOString() },
    turnTimeoutMs: 15000, audit: (e) => audit.push(e),
  });
  assert.ok(audit.some((e) => e.step === 'night_complete'), 'daemon recorded night_complete');
  const last = night.readLastRun(store);
  assert.ok(last, 'LAST_RUN.json written');
  assert.equal(last.cycleId, 'night-e2e');
  assert.equal(last.complete, true);
  assert.equal(last.lanes[0].state, 'DONE');
});

test('store completion derives truthfully from disk', async () => {
  const store = tmp();
  // IDLE lane: no run at all.
  let c = night.evaluateStoreCompletion(store, ['actl']);
  assert.equal(c.complete, false);
  assert.equal(c.lanes[0].state, 'IDLE');
  // DONE lane with no pending turns: complete.
  fs.mkdirSync(path.join(store, 'lane-runs'), { recursive: true });
  const rec = {
    laneRunId: 'lr-actl', correlationId: 'c', laneId: 'actl', projectId: 'actl',
    taskId: 'TASK-1', runId: 'run-9', attempt: 1, phase: 'DONE', outcome: 'ACCEPT_AND_ADVANCE',
    reason: 'ok', qaMode: 'primary', route: 'full', envelope: null, updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(store, 'lane-runs', 'actl.json'), JSON.stringify(rec));
  c = night.evaluateStoreCompletion(store, ['actl']);
  assert.equal(c.complete, true);
  assert.equal(c.lanes[0].state, 'DONE');
  // A stale pending turn on the same lineage reopens the night.
  const ts = await import('../dist/server/runner/turn-store.js');
  ts.createTurn(store, {
    projectId: 'actl', taskId: 'TASK-1', runId: 'run-9', role: 'qa',
    requestId: 'q-stale', correlationId: 'c', requestBody: 'stale',
  });
  c = night.evaluateStoreCompletion(store, ['actl']);
  assert.equal(c.complete, false);
  assert.match(c.reason, /pending/);
});
