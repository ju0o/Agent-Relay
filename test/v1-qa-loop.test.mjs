import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-wbs67-')); const PROJECT = 'WBS67'; const NODE = process.execPath;
const gt = await import('../dist/server/backend/goal-task.js'); const rt = await import('../dist/server/backend/goal-task-runtime.js');
const qa = await import('../dist/server/backend/qa-attempt.js'); const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const gate = await import('../dist/server/backend/qa-gate.js'); const pm = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const wr = await import('../dist/server/backend/worker-registry.js'); const obs = await import('../dist/server/backend/observation-lock.js');
const disp = await import('../dist/server/backend/dispatcher.js'); const capture = await import('../dist/server/backend/capture-service.js');
const fsKernel = await import('../dist/server/backend/fs.js'); const fixture = await import('../dist/server/integrations/test-fixture/watch.js'); fixture.ensureTestFixtureAdapterRegistered();
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');
const packets = await import('../dist/server/orchestrator/pm-packets.js');
const QA = path.resolve('scripts/fake-qa-worker.mjs'); const BUILDER = path.resolve('scripts/fake-builder-worker.mjs');
const fence = (header, object) => `\`\`\`json\n${header}\n${JSON.stringify(object)}\n\`\`\``;
let sequence = 0;
function reset() { disp._resetDispatcherStateForTests(); capture._resetCaptureServiceForTests(); qa._resetQaAttemptLocksForTests(); qrp._resetQaRemediationPreparationLocksForTests(); gate._resetQaGateLocksForTests(); }
async function setup({ qaWorker = null } = {}) {
  fs.mkdirSync(path.join(ROOT, 'workspace'), { recursive: true });
  const counter = path.join(ROOT, `qa-${++sequence}.count`); fs.writeFileSync(counter, qaWorker === 'pass' ? '1' : '0');
  const qaWorkerId = qaWorker === 'crash' ? 'qa-crash' : `qa-${sequence}`;
  const blockedThenPass = path.join(ROOT, `qa-blocked-then-pass-${sequence}.mjs`);
  if (qaWorker === 'blocked-then-pass') fs.writeFileSync(blockedThenPass, "import fs from 'node:fs'; const f=process.argv[2]; const n=Number(fs.readFileSync(f,'utf8'))+1; fs.writeFileSync(f,String(n)); if(n<=2) process.exit(9); console.log('status: PASS'); console.log('criteria:'); console.log('- AC-SEMANTIC: PASS');\n", 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, { schemaVersion: 'G.2', workerId: qaWorkerId, launchCommand: NODE, launchArgsPrefix: qaWorker === 'crash' ? ['-e', 'process.exit(9)'] : qaWorker === 'blocked-then-pass' ? [blockedThenPass, counter] : [QA, counter], role: 'qa' });
  wr.writeWorkerRegistryRecord(ROOT, { schemaVersion: 'G.2', workerId: `builder-${sequence}`, launchCommand: NODE, launchArgsPrefix: [BUILDER], workingDirectory: 'workspace', role: 'implementation', observationAdapterId: 'test-fixture' });
  const g = await gt.createGoal(ROOT, PROJECT, { title: 'WBS67', goalStatement: 'QA loop' });
  const t = await gt.createTask(ROOT, PROJECT, { goalId: g.goalId, title: 'same task', goal: 'make output correct', reason: 'proof', scope: 'out.txt only', completionCriteria: ['done'], executionState: 'RUNNING', pmState: 'PENDING', acceptanceCriteria: [{ id: 'AC-SEMANTIC', description: 'output is correct', validationMode: 'SEMANTIC' }], qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId }, maxQaRemediationAttempts: 1 } });
  return { task: t, builderId: `builder-${sequence}` };
}
async function linkResult(taskId, n, builderId, text = 'result', existingWorkspace, correctOutput = false) {
  const workspaceRoot = existingWorkspace ?? path.join(ROOT, 'workspace', String(n)); const folder = path.join(ROOT, PROJECT, '_runs', String(n)); fs.mkdirSync(workspaceRoot, { recursive: true }); fs.mkdirSync(folder, { recursive: true });
  const runId = `wbs67-run-${n}`; fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: builderId })); await gt.linkRunToTask(ROOT, PROJECT, taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true }); fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}'); fs.writeFileSync(path.join(folder, 'result.md'), text);
  spawnSync(NODE, [BUILDER], { cwd: workspaceRoot, env: { ...process.env, FAKE_BUILDER_OUTPUT: path.join(workspaceRoot, 'out.txt'), FAKE_BUILDER_COUNTER: path.join(workspaceRoot, '.builder-attempt') } }); if (correctOutput) fs.writeFileSync(path.join(workspaceRoot, 'out.txt'), 'correct'); obs.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId, runId }); await rt.markQaResultReceived(ROOT, PROJECT, taskId, runId); return { runId, folder, workspaceRoot };
}
async function finishCurrent(taskId, builderId, n, text) { const r = await linkResult(taskId, n, builderId, text); const out = await gate.runOrResumeQaGate(ROOT, PROJECT, taskId); return { r, out }; }

test('Result 1 → QA FAIL → same-Task remediation → Result 2 → QA PASS → one pending Delivery', async () => {
  reset(); const { task, builderId } = await setup(); const first = await finishCurrent(task.taskId, builderId, 1, 'wrong result'); assert.equal(first.out.outcome, 'FAIL_REMEDIATION_DISPATCHED');
  const afterFail = gt.getTask(ROOT, PROJECT, task.taskId); assert.equal(afterFail.taskId, task.taskId); assert.equal(afterFail.linkedRuns.length, 2); assert.equal(qrp.listQaRemediationPreparations(ROOT, PROJECT).length, 1); assert.equal(qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId)[0].finalQaStatus, 'FAIL');
  const secondRun = await linkResult(task.taskId, 2, builderId, 'correct result', first.r.workspaceRoot); const secondOut = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId); assert.equal(secondOut.outcome, 'PASS_DELIVERED'); const attempts = qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId); assert.equal(attempts.length, 2); assert.equal(attempts[1].finalQaStatus, 'PASS'); const deliveries = pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === task.taskId); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].status, 'PENDING');
});
test('duplicate completion and restart reconciliation are idempotent', async () => { reset(); const { task, builderId } = await setup({ qaWorker: 'pass' }); const first = await linkResult(task.taskId, 3, builderId, 'correct result', undefined, true); const initial = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId); assert.equal(initial.outcome, 'PASS_DELIVERED'); const before = qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId).length; await rt.markQaResultReceived(ROOT, PROJECT, task.taskId, first.runId); const replay = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId); assert.equal(replay.outcome, 'PASS_DELIVERED'); reset(); assert.equal(qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId).length, before); assert.equal(pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === task.taskId).length, 1); });
test('QA worker crash retries semantically, then escalates with a reason after the bounded budget', async () => { reset(); const { task, builderId } = await setup({ qaWorker: 'crash' }); await linkResult(task.taskId, 4, builderId, 'wrong result');
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId), /semantic retry 1\/3/);
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId), /semantic retry 2\/3/);
  const result = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId); assert.equal(result.outcome, 'BLOCKED_ESCALATED');
  const attempt = qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId)[0]; assert.equal(attempt.finalQaStatus, 'BLOCKED'); assert.ok(attempt.reason);
  const deliveries = pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === task.taskId); assert.equal(deliveries.length, 1); assert.equal(deliveries[0].status, 'PENDING');
  const packet = packets.buildPmFinalGatePacket(ROOT, PROJECT, deliveries[0].deliveryId); assert.deepEqual(packet.allowedActions, ['CHANGES', 'OWNER_REQUIRED']); assert.match(packet.text, /status: BLOCKED/); assert.match(packet.text, /reason:/); });
test('semantic BLOCKED is retried on the next cycle and can reach PASS before Delivery', async () => { reset(); const { task, builderId } = await setup({ qaWorker: 'blocked-then-pass' }); await linkResult(task.taskId, 6, builderId, 'correct result', undefined, true);
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId), /semantic retry 1\/3/);
  const second = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId); assert.equal(second.outcome, 'PASS_DELIVERED');
  const attempt = qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId)[0]; assert.equal(attempt.finalQaStatus, 'PASS'); assert.equal(attempt.reason, undefined);
  assert.equal(pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === task.taskId).length, 1); });
test('PM ACCEPT is re-asked and blocked when the delivered QA verdict is not PASS', async () => { reset(); const { task, builderId } = await setup({ qaWorker: 'crash' }); await linkResult(task.taskId, 7, builderId, 'result');
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId), /semantic retry 1\/3/);
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId), /semantic retry 2\/3/);
  await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId);
  const delivery = pm.listPmDeliveries(ROOT, PROJECT).find(d => d.taskId === task.taskId); const packet = packets.buildPmFinalGatePacket(ROOT, PROJECT, delivery.deliveryId);
  const responses = [fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'accept', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash }), fence('PM_JUDGMENT v1', { decision: 'ACCEPT', retry: 'NONE', reason: 'accept again', contract_hash: packet.context.task.contract_hash, context_hash: packet.contextHash })]; let sends = 0;
  const adapter = { id: 'qa-blocked-pm', capabilities: () => ({ freeTier: true, persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: false, shell: false, subscriptionAuth: false }), health: async () => ({ ok: true }), authMode: async () => ({ mode: 'free' }), ensureSession: async () => ({ sessionId: 'pm-session', created: true }), send: async () => ({ requestId: `r-${++sends}` }), collect: async (_s, id) => ({ text: id.startsWith('r-1') ? '' : responses.shift() }), interrupt: async () => {}, sessionIdentity: (sessionId) => ({ adapterId: 'qa-blocked-pm', sessionId }) };
  const roleConfig = { schema_version: 'role-config.v1', project: PROJECT, assignments: [{ roleId: 'pm', runtimeAdapterId: 'qa-blocked-pm', model: 'nemotron-3.5-lightning-free', workspace: { project: PROJECT, workspaceRoot: ROOT }, sessionPolicy: 'persistent', permissionProfile: 'read-only', capabilityRequirements: {}, zeroExtraBilling: true, fallbackChain: [], enabled: true }], graph: [] };
  const out = await roleLoop.processFinalGate({ dataRoot: ROOT, project: PROJECT, roleConfig, pmAdapter: adapter, dispatchHook: async () => {}, auditDir: path.join(ROOT, 'pm-audit'), stateFile: path.join(ROOT, 'pm-state.json') }, delivery.deliveryId);
  assert.equal(out.outcome, 'BLOCKED'); assert.equal(pmJud.listPmJudgments(ROOT, PROJECT).length, 0); });

test('runOnce resumes a READY QA remediation preparation through the orchestrator dispatch seam exactly once', async () => {
  reset(); const { task, builderId } = await setup(); await linkResult(task.taskId, 5, builderId, 'wrong result');
  await assert.rejects(() => gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId, { dispatchRemediation: async () => { throw new Error('simulated permit refusal'); } }), /simulated permit refusal/);
  const before = qrp.listQaRemediationPreparations(ROOT, PROJECT).find((p) => p.taskId === task.taskId); assert.equal(before?.status, 'READY'); assert.equal(before?.dispatchedRunId, undefined);
  const stateFile = path.join(ROOT, 'role-loop-state.json'); const auditDir = path.join(ROOT, 'audit'); let dispatches = 0;
  const result = await roleLoop.runOnce({ dataRoot: ROOT, project: PROJECT, roleConfig: { assignments: [] }, pmAdapter: {}, dispatchHook: async () => {}, qaRemediationDispatchHook: async (dr, project, input) => { dispatches += 1; return disp.dispatchTask(dr, project, { taskId: input.taskId, workerId: input.workerId, workspaceRoot: input.workspaceRoot, expectedExecutionState: 'READY', qaRemediationContext: { preparationId: input.preparationId, sourceRunId: input.sourceRunId, prompt: input.prompt } }); }, stateFile, auditDir });
  assert.equal(dispatches, 1); assert.equal(result.steps.filter((s) => s.step === 'qa-remediation').length, 1);
  const after = qrp.listQaRemediationPreparations(ROOT, PROJECT).find((p) => p.taskId === task.taskId); assert.ok(after?.dispatchedRunId); assert.equal(gt.getTask(ROOT, PROJECT, task.taskId).linkedRuns.length, 2);
  await roleLoop.runOnce({ dataRoot: ROOT, project: PROJECT, roleConfig: { assignments: [] }, pmAdapter: {}, dispatchHook: async () => {}, qaRemediationDispatchHook: async () => { dispatches += 1; throw new Error('duplicate dispatch'); }, stateFile, auditDir });
  assert.equal(dispatches, 1);
});
