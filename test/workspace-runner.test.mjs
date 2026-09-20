import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultWorkspaceConfigV2,
  loadEffectiveConfig,
  migrateV1ToV2,
  splitRuntimeLabel,
  validateWorkspaceConfigV2,
  writeWorkspaceConfigV2,
} from '../dist/server/workspace/config-v2.js';
import { defaultWorkspaceManifest } from '../dist/server/workspace/manifest.js';
import {
  assertQaIndependent,
  buildVerificationPacket,
  validateQaVerdict,
} from '../dist/server/workspace/verification-packet.js';
import { LaneScheduler } from '../dist/server/workspace/scheduler.js';
import { runProjectLane, formatHandoffMarker, isCurrentCycleMarker, assertLaneBinding } from '../dist/server/workspace/lane-runner.js';
import {
  laneFieldDescriptors,
  workspaceFieldDescriptors,
} from '../dist/server/workspace/schema.js';
import { runLaneDryRun } from '../dist/server/workspace/run-cli.js';

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');

function noPaneNumbers(value) {
  assert.ok(!/%\d+/.test(JSON.stringify(value)), 'no pane numbers in config');
}

// ── v2 schema: runtime/model separation ─────────────────────────────────────

test('v2 defaults separate runtime from model/profile with zero pane numbers', () => {
  const c = defaultWorkspaceConfigV2();
  assert.equal(c.schemaVersion, 'workspace.v2');
  assert.equal(c.lanes.length, 4);
  noPaneNumbers(c);
  const actl = c.lanes.find((l) => l.id === 'actl');
  assert.equal(actl.builder.runtime, 'codex');
  assert.equal(actl.builder.model, 'luna');
  assert.notEqual(actl.builder.runtime, actl.builder.model);
  assert.equal(actl.qaFallback.runtime, 'cursor');
  const juplan = c.lanes.find((l) => l.id === 'juplan');
  assert.equal(juplan.qa.runtime, 'claude');
  assert.equal(juplan.qa.model, 'team');
  validateWorkspaceConfigV2(c);
});

test('combined labels split explicitly; unknown labels pass through with default model', () => {
  assert.deepEqual(splitRuntimeLabel('codex-luna'), { runtime: 'codex', model: 'luna' });
  assert.deepEqual(splitRuntimeLabel('claude-team'), { runtime: 'claude', model: 'team' });
  assert.deepEqual(splitRuntimeLabel('opencode'), { runtime: 'opencode', model: 'default' });
});

test('v2 validation rejects pane numbers, empty runtimes, and bad caps', () => {
  const c = defaultWorkspaceConfigV2();
  const bad = JSON.parse(JSON.stringify(c));
  bad.lanes[0].builder.runtime = '%1';
  assert.throws(() => validateWorkspaceConfigV2(bad), /pane number/);
  const bad2 = JSON.parse(JSON.stringify(c));
  bad2.lanes[1].qa.model = '  ';
  assert.throws(() => validateWorkspaceConfigV2(bad2), /model required/);
  const bad3 = JSON.parse(JSON.stringify(c));
  bad3.concurrency.maxActiveQa = 0;
  assert.throws(() => validateWorkspaceConfigV2(bad3), />= 1/);
});

test('v1 migrates to v2 preserving roots/goals with separated bindings', () => {
  const v1 = defaultWorkspaceManifest();
  const v2 = migrateV1ToV2(v1);
  assert.equal(v2.lanes.length, v1.lanes.length);
  v2.lanes.forEach((lane, i) => {
    assert.equal(lane.root, v1.lanes[i].root);
    assert.equal(lane.goal, v1.lanes[i].goal);
  });
  const actl = v2.lanes.find((l) => l.id === 'actl');
  assert.deepEqual([actl.builder.runtime, actl.builder.model], ['codex', 'luna']);
  validateWorkspaceConfigV2(v2);
});

test('effective config migrates a legacy v1 file on disk', () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-v2mig-'));
  fs.mkdirSync(path.join(host, '.agent-relay'), { recursive: true });
  fs.writeFileSync(
    path.join(host, '.agent-relay', 'workspace.json'),
    JSON.stringify(defaultWorkspaceManifest()),
  );
  const { config, migrated, created } = loadEffectiveConfig(host);
  assert.equal(migrated, true);
  assert.equal(created, false);
  assert.equal(config.schemaVersion, 'workspace.v2');
  assert.ok(fs.existsSync(path.join(host, '.agent-relay', 'workspace-config.json')));
});

// ── scheduler ───────────────────────────────────────────────────────────────

test('scheduler caps builders and QA, parks only the gated lane', () => {
  const s = new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  assert.equal(s.acquire('a', 'builder'), true);
  assert.equal(s.acquire('b', 'builder'), true);
  assert.equal(s.acquire('c', 'builder'), false);
  assert.equal(s.acquire('a', 'qa'), true);
  assert.equal(s.acquire('b', 'qa'), false);
  s.release('a', 'builder');
  assert.equal(s.acquire('c', 'builder'), true);
  s.park('c');
  assert.equal(s.acquire('c', 'builder'), false);
  assert.equal(s.isParked('c'), true);
  // Other lanes continue while one is parked.
  assert.equal(s.acquire('a', 'builder'), true);
  const snap = s.snapshot();
  assert.deepEqual(snap.parked, ['c']);
});

// ── verification packet ─────────────────────────────────────────────────────

function packet(over = {}) {
  return buildVerificationPacket({
    laneId: 'actl',
    project: 'actl',
    projectRoot: '/tmp/actl',
    taskId: 'TASK-0001',
    attempt: 1,
    runId: 'run-1',
    taskContract: { id: 'c' },
    acceptanceCriteria: ['ac-1'],
    builderResult: 'RESULT_PACKET body',
    commands: ['npm test'],
    tests: ['t1'],
    knownRisks: ['r1'],
    builderSessionId: 'b:1',
    qaSessionId: 'q:1',
    ...over,
  });
}

test('packet independence guard refuses Builder self-certification', () => {
  assert.throws(() => assertQaIndependent(packet({ qaSessionId: 'b:1' })), /QA_NOT_INDEPENDENT/);
  assert.throws(() => assertQaIndependent(packet({ qaSessionId: ' ' })), /QA_NOT_INDEPENDENT/);
  assert.equal(assertQaIndependent(packet()).taskId, 'TASK-0001');
});

test('QA_CHANGES needs findings; QA_UNAVAILABLE needs a configured cause', () => {
  const p = packet();
  assert.throws(
    () => validateQaVerdict(p, { verdict: 'QA_CHANGES', reason: 'bad' }),
    /concrete findings/,
  );
  assert.throws(
    () => validateQaVerdict(p, { verdict: 'QA_UNAVAILABLE', reason: 'x', unavailabilityCause: 'aliens' }),
    /five configured causes/,
  );
  const ok = validateQaVerdict(p, { verdict: 'QA_UNAVAILABLE', reason: 'limited', unavailabilityCause: 'rate limit' });
  assert.equal(ok.verdict, 'QA_UNAVAILABLE');
});

// ── lane runner (scratch canonical scope, scripted seams) ───────────────────

async function seedScope() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-lane-'));
  const project = 'CERT';
  const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'cert fixture' });
  const created = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's',
  });
  const ready = await rt.transitionTaskExecution(dataRoot, project, created.taskId, {
    expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
  });
  return { dataRoot, project, taskId: ready.taskId };
}

function lane(id = 'actl') {
  return defaultWorkspaceConfigV2().lanes.find((l) => l.id === id);
}

function storeFor(dataRoot, project) {
  return {
    listReadyTasks: () => gt.listTasks(dataRoot, project)
      .filter((t) => t.executionState === 'READY')
      .map((t) => ({ taskId: t.taskId, executionState: t.executionState, pmState: t.pmState })),
    readTask: (_l, taskId) => {
      try {
        const t = gt.getTask(dataRoot, project, taskId);
        return { taskId: t.taskId, executionState: t.executionState, pmState: t.pmState };
      } catch { return null; }
    },
  };
}

function seams(script, calls) {
  let qaCalls = 0;
  const taskId = calls.taskId;
  return {
    pmDecide: async ({ task, packet: p, qaVerdict }) => {
      calls.push(`pm:${task ? task.taskId : 'none'}:${p ? 'packet' : 'no-packet'}:${qaVerdict ? qaVerdict.verdict : 'no-qa'}`);
      if (!task) return { kind: 'DISPATCH', taskId, reason: 'script' };
      if (p && qaVerdict?.verdict === 'QA_PASS') return { kind: 'ACCEPT', reason: 'script accept' };
      return { kind: 'REQUEST_CHANGES', changes: 'script rework', reason: 'script' };
    },
    dispatch: async (_l, task) => { calls.push(`dispatch:${task.taskId}`); return { runId: `run-${calls.filter((c) => typeof c === 'string' && c.startsWith('dispatch')).length}` }; },
    builderExecute: async (_l, task, attempt, changes) => {
      calls.push(`build:${task.taskId}:${attempt}:${changes ?? 'fresh'}`);
      return {
        taskId: task.taskId,
        runId: `run-${calls.filter((c) => typeof c === 'string' && c.startsWith('dispatch')).length}`,
        resultPacket: `RESULT attempt=${attempt}`, commands: ['npm test'], tests: ['t'], knownRisks: [],
      };
    },
    qaVerify: async (p) => {
      qaCalls += 1;
      calls.push(`qa:${p.taskId}:${p.runId}:${p.qaSessionId}`);
      if (script === 'changes' && qaCalls === 1) {
        return { verdict: 'QA_CHANGES', reason: 'gap', findings: ['missing log line'] };
      }
      return { verdict: 'QA_PASS', reason: 'verified' };
    },
    accept: async (_l, task, runId) => { calls.push(`accept:${task.taskId}:${runId}`); },
    nextTask: async () => null,
    detectQaRuntime: () => ({ installed: true }),
    audit: (e) => calls.push(e),
  };
}

function sessions() {
  return { builderSessionId: 'b:1', qaSessionId: 'q:1' };
}

test('runner dry ACCEPT chain: same task, one dispatch, zero founder relay', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const audit = [];
  const s = seams('accept', calls);
  const auditPush = s.audit;
  s.audit = (e) => { audit.push(e); auditPush(e); };
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(out.taskId, taskId);
  assert.equal(out.attempts, 1);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  const steps = audit.map((e) => e.step);
  for (const need of ['lane_start', 'sessions_bound', 'slot_acquired', 'dispatched', 'builder_result', 'qa_verdict', 'accepted']) {
    assert.ok(steps.includes(need), `audit has ${need}`);
  }
  assert.ok(calls.includes(`accept:${taskId}:run-1`));
});

test('runner QA_CHANGES reworks the SAME task with findings as changes', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const audit = [];
  const s = seams('changes', calls);
  s.audit = (e) => audit.push(e);
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(out.attempts, 2);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  assert.ok(calls.includes(`build:${taskId}:1:fresh`));
  const rework = calls.find((c) => typeof c === 'string' && c.startsWith(`build:${taskId}:2:`));
  assert.ok(rework && rework.includes('missing log line'), 'findings relayed to Builder, same Task identity');
});

test('runner QA fallback preserves Task/Result and re-routes only QA', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const seen = [];
  const s = seams('accept', calls);
  let first = true;
  const innerQa = s.qaVerify;
  s.qaVerify = async (p) => {
    seen.push({ taskId: p.taskId, runId: p.runId, result: p.builderResult, qa: p.qaSessionId });
    if (first) {
      first = false;
      return { verdict: 'QA_UNAVAILABLE', reason: 'limited', unavailabilityCause: 'rate limit' };
    }
    return innerQa(p);
  };
  s.detectQaRuntime = (runtime) => {
    assert.equal(runtime, 'cursor');
    return { installed: true, version: 'cursor-test' };
  };
  s.audit = () => {};
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(out.qaMode, 'fallback:cursor');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].taskId, seen[0].taskId);
  assert.equal(seen[1].runId, seen[0].runId);
  assert.equal(seen[1].result, seen[0].result);
  assert.notEqual(seen[1].qa, seen[0].qa);
});

test('runner fallback-missing blocks with Task/Result preserved, no Builder re-run', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const s = seams('accept', calls);
  s.qaVerify = async () => ({ verdict: 'QA_UNAVAILABLE', reason: 'down', unavailabilityCause: 'auth unavailable' });
  s.detectQaRuntime = () => ({ installed: false });
  s.audit = () => {};
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'BLOCKED');
  assert.match(out.reason, /QA_RUNTIME_UNAVAILABLE/);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  assert.equal(calls.filter((c) => typeof c === 'string' && c.startsWith('build:')).length, 1);
});

test('runner HUMAN_GATE parks only that lane; siblings continue', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const sched = new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const mkCalls = () => { const c = []; c.taskId = taskId; return c; };
  const gateSeams = (calls) => {
    const s = seams('accept', calls);
    s.pmDecide = async () => ({ kind: 'HUMAN_GATE', reason: 'owner checkpoint' });
    s.audit = () => {};
    return s;
  };
  const out = await runProjectLane(lane('actl'), storeFor(dataRoot, project), gateSeams(mkCalls()), {
    scheduler: sched, sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'HUMAN_GATE_PARKED');
  assert.equal(sched.isParked('actl'), true);
  assert.equal(sched.acquire('juplan', 'builder'), true);
});

test('runner refuses stale sessions, terminal re-dispatch, and missing tasks', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const mk = () => { const c = []; c.taskId = taskId; const s = seams('accept', c); s.audit = () => {}; return { c, s }; };
  const sched = () => new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  // Stale: shared session.
  {
    const { s } = mk();
    const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
      scheduler: sched(), sessions: { builderSessionId: 'x', qaSessionId: 'x' }, mode: 'dry-run',
    });
    assert.equal(out.outcome, 'BLOCKED');
    assert.match(out.reason, /QA_NOT_INDEPENDENT/);
  }
  // Missing task id from PM.
  {
    const { c, s } = mk();
    s.pmDecide = async () => ({ kind: 'DISPATCH', taskId: 'TASK-9999' });
    const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
      scheduler: sched(), sessions: sessions(), mode: 'dry-run',
    });
    assert.equal(out.outcome, 'BLOCKED');
    assert.match(out.reason, /existing READY/);
    assert.equal(c.filter((x) => typeof x === 'string' && x.startsWith('dispatch')).length, 0);
  }
  // Canonical duplicate protection is real (scratch store, real API).
  {
    await rt.transitionTaskExecution(dataRoot, project, taskId, {
      expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'first',
    });
    await assert.rejects(
      () => rt.transitionTaskExecution(dataRoot, project, taskId, {
        expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'second',
      }),
      /CONFLICT/,
    );
  }
});

test('schema descriptors cover every GUI-editable lane field', () => {
  const keys = new Set(laneFieldDescriptors().map((d) => d.key));
  for (const k of ['id', 'label', 'root', 'goal', 'pm.runtime', 'pm.model', 'builder.runtime', 'builder.model',
    'qa.runtime', 'qa.model', 'pm.roleProfile.sessionPolicy', 'qaFallback.runtime', 'qaFallback.model',
    'concurrency.maxBuilders', 'concurrency.maxQa']) {
    assert.ok(keys.has(k), `descriptor for ${k}`);
  }
  const wk = new Set(workspaceFieldDescriptors().map((d) => d.key));
  assert.ok(wk.has('concurrency.maxActiveBuilders') && wk.has('concurrency.maxActiveQa'));
});

test('dry-run CLI vehicle reaches ACCEPT with audit trail', async () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-runcli-'));
  const res = await runLaneDryRun(host, 'actl', { script: 'accept' });
  assert.equal(res.outcome.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(res.outcome.attempts, 1);
  assert.ok(fs.existsSync(res.auditFile));
  const steps = res.audit.map((e) => e.step);
  assert.ok(steps.includes('accepted'));
});

test('builder task identity mismatch blocks the lane (taskId + runId asserted)', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const s = seams('accept', calls);
  s.builderExecute = async (_l, task, attempt) => ({
    taskId: 'TASK-9999', runId: 'run-1', resultPacket: 'rogue', commands: [], tests: [], knownRisks: [],
  });
  s.audit = () => {};
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(out.outcome, 'BLOCKED');
  assert.match(out.reason, /builder identity mismatch/);
  assert.match(out.reason, new RegExp(taskId));
});

test('cross-lane isolation: lane A context/task/result never enters lane B packet/dispatch', async () => {
  const mk = async (id, decoys = 0) => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `ar-x-${id}-`));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ar-xroot-${id}-`));
    const project = `X-${id}`;
    const goal = await gt.createGoal(dataRoot, project, { title: 'g', goalStatement: 'x' });
    for (let d = 0; d < decoys; d += 1) {
      await gt.createTask(dataRoot, project, {
        goalId: goal.goalId, title: `decoy-${d}`, goal: 'g', reason: 'r', scope: 's',
      });
    }
    const created = await gt.createTask(dataRoot, project, {
      goalId: goal.goalId, title: 't', goal: 'g', reason: 'r', scope: 's',
    });
    const ready = await rt.transitionTaskExecution(dataRoot, project, created.taskId, {
      expectedExecutionState: 'PLANNED', to: 'READY', reason: 'seed',
    });
    return { dataRoot, project, root, taskId: ready.taskId };
  };
  const a = await mk('a');
  const b = await mk('b', 1); // decoy => READY task is TASK-0002, distinct from A's TASK-0001
  assert.notEqual(a.taskId, b.taskId);
  const laneA = { ...lane('actl'), id: 'lane-a', root: a.root };
  const laneB = { ...lane('juplan'), id: 'lane-b', root: b.root };
  const seen = [];
  const mkSeams = (scope, taskId) => {
    const s = seams('accept', Object.assign([], { taskId }));
    const baseDispatch = s.dispatch;
    s.dispatch = async (l, task) => {
      seen.push({ kind: 'dispatch', lane: l.id, root: l.root, task: task.taskId });
      return baseDispatch(l, task);
    };
    const baseQa = s.qaVerify;
    s.qaVerify = async (p) => {
      seen.push({ kind: 'qa', lane: p.laneId, root: p.projectRoot, task: p.taskId, result: p.builderResult });
      return baseQa(p);
    };
    s.audit = () => {};
    return s;
  };
  const sched = new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 });
  const outA = await runProjectLane(laneA, storeFor(a.dataRoot, a.project), mkSeams(a, a.taskId), {
    scheduler: sched, sessions: sessions(), mode: 'dry-run',
  });
  const outB = await runProjectLane(laneB, storeFor(b.dataRoot, b.project), mkSeams(b, b.taskId), {
    scheduler: sched, sessions: sessions(), mode: 'dry-run',
  });
  assert.equal(outA.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(outB.outcome, 'ACCEPT_AND_ADVANCE');
  for (const e of seen) {
    if (e.lane === 'lane-a') {
      assert.equal(e.task, a.taskId);
      assert.equal(e.root, a.root);
    } else {
      assert.equal(e.task, b.taskId);
      assert.equal(e.root, b.root);
    }
  }
  assert.ok(!seen.some((e) => e.lane === 'lane-b' && (e.task === a.taskId || e.root === a.root)));
  assert.ok(!seen.some((e) => e.lane === 'lane-a' && (e.task === b.taskId || e.root === b.root)));
  // Lane-binding guard rejects a foreign packet at unit level too.
  const foreign = buildVerificationPacket({
    laneId: 'lane-a', project: 'lane-a', projectRoot: a.root, taskId: a.taskId, attempt: 1,
    runId: 'run-1', taskContract: null, acceptanceCriteria: null, builderResult: 'R',
    commands: [], tests: [], knownRisks: [], builderSessionId: 'b', qaSessionId: 'q',
  });
  assert.throws(() => assertLaneBinding(foreign, laneB), /LANE_BINDING_MISMATCH/);
  assert.equal(assertLaneBinding(foreign, laneA).laneId, 'lane-a');
});

test('handoff markers correlate to one request only (bare history never matches)', () => {
  const cycle = 'runner-fix-1789871385';
  assert.equal(formatHandoffMarker('QA', cycle), 'AR_RUNNER_QA_DONE:runner-fix-1789871385');
  assert.throws(() => formatHandoffMarker('PM', '  '), /correlation id/);
  const history = 'AR_RUNNER_QA_DONE\nAR_RUNNER_PM_DONE\nAR_RUNNER_BUILDER_DONE';
  assert.equal(isCurrentCycleMarker(history, 'QA', cycle), false);
  assert.equal(isCurrentCycleMarker(history, 'QA', 'runner-fix-0000000000'), false);
  const current = `noise\nAR_RUNNER_QA_DONE:${cycle}   \nmore`;
  assert.equal(isCurrentCycleMarker(current, 'QA', cycle), true);
  assert.equal(isCurrentCycleMarker(current, 'PM', cycle), false);
});

test('live bind failure is a labeled safe stop, never packaged as a pass', async () => {
  const { runLaneLive } = await import('../dist/server/workspace/run-cli.js');
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-livesafe-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-lonelyroot-'));
  const base = lane('actl');
  writeWorkspaceConfigV2(host, {
    schemaVersion: 'workspace.v2',
    concurrency: { maxActiveBuilders: 2, maxActiveQa: 1 },
    lanes: [{ ...base, id: 'lonely', label: 'Lonely', root }],
  });
  const res = await runLaneLive(host, 'lonely', { project: 'NOPE-NO-SUCH-PROJECT' });
  assert.equal(res.outcome.outcome, 'BLOCKED');
  assert.equal(res.safeStop, true);
  assert.equal(res.founderRelayActions, 0);
  assert.notEqual(res.outcome.outcome, 'ACCEPT_AND_ADVANCE');
});

test('runner outcome and audit carry the request correlation id', async () => {
  const { dataRoot, project, taskId } = await seedScope();
  const calls = [];
  calls.taskId = taskId;
  const audit = [];
  const s = seams('accept', calls);
  s.audit = (e) => audit.push(e);
  const out = await runProjectLane(lane(), storeFor(dataRoot, project), s, {
    scheduler: new LaneScheduler({ maxActiveBuilders: 2, maxActiveQa: 1 }),
    sessions: sessions(), mode: 'dry-run', correlationId: 'runner-fix-1789871385',
  });
  assert.equal(out.outcome, 'ACCEPT_AND_ADVANCE');
  assert.equal(out.correlationId, 'runner-fix-1789871385');
  assert.ok(audit.length > 0);
  for (const e of audit) assert.equal(e.correlationId, 'runner-fix-1789871385');
});
