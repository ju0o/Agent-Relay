/** V1.5 Slice 5 — minimal Chat MCP ExecutionPlan surface. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(os.tmpdir(), `arl-v15-s5-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });
let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};
async function shouldThrow(fn, label, fragment) {
  try {
    await fn();
    check(false, `${label} — expected throw`);
  } catch (err) {
    const hay = `${err?.mcpCode ?? err?.code ?? ''} ${err instanceof Error ? err.message : String(err)}`;
    check(!fragment || hay.includes(fragment), label);
  }
}

const pmTools = await import('../dist/server/mcp/pm-tools.js');
const appServer = await import('../dist/server/mcp/app-server.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const deliveries = await import('../dist/server/backend/pm-delivery.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const workers = await import('../dist/server/backend/worker-registry.js');
const fixtures = await import('../dist/server/integrations/test-fixture/watch.js');
fixtures.ensureTestFixtureAdapterRegistered();

const project = 'V15Slice5';
const tools = pmTools.buildAllPmTools({ dataRoot: ROOT, project });
const get = (name) => {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
};
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const alive = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
process.env.WORKER_STAY_MS = '30000';
dispatcher._resetDispatcherStateForTests();
workers.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'v15-s5-worker', displayName: 'V1.5 Slice 5 fixture worker',
  launchCommand: process.execPath, launchArgsPrefix: [alive], capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const PLAN_TOOL_NAMES = [
  'relay_pm_create_execution_plan',
  'relay_pm_dispatch_execution_plan_owner_approved',
  'relay_pm_get_execution_plan',
  'relay_pm_reconcile_execution_plan',
];

function catalogBytes(toolList) {
  return Buffer.byteLength(JSON.stringify(toolList.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool._meta ? { _meta: tool._meta } : {}),
  }))), 'utf8');
}

function resetLocal() {
  dispatcher._resetDispatcherStateForTests();
  plans._resetExecutionPlanLocksForTests();
  fixtures.ensureTestFixtureAdapterRegistered();
}

async function createThreeTasks(prefix) {
  const created = [];
  for (let index = 1; index <= 3; index += 1) {
    const result = await get('relay_pm_create_task').handler({
      title: `${prefix}-${index}`,
      goal: `Complete ${prefix}-${index}`,
      reason: 'Slice 5 MCP fixture task',
      scope: `Slice5 scope ${prefix}-${index}`,
      completionCriteria: ['fixture complete'],
    });
    created.push(result.task);
  }
  return created;
}

function bindingsFor(tasks, workspace) {
  return tasks.map((task) => ({
    taskId: task.taskId,
    workerId: 'v15-s5-worker',
    workspaceRoot: workspace,
    scopeFingerprint: retryAuth.computeTaskScopeFingerprint(task),
  }));
}

async function createPlanViaMcp(prefix) {
  const workspace = path.join(ROOT, `_workspace-${prefix}`);
  fs.mkdirSync(workspace, { recursive: true });
  const tasks = await createThreeTasks(prefix);
  const created = await get('relay_pm_create_execution_plan').handler({
    title: prefix,
    orderedTaskIds: tasks.map((task) => task.taskId),
    taskBindings: bindingsFor(tasks, workspace),
  });
  return { created, tasks, workspace };
}

async function promoteAndJudge(taskId, runId, workspace, decision, extras = {}) {
  await rt.markResultReceived(ROOT, project, taskId, runId);
  observation.releaseObservationLockByBinding({
    observationAdapterId: 'test-fixture', workspaceRoot: workspace, taskId, runId,
  });
  const delivery = await deliveries.ensurePmDeliveryForTaskVerify(ROOT, project, taskId);
  resetLocal();
  return get('relay_pm_submit_judgment').handler({
    deliveryId: delivery.deliveryId,
    decision,
    reason: extras.reason ?? 'slice5 judgment reason long enough',
    ...(extras.retryInstruction ? { retryInstruction: extras.retryInstruction } : {}),
  });
}

console.log('\n-- catalog footprint and tool presence --');
const baselineNames = tools.map((tool) => tool.name).filter((name) => !PLAN_TOOL_NAMES.includes(name));
const appTools = appServer.buildAppTools({ dataRoot: ROOT, project });
const totalCount = appTools.length;
const totalBytes = catalogBytes(appTools);
const planTools = appTools.filter((tool) => PLAN_TOOL_NAMES.includes(tool.name));
const withoutPlanBytes = catalogBytes(appTools.filter((tool) => !PLAN_TOOL_NAMES.includes(tool.name)));
check(planTools.length === 4, 'exactly four V1.5 Plan tools registered');
for (const name of PLAN_TOOL_NAMES) {
  check(appTools.some((tool) => tool.name === name), `app catalog exposes ${name}`);
}
check(appTools.some((tool) => tool.name === 'relay_pm_open_widget'), 'existing Agent Relay PM widget opener remains');
check(appTools.some((tool) => tool.name === 'relay_pm_submit_judgment'), 'existing V1 judgment tool remains');
check(appTools.some((tool) => tool.name === 'relay_pm_list_pending_deliveries'), 'existing pending-delivery tool remains');
console.log(`  INFO  production-shaped tool count=${totalCount} catalogBytes=${totalBytes} planDeltaBytes=${totalBytes - withoutPlanBytes}`);

console.log('\n-- create plan validation --');
{
  const ok = await createPlanViaMcp('valid-create');
  check(ok.created.planId && ok.created.state === 'PLANNED' && ok.created.activeTaskId === null, '1 create valid 3-Task Plan through MCP');
  const tasks = ok.tasks;
  await shouldThrow(
    () => get('relay_pm_create_execution_plan').handler({
      title: 'dup',
      orderedTaskIds: [tasks[0].taskId, tasks[0].taskId],
      taskBindings: bindingsFor([tasks[0], tasks[0]], ok.workspace),
    }),
    '2 duplicate Task IDs rejected',
    'duplicate',
  );
  await shouldThrow(
    () => get('relay_pm_create_execution_plan').handler({
      title: 'missing-binding',
      orderedTaskIds: tasks.map((task) => task.taskId),
      taskBindings: bindingsFor(tasks.slice(0, 2), ok.workspace),
    }),
    '3 missing binding rejected',
    'exactly one binding',
  );
  await shouldThrow(
    () => get('relay_pm_create_execution_plan').handler({
      title: 'inject-fingerprint',
      orderedTaskIds: tasks.map((task) => task.taskId),
      taskBindings: bindingsFor(tasks, ok.workspace),
      planScopeFingerprint: '0'.repeat(64),
    }),
    '4 caller cannot inject Plan fingerprint',
    '허용되지 않은 인자',
  );
  await shouldThrow(
    () => get('relay_pm_create_execution_plan').handler({
      title: 'inject-state',
      orderedTaskIds: tasks.map((task) => task.taskId),
      taskBindings: bindingsFor(tasks, ok.workspace),
      state: 'RUNNING',
      activeTaskId: tasks[0].taskId,
    }),
    '5 caller cannot set activeTaskId/state',
    '허용되지 않은 인자',
  );
}

console.log('\n-- Plan GO + get + reconcile bounds --');
{
  const fixture = await createPlanViaMcp('owner-go');
  const go = await get('relay_pm_dispatch_execution_plan_owner_approved').handler({
    planId: fixture.created.planId,
    expectedPlanState: 'PLANNED',
  });
  check(go.outcome === 'DISPATCHED' && go.state === 'RUNNING' && go.activeTaskId === fixture.tasks[0].taskId && !!go.runId, '6 Plan GO dispatches Task A exactly once');
  check(gt.getTask(ROOT, project, fixture.tasks[0].taskId).linkedRuns.length === 1, '6 exactly one first Run linked');
  const dup = await get('relay_pm_dispatch_execution_plan_owner_approved').handler({
    planId: fixture.created.planId,
    expectedPlanState: 'PLANNED',
  });
  check(
    (dup.outcome === 'ALREADY_STARTED' || dup.outcome === 'START_IN_PROGRESS_OR_RECOVERY_REQUIRED')
      && gt.getTask(ROOT, project, fixture.tasks[0].taskId).linkedRuns.length === 1,
    '7 duplicate Plan GO creates no second Run',
  );
  await shouldThrow(
    () => get('relay_pm_dispatch_execution_plan_owner_approved').handler({
      planId: fixture.created.planId,
      expectedPlanState: 'PLANNED',
      workerId: 'attacker',
      firstTaskId: fixture.tasks[1].taskId,
      planScopeFingerprint: '1'.repeat(64),
    }),
    '7b GO rejects caller overrides of Worker/Task/fingerprint',
    '허용되지 않은 인자',
  );

  const status = await get('relay_pm_get_execution_plan').handler({ planId: fixture.created.planId });
  check(
    status.planId === fixture.created.planId
      && status.state === 'RUNNING'
      && status.activeTaskId === fixture.tasks[0].taskId
      && Array.isArray(status.orderedTaskIds)
      && Array.isArray(status.tasks),
    '8 get_execution_plan returns bounded state',
  );
  const statusText = JSON.stringify(status);
  check(
    !statusText.includes('launchCommand')
      && !statusText.includes('transcript')
      && !statusText.includes('rawFinalText')
      && !statusText.includes('sk-')
      && !statusText.includes('prompt')
      && !statusText.includes(alive),
    '9 get_execution_plan leaks no prompt/result/transcript/credential',
  );

  resetLocal();
  const reconciled = await get('relay_pm_reconcile_execution_plan').handler({ planId: fixture.created.planId });
  check(
    (reconciled.status === 'HEALTHY_RUNNING' || reconciled.status === 'WAITING_FOR_RESULT')
      && reconciled.planId === fixture.created.planId
      && reconciled.observedRunId === go.runId
      && gt.getTask(ROOT, project, fixture.tasks[0].taskId).linkedRuns.length === 1,
    '10 reconcile tool uses canonical Slice 4 engine without redispatch',
  );
  await shouldThrow(
    () => get('relay_pm_reconcile_execution_plan').handler({
      planId: fixture.created.planId,
      taskId: fixture.tasks[1].taskId,
      runId: 'RUN-injected',
      nextActiveTaskId: fixture.tasks[1].taskId,
      to: 'COMPLETED',
    }),
    '11 reconcile caller cannot choose Task/Run/cursor',
    '허용되지 않은 인자',
  );
}

console.log('\n-- judgment-driven continuation through existing V1 tools --');
{
  const fixture = await createPlanViaMcp('judgment-flow');
  const go = await get('relay_pm_dispatch_execution_plan_owner_approved').handler({
    planId: fixture.created.planId,
    expectedPlanState: 'PLANNED',
  });
  const [taskA, taskB, taskC] = fixture.tasks.map((task) => task.taskId);
  await promoteAndJudge(taskA, go.runId, fixture.workspace, 'ACCEPT');
  let plan = plans.getExecutionPlan(ROOT, project, fixture.created.planId);
  let b = gt.getTask(ROOT, project, taskB);
  check(plan.activeTaskId === taskB && b.linkedRuns.length === 1, '12 Task A ACCEPT via relay_pm_submit_judgment dispatches Task B');

  const bRun1 = b.linkedRuns[0].runId;
  await promoteAndJudge(taskB, bRun1, fixture.workspace, 'CHANGES', {
    reason: 'slice5 changes reason needs detail',
    retryInstruction: 'retry the same Task B fixture work carefully',
  });
  plan = plans.getExecutionPlan(ROOT, project, fixture.created.planId);
  b = gt.getTask(ROOT, project, taskB);
  check(plan.activeTaskId === taskB && gt.getTask(ROOT, project, taskC).linkedRuns.length === 0, '13 Task B CHANGES keeps activeTaskId on Task B');
  check(b.linkedRuns.length === 2, '13 Task B same-Task retry materialized once');

  const bRun2 = b.linkedRuns[1].runId;
  await promoteAndJudge(taskB, bRun2, fixture.workspace, 'ACCEPT');
  plan = plans.getExecutionPlan(ROOT, project, fixture.created.planId);
  const c = gt.getTask(ROOT, project, taskC);
  check(plan.activeTaskId === taskC && c.linkedRuns.length === 1, '14 Task B retry ACCEPT dispatches Task C');

  await promoteAndJudge(taskC, c.linkedRuns[0].runId, fixture.workspace, 'ACCEPT');
  plan = plans.getExecutionPlan(ROOT, project, fixture.created.planId);
  check(plan.state === 'COMPLETED' && plan.activeTaskId === null && !!plan.completedAt, '15 Task C ACCEPT completes Plan');

  // Ordinary Task/Run deliveries remain the wake channel.
  const pending = await get('relay_pm_list_pending_deliveries').handler({});
  check(Array.isArray(pending.deliveries), '16/17 pending-delivery list tool remains ordinary Task/Run surface');
  check(!JSON.stringify(pending).includes('planId'), '16 successor PM Delivery surface stays Task/Run keyed (no Plan channel)');
}

console.log('\n-- V1 single-Task MCP path + fail-closed bounds --');
{
  const workspace = path.join(ROOT, '_workspace-v1-alone');
  fs.mkdirSync(workspace, { recursive: true });
  const created = await get('relay_pm_create_task').handler({
    title: 'v1-alone',
    goal: 'standalone v1 task',
    reason: 'prove V1 path untouched',
    scope: 'v1 only',
  });
  const dispatched = await get('relay_pm_dispatch_owner_approved').handler({
    taskId: created.task.taskId,
    workerId: 'v15-s5-worker',
    workspaceRoot: workspace,
    expectedExecutionState: 'READY',
  });
  check(dispatched.runId && gt.getTask(ROOT, project, created.task.taskId).linkedRuns.length === 1, '18 V1 single-Task MCP path remains unchanged');

  await shouldThrow(
    () => get('relay_pm_get_execution_plan').handler({ planId: 'PLAN-999999' }),
    '20 unknown Plan get fails closed',
    'NOT_FOUND',
  );
  const badReconcile = await get('relay_pm_reconcile_execution_plan').handler({ planId: 'not-a-plan' });
  check(
    badReconcile.status === 'BLOCKED_REQUIRES_OWNER'
      && badReconcile.actionTaken === 'RECONCILIATION_FAILED_CLOSED'
      && !badReconcile.observedRunId,
    '20 malformed planId reconcile fails closed without dispatch',
  );
  await shouldThrow(
    () => get('relay_pm_dispatch_execution_plan_owner_approved').handler({
      planId: 'PLAN-0001',
      expectedPlanState: 'RUNNING',
    }),
    '20 unauthorized expectedPlanState rejected',
    'INVALID_ARGUMENT',
  );

  for (const name of PLAN_TOOL_NAMES) {
    const tool = get(name);
    check(
      tool.inputSchema?.type === 'object'
        && tool.inputSchema.additionalProperties === false
        && typeof tool.description === 'string'
        && tool.description.length > 20,
      `19 ${name} has strict bounded schema`,
    );
  }
  check(!tools.some((tool) => /relay_plan_accept|relay_plan_changes|relay_plan_review/.test(tool.name)), '19 no Plan-specific judgment path added');
  check(baselineNames.includes('relay_pm_create_task') && baselineNames.includes('relay_pm_submit_judgment'), '19 existing V1 tools retained');
}

console.log('\n-- widget pending-delivery behavior unchanged --');
{
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const port = 4805;
  const server = await appServer.startMcpAppServer({ dataRoot: ROOT, project, port });
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`));
  const client = new Client({ name: 'v15-s5-check', version: '0.0.1' });
  await client.connect(transport);
  const { tools: listed } = await client.listTools();
  const names = listed.map((tool) => tool.name);
  for (const want of [...PLAN_TOOL_NAMES, 'relay_pm_list_pending_deliveries', 'relay_pm_submit_judgment', 'relay_pm_open_widget']) {
    check(names.includes(want), `17/chat app exposes ${want}`);
  }
  const resources = await client.listResources();
  check(resources.resources.some((resource) => resource.uri === 'ui://agent-relay/pm-widget-v2'), '17 widget resource unchanged');
  const read = await client.readResource({ uri: 'ui://agent-relay/pm-widget-v2' });
  const html = read.contents[0].text;
  check(html.includes('relay_pm_list_pending_deliveries') && html.includes('relay_pm_claim_wake'), '17 widget still polls pending deliveries');
  check(!html.includes('relay_pm_create_execution_plan'), '17 widget has no Plan-specific wake channel');
  await client.close();
  await new Promise((resolve) => server.close(resolve));
}

dispatcher._resetDispatcherStateForTests();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nV1.5 Slice 5 MCP surface tests complete. Passed: ${passed}, Failed: ${failed}`);
console.log(`CATALOG_FOOTPRINT toolCount=${totalCount} catalogBytes=${totalBytes} newTools=4 planSchemaDeltaBytes=${totalBytes - withoutPlanBytes}`);
if (failed) process.exitCode = 1;
