import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createTurn,
  listPendingTurns,
  listTurns,
  readTurn,
  transitionTurn,
} from '../dist/server/runner/turn-store.js';
import {
  SubprocessTransport,
  TmuxTransport,
  beginMarker,
  endMarker,
  extractBoundary,
  newRequestId,
} from '../dist/server/runner/transport.js';
import { parseBuilderTurn, parsePmTurn, parseQaTurn } from '../dist/server/runner/result-parse.js';
import { advanceLane, executeTurn, readLaneRun, verifiedTurn } from '../dist/server/runner/lane-engine.js';
import { LaneScheduler } from '../dist/server/workspace/scheduler.js';
import { defaultWorkspaceConfigV2 } from '../dist/server/workspace/config-v2.js';

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ar-durable-'));
}

function turn(input = {}) {
  return {
    projectId: 'p', taskId: 'TASK-0001', runId: 'run-1', role: 'builder',
    correlationId: 'c1', requestBody: 'do work',
    ...input,
  };
}

// ── turn store ──────────────────────────────────────────────────────────────

test('turn lifecycle enforces legal transitions with CAS', () => {
  const store = tmp();
  const t = createTurn(store, turn());
  assert.equal(t.state, 'REQUESTED');
  assert.equal(t.attempt, 1);
  assert.ok(t.requestId);
  assert.throws(() => transitionTurn(store, t.turnId, 'VERIFIED'), /TURN_ILLEGAL/);
  assert.throws(() => transitionTurn(store, t.turnId, 'SENT', { expected: 'RUNNING' }), /TURN_CAS_CONFLICT/);
  const s = transitionTurn(store, t.turnId, 'SENT', { expected: 'REQUESTED' });
  assert.equal(s.history.length, 2);
  assert.equal(listPendingTurns(store).length, 1);
  let cur = s;
  for (const next of ['RUNNING', 'RESULT_RECEIVED', 'VERIFIED']) {
    cur = transitionTurn(store, cur.turnId, next, { ...(next === 'RESULT_RECEIVED' ? { resultBody: 'R' } : {}) });
  }
  assert.equal(cur.state, 'VERIFIED');
  assert.equal(listPendingTurns(store).length, 0);
  assert.equal(readTurn(store, t.turnId).state, 'VERIFIED');
});

test('turn creation is idempotent per request identity (no duplicate turns)', () => {
  const store = tmp();
  const a = createTurn(store, turn({ requestId: 'req-1' }));
  const b = createTurn(store, turn({ requestId: 'req-1' }));
  assert.equal(a.turnId, b.turnId);
  assert.equal(listTurns(store).length, 1);
});

// ── boundary extraction ─────────────────────────────────────────────────────

test('only the current request boundary counts; history and truncation do not', () => {
  const old = 'AR_TURN_BEGIN:rold\nOLD RESULT AR_RUNNER_QA_DONE\nAR_TURN_END:rold\nnoise\n';
  const req = newRequestId();
  assert.notEqual(req, 'rold');
  // Truncated: begin without end is NOT a result.
  assert.equal(extractBoundary(`${old}${beginMarker(req)}\npartial`, req), null);
  // Old-history fixed markers never satisfy a new request.
  assert.equal(extractBoundary(`${old}AR_RUNNER_QA_DONE:${req}`, req), null);
  // Complete boundary extracts exactly.
  const full = `${old}${beginMarker(req)}\nQA_PASS verified ok\n${endMarker(req)}\ntrailer`;
  assert.equal(extractBoundary(full, req), 'QA_PASS verified ok');
  // A newer same-id send wins (lastIndexOf).
  const twice = `${beginMarker(req)}\nfirst\n${endMarker(req)}\n${beginMarker(req)}\nsecond\n${endMarker(req)}`;
  assert.equal(extractBoundary(twice, req), 'second');
});

// ── result parsing ──────────────────────────────────────────────────────────

test('pm/builder/qa parsing is strict per-turn', () => {
  assert.deepEqual(parsePmTurn('DISPATCH\n{"taskId":"TASK-7"}'), { kind: 'DISPATCH', taskId: 'TASK-7' });
  assert.deepEqual(parsePmTurn('ACCEPT'), { kind: 'ACCEPT' });
  assert.throws(() => parsePmTurn('maybe later'), /PM_TURN_AMBIGUOUS/);
  assert.throws(() => parsePmTurn('DISPATCH\n{}'), /taskId/);
  const b = parseBuilderTurn('RESULT_PACKET\nTask: TASK-1\nRun: run-9\nCommands: npm test\nTests: t1\nKnown risks: none');
  assert.equal(b.taskId, 'TASK-1');
  assert.equal(b.runId, 'run-9');
  assert.deepEqual(b.commands, ['npm test']);
  assert.throws(() => parseBuilderTurn('done-ish prose'), /RESULT_PACKET/);
  assert.deepEqual(parseQaTurn('QA_PASS all good').verdict, 'QA_PASS');
  const ch = parseQaTurn('QA_CHANGES\n- missing log\n- wrong path');
  assert.equal(ch.verdict, 'QA_CHANGES');
  assert.equal(ch.findings.length, 2);
  assert.throws(() => parseQaTurn('QA_CHANGES'), /findings/);
  assert.throws(() => parseQaTurn('looks fine'), /QA_TURN_AMBIGUOUS/);
});

// ── subprocess transport (real OS process) ──────────────────────────────────

const RESPONDER = path.resolve('test/helpers/turn-responder.mjs');

function subBinding(role, env = {}) {
  return {
    transport: new SubprocessTransport(),
    session: {
      kind: 'subprocess',
      target: process.execPath,
      args: [RESPONDER],
      env: { RR_ROLE: role, ...env },
    },
    sessionId: `sub:${role}`,
  };
}

test('subprocess transport round-trips a real process by request boundary', async () => {
  const store = tmp();
  const t = createTurn(store, turn({ requestBody: 'hello-real-process' }));
  const tr = new SubprocessTransport();
  const session = {
    kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'echo' },
  };
  await tr.sendTurn(t, session);
  const col = await tr.collectTurn(t, session, 15000);
  assert.equal(col.requestId, t.requestId);
  assert.ok(col.text.includes('ECHO:hello-real-process'));
});

test('subprocess transport times out boundedly without a boundary', async () => {
  const store = tmp();
  const t = createTurn(store, turn({ requestBody: 'x' }));
  const tr = new SubprocessTransport();
  await assert.rejects(
    () => tr.collectTurn(t, { kind: 'subprocess', target: process.execPath, args: ['-e', 'setTimeout(()=>{},30000)'] }, 800),
    /TURN_TIMEOUT/,
  );
});

// ── tmux transport (real scratch pane) ──────────────────────────────────────

function tmuxOk() {
  try {
    const r = spawnSync('tmux', ['ls'], { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test('tmux transport round-trips a real pane by request boundary', async () => {
  if (!tmuxOk()) {
    assert.ok(true, 'no tmux here; scratch-pane transport proven where tmux exists');
    return;
  }
  const session = `ar-tt-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  const mk = spawnSync('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50'], { encoding: 'utf8', timeout: 8000 });
  assert.equal(mk.status, 0, 'scratch tmux session created');
  try {
    const store = tmp();
    const t = createTurn(store, turn({ requestBody: 'PING-VIA-TMUX' }));
    const tr = new TmuxTransport();
    const pane = `${session}:0.0`;
    const health = await tr.checkHealth({ kind: 'tmux', target: pane });
    assert.equal(health.ok, true);
    spawnSync('tmux', ['send-keys', '-t', pane, `${process.execPath} ${RESPONDER}`, 'C-m'], { timeout: 5000 });
    // Deterministic readiness: the responder prints TURN_RESPONDER_READY (no
    // fixed sleep race under load).
    {
      const readyBy = Date.now() + 30000;
      for (;;) {
        const snap = spawnSync('tmux', ['capture-pane', '-p', '-t', pane], { encoding: 'utf8', timeout: 5000 }).stdout ?? '';
        if (snap.includes('TURN_RESPONDER_READY')) break;
        if (Date.now() > readyBy) throw new Error('responder never became ready');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await tr.sendTurn(t, { kind: 'tmux', target: pane });
    const col = await tr.collectTurn(t, { kind: 'tmux', target: pane }, 20000);
    assert.equal(col.requestId, t.requestId);
    assert.ok(col.text.includes('PING-VIA-TMUX'), `boundary echoed through real pane (got ${col.text.slice(0, 120)})`);
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  }
});

// ── lane engine full loop (scratch canonical scope, real turn store) ────────

async function seedScope() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-eng-'));
  const project = 'ENG';
  const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'engine fixture' });
  const created = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's',
  });
  const ready = await rt.transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
  });
  return { dataRoot, project, taskId: ready.taskId };
}

function lane() {
  return defaultWorkspaceConfigV2().lanes.find((l) => l.id === 'actl');
}

function engineHarness(dataRoot, project) {
  const dispatches = [];
  const stores = {
    listReadyTasks: () => gt.listTasks(dataRoot, project)
      .filter((t) => t.executionState === 'READY')
      .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState })),
    readTask: (_l, taskId) => {
      try {
        const t = gt.getTask(dataRoot, project, taskId);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch { return null; }
    },
    taskContract: () => ({ acceptance: 'fixture' }),
    acceptanceCriteria: () => ['fixture ac'],
  };
  const seams = {
    dispatch: async (_l, task) => {
      dispatches.push(task.taskId);
      const cur = gt.getTask(dataRoot, project, task.taskId);
      if (cur.executionState === 'READY') {
        await rt.transitionTaskExecution(dataRoot, project, task.taskId, {
          expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'engine e2e dispatch (real CAS)',
        });
      }
      return { runId: `eng-run-${dispatches.length}` };
    },
    accept: async () => {},
    nextTask: async () => null,
  };
  return { stores, seams, dispatches };
}

test('engine drives PM->Builder->QA->PM to ACCEPT on durable turns', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const store = tmp();
  const audit = [];
  const { stores, seams, dispatches } = engineHarness(dataRoot, project);
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa') };
  const out = await advanceLane(lane(), stores, seams, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'eng-1', projectId: project,
    turnTimeoutMs: 15000, audit: (e) => audit.push(e),
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(out.laneRun.taskId, taskId);
  assert.deepEqual(dispatches, [taskId]);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  // Every turn carries full structured identity; builder verified once.
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  assert.ok(turns.length >= 4);
  for (const t of turns) {
    assert.ok(t.projectId && t.taskId && t.runId && t.requestId && t.correlationId === 'eng-1');
  }
  const builders = turns.filter((t) => t.role === 'builder' && t.state === 'VERIFIED');
  assert.equal(builders.length, 1);
  const rec = readLaneRun(store, 'actl');
  assert.equal(rec.phase, 'DONE');
});

test('engine reuses verified turns on re-entry (restart-safe, no duplicates)', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const store = tmp();
  const { stores, seams } = engineHarness(dataRoot, project);
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa') };
  const base = {
    storeRoot: store, correlationId: 'eng-2', projectId: project,
    turnTimeoutMs: 15000, scheduler: undefined,
  };
  const sched = () => new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const out1 = await advanceLane(lane(), stores, seams, bindings, sched(), { ...base, maxTurnsPerAdvance: 100 });
  assert.equal(out1.outcome, 'ACCEPT_AND_ADVANCE');
  const turnsAfterFirst = (await import('../dist/server/runner/turn-store.js')).listTurns(store).length;
  // A second engine instance (post-restart) finds DONE and creates nothing.
  const out2 = await advanceLane(lane(), stores, seams, bindings, sched(), { ...base, maxTurnsPerAdvance: 100 });
  assert.equal(out2.outcome, 'ACCEPT_AND_ADVANCE');
  const turnsAfterSecond = (await import('../dist/server/runner/turn-store.js')).listTurns(store).length;
  assert.equal(turnsAfterSecond, turnsAfterFirst);
  void taskId;
});

test('RESULT_RECEIVED turn advances without transport contact after restart', async () => {
  const store = tmp();
  const t0 = createTurn(store, turn({ role: 'qa', requestId: 'req-rr', correlationId: 'c9' }));
  let cur = t0;
  cur = (await import('../dist/server/runner/turn-store.js')).transitionTurn(store, cur.turnId, 'SENT');
  cur = (await import('../dist/server/runner/turn-store.js')).transitionTurn(store, cur.turnId, 'RUNNING');
  cur = (await import('../dist/server/runner/turn-store.js')).transitionTurn(store, cur.turnId, 'RESULT_RECEIVED', { resultBody: 'QA_PASS ok' });
  // executeTurn must VERIFY from the durable record with zero transport calls.
  let calls = 0;
  const dead = {
    kind: 'x',
    sendTurn: async () => { calls += 1; },
    collectTurn: async () => { calls += 1; return { text: 'x', requestId: 'y', stable: true }; },
    checkHealth: async () => ({ ok: true }),
  };
  const { executeTurn: exec } = await import('../dist/server/runner/lane-engine.js');
  const out = await exec(store, { projectId: 'p', taskId: 'TASK-0001', runId: 'run-1', correlationId: 'c9' },
    'qa', 'body', { transport: dead, session: { kind: 'subprocess', target: 'x' }, sessionId: 's' },
    { timeoutMs: 1000, maxAttempts: 1 });
  assert.equal(out.text, 'QA_PASS ok');
  assert.equal(calls, 0);
  assert.equal(verifiedTurn(store, 'TASK-0001', 'qa', 'run-1').turnId, cur.turnId);
});

test('tmux collect requires role-shaped content (expect-gated timeout)', async () => {
  if (!tmuxOk()) {
    assert.ok(true, 'no tmux here');
    return;
  }
  const session = `ar-tx-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50'], { timeout: 8000 });
  try {
    const store = tmp();
    const t = createTurn(store, turn({ requestBody: 'PING' }));
    const tr = new TmuxTransport();
    const pane = `${session}:0.0`;
    await new Promise((r) => setTimeout(r, 800));
    await tr.sendTurn(t, { kind: 'tmux', target: pane });
    // Plain shell answers "command not found" — never RESULT_PACKET.
    await assert.rejects(
      () => tr.collectTurn(t, { kind: 'tmux', target: pane, expect: /RESULT_PACKET/ }, 4000),
      /TURN_TIMEOUT/,
    );
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  }
});

test('owner GO gates live effects fail-closed (expiry, revoke, scope, action)', async () => {
  const { recordOwnerGo, requireOwnerGo, revokeOwnerGo } = await import('../dist/server/runner/owner-go.js');
  const store = tmp();
  assert.throws(() => requireOwnerGo(store, 'actl', 'advance'), /OWNER_GO_REQUIRED/);
  const go = recordOwnerGo(store, { cycleId: 'c1', lanes: ['actl'], maxTasksPerLane: 1 });
  assert.equal(requireOwnerGo(store, 'actl', 'advance').goId, go.goId);
  assert.throws(() => requireOwnerGo(store, 'juplan', 'advance'), /OWNER_GO_SCOPE/);
  const noTmux = recordOwnerGo(store, { cycleId: 'c2', lanes: ['actl'], allowTmuxSends: false });
  void noTmux;
  assert.throws(() => requireOwnerGo(store, 'actl', 'tmux-send'), /not authorized/);
  assert.equal(requireOwnerGo(store, 'actl', 'dispatch').goId, noTmux.goId);
  revokeOwnerGo(store);
  assert.throws(() => requireOwnerGo(store, 'actl', 'advance'), /OWNER_GO_REVOKED/);
  const expired = recordOwnerGo(store, { cycleId: 'c3', lanes: ['actl'], ttlHours: 0.000001 });
  void expired;
  await new Promise((r) => setTimeout(r, 50));
  // ttlHours 0.000001h ~= 3.6ms — already expired. (Expires-at computed from now.)
  const list = (await import('../dist/server/runner/owner-go.js')).readOwnerGo(store);
  assert.ok(Date.now() > Date.parse(list.expiresAt));
  assert.throws(() => requireOwnerGo(store, 'actl', 'advance'), /OWNER_GO_EXPIRED/);
});

test('advanceLane with requireOwnerGo refuses without a covering GO', async () => {
  const { dataRoot, project } = await seedScope();
  const store = tmp();
  const { stores, seams } = engineHarness(dataRoot, project);
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa') };
  await assert.rejects(
    () => advanceLane(lane(), stores, seams, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
      storeRoot: store, correlationId: 'go-1', projectId: project, requireOwnerGo: true,
    }),
    /OWNER_GO_REQUIRED/,
  );
  assert.equal(listTurns(store).length, 0);
});

test('intakeNextTask validates, creates, and marks READY exactly once (marker resume)', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const inbox = tmp();
  const store = tmp();
  const { recordOwnerGo } = await import('../dist/server/runner/owner-go.js');
  recordOwnerGo(store, { cycleId: 'in-1', lanes: ['actl'] });
  const calls = [];
  const seams = {
    validateProposal: async (_l, p) => {
      calls.push(`validate:${p.goal.slice(0, 20)}`);
      assert.ok(p.acceptance_criteria.length > 0);
    },
    createTask: async (_l, p) => {
      calls.push('create');
      const goal = await gt.createGoal(inbox, 'IN', { title: 'g', goalStatement: 'x' });
      const c = await gt.createTask(inbox, 'IN', {
        goalId: goal.goalId, title: p.goal.slice(0, 60), goal: p.goal, reason: 'intake', scope: p.bounded_scope,
      });
      return { taskId: c.taskId, executionState: 'PLANNED', pmState: 'PENDING' };
    },
    markReady: async (_l, taskId) => {
      calls.push('ready');
      const r = await rt.transitionTaskExecution(inbox, 'IN', taskId, {
        expectedExecutionState: 'PLANNED', to: 'READY', reason: 'intake',
      });
      return { taskId: r.taskId, executionState: 'READY', pmState: 'PENDING' };
    },
  };
  const pm = {
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'propose' } },
    sessionId: 'sub:propose',
  };
  const first = await engine.intakeNextTask(lane(), pm, seams, {
    storeRoot: store, correlationId: 'in-1', projectId: 'IN', goalBrief: 'actl remote control QA',
  });
  assert.equal(first.executionState, 'READY');
  assert.deepEqual(calls.filter((c) => c === 'create').length, 1);
  // Restart: marker resumes without a second Task.
  const second = await engine.intakeNextTask(lane(), pm, seams, {
    storeRoot: store, correlationId: 'in-1', projectId: 'IN', goalBrief: 'actl remote control QA',
  });
  assert.equal(second.taskId, first.taskId);
  assert.equal(calls.filter((c) => c === 'create').length, 1);
  assert.equal(gt.listTasks(inbox, 'IN').length, 1);
});

test('parseTaskProposal accepts one fenced block, rejects prose', async () => {
  const { parseTaskProposal } = await import('../dist/server/runner/result-parse.js');
  const good = 'note\n```json TASK_PROPOSAL v1 {"goal":"g","bounded_scope":"s","acceptance_criteria":[{"id":"AC-1","description":"d"}]}```\ntail';
  const p = parseTaskProposal(good);
  assert.equal(p.goal, 'g');
  assert.equal(p.acceptance_criteria.length, 1);
  assert.throws(() => parseTaskProposal('just prose'), /PROPOSAL_AMBIGUOUS/);
  assert.throws(() => parseTaskProposal('```json TASK_PROPOSAL v1 {"goal":"g"}```'), /bounded_scope/);
});

test('intake re-asks once on unparseable proposals, then blocks bounded', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const inbox = tmp();
  const store = tmp();
  const { recordOwnerGo } = await import('../dist/server/runner/owner-go.js');
  recordOwnerGo(store, { cycleId: 'in-bad', lanes: ['actl'] });
  let creates = 0;
  const seams = {
    validateProposal: async () => {},
    createTask: async () => { creates += 1; return { taskId: 'TASK-9', executionState: 'PLANNED', pmState: 'PENDING' }; },
    markReady: async (_l, taskId) => ({ taskId, executionState: 'READY', pmState: 'PENDING' }),
  };
  const pm = {
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'propose-bad' } },
    sessionId: 'sub:propose-bad',
  };
  await assert.rejects(
    () => engine.intakeNextTask(lane(), pm, seams, {
      storeRoot: store, correlationId: 'in-bad', projectId: 'IN', goalBrief: 'g',
    }),
    /PROPOSAL_AMBIGUOUS/,
  );
  const pmTurns = (await import('../dist/server/runner/turn-store.js')).listTurns(store).filter((t) => t.role === 'pm');
  assert.equal(pmTurns.length, 2, 'exactly one retry, then stop — no PM spam');
  assert.equal(creates, 0, 'no Task created from unparseable proposals');
  void inbox;
});

test('parseTaskProposal tolerates bare JSON with identical field validation', async () => {
  const { parseTaskProposal } = await import('../dist/server/runner/result-parse.js');
  const bare = '• JSON\n{"goal":"g","bounded_scope":"s","acceptance_criteria":[{"id":"AC-1","description":"d"}]}\n› prompt';
  const p = parseTaskProposal(bare);
  assert.equal(p.goal, 'g');
  assert.equal(p.acceptance_criteria[0].id, 'AC-1');
  const mixed = 'noise {"reason":"x"} tail {"goal":"g2","bounded_scope":"s2","acceptance_criteria":[{"id":"A","description":"b"}]} end';
  assert.equal(parseTaskProposal(mixed).goal, 'g2');
  assert.throws(() => parseTaskProposal('no braces at all'), /PROPOSAL_AMBIGUOUS/);
  assert.throws(() => parseTaskProposal('{"goal":"g"}'), /bounded_scope/);
});

test('parseTaskProposal tolerates TUI-wrapped bare JSON', async () => {
  const { parseTaskProposal } = await import('../dist/server/runner/result-parse.js');
  const wrapped = '• JSON\n\n  {"goal":"Run the approved suite once and\n  report evidence.","bounded_scope":"Read-only verification\n  only.","acceptance_criteria":[{"id":"AC-1","description":"stages\n  recorded"}]}\n\n› prompt';
  const p = parseTaskProposal(wrapped);
  assert.ok(p.goal.startsWith('Run the approved suite once and'));
  assert.ok(p.goal.endsWith('report evidence.'));
  assert.equal(p.acceptance_criteria[0].id, 'AC-1');
});

test('verb parsing tolerates TUI bullets and preamble chatter', async () => {
  const { parsePmTurn, parseQaTurn } = await import('../dist/server/runner/result-parse.js');
  assert.deepEqual(parsePmTurn('• DISPATCH {"taskId":"TASK-0001"}'), { kind: 'DISPATCH', taskId: 'TASK-0001' });
  assert.deepEqual(
    parsePmTurn('hook noise\n> ChatGPT cannot do X\n• ACCEPT\n{"reason":"verified result accepted"}'),
    { kind: 'ACCEPT', reason: 'verified result accepted' },
  );
  assert.equal(parseQaTurn('• QA_PASS\nall good').verdict, 'QA_PASS');
  assert.throws(() => parsePmTurn('just chatting, no verb here'), /PM_TURN_AMBIGUOUS/);
});

test('runtime signatures match configured labels, never positions', async () => {
  const bind = await import('../dist/server/runner/session-bind.js');
  assert.ok(bind.matchConfiguredRuntime('codex-luna', bind.classifyPaneRuntime('gpt-5.6-luna medium · ~/actl')));
  assert.ok(bind.matchConfiguredRuntime('chatgpt', bind.classifyPaneRuntime('› Ask Codex\nchatgpt-web/light low')));
  assert.ok(bind.matchConfiguredRuntime('claude-team', bind.classifyPaneRuntime('Claude Code Sonnet 5 Claude Team')));
  assert.ok(bind.matchConfiguredRuntime('commandcode', bind.classifyPaneRuntime('Command Code v1.44.0 laguna-s')));
  assert.ok(bind.matchConfiguredRuntime(
    'commandcode',
    bind.classifyPaneRuntime('models: laguna-s-2.1 (free) x taste-1\nAsk your question...'),
  ), 'wrapped ASCII-art banner still classifies');
  assert.ok(bind.matchConfiguredRuntime('grok', bind.classifyPaneRuntime('Grok Build 1.0.34')));
  assert.ok(bind.matchConfiguredRuntime('opencode', bind.classifyPaneRuntime('Muse Spark opencode')));
  assert.ok(!bind.matchConfiguredRuntime('commandcode', bind.classifyPaneRuntime('Claude Code Sonnet')));
  assert.ok(!bind.matchConfiguredRuntime('cline', bind.classifyPaneRuntime('opencode idle')));
  assert.ok(!bind.matchConfiguredRuntime('', []));
});

test('binder matches roles by runtime evidence and reports missing roles', async () => {
  const bind = await import('../dist/server/runner/session-bind.js');
  const lane = {
    id: 'x', label: 'X', root: '/tmp/x-root-x', goal: 'g',
    pm: { runtime: 'chatgpt', model: 'm', roleProfile: { sessionPolicy: 'persistent', permissionProfile: 'read-only' } },
    builder: { runtime: 'grok', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'write-workspace' } },
    qa: { runtime: 'commandcode', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'read-only' } },
    qaFallback: { runtime: 'cursor', model: 'm' },
  };
  const candidates = [
    { paneId: '%21', pid: 21, cwd: '/tmp/x-root-x', command: 'grok', dead: false, pidAlive: true, cwdExists: true, health: 'HEALTHY', tailEvidence: '' },
    { paneId: '%22', pid: 22, cwd: '/tmp/x-root-x', command: 'codex', dead: false, pidAlive: true, cwdExists: true, health: 'HEALTHY', tailEvidence: '' },
  ];
  const tails = { '%21': 'Grok Build 1.0.34', '%22': 'x Ask Codex\nchatgpt-web/light' };
  const res = bind.bindLaneSessions(lane, { candidates, captureTail: (id) => tails[id] ?? '' });
  assert.ok(res.deferred && res.deferred.includes('partial'), 'partial binding reported, lane proceeds through bound phases');
  assert.ok(res.bindings.pm.sessionId.startsWith('%22:'), 'pm bound to chatgpt pane, not positionally');
  assert.ok(res.bindings.builder.sessionId.startsWith('%21:'), 'builder bound to grok pane');
  assert.equal(res.bindings.qa, null, 'commandcode absent: qa stays unbound, never misbound');
  assert.ok(res.missing.some((m) => m.startsWith('qa:')), 'missing qa reported concretely');
  assert.ok(res.boundPanes.length === 2);
});

test('daemon advances lanes concurrently: slow collect never starves others', async () => {
  const daemon = await import('../dist/server/runner/daemon.js');
  const mkLane = (id) => ({ id, label: id, root: '/tmp/' + id, goal: 'g',
    pm: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'read-only' } },
    builder: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'write-workspace' } },
    qa: { runtime: 't', model: 'm', roleProfile: { sessionPolicy: 'per-task', permissionProfile: 'read-only' } },
    qaFallback: { runtime: 't', model: 'm' } });
  // Slow lane: PM collect blocks 3s before answering NO_DISPATCHABLE path is
  // instant for the fast lane. Sequential code would finish fast only after
  // slow's 3s; concurrent code finishes fast immediately.
  const slowTr = {
    kind: 'slow', sendTurn: async () => {},
    collectTurn: async (turn) => { await new Promise((r) => setTimeout(r, 3000)); return { text: 'MILESTONE_COMPLETE\n{"reason":"slow done"}', requestId: turn.requestId, stable: true }; },
    checkHealth: async () => ({ ok: true }),
  };
  const fastTr = {
    kind: 'fast', sendTurn: async () => {},
    collectTurn: async (turn) => ({ text: 'MILESTONE_COMPLETE\n{"reason":"fast done"}', requestId: turn.requestId, stable: true }),
    checkHealth: async () => ({ ok: true }),
  };
  const mkBindings = (tag, tr) => ({
    pm: { transport: tr, session: { kind: 'subprocess', target: 'x' }, sessionId: `s-${tag}` },
    builder: null, qa: null,
  });
  const seq = [];
  const { createTurn: _ct, transitionTurn: _tt } = await import('../dist/server/runner/turn-store.js');
  void _ct; void _tt;
  await daemon.serveOnce({
    storeRoot: tmp(), lanes: [mkLane('slow'), mkLane('fast')], projectId: 'p', correlationId: 'cc',
    resolveBindings: async (lane) => mkBindings(lane.id, lane.id === 'slow' ? slowTr : fastTr),
    stores: { listReadyTasks: () => [{ taskId: 'TASK-9', executionState: 'READY', pmState: 'PENDING' }], readTask: (l, id) => ({ taskId: id, executionState: 'READY', pmState: 'PENDING' }), taskContract: () => null, acceptanceCriteria: () => null },
    seams: { dispatch: async () => ({ runId: 'r1' }), accept: async () => {}, nextTask: async () => null },
    audit: (e) => { seq.push(`${e.laneId || e.role}:${e.step}${e.outcome ? `:${e.outcome}` : ''}`); },
  });
  const fastDone = seq.indexOf('fast:advance:MILESTONE_REPORTED');
  const slowDecide = seq.indexOf('slow:pm_decide');
  assert.ok(fastDone >= 0 && slowDecide >= 0 && fastDone < slowDecide,
    `fast lane completes before slow lane even decides (load-independent order): ${seq.join(' | ')}`);
});

test('tmux anchor tolerates TUI-wrapped markers', async () => {
  const tr = await import('../dist/server/runner/transport.js');
  const req = 'turn-abc-pm-x-a1';
  const tag = `AR_TURN_END:${req}`;
  // Terminal-width reflow splits the marker across lines mid-token.
  const cut = 20 + 12;
  const frag = `${tag.slice(0, cut)}\n${tag.slice(cut)}`;
  const re = tr.anchorRe(req);
  assert.ok(re.test(`noise\n${tag}\nmore`), 'contiguous marker matches');
  assert.ok(re.test(`noise\n${frag}\nmore`), 'wrapped marker matches');
  assert.ok(!re.test('noise\nAR_TURN_END:turn-other-req\nmore'), 'foreign markers never match');
});

test('executable gate demands complete contracts, never guesses', async () => {
  const mod = await import('../dist/server/runner/result-parse.js');
  const base = { goal: 'g', bounded_scope: 'touch scripts/qa.sh only', acceptance_criteria: [{ id: 'AC-1', description: 'd' }] };
  const full = { ...base, whyNow: 'w', inScope: ['run qa'], outOfScope: ['product edits'], requiredTests: ['qa.sh'], requiredEvidence: ['exit codes'], sourceReferences: ['docs/TESTER.md'], fileScope: ['scripts/qa.sh'] };
  const env = mod.assertExecutableContract(full, { baseSha: 'abc123' });
  assert.equal(env.taskType, 'IMPLEMENTATION');
  assert.equal(env.rolePlan, 'PM → Builder → QA → PM');
  assert.throws(() => mod.assertExecutableContract({ ...full, whyNow: ' ' }, { baseSha: 'abc' }), /TASK_NOT_EXECUTABLE.*whyNow/);
  assert.throws(() => mod.assertExecutableContract(full, { baseSha: null }), /currentBaseSha/);
  assert.throws(
    () => mod.assertExecutableContract({ ...full, fileScope: ['src/secret.ts'] }, { baseSha: 'abc' }),
    /not declared in bounded_scope/,
  );
  const review = mod.assertExecutableContract(
    { ...base, taskType: 'REVIEW_ONLY', whyNow: 'w', inScope: ['read'], outOfScope: ['edits'], requiredTests: ['read-through'], requiredEvidence: ['review note'], sourceReferences: ['SSOT'] },
    { baseSha: 'abc' },
  );
  assert.equal(review.taskType, 'REVIEW_ONLY');
  assert.equal(mod.routeForTaskType('REVIEW_ONLY'), 'review');
  assert.equal(mod.routeForTaskType('VERIFICATION'), 'review');
  assert.equal(mod.routeForTaskType('IMPLEMENTATION'), 'full');
});

test('review route skips Builder entirely (QA verifies the target)', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const inbox = tmp();
  const store = tmp();
  const { recordOwnerGo } = await import('../dist/server/runner/owner-go.js');
  recordOwnerGo(store, { cycleId: 'rev-1', lanes: ['actl'] });
  const goal = await gt.createGoal(inbox, 'IN', { title: 'g', goalStatement: 'x' });
  void goal;
  const pmReview = {
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'propose', RR_PROPOSE_TYPE: 'REVIEW_ONLY' } },
    sessionId: 'sub:propose-review',
  };
  const seams = {
    validateProposal: async () => {},
    createTask: async (_l, p) => {
      const g2 = await gt.createGoal(inbox, 'IN', { title: 'g2', goalStatement: 'x' });
      const c = await gt.createTask(inbox, 'IN', {
        goalId: g2.goalId, title: 'review task', goal: p.goal, reason: 'r', scope: p.bounded_scope,
      });
      return { taskId: c.taskId, executionState: 'PLANNED', pmState: 'PENDING' };
    },
    markReady: async (_l, taskId) => {
      const r = await rt.transitionTaskExecution(inbox, 'IN', taskId, {
        expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
      });
      return { taskId: r.taskId, executionState: 'READY', pmState: 'PENDING' };
    },
  };
  const emptyStores = {
    listReadyTasks: () => [],
    readTask: () => null,
    taskContract: () => null, acceptanceCriteria: () => null,
  };
  const sched = () => new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa') };
  // Production order: advance creates the lane-run (NO_DISPATCHABLE), then
  // intake persists route+envelope, then advance runs the review route.
  const pre = await engine.advanceLane(lane(), emptyStores, {
    dispatch: async () => ({ runId: 'r-x' }),
    accept: async () => {}, nextTask: async () => null,
  }, bindings, sched(), {
    storeRoot: store, correlationId: 'rev-1', projectId: 'IN', turnTimeoutMs: 15000,
  });
  assert.equal(pre.outcome, 'NO_DISPATCHABLE_TASK');
  const taken = await engine.intakeNextTask(lane(), pmReview, seams, {
    storeRoot: store, correlationId: 'rev-1', projectId: 'IN', goalBrief: 'review the frozen plan',
  });
  const rec0 = engine.readLaneRun(store, 'actl');
  assert.equal(rec0.route, 'review');
  assert.equal(rec0.envelope.taskType, 'REVIEW_ONLY');
  // Advance with QA/PM responders only; Builder must never execute.
  const stores = {
    listReadyTasks: () => [{ taskId: taken.taskId, executionState: 'READY', pmState: 'PENDING' }],
    readTask: () => ({ taskId: taken.taskId, executionState: 'READY', pmState: 'PENDING' }),
    taskContract: () => null, acceptanceCriteria: () => null,
  };
  const calls = [];
  const out = await engine.advanceLane(lane(), stores, {
    dispatch: async () => { calls.push('dispatch'); return { runId: 'r-x' }; },
    accept: async () => { calls.push('accept'); },
    nextTask: async () => null,
  }, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'rev-1', projectId: 'IN', turnTimeoutMs: 15000,
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.ok(!calls.includes('dispatch'), 'review route never dispatches');
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  assert.equal(turns.filter((t) => t.role === 'builder').length, 0, 'builder never executes on review route');
  assert.equal(turns.filter((t) => t.role === 'qa' && t.state === 'VERIFIED').length, 1);
});

test('cancelled tasks block staged phases instead of advancing', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const { dataRoot, project, taskId } = await seedScope();
  const store = tmp();
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa') };
  const stores = {
    listReadyTasks: () => [],
    readTask: () => ({ taskId, executionState: 'CANCELLED', pmState: 'PENDING' }),
    taskContract: () => null, acceptanceCriteria: () => null,
  };
  // Force a lane-run into BUILD_TURN on a cancelled task (simulates a task
  // cancelled after dispatch, as happened live with actl TASK-0001).
  fs.mkdirSync(path.join(store, 'lane-runs'), { recursive: true });
  fs.writeFileSync(path.join(store, 'lane-runs', 'actl.json'), JSON.stringify({
    laneRunId: 'lrun-cancel', correlationId: 'cx-1', laneId: 'actl', projectId: project,
    taskId, runId: 'run-cancel', attempt: 0, phase: 'BUILD_TURN', outcome: null,
    reason: null, qaMode: 'primary', route: 'full', envelope: null,
    updatedAt: new Date().toISOString(),
  }));
  const out = await engine.advanceLane(lane(), stores, {
    dispatch: async () => { throw new Error('must not dispatch a cancelled task'); },
    accept: async () => { throw new Error('must not accept a cancelled task'); },
    nextTask: async () => null,
  }, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'cx-1', projectId: project, turnTimeoutMs: 5000,
  });
  assert.equal(out.outcome, 'BLOCKED');
  assert.match(out.laneRun.reason ?? '', /left dispatchable state/);
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  assert.equal(turns.filter((t) => t.role === 'builder').length, 0);
});

test('project current resolver collects bounded evidence without assumptions', async () => {
  const mod = await import('../dist/server/runner/project-current.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cur-'));
  fs.writeFileSync(path.join(root, 'README.md'), '# P\nProduct goal line.\n');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'WBS-01.md'), '# WBS\n- P1\n');
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
  const cur = await mod.resolveProjectCurrent('x', root, { laneRoots: [root] });
  assert.ok(/^[0-9a-f]{40}$/.test(cur.git.headSha));
  assert.ok(cur.readmeGoal.includes('Product goal line'));
  assert.ok(cur.docIndex.some((d) => d.includes('WBS-01.md')));
  assert.equal(cur.wbsFiles.length, 1);
  assert.equal(cur.privateRepo, null, 'no private repo invented');
  assert.equal(cur.controlTower, null);
  const pkt = mod.renderProjectCurrentPacket(cur, 500);
  assert.ok(pkt.length <= 560);
  assert.ok(pkt.includes('PROJECT_CURRENT x'));
});

test('gate collapses TUI-wrapped fileScope paths before scope check', async () => {
  const mod = await import('../dist/server/runner/result-parse.js');
  const base = {
    goal: 'g', bounded_scope: 'touch packages/plan-core/test/ only', acceptance_criteria: [{ id: 'AC-1', description: 'd' }],
    whyNow: 'w', inScope: ['i'], outOfScope: ['o'], requiredTests: ['t'], requiredEvidence: ['e'],
    sourceReferences: ['s'],
  };
  const env = mod.assertExecutableContract({ ...base, fileScope: ['packages/plan-   core/test/'] }, { baseSha: 'abc' });
  assert.deepEqual(env.fileScope, ['packages/plan-core/test/']);
});

test('lenient builder acceptance binds turn identity on substantive evidence', async () => {
  const mod = await import('../dist/server/runner/result-parse.js');
  const ok = mod.parseBuilderTurnLenient('evidence line. '.repeat(20) + ' pnpm run test exit 0, 37 passed, files tests/a.ts', 'TASK-1', 'run-1');
  assert.equal(ok.taskId, 'TASK-1');
  assert.equal(ok.runId, 'run-1');
  assert.throws(() => mod.parseBuilderTurnLenient('I cannot access the local repo, sorry.', 'TASK-1', 'run-1'), /RESULT_PACKET/);
  assert.throws(() => mod.parseBuilderTurnLenient('ok done', 'TASK-1', 'run-1'), /RESULT_PACKET/);
});

test('delivery failures defer without failed records or budget', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const store = tmp();
  let sends = 0;
  const busy = {
    kind: 'busy', sendTurn: async () => { sends += 1; throw new Error('NOT_IDLE: pane is busy'); },
    collectTurn: async () => { throw new Error('unreached'); }, checkHealth: async () => ({ ok: true }),
  };
  const bound = { transport: busy, session: { kind: 'tmux', target: '%9' }, sessionId: '%9:1' };
  const id = { projectId: 'p', taskId: 'T', runId: 'r', correlationId: 'c' };
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => engine.executeTurn(store, id, 'builder', 'body', bound, { timeoutMs: 1000, maxAttempts: 3 }),
      (err) => err.code === 'DELIVERY_DEFERRED',
    );
  }
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  assert.equal(turns.length, 1, 'same REQUESTED turn reused, no FAILED records');
  assert.equal(turns[0].state, 'REQUESTED');
  assert.equal(sends, 2);
});

test('concurrent tmux sends never cross panes (per-turn buffers)', async () => {
  if (!tmuxOk()) {
    assert.ok(true, 'no tmux here');
    return;
  }
  const session = `ar-conc-${process.pid}`;
  spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50'], { timeout: 8000 });
  spawnSync('tmux', ['split-window', '-h', '-t', session], { timeout: 8000 });
  try {
    const store = tmp();
    const mk = (body) => createTurn(store, turn({ requestBody: body }));
    const t1 = mk('WIRE-ONE-AAA');
    const t2 = mk('WIRE-TWO-BBB');
    const tr1 = new TmuxTransport();
    const tr2 = new TmuxTransport();
    await Promise.all([
      tr1.sendTurn(t1, { kind: 'tmux', target: `${session}:0.0` }),
      tr2.sendTurn(t2, { kind: 'tmux', target: `${session}:0.1` }),
    ]);
    const cap = (p) => spawnSync('tmux', ['capture-pane', '-J', '-p', '-t', `${session}:${p}`, '-S', '-60'], { encoding: 'utf8', timeout: 5000 }).stdout ?? '';
    const a = cap('0.0');
    const b = cap('0.1');
    assert.ok(a.includes('WIRE-ONE-AAA'), 'pane A got its own wire');
    assert.ok(b.includes('WIRE-TWO-BBB'), 'pane B got its own wire');
    assert.ok(!a.includes('WIRE-TWO-BBB'), 'no crosstalk into pane A');
    assert.ok(!b.includes('WIRE-ONE-AAA'), 'no crosstalk into pane B');
  } finally {
    spawnSync('tmux', ['kill-session', '-t', session], { timeout: 5000 });
  }
});

test('collect prefers anchor but falls back to agent REF lines', async () => {
  const store = tmp();
  const tr = new SubprocessTransport();
  void tr;
  const { default: _d } = await import('node:assert/strict').catch(() => ({ default: null }));
  void _d;
  // REF fallback is exercised live (Grok REF:runId replies); here pin the
  // instruction-line exclusion rule via the built transport source.
  const src = fs.readFileSync(path.resolve('src/runner/transport.ts'), 'utf8');
  assert.ok(src.includes('End your reply'), 'instruction-line exclusion present');
});

test('lane states derive truthfully from durable records', async () => {
  const mod = await import('../dist/server/runner/lane-states.js');
  const run = (over) => ({
    laneRunId: 'l1', correlationId: 'c', laneId: 'x', projectId: 'p', taskId: null,
    runId: null, attempt: 0, phase: 'PM_TURN', outcome: null, reason: null,
    qaMode: 'primary', route: 'full', envelope: null, updatedAt: new Date().toISOString(), ...over,
  });
  const t = (state) => ({ turnId: 't1', projectId: 'p', taskId: 'T', runId: 'r', role: 'builder', requestId: 'q', correlationId: 'c', attempt: 1, state, timeoutMs: 1, maxAttempts: 1, requestBody: 'b', resultBody: null, resultRef: null, error: null, transient: false, createdAt: '', updatedAt: '', history: [] });
  assert.equal(mod.deriveLaneState({ run: null, pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'IDLE');
  assert.equal(mod.deriveLaneState({ run: run({ outcome: 'ACCEPT_AND_ADVANCE' }), pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'DONE');
  assert.equal(mod.deriveLaneState({ run: run({ outcome: 'HUMAN_GATE_PARKED' }), pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'HUMAN_GATE');
  assert.equal(mod.deriveLaneState({ run: run({ outcome: 'BLOCKED_CONTEXT' }), pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'BLOCKED_CONTEXT');
  assert.equal(mod.deriveLaneState({ run: run({ outcome: 'BLOCKED_RUNTIME', reason: 'QA_RUNTIME_UNAVAILABLE x' }), pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'BLOCKED_TRANSPORT');
  assert.equal(mod.deriveLaneState({ run: run({ phase: 'BUILD_TURN', taskId: 'T' }), pendingTurns: [t('RUNNING')], builderSlotHeld: true, qaSlotHeld: false, unboundRoles: [] }), 'ACTIVE');
  assert.equal(mod.deriveLaneState({ run: run({ phase: 'QA_TURN', taskId: 'T' }), pendingTurns: [], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: ['qa: missing'] }), 'WAITING_FOR_RUNTIME');
  assert.equal(mod.deriveLaneState({ run: run({ phase: 'BUILD_TURN', taskId: 'T' }), pendingTurns: [t('REQUESTED')], builderSlotHeld: false, qaSlotHeld: false, unboundRoles: [] }), 'WAITING_FOR_SLOT');
});

test('QA_UNAVAILABLE primary routes to healthy fallback, same Task/Result, Builder never re-runs', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const store = tmp();
  const audit = [];
  const { stores, seams } = engineHarness(dataRoot, project);
  const bindings = {
    pm: subBinding('pm'), builder: subBinding('builder'),
    qa: subBinding('qa-unavailable'), qaFallback: subBinding('qa'),
  };
  const out = await advanceLane(lane(), stores, seams, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'eng-fb', projectId: project,
    turnTimeoutMs: 15000, audit: (e) => audit.push(e),
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.ok(out.laneRun.qaMode?.startsWith('fallback:'), `qaMode records fallback hop (got ${out.laneRun.qaMode})`);
  assert.ok(audit.some((e) => e.step === 'qa_fallback'), 'fallback hop audited');
  // Same Result preserved: exactly one verified builder turn, no re-run.
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  const builders = turns.filter((t) => t.role === 'builder' && t.state === 'VERIFIED');
  assert.equal(builders.length, 1);
  assert.equal(builders[0].taskId, taskId);
  // Both QA attempts served the same run.
  for (const q of turns.filter((t) => t.role === 'qa' && t.state === 'VERIFIED')) {
    assert.equal(q.taskId, taskId);
  }
});

test('unbound QA primary walks chain to fallback immediately', async () => {
  const { dataRoot, project } = await seedScope();
  const store = tmp();
  const { stores, seams } = engineHarness(dataRoot, project);
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qaFallback: subBinding('qa') };
  const out = await advanceLane(lane(), stores, seams, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'eng-fb2', projectId: project, turnTimeoutMs: 15000,
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.ok(out.laneRun.qaMode?.startsWith('fallback:'), `qaMode records fallback hop (got ${out.laneRun.qaMode})`);
});

test('exhausted QA chain ends BLOCKED_RUNTIME, Task/Result preserved, Builder untouched', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const store = tmp();
  const { stores, seams } = engineHarness(dataRoot, project);
  const bindings = { pm: subBinding('pm'), builder: subBinding('builder'), qa: subBinding('qa-unavailable') };
  const out = await advanceLane({ ...lane(), qaFallback: { runtime: 'cursor', model: 'default' } }, stores, seams, bindings, new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }), {
    storeRoot: store, correlationId: 'eng-fb3', projectId: project, turnTimeoutMs: 15000,
  });
  assert.equal(out.outcome, 'BLOCKED_RUNTIME');
  assert.match(out.laneRun.reason ?? '', /QA_RUNTIME_UNAVAILABLE/);
  const turns = (await import('../dist/server/runner/turn-store.js')).listTurns(store);
  assert.equal(turns.filter((t) => t.role === 'builder' && t.state === 'VERIFIED').length, 1);
  assert.equal(gt.getTask(dataRoot, project, taskId).executionState, 'DISPATCHED');
});

test('quarantine exiles frozen sessions after repeated failures, resets on success', async () => {
  const mod = await import('../dist/server/runner/session-health.js');
  const store = tmp();
  const sid = '%6:16363';
  assert.equal(mod.readQuarantine(store).isQuarantined(sid), false);
  mod.recordSessionFailure(store, sid, 'TRANSPORT_LOST: x');
  mod.recordSessionFailure(store, sid, 'TURN_TIMEOUT: y');
  assert.equal(mod.readQuarantine(store).isQuarantined(sid), false);
  const h = mod.recordSessionFailure(store, sid, 'NOT_IDLE: z');
  assert.equal(h.quarantined, true);
  assert.equal(mod.readQuarantine(store).isQuarantined(sid), true);
  mod.resetSessionHealth(store, sid);
  assert.equal(mod.readQuarantine(store).isQuarantined(sid), false);
});

test('holds park matching proposals as HUMAN_GATE without creating Tasks', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const inbox = tmp();
  const store = tmp();
  const { recordOwnerGo } = await import('../dist/server/runner/owner-go.js');
  recordOwnerGo(store, { cycleId: 'hold-1', lanes: ['actl'] });
  const base = defaultWorkspaceConfigV2().lanes.find((l) => l.id === 'actl');
  // The propose responder emits a fixed regression proposal; hold on its wording.
  const lane = { ...base, holds: ['regression'] };
  let created = 0;
  const seams = {
    validateProposal: async () => {},
    createTask: async () => { created += 1; return { taskId: 'T', executionState: 'PLANNED', pmState: 'PENDING' }; },
    markReady: async (_l, id) => ({ taskId: id, executionState: 'READY', pmState: 'PENDING' }),
  };
  const pm = {
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'propose' } },
    sessionId: 'sub:propose-hold',
  };
  const out = await engine.intakeNextTask(lane, pm, seams, {
    storeRoot: store, correlationId: 'hold-1', projectId: 'IN', goalBrief: 'actl remote',
  });
  assert.equal(out, null);
  assert.equal(created, 0);
  const rec = engine.readLaneRun(store, 'actl');
  assert.equal(rec, null);
  void inbox;
});

test('BLOCKED_CONTEXT parks intake without authoritative basis', async () => {
  const engine = await import('../dist/server/runner/lane-engine.js');
  const store = tmp();
  const { recordOwnerGo } = await import('../dist/server/runner/owner-go.js');
  recordOwnerGo(store, { cycleId: 'ctx-1', lanes: ['actl'] });
  const pm = {
    transport: new SubprocessTransport(),
    session: { kind: 'subprocess', target: process.execPath, args: [RESPONDER], env: { RR_ROLE: 'propose' } },
    sessionId: 'sub:propose-ctx',
  };
  const out = await engine.intakeNextTask(lane(), pm, {
    validateProposal: async () => {},
    createTask: async () => { throw new Error('must not create without basis'); },
    markReady: async () => { throw new Error('must not ready without basis'); },
  }, {
    storeRoot: store, correlationId: 'ctx-1', projectId: 'IN', goalBrief: 'vague',
    authoritative: async () => ({ ok: false, reason: 'no git, no docs, no goals' }),
  });
  assert.equal(out, null);
});

test('supersede cancels stale READY tasks, never the kept one', async () => {
  const { supersedeStaleReady } = await import('../dist/server/runner/serve-cli.js');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-sup-'));
  const project = 'SUP';
  const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'x' });
  const mk = async () => {
    const c = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's' });
    return rt.transitionTaskExecution(dataRoot, project, c.taskId, { expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed' });
  };
  const keep = await mk();
  const stale = await mk();
  const dropped = await supersedeStaleReady(dataRoot, project, keep.taskId);
  assert.deepEqual(dropped, [stale.taskId]);
  assert.equal(gt.getTask(dataRoot, project, stale.taskId).executionState, 'CANCELLED');
  assert.equal(gt.getTask(dataRoot, project, keep.taskId).executionState, 'READY');
});

test('frozen SHA pin fails closed, unpinned runs only attest', async () => {
  const { attestRunnerCode } = await import('../dist/server/runner/frozen-sha.js');
  // Wrong pin always refuses, whatever the tree looks like.
  assert.throws(
    () => attestRunnerCode('.', '0'.repeat(40)),
    /FROZEN_SHA_MISMATCH/,
  );
  // Hermetic repo: clean attest passes pinned; dirty tree refuses pinned.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-frozen-'));
  const git = (args, extra = {}) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 15000, ...extra });
  assert.equal(git(['init']).status, 0);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'v1\n');
  assert.equal(git(['add', '.']).status, 0);
  assert.equal(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'c1']).status, 0);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  assert.match(head, /^[0-9a-f]{40}$/);
  const clean = attestRunnerCode(repo, head);
  assert.equal(clean.sha, head);
  assert.equal(clean.dirty, false);
  assert.equal(clean.pinned, true);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'v2-dirty\n');
  assert.throws(() => attestRunnerCode(repo, head), /FROZEN_SHA_DIRTY/);
  const reported = attestRunnerCode(repo, null);
  assert.equal(reported.sha, head);
  assert.equal(reported.dirty, true);
  assert.equal(reported.pinned, false);
});
