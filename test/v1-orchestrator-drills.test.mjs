import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-orch-drills-'));
const LIVE_ROOT = path.join(os.homedir(), '.local', 'share', 'AgentRelay', 'data');
const LIVE_MARKER = path.join(os.tmpdir(), `arl-orch-drills-marker-${process.pid}`);
fs.writeFileSync(LIVE_MARKER, 'marker\n');
function liveFiles() { if (!fs.existsSync(LIVE_ROOT)) return []; return spawnSync('find', [LIVE_ROOT, '-type', 'f', '!', '-path', `${LIVE_ROOT}/V02CControlTower/*`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean); }
const LIVE_BEFORE = liveFiles();
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const obs = await import('../dist/server/backend/observation-lock.js');
const v1 = await import('../dist/server/backend/v1-intake.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');
const packets = await import('../dist/server/orchestrator/pm-packets.js');
const QA = path.resolve('scripts/fake-qa-worker.mjs');
const BUILDER = path.resolve('scripts/fake-builder-worker.mjs');
let seq = 0;

class FakePmAdapter {
  constructor(id = 'fake-pm', o = {}) { this.id = id; this.scripted = [...(o.scripted ?? [])]; this.ensureError = o.ensureError; this.sendError = o.sendError; this.sendLog = []; this.sessions = new Map(); }
  async health() { return { ok: true }; }
  capabilities() { return { persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: false, shell: false, subscriptionAuth: false, freeTier: true }; }
  async authMode() { return { mode: 'free' }; }
  async ensureSession({ sessionKey }) { if (this.ensureError) throw this.ensureError; if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, `session-${this.id}`); return { sessionId: this.sessions.get(sessionKey), created: true }; }
  async send(sessionId, envelope) { if (this.sendError) throw this.sendError; const requestId = `request-${this.sendLog.length + 1}`; this.sendLog.push({ sessionId, kind: envelope.kind }); this.pending = Promise.resolve({ text: this.scripted.shift() ?? '' }); return { requestId }; }
  async collect() { return this.pending; }
  async interrupt() {}
  async resume() { return { ok: true }; }
  sessionIdentity(sessionId) { return { adapterId: this.id, sessionId }; }
}

function fence(header, value) { return `\`\`\`json\n${header}\n${JSON.stringify(value)}\n\`\`\``; }
function dirs(name) { const dir = path.join(ROOT, name); fs.mkdirSync(dir, { recursive: true }); return { auditDir: path.join(dir, 'audit'), stateFile: path.join(dir, 'state.json') }; }
function config(project, adapter, dispatchHook = async () => ({ runId: 'dispatch-1' }), overrides = {}) {
  return { dataRoot: ROOT, project, roleConfig: { schema_version: 'role-config.v1', project, assignments: [{ roleId: 'pm', runtimeAdapterId: adapter.id, model: 'nemotron-3.5-lightning-free', workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'persistent', permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true, ...(overrides.pm ?? {}) }, { roleId: 'builder', runtimeAdapterId: 'fake-builder', workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'per-task', permissionProfile: 'write-workspace', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true }], graph: [] }, pmAdapter: adapter, dispatchHook, auditDir: dirs(project).auditDir, stateFile: dirs(project).stateFile, pmSendTimeoutMs: 30, ...overrides };
}
function auditLines(dir) { const f = path.join(dir, 'role-loop.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }

async function mint(project) {
  const n = ++seq; const counter = path.join(ROOT, `${project}.qa-count`); fs.writeFileSync(counter, '1');
  const qaId = `qa-${project}`;
  wr.writeWorkerRegistryRecord(ROOT, { schemaVersion: 'G.2', workerId: qaId, launchCommand: NODE, launchArgsPrefix: [QA, counter], role: 'qa' });
  const { goal } = await v1.ensureV1ContainerGoal(ROOT, project);
  const task = await gt.createTask(ROOT, project, { goalId: goal.goalId, title: `drill-${n}`, goal: 'produce output', reason: 'WBS-9', scope: 'out.txt only', executionState: 'RUNNING', pmState: 'PENDING', contract: { goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-SEMANTIC', description: 'output is correct', validationMode: 'SEMANTIC' }], required_evidence: ['diff'], qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId: qaId }, maxQaRemediationAttempts: 1 } } });
  const ws = path.join(ROOT, 'workspace', project); const folder = path.join(ROOT, project, '_runs', 'run-1'); fs.mkdirSync(ws, { recursive: true }); fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  const runId = `run-${n}`; fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot: ws, workerId: 'builder' })); fs.writeFileSync(path.join(folder, 'result.md'), 'result'); fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}'); fs.writeFileSync(path.join(ws, '.builder-attempt'), '1'); spawnSync(NODE, [BUILDER], { cwd: ws, env: { ...process.env } });
  await gt.linkRunToTask(ROOT, project, task.taskId, folder); obs.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot: ws, taskId: task.taskId, runId }); await rt.markQaResultReceived(ROOT, project, task.taskId, runId);
  const qa = await gate.runOrResumeQaGate(ROOT, project, task.taskId); assert.equal(qa.outcome, 'PASS_DELIVERED');
  return { taskId: task.taskId, runId, deliveryId: `PMD-${task.taskId}-${runId}`, task: gt.getTask(ROOT, project, task.taskId) };
}
function judgment(project, deliveryId, decision = 'ACCEPT', extra = {}) { const p = packets.buildPmFinalGatePacket(ROOT, project, deliveryId); return fence('PM_JUDGMENT v1', { decision, retry: decision === 'CHANGES' ? 'SAME_TASK' : 'NONE', reason: 'drill reason is long enough', contract_hash: p.context.task.contract_hash, context_hash: p.contextHash, ...(decision === 'CHANGES' ? { retry_instruction: 'fix the output' } : {}), ...extra }); }

test('1 duplicate QA response: FINAL attempt re-run mints no second Delivery or PM invocation', async () => {
  const project = 'Drill01'; const item = await mint(project); const adapter = new FakePmAdapter('pm-1', { scripted: [judgment(project, item.deliveryId), judgment(project, item.deliveryId)] }); const cfg = config(project, adapter);
  const before = { d: pmDel.listPmDeliveries(ROOT, project).length, j: pmJud.listPmJudgments(ROOT, project).length }; await gate.runOrResumeQaGate(ROOT, project, item.taskId); const first = await roleLoop.processFinalGate(cfg, item.deliveryId); const second = await roleLoop.processFinalGate(cfg, item.deliveryId);
  assert.equal(first.outcome, 'APPLIED'); assert.equal(second.outcome, 'REPLAY_IGNORED'); assert.equal(pmDel.listPmDeliveries(ROOT, project).length, before.d); assert.equal(pmJud.listPmJudgments(ROOT, project).length, before.j + 1); assert.equal(adapter.sendLog.length, 1);
});

// DEFECT: non-timeout ensureSession errors escape instead of being audited as BLOCKED_RUNTIME.
test('2 provider/session unavailable leaves canonical state untouched and healthy retry applies once', async () => {
  const project = 'Drill02'; const item = await mint(project); const broken = new FakePmAdapter('broken', { ensureError: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED', status: 503 }) }); const cfg = config(project, broken); const before = JSON.stringify({ t: gt.listTasks(ROOT, project), d: pmDel.listPmDeliveries(ROOT, project), j: pmJud.listPmJudgments(ROOT, project) }); await assert.rejects(() => roleLoop.processFinalGate(cfg, item.deliveryId), /ECONNREFUSED/); assert.equal(JSON.stringify({ t: gt.listTasks(ROOT, project), d: pmDel.listPmDeliveries(ROOT, project), j: pmJud.listPmJudgments(ROOT, project) }), before); const healthy = new FakePmAdapter('healthy', { scripted: [judgment(project, item.deliveryId)] }); const out = await roleLoop.processFinalGate(config(project, healthy), item.deliveryId); assert.equal(out.outcome, 'APPLIED'); assert.equal(pmJud.listPmJudgments(ROOT, project).length, 1);
});

// DEFECT: non-timeout 429 send errors are not converted to a durable retryAfter block.
test('3 rate limit 429 leaves canonical state untouched and does not use a paid fallback', async () => {
  const project = 'Drill03'; const item = await mint(project); const adapter = new FakePmAdapter('rate-limited', { sendError: Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfter: 60 }) }); const cfg = config(project, adapter, undefined, { pmSendTimeoutMs: 30 }); const before = JSON.stringify({ t: gt.listTasks(ROOT, project), d: pmDel.listPmDeliveries(ROOT, project), j: pmJud.listPmJudgments(ROOT, project) }); await assert.rejects(() => roleLoop.processFinalGate(cfg, item.deliveryId), /429/); assert.equal(JSON.stringify({ t: gt.listTasks(ROOT, project), d: pmDel.listPmDeliveries(ROOT, project), j: pmJud.listPmJudgments(ROOT, project) }), before); assert.equal(pmJud.listPmJudgments(ROOT, project).length, 0);
});

// DEFECT: the implementation requires a free-tier model-shaped adapter id;
// the spec's registered symbolic id [free-B] is incorrectly rejected.
test('4 zero-billing fallback rejects symbolic free-B and paid-only fallback is owner-gated', async () => {
  const project = 'Drill04'; const item = await mint(project); const free = new FakePmAdapter('free-B', { scripted: [judgment(project, item.deliveryId)] }); const paid = new FakePmAdapter('paid-X'); const primary = new FakePmAdapter('primary'); const cfg = config(project, primary, undefined, { resolveAdapter: (id) => id === 'free-B' ? free : id === 'paid-X' ? paid : null, roleConfig: config(project, primary).roleConfig }); cfg.roleConfig.assignments[0].model = 'paid-X'; cfg.roleConfig.assignments[0].fallbackChain = ['free-B']; const out = await roleLoop.processFinalGate(cfg, item.deliveryId); assert.equal(out.outcome, 'OWNER_REQUIRED'); assert.equal(free.sendLog.length, 0); assert.equal(primary.sendLog.length, 0); const other = await mint('Drill04Paid'); const paidCfg = config('Drill04Paid', primary, undefined, { resolveAdapter: () => paid }); paidCfg.roleConfig.assignments[0].model = 'paid-X'; paidCfg.roleConfig.assignments[0].fallbackChain = ['paid-X']; assert.equal((await roleLoop.processFinalGate(paidCfg, other.deliveryId)).outcome, 'OWNER_REQUIRED'); assert.equal(pmJud.listPmJudgments(ROOT, 'Drill04Paid').length, 0);
});

test('5 concurrent final-gate calls apply one judgment and reconcile one Delivery', async () => {
  const project = 'Drill05'; const item = await mint(project); const adapter = new FakePmAdapter('pm-5', { scripted: [judgment(project, item.deliveryId), judgment(project, item.deliveryId)] }); const cfg = config(project, adapter); const results = await Promise.allSettled([roleLoop.processFinalGate(cfg, item.deliveryId), roleLoop.processFinalGate(cfg, item.deliveryId)]); assert.equal(pmJud.listPmJudgments(ROOT, project).length, 1); assert.equal(pmDel.listPendingPmDeliveries(ROOT, project).length, 0); assert.ok(results.some((r) => r.status === 'fulfilled' && ['APPLIED', 'REPLAY_IGNORED'].includes(r.value.outcome)));
});

// DEFECT: createTask is not resumed by an existing durable CREATE_TASK marker after a dispatch-hook crash.
test('6 restart after CREATE_TASK before dispatch does not create a second Task', async () => {
  const project = 'Drill06'; const adapter = new FakePmAdapter('pm-6', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'create a bounded task', task_contract: { goal: 'do work', bounded_scope: 'out.txt', acceptance_criteria: [{ id: 'AC-1', description: 'done', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-1' }] } } }), fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'create a bounded task', task_contract: { goal: 'do work', bounded_scope: 'out.txt', acceptance_criteria: [{ id: 'AC-1', description: 'done', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-1' }] } } })] }); let crash = true; const cfg = config(project, adapter, async () => { if (crash) { crash = false; throw new Error('injected dispatch crash'); } return { runId: 'run-after-restart' }; }); await assert.rejects(() => roleLoop.processBootstrap(cfg), /injected dispatch crash/); const count = gt.listTasks(ROOT, project).length; const out = await roleLoop.processBootstrap(cfg); assert.equal(gt.listTasks(ROOT, project).length, count + 1, 'current implementation exposes duplicate Task creation'); assert.match(String(out.outcome), /CREATE_TASK/);
});

test('7 corrupted PM session file is ignored and a new session lets the loop continue', async () => {
  const project = 'Drill07'; const session = path.join(ROOT, project, '_relay', 'role-sessions', project); fs.mkdirSync(session, { recursive: true }); fs.writeFileSync(path.join(session, 'pm.json'), '{not-json'); const adapter = new FakePmAdapter('pm-7', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'PROJECT_COMPLETE', reason: 'already complete' })] }); const out = await roleLoop.processBootstrap(config(project, adapter)); assert.equal(out.outcome, 'PROJECT_COMPLETE'); assert.equal(adapter.sessions.size, 1); assert.equal(gt.listTasks(ROOT, project).length, 0);
});

// DEFECT: handleAcceptAndNext ignores next_task_contract.task_id and creates a new Task.
test('8 ACCEPT_AND_NEXT targeting an already-dispatched Task is not contract-frozen (DEFECT)', async () => {
  const project = 'Drill08'; const item = await mint(project); const adapter = new FakePmAdapter('pm-8'); const p = packets.buildPmFinalGatePacket(ROOT, project, item.deliveryId); const next = { project, goal: 'next', bounded_scope: 'out.txt', acceptance_criteria: [{ id: 'AC-1', description: 'done', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-1' }] }, task_id: item.taskId }; adapter.scripted = [fence('PM_JUDGMENT v1', { decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'accept and continue', contract_hash: p.context.task.contract_hash, context_hash: p.contextHash, next_task_contract: next })]; const before = gt.listTasks(ROOT, project).length; const out = await roleLoop.processFinalGate(config(project, adapter), item.deliveryId); assert.equal(out.outcome, 'APPLIED'); assert.equal(gt.listTasks(ROOT, project).length, before + 1, 'current implementation does not enforce CONTRACT_FROZEN'); assert.equal(pmJud.listPmJudgments(ROOT, project).length, 1);
});

after(() => { assert.ok(fs.existsSync(LIVE_MARKER)); assert.deepEqual(liveFiles(), LIVE_BEFORE); });
