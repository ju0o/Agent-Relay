import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve('.');
const NODE = process.execPath;
const FAKE_ACTL = path.join(repo, 'test/fixtures/actl/fake-actl.mjs');

async function fixture(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-orch-actl-'));
  const dataRoot = path.join(root, 'data');
  const workspaceRoot = path.join(root, 'workspace');
  const stateDir = path.join(root, 'actl-state');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const launcher = path.join(root, 'actl');
  fs.writeFileSync(launcher, `#!/usr/bin/env bash\nexec "${NODE}" "${FAKE_ACTL}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_ACTL_MODE = mode;
  process.env.FAKE_ACTL_STATE_DIR = stateDir;
  process.env.FAKE_ACTL_PANE_ID = '%fixture';

  const wr = await import('../dist/server/backend/worker-registry.js');
  const gt = await import('../dist/server/backend/goal-task.js');
  const rt = await import('../dist/server/backend/goal-task-runtime.js');
  const watch = await import('../dist/server/integrations/actl-managed/watch.js');
  const dispatcher = await import('../dist/server/backend/dispatcher.js');
  const main = await import('../dist/server/orchestrator/main.js');
  watch.ensureActlManagedAdapterRegistered();
  dispatcher._resetDispatcherStateForTests();
  watch.ensureActlManagedAdapterRegistered();

  const project = `OrchActl${mode.replace(/[^A-Za-z]/g, '')}`;
  const actl = { contractVersion: 1, runtimeId: 'rt_orch_fixture', agentKind: 'codex', expectedProfileRoot: path.join(root, 'codex-home'), socketPath: path.join(root, 'tmux.sock') };
  fs.mkdirSync(actl.expectedProfileRoot, { recursive: true });
  fs.writeFileSync(actl.socketPath, 'fixture');
  const workerId = 'w-orch-actl';
  wr.writeWorkerRegistryRecord(dataRoot, { schemaVersion: 'G.2', workerId, role: 'implementation', launchCommand: launcher, launchArgsPrefix: [], observationAdapterId: 'actl-managed', driverOptions: { actl } });
  const roleConfig = { schema_version: 'role-config.v1', project, assignments: [{ roleId: 'builder', runtimeAdapterId: `actl-managed:${workerId}`, workspace: { project, workspaceRoot }, sessionPolicy: 'per-task', permissionProfile: 'write-workspace', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true }], graph: [] };
  const goal = await gt.createGoal(dataRoot, project, { title: 'fixture goal', goalStatement: 'dispatch one fixture task', completionCriteria: ['done'], permissionPolicy: { mode: 'BYPASS' } });
  const task = await gt.createTask(dataRoot, project, { goalId: goal.goalId, title: 'fixture task', goal: 'dispatch one fixture task', reason: 'test', scope: 'fixture', completionCriteria: ['ACTL_TEST_OK'] });
  await rt.refreshTaskReadiness(dataRoot, project, task.taskId);
  return { root, dataRoot, project, workspaceRoot, taskId: task.taskId, roleConfig, main };
}

test('failed initial dispatch can prepare and send exactly one same-Task retry through actl', async () => {
  const f = await fixture('reject-send-clean');
  const gt = await import('../dist/server/backend/goal-task.js');
  const pmDel = await import('../dist/server/backend/pm-delivery.js');
  const pmJud = await import('../dist/server/backend/pm-judgment.js');
  const retryPrep = await import('../dist/server/backend/retry-preparation.js');
  const retryDispatch = await import('../dist/server/backend/retry-dispatch.js');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  await assert.rejects(() => hook(f.dataRoot, f.project, gt.getTask(f.dataRoot, f.project, f.taskId)), /rejected send cleanly/);
  const failed = gt.getTask(f.dataRoot, f.project, f.taskId);
  const sourceRun = failed.linkedRuns[0];
  const delivery = await pmDel.ensurePmDeliveryForFailedRun(f.dataRoot, f.project, f.taskId, sourceRun.runId);
  const judgment = await pmJud.submitPmJudgment(f.dataRoot, f.project, { deliveryId: delivery.deliveryId, decision: 'CHANGES', reason: 'retry after clean dispatch failure', retryInstruction: 'send the same task again' });
  const prep = await retryPrep.prepareRetryForJudgment(f.dataRoot, f.project, delivery.deliveryId);
  assert.equal(prep.preparation.status, 'READY');
  process.env.FAKE_ACTL_MODE = 'final-same-poll';
  const outcomes = await retryDispatch.reconcileReadyRetryDispatches(f.dataRoot, f.project);
  assert.equal(outcomes.filter((o) => o.outcome === 'dispatched').length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(f.root, 'actl-state', 'state.json'), 'utf8'));
  assert.equal(state.sendCount, 2, 'initial failed send plus exactly one retry send');
  const retried = gt.getTask(f.dataRoot, f.project, f.taskId);
  assert.equal(retried.linkedRuns.length, 2, 'retry remains linked to the same Task');
  assert.equal(retried.taskId, f.taskId);
  assert.equal(judgment.judgment.decision, 'CHANGES');
});

test('orchestrator default dispatch installs the owner permit and dispatches once through fake actl', async () => {
  const f = await fixture('final-same-poll');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  const result = await hook(f.dataRoot, f.project, (await import('../dist/server/backend/goal-task.js')).getTask(f.dataRoot, f.project, f.taskId));
  const gt = await import('../dist/server/backend/goal-task.js');
  const task = gt.getTask(f.dataRoot, f.project, f.taskId);
  const fakeState = JSON.parse(fs.readFileSync(path.join(f.root, 'actl-state', 'state.json'), 'utf8'));
  assert.ok(result.runId);
  assert.equal(task.linkedRuns.length, 1);
  assert.equal(fakeState.sendCount, 1);
  assert.equal(fakeState.sent, true);
});

test('INPUT_STATE_UNKNOWN with the Codex idle prompt grants a permit and dispatches once', async () => {
  const f = await fixture('status-unknown-idle');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  const result = await hook(f.dataRoot, f.project, (await import('../dist/server/backend/goal-task.js')).getTask(f.dataRoot, f.project, f.taskId));
  const state = JSON.parse(fs.readFileSync(path.join(f.root, 'actl-state', 'state.json'), 'utf8'));
  assert.ok(result.runId);
  assert.equal(state.sendCount, 1);
});

test('INPUT_STATE_UNKNOWN with a busy marker refuses dispatch', async () => {
  const f = await fixture('status-unknown-busy');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  const gt = await import('../dist/server/backend/goal-task.js');
  await assert.rejects(() => hook(f.dataRoot, f.project, gt.getTask(f.dataRoot, f.project, f.taskId)), /not idle at its prompt|unable to capture idle prompt/);
  assert.equal(gt.getTask(f.dataRoot, f.project, f.taskId).linkedRuns.length, 0);
});

test('INPUT_STATE_UNKNOWN without a snapshot refuses dispatch fail-closed', async () => {
  const f = await fixture('status-unknown-missing');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  const gt = await import('../dist/server/backend/goal-task.js');
  await assert.rejects(() => hook(f.dataRoot, f.project, gt.getTask(f.dataRoot, f.project, f.taskId)), /unable to capture idle prompt/);
  assert.equal(gt.getTask(f.dataRoot, f.project, f.taskId).linkedRuns.length, 0);
});

test('orchestrator refuses a busy fake actl pane before leaving a Run behind', async () => {
  const f = await fixture('status-busy');
  const hook = f.main.defaultDispatchHook(f.dataRoot, f.roleConfig);
  const gt = await import('../dist/server/backend/goal-task.js');
  await assert.rejects(() => hook(f.dataRoot, f.project, gt.getTask(f.dataRoot, f.project, f.taskId)), /not idle at its prompt|unable to capture idle prompt/);
  assert.equal(gt.getTask(f.dataRoot, f.project, f.taskId).linkedRuns.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'actl-state', 'state.json')), false, 'busy preflight refuses before actl reserve/send');
});
