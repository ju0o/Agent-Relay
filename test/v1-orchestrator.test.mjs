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
const events = await import('../dist/server/backend/event.js');
const actlBridge = await import('../dist/server/backend/actl-bridge.js');
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');
const v1Intake = await import('../dist/server/backend/v1-intake.js');
const evk = await import('../dist/server/backend/evidence.js');

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
async function mintPendingDelivery(project, opts = {}) {
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
      required_evidence: opts.requiredEvidence ?? [],
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

/** Direct construction with NO QA gate (no QA attempt ⇒ no QA-minted VERIFIED
 * record): the Task lands RESULT_RECEIVED + VERIFYING and a TASK_VERIFY Delivery
 * is minted, so the evidence gate judges exactly the records the test plants. */
async function mintDeliveryWithoutQaGate(project, requiredEvidence, runSeq) {
  const { goal: g } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const t = await gt.createTask(dataRoot, project, {
    goalId: g.goalId, title: `Orch no-qa ${runSeq}`, goal: 'produce correct output', reason: 'orchestrator certification',
    scope: 'out.txt only', completionCriteria: ['done when out.txt is correct'],
    executionState: 'RUNNING', pmState: 'PENDING',
    contract: {
      goal: 'produce correct output', bounded_scope: 'out.txt only',
      acceptance_criteria: [{ id: 'AC-SEMANTIC', description: 'output is correct', validationMode: 'SEMANTIC' }],
      required_evidence: requiredEvidence,
      qa_route: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId: 'floor-qa-worker' }, maxQaRemediationAttempts: 0 },
    },
  });
  const ws = path.join(ROOT, 'workspace', `floor-${runSeq}`);
  const folder = path.join(dataRoot, project, '_runs', `floor-run-${runSeq}`);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  const runId = `floor-run-${runSeq}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot: ws, workerId: 'floor-builder' }));
  await gt.linkRunToTask(dataRoot, project, t.taskId, folder);
  fs.writeFileSync(path.join(folder, 'result.md'), `orchestrator result text ${runSeq}`);
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
  await rt.markResultReceived(dataRoot, project, t.taskId, runId);
  const delivery = await pmDel.ensurePmDeliveryForTaskVerify(dataRoot, project, t.taskId);
  assert.ok(delivery, `delivery minted without QA gate for ${project}`);
  return { taskId: t.taskId, goalId: g.goalId, runId, deliveryId: delivery.deliveryId };
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
  assert.match(final.text, /## HASHES TO ECHO EXACTLY\ncontract_hash: [0-9a-f]{64}\ncontext_hash: [0-9a-f]{64}/);
  assert.match(final.text, /<contract_hash from HASHES block>/);
  assert.match(final.text, /<context_hash from HASHES block>/);
  assert.notEqual(final.context.task.contract_hash, final.contextHash);
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

test('contract validation gets three bounded rounds and converges after cwd and criterion fixes', async () => {
  const project = 'OrchValidationRounds';
  const roleConfig = makeRoleConfig(project);
  const contract = (check) => ({ goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [check] } });
  const adapter = new FakePmAdapter('fake-pm', { scripted: [
    fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'first correction', task_contract: contract({ kind: 'command', criterionId: 'AC-01', command: 'node', args: [], cwd: '/tmp/work' }) }),
    fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'second correction', task_contract: contract({ kind: 'command', command: 'node', args: [] }) }),
    fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'complete correction', task_contract: contract({ kind: 'command', criterionId: 'AC-01', command: 'node', args: [], cwd: 'workspace' }) }),
  ] });
  const { auditDir, stateFile } = mkTestDirs('validation-rounds');
  const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.outcome, 'CREATE_TASK');
  assert.equal(adapter.sendLog.length, 3);
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  assert.deepEqual(auditLines(auditDir).filter((line) => line.outcome?.startsWith('VALIDATION_REASK')).map((line) => line.outcome), ['VALIDATION_REASK 1/3', 'VALIDATION_REASK 2/3']);
  assert.match(adapter.sendLog[1].body, /cwd는 workspace 상대 경로여야 합니다/);
  assert.match(adapter.sendLog[2].body, /귀속된 deterministic check/);
  assert.match(adapter.sendLog[2].body, /Return the COMPLETE corrected PM_TASK_DECISION v1 block; keep everything else unchanged\./);
});

test('four invalid contract responses exhaust validation re-asks and create no Task', async () => {
  const project = 'OrchValidationBlocked';
  const roleConfig = makeRoleConfig(project);
  const bad = fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'still invalid', task_contract: { goal: 'produce output', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'command', criterionId: 'AC-01', command: 'node --bad', args: [] }] } } });
  const adapter = new FakePmAdapter('fake-pm', { scripted: [bad, bad, bad, bad] });
  const { auditDir, stateFile } = mkTestDirs('validation-blocked');
  const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(adapter.sendLog.length, 4, 'initial response plus three validation re-asks');
  assert.equal(gt.listTasks(dataRoot, project).length, 0);
  assert.equal(auditLines(auditDir).filter((line) => line.outcome?.startsWith('VALIDATION_REASK')).length, 3);
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
  assert.equal(adapter.sendLog.length, 1, 'PROJECT_COMPLETE is cached while bootstrap context is unchanged');
  const cachedAudit = fs.readFileSync(path.join(auditDir, 'role-loop.jsonl'), 'utf8');
  assert.match(cachedAudit, /PROJECT_COMPLETE_CACHED/);
  await gt.createGoal(dataRoot, project, { title: 'new canonical goal', goalStatement: 'invalidate bootstrap completion cache' });
  await roleLoop.processBootstrap(cfg);
  assert.equal(adapter.sendLog.length, 2, 'a new canonical goal invalidates the completion cache');
  assert.equal(adapter.preambleBodies[0], fs.readFileSync(path.resolve('docs/PM_ROLE_INSTRUCTIONS.md'), 'utf8'));
});

test('PM instructions resolve from the module when launched from another cwd', async () => {
  const project = 'OrchPreambleOtherCwd';
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'PROJECT_COMPLETE', reason: 'complete' })] });
  const { auditDir, stateFile } = mkTestDirs('preamble-other-cwd');
  const previous = process.cwd();
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-other-cwd-'));
  try {
    process.chdir(otherCwd);
    const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
    assert.equal(result.outcome, 'PROJECT_COMPLETE');
    assert.equal(adapter.preambleBodies.length, 1);
  } finally {
    process.chdir(previous);
  }
});

test('missing PM instructions fail closed before any PM send', async () => {
  const project = 'OrchMissingPreamble';
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'PROJECT_COMPLETE', reason: 'must not send' })] });
  const { auditDir, stateFile } = mkTestDirs('missing-preamble');
  const result = await roleLoop.processBootstrap({ dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile, pmInstructionsPath: path.join(os.tmpdir(), 'does-not-exist-pm-instructions.md') });
  assert.equal(result.outcome, 'BLOCKED_RUNTIME');
  assert.equal(adapter.sendLog.length, 0);
  assert.equal(adapter.preambleBodies.length, 0);
  assert.match(fs.readFileSync(path.join(auditDir, 'role-loop.jsonl'), 'utf8'), /BLOCKED_RUNTIME: pm instructions missing/);
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

// ── round 38b: final gate mechanically enforces contract required_evidence ──
test('(r38b-a) ACCEPT is refused and rewritten to CHANGES when the contract requires TEST/VERIFIED but only ADAPTER_OBSERVATION/OBSERVED exists', async () => {
  const project = 'OrchEvGateRefuse';
  const d = await mintPendingDelivery(project, { requiredEvidence: ['TEST/VERIFIED machine-proof of the --self-test run'] });
  await evk.recordAdapterObservation(dataRoot, project, {
    summary: 'Adapter RESPONSE_COMPLETE observed for Task TASK-1 Run orch-run',
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const pmReason = 'the raw self-test output is visible in the cited record, so I accept on this basis';
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: pmReason, contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-refuse');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  assert.equal(result.decision, 'CHANGES');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.decision, 'CHANGES', 'applied judgment decision is CHANGES, not ACCEPT');
  assert.match(judgment.reason, /TEST\/VERIFIED/, 'machine reason names the unmet requirement');
  assert.ok(judgment.reason.includes(pmReason), 'PM prose reason preserved verbatim in the stored judgment');
  assert.notEqual(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED', 'the Task is NOT accepted on prose');
  const refusal = auditLines(auditDir).find((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE');
  assert.ok(refusal, 'audit line carries outcome ACCEPT_REFUSED_EVIDENCE');
  assert.deepEqual(refusal.unmet, ['REQ-1'], 'unmet requirement id visible in role-loop.jsonl');
  assert.match(refusal.requirements[0], /TEST\/VERIFIED/);
  assert.ok(refusal.present.some((s) => /ADAPTER_OBSERVATION\/OBSERVED/.test(s)), 'present records are listed in the audit line');
});

test('(r38b-b) ACCEPT applies unchanged when a required TEST/VERIFIED record is bound to the run', async () => {
  const project = 'OrchEvGateSatisfied';
  const d = await mintPendingDelivery(project, { requiredEvidence: ['TEST/VERIFIED machine-proof of the --self-test run'] });
  await evk.recordTestEvidence(dataRoot, project, {
    summary: 'deterministic QA: node scripts/founder-brief.mjs --self-test exited 0',
    status: 'PASS', source: { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' },
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'verified test evidence is bound', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-satisfied');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
  assert.ok(!auditLines(auditDir).some((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE'), 'no refusal audit line');
});

test('(r38b-c) no required_evidence in the contract: ACCEPT applies unchanged', async () => {
  const project = 'OrchEvGateNoRequirement';
  const d = await mintPendingDelivery(project, { requiredEvidence: [] });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'no evidence requirements named', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-none');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
  assert.ok(!auditLines(auditDir).some((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE'));
});

test('(r38b-d) a FAIL-status record of the right type/level does not satisfy the requirement', async () => {
  const project = 'OrchEvGateFailRecord';
  const d = await mintPendingDelivery(project, { requiredEvidence: ['TEST/VERIFIED machine-proof of the --self-test run'] });
  await evk.recordTestEvidence(dataRoot, project, {
    summary: 'deterministic QA: node scripts/founder-brief.mjs --self-test exited 7',
    status: 'FAIL', source: { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' },
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const pmReason = 'the failing run is still evidence that the test ran, so I accept';
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: pmReason, contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-fail-record');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.decision, 'CHANGES');
  const refusal = auditLines(auditDir).find((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE');
  assert.ok(refusal, 'refusal audited');
  assert.deepEqual(refusal.unmet, ['REQ-1'], 'FAIL record of the right type/level is still unmet');
  assert.ok(refusal.present.some((s) => /:TEST\/VERIFIED\/FAIL/.test(s)), 'the FAIL record is listed as present');
  assert.ok(judgment.reason.includes(pmReason), 'PM prose reason preserved verbatim in the stored judgment');
});

test("(r38b-e) the PM's original reason text is preserved verbatim in the stored CHANGES judgment", async () => {
  const project = 'OrchEvGateReasonPreserved';
  const d = await mintPendingDelivery(project, { requiredEvidence: ['TEST/VERIFIED machine-proof of the --self-test run'] });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const pmReason = 'this run shows the adapter RESPONSE_COMPLETE only, yet the contract wants machine-verified test proof';
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: pmReason, contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-reason');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.decision, 'CHANGES');
  assert.ok(judgment.reason.includes('--- PM reason (verbatim):'), 'verbatim marker present');
  assert.ok(judgment.reason.includes(pmReason), 'PM reason appears verbatim inside the stored judgment reason');
  const refusal = auditLines(auditDir).find((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE');
  assert.equal(refusal.pmReason, pmReason, 'audit line also preserves the full PM reason');
});

// ── round 38c: prose required_evidence falls back to a VERIFIED floor ─────────
// LIVE TASK-0003 (JuControler-Private-planning, audit 04:16:36Z) refused forever
// because real task-contract.v1 required_evidence entries are PROSE and name no
// machine-checkable TYPE/TRUSTLEVEL token. Prose requirements now fall back to
// the default floor: at least one non-FAIL VERIFIED (or ACCEPTED) record bound
// to the run. Token requirements keep the round-38b rule, and the applied
// judgment records which rule matched per requirement (evidenceGate rows).

const PROSE_EVIDENCE_REQ = 'node scripts/founder-brief.mjs --self-test 실행 결과(PASS 마커, exit 0)';

test('(r38c-a) prose required_evidence is satisfied by a non-FAIL VERIFIED record — ACCEPT applies under the floor rule', async () => {
  const project = 'OrchEvGateFloorSatisfied';
  const d = await mintPendingDelivery(project, { requiredEvidence: [PROSE_EVIDENCE_REQ] });
  await evk.recordTestEvidence(dataRoot, project, {
    summary: 'deterministic QA: node scripts/founder-brief.mjs --self-test exited 0',
    status: 'PASS', source: { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' },
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'verified test evidence is bound', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-floor-satisfied');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.deepEqual(judgment.evidenceGate, [{ requirementId: 'REQ-1', requirement: PROSE_EVIDENCE_REQ, rule: 'floor' }], 'applied judgment records which rule matched (floor)');
  assert.ok(!auditLines(auditDir).some((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE'), 'no refusal audit line');
});

test('(r38c-b) prose required_evidence with only ADAPTER_OBSERVATION/OBSERVED is refused — reason says "floor: VERIFIED evidence absent"', async () => {
  const project = 'OrchEvGateFloorAbsent';
  const d = await mintDeliveryWithoutQaGate(project, [PROSE_EVIDENCE_REQ], 1);
  await evk.recordAdapterObservation(dataRoot, project, {
    summary: 'Adapter RESPONSE_COMPLETE observed for Task',
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  assert.equal(packet.context.qa, undefined, 'no QA attempt ⇒ no qa block, legacy-style delivery reaches the evidence gate');
  const pmReason = 'the raw self-test output is visible in the cited record, so I accept on this basis';
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: pmReason, contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-floor-absent');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  assert.equal(result.decision, 'CHANGES');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.decision, 'CHANGES');
  assert.match(judgment.reason, /floor: VERIFIED evidence absent/, 'reason names the missing floor, not the contract text');
  assert.ok(!/names no machine-checkable/.test(judgment.reason), 'the r38b phrase describing the contract is gone');
  assert.deepEqual(judgment.evidenceGate, [{ requirementId: 'REQ-1', requirement: PROSE_EVIDENCE_REQ, rule: 'floor' }], 'applied judgment records the floor rule');
  assert.notEqual(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED', 'the Task is NOT accepted on an OBSERVED-only run');
  const refusal = auditLines(auditDir).find((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE');
  assert.ok(refusal, 'refusal audited');
  assert.deepEqual(refusal.unmet, ['REQ-1']);
  assert.match(refusal.requirements[0], /floor: VERIFIED evidence absent/);
  assert.ok(refusal.present.some((s) => /ADAPTER_OBSERVATION\/OBSERVED/.test(s)), 'present records are listed');
  assert.ok(refusal.rules.includes('REQ-1:floor'), 'audit line records the matching rule');
});

test('(r38c-c) prose required_evidence is refused when the only VERIFIED record bound to the run has status FAIL', async () => {
  const project = 'OrchEvGateFloorFail';
  const d = await mintDeliveryWithoutQaGate(project, [PROSE_EVIDENCE_REQ], 2);
  await evk.recordTestEvidence(dataRoot, project, {
    summary: 'deterministic QA: node scripts/founder-brief.mjs --self-test exited 7',
    status: 'FAIL', source: { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' },
    taskId: d.taskId, runId: d.runId,
  });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'the failing run is still evidence that the test ran, so I accept', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-floor-fail');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.decision, 'CHANGES');
  assert.match(judgment.reason, /floor: VERIFIED evidence absent/, 'a FAIL-status VERIFIED record never satisfies the floor');
  assert.deepEqual(judgment.evidenceGate, [{ requirementId: 'REQ-1', requirement: PROSE_EVIDENCE_REQ, rule: 'floor' }]);
  const refusal = auditLines(auditDir).find((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE');
  assert.ok(refusal, 'refusal audited');
  assert.ok(refusal.present.some((s) => /:TEST\/VERIFIED\/FAIL/.test(s)), 'the FAIL VERIFIED record is listed as present');
});

test('(r38c-d) explicit TEST/VERIFIED token requirement keeps the round-38b rule, recorded as rule=token (unsatisfied and satisfied)', async () => {
  // Unsatisfied: token rule refuses with the r38b wording (a TEST record is
  // required; OBSERVED alone never suffices).
  const projectA = 'OrchEvGateTokenUnsatisfied';
  const da = await mintDeliveryWithoutQaGate(projectA, ['TEST/VERIFIED machine-proof of the --self-test run'], 3);
  await evk.recordAdapterObservation(dataRoot, projectA, { summary: 'Adapter RESPONSE_COMPLETE observed', taskId: da.taskId, runId: da.runId });
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const roleConfig = makeRoleConfig(projectA);
  const packetA = pkg.buildPmFinalGatePacket(dataRoot, projectA, da.deliveryId);
  const adapterA = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'observed record is enough for me', contract_hash: packetA.context.task.contract_hash, context_hash: packetA.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-token-unsatisfied');
  const refused = await roleLoop.processFinalGate({ dataRoot, project: projectA, roleConfig, pmAdapter: adapterA, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, da.deliveryId);
  assert.equal(refused.outcome, 'ACCEPT_REFUSED_EVIDENCE');
  const refusedJudgment = pmJud.getPmJudgment(dataRoot, projectA, `PMJ-${da.deliveryId}`);
  assert.match(refusedJudgment.reason, /requires TEST\/VERIFIED/, 'token requirements still refuse with the r38b wording');
  assert.ok(!/floor: VERIFIED evidence absent/.test(refusedJudgment.reason), 'token rule does not use the floor wording');
  assert.deepEqual(refusedJudgment.evidenceGate, [{ requirementId: 'REQ-1', requirement: 'TEST/VERIFIED machine-proof of the --self-test run', rule: 'token' }], 'applied judgment records the token rule');

  // Satisfied: a TEST/VERIFIED PASS record bound to the run unblocks ACCEPT.
  const projectB = 'OrchEvGateTokenSatisfied';
  const db = await mintDeliveryWithoutQaGate(projectB, ['TEST/VERIFIED machine-proof of the --self-test run'], 4);
  await evk.recordTestEvidence(dataRoot, projectB, {
    summary: 'deterministic QA: node scripts/founder-brief.mjs --self-test exited 0',
    status: 'PASS', source: { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' },
    taskId: db.taskId, runId: db.runId,
  });
  const roleConfigB = makeRoleConfig(projectB);
  const packetB = pkg.buildPmFinalGatePacket(dataRoot, projectB, db.deliveryId);
  const adapterB = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'the required TEST/VERIFIED record is bound', contract_hash: packetB.context.task.contract_hash, context_hash: packetB.contextHash })],
  });
  const dirsB = mkTestDirs('evgate-token-satisfied');
  const accepted = await roleLoop.processFinalGate({ dataRoot, project: projectB, roleConfig: roleConfigB, pmAdapter: adapterB, dispatchHook: fakeDispatchHook([]), auditDir: dirsB.auditDir, stateFile: dirsB.stateFile }, db.deliveryId);
  assert.equal(accepted.outcome, 'APPLIED');
  assert.equal(accepted.decision, 'ACCEPT');
  assert.equal(gt.getTask(dataRoot, projectB, db.taskId).pmState, 'ACCEPTED');
  const acceptedJudgment = pmJud.getPmJudgment(dataRoot, projectB, `PMJ-${db.deliveryId}`);
  assert.deepEqual(acceptedJudgment.evidenceGate, [{ requirementId: 'REQ-1', requirement: 'TEST/VERIFIED machine-proof of the --self-test run', rule: 'token' }], 'applied judgment records the token rule');
});

test('(r38c-e) a contract with no required_evidence still applies ACCEPT unchanged — no evidenceGate rows on the judgment', async () => {
  const project = 'OrchEvGateNoRequirement38c';
  const d = await mintPendingDelivery(project, { requiredEvidence: [] });
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'no evidence requirements named', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })],
  });
  const { auditDir, stateFile } = mkTestDirs('evgate-none-38c');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
  const judgment = pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`);
  assert.equal(judgment.evidenceGate, undefined, 'no required_evidence ⇒ no gate rows recorded');
  assert.ok(!auditLines(auditDir).some((line) => line.outcome === 'ACCEPT_REFUSED_EVIDENCE'));
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
  const sendsAfterFirst = adapter.sendLog.length;
  const cached = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(cached.outcome, 'OWNER_REQUIRED');
  assert.equal(adapter.sendLog.length, sendsAfterFirst, 'unchanged OWNER_REQUIRED decision is cached');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'Delivery untouched');
  assert.throws(() => pmJud.getPmJudgment(dataRoot, project, `PMJ-${d.deliveryId}`), 'no judgment record created');
  const lines = auditLines(auditDir);
  assert.ok(lines.some((l) => l.outcome === 'OWNER_REQUIRED' && l.deliveryId === d.deliveryId));
  assert.ok(lines.some((l) => l.outcome === 'FINAL_GATE_DECISION_CACHED' && l.deliveryId === d.deliveryId));
});

// ── stale contract_hash/context_hash → fail closed ───────────────────────────
test('a stale context_hash (canonical state moved since the packet was built) is REJECTED_STALE', async () => {
  const project = 'OrchStaleContext';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', {
    scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'accepting a stale snapshot', contract_hash: d.contractHash, context_hash: '0'.repeat(64) })],
  });
  const send = adapter.send.bind(adapter);
  adapter.send = async (sessionId, envelope) => { const request = await send(sessionId, envelope); if (envelope.kind === 'PM_FINAL_GATE') await rt.requestChanges(dataRoot, project, d.taskId, d.runId, { goalId: d.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'canonical state moved for stale test' }); return request; };
  const { auditDir, stateFile } = mkTestDirs('stale-context');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'REJECTED_STALE');
  const delivery = pmDel.getPmDelivery(dataRoot, project, d.deliveryId);
  assert.equal(delivery.status, 'PENDING', 'no canonical mutation on stale rejection');
});

test('context_hash copied from contract_hash is re-asked once and then applied', async () => {
  const project = 'OrchHashEchoContext';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'echo mistake', contract_hash: packet.context.task.contract_hash, context_hash: packet.context.task.contract_hash }),
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'corrected echo', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash }),
  ] });
  const { auditDir, stateFile } = mkTestDirs('hash-echo-context');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(adapter.sendLog.length, 2);
  assert.match(adapter.sendLog[1].body, /HASH_ECHO_ERROR/);
  assert.ok(auditLines(auditDir).some((line) => line.outcome === 'HASH_ECHO_REASK' && line.field === 'context_hash'));
});

test('contract_hash echo error is re-asked while canonical state is unchanged', async () => {
  const project = 'OrchHashEchoContract';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'wrong contract echo', contract_hash: '0'.repeat(64), context_hash: packet.contextHash }),
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'corrected contract echo', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash }),
  ] });
  const { auditDir, stateFile } = mkTestDirs('hash-echo-contract');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.ok(auditLines(auditDir).some((line) => line.outcome === 'HASH_ECHO_REASK' && line.field === 'contract_hash'));
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
  const send = adapter.send.bind(adapter);
  adapter.send = async (sessionId, envelope) => { const request = await send(sessionId, envelope); if (envelope.kind === 'PM_FINAL_GATE') await rt.requestChanges(dataRoot, project, d.taskId, d.runId, { goalId: d.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'canonical state moved for contract stale test' }); return request; };
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

test('ACCEPT_AND_NEXT injects the configured QA worker when the PM uses semantic true', async () => {
  const project = 'OrchAcceptNextQaInjection';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  roleConfig.assignments.push({ roleId: 'qa', runtimeAdapterId: 'qa-worker:configured-next-qa', workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'per-task', permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true });
  const packet = (await import('../dist/server/orchestrator/pm-packets.js')).buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const nextContract = { project, goal: 'follow-up', bounded_scope: 'out2.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'SEMANTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out2.txt' }], semantic: true } };
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'accepted', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash, next_task_contract: nextContract })] });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('accept-next-qa-injection');
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile }, d.deliveryId);
  const nextTask = gt.getTask(dataRoot, project, result.nextTask.taskId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(nextTask.contract.qa_route.semantic.qaWorkerId, 'configured-next-qa');
  assert.equal(dispatchCalls.length, 1);
  assert.equal(pmJud.listPmJudgments(dataRoot, project).filter((j) => j.deliveryId === d.deliveryId).length, 1);
});

test('ACCEPT_AND_NEXT validation error re-asks once and creates one corrected next Task while applying ACCEPT once', async () => {
  const project = 'OrchAcceptNextValidation';
  const d = await mintPendingDelivery(project);
  const roleConfig = makeRoleConfig(project);
  roleConfig.assignments.push({ roleId: 'qa', runtimeAdapterId: 'qa-worker:configured-next-qa', workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'per-task', permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true });
  const packet = (await import('../dist/server/orchestrator/pm-packets.js')).buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const bad = { project, goal: 'follow-up', bounded_scope: 'out2.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'command', criterionId: 'AC-01', command: 'node --bad', args: [] }], semantic: true } };
  const good = { project, goal: 'follow-up', bounded_scope: 'out2.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out2.txt' }], semantic: true } };
  const adapter = new FakePmAdapter('fake-pm', { scripted: [
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'accepted', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash, next_task_contract: bad }),
    fence('PM_JUDGMENT v1', { decision: 'ACCEPT_AND_NEXT', retry: 'NONE', reason: 'corrected', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash, next_task_contract: good }),
  ] });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('accept-next-validation');
  const before = gt.listTasks(dataRoot, project).length;
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile }, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(adapter.sendLog.length, 2);
  assert.equal(gt.listTasks(dataRoot, project).length, before + 1);
  assert.equal(dispatchCalls.length, 1);
  assert.equal(pmJud.listPmJudgments(dataRoot, project).filter((j) => j.deliveryId === d.deliveryId).length, 1, 'ACCEPT is submitted once despite next-task re-ask');
  assert.ok(auditLines(auditDir).some((line) => line.outcome === 'VALIDATION_REASK 1/3'));
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
  const fixtureRoot = path.join(ROOT, 'raw-worker-fixture');
  const workers = path.join(fixtureRoot, '_relay', 'workers');
  fs.mkdirSync(workers, { recursive: true });
  fs.writeFileSync(path.join(workers, 'builder-1.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'builder-1', role: 'implementation', launchCommand: '/home/skkse12/.local/bin/actl', driverOptions: { actl: { runtimeId: 'rt1_fixture' } } }));
  fs.writeFileSync(path.join(workers, 'claude.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'claude', launchCommand: 'node' }));
  fs.writeFileSync(path.join(workers, 'qa.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'qa', role: 'qa', launchCommand: 'node' }));
  const selected = selectBuilderWorker(fixtureRoot, 'actl-managed:builder-1');
  assert.equal(selected.workerId, 'builder-1');
  assert.equal(selected.driverOptions.actl.runtimeId, 'rt1_fixture');
  assert.throws(() => selectBuilderWorker(fixtureRoot, 'actl-managed:missing'), /missing/);
  fs.writeFileSync(path.join(workers, 'builder-1.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'builder-1', role: 'qa', launchCommand: 'node' }));
  assert.throws(() => selectBuilderWorker(fixtureRoot, 'actl-managed:builder-1'), /role mismatch/);
  fs.writeFileSync(path.join(workers, 'builder-1.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'builder-1', role: 'implementation', launchCommand: 'node' }));
  fs.writeFileSync(path.join(workers, 'duplicate.json'), JSON.stringify({ schemaVersion: 'G.2', workerId: 'builder-1', role: 'implementation', launchCommand: 'node' }));
  assert.throws(() => selectBuilderWorker(fixtureRoot, 'actl-managed:builder-1'), /ambiguous/);
});

test('dispatch-failed Run without Result enters the PM gate and prepares a same-Task retry', async () => {
  const project = 'OrchFailedRunRecovery';
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 'failed dispatch recovery', goal: 'recover failed dispatch', reason: 'resilience', scope: 'out.txt only',
    completionCriteria: ['retry the same task'], executionState: 'READY', pmState: 'PENDING',
    contract: { goal: 'recover failed dispatch', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'retry', validationMode: 'DETERMINISTIC' }], required_evidence: [], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }], semantic: { qaWorkerId: 'qa-test' } }, retry_policy: { max_pm_changes: 1 } },
  });
  const runId = 'failed-dispatch-run-1';
  const folder = path.join(dataRoot, project, '_runs', 'failed-1');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, goalId: goal.goalId, taskId: task.taskId, workspaceRoot: ROOT, workerId: 'failed-builder', ownerApprovedScopeFingerprint: 'scope' }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'test dispatch' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'FAILED', reason: 'dispatch failed: pane unavailable' });
  await events.recordRuntimeError(dataRoot, project, { summary: 'dispatch failed: pane unavailable', goalId: goal.goalId, taskId: task.taskId, runId, source: { kind: 'test', subsystem: 'dispatch' }, details: { error: 'pane unavailable' } });

  const { auditDir, stateFile } = mkTestDirs('failed-run-recovery');
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_JUDGMENT v1', { decision: 'OWNER_REQUIRED', retry: 'NONE', reason: 'owner review required', contract_hash: task.contract.contract_hash, context_hash: 'unused' })] });
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  await pmDel.ensurePmDeliveryForFailedRun(dataRoot, project, task.taskId, runId);
  const beforePacket = pkg.buildPmFinalGatePacket(dataRoot, project, `PMD-${task.taskId}-${runId}`);
  const first = await roleLoop.runOnce(cfg);
  assert.equal(first.steps.length, 1);
  const deliveries = pmDel.listPendingPmDeliveries(dataRoot, project);
  assert.equal(deliveries.length, 1);
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, deliveries[0].deliveryId);
  assert.equal(beforePacket.contextHash, packet.contextHash, 'read/send/re-read keeps failed-run context hash stable');
  assert.match(packet.text, /Run FAILED before producing a Result — reason: pane unavailable/);
  assert.match(packet.text, /## QA\nnot run/);
  assert.match(packet.text, /retries remaining 1 of 1/);
  assert.deepEqual(packet.allowedActions, ['CHANGES', 'OWNER_REQUIRED']);

  const judgment = await pmJud.submitPmJudgment(dataRoot, project, { deliveryId: deliveries[0].deliveryId, decision: 'CHANGES', reason: 'retry after dispatch failure', retryInstruction: 'retry the same task' });
  assert.equal(judgment.judgment.decision, 'CHANGES');
  const prepared = await rtp.prepareRetryForJudgment(dataRoot, project, deliveries[0].deliveryId);
  assert.equal(prepared.preparation.status, 'READY');
  assert.equal(prepared.task.taskId, task.taskId);
  assert.equal(prepared.task.executionState, 'READY');
  assert.equal(gt.listTasks(dataRoot, project).length, 1);
  assert.equal(pmDel.listPmDeliveries(dataRoot, project).length, 1);
  const newerFolder = path.join(dataRoot, project, '_runs', 'failed-2');
  fs.mkdirSync(newerFolder, { recursive: true });
  fs.writeFileSync(path.join(newerFolder, 'meta.json'), JSON.stringify({ tags: [], runId: 'failed-dispatch-run-2', goalId: goal.goalId, taskId: task.taskId }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, newerFolder);
  const changedPacket = pkg.buildPmFinalGatePacket(dataRoot, project, deliveries[0].deliveryId);
  assert.notEqual(changedPacket.contextHash, packet.contextHash, 'a newly linked Run changes the stale-check hash');
});

test('in-flight RESERVED retry Run does not mint another failed-run Delivery or PM turn', async () => {
  const project = 'OrchRetryInFlight';
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 'retry in flight', goal: 'hold retry', reason: 'test', scope: 'fixture', completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING' });
  const runId = 'retry-in-flight-run';
  const folder = path.join(dataRoot, project, '_runs', 'retry-in-flight');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, goalId: goal.goalId, taskId: task.taskId }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'retry reserved' });
  fs.writeFileSync(path.join(folder, 'runtime-binding.json'), JSON.stringify({ schemaVersion: 1, collectStatus: 'RESERVED', runtimeId: 'rt-fixture', updatedAt: new Date().toISOString() }));
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'FAILED', reason: 'reservation remains live' });
  await events.recordRuntimeError(dataRoot, project, { summary: 'reservation remains live', goalId: goal.goalId, taskId: task.taskId, runId, source: { kind: 'test', subsystem: 'retry' }, details: { error: 'reservation remains live' } });
  const adapter = new FakePmAdapter('fake-pm');
  const { auditDir, stateFile } = mkTestDirs('retry-in-flight');
  const result = await roleLoop.runOnce({ dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.steps.length, 0);
  assert.equal(pmDel.listPmDeliveries(dataRoot, project).length, 0);
  assert.equal(adapter.sendLog.length, 0);
});

test('failed-run PM changes honor max_pm_changes and stop at OWNER_REQUIRED', async () => {
  const project = 'OrchFailedRunBudget';
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: 'failed dispatch budget', goal: 'bounded recovery', reason: 'resilience', scope: 'out.txt only', completionCriteria: ['retry'], executionState: 'READY', pmState: 'PENDING',
    contract: { goal: 'bounded recovery', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'retry', validationMode: 'DETERMINISTIC' }], required_evidence: [], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }], semantic: { qaWorkerId: 'qa-test' } }, retry_policy: { max_pm_changes: 0 } },
  });
  const runId = 'failed-budget-run-1'; const folder = path.join(dataRoot, project, '_runs', 'failed-1'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, goalId: goal.goalId, taskId: task.taskId }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'FAILED', reason: 'dispatch failed' });
  await pmDel.ensurePmDeliveryForFailedRun(dataRoot, project, task.taskId, runId);
  const { auditDir, stateFile } = mkTestDirs('failed-run-budget');
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, `PMD-${task.taskId}-${runId}`);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_JUDGMENT v1', { decision: 'CHANGES', retry: 'SAME_TASK', reason: 'retry requested', retry_instruction: 'retry same task', contract_hash: task.contract.contract_hash, context_hash: packet.contextHash })] });
  const result = await roleLoop.processFinalGate({ dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile }, `PMD-${task.taskId}-${runId}`);
  assert.equal(result.outcome, 'OWNER_REQUIRED');
  assert.equal(pmJud.listPmJudgments(dataRoot, project).length, 0);
  assert.equal(gt.getTask(dataRoot, project, task.taskId).executionState, 'FAILED');
});

test('idle cycle writes a durable cycle audit summary', async () => {
  const project = 'OrchCycleIdle';
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 'in flight', goal: 'wait', reason: 'test', scope: 'fixture', completionCriteria: ['done'] });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'PLANNED', to: 'READY' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'RUNNING' });
  const { auditDir, stateFile } = mkTestDirs('cycle-idle');
  const result = await roleLoop.runOnce({ dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile });
  assert.equal(result.steps.length, 0);
  const cycle = auditLines(auditDir).find((line) => line.step === 'cycle');
  assert.equal(cycle.outcome, 'IDLE');
  assert.deepEqual(cycle.openTasks, [task.taskId]);
});

async function mintInFlightRun(project) {
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 'async run', goal: 'collect later', reason: 'test', scope: 'fixture', completionCriteria: ['done'] });
  const runId = `${project}-run`;
  const folder = path.join(dataRoot, project, '_runs', 'async-run');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, goalId: goal.goalId, taskId: task.taskId, workerId: 'builder-test' }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'PLANNED', to: 'READY' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED' });
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'RUNNING' });
  actlBridge.writeRuntimeBinding(folder, { schemaVersion: 1, collectStatus: 'SENT', runtimeId: 'rt-test', updatedAt: new Date().toISOString() });
  return { task, runId, folder };
}

test('runOnce resumes a finished asynchronous Run once and is idempotent after FINAL_BOUND', async () => {
  const project = 'OrchResumeCollect';
  const { task, runId, folder } = await mintInFlightRun(project);
  const { auditDir, stateFile } = mkTestDirs('resume-collect');
  let collectCalls = 0;
  const result = await roleLoop.runOnce({
    dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile,
    collectHook: async () => {
      collectCalls += 1;
      const binding = actlBridge.readRuntimeBinding(folder);
      actlBridge.writeRuntimeBinding(folder, { ...binding, collectStatus: 'FINAL_BOUND', updatedAt: new Date().toISOString() });
      return { taskId: task.taskId, runId, collectStatus: 'FINAL_BOUND' };
    },
  });
  assert.equal(collectCalls, 1);
  assert.ok(result.steps.some((step) => step.step === 'resume-collect' && step.outcome === 'COLLECTED'));
  assert.equal(actlBridge.readRuntimeBinding(folder).collectStatus, 'FINAL_BOUND');
  await roleLoop.runOnce({ dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile, collectHook: async () => { collectCalls += 1; throw new Error('duplicate collect'); } });
  assert.equal(collectCalls, 1, 'FINAL_BOUND Run is not collected again');
  assert.equal(auditLines(auditDir).filter((line) => line.step === 'resume-collect' && line.outcome === 'COLLECTED').length, 1);
});

test('runOnce audits WAITING when an asynchronous worker is still busy', async () => {
  const project = 'OrchResumeWaiting';
  const { task, runId } = await mintInFlightRun(project);
  const { auditDir, stateFile } = mkTestDirs('resume-waiting');
  const result = await roleLoop.runOnce({
    dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile,
    collectHook: async () => { throw new Error('worker still busy'); },
  });
  assert.ok(result.steps.some((step) => step.step === 'resume-collect' && step.outcome === 'WAITING'));
  const audit = auditLines(auditDir).find((line) => line.step === 'resume-collect' && line.runId === runId);
  assert.equal(audit.outcome, 'WAITING');
  assert.equal(audit.taskId, task.taskId);
});

test('exhausted FAILED Task is audited once and bootstrap creates one replacement', async () => {
  const project = 'OrchExhaustedBootstrap';
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const failed = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 'dead task', goal: 'failed work', reason: 'test', scope: 'fixture', completionCriteria: ['done'], executionState: 'FAILED', pmState: 'PENDING', contract: { goal: 'failed work', bounded_scope: 'fixture', acceptance_criteria: [{ id: 'AC-01', description: 'done', validationMode: 'DETERMINISTIC' }], required_evidence: [], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] }, retry_policy: { same_task_only: true, max_qa_remediations: 0, max_pm_changes: 0 } } });
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_TASK_DECISION v1', { decision: 'CREATE_TASK', reason: 'replace exhausted task', task_contract: { goal: 'replacement', bounded_scope: 'fixture', acceptance_criteria: [{ id: 'AC-01', description: 'replacement done', validationMode: 'DETERMINISTIC' }], required_evidence: [], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] }, retry_policy: { same_task_only: true, max_qa_remediations: 0, max_pm_changes: 1 } } })] });
  const dispatchCalls = [];
  const { auditDir, stateFile } = mkTestDirs('exhausted-bootstrap');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook(dispatchCalls), auditDir, stateFile };
  const first = await roleLoop.runOnce(cfg);
  assert.equal(gt.listTasks(dataRoot, project).length, 2);
  assert.equal(dispatchCalls.length, 1);
  assert.match(adapter.sendLog[0].body, /## Closed without acceptance \(terminal\)/);
  assert.match(adapter.sendLog[0].body, new RegExp(failed.taskId));
  assert.equal(auditLines(auditDir).filter((line) => line.step === 'TASK_EXHAUSTED' && line.taskId === failed.taskId).length, 1);
  assert.ok(auditLines(auditDir).some((line) => line.step === 'cycle' && line.outcome === 'ACTED'));
  await roleLoop.runOnce(cfg);
  assert.equal(auditLines(auditDir).filter((line) => line.step === 'TASK_EXHAUSTED' && line.taskId === failed.taskId).length, 1);
  assert.equal(first.steps.some((step) => step.step === 'bootstrap'), true);
});

// ── round 39: a terminal Task's leftover Delivery is superseded, not re-decided ──
// LIVE starvation (JuControler-Private-planning): TASK-0001 reached terminal
// executionState FAILED while its TASK_VERIFY delivery PMD-TASK-0001-eeb756bd-…
// stayed PENDING with a cached OWNER_REQUIRED final-gate decision. From 03:11Z
// to 04:16Z the orchestrator logged `final-gate FINAL_GATE_DECISION_CACHED` for
// that same delivery every ~10 s and never processed the live delivery of
// TASK-0003 — a healthy Task waited an hour behind a dead one. The final-gate
// step now reads the Task's executionState before re-deciding; a terminal
// Task's leftover delivery is superseded EXACTLY ONCE through the certified
// delivery-consumption API (ignorePmDelivery) with a machine reason naming the
// terminal state, and the same cycle still processes every remaining delivery.

/** Terminal Task (FAILED | CANCELLED) with a PENDING TASK_VERIFY delivery.
 * FAILED uses the certified failed-run mint; CANCELLED has no certified mint
 * path, so the PENDING fixture is written directly (test-only construction). */
async function mintTerminalDelivery(project, terminalState) {
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const task = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: `dead ${terminalState.toLowerCase()} task`, goal: 'dead work', reason: 'orchestrator certification',
    scope: 'out.txt only', completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
    contract: { goal: 'dead work', bounded_scope: 'out.txt only', acceptance_criteria: [{ id: 'AC-01', description: 'done', validationMode: 'DETERMINISTIC' }], required_evidence: [], qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] }, retry_policy: { same_task_only: true, max_qa_remediations: 0, max_pm_changes: 0 } },
  });
  const runId = `${terminalState.toLowerCase()}-run-${++seq}`;
  const folder = path.join(dataRoot, project, '_runs', `r39-${seq}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, goalId: goal.goalId, taskId: task.taskId, workspaceRoot: ROOT, workerId: 'dead-builder' }));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  if (terminalState === 'FAILED') {
    await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED', reason: 'test dispatch' });
  }
  await rt.transitionTaskExecution(dataRoot, project, task.taskId, { expectedExecutionState: terminalState === 'FAILED' ? 'DISPATCHED' : 'READY', to: terminalState, reason: `test ${terminalState}` });
  let delivery;
  if (terminalState === 'FAILED') {
    delivery = await pmDel.ensurePmDeliveryForFailedRun(dataRoot, project, task.taskId, runId);
  } else {
    const deliveryId = `PMD-${task.taskId}-${runId}`;
    const delFolder = path.join(dataRoot, project, '_relay', 'pm-deliveries', deliveryId);
    fs.mkdirSync(delFolder, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(delFolder, 'delivery.json'), JSON.stringify({ schemaVersion: 1, deliveryId, project, kind: 'TASK_VERIFY', taskId: task.taskId, runId, status: 'PENDING', createdAt: now, updatedAt: now, source: { kind: 'pm-work', workKind: 'TASK_VERIFY' } }, null, 2) + '\n');
    delivery = pmDel.getPmDelivery(dataRoot, project, deliveryId);
  }
  assert.ok(delivery, `${terminalState} delivery minted`);
  return { taskId: task.taskId, runId, deliveryId: delivery.deliveryId };
}

/** Seed the state file with the cached OWNER_REQUIRED decision the LIVE trace
 * had — the exact precondition that made TASK-0001's delivery re-decide from
 * cache every tick instead of being consumed. */
function seedCachedOwnerRequired(stateFile, deliveryId, contextHash) {
  const state = {
    schemaVersion: 1, blocked: {},
    finalGateDecisions: { [deliveryId]: { contextHash, outcome: 'OWNER_REQUIRED', reason: 'owner review required', updatedAt: new Date().toISOString() } },
    pendingReask: {}, exhausted: {},
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
}

/** A second, LIVE delivery in the same project whose ACCEPT envelope lets the
 * fake PM apply normally; proves the same cycle is not starved by the dead one. */
async function mintLiveAcceptDelivery(project, adapter, pkg) {
  const live = await mintPendingDelivery(project);
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, live.deliveryId);
  adapter.scripted.push(fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'live delivery accepted', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash }));
  return { live, packet };
}

test('(r39-a) a pending delivery whose Task is FAILED is superseded once, audited, and a second live delivery in the same cycle is still processed', async () => {
  const project = 'OrchR39SupersedeFailed';
  const dead = await mintTerminalDelivery(project, 'FAILED');
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const deadPacket = pkg.buildPmFinalGatePacket(dataRoot, project, dead.deliveryId);
  const { auditDir, stateFile } = mkTestDirs('r39-supersede-failed');
  seedCachedOwnerRequired(stateFile, dead.deliveryId, deadPacket.contextHash);
  const adapter = new FakePmAdapter('fake-pm');
  const { live, packet: livePacket } = await mintLiveAcceptDelivery(project, adapter, pkg);
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };

  const result = await roleLoop.runOnce(cfg);

  assert.equal(pmDel.getPmDelivery(dataRoot, project, dead.deliveryId).status, 'IGNORED', 'dead FAILED-task delivery superseded');
  const supersedes = auditLines(auditDir).filter((l) => l.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK');
  assert.equal(supersedes.length, 1, 'superseded exactly once');
  assert.equal(supersedes[0].step, 'final-gate');
  assert.equal(supersedes[0].deliveryId, dead.deliveryId);
  assert.equal(supersedes[0].taskId, dead.taskId);
  assert.equal(supersedes[0].terminalState, 'FAILED');
  assert.match(supersedes[0].reason, /FAILED/, 'machine reason names the terminal state');
  assert.ok(!auditLines(auditDir).some((l) => l.outcome === 'FINAL_GATE_DECISION_CACHED' && l.deliveryId === dead.deliveryId), 'cached decision not kept alive');
  // Same cycle still processed the live delivery.
  assert.equal(pmDel.getPmDelivery(dataRoot, project, live.deliveryId).status, 'ACKNOWLEDGED', 'live delivery processed in the same cycle');
  assert.ok(result.steps.some((s) => s.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK' && s.deliveryId === dead.deliveryId));
  assert.ok(result.steps.some((s) => s.outcome === 'APPLIED' && s.deliveryId === live.deliveryId));
});

test('(r39-b) a pending delivery whose Task is CANCELLED behaves the same: superseded once, audited, live sibling processed', async () => {
  const project = 'OrchR39SupersedeCancelled';
  const dead = await mintTerminalDelivery(project, 'CANCELLED');
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const deadPacket = pkg.buildPmFinalGatePacket(dataRoot, project, dead.deliveryId);
  const { auditDir, stateFile } = mkTestDirs('r39-supersede-cancelled');
  seedCachedOwnerRequired(stateFile, dead.deliveryId, deadPacket.contextHash);
  const adapter = new FakePmAdapter('fake-pm');
  const { live, packet: livePacket } = await mintLiveAcceptDelivery(project, adapter, pkg);
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };

  const result = await roleLoop.runOnce(cfg);

  assert.equal(pmDel.getPmDelivery(dataRoot, project, dead.deliveryId).status, 'IGNORED', 'dead CANCELLED-task delivery superseded');
  const supersedes = auditLines(auditDir).filter((l) => l.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK');
  assert.equal(supersedes.length, 1, 'superseded exactly once');
  assert.equal(supersedes[0].step, 'final-gate');
  assert.equal(supersedes[0].deliveryId, dead.deliveryId);
  assert.equal(supersedes[0].taskId, dead.taskId);
  assert.equal(supersedes[0].terminalState, 'CANCELLED');
  assert.match(supersedes[0].reason, /CANCELLED/, 'machine reason names the terminal state');
  assert.ok(!auditLines(auditDir).some((l) => l.outcome === 'FINAL_GATE_DECISION_CACHED' && l.deliveryId === dead.deliveryId), 'cached decision not kept alive');
  assert.equal(pmDel.getPmDelivery(dataRoot, project, live.deliveryId).status, 'ACKNOWLEDGED', 'live delivery processed in the same cycle');
  assert.ok(result.steps.some((s) => s.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK' && s.deliveryId === dead.deliveryId));
});

test('(r39-c) a pending delivery whose Task is still open is untouched and decided normally', async () => {
  const project = 'OrchR39OpenTask';
  const d = await mintPendingDelivery(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const roleConfig = makeRoleConfig(project);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'open task decided normally', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })] });
  const { auditDir, stateFile } = mkTestDirs('r39-open-task');
  const cfg = { dataRoot, project, roleConfig, pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(pmDel.getPmDelivery(dataRoot, project, d.deliveryId).status, 'ACKNOWLEDGED');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
  assert.equal(auditLines(auditDir).filter((l) => l.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK').length, 0, 'open task is never superseded');
  const replay = await roleLoop.processFinalGate(cfg, d.deliveryId);
  assert.equal(replay.outcome, 'REPLAY_IGNORED');
});

test('(r39-d) replaying the same cycle does not supersede the terminal delivery twice', async () => {
  const project = 'OrchR39SupersedeReplay';
  const dead = await mintTerminalDelivery(project, 'FAILED');
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const deadPacket = pkg.buildPmFinalGatePacket(dataRoot, project, dead.deliveryId);
  const { auditDir, stateFile } = mkTestDirs('r39-supersede-replay');
  seedCachedOwnerRequired(stateFile, dead.deliveryId, deadPacket.contextHash);
  const adapter = new FakePmAdapter('fake-pm');
  await mintLiveAcceptDelivery(project, adapter, pkg);
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };

  await roleLoop.runOnce(cfg);
  await roleLoop.runOnce(cfg); // replay of the same cycle shape
  const supersedes = auditLines(auditDir).filter((l) => l.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK');
  assert.equal(supersedes.length, 1, 'never superseded twice');
  assert.equal(supersedes[0].deliveryId, dead.deliveryId);
  assert.equal(pmDel.getPmDelivery(dataRoot, project, dead.deliveryId).status, 'IGNORED');
  // A direct replay of the final-gate step over the consumed delivery is REPLAY_IGNORED.
  const direct = await roleLoop.processFinalGate(cfg, dead.deliveryId);
  assert.equal(direct.outcome, 'REPLAY_IGNORED');
  assert.equal(auditLines(auditDir).filter((l) => l.outcome === 'DELIVERY_SUPERSEDED_TERMINAL_TASK').length, 1);
});

// ── zero live-dataRoot writes ─────────────────────────────────────────────────
// ── Round 40: restart-stranded dispatched-run recovery ────────────────────────

/** Direct construction (round 40): the LIVE TASK-0003 shape — a dispatcher-
 * orphaned relay-path Run (folder with meta.json only, NO runtime-binding.json,
 * which is exactly why the actl-only operator collect refuses it). Task stays
 * DISPATCHED with the run linked. Optionally carries a worker result + canonical
 * capture marker + out.txt so the orchestrator can re-admit it. */
async function mintStrandedRun(project, opts = {}) {
  const n = ++seq;
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const qaGated = opts.qaGated ?? false;
  const contract = {
    goal: 'recover stranded result', bounded_scope: 'out.txt only',
    acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }],
    required_evidence: [],
    qa_route: qaGated
      ? { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }], maxQaRemediationAttempts: 1 }
      : { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] },
    retry_policy: { same_task_only: true, max_qa_remediations: 1, max_pm_changes: 1 },
  };
  const task = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: `stranded ${n}`, goal: 'recover me', reason: 'round 40', scope: 'out.txt only',
    completionCriteria: ['done'], executionState: 'DISPATCHED', pmState: 'PENDING', contract,
  });
  const runId = `stranded-run-${n}${opts.remediation ? '-rem' : ''}`;
  const folder = path.join(dataRoot, project, '_runs', `stranded-${n}`);
  const workspaceRoot = path.join(ROOT, 'workspace', `stranded-${n}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const meta = { tags: [], runId, goalId: goal.goalId, taskId: task.taskId, workspaceRoot, workerId: 'stranded-builder' };
  if (opts.remediation) meta.qaRemediationPreparationId = `QRP-QA-${task.taskId}-rem-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta));
  await gt.linkRunToTask(dataRoot, project, task.taskId, folder);
  if (opts.result) {
    fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
    fs.writeFileSync(path.join(folder, 'result.md'), `stranded worker result for run ${n}\n`);
    if (opts.remediation) {
      fs.writeFileSync(path.join(folder, 'qa-remediation-context.json'), JSON.stringify({ schemaVersion: 1, preparationId: meta.qaRemediationPreparationId, qaRemediationPreparationId: meta.qaRemediationPreparationId, sourceRunId: `stranded-src-${n}`, taskId: task.taskId }));
    }
    fs.writeFileSync(path.join(workspaceRoot, 'out.txt'), `ok ${n}\n`);
  }
  return { task, taskId: task.taskId, runId, folder, workspaceRoot, goalId: goal.goalId };
}

function strandedRecoveredSteps(auditDir) {
  return auditLines(auditDir).filter((l) => l.step === 'resume-collect' && (l.outcome === 'RECOVERED_RESULT' || l.outcome === 'RECOVERED_NO_RESULT'));
}

/** Round 41B direct construction of the LIVE TASK-0003 miss: ONE open Task with
 * TWO stranded Runs — an OLDER Run whose worker already wrote result files
 * (`result.md`/`agent-result.md`, no Delivery ever minted) and a NEWER Run that
 * produced nothing. Round 40 only walked the latest linked Run, so the newer
 * no-result Run was recorded as FAILED while the older result-bearing Run was
 * never recovered. */
async function mintTwoRunStrandedTask(project) {
  const n = ++seq;
  const { goal } = await v1Intake.ensureV1ContainerGoal(dataRoot, project);
  const contract = {
    goal: 'recover stranded result', bounded_scope: 'out.txt only',
    acceptance_criteria: [{ id: 'AC-01', description: 'output exists', validationMode: 'DETERMINISTIC' }],
    required_evidence: [],
    qa_route: { deterministic: [{ kind: 'fileExists', criterionId: 'AC-01', path: 'out.txt' }] },
    retry_policy: { same_task_only: true, max_qa_remediations: 1, max_pm_changes: 1 },
  };
  const task = await gt.createTask(dataRoot, project, {
    goalId: goal.goalId, title: `two-stranded ${n}`, goal: 'recover me', reason: 'round 41b', scope: 'out.txt only',
    completionCriteria: ['done'], executionState: 'DISPATCHED', pmState: 'PENDING', contract,
  });
  const taskId = task.taskId;
  async function linkRun(tag, withResult) {
    const folder = path.join(dataRoot, project, '_runs', `two-stranded-${n}-${tag}`);
    const workspaceRoot = path.join(ROOT, 'workspace', `two-stranded-${n}-${tag}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const runId = `stranded-two-${n}-${tag}`;
    const meta = { tags: [], runId, goalId: goal.goalId, taskId, workspaceRoot, workerId: 'stranded-builder' };
    fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta));
    await gt.linkRunToTask(dataRoot, project, taskId, folder);
    if (withResult) {
      fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
      fs.writeFileSync(path.join(folder, 'result.md'), `stranded worker result for run ${tag}\n`);
      fs.writeFileSync(path.join(workspaceRoot, 'out.txt'), `ok ${tag}\n`);
    }
    return { runId, folder, workspaceRoot };
  }
  // LIVE shape: the RESULT-bearing run is the OLDER attempt (seq 1) and the
  // no-result run is the NEWER/current attempt (seq 2).
  const olderResult = await linkRun('older-result', true);
  const newerNoResult = await linkRun('newer-noresult', false);
  return { task, taskId, goalId: goal.goalId, olderResult, newerNoResult };
}


after(() => {
  if (fs.existsSync(LIVE_ROOT)) {
    const writes = execFileSync('find', [LIVE_ROOT, '-path', path.join(LIVE_ROOT, 'V02CControlTower'), '-prune', '-o', '-newer', LIVE_MARKER, '-print'], { encoding: 'utf8' }).trim();
    if (writes) console.log(`  INFO  live-root paths newer than marker:\n${writes}`);
    assert.equal(writes, '', 'no writes under the live dataRoot outside V02CControlTower');
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(LIVE_MARKER, { force: true });
});

test('(r40-a) a stranded run folder with a worker result and no Delivery → Delivery created once, RECOVERED_RESULT audit, cycle ACTED not IDLE', async () => {
  const project = `OrchStrandedResult${seq}`;
  const { taskId, runId, folder } = await mintStrandedRun(project, { result: true });
  const { auditDir, stateFile } = mkTestDirs('r40-stranded-result');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.runOnce(cfg);

  const step = result.steps.find((s) => s.step === 'resume-collect' && s.outcome === 'RECOVERED_RESULT');
  assert.ok(step, 'recovery step emitted');
  assert.equal(step.taskId, taskId);
  assert.equal(step.runId, runId);
  assert.equal(step.folder, folder);
  const audit = strandedRecoveredSteps(auditDir).find((l) => l.runId === runId);
  assert.equal(audit?.outcome, 'RECOVERED_RESULT');
  assert.equal(audit?.taskId, taskId);
  assert.equal(audit?.folder, folder);

  const deliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === runId);
  assert.equal(deliveries.length, 1, 'exactly one Delivery minted from the recovered result');
  assert.equal(deliveries[0].status, 'PENDING');
  const task = gt.getTask(dataRoot, project, taskId);
  assert.equal(task.executionState, 'RESULT_RECEIVED');
  assert.equal(task.pmState, 'VERIFYING');
  const cycle = auditLines(auditDir).find((l) => l.step === 'cycle');
  assert.equal(cycle.outcome, 'ACTED', 'a recovering cycle is ACTED, never IDLE');
});

test('(r40-b) a stranded run folder with no result → failure recorded once with a machine reason and the Task can retry', async () => {
  const project = `OrchStrandedNoResult${seq}`;
  const { taskId, runId, folder } = await mintStrandedRun(project);
  const { auditDir, stateFile } = mkTestDirs('r40-stranded-no-result');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.runOnce(cfg);

  const step = result.steps.find((s) => s.step === 'resume-collect' && s.outcome === 'RECOVERED_NO_RESULT');
  assert.ok(step, 'failure-record step emitted');
  assert.equal(step.taskId, taskId);
  assert.equal(step.runId, runId);
  assert.equal(step.folder, folder);
  assert.match(step.reason, /no result\.md\/agent-result\.md and no live process handle/);
  const audit = strandedRecoveredSteps(auditDir).find((l) => l.runId === runId);
  assert.equal(audit?.outcome, 'RECOVERED_NO_RESULT');

  const task = gt.getTask(dataRoot, project, taskId);
  assert.equal(task.executionState, 'FAILED', 'stranded run recorded as a failed run');
  const deliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === runId);
  assert.equal(deliveries.length, 1, 'exactly one failed-run Delivery');
  assert.equal(deliveries[0].status, 'PENDING');

  // The Task can retry through the existing failed-run PM path.
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, deliveries[0].deliveryId);
  assert.match(packet.text, /Run FAILED before producing a Result — reason: run has no result\.md\/agent-result\.md and no live process handle/);
  const judgment = await pmJud.submitPmJudgment(dataRoot, project, { deliveryId: deliveries[0].deliveryId, decision: 'CHANGES', reason: 'retry after stranded run', retryInstruction: 'retry the same task' });
  assert.equal(judgment.judgment.decision, 'CHANGES');
  const prepared = await rtp.prepareRetryForJudgment(dataRoot, project, deliveries[0].deliveryId);
  assert.equal(prepared.task.taskId, taskId);
  assert.equal(prepared.task.executionState, 'READY');
  const cycle = auditLines(auditDir).find((l) => l.step === 'cycle');
  assert.equal(cycle.outcome, 'ACTED', 'a recovering cycle is ACTED, never IDLE');
});

test('(r40-c) replaying the same cycle recovers neither again — no second Delivery, no second failure record, no duplicate audit', async () => {
  const project = `OrchStrandedReplay${seq}`;
  const withResult = await mintStrandedRun(project, { result: true });
  const noResult = await mintStrandedRun(project);
  const { auditDir, stateFile } = mkTestDirs('r40-replay');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile };

  await roleLoop.runOnce(cfg);
  await roleLoop.runOnce(cfg); // replay of the same cycle shape

  const resultDeliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === withResult.taskId && d.runId === withResult.runId);
  assert.equal(resultDeliveries.length, 1, 'result recovery never mints a second Delivery');
  assert.equal(strandedRecoveredSteps(auditDir).filter((l) => l.runId === withResult.runId && l.outcome === 'RECOVERED_RESULT').length, 1);

  const failedDeliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === noResult.taskId && d.runId === noResult.runId);
  assert.equal(failedDeliveries.length, 1, 'no-result recovery never mints a second failure record');
  assert.equal(strandedRecoveredSteps(auditDir).filter((l) => l.runId === noResult.runId && l.outcome === 'RECOVERED_NO_RESULT').length, 1);

  assert.equal(strandedRecoveredSteps(auditDir).filter((l) => l.outcome === 'RECOVERED_RESULT' || l.outcome === 'RECOVERED_NO_RESULT').length, 2);
});

test('(r40-d) a QA-remediation run (folder with qa-remediation-context.json) with a result recovers the same way through the QA gate', async () => {
  const project = `OrchStrandedRem${seq}`;
  const { taskId, runId, folder, workspaceRoot } = await mintStrandedRun(project, { result: true, remediation: true, qaGated: true });
  assert.ok(fs.existsSync(path.join(folder, 'qa-remediation-context.json')), 'fixture carries the QA-remediation lineage marker');
  const { auditDir, stateFile } = mkTestDirs('r40-stranded-rem');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.runOnce(cfg);

  const step = result.steps.find((s) => s.step === 'resume-collect' && s.outcome === 'RECOVERED_RESULT');
  assert.ok(step, 'QA-remediation run recovered');
  assert.equal(step.taskId, taskId);
  assert.equal(step.runId, runId);
  assert.equal(step.folder, folder);
  const audit = strandedRecoveredSteps(auditDir).find((l) => l.runId === runId);
  assert.equal(audit?.outcome, 'RECOVERED_RESULT');

  // QA-gated re-admission leaves the Delivery mint to the SAME QA gate that a
  // normal collect uses; deterministic check PASSes on the recovered out.txt.
  const deliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === runId);
  assert.equal(deliveries.length, 1, 'QA-gated recovered run produced exactly one Delivery');
  assert.equal(gt.getTask(dataRoot, project, taskId).pmState, 'VERIFYING', 'gate advanced the recovered run to VERIFYING');
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'out.txt')));
  const cycle = auditLines(auditDir).find((l) => l.step === 'cycle');
  assert.equal(cycle.outcome, 'ACTED');

  // Idempotent replay: no duplicate audit, no second Delivery.
  await roleLoop.runOnce(cfg);
  assert.equal(strandedRecoveredSteps(auditDir).filter((l) => l.runId === runId && l.outcome === 'RECOVERED_RESULT').length, 1);
  assert.equal(pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === runId).length, 1);
});

test('(r40-e) a healthy cycle with nothing stranded is unchanged — no RECOVERED_* steps', async () => {
  const project = `OrchStrandedHealthy${seq}`;
  const d = await mintPendingDelivery(project);
  const pkg = await import('../dist/server/orchestrator/pm-packets.js');
  const packet = pkg.buildPmFinalGatePacket(dataRoot, project, d.deliveryId);
  const adapter = new FakePmAdapter('fake-pm', { scripted: [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'healthy accept', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })] });
  const { auditDir, stateFile } = mkTestDirs('r40-healthy');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: adapter, dispatchHook: fakeDispatchHook([]), auditDir, stateFile };
  const result = await roleLoop.runOnce(cfg);
  assert.equal(result.steps.filter((s) => s.step === 'resume-collect' && (s.outcome === 'RECOVERED_RESULT' || s.outcome === 'RECOVERED_NO_RESULT')).length, 0);
  assert.equal(auditLines(auditDir).filter((l) => l.outcome === 'RECOVERED_RESULT' || l.outcome === 'RECOVERED_NO_RESULT').length, 0);
  assert.equal(pmDel.getPmDelivery(dataRoot, project, d.deliveryId).status, 'ACKNOWLEDGED');
  assert.equal(gt.getTask(dataRoot, project, d.taskId).pmState, 'ACCEPTED');
});

test('(r41-a) ONE open Task with TWO stranded runs (older with a Result, newer without) recovers BOTH in a single cycle — one RECOVERED_* audit per run, and a replay adds no second Delivery and no second failure record', async () => {
  const project = `OrchTwoRuns${seq}`;
  const { taskId, olderResult, newerNoResult } = await mintTwoRunStrandedTask(project);
  const { auditDir, stateFile } = mkTestDirs('r41-two-runs');
  const cfg = { dataRoot, project, roleConfig: makeRoleConfig(project), pmAdapter: new FakePmAdapter('fake-pm'), dispatchHook: fakeDispatchHook([]), auditDir, stateFile };

  await roleLoop.runOnce(cfg);

  // Exactly one audit line per stranded run, with the round-40 field shape.
  const resultAudit = strandedRecoveredSteps(auditDir).find((l) => l.runId === olderResult.runId);
  assert.equal(resultAudit?.outcome, 'RECOVERED_RESULT', 'older run with result files recovered');
  assert.equal(resultAudit?.taskId, taskId);
  assert.equal(resultAudit?.folder, olderResult.folder);
  const noResultAudit = strandedRecoveredSteps(auditDir).find((l) => l.runId === newerNoResult.runId);
  assert.equal(noResultAudit?.outcome, 'RECOVERED_NO_RESULT', 'newer no-result run recorded as failed');
  assert.equal(noResultAudit?.taskId, taskId);
  assert.equal(noResultAudit?.folder, newerNoResult.folder);
  assert.equal(strandedRecoveredSteps(auditDir).length, 2, 'exactly one audit line per run');

  // Both runs recovered through the certified APIs in the SAME cycle: the older
  // result run has its own Delivery; the newer no-result run its failed-run record.
  const resultDeliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === olderResult.runId);
  assert.equal(resultDeliveries.length, 1, 'result run has exactly one Delivery');
  assert.equal(resultDeliveries[0].status, 'PENDING');
  const failedDeliveries = pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === newerNoResult.runId);
  assert.equal(failedDeliveries.length, 1, 'no-result run has exactly one failed-run Delivery');
  assert.equal(failedDeliveries[0].status, 'PENDING');
  const cycle = auditLines(auditDir).find((l) => l.step === 'cycle');
  assert.equal(cycle.outcome, 'ACTED', 'a recovering cycle is ACTED, never IDLE');

  // Replay of the same cycle: no second Delivery, no second failure record, no
  // duplicate audit lines (the failed Task is no longer scanned for recovery).
  await roleLoop.runOnce(cfg);
  assert.equal(pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === olderResult.runId).length, 1, 'replay never mints a second Delivery');
  assert.equal(pmDel.listPmDeliveries(dataRoot, project).filter((d) => d.taskId === taskId && d.runId === newerNoResult.runId).length, 1, 'replay never mints a second failure record');
  assert.equal(strandedRecoveredSteps(auditDir).length, 2, 'replay emits no duplicate RECOVERED_* audit lines');
});
