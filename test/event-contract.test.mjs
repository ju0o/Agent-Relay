/**
 * Phase D contract correction tests (DC-01..DC-28).
 * Temporary DATA_ROOT only. All-ASCII source by design (encoding hygiene).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as ev from '../dist/server/backend/evidence.js';
import * as evk from '../dist/server/backend/event.js';
import * as rt from '../dist/server/backend/goal-task-runtime.js';
import sharedTypes from '../dist/server/shared/types.js';
const { EVENT_TYPES, ATTENTION_CLASSIFIER_VERSION } = sharedTypes;

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-dc-${process.pid}-${Date.now()}`);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'ContractProj';
const otherProject = 'OtherProj';
const base = { summary: 'contract test event', source: { kind: 'runtime-kernel' } };

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);
  relay.createProject(TEST_ROOT, otherProject);

  const goal = await gt.createGoal(TEST_ROOT, project, { title: 'DC Goal', goalStatement: 'g', completionCriteria: ['c'] });
  const task = await gt.createTask(TEST_ROOT, project, { goalId: goal.goalId, title: 'DC Task', goal: 'g', reason: 'r', scope: 's' });
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'Codex');
  const linked = await gt.linkRunToTask(TEST_ROOT, project, task.taskId, run.folder);
  const link = linked.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  const runId = link.runId;

  console.log('DC-01..06) PM attention classification matrix');
  const r1 = await evk.recordRunResultReceived(TEST_ROOT, project, base);
  const r2 = await evk.recordEvidenceReady(TEST_ROOT, project, base);
  const r3 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, taskId: task.taskId, runId });
  const r4 = await evk.recordRunFailed(TEST_ROOT, project, { ...base, taskId: task.taskId, runId });
  const r5 = await evk.recordOwnerDecisionRequired(TEST_ROOT, project, base);
  const r6 = await evk.recordTaskBecameReady(TEST_ROOT, project, base);
  const rBlocked = await evk.recordRunBlocked(TEST_ROOT, project, base);
  const rTimeout = await evk.recordTaskTimeout(TEST_ROOT, project, base);
  const rTBlocked = await evk.recordTaskBlocked(TEST_ROOT, project, base);
  const rErr = await evk.recordRuntimeError(TEST_ROOT, project, base);
  const rElig = await evk.recordGoalCompletionEligible(TEST_ROOT, project, { ...base, goalId: goal.goalId });
  const rWarn = await evk.recordRuntimeWarning(TEST_ROOT, project, base);
  check(r1.pmAttention.required === false, 'DC-01 RUN_RESULT_RECEIVED required=false');
  check(r2.pmAttention.required === false, 'DC-02 EVIDENCE_READY required=false');
  check(r3.pmAttention.required === true, 'DC-03 QA_FAILED required=true');
  check(r4.pmAttention.required === true, 'DC-04 RUN_FAILED required=true');
  check(r5.pmAttention.required === true, 'DC-05 OWNER_DECISION_REQUIRED required=true');
  check(r6.pmAttention.required === false, 'DC-06 TASK_BECAME_READY required=false');
  check(rBlocked.pmAttention.required === true, 'DC-04b RUN_BLOCKED required=true');
  check(rTimeout.pmAttention.required === true, 'DC-04c TASK_TIMEOUT required=true');
  check(rTBlocked.pmAttention.required === true, 'DC-04d TASK_BLOCKED required=true');
  check(rErr.pmAttention.required === true, 'DC-04e RUNTIME_ERROR required=true');
  check(rElig.pmAttention.required === true, 'DC-05b GOAL_COMPLETION_ELIGIBLE required=true');
  check(rWarn.pmAttention.required === false, 'DC-06b RUNTIME_WARNING required=false');
console.log('DC-07) classifier version persisted');
  const allSeven = [r1, r2, r3, r4, r5, r6, rWarn];
  check(allSeven.every((e) => e.attentionClassifierVersion === ATTENTION_CLASSIFIER_VERSION), 'DC-07 frozen version stamped (v' + ATTENTION_CLASSIFIER_VERSION + ')');
  const raw1 = JSON.parse(fs.readFileSync(path.join(evk.eventFolder(TEST_ROOT, project, r1.eventId), 'event.json'), 'utf8'));
  check(typeof raw1.attentionClassifierVersion === 'number' && raw1.attentionClassifierVersion >= 1, 'DC-07 persisted in event.json');

  console.log('DC-08) frozen classification survives reload semantics');
  const eventsRoot = evk.eventsDir(TEST_ROOT, project);
  const mkFrozen = (id, type, severity, required) => {
    const folder = path.join(eventsRoot, id);
    fs.mkdirSync(folder, { recursive: true });
    const rec = {
      schemaVersion: 1,
      eventId: id,
      project,
      type,
      severity,
      source: { kind: 'legacy-freeze' },
      summary: 'frozen classification probe',
      occurredAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      attentionClassifierVersion: ATTENTION_CLASSIFIER_VERSION,
      pmAttention: { required, reason: 'frozen probe' },
    };
    fs.writeFileSync(path.join(folder, 'event.json'), JSON.stringify(rec, null, 2), 'utf8');
    fs.writeFileSync(path.join(folder, 'delivery.json'), JSON.stringify({ eventId: id, status: 'PENDING', updatedAt: rec.recordedAt }, null, 2), 'utf8');
  };
  mkFrozen('EVENT-900001', 'RUN_FAILED', 'ERROR', false);
  mkFrozen('EVENT-900002', 'TASK_BECAME_READY', 'INFO', true);
  const pend = evk.listPendingPmEvents(TEST_ROOT, project);
  check(!pend.some((e) => e.eventId === 'EVENT-900001'), 'DC-08 frozen required=false kept (not re-derived)');
  check(pend.some((e) => e.eventId === 'EVENT-900002'), 'DC-08 frozen required=true kept (not re-derived)');
  const gFrozen = evk.getEvent(TEST_ROOT, project, 'EVENT-900001');
  check(gFrozen.pmAttention.required === false && gFrozen.attentionClassifierVersion === ATTENTION_CLASSIFIER_VERSION, 'DC-08 getEvent returns frozen classification');

  console.log('DC-09/10) closed vocabulary');
  check(!EVENT_TYPES.includes('ALL_PARALLEL_RUNS_COMPLETED'), 'DC-09 ALL_PARALLEL_RUNS_COMPLETED absent from EVENT_TYPES');
  check(!EVENT_TYPES.includes('PM_REVIEW_REQUIRED'), 'DC-10 PM_REVIEW_REQUIRED absent from EVENT_TYPES');
  const typesSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'types.ts'), 'utf8');
  check(!typesSrc.includes("'ALL_PARALLEL_RUNS_COMPLETED'"), 'DC-09 absent from shared/types.ts');
  check(!typesSrc.includes("'PM_REVIEW_REQUIRED'"), 'DC-10 absent from shared/types.ts');
  const eventSrc = fs.readFileSync(path.join(REPO, 'src', 'backend', 'event.ts'), 'utf8');
  check(!eventSrc.includes("'ALL_PARALLEL_RUNS_COMPLETED'"), 'DC-09 absent from event kernel vocabulary');
  check(!eventSrc.includes("'PM_REVIEW_REQUIRED'"), 'DC-10 absent from event kernel vocabulary');

  console.log('DC-11/12) no severity / attention override');
  const ov = await evk.recordQaFailed(TEST_ROOT, project, {
    ...base,
    severity: 'INFO',
    pmAttention: { required: false, reason: 'caller tries to suppress' },
    taskId: task.taskId,
    runId,
  });
  check(ov.severity === 'ERROR', 'DC-11 severity override ignored (derived ERROR)');
  check(ov.pmAttention.required === true, 'DC-12 pmAttention override ignored (derived true)');

  await secondHalf({ goal, task, runId });
}

main().catch((err) => { console.error(err); process.exit(1); });
async function secondHalf({ goal, task, runId }) {
  console.log('DC-13) no raw event:create IPC');
  const mainSrc = fs.readFileSync(path.join(REPO, 'src', 'backend', 'main.ts'), 'utf8');
  check(!mainSrc.includes("case 'event:create'"), 'DC-13 no event:create case in main.ts');
  const typesSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'types.ts'), 'utf8');
  check(!typesSrc.includes("op: 'event:create'"), 'DC-13 no event:create RelayRequest op');
  for (const op of ['event:get', 'event:list', 'event:listPendingPm', 'event:getSummary', 'event:markDelivered', 'event:acknowledge', 'event:ignore']) {
    if (!typesSrc.includes("op: '" + op + "'")) FAIL('DC-13 missing op ' + op);
  }
  PASS('DC-13 read/delivery ops present');

  console.log('DC-14/15) privileged event boundary');
  const exported = Object.keys(evk);
  check(!exported.includes('recordEventInternal'), 'DC-14 internal primitive not exported');
  check(!exported.some((k) => /^create/i.test(k) && !k.startsWith('record')), 'DC-14 no generic exported creator');
  check(typeof evk.recordGoalCompleted === 'function' && typeof evk.recordOwnerDecisionRequired === 'function' && typeof evk.recordGoalCompletionEligible === 'function', 'DC-14 privileged events minted only via trusted server-side helpers');
  check(exported.every((k) => !k.startsWith('recordWorker') && !k.startsWith('recordPublic')), 'DC-15 no Worker-safe privileged mint helper');

  console.log('DC-16/17) delivery transitions');
  const d16 = await evk.recordRunResultReceived(TEST_ROOT, project, base);
  const dd = evk.markDelivered(TEST_ROOT, project, d16.eventId, 'PENDING');
  check(dd.status === 'DELIVERED', 'DC-16 PENDING -> DELIVERED');
  const da = evk.acknowledge(TEST_ROOT, project, d16.eventId, 'DELIVERED');
  check(da.status === 'ACKNOWLEDGED', 'DC-17 DELIVERED -> ACKNOWLEDGED');

  console.log('DC-18) IGNORE terminal');
  const d18 = await evk.recordRunResultReceived(TEST_ROOT, project, base);
  const ig = evk.ignore(TEST_ROOT, project, d18.eventId, 'PENDING');
  check(ig.status === 'IGNORED', 'DC-18 PENDING -> IGNORED');
  let termReject = false;
  try { evk.markDelivered(TEST_ROOT, project, d18.eventId, 'IGNORED'); } catch { termReject = true; }
  check(termReject, 'DC-18 IGNORED is terminal (no exit)');
  let termReplay = true;
  try { const again = evk.ignore(TEST_ROOT, project, d18.eventId, 'IGNORED'); check(again.status === 'IGNORED', 'DC-18 repeated ignore is a no-op success'); } catch { termReplay = false; }
  check(termReplay, 'DC-18 idempotent replay safe');
  const acked = await evk.recordRunResultReceived(TEST_ROOT, project, base);
  evk.markDelivered(TEST_ROOT, project, acked.eventId, 'PENDING');
  evk.acknowledge(TEST_ROOT, project, acked.eventId, 'DELIVERED');
  let ackTerminal = false;
  try { evk.ignore(TEST_ROOT, project, acked.eventId, 'ACKNOWLEDGED'); } catch { ackTerminal = true; }
  check(ackTerminal, 'DC-18 ACKNOWLEDGED is terminal');

  console.log('DC-19) sourceEventId replay regression');
  const s1 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, sourceEventId: 'dc-src-1', taskId: task.taskId, runId });
  const s2 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, sourceEventId: 'dc-src-1', taskId: task.taskId, runId });
  check(s1.eventId === s2.eventId, 'DC-19 same logical Event returned');

  console.log('DC-20) restart pending queue regression');
  const rq = await evk.recordQaFailed(TEST_ROOT, project, { ...base });
  const pendAfter = evk.listPendingPmEvents(TEST_ROOT, project);
  check(pendAfter.some((e) => e.eventId === rq.eventId), 'DC-20 pending queue reconstructed from disk');

  console.log('DC-21) linkage regression');
  let badRun = false;
  try { await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, runId: '00000000-0000-4000-8000-000000000000' }); } catch { badRun = true; }
  check(badRun, 'DC-21 invalid runId rejected');
  let crossProj = false;
  try { await evk.recordRunResultReceived(TEST_ROOT, otherProject, { ...base, taskId: task.taskId, runId }); } catch { crossProj = true; }
  check(crossProj, 'DC-21 cross-project rejected');

  console.log('DC-22) malformed isolation regression');
  const evRoot = evk.eventsDir(TEST_ROOT, project);
  fs.mkdirSync(path.join(evRoot, 'EVENT-999999'), { recursive: true });
  fs.writeFileSync(path.join(evRoot, 'EVENT-999999', 'event.json'), '{not json', 'utf8');
  const lst = evk.listEvents(TEST_ROOT, project);
  check(lst.events.length > 0 && lst.warnings.some((w) => w.includes('EVENT-999999')), 'DC-22 listing survives malformed neighbor with warning');
  let directBad = false;
  try { evk.getEvent(TEST_ROOT, project, 'EVENT-999999'); } catch { directBad = true; }
  check(directBad, 'DC-22 direct get malformed fails clearly');

  await thirdHalf({ goal, task, runId });
}
async function thirdHalf({ goal, task, runId }) {
  console.log('DC-23/24/25) Event creation leaves canonical state unchanged');
  const taskBefore = gt.getTask(TEST_ROOT, project, task.taskId);
  const goalBefore = gt.getGoal(TEST_ROOT, project, goal.goalId);
  const claim = await ev.recordWorkerClaim(TEST_ROOT, project, { summary: 'dc claim', taskId: task.taskId, runId });
  const claimBefore = ev.getEvidence(TEST_ROOT, project, claim.evidenceId);
  await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, taskId: task.taskId, runId, goalId: goal.goalId, evidenceId: claim.evidenceId });
  await evk.recordGoalCompleted(TEST_ROOT, project, { ...base, goalId: goal.goalId });
  await evk.recordQaFailed(TEST_ROOT, project, { ...base, taskId: task.taskId, runId, evidenceId: claim.evidenceId });
  check(JSON.stringify(taskBefore) === JSON.stringify(gt.getTask(TEST_ROOT, project, task.taskId)), 'DC-23 Task unchanged');
  check(JSON.stringify(goalBefore) === JSON.stringify(gt.getGoal(TEST_ROOT, project, goal.goalId)), 'DC-24 Goal unchanged');
  check(JSON.stringify(claimBefore) === JSON.stringify(ev.getEvidence(TEST_ROOT, project, claim.evidenceId)), 'DC-25 Evidence unchanged');

  console.log('DC-26/27/28) Phase C / B2 / A regressions (sanity)');
  const testEv = await ev.recordTestEvidence(TEST_ROOT, project, {
    summary: 'dc regression test',
    taskId: task.taskId,
    runId,
    details: { command: 'npm test', exitCode: 0 },
  });
  check(ev.getEvidence(TEST_ROOT, project, testEv.evidenceId).trustLevel === 'VERIFIED', 'DC-26 Evidence kernel intact (Phase C)');
  const readiness = rt.getTaskReadinessForId(TEST_ROOT, project, task.taskId);
  check(typeof readiness === 'object', 'DC-27 B2 readiness intact');
  const run2 = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), 'Claude Code');
  check(fs.existsSync(run2.folder), 'DC-28 Phase A run materialization intact');

  console.log('\nDC DONE');
}
