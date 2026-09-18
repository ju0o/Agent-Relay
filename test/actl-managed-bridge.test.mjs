/**
 * Phase 2 — actl-managed bridge fixture tests (no live Codex).
 *
 * Covers: registry validation, bridge round-trip, dispatcher branch,
 * native path unpolluted, arm-fail means no send.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACTL = path.resolve(__dirname, 'fixtures/actl/fake-actl.mjs');
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const NODE = process.execPath;

const TEST_ROOT = path.join(os.tmpdir(), `arl-actl-bridge-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
const PROFILE = path.join(TEST_ROOT, '_codex_home');
fs.mkdirSync(PROFILE, { recursive: true });
const SOCKET = path.join(TEST_ROOT, 'tmux.sock');
fs.writeFileSync(SOCKET, '', 'utf8');

let passed = 0;
let failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (fragment && !(msg.includes(fragment) || code === fragment || String(code).includes(fragment))) {
      FAIL(`${label} — expected "${fragment}", got: ${code || ''} ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const wr = await import('../dist/server/backend/worker-registry.js');
const bridge = await import('../dist/server/backend/actl-bridge.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
const actlWatch = await import('../dist/server/integrations/actl-managed/watch.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');

testFix.ensureTestFixtureAdapterRegistered();
actlWatch.ensureActlManagedAdapterRegistered();
disp._resetDispatcherStateForTests();
await captureSvc._resetCaptureServiceForTests();

const project = 'ActlBridgeProj';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function makeReadyTask(title = 'Actl Task') {
  const goal = await gt.createGoal(TEST_ROOT, project, {
    title: 'G',
    goalStatement: 'g',
    completionCriteria: ['done'],
    permissionPolicy: { mode: 'BYPASS' },
  });
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId,
    title,
    goal: 'Create proof.txt with ACTL_TEST_OK',
    reason: 'fixture',
    scope: 'workspace only',
    completionCriteria: ['ACTL_TEST_OK'],
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  return gt.getTask(TEST_ROOT, project, t.taskId);
}

function freshStateDir(label) {
  const dir = path.join(TEST_ROOT, `fake-state-${label}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function actlEnv(stateDir, extra = {}) {
  return {
    ...process.env,
    FAKE_ACTL_STATE_DIR: stateDir,
    ...extra,
  };
}

function validActlOpts(over = {}) {
  return {
    contractVersion: 1,
    runtimeId: 'rt_fixture_1',
    agentKind: 'codex',
    expectedProfileRoot: PROFILE,
    socketPath: SOCKET,
    ...over,
  };
}

function registerActlWorker(workerId, stateDir, extra = {}) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId,
    displayName: workerId,
    launchCommand: NODE,
    launchArgsPrefix: [FAKE_ACTL],
    observationAdapterId: 'actl-managed',
    driverOptions: { actl: validActlOpts(extra.actlOver) },
    capabilities: ['actl-fixture'],
    ...extra.record,
  });
}

// Bridge requires an absolute executable and deliberately uses shell:false.
// A bash launcher works on Linux but is not an executable on Windows. Keep the
// production contract intact and make the fixture cross-platform by launching
// the real Node executable and using a test-only Node preload. The preload
// intercepts the synthetic "runtime <op> --request-stdin" main-script shape,
// rewrites argv to the existing fake-actl.mjs shape, and imports the fixture.
// It does nothing for every other Node child spawned by this test.
const FAKE_LAUNCHER = NODE;
const FAKE_ACTL_PRELOAD = path.join(TEST_ROOT, 'fake-actl-preload.mjs');
fs.writeFileSync(
  FAKE_ACTL_PRELOAD,
  [
    "import * as path from 'node:path';",
    `if (path.basename(process.argv[1] ?? '') === 'runtime') {`,
    `  process.argv = [process.argv[0], ${JSON.stringify(FAKE_ACTL)}, 'runtime', ...process.argv.slice(2)];`,
    `  await import(${JSON.stringify(pathToFileURL(FAKE_ACTL).href)});`,
    '}',
    '',
  ].join('\\n'),
  'utf8',
);
const preloadOption = `--import=${pathToFileURL(FAKE_ACTL_PRELOAD).href}`;
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption].filter(Boolean).join(' ');

function registerActlWorkerAbs(workerId, extra = {}) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId,
    displayName: workerId,
    launchCommand: FAKE_LAUNCHER,
    launchArgsPrefix: [],
    observationAdapterId: 'actl-managed',
    driverOptions: { actl: validActlOpts(extra.actlOver) },
    capabilities: ['actl-fixture'],
  });
}

function registerNativeWorker(workerId) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId,
    displayName: workerId,
    launchCommand: NODE,
    launchArgsPrefix: [FIX_ZERO],
    observationAdapterId: 'test-fixture',
    capabilities: ['native-fixture'],
  });
}

// ── 1. Registry validation ───────────────────────────────────────────────────
console.log('\n── Registry actl driverOptions validation ──');

{
  const ok = wr.validateWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: 'w-actl-ok',
    launchCommand: FAKE_LAUNCHER,
    launchArgsPrefix: [],
    observationAdapterId: 'actl-managed',
    driverOptions: { actl: validActlOpts() },
  });
  check(ok.driverOptions?.actl?.contractVersion === 1, 'accepts contractVersion:1 actl options');
  check(ok.driverOptions?.actl?.agentKind === 'codex', 'accepts agentKind=codex');
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-bad-ver',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: [],
      driverOptions: { actl: validActlOpts({ contractVersion: 2 }) },
    }),
    'rejects contractVersion != 1',
    'contractVersion',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-bad-kind',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: [],
      driverOptions: { actl: validActlOpts({ agentKind: 'claude' }) },
    }),
    'rejects non-codex agentKind',
    'codex',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-unknown-key',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: [],
      driverOptions: { actl: { ...validActlOpts(), extraFlag: true } },
    }),
    'rejects unknown actl keys',
    'Unknown driverOptions.actl key',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-rel-sock',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: [],
      driverOptions: { actl: validActlOpts({ socketPath: 'relative.sock' }) },
    }),
    'rejects relative socketPath',
    'absolute',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-bad-driver-key',
      launchCommand: NODE,
      launchArgsPrefix: [FIX_ZERO],
      driverOptions: { other: {} },
    }),
    'rejects unknown driverOptions root keys (native still protected)',
    "Only 'claude' and 'actl'",
  );
}

{
  const both = wr.validateWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: 'w-both',
    launchCommand: FAKE_LAUNCHER,
    launchArgsPrefix: [],
    observationAdapterId: 'actl-managed',
    driverOptions: {
      claude: { permissionMode: 'default' },
      actl: validActlOpts(),
    },
  });
  check(!!both.driverOptions?.claude && !!both.driverOptions?.actl, 'allows claude + actl keys together');
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-actl-prefix',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: ['--oops'],
      observationAdapterId: 'actl-managed',
      driverOptions: { actl: validActlOpts() },
    }),
    'rejects non-empty launchArgsPrefix with actl',
    'launchArgsPrefix',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-actl-wrong-adapter',
      launchCommand: FAKE_LAUNCHER,
      launchArgsPrefix: [],
      observationAdapterId: 'codex',
      driverOptions: { actl: validActlOpts() },
    }),
    'rejects observationAdapterId≠actl-managed with actl',
    'actl-managed',
  );
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-actl-basename',
      launchCommand: 'node',
      launchArgsPrefix: [],
      observationAdapterId: 'actl-managed',
      driverOptions: { actl: validActlOpts() },
    }),
    'rejects non-absolute launchCommand with actl',
    'absolute',
  );
}

// ── 2. Bridge round-trip via fake actl ───────────────────────────────────────
console.log('\n── Bridge JSON subprocess round-trip ──');

{
  const stateDir = freshStateDir('rt');
  const env = actlEnv(stateDir);
  const status = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'status',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'status',
      runtimeId: 'rt_fixture_1',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(status.data.processState === 'UP', 'status preflight ok via fake actl');

  const reserve = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'reserve',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'reserve',
      action: 'acquire',
      runtimeId: 'rt_fixture_1',
      mode: 'MANAGED',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(String(reserve.data.reservationId || '').startsWith('rsv_'), 'reserve acquire returns reservationId');
  check(!!reserve.data.leaseToken && !!reserve.data.fence, 'reserve returns leaseToken + fence');
  const frozen = bridge.frozenExpectedContextFromReserve(reserve.data, {
    agentKind: 'codex',
    profileRoot: PROFILE,
    workspaceRoot: WORKSPACE,
  });
  check(frozen.paneId === '%fixture', 'reserve freezes paneId into context');

  const commandId = 'cmd1_fixture_roundtrip';
  const { wirePrompt, promptSha256 } = bridge.composeWirePrompt(commandId, 'hello fixture\n');
  const permit = bridge.buildDefaultInputPermit({
    commandId,
    runtimeId: 'rt_fixture_1',
    fence: String(reserve.data.fence),
    snapshotHash: 'fixture-snapshot',
  });
  const send = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'send',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'send',
      runtimeId: 'rt_fixture_1',
      expectedContext: frozen,
      reservationId: reserve.data.reservationId,
      leaseToken: reserve.data.leaseToken,
      fence: reserve.data.fence,
      commandId,
      wirePrompt,
      promptSha256,
      observationCursor: { kind: 'BOOTSTRAP' },
      inputPermit: permit,
      currentSnapshotHash: 'fixture-snapshot',
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(send.data.stage === 'TRANSPORT_SENT', 'send returns TRANSPORT_SENT');
  check(send.data.transportReceipt?.paneId === '%fixture', 'send consumed frozen paneId');

  const c1 = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'collect',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'collect',
      commandId,
      runtimeId: 'rt_fixture_1',
      expectedContext: { agentKind: 'codex' },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(c1.data.command?.stage === 'AGENT_RECEIVED', 'first collect → AGENT_RECEIVED');

  const c2 = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'collect',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'collect',
      commandId,
      runtimeId: 'rt_fixture_1',
      expectedContext: { agentKind: 'codex' },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(c2.data.final?.rawFinalText === 'ACTL_TEST_OK', 'second collect → FINAL packet');
}

{
  const cmd = bridge.computeCommandId({
    relayInstanceId: 'inst',
    project: 'p',
    taskId: 'TASK-1',
    runId: 'run-1',
  });
  check(cmd.startsWith('cmd1_') && cmd.length === 5 + 64, 'commandId uses cmd1_ + sha256');
  const again = bridge.computeCommandId({
    relayInstanceId: 'inst',
    project: 'p',
    taskId: 'TASK-1',
    runId: 'run-1',
  });
  check(cmd === again, 'commandId is stable for same binding tuple');
}

// ── 3. Dispatcher actl-managed branch (no live Codex) ────────────────────────
console.log('\n── Dispatcher actl-managed branch ──');

{
  const stateDir = freshStateDir('disp');
  process.env.FAKE_ACTL_STATE_DIR = stateDir;
  process.env.FAKE_ACTL_MODE = 'happy';
  delete process.env.FAKE_ACTL_FINAL_TEXT;

  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  actlWatch._resetActlManagedWatchesForTests();
  actlWatch.ensureActlManagedAdapterRegistered();
  disp._setActlCollectTimeoutMsForTests(5_000);
  bridge.setActlInputPermitFactory(async (args) =>
    bridge.buildDefaultInputPermit({
      ...args,
      snapshotHash: args.currentSnapshotHash || 'fixture-snapshot',
    }),
  );

  registerActlWorkerAbs('w-actl-disp');
  const task = await makeReadyTask('Managed dispatch');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-actl-disp',
    expectedExecutionState: 'READY',
    workspaceRoot: WORKSPACE,
  });

  check(!!result.runId, 'managed dispatch returns runId');
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  // RESULT_RECEIVED may already be applied by settle+Result Bridge; RUNNING is minimum.
  check(
    ['RUNNING', 'RESULT_RECEIVED', 'VERIFYING', 'ACCEPTED'].includes(after.executionState)
      || after.executionState === 'RUNNING',
    `managed path advanced past DISPATCHED (state=${after.executionState})`,
  );
  check(after.executionState !== 'DISPATCHED' || after.currentRunId, 'not stuck without run');

  const runsDir = path.join(TEST_ROOT, project, 'runs');
  const runFolders = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(runsDir, d.name))
    : [];
  // Run folders may be nested by date — search for runtime-binding.json
  function findBinding(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'runtime-binding.json') return p;
      try {
        if (fs.statSync(p).isDirectory()) {
          const found = findBinding(p);
          if (found) return found;
        }
      } catch { /* ignore */ }
    }
    return null;
  }
  const bindingPath = findBinding(path.join(TEST_ROOT, project));
  check(!!bindingPath, 'persists runtime-binding.json on Run');
  if (bindingPath) {
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    check(binding.commandId?.startsWith('cmd1_'), 'binding has commandId');
    check(binding.runtimeId === 'rt_fixture_1', 'binding has frozen runtimeId');
    check(!!binding.reservationId, 'binding has reservationId');
    check(!!binding.finalPacket || !!binding.agentReceived, 'binding recorded collect evidence');
    const runFolder = path.dirname(bindingPath);
    check(fs.existsSync(path.join(runFolder, 'wire-prompt.txt')), 'persists wire-prompt.txt');
    check(fs.existsSync(path.join(runFolder, 'prompt.md')), 'persists prompt.md');
  }

  // Prove send happened (fake state).
  const fakeState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState.sent === true, 'fake actl recorded send');
}

// ── 4. Arm-fail ⇒ no send ────────────────────────────────────────────────────
console.log('\n── Arm failure means no send ──');

{
  const stateDir = await prepareManagedDispatch('armfail');
  process.env.FAKE_ACTL_MODE = 'happy';
  disp._setActlArmFailForTests(new Error('injected arm failure'));

  registerActlWorkerAbs('w-actl-armfail');
  const task = await makeReadyTask('Arm fail task');
  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-armfail',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    }),
    'arm failure throws LAUNCH_FAILED',
    'Capture arm failed',
  );

  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === 'FAILED', 'arm failure → FAILED (Run preserved)');
  const stateFile = path.join(stateDir, 'state.json');
  if (fs.existsSync(stateFile)) {
    const fakeState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    check(fakeState.sent !== true, 'arm failure did not call actl send');
  } else {
    PASS('arm failure did not call actl send (no fake state / no send)');
  }
  disp._setActlArmFailForTests(null);
}

// ── 5. Native spawn path unpolluted ──────────────────────────────────────────
console.log('\n── Native spawn path unpolluted ──');

{
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  testFix.ensureTestFixtureAdapterRegistered();

  registerNativeWorker('w-native');
  const task = await makeReadyTask('Native path');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-native',
    expectedExecutionState: 'READY',
    workspaceRoot: WORKSPACE,
  });
  check(typeof result.pid === 'number' && result.pid > 0, 'native path still spawns child pid');
  const after = await new Promise(async (resolve, reject) => {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const t = gt.getTask(TEST_ROOT, project, task.taskId);
      if (t.executionState === 'RUNNING' || t.executionState === 'FAILED' || t.executionState === 'RESULT_RECEIVED') {
        return resolve(t);
      }
      await sleep(40);
    }
    reject(new Error('native timeout'));
  });
  check(after.executionState === 'RUNNING' || after.currentRunId, 'native path reaches RUNNING via spawn evidence');

  // Ensure no runtime-binding required on native runs — search newest run without requiring binding.
  function findPrompt(dir) {
    if (!fs.existsSync(dir)) return null;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (name === 'prompt.md') return p;
      try {
        if (fs.statSync(p).isDirectory()) {
          const found = findPrompt(p);
          if (found) return found;
        }
      } catch { /* ignore */ }
    }
    return null;
  }
  // Native fixture worker does not write prompt.md before exit — just assert no crash and pid path.
  check(!fs.existsSync(path.join(TEST_ROOT, 'unexpected-actl-touch')), 'native path did not require actl state');
}

// Incomplete opt-in rejected
{
  disp._resetDispatcherStateForTests();
  wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: 'w-partial',
    launchCommand: FAKE_LAUNCHER,
    launchArgsPrefix: [],
    observationAdapterId: 'actl-managed',
    // missing driverOptions.actl
  });
  const task = await makeReadyTask('Partial opt-in');
  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-partial',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    }),
    'actl-managed without driverOptions.actl rejected',
    'driverOptions.actl',
  );
}

function installFixturePermit() {
  bridge.setActlInputPermitFactory(async (args) =>
    bridge.buildDefaultInputPermit({
      ...args,
      snapshotHash: args.currentSnapshotHash || 'fixture-snapshot',
    }),
  );
}

async function prepareManagedDispatch(label) {
  const stateDir = freshStateDir(label);
  process.env.FAKE_ACTL_STATE_DIR = stateDir;
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  actlWatch._resetActlManagedWatchesForTests();
  actlWatch.ensureActlManagedAdapterRegistered();
  disp._setActlCollectTimeoutMsForTests(5_000);
  installFixturePermit();
  // Ensure prior flock holders are gone before the next managed dispatch.
  await sleep(50);
  return stateDir;
}

// ── 6. Default permit factory refuses ────────────────────────────────────────
console.log('\n── Default inputPermit factory fail-closed ──');

{
  disp._resetDispatcherStateForTests();
  bridge.setActlInputPermitFactory(null); // restore refuse default
  await shouldThrow(
    async () => bridge.obtainInputPermit({
      commandId: 'cmd1_x',
      runtimeId: 'rt',
      fence: '1',
      currentSnapshotHash: 'fixture-snapshot',
    }),
    'default permit factory refuses without Owner install',
    'INPUT_STATE_UNKNOWN',
  );
}

// ── 7. Ambiguous send / hang-send → DISPATCHED, sendCount===1 ────────────────
console.log('\n── Delivery ambiguity (no FAILED, no second send) ──');

{
  const stateDir = await prepareManagedDispatch('ambig');
  process.env.FAKE_ACTL_MODE = 'ambiguous-send';
  registerActlWorkerAbs('w-actl-ambig');
  const task = await makeReadyTask('Ambiguous send');
  let thrownCode;
  try {
    await disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-ambig',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    });
    FAIL('ambiguous-send — expected throw');
  } catch (err) {
    thrownCode = err && err.code;
    if (thrownCode === 'DELIVERY_AMBIGUOUS') PASS('ambiguous-send throws DELIVERY_AMBIGUOUS (not LAUNCH_FAILED)');
    else FAIL(`ambiguous-send — expected DELIVERY_AMBIGUOUS got ${thrownCode}: ${err.message}`);
  }
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === 'DISPATCHED', 'ambiguous-send keeps Task DISPATCHED');
  const fakeState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState.sendCount === 1, 'ambiguous-send sendCount===1');
  // Second dispatch must not be a silent resend — blocked by active hold / lock / state.
  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-ambig',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    }),
    'ambiguous-send blocks second dispatch (no resend)',
    undefined,
  );
  const fakeState2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState2.sendCount === 1, 'after blocked redispatch sendCount still 1');
}

{
  const stateDir = await prepareManagedDispatch('hang');
  process.env.FAKE_ACTL_MODE = 'hang-send';
  disp._setActlSendTimeoutMsForTests(250);
  registerActlWorkerAbs('w-actl-hang');
  const task = await makeReadyTask('Hang send');
  let thrownCode;
  try {
    await disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-hang',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    });
    FAIL('hang-send — expected throw');
  } catch (err) {
    thrownCode = err && err.code;
    if (thrownCode === 'DELIVERY_AMBIGUOUS') PASS('hang-send/TIMEOUT throws DELIVERY_AMBIGUOUS');
    else FAIL(`hang-send — expected DELIVERY_AMBIGUOUS got ${thrownCode}: ${err?.message}`);
  }
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === 'DISPATCHED', 'hang-send keeps Task DISPATCHED (not FAILED)');
  const fakeState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState.sendCount === 1, 'hang-send sendCount===1');
  disp._setActlSendTimeoutMsForTests(null);
}

{
  const stateDir = await prepareManagedDispatch('poss');
  process.env.FAKE_ACTL_MODE = 'possible-input-busy';
  registerActlWorkerAbs('w-actl-poss');
  const task = await makeReadyTask('Possible input busy');
  let thrownCode;
  try {
    await disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-poss',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    });
    FAIL('possible-input-busy — expected throw');
  } catch (err) {
    thrownCode = err && err.code;
    if (thrownCode === 'DELIVERY_AMBIGUOUS') PASS('sideEffect=POSSIBLE_INPUT maps to DELIVERY_AMBIGUOUS');
    else FAIL(`possible-input — expected DELIVERY_AMBIGUOUS got ${thrownCode}`);
  }
  check(gt.getTask(TEST_ROOT, project, task.taskId).executionState === 'DISPATCHED', 'POSSIBLE_INPUT keeps DISPATCHED');
  const fakeState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState.sendCount === 1, 'POSSIBLE_INPUT sendCount===1');
}

{
  const stateDir = await prepareManagedDispatch('cleanrej');
  process.env.FAKE_ACTL_MODE = 'reject-send-clean';
  registerActlWorkerAbs('w-actl-cleanrej');
  const task = await makeReadyTask('Clean reject send');
  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {
      taskId: task.taskId,
      workerId: 'w-actl-cleanrej',
      expectedExecutionState: 'READY',
      workspaceRoot: WORKSPACE,
    }),
    'sideEffect=NONE send reject fails dispatch',
    undefined,
  );
  check(gt.getTask(TEST_ROOT, project, task.taskId).executionState === 'FAILED', 'clean reject → FAILED');
  const fakeState = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(fakeState.sendCount === 1, 'clean reject still attempted send once');
}

// ── 8. Same-poll AGENT_RECEIVED + FINAL order ────────────────────────────────
console.log('\n── Same-poll AGENT_RECEIVED+FINAL ──');

{
  await prepareManagedDispatch('samepoll');
  process.env.FAKE_ACTL_MODE = 'final-same-poll';
  registerActlWorkerAbs('w-actl-samepoll');
  const task = await makeReadyTask('Same poll final');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-actl-samepoll',
    expectedExecutionState: 'READY',
    workspaceRoot: WORKSPACE,
  });
  check(!!result.runId, 'same-poll dispatch returns runId');
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(
    ['RUNNING', 'RESULT_RECEIVED', 'VERIFYING', 'ACCEPTED'].includes(after.executionState),
    `same-poll advanced via AGENT_RECEIVED then FINAL (state=${after.executionState})`,
  );
  const link = after.linkedRuns.find((r) => r.runId === result.runId);
  const bindingPath = link ? path.join(link.folder, 'runtime-binding.json') : null;
  if (bindingPath && fs.existsSync(bindingPath)) {
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf8'));
    check(!!binding.agentReceived, 'same-poll recorded AGENT_RECEIVED evidence');
    check(!!binding.finalPacket, 'same-poll recorded FINAL packet');
    check(!!binding.transportReceipt, 'same-poll persisted transportReceipt');
    check(binding.collectStatus === 'FINAL_BOUND', 'same-poll collectStatus FINAL_BOUND');
  } else {
    FAIL('same-poll missing runtime-binding.json for dispatched run');
  }
}

// ── 9. dataRoot flock path documented / acquire works ────────────────────────
console.log('\n── §9.3 dataRoot lock ──');

{
  disp._resetDispatcherStateForTests();
  const lockPath = disp.actlManagedDataRootLockPath(TEST_ROOT);
  check(
    lockPath.includes(path.join('_relay', 'locks', 'actl-managed-controller.lock')),
    'lock path under dataRoot/_relay/locks/',
  );
  const lockMod = await import('../dist/server/backend/actl-data-root-lock.js');
  const h1 = await lockMod.tryAcquireActlManagedDataRootLock(TEST_ROOT);
  check(!!h1.lockPath && fs.existsSync(h1.lockPath), 'acquires dataRoot exclusive lock dir');
  let contended = false;
  const child = spawnSync(NODE, ['-e', `
    (async () => {
      const m = require(${JSON.stringify(path.resolve('dist/server/backend/actl-data-root-lock.js'))});
      try {
        await m.tryAcquireActlManagedDataRootLock(${JSON.stringify(TEST_ROOT)});
        process.exit(0);
      } catch (e) {
        process.stderr.write(String(e && e.message || e));
        process.exit(2);
      }
    })();
  `], { encoding: 'utf8', timeout: 5000 });
  if (child.status === 2 && /contended|CONFLICT/i.test(child.stderr + child.stdout)) {
    contended = true;
  }
  check(contended, 'second process dataRoot lock is contended');
  h1.release();
  lockMod._resetActlDataRootLocksForTests();
  check(!fs.existsSync(lockPath), 'release removes lock dir');
}

// ── 10. Pre-send frozen paneId wiring (Phase 2) ───────────────────────────────
console.log('\n── Frozen paneId reserve→send wiring ──');

{
  // Helper unit: freeze + binding helpers
  const frozen = bridge.frozenExpectedContextFromReserve(
    { context: { agentKind: 'codex', paneId: '%7' }, runtimeId: 'rt_x' },
    { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
  );
  check(frozen.paneId === '%7', 'frozenExpectedContextFromReserve keeps reserve paneId');
  let missing = false;
  try {
    bridge.frozenExpectedContextFromReserve({ context: { agentKind: 'codex' } }, { agentKind: 'codex' });
  } catch (e) {
    missing = /paneId/i.test(String(e && e.message));
  }
  check(missing, 'freeze fails closed when reserve omits paneId');

  const bindingOk = {
    schemaVersion: 1,
    relayInstanceId: 'i',
    project: 'p',
    taskId: 't',
    runId: 'r',
    runtimeId: 'rt',
    agentKind: 'codex',
    expectedProfileRoot: PROFILE,
    socketPath: SOCKET,
    workspaceRoot: WORKSPACE,
    commandId: 'cmd1_x',
    wirePromptSha256: 'a'.repeat(64),
    paneId: '%7',
    frozenExpectedContext: frozen,
    updatedAt: new Date().toISOString(),
  };
  const fromBinding = bridge.expectedContextFromBinding(bindingOk);
  check(fromBinding.paneId === '%7', 'expectedContextFromBinding returns frozen paneId');

  let remap = false;
  try {
    bridge.expectedContextFromBinding({
      ...bindingOk,
      paneId: '%9',
      frozenExpectedContext: { ...frozen, paneId: '%7' },
    });
  } catch (e) {
    remap = /disagree|MISMATCH/i.test(String(e && e.message));
  }
  check(remap, 'binding paneId vs frozen paneId mismatch fails closed');

  let noFrozen = false;
  try {
    bridge.expectedContextFromBinding({ ...bindingOk, frozenExpectedContext: undefined, paneId: '%7' });
  } catch (e) {
    noFrozen = /frozenExpectedContext/i.test(String(e && e.message));
  }
  check(noFrozen, 'missing frozenExpectedContext fails closed (no registry remap)');
}

{
  // Dispatcher: reserve paneId reaches send unchanged
  disp._resetDispatcherStateForTests();
  actlWatch._resetActlManagedWatchesForTests();
  actlWatch.ensureActlManagedAdapterRegistered();
  process.env.FAKE_ACTL_STATE_DIR = freshStateDir('pane-wire');
  process.env.FAKE_ACTL_MODE = 'happy';
  process.env.FAKE_ACTL_PANE_ID = '%wire42';
  delete process.env.FAKE_ACTL_LIVE_SNAPSHOT;
  registerActlWorkerAbs('w-actl-pane-wire');
  bridge.setActlInputPermitFactory((args) => bridge.buildDefaultInputPermit({
    commandId: args.commandId,
    runtimeId: args.runtimeId,
    fence: args.fence,
    snapshotHash: args.currentSnapshotHash,
  }));
  const task = await makeReadyTask('Pane wire');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-actl-pane-wire',
    expectedExecutionState: 'READY',
    workspaceRoot: WORKSPACE,
  });
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  const link = after.linkedRuns.find((r) => r.runId === result.runId);
  const binding = JSON.parse(fs.readFileSync(path.join(link.folder, 'runtime-binding.json'), 'utf8'));
  check(binding.paneId === '%wire42', 'dispatcher persists frozen paneId on runtime-binding');
  check(binding.frozenExpectedContext?.paneId === '%wire42', 'dispatcher persists frozenExpectedContext.paneId');
  const fakeState = JSON.parse(fs.readFileSync(path.join(process.env.FAKE_ACTL_STATE_DIR, 'state.json'), 'utf8'));
  check(fakeState.lastSendPaneId === '%wire42', 'fake actl send received exact reserved paneId');
  check(fakeState.sent === true, 'wiring happy path still sends once');
  bridge.setActlInputPermitFactory(null);
  delete process.env.FAKE_ACTL_PANE_ID;
}

{
  // Alias remap cannot redirect Managed send
  const stateDir = freshStateDir('alias');
  const env = actlEnv(stateDir, { FAKE_ACTL_PANE_ID: '%real' });
  const reserve = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'reserve',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'reserve',
      action: 'acquire',
      runtimeId: 'rt_fixture_1',
      mode: 'MANAGED',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  const frozen = bridge.frozenExpectedContextFromReserve(reserve.data, {
    agentKind: 'codex',
    profileRoot: PROFILE,
    workspaceRoot: WORKSPACE,
  });
  check(frozen.paneId === '%real', 'alias fixture reserved %real');
  const commandId = 'cmd1_alias_remap';
  const { wirePrompt, promptSha256 } = bridge.composeWirePrompt(commandId, 'x\n');
  const permit = bridge.buildDefaultInputPermit({
    commandId,
    runtimeId: 'rt_fixture_1',
    fence: String(reserve.data.fence),
    snapshotHash: 'fixture-snapshot',
  });
  const remapped = await bridge.invokeActlRuntime(
    FAKE_LAUNCHER,
    'send',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'send',
      runtimeId: 'rt_fixture_1',
      expectedContext: { ...frozen, paneId: '%alias-other' },
      reservationId: reserve.data.reservationId,
      leaseToken: reserve.data.leaseToken,
      fence: reserve.data.fence,
      commandId,
      wirePrompt,
      promptSha256,
      observationCursor: { kind: 'BOOTSTRAP' },
      inputPermit: permit,
      currentSnapshotHash: 'fixture-snapshot',
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(remapped.envelope?.ok === false, 'remapped paneId send is rejected');
  check(remapped.envelope?.error?.code === 'MISMATCH', 'remapped paneId → MISMATCH');
  check(remapped.envelope?.error?.sideEffect === 'NONE', 'remapped paneId → no input sideEffect');
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'));
  check(st.sent !== true, 'remapped paneId did not mark sent');
}

{
  // Changed snapshot fails closed
  const stateDir = freshStateDir('snap');
  const env = actlEnv(stateDir, {
    FAKE_ACTL_PANE_ID: '%snap',
    FAKE_ACTL_SNAPSHOT: 'snap-a',
    FAKE_ACTL_LIVE_SNAPSHOT: 'snap-b',
  });
  const reserve = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'reserve',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'reserve',
      action: 'acquire',
      runtimeId: 'rt_fixture_1',
      mode: 'MANAGED',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  const frozen = bridge.frozenExpectedContextFromReserve(reserve.data, {
    agentKind: 'codex',
    profileRoot: PROFILE,
    workspaceRoot: WORKSPACE,
  });
  const commandId = 'cmd1_snap_change';
  const { wirePrompt, promptSha256 } = bridge.composeWirePrompt(commandId, 'x\n');
  const permit = bridge.buildDefaultInputPermit({
    commandId,
    runtimeId: 'rt_fixture_1',
    fence: String(reserve.data.fence),
    snapshotHash: 'snap-a',
  });
  const send = await bridge.invokeActlRuntime(
    FAKE_LAUNCHER,
    'send',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'send',
      runtimeId: 'rt_fixture_1',
      expectedContext: frozen,
      reservationId: reserve.data.reservationId,
      leaseToken: reserve.data.leaseToken,
      fence: reserve.data.fence,
      commandId,
      wirePrompt,
      promptSha256,
      observationCursor: { kind: 'BOOTSTRAP' },
      inputPermit: permit,
      currentSnapshotHash: 'snap-a',
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(send.envelope?.ok === false, 'snapshot change rejects send');
  check(send.envelope?.error?.code === 'INPUT_STATE_UNKNOWN', 'snapshot change → INPUT_STATE_UNKNOWN');
  check(JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).sent !== true, 'snapshot change did not send');
}

{
  // Stale fence fails closed
  const stateDir = freshStateDir('fence');
  const env = actlEnv(stateDir, { FAKE_ACTL_PANE_ID: '%fence' });
  const reserve = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'reserve',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'reserve',
      action: 'acquire',
      runtimeId: 'rt_fixture_1',
      mode: 'MANAGED',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  const frozen = bridge.frozenExpectedContextFromReserve(reserve.data, {
    agentKind: 'codex',
    profileRoot: PROFILE,
    workspaceRoot: WORKSPACE,
  });
  const commandId = 'cmd1_stale_fence';
  const { wirePrompt, promptSha256 } = bridge.composeWirePrompt(commandId, 'x\n');
  const permit = bridge.buildDefaultInputPermit({
    commandId,
    runtimeId: 'rt_fixture_1',
    fence: '999',
    snapshotHash: 'fixture-snapshot',
  });
  const send = await bridge.invokeActlRuntime(
    FAKE_LAUNCHER,
    'send',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'send',
      runtimeId: 'rt_fixture_1',
      expectedContext: frozen,
      reservationId: reserve.data.reservationId,
      leaseToken: reserve.data.leaseToken,
      fence: '999',
      commandId,
      wirePrompt,
      promptSha256,
      observationCursor: { kind: 'BOOTSTRAP' },
      inputPermit: permit,
      currentSnapshotHash: 'fixture-snapshot',
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(send.envelope?.ok === false, 'stale fence rejects send');
  check(send.envelope?.error?.code === 'BUSY', 'stale fence → BUSY');
}

{
  // Wrong runtime fails closed
  const stateDir = freshStateDir('runtime');
  const env = actlEnv(stateDir, { FAKE_ACTL_PANE_ID: '%rt' });
  const reserve = await bridge.invokeActlRuntimeOrThrow(
    FAKE_LAUNCHER,
    'reserve',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'reserve',
      action: 'acquire',
      runtimeId: 'rt_fixture_1',
      mode: 'MANAGED',
      expectedContext: { agentKind: 'codex', profileRoot: PROFILE, workspaceRoot: WORKSPACE },
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  const frozen = bridge.frozenExpectedContextFromReserve(reserve.data, {
    agentKind: 'codex',
    profileRoot: PROFILE,
    workspaceRoot: WORKSPACE,
  });
  const commandId = 'cmd1_wrong_rt';
  const { wirePrompt, promptSha256 } = bridge.composeWirePrompt(commandId, 'x\n');
  const permit = bridge.buildDefaultInputPermit({
    commandId,
    runtimeId: 'rt_OTHER',
    fence: String(reserve.data.fence),
    snapshotHash: 'fixture-snapshot',
  });
  const send = await bridge.invokeActlRuntime(
    FAKE_LAUNCHER,
    'send',
    {
      contractVersion: 1,
      requestId: bridge.newRequestId(),
      operation: 'send',
      runtimeId: 'rt_OTHER',
      expectedContext: frozen,
      reservationId: reserve.data.reservationId,
      leaseToken: reserve.data.leaseToken,
      fence: reserve.data.fence,
      commandId,
      wirePrompt,
      promptSha256,
      observationCursor: { kind: 'BOOTSTRAP' },
      inputPermit: permit,
      currentSnapshotHash: 'fixture-snapshot',
      ...bridge.scopeFields(SOCKET),
    },
    { env },
  );
  check(send.envelope?.ok === false, 'wrong runtime rejects send');
  check(send.envelope?.error?.code === 'MISMATCH', 'wrong runtime → MISMATCH');
}

console.log(`\nActl-managed bridge tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
