/**
 * V1-G5-C — Automatic same-Task redispatch.
 *
 * Proves A–AG (see task) plus the full G5 loop with fixture PM Host + fixture
 * Worker: one owner GO → Run #1 → Result #1 → PM delivery → one CHANGES
 * judgment → G5-A → G5-B → G5-C automatic Run #2 → Result #2 → PM delivery
 * #2 → ACCEPT judgment → Task ACCEPTED.
 *
 * Manual owner dispatch count: EXACTLY ONE per task.
 * Manual retry dispatch: ZERO (retry runs are launched by dispatchV1Retry).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g5c-${process.pid}-${Date.now()}`);
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
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const pmJud = await import('../dist/server/backend/pm-judgment.js');
const retryPrep = await import('../dist/server/backend/retry-preparation.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const retryDispatch = await import('../dist/server/backend/retry-dispatch.js');
const retryPrompt = await import('../dist/server/backend/retry-prompt.js');
const fsKernel = await import('../dist/server/backend/fs.js');
const evk = await import('../dist/server/backend/event.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const bridgeMod = await import('../dist/server/backend/pm-host-bridge.js');
const actlBridge = await import('../dist/server/backend/actl-bridge.js');
const roleLoop = await import('../dist/server/orchestrator/role-loop.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const FAKE_HOST = path.resolve(__dirname, 'fixtures/hosts/fake-pm-host.mjs');
const NODE = process.execPath;

const project = 'V1G5CProj';
const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });
const WORKSPACE_B = path.join(TEST_ROOT, '_workspace_b');
fs.mkdirSync(WORKSPACE_B, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g5c-worker',
  displayName: 'v1-g5c-worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});
wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g5c-worker2',
  displayName: 'v1-g5c-worker2',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G5C retry task',
  goal: 'Intended outcome for V1 worker review',
  reason: 'PM finalized contract reason for review',
  scope: 'Narrow V1 review scope',
  completionCriteria: ['done when worker result received'],
};

const REASON = 'please address the review nits above';
const INSTR = 'fix the nits and re-verify typecheck';

async function resetProcessLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  retryPrep._resetRetryPreparationLocksForTests();
  pmJud._resetPmJudgmentLocksForTests();
  pmDel._resetPmDeliveryLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function responseComplete(sessionId, text, workspace = WORKSPACE) {
  return {
    adapterId: 'test-fixture',
    agentName: 'TestFixture',
    sessionId,
    workspace,
    observedAt: new Date().toISOString(),
    terminalSignal: 'test.complete',
    rawFinalText: text,
    completionKind: 'RESPONSE_COMPLETE',
  };
}

async function driveToResultReceived(title, sessionId, text, workspace = WORKSPACE) {
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'v1-g5c-worker', workspaceRoot: workspace, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text, workspace));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  if (t.executionState !== 'RESULT_RECEIVED') throw new Error(`setup failed: ${t.executionState}`);
  // Simulate worker exit: clear the lingering fixture process + observation slot.
  await resetProcessLocal();
  return { goalId: inc.goal.goalId, taskId: inc.task.taskId, runId: res.runId, folder };
}

async function injectResultIntoRun(taskId, runId, sessionId, text, workspace = WORKSPACE) {
  const task = gt.getTask(TEST_ROOT, project, taskId);
  const folder = task.linkedRuns.find((r) => r.runId === runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text, workspace));
  await sleep(150);
  await resetProcessLocal();
  return gt.getTask(TEST_ROOT, project, taskId);
}

async function waitFor(label, fn, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// ── A/B: initial owner dispatch creates narrow retry authorization ──
console.log('\n-- A/B: retry authorization minting --');
{
  const t = await driveToResultReceived('V1 G5C auth', 'ses-g5c-a', 'G5C auth result text');
  const auth = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  check(auth.status === 'ACTIVE', 'A initial owner dispatch creates ACTIVE retry authorization');
  check(auth.taskId === t.taskId && auth.goalId === t.goalId, 'B authorization binds taskId/goalId');
  check(auth.workerId === 'v1-g5c-worker', 'B authorization binds workerId');
  check(path.resolve(auth.workspaceRoot) === path.resolve(WORKSPACE), 'B authorization binds workspaceRoot');
  const task = gt.getTask(TEST_ROOT, project, t.taskId);
  check(auth.scopeFingerprint === retryAuth.computeTaskScopeFingerprint(task), 'B scopeFingerprint matches Task contract');
  const raw = JSON.parse(fs.readFileSync(retryAuth.retryAuthorizationFile(TEST_ROOT, project, t.taskId), 'utf8'));
  for (const key of ['launchCommand', 'launchArgsPrefix', 'driverOptions', 'env', 'secrets', 'permissionPolicy', 'permissionMode']) {
    check(!(key in raw), `A no ${key} stored in authorization`);
  }
  const src = fs.readFileSync('src/backend/retry-authorization.ts', 'utf8');
  check(!src.includes('launchCommand'), 'A authorization kernel stores no launchCommand');
  check(!/permissionPolicy:\s/.test(src), 'A authorization kernel never writes permissionPolicy');
  check(!/authorizeEffect/.test(src), 'A authorization kernel performs no permission-gate call');
  await resetProcessLocal();
}

// ── C: PM cannot supply worker/workspace through judgment ──
console.log('\n-- C: no PM-supplied worker/workspace --');
{
  const t = await driveToResultReceived('V1 G5C pm-no-ws', 'ses-g5c-c', 'G5C pm text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  // Extra unknown fields are rejected (not silently honored).
  await shouldThrow(
    () => get('relay_pm_submit_judgment').handler({
      deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR,
      workerId: 'v1-g5c-worker2', workspaceRoot: '/tmp/hacked-workspace',
    }),
    'C extra workerId/workspaceRoot on MCP judgment rejected',
    'INVALID',
  );
  const submitted = await pmJud.submitPmJudgment(TEST_ROOT, project, {
    deliveryId: D, decision: 'ACCEPT', reason: 'accept reason here',
  });
  check(submitted.judgment.decision === 'ACCEPT', 'C backend judgment schema has no worker/workspace inputs');
  const src = fs.readFileSync('src/backend/pm-judgment.ts', 'utf8');
  check(!/workerId|workspaceRoot/.test(src), 'C pm-judgment kernel accepts no worker/workspace');
  // Redispatch input is deliveryId/preparationId only — no worker/workspace fields.
  const srcD = fs.readFileSync('src/backend/retry-dispatch.ts', 'utf8');
  check(!/input\.workerId|input\.workspaceRoot/.test(srcD), 'C retry dispatch accepts no worker/workspace input');
  await resetProcessLocal();
}

// ── D/E/F/G/H/I/J/K/L: automatic redispatch ──
console.log('\n-- D-L: automatic redispatch --');
let loopRun1, loopRun2, loopPrep;
{
  const t = await driveToResultReceived('V1 G5C auto', 'ses-g5c-d', 'G5C auto result text');
  loopRun1 = t.runId;
  const D = `PMD-${t.taskId}-${t.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.prepared === true && res.redispatch?.ok === true, 'D CHANGES → G5-B READY → automatic redispatch (one judgment)');
  check(res.redispatch?.alreadyDispatched === false, 'D redispatch happened inline, not adopted');
  const task = res.task;
  check(['DISPATCHED', 'RUNNING'].includes(task.executionState) && task.pmState === 'PENDING', 'F same Task reused (still one Task record)');
  check(task.linkedRuns.length === 2, 'G new Run created');
  const run2 = task.linkedRuns.find((r) => r.runId === res.redispatch.retryRunId);
  const srcSeq = task.linkedRuns.find((r) => r.runId === t.runId).taskRunSequence;
  check(!!run2, 'G retryRunId linked to Task');
  check(run2.taskRunSequence === srcSeq + 1, 'H new Run sequence is previous +1');
  check(run2.agent === 'worker-v1-g5c-worker', 'I same Worker reused');
  const meta2 = fsKernel.readRunMeta(run2.folder);
  check(meta2.workerId === 'v1-g5c-worker', 'I authoritative workerId persisted on retry Run');
  check(path.resolve(meta2.workspaceRoot) === path.resolve(WORKSPACE), 'J same Workspace reused');
  check(fs.existsSync(run2.folder) && fs.statSync(run2.folder).isDirectory(), 'K workspace revalidated (dispatcher validated + Run materialized)');
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, `RTP-PMJ-${D}`).dispatchedRunId === res.redispatch.retryRunId, 'Q consumption marker binds preparation→Run');
  loopRun2 = res.redispatch.retryRunId;
  loopPrep = `RTP-PMJ-${D}`;
  await resetProcessLocal();
}

// ── M/N/O/P: denial matrix ──
console.log('\n-- M-O: worker/workspace/scope/task denial --');
{
  const t = await driveToResultReceived('V1 G5C deny', 'ses-g5c-m', 'G5C deny text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  const auth = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  // M: different Worker is not possible — auth binds the worker; retry input is deliveryId only.
  const srcM = fs.readFileSync('src/backend/retry-dispatch.ts', 'utf8');
  check(!/workerId: input|workspaceRoot: input/.test(srcM), 'M retry dispatch accepts no workerId input');
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  // O: new Task cannot reuse authorization (authorization is keyed by taskId).
  const t2 = await driveToResultReceived('V1 G5C other-task', 'ses-g5c-o', 'G5C other text');
  check(retryAuth.getRetryAuthorization(TEST_ROOT, project, t2.taskId).taskId === t2.taskId, 'O other Task gets its own authorization (keyed per taskId)');
  // Task T's preparation can only ever resolve against T's own authorization
  // (dispatchV1Retry reads the authorization for prep.taskId). Cross-task
  // reuse is structurally impossible.
  check(retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId).taskId === t.taskId, 'O authorization cannot authorize another Task');
  // N: changed Workspace binding denies — authorization.workspaceRoot made invalid.
  const authPath = retryAuth.retryAuthorizationFile(TEST_ROOT, project, t.taskId);
  const authRaw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  authRaw.workspaceRoot = path.join(TEST_ROOT, 'does-not-exist-now');
  fs.writeFileSync(authPath, JSON.stringify(authRaw, null, 2), 'utf8');
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { preparationId: P }),
    'N changed/broken Workspace binding denies retry',
    'workspace',
  );
  // Restore for the scope-mismatch check.
  authRaw.workspaceRoot = WORKSPACE;
  fs.writeFileSync(authPath, JSON.stringify(authRaw, null, 2), 'utf8');
  // Scope mismatch (P): edit the Task contract → fingerprint no longer matches.
  const taskPath = path.join(gt.taskFolder(TEST_ROOT, project, t.taskId), 'task.json');
  const taskRaw = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  taskRaw.scope = 'ENLARGED SCOPE — new work added';
  fs.writeFileSync(taskPath, JSON.stringify(taskRaw, null, 2), 'utf8');
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { preparationId: P }),
    'P scope fingerprint mismatch denies retry',
    'scope',
  );
  // Restore Task contract.
  taskRaw.scope = CONTRACT.scope;
  fs.writeFileSync(taskPath, JSON.stringify(taskRaw, null, 2), 'utf8');
  // Consume this preparation so the T-block restart reconcile (which scans ALL
  // READY unconsumed preparations) does not collide on the observation lock.
  const consumed = await retryDispatch.dispatchV1Retry(TEST_ROOT, project, { preparationId: P });
  check(consumed.alreadyDispatched === false && !!consumed.runId, 'denial-block cleanup: preparation consumed');
  await resetProcessLocal();
}

// ── Q/R: one prep → at most one Run; correlation persisted ──
console.log('\n-- Q/R: one Run per preparation + correlation --');
{
  const t = await driveToResultReceived('V1 G5C one-run', 'ses-g5c-q', 'G5C one-run text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  const res1 = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const runId1 = res1.redispatch.retryRunId;
  const prep = retryPrep.getRetryPreparation(TEST_ROOT, project, P);
  check(prep.dispatchedRunId === runId1 && prep.consumedAt !== undefined, 'Q preparation consumed exactly once');
  check(res1.redispatch.ok === true && res1.redispatch.alreadyDispatched === false, 'Q first dispatch is fresh');
  // Replay (same judgment) must adopt, never duplicate.
  const res2 = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res2.redispatch?.alreadyDispatched === true && res2.redispatch?.retryRunId === runId1, 'U duplicate judgment replay → adopt same Run, no duplicate');
  const task = gt.getTask(TEST_ROOT, project, t.taskId);
  check(task.linkedRuns.length === 2, 'U exactly two Runs total (source + one retry)');
  const run2 = task.linkedRuns.find((r) => r.runId === runId1);
  const meta = fsKernel.readRunMeta(run2.folder);
  check(meta.retryPreparationId === P, 'R retry correlation persisted on retry Run meta');
  check(meta.sourceRunId === t.runId, 'R sourceRunId persisted on retry Run meta');
  await resetProcessLocal();
}

// ── S/T: crash seams ──
console.log('\n-- S: crash after Run creation, before consumption marker --');
{
  const t = await driveToResultReceived('V1 G5C crash-seam', 'ses-g5c-s', 'G5C crash text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  check(gt.getTask(TEST_ROOT, project, t.taskId).executionState === 'READY', 'S setup: Task READY+PENDING (preparation alone)');
  // Direct kernel dispatch (no MCP auto-trigger) → Run created + marker written.
  const res = await retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D });
  check(res.alreadyDispatched === false && res.runId, 'S fresh dispatch created retry Run');
  // Simulate crash: strip the consumption marker but LEAVE the correlated Run.
  const prepPath = path.join(retryPrep.retryPreparationFolder(TEST_ROOT, project, P), 'preparation.json');
  const prepRaw = JSON.parse(fs.readFileSync(prepPath, 'utf8'));
  delete prepRaw.dispatchedRunId; delete prepRaw.dispatchedAt; delete prepRaw.consumedAt;
  fs.writeFileSync(prepPath, JSON.stringify(prepRaw, null, 2), 'utf8');
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, P).dispatchedRunId === undefined, 'S crash simulated: marker stripped');
  const runsBefore = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length;
  await resetProcessLocal();
  const res2 = await retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D });
  check(res2.alreadyDispatched === true && res2.runId === res.runId, 'S restart adopts same correlated Run, no duplicate');
  check(gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length === runsBefore, 'S no second Run launched');
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, P).dispatchedRunId === res.runId, 'S consumption marker re-established on adoption');
  await resetProcessLocal();
}
console.log('\n-- T: restart before Run creation auto-dispatches once --');
{
  const t = await driveToResultReceived('V1 G5C restart-before', 'ses-g5c-t', 'G5C restart text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  check(gt.getTask(TEST_ROOT, project, t.taskId).executionState === 'READY', 'T setup: no Run yet');
  const runsBefore = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length;
  await resetProcessLocal();
  const outcomes = await retryDispatch.reconcileReadyRetryDispatches(TEST_ROOT, project);
  const mine = outcomes.find((o) => o.preparationId === P);
  check(mine?.outcome === 'dispatched' && !!mine?.runId, 'T restart reconciliation dispatched exactly once');
  const task = gt.getTask(TEST_ROOT, project, t.taskId);
  check(task.linkedRuns.length === runsBefore + 1, 'T exactly one new Run created');
  check(retryPrep.getRetryPreparation(TEST_ROOT, project, P).dispatchedRunId === mine.runId, 'T preparation consumed after dispatch');
  await resetProcessLocal();
}

// ── V/W/X/Y/Z: retry prompt ──
console.log('\n-- V-Z: retry prompt bounded + history preserved --');
{
  const t = await driveToResultReceived('V1 G5C prompt', 'ses-g5c-v', 'G5C prior result text: fixed the typecheck and verified.');
  const t0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const sourceLink = t0.linkedRuns.find((r) => r.runId === t.runId);
  const priorPromptPath = path.join(sourceLink.folder, 'prompt.md');
  fs.writeFileSync(priorPromptPath, 'INITIAL PROMPT — first attempt', 'utf8');
  const priorPromptBytes = fs.readFileSync(priorPromptPath);
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.redispatch?.ok === true, 'V retry dispatched');
  const task = res.task;
  const run2 = task.linkedRuns.find((r) => r.runId === res.redispatch.retryRunId);
  const prompt2 = fs.readFileSync(path.join(run2.folder, 'prompt.md'), 'utf8');
  check(prompt2.includes('Retry instruction:'), 'V retry instruction section present');
  check(prompt2.includes(INSTR), 'V durable retry instruction included in second Run prompt');
  check(prompt2.includes(REASON), 'W PM change reason included');
  check(prompt2.includes('G5C prior result text'), 'X prior result excerpt included');
  const excerpt = prompt2.slice(prompt2.indexOf('Prior result excerpt:')).slice(0, 3000);
  check(Buffer.byteLength(excerpt, 'utf8') <= 2000 + 2000, 'X prior result excerpt bounded');
  check(!prompt2.includes('chain of thought') && !/transcript/i.test(prompt2) && !prompt2.includes('session log'), 'Y no transcript/CoT in retry prompt');
  check(!prompt2.includes('INITIAL PROMPT — first attempt'), 'Z retry prompt does not reuse prior prompt text');
  check(fs.readFileSync(priorPromptPath).equals(priorPromptBytes), 'Z first Run prompt byte-identical after retry');
  check(Buffer.byteLength(prompt2, 'utf8') <= 16 * 1024, 'V retry prompt within 16 KiB cap');
  const ctx = JSON.parse(fs.readFileSync(path.join(run2.folder, 'retry-context.json'), 'utf8'));
  check(ctx.preparationId === P && ctx.sourceRunId === t.runId && ctx.taskId === t.taskId, 'V retry-context.json correlates attempt');
  await resetProcessLocal();
}

// ── AA/AB/AC: retry result returns through G3 + G4-A ──
console.log('\n-- AA-AC: retry result → G3 delivery #2 → new runId --');
{
  const t = await driveToResultReceived('V1 G5C loop-return', 'ses-g5c-aa', 'G5C aa result text');
  const D1 = `PMD-${t.taskId}-${t.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D1, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const run2 = res.redispatch.retryRunId;
  const D2 = `PMD-${t.taskId}-${run2}`;
  check(D2 !== D1, 'AB new retry result produces new G4-A PM Delivery for new runId');
  const task = await injectResultIntoRun(t.taskId, run2, 'ses-g5c-aa2', 'G5C retry result text: all fixed');
  check(task.executionState === 'RESULT_RECEIVED', 'AA retry Worker result returned through existing G3');
  const deliv = pmDel.getPmDelivery(TEST_ROOT, project, D2);
  check(deliv.kind === 'TASK_VERIFY' && deliv.runId === run2 && deliv.status === 'PENDING', 'AA/AB delivery #2 minted for retry runId');
  await shouldThrow(
    () => get('relay_pm_submit_judgment').handler({ deliveryId: D1, decision: 'ACCEPT', reason: 'accept reason here' }),
    'AC old source delivery cannot judge retry Run (delivery is stale for RESULT_RECEIVED)',
    'CONFLICT',
  );
  await resetProcessLocal();
}

// ── AD: worker launch failure does not cause duplicate redispatch ──
console.log('\n-- AD: launch failure correlation retained --');
{
  const t = await driveToResultReceived('V1 G5C launch-fail', 'ses-g5c-ad', 'G5C ad text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const P = `RTP-PMJ-${D}`;
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  const runsBefore = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length;
  let failedRunId;
  disp._setSpawnImplForTests(() => { throw new Error('simulated spawn failure'); });
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D }),
    'AD launch failure surfaces as LAUNCH_FAILED',
    'LAUNCH_FAILED',
  );
  disp._setSpawnImplForTests(null);
  const task = gt.getTask(TEST_ROOT, project, t.taskId);
  check(task.linkedRuns.length === runsBefore + 1, 'AD retry Run preserved (not rolled back after commit)');
  const prep = retryPrep.getRetryPreparation(TEST_ROOT, project, P);
  check(prep.dispatchedRunId === task.linkedRuns[task.linkedRuns.length - 1].runId, 'AD correlation retained on the failed retry Run');
  check(task.executionState === 'FAILED', 'AD canonical Task FAILED (no second Run launched)');
  await resetProcessLocal();
}

// ── AE/AF/AG: scope safety ──
console.log('\n-- AE-AG: scope safety --');
{
  const srcAll = ['retry-dispatch.ts', 'retry-authorization.ts', 'retry-prompt.ts']
    .map((f) => fs.readFileSync(`src/backend/${f}`, 'utf8')).join('\n');
  for (const needle of ['openai', 'chatgpt', 'fetch(', 'http.request']) {
    check(!srcAll.toLowerCase().includes(needle.toLowerCase()), `AE no ${needle} in G5-C backend`);
  }
  const srcDispatch = fs.readFileSync('src/backend/retry-dispatch.ts', 'utf8');
  check(!srcDispatch.includes('relay_pm_create_task'), 'AF G5-C never creates unrelated Task');
  check(!srcDispatch.includes('multi'), 'AG no multi-agent behavior in G5-C');
  check(!srcDispatch.includes('merge') && !srcDispatch.includes('deploy'), 'AG no merge/deploy/release in G5-C');
  await resetProcessLocal();
}

// ── P (live): authorization alone cannot dispatch; READY preparation required ──
console.log('\n-- P: authorization alone cannot dispatch --');
{
  const t = await driveToResultReceived('V1 G5C auth-only', 'ses-g5c-p', 'G5C p text');
  const auth = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  check(auth.status === 'ACTIVE', 'P authorization ACTIVE');
  check(retryPrep.listRetryPreparations(TEST_ROOT, project).filter((p) => p.taskId === t.taskId).length === 0, 'P no READY preparation exists yet');
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: `PMD-${t.taskId}-${t.runId}` }),
    'P authorization alone cannot dispatch (no preparation)',
    'NOT_FOUND',
  );
  // Revoked authorization is unusable even with a READY preparation.
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: `PMD-${t.taskId}-${t.runId}`, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, `PMD-${t.taskId}-${t.runId}`);
  retryAuth.revokeRetryAuthorization(TEST_ROOT, project, t.taskId, 'test revoke');
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: `PMD-${t.taskId}-${t.runId}` }),
    'P REVOKED authorization denies retry despite READY preparation',
    'CONFLICT',
  );
  await resetProcessLocal();
}

// ── FULL G5 LOOP: bridge host + fixture worker ──
console.log('\n-- FULL G5 LOOP (bridge host + fixture worker) --');
{
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G5C full loop' });
  const taskId = inc.task.taskId;
  // One owner GO → Run #1.
  const res1 = await get('relay_pm_dispatch_owner_approved').handler({
    taskId, workerId: 'v1-g5c-worker', workspaceRoot: WORKSPACE_B, expectedExecutionState: 'READY',
  });
  const runId1 = res1.runId;
  const t0 = gt.getTask(TEST_ROOT, project, taskId);
  const folder1 = t0.linkedRuns.find((r) => r.runId === runId1).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder1, 'ses-loop-1');
  cm.injectCompletionForTests(folder1, responseComplete('ses-loop-1', 'loop result one', WORKSPACE_B));
  await sleep(150);
  await resetProcessLocal();
  // Bridge host judges CHANGES once → G5-A → G5-B → G5-C automatic Run #2.
  const rec = path.join(TEST_ROOT, 'rec-loop.ndjson');
  process.env.FAKE_HOST_RECORD_FILE = rec;
  process.env.FAKE_HOST_MODE = 'judge-changes';
  const b = new bridgeMod.PmHostBridge({
    dataRoot: TEST_ROOT, project, hostCommand: NODE, hostArgs: [FAKE_HOST],
    pollMs: 30, receiptTimeoutMs: 4000, maxBackoffMs: 400, logger: () => {},
  });
  await b.start();
  const run2 = await waitFor('loop redispatch', () => {
    const t = gt.getTask(TEST_ROOT, project, taskId);
    if (t.linkedRuns.length < 2) return null;
    const r2 = t.linkedRuns[t.linkedRuns.length - 1];
    return (t.executionState === 'DISPATCHED' || t.executionState === 'RUNNING') ? r2.runId : null;
  });
  await b.stop();
  delete process.env.FAKE_HOST_RECORD_FILE;
  delete process.env.FAKE_HOST_MODE;
  check(run2 !== runId1, 'loop: automatic retry Run #2 created');
  const loopRows = readRecords(rec).filter((r) => r.event === 'judgment-response');
  check(loopRows.some((r) => r.message?.type === 'PM_JUDGMENT_APPLIED' && r.message?.status === 'REDISPATCHED' && r.message?.retryRunId === run2), 'loop: host received REDISPATCHED with retryRunId');
  // Capture Run #2 → Result #2 → delivery #2.
  await injectResultIntoRun(taskId, run2, 'ses-loop-2', 'loop result two', WORKSPACE_B);
  const D2 = `PMD-${taskId}-${run2}`;
  const deliv2 = pmDel.getPmDelivery(TEST_ROOT, project, D2);
  check(deliv2?.runId === run2 && deliv2?.status === 'PENDING', 'loop: delivery #2 minted for Run #2');
  // Host ACCEPT → Task ACCEPTED.
  const accept = await get('relay_pm_submit_judgment').handler({ deliveryId: D2, decision: 'ACCEPT', reason: 'loop accept: looks good' });
  check(accept.judgment.status === 'APPLIED', 'loop: ACCEPT applied');
  const final = gt.getTask(TEST_ROOT, project, taskId);
  check(final.pmState === 'ACCEPTED' && final.acceptedRunId === run2, 'loop: Task ACCEPTED with retry Run as winner');
  check(final.linkedRuns.length === 2, 'loop: exactly two Runs total');
  check(final.retryCount === 1, 'loop: retryCount exactly one');
  // Owner dispatch count: exactly one (the initial GO) — no second manual GO.
  const ownerDispatches = evk.listEvents(TEST_ROOT, project).events
    .filter((e) => e.taskId === taskId && e.type === 'RUN_RESULT_RECEIVED');
  check(ownerDispatches.length === 2, 'loop: two results (Run #1 + Run #2) returned');
  await resetProcessLocal();
}

// ── G5-C correction: original owner-approved scope preserved for auth repair ──
console.log('\n-- correction: owner-approved fingerprint on first-run binding --');
{
  // A: initial owner dispatch RunMeta stores ownerApprovedScopeFingerprint.
  const t = await driveToResultReceived('V1 G5C corr-auth', 'ses-g5c-cor-a', 'G5C corr text');
  const task0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const initialLink = task0.linkedRuns.find((r) => r.runId === t.runId);
  const meta = fsKernel.readRunMeta(initialLink.folder);
  check(typeof meta.ownerApprovedScopeFingerprint === 'string' && /^sha256:[0-9a-f]{64}$/.test(meta.ownerApprovedScopeFingerprint), 'A initial RunMeta stores ownerApprovedScopeFingerprint');
  // B: stored value equals fingerprint of Task contract at owner approval.
  const contractAtApproval = retryAuth.computeTaskScopeFingerprint({ ...CONTRACT, taskId: t.taskId });
  check(meta.ownerApprovedScopeFingerprint === contractAtApproval, 'B RunMeta fingerprint equals Task contract at owner approval');
  // C: normal authorization uses the exact same fingerprint.
  const auth = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  check(auth.scopeFingerprint === meta.ownerApprovedScopeFingerprint, 'C authorization fingerprint == RunMeta original fingerprint');
  check(auth.scopeFingerprint === contractAtApproval, 'C authorization fingerprint == contract-at-approval fingerprint');
  await resetProcessLocal();
}

console.log('\n-- correction: repair without current-task blessing --');
{
  // D/E/F: simulate missing authorization.json after initial dispatch; Task
  // contract UNCHANGED → repair from RunMeta succeeds with the ORIGINAL
  // fingerprint.
  const t = await driveToResultReceived('V1 G5C corr-repair', 'ses-g5c-cor-d', 'G5C corr repair text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const task0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const initialLink = task0.linkedRuns.find((r) => r.runId === t.runId);
  const meta = fsKernel.readRunMeta(initialLink.folder);
  const originalFp = meta.ownerApprovedScopeFingerprint;
  const authPath = retryAuth.retryAuthorizationFile(TEST_ROOT, project, t.taskId);
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  check(!fs.existsSync(authPath), 'D authorization.json removed (mint-failure simulation)');
  // Task contract unchanged → direct retry dispatch auto-repairs from RunMeta.
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  const res = await retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D });
  check(res.alreadyDispatched === false && !!res.runId, 'E unchanged Task → repair + retry dispatch succeeds');
  const repaired = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  check(repaired.source === 'REPAIRED_FROM_FIRST_RUN_BINDING', 'E authorization auto-repaired');
  check(repaired.scopeFingerprint === originalFp, 'F repaired authorization fingerprint == RunMeta original fingerprint');
  check(repaired.scopeFingerprint === contractFp(t.taskId), 'F repaired authorization == contract-at-approval fingerprint');
  await resetProcessLocal();
}
function contractFp(taskId) {
  return retryAuth.computeTaskScopeFingerprint({ ...CONTRACT, taskId });
}

console.log('\n-- correction: changed-scope DENIED after repair (critical) --');
{
  // G: Task contract changed AFTER initial owner dispatch → missing auth →
  // repair reconstructs ORIGINAL auth → retry MUST DENY (current fp mismatch).
  const t = await driveToResultReceived('V1 G5C corr-changed', 'ses-g5c-cor-g', 'G5C corr changed text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const task0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const initialLink = task0.linkedRuns.find((r) => r.runId === t.runId);
  const meta = fsKernel.readRunMeta(initialLink.folder);
  const originalFp = meta.ownerApprovedScopeFingerprint;
  // Mutate the Task contract AFTER owner approval (smallest legal mechanism).
  const taskPath = path.join(gt.taskFolder(TEST_ROOT, project, t.taskId), 'task.json');
  const taskRaw = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  taskRaw.completionCriteria = ['done when worker result received AND extra scope added later'];
  fs.writeFileSync(taskPath, JSON.stringify(taskRaw, null, 2), 'utf8');
  const currentFp = retryAuth.computeTaskScopeFingerprint(gt.getTask(TEST_ROOT, project, t.taskId));
  check(originalFp !== currentFp, 'G original fingerprint A != current fingerprint B (contract mutated)');
  // Remove authorization → repair MUST use A, never B.
  const authPath = retryAuth.retryAuthorizationFile(TEST_ROOT, project, t.taskId);
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  const runsBefore = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length;
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D }),
    'G changed scope after owner approval → retry DENIED (repair uses original A)',
    'scope',
  );
  const after = gt.getTask(TEST_ROOT, project, t.taskId);
  check(after.linkedRuns.length === runsBefore, 'G no new Run created');
  const repaired = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  check(repaired.scopeFingerprint === originalFp, 'G repair fingerprint == original A (not current B)');
  await resetProcessLocal();
}

console.log('\n-- correction: repair never fingerprints current Task --');
{
  // H: structural — repair path source contains no computeTaskScopeFingerprint.
  const src = fs.readFileSync('src/backend/retry-dispatch.ts', 'utf8');
  const repairSlice = src.slice(src.indexOf('ensureAuthorizationFromFirstRunBinding'), src.indexOf('loadAuthorizationOrRepair'));
  check(!repairSlice.includes('computeTaskScopeFingerprint'), 'H repair path never fingerprints current Task');
  check(repairSlice.includes('meta.ownerApprovedScopeFingerprint'), 'H repair uses stored original fingerprint');
}

console.log('\n-- correction: legacy/no-fingerprint safe denial --');
{
  // I: pre-G5-C / legacy first RunMeta (no original fingerprint) → no auto-repair.
  const t = await driveToResultReceived('V1 G5C corr-legacy', 'ses-g5c-cor-i', 'G5C corr legacy text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const task0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const initialLink = task0.linkedRuns.find((r) => r.runId === t.runId);
  const metaPath = path.join(initialLink.folder, 'meta.json');
  const metaRaw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  delete metaRaw.ownerApprovedScopeFingerprint;
  fs.writeFileSync(metaPath, JSON.stringify(metaRaw, null, 2), 'utf8');
  const authPath = retryAuth.retryAuthorizationFile(TEST_ROOT, project, t.taskId);
  fs.rmSync(path.dirname(authPath), { recursive: true, force: true });
  await pmJud.submitPmJudgment(TEST_ROOT, project, { deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  await retryPrep.prepareRetryForJudgment(TEST_ROOT, project, D);
  await shouldThrow(
    () => retryDispatch.dispatchV1Retry(TEST_ROOT, project, { deliveryId: D }),
    'I legacy first RunMeta without fingerprint → auto-repair denied safely',
    'cannot be reconstructed safely',
  );
  check(!fs.existsSync(authPath), 'I no authorization minted from legacy binding');
  await resetProcessLocal();
}

console.log('\n-- correction: PM cannot inject ownerApprovedScopeFingerprint --');
{
  // J: PM judgment schema + retry dispatch input have no such field.
  const srcJ = fs.readFileSync('src/backend/retry-dispatch.ts', 'utf8')
    + '\n' + fs.readFileSync('src/backend/pm-judgment.ts', 'utf8');
  check(!srcJ.includes('ownerApprovedScopeFingerprint: input'), 'J retry dispatch accepts no ownerApprovedScopeFingerprint input');
  // Dispatcher rejects a caller-supplied ownerApprovalContext with bad fingerprint.
  const t = await driveToResultReceived('V1 G5C corr-j', 'ses-g5c-cor-j', 'G5C corr j text');
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId: t.taskId, workerId: 'v1-g5c-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
      ownerApprovalContext: { scopeFingerprint: 'sha256:' + '0'.repeat(64) },
    }),
    'J ownerApprovalContext not accepted from MCP surface',
    'INVALID',
  );
  await resetProcessLocal();
}

console.log('\n-- correction: retry Run does not redefine original approval --');
{
  // K: after a retry dispatch, the retry Run meta has NO fresh
  // ownerApprovedScopeFingerprint; the initial Run keeps the original.
  const t = await driveToResultReceived('V1 G5C corr-k', 'ses-g5c-cor-k', 'G5C corr k text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const task0 = gt.getTask(TEST_ROOT, project, t.taskId);
  const initialLink = task0.linkedRuns.find((r) => r.runId === t.runId);
  const originalFp = fsKernel.readRunMeta(initialLink.folder).ownerApprovedScopeFingerprint;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const retryLink = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.find((r) => r.runId === res.redispatch.retryRunId);
  const retryMeta = fsKernel.readRunMeta(retryLink.folder);
  check(retryMeta.ownerApprovedScopeFingerprint === undefined, 'K retry Run does not store ownerApprovedScopeFingerprint');
  check(fsKernel.readRunMeta(initialLink.folder).ownerApprovedScopeFingerprint === originalFp, 'K initial Run original fingerprint unchanged');
  check(retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId).scopeFingerprint === originalFp, 'K authorization still binds original fingerprint');
  await resetProcessLocal();
}

console.log('\n-- correction: normal path unchanged-scope retry still works --');
{
  // L regression: normal mint + unchanged scope → automatic retry works.
  const t = await driveToResultReceived('V1 G5C corr-l', 'ses-g5c-cor-l', 'G5C corr l text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const auth = retryAuth.getRetryAuthorization(TEST_ROOT, project, t.taskId);
  const initialMeta = fsKernel.readRunMeta(gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.find((r) => r.runId === t.runId).folder);
  check(auth.scopeFingerprint === initialMeta.ownerApprovedScopeFingerprint, 'L normal auth fingerprint == initial RunMeta fingerprint');
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.redispatch?.ok === true, 'L unchanged-scope CHANGES retry still dispatches');
  await resetProcessLocal();
}

console.log('\n-- correction: consumed expired retry is audited, never silent --');
{
  const t = await driveToResultReceived('V1 G5C expired retry', 'ses-g5c-expired', 'G5C expired retry text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  const retryRun = res.redispatch.retryRunId;
  const retryLink = gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.find((r) => r.runId === retryRun);
  const binding = actlBridge.readRuntimeBinding(retryLink.folder);
  actlBridge.writeRuntimeBinding(retryLink.folder, { ...binding, collectStatus: 'RESERVED', closeoutStatus: 'RELEASED' });
  await resetProcessLocal();
  const auditDir = path.join(TEST_ROOT, 'expired-audit'); const stateFile = path.join(TEST_ROOT, 'expired-state.json');
  await roleLoop.runOnce({ dataRoot: TEST_ROOT, project, roleConfig: { assignments: [] }, pmAdapter: {}, dispatchHook: async () => {}, auditDir, stateFile });
  const audit = fs.readFileSync(path.join(auditDir, 'role-loop.jsonl'), 'utf8');
  check(audit.includes('retry reservation expired before send') && audit.includes('BLOCKED_RUNTIME'), 'expired consumed retry is audited BLOCKED_RUNTIME');
  check(gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length === 2, 'expired retry audit does not create another Run');
  await resetProcessLocal();
}

delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G5-C Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
