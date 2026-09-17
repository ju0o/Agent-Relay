/**
 * V2 R4 — Electron Task History panel data contract.
 *
 * The panel renders `history:get` (H1 model) only. These tests pin the
 * panel's required states at the model level plus the IPC wiring proof:
 *   R4-01  single-Run rendering data
 *   R4-02  multi-Run/retry ordering + CHANGES judgment on attempt 1
 *   R4-03  delivery present, judgment absent
 *   R4-04  no delivery yet
 *   R4-05  ACCEPTED task (acceptedRunId surfaced)
 *   R4-06  QA-enabled task + evidence linkage
 *   R4-07  empty task (no runs) + unknown taskId throws (fail-closed)
 *   R4-08  corrupt task.json → throws, nothing repaired (fail-closed)
 *   R4-09  repeated reads byte-identical (read-only proof incl. delivery/judgment)
 *   R4-10  IPC wiring: built main.js dispatches history:get via getTaskHistory
 *   R4-11  Managed Relay Founder-facing status contract stays present
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-v2-r4-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });
const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const relay = await import('../dist/server/backend/fs.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const pmd = await import('../dist/server/backend/pm-delivery.js');
const pmj = await import('../dist/server/backend/pm-judgment.js');
const ta = await import('../dist/server/backend/task-actions.js');
const evk = await import('../dist/server/backend/evidence.js');
const hist = await import('../dist/server/backend/task-history.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const NODE = process.execPath;
const project = 'V2R4Proj';
const date = '2026-09-12';
const agent = 'Codex';

disp._resetDispatcherStateForTests();

const goal = await gt.createGoal(TEST_ROOT, project, {
  title: 'V2 R4 goal', goalStatement: 'panel test goal',
  permissionPolicy: { mode: 'BYPASS' },
});

async function makeReadyTask(title, extra = {}) {
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId, title, goal: 'g', reason: 'r', scope: 's', ...extra,
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  return gt.getTask(TEST_ROOT, project, t.taskId);
}

function registerWorker(workerId) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: NODE,
    launchArgsPrefix: [FIX_ZERO], capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
  });
}

async function dispatchInstant(taskId, workerId) {
  registerWorker(workerId);
  const ws = path.join(WORKSPACE, taskId);
  fs.mkdirSync(ws, { recursive: true });
  await disp.dispatchTask(TEST_ROOT, project, {
    taskId, workerId, workspaceRoot: ws, expectedExecutionState: 'READY',
  });
  for (let i = 0; i < 50; i++) {
    const t = gt.getTask(TEST_ROOT, project, taskId);
    if (t.executionState === 'DISPATCHED' || t.executionState === 'RUNNING') return t;
    await sleep(40);
  }
  throw new Error(`never dispatched: ${taskId}`);
}

let runSeq = 0;
function linkRun(taskId, { prompt = true, result = true } = {}) {
  // Run folders are shared per project/date/agent (not per task) — use a
  // unique agent per linked run so fixtures never collide.
  runSeq += 1;
  const nn = String(runSeq).padStart(2, '0');
  const folder = relay.ensureRunFolder(TEST_ROOT, project, date, `${agent}-${nn}`, '01');
  if (prompt) relay.writeMarkdown(folder, 'prompt.md', `# p${nn}\n`, false);
  if (result) relay.writeMarkdown(folder, 'result.md', `# r${nn}\n`, false);
  return gt.linkRunToTask(TEST_ROOT, project, taskId, folder);
}

// R4-01: single run ----------------------------------------------------------
console.log('\n-- R4-01: single run --');
const t1 = await makeReadyTask('single task');
await linkRun(t1.taskId);
{
  const h = hist.getTaskHistory(TEST_ROOT, project, t1.taskId);
  check(h.attempts.length === 1, 'one attempt');
  const a = h.attempts[0];
  check(a.taskRunSequence === 1 && a.hasPrompt && a.hasResult, 'P/R present, seq 1');
  check(a.delivery === null && a.judgment === null, 'no delivery/judgment yet');
}

// R4-02: retry lineage -------------------------------------------------------
console.log('\n-- R4-02: multi-run retry --');
const t2 = await makeReadyTask('retry task');
{
  // Attempt 1 comes from a real dispatch (filled in afterwards so the
  // folder stays the kernel-materialized one); attempt 2 is linked.
  let d = await dispatchInstant(t2.taskId, 'w-r4b');
  const f1 = d.linkedRuns[0].folder;
  relay.writeMarkdown(f1, 'prompt.md', '# p1\n', false);
  relay.writeMarkdown(f1, 'result.md', '# r1\n', false);
  // Delivery + judgment BEFORE linking run 2 so they attach to attempt 1
  // (ensurePmDelivery targets the current attempt at call time).
  let t = gt.getTask(TEST_ROOT, project, t2.taskId);
  await rt.markResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
  const delivery = await pmd.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t.taskId);
  await pmj.submitPmJudgment(TEST_ROOT, project, {
    deliveryId: delivery.deliveryId, decision: 'CHANGES',
    reason: 'needs more work here', retryInstruction: 'fix it',
  });
  await linkRun(t2.taskId, { prompt: false });
  t = gt.getTask(TEST_ROOT, project, t2.taskId);
  const h = hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  check(h.attempts.length === 2, 'two attempts');
  check(h.attempts[0].taskRunSequence === 1 && h.attempts[1].taskRunSequence === 2, 'sequence ascending');
  check(h.attempts[0].judgment?.decision === 'CHANGES', 'CHANGES on attempt 1');
  check(h.attempts[1].judgment === null && h.attempts[1].hasResult, 'attempt 2 pending, result-only');
}

// R4-03 + R4-04: delivery states ----------------------------------------------
console.log('\n-- R4-03/R4-04: delivery states --');
const t3 = await makeReadyTask('delivery task');
{
  let d = await dispatchInstant(t3.taskId, 'w-r4c');
  const f1 = d.linkedRuns[0].folder;
  relay.writeMarkdown(f1, 'prompt.md', '# p\n', false);
  relay.writeMarkdown(f1, 'result.md', '# r\n', false);
  let t = gt.getTask(TEST_ROOT, project, t3.taskId);
  await rt.markResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
  let h = hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  check(h.attempts[0].delivery === null, 'R4-04: no delivery yet → null');
  const delivery = await pmd.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t.taskId);
  h = hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  check(h.attempts[0].delivery?.deliveryId === delivery.deliveryId, 'R4-03: delivery rendered');
  check(h.attempts[0].judgment === null, 'R4-03: judgment absent → null');
}

// R4-05: ACCEPTED --------------------------------------------------------------
console.log('\n-- R4-05: accepted --');
{
  const t = gt.getTask(TEST_ROOT, project, t3.taskId);
  await ta.acceptTaskResult({
    dataRoot: TEST_ROOT, project, goalId: goal.goalId, taskId: t.taskId,
    runId: t.linkedRuns[0].runId, reason: 'R4 fixture accept',
    expectedPmState: 'VERIFYING', expectedExecutionState: 'RESULT_RECEIVED',
    callerSurface: 'OWNER_IPC',
  });
  const h = hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  check(h.task.acceptedRunId === t.linkedRuns[0].runId, 'acceptedRunId surfaced');
  // acceptTaskResult applies the ACCEPT verdict to the Task; it does not
  // mint a separate PMJ record, so the panel reads ACCEPTED state + winner.
  check(h.task.pmState === 'ACCEPTED', 'ACCEPTED state rendered');
}

// R4-06: QA + evidence ----------------------------------------------------------
console.log('\n-- R4-06: QA + evidence --');
const t4 = await makeReadyTask('qa task', {
  acceptanceCriteria: [{ id: 'AC-1', description: 'result exists', validationMode: 'DETERMINISTIC' }],
  qaContract: { deterministic: [{ kind: 'fileExists', path: 'result.md', criterionId: 'AC-1' }] },
});
await linkRun(t4.taskId);
{
  // QA receipt path needs a dispatched run; the linked run documents the files.
  await dispatchInstant(t4.taskId, 'w-r4d');
  const t = gt.getTask(TEST_ROOT, project, t4.taskId);
  await rt.markQaResultReceived(TEST_ROOT, project, t.taskId, t.linkedRuns[0].runId);
  await evk.recordTestEvidence(TEST_ROOT, project, {
    summary: 'R4 fixture test evidence', status: 'PASS',
    taskId: t.taskId, runId: t.linkedRuns[0].runId,
  });
  await evk.recordQaEvidence(TEST_ROOT, project, {
    summary: 'R4 fixture QA verdict', status: 'PASS',
    taskId: t.taskId, runId: t.linkedRuns[0].runId,
  });
  const h = hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  check(h.task.qaContract !== undefined, 'qaContract visible');
  check(h.evidence.length >= 1 && h.evidence.some((e) => e.type === 'TEST'), 'evidence linked');
  check(h.evidence.some((e) => e.type === 'QA' && e.status === 'PASS'), 'QA strip data present');
}

// R4-07: empty + unknown ---------------------------------------------------------
console.log('\n-- R4-07: empty + unknown --');
{
  const te = await makeReadyTask('empty task');
  const h = hist.getTaskHistory(TEST_ROOT, project, te.taskId);
  check(h.attempts.length === 0 && h.events.length === 0, 'empty states renderable');
  let threw = false;
  try { hist.getTaskHistory(TEST_ROOT, project, 'TASK-9999'); }
  catch { threw = true; }
  check(threw, 'unknown taskId throws (fail-closed)');
}

// R4-08: corrupt record ------------------------------------------------------------
console.log('\n-- R4-08: corrupt record --');
{
  const tc = await makeReadyTask('corrupt task');
  const taskFile = path.join(TEST_ROOT, project, '_relay', 'tasks', tc.taskId, 'task.json');
  const saved = fs.readFileSync(taskFile, 'utf8');
  fs.writeFileSync(taskFile, '{corrupt!!!');
  let threw = false;
  try { hist.getTaskHistory(TEST_ROOT, project, tc.taskId); }
  catch { threw = true; }
  check(threw, 'corrupt task.json throws (fail-closed, no repair)');
  check(fs.readFileSync(taskFile, 'utf8') === '{corrupt!!!', 'corrupt file untouched (no repair attempt)');
  fs.writeFileSync(taskFile, saved);
}

// R4-09: read-only across refreshes ---------------------------------------------------
console.log('\n-- R4-09: repeated refresh read-only --');
{
  const t = gt.getTask(TEST_ROOT, project, t2.taskId);
  const files = [
    path.join(TEST_ROOT, project, '_relay', 'tasks', t.taskId, 'task.json'),
    path.join(t.linkedRuns[0].folder, 'meta.json'),
  ];
  const delivery = await pmd.ensurePmDeliveryForTaskVerify(TEST_ROOT, project, t.taskId).catch(() => null);
  if (delivery) {
    files.push(path.join(TEST_ROOT, project, '_relay', 'pm-deliveries', delivery.deliveryId, 'delivery.json'));
    try {
      files.push(path.join(TEST_ROOT, project, '_relay', 'pm-judgments', pmj.pmJudgmentIdFor(delivery.deliveryId), 'judgment.json'));
    } catch { /* judgment file may use another name — optional */ }
  }
  const before = files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f));
  hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  hist.getTaskHistory(TEST_ROOT, project, t.taskId);
  const after = files.filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f));
  check(before.length === after.length && before.every((b, i) => b.equals(after[i])), '3 refreshes, zero byte drift');
}

// R4-10: IPC wiring ----------------------------------------------------------------------
console.log('\n-- R4-10: IPC wiring --');
{
  const mainJs = fs.readFileSync(path.join(process.cwd(), 'dist/server/backend/main.js'), 'utf8');
  check(mainJs.includes("'history:get'") || mainJs.includes('"history:get"'), 'built main dispatches history:get');
}

// R4-11: Managed Relay UI contract --------------------------------------------------
console.log('\n-- R4-11: Managed Relay UI contract --');
{
  const panelSource = fs.readFileSync(path.join(process.cwd(), 'src/frontend/taskhistory.tsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(process.cwd(), 'src/frontend/App.tsx'), 'utf8');
  const requiredLabels = [
    'Goal:',
    'Current Task:',
    'Current Run:',
    'Assigned Agent:',
    'Status:',
    'Result:',
    'Review / Judgment:',
    'Next:',
  ];
  check(requiredLabels.every((label) => panelSource.includes(label)), 'Founder-facing canonical relay fields stay visible');
  check(panelSource.includes('SAME TASK → NEW RUN'), 'CHANGES keeps same-Task retry lineage visible');
  check(panelSource.includes('NEXT / GOAL COMPLETE CHECK'), 'PASS makes NEXT/complete transition visible');
  check(panelSource.includes("goalStatus === 'WAITING_OWNER'") && panelSource.includes("return 'OWNER_REQUIRED'"), 'WAITING_OWNER projects as OWNER_REQUIRED');
  check(panelSource.includes("t?.executionState === 'RESULT_RECEIVED'") && panelSource.includes("? 'RECEIVED'"), 'canonical RESULT_RECEIVED wins over file-presence hint');
  check(appSource.includes('⚡ Managed Relay'), 'desktop app exposes Managed Relay entry');
}

console.log(`\n결과: ${passed} passed, ${failed} failed`);
disp._resetDispatcherStateForTests();
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
