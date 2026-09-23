/**
 * V1 W-A1..W-A5 — quota-aware failover.
 *
 * Runs against compiled server modules under dist/server with fake `.mjs`
 * workers — never a real provider call. What this proves, in the order the
 * 2026-09-16 Founder-absence failure actually happened:
 *
 *   1. a provider limit message is RECOGNIZED (it used to reach the QA
 *      parser as "no status: line", i.e. as a work defect);
 *   2. the seat is HELD until its stated reset and released automatically;
 *   3. the QA chain ROTATES to the next seat and the Task still completes;
 *   4. an exhausted chain produces QUOTA_EXHAUSTED, spends no QA budget and
 *      never finalizes BLOCKED — it never becomes an owner decision;
 *   5. failover never lands the reviewer on the producer's runtime;
 *   6. the PM turn walker skips held seats and waits instead of escalating.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-v1-quota-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0; let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed += 1; }
  else { console.log(`  FAIL  ${message}`); failed += 1; process.exitCode = 1; }
};

const q = await import('../dist/server/backend/quota-signal.js');
const gt = await import('../dist/server/backend/goal-task.js');
const qa = await import('../dist/server/backend/qa-attempt.js');
const wr = await import('../dist/server/backend/worker-registry.js');
const sem = await import('../dist/server/backend/qa-semantic-evaluator.js');
const rl = await import('../dist/server/orchestrator/role-loop.js');

const project = 'V1Quota';
let runCounter = 0;
let workerCounter = 0;

async function makeTaskWithRun(producerWorkerId = 'fixture-builder') {
  const goal = await gt.createGoal(ROOT, project, { title: 'quota goal', goalStatement: 'quota fixture goal' });
  const task = await gt.createTask(ROOT, project, {
    goalId: goal.goalId, title: 'quota task', goal: 'quota fixture task', reason: 'fixture', scope: 'fixture-only',
    executionState: 'RUNNING', pmState: 'PENDING',
  });
  runCounter += 1;
  const workspaceRoot = path.join(ROOT, 'ws', String(runCounter));
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const folder = path.join(ROOT, project, '_fixture-runs', String(runCounter));
  fs.mkdirSync(folder, { recursive: true });
  const runId = `quota-run-${runCounter}`;
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ tags: [], runId, workspaceRoot, workerId: producerWorkerId }), 'utf8');
  await gt.linkRunToTask(ROOT, project, task.taskId, folder);
  fs.mkdirSync(path.join(folder, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'evidence', 'adapter.json'), JSON.stringify({ fixture: true }), 'utf8');
  fs.writeFileSync(path.join(folder, 'result.md'), 'Implemented the requested change.', 'utf8');
  return { task, runId, folder, workspaceRoot };
}

const FAKE_WORKERS_DIR = path.join(ROOT, '_fake-workers');
fs.mkdirSync(FAKE_WORKERS_DIR, { recursive: true });

// Fake workers are real .mjs files: `node -e` plus a later `--print` argv
// confuses Node's own flag parsing (same trap documented in the Slice 3 suite).
function registerFakeQaWorker(script, options = {}) {
  workerCounter += 1;
  const workerId = options.workerId ?? `fake-qa-${workerCounter}`;
  const scriptPath = path.join(FAKE_WORKERS_DIR, `${workerId}.mjs`);
  fs.writeFileSync(scriptPath, script, 'utf8');
  wr.writeWorkerRegistryRecord(ROOT, {
    schemaVersion: 'G.2', workerId, launchCommand: process.execPath, launchArgsPrefix: [scriptPath], role: 'qa',
    ...(options.observationAdapterId ? { observationAdapterId: options.observationAdapterId } : {}),
  });
  return workerId;
}

const passScript = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconst p = process.argv[3] || '';\nconst ids = [...new Set([...p.matchAll(/^- (AC[A-Za-z0-9_-]*): /gm)].map((m) => m[1]))];\nconsole.log('status: PASS');\nconsole.log('criteria:');\nfor (const id of ids) console.log('- ' + id + ': PASS');\n`;
// Verbatim shape of the Claude Code session-limit reply behind the
// 2026-09-16 escalation.
const quotaScript = (marker) => `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, 'x');\nconsole.log('Claude usage limit reached. Your limit will reset at 11:30pm (Asia/Seoul).');\n`;

wr.writeWorkerRegistryRecord(ROOT, {
  schemaVersion: 'G.2', workerId: 'fixture-builder', launchCommand: process.execPath, launchArgsPrefix: ['-e', "console.log('placeholder')"],
  observationAdapterId: 'actl-managed',
});

console.log('\n== 1) DETECTION ==');
{
  const claude = q.detectQuotaSignal('Claude usage limit reached. Your limit will reset at 11:30pm (Asia/Seoul).');
  check(claude !== null, '1a Claude session-limit line detected');
  check(!!claude?.resetAt && Date.parse(claude.resetAt) > Date.now(), `1b resetAt parsed into the future (got ${claude?.resetAt})`);
  const codex = q.detectQuotaSignal('stream error: You have hit your usage limit. Try again in 4 hours.');
  check(codex !== null, '1c Codex usage-limit line detected');
  check(!!codex?.resetAt, `1d relative reset parsed (got ${codex?.resetAt})`);
  const weekly = q.detectQuotaSignal('Weekly limit reached for this model.');
  check(weekly !== null && weekly.resetAt === undefined, '1e weekly limit, no stated reset → detected and resetAt absent (never guessed)');
  check(q.detectQuotaSignal('status: PASS\ncriteria:\n- AC-1: PASS') === null, '1f a normal QA verdict is NOT a quota signal');
  check(q.detectQuotaSignal('Error: ENOENT: no such file or directory') === null, '1g a generic runtime error is NOT a quota signal (fail-closed)');
  check(q.detectQuotaSignal('the model refused to answer') === null, '1h a refusal is NOT a quota signal');
}

console.log('\n== 2) LEDGER + RESET QUEUING ==');
{
  const seat = 'qa-worker:ledger-probe';
  const future = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  const signal = q.recordQuotaExhaustion(ROOT, seat, { matched: 'usage limit reached', resetAt: future });
  check(signal.holdUntil === future, '2a hold honours the provider-stated reset');
  check(q.isQuotaExhausted(ROOT, seat) !== null, '2b seat reads back as held');
  check(q.earliestQuotaRelease(ROOT, [seat, 'qa-worker:unheld']) === future, '2c earliest release across a chain');
  // Time travel instead of sleeping: the ledger takes `now` explicitly.
  const afterReset = new Date(Date.parse(future) + 1000);
  check(q.isQuotaExhausted(ROOT, seat, afterReset) === null, '2d hold auto-expires at the reset time (no sweeper, no owner)');
  check(q.isQuotaExhausted(ROOT, seat) === null, '2e expiry is durable — the seat is re-admitted');
  const noReset = q.recordQuotaExhaustion(ROOT, seat, { matched: 'weekly limit reached' });
  check(Date.parse(noReset.holdUntil) - Date.now() <= q.DEFAULT_QUOTA_HOLD_MS + 5000, '2f unknown reset falls back to a bounded default hold, never forever');
  const absurd = q.recordQuotaExhaustion(ROOT, seat, { matched: 'x', resetAt: new Date(Date.now() + 400 * 86400000).toISOString() });
  check(Date.parse(absurd.holdUntil) - Date.now() <= q.DEFAULT_QUOTA_HOLD_MS + 5000, '2g an absurd reset time is rejected, not trusted');
  q.clearQuotaExhaustion(ROOT, seat);
  check(q.isQuotaExhausted(ROOT, seat) === null, '2h explicit clear works');
}

console.log('\n== 3) QA SEAT ROTATION (the reproduced blocker) ==');
{
  const { task, runId } = await makeTaskWithRun();
  const exhaustedMarker = path.join(ROOT, 'marker-3-exhausted');
  const healthyMarker = path.join(ROOT, 'marker-3-healthy');
  const exhausted = registerFakeQaWorker(quotaScript(exhaustedMarker), { workerId: 'qa-seat-exhausted', observationAdapterId: 'claude-code' });
  const healthy = registerFakeQaWorker(passScript(healthyMarker), { workerId: 'qa-seat-healthy', observationAdapterId: 'opencode' });
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: exhausted, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
    qaWorkerFallbackChain: [`qa-worker:${healthy}`],
  });
  check(out.record.finalQaStatus === 'PASS', `3a Task reaches QA PASS despite the primary seat being out of quota (got ${out.record.finalQaStatus})`);
  check(out.record.semantic.qaWorkerId === healthy, `3b evidence names the seat that actually judged (got ${out.record.semantic.qaWorkerId})`);
  check(fs.existsSync(exhaustedMarker) && fs.readFileSync(exhaustedMarker, 'utf8') === 'x', '3c the exhausted seat is tried exactly once — a quota reply is not re-attempted');
  check(fs.readFileSync(healthyMarker, 'utf8') === 'x', '3d the fallback seat judged once');
  const held = q.isQuotaExhausted(ROOT, `qa-worker:${exhausted}`);
  check(held !== null, '3e the exhausted seat is recorded in the ledger');
  check(!!held?.resetAt, `3f its provider-stated reset is durable (got ${held?.resetAt})`);
  check(q.isQuotaExhausted(ROOT, `qa-worker:${healthy}`) === null, '3g the seat that answered carries no hold');
  const runDir = path.join(ROOT, project, '_relay', 'qa-semantic-runs', attempt.qaAttemptId);
  const seats = fs.readFileSync(path.join(runDir, 'seats.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check(seats.length === 2 && seats[0].seatId.endsWith(exhausted) && seats[1].seatId.endsWith(healthy), `3h seat provenance is independently readable (got ${JSON.stringify(seats.map((s) => s.seatId))})`);
  check(fs.existsSync(path.join(runDir, `quota-${exhausted}.json`)), '3i the quota evidence artifact is persisted next to the attempt');
}

console.log('\n== 4) WHOLE CHAIN EXHAUSTED → WAIT, NOT OWNER ==');
{
  const { task, runId } = await makeTaskWithRun();
  const a = registerFakeQaWorker(quotaScript(path.join(ROOT, 'marker-4a')), { workerId: 'qa-seat-dry-1', observationAdapterId: 'claude-code' });
  const b = registerFakeQaWorker(quotaScript(path.join(ROOT, 'marker-4b')), { workerId: 'qa-seat-dry-2', observationAdapterId: 'opencode' });
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: a, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
    qaWorkerFallbackChain: [`qa-worker:${b}`],
  });
  check(q.isQuotaExhaustedReason(out.record.reason), `4a the block is classified QUOTA_EXHAUSTED, not a QA defect (got ${out.record.reason})`);
  check(!!q.resetAtFromReason(out.record.reason), '4b the reason carries a machine-parsable resetAt for the supervisor to wake on');
  check(out.record.reason.includes(a) && out.record.reason.includes(b), '4c every dry seat is named in the evidence');
  // Budget accounting: an infrastructure hold must not consume the bounded
  // semantic-BLOCKED budget reserved for real work defects.
  const kept = await qa.recordSemanticBlockedForRetry(ROOT, project, attempt.qaAttemptId, out.record.reason, { consumeBudget: false });
  check((kept.semanticBlockedAttempts ?? 0) === 0, `4d quota holds spend no semantic budget (got ${kept.semanticBlockedAttempts})`);
  check(kept.finalQaStatus === 'PENDING', '4e the attempt returns to PENDING — it is resumable after the reset, never finalized BLOCKED');
  const spent = await qa.recordSemanticBlockedForRetry(ROOT, project, attempt.qaAttemptId, 'a real unparseable verdict');
  check((spent.semanticBlockedAttempts ?? 0) === 1, '4f a genuine QA defect still consumes the budget (default unchanged)');
}

console.log('\n== 5) INDEPENDENCE INVARIANT UNDER FAILOVER (DEC-2026-013) ==');
{
  const { task, runId } = await makeTaskWithRun('fixture-builder');
  const sameRuntimeMarker = path.join(ROOT, 'marker-5-same');
  const exhausted = registerFakeQaWorker(quotaScript(path.join(ROOT, 'marker-5-dry')), { workerId: 'qa-seat-ind-primary', observationAdapterId: 'opencode' });
  // A fallback seat that happens to live on the BUILDER's runtime: taking it
  // would make the second opinion non-independent, so it must be skipped even
  // though it is healthy and available.
  const sameRuntime = registerFakeQaWorker(passScript(sameRuntimeMarker), { workerId: 'qa-seat-ind-same-runtime', observationAdapterId: 'actl-managed' });
  const attempt = await qa.createQaAttempt(ROOT, project, { taskId: task.taskId, runId, qaAttemptNumber: 1, qaWorkerId: exhausted, criteriaValidationModes: { 'AC-1': 'SEMANTIC' } });
  await qa.recordDeterministicEvidence(ROOT, project, attempt.qaAttemptId, { status: 'PASS', checks: [] });
  const out = await sem.evaluateSemanticQa(ROOT, project, {
    qaAttemptId: attempt.qaAttemptId,
    task: { title: 't', goal: 'g', reason: 'r', scope: 's' },
    criteriaText: { 'AC-1': 'the thing must work' },
    qaWorkerFallbackChain: [`qa-worker:${sameRuntime}`],
    excludeObservationAdapters: ['actl-managed'],
  });
  check(!fs.existsSync(sameRuntimeMarker), '5a the producer-runtime seat is never invoked — failover cannot fake independence');
  check(out.record.finalQaStatus !== 'PASS', `5b no PASS is manufactured from a barred seat (got ${out.record.finalQaStatus})`);
  check(q.isQuotaExhaustedReason(out.record.reason), '5c the loop waits (QUOTA_EXHAUSTED) rather than breaking the invariant');
  check(out.record.reason.includes('독립성 불변식'), `5d the skip reason is stated as evidence (got ${out.record.reason})`);
}

console.log('\n== 6) PM TURN WALKER ==');
{
  const adapters = new Map();
  const mk = (id) => ({ id, capabilities: () => ({ persistentSession: true, structuredOutput: true, readWorkspace: true }) });
  for (const id of ['opencode-command', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free']) adapters.set(id, mk(id));
  const assignment = {
    roleId: 'pm', runtimeAdapterId: 'opencode-command', model: 'mimo-v2.5-free',
    workspace: { project, workspaceRoot: ROOT }, sessionPolicy: 'persistent', permissionProfile: 'read-only',
    capabilityRequirements: { persistentSession: true, structuredOutput: true }, zeroExtraBilling: true,
    fallbackChain: ['opencode/big-pickle', 'opencode/nemotron-3-ultra-free'], enabled: true,
  };
  const cfg = { dataRoot: ROOT, project, pmAdapter: adapters.get('opencode-command'), resolveAdapter: (id) => adapters.get(id) ?? null };
  check(rl.resolvePmAdapterForTurn(cfg, assignment).id === 'opencode-command', '6a healthy primary is used');
  q.recordQuotaExhaustion(ROOT, 'opencode-command', { matched: 'usage limit reached', resetAt: new Date(Date.now() + 3600000).toISOString() });
  check(rl.resolvePmAdapterForTurn(cfg, assignment).id === 'opencode/big-pickle', '6b an exhausted primary rotates to the next free-tier seat');
  q.recordQuotaExhaustion(ROOT, 'opencode/big-pickle', { matched: 'usage limit reached' });
  check(rl.resolvePmAdapterForTurn(cfg, assignment).id === 'opencode/nemotron-3-ultra-free', '6c rotation walks the whole chain');
  q.recordQuotaExhaustion(ROOT, 'opencode/nemotron-3-ultra-free', { matched: 'usage limit reached' });
  let thrown;
  try { rl.resolvePmAdapterForTurn(cfg, assignment); } catch (err) { thrown = err; }
  check(thrown?.code === 'QUOTA_EXHAUSTED', `6d a fully dry chain is QUOTA_EXHAUSTED, never OWNER_REQUIRED (got ${thrown?.code})`);
  check(!!thrown?.resetAt, '6e the wait carries a resetAt so the supervisor resumes unattended');
  q.clearQuotaExhaustion(ROOT, 'opencode-command');
  check(rl.resolvePmAdapterForTurn(cfg, assignment).id === 'opencode-command', '6f the primary is re-admitted as soon as its hold clears');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
