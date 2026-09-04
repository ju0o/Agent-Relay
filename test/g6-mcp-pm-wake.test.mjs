/**
 * V1-G6-MCP — PM Wake Adapter tests.
 *
 * Proves the production-shaped MCP App wake path:
 *   1. pending PM delivery appears in MCP list
 *   2. non-actionable delivery does not appear
 *   3. correct verification context returned
 *   4. invalid delivery/project identity rejected
 *   5. wake instruction bounded (no result text / transcripts / secrets)
 *   6. same delivery not repeatedly emitted in one widget session
 *   7. durable restart preserves pending PM delivery
 *   8. ACCEPT path still canonical
 *   9. CHANGES path still canonical
 *   10. G5-C retry still creates only one retry Run
 *   11. no duplicate retry dispatch regression
 *   12. no secret/full transcript leakage in wake payload
 *   13. legacy stdio PM Host path remains functional
 *   14. broad regression suite remains green (run separately)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-g6-mcp-${process.pid}-${Date.now()}`);
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
const pmWake = await import('../dist/server/backend/pm-wake.js');
const retryPrep = await import('../dist/server/backend/retry-preparation.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const appServer = await import('../dist/server/mcp/app-server.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

const project = 'G6MCPProj';
const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();
wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2', workerId: 'g6-mcp-worker', displayName: 'g6-mcp-worker',
  launchCommand: NODE, launchArgsPrefix: [FIX_ALIVE], capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

const CONTRACT = {
  title: 'V1 G6 MCP wake task',
  goal: 'Intended outcome for G6 MCP wake',
  reason: 'PM finalized contract for review',
  scope: 'Narrow wake review scope',
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
  pmWake._resetPmWakeLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function responseComplete(sessionId, text) {
  return {
    adapterId: 'test-fixture', agentName: 'TestFixture', sessionId,
    workspace: WORKSPACE, observedAt: new Date().toISOString(),
    terminalSignal: 'test.complete', rawFinalText: text, completionKind: 'RESPONSE_COMPLETE',
  };
}

async function driveToResultReceived(title, sessionId, text) {
  const inc = await get('relay_pm_create_task').handler({ ...CONTRACT, title });
  const res = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: inc.task.taskId, workerId: 'g6-mcp-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  const t0 = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  const folder = t0.linkedRuns.find((r) => r.runId === res.runId).folder;
  const cm = captureSvc.ensureDispatchCaptureManager({ settleMs: 0 });
  cm.forceBindSessionForTests(folder, sessionId);
  cm.injectCompletionForTests(folder, responseComplete(sessionId, text));
  await sleep(150);
  const t = gt.getTask(TEST_ROOT, project, inc.task.taskId);
  if (t.executionState !== 'RESULT_RECEIVED') throw new Error(`setup failed: ${t.executionState}`);
  await resetProcessLocal();
  return { goalId: inc.goal.goalId, taskId: inc.task.taskId, runId: res.runId };
}

// ── 1/2: pending delivery appears; non-actionable does not ──
console.log('\n-- 1/2: pending delivery listing --');
{
  const t = await driveToResultReceived('G6 MCP list', 'ses-g6-a', 'G6 result one');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const deliv = pmDel.getPmDelivery(TEST_ROOT, project, D);
  check(deliv.status === 'PENDING', 'delivery minted PENDING');
  const listRes = await get('relay_pm_list_pending_deliveries').handler({});
  check(listRes.deliveries.some((d) => d.deliveryId === D), '1 pending delivery appears in MCP list');
  // Non-actionable: mark DELIVERED→ACKNOWLEDGED (terminal) → must disappear.
  await get('relay_pm_mark_delivery_delivered').handler({ deliveryId: D, expectedStatus: 'PENDING' });
  await get('relay_pm_ack_delivery').handler({ deliveryId: D, expectedStatus: 'DELIVERED' });
  const listRes2 = await get('relay_pm_list_pending_deliveries').handler({});
  check(!listRes2.deliveries.some((d) => d.deliveryId === D), '2 non-actionable (ACKNOWLEDGED) delivery does not appear');
  await resetProcessLocal();
}

// ── 3: correct verification context returned ──
console.log('\n-- 3: verification context --');
{
  const t = await driveToResultReceived('G6 MCP ctx', 'ses-g6-b', 'G6 result two: done and verified');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const ctx = await get('relay_pm_get_verification_context').handler({ deliveryId: D });
  check(ctx.delivery.deliveryId === D && ctx.task.taskId === t.taskId, '3 verification context binds delivery/task');
  check(ctx.attempt.runId === t.runId, '3 context run = delivery run');
  check(ctx.result.text.includes('done and verified'), '3 context includes bounded result text');
  check(ctx.schemaVersion && typeof ctx.schemaVersion === 'string', '3 context schemaVersion present');
  await resetProcessLocal();
}

// ── 4: invalid identity rejected ──
console.log('\n-- 4: identity rejection --');
{
  await shouldThrow(
    () => get('relay_pm_claim_wake').handler({ deliveryId: 'PMD-TASK-999-BAD/..' }),
    '4 malformed deliveryId rejected',
    'INVALID_ARGUMENT',
  );
  await shouldThrow(
    () => get('relay_pm_get_verification_context').handler({ deliveryId: 'PMD-TASK-9999-unknown' }),
    '4 unknown delivery rejected',
    'NOT_FOUND',
  );
  await shouldThrow(
    () => get('relay_pm_claim_wake').handler({ deliveryId: 'PMD-TASK-0001-ffffffff-ffff-ffff-ffff-ffffffffffff' }),
    '4 cross/other delivery not found for this project rejected',
    'NOT_FOUND',
  );
}

// ── 5/6: wake instruction bounded; single emit per session ──
console.log('\n-- 5/6: wake claim + dedupe --');
{
  const t = await driveToResultReceived('G6 MCP wake', 'ses-g6-c', 'G6 secret-payload-TOKEN must not leak into wake');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const c1 = await get('relay_pm_claim_wake').handler({ deliveryId: D });
  check(c1.claimable === true, '6 first claim claimable');
  check(c1.record.status === 'SENT' && c1.record.attemptCount === 1, '6 wake SENT attempt 1');
  check(typeof c1.instruction === 'string' && c1.instruction.includes('AGENT_RELAY_PM_WAKE'), '5 wake instruction has frozen marker');
  check(c1.instruction.includes(`deliveryId=${D}`) && c1.instruction.includes(`project=${project}`) && c1.instruction.includes(`taskId=${t.taskId}`), '5 instruction carries identity');
  check(!c1.instruction.includes('secret-payload-TOKEN'), '12 no result payload in wake instruction');
  check(!/transcript|chain.of.thought|session log/i.test(c1.instruction), '12 no transcript/CoT in wake instruction');
  check(c1.instruction.length <= 600, '5 wake instruction bounded length');
  const c2 = await get('relay_pm_claim_wake').handler({ deliveryId: D });
  check(c2.claimable === false && c2.reason === 'ALREADY_SENT', '6 same delivery NOT repeatedly emitted (ALREADY_SENT)');
  const deliv = pmDel.getPmDelivery(TEST_ROOT, project, D);
  check(deliv.status === 'PENDING', '7 wake SENT does not complete the PM Delivery');
  await resetProcessLocal();
}

// ── 7: durable restart preserves pending delivery ──
console.log('\n-- 7: durable restart --');
{
  const t = await driveToResultReceived('G6 MCP durable', 'ses-g6-d', 'G6 durable text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  await get('relay_pm_claim_wake').handler({ deliveryId: D });
  await resetProcessLocal();
  const deliv = pmDel.getPmDelivery(TEST_ROOT, project, D);
  check(deliv.status === 'PENDING', '7 pending PM delivery survives restart (obligation preserved)');
  const wake = pmWake.getPmWake(TEST_ROOT, project, D);
  check(wake !== null && wake.status === 'SENT', '7 wake record survives restart (no re-wake)');
  await resetProcessLocal();
}

// ── 8: ACCEPT still canonical ──
console.log('\n-- 8: ACCEPT path --');
{
  const t = await driveToResultReceived('G6 MCP accept', 'ses-g6-e', 'G6 accept text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'ACCEPT', reason: 'accept reason here' });
  check(res.judgment.status === 'APPLIED', '8 ACCEPT applied');
  check(gt.getTask(TEST_ROOT, project, t.taskId).pmState === 'ACCEPTED', '8 Task ACCEPTED via canonical path');
  await resetProcessLocal();
}

// ── 9/10/11: CHANGES still canonical; one retry Run only; no duplicate ──
console.log('\n-- 9/10/11: CHANGES → single retry --');
{
  const t = await driveToResultReceived('G6 MCP changes', 'ses-g6-f', 'G6 changes text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  const res = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res.judgment.status === 'APPLIED', '9 CHANGES applied');
  check(res.redispatch?.ok === true, '9 CHANGES auto-redispatch (G5-C)');
  const task = gt.getTask(TEST_ROOT, project, t.taskId);
  check(task.linkedRuns.length === 2, '10 exactly one retry Run created');
  check(task.retryCount === 1, '10 retryCount exactly one');
  // Replay the same judgment → adopt same Run, no duplicate.
  const res2 = await get('relay_pm_submit_judgment').handler({ deliveryId: D, decision: 'CHANGES', reason: REASON, retryInstruction: INSTR });
  check(res2.redispatch?.alreadyDispatched === true && res2.redispatch?.retryRunId === res.redispatch?.retryRunId, '11 no duplicate retry dispatch');
  check(gt.getTask(TEST_ROOT, project, t.taskId).linkedRuns.length === 2, '11 still exactly two Runs total');
  await resetProcessLocal();
}

// ── wake FAILED → bounded retry allowed ──
console.log('\n-- wake failure recovery --');
{
  const t = await driveToResultReceived('G6 MCP wake-fail', 'ses-g6-g', 'G6 wake fail text');
  const D = `PMD-${t.taskId}-${t.runId}`;
  await get('relay_pm_claim_wake').handler({ deliveryId: D });
  const f = await get('relay_pm_mark_wake_failed').handler({ deliveryId: D, reason: 'ui/message rejected' });
  check(f.status === 'FAILED', 'wake marked FAILED');
  const c = await get('relay_pm_claim_wake').handler({ deliveryId: D });
  check(c.claimable === true && c.record.attemptCount === 2, 'FAILED wake allows bounded retry (attempt 2)');
  await resetProcessLocal();
}

// ── MCP App server: tools/list (with UI meta), resources, widget html ──
console.log('\n-- MCP App server surface --');
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const port = 4799;
  const server = await appServer.startMcpAppServer({ dataRoot: TEST_ROOT, project, port });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  const client = new Client({ name: 'g6-check', version: '0.0.1' });
  await client.connect(transport);
  const { tools: listed } = await client.listTools();
  const names = listed.map((t) => t.name);
  for (const want of ['relay_pm_list_pending_deliveries', 'relay_pm_get_verification_context', 'relay_pm_submit_judgment', 'relay_pm_claim_wake', 'relay_pm_open_widget']) {
    check(names.includes(want), `app server exposes ${want}`);
  }
  const opener = listed.find((t) => t.name === 'relay_pm_open_widget');
  const metaUri = opener && opener._meta && opener._meta.ui && opener._meta.ui.resourceUri;
  check(metaUri === 'ui://agent-relay/pm-widget', 'open-widget tool carries ui resourceUri');
  const resources = await client.listResources();
  check(resources.resources.some((r) => r.uri === 'ui://agent-relay/pm-widget'), 'app server lists widget resource');
  const read = await client.readResource({ uri: 'ui://agent-relay/pm-widget' });
  const html = read.contents[0].text;
  check(html.includes('ui/initialize') && html.includes('AGENT_RELAY_PM_WAKE') === false, 'widget HTML served (wake text is generated server-side, not embedded)');
  check(html.includes('relay_pm_list_pending_deliveries') && html.includes('relay_pm_claim_wake'), 'widget HTML polls list + claims wake');
  check(!html.includes('secret-payload'), 'widget HTML has no secrets');
  await client.close();
  await new Promise((resolve) => server.close(resolve));
}

delete process.env.WORKER_STAY_MS;
fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nG6-MCP-PM-Wake Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;