/**
 * WBS-4 / V1-01 — TASK_CONTRACT v1 tests (disposable dataRoot only).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-contract-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
const LIVE_ROOT = path.join(os.homedir(), '.local', 'share', 'AgentRelay', 'data');
const LIVE_MARKER = path.join(os.tmpdir(), `arl-v1-contract-live-${process.pid}`);
fs.writeFileSync(LIVE_MARKER, `${new Date().toISOString()}\n`);

const gt = await import('../dist/server/backend/goal-task.js');
const tc = await import('../dist/server/backend/task-contract.js');
const qaAttempt = await import('../dist/server/backend/qa-attempt.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmCtx = await import('../dist/server/backend/pm-verification-context.js');
const { ensureRunId } = await import('../dist/server/backend/fs.js');

const project = 'V1ContractProj';

const AC = [
  { id: 'AC-01', description: 'file exists', validationMode: 'DETERMINISTIC' },
  { id: 'AC-02', description: 'content is correct', validationMode: 'SEMANTIC' },
];
const QA_ROUTE = {
  deterministic: [
    { kind: 'fileExists', path: '.g6-dogfood/v1.txt', criterionId: 'AC-01' },
    { kind: 'diffScope', allowedPaths: ['.g6-dogfood/v1.txt'] },
  ],
  semantic: { qaWorkerId: 'claude-code' },
};

async function mintGoal() {
  return gt.createGoal(TEST_ROOT, project, {
    title: 'V1 contract goal',
    goalStatement: 'Prove TASK_CONTRACT v1',
    completionCriteria: ['contract frozen'],
    permissionPolicy: { mode: 'BYPASS' },
  });
}

async function mintContractTask(goalId, extras = {}) {
  return gt.createTask(TEST_ROOT, project, {
    goalId,
    title: 'V1 contract task',
    goal: 'Write .g6-dogfood/v1.txt correctly',
    reason: 'WBS-4 test',
    scope: 'Only .g6-dogfood/v1.txt',
    completionCriteria: ['file correct'],
    contract: {
      goal: 'Write .g6-dogfood/v1.txt correctly',
      bounded_scope: 'Only .g6-dogfood/v1.txt',
      acceptance_criteria: AC,
      qa_route: QA_ROUTE,
      required_evidence: ['diff --stat'],
      ...extras,
    },
  });
}

test('1. createTask with contract → persisted; hash stable across re-read', async () => {
  const goal = await mintGoal();
  const task = await mintContractTask(goal.goalId);
  assert.ok(task.contract, 'contract persisted');
  assert.equal(task.contract.schema_version, 'task-contract.v1');
  assert.match(task.contract.contract_hash, /^[0-9a-f]{64}$/);
  assert.equal(task.acceptanceCriteria?.[0]?.id, 'AC-01');
  assert.equal(task.qaContract?.semantic?.qaWorkerId, 'claude-code');
  const again = gt.getTask(TEST_ROOT, project, task.taskId);
  assert.equal(again.contract.contract_hash, task.contract.contract_hash);
  const revFile = path.join(
    TEST_ROOT, project, '_relay', 'task-contracts', task.taskId, 'rev-1.json',
  );
  assert.ok(fs.existsSync(revFile), 'rev-1.json written');
});

test('2. same inputs different key order → same hash', async () => {
  const a = tc.buildTaskContract({
    project: 'P',
    task_id: 'TASK-0001',
    goal: 'g',
    bounded_scope: 'Only .g6-dogfood/v1.txt',
    acceptance_criteria: AC,
    qa_route: QA_ROUTE,
    required_evidence: ['diff --stat', 'test output'],
  });
  const shuffledAc = [
    { validationMode: 'SEMANTIC', description: 'content is correct', id: 'AC-02' },
    { validationMode: 'DETERMINISTIC', description: 'file exists', id: 'AC-01' },
  ];
  // Note: array order is significant for criteria list identity in validate;
  // key-order independence is about object key serialization.
  const b = tc.computeContractHash({
    ...a,
    // rebuild payload with different key insertion order
    contract_hash: undefined,
  });
  const c = tc.computeContractHash({
    schema_version: a.schema_version,
    task_id: a.task_id,
    project: a.project,
    owner_gate_conditions: a.owner_gate_conditions,
    retry_policy: a.retry_policy,
    qa_route: a.qa_route,
    required_evidence: a.required_evidence,
    acceptance_criteria: a.acceptance_criteria,
    bounded_scope: a.bounded_scope,
    goal: a.goal,
    contract_revision: a.contract_revision,
  });
  assert.equal(a.contract_hash, c);
  assert.equal(a.contract_hash, b);
  void shuffledAc;
});

test('3. field change → new hash only via explicit revision path', async () => {
  const goal = await mintGoal();
  const task = await mintContractTask(goal.goalId);
  const h1 = task.contract.contract_hash;
  const revised = gt.reviseTaskContract(TEST_ROOT, project, task.taskId, {
    goal: 'Write .g6-dogfood/v1.txt correctly (clarified)',
    revision_reason: 'clarify goal wording pre-dispatch',
  });
  assert.equal(revised.contract.contract_revision, 2);
  assert.notEqual(revised.contract.contract_hash, h1);
  assert.ok(fs.existsSync(path.join(
    TEST_ROOT, project, '_relay', 'task-contracts', task.taskId, 'rev-2.json',
  )));
});

test('4. mutation after dispatch → CONTRACT_FROZEN', async () => {
  const goal = await mintGoal();
  const task = await mintContractTask(goal.goalId);
  const runFolder = path.join(TEST_ROOT, '_runs', 'r1');
  fs.mkdirSync(runFolder, { recursive: true });
  ensureRunId(runFolder);
  await gt.linkRunToTask(TEST_ROOT, project, task.taskId, runFolder);
  assert.throws(
    () => gt.reviseTaskContract(TEST_ROOT, project, task.taskId, {
      goal: 'mutated after dispatch',
      revision_reason: 'should fail',
    }),
    (err) => {
      assert.ok(
        String(err.message).includes('CONTRACT_FROZEN') || err?.code === 'CONTRACT_FROZEN',
        `expected CONTRACT_FROZEN, got ${err}`,
      );
      return true;
    },
  );
});

test('5. getTask + verification context expose contract + hash', async () => {
  const goal = await mintGoal();
  const task = await mintContractTask(goal.goalId);
  const got = gt.getTask(TEST_ROOT, project, task.taskId);
  assert.ok(got.contract);
  assert.equal(got.contract.contract_hash, task.contract.contract_hash);

  const runFolder = path.join(TEST_ROOT, '_runs', `r-ctx-${task.taskId}`);
  fs.mkdirSync(runFolder, { recursive: true });
  // markResultReceived reads result artifacts from the run folder — create stubs
  fs.writeFileSync(path.join(runFolder, 'result.md'), 'ok\n');
  ensureRunId(runFolder);
  await gt.linkRunToTask(TEST_ROOT, project, task.taskId, runFolder);
  const linked = gt.getTask(TEST_ROOT, project, task.taskId);
  const runId = linked.linkedRuns[0].runId;
  const rt = await import('../dist/server/backend/goal-task-runtime.js');
  await rt.refreshTaskReadiness(TEST_ROOT, project, task.taskId);
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    to: 'DISPATCHED',
    expectedExecutionState: 'READY',
  });
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, runId, {
    expectedExecutionState: 'DISPATCHED',
  });
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  assert.equal(after.executionState, 'RESULT_RECEIVED');
  assert.equal(after.pmState, 'VERIFYING');
  const delivery = await pmDel.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, task.taskId);
  assert.ok(delivery);
  const ctx = pmCtx.getVerificationContextForDelivery(TEST_ROOT, project, delivery.deliveryId);
  assert.ok(ctx.task.contract);
  assert.equal(ctx.task.contract_hash, task.contract.contract_hash);
});

test('6. QA attempt snapshot carries contractHash', async () => {
  const goal = await mintGoal();
  const task = await mintContractTask(goal.goalId);
  const attempt = await qaAttempt.createQaAttempt(TEST_ROOT, project, {
    taskId: task.taskId,
    runId: 'run-contract-qa-1',
    qaAttemptNumber: 1,
    qaWorkerId: 'claude-code',
    contractHash: task.contract.contract_hash,
  });
  assert.equal(attempt.contractHash, task.contract.contract_hash);
  const again = qaAttempt.getQaAttempt(TEST_ROOT, project, attempt.qaAttemptId);
  assert.equal(again.contractHash, task.contract.contract_hash);
});

test('7. tasks without contract behave as before (opt-in)', async () => {
  const goal = await mintGoal();
  const legacy = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId,
    title: 'legacy task',
    goal: 'no contract',
    reason: 'opt-in',
    scope: 'none',
    completionCriteria: ['done'],
  });
  assert.equal(legacy.contract, undefined);
  assert.equal(legacy.acceptanceCriteria, undefined);
  assert.equal(legacy.qaContract, undefined);
  const again = gt.getTask(TEST_ROOT, project, legacy.taskId);
  assert.equal(again.contract, undefined);
});

test('live dataRoot hygiene (excluding V02CControlTower)', async () => {
  const { execFileSync } = await import('node:child_process');
  if (!fs.existsSync(LIVE_ROOT)) return;
  const out = execFileSync(
    'find',
    [LIVE_ROOT, '-path', path.join(LIVE_ROOT, 'V02CControlTower'), '-prune', '-o', '-newer', LIVE_MARKER, '-print'],
    { encoding: 'utf8' },
  ).trim();
  const lines = out ? out.split('\n').filter(Boolean) : [];
  assert.equal(lines.length, 0, `unexpected live writes: ${lines.slice(0, 5).join(', ')}`);
});
