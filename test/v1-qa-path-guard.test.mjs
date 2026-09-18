/**
 * V1 QA deterministic path-guard regression tests.
 *
 * Bug class: `resolveExistingPathUnderRoot` (qa-deterministic-evaluator.ts)
 * compared a fully canonicalized path (`fsp.realpath` of the file) against a
 * NON-canonicalized `workspaceRoot` with a case-sensitive lexical check.
 * Any spelling divergence for the SAME directory — Windows 8.3 short names
 * (`RUNNER~1` vs `runneradmin`), on-disk case differences, junctions, or a
 * symlinked root spelling (used here to reproduce on any platform) — made a
 * genuinely-contained file report BLOCKED ("symlink escapes workspace").
 * A deterministic BLOCKED finalizes the QA attempt immediately (Slice 1
 * structural non-override) and the gate escalates BLOCKED_ESCALATED without
 * semantic QA ever running — exactly the Windows `0 passed / 6 failed`
 * signature (first mismatch: expected FAIL_REMEDIATION_DISPATCHED).
 *
 * Test A proves the false positive (fails before the fix, passes after).
 * Test B proves the guard still catches a TRUE escape after the fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const gt = await import('../dist/server/backend/goal-task.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const qrp = await import('../dist/server/backend/qa-remediation-preparation.js');
const gate = await import('../dist/server/backend/qa-gate.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const obs = await import('../dist/server/backend/observation-lock.js');
const disp = await import('../dist/server/backend/dispatcher.js');
const capture = await import('../dist/server/backend/capture-service.js');
const fixture = await import('../dist/server/integrations/test-fixture/watch.js');
fixture.ensureTestFixtureAdapterRegistered();

const NODE = process.execPath;
const QA = path.resolve('scripts/fake-qa-worker.mjs');
const BUILDER = path.resolve('scripts/fake-builder-worker.mjs');
const PROJECT = 'WBS67-PG';

/**
 * Best-effort temp cleanup. Windows commonly reports EBUSY/EPERM when
 * removing a just-used temp tree (child-handle release timing, AV scans,
 * junction handles). Cleanup must never fail the test — the OS reclaims
 * os.tmpdir() entries. Retry briefly, then swallow.
 */
function rmBestEffort(p) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

function unlinkBestEffort(p) {
  try {
    fs.unlinkSync(p);
  } catch { /* absent or locked — covered by rmBestEffort / OS cleanup */ }
}

function reset() {
  disp._resetDispatcherStateForTests();
  capture._resetCaptureServiceForTests();
  qa._resetQaAttemptLocksForTests();
  qrp._resetQaRemediationPreparationLocksForTests();
  gate._resetQaGateLocksForTests();
}

async function setup(ROOT, { checkPath = 'out.txt', qaWorkerSuffix = 'pg' } = {}) {
  fs.mkdirSync(path.join(ROOT, 'workspace'), { recursive: true });
  const counter = path.join(ROOT, `qa-${qaWorkerSuffix}.count`);
  fs.writeFileSync(counter, '0');
  const qaWorkerId = `qa-${qaWorkerSuffix}`;
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId: qaWorkerId, launchCommand: NODE,
    launchArgsPrefix: [QA, counter], role: 'qa',
  });
  const builderId = `builder-${qaWorkerSuffix}`;
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId: builderId, launchCommand: NODE,
    launchArgsPrefix: [BUILDER], workingDirectory: 'workspace',
    role: 'implementation', observationAdapterId: 'test-fixture',
  });
  const g = await gt.createGoal(ROOT, PROJECT, { title: 'WBS67-PG', goalStatement: 'QA path guard' });
  const t = await gt.createTask(ROOT, PROJECT, {
    goalId: g.goalId, title: 'same task', goal: 'make output correct', reason: 'proof',
    scope: 'out.txt only', completionCriteria: ['done'],
    executionState: 'RUNNING', pmState: 'PENDING',
    acceptanceCriteria: [{ id: 'AC-SEMANTIC', description: 'output is correct', validationMode: 'SEMANTIC' }],
    qaContract: {
      deterministic: [{ kind: 'fileExists', path: checkPath }],
      semantic: { qaWorkerId }, maxQaRemediationAttempts: 1,
    },
  });
  return { task: t, builderId };
}

async function linkResult(ROOT, taskId, n, builderId, text = 'result') {
  const workspaceRoot = path.join(ROOT, 'workspace', String(n));
  const folder = path.join(ROOT, PROJECT, '_runs', String(n));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(folder, { recursive: true });
  const runId = `pg-run-${n}-${Date.now()}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: builderId }));
  await gt.linkRunToTask(ROOT, PROJECT, taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), '{}');
  fs.writeFileSync(path.join(folder, 'result.md'), text);
  spawnSync(NODE, [BUILDER], {
    cwd: workspaceRoot,
    env: { ...process.env, FAKE_BUILDER_OUTPUT: path.join(workspaceRoot, 'out.txt'), FAKE_BUILDER_COUNTER: path.join(workspaceRoot, '.builder-attempt') },
  });
  obs.releaseObservationLockByBinding({ observationAdapterId: 'test-fixture', workspaceRoot, taskId, runId });
  await rt.markQaResultReceived(ROOT, PROJECT, taskId, runId);
  return { runId, folder, workspaceRoot };
}

test('symlink-spelled root still reaches semantic FAIL and dispatches SAME-Task remediation', async () => {
  reset();
  // Same directory, two spellings: REAL (canonical) vs ROOT (via junction).
  // Mirrors Windows Temp short-name/case divergence (RUNNER~1 vs runneradmin).
  const REAL = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-pg-real-'));
  const ROOT = path.join(os.tmpdir(), `arl-pg-link-${process.pid}`);
  try { fs.unlinkSync(ROOT); } catch { /* absent */ }
  fs.symlinkSync(REAL, ROOT, 'junction');
  try {
    const { task, builderId } = await setup(ROOT, { qaWorkerSuffix: `pg${process.pid}` });
    await linkResult(ROOT, task.taskId, 1, builderId, 'wrong result');
    const out = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId);
    assert.equal(out.outcome, 'FAIL_REMEDIATION_DISPATCHED');
    const after = gt.getTask(ROOT, PROJECT, task.taskId);
    assert.equal(after.taskId, task.taskId);
    assert.equal(after.linkedRuns.length, 2);
    assert.deepEqual(after.linkedRuns.map((r) => r.taskRunSequence).sort(), [1, 2]);
  } finally {
    unlinkBestEffort(ROOT);
    rmBestEffort(REAL);
  }
});

test('true symlink escape outside the workspace is still BLOCKED', async () => {
  reset();
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-pg-escape-'));
  const outside = path.join(os.tmpdir(), `arl-pg-outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'secret');
  try {
    const { task, builderId } = await setup(ROOT, { checkPath: 'evil-link', qaWorkerSuffix: `esc${process.pid}` });
    const r = await linkResult(ROOT, task.taskId, 1, builderId, 'result');
    fs.symlinkSync(outside, path.join(r.workspaceRoot, 'evil-link'));
    const out = await gate.runOrResumeQaGate(ROOT, PROJECT, task.taskId);
    assert.equal(out.outcome, 'BLOCKED_ESCALATED');
    const attempts = qa.listQaAttemptsForTask(ROOT, PROJECT, task.taskId);
    assert.equal(attempts[0].finalQaStatus, 'BLOCKED');
    assert.equal(qrp.listQaRemediationPreparations(ROOT, PROJECT).length, 0);
  } finally {
    try { fs.unlinkSync(outside); } catch { /* best-effort */ }
    rmBestEffort(ROOT);
  }
});
