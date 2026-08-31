/**
 * Phase D Event runtime kernel tests (D-01..D-36).
 * Temporary DATA_ROOT only ??never touches real project data.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as ev from '../dist/server/backend/evidence.js';
import * as evk from '../dist/server/backend/event.js';

const TEST_ROOT = path.join(os.tmpdir(), `agent-relay-ev-d-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const project = 'EventProj';
const otherProject = 'OtherProj';

async function linkFreshRun(taskId, agent = 'Codex') {
  const run = await relay.atomicMaterializeRun(TEST_ROOT, project, relay.todayString(), agent);
  const task = await gt.linkRunToTask(TEST_ROOT, project, taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  return { run, link, runId: link.runId, folder: run.folder };
}

const base = { summary: 'test event', source: { kind: 'runtime-kernel' } };

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);
  relay.createProject(TEST_ROOT, otherProject);

  const goal = await gt.createGoal(TEST_ROOT, project, { title: 'Event Goal', goalStatement: 'g', completionCriteria: ['c'] });
  const goal2 = await gt.createGoal(TEST_ROOT, project, { title: 'Other Goal', goalStatement: 'g2', completionCriteria: ['c'] });
  const task = await gt.createTask(TEST_ROOT, project, { goalId: goal.goalId, title: 'Task A', goal: 'g', reason: 'r', scope: 's' });
  const task2 = await gt.createTask(TEST_ROOT, project, { goalId: goal2.goalId, title: 'Task B', goal: 'g2', reason: 'r', scope: 's' });
  const { runId, folder: runFolder } = await linkFreshRun(task.taskId);

  console.log('D-01) create INFO runtime event');
  const w1 = await evk.recordRuntimeWarning(TEST_ROOT, project, base);
  check(w1.severity === 'WARNING', `D-01 severity=${w1.severity}`);
  check(w1.type === 'RUNTIME_WARNING', 'D-01 type RUNTIME_WARNING');

  console.log('D-02) stable Event ID');
  check(w1.eventId === 'EVENT-000001', `D-02 id=${w1.eventId}`);

  console.log('D-03) persisted event.json + event.md');
  const folder1 = evk.eventFolder(TEST_ROOT, project, w1.eventId);
  check(fs.existsSync(path.join(folder1, 'event.json')), 'D-03 event.json');
  check(fs.existsSync(path.join(folder1, 'event.md')), 'D-03 event.md');
  check(fs.existsSync(path.join(folder1, 'delivery.json')), 'D-03 delivery.json');

  console.log('D-04) Event immutable payload');
  const jsonBefore = fs.readFileSync(path.join(folder1, 'event.json'), 'utf8');
  await evk.markDelivered(TEST_ROOT, project, w1.eventId, 'PENDING');
  const jsonAfter = fs.readFileSync(path.join(folder1, 'event.json'), 'utf8');
  check(jsonBefore === jsonAfter, 'D-04 event.json byte-identical after delivery change');
  check(evk.getEvent(TEST_ROOT, project, w1.eventId).summary === w1.summary, 'D-04 summary unchanged');

  console.log('D-05) sourceEventId idempotency');
  const eA = await evk.recordRuntimeWarning(TEST_ROOT, project, { ...base, sourceEventId: 'src-1' });
  const eB = await evk.recordRuntimeWarning(TEST_ROOT, project, { ...base, sourceEventId: 'src-1', summary: 'different' });
  check(eA.eventId === eB.eventId, `D-05 same eventId=${eA.eventId}`);
  check(eA.summary !== 'different', 'D-05 original payload returned');

  console.log('D-06) concurrent duplicate sourceEventId');
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      evk.recordQaFailed(TEST_ROOT, project, { ...base, sourceEventId: 'src-concurrent', taskId: task.taskId, runId }),
    ),
  );
  const uniqueIds = new Set(results.map((r) => r.eventId));
  check(uniqueIds.size === 1, `D-06 all return same id (${uniqueIds.size})`);

  console.log('D-07) concurrent unique Event allocation');
  const uniq = await Promise.all(
    Array.from({ length: 15 }, (_, i) => evk.recordRuntimeWarning(TEST_ROOT, project, { ...base, summary: `uniq-${i}` })),
  );
  const uniqSet = new Set(uniq.map((r) => r.eventId));
  check(uniqSet.size === 15, `D-07 15 distinct ids (${uniqSet.size})`);
  const ids = [...uniq].map((r) => parseInt(r.eventId.split('-')[1], 10)).sort((a, b) => a - b);
  check(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'D-07 monotonic unique allocation');
// ?? D-08 valid Run linkage ???????????????????????????????????????????????
  console.log('D-08) valid Run linkage');
  const eRun = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, taskId: task.taskId, runId });
  check(eRun.runId === runId && eRun.taskId === task.taskId, 'D-08 runId/taskId stamped');

  // ?? D-09 invalid Run rejected ????????????????????????????????????????????
  console.log('D-09) invalid Run rejected');
  let badRun = false;
  try {
    await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, runId: '00000000-0000-4000-8000-000000000000' });
  } catch { badRun = true; }
  check(badRun, 'D-09 invalid runId rejected');

  // ?? D-10 Task/Run mismatch rejected ??????????????????????????????????????
  console.log('D-10) Task/Run mismatch rejected');
  const { runId: runId2 } = await linkFreshRun(task2.taskId, 'Claude Code');
  let trMismatch = false;
  try {
    await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, taskId: task.taskId, runId: runId2 });
  } catch { trMismatch = true; }
  check(trMismatch, 'D-10 Task/Run mismatch rejected');

  // ?? D-11 Task/Goal mismatch rejected ?????????????????????????????????????
  console.log('D-11) Task/Goal mismatch rejected');
  let tgMismatch = false;
  try {
    await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, goalId: goal2.goalId, taskId: task.taskId, runId });
  } catch { tgMismatch = true; }
  check(tgMismatch, 'D-11 Task/Goal mismatch rejected');

  // ?? D-12 Evidence/Event linkage consistency ??????????????????????????????
  console.log('D-12) Evidence/Event linkage consistency');
  const claim = await ev.recordWorkerClaim(TEST_ROOT, project, { summary: 'claim', taskId: task.taskId, runId });
  const eEvil = await evk.recordEvidenceReady(TEST_ROOT, project, { ...base, taskId: task.taskId, runId, evidenceId: claim.evidenceId });
  check(eEvil.evidenceId === claim.evidenceId, 'D-12 evidenceId linked to matching task');
  let evMismatch = false;
  try {
    await evk.recordEvidenceReady(TEST_ROOT, project, { ...base, taskId: task2.taskId, runId: runId2, evidenceId: claim.evidenceId });
  } catch { evMismatch = true; }
  check(evMismatch, 'D-12 conflicting task/evidence rejected');

  // ?? D-13 cross-project rejected ??????????????????????????????????????????
  console.log('D-13) cross-project rejected');
  let crossProj = false;
  try {
    await evk.recordRunResultReceived(TEST_ROOT, otherProject, { ...base, taskId: task.taskId, runId });
  } catch { crossProj = true; }
  check(crossProj, 'D-13 other-project linkage rejected');

  // ?? D-14 PM required QA_FAILED ???????????????????????????????????????????
  console.log('D-14) QA_FAILED => PM required');
  const qa = await evk.recordQaFailed(TEST_ROOT, project, { ...base, taskId: task.taskId, runId });
  check(qa.pmAttention.required === true, 'D-14 pmAttention.required true');

  // ?? D-15 PM required OWNER_DECISION_REQUIRED ?????????????????????????????
  console.log('D-15) OWNER_DECISION_REQUIRED => PM required');
  const odr = await evk.recordOwnerDecisionRequired(TEST_ROOT, project, { ...base });
  check(odr.pmAttention.required === true && odr.pmAttention.priority === 'HIGH', 'D-15 required + HIGH');

  // ?? D-16 PM not required TASK_BECAME_READY ???????????????????????????????
  console.log('D-16) TASK_BECAME_READY => PM not required');
  const ready = await evk.recordTaskBecameReady(TEST_ROOT, project, { ...base });
  check(ready.pmAttention.required === false, 'D-16 not required');

  // ?? D-17 severity defaults deterministic ?????????????????????????????????
  console.log('D-17) severity defaults deterministic');
  check(qa.severity === 'ERROR', 'D-17 QA_FAILED=ERROR');
  check(odr.severity === 'WARNING', 'D-17 OWNER_DECISION_REQUIRED=WARNING');
  check(w1.severity === 'WARNING', 'D-17 RUNTIME_WARNING=WARNING');
  const eligible = await evk.recordGoalCompletionEligible(TEST_ROOT, project, { ...base, goalId: goal.goalId });
  check(eligible.severity === 'WARNING', 'D-17 GOAL_COMPLETION_ELIGIBLE=WARNING');
  const resGot = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  check(resGot.severity === 'INFO', 'D-17 RUN_RESULT_RECEIVED=INFO');
// ?? D-18 pending PM queue filtering ??????????????????????????????????????
  console.log('D-18) pending PM queue filtering');
  const pendQA = await evk.recordQaFailed(TEST_ROOT, project, { ...base, taskId: task.taskId, runId });
  await evk.markDelivered(TEST_ROOT, project, pendQA.eventId, 'PENDING'); // delivered excluded
  const pendEligible = await evk.recordGoalCompletionEligible(TEST_ROOT, project, { ...base });
  const nonPm = await evk.recordRuntimeWarning(TEST_ROOT, project, { ...base });
  const pendingIds = evk.listPendingPmEvents(TEST_ROOT, project).map((r) => r.eventId);
  check(pendingIds.includes(odr.eventId), 'D-18 own-decision included');
  check(pendingIds.includes(eligible.eventId), 'D-18 eligible (PENDING) included');
  check(pendingIds.includes(pendEligible.eventId), 'D-18 pendEligible included');
  check(!pendingIds.includes(pendQA.eventId), 'D-18 delivered excluded');
  check(!pendingIds.includes(nonPm.eventId), 'D-18 non-PM excluded');

  // ?? D-19 pending PM ordering ?????????????????????????????????????????????
  console.log('D-19) pending PM ordering (severity, then occurredAt, then id)');
  // Contract: severity → occurredAt ascending → eventId
  // o1b ERROR at 00:00, o1 ERROR at 00:01 → o1b before o1
  const tEarlier = '2026-01-01T00:00:00.000Z';
  const tLater = '2026-01-01T00:01:00.000Z';
  const tWarn = '2026-01-01T00:02:00.000Z';
  const o1 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, occurredAt: tLater });
  const o1b = await evk.recordRunFailed(TEST_ROOT, project, { ...base, occurredAt: tEarlier }); // same severity, earlier occurredAt
  const o3 = await evk.recordOwnerDecisionRequired(TEST_ROOT, project, { ...base, occurredAt: tWarn });
  const ordered = evk.listPendingPmEvents(TEST_ROOT, project).map((r) => r.eventId);
  const orderPos = (id) => ordered.indexOf(id);
  check(orderPos(o1b.eventId) < orderPos(o1.eventId), 'D-19 same severity earlier occurredAt first');
  check(orderPos(o1.eventId) < orderPos(o3.eventId), 'D-19 ERROR before WARNING');
  // Same severity + same occurredAt → lower eventId first
  const tSame = '2026-01-01T00:03:00.000Z';
  const oSameA = await evk.recordQaFailed(TEST_ROOT, project, { ...base, occurredAt: tSame, summary: 'same-a' });
  const oSameB = await evk.recordRunFailed(TEST_ROOT, project, { ...base, occurredAt: tSame, summary: 'same-b' });
  const ordered2 = evk.listPendingPmEvents(TEST_ROOT, project).map((r) => r.eventId);
  const posSame = (id) => ordered2.indexOf(id);
  const [lowerId, higherId] = [oSameA.eventId, oSameB.eventId].sort((a, b) => a.localeCompare(b));
  check(posSame(lowerId) < posSame(higherId), 'D-19 same severity+occurredAt ordered by eventId');
  // RUN_RESULT_RECEIVED is a fact event — must NOT appear in the PM queue
  const factEvt = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  check(
    !evk.listPendingPmEvents(TEST_ROOT, project).some((r) => r.eventId === factEvt.eventId),
    'D-19 RUN_RESULT_RECEIVED (fact) excluded',
  );

  // ?? D-20 non-PM event excluded ???????????????????????????????????????????
  console.log('D-20) non-PM event excluded');
  const nm = await evk.recordTaskBecameReady(TEST_ROOT, project, { ...base });
  check(
    !evk.listPendingPmEvents(TEST_ROOT, project).some((r) => r.eventId === nm.eventId),
    'D-20 non-PM excluded from PM queue',
  );

  // ?? D-21 PENDING->DELIVERED ???????????????????????????????????????????????
  console.log('D-21) PENDING -> DELIVERED');
  const d21 = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  const d1 = await evk.markDelivered(TEST_ROOT, project, d21.eventId, 'PENDING');
  check(d1.status === 'DELIVERED', 'D-21 DELIVERED');

  // ?? D-22 DELIVERED->ACKNOWLEDGED ?????????????????????????????????????????
  console.log('D-22) DELIVERED -> ACKNOWLEDGED');
  const ack = await evk.acknowledge(TEST_ROOT, project, d21.eventId, 'DELIVERED');
  check(ack.status === 'ACKNOWLEDGED', 'D-22 ACKNOWLEDGED');

  // ?? D-23 PENDING->IGNORED ?????????????????????????????????????????????????
  console.log('D-23) PENDING -> IGNORED');
  const d23 = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  const ig = await evk.ignore(TEST_ROOT, project, d23.eventId, 'PENDING');
  check(ig.status === 'IGNORED', 'D-23 IGNORED');

  // ?? D-24 illegal delivery transition rejected ????????????????????????????
  console.log('D-24) illegal delivery transition rejected');
  const d24 = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  let illegal = false;
  try {
    await evk.acknowledge(TEST_ROOT, project, d24.eventId, 'PENDING'); // PENDING->ACKNOWLEDGED illegal
  } catch { illegal = true; }
  check(illegal, 'D-24 PENDING->ACKNOWLEDGED rejected');
  check(evk.getDelivery(TEST_ROOT, project, d24.eventId).status === 'PENDING', 'D-24 status unchanged');

  // ?? D-25 stale expected status rejected ??????????????????????????????????
  console.log('D-25) stale expected status rejected');
  let stale = false;
  try {
    await evk.markDelivered(TEST_ROOT, project, d24.eventId, 'DELIVERED'); // actual is PENDING
  } catch { stale = true; }
  check(stale, 'D-25 stale expected rejected');

  // ?? D-26 idempotent replay safe ??????????????????????????????????????????
  console.log('D-26) idempotent replay safe');
  const d26 = await evk.recordRunResultReceived(TEST_ROOT, project, { ...base });
  await evk.markDelivered(TEST_ROOT, project, d26.eventId, 'PENDING');
  let replayOk = true;
  try {
    const again = await evk.markDelivered(TEST_ROOT, project, d26.eventId, 'DELIVERED');
    check(again.status === 'DELIVERED', 'D-26 replay no-op returns DELIVERED');
  } catch { replayOk = false; }
  check(replayOk, 'D-26 repeated markDelivered does not throw');
  // Stale expected on replay must NOT silently succeed just because target==current
  let staleReplay = false;
  try {
    await evk.markDelivered(TEST_ROOT, project, d26.eventId, 'PENDING'); // current is DELIVERED
  } catch { staleReplay = true; }
  check(staleReplay, 'D-26 stale expected on replay rejected (strict CAS)');

  // ?? D-27 restart reconstructs pending queue from disk ????????????????????
  console.log('D-27) restart reconstructs pending PM queue from disk');
  const rq = await evk.recordQaFailed(TEST_ROOT, project, { ...base });
  const pendingAfterRestart = evk.listPendingPmEvents(TEST_ROOT, project);
  check(pendingAfterRestart.some((r) => r.eventId === rq.eventId), 'D-27 pending event found after fresh disk read');
  await evk.markDelivered(TEST_ROOT, project, rq.eventId, 'PENDING');
  await evk.acknowledge(TEST_ROOT, project, rq.eventId, 'DELIVERED');
  check(!evk.listPendingPmEvents(TEST_ROOT, project).some((r) => r.eventId === rq.eventId), 'D-27 acknowledged no longer pending');
// ?? D-28/29/30 malformed neighbor isolation ??????????????????????????????
  console.log('D-28/29/30) malformed neighbor isolation');
  const eventsRoot = evk.eventsDir(TEST_ROOT, project);
  fs.mkdirSync(path.join(eventsRoot, 'EVENT-999999'), { recursive: true });
  fs.writeFileSync(path.join(eventsRoot, 'EVENT-999999', 'event.json'), '{not json', 'utf8');
  check(fs.existsSync(path.join(eventsRoot, 'EVENT-999999', 'event.json')), 'D-28 malformed neighbor created');
  const validList = evk.listEvents(TEST_ROOT, project);
  check(validList.events.length > 0, 'D-28 valid listing survives malformed neighbor');
  check(validList.warnings.some((w) => w.includes('EVENT-999999')), 'D-28 warning recorded for malformed');
  let directBad = false;
  try {
    evk.getEvent(TEST_ROOT, project, 'EVENT-999999');
  } catch { directBad = true; }
  check(directBad, 'D-29 direct get malformed fails clearly');
  const pendOk = evk.listPendingPmEvents(TEST_ROOT, project);
  check(pendOk.length > 0 && pendOk.every(valid), 'D-30 valid pending survive malformed neighbor');

  function valid(e) { return typeof e.eventId === 'string' && e.eventId.startsWith('EVENT-'); }

  // ?? D-31/D-32/D-33 Event creation does not mutate canonical state ????????
  console.log('D-31/32/33) Event creation does not mutate canonical state');
  const taskBefore = gt.getTask(TEST_ROOT, project, task.taskId);
  const goalBefore = gt.getGoal(TEST_ROOT, project, goal.goalId);
  const claimBefore = ev.getEvidence(TEST_ROOT, project, claim.evidenceId);
  await evk.recordRunResultReceived(TEST_ROOT, project, { ...base, taskId: task.taskId, runId, goalId: goal.goalId, evidenceId: claim.evidenceId });
  await evk.recordGoalCompleted(TEST_ROOT, project, { ...base, goalId: goal.goalId });
  const taskAfter = gt.getTask(TEST_ROOT, project, task.taskId);
  const goalAfter = gt.getGoal(TEST_ROOT, project, goal.goalId);
  const claimAfter = ev.getEvidence(TEST_ROOT, project, claim.evidenceId);
  check(JSON.stringify(taskBefore) === JSON.stringify(taskAfter), 'D-31 Task unchanged');
  check(JSON.stringify(goalBefore) === JSON.stringify(goalAfter), 'D-32 Goal unchanged');
  check(JSON.stringify(claimBefore) === JSON.stringify(claimAfter), 'D-33 Evidence unchanged');

  // ?? D-34/35/36 phase regressions (B2/C/A kernels still operate) ??????????
  console.log('D-34/35/36) phase regressions (B2/C/A sanity)');
  const g2 = await gt.createGoal(TEST_ROOT, project, { title: 'After', goalStatement: 'g', completionCriteria: ['c'] });
  check(gt.getGoal(TEST_ROOT, project, g2.goalId).goalId === g2.goalId, 'D-34 Goal kernel usable after events');
  const claim2 = await ev.recordWorkerClaim(TEST_ROOT, project, { summary: 'regression', taskId: task.taskId, runId });
  check(ev.getEvidence(TEST_ROOT, project, claim2.evidenceId).evidenceId === claim2.evidenceId, 'D-35 Evidence kernel usable after events');
  const t2 = await gt.createTask(TEST_ROOT, project, { goalId: g2.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  check(gt.getTask(TEST_ROOT, project, t2.taskId).taskId === t2.taskId, 'D-36 Task creation unaffected');
  const beforeEventCount = evk.listEvents(TEST_ROOT, project).events.length;
  await evk.recordRuntimeError(TEST_ROOT, project, { ...base });
  check(evk.listEvents(TEST_ROOT, project).events.length === beforeEventCount + 1, 'D-36 event counter preserved after goal/task allocs');

  // ?? CAS-01..07 delivery per-event lock / race safety ?????????????????????
  console.log('CAS-01..07) delivery CAS race safety');

  function readDeliveryRaw(eventId) {
    const p = path.join(evk.eventFolder(TEST_ROOT, project, eventId), 'delivery.json');
    const text = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    return { text, parsed };
  }

  // CAS-01: conflicting PENDING transitions — exactly one succeeds
  const cas1 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-01' });
  const cas1results = await Promise.allSettled([
    evk.markDelivered(TEST_ROOT, project, cas1.eventId, 'PENDING'),
    evk.ignore(TEST_ROOT, project, cas1.eventId, 'PENDING'),
  ]);
  const cas1ok = cas1results.filter((r) => r.status === 'fulfilled');
  const cas1fail = cas1results.filter((r) => r.status === 'rejected');
  check(cas1ok.length === 1 && cas1fail.length === 1, `CAS-01 exactly one winner (ok=${cas1ok.length} fail=${cas1fail.length})`);
  const cas1staleMsg = cas1fail[0].status === 'rejected' ? String(cas1fail[0].reason?.message ?? cas1fail[0].reason) : '';
  check(cas1staleMsg.includes('대기 상태 불일치'), 'CAS-01 loser is stale expected-status conflict');

  // CAS-02: final delivery state is exactly the winner; JSON valid
  const cas1final = evk.getDelivery(TEST_ROOT, project, cas1.eventId);
  const winnerStatus = cas1ok[0].status === 'fulfilled' ? cas1ok[0].value.status : null;
  check(
    (winnerStatus === 'DELIVERED' || winnerStatus === 'IGNORED') && cas1final.status === winnerStatus,
    `CAS-02 final status matches winner (${cas1final.status})`,
  );
  const { parsed: cas1disk } = readDeliveryRaw(cas1.eventId);
  check(
    cas1disk.eventId === cas1.eventId && cas1disk.status === winnerStatus && typeof cas1disk.updatedAt === 'string',
    'CAS-02 delivery.json valid single winner state',
  );
  check(
    !evk.listPendingPmEvents(TEST_ROOT, project).some((r) => r.eventId === cas1.eventId),
    'CAS-02 pending PM queue reflects final non-PENDING state',
  );

  // CAS-03: concurrent duplicate markDelivered(expected=PENDING) — one transition, one stale
  const cas3 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-03' });
  const cas3results = await Promise.allSettled([
    evk.markDelivered(TEST_ROOT, project, cas3.eventId, 'PENDING'),
    evk.markDelivered(TEST_ROOT, project, cas3.eventId, 'PENDING'),
  ]);
  const cas3ok = cas3results.filter((r) => r.status === 'fulfilled');
  const cas3fail = cas3results.filter((r) => r.status === 'rejected');
  check(cas3ok.length === 1 && cas3fail.length === 1, `CAS-03 duplicate markDelivered one transition (ok=${cas3ok.length})`);
  check(evk.getDelivery(TEST_ROOT, project, cas3.eventId).status === 'DELIVERED', 'CAS-03 final DELIVERED');
  check(String(cas3fail[0].reason?.message ?? '').includes('대기 상태 불일치'), 'CAS-03 loser stale-CAS policy');

  // CAS-04: from DELIVERED, acknowledge vs ignore — exactly one succeeds
  const cas4 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-04' });
  await evk.markDelivered(TEST_ROOT, project, cas4.eventId, 'PENDING');
  const cas4results = await Promise.allSettled([
    evk.acknowledge(TEST_ROOT, project, cas4.eventId, 'DELIVERED'),
    evk.ignore(TEST_ROOT, project, cas4.eventId, 'DELIVERED'),
  ]);
  const cas4ok = cas4results.filter((r) => r.status === 'fulfilled');
  const cas4fail = cas4results.filter((r) => r.status === 'rejected');
  check(cas4ok.length === 1 && cas4fail.length === 1, `CAS-04 ack vs ignore one winner (ok=${cas4ok.length})`);
  const cas4final = evk.getDelivery(TEST_ROOT, project, cas4.eventId);
  check(
    cas4final.status === 'ACKNOWLEDGED' || cas4final.status === 'IGNORED',
    `CAS-04 terminal winner status=${cas4final.status}`,
  );

  // CAS-05: stale expected never writes
  const cas5 = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-05' });
  const beforeCas5 = readDeliveryRaw(cas5.eventId);
  let cas5rejected = false;
  try {
    await evk.ignore(TEST_ROOT, project, cas5.eventId, 'DELIVERED'); // actual PENDING
  } catch { cas5rejected = true; }
  const afterCas5 = readDeliveryRaw(cas5.eventId);
  check(cas5rejected, 'CAS-05 stale expected rejected');
  check(beforeCas5.text === afterCas5.text, 'CAS-05 stale expected never writes');
  check(evk.getDelivery(TEST_ROOT, project, cas5.eventId).status === 'PENDING', 'CAS-05 remains PENDING');

  // CAS-06: ACKNOWLEDGED and IGNORED remain terminal under concurrency
  const cas6a = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-06a' });
  await evk.markDelivered(TEST_ROOT, project, cas6a.eventId, 'PENDING');
  await evk.acknowledge(TEST_ROOT, project, cas6a.eventId, 'DELIVERED');
  const cas6aResults = await Promise.allSettled([
    evk.markDelivered(TEST_ROOT, project, cas6a.eventId, 'ACKNOWLEDGED'),
    evk.ignore(TEST_ROOT, project, cas6a.eventId, 'ACKNOWLEDGED'),
    evk.acknowledge(TEST_ROOT, project, cas6a.eventId, 'DELIVERED'),
  ]);
  check(cas6aResults.every((r) => r.status === 'rejected'), 'CAS-06 ACKNOWLEDGED rejects concurrent exits');
  check(evk.getDelivery(TEST_ROOT, project, cas6a.eventId).status === 'ACKNOWLEDGED', 'CAS-06 ACKNOWLEDGED unchanged');

  const cas6b = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-06b' });
  await evk.ignore(TEST_ROOT, project, cas6b.eventId, 'PENDING');
  const cas6bResults = await Promise.allSettled([
    evk.markDelivered(TEST_ROOT, project, cas6b.eventId, 'IGNORED'),
    evk.acknowledge(TEST_ROOT, project, cas6b.eventId, 'IGNORED'),
    evk.ignore(TEST_ROOT, project, cas6b.eventId, 'PENDING'),
  ]);
  check(cas6bResults.every((r) => r.status === 'rejected'), 'CAS-06 IGNORED rejects concurrent exits');
  check(evk.getDelivery(TEST_ROOT, project, cas6b.eventId).status === 'IGNORED', 'CAS-06 IGNORED unchanged');
  // Idempotent terminal replay with matching expected still succeeds
  const cas6replay = await evk.ignore(TEST_ROOT, project, cas6b.eventId, 'IGNORED');
  check(cas6replay.status === 'IGNORED', 'CAS-06 terminal idempotent replay with expected=IGNORED');

  // CAS-07: different events mutate independently (no global delivery lock)
  const cas7a = await evk.recordQaFailed(TEST_ROOT, project, { ...base, summary: 'cas-07a' });
  const cas7b = await evk.recordRunFailed(TEST_ROOT, project, { ...base, summary: 'cas-07b' });
  let overlap = false;
  let inA = false;
  let inB = false;
  await Promise.all([
    evk.withDeliveryLock(project, cas7a.eventId, async () => {
      inA = true;
      await new Promise((r) => setTimeout(r, 30));
      if (inB) overlap = true;
      inA = false;
    }),
    evk.withDeliveryLock(project, cas7b.eventId, async () => {
      inB = true;
      await new Promise((r) => setTimeout(r, 30));
      if (inA) overlap = true;
      inB = false;
    }),
  ]);
  check(overlap, 'CAS-07 different events may hold locks concurrently');
  const cas7results = await Promise.allSettled([
    evk.markDelivered(TEST_ROOT, project, cas7a.eventId, 'PENDING'),
    evk.ignore(TEST_ROOT, project, cas7b.eventId, 'PENDING'),
  ]);
  check(cas7results.every((r) => r.status === 'fulfilled'), 'CAS-07 independent events both succeed');
  check(evk.getDelivery(TEST_ROOT, project, cas7a.eventId).status === 'DELIVERED', 'CAS-07a DELIVERED');
  check(evk.getDelivery(TEST_ROOT, project, cas7b.eventId).status === 'IGNORED', 'CAS-07b IGNORED');

  // Restart / disk reconstruction after races
  console.log('CAS-restart) disk reconstruction after races');
  for (const id of [cas1.eventId, cas3.eventId, cas4.eventId, cas5.eventId, cas6a.eventId, cas6b.eventId, cas7a.eventId, cas7b.eventId]) {
    const { parsed } = readDeliveryRaw(id);
    check(parsed.eventId === id && typeof parsed.status === 'string', `CAS-restart valid delivery.json ${id}`);
    check(evk.getDelivery(TEST_ROOT, project, id).status === parsed.status, `CAS-restart getDelivery matches disk ${id}`);
  }
  const pendingRestart = evk.listPendingPmEvents(TEST_ROOT, project);
  check(pendingRestart.every((e) => evk.getDelivery(TEST_ROOT, project, e.eventId).status === 'PENDING'), 'CAS-restart pending queue matches PENDING deliveries');
  check(pendingRestart.some((e) => e.eventId === cas5.eventId), 'CAS-restart cas5 still pending');
  check(!pendingRestart.some((e) => e.eventId === cas1.eventId), 'CAS-restart cas1 winner no longer pending');

  console.log('\nDONE');
}

main().catch((err) => { console.error(err); process.exit(1); });
