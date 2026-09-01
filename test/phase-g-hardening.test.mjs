/**
 * Phase G Hardening — Operational Safety Correction (GH-01..GH-20).
 *
 * GH-01..07  post-spawn DISPATCHED→RUNNING CAS race
 * GH-08..10  cross-dataRoot key isolation
 * GH-11..13  instant zero-exit stress (≥20 cycles)
 * GH-14..20  full phase regressions
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const BASE = path.join(os.tmpdir(), `arl-gh-${process.pid}-${Date.now()}`);
fs.mkdirSync(BASE, { recursive: true });

// Two isolated dataRoots for cross-dataRoot tests
const ROOT_A = path.join(BASE, 'rootA');
const ROOT_B = path.join(BASE, 'rootB');
fs.mkdirSync(ROOT_A, { recursive: true });
fs.mkdirSync(ROOT_B, { recursive: true });

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
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (fragment && !(msg.includes(fragment) || code === fragment || String(code).includes(fragment))) {
      FAIL(`${label} — expected "${fragment}" in error, got: ${code || ''} ${msg}`);
    } else {
      PASS(label);
    }
  }
}

const relay = await import('../dist/server/backend/fs.js');
const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const evk = await import('../dist/server/backend/event.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const pmTools = await import('../dist/server/mcp/pm-tools.js');
const workerTools = await import('../dist/server/mcp/worker-tools.js');
const evidence = await import('../dist/server/backend/evidence.js');

const project = 'GHardenProj';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIX_INSTANT = path.resolve(__dirname, 'fixtures/workers/exit-zero-instant.mjs');
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const FIX_NONZERO = path.resolve(__dirname, 'fixtures/workers/exit-nonzero.mjs');
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const NODE = process.execPath;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function makeGoal(dataRoot, proj = project, title = 'GH Goal') {
  return gt.createGoal(dataRoot, proj, {
    title,
    goalStatement: 'hardening',
    completionCriteria: ['done'],
  });
}

async function makeReadyTask(dataRoot, goalId, title = 'GH Task', proj = project) {
  const t = await gt.createTask(dataRoot, proj, {
    goalId,
    title,
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: ['done'],
  });
  await rt.refreshTaskReadiness(dataRoot, proj, t.taskId);
  return gt.getTask(dataRoot, proj, t.taskId);
}

function registerWorker(dataRoot, workerId, scriptPath, extra = {}) {
  return wr.writeWorkerRegistryRecord(dataRoot, {
    schemaVersion: 'G.1',
    workerId,
    displayName: extra.displayName || workerId,
    launchCommand: NODE,
    launchArgsPrefix: [scriptPath],
    capabilities: extra.capabilities || ['fixture'],
  });
}

function waitForStateRoot(dataRoot, proj, taskId, state, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise(async (resolve, reject) => {
    while (Date.now() - start < timeoutMs) {
      const t = gt.getTask(dataRoot, proj, taskId);
      if (t.executionState === state) return resolve(t);
      await sleep(40);
    }
    reject(new Error(`timeout waiting for ${taskId} → ${state} (current: ${gt.getTask(dataRoot, proj, taskId).executionState})`));
  });
}

// Reset before starting
disp._resetDispatcherStateForTests();

// ── GH-01..07  Post-spawn DISPATCHED→RUNNING CAS race ───────────────────────
console.log('\n── GH-01..07  post-spawn RUNNING CAS race ──');

{
  const goalA = await makeGoal(ROOT_A);
  registerWorker(ROOT_A, 'gh-alive', FIX_ALIVE);

  // We will set WORKER_STAY_MS env so the stay-alive fixture exits quickly (~500ms).
  // The child inherits process.env since we pass no explicit env in spawnOpts.
  const origMs = process.env.WORKER_STAY_MS;
  process.env.WORKER_STAY_MS = '600';

  const task = await makeReadyTask(ROOT_A, goalA.goalId, 'CAS race task');

  // afterSpawnHook: fires after exit listener installed, before DISPATCHED→RUNNING CAS.
  // Force a DISPATCHED→FAILED transition to create a CAS conflict.
  disp._setAfterSpawnHookForTests(async () => {
    await rt.transitionTaskExecution(ROOT_A, project, task.taskId, {
      expectedExecutionState: 'DISPATCHED',
      to: 'FAILED',
      reason: 'test-injected CAS race',
    });
  });

  let conflictErr;
  try {
    await disp.dispatchTask(ROOT_A, project, {
      taskId: task.taskId,
      workerId: 'gh-alive',
      expectedExecutionState: 'READY',
    });
  } catch (err) {
    conflictErr = err;
  } finally {
    disp._setAfterSpawnHookForTests(null);
    process.env.WORKER_STAY_MS = origMs ?? '';
  }

  // GH-01: caller receives CONFLICT
  check(conflictErr?.code === 'CONFLICT', 'GH-01 post-spawn CAS conflict → DispatcherError CONFLICT');

  // GH-02: child remains tracked in activeDispatches
  const statusAfterConflict = await disp.getDispatchStatus(ROOT_A, project, task.taskId);
  check(
    statusAfterConflict.active !== undefined && statusAfterConflict.active.pid !== undefined,
    'GH-02 child remains tracked (active dispatch present with pid)',
  );

  // GH-03: redispatch is blocked while child is alive
  await shouldThrow(
    async () => disp.dispatchTask(ROOT_A, project, {
      taskId: task.taskId,
      workerId: 'gh-alive',
      expectedExecutionState: 'READY',
    }),
    'GH-03 redispatch blocked while child tracked',
    'CONFLICT',
  );

  // GH-04: Run preserved (linked to task)
  const taskAfter = gt.getTask(ROOT_A, project, task.taskId);
  check(taskAfter.linkedRuns.length >= 1, 'GH-04 Run preserved after CAS conflict');

  // GH-05: Task is FAILED (from our hook injection, not from RUNNING CAS failure)
  // The canonical state was set to FAILED by our hook; the RUNNING CAS failed on top of that.
  check(taskAfter.executionState === 'FAILED', 'GH-05 Task in canonical FAILED (from hook) — not an extra guess');

  // GH-06: no RESULT_RECEIVED anywhere
  check(taskAfter.executionState !== 'RESULT_RECEIVED', 'GH-06 no RESULT_RECEIVED after CAS conflict');

  // GH-01b: RUNTIME_WARNING event was emitted for DISPATCH_RUNNING_CAS_FAILED
  const eventsA = evk.listEvents(ROOT_A, project).events;
  const casWarning = eventsA.find(
    (e) => e.type === 'RUNTIME_WARNING' && String(e.summary).includes('DISPATCH_RUNNING_CAS_FAILED'),
  );
  check(!!casWarning, 'GH-01b RUNTIME_WARNING emitted with DISPATCH_RUNNING_CAS_FAILED semantic');
  if (casWarning) {
    check(casWarning.details?.reason === 'DISPATCH_RUNNING_CAS_FAILED', 'GH-01b warning details.reason correct');
    check(typeof casWarning.details?.pid !== 'undefined', 'GH-01b warning contains pid');
    check(
      !JSON.stringify(casWarning).includes(ROOT_A.replace(/\\/g, '\\\\')),
      'GH-01b warning does not expose absolute path in JSON',
    );
  }

  // GH-07: after child exits naturally, active dispatch is cleared
  // The stay-alive fixture exits after WORKER_STAY_MS (we set 600ms above; it may still be alive).
  // Wait up to 2s for the child to exit and tracking to clear.
  let trackingCleared = false;
  for (let i = 0; i < 25; i++) {
    await sleep(100);
    const st = await disp.getDispatchStatus(ROOT_A, project, task.taskId);
    if (!st.active) { trackingCleared = true; break; }
  }
  check(trackingCleared, 'GH-07 child exit eventually clears active dispatch tracking');

  disp._resetDispatcherStateForTests();
}

// ── GH-08..10  Cross-dataRoot key isolation ──────────────────────────────────
console.log('\n── GH-08..10  cross-dataRoot key isolation ──');

{
  // GH-08: dispatch key includes dataRoot — same project::taskId → independent keys
  registerWorker(ROOT_A, 'gh-cross-a', FIX_ALIVE);
  registerWorker(ROOT_B, 'gh-cross-b', FIX_ALIVE);

  const goalA2 = await makeGoal(ROOT_A, project, 'GoalA Cross');
  const goalB2 = await makeGoal(ROOT_B, project, 'GoalB Cross');

  const taskA = await makeReadyTask(ROOT_A, goalA2.goalId, 'Cross DataRoot A');
  const taskB = await makeReadyTask(ROOT_B, goalB2.goalId, 'Cross DataRoot B');

  // GH-08: dispatch key includes dataRoot component — proven by independent status tracking.
  // (taskIds need not be equal; each dataRoot has its own counter.)
  // Verify the source code uses path.resolve(dataRoot) in dispatchKey.
  const srcDisp = fs.readFileSync(path.resolve('src/backend/dispatcher.ts'), 'utf8');
  check(
    srcDisp.includes('path.resolve(dataRoot)') && srcDisp.includes('@@'),
    'GH-08 dispatchKey includes path.resolve(dataRoot) component',
  );

  // GH-09: dispatch both concurrently — both should succeed independently
  const [resA, resB] = await Promise.all([
    disp.dispatchTask(ROOT_A, project, {
      taskId: taskA.taskId,
      workerId: 'gh-cross-a',
      expectedExecutionState: 'READY',
    }),
    disp.dispatchTask(ROOT_B, project, {
      taskId: taskB.taskId,
      workerId: 'gh-cross-b',
      expectedExecutionState: 'READY',
    }),
  ]);

  check(resA.executionState === 'RUNNING', 'GH-09 ROOT_A dispatch succeeds independently');
  check(resB.executionState === 'RUNNING', 'GH-09 ROOT_B dispatch succeeds independently');
  check(resA.runId !== resB.runId, 'GH-09 different Runs materialized');

  // Verify independent status
  const stA = await disp.getDispatchStatus(ROOT_A, project, taskA.taskId);
  const stB = await disp.getDispatchStatus(ROOT_B, project, taskB.taskId);
  check(stA.active !== undefined, 'GH-09 ROOT_A shows active dispatch');
  check(stB.active !== undefined, 'GH-09 ROOT_B shows active dispatch');
  check(stA.dispatchBlocked === true, 'GH-09 ROOT_A redispatch blocked');
  check(stB.dispatchBlocked === true, 'GH-09 ROOT_B redispatch blocked');

  disp._resetDispatcherStateForTests();
}

{
  // GH-10: orphan recovery registry does not leak across dataRoots
  // Put ROOT_A/project/TASK in DISPATCHED without live handle → orphan
  // Then verify ROOT_B/project/same TASK is NOT blocked

  registerWorker(ROOT_A, 'gh-orphan-a', FIX_ALIVE);
  registerWorker(ROOT_B, 'gh-orphan-b', FIX_ALIVE);

  const goalA3 = await makeGoal(ROOT_A, project, 'GoalA Orphan');
  const goalB3 = await makeGoal(ROOT_B, project, 'GoalB Orphan');

  const orphanTask = await makeReadyTask(ROOT_A, goalA3.goalId, 'Orphan only in A');
  const cleanTask = await makeReadyTask(ROOT_B, goalB3.goalId, 'Clean in B');

  // Manually set ROOT_A task to DISPATCHED without live handle
  await rt.transitionTaskExecution(ROOT_A, project, orphanTask.taskId, {
    expectedExecutionState: 'READY',
    to: 'DISPATCHED',
  });

  // Initialize recovery for ROOT_A — should orphan the task
  const orphans = await disp.initializeDispatcherRecovery(ROOT_A, project);
  check(
    orphans.some((o) => o.taskId === orphanTask.taskId && o.status === 'ORPHAN_SUSPECTED'),
    'GH-10 ROOT_A orphan detected',
  );

  // Verify ROOT_A task IS blocked
  check(
    disp.isDispatchBlocked(ROOT_A, project, orphanTask.taskId),
    'GH-10 ROOT_A orphan task is dispatch-blocked',
  );

  // Verify ROOT_B task with same taskId (cleanTask may differ — use the same id if equal, else skip)
  // cleanTask.taskId may or may not equal orphanTask.taskId depending on prior allocation.
  // We test the key isolation directly: isDispatchBlocked for ROOT_B with orphanTask.taskId should be false.
  check(
    !disp.isDispatchBlocked(ROOT_B, project, orphanTask.taskId),
    'GH-10 ROOT_B not blocked by ROOT_A orphan (key isolation)',
  );

  // Dispatch ROOT_B clean task — should succeed regardless of ROOT_A orphan
  const resClean = await disp.dispatchTask(ROOT_B, project, {
    taskId: cleanTask.taskId,
    workerId: 'gh-orphan-b',
    expectedExecutionState: 'READY',
  });
  check(resClean.executionState === 'RUNNING', 'GH-10 ROOT_B dispatch succeeds despite ROOT_A orphan');

  disp._resetDispatcherStateForTests();
}

// ── GH-11..13  Instant zero-exit stress (≥20 cycles) ────────────────────────
console.log('\n── GH-11..13  instant zero-exit stress ──');

{
  // GH-11: instant zero-exit fixture exists and exits cleanly
  registerWorker(ROOT_A, 'gh-instant', FIX_INSTANT);

  const goalInst = await makeGoal(ROOT_A, project, 'Goal Instant');
  const instTask0 = await makeReadyTask(ROOT_A, goalInst.goalId, 'Instant Check');
  const res0 = await disp.dispatchTask(ROOT_A, project, {
    taskId: instTask0.taskId,
    workerId: 'gh-instant',
    expectedExecutionState: 'READY',
  });
  check(res0.executionState === 'RUNNING', 'GH-11 instant zero-exit fixture dispatches successfully');

  // Wait for the child to exit and tracking to clear (it exits immediately)
  await sleep(400);
  const st0 = await disp.getDispatchStatus(ROOT_A, project, instTask0.taskId);
  check(!st0.active, 'GH-11 instant exit clears active dispatch tracking');

  // Verify task stays RUNNING (zero exit ≠ FAILED, ≠ RESULT_RECEIVED — awaiting adapter)
  const instTask0After = gt.getTask(ROOT_A, project, instTask0.taskId);
  check(
    instTask0After.executionState !== 'RESULT_RECEIVED' && instTask0After.pmState !== 'ACCEPTED',
    'GH-11 instant zero exit does not set RESULT_RECEIVED or ACCEPTED',
  );

  disp._resetDispatcherStateForTests();

  // GH-12: stress ≥20 cycles — each dispatch/exit must clear tracking
  const CYCLES = 25;
  let allCleared = true;
  let anyDeadRetained = false;

  const stressGoal = await makeGoal(ROOT_A, project, 'Stress Goal');
  registerWorker(ROOT_A, 'gh-stress', FIX_INSTANT);

  for (let i = 0; i < CYCLES; i++) {
    disp._resetDispatcherStateForTests();
    const t = await makeReadyTask(ROOT_A, stressGoal.goalId, `Stress ${i}`);
    await disp.dispatchTask(ROOT_A, project, {
      taskId: t.taskId,
      workerId: 'gh-stress',
      expectedExecutionState: 'READY',
    });
    // Allow up to 500ms for the instant exit to be processed
    await sleep(200);
    const st = await disp.getDispatchStatus(ROOT_A, project, t.taskId);
    if (st.active) {
      // One more chance after a longer wait
      await sleep(400);
      const st2 = await disp.getDispatchStatus(ROOT_A, project, t.taskId);
      if (st2.active) {
        allCleared = false;
        anyDeadRetained = true;
      }
    }
  }

  check(allCleared, `GH-12 instant zero-exit stress (${CYCLES} cycles) — all tracking cleared`);
  check(!anyDeadRetained, 'GH-13 no dead ChildProcess retained after instant-exit stress');

  disp._resetDispatcherStateForTests();
}

// ── GH-14..20  Regressions ───────────────────────────────────────────────────
console.log('\n── GH-14..20  regressions ──');

{
  // GH-14: existing G-test core behavior — trusted registry, shell:false, orphan
  const src = fs.readFileSync(path.resolve('src/backend/dispatcher.ts'), 'utf8');
  check(src.includes('shell: false') || src.includes('shell:false'), 'GH-14 shell:false present');
  check(!/\bexec\s*\(/.test(src) && !/\bexecSync\s*\(/.test(src), 'GH-14 no exec/execSync');
  check(!src.includes('autoDispatch') && !src.includes('autoRetry'), 'GH-14 no auto loops');

  // GH-14b: trusted registry still resolves from dataRoot/_relay/workers
  const trustedPath = disp.trustedWorkersRoot(ROOT_A);
  check(trustedPath.includes(path.join('_relay', 'workers')), 'GH-14b trusted registry path correct');

  // GH-15: Phase F regression
  const fTools = pmTools.buildAllPmTools({ dataRoot: ROOT_A, project });
  check(fTools.some((t) => t.name === 'relay_pm_get_context_for_event'), 'GH-15 Phase F gateway tool present');

  // GH-16: Phase E regression — use real task/run IDs for worker tool context
  // (Create a real task and run so the evidence kernel can resolve the linkage.)
  const goalC = await makeGoal(ROOT_A, project, 'GH-18 Evidence');
  const taskC = await makeReadyTask(ROOT_A, goalC.goalId, 'GH-18 Task');
  const runC = await relay.atomicMaterializeRun(ROOT_A, project, relay.todayString(), 'GH18Agent');
  await gt.linkRunToTask(ROOT_A, project, taskC.taskId, runC.folder);

  const wTools = workerTools.buildAllWorkerTools({
    dataRoot: ROOT_A, project, taskId: taskC.taskId, runId: runC.runId,
  });
  check(wTools.some((t) => t.name === 'relay_worker_submit_result'), 'GH-16 Phase E worker submit_result');

  // Worker surface must still not expose PM dispatch tools
  const wNames = wTools.map((t) => t.name);
  check(!wNames.includes('relay_pm_dispatch_task'), 'GH-16 Worker surface excludes relay_pm_dispatch_task');
  check(!wNames.includes('relay_pm_list_workers'), 'GH-16 Worker surface excludes relay_pm_list_workers');

  // GH-17: Phase D regression
  const ev = await evk.recordRuntimeWarning(ROOT_A, project, {
    summary: 'GH regression warning',
    source: { kind: 'test' },
  });
  check(ev.type === 'RUNTIME_WARNING', 'GH-17 Phase D event kernel intact');

  // GH-18: Phase C regression
  const claim = await evidence.recordWorkerClaim(ROOT_A, project, {
    summary: 'gh claim',
    goalId: goalC.goalId,
    taskId: taskC.taskId,
    runId: runC.runId,
    source: { kind: 'worker' },
  });
  check(!!claim.evidenceId, 'GH-18 Phase C evidence kernel intact');

  // relay_worker_submit_result remains CLAIMED only
  const submitTool = wTools.find((t) => t.name === 'relay_worker_submit_result');
  const submitResult = await submitTool.handler({ summary: 'gh result claim' });
  check(
    String(JSON.stringify(submitResult)).includes('CLAIM') || submitResult.trustLevel === 'WORKER_CLAIM',
    'GH-18 Worker submit_result still CLAIMED only (no RESULT_RECEIVED)',
  );

  // GH-19: B2 regression
  check(
    typeof rt.transitionTaskExecution === 'function' && typeof rt.requestRetry === 'function',
    'GH-19 B2 runtime intact',
  );

  // GH-20: Phase A regression
  const mat = await relay.atomicMaterializeRun(ROOT_A, project, relay.todayString(), 'GH20PhaseA');
  check(!!mat.folder && fs.existsSync(mat.folder), 'GH-20 Phase A run materialize intact');
}

disp._resetDispatcherStateForTests();

console.log(`\nPhase G Hardening tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
