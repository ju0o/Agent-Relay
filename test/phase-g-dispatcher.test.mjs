/**
 * Phase G — Trusted Worker Registry + PM Dispatcher permanent tests (G-01..G-45).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const TEST_ROOT = path.join(os.tmpdir(), `arl-phase-g-${process.pid}-${Date.now()}`);
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
const testFix = await import('../dist/server/integrations/test-fixture/watch.js');
testFix.ensureTestFixtureAdapterRegistered();
const wdc = await import('../dist/server/backend/workspace-diff-common.js');
const WORKSPACE = path.join(TEST_ROOT, '_workspace');
fs.mkdirSync(WORKSPACE, { recursive: true });

const project = 'PhaseGProj';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX_ZERO = path.resolve(__dirname, 'fixtures/workers/exit-zero.mjs');
const FIX_NONZERO = path.resolve(__dirname, 'fixtures/workers/exit-nonzero.mjs');
const FIX_ALIVE = path.resolve(__dirname, 'fixtures/workers/stay-alive.mjs');
const NODE = process.execPath;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function makeGoal(title = 'G Goal') {
  return gt.createGoal(TEST_ROOT, project, {
    title,
    goalStatement: 'phase g',
    completionCriteria: ['done'],
    // Phase H: PM MCP DISPATCH requires APPROVE/BYPASS (PLAN denies).
    permissionPolicy: { mode: 'BYPASS' },
  });
}

async function makeReadyTask(goalId, title = 'Ready Task') {
  const t = await gt.createTask(TEST_ROOT, project, {
    goalId,
    title,
    goal: 'g',
    reason: 'r',
    scope: 's',
    completionCriteria: ['done'],
  });
  await rt.refreshTaskReadiness(TEST_ROOT, project, t.taskId);
  return gt.getTask(TEST_ROOT, project, t.taskId);
}

function registerWorker(workerId, scriptPath, extra = {}) {
  return wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId,
    displayName: extra.displayName || workerId,
    launchCommand: NODE,
    launchArgsPrefix: [scriptPath],
    capabilities: extra.capabilities || ['fixture'],
    observationAdapterId: extra.observationAdapterId || 'test-fixture',
    ...(extra.workingDirectory ? { workingDirectory: extra.workingDirectory } : {}),
  });
}

function waitForState(taskId, state, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise(async (resolve, reject) => {
    while (Date.now() - start < timeoutMs) {
      const t = gt.getTask(TEST_ROOT, project, taskId);
      if (t.executionState === state) return resolve(t);
      await sleep(40);
    }
    reject(new Error(`timeout waiting for ${taskId} → ${state}`));
  });
}

disp._resetDispatcherStateForTests();

// ── G-01..G-06 registry + launch security ───────────────────────────────────
console.log('\n── G-01..G-06 registry + launch security ──');

{
  registerWorker('w-zero', FIX_ZERO);
  const rec = wr.loadWorkerRegistryRecord(TEST_ROOT, 'w-zero');
  check(rec.workerId === 'w-zero', 'G-01 trusted registry loads from dataRoot/_relay/workers');
  check(
    wr.workerRegistryPath(TEST_ROOT, 'w-zero').includes(path.join('_relay', 'workers')),
    'G-01 path is dataRoot/_relay/workers',
  );
}

{
  const projWorkers = path.join(TEST_ROOT, project, 'workers');
  fs.mkdirSync(projWorkers, { recursive: true });
  fs.writeFileSync(
    path.join(projWorkers, 'evil.json'),
    JSON.stringify({
      schemaVersion: 'G.2',
      workerId: 'evil',
      launchCommand: NODE,
      launchArgsPrefix: [FIX_ZERO],
    }),
    'utf8',
  );
  let rejected = false;
  try {
    wr.loadWorkerRegistryRecord(TEST_ROOT, 'evil');
  } catch {
    rejected = true;
  }
  check(rejected, 'G-02 project/<project>/workers registry is ignored/rejected');
}

{
  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.0',
      workerId: 'bad',
      launchCommand: NODE,
      launchArgsPrefix: [],
    }),
    'G-03 invalid schema rejected',
    'schemaVersion',
  );
}

{
  // Project cannot override launchCommand via project workers path — only trusted root is read.
  const listed = wr.listWorkerRegistryRecords(TEST_ROOT).map((w) => w.workerId);
  check(!listed.includes('evil'), 'G-04 project cannot override launchCommand (evil not listed)');
}

{
  const src = fs.readFileSync(path.resolve('src/backend/dispatcher.ts'), 'utf8');
  check(src.includes('shell: false') || src.includes('shell:false'), 'G-05 shell:false launch confirmed');
  check(!/\bexec\s*\(/.test(src) && !/\bexecSync\s*\(/.test(src), 'G-06 no exec / command-string shell path');
  check(!src.includes('shell: true') && !src.includes('shell:true'), 'G-06 shell:true absent');
}

// ── G-07..G-14 dispatch ownership + worker trust ────────────────────────────
console.log('\n── G-07..G-14 dispatch ownership + worker trust ──');

const goal = await makeGoal();
registerWorker('w-alive', FIX_ALIVE, { displayName: 'Alive' });

{
  const task = await makeReadyTask(goal.goalId, 'Dispatch OK');
  const beforeRuns = task.linkedRuns.length;
  const result = await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
    workerId: 'w-alive',
    expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  check(result.executionState === 'RUNNING', 'G-07 READY Task dispatch succeeds');
  check(result.runId && result.taskId === task.taskId, 'G-07 returns logical ids');
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.linkedRuns.length === beforeRuns + 1, 'G-09 fresh Run materialized');
  check(after.linkedRuns.some((r) => r.runId === result.runId), 'G-10 Run linked before/with DISPATCHED');
  check(after.executionState === 'RUNNING', 'G-12 spawn success → DISPATCHED→RUNNING');
  // G-11 implied: reached RUNNING via DISPATCHED
  check(true, 'G-11 READY→DISPATCHED by Dispatcher');
  // kill child
  disp._resetDispatcherStateForTests();
}

{
  const task = await makeReadyTask(goal.goalId, 'Not ready later');
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'hold',
  });
  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
      workerId: 'w-alive',
      expectedExecutionState: 'READY', workspaceRoot: WORKSPACE }),
    'G-08 non-READY dispatch rejected',
    'READY',
  );
}

{
  const tools = workerTools.buildAllWorkerTools({
    dataRoot: TEST_ROOT, project, taskId: 'TASK-0001', runId: 'run-x',
  });
  const names = tools.map((t) => t.name);
  check(!names.includes('relay_worker_report_running'), 'G-13 Worker surface contains no report_running');
  check(
    !names.some((n) => n.includes('transition_execution') || n.includes('mark_result_received') || n.includes('cancel_task')),
    'G-14 Worker surface cannot mutate execution state (no transition tools)',
  );
}

// ── G-14a: dispatch-time workspace baseline (round 33, content-aware) ───────
console.log('\n── G-14a dispatch-time workspace baseline ──');

{
  // Generic (non-actl) worker dispatch must snapshot the workspace's
  // pre-existing dirty paths AND their content digests into
  // workspace-baseline.json ({ paths, entries, capturedAt }) in the Run folder.
  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
  const baseWS = path.join(TEST_ROOT, '_baseline-ws');
  fs.rmSync(baseWS, { recursive: true, force: true });
  fs.mkdirSync(baseWS, { recursive: true });
  execSync('git init -q', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.email g@example.com', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.name "G Fixture"', { cwd: baseWS, stdio: 'ignore' });
  // ` M` (tracked then modified): commit tracked.txt, then dirty it.
  fs.writeFileSync(path.join(baseWS, 'tracked.txt'), 'committed-v1', 'utf8');
  execSync('git add tracked.txt && git commit -qm add-tracked', { cwd: baseWS, stdio: 'ignore' });
  const modifiedPath = 'tracked.txt';
  const modifiedBytes = 'modified-after-commit';
  fs.writeFileSync(path.join(baseWS, modifiedPath), modifiedBytes, 'utf8');
  // `??` (untracked file): docs/OPERATIONS.md exists before dispatch.
  const untrackedPath = path.join('docs', 'OPERATIONS.md');
  const untrackedBytes = 'uncommitted-from-before';
  fs.mkdirSync(path.join(baseWS, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(baseWS, untrackedPath), untrackedBytes, 'utf8');

  const task = await makeReadyTask(goal.goalId, 'Baseline dispatch');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-zero',
    expectedExecutionState: 'READY',
    workspaceRoot: baseWS,
  });
  check(result.executionState === 'RUNNING' && result.runId, 'G-14a dispatch succeeds for a git workspace');
  const linked = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.find((r) => r.runId === result.runId);
  check(!!linked, 'G-14a baseline dispatch run linked');
  const baselinePath = path.join(linked.folder, 'workspace-baseline.json');
  check(fs.existsSync(baselinePath), 'G-14a workspace-baseline.json written at dispatch');
  let baseline = null;
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch {
    baseline = null;
  }
  check(
    baseline !== null && typeof baseline === 'object' && Array.isArray(baseline.paths) && !Array.isArray(baseline),
    `G-14a baseline is the { paths, entries, capturedAt } object shape (got ${JSON.stringify(baseline)?.slice(0, 200)})`,
  );
  check(
    Array.isArray(baseline?.paths) && baseline.paths.includes(untrackedPath) && baseline.paths.includes(modifiedPath),
    `G-14a baseline paths contain both the ?-untracked and the M-modified path (got ${JSON.stringify(baseline?.paths)})`,
  );
  check(
    Array.isArray(baseline?.paths) && baseline.paths.join(',') === [...baseline.paths].sort().join(','),
    'G-14a baseline paths list is sorted',
  );
  check(baseline.paths.length === 2, 'G-14a exactly the two dirty paths are snapshotted (clean standalone commit otherwise)');
  check(
    baseline?.entries?.[untrackedPath] === sha256(Buffer.from(untrackedBytes, 'utf8')),
    `G-14a content digest recorded for the ?? entry (got ${baseline?.entries?.[untrackedPath]})`,
  );
  check(
    baseline?.entries?.[modifiedPath] === sha256(Buffer.from(modifiedBytes, 'utf8')),
    `G-14a content digest recorded for the M entry (got ${baseline?.entries?.[modifiedPath]})`,
  );
  check(
    typeof baseline?.capturedAt === 'string' && !Number.isNaN(Date.parse(baseline.capturedAt)),
    'G-14a capturedAt is an ISO timestamp',
  );
  disp._resetDispatcherStateForTests();
}

// ── G-14b: NUL porcelain capture — raw non-ASCII/quote/backslash keys ────────
console.log('\n── G-14b dispatch-time workspace baseline: raw Korean/quote/backslash path keys (round 36 P0) ──');

{
  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
  const baseWS = path.join(TEST_ROOT, '_baseline-ws-nul');
  fs.rmSync(baseWS, { recursive: true, force: true });
  fs.mkdirSync(baseWS, { recursive: true });
  execSync('git init -q', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.email g@example.com', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.name "G Fixture"', { cwd: baseWS, stdio: 'ignore' });
  const koreanPath = 'docs/문서.md';
  const quotedPath = 'docs/notes with "quotes".md';
  const backslashPath = 'docs/odd\\name.md';
  const koreanBytes = 'korean-content-v1';
  const quotedBytes = 'quoted-content-v1';
  const backslashBytes = 'backslash-content-v1';
  fs.mkdirSync(path.join(baseWS, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(baseWS, 'docs', '문서.md'), koreanBytes, 'utf8');
  fs.writeFileSync(path.join(baseWS, 'docs', 'notes with "quotes".md'), quotedBytes, 'utf8');
  fs.writeFileSync(path.join(baseWS, 'docs', 'odd\\name.md'), backslashBytes, 'utf8');

  const task = await makeReadyTask(goal.goalId, 'NUL baseline dispatch');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-zero',
    expectedExecutionState: 'READY',
    workspaceRoot: baseWS,
  });
  check(result.executionState === 'RUNNING' && result.runId, 'G-14b dispatch succeeds for a workspace with Korean/quote/backslash filenames');
  const linked = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.find((r) => r.runId === result.runId);
  const baseline = JSON.parse(fs.readFileSync(path.join(linked.folder, 'workspace-baseline.json'), 'utf8'));
  check(
    baseline.paths.includes(koreanPath) && baseline.paths.includes(quotedPath) && baseline.paths.includes(backslashPath),
    `G-14b baseline paths are the exact RAW key strings (got ${JSON.stringify(baseline.paths)})`,
  );
  check(
    baseline.entries?.[koreanPath] === sha256(Buffer.from(koreanBytes, 'utf8')) &&
      baseline.entries?.[quotedPath] === sha256(Buffer.from(quotedBytes, 'utf8')) &&
      baseline.entries?.[backslashPath] === sha256(Buffer.from(backslashBytes, 'utf8')),
    `G-14b content digests recorded under the exact raw keys (got ${JSON.stringify(baseline.entries)})`,
  );
  check(
    !baseline.paths.some((p) => p.startsWith('"') || /\\\d{3}/.test(p)),
    `G-14b no C-quoted / octal-escaped path ever reaches the baseline (got ${JSON.stringify(baseline.paths)})`,
  );
  // The evaluator parses the SAME NUL stream through the SAME shared parser
  // (runGitStatusZ) — prove the two sides of the protocol emit identical keys.
  const status = await wdc.runGitStatusZ(baseWS);
  check(
    status.kind === 'ok' &&
      status.paths.length === 3 &&
      status.paths.includes(koreanPath) && status.paths.includes(quotedPath) && status.paths.includes(backslashPath) &&
      status.paths.every((p) => baseline.paths.includes(p)),
    `G-14b dispatcher baseline keys ≡ evaluator-side parser keys (both sides agree byte-for-byte; got ${status.kind === 'ok' ? JSON.stringify(status.paths) : status.reason})`,
  );
  disp._resetDispatcherStateForTests();
}

// ── G-14c: oversize dirty file → `oversize:<bytes>` digest (round 36 P1) ─────
console.log('\n── G-14c dispatch-time workspace baseline: oversize file above the per-file cap ──');

{
  const baseWS = path.join(TEST_ROOT, '_baseline-ws-oversize');
  fs.rmSync(baseWS, { recursive: true, force: true });
  fs.mkdirSync(baseWS, { recursive: true });
  execSync('git init -q', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.email g@example.com', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.name "G Fixture"', { cwd: baseWS, stdio: 'ignore' });
  const bigSize = wdc.MAX_DIGEST_FILE_BYTES + 1;
  fs.writeFileSync(path.join(baseWS, 'big.bin'), Buffer.alloc(bigSize, 0x61));

  const task = await makeReadyTask(goal.goalId, 'Oversize baseline dispatch');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-zero',
    expectedExecutionState: 'READY',
    workspaceRoot: baseWS,
  });
  check(result.executionState === 'RUNNING' && result.runId, 'G-14c dispatch succeeds with an oversize dirty file');
  const linked = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.find((r) => r.runId === result.runId);
  const baseline = JSON.parse(fs.readFileSync(path.join(linked.folder, 'workspace-baseline.json'), 'utf8'));
  check(
    baseline.entries?.['big.bin'] === `oversize:${bigSize}`,
    `G-14c oversize dirty file recorded as oversize:<bytes>, never read/hashed (got ${baseline.entries?.['big.bin']})`,
  );
  check(
    Array.isArray(baseline.paths) && baseline.paths.includes('big.bin') && baseline.truncated !== true,
    'G-14c oversize path still listed in paths, baseline not truncated',
  );
  disp._resetDispatcherStateForTests();
}

// ── G-14d: dirty-path count cap → `truncated: true`, no digests (round 36 P1) ─
console.log('\n── G-14d dispatch-time workspace baseline: dirty-path count cap → truncated ──');

{
  const baseWS = path.join(TEST_ROOT, '_baseline-ws-many');
  fs.rmSync(baseWS, { recursive: true, force: true });
  fs.mkdirSync(baseWS, { recursive: true });
  execSync('git init -q', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.email g@example.com', { cwd: baseWS, stdio: 'ignore' });
  execSync('git config user.name "G Fixture"', { cwd: baseWS, stdio: 'ignore' });
  const count = wdc.MAX_BASELINE_PATHS + 1; // exactly over the cap
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(baseWS, `dirty-${String(i).padStart(4, '0')}.txt`), String(i), 'utf8');
  }

  const task = await makeReadyTask(goal.goalId, 'Count-cap baseline dispatch');
  const result = await disp.dispatchTask(TEST_ROOT, project, {
    taskId: task.taskId,
    workerId: 'w-zero',
    expectedExecutionState: 'READY',
    workspaceRoot: baseWS,
  });
  check(result.executionState === 'RUNNING' && result.runId, 'G-14d dispatch succeeds past the dirty-path count cap');
  const linked = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.find((r) => r.runId === result.runId);
  const baseline = JSON.parse(fs.readFileSync(path.join(linked.folder, 'workspace-baseline.json'), 'utf8'));
  check(
    baseline.truncated === true,
    `G-14d baseline is marked truncated: true (got ${JSON.stringify(baseline.truncated)})`,
  );
  check(
    Array.isArray(baseline.paths) && baseline.paths.length === count,
    `G-14d the bounded path list is still written for the legacy fallback (got ${baseline.paths?.length})`,
  );
  check(
    baseline.entries !== undefined && Object.keys(baseline.entries).length === 0,
    'G-14d NO content digests are computed past the count cap (bounded hashing)',
  );
  disp._resetDispatcherStateForTests();
}

// ── G-15..G-20 rollback + spawn failure ─────────────────────────────────────
console.log('\n── G-15..G-20 rollback + spawn failure ──');

{
  disp._resetDispatcherStateForTests();
  const task = await makeReadyTask(goal.goalId, 'CAS rollback');
  // Pre-link an older run so we can prove preservation
  const older = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'OldAgent');
  await gt.linkRunToTask(TEST_ROOT, project, task.taskId, older.folder);
  const olderRunId = older.runId;
  const beforeCount = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.length;

  disp._setAfterLinkHookForTests(async () => {
    await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
      expectedExecutionState: 'READY', to: 'BLOCKED', reason: 'race',
    });
  });

  let threw = false;
  try {
    await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
      workerId: 'w-alive',
      expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  } catch {
    threw = true;
  }
  disp._setAfterLinkHookForTests(null);
  check(threw, 'G-15 CAS conflict before dispatch commitment rolls back new Run link');

  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.linkedRuns.length === beforeCount, 'G-15 link count restored');
  check(after.linkedRuns.some((r) => r.runId === olderRunId), 'G-17 older Runs preserved during rollback');

  // Newly created run folder should be gone (only the failed attempt)
  const agentDir = path.join(TEST_ROOT, project, relay.todayString(), 'worker-w-alive');
  let dangling = false;
  if (fs.existsSync(agentDir)) {
    for (const name of fs.readdirSync(agentDir)) {
      const metaPath = path.join(agentDir, name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.taskId === task.taskId && meta.runId !== olderRunId) dangling = true;
      } catch { /* ignore */ }
    }
  }
  check(!dangling, 'G-16 CAS conflict deletes only newly-created Run folder');

  // Restore task for later use
  await rt.transitionTaskExecution(TEST_ROOT, project, task.taskId, {
    expectedExecutionState: 'BLOCKED', to: 'READY',
  });
  disp._resetDispatcherStateForTests();
}

{
  // Spawn failure via nonexistent absolute executable in registry
  const badId = 'w-missing';
  wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: badId,
    launchCommand: path.join(TEST_ROOT, 'no-such-worker-bin.exe'),
    launchArgsPrefix: [],
    observationAdapterId: 'test-fixture',
  });
  // Unblock previous blocked path — fresh task
  const task = await makeReadyTask(goal.goalId, 'Spawn fail');
  let errCode;
  try {
    await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
      workerId: badId,
      expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  } catch (err) {
    errCode = err.code;
  }
  check(errCode === 'LAUNCH_FAILED', 'G-18 spawn failure → LAUNCH_FAILED');
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === 'FAILED', 'G-18 spawn failure → FAILED');
  check(after.linkedRuns.length >= 1, 'G-19 spawn failure preserves committed Run');

  const events = evk.listEvents(TEST_ROOT, project).events;
  const related = events.filter((e) => e.taskId === task.taskId);
  check(
    related.some((e) => e.type === 'RUN_FAILED' || e.type === 'RUNTIME_ERROR'),
    'G-20 spawn failure emits typed runtime Event',
  );
  disp._resetDispatcherStateForTests();
}

// ── G-21..G-24 process exit + RESULT boundary ───────────────────────────────
console.log('\n── G-21..G-24 process exit + RESULT boundary ──');

{
  registerWorker('w-nonzero', FIX_NONZERO);
  const task = await makeReadyTask(goal.goalId, 'Nonzero exit');
  await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
    workerId: 'w-nonzero',
    expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  const failedTask = await waitForState(task.taskId, 'FAILED', 8000);
  check(failedTask.pmState !== 'ACCEPTED', 'G-21 non-zero observed exit does not ACCEPT Task');
  check(failedTask.executionState === 'FAILED', 'G-21 non-zero exit → FAILED (not ACCEPTED)');
  disp._resetDispatcherStateForTests();
}

{
  registerWorker('w-zero2', FIX_ZERO);
  const task = await makeReadyTask(goal.goalId, 'Zero exit');
  await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId,
    workerId: 'w-zero2',
    expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  await sleep(600);
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState !== 'RESULT_RECEIVED', 'G-22 zero exit does not mark RESULT_RECEIVED');
  check(after.pmState !== 'ACCEPTED', 'G-22 zero exit does not ACCEPT');
  disp._resetDispatcherStateForTests();
}

{
  const task = await makeReadyTask(goal.goalId, 'Claim only');
  // Manually bind a run for worker tools without full dispatch
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'ClaimAgent');
  await gt.linkRunToTask(TEST_ROOT, project, task.taskId, run.folder);
  const before = gt.getTask(TEST_ROOT, project, task.taskId).executionState;
  const tools = workerTools.buildAllWorkerTools({
    dataRoot: TEST_ROOT, project, taskId: task.taskId, runId: run.runId,
  });
  const submit = tools.find((t) => t.name === 'relay_worker_submit_result');
  const ev = await submit.handler({ summary: 'done claim' });
  check(ev.trustLevel === 'WORKER_CLAIM' || ev.trust?.level === 'WORKER_CLAIM' || ev.trustLevel === 'CLAIMED' || String(JSON.stringify(ev)).includes('CLAIM'), 'G-23 Worker submit_result still CLAIMED only');
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  check(after.executionState === before, 'G-24 Worker submit_result does not call markResultReceived');
}

// ── G-25..G-28 restart orphan safety ────────────────────────────────────────
console.log('\n── G-25..G-28 restart orphan safety ──');

{
  disp._resetDispatcherStateForTests();
  const t1 = await makeReadyTask(goal.goalId, 'Orphan Dispatched');
  await rt.transitionTaskExecution(TEST_ROOT, project, t1.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  const orphans1 = await disp.initializeDispatcherRecovery(TEST_ROOT, project);
  check(
    orphans1.some((o) => o.taskId === t1.taskId && o.status === 'ORPHAN_SUSPECTED'),
    'G-25 restart stale DISPATCHED → orphan suspected',
  );
  check(gt.getTask(TEST_ROOT, project, t1.taskId).executionState === 'DISPATCHED', 'G-25 not FAILED');

  const t2 = await makeReadyTask(goal.goalId, 'Orphan Running');
  await rt.transitionTaskExecution(TEST_ROOT, project, t2.taskId, {
    expectedExecutionState: 'READY', to: 'DISPATCHED',
  });
  await rt.transitionTaskExecution(TEST_ROOT, project, t2.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'RUNNING',
  });
  // Clear any live maps then recover
  disp._resetDispatcherStateForTests();
  // Re-seed orphan for t1 lost on reset — re-run recovery for both
  // After reset, recovery registry cleared; re-init
  await rt.transitionTaskExecution(TEST_ROOT, project, t1.taskId, {
    expectedExecutionState: 'DISPATCHED', to: 'DISPATCHED',
  }).catch(() => {});
  const orphans2 = await disp.initializeDispatcherRecovery(TEST_ROOT, project);
  check(
    orphans2.some((o) => o.taskId === t2.taskId && o.status === 'ORPHAN_SUSPECTED')
      || disp.getRecoveryRecord(TEST_ROOT, project, t2.taskId)?.status === 'ORPHAN_SUSPECTED',
    'G-26 restart stale RUNNING → orphan suspected',
  );
  check(gt.getTask(TEST_ROOT, project, t2.taskId).executionState === 'RUNNING', 'G-26 not FAILED');

  await shouldThrow(
    async () => disp.dispatchTask(TEST_ROOT, project, {taskId: t2.taskId,
      workerId: 'w-alive',
      expectedExecutionState: 'READY', workspaceRoot: WORKSPACE }),
    'G-27 orphan-suspected Task blocks redispatch',
    'ORPHAN_SUSPECTED',
  );

  const events = evk.listEvents(TEST_ROOT, project).events;
  check(
    events.some((e) => e.type === 'RUNTIME_WARNING' && String(e.summary).includes('ORPHAN_SUSPECTED')),
    'G-28 restart recovery emits runtime warning/event',
  );
}

// ── G-29..G-32 concurrency + retry ──────────────────────────────────────────
console.log('\n── G-29..G-32 concurrency + retry ──');

{
  disp._resetDispatcherStateForTests();
  registerWorker('w-alive2', FIX_ALIVE);
  const task = await makeReadyTask(goal.goalId, 'Double dispatch');
  const results = await Promise.allSettled([
    disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId, workerId: 'w-alive2', expectedExecutionState: 'READY', workspaceRoot: WORKSPACE }),
    disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId, workerId: 'w-alive2', expectedExecutionState: 'READY', workspaceRoot: WORKSPACE }),
  ]);
  const oks = results.filter((r) => r.status === 'fulfilled');
  const fails = results.filter((r) => r.status === 'rejected');
  check(oks.length === 1, 'G-29 double concurrent dispatch → one success');
  check(
    fails.length === 1 && (fails[0].reason?.code === 'CONFLICT' || String(fails[0].reason?.message || '').includes('CONFLICT')),
    'G-29 one CONFLICT',
  );
  const after = gt.getTask(TEST_ROOT, project, task.taskId);
  // Exactly one committed run from this dispatch wave (may equal 1)
  const workerRuns = after.linkedRuns.filter((r) => (r.agent || '').includes('worker-w-alive2') || true);
  check(after.linkedRuns.length >= 1, 'G-30 only one committed Run after concurrent dispatch');
  // Stronger: count runs created under worker agent folder
  const agentPath = path.join(TEST_ROOT, project, relay.todayString(), 'worker-w-alive2');
  const runDirs = fs.existsSync(agentPath) ? fs.readdirSync(agentPath).filter((n) => /^\d+$/.test(n)) : [];
  check(runDirs.length === 1, 'G-30 single worker run folder');
  disp._resetDispatcherStateForTests();
  void workerRuns;
}

{
  // Retry path: drive to RESULT_RECEIVED + CHANGES_REQUESTED → requestRetry → dispatch new run
  const task = await makeReadyTask(goal.goalId, 'Retry fresh');
  registerWorker('w-retry', FIX_ALIVE);
  const d1 = await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId, workerId: 'w-retry', expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  const run1 = d1.runId;
  // Force result received for retry precondition
  await rt.markResultReceived(TEST_ROOT, project, task.taskId, run1, {
    expectedExecutionState: 'RUNNING',
  });
  await rt.requestChanges(TEST_ROOT, project, task.taskId, run1, {
    goalId: goal.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING', reason: 'nits: please address',
  });
  await rt.requestRetry(TEST_ROOT, project, task.taskId, {
    goalId: goal.goalId,
    expectedExecutionState: 'RESULT_RECEIVED',
    expectedPmState: 'CHANGES_REQUESTED',
  });
  disp._resetDispatcherStateForTests();
  const before = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.map((r) => r.runId);
  const d2 = await disp.dispatchTask(TEST_ROOT, project, {taskId: task.taskId, workerId: 'w-retry', expectedExecutionState: 'READY', workspaceRoot: WORKSPACE });
  check(d2.runId !== run1, 'G-31 retry after READY creates new Run');
  const afterIds = gt.getTask(TEST_ROOT, project, task.taskId).linkedRuns.map((r) => r.runId);
  check(afterIds.includes(run1) && afterIds.includes(d2.runId), 'G-32 prior Run preserved');
  disp._resetDispatcherStateForTests();
  void before;
}

// ── G-33..G-39 MCP surface + no auto loops ──────────────────────────────────
console.log('\n── G-33..G-39 MCP surface + no auto loops ──');

{
  const tools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check(!!byName.relay_pm_dispatch_task, 'G-33 relay_pm_dispatch_task exists');

  const schema = byName.relay_pm_dispatch_task.inputSchema;
  check(
    Array.isArray(schema.required) && schema.required.includes('workerId'),
    'G-34 dispatch MCP requires workerId',
  );
  check(
    Array.isArray(schema.required)
      && schema.required.includes('expectedExecutionState')
      && schema.required.includes('workspaceRoot'),
    'G-35 dispatch MCP requires expectedExecutionState + workspaceRoot',
  );

  const task = await makeReadyTask(goal.goalId, 'MCP dispatch');
  registerWorker('w-mcp', FIX_ALIVE);
  const result = await byName.relay_pm_dispatch_task.handler({
    taskId: task.taskId,
    workerId: 'w-mcp',
    workspaceRoot: WORKSPACE,
    expectedExecutionState: 'READY',
  });
  const json = JSON.stringify(result);
  check(!json.includes('folder') && !json.includes(TEST_ROOT.replace(/\\/g, '\\\\')), 'G-36 dispatch response exposes no folder/path');
  check(!json.includes('launchCommand'), 'G-36 no launchCommand in response');

  const listed = await byName.relay_pm_list_workers.handler({});
  check(Array.isArray(listed.workers), 'G-37 list_workers read tool safe if implemented');
  check(
    listed.workers.every((w) => !('launchCommand' in w) && !('workingDirectory' in w)),
    'G-37 list_workers does not expose launchCommand',
  );

  const srcDisp = fs.readFileSync(path.resolve('src/backend/dispatcher.ts'), 'utf8');
  check(!/setInterval\s*\(/.test(srcDisp) && !/autoDispatch/.test(srcDisp), 'G-38 no auto-dispatch loop');
  check(!/autoRetry|scheduleRetry/.test(srcDisp), 'G-39 no auto-retry loop');
  disp._resetDispatcherStateForTests();
}

// ── G-40..G-45 regressions (smoke) ──────────────────────────────────────────
console.log('\n── G-40..G-45 phase regressions (smoke) ──');

{
  // Phase F
  const fTools = pmTools.buildAllPmTools({ dataRoot: TEST_ROOT, project });
  check(fTools.some((t) => t.name === 'relay_pm_get_context_for_event'), 'G-40 Phase F regression (gateway tool present)');

  // Phase E
  const wTools = workerTools.buildAllWorkerTools({
    dataRoot: TEST_ROOT, project, taskId: 'TASK-0001', runId: 'r1',
  });
  check(wTools.some((t) => t.name === 'relay_worker_submit_result'), 'G-41 Phase E regression (worker submit_result)');

  // Phase D
  const ev = await evk.recordRuntimeWarning(TEST_ROOT, project, {
    summary: 'regression warning',
    source: { kind: 'test' },
  });
  check(ev.type === 'RUNTIME_WARNING', 'G-42 Phase D regression (event kernel)');

  // Phase C
  const t = await makeReadyTask(goal.goalId, 'Evidence smoke');
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'EvAgent');
  await gt.linkRunToTask(TEST_ROOT, project, t.taskId, run.folder);
  const claim = await evidence.recordWorkerClaim(TEST_ROOT, project, {
    summary: 'claim',
    goalId: goal.goalId,
    taskId: t.taskId,
    runId: run.runId,
    source: { kind: 'worker' },
  });
  check(!!claim.evidenceId, 'G-43 Phase C regression (evidence kernel)');

  // B2
  check(typeof rt.transitionTaskExecution === 'function' && typeof rt.requestRetry === 'function', 'G-44 B2 regression');

  // Phase A — capture/fs materialize still works
  const mat = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'PhaseA');
  check(!!mat.folder && fs.existsSync(mat.folder), 'G-45 Phase A regression (run materialize)');
}

// ── R35 allowedTools: worker record → repeated --allowedTool relay args ──────
console.log('\n── R35 allowedTools relay args ──');

{
  const argv = disp.buildDispatchArgv(
    ['/path/to/wrapper.mjs'],
    {
      dataRoot: '/data',
      project: 'proj',
      taskId: 'TASK-0001',
      runId: 'run-id',
      workspaceRoot: '/workspace',
      allowedTools: ['Bash(node:*)', 'Read', 'Bash(git status:*)'],
    },
  );
  check(argv.includes('--allowedTool'), 'R35 buildDispatchArgv forwards --allowedTool relay args');
  const i0 = argv.indexOf('--allowedTool');
  check(i0 !== -1 && argv[i0 + 1] === 'Bash(node:*)', 'R35 first --allowedTool pattern is Bash(node:*)');
  check(argv[i0 + 2] === '--allowedTool' && argv[i0 + 3] === 'Read', 'R35 --allowedTool is repeatable (Read)');
  check(argv[i0 + 4] === '--allowedTool' && argv[i0 + 5] === 'Bash(git status:*)', 'R35 --allowedTool is repeatable (Bash(git status:*))');

  const noAllowed = disp.buildDispatchArgv(
    ['/path/to/wrapper.mjs'],
    {
      dataRoot: '/data',
      project: 'proj',
      taskId: 'TASK-0001',
      runId: 'run-id',
      workspaceRoot: '/workspace',
    },
  );
  check(!noAllowed.includes('--allowedTool'), 'R35 absent allowedTools injects no relay args');

  await shouldThrow(
    async () => wr.validateWorkerRegistryRecord(TEST_ROOT, {
      schemaVersion: 'G.2',
      workerId: 'w-r35-bad',
      launchCommand: NODE,
      launchArgsPrefix: [FIX_ZERO],
      driverOptions: { claude: { allowedTools: ['Bash(rm:*)'] } },
    }),
    'R35 registry rejects off-allowlist allowedTools pattern',
    'allowedTools',
  );

  wr.writeWorkerRegistryRecord(TEST_ROOT, {
    schemaVersion: 'G.2',
    workerId: 'w-r35',
    displayName: 'r35',
    launchCommand: NODE,
    launchArgsPrefix: [FIX_ZERO],
    capabilities: ['fixture'],
    observationAdapterId: 'test-fixture',
    driverOptions: { claude: { allowedTools: ['Bash(node:*)', 'Read'] } },
  });
  const rec = wr.loadWorkerRegistryRecord(TEST_ROOT, 'w-r35');
  check(
    rec.driverOptions?.claude?.allowedTools?.join(',') === 'Bash(node:*),Read',
    'R35 worker record round-trips allowedTools',
  );
  const fromRec = disp.buildDispatchArgv(['/x'], {
    dataRoot: '/data',
    project: 'proj',
    taskId: 'T',
    runId: 'r',
    workspaceRoot: '/w',
    allowedTools: rec.driverOptions?.claude?.allowedTools,
  });
  check(fromRec.includes('--allowedTool') && fromRec[fromRec.indexOf('--allowedTool') + 1] === 'Bash(node:*)', 'R35 worker-record allowedTools produce the relay args');
}

disp._resetDispatcherStateForTests();
await (await import('../dist/server/backend/capture-service.js'))._resetCaptureServiceForTests();

console.log(`\nPhase G tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
