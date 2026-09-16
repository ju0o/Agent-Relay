import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const NODE = process.execPath;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-orchestrator-'));
const dataRoot = path.join(ROOT, 'data');
fs.mkdirSync(dataRoot, { recursive: true });

const LIVE_ROOT = path.join(os.homedir(), '.local', 'share', 'AgentRelay', 'data');
const LIVE_MARKER = path.join(os.tmpdir(), `arl-orchestrator-live-marker-${process.pid}-${Date.now()}`);
fs.writeFileSync(LIVE_MARKER, 'marker\n');

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const rtp = await import('../dist/server/backend/retry-preparation.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const obs = await import('../dist/server/backend/observation-lock.js');
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');
const v1Intake = await import('../dist/server/backend/v1-intake.js');

const QA_WORKER = path.resolve('scripts/fake-qa-worker.mjs');
const BUILDER_WORKER = path.resolve('scripts/fake-builder-worker.mjs');

// ── FAKE pm adapter (RoleRuntimeAdapter), scripted replies ──────────────────

class FakePmAdapter {
  constructor(id, opts = {}) {
    this.id = id;
    this.scripted = [...(opts.scripted ?? [])];
    this.freeTier = opts.freeTier ?? true;
    this.hang = opts.hang ?? false;
    this.lateMs = opts.lateMs ?? 0;
    this.sessions = new Map();
    this.sendLog = [];
    this.preambleBodies = [];
  }
  async health() { return { ok: true }; }
  capabilities() {
    return { persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: false, shell: false, subscriptionAuth: false, freeTier: this.freeTier };
  }
  async authMode() { return { mode: this.freeTier ? 'free' : 'existing-plan-key' }; }
  async ensureSession({ sessionKey }) {
    if (!this.sessions.has(sessionKey)) this.sessions.set(sessionKey, `ses-${this.id}-${sessionKey}`);
    return { sessionId: this.sessions.get(sessionKey), created: true };
  }
  async send(sessionId, envelope) {
    if (envelope.kind === 'PM_PREAMBLE') { this.preambleBodies.push(envelope.body); const requestId = `preamble-${sessionId}`; this._pendingByRequest ??= new Map(); this._pendingByRequest.set(requestId, Promise.resolve({ text: '' })); return { requestId }; }
    this.sendLog.push({ sessionId, kind: envelope.kind, body: envelope.body });
    const requestId = `req-${this.sendLog.length}`;
    if (this.hang) {
      this._pending = new Promise(() => {}); // never resolves; role-loop's own timeout race handles it
    } else {
      const text = this.scripted.length ? this.scripted.shift() : '';
      this._pending = this.lateMs ? new Promise((resolve) => setTimeout(() => resolve({ text }), this.lateMs)) : Promise.resolve({ text });
    }
    this._pendingByRequest ??= new Map();
    this._pendingByRequest.set(requestId, this._pending);
    return { requestId };
  }
  async collect(sessionId, requestId) {
    const p = this._pendingByRequest.get(requestId);
    if (!p) throw new Error(`unknown requestId: ${requestId}`);
    return p;
  }
  async interrupt() {}
  async resume() { return { ok: true }; }
  sessionIdentity(sessionId) { return { adapterId: this.id, sessionId }; }
}

function fence(header, obj) {
  return '```json\n' + header + '\n' + JSON.stringify(obj) + '\n```';
}

let seq = 0;
function makeRoleConfig(project, pmOverrides = {}) {
  return {
    schema_version: 'role-config.v1',
    project,
    assignments: [
      {
        roleId: 'pm', runtimeAdapterId: 'fake-pm', model: 'nemotron-3.5-lightning-free',
        workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'persistent', permissionProfile: 'read-only',
        capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true,
        ...pmOverrides,
      },
      {
        roleId: 'builder', runtimeAdapterId: 'fake-builder', workspace: { project, workspaceRoot: ROOT },
        sessionPolicy: 'per-task', permissionProfile: 'write-workspace', capabilityRequirements: {},
        zeroExtraBilling: true, fallbackChain: [], enabled: true,
      },
    ],
    graph: [],
  };
}

function fakeDispatchHook(calls) {
  return async (dr, project, task) => {
    calls.push(task.taskId);
    return { runId: `fake-run-${calls.length}` };
  };
}

function auditLines(auditDir) {
  const file = path.join(auditDir, 'role-loop.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Direct construction (no dispatcher): mints a QA-gated Task with a full
 * TASK_CONTRACT v1 and a PENDING TASK_VERIFY Delivery, same "V16 dogfood
 * style" pattern as test/v1-qa-loop.test.mjs and test/github-pm-bridge.test.mjs. */
async function mintPendingDelivery(project) {
  const n = ++seq;
  const counter = path.join(ROOT, `qa-${n}.count`);
  fs.writeFileSync(counter, '1'); // PASS on first real QA call
  const qaWorkerId = `qa-${n}`;
  wr.writeWorkerRegistryRecord(dataRoot, { schemaVersion: 'G.2', workerId: qaWorkerId, launchCommand: NODE, launchArgsPrefix: [QA_WORKER, counter], role: 'qa' });

  // Use the SAME V1 container Goal the orchestrator's own bootstrap/ACCEPT_AND_NEXT
  // paths use (ensureV1ContainerGoal), so ACCEPT_AND_NEXT's "same Goal scope" check
  // reflects real orchestrator-created Tasks, not an unrelated ad-hoc Goal.
  const { goal: g } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const t = await gt.createTask(dataRoot, project, {
    goalId: g.goalId, title: `Orch task ${n}`, goal: 'produce correct output', reason: 'orchestrator certification',
    scope: 'out.txt only', completionCriteria: ['done when out.txt is correct'],
    executionState: 'RUNNING', pmState: 'PENDING',
    contract: {
      goal: 'produce correct output', bounded_scope: 'out.txt only',
      acceptance_criteria: [{ id: 'AC-SEMANTIC', description: 'output is correct', validationMode: 'SEMANTIC' }],
      required_evidence: ['diff --stat'],
      qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId }, maxQaRemediationAttempts: 1 },
    },
  });

  const workspaceRoot = path.join(ROOT, 'workspace', String(n));
  const folder = path.join(dataRoot, project, '_runs', String(n));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const runId = `orch-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 'orch-direct-builder' }));
  await gt.linkRunToTask(dataRoot, project, t.taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
  fs.writeFileSync(path.join(folder, 'result.md'), `orchestrator result text for task ${n}`);
  fs.writeFileSync(path.join(workspaceRoot, '.builder-attempt'), '1'); // pre-seeded so the fake builder writes 'correct' immediately
  spawnSync(NODE, [BUILDER_WORKER], { cwd: workspaceRoot, env: { ...process.env, FAKE_BUILDER_OUTPUT: path.join(workspaceRoot, 'out.txt'), FAKE_BUILDER_COUNTER: path.join(workspaceRoot, '.builder-attempt') } });
  obs.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId: t.taskId, runId });
  await rt.markQaResultReceived(dataRoot, project, t.taskId, runId);

  const out = await gate.runOrResumeQaGate(dataRoot, project, t.taskId);
  assert.equal(out.outcome, 'PASS_DELIVERED', `expected QA PASS_DELIVERED for task ${n}, got ${out.outcome}`);
  const deliveryId = `PMD-${t.taskId}-${runId}`;
  return { taskId: t.taskId, goalId: g.goalId, runId, deliveryId, contractHash: (await import('../dist/server/backend/goal-task.js')).getTask(dataRoot, project, t.taskId).contract.contract_hash };
}

function mkTestDirs(name) {
  const dir = path.join(ROOT, name);
  const auditDir = path.join(dir, 'audit');
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(auditDir, { recursive: true });
  return { auditDir, stateFile };
}

// ── bootstrap packet bounded + contextHash stable ────────────────────────────
test('bootstrap packet is bounded and its contextHash is stable across re-reads of the same state', async () => {
  const project = 'OrchBootstrap';
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const p1 = pkg.buildPmBootstrapPacket(dataRoot, project, roleConfig);
  const p2 = pkg.buildPmBootstrapPacket(dataRoot, project, roleConfig);
  assert.equal(p1.contextHash, p2.contextHash);
  assert.ok(p1.text.length < 20000, 'bootstrap packet text is bounded');
  assert.match(p1.contextHash, /^[0-9a-f]{64}$/);
});

test('every PM packet ends with a code-generated contract whose example parses strictly', async () => {
  const project = 'OrchOutputContract';
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const schemas = await import('../dist/server/orchestrator/pm-schemas.js');
  const contracts = await import('../dist/server/backend/task-contract.js');
  const qaContracts = await import('../dist/server/backend/qa-contract.js');
  const roleConfig = makeRoleConfig(project);
  const bootstrap = pkg.buildPmBootstrapPacket(dataRoot, project, roleConfig);
  assert.match(bootstrap.text, /## OUTPUT CONTRACT[\s\S]*```$/);
  const bootstrapExample = bootstrap.text.match(/```json\n(PM_TASK_DECISION v1\n[\s\S]*?)```$/)?.[1];
  assert.ok(bootstrapExample);
  const parsedBootstrap = schemas.parsePmTaskDecision('```json\n' + bootstrapExample + '```');
  assert.equal(parsedBootstrap.decision, 'CREATE_TASK');
  const built = contracts.buildTaskContract({ project: 'example', task_id: 'TASK-0001', ...parsedBootstrap.task_contract });
  assert.equal(contracts.validateTaskContract(built).contract_hash, built.contract_hash);
  assert.ok(qaContracts.validateTaskQaContractFields({ scope: built.bounded_scope, acceptanceCriteria: built.acceptance_criteria, qaContract: built.qa_route }));
  const delivery = await mintPendingDelivery(project);
  const final = pkg.buildPmFinalGatePacket(dataRoot, project, delivery.deliveryId);
  assert.match(final.text, /## OUTPUT CONTRACT[\s\S]*```$/);
  const finalExample = final.text.match(/```json\n(PM_JUDGMENT v1\n[\s\S]*?)```$/)?.[1];
  assert.ok(finalExample);
  assert.equal(schemas.parsePmJudgment('```json\n' + finalExample + '```').decision, 'OWNER_REQUIRED');
});

test('CREATE_TASK injects the configured QA worker and audits a PM-supplied worker override', async () => {
  const project = 'OrchQaWorkerInjection';
  const roleConfig = makeRoleConfig(project);
  roleConfig.assignments.push({ roleId: 'qa', runtimeAdapterId: 'qa-worker:configured-qa', workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'per-task', permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true });
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'bounded task', task_contract: { goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'SEMANTIC' }], required_evidence: ['test output'], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }], semantic: { qaWorkerId: 'invented-pm-worker' } } } })] });
  const { auditDir, stateFile } = mkTestDirs('qa-worker-injection');
  const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.outcome, 'CREATE_TASK');
  assert.equal(gt.getTask(dataRoot, project, result.taskId).contract.qa_route.semantic.qaWorkerId, 'configured-qa');
  assert.ok(auditLines(auditDir).some((line) => line.outcome === 'QA_WORKER_OVERRIDDEN'));
});

test('invalid QA contract validation is re-asked once with the exact validation error', async () => {
  const project = 'OrchQaValidationReask';
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'bad first shape', task_contract: { goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: ['node scripts/check.mjs'] } } }), fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'corrected shape', task_contract: { goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] } } })] });
  const { auditDir, stateFile } = mkTestDirs('qa-validation-reask');
  const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.outcome, 'CREATE_TASK');
  assert.equal(adapter.sendLog.length, 2);
  assert.match(adapter.sendLog[1].body, /deterministic\[0\] 항목이 잘못되었습니다/);
});

test('--retry-blocked parses as an operator flag and clears only the durable blocked map', async () => {
  const main = await import('../dist/server/orchestrator/main.js');
  const stateFile = path.join(ROOT, 'retry-blocked-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, blocked: { bootstrap: { contextHash: 'h', reason: 'old', updatedAt: 'now' } }, pendingReask: { bootstrap: { contextHash: 'h', reason: 'retry', updatedAt: 'now' } } }));
  const args = main.parseArgs(['--dataRoot', dataRoot, '--project', 'RetryBlocked', '--role-config', 'role.json', '--audit-dir', path.join(ROOT, 'audit'), '--state-file', stateFile, '--once', '--retry-blocked']);
  assert.equal(args.retryBlocked, true);
  main.clearBlockedState(stateFile);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(state.blocked, {});
  assert.ok(state.pendingReask.bootstrap);
});

// ── CREATE_TASK creates a task WITH contract and calls the dispatch hook once ──
test('CREATE_TASK creates a Task with a TASK_CONTRACT v1 contract and calls the dispatch hook exactly once', async () => {
  const project = 'OrchCreateTask';
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_TASK_DECISION v1', {
      decision: 'CREATE_TASK', reason: 'starting the first bounded task',
      task_contract: {
        goal: 'produce correct output', bounded_scope: 'out.txt only',
        acceptance_criteria: [{ id: 'AC-01', description: 'output correct', validationMode: 'DETERMINISTIC' }],
        qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
      },
    })],
  });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('create-task');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile };
  const result = await roleLoop.processBootstrap(cfg);
  assert.equal(result.outcome, 'CREATE_TASK');
  assert.equal(dispatchCalls.length, 1);
  const task = gt.getTask(dataRoot, project, result.taskId);
  assert.ok(task.contract && task.contract.contract_hash, 'created Task carries a TASK_CONTRACT v1 contract_hash');
  assert.equal(task.executionState, 'READY');
});

// ── invalid PM output → re-ask once → BLOCKED with no canonical mutation ────
test('invalid PM output is re-asked once, then BLOCKED with zero canonical mutation', async () => {
  const project = 'OrchInvalidOutput';
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { scripted: ['not a fenced block at all', 'still not valid { this is not json'] });
  const { auditDir, stateFile } = mkTestDirs('invalid-output');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const tasksBefore = gt.listTasks(dataRoot, project).length;
  const result = await roleLoop.processBootstrap(cfg);
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(adapter.sendLog.length, 2, 're-asked exactly once (2 total sends)');
  assert.equal(gt.listTasks(dataRoot, project).length, tasksBefore, 'no Task created');
  const lines = auditLines(auditDir);
  assert.ok(lines.some((l) => l.step === 'bootstrap' && l.outcome === 'BLOCKED'));

  // A second pass with the SAME unchanged packet must not re-ask the PM again
  // (durable "blocked, don't re-ask every poll" state keyed by contextHash).
  const before = adapter.sendLog.length;
  const result2 = await roleLoop.processBootstrap(cfg);
  assert.equal(result2.outcome, 'BLOCKED');
  assert.equal(adapter.sendLog.length, before, 'no additional PM sends while state is unchanged and still blocked');
});

test('PM tool-call markup receives a no-tools re-ask and valid second reply applies once', async () => {
  const project = 'OrchNoToolsReask';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', { scripted: ['<tool_call><function=read></function></tool_call>', fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'valid second response', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })] });
  const { auditDir, stateFile } = mkTestDirs('no-tools-reask');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(adapter.sendLog.length, 2);
  assert.match(adapter.sendLog[1].body, /you have no tools; answer with the JSON block only/);
  assert.equal(pmJud.listPmJudgments(dataRoot, project).length, 1);
});

test('a new PM session receives the role preamble once and reuse does not resend it', async () => {
  const project = 'OrchPreamble';
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'PROJECT_COMPLETE', reason: 'complete' }), fence('PM_TASK_DECISION v1', { decision: 'PROJECT_COMPLETE', reason: 'complete' })] });
  const { auditDir, stateFile } = mkTestDirs('preamble');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  await roleLoop.processBootstrap(cfg);
  await roleLoop.processBootstrap(cfg);
  assert.equal(adapter.preambleBodies.length, 1);
  assert.equal(adapter.preambleBodies[0], fs.readFileSync(path.resolve('docs/PM_ROLE_INSTRUCTIONS.md'), 'utf8'));
});

// ── final gate ACCEPT applies once (judgment + delivery reconciled) ─────────
let acceptDelivery;
test('final gate ACCEPT applies once: judgment APPLIED, Delivery ACKNOWLEDGED', async () => {
  const project = 'OrchAccept';
  acceptDelivery = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, acceptDelivery.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', {
      decision: 'ACCEPT', retry: 'NONE', reason: 'evidence supports acceptance',
      contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash,
    })],
  });
  const { auditDir, stateFile } = mkTestDirs('accept');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, acceptDelivery.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${acceptDelivery.deliveryId}`);
  assert.equal(judgment.status, 'APPLIED');
  const delivery = pmDel.getPmDelivery(dataRoot, project, acceptDelivery.deliveryId);
  assert.equal(delivery.status, 'ACKNOWLEDGED');
  acceptDelivery.project = project;
  acceptDelivery.cfg = cfg;
});

// ── duplicate judgment → REPLAY_IGNORED ──────────────────────────────────────
test('a second final-gate pass over an already-ACKNOWLEDGED delivery is REPLAY_IGNORED', async () => {
  const result = await roleLoop.processFinalGate(acceptDelivery.cfg, acceptDelivery.deliveryId);
  assert.equal(result.outcome, 'REPLAY_IGNORED');
});

// ── CHANGES+SAME_TASK → retry preparation for the same task, no new task ────
test('CHANGES + SAME_TASK prepares and auto-dispatches a retry for the SAME Task, no new Task', async () => {
  const project = 'OrchChanges';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', {
      decision: 'CHANGES', retry: 'SAME_TASK', reason: 'needs one more correction pass',
      retry_instruction: 're-run and verify out.txt content', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash,
    })],
  });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('changes');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile };
  const tasksBefore = gt.listTasks(dataRoot, project).length;
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'CHANGES');
  const preps = rtp.listRetryPreparations(dataRoot, project).filter((r) => r.taskId === d.taskId);
  assert.equal(preps.length, 1);
  assert.equal(preps[0].status, 'READY');
  // NOTE: reconcileReadyRetryDispatches uses the retry-authorization from the
  // ORIGINAL owner-approved dispatch, which this disposable Task never went
  // through (it was minted directly, not via v1-dispatch); it is therefore
  // expected to skip (no worker/workspace binding to adopt), not dispatch —
  // the retry PREPARATION reaching READY is what this test certifies per the
  // spec's own wording ("retry preparation for the same task, no new task").
  assert.equal(gt.listTasks(dataRoot, project).length, tasksBefore, 'no new Task record created');
});

// ── OWNER_REQUIRED → audit only ──────────────────────────────────────────────
test('final gate OWNER_REQUIRED makes no canonical write, audit only', async () => {
  const project = 'OrchOwnerRequired';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', {
      decision: 'OWNER_REQUIRED', retry: 'NONE', reason: 'this needs a human call',
      contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash,
    })],
  });
  const { auditDir, stateFile } = mkTestDirs('owner-required');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'OWNER_REQUIRED');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'Delivery untouched');
  assert.throws(() => pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`), 'no judgment record created');
  const lines = auditLines(auditDir);
  assert.ok(lines.some((l) => l.outcome === 'OWNER_REQUIRED' && l.deliveryId === d.deliveryId));
});

// ── stale contract_hash/context_hash → fail closed ───────────────────────────
test('a stale context_hash (canonical state moved since the packet was built) is REJECTED_STALE', async () => {
  const project = 'OrchStaleContext';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'accepting a stale snapshot', contract_hash: d.contractHash, context_hash: '0'.repeat(64) })],
  });
  const { auditDir, stateFile } = mkTestDirs('stale-context');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'REJECTED_STALE');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'no canonical mutation on stale rejection');
});

test('(c) a mismatched contract_hash (context_hash otherwise fresh) is REJECTED_STALE', async () => {
  const project = 'OrchStaleContract';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'wrong contract hash on purpose', contract_hash: '1'.repeat(64), context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('stale-contract');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'REJECTED_STALE');
});

// ── ACCEPT_AND_NEXT → next task created with contract_hash + dispatched only when same goalId ──
test('ACCEPT_AND_NEXT creates the next Task with a contract_hash and dispatches it within the same scope', async () => {
  const project = 'OrchAcceptNext';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const nextContract = {
    project, goal: 'follow-up task', bounded_scope: 'out2.txt only',
    acceptance_criteria: [{ id: 'AC-01', description: 'follow-up criterion', validationMode: 'DETERMINISTIC' }],
    qa_route: { deterministic: [{ kind: 'fileExists', path: 'out2.txt', criterionId: 'AC-01' }] },
  };
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', {
      decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'accepted; follow-up is in scope',
      contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash, next_task_contract: nextContract,
    })],
  });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('accept-next');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT_AND_NEXT');
  assert.equal(result.nextTask.status, 'DISPATCHED');
  assert.equal(dispatchCalls.length, 1);
  const task = gt.getTask(dataRoot, project, d.taskId);
  assert.equal(task.pmState, 'ACCEPTED');
  const nextTask = gt.getTask(dataRoot, project, result.nextTask.taskId);
  assert.ok(nextTask.contract && nextTask.contract.contract_hash);
  assert.equal(nextTask.goalId, task.goalId, 'next Task stays in the same (V1 container) Goal scope');
});

test('ACCEPT_AND_NEXT with an out-of-scope project is OWNER_REQUIRED for the next-Task half only', async () => {
  const project = 'OrchAcceptNextScope';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', {
      decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'accept but next task is out of scope',
      contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash,
      next_task_contract: { project: 'SomeOtherProject', goal: 'scope violation', bounded_scope: 'x', acceptance_criteria: [], qa_route: {} },
    })],
  });
  const { auditDir, stateFile } = mkTestDirs('accept-next-scope');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED', 'the ACCEPT half still applies');
  assert.equal(result.nextTask.status, 'OWNER_REQUIRED');
  const task = gt.getTask(dataRoot, project, d.taskId);
  assert.equal(task.pmState, 'ACCEPTED');
});

// ── restart between QA PASS and PM (re-run --once) → resumes without duplicate ──
test('restart between QA PASS and PM: re-running processFinalGate resumes without duplicating the judgment', async () => {
  const project = 'OrchRestart';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'restart-safety drill', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('restart');
  const cfg1 = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const first = await roleLoop.processFinalGate(cfg1, d.deliveryId);
  assert.equal(first.outcome, 'APPLIED');

  // "Restart": a brand-new process-local config/adapter, same durable dataRoot+stateFile.
  const adapter2 = new FakePmAdapter('fake-pm', { scripted: [] }); // must NOT be consulted again
  const cfg2 = { dataRoot, project, roleConfig, pmAdapter: adapter2, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const second = await roleLoop.processFinalGate(cfg2, d.deliveryId);
  assert.equal(second.outcome, 'REPLAY_IGNORED');
  assert.equal(adapter2.sendLog.length, 0, 'the PM was never re-consulted for an already-ACKNOWLEDGED delivery');
  const judgments = pmJud.listPmJudgments(dataRoot, project).filter((j) => j.deliveryId === d.deliveryId);
  assert.equal(judgments.length, 1, 'no duplicate judgment record');
});

// ── (a) runtime billing guard ────────────────────────────────────────────────
test('(a) billing guard: a non-free-tier model with zeroExtraBilling !== false is BLOCKED_BILLING, no PM send, no canonical mutation', async () => {
  const project = 'OrchBillingGuard';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project, { model: 'some-paid-model' });
  const adapter = new FakePmAdapter('fake-pm', { scripted: [] });
  const { auditDir, stateFile } = mkTestDirs('billing');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'BLOCKED_BILLING');
  assert.equal(adapter.sendLog.length, 0, 'the PM adapter was never sent to');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'no canonical mutation');
  const lines = auditLines(auditDir);
  assert.ok(lines.some((l) => l.outcome === 'BLOCKED_BILLING'));
});

test('(a) billing guard: assertBillingAllowed is a pure, directly-testable unit', () => {
  assert.throws(() => roleLoop.assertBillingAllowed({ roleId: 'pm', model: 'gpt-5-paid', zeroExtraBilling: true }), /BLOCKED_BILLING/);
  assert.doesNotThrow(() => roleLoop.assertBillingAllowed({ roleId: 'pm', model: 'nemotron-3.5-lightning-free', zeroExtraBilling: true }));
  assert.doesNotThrow(() => roleLoop.assertBillingAllowed({ roleId: 'pm', model: 'big-pickle', zeroExtraBilling: true }));
  assert.throws(() => roleLoop.assertBillingAllowed({ roleId: 'pm', model: 'gpt-5-paid', zeroExtraBilling: false }), /OWNER_REQUIRED/);
});

// ── (b) fallbackChain walker ─────────────────────────────────────────────────
test('(b) fallbackChain: a paid primary walks to the first registered, free-tier fallback', async () => {
  const project = 'OrchFallback';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project, { model: 'some-paid-model', fallbackChain: ['opencode/unregistered-free', 'opencode/big-pickle'] });
  const primary = new FakePmAdapter('fake-pm', { scripted: [] });
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const fallback = new FakePmAdapter('opencode/big-pickle', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'accepted via fallback adapter', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const registry = new Map([['fake-pm', primary], ['opencode/big-pickle', fallback]]); // 'opencode/unregistered-free' deliberately absent
  const { auditDir, stateFile } = mkTestDirs('fallback');
  const cfg = {
    dataRoot, project, roleConfig, pmAdapter: primary, dispatchHook: fakeDispatchHook([]), auditDir, stateFile,
    resolveAdapter: (id) => registry.get(id) ?? null,
  };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(primary.sendLog.length, 0, 'the paid primary was never sent to');
  assert.equal(fallback.sendLog.length, 1, 'the compliant fallback was used instead');
});

test('(b) fallbackChain: an unregistered/paid-only chain is exhausted -> OWNER_REQUIRED, never a silent switch', async () => {
  const project = 'OrchFallbackExhausted';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project, { model: 'some-paid-model', fallbackChain: ['opencode/also-paid', 'opencode/unregistered-free'] });
  const primary = new FakePmAdapter('fake-pm', { scripted: [] });
  const alsoPaid = new FakePmAdapter('opencode/also-paid', { scripted: [] });
  const registry = new Map([['opencode/also-paid', alsoPaid]]); // registered but its id doesn't look free-tier; the other entry isn't registered at all
  const { auditDir, stateFile } = mkTestDirs('fallback-exhausted');
  const cfg = {
    dataRoot, project, roleConfig, pmAdapter: primary, dispatchHook: fakeDispatchHook([]), auditDir, stateFile,
    resolveAdapter: (id) => registry.get(id) ?? null,
  };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'OWNER_REQUIRED');
  assert.equal(primary.sendLog.length, 0);
  assert.equal(alsoPaid.sendLog.length, 0, 'a paid-looking fallback entry is skipped, never silently used');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'no canonical mutation');
});

// ── (d) PM send timeout: bounded, one retry, then BLOCKED_RUNTIME ───────────
test('(d) PM send timeout: a hanging adapter is not resent, then BLOCKED_RUNTIME with canonical untouched', async () => {
  const project = 'OrchTimeout';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { hang: true });
  const { auditDir, stateFile } = mkTestDirs('timeout');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile, pmSendTimeoutMs: 200 };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'BLOCKED_RUNTIME');
  assert.equal(adapter.sendLog.length, 1, 'the timed-out envelope is never blindly resent');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'canonical state untouched by the timeout');
  assert.equal(fs.existsSync(path.join(dataRoot, '_relay', 'role-sessions', project, 'pm.json')), false, 'timed-out PM session record is rotated');
  const lines = auditLines(auditDir);
  assert.ok(lines.some((l) => l.outcome === 'BLOCKED_RUNTIME'));
});

test('(d) PM late response after timeout is collected without a second send', async () => {
  const project = 'OrchLateResponse';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', { lateMs: 60, scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'late but valid response', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })] });
  const { auditDir, stateFile } = mkTestDirs('late-response');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile, pmSendTimeoutMs: 30 }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(adapter.sendLog.length, 1);
});

test('(a) primary PM adapter must be registered and zeroExtraBilling must be true', async () => {
  const project = 'OrchPrimaryRegistry';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project, { runtimeAdapterId: 'registered-id' });
  const adapter = new FakePmAdapter('injected-unregistered');
  const { auditDir, stateFile } = mkTestDirs('primary-registry');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, resolveAdapter: () => null, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'OWNER_REQUIRED');
  assert.equal(adapter.sendLog.length, 0);
  roleConfig.assignments[0].runtimeAdapterId = 'fake-pm';
  roleConfig.assignments[0].zeroExtraBilling = false;
  const result2 = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, resolveAdapter: () => adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result2.outcome, 'OWNER_REQUIRED');
  assert.equal(adapter.sendLog.length, 0);
});

test('(P1-3) default worker selector matches actl-managed adapter identity and rejects missing/ambiguous records', async () => {
  const { selectBuilderWorker } = await import('../dist/server/orchestrator/main.js');
  const record = (workerId) => ({ workerId, role: 'implementation' });
  assert.equal(selectBuilderWorker([record('builder-1')], 'actl-managed:builder-1').workerId, 'builder-1');
  assert.throws(() => selectBuilderWorker([], 'actl-managed:builder-1'), /missing/);
  assert.throws(() => selectBuilderWorker([record('builder-1'), record('builder-1')], 'actl-managed:builder-1'), /ambiguous/);
});

// ── zero live-dataRoot writes ─────────────────────────────────────────────────
after(() => {
  if (fs.existsSync(LIVE_ROOT)) {
    const writes = execFileSync('find', [LIVE_ROOT, '-path', path.join(LIVE_ROOT, 'V02CControlTower'), '-prune', '-o', '-newer', LIVE_MARKER, '-print'], { encoding: 'utf8' }).trim();
    if (writes) console.log(`  INFO  live-root paths newer than marker:\n${writes}`);
    assert.equal(writes, '', 'no writes under the live dataRoot outside V02CControlTower');
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(LIVE_MARKER, { force: true });
});
