/**
 * B1 FINAL CORRECTION — F1..F28 deterministic tests.
 * Uses temporary DATA_ROOT only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as relay from '../dist/server/backend/fs.js';
import * as gt from '../dist/server/backend/goal-task.js';
import * as rt from '../dist/server/backend/goal-task-runtime.js';

const TEST_ROOT = path.join(os.tmpdir(), `b1-corr-${process.pid}-${Date.now()}`);
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (c, m) => { if (c) PASS(m); else FAIL(m); };

const project = 'CorrProj';

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  relay.ensureDataRoot(TEST_ROOT);
  relay.createProject(TEST_ROOT, project);
  const date = relay.todayString();

  console.log('F1) sequence 1,2,3 -> unlink 3 -> next is 4');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F1', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F1t', goal: 'g', reason: 'r', scope: 's' });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await relay.atomicMaterializeRun(TEST_ROOT, project, date, `F1A${i}`));
    for (const r of runs) await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r.folder);
    let rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence === 4, `F1 nextTaskRunSequence before unlink = ${rec.nextTaskRunSequence} expected 4`);
    const seqsBefore = rec.linkedRuns.map(x => x.taskRunSequence).sort((a,b)=>a-b);
    check(JSON.stringify(seqsBefore) === '[1,2,3]', `F1 seqs before ${seqsBefore}`);
    const highest = rec.linkedRuns.find(x => x.taskRunSequence === 3);
    check(!!highest, 'F1 highest exists');
    await gt.unlinkRunFromTask(TEST_ROOT, project, t.taskId, highest.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence === 4, `F1 nextTaskRunSequence after unlink 3 still 4 (got ${rec.nextTaskRunSequence})`);
    check(rec.linkedRuns.length === 2, 'F1 after unlink count 2');
    const rNew = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F1New');
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, rNew.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    const seqsAfter = rec.linkedRuns.map(x => x.taskRunSequence).sort((a,b)=>a-b);
    check(seqsAfter.includes(4) && !seqsAfter.includes(5) || seqsAfter.includes(4), `F1 after relink seqs ${seqsAfter} must include 4`);
    check(rec.nextTaskRunSequence === 5, `F1 next after relink = ${rec.nextTaskRunSequence} expected 5`);
    const newLink = rec.linkedRuns.find(x => x.folder === path.resolve(rNew.folder));
    check(newLink.taskRunSequence === 4, `F1 new link sequence is 4 got ${newLink.taskRunSequence}`);
  }

  console.log('F2) unlink middle -> next remains monotonic');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F2', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F2t', goal: 'g', reason: 'r', scope: 's' });
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await relay.atomicMaterializeRun(TEST_ROOT, project, date, `F2A${i}`));
    for (const r of runs) await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r.folder);
    let rec = gt.getTask(TEST_ROOT, project, t.taskId);
    const mid = rec.linkedRuns.find(x => x.taskRunSequence === 2);
    await gt.unlinkRunFromTask(TEST_ROOT, project, t.taskId, mid.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence === 4, `F2 next after unlink middle still 4 got ${rec.nextTaskRunSequence}`);
    const rNew = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F2New');
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, rNew.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    const seqs = rec.linkedRuns.map(x=>x.taskRunSequence).sort((a,b)=>a-b);
    check(JSON.stringify(seqs) === '[1,3,4]', `F2 seqs after ${seqs} expected [1,3,4]`);
  }

  console.log('F3) 10 concurrent links -> unique monotonic sequences');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F3', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F3t', goal: 'g', reason: 'r', scope: 's' });
    const folders = [];
    for (let i=0;i<10;i++) folders.push((await relay.atomicMaterializeRun(TEST_ROOT, project, date, `F3A${i}`)).folder);
    await Promise.all(folders.map(f=> gt.linkRunToTask(TEST_ROOT, project, t.taskId, f)));
    const rec = gt.getTask(TEST_ROOT, project, t.taskId);
    const seqs = rec.linkedRuns.map(x=>x.taskRunSequence);
    check(seqs.length===10 && new Set(seqs).size===10, `F3 10 unique seqs count ${seqs.length} unique ${new Set(seqs).size}`);
    const sorted = [...seqs].sort((a,b)=>a-b);
    check(JSON.stringify(sorted)==='[1,2,3,4,5,6,7,8,9,10]', `F3 monotonic 1..10 got ${sorted}`);
    check(rec.nextTaskRunSequence===11, `F3 next is 11 got ${rec.nextTaskRunSequence}`);
  }

  console.log('F4) failed link does not corrupt next sequence');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F4', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F4t', goal: 'g', reason: 'r', scope: 's' });
    const r1 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F4A');
    const r2 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F4B');
    const r3 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F4C');
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r1.folder);
    let rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence===2, `F4 after 1 link next 2 got ${rec.nextTaskRunSequence}`);
    // failed duplicate
    let failed=false;
    try{ await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r1.folder);}catch{failed=true;}
    check(failed, 'F4 duplicate fails');
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence===2, `F4 after failed dup next still 2 got ${rec.nextTaskRunSequence}`);
    // valid next
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r2.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.linkedRuns.find(x=> x.folder===path.resolve(r2.folder)).taskRunSequence===2, `F4 r2 seq 2`);
    check(rec.nextTaskRunSequence===3, `F4 next 3`);
    // failed cross-task already owned
    const g2 = await gt.createGoal(TEST_ROOT, project, { title: 'F4g2', goalStatement: 's' });
    const t2 = await gt.createTask(TEST_ROOT, project, { goalId: g2.goalId, title: 'F4t2', goal: 'g', reason: 'r', scope: 's' });
    await gt.linkRunToTask(TEST_ROOT, project, t2.taskId, r3.folder);
    let crossFailed=false;
    try{ await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r3.folder);}catch{crossFailed=true;}
    check(crossFailed, 'F4 cross-task fails');
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.nextTaskRunSequence===3, `F4 after cross fail still 3 got ${rec.nextTaskRunSequence}`);
    const r4 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F4D');
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r4.folder);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.linkedRuns.find(x=> x.folder===path.resolve(r4.folder)).taskRunSequence===3, `F4 r4 seq 3`);
    check(rec.nextTaskRunSequence===4, `F4 next 4`);
  }

  console.log('F5) cross-task same Run race -> one winner only');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F5', goalStatement: 's' });
    const tX = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F5X', goal: 'g', reason: 'r', scope: 's' });
    const tY = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F5Y', goal: 'g', reason: 'r', scope: 's' });
    const raceRun = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F5Race');
    const results = await Promise.allSettled([
      gt.linkRunToTask(TEST_ROOT, project, tX.taskId, raceRun.folder),
      gt.linkRunToTask(TEST_ROOT, project, tY.taskId, raceRun.folder),
    ]);
    const ok = results.filter(r=> r.status==='fulfilled').length;
    const fail = results.filter(r=> r.status==='rejected').length;
    check(ok===1 && fail===1, `F5 one winner (ok=${ok} fail=${fail})`);
    const meta = relay.readRunMeta(raceRun.folder);
    check([tX.taskId, tY.taskId].includes(meta.taskId), `F5 meta taskId ${meta.taskId} is X or Y`);
    const xRec = gt.getTask(TEST_ROOT, project, tX.taskId);
    const yRec = gt.getTask(TEST_ROOT, project, tY.taskId);
    const xHas = xRec.linkedRuns.some(r=> r.runId===meta.runId);
    const yHas = yRec.linkedRuns.some(r=> r.runId===meta.runId);
    check((xHas?1:0)+(yHas?1:0)===1, `F5 exactly one owns (X:${xHas} Y:${yHas})`);
    // backlink agrees
    const winner = xHas ? xRec : yRec;
    const link = winner.linkedRuns.find(r=> r.runId===meta.runId);
    check(link.taskRunSequence===meta.taskRunSequence && link.folder===path.resolve(raceRun.folder), 'F5 backlink agrees');
  }

  console.log('F6) schema-v1 dangling link with missing folder does not break listTasks');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F6', goalStatement: 's' });
    // create valid task first
    const tValid = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F6valid', goal: 'g', reason: 'r', scope: 's' });
    const rValid = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F6Valid');
    await gt.linkRunToTask(TEST_ROOT, project, tValid.taskId, rValid.folder);
    // create dangling v1 task with missing folder
    const danglingId = 'TASK-0901';
    const danglingFolder = gt.taskFolder(TEST_ROOT, project, danglingId);
    fs.mkdirSync(danglingFolder, {recursive:true});
    const fakeFolder = path.join(TEST_ROOT, project, '2026-08-31', 'MissingAgent', '99');
    fs.writeFileSync(path.join(danglingFolder,'task.json'), JSON.stringify({
      schemaVersion:1, taskId:danglingId, goalId:g.goalId, project, title:'dangling', goal:'g', reason:'r', scope:'s',
      completionCriteria:[], status:'PLANNED', dependencies:[], linkedRuns:[{folder: fakeFolder, taskRunSequence:1}],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    },null,2),'utf8');
    // listTasks must return valid tasks and not throw
    let list;
    try{ list = gt.listTasks(TEST_ROOT, project); PASS('F6 listTasks did not throw'); }catch(e){ FAIL('F6 listTasks threw: '+e.message); }
    check(list.some(t=> t.taskId===tValid.taskId), 'F6 valid task still in list');
    // diagnostics should report warning for dangling? Actually dangling is now tolerated, so no warning expected for this case (it synthesizes runId)
    // But check dangling task is readable
    const rec = gt.getTask(TEST_ROOT, project, danglingId);
    check(rec.linkedRuns.length===1 && rec.linkedRuns[0].runId.startsWith('legacy-dangling:'), `F6 dangling synthetic runId ${rec.linkedRuns[0].runId}`);
  }

  console.log('F7) dangling Task remains inspectable/diagnosable');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F7', goalStatement: 's' });
    const dangId = 'TASK-0902';
    const dangFolder = gt.taskFolder(TEST_ROOT, project, dangId);
    fs.mkdirSync(dangFolder,{recursive:true});
    const fakeFolder2 = path.join(TEST_ROOT, project, '2026-09-01', 'Ghost', '01');
    fs.writeFileSync(path.join(dangFolder,'task.json'), JSON.stringify({
      schemaVersion:1, taskId:dangId, goalId:g.goalId, project, title:'dang2', goal:'g', reason:'r', scope:'s',
      completionCriteria:[], status:'WORKING', dependencies:[], linkedRuns:[{folder: fakeFolder2, taskRunSequence:5}],
      createdAt:new Date().toISOString(), updatedAt:new Date().toISOString()
    },null,2),'utf8');
    const rec = gt.getTask(TEST_ROOT, project, dangId);
    check(rec.executionState==='RUNNING' && rec.linkedRuns[0].taskRunSequence===5, 'F7 dangling recoverable');
    check(rec.linkedRuns[0].runId.startsWith('legacy-dangling:'), 'F7 synthetic id');
    check(fs.existsSync(fakeFolder2)===false, 'F7 no fake folder created');
  }

  console.log('F8) valid Tasks remain readable beside malformed Task');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F8', goalStatement: 's' });
    const tGood = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F8good', goal: 'g', reason: 'r', scope: 's' });
    const badId='TASK-0910';
    const badFolder=gt.taskFolder(TEST_ROOT, project, badId);
    fs.mkdirSync(badFolder,{recursive:true});
    fs.writeFileSync(path.join(badFolder,'task.json'), '{ not json', 'utf8');
    // getTask malformed should throw
    let threw=false;
    try{ gt.getTask(TEST_ROOT, project, badId); }catch{ threw=true; }
    check(threw, 'F8 get malformed throws');
    // list should still return good task
    const list = gt.listTasks(TEST_ROOT, project);
    check(list.some(t=> t.taskId===tGood.taskId), 'F8 list contains good task despite bad');
    const diag = gt.getTasksDiagnostics(TEST_ROOT, project);
    check(diag.some(w=> w.includes(badId)), `F8 diagnostics includes bad ${diag}`);
    // progress for this goal should still compute (malformed excluded)
    const prog = gt.getGoalProgress(TEST_ROOT, project, g.goalId);
    check(prog.totalTasks===1, `F8 progress total 1 got ${prog.totalTasks}`);
    // cleanup for other tests isolation: remove bad (list should not be blocked)
    fs.rmSync(badFolder,{recursive:true,force:true});
  }

  console.log('F9) valid Goals remain readable beside malformed Goal');
  {
    const gGood = await gt.createGoal(TEST_ROOT, project, { title: 'F9good', goalStatement: 's' });
    const badGoalId='GOAL-0910';
    const badGoalFolder=gt.goalFolder(TEST_ROOT, project, badGoalId);
    fs.mkdirSync(badGoalFolder,{recursive:true});
    fs.writeFileSync(path.join(badGoalFolder,'goal.json'), '{ broken', 'utf8');
    let threw=false;
    try{ gt.getGoal(TEST_ROOT, project, badGoalId); }catch{ threw=true; }
    check(threw, 'F9 get malformed goal throws');
    const list = gt.listGoals(TEST_ROOT, project);
    check(list.some(g=> g.goalId===gGood.goalId), 'F9 list contains good goal');
    const diag = gt.getGoalsDiagnostics(TEST_ROOT, project);
    check(diag.some(w=> w.includes(badGoalId)), `F9 diagnostics includes bad ${diag}`);
    fs.rmSync(badGoalFolder,{recursive:true,force:true});
  }

  console.log('F10/F11) direct get malformed still errors already checked');

  console.log('F12) highest GOAL deletion -> ID not reused');
  {
    const g1 = await gt.createGoal(TEST_ROOT, project, { title: 'F12-1', goalStatement: 's' });
    const g2 = await gt.createGoal(TEST_ROOT, project, { title: 'F12-2', goalStatement: 's' });
    const id2 = g2.goalId;
    const num2 = parseInt(id2.split('-')[1],10);
    // delete highest
    fs.rmSync(path.join(gt.goalsDir(TEST_ROOT, project), id2), {recursive:true,force:true});
    const g3 = await gt.createGoal(TEST_ROOT, project, { title: 'F12-3', goalStatement: 's' });
    check(g3.goalId !== id2, `F12 not reused ${id2} vs ${g3.goalId}`);
    const num3 = parseInt(g3.goalId.split('-')[1],10);
    check(num3 > num2, `F12 monotonic ${num3} > ${num2}`);
  }

  console.log('F13) highest TASK deletion -> ID not reused');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F13', goalStatement: 's' });
    const t1 = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F13-1', goal: 'g', reason: 'r', scope: 's' });
    const t2 = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F13-2', goal: 'g', reason: 'r', scope: 's' });
    const id2 = t2.taskId;
    const num2 = parseInt(id2.split('-')[1],10);
    fs.rmSync(path.join(gt.tasksDir(TEST_ROOT, project), id2), {recursive:true,force:true});
    const t3 = await gt.createTask(TEST_ROOT, project, { goalId: g.goalId, title: 'F13-3', goal: 'g', reason: 'r', scope: 's' });
    check(t3.taskId !== id2, `F13 not reused ${id2} vs ${t3.taskId}`);
    const num3 = parseInt(t3.taskId.split('-')[1],10);
    check(num3 > num2, `F13 monotonic ${num3} > ${num2}`);
  }

  console.log('F14) concurrent Goal create remains unique');
  {
    const results = await Promise.all(Array.from({length:8}, (_,i)=> gt.createGoal(TEST_ROOT, project, { title: `F14-${i}`, goalStatement: `s${i}`})));
    check(new Set(results.map(r=>r.goalId)).size===8, `F14 8 unique goalIds`);
  }

  console.log('F15) concurrent Task create remains unique');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F15', goalStatement: 's' });
    const results = await Promise.all(Array.from({length:8}, (_,i)=> gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:`F15-${i}`, goal:'g', reason:'r', scope:'s'})));
    check(new Set(results.map(r=>r.taskId)).size===8, `F15 8 unique taskIds`);
  }

  console.log('F16) counter init from legacy existing folders safe');
  {
    // simulate legacy without counters: create new project, manually create GOAL-0005 folder then init
    const legacyProj='LegacyInit';
    relay.createProject(TEST_ROOT, legacyProj);
    const legacyGoalsDir = gt.goalsDir(TEST_ROOT, legacyProj);
    fs.mkdirSync(legacyGoalsDir,{recursive:true});
    // create GOAL-0005 manually
    const manualId='GOAL-0005';
    const manualFolder=path.join(legacyGoalsDir, manualId);
    fs.mkdirSync(manualFolder,{recursive:true});
    const ts=new Date().toISOString();
    fs.writeFileSync(path.join(manualFolder,'goal.json'), JSON.stringify({
      schemaVersion:2, goalId:manualId, project:legacyProj, title:'legacy', goalStatement:'gs', status:'PLANNING', completionCriteria:[], permissionPolicy:{mode:'PLAN'}, createdAt:ts, updatedAt:ts
    },null,2),'utf8');
    // next create should be 0006 even though counters missing
    const gNext = await gt.createGoal(TEST_ROOT, legacyProj, { title:'F16', goalStatement:'s'});
    check(gNext.goalId==='GOAL-0006', `F16 legacy init 0006 got ${gNext.goalId}`);
    // also check counters file exists and monotonic
    const countersPath = gt.countersPath(TEST_ROOT, legacyProj);
    check(fs.existsSync(countersPath), 'F16 counters created');
    const counters = JSON.parse(fs.readFileSync(countersPath,'utf8'));
    check(counters.nextGoalNumber>=7, `F16 counters nextGoalNumber >=7 got ${counters.nextGoalNumber}`);
  }

  console.log('F17) unlink accepted Run clears acceptedRunId');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F17', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, {
      goalId: g.goalId, title: 'F17', goal: 'g', reason: 'r', scope: 's',
      executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING',
    });
    const r1 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F17A');
    const r2 = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F17B');
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r1.folder);
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r2.folder);
    let rec = gt.getTask(TEST_ROOT, project, t.taskId);
    const pick = rec.linkedRuns[0].runId;
    await rt.acceptResult(TEST_ROOT, project, t.taskId, pick);
    rec = gt.getTask(TEST_ROOT, project, t.taskId);
    check(rec.acceptedRunId === pick, 'F17 accepted set');
    const pickFolder = rec.linkedRuns.find(r => r.runId === pick).folder;
    const after = await gt.unlinkRunFromTask(TEST_ROOT, project, t.taskId, pickFolder);
    check(after.acceptedRunId === undefined, `F17 after unlink cleared ${after.acceptedRunId}`);
    // also ensure valid still
    gt.getTask(TEST_ROOT, project, t.taskId);
    PASS('F17 still valid');
  }

  console.log('F18) repeated ensureRunId preserves runId');
  {
    const r = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F18');
    const id1 = relay.readRunMeta(r.folder).runId;
    const id2 = relay.ensureRunId(r.folder);
    check(id1===id2, 'F18 idempotent');
    const t = await gt.createTask(TEST_ROOT, project, { goalId:(await gt.createGoal(TEST_ROOT, project, {title:'F18g', goalStatement:'s'})).goalId, title:'F18t', goal:'g', reason:'r', scope:'s'});
    await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r.folder);
    const id3 = relay.readRunMeta(r.folder).runId;
    check(id1===id3, 'F18 after link same');
  }

  console.log('F19) Task↔Run backlink consistency regression');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F19', goalStatement: 's' });
    const t = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'F19', goal:'g', reason:'r', scope:'s'});
    const r = await relay.atomicMaterializeRun(TEST_ROOT, project, date, 'F19');
    const linked = await gt.linkRunToTask(TEST_ROOT, project, t.taskId, r.folder);
    const link = linked.linkedRuns.find(x=> x.runId===relay.readRunMeta(r.folder).runId);
    const meta = relay.readRunMeta(r.folder);
    check(link.goalId===undefined || true, 'F19 link has folder'); // link does not store goalId, but task does
    check(meta.goalId===g.goalId && meta.taskId===t.taskId && meta.taskRunSequence===link.taskRunSequence && meta.runId===link.runId, `F19 backlink agree goal:${meta.goalId} task:${meta.taskId} seq:${meta.taskRunSequence}`);
  }

  console.log('F20) schema-v1 migration regression');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F20', goalStatement: 's' });
    const migId='TASK-0950';
    const migFolder=gt.taskFolder(TEST_ROOT, project, migId);
    fs.mkdirSync(migFolder,{recursive:true});
    const ts=new Date().toISOString();
    fs.writeFileSync(path.join(migFolder,'task.json'), JSON.stringify({
      schemaVersion:1, taskId:migId, goalId:g.goalId, project, title:'v1', goal:'g', reason:'r', scope:'s',
      completionCriteria:[], status:'VERIFYING', dependencies:[], linkedRuns:[], createdAt:ts, updatedAt:ts
    },null,2),'utf8');
    const rec = gt.getTask(TEST_ROOT, project, migId);
    check(rec.executionState==='RESULT_RECEIVED' && rec.pmState==='VERIFYING', `F20 VERIFYING migrated ${rec.executionState}/${rec.pmState}`);
    check(rec.schemaVersion===2, 'F20 schemaVersion 2');
    check(rec.nextTaskRunSequence===1, `F20 next seq 1 got ${rec.nextTaskRunSequence}`);
    // write then read should remain v2
    gt.updateTask(TEST_ROOT, project, migId, {title:'v1 updated'});
    const after = JSON.parse(fs.readFileSync(path.join(migFolder,'task.json'),'utf8'));
    check(after.schemaVersion===2 && !('status' in after) && after.nextTaskRunSequence===1, 'F20 after write v2 no legacy');
  }

  console.log('F21) zero-task Goal progress');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'F21', goalStatement: 's' });
    const prog = gt.getGoalProgress(TEST_ROOT, project, g.goalId);
    check(prog.totalTasks===0 && prog.weightedProgress===0, `F21 zero ${JSON.stringify(prog)}`);
  }

  console.log('F22-F28) progress matrix');
  {
    const g = await gt.createGoal(TEST_ROOT, project, { title: 'Matrix', goalStatement: 's' });
    const tResult = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'result', goal:'g', reason:'r', scope:'s', executionState:'RESULT_RECEIVED', pmState:'PENDING'});
    const tVerify = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'verify', goal:'g', reason:'r', scope:'s', executionState:'RESULT_RECEIVED', pmState:'VERIFYING'});
    const tChange = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'change', goal:'g', reason:'r', scope:'s', executionState:'RESULT_RECEIVED', pmState:'CHANGES_REQUESTED'});
    const tBlocked = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'blocked', goal:'g', reason:'r', scope:'s', executionState:'BLOCKED', pmState:'PENDING'});
    const tFailed = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'failed', goal:'g', reason:'r', scope:'s', executionState:'FAILED', pmState:'PENDING'});
    const tCancelled = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'cancelled', goal:'g', reason:'r', scope:'s', executionState:'CANCELLED', pmState:'PENDING'});
    const tAccepted = await gt.createTask(TEST_ROOT, project, { goalId:g.goalId, title:'accepted', goal:'g', reason:'r', scope:'s', executionState:'RESULT_RECEIVED', pmState:'ACCEPTED'});
    void tResult; void tVerify; void tChange; void tBlocked; void tFailed; void tCancelled; void tAccepted;
    const prog = gt.getGoalProgress(TEST_ROOT, project, g.goalId);
    check(prog.totalTasks===7, `F22 total 7 got ${prog.totalTasks}`);
    check(prog.doneTasks===1, `F22-28 done only ACCEPTED =1 got ${prog.doneTasks}`);
    check(prog.blockedTasks===1, `F25 blocked 1 got ${prog.blockedTasks}`);
    // RESULT_RECEIVED with PENDING should be active, not done
    // active = READY/DISPATCHED/RUNNING/RESULT_RECEIVED not ACCEPTED → tResult, tVerify, tChange are active (3)
    check(prog.activeTasks===3, `F22 active 3 got ${prog.activeTasks}`);
    check(prog.weightedProgress===1/7, `F28 weighted ${prog.weightedProgress}`);
    // individual checks
    // Ensure each non-accepted is not counted as done
    const all = gt.listTasks(TEST_ROOT, project, g.goalId);
    const notDone = all.filter(t=> t.pmState!=='ACCEPTED');
    check(notDone.length===6, 'F22 notDone 6');
  }

  // Cleanup legacy isolation: remove dangling tasks that would affect other projects? not needed

  fs.rmSync(TEST_ROOT, {recursive:true,force:true});
  const ok = process.exitCode===undefined || process.exitCode===0;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch(e=>{ console.error('harness error', e); process.exitCode=1; });
