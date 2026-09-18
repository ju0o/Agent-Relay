import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-b15-fix-03-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const fake = path.join(repo, 'test/fixtures/actl/fake-actl.mjs');
// Cross-platform fake executable: production still spawns one absolute
// executable with shell:false; the test uses Node plus a preload that remaps
// the synthetic "runtime <op> --request-stdin" invocation to fake-actl.mjs.
const launcher = process.execPath;
const preload = path.join(root, 'fake-actl-preload.mjs');
fs.writeFileSync(preload, [
  "import * as path from 'node:path';",
  `if (path.basename(process.argv[1] ?? '') === 'runtime') {`,
  `  process.argv = [process.argv[0], ${JSON.stringify(fake)}, 'runtime', ...process.argv.slice(2)];`,
  `  await import(${JSON.stringify(pathToFileURL(fake).href)});`,
  '}',
  '',
].join('\n'), 'utf8');
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ');
const profile = path.join(root, 'codex-home');
fs.mkdirSync(profile, { recursive: true });
const socket = path.join(root, 'tmux.sock');
fs.writeFileSync(socket, 'fixture');

const bridge = await import('../dist/server/backend/actl-bridge.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const delivery = await import('../dist/server/backend/pm-delivery.js');
const judgment = await import('../dist/server/backend/pm-judgment.js');
const evidence = await import('../dist/server/backend/evidence.js');
const capture = await import('../dist/server/backend/capture-service.js');
const watch = await import('../dist/server/integrations/actl-managed/watch.js');
const taskActions = await import('../dist/server/backend/task-actions.js');

const project = 'B15Fix03';
let passed = 0;
let failed = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (ok) passed += 1; else failed += 1;
};

// ── kept behavioral / contract checks ───────────────────────────────────────
const bridgeSource = fs.readFileSync(path.join(repo, 'src/backend/actl-bridge.ts'), 'utf8');
const opBlock = bridgeSource.match(/export type ActlRuntimeOp =([\s\S]*?);/)?.[1] ?? '';
check(!opBlock.includes("'captureAck'"), 'operation set still excludes captureAck');

const actlOpts = { contractVersion: 1, runtimeId: 'rt_fix03', agentKind: 'codex', expectedProfileRoot: profile, socketPath: socket };
wr.writeWorkerRegistryRecord(root, {
  schemaVersion: 'G.2', workerId: 'w-fix03', launchCommand: launcher, launchArgsPrefix: [],
  observationAdapterId: 'actl-managed', driverOptions: { actl: actlOpts },
});
watch.ensureActlManagedAdapterRegistered();
disp._resetDispatcherStateForTests();
await capture._resetCaptureServiceForTests();

async function makeTask(title) {
  const goal = await gt.createGoal(root, project, { title: `G-${title}`, goalStatement: 'g', completionCriteria: ['done'], permissionPolicy: { mode: 'BYPASS' } });
  const created = await gt.createTask(root, project, { goalId: goal.goalId, title, goal: 'complete fixture', reason: 'test', scope: 'fixture', completionCriteria: ['ACTL_TEST_OK'] });
  await rt.refreshTaskReadiness(root, project, created.taskId);
  return gt.getTask(root, project, created.taskId);
}

async function dispatchToVerifying(title, stateDir, permitFactory) {
  process.env.FAKE_ACTL_STATE_DIR = stateDir;
  process.env.FAKE_ACTL_MODE = 'happy';
  bridge.setActlInputPermitFactory(permitFactory ?? (args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash })));
  const t = await makeTask(title);
  const result = await disp.dispatchTask(root, project, { taskId: t.taskId, workerId: 'w-fix03', expectedExecutionState: 'READY', workspaceRoot: workspace });
  const after = gt.getTask(root, project, t.taskId);
  const d = delivery.listPmDeliveries(root, project).find(item => item.taskId === t.taskId && item.runId === result.runId);
  return { task: after, result, delivery: d };
}

const readReservations = dir => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).reservations;
const allReleased = dir => Object.values(readReservations(dir)).every(r => r.state === 'RELEASED');
const anyHeld = dir => Object.values(readReservations(dir)).some(r => r.state === 'HELD');

// ── replaced: "shared closeout helper is exported" (was source grep) ────────
check(typeof bridge.closeActlManagedReservationForTask === 'function', 'shared closeout helper is exported');

// ── replaced: "relay_pm_accept_result reaches canonical closeout path" ──────
// submitPmJudgment(ACCEPT) routes through acceptTaskResult(callerSurface: PM_MCP),
// the same canonical path the relay_pm_accept_result MCP tool reaches.
const acceptDir = path.join(root, 'pm-accept'); fs.mkdirSync(acceptDir);
const acceptDispatch = await dispatchToVerifying('pm accept closeout', acceptDir);
const acceptResult = await judgment.submitPmJudgment(root, project, {
  deliveryId: acceptDispatch.delivery.deliveryId, decision: 'ACCEPT', reason: 'closeout acceptance',
});
check(acceptResult.task.pmState === 'ACCEPTED' && allReleased(acceptDir), 'relay_pm_accept_result reaches canonical closeout path');

// ── replaced: "OWNER_IPC accept reaches canonical closeout path" ───────────
// Call acceptTaskResult directly with callerSurface OWNER_IPC (the main.ts IPC path).
const ownerDir = path.join(root, 'owner-accept'); fs.mkdirSync(ownerDir);
const ownerDispatch = await dispatchToVerifying('owner accept closeout', ownerDir);
const ownerAfter = await taskActions.acceptTaskResult({
  dataRoot: root, project, goalId: ownerDispatch.task.goalId,
  taskId: ownerDispatch.task.taskId, runId: ownerDispatch.result.runId,
  expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', callerSurface: 'OWNER_IPC',
});
check(ownerAfter.pmState === 'ACCEPTED' && allReleased(ownerDir), 'OWNER_IPC accept reaches canonical closeout path');

// ── replaced: "PM CHANGES uses shared guarded closeout" (was source grep) ───
// submitPmJudgment(CHANGES) calls closeActlManagedReservationForTask directly.
const changesDir = path.join(root, 'pm-changes'); fs.mkdirSync(changesDir);
const changesDispatch = await dispatchToVerifying('pm changes closeout', changesDir);
await judgment.submitPmJudgment(root, project, {
  deliveryId: changesDispatch.delivery.deliveryId, decision: 'CHANGES',
  reason: 'request changes closeout', retryInstruction: 'fixture change instruction',
});
check(allReleased(changesDir), 'PM CHANGES uses shared guarded closeout');

// ── replaced: "canonical ACCEPT and CHANGES call shared closeout" ──────────
// Exercise taskActions.requestTaskChanges (the canonical CHANGES path in
// task-actions.ts) and combine with the ACCEPT path above to prove both
// branches call the shared closeout helper.
const taskChangesDir = path.join(root, 'task-changes'); fs.mkdirSync(taskChangesDir);
const taskChangesDispatch = await dispatchToVerifying('task actions changes', taskChangesDir);
await taskActions.requestTaskChanges({
  dataRoot: root, project, goalId: taskChangesDispatch.task.goalId,
  taskId: taskChangesDispatch.task.taskId, runId: taskChangesDispatch.result.runId,
  reason: 'canonical task-actions changes request', expectedExecutionState: 'RESULT_RECEIVED',
  expectedPmState: 'VERIFYING', callerSurface: 'PM_MCP',
});
check(allReleased(taskChangesDir) && allReleased(ownerDir), 'canonical ACCEPT and CHANGES call shared closeout');

// ── replaced: "RUNNING-CAS failure keeps the reservation held" ──────────────
// Register a worker whose launcher delays collect, dispatch, then race the
// DISPATCHED → RUNNING CAS by concurrently transitioning the Task to FAILED.
// The failure handler must NOT release the actl reservation.
const casDir = path.join(root, 'running-cas'); fs.mkdirSync(casDir);
wr.writeWorkerRegistryRecord(root, {
  schemaVersion: 'G.2', workerId: 'w-cas', launchCommand: launcher, launchArgsPrefix: [],
  observationAdapterId: 'actl-managed', driverOptions: { actl: actlOpts },
});
process.env.FAKE_ACTL_STATE_DIR = casDir;
process.env.FAKE_ACTL_MODE = 'happy';
process.env.FAKE_ACTL_COLLECT_DELAY_MS = '300';
bridge.setActlInputPermitFactory(args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash }));
const casTask = await makeTask('running cas failure');
const casDispatchP = disp.dispatchTask(root, project, {
  taskId: casTask.taskId, workerId: 'w-cas', expectedExecutionState: 'READY', workspaceRoot: workspace,
});
// Wait until the dispatcher has committed READY → DISPATCHED (so the
// reservation is held and the delayed collect is in flight), then force the
// Task out of DISPATCHED so the RUNNING CAS (DISPATCHED → RUNNING) fails.
// Polling avoids racing the CAS on slow machines where the reserve/status
// child-process spawns take longer than a fixed delay.
let casReady = false;
for (let i = 0; i < 400; i++) {
  await new Promise(resolve => setTimeout(resolve, 5));
  if (gt.getTask(root, project, casTask.taskId).executionState === 'DISPATCHED') { casReady = true; break; }
}
let casTransitionError;
if (casReady) {
  try {
    await rt.transitionTaskExecution(root, project, casTask.taskId, {
      expectedExecutionState: 'DISPATCHED', to: 'FAILED', reason: 'test: force RUNNING-CAS failure',
    });
  } catch (err) { casTransitionError = err; }
}
let casError;
try { await casDispatchP; } catch (err) { casError = err; }
check(casReady && !casTransitionError && casError?.code === 'CONFLICT' && anyHeld(casDir), 'RUNNING-CAS failure keeps the reservation held');
delete process.env.FAKE_ACTL_COLLECT_DELAY_MS;
disp._resetDispatcherStateForTests();
bridge.setActlInputPermitFactory(null);

// ── replaced: "PM evidence remains ACCEPT-only and replay-deduped" ──────────
// ACCEPT mints exactly one PM_DECISION evidence; CHANGES mints none; replaying
// the identical ACCEPT is idempotent (no duplicate PM_DECISION).
const acceptEvidence = evidence.listEvidenceForRun(root, project, acceptDispatch.result.runId);
const acceptPmDecisions = acceptEvidence.filter(e => e.type === 'PM_DECISION');
await judgment.submitPmJudgment(root, project, {
  deliveryId: acceptDispatch.delivery.deliveryId, decision: 'ACCEPT', reason: 'closeout acceptance',
});
const acceptPmDecisionsAfterReplay = evidence.listEvidenceForRun(root, project, acceptDispatch.result.runId).filter(e => e.type === 'PM_DECISION');
const changesPmDecisions = evidence.listEvidenceForRun(root, project, changesDispatch.result.runId).filter(e => e.type === 'PM_DECISION');
check(acceptPmDecisions.length === 1 && acceptPmDecisionsAfterReplay.length === 1 && changesPmDecisions.length === 0, 'PM evidence remains ACCEPT-only and replay-deduped');

// ── kept behavioral checks (actl bridge direct fixture contract) ───────────
const stateDir = path.join(root, 'fixture-state'); fs.mkdirSync(stateDir);
const env = { ...process.env, FAKE_ACTL_STATE_DIR: stateDir };
const acquire = {
  contractVersion: 1, requestId: bridge.newRequestId(), operation: 'reserve', action: 'acquire',
  runtimeId: 'rt_fix03', mode: 'MANAGED', expectedContext: { agentKind: 'codex', profileRoot: root, workspaceRoot: root },
  ...bridge.scopeFields(path.join(root, 'tmux.sock')),
};
const acquired = await bridge.invokeActlRuntime(launcher, 'reserve', acquire, { env });
const reservation = acquired.envelope.data;
const release = {
  contractVersion: 1, requestId: bridge.newRequestId(), operation: 'reserve', action: 'release',
  runtimeId: 'rt_fix03', reservationId: reservation.reservationId, leaseToken: reservation.leaseToken,
  fence: reservation.fence, captureAck: { kind: 'RECONCILE', commandId: '', disposition: 'FAILED', acknowledged: true },
  ...bridge.scopeFields(path.join(root, 'tmux.sock')),
};
const first = await bridge.invokeActlRuntime(launcher, 'reserve', release, { env });
const second = await bridge.invokeActlRuntime(launcher, 'reserve', { ...release, requestId: bridge.newRequestId() }, { env });
check(first.envelope?.ok === true && second.envelope?.error?.code === 'INVALID_ARGUMENT'
  && /already released/i.test(second.envelope.error.detail), 'fixture rejects a second release like real actl');
const stored = Object.values(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).reservations)[0];
process.env.FAKE_ACTL_STATE_DIR = stateDir;
const binding = {
  schemaVersion: 1, relayInstanceId: 'relay', project: 'p', taskId: 't', runId: 'r', runtimeId: 'rt_fix03',
  agentKind: 'codex', expectedProfileRoot: root, socketPath: path.join(root, 'tmux.sock'), workspaceRoot: root,
  commandId: '', wirePromptSha256: 'x', reservationId: reservation.reservationId, leaseToken: reservation.leaseToken,
  fence: stored.fence, collectStatus: 'RESERVED', updatedAt: new Date().toISOString(),
};
binding.reservationId = stored.reservationId;
binding.leaseToken = stored.leaseToken;
const reconciled = await bridge.closeActlManagedReservation(launcher, binding, { disposition: 'FAILED' });
check(reconciled.closeoutStatus === 'RELEASED', 'production closeout reconciles exact already-released reservation');

console.log(`B15 FIX 03 tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
