import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultWorkspaceManifest,
  validateWorkspaceManifest,
  writeWorkspaceManifest,
  readWorkspaceManifest,
} from '../dist/server/workspace/manifest.js';
import { probeLanes } from '../dist/server/workspace/probe.js';
import { resolveQaFallback } from '../dist/server/workspace/qa-fallback.js';
import { applyConcurrency } from '../dist/server/workspace/concurrency.js';
import { runWorkspaceStart, runWorkspaceStatus } from '../dist/server/workspace/bootstrap.js';
import { TmuxRoleRuntimeAdapter } from '../dist/server/integrations/tmux/role-runtime-adapter.js';
import {
  readRoleSession,
  writeRoleSession,
} from '../dist/server/integrations/core/role-runtime.js';
import { probeAllPanes } from '../dist/server/workspace/probe.js';

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');

// Minimal PM adapter + role config for processBootstrap DISPATCH-branch tests.
// Isolated tmp dataRoots only — the live canonical store is never touched.
class FakePmAdapter {
  constructor(scripted = []) {
    this.id = 'fake-pm';
    this.scripted = [...scripted];
    this.sessions = new Map();
    this.sendLog = [];
    this.preambleBodies = [];
    this._pendingByRequest = new Map();
  }
  capabilities() {
    return { persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: false, shell: false, subscriptionAuth: false, freeTier: true };
  }
  async ensureSession({ sessionKey }) {
    if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, `ses-${sessionKey}`);
    return { sessionId: this.sessions.get(sessionKey), created: true };
  }
  async send(sessionId, envelope) {
    if (envelope.kind === 'PM_PREAMBLE') {
      this.preambleBodies.push(envelope.body);
      const requestId = `preamble-${sessionId}`;
      this._pendingByRequest.set(requestId, Promise.resolve({ text: '' }));
      return { requestId };
    }
    this.sendLog.push(envelope);
    const requestId = `req-${this.sendLog.length}`;
    this._pendingByRequest.set(requestId, Promise.resolve({ text: this.scripted.length ? this.scripted.shift() : '' }));
    return { requestId };
  }
  async collect(sessionId, requestId) {
    const p = this._pendingByRequest.get(requestId);
    if (!p) throw new Error(`unknown requestId: ${requestId}`);
    return p;
  }
  async interrupt() {}
  async resume() { return { ok: true }; }
  sessionIdentity(sessionId) { return { adapterId: 'fake-pm', sessionId }; }
}

function dispatchAction(taskId) {
  return `DISPATCH\n${JSON.stringify({ taskId })}`;
}

function makeBootstrapCfg(dataRoot, project, adapter, calls) {
  const auditDir = path.join(dataRoot, 'audit');
  const stateFile = path.join(dataRoot, 'state.json');
  return {
    dataRoot,
    project,
    roleConfig: {
      schema_version: 'role-config.v1',
      project,
      assignments: [
        {
          roleId: 'pm', runtimeAdapterId: 'fake-pm', model: 'opencode/nemotron-3.5-lightning-free',
          workspace: { project, workspaceRoot: dataRoot }, sessionPolicy: 'persistent',
          permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true,
          fallbackChain: [], enabled: true,
        },
      ],
      graph: [],
    },
    pmAdapter: adapter,
    resolveAdapter: (id) => (id === 'fake-pm' ? adapter : null),
    dispatchHook: async (dr, proj, task) => { calls.push(task.taskId); return { runId: 'fake-run-1' }; },
    auditDir,
    stateFile,
  };
}

async function seedReadyTask(dataRoot, project, pmState) {
  const goal = await gt.createGoal(dataRoot, project, { title: 'cert goal', goalStatement: 'certification fixture' });
  const created = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 'cert task', goal: 'certify', reason: 'fixture', scope: 'fixture scope',
    ...(pmState ? { pmState } : {}),
  });
  return rt.transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY', reason: 'fixture ready',
  });
}

test('manifest defaults carry 4 lanes with absolute roots and no pane numbers', () => {
  const m = defaultWorkspaceManifest();
  assert.equal(m.schemaVersion, 'workspace.v1');
  assert.equal(m.lanes.length, 4);
  assert.deepEqual(m.lanes.map((l) => l.id), ['agent-relay', 'actl', 'juplan', 'jucontroller']);
  for (const lane of m.lanes) {
    assert.ok(path.isAbsolute(lane.root));
    assert.ok(lane.goal.trim().length > 0);
    for (const v of [lane.root, lane.roles.pm, lane.roles.builder, lane.roles.qa]) {
      assert.ok(!/%\d+/.test(v), `must not hardcode pane numbers: ${v}`);
    }
  }
  assert.equal(m.maxActiveBuilders, 2);
  assert.equal(m.maxActiveQa, 1);
  validateWorkspaceManifest(m);
});

test('manifest rejects pane-number hardcoding', () => {
  const m = defaultWorkspaceManifest();
  m.lanes[0].root = '%0';
  assert.throws(() => validateWorkspaceManifest(m), /pane numbers|absolute/);
});

test('probe reuses healthy panes by cwd prefix, never by pane number config', () => {
  const m = defaultWorkspaceManifest();
  const fakePanes = m.lanes.map((lane, i) => ({
    paneId: `%${90 + i}`,
    pid: 1000 + i,
    cwd: lane.root,
    command: 'bash',
    dead: false,
    pidAlive: true,
    cwdExists: true,
    health: 'HEALTHY',
    tailEvidence: 'idle',
  }));
  const probes = probeLanes(m.lanes, fakePanes);
  assert.equal(probes.length, 4);
  for (const p of probes) assert.equal(p.decision, 'REUSED');
});

test('probe reports SPAWN_REQUIRED only for missing/DEAD lanes', () => {
  const m = defaultWorkspaceManifest();
  const probes = probeLanes(m.lanes, []);
  for (const p of probes) assert.equal(p.decision, 'SPAWN_REQUIRED');
  const dead = m.lanes.map((lane, i) => ({
    paneId: `%${80 + i}`,
    pid: 2000 + i,
    cwd: lane.root,
    command: 'bash',
    dead: true,
    pidAlive: false,
    cwdExists: true,
    health: 'DEAD',
    tailEvidence: '',
  }));
  const probes2 = probeLanes(m.lanes, dead);
  for (const p of probes2) assert.equal(p.decision, 'SPAWN_REQUIRED');
});

test('qa fallback keeps Task/Result and requires real cursor CLI', () => {
  const primary = resolveQaFallback('cline', false, 'cursor', { installed: true });
  assert.equal(primary.kind, 'PRIMARY');
  const fb = resolveQaFallback('cline', true, 'cursor', { installed: true, version: 'v1' });
  assert.equal(fb.kind, 'FALLBACK_CURSOR');
  assert.equal(fb.effectiveQa, 'cursor');
  const missing = resolveQaFallback('cline', true, 'cursor', { installed: false });
  assert.equal(missing.kind, 'QA_RUNTIME_UNAVAILABLE');
});

test('concurrency caps builders<=2 qa<=1, rest WAITING', () => {
  const c = applyConcurrency(['agent-relay', 'actl', 'juplan', 'jucontroller'], 2, 1);
  assert.deepEqual(c.activeBuilders, ['agent-relay', 'actl']);
  assert.deepEqual(c.activeQa, ['agent-relay']);
  assert.equal(c.laneStates['juplan'], 'WAITING');
  assert.equal(c.laneStates['jucontroller'], 'WAITING');
});

test('workspace start writes manifest+state, never dispatches', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-ws-'));
  const laneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-lane-'));
  const m = defaultWorkspaceManifest();
  for (const lane of m.lanes) lane.root = laneRoot;
  writeWorkspaceManifest(tmp, m);
  assert.ok(readWorkspaceManifest(tmp));
  const res = runWorkspaceStart(tmp);
  assert.equal(res.ok, true);
  assert.equal(res.dispatch, 'NOT_DISPATCHED');
  assert.deepEqual(res.spawnedSessions, []);
  assert.ok(fs.existsSync(path.join(tmp, '.agent-relay', 'workspace-state.json')));
  const st = runWorkspaceStatus(tmp);
  assert.equal(st.ok, true);
  assert.equal(st.manifestPresent, true);
});

test('role session persists project+role+runtime+live_session_identity', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-role-session-'));
  const written = writeRoleSession(dataRoot, 'ws', 'pm', {
    adapterId: 'tmux-external',
    sessionId: '%0:4816',
    createdAt: '2026-09-20T00:00:00.000Z',
    lastUsedAt: '2026-09-20T00:00:00.000Z',
    identity: {
      project: 'ws',
      role: 'pm',
      runtime: 'tmux-external',
      liveSessionIdentity: '%0:4816',
    },
  });
  assert.equal(written.identity.project, 'ws');
  assert.equal(written.identity.role, 'pm');
  assert.equal(written.identity.runtime, 'tmux-external');
  assert.equal(written.identity.liveSessionIdentity, '%0:4816');
  const reread = readRoleSession(dataRoot, 'ws', 'pm');
  assert.deepEqual(reread.identity, written.identity);
});

test('tmux adapter rejects stale/unknown session identities as live proof', async () => {
  const adapter = new TmuxRoleRuntimeAdapter({ targets: { pm: '%999999' } });
  // Unknown session carries no identity — never presented as live proof.
  const unknown = adapter.sessionIdentity('%3:604753');
  assert.equal(unknown.adapterId, 'tmux-external');
  assert.equal(unknown.sessionId, '%3:604753');
  assert.equal(unknown.identity, undefined);
  // Stale session ids are rejected, not served.
  await assert.rejects(
    () => adapter.send('%3:604753', { kind: 'PM_BOOTSTRAP', schemaVersion: 'v1', contextHash: 'h', body: 'b' }),
    /SESSION_IDENTITY_MISMATCH/,
  );
  await assert.rejects(
    () => adapter.collect('%3:604753', 'tmux-request-stale', { timeoutMs: 50 }),
    /unknown requestId/,
  );
  assert.deepEqual(await adapter.resume('%8:663844'), { ok: false });
  // Unresolvable targets fail closed instead of binding a phantom session.
  await assert.rejects(
    () => adapter.ensureSession({ roleId: 'pm', project: 'ws', sessionPolicy: 'persistent', sessionKey: 'ws:pm' }),
  );
});

test('DISPATCH with non-canonical id fails closed (no throw, no dispatch, no Task)', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dispatch-failclosed-'));
  const project = 'DispatchFailClosed';
  const calls = [];
  const adapter = new FakePmAdapter([dispatchAction('BOOTSTRAP-LIVE-001')]);
  const out = await roleLoop.processBootstrap(makeBootstrapCfg(dataRoot, project, adapter, calls));
  assert.equal(out.outcome, 'BLOCKED');
  assert.match(out.reason, /unreadable/);
  assert.equal(calls.length, 0);
  assert.equal(gt.listTasks(dataRoot, project).length, 0);
});

test('DISPATCH reuses one existing READY task exactly once (zero duplicate Tasks)', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dispatch-reuse-'));
  const project = 'DispatchReuse';
  const ready = await seedReadyTask(dataRoot, project);
  const calls = [];
  const adapter = new FakePmAdapter([dispatchAction(ready.taskId)]);
  const out = await roleLoop.processBootstrap(makeBootstrapCfg(dataRoot, project, adapter, calls));
  assert.equal(out.outcome, 'DISPATCH');
  assert.equal(out.taskId, ready.taskId);
  assert.deepEqual(calls, [ready.taskId]);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
});

test('DISPATCH refuses ACCEPTED-terminal tasks (canonical ACCEPT finality)', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-dispatch-terminal-'));
  const project = 'DispatchTerminal';
  const ready = await seedReadyTask(dataRoot, project, 'ACCEPTED');
  assert.equal(gt.getTask(dataRoot, project, ready.taskId).pmState, 'ACCEPTED');
  const calls = [];
  const adapter = new FakePmAdapter([dispatchAction(ready.taskId)]);
  const out = await roleLoop.processBootstrap(makeBootstrapCfg(dataRoot, project, adapter, calls));
  assert.equal(out.outcome, 'BLOCKED');
  assert.match(out.reason, /ACCEPTED-terminal/);
  assert.equal(calls.length, 0);
});
test('live probe rediscovers pane_id+pid+cwd+health and drops stale identities', () => {
  const panes = probeAllPanes();
  if (panes.length === 0) {
    assert.deepEqual(panes, [], 'no tmux server here; probe degrades to empty, never to phantom panes');
    return;
  }
  const seenPids = new Set();
  for (const p of panes) {
    assert.ok(p.paneId.startsWith('%'), `pane id shaped like %N (got ${p.paneId})`);
    assert.ok(Number.isInteger(p.pid) && p.pid > 0, `live pid for ${p.paneId}`);
    assert.ok(path.isAbsolute(p.cwd), `absolute cwd for ${p.paneId}`);
    assert.ok(['HEALTHY', 'BUSY', 'DEAD', 'STALE'].includes(p.health), `known health for ${p.paneId}`);
    seenPids.add(p.pid);
  }
  // Stale night-run identities (AGENT_RELAY_FINAL_RESULT.md) must be gone.
  assert.ok(!seenPids.has(604753), 'stale builder pid 663844/604753-era identity absent');
  assert.ok(!seenPids.has(663844), 'stale pm pid absent');
});
