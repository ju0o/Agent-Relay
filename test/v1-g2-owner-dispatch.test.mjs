/**
 * V1-G2 — Owner-approved one-call dispatch.
 *
 * Covers:
 *   A. V1 Task created under internal PLAN Goal
 *   B. ordinary relay_pm_dispatch_task still fails under PLAN
 *   C. new owner-approved dispatch surface succeeds under same PLAN Goal
 *   D. exactly one Run is linked
 *   E. Task reaches expected dispatcher state under test spawn path
 *   F. Goal permissionPolicy remains PLAN after dispatch
 *   G. runtime fields / command injection cannot be supplied
 *   H. stale/non-READY dispatch rejected
 *   I. no second dispatch of same active Task
 *   J. no auto-dispatch of unrelated Tasks
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v1-g2-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

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
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

const project = 'V1G2Proj';
const ctx = { dataRoot: TEST_ROOT, project };
const tools = pmTools.buildAllPmTools(ctx);
const get = (name) => tools.find((t) => t.name === name);

const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

const CONTRACT = {
  title: 'V1 G2 task',
  goal: 'Intended outcome for V1 worker',
  reason: 'PM finalized contract reason',
  scope: 'Narrow V1 scope',
  completionCriteria: ['done when worker result received'],
};

// Keep fixture child alive across assertions; reset kills it.
process.env.WORKER_STAY_MS = '30000';
disp._resetDispatcherStateForTests();

wr.writeWorkerRegistryRecord(TEST_ROOT, {
  schemaVersion: 'G.2',
  workerId: 'v1-g2-worker',
  displayName: 'V1 G2 fixture worker',
  launchCommand: NODE,
  launchArgsPrefix: [FIX_ALIVE],
  capabilities: ['fixture'],
  observationAdapterId: 'test-fixture',
});

// ── A: V1 Task created under internal PLAN Goal ──
console.log('\n-- A: V1 intake under internal PLAN Goal --');
const intake = await get('relay_pm_create_task').handler({ ...CONTRACT });
const taskId = intake.task.taskId;
const goalId = intake.goal.goalId;
{
  const goal = gt.getGoal(TEST_ROOT, project, goalId);
  check(Array.isArray(goal.tags) && goal.tags.includes('v1-internal'), 'A internal container tagged v1-internal');
  check(goal.permissionPolicy?.mode === 'PLAN', `A internal Goal remains PLAN (got ${goal.permissionPolicy?.mode})`);
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.executionState === 'READY', `A task READY (got ${t.executionState})`);
  check(t.pmState === 'PENDING', `A task PENDING (got ${t.pmState})`);
  check(t.linkedRuns.length === 0, 'A no auto-dispatch (no linked runs)');
}

// ── B: ordinary PM dispatch still denied under PLAN ──
console.log('\n-- B: ordinary dispatch denied under PLAN --');
{
  await shouldThrow(
    () => get('relay_pm_dispatch_task').handler({
      taskId, workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
    }),
    'B ordinary relay_pm_dispatch_task denied under PLAN',
    'FORBIDDEN',
  );
  const t = gt.getTask(TEST_ROOT, project, taskId);
  check(t.executionState === 'READY', 'B task still READY after denied dispatch');
  check(t.linkedRuns.length === 0, 'B no Run linked by denied dispatch');
}

// ── tool contract ──
console.log('\n-- contract: owner-approved tool shape --');
{
  const tool = get('relay_pm_dispatch_owner_approved');
  check(!!tool, 'contract relay_pm_dispatch_owner_approved registered');
  const required = tool.inputSchema?.required ?? [];
  for (const f of ['taskId', 'workerId', 'workspaceRoot', 'expectedExecutionState']) {
    check(required.includes(f), `contract requires ${f}`);
  }
  check(tool.inputSchema?.additionalProperties === false, 'contract additionalProperties=false');
}

// ── C/D/E: owner-approved dispatch succeeds, one Run, RUNNING ──
console.log('\n-- C/D/E: owner-approved dispatch --');
let dispatchRes;
{
  dispatchRes = await get('relay_pm_dispatch_owner_approved').handler({
    taskId, workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
  });
  check(dispatchRes && dispatchRes.taskId === taskId, 'C owner-approved dispatch succeeds under PLAN Goal');
  check(!!dispatchRes.runId, 'D dispatch returns one runId');
  const after = gt.getTask(TEST_ROOT, project, taskId);
  check(after.linkedRuns.length === 1, `D exactly one Run linked (got ${after.linkedRuns.length})`);
  check(after.linkedRuns[0].runId === dispatchRes.runId, 'D linked run matches dispatch result');
  check(
    dispatchRes.executionState === 'RUNNING' && after.executionState === 'RUNNING',
    `E Task RUNNING via dispatcher spawn path (got ${after.executionState})`,
  );
  const json = JSON.stringify(dispatchRes);
  check(!json.includes('folder') && !json.includes('launchCommand'), 'E response exposes no folder/launchCommand');
}

// ── F: Goal remains PLAN ──
console.log('\n-- F: Goal policy unchanged --');
{
  const goal = gt.getGoal(TEST_ROOT, project, goalId);
  check(goal.permissionPolicy?.mode === 'PLAN', `F Goal permissionPolicy still PLAN (got ${goal.permissionPolicy?.mode})`);
}

// ── G: runtime/command injection rejected ──
console.log('\n-- G: forbidden fields rejected --');
{
  const base = { taskId, workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY' };
  for (const field of [
    'goalId', 'permissionMode', 'permissionPolicy', 'runId', 'launchCommand',
    'adapterId', 'observationAdapterId', 'launchArgsPrefix', 'args', 'cliArgs',
    'env', 'environment', 'shell', 'cwd', 'workingDirectory', 'command',
  ]) {
    await shouldThrow(
      () => get('relay_pm_dispatch_owner_approved').handler({ ...base, [field]: 'INJECT' }),
      `G forbidden field ${field} rejected`,
      field,
    );
  }
}

// ── H: stale / non-READY / missing / invalid rejected ──
console.log('\n-- H: stale + invalid preconditions --');
{
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId, workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'BLOCKED',
    }),
    'H stale expectedExecutionState rejected',
    'READY',
  );
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId: 'TASK-9999', workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
    }),
    'H missing task rejected',
    'NOT_FOUND',
  );
  // Worker/workspace preconditions need a fresh READY task (primary task is RUNNING now).
  const probe = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G2 probe' });
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId: probe.task.taskId, workerId: 'no-such-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
    }),
    'H unknown worker rejected',
    'NOT_FOUND',
  );
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId: probe.task.taskId, workerId: 'v1-g2-worker',
      workspaceRoot: path.join(TEST_ROOT, 'no-such-workspace'),
      expectedExecutionState: 'READY',
    }),
    'H invalid workspaceRoot rejected',
    'workspaceRoot',
  );
  {
    const t = gt.getTask(TEST_ROOT, project, probe.task.taskId);
    check(t.executionState === 'READY', 'H probe task still READY after rejected dispatches');
    check(t.linkedRuns.length === 0, 'H probe task has no linked runs after rejected dispatches');
  }
}

// ── I: no second dispatch of same active Task ──
console.log('\n-- I: second dispatch blocked --');
{
  const before = gt.getTask(TEST_ROOT, project, taskId).linkedRuns.length;
  await shouldThrow(
    () => get('relay_pm_dispatch_owner_approved').handler({
      taskId, workerId: 'v1-g2-worker', workspaceRoot: WORKSPACE, expectedExecutionState: 'READY',
    }),
    'I second dispatch of active Task rejected',
    'INVALID_STATE',
  );
  const after = gt.getTask(TEST_ROOT, project, taskId);
  check(after.linkedRuns.length === before, `I no extra Run linked (still ${after.linkedRuns.length})`);
}

// ── J: unrelated Tasks untouched ──
console.log('\n-- J: no auto-dispatch of unrelated Tasks --');
{
  const second = await get('relay_pm_create_task').handler({ ...CONTRACT, title: 'V1 G2 sibling' });
  check(second.goal.goalId === goalId, 'J sibling reuses same internal container');
  const sib = gt.getTask(TEST_ROOT, project, second.task.taskId);
  check(sib.executionState === 'READY', `J sibling stays READY (got ${sib.executionState})`);
  check(sib.linkedRuns.length === 0, 'J sibling has no linked runs (no auto-dispatch)');
  const all = gt.listTasks(TEST_ROOT, project);
  check(all.length === 3, `J exactly three tasks total (got ${all.length})`);
}

// ── structural safety ──
console.log('\n-- structural safety --');
{
  const pmSrc = fs.readFileSync('src/mcp/pm-tools.ts', 'utf8');
  const gateSrc = fs.readFileSync('src/backend/permission-gate.ts', 'utf8');
  check(pmSrc.includes('relay_pm_dispatch_owner_approved'), 'S owner-approved tool registered in pm-tools');
  // Ordinary PM dispatch path unchanged: PM_MCP surface + central PLAN denial intact.
  check(
    pmSrc.includes("callerSurface: 'PM_MCP'") && gateSrc.includes('PM_MCP DISPATCH denied in PLAN mode'),
    'S ordinary PM PLAN dispatch denial intact',
  );
  const helperSrc = fs.readFileSync('src/backend/v1-dispatch.ts', 'utf8');
  check(helperSrc.includes("callerSurface: 'OWNER_IPC'"), 'S owner-approved path uses OWNER_IPC-equivalent gate');
  check(helperSrc.includes('authorizeEffect'), 'S owner-approved path enforces central permission gate');
  check(helperSrc.includes('dispatchTask'), 'S owner-approved path reuses canonical dispatcher.dispatchTask');
  check(
    !helperSrc.includes('updateGoal') && !helperSrc.includes('persistGoalRecord')
      && !helperSrc.includes("mode: 'APPROVE'") && !helperSrc.includes("mode: 'BYPASS'"),
    'S no Goal policy mutation',
  );
  check(
    !helperSrc.includes('approvalToken') && !helperSrc.includes('createToken') && !helperSrc.includes('issueToken'),
    'S no approval token',
  );
  check(!helperSrc.includes('acceptResult') && !helperSrc.includes('completeGoal'), 'S no accept/complete orchestration');
  const intakeSrc = fs.readFileSync('src/backend/v1-intake.ts', 'utf8');
  check(!intakeSrc.includes('dispatchTask'), 'S intake still never dispatches');
}

disp._resetDispatcherStateForTests();
await (await import('../dist/server/backend/capture-service.js'))._resetCaptureServiceForTests().catch(() => undefined);
delete process.env.WORKER_STAY_MS;

fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nV1-G2 Tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
