/**
 * V1.6 Slice 5 — PM Delivery / Escalation: additive `qa` block on
 * relay_pm_get_verification_context (plan §12, §16). Runs against compiled
 * server modules under dist/server.
 *
 * Proves GPT PM receives bounded, authoritative, durable QA evidence that
 * distinguishes QA PASS / QA FAIL (budget exhausted) / QA BLOCKED — WITHOUT
 * transferring any PM acceptance authority to QA:
 *   - the `qa` block is a PURE READ (no QA/prep/Delivery/Task/Event/Evidence
 *     writes, no QA Agent spawn);
 *   - QA PASS never ACCEPTs the Task and never advances a Plan (regression);
 *   - Tasks with no QA Gate get NO `qa` block (additive backward compat);
 *   - escalation reason is derived only from the delivered run's terminal
 *     finalQaStatus (PASS / BLOCKED / BUDGET_EXHAUSTED), never guessed.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v16-s5-${process.pid}-${Date.now()}`);
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

const gt = await import('../dist/server/backend/goal-task.js');
const gtr = await import('../dist/server/backend/goal-task-runtime.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const pmDel = await import('../dist/server/backend/pm-delivery.js');
const vctx = await import('../dist/server/backend/pm-verification-context.js');
const plans = await import('../dist/server/backend/execution-plan.js');
const planDispatch = await import('../dist/server/backend/execution-plan-dispatch.js');
const retryAuth = await import('../dist/server/backend/retry-authorization.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();

const NODE = process.execPath;
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ZERO_FIXTURE = path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs');
wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 's5-worker', displayName: 's5 fixture implementation worker',
  launchCommand: NODE, launchArgsPrefix: [EXIT_ZERO_FIXTURE],
  capabilities: ['fixture'], observationAdapterId: 'test-fixture',
});

const project = 'V16Slice5';

let goalCache = null;
async function goal() {
  if (!goalCache) goalCache = await gt.createGoal(ROOT, project, { title: 'S5 goal', goalStatement: 'S5 fixture goal' });
  return goalCache;
}

let idCounter = 0;
async function makeTask({ withQa = true, criteria, contract } = {}) {
  const g = await goal();
  idCounter += 1;
  const n = idCounter;
  const workspaceRoot = path.join(ROOT, 'ws', `t-${n}`);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', `run-${n}`);
  fs.mkdirSync(folder, { recursive: true });
  const runId = `s5-run-${n}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: 's5-worker' }), 'utf8');
  const c = criteria ?? [{ id: 'AC-01', description: 'AC-01', validationMode: 'DETERMINISTIC' }];
  const q = contract ?? { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] };
  const task = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'S5 QA task', goal: 'S5 fixture task', reason: 'fixture', scope: 'fixture scope; authorized file: out.txt',
    completionCriteria: ['fixture done'], executionState: 'RUNNING', pmState: 'PENDING',
    ...(withQa ? { acceptanceCriteria: c, qaContract: q } : {}),
  });
  const taskId = task.taskId;
  await gt.linkRunToTask(ROOT, project, taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(folder, 'result.md'), `fixture result for ${runId}`, 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'out.txt'), 'ok', 'utf8');
  return { taskId, runId, workspaceRoot };
}

// Move a Task into RESULT_RECEIVED+PENDING then to VERIFYING (what the QA gate
// does on escalation) and mint the ordinary Delivery, exactly like
// escalateWithDelivery does. Returns the deliveryId.
async function escalate(taskId, runId) {
  await gtr.markQaResultReceived(ROOT, project, taskId, runId);
  await gtr.transitionTaskPm(ROOT, project, taskId, {
    expectedPmState: 'PENDING', expectedExecutionState: 'RESULT_RECEIVED', to: 'VERIFYING', reason: 'qa-gate:escalate',
  });
  const d = await pmDel.ensurePmDeliveryForTaskVerify(ROOT, project, taskId);
  return d.deliveryId;
}

// Build a durable terminal QaAttemptRecord for a run via the QA kernel.
async function recordTerminalAttempt(taskId, runId, taskRunSequence, { deterministic = 'PASS', semantic = null, failed = [], instruction } = {}) {
  const attempt = await qa.createQaAttempt(ROOT, project, {
    taskId, runId, qaAttemptNumber: taskRunSequence,
    criteriaValidationModes: { 'AC-01': semantic === null ? 'DETERMINISTIC' : 'SEMANTIC' },
    ...(semantic !== null ? { qaWorkerId: 's5-qa-worker' } : {}),
  });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, {
    status: deterministic, checks: [{ checkIndex: 0, kind: 'fileExists', status: deterministic, detail: 'out.txt', criterionId: 'AC-01' }],
    ...(deterministic === 'FAIL' ? { failedCriteria: failed } : {}),
  });
  if (deterministic === 'PASS' && semantic !== null) {
    await qa.recordSemanticEvidence(ROOT, project, attempt.qaAttemptId, {
      status: semantic,
      criteria: [{ id: 'AC-01', status: semantic === 'PASS' ? 'PASS' : 'FAIL', note: semantic === 'PASS' ? 'semantic PASS' : 'semantic FAIL' }],
      ...(semantic === 'FAIL' ? { failedCriteria: failed } : {}),
      ...(semantic === 'FAIL' && instruction ? { remediationInstruction: instruction } : {}),
      qaWorkerId: 's5-qa-worker',
    });
  } else if (deterministic === 'PASS' && semantic === null) {
    // No SEMANTIC/BOTH criterion configured → deterministic PASS completes
    // directly via completeQaAttempt(PASS) (the no-LLM path the gate uses).
    await qa.completeQaAttempt(ROOT, project, attempt.qaAttemptId, { finalQaStatus: 'PASS' });
  }
  return attempt.qaAttemptId;
}

async function buildDelivery({ withQa = true } = {}) {
  const t = await makeTask({ withQa });
  const deliveryId = await escalate(t.taskId, t.runId);
  return { ...t, deliveryId };
}

// ── 1. Backward compatibility: no QA Gate ⇒ no `qa` block ────────────────────
{
  console.log('\n[1] Non-QA Task → no `qa` block (additive backward compat)');
  const t = await buildDelivery({ withQa: false });
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, t.deliveryId);
  check(packet.qa === undefined, 'no `qa` block when Task has no QA Gate');
  check(packet.schemaVersion === 'V1-G4B.1', 'schemaVersion unchanged for additive field');
  check(packet.delivery.deliveryId === t.deliveryId, 'delivery identity preserved');
  check(Array.isArray(packet.reviewActions), 'reviewActions still present');
}

// ── 2. QA PASS ⇒ `qa` block status PASS, escalationReason PASS ──────────────
{
  console.log('\n[2] QA PASS → `qa` block reports PASS, no acceptance authority');
  const t = await makeTask();
  await recordTerminalAttempt(t.taskId, t.runId, 1, { deterministic: 'PASS', semantic: null });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa !== undefined, '`qa` block present for QA-gated Task');
  check(packet.qa.status === 'PASS', 'qa.status = PASS');
  check(packet.qa.escalationReason === 'PASS', 'qa.escalationReason = PASS');
  check(packet.qa.attemptNumber === 1, 'qa.attemptNumber = 1');
  check(packet.qa.semanticEvaluated === false, 'no semantic evaluation when none configured');
  check(packet.qa.failedCriteria.length === 0, 'no failedCriteria on PASS');
  check(typeof packet.qa.summary === 'string' && packet.qa.summary.startsWith('QA PASS'), 'bounded summary present');
}

// ── 3. QA semantic PASS ⇒ semanticEvaluated=true ────────────────────────────
{
  console.log('\n[3] QA semantic PASS → semanticEvaluated true');
  const t = await makeTask({
    criteria: [{ id: 'AC-01', description: 'AC-01', validationMode: 'SEMANTIC' }],
    contract: { deterministic: [{ kind: 'fileExists', path: 'out.txt' }], semantic: { qaWorkerId: 's5-qa-worker' } },
  });
  await recordTerminalAttempt(t.taskId, t.runId, 1, { deterministic: 'PASS', semantic: 'PASS' });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa.semanticEvaluated === true, 'qa.semanticEvaluated = true when semantic ran');
  check(packet.qa.qaWorkerId === 's5-qa-worker', 'qa.qaWorkerId exposed');
}

// ── 4. QA FAIL budget-exhausted ⇒ status FAIL, escalationReason BUDGET_EXHAUSTED ─
{
  console.log('\n[4] QA FAIL (remediation exhausted) → escalation evidence');
  const t = await makeTask();
  // Run 1 FAIL with a prior FAIL (remediation #1) then delivered-run FAIL (#2)
  // — simulate the exhausted-budget escalation the QA gate would produce.
  await recordTerminalAttempt(t.taskId, t.runId, 2, {
    deterministic: 'PASS', semantic: 'FAIL', failed: ['AC-01'], instruction: 'fix it',
  });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa.status === 'FAIL', 'qa.status = FAIL');
  check(packet.qa.escalationReason === 'BUDGET_EXHAUSTED', 'qa.escalationReason = BUDGET_EXHAUSTED');
  check(packet.qa.attemptNumber === 2, 'qa.attemptNumber = 2');
  check(JSON.stringify(packet.qa.failedCriteria) === JSON.stringify(['AC-01']), 'failedCriteria reported');
  check(packet.qa.semanticEvaluated === true, 'semantic evaluated on semantic FAIL');
}

// ── 5. QA BLOCKED ⇒ status BLOCKED, escalationReason BLOCKED ───────────────
{
  console.log('\n[5] QA BLOCKED → escalation evidence');
  const t = await makeTask();
  await qa.createQaAttempt(ROOT, project, { taskId: t.taskId, runId: t.runId, qaAttemptNumber: 1, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' } });
  const attempts = qa.listQaAttemptsForTask(ROOT, project, t.taskId);
  await qa.recordDeterministicEvidence(ROOT, project, attempts[0].qaAttemptId, {
    status: 'BLOCKED', checks: [{ checkIndex: 0, kind: 'command', status: 'BLOCKED', detail: 'spawn error' }],
  });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa.status === 'BLOCKED', 'qa.status = BLOCKED');
  check(packet.qa.escalationReason === 'BLOCKED', 'qa.escalationReason = BLOCKED');
  check(packet.qa.failedCriteria.length === 0, 'no failedCriteria on BLOCKED');
}

// ── 6. Remediation history: prior attempts + verdicts ───────────────────────
{
  console.log('\n[6] remediationHistory lists prior attempts with verdicts');
  const t = await makeTask();
  // Prior attempt (different run) FAIL, then current run PASS.
  const priorRun = `${t.runId}-prior`;
  await recordTerminalAttempt(t.taskId, priorRun, 1, {
    deterministic: 'PASS', semantic: 'FAIL', failed: ['AC-01'], instruction: 'fix it',
  });
  await recordTerminalAttempt(t.taskId, t.runId, 2, { deterministic: 'PASS', semantic: null });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa.status === 'PASS', 'current status PASS');
  check(packet.qa.remediationHistory.length === 1, 'one prior attempt recorded');
  check(packet.qa.remediationHistory[0].finalQaStatus === 'FAIL', 'prior attempt verdict FAIL');
  check(packet.qa.remediationHistory[0].qaAttemptNumber === 1, 'prior attempt number 1');
  check(packet.qa.summary.includes('1 prior attempt'), 'summary mentions prior attempts');
}

// ── 7. PURE READ: composing the packet writes nothing ───────────────────────
{
  console.log('\n[7] Verification context composition is a PURE READ');
  const t = await makeTask();
  await recordTerminalAttempt(t.taskId, t.runId, 1, { deterministic: 'PASS', semantic: null });
  const deliveryId = await escalate(t.taskId, t.runId);
  const beforeTask = JSON.stringify(gt.getTask(ROOT, project, t.taskId));
  const beforeAttempts = JSON.stringify(qa.listQaAttemptsForTask(ROOT, project, t.taskId));
  const beforePreps = JSON.stringify(qrp.listQaRemediationPreparations(ROOT, project));
  const beforeDeliveries = JSON.stringify(pmDel.listPmDeliveries(ROOT, project));
  vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  const afterTask = JSON.stringify(gt.getTask(ROOT, project, t.taskId));
  const afterAttempts = JSON.stringify(qa.listQaAttemptsForTask(ROOT, project, t.taskId));
  const afterPreps = JSON.stringify(qrp.listQaRemediationPreparations(ROOT, project));
  const afterDeliveries = JSON.stringify(pmDel.listPmDeliveries(ROOT, project));
  check(beforeTask === afterTask, 'Task unchanged');
  check(beforeAttempts === afterAttempts, 'QA attempts unchanged');
  check(beforePreps === afterPreps, 'QA preparations unchanged');
  check(beforeDeliveries === afterDeliveries, 'PM Deliveries unchanged');
}

// ── 8. QA never ACCEPTs / never advances a Plan (authority regression) ──────
{
  console.log('\n[8] QA block never accepts a Task or advances a Plan');
  const g = await goal();
  const wsP = path.join(ROOT, 'ws', 'plan-p');
  fs.mkdirSync(wsP, { recursive: true });
  const taskA = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan A', goal: 'A', reason: 'r', scope: 'plan scope A; authorized file: out.txt',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-01', description: 'AC-01', validationMode: 'DETERMINISTIC' }],
    qaContract: { deterministic: [{ kind: 'fileExists', path: 'out.txt', criterionId: 'AC-01' }] },
  });
  const taskB = await gt.createTask(ROOT, project, {
    goalId: g.goalId, title: 'plan B', goal: 'successor', reason: 'r', scope: 'plan scope B',
    completionCriteria: ['done'], executionState: 'READY', pmState: 'PENDING',
  });
  const plan = await plans.createExecutionPlan(ROOT, project, {
    title: 's5-plan', orderedTaskIds: [taskA.taskId, taskB.taskId],
    taskBindings: [taskA, taskB].map((t) => ({
      taskId: t.taskId, workerId: 's5-worker', workspaceRoot: wsP, scopeFingerprint: retryAuth.computeTaskScopeFingerprint(t),
    })),
  });
  const authz = {
    authorizationId: `owner-go:${plan.planId}`, approvedAt: new Date().toISOString(), approvedBy: 'OWNER',
    planScopeFingerprint: plans.computeExecutionPlanScopeFingerprint(plan),
    taskScopeFingerprints: Object.fromEntries(plan.taskBindings.map((b) => [b.taskId, b.scopeFingerprint])),
  };
  const start = await planDispatch.dispatchExecutionPlanOwnerApproved(ROOT, project, {
    planId: plan.planId, expectedPlanState: 'PLANNED', ownerAuthorization: authz,
  });
  check(start.outcome === 'DISPATCHED', 'plan started');
  const activeBefore = plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId;
  check(activeBefore === taskA.taskId, 'activeTaskId = Task A after start');
  // Record a QA PASS attempt for the dispatched run, then escalate to a
  // VERIFYING Delivery exactly as the gate does. The qa block must report
  // PASS without ever ACCEPTING the Task or moving the Plan cursor.
  const aNow = gt.getTask(ROOT, project, taskA.taskId);
  const runIdA = aNow.linkedRuns[0].runId;
  await recordTerminalAttempt(taskA.taskId, runIdA, 1, { deterministic: 'PASS', semantic: null });
  await escalate(taskA.taskId, runIdA);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, pmDel.pmDeliveryIdFor(taskA.taskId, runIdA));
  check(packet.qa !== undefined && packet.qa.status === 'PASS', 'qa PASS delivered to PM review');
  check(gt.getTask(ROOT, project, taskA.taskId).pmState === 'VERIFYING', 'Task A VERIFYING (not ACCEPTED)');
  check(gt.getTask(ROOT, project, taskA.taskId).acceptedRunId === undefined, 'Task A acceptedRunId undefined (never ACCEPTED)');
  check(gt.getTask(ROOT, project, taskB.taskId).linkedRuns.length === 0, 'successor Task B never starts');
  check(plans.getExecutionPlan(ROOT, project, plan.planId).activeTaskId === activeBefore, 'Plan activeTaskId unchanged by QA PASS');
}

// ── 9. Omission warning + history-item cap ─────────────────────────────────
{
  console.log('\n[9] QA records present but unusable → warning, no `qa` block; history capped');
  const t = await makeTask();
  // Prior run FAIL with 50 failedCriteria (history cap probe).
  const priorRun = `${t.runId}-prior9`;
  const manyFailed = Array.from({ length: 50 }, (_, i) => `AC-${String(i + 1).padStart(2, '0')}`);
  await recordTerminalAttempt(t.taskId, priorRun, 1, {
    deterministic: 'PASS', semantic: 'FAIL', failed: manyFailed, instruction: 'fix it',
  });
  // Delivered run has only a PENDING attempt (QA still in flight / stale delivery).
  await qa.createQaAttempt(ROOT, project, {
    taskId: t.taskId, runId: t.runId, qaAttemptNumber: 2, criteriaValidationModes: { 'AC-01': 'DETERMINISTIC' },
  });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa === undefined, 'no `qa` block when no terminal verdict for the delivered run');
  check(packet.warnings.some((w) => w.includes('QA records exist for this Task')), 'omission surfaced as warning, not silent');
  check(packet.delivery.deliveryId === deliveryId, 'packet still composes despite omission');
}

// ── 10. History-item failedCriteria capped ──────────────────────────────────
{
  console.log('\n[10] remediationHistory items are bounded');
  const t = await makeTask();
  const priorRun = `${t.runId}-prior10`;
  const manyFailed = Array.from({ length: 50 }, (_, i) => `AC-${String(i + 1).padStart(2, '0')}`);
  await recordTerminalAttempt(t.taskId, priorRun, 1, {
    deterministic: 'PASS', semantic: 'FAIL', failed: manyFailed, instruction: 'fix it',
  });
  await recordTerminalAttempt(t.taskId, t.runId, 2, { deterministic: 'PASS', semantic: null });
  const deliveryId = await escalate(t.taskId, t.runId);
  const packet = vctx.getVerificationContextForDelivery(ROOT, project, deliveryId);
  check(packet.qa.remediationHistory.length === 1, 'one prior attempt recorded');
  check(packet.qa.remediationHistory[0].failedCriteria.length === 20, 'history-item failedCriteria capped at 20');
  check(packet.qa.remediationHistory[0].finalQaStatus === 'FAIL', 'history-item verdict preserved');
}

console.log(`\nSlice 5 PM Delivery / Escalation: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);