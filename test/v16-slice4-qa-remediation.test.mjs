/**
 * V1.6 Slice 4 — QA FAIL → same-Task remediation. Runs against compiled
 * server modules under dist/server.
 *
 * Covers the required Slice 4 matrix: happy deterministic remediation,
 * semantic remediation, QA PASS (no ACCEPT / no Plan advancement),
 * QA BLOCKED (deterministic + semantic), retry budget (2 → 3 Runs, no 4th),
 * identity preservation, idempotency, concurrency, corruption, contract
 * validation, result-bridge insertion, GPT PM authority regression, and
 * QA-vs-G5 lineage distinction. Real canonical dispatchTask is exercised
 * for every remediation Run (spawn is a real immediate-exit `node -e`
 * worker under the test-fixture observation adapter — no real Claude call).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s4-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};
async function throwsWithCode(fn, code, message) {
  try {
    await fn();
    check(false, `${message} (did not throw)`);
  } catch (err) {
    check(err && err.code === code, `${message} (got code=${err && err.code}: ${err && err.message})`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gt = await import('../dist/server/backend/goal-task.js');
const gtr = await import('../dist/server/backend/goal-task-runtime.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const bridge = await import('../dist/server/backend/result-bridge.js');
const observation = await import('../dist/server/backend/observation-lock.js');
const captureSvc = await import('../dist/server/backend/capture-service.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const qaPrompt = await import('../dist/server/backend/qa-remediation-prompt.js');
const fsKernel = await import('../dist/server/backend/fs.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const project = 'V16Slice4';
const NODE = process.execPath;
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ZERO_FIXTURE = path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs');

wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 's4-worker', displayName: 's4 fixture implementation worker',
  launchCommand: NODE, launchArgsPrefix: [EXIT_ZERO_FIXTURE],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

let idCounter = 0;
let goalCache = null;
async function goal() {
  if (!goalCache) goalCache = await gt.createGoal(ROOT, project, { title: 'S4 goal', goalStatement: 'S4 fixture goal' });
  return goalCache;
}

function detFileContract() {
  return {
    acceptanceCriteria: [{ id: 'AC-01', description: 'output file out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  };
}

async function makeQaTask({ scope = 'fixture scope; authorized file: out.txt', criteria, contract } = {}) {
  const g = await goal();
  const c = criteria ?? detFileContract().acceptanceCriteria;
  const q = contract ?? detFileContract().qaContract;
  return gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'S4 QA task', goal: 'S4 fixture task', reason: 'fixture', scope,
    completionCriteria: ['fixture done'], executionState: 'RUNNING', pmState: 'PENDING',
    acceptanceCriteria: c, qaContract: q,
  });
}

async function linkRun(taskId, { resultText = 'fixture result', files = {} } = {}) {
  idCounter += 1;
  const n = idCounter;
  const workspaceRoot = path.join(ROOT, 'ws', `t-${n}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', `run-${n}`);
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s4-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 's4-worker' }), 'utf8');
  const task = await gt.linkRunToTask(ROOT, project, taskId, folder);
  const link = task.linkedRuns.find((r) => r.runId === runId);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(folder, 'result.md'), resultText, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(workspaceRoot, rel), content, 'utf8');
  }
  return { runId, folder, workspaceRoot, taskRunSequence: link.taskRunSequence };
}

async function receive(taskId, runId) {
  return gtr.markQaResultReceived(ROOT, project, taskId, runId);
}

function release(taskId, runId, workspaceRoot) {
  // Mirror what the result bridge does on promotion: free the observation slot.
  observation.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId, runId });
}

async function waitForNoLive(taskId, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const st = await disp.getDispatchStatus(ROOT, project, taskId);
    if (!st.active) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for live dispatch to clear: ${taskId}`);
    await sleep(50);
  }
}

/** Simulate a full Worker cycle for the CURRENT (latest) run, then reconcile. */
async function completeCurrentRunAndReconcile(taskId, { resultText = 'fixture result', files = {} } = {}) {
  const t = gt.getTask(ROOT, project, taskId);
  const latest = [...t.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const meta = fsKernel.readRunMeta(latest.folder);
  fs.mkdirSync(path.join(latest.folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(latest.folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(latest.folder, 'result.md'), resultText, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(meta.workspaceRoot, rel), content, 'utf8');
  }
  release(taskId, latest.runId, meta.workspaceRoot);
  await receive(taskId, latest.runId);
  const res = await gate.reconcileQaGate(ROOT, project, taskId);
  await waitForNoLive(taskId);
  return res;
}

function deliveriesFor(taskId) {
  return pmDel.listPmDeliveries(ROOT, project).filter((d) => d.taskId === taskId);
}
function prepsFor(taskId) {
  return qrp.listQaRemediationPreparations(ROOT, project).filter((p) => p.taskId === taskId);
}

async function resetLocal() {
  disp._resetDispatcherStateForTests();
  await captureSvc._resetCaptureServiceForTests();
  pmDel._resetPmDeliveryLocksForTests();
  qa._resetQaAttemptLocksForTests();
  qrp._resetQaRemediationPreparationLocksForTests();
  gate._resetQaGateLocksForTests();
  testFix.ensureTestFixtureAdapterRegistered();
}

function responseComplete(sessionId, text, workspace) {
  return {
    adapterId: 'test-fixture', agentName: 'TestFixture', sessionId, workspace,
    observedAt: new Date().toISOString(), terminalSignal: 'test.complete',
    rawFinalText: text, completionKind: 'RESPONSE_COMPLETE',
  };
}

// Fake semantic QA workers (.mjs files run as `node <file> --print <prompt>`).
const FAKE_QA_DIR = path.join(ROOT, '_fake-qa-workers');
fs.mkdirSync(FAKE_QA_DIR, { recursive: true });
let qaWorkerCounter = 0;
function registerFakeQaWorker(script) {
  qaWorkerCounter += 1;
  const workerId = `fake-qa-${qaWorkerCounter}`;
  const scriptPath = path.join(FAKE_QA_DIR, `${workerId}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: NODE, launchArgsPrefix: [scriptPath], role: 'qa',
  });
  return workerId;
}
const PASS_SCRIPT = `const p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: PASS');\nconsole.log('criteria:');\nfor (const id of ids) console.log('- ' + id + ': PASS');\n`;
const FAIL_SCRIPT = `const p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: FAIL');\nconsole.log('failedCriteria:');\nconsole.log('- ' + ids[0]);\nconsole.log('reason: fake semantic failure');\nconsole.log('remediationInstruction: rewrite the file to express the correct status');\n`;
const GARBAGE_SCRIPT = `console.log('this is not a structured status block at all');\n`;

// ── A. Contract validation at Task creation (§7) ─────────────────────────────
console.log('\n== A. QA contract validation (creation-time, fail closed) ==');
{
  const g = await goal();
  const base = {
    goalId: g.goalId, title: 't', goal: 'gg', reason: 'r', scope: 'scope mentions out.txt',
    executionState: 'RUNNING', pmState: 'PENDING',
  };
  const bad = async (patch, label) => {
    try {
      await gt.createTask(ROOT, project, { ...base, ...patch });
      check(false, `${label} (created, should have thrown)`);
    } catch (err) {
      check(true, `${label} (rejected: ${String(err.message).slice(0, 80)})`);
    }
  };
  await bad({ acceptanceCriteria: detFileContract().acceptanceCriteria }, 'A1 qaContract without acceptanceCriteria rejected');
  await bad({ qaContract: detFileContract().qaContract }, 'A2 acceptanceCriteria without qaContract rejected');
  await bad({
    acceptanceCriteria: [{ id: 'AC-01', description: 'x', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'teleport', path: 'out.txt', criterionId: 'AC-01' }] },
  }, 'A3 non-frozen check kind rejected');
  await bad({
    acceptanceCriteria: [{ id: 'AC-01', description: 'x', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'command', command: 'npm test -- --watch; rm -rf /', args: [], criterionId: 'AC-01' }] },
  }, 'A4 shell-string command rejected');
  await bad({
    acceptanceCriteria: [{ id: 'AC-01', description: 'x', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'other.txt', criterionId: 'AC-99' }] },
  }, 'A5 DETERMINISTIC AC with no attributed check rejected');
  await bad({
    acceptanceCriteria: [{ id: 'AC-02', description: 'semantic thing', validationMode: 'SEMANTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }] },
  }, 'A6 SEMANTIC AC without qaWorkerId rejected');
  await bad({
    acceptanceCriteria: [{ id: 'AC-01', description: 'x', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'diffScope', allowedPaths: ['nowhere-near.txt'], criterionId: 'AC-01' }] },
  }, 'A7 out-of-scope diffScope.allowedPaths rejected');
  await bad({
    acceptanceCriteria: [
      { id: 'AC-01', description: 'x', validationMode: 'DETERMINISTIC' },
      { id: 'AC-01', description: 'y', validationMode: 'DETERMINISTIC' },
    ],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  }, 'A8 duplicate AC ids rejected');
  const ok = await gt.createTask(ROOT, project, {
    ...base, acceptanceCriteria: detFileContract().acceptanceCriteria, qaContract: detFileContract().qaContract,
  });
  check(ok.acceptanceCriteria?.length === 1 && ok.qaContract?.deterministic.length === 1, 'A9 valid contract creates (stored normalized)');
  const reread = gt.getTask(ROOT, project, ok.taskId);
  check(JSON.stringify(reread.qaContract) === JSON.stringify(ok.qaContract), 'A10 contract survives persist/read round-trip');
  try {
    gt.updateTask(ROOT, project, ok.taskId, { qaContract: { deterministic: [] } });
    check(false, 'A11 task:update with qaContract (should have thrown)');
  } catch { check(true, 'A11 task:update with qaContract rejected (frozen at creation)'); }
}

// ── B. Happy remediation: deterministic FAIL → same-Task Run 2 ──────────────
console.log('\n== B. deterministic FAIL → preparation → same-Task Run 2 ==');
{
  await resetLocal();
  const task = await makeQaTask();
  const run1 = await linkRun(task.taskId); // out.txt NOT created → FAIL
  const contractBefore = JSON.stringify({ g: task.goal, s: task.scope, c: task.completionCriteria, ac: task.acceptanceCriteria, q: task.qaContract });
  await receive(task.taskId, run1.runId);
  const afterReceive = gt.getTask(ROOT, project, task.taskId);
  check(afterReceive.executionState === 'RESULT_RECEIVED' && afterReceive.pmState === 'PENDING', 'B1 receipt keeps PENDING (no premature VERIFYING)');
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', `B2 outcome DISPATCHED (got ${res.outcome})`);
  check(res.finalQaStatus === 'FAIL', 'B3 finalQaStatus FAIL');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.linkedRuns.length === 2, `B4 exactly 2 linked Runs (got ${t.linkedRuns.length})`);
  check(t.pmState === 'PENDING', 'B5 pmState still PENDING (no VERIFYING, no CHANGES_REQUESTED, no ACCEPTED)');
  const run2link = [...t.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  check(run2link.taskRunSequence === 2, 'B6 remediation Run has taskRunSequence 2');
  const meta2 = fsKernel.readRunMeta(run2link.folder);
  check(meta2.qaRemediationPreparationId === `QRP-QA-${task.taskId}-${run1.runId}`, 'B7 Run2 meta carries qaRemediationPreparationId');
  check(!meta2.retryPreparationId, 'B8 Run2 meta has NO retryPreparationId (lineage distinct)');
  check(meta2.sourceRunId === run1.runId, 'B9 Run2 meta sourceRunId = Run1');
  check(meta2.workerId === 's4-worker' && meta2.workspaceRoot === run1.workspaceRoot, 'B10 same Worker + same workspace binding');
  check(fs.existsSync(path.join(run2link.folder, 'qa-remediation-context.json')), 'B11 qa-remediation-context.json persisted on Run2');
  check(!fs.existsSync(path.join(run2link.folder, 'retry-context.json')), 'B12 NO retry-context.json on Run2');
  const prompt = fs.readFileSync(path.join(run2link.folder, 'prompt.md'), 'utf8');
  check(prompt.includes('SAME Task') && prompt.includes('Do NOT reinterpret or expand'), 'B13 prompt carries SAME-Task remediation banner');
  check(prompt.includes('AC-01'), 'B14 prompt names the failed criterion');
  const contractAfter = JSON.stringify({ g: t.goal, s: t.scope, c: t.completionCriteria, ac: t.acceptanceCriteria, q: t.qaContract });
  check(contractBefore === contractAfter, 'B15 Task contract unchanged across remediation');
  const preps = prepsFor(task.taskId);
  check(preps.length === 1 && preps[0].status === 'READY' && preps[0].dispatchedRunId === run2link.runId, 'B16 one READY prep, consumed by Run2');
  check(preps[0].qaRemediationNumber === 1, 'B17 qaRemediationNumber 1 (authoritative budget counter)');
  const attempts = qa.listQaAttemptsForTask(ROOT, project, task.taskId);
  check(attempts.length === 1 && attempts[0].finalQaStatus === 'FAIL' && attempts[0].remediationPreparationId === preps[0].preparationId, 'B18 one FAIL attempt linked to the prep');
  check(attempts[0].failedCriteria.includes('AC-01'), 'B19 failedCriteria derived from deterministic evidence (AC-01)');
  check(deliveriesFor(task.taskId).length === 0, 'B20 NO PM Delivery on FAIL-with-budget');
}

// ── C. Semantic remediation: det PASS + semantic FAIL → Run 2 ───────────────
console.log('\n== C. semantic FAIL → same-Task Run 2 ==');
{
  await resetLocal();
  const qaWorkerId = registerFakeQaWorker(FAIL_SCRIPT);
  const task = await makeQaTask({
    scope: 'fixture scope; authorized file: out.txt',
    criteria: [
      { id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' },
      { id: 'AC-02', description: 'content expresses the correct status', validationMode: 'SEMANTIC' },
    ],
    contract: {
      deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }],
      semantic: { qaWorkerId },
    },
  });
  const run1 = await linkRun(task.taskId, { files: { 'out.txt': 'status=wrong' } }); // det PASS, semantic FAIL
  await receive(task.taskId, run1.runId);
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(res.outcome === 'FAIL_REMEDIATION_DISPATCHED', `C1 semantic FAIL dispatches (got ${res.outcome})`);
  const attempts = qa.listQaAttemptsForTask(ROOT, project, task.taskId);
  check(attempts.length === 1 && attempts[0].deterministic?.status === 'PASS' && attempts[0].semantic?.status === 'FAIL', 'C2 deterministic PASS + semantic FAIL both recorded independently');
  check(attempts[0].failedCriteria.includes('AC-02'), 'C3 failedCriteria carries the semantic failure (AC-02)');
  check(typeof attempts[0].remediationInstruction === 'string' && attempts[0].remediationInstruction.includes('rewrite'), 'C4 semantic remediationInstruction persisted on the attempt');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.linkedRuns.length === 2 && t.pmState === 'PENDING', 'C5 same-Task Run2, pmState PENDING');
  const run2link = [...t.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
  const prompt = fs.readFileSync(path.join(run2link.folder, 'prompt.md'), 'utf8');
  check(prompt.includes('rewrite the file'), 'C6 remediation prompt carries the semantic instruction');
  check(deliveriesFor(task.taskId).length === 0, 'C7 NO PM Delivery on semantic FAIL');
}

// ── D. QA PASS: delivery, no ACCEPT, no Plan advancement ─────────────────────
console.log('\n== D. QA PASS → delivery, never ACCEPT/advance ==');
{
  await resetLocal();
  const task = await makeQaTask();
  const run1 = await linkRun(task.taskId, { files: { 'out.txt': 'hello' } });
  await receive(task.taskId, run1.runId);
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res.outcome === 'PASS_DELIVERED', `D1 outcome PASS_DELIVERED (got ${res.outcome})`);
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.executionState === 'RESULT_RECEIVED' && t.pmState === 'VERIFYING', 'D2 RESULT_RECEIVED+VERIFYING (ordinary review state)');
  check(t.acceptedRunId === undefined && t.pmState !== 'ACCEPTED', 'D3 Task NOT ACCEPTED');
  check(t.linkedRuns.length === 1, 'D4 no remediation Run on PASS');
  check(deliveriesFor(task.taskId).length === 1, 'D5 exactly one ordinary Delivery minted');
  check(prepsFor(task.taskId).length === 0, 'D6 no remediation preparation on PASS');
}

// ── E. QA BLOCKED: escalate, never remediate ─────────────────────────────────
console.log('\n== E. deterministic BLOCKED → escalate, no remediation ==');
{
  await resetLocal();
  const task = await makeQaTask({
    criteria: [{ id: 'AC-01', description: 'probe runs', validationMode: 'DETERMINISTIC' }],
    contract: { deterministic: [{ kind: 'command', command: 'definitely-not-a-real-binary-xyz', args: [], criterionId: 'AC-01' }] },
  });
  const run1 = await linkRun(task.taskId);
  await receive(task.taskId, run1.runId);
  const res = await gate.reconcileQaGate(ROOT, project, task.taskId);
  check(res.outcome === 'BLOCKED_ESCALATED', `E1 outcome BLOCKED_ESCALATED (got ${res.outcome})`);
  check(res.finalQaStatus === 'BLOCKED', 'E2 finalQaStatus BLOCKED');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.pmState === 'VERIFYING' && t.linkedRuns.length === 1, 'E3 escalated to VERIFYING, no remediation Run');
  check(deliveriesFor(task.taskId).length === 1, 'E4 Delivery minted with BLOCKED (escalation)');
  check(prepsFor(task.taskId).length === 0, 'E5 BLOCKED never creates a preparation');

  // Semantic BLOCKED (unparseable agent output ×2) also escalates, never remediates.
  await resetLocal();
  const garbageWorker = registerFakeQaWorker(GARBAGE_SCRIPT);
  const task2 = await makeQaTask({
    criteria: [
      { id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' },
      { id: 'AC-02', description: 'semantic judgment', validationMode: 'SEMANTIC' },
    ],
    contract: {
      deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }],
      semantic: { qaWorkerId: garbageWorker },
    },
  });
  const r2 = await linkRun(task2.taskId, { files: { 'out.txt': 'x' } });
  await receive(task2.taskId, r2.runId);
  const res2 = await gate.reconcileQaGate(ROOT, project, task2.taskId);
  check(res2.outcome === 'BLOCKED_ESCALATED', `E6 semantic-garbage → BLOCKED_ESCALATED (got ${res2.outcome})`);
  const t2 = gt.getTask(ROOT, project, task2.taskId);
  check(t2.linkedRuns.length === 1 && t2.pmState === 'VERIFYING', 'E7 semantic BLOCKED: no remediation, escalated');
  check(deliveriesFor(task2.taskId).length === 1, 'E8 semantic BLOCKED: Delivery minted');
}

// ── F. Retry budget: 3 FAILs → 3 Runs, never a 4th ───────────────────────────
console.log('\n== F. remediation budget (2) enforced ==');
{
  await resetLocal();
  const task = await makeQaTask();
  const run1 = await linkRun(task.taskId); // FAIL (no out.txt)
  await receive(task.taskId, run1.runId);
  const r1 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(r1.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'F1 Run1 FAIL → Run2 dispatched');
  const r2 = await completeCurrentRunAndReconcile(task.taskId); // Run2 FAIL (still no out.txt)
  check(r2.outcome === 'FAIL_REMEDIATION_DISPATCHED', `F2 Run2 FAIL → Run3 dispatched (got ${r2.outcome})`);
  const r3 = await completeCurrentRunAndReconcile(task.taskId); // Run3 FAIL → exhausted
  check(r3.outcome === 'FAIL_ESCALATED_BUDGET_EXHAUSTED', `F3 Run3 FAIL → escalated, no Run4 (got ${r3.outcome})`);
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.linkedRuns.length === 3, `F4 exactly 3 linked Runs (got ${t.linkedRuns.length})`);
  check(t.pmState === 'VERIFYING', 'F5 exhausted task escalated to VERIFYING');
  check(deliveriesFor(task.taskId).length === 1, 'F6 exactly one Delivery minted on exhaustion');
  check(prepsFor(task.taskId).length === 2, 'F7 exactly 2 preparations (budget = 2)');
  const attempts = qa.listQaAttemptsForTask(ROOT, project, task.taskId);
  check(attempts.length === 3 && attempts.every((a) => a.finalQaStatus === 'FAIL'), 'F8 three FAIL attempts, one per Run');
  // A further reconcile must not race into a 4th Run.
  const r4 = await gate.reconcileQaGate(ROOT, project, task.taskId);
  const t4 = gt.getTask(ROOT, project, task.taskId);
  check(t4.linkedRuns.length === 3 && r4.outcome === 'FAIL_ESCALATED_BUDGET_EXHAUSTED', 'F9 duplicate reconcile after exhaustion: still 3 Runs');
}

// ── G. Idempotency: repeated reconciles → one prep, one Run ──────────────────
console.log('\n== G. idempotent reconciliation ==');
{
  await resetLocal();
  const task = await makeQaTask();
  const run1 = await linkRun(task.taskId);
  await receive(task.taskId, run1.runId);
  const first = await gate.reconcileQaGate(ROOT, project, task.taskId);
  await waitForNoLive(task.taskId);
  check(first.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'G1 first reconcile dispatches');
  // Replays now address Run2, which has no canonically captured Result yet:
  // precondition-BLOCKED, fail closed, with zero side effects (no prep, no
  // Run, no delivery). The resumable PENDING attempt for Run2 is expected.
  for (let i = 0; i < 3; i += 1) {
    await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, task.taskId), 'BLOCKED', `G2 replay ${i + 1} fails closed (no result yet)`);
  }
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.linkedRuns.length === 2, 'G3 still exactly 2 Runs after replays');
  check(prepsFor(task.taskId).length === 1, 'G4 still exactly 1 preparation after replays');
  check(deliveriesFor(task.taskId).length === 0, 'G5 no Delivery minted by replays');
  const attemptsG = qa.listQaAttemptsForTask(ROOT, project, task.taskId);
  check(attemptsG.length === 2 && attemptsG[0].finalQaStatus === 'FAIL' && attemptsG[1].finalQaStatus === 'PENDING', 'G6 Run1 FAIL terminal + Run2 PENDING-resumable (seam 1 will resume it)');

  // Crash-seam replay BEFORE dispatch: FAIL recorded + prep READY but Task
  // still RESULT_RECEIVED+PENDING (dispatch never ran) → exactly one dispatch.
  await resetLocal();
  const taskG2 = await makeQaTask();
  const runG2 = await linkRun(taskG2.taskId);
  await receive(taskG2.taskId, runG2.runId);
  const attemptIdG2 = `QA-${taskG2.taskId}-${runG2.runId}`;
  await qa.createQaAttempt(ROOT, project, { taskId: taskG2.taskId, runId: runG2.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attemptIdG2, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing' }], failedCriteria: ['AC-01'],
  });
  const g2a = await gate.reconcileQaGate(ROOT, project, taskG2.taskId);
  await waitForNoLive(taskG2.taskId);
  check(g2a.outcome === 'FAIL_REMEDIATION_DISPATCHED', 'G7 pre-dispatch crash seam resumes to exactly one dispatch');
  check(gt.getTask(ROOT, project, taskG2.taskId).linkedRuns.length === 2, 'G8 crash seam: exactly 2 Runs');
}

// ── H. Concurrency: 5 parallel reconciles → one Run ──────────────────────────
console.log('\n== H. concurrent reconciliation collapses to one Run ==');
{
  await resetLocal();
  const task = await makeQaTask();
  const run1 = await linkRun(task.taskId);
  await receive(task.taskId, run1.runId);
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => gate.reconcileQaGate(ROOT, project, task.taskId)),
  );
  await waitForNoLive(task.taskId);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  // The per-task lock serializes the five: exactly one performs the
  // evaluate→prepare→dispatch sequence; the followers then address the NEW
  // current attempt (Run2, no captured Result yet) and fail closed with a
  // precondition BLOCKED instead of duplicating anything.
  check(fulfilled.length === 1 && fulfilled[0].value.outcome === 'FAIL_REMEDIATION_DISPATCHED', `H1 exactly 1 dispatch wins (got ${fulfilled.length})`);
  check(rejected.length === 4 && rejected.every((r) => r.reason && r.reason.code === 'BLOCKED'), 'H2 4 followers fail closed (BLOCKED, no result yet — no duplication)');
  const t = gt.getTask(ROOT, project, task.taskId);
  check(t.linkedRuns.length === 2, 'H3 exactly 2 Runs despite concurrency');
  check(prepsFor(task.taskId).length === 1, 'H4 exactly 1 preparation despite concurrency');

  // Seam-4 adoption: prep READY + undispatched, but the correlated Run was
  // already materialized/linked (crash between commit and consume) → adopt,
  // never a second dispatch.
  await resetLocal();
  const taskAd = await makeQaTask();
  const runAd = await linkRun(taskAd.taskId);
  await receive(taskAd.taskId, runAd.runId);
  const attemptIdAd = `QA-${taskAd.taskId}-${runAd.runId}`;
  await qa.createQaAttempt(ROOT, project, { taskId: taskAd.taskId, runId: runAd.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attemptIdAd, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing' }], failedCriteria: ['AC-01'],
  });
  const prepIdAd = `QRP-${attemptIdAd}`;
  await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attemptIdAd, taskId: taskAd.taskId, sourceRunId: runAd.runId,
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: attemptIdAd,
    workerId: 's4-worker', workspaceRoot: runAd.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, attemptIdAd, prepIdAd);
  // Manually materialize the correlated remediation Run (what a crashed
  // dispatch would have left behind): linked, meta-correlated, no capture.
  idCounter += 1;
  const adoptedFolder = path.join(ROOT, project, '_fixture-runs', `adopted-${idCounter}`);
  fs.mkdirSync(adoptedFolder, { recursive: true });
  const adoptedRunId = `s4-adopted-${idCounter}`;
  fs.writeFileSync(path.join(adoptedFolder, 'meta.json'), JSON.stringify({
    tags: [], runId: adoptedRunId, workspaceRoot: runAd.workspaceRoot, workerId: 's4-worker',
    qaRemediationPreparationId: prepIdAd, sourceRunId: runAd.runId,
  }), 'utf8');
  await gt.linkRunToTask(ROOT, project, taskAd.taskId, adoptedFolder);
  const resAd = await gate.reconcileQaGate(ROOT, project, taskAd.taskId);
  check(resAd.outcome === 'FAIL_REMEDIATION_ADOPTED' && resAd.remediationRunId === adoptedRunId, `H5 crash seam adopts existing Run (got ${resAd.outcome})`);
  const tAd = gt.getTask(ROOT, project, taskAd.taskId);
  check(tAd.linkedRuns.length === 2, 'H6 adoption launches no second Worker (still 2 Runs)');
  const prepAd = qrp.getQaRemediationPreparation(ROOT, project, prepIdAd);
  check(prepAd.dispatchedRunId === adoptedRunId, 'H7 adoption consumes the preparation on the existing Run');
}

// ── I. Corruption fails closed ───────────────────────────────────────────────
console.log('\n== I. corrupt durable state fails closed ==');
{
  await resetLocal();
  // I-a: corrupt QaAttempt.
  const taskA = await makeQaTask();
  const runA = await linkRun(taskA.taskId);
  await receive(taskA.taskId, runA.runId);
  const attemptIdA = `QA-${taskA.taskId}-${runA.runId}`;
  await qa.createQaAttempt(ROOT, project, { taskId: taskA.taskId, runId: runA.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' } });
  fs.writeFileSync(path.join(ROOT, project, '_relay', 'qa-attempts', attemptIdA, 'qa.json'), '{corrupt json', 'utf8');
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, taskA.taskId), 'CORRUPT_RECORD', 'I1 corrupt QaAttempt → CORRUPT_RECORD');
  check(gt.getTask(ROOT, project, taskA.taskId).linkedRuns.length === 1, 'I2 corrupt attempt: no remediation Run');

  // I-b: corrupt QaRemediationPreparation.
  await resetLocal();
  const taskB = await makeQaTask();
  const runB = await linkRun(taskB.taskId);
  await receive(taskB.taskId, runB.runId);
  const attemptIdB = `QA-${taskB.taskId}-${runB.runId}`;
  await qa.createQaAttempt(ROOT, project, { taskId: taskB.taskId, runId: runB.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attemptIdB, {
    status: 'FAIL', checks: [{ checkIndex: 0, kind: 'fileExists', status: 'FAIL', detail: 'missing' }], failedCriteria: ['AC-01'],
  });
  const prepIdB = `QRP-${attemptIdB}`;
  await qrp.createQaRemediationPreparation(ROOT, project, {
    sourceQaAttemptId: attemptIdB, taskId: taskB.taskId, sourceRunId: runB.runId,
    qaRemediationNumber: 1, failedCriteria: ['AC-01'], remediationInstructionRef: attemptIdB,
    workerId: 's4-worker', workspaceRoot: runB.workspaceRoot,
  });
  await qa.linkRemediationPreparation(ROOT, project, attemptIdB, prepIdB);
  fs.writeFileSync(path.join(ROOT, project, '_relay', 'qa-remediation-preparations', prepIdB, 'preparation.json'), 'not json', 'utf8');
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, taskB.taskId), 'CORRUPT_RECORD', 'I3 corrupt preparation → CORRUPT_RECORD');
  check(gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 1, 'I4 corrupt preparation: no remediation Run (never recreated over corrupt state)');

  // I-c: missing Task fails closed.
  await throwsWithCode(() => gate.reconcileQaGate(ROOT, project, 'TASK-999999'), 'NOT_FOUND', 'I5 missing Task → NOT_FOUND');
}

// ── J. Result-bridge insertion (§16) ─────────────────────────────────────────
console.log('\n== J. result-bridge insertion ==');
{
  await resetLocal();
  // J-i: FAIL flows through the bridge with no Delivery + remediation dispatched.
  const taskF = await makeQaTask();
  const runF = await linkRun(taskF.taskId);
  const bf = await bridge.promoteObservedResult({
    dataRoot: ROOT, project, goalId: (await goal()).goalId, taskId: taskF.taskId, runId: runF.runId,
    completion: responseComplete('ses-j1', 'result text', runF.workspaceRoot),
    boundFolder: runF.folder, observationAdapterId: 'test-fixture', workspaceRoot: runF.workspaceRoot,
  });
  await waitForNoLive(taskF.taskId);
  check(bf !== null && bf.pmState === 'PENDING', 'J1 bridge FAIL: promotion returns PENDING task (no VERIFYING)');
  check(deliveriesFor(taskF.taskId).length === 0, 'J2 bridge FAIL: no Delivery before verdict allows it');
  const tF = gt.getTask(ROOT, project, taskF.taskId);
  check(tF.linkedRuns.length === 2, 'J3 bridge FAIL: remediation Run dispatched via bridge');
  // Duplicate bridge processing of the same result → still one attempt/prep/Run.
  const bf2 = await bridge.promoteObservedResult({
    dataRoot: ROOT, project, goalId: (await goal()).goalId, taskId: taskF.taskId, runId: runF.runId,
    completion: responseComplete('ses-j1', 'result text', runF.workspaceRoot),
    boundFolder: runF.folder, observationAdapterId: 'test-fixture', workspaceRoot: runF.workspaceRoot,
  });
  check(bf2 === null, 'J4 duplicate bridge processing of a stale attempt returns null');
  check(qa.listQaAttemptsForTask(ROOT, project, taskF.taskId).length === 1, 'J5 duplicate bridge: exactly one QA attempt');
  check(prepsFor(taskF.taskId).length === 1 && gt.getTask(ROOT, project, taskF.taskId).linkedRuns.length === 2, 'J6 duplicate bridge: one prep, no duplicate Run');

  // J-ii: PASS flows through the bridge to an ordinary Delivery.
  await resetLocal();
  const taskP = await makeQaTask();
  const runP = await linkRun(taskP.taskId, { files: { 'out.txt': 'done' } });
  const bp = await bridge.promoteObservedResult({
    dataRoot: ROOT, project, goalId: (await goal()).goalId, taskId: taskP.taskId, runId: runP.runId,
    completion: responseComplete('ses-j2', 'result text', runP.workspaceRoot),
    boundFolder: runP.folder, observationAdapterId: 'test-fixture', workspaceRoot: runP.workspaceRoot,
  });
  check(bp !== null && bp.pmState === 'VERIFYING', 'J7 bridge PASS: VERIFYING + ordinary Delivery path');
  check(deliveriesFor(taskP.taskId).length === 1, 'J8 bridge PASS: exactly one Delivery');

  // J-iii: Tasks without a contract behave byte-identically to before.
  await resetLocal();
  const g = await goal();
  const plain = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plain', goal: 'gg', reason: 'r', scope: 's',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  const runPl = await linkRun(plain.taskId);
  const bpl = await bridge.promoteObservedResult({
    dataRoot: ROOT, project, goalId: g.goalId, taskId: plain.taskId, runId: runPl.runId,
    completion: responseComplete('ses-j3', 'result text', runPl.workspaceRoot),
    boundFolder: runPl.folder, observationAdapterId: 'test-fixture', workspaceRoot: runPl.workspaceRoot,
  });
  check(bpl !== null && bpl.pmState === 'VERIFYING', 'J9 non-QA task: unconditional VERIFYING as before');
  check(deliveriesFor(plain.taskId).length === 1, 'J10 non-QA task: Delivery minted unconditionally');
  check(!fs.existsSync(path.join(ROOT, project, '_relay', 'qa-attempts', `QA-${plain.taskId}-${runPl.runId}`)), 'J11 non-QA task: no QA attempt record created');
}

// ── K. GPT PM authority regression (Plan interaction) ────────────────────────
console.log('\n== K. QA never ACCEPTs, never advances a Plan ==');
{
  await resetLocal();
  const g = await goal();
  const wsK = path.join(ROOT, 'ws', 'plan-k');
  fs.mkdirSync(wsK, { recursive: true });
  const taskA = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan A (QA)', goal: 'QA-gated plan task', reason: 'r', scope: 'plan scope; authorized file: out.txt',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'out.txt exists', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan B', goal: 'successor', reason: 'r', scope: 'plan scope B',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
  });
  const bindings = [taskA, taskB].map((t) => ({
    taskId: t.taskId, workerId: 's4-worker', workspaceRoot: wsK, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
  }));
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 's4-plan', orderedTaskIds: [taskA.taskId, taskB.taskId], taskBindings: bindings,
  });
  const authz = {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
  };
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authz,
  });
  check(start.outcome === 'DISPATCHED', 'K1 plan starts (first task dispatched with QA appendix fingerprint)');
  const activeBefore = plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId;
  check(activeBefore === taskA.taskId, 'K2 activeTaskId = Task A after start');
  await waitForNoLive(taskA.taskId);
  // Run 1 FAILs QA (no out.txt yet) → same-Task remediation only.
  await completeCurrentRunAndReconcile(taskA.taskId);
  let planNow = plans.getExecutionPlan(ROOT, project, plan.planId);
  let bNow = gt.getTask(ROOT, project, taskB.taskId);
  check(planNow.activeTaskId === taskA.taskId, 'K3 QA FAIL: Plan cursor stays on A (no advancement)');
  check(bNow.linkedRuns.length === 0, 'K4 QA FAIL: successor Task B never starts');
  // Run 2 PASSes QA → ordinary Delivery, still no ACCEPT / no advancement.
  await completeCurrentRunAndReconcile(taskA.taskId, { files: { 'out.txt': 'fixed' } });
  planNow = plans.getExecutionPlan(ROOT, project, plan.planId);
  bNow = gt.getTask(ROOT, project, taskB.taskId);
  const aNow = gt.getTask(ROOT, project, taskA.taskId);
  check(planNow.activeTaskId === taskA.taskId, 'K5 QA PASS: Plan cursor still on A');
  check(bNow.linkedRuns.length === 0, 'K6 QA PASS: successor Task B still never starts');
  check(aNow.pmState === 'VERIFYING' && aNow.acceptedRunId === undefined, 'K7 QA PASS: Task A VERIFYING but NOT ACCEPTED');
  check(deliveriesFor(taskA.taskId).length === 1, 'K8 QA PASS: exactly one ordinary Delivery for GPT PM review');
}

// ── L. Fingerprint appendix + prompt unit ────────────────────────────────────
console.log('\n== L. scope fingerprint + remediation prompt ==');
{
  const fpTask = await makeQaTask();
  const withQa = retryAuth.computeTaskScopeFingerprint(fpTask);
  const { acceptanceCriteria, qaContract, ...legacy } = fpTask;
  void acceptanceCriteria; void qaContract;
  const withoutQa = retryAuth.computeTaskScopeFingerprint(legacy);
  check(withQa !== withoutQa && withQa.startsWith('sha256:') && withoutQa.startsWith('sha256:'), 'L1 QA contract folded into scope fingerprint (differs, same shape)');
  check(retryAuth.computeTaskScopeFingerprint(fpTask) === withQa, 'L2 fingerprint deterministic across reads');

  const prompt = qaPrompt.composeQaRemediationPrompt({
    task: { taskId: 'TASK-1', title: 't', goal: 'gg', reason: 'r', scope: 's', completionCriteria: [] },
    preparationId: 'QRP-QA-TASK-1-r1', sourceRunId: 'r1', qaRemediationNumber: 1,
    failedCriteria: ['AC-01'], deterministicSummary: '- [FAIL] fileExists (AC-01): missing',
    remediationInstruction: 'create the file', priorExcerpt: 'prior', priorAvailable: true,
  });
  check(prompt.includes('SAME Task') && prompt.includes('Fix ONLY the verified failures') && prompt.includes('AC-01'), 'L3 remediation prompt carries authority banner + failed criteria');
}

console.log(`\nV16 Slice 4: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
