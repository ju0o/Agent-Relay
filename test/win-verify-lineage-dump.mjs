/**
 * TEMPORARY Windows verification artifact (NOT part of the fix).
 * Lives only on ar/v1-pm-win-verify-* branches. Portable lineage dump:
 * Run 1 → deterministic PASS → semantic FAIL → QA remediation preparation
 * → SAME Task → Run 2 → Result 2 → QA PASS → one pending PM Delivery.
 * Prints exact canonical IDs as JSON. Disposable DATA_ROOT under os.tmpdir().
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const BACKEND = path.join(ROOT, 'dist', 'server', 'backend');
const imp = (p) => import(pathToFileURL(path.join(BACKEND, p)).href);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-win-lineage-'));
const PROJECT = 'WINLIN';
const NODE = process.execPath;

const gt = await imp('goal-task.js');
const rt = await imp('goal-task-runtime.js');
const qa = await imp('qa-attempt.js');
const qrp = await imp('qa-remediation-preparation.js');
const gate = await imp('qa-gate.js');
const pm = await imp('pm-delivery.js');
const wr = await imp('worker-registry.js');
const obs = await imp('observation-lock.js');
const disp = await imp('dispatcher.js');
const capture = await imp('capture-service.js');
const fixture = await imp(path.join('..', 'integrations', 'test-fixture', 'watch.js'));
fixture.ensureTestFixtureAdapterRegistered();

const QA = path.join(ROOT, 'scripts', 'fake-qa-worker.mjs');
const BUILDER = path.join(ROOT, 'scripts', 'fake-builder-worker.mjs');

disp._resetDispatcherStateForTests();
capture._resetCaptureServiceForTests();
qa._resetQaAttemptLocksForTests();
qrp._resetQaRemediationPreparationLocksForTests();
gate._resetQaGateLocksForTests();

fs.mkdirSync(path.join(DATA, 'workspace'), { recursive: true });
const counter = path.join(DATA, 'qa.count');
fs.writeFileSync(counter, '0');
wr.writeWorkerRegistryRecord(DATA, {
  schemaVersion: 'G.2', workerId: 'qa-w', launchCommand: NODE,
  launchArgsPrefix: [QA, counter], role: 'qa',
});
wr.writeWorkerRegistryRecord(DATA, {
  schemaVersion: 'G.2', workerId: 'builder', launchCommand: NODE,
  launchArgsPrefix: [BUILDER], workingDirectory: 'workspace',
  role: 'implementation', observationAdapterId: 'test-fixture',
});
const g = await gt.createGoal(DATA, PROJECT, { title: 'WIN', goalStatement: 'windows lineage' });
const t = await gt.createTask(DATA, PROJECT, {
  goalId: g.goalId, title: 'same task', goal: 'go', reason: 'r', scope: 'out.txt only',
  completionCriteria: ['done'], executionState: 'RUNNING', pmState: 'PENDING',
  acceptanceCriteria: [{ id: 'AC-SEMANTIC', description: 'correct', validationMode: 'SEMANTIC' }],
  qaContract: {
    deterministic: [{ kind: 'fileExists', path: 'out.txt' }],
    semantic: { qaWorkerId: 'qa-w' }, maxQaRemediationAttempts: 1,
  },
});

async function linkResult(n, text, ws) {
  const workspaceRoot = ws ?? path.join(DATA, 'workspace', String(n));
  const folder = path.join(DATA, PROJECT, '_runs', String(n));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const runId = `win-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'),
    JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 'builder' }));
  await gt.linkRunToTask(DATA, PROJECT, t.taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
  fs.writeFileSync(path.join(folder, 'result.md'), text);
  spawnSync(NODE, [BUILDER], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      FAKE_BUILDER_OUTPUT: path.join(workspaceRoot, 'out.txt'),
      FAKE_BUILDER_COUNTER: path.join(workspaceRoot, '.b'),
    },
  });
  obs.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId: t.taskId, runId });
  await rt.markQaResultReceived(DATA, PROJECT, t.taskId, runId);
  return { runId, folder, workspaceRoot };
}

const r1 = await linkResult(1, 'wrong');
const o1 = await gate.runOrResumeQaGate(DATA, PROJECT, t.taskId);
const preps = qrp.listQaRemediationPreparations(DATA, PROJECT);
const r2 = await linkResult(2, 'correct', r1.workspaceRoot);
const o2 = await gate.runOrResumeQaGate(DATA, PROJECT, t.taskId);
// Replay idempotency: re-running the gate must not create Run 3.
const o3 = await gate.runOrResumeQaGate(DATA, PROJECT, t.taskId);
const fin = gt.getTask(DATA, PROJECT, t.taskId);
const atts = qa.listQaAttemptsForTask(DATA, PROJECT, t.taskId);
const dels = pm.listPmDeliveries(DATA, PROJECT).filter((d) => d.taskId === t.taskId);

console.log(JSON.stringify({
  platform: process.platform,
  taskId: t.taskId,
  gate1: o1.outcome,
  gate2: o2.outcome,
  gateReplay: o3.outcome,
  linkedRuns: fin.linkedRuns.map((r) => ({ runId: r.runId, seq: r.taskRunSequence })),
  execPm: `${fin.executionState}+${fin.pmState}`,
  preps: preps.map((p) => ({ id: p.preparationId, src: p.sourceRunId, dispatched: p.dispatchedRunId ?? null, n: p.qaRemediationNumber })),
  attempts: atts.map((a) => ({ id: a.qaAttemptId, run: a.runId, final: a.finalQaStatus })),
  deliveries: dels.map((d) => ({ id: d.deliveryId, run: d.runId, status: d.status })),
}, null, 1));
