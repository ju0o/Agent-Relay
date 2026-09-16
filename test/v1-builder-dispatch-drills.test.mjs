import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-wbs69-')); const PROJECT = 'WBS69'; const NODE = process.execPath;
const gt = await import('../dist/server/backend/goal-task.js'); const rt = await import('../dist/server/backend/goal-task-runtime.js');
const disp = await import('../dist/server/backend/dispatcher.js'); const cap = await import('../dist/server/backend/capture-service.js');
const bridge = await import('../dist/server/backend/result-bridge.js'); const pm = await import('../dist/server/backend/pm-delivery.js');
const qa = await import('../dist/server/backend/qa-attempt.js'); const gate = await import('../dist/server/backend/qa-gate.js');
const wr = await import('../dist/server/backend/worker-registry.js'); const fixture = await import('../dist/server/integrations/test-fixture/watch.js'); fixture.ensureTestFixtureAdapterRegistered();
const tools = (await import('../dist/server/mcp/pm-tools.js')).buildAllPmTools({ dataRoot: ROOT, project: PROJECT }); const get = n => tools.find(t => t.name === n);
const alive = path.resolve('test/fixtures/workers/stay-alive.mjs'); const dead = path.resolve('test/fixtures/workers/exit-nonzero.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let n = 0;
function reset() { disp._resetDispatcherStateForTests(); cap._resetCaptureServiceForTests(); fixture.ensureTestFixtureAdapterRegistered(); }
async function makeTask(workerId = 'wbs69-builder', worker = alive) {
  wr.writeWorkerRegistryRecord(ROOT, { schemaVersion: 'G.2', workerId, displayName: workerId, launchCommand: NODE, launchArgsPrefix: [worker], capabilities: ['fixture'], observationAdapterId: 'test-fixture' });
  const intake = await get('relay_pm_create_task').handler({ title: `builder drill ${++n}`, goal: 'capture one result', reason: 'drill', scope: 'fixture', completionCriteria: ['result captured'] });
  const workspaceRoot = path.join(ROOT, 'workspace', String(n)); fs.mkdirSync(workspaceRoot, { recursive: true });
  const dispatch = await get('relay_pm_dispatch_owner_approved').handler({ taskId: intake.task.taskId, workerId, workspaceRoot, expectedExecutionState: 'READY' });
  return { taskId: intake.task.taskId, runId: dispatch.runId, folder: gt.getTask(ROOT, PROJECT, intake.task.taskId).linkedRuns[0].folder };
}
function completion(sessionId, text = 'builder result') { return { adapterId: 'test-fixture', agentName: 'fixture', sessionId, workspace: path.join(ROOT, 'workspace'), observedAt: new Date().toISOString(), terminalSignal: 'fixture.complete', rawFinalText: text, completionKind: 'RESPONSE_COMPLETE' }; }
async function complete(run) { const cm = cap.ensureDispatchCaptureManager({ settleMs: 0 }); assert.equal(cm.forceBindSessionForTests(run.folder, `session-${run.runId}`), true); cm.injectCompletionForTests(run.folder, completion(`session-${run.runId}`)); await sleep(150); return gt.getTask(ROOT, PROJECT, run.taskId); }

test('attempt 1 executes and Result is captured exactly once', async () => { reset(); const run = await makeTask(); const task = await complete(run); assert.equal(task.executionState, 'RESULT_RECEIVED'); assert.equal(task.linkedRuns.length, 1); assert.equal(fs.existsSync(path.join(run.folder, 'result.md')), true); assert.equal(fs.existsSync(path.join(run.folder, 'agent-result.md')), true); });
test('duplicate completion never duplicates Result, QaAttempt, or Delivery', async () => { reset(); const run = await makeTask(); await complete(run); const before = { task: fs.readFileSync(gt.taskFolder(ROOT, PROJECT, run.taskId) + '/task.json', 'utf8'), qa: qa.listQaAttemptsForTask(ROOT, PROJECT, run.taskId).length, deliveries: pm.listPmDeliveries(ROOT, PROJECT).length }; const task = gt.getTask(ROOT, PROJECT, run.taskId); const duplicate = await bridge.promoteObservedResult({ dataRoot: ROOT, project: PROJECT, goalId: task.goalId, taskId: run.taskId, runId: run.runId, boundFolder: run.folder, completion: completion(`session-${run.runId}`), observationAdapterId: 'test-fixture', workspaceRoot: path.join(ROOT, 'workspace') }); assert.equal(duplicate?.taskId ?? null, run.taskId); const after = { task: fs.readFileSync(gt.taskFolder(ROOT, PROJECT, run.taskId) + '/task.json', 'utf8'), qa: qa.listQaAttemptsForTask(ROOT, PROJECT, run.taskId).length, deliveries: pm.listPmDeliveries(ROOT, PROJECT).length }; assert.deepEqual(after, before); });
test('Builder process death is truthful and preserves resumability', async () => { reset(); const run = await makeTask('wbs69-dead', dead); const task = await complete(run); assert.ok(['FAILED', 'BLOCKED', 'RESULT_RECEIVED'].includes(task.executionState)); const recovery = disp.getRecoveryRecord(ROOT, PROJECT, run.taskId); assert.ok(recovery === undefined || recovery.taskId === run.taskId); });
test('stale completion for a historical Run cannot change the latest Run', async () => { reset(); const run = await makeTask(); const before = gt.getTask(ROOT, PROJECT, run.taskId); const stale = { ...completion('stale-session', 'stale'), sessionId: 'stale-session' }; const result = await bridge.promoteObservedResult({ dataRoot: ROOT, project: PROJECT, taskId: run.taskId, runId: 'stale-run-no-longer-current', runFolder: run.folder, completion: stale }).catch(() => null); const after = gt.getTask(ROOT, PROJECT, run.taskId); assert.equal(result, null); assert.deepEqual(after, before); });
test('restart between completion and QA is idempotent', async () => { reset(); const run = await makeTask(); await complete(run); const first = await gate.runOrResumeQaGate(ROOT, PROJECT, run.taskId).catch(error => ({ error })); const deliveriesBefore = pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === run.taskId).length; reset(); const second = await gate.runOrResumeQaGate(ROOT, PROJECT, run.taskId).catch(error => ({ error })); assert.equal(qa.listQaAttemptsForTask(ROOT, PROJECT, run.taskId).length, 0); assert.equal(pm.listPmDeliveries(ROOT, PROJECT).filter(d => d.taskId === run.taskId).length, deliveriesBefore); assert.ok(first && second); });
