/**
 * Phase C Evidence kernel tests (C-01..C-27).
 * Temporary DATA_ROOT only — never touches real project data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as rt from '../dist/server/backend/goal-task-runtime.js';
import * as ev from '../dist/server/backend/evidence.js';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-c-ev-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'EvidenceProj';
const otherProject = 'OtherProj';

async function linkFreshRun(taskId, agent = 'Codex') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, link, runId: link.runId, folder: run.folder };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);
  relay.createProject(TEST_ROOT, otherProject);

  const goal = await gt.createGoal(TEST_ROOT, project, {
    title: 'Evidence Kernel',
    goalStatement: 'Local-first evidence SSOT',
    completionCriteria: ['trust levels separate'],
  });
  const task = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId,
    title: 'Implement evidence',
    goal: 'Attach multi-source evidence',
    reason: 'Phase C',
    scope: 'backend kernel',
  });
  const { runId, folder: runFolder } = await linkFreshRun(task.taskId);

  // ── C-01 Worker CLAIM ─────────────────────────────────────────────────────
  console.log('C-01) create Worker CLAIM evidence');
  const claim = await ev.recordWorkerClaim(TEST_ROOT, project, {
    summary: 'Implemented feature and tests pass.',
    taskId: task.taskId,
    runId,
    source: { kind: 'worker', agent: 'Codex' },
  });
  check(claim.evidenceId === 'EVIDENCE-000001', `C-01 id=${claim.evidenceId}`);
  check(claim.type === 'WORKER_CLAIM' && claim.trustLevel === 'CLAIMED', 'C-01 WORKER_CLAIM/CLAIMED');
  check(fs.existsSync(path.join(ev.evidenceFolder(TEST_ROOT, project, claim.evidenceId), 'evidence.json')), 'C-01 evidence.json');
  check(fs.existsSync(path.join(ev.evidenceFolder(TEST_ROOT, project, claim.evidenceId), 'evidence.md')), 'C-01 evidence.md');

  // ── C-02 cannot become VERIFIED implicitly ───────────────────────────────
  console.log('C-02) Worker claim cannot become VERIFIED implicitly');
  let rejectedUpgrade = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'WORKER_CLAIM',
      trustLevel: 'VERIFIED',
      status: 'PASS',
      source: { kind: 'worker' },
      summary: 'tests pass',
      taskId: task.taskId,
    });
  } catch { rejectedUpgrade = true; }
  check(rejectedUpgrade, 'C-02 WORKER_CLAIM+VERIFIED rejected');
  check(claim.trustLevel === 'CLAIMED', 'C-02 original remains CLAIMED');

  // ── C-03 Adapter observation ──────────────────────────────────────────────
  console.log('C-03) Adapter observation = OBSERVED');
  const obs = await ev.recordAdapterObservation(TEST_ROOT, project, {
    summary: 'response completed / capture materialized',
    runId,
    taskId: task.taskId,
    source: { kind: 'adapter', adapter: 'opencode' },
    status: 'INFO',
  });
  check(obs.type === 'ADAPTER_OBSERVATION' && obs.trustLevel === 'OBSERVED', 'C-03 OBSERVED');
  check(obs.status === 'INFO', 'C-03 INFO status allowed');

  // ── C-04 Test evidence = VERIFIED ─────────────────────────────────────────
  console.log('C-04) Test evidence = VERIFIED');
  const testEv = await ev.recordTestEvidence(TEST_ROOT, project, {
    summary: 'npm test exit 0',
    runId,
    taskId: task.taskId,
    details: { command: 'npm test', exitCode: 0, durationMs: 1200, stdoutRef: 'artifacts/test-stdout.txt' },
  });
  check(testEv.type === 'TEST' && testEv.trustLevel === 'VERIFIED' && testEv.status === 'PASS', 'C-04 TEST/VERIFIED/PASS');

  // ── C-05 PM decision ACCEPTED distinct ────────────────────────────────────
  console.log('C-05) PM decision ACCEPTED remains distinct');
  const pmBefore = gt.getTask(TEST_ROOT, project, task.taskId).pmState;
  const pmAcc = await ev.recordPmDecision(TEST_ROOT, project, {
    verdict: 'ACCEPTED',
    taskId: task.taskId,
    runId,
    reason: 'Looks good',
  });
  check(pmAcc.type === 'PM_DECISION' && pmAcc.trustLevel === 'ACCEPTED', 'C-05 PM ACCEPTED trust');
  check(pmAcc.details?.verdict === 'ACCEPTED', 'C-05 verdict ACCEPTED');
  check(pmAcc.trustLevel !== testEv.trustLevel || pmAcc.type !== testEv.type, 'C-05 distinct from TEST');

  // ── C-06 linked to valid Run ──────────────────────────────────────────────
  console.log('C-06) Evidence linked to valid Run');
  check(claim.runId === runId && obs.runId === runId, 'C-06 runId stamped');
  check(ev.listEvidenceForRun(TEST_ROOT, project, runId).length >= 4, 'C-06 listForRun');

  // ── C-07 invalid runId rejected ───────────────────────────────────────────
  console.log('C-07) invalid runId rejected');
  let badRun = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'bad run',
      runId: '00000000-0000-4000-8000-000000000000',
    });
  } catch { badRun = true; }
  check(badRun, 'C-07 invalid runId rejected');

  // ── C-08 mismatched Task/Run rejected ─────────────────────────────────────
  console.log('C-08) mismatched Task/Run rejected');
  const task2 = await gt.createTask(TEST_ROOT, project, {
    goalId: goal.goalId,
    title: 'Other task',
    goal: 'g',
    reason: 'r',
    scope: 's',
  });
  const { runId: runId2 } = await linkFreshRun(task2.taskId, 'Claude Code');
  let mismatchTR = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'mismatch',
      taskId: task.taskId,
      runId: runId2,
    });
  } catch { mismatchTR = true; }
  check(mismatchTR, 'C-08 Task/Run mismatch rejected');

  // ── C-09 mismatched Goal/Task rejected ────────────────────────────────────
  console.log('C-09) mismatched Goal/Task rejected');
  const goal2 = await gt.createGoal(TEST_ROOT, project, {
    title: 'Other goal',
    goalStatement: 'other',
  });
  let mismatchGT = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'mismatch goal',
      taskId: task.taskId,
      goalId: goal2.goalId,
    });
  } catch { mismatchGT = true; }
  check(mismatchGT, 'C-09 Goal/Task mismatch rejected');

  // ── C-10 cross-project reference rejected ─────────────────────────────────
  console.log('C-10) cross-project reference rejected');
  // IDs are project-scoped (TASK-0001 can exist in two projects). Cross-project
  // rejection is enforced via TaskRecord/GoalRecord.project field mismatch and
  // missing identity under the API project tree.
  let missingForeign = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'missing foreign',
      taskId: 'TASK-9999',
    });
  } catch { missingForeign = true; }
  check(missingForeign, 'C-10 missing foreign taskId rejected');

  const spoofGoalDir = gt.goalFolder(TEST_ROOT, project, 'GOAL-0099');
  fs.mkdirSync(spoofGoalDir, { recursive: true });
  fs.writeFileSync(path.join(spoofGoalDir, 'goal.json'), JSON.stringify({
    schemaVersion: 2,
    goalId: 'GOAL-0099',
    project: otherProject,
    title: 'spoof',
    goalStatement: 'spoof',
    status: 'PLANNING',
    completionCriteria: [],
    permissionPolicy: { mode: 'PLAN' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  let crossProjectField = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'cross field',
      goalId: 'GOAL-0099',
    });
  } catch { crossProjectField = true; }
  check(crossProjectField, 'C-10 mismatched Goal.project field rejected');

  // Spoof Task whose persisted project field points elsewhere
  const spoofTaskDir = gt.taskFolder(TEST_ROOT, project, 'TASK-0099');
  fs.mkdirSync(spoofTaskDir, { recursive: true });
  fs.writeFileSync(path.join(spoofTaskDir, 'task.json'), JSON.stringify({
    schemaVersion: 2,
    taskId: 'TASK-0099',
    goalId: goal.goalId,
    project: otherProject,
    title: 'spoof task',
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: [],
    executionState: 'PLANNED',
    pmState: 'PENDING',
    dependencies: [],
    linkedRuns: [],
    nextTaskRunSequence: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  let crossTaskField = false;
  try {
    await ev.createEvidence(TEST_ROOT, project, {
      type: 'MANUAL',
      trustLevel: 'OBSERVED',
      status: 'INFO',
      source: { kind: 'manual' },
      summary: 'cross task field',
      taskId: 'TASK-0099',
    });
  } catch { crossTaskField = true; }
  check(crossTaskField, 'C-10 mismatched Task.project field rejected');

  // ── C-11 multiple evidence per Run ────────────────────────────────────────
  console.log('C-11) multiple evidence records per Run');
  const runList = ev.listEvidenceForRun(TEST_ROOT, project, runId);
  check(runList.length >= 4, `C-11 count=${runList.length}`);
  const ids = new Set(runList.map((e) => e.evidenceId));
  check(ids.size === runList.length, 'C-11 unique ids');

  // ── C-12 multiple Runs contribute to Task summary ─────────────────────────
  console.log('C-12) multiple Runs contribute to Task summary');
  const { runId: runIdExtra } = await linkFreshRun(task.taskId, 'Cline');
  await ev.recordGitEvidence(TEST_ROOT, project, {
    summary: 'commit present on second run',
    runId: runIdExtra,
    details: { branch: 'dev/adapter-foundation-01', commitSha: 'abc123', cleanWorkingTree: true },
  });
  // Evidence stamped with runId only (no taskId) still appears via includeRunEvidence
  const runOnly = await ev.createEvidence(TEST_ROOT, project, {
    type: 'BUILD',
    trustLevel: 'VERIFIED',
    status: 'PASS',
    source: { kind: 'build-executor', command: 'npm run build' },
    summary: 'build ok on extra run',
    runId: runIdExtra,
  });
  check(runOnly.taskId === task.taskId, 'C-12 run-only evidence auto-fills taskId from link');
  const taskList = ev.listEvidenceForTask(TEST_ROOT, project, task.taskId, true);
  check(taskList.some((e) => e.runId === runId) && taskList.some((e) => e.runId === runIdExtra), 'C-12 multi-run in task list');

  // ── C-13 trust levels remain separate ─────────────────────────────────────
  console.log('C-13) trust levels remain separate');
  const summary = ev.getTaskEvidenceSummary(TEST_ROOT, project, task.taskId);
  check(summary.claimedCount >= 1, `C-13 claimed=${summary.claimedCount}`);
  check(summary.observedCount >= 1, `C-13 observed=${summary.observedCount}`);
  check(summary.verifiedCount >= 1, `C-13 verified=${summary.verifiedCount}`);
  check(summary.acceptedCount >= 1, `C-13 accepted=${summary.acceptedCount}`);
  check(
    summary.claimedCount !== summary.verifiedCount || summary.workerClaimCount >= 1,
    'C-13 counts not collapsed',
  );

  // ── C-14 FAIL evidence is failure, not acceptance (attempt-aware) ───────
  console.log('C-14) FAIL evidence appears as failure, not acceptance');
  // Create FAIL on old attempt (runId) — should NOT count as current failure when newer attempt is clean
  const failEvOld = await ev.recordTestEvidence(TEST_ROOT, project, {
    summary: 'npm test failed (old attempt)',
    runId,
    taskId: task.taskId,
    details: { command: 'npm test', exitCode: 1 },
  });
  check(failEvOld.status === 'FAIL' && failEvOld.trustLevel === 'VERIFIED', 'C-14 old FAIL/VERIFIED');
  const evalOld = ev.evaluateTaskEvidence(TEST_ROOT, project, task.taskId);
  // Latest attempt is runIdExtra (clean), so current failure is false even though historical exists
  check(evalOld.hasVerificationFailure === false, 'C-14 stale historical FAIL not counted as current failure');
  // Also verify historical remains inspectable via attempt summary
  const summaryAfterOld = ev.getTaskEvidenceSummary(TEST_ROOT, project, task.taskId);
  check(summaryAfterOld.attempts.some((a) => a.runId === runId && a.summary.failCount >= 1), 'C-14 old failure remains inspectable');
  // Now create FAIL on current (latest) attempt — should count
  const failEv = await ev.recordTestEvidence(TEST_ROOT, project, {
    summary: 'npm test failed (current)',
    runId: runIdExtra,
    taskId: task.taskId,
    details: { command: 'npm test', exitCode: 1 },
  });
  check(failEv.status === 'FAIL' && failEv.trustLevel === 'VERIFIED', 'C-14 current FAIL/VERIFIED');
  const eval1 = ev.evaluateTaskEvidence(TEST_ROOT, project, task.taskId);
  check(eval1.hasVerificationFailure === true, 'C-14 current hasVerificationFailure');
  check(failEv.trustLevel !== 'ACCEPTED', 'C-14 FAIL is not ACCEPTED');

  // ── C-15 accepted evidence does not mutate Task pmState ───────────────────
  console.log('C-15) accepted evidence does not mutate Task pmState');
  const pmAfter = gt.getTask(TEST_ROOT, project, task.taskId).pmState;
  check(pmAfter === pmBefore, `C-15 pmState unchanged (${pmBefore} → ${pmAfter})`);
  check(pmAfter !== 'ACCEPTED' || pmBefore === 'ACCEPTED', 'C-15 no auto ACCEPTED');

  // ── C-16 concurrency unique IDs ───────────────────────────────────────────
  console.log('C-16) evidence identity unique under concurrency');
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      ev.createEvidence(TEST_ROOT, project, {
        type: 'MANUAL',
        trustLevel: 'OBSERVED',
        status: 'INFO',
        source: { kind: 'manual', actor: `c${i}` },
        summary: `concurrent ${i}`,
        taskId: task.taskId,
      }),
    ),
  );
  const cids = new Set(concurrent.map((e) => e.evidenceId));
  check(cids.size === 8, `C-16 unique under concurrency (${cids.size})`);

  // ── C-17 sourceEventId idempotent ─────────────────────────────────────────
  console.log('C-17) sourceEventId duplicate idempotent');
  const first = await ev.recordAdapterObservation(TEST_ROOT, project, {
    summary: 'idempotent obs',
    runId,
    sourceEventId: 'evt-adapter-1',
  });
  const second = await ev.recordAdapterObservation(TEST_ROOT, project, {
    summary: 'idempotent obs replay',
    runId,
    sourceEventId: 'evt-adapter-1',
  });
  check(first.evidenceId === second.evidenceId, `C-17 same id ${first.evidenceId}`);
  check(second.summary === first.summary, 'C-17 returns original record');

  // ── C-18 atomic write / malformed neighbor isolation ──────────────────────
  console.log('C-18) atomic write / malformed neighbor isolation');
  const badDir = path.join(ev.evidenceDir(TEST_ROOT, project), 'EVIDENCE-009999');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'evidence.json'), '{not-json', 'utf8');
  const listed = ev.listEvidenceWithDiagnostics(TEST_ROOT, project);
  check(listed.warnings.some((w) => w.includes('EVIDENCE-009999')), 'C-18 warning for malformed');
  check(listed.evidence.every((e) => e.evidenceId !== 'EVIDENCE-009999'), 'C-18 malformed excluded');
  check(listed.evidence.length >= 5, 'C-18 valid still listed');

  // ── C-19 direct malformed get errors ──────────────────────────────────────
  console.log('C-19) direct malformed get errors');
  let getBad = false;
  try { ev.getEvidence(TEST_ROOT, project, 'EVIDENCE-009999'); }
  catch { getBad = true; }
  check(getBad, 'C-19 get malformed throws');

  // ── C-20 valid records still list ─────────────────────────────────────────
  console.log('C-20) valid records still list');
  check(listed.evidence.some((e) => e.evidenceId === claim.evidenceId), 'C-20 claim still listed');
  check(ev.getEvidence(TEST_ROOT, project, claim.evidenceId).summary === claim.summary, 'C-20 direct get ok');

  // ── C-21 legacy adapter.json compatibility ────────────────────────────────
  console.log('C-21) legacy adapter.json compatibility');
  const cap = captureCompletion(runFolder, {
    adapterId: 'opencode',
    agentName: 'OpenCode',
    workspace: runFolder,
    observedAt: new Date().toISOString(),
    terminalSignal: 'turn-completed',
    completionKind: 'RESPONSE_COMPLETE',
    rawFinalText: 'hello from adapter',
    sessionId: 'ses_test_evidence',
  }, { bindingReason: 'unique-new' });
  check(cap.ok, 'C-21 capture wrote adapter evidence');
  const legacyPath = path.join(runFolder, 'evidence', 'adapter.json');
  check(fs.existsSync(legacyPath), 'C-21 adapter.json exists');
  const beforeLegacy = fs.readFileSync(legacyPath, 'utf8');
  const legacyView = ev.getLegacyAdapterEvidence(runFolder);
  check(legacyView.present && legacyView.adapterId === 'opencode', 'C-21 getLegacyAdapterEvidence');
  const normalized = ev.normalizeLegacyAdapterEvidence(runFolder, { runId, taskId: task.taskId });
  check(normalized?.type === 'ADAPTER_OBSERVATION' && normalized?.trustLevel === 'OBSERVED', 'C-21 normalize shape');

  // ── C-22 no legacy rewrite ────────────────────────────────────────────────
  console.log('C-22) no legacy rewrite');
  const afterLegacy = fs.readFileSync(legacyPath, 'utf8');
  check(beforeLegacy === afterLegacy, 'C-22 adapter.json unchanged');

  // ── C-23 no Run folder migration ──────────────────────────────────────────
  console.log('C-23) no Run folder migration');
  check(fs.existsSync(path.join(runFolder, 'meta.json')), 'C-23 meta.json remains');
  check(fs.existsSync(legacyPath), 'C-23 run/evidence/adapter.json remains');
  const evUnderRelay = path.join(gt.relayDir(TEST_ROOT, project), 'evidence');
  check(fs.existsSync(evUnderRelay), 'C-23 SSOT under _relay/evidence');
  check(!fs.existsSync(path.join(runFolder, 'EVIDENCE-000001')), 'C-23 no evidence id under run folder');

  // ── C-24 no Result content duplication ────────────────────────────────────
  console.log('C-24) no Result content duplication');
  const claimJson = JSON.parse(fs.readFileSync(
    path.join(ev.evidenceFolder(TEST_ROOT, project, claim.evidenceId), 'evidence.json'),
    'utf8',
  ));
  check(!JSON.stringify(claimJson).includes('hello from adapter'), 'C-24 no result body in claim json');
  check(!claimJson.rawFinalText, 'C-24 no rawFinalText field');

  // ── C-25 B2 runtime regression ────────────────────────────────────────────
  console.log('C-25) B2 runtime regression');
  const tReady = await rt.refreshTaskReadiness(TEST_ROOT, project, task2.taskId);
  check(tReady.executionState === 'READY' || tReady.executionState === 'PLANNED', 'C-25 readiness works');
  await rt.transitionTaskExecution(TEST_ROOT, project, task2.taskId, {
    expectedExecutionState: tReady.executionState === 'READY' ? 'READY' : 'PLANNED',
    to: tReady.executionState === 'READY' ? 'DISPATCHED' : 'READY',
  });
  const t2 = gt.getTask(TEST_ROOT, project, task2.taskId);
  check(t2.executionState === 'DISPATCHED' || t2.executionState === 'READY', 'C-25 transition works');
  check(t2.pmState === 'PENDING', 'C-25 pmState untouched by evidence/runtime smoke');

  // ── C-26 B1 identity regression ───────────────────────────────────────────
  console.log('C-26) B1 identity regression');
  check(goal.goalId === 'GOAL-0001', 'C-26 goal id stable');
  check(task.taskId === 'TASK-0001', 'C-26 task id stable');
  check(typeof runId === 'string' && runId.length > 10, 'C-26 runId present');
  const counters = JSON.parse(fs.readFileSync(gt.countersPath(TEST_ROOT, project), 'utf8'));
  check(typeof counters.nextEvidenceNumber === 'number' && counters.nextEvidenceNumber > 1, 'C-26 evidence counter');
  check(typeof counters.nextGoalNumber === 'number' && typeof counters.nextTaskNumber === 'number', 'C-26 goal/task counters preserved');

  // ── C-27 Phase A adapter regression ───────────────────────────────────────
  console.log('C-27) Phase A adapter regression');
  const dup = captureCompletion(runFolder, {
    adapterId: 'opencode',
    agentName: 'OpenCode',
    workspace: runFolder,
    observedAt: new Date().toISOString(),
    terminalSignal: 'turn-completed',
    completionKind: 'RESPONSE_COMPLETE',
    rawFinalText: 'hello from adapter',
    sessionId: 'ses_test_evidence',
  });
  check(dup.ok && dup.duplicate === true, 'C-27 capture dedupe still works');
  check(fs.existsSync(path.join(runFolder, 'agent-result.md')), 'C-27 agent-result.md preserved');

  // evaluateTask advisory shape
  const evalFinal = ev.evaluateTaskEvidence(TEST_ROOT, project, task.taskId);
  check(evalFinal.hasWorkerClaim && evalFinal.hasObservation && evalFinal.hasObjectiveVerification, 'evaluate axes present');
  check(evalFinal.hasPmAcceptanceEvidence === true, 'PM acceptance evidence flag');
  check(Array.isArray(evalFinal.blockers), 'blockers array');

  // Cleanup temp root
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }

  if (process.exitCode) {
    console.log('\nPhase C Evidence tests: FAIL');
  } else {
    console.log('\nPhase C Evidence tests: PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
