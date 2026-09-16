/**
 * V1-G4-A — Durable PM Delivery kernel.
 *
 * Full path begins through V1 surfaces (never manufactured):
 *   relay_pm_create_task → relay_pm_dispatch_owner_approved →
 *   injected bound RESPONSE_COMPLETE → RESULT_RECEIVED + VERIFYING →
 *   durable TASK_VERIFY PM Delivery (minted by the Result Bridge fast-path).
 *
 * Proves:
 *   A. RESULT_RECEIVED+VERIFYING creates one TASK_VERIFY delivery
 *   B. identity binds exact project/taskId/current runId
 *   C. duplicate ensure → exactly one record (incl. concurrent ensure)
 *   D. Result Bridge replay does not duplicate delivery
 *   E. restart/reconciliation finds missing delivery
 *   F. repeated reconciliation is idempotent
 *   G. retry/new current Run → NEW delivery identity
 *   H. historical Run never mints
 *   I. lifecycle PENDING→DELIVERED→ACKNOWLEDGED
 *   J. IGNORE legal from PENDING and DELIVERED
 *   K. terminal states cannot exit
 *   L. stale CAS rejected
 *   M. no result text/secrets/workspace paths in the delivery record
 *   N. RUN_RESULT_RECEIVED Event semantics unchanged (fact-only)
 *   O. getNextWork TASK_VERIFY semantics unchanged
 *   P. G5 judgment not triggered
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g4a-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    FAIL(`${label} — expected throw`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' ? err.mcpCode ?? err.code : undefined;
    const hay = `${code ?? ''} ${msg}`;
    if (fragment && !hay.includes(fragment)) {
      FAIL(`${label} — expected "${fragment}" in error, got: ${code || ''} ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const bridge = await import('../dist/server/backend/result-bridge.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const evidence = await import('../dist/server/backend/evidence.js');
const evk = await import('../dist/server/backend/event.js');
const pmWork = await import('../dist/server/backend/pm-work.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

const project = 'V1G4AProj';
const ctx = { dataRoot: TEST_ROOT, project };
const tools = pmTools.buildAllPmTools(ctx);
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g4a-worker',
  displayName: 'v1-g4a-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G4A delivery task',
  goal: 'Intended outcome for V1 worker',
  reason: 'PM finalized contract reason',
  scope: 'Narrow V1 scope',
  completionCriteria: ['done when worker result received'],
};

async function resetProcessLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function responseComplete(sessionId, text) {
  return {
    adapterId: 'test-fixture',
    agentName: 'TestFixture',
    sessionId,
    workspace: WORKSPACE,
    observedAt: new Date().toISOString(),
    terminalSignal: 'test.complete',
    rawFinalText: text,
    completionKind: 'RESPONSE_COMPLETE',
  };
}

async function driveToResultReceived(title, sessionId, text) {
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g4a-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  if (t.executionState !== 'RESULT_RECEIVED') throw new Error(`setup failed: ${t.executionState}`);
  return { goalId: inc.goal.goalId, taskId: inc.task.taskId, runId: res.runId, folder };
}

// ── A/B: bridge fast-path mints exactly one TASK_VERIFY delivery ──
console.log('\n-- A/B: fast-path mint --');
const t1 = await driveToResultReceived('V1 G4A main', 'ses-g4a-1', 'G4A synthetic final result one');
{
  const pending = await get('relay_pm_list_pending_deliveries').handler({});
  check(pending.deliveries.length === 1, `A one delivery minted on promotion (got ${pending.deliveries.length})`);
  const d = pending.deliveries[0];
  check(d.kind === 'TASK_VERIFY', 'A kind is TASK_VERIFY');
  check(d.status === 'PENDING', `A initial status PENDING (got ${d.status})`);
  check(d.taskId === t1.taskId && d.runId === t1.runId && d.project === project, 'B identity binds project/taskId/current runId');
  check(d.deliveryId === `PMD-${t1.taskId}-${t1.runId}`, `B deterministic deliveryId (got ${d.deliveryId})`);
  const reread = await get('relay_pm_get_delivery').handler({ deliveryId: d.deliveryId });
  check(reread.deliveryId === d.deliveryId, 'A get_delivery round-trips');
}
const D1 = `PMD-${t1.taskId}-${t1.runId}`;

// ── C: duplicate ensure collapses ──
console.log('\n-- C: idempotent ensure --');
{
  const a = await pmDel.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t1.taskId);
  const b = await pmDel.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t1.taskId);
  check(a.deliveryId === D1 && b.deliveryId === D1, 'C duplicate ensure returns same delivery');
  const [c1, c2] = await Promise.all([
    pmDel.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t1.taskId),
    pmDel.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t1.taskId),
  ]);
  check(c1.deliveryId === D1 && c2.deliveryId === D1, 'C concurrent ensure collapses');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 1, 'C exactly one record on disk');
}

// ── D: bridge replay does not duplicate ──
console.log('\n-- D: replay safety --');
{
  const replayed = await bridge.promoteObservedResult({
    dataRoot: TEST_ROOT, project, goalId: t1.goalId,
    taskId: t1.taskId, runId: t1.runId, boundFolder: t1.folder,
    completion: responseComplete('ses-g4a-1', 'G4A synthetic final result one'),
  });
  check(!!replayed, 'D idempotent bridge replay still promotes (same attempt)');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 1, 'D no duplicate delivery on replay');
}

// ── E/F: reconcile recovery + idempotence ──
console.log('\n-- E/F: reconcile --');
{
  fs.rmSync(pmDel.pmDeliveryFolder(TEST_ROOT, project, D1), { recursive: true, force: true });
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 0, 'E delivery folder removed (simulated loss)');
  const r1 = await pmDel.reconcilePmDeliveries(TEST_ROOT, project);
  check(r1.ensured.includes(D1), 'E reconcile re-mints missing delivery');
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D1)).status === 'PENDING', 'E re-minted as PENDING');
  const r2 = await pmDel.reconcilePmDeliveries(TEST_ROOT, project);
  check(r2.ensured.length === 0 && r2.alreadyPresent.includes(D1), 'F repeated reconcile is idempotent');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 1, 'F still exactly one record');
}

// ── G: retry/new run → NEW delivery ──
console.log('\n-- G: new attempt, new delivery --');
let t1r2;
{
  await rt.requestChanges(TEST_ROOT, project, t1.taskId, t1.runId, {
    goalId: t1.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'g4a changes fixture reason',
  });
  await rt.requestRetry(TEST_ROOT, project, t1.taskId, {
    goalId: t1.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'CHANGES_REQUESTED',
  });
  await resetProcessLocal();
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: t1.taskId, workerId: 'v1-g4a-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, t1.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, 'ses-g4a-2');
  cm.injectCompletionForTests(folder, responseComplete('ses-g4a-2', 'G4A synthetic final result two'));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, t1.taskId);
  check(t.executionState === 'RESULT_RECEIVED', 'G retry attempt promoted again');
  t1r2 = { runId: res.runId, folder };
  const D2 = `PMD-${t1.taskId}-${res.runId}`;
  check(D2 !== D1, 'G new attempt has new delivery identity');
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D2)).status === 'PENDING', 'G new delivery minted PENDING');
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D1)).status === 'PENDING', 'G old delivery untouched (not reset)');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 2, 'G exactly two deliveries total');
}

// ── H: historical run never mints ──
console.log('\n-- H: historical isolation --');
{
  const hist = await bridge.promoteObservedResult({
    dataRoot: TEST_ROOT, project, goalId: t1.goalId,
    taskId: t1.taskId, runId: t1.runId, boundFolder: t1.folder,
    completion: responseComplete('ses-hist', 'stale historical text'),
  });
  check(hist === null, 'H historical runId never promotes current attempt');
  check(pmDel.listPmDeliveries(TEST_ROOT, project).length === 2, 'H no delivery minted for historical run');
}
const D2 = `PMD-${t1.taskId}-${t1r2.runId}`;

// ── L: stale CAS rejected (while D2 still PENDING) ──
console.log('\n-- L: stale CAS --');
{
  await shouldThrow(
    () => get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D2, expectedStatus: 'DELIVERED' }),
    'L stale expectedStatus rejected',
    'CONFLICT',
  );
  await shouldThrow(
    () => get('relay_pm_get_delivery').handler({ deliveryId: 'PMD-TASK-0001-nope' }),
    'L unknown delivery NOT_FOUND',
    'NOT_FOUND',
  );
}

// ── I: PENDING→DELIVERED→ACKNOWLEDGED ──
console.log('\n-- I: lifecycle --');
{
  const m = await get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D2, expectedStatus: 'PENDING' });
  check(m.status === 'DELIVERED' && !!m.deliveredAt, 'I PENDING→DELIVERED with timestamp');
  const m2 = await get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D2, expectedStatus: 'DELIVERED' });
  check(m2.status === 'DELIVERED', 'I same-state replay idempotent');
  const a = await get('relay_pm_ack_delivery').handler({ deliveryId: D2, expectedStatus: 'DELIVERED' });
  check(a.status === 'ACKNOWLEDGED' && !!a.acknowledgedAt, 'I DELIVERED→ACKNOWLEDGED with timestamp');
  const pend = await get('relay_pm_list_pending_deliveries').handler({});
  check(!pend.deliveries.some((d) => d.deliveryId === D2), 'I ACKNOWLEDGED leaves pending queue');
}

// ── J: IGNORE from PENDING and DELIVERED ──
console.log('\n-- J: ignore paths --');
{
  // be7c41c reconciles superseded D1 to IGNORED when the pending queue is
  // read, so use fresh current-attempt deliveries for the CAS lifecycle.
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D1)).status === 'IGNORED', 'J superseded D1 is reconciled to IGNORED');
  const tPending = await driveToResultReceived('V1 G4A pending ignore', 'ses-g4a-pending', 'G4A pending ignore result');
  const DPending = `PMD-${tPending.taskId}-${tPending.runId}`;
  const ig1 = await get('relay_pm_ignore_delivery').handler({ deliveryId: DPending, expectedStatus: 'PENDING' });
  check(ig1.status === 'IGNORED' && !!ig1.ignoredAt, 'J IGNORE legal from PENDING');
  const t2 = await driveToResultReceived('V1 G4A second', 'ses-g4a-3', 'G4A second task result');
  const D3 = `PMD-${t2.taskId}-${t2.runId}`;
  await get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D3, expectedStatus: 'PENDING' });
  const ig2 = await get('relay_pm_ignore_delivery').handler({ deliveryId: D3, expectedStatus: 'DELIVERED' });
  check(ig2.status === 'IGNORED', 'J IGNORE legal from DELIVERED');
}

// ── K: terminal states cannot exit ──
console.log('\n-- K: terminal --');
{
  for (const [id, st] of [[D2, 'ACKNOWLEDGED'], [D1, 'IGNORED']]) {
    await shouldThrow(
      () => get('relay_pm_mark_delivery_delivered').handler({ deliveryId: id, expectedStatus: st }),
      `K terminal ${st} rejects mark_delivered`,
      'INVALID_STATE',
    );
    // Same-state terminal replay is idempotent success (mirrors Event delivery);
    // only exits to a DIFFERENT state are rejected.
    const sameOp = st === 'ACKNOWLEDGED' ? 'relay_pm_ack_delivery' : 'relay_pm_ignore_delivery';
    const same = await get(sameOp).handler({ deliveryId: id, expectedStatus: st });
    check(same.status === st, `K terminal ${st} same-state replay idempotent`);
    const otherOp = st === 'ACKNOWLEDGED' ? 'relay_pm_ignore_delivery' : 'relay_pm_ack_delivery';
    await shouldThrow(
      () => get(otherOp).handler({ deliveryId: id, expectedStatus: st }),
      `K terminal ${st} rejects exit to another state`,
      'INVALID_STATE',
    );
  }
  // Reconcile never resurrects terminal records.
  const r = await pmDel.reconcilePmDeliveries(TEST_ROOT, project);
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D2)).status === 'ACKNOWLEDGED', 'K reconcile keeps ACKNOWLEDGED');
  check((await pmDel.getPmDelivery(TEST_ROOT, project, D1)).status === 'IGNORED', 'K reconcile keeps IGNORED');
  void r;
}

// ── M: identity/state only ──
console.log('\n-- M: payload safety --');
{
  const raw = fs.readFileSync(path.join(pmDel.pmDeliveryFolder(TEST_ROOT, project, D2), 'delivery.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const allowed = new Set(['schemaVersion', 'deliveryId', 'project', 'kind', 'taskId', 'runId', 'status',
    'createdAt', 'updatedAt', 'deliveredAt', 'acknowledgedAt', 'ignoredAt', 'source']);
  check(Object.keys(parsed).every((k) => allowed.has(k)), 'M record has only identity/state fields');
  for (const needle of ['G4A synthetic final result', WORKSPACE, 'agent-result', 'transcript', 'sk-']) {
    check(!raw.includes(needle), `M no leak of ${needle === WORKSPACE ? 'workspace path' : needle}`);
  }
  check(fs.existsSync(path.join(pmDel.pmDeliveryFolder(TEST_ROOT, project, D2), 'delivery.md')), 'M human mirror exists');
}

// ── N: Event semantics unchanged ──
console.log('\n-- N: event facts --');
{
  const events = evk.listEvents(TEST_ROOT, project).events;
  const recv = events.filter((e) => e.type === 'RUN_RESULT_RECEIVED' && e.taskId === t1.taskId);
  check(recv.length >= 1, `N RUN_RESULT_RECEIVED still recorded (got ${recv.length})`);
  check(recv.every((e) => e.pmAttention.required === false), 'N RUN_RESULT_RECEIVED stays fact-only (no PM attention)');
  check(evk.derivePmAttention('RUN_RESULT_RECEIVED', 'INFO').required === false, 'N classifier unchanged');
}

// ── O: getNextWork unchanged ──
console.log('\n-- O: pm-work --');
{
  const work = pmWork.getNextWork(TEST_ROOT, project);
  const item = work.items.find((i) => i.kind === 'TASK_VERIFY' && i.taskId === t1.taskId);
  check(!!item, 'O TASK_VERIFY still derived');
  check(item.runId === t1r2.runId, 'O TASK_VERIFY tracks current runId');
  check(item.cas?.expectedExecutionState === 'RESULT_RECEIVED' && item.cas?.expectedPmState === 'VERIFYING', 'O TASK_VERIFY CAS unchanged');
}

// ── P: no judgment ──
console.log('\n-- P: judgment untouched --');
{
  const t = gt.getTask(TEST_ROOT, project, t1.taskId);
  check(t.pmState === 'VERIFYING' && t.acceptedRunId === undefined, 'P still VERIFYING, never ACCEPTED');
  const events = evk.listEvents(TEST_ROOT, project).events;
  check(!events.some((e) => e.type === 'TASK_RESULT_ACCEPTED' && e.taskId === t1.taskId), 'P no accept event');
  const names = tools.map((x) => x.name);
  check(!names.some((n) => n.includes('create_delivery') || n.includes('mint_delivery')), 'P no MCP mint surface');
  const delSrc = fs.readFileSync('src/backend/pm-delivery.ts', 'utf8');
  for (const forbidden of ['acceptResult', 'completeGoal', 'dispatchTask', 'markResultReceived', 'recordAdapterObservation', 'recordRunResultReceived']) {
    check(!delSrc.includes(forbidden), `P kernel never calls ${forbidden}`);
  }
}

await resetProcessLocal();
delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G4-A Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
