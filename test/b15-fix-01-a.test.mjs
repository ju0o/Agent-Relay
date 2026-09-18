import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(os.tmpdir(), `arl-b15-fix-a-${process.pid}-${Date.now()}`);
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const fake = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/actl/fake-actl.mjs');
// POSIX: extensionless bash launcher (shebang + exec bit) runs under production's
// shell:false spawn. Windows: CreateProcess cannot execute a bash/shebang script
// with shell:false (ENOENT before any JSON reaches the fake) — shell:true/cmd.exe
// stay forbidden — so compile the tiny test-only C# launcher fixture (Repair 05
// pattern: same Node fake-actl.mjs, argv forwarded verbatim, stdio pumped as raw
// bytes, exit code propagated) to a real .exe under the disposable root.
// launchArgsPrefix stays [] on both platforms; production is untouched.
const launcherSh = path.join(root, 'actl');
fs.writeFileSync(launcherSh, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
function resolveLauncher() {
  if (process.platform !== 'win32') return launcherSh;
  const exe = path.join(root, 'actl.exe');
  if (!fs.existsSync(exe)) {
    const cs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/actl/fake-actl-launcher.cs');
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const r = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(cs)})) -OutputAssembly ${q(exe)} -OutputType ConsoleApplication`,
    ], { shell: false, encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(exe)) {
      throw new Error(`fake actl launcher .exe compile failed (status=${r.status}): ${(r.stderr || '').slice(0, 500)}`);
    }
  }
  return exe;
}
const launcher = resolveLauncher();
if (process.platform === 'win32') {
  process.env.FAKE_ACTL_NODE_BIN = process.execPath;
  process.env.FAKE_ACTL_SCRIPT = fake;
}
const profile = path.join(root, 'codex-home');
fs.mkdirSync(profile, { recursive: true });
const socket = path.join(root, 'tmux.sock');
fs.writeFileSync(socket, 'fixture');

const wr = await import('../dist/server/backend/worker-registry.js');
const bridge = await import('../dist/server/backend/actl-bridge.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const v1Dispatch = await import('../dist/server/backend/v1-dispatch.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const delivery = await import('../dist/server/backend/pm-delivery.js');
const judgment = await import('../dist/server/backend/pm-judgment.js');
const evidence = await import('../dist/server/backend/evidence.js');
const retryPreparation = await import('../dist/server/backend/retry-preparation.js');
const retryDispatch = await import('../dist/server/backend/retry-dispatch.js');
const capture = await import('../dist/server/backend/capture-service.js');
const watch = await import('../dist/server/integrations/actl-managed/watch.js');

const project = 'B15FixA';
let passed = 0;
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (ok) passed++; else failed++; };
const bridgeSource = fs.readFileSync(path.resolve('src/backend/actl-bridge.ts'), 'utf8');
const opBlock = bridgeSource.match(/export type ActlRuntimeOp =([\s\S]*?);/)?.[1] ?? '';
check(!opBlock.includes("'captureAck'"), 'ActlRuntimeOp excludes invented captureAck operation');
check(['status', 'discover', 'reserve', 'send', 'collect', 'interrupt'].every(op => opBlock.includes(`'${op}'`))
  && opBlock.match(/'status'/g)?.length === 1, 'ActlRuntimeOp contains exactly the real operation set');
const envFor = stateDir => ({ ...process.env, FAKE_ACTL_STATE_DIR: stateDir });
const actlOpts = { contractVersion: 1, runtimeId: 'rt_b15', agentKind: 'codex', expectedProfileRoot: profile, socketPath: socket };

wr.writeWorkerRegistryRecord(root, {
  schemaVersion: 'G.2', workerId: 'w-b15', launchCommand: launcher, launchArgsPrefix: [],
  observationAdapterId: 'actl-managed', driverOptions: { actl: actlOpts },
});
watch.ensureActlManagedAdapterRegistered();
disp._resetDispatcherStateForTests();
await capture._resetCaptureServiceForTests();

async function task(title) {
  const goal = await gt.createGoal(root, project, { title: `G-${title}`, goalStatement: 'g', completionCriteria: ['done'], permissionPolicy: { mode: 'BYPASS' } });
  const created = await gt.createTask(root, project, { goalId: goal.goalId, title, goal: 'complete fixture', reason: 'test', scope: 'fixture', completionCriteria: ['ACTL_TEST_OK'] });
  await rt.refreshTaskReadiness(root, project, created.taskId);
  return gt.getTask(root, project, created.taskId);
}

async function dispatchOne(title, stateDir, permitFactory, decision = 'ACCEPT', ownerApproved = false) {
  process.env.FAKE_ACTL_STATE_DIR = stateDir;
  process.env.FAKE_ACTL_MODE = 'happy';
  bridge.setActlInputPermitFactory(permitFactory);
  const t = await task(title);
  let result;
  try {
    const input = { taskId: t.taskId, workerId: 'w-b15', expectedExecutionState: 'READY', workspaceRoot: workspace };
    result = ownerApproved
      ? await v1Dispatch.dispatchV1OwnerApproved(root, project, { ...input, ownerInputPermitFactory: permitFactory })
      : await disp.dispatchTask(root, project, input);
  } catch (error) {
    return { task: gt.getTask(root, project, t.taskId), error, state: JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')) };
  }
  const after = gt.getTask(root, project, t.taskId);
  const d = delivery.listPmDeliveries(root, project).find(item => item.taskId === t.taskId && item.runId === result.runId);
  const accepted = await judgment.submitPmJudgment(root, project, {
    deliveryId: d.deliveryId, decision, reason: decision === 'ACCEPT' ? 'closeout acceptance' : 'request changes',
    ...(decision === 'CHANGES' ? { retryInstruction: 'fixture change instruction' } : {}),
  });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  return { task: after, result, accepted, state };
}

const happyDir = path.join(root, 'happy'); fs.mkdirSync(happyDir);
const happy = await dispatchOne('successful closeout', happyDir, args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash }));
// Launch evidence: only the real fake ACTL process mints state.json (the launcher
// itself never touches it), so this cannot pass from a pre-created fixture file.
check(fs.existsSync(path.join(happyDir, 'state.json')), 'fake actl process actually executed behind the launcher (state.json minted)');
check(happy.accepted?.task.pmState === 'ACCEPTED', 'ACCEPT applies canonical task state');
const happyReservation = Object.values(happy.state.reservations)[0];
check(happyReservation.captureAck?.kind === 'FINAL_CAPTURE' && happyReservation.captureAck?.resultId, 'successful FINAL performs captureAck');
check(happyReservation.state === 'RELEASED', 'successful ACCEPT releases reservation');

const reused = await bridge.invokeActlRuntime(launcher, 'reserve', {
  contractVersion: 1, requestId: bridge.newRequestId(), operation: 'reserve', action: 'acquire', runtimeId: actlOpts.runtimeId,
  mode: 'MANAGED', expectedContext: { agentKind: 'codex', profileRoot: profile, workspaceRoot: workspace }, ...bridge.scopeFields(socket),
}, { env: envFor(happyDir) });
check(reused.envelope?.ok === true, 'same runtime can be reserved after closeout');
const reusedStatePath = path.join(happyDir, 'state.json');
const reusedState = JSON.parse(fs.readFileSync(reusedStatePath, 'utf8'));
reusedState.reservations[reused.envelope.data.reservationId].commandAttached = true;
fs.writeFileSync(reusedStatePath, JSON.stringify(reusedState));
const noAck = await bridge.invokeActlRuntime(launcher, 'reserve', {
  contractVersion: 1, requestId: bridge.newRequestId(), operation: 'reserve', action: 'release', runtimeId: actlOpts.runtimeId,
  reservationId: reused.envelope.data.reservationId, leaseToken: reused.envelope.data.leaseToken, fence: reused.envelope.data.fence,
  ...bridge.scopeFields(socket),
}, { env: envFor(happyDir) });
check(noAck.envelope?.ok === false && noAck.envelope?.error?.detail?.includes('captureAck required'), 'release without captureAck is rejected when command is attached');
const acceptedTask = gt.getTask(root, project, happy.result.runId ? happy.task.taskId : happy.task.taskId);
const acceptedRun = acceptedTask.linkedRuns.find(run => run.runId === happy.result.runId);
const acceptedBinding = bridge.readRuntimeBinding(acceptedRun.folder);
const duplicate = await bridge.closeActlManagedReservation(launcher, acceptedBinding, { accepted: true });
check(duplicate.closeoutStatus === 'RELEASED', 'duplicate closeout is idempotent');
const staleBinding = { ...acceptedBinding, reservationId: reused.envelope.data.reservationId, closeoutStatus: undefined };
let staleError;
try { await bridge.closeActlManagedReservation(launcher, staleBinding, { accepted: true }); } catch (error) { staleError = error; }
check(staleError?.code === 'BUSY', 'stale fence/lease cannot close a newer reservation');
const recoveredBinding = {
  ...acceptedBinding,
  reservationId: reused.envelope.data.reservationId,
  leaseToken: reused.envelope.data.leaseToken,
  fence: reused.envelope.data.fence,
  closeoutStatus: 'CAPTURE_ACKED',
};
await bridge.closeActlManagedReservation(launcher, recoveredBinding, { accepted: true });
const recoveredState = JSON.parse(fs.readFileSync(path.join(happyDir, 'state.json'), 'utf8'));
check(Object.values(recoveredState.reservations).some(r => r.reservationId === reused.envelope.data.reservationId && r.state === 'RELEASED'), 'FINAL with unfinished closeout recovers at release');

const changesDir = path.join(root, 'changes'); fs.mkdirSync(changesDir);
const changes = await dispatchOne('changes evidence', changesDir, args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash }), 'CHANGES', true);
check(!evidence.listEvidenceForRun(root, project, changes.result.runId).some(item => item.type === 'PM_DECISION'), 'CHANGES does not mint PM_DECISION evidence');
const changesDeliveryId = `PMD-${changes.task.taskId}-${changes.result.runId}`;
await retryPreparation.prepareRetryForJudgment(root, project, changesDeliveryId);
const retry = await retryDispatch.dispatchV1Retry(root, project, { deliveryId: changesDeliveryId });
check(retry.runId && retry.runId !== changes.result.runId, 'CHANGES releases before same-runtime retry re-reserves');

const changesFailDir = path.join(root, 'changes-closeout-fail'); fs.mkdirSync(changesFailDir);
process.env.FAKE_ACTL_STATE_DIR = changesFailDir; process.env.FAKE_ACTL_MODE = 'happy';
bridge.setActlInputPermitFactory(args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash }));
const changesFailTask = await task('changes closeout failure');
const changesFailDispatch = await disp.dispatchTask(root, project, {
  taskId: changesFailTask.taskId, workerId: 'w-b15', expectedExecutionState: 'READY', workspaceRoot: workspace,
});
const changesFailDelivery = delivery.listPmDeliveries(root, project)
  .find(item => item.taskId === changesFailTask.taskId && item.runId === changesFailDispatch.runId);
const changesFailRun = gt.getTask(root, project, changesFailTask.taskId).linkedRuns
  .find(run => run.runId === changesFailDispatch.runId);
const changesFailBinding = bridge.readRuntimeBinding(changesFailRun.folder);
fs.writeFileSync(path.join(changesFailRun.folder, 'runtime-binding.json'), JSON.stringify({ ...changesFailBinding, fence: 'stale-fence' }) + '\n');
let changesFailureResult;
try {
  changesFailureResult = await judgment.submitPmJudgment(root, project, {
    deliveryId: changesFailDelivery.deliveryId, decision: 'CHANGES', reason: 'closeout failure remains durable',
    retryInstruction: 'continue bounded retry',
  });
} catch (error) { changesFailureResult = { error }; }
check(changesFailureResult?.judgment?.status === 'RECEIVED', 'CHANGES closeout failure does not throw after durable commit');
let retryPreparationAfterCloseout;
try {
  retryPreparationAfterCloseout = await retryPreparation.prepareRetryForJudgment(root, project, changesFailDelivery.deliveryId);
} catch (error) { retryPreparationAfterCloseout = { error }; }
check(!retryPreparationAfterCloseout?.error, 'CHANGES retry continuation runs after closeout warning');

const permitDir = path.join(root, 'permit-fail'); fs.mkdirSync(permitDir);
const permitFail = await dispatchOne('permit failure', permitDir, async () => { throw new Error('OWNER_REQUIRED'); });
check(permitFail.error, 'missing Owner permit fails closed');
check(Object.values(permitFail.state.reservations).every(r => r.state === 'RELEASED'), 'permit failure releases unused reservation');
const unapproved = await task('unapproved permit provider');
let unapprovedError;
try {
  await disp.dispatchTask(root, project, {
    taskId: unapproved.taskId, workerId: 'w-b15', expectedExecutionState: 'READY', workspaceRoot: workspace,
    ownerInputPermitFactory: () => bridge.buildDefaultInputPermit({ commandId: 'x', runtimeId: 'x', fence: 'x', snapshotHash: 'x' }),
  });
} catch (error) { unapprovedError = error; }
check(unapprovedError?.code === 'INVALID_ARGUMENT', 'production permit provider requires Owner approval context');

const rejectDir = path.join(root, 'clean-reject'); fs.mkdirSync(rejectDir);
const cleanReject = await dispatchOne('clean send rejection', rejectDir, args => bridge.buildDefaultInputPermit({ ...args, snapshotHash: args.currentSnapshotHash }));
// The fake is switched only for this process invocation; use direct fake mode for a second task.
process.env.FAKE_ACTL_MODE = 'reject-send-clean';
const rejectTask = await task('clean send rejection 2');
let rejectError;
try { await disp.dispatchTask(root, project, { taskId: rejectTask.taskId, workerId: 'w-b15', expectedExecutionState: 'READY', workspaceRoot: workspace }); } catch (error) { rejectError = error; }
const rejectState = JSON.parse(fs.readFileSync(path.join(rejectDir, 'state.json'), 'utf8'));
check(rejectError && rejectError.code !== 'DELIVERY_AMBIGUOUS', 'clean send rejection is not ambiguous');
check(Object.values(rejectState.reservations).every(r => r.state === 'RELEASED'), 'clean send rejection releases reservation');

const ambDir = path.join(root, 'ambiguous'); fs.mkdirSync(ambDir);
process.env.FAKE_ACTL_STATE_DIR = ambDir; process.env.FAKE_ACTL_MODE = 'ambiguous-send';
const ambTask = await task('ambiguous send');
let ambError;
try { await disp.dispatchTask(root, project, { taskId: ambTask.taskId, workerId: 'w-b15', expectedExecutionState: 'READY', workspaceRoot: workspace }); } catch (error) { ambError = error; }
const ambState = JSON.parse(fs.readFileSync(path.join(ambDir, 'state.json'), 'utf8'));
check(ambError?.code === 'DELIVERY_AMBIGUOUS', 'ambiguous send remains DELIVERY_AMBIGUOUS');
check(Object.values(ambState.reservations).every(r => r.state === 'HELD'), 'ambiguous send is not auto-released');

bridge.setActlInputPermitFactory(null);
console.log(`B15 FIX A tests: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
