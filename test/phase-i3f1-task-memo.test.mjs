/**
 * Phase I3F-1 Memo Backend — F1-01..F1-15 + Counter Interoperability
 * Permanent regression for append-only Task Memo.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (c, m) => c ? PASS(m) : FAIL(m);

const distM = (p) => path.resolve('dist/server/backend/' + p);
if (!fs.existsSync(distM('task-memo.js'))) {
  console.log(' SKIP task-memo not built');
  process.exit(0);
}

const goalTask = await import('../dist/server/backend/goal-task.js');
const taskMemo = await import('../dist/server/backend/task-memo.js');
const evidence = await import('../dist/server/backend/evidence.js');
const eventK = await import('../dist/server/backend/event.js');
const rt = await import('../dist/server/backend/goal-task-runtime.js');
const fslib = await import('../dist/server/backend/fs.js');

function tmpProject() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-i3f1-memo-'));
  const project = 'P1';
  return { tmp, dataRoot: tmp, project };
}
function readCounters(dataRoot, project) {
  try { return JSON.parse(fs.readFileSync(goalTask.countersPath(dataRoot, project), 'utf8')); } catch { return {}; }
}
function cleanup(tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }

// Shared tmp for first batch
let g = tmpProject();
let dataRoot = g.dataRoot;
let project = g.project;

let goal = await goalTask.createGoal(dataRoot, project, { title: 'G', goalStatement: 'S' });
let task = await goalTask.createTask(dataRoot, project, { goalId: goal.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });

console.log('\n── F1-01 first Memo creates NOTE-000001 ──');
{
  const m1 = await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'hello first' });
  check(m1.noteId === 'NOTE-000001', 'F1-01 noteId NOTE-000001');
  check(m1.body === 'hello first', 'F1-01 body preserved');
  check(m1.schemaVersion === 1, 'F1-01 schemaVersion 1');
  check(m1.authorSurface === 'OWNER_IPC', 'F1-01 authorSurface OWNER_IPC');
  check(m1.project === project && m1.taskId === task.taskId && m1.goalId === goal.goalId, 'F1-01 linkage');
}

console.log('\n── F1-02 second Memo creates NOTE-000002 ──');
{
  const m2 = await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'second memo' });
  check(m2.noteId === 'NOTE-000002', 'F1-02 NOTE-000002');
}

console.log('\n── F1-03 legacy counters.json with no nextNoteNumber remains compatible ──');
{
  const g2 = tmpProject();
  const pr = g2.project;
  const dr = g2.dataRoot;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G2', goalStatement: 'S2' });
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T2', goal: 'g', reason: 'r', scope: 's' });
  // Manually strip nextNoteNumber
  const cp = goalTask.countersPath(dr, pr);
  const raw = JSON.parse(fs.readFileSync(cp, 'utf8'));
  delete raw.nextNoteNumber;
  fs.writeFileSync(cp, JSON.stringify(raw, null, 2), 'utf8');
  // Should still create NOTE-000001
  const m = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'legacy compat' });
  check(m.noteId === 'NOTE-000001', 'F1-03 legacy creates NOTE-000001');
  const after = readCounters(dr, pr);
  check(typeof after.nextNoteNumber === 'number' && after.nextNoteNumber === 2, 'F1-03 nextNoteNumber defaulted to 2');
  // Also ensure Goal/Task still allocatable after legacy memo
  const gg2 = await goalTask.createGoal(dr, pr, { title: 'G3', goalStatement: 'S3' });
  check(gg2.goalId === 'GOAL-0002', 'F1-03 goal still allocatable');
  cleanup(g2.tmp);
}

console.log('\n── F1-04 canonical path <dataRoot>/<project>/_relay/tasks/<taskId>/notes/<noteId>.json ──');
{
  const p = taskMemo.noteJsonPath(dataRoot, project, task.taskId, 'NOTE-000001');
  check(p.includes('_relay') && p.includes(task.taskId) && p.includes('notes') && p.endsWith('NOTE-000001.json'), 'F1-04 path shape');
  check(fs.existsSync(p), 'F1-04 file exists');
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  check(parsed.noteId === 'NOTE-000001', 'F1-04 json noteId');
}

console.log('\n── F1-05 Markdown mirror path correct when mirror succeeds ──');
{
  const mdp = taskMemo.noteMdPath(dataRoot, project, task.taskId, 'NOTE-000001');
  check(mdp.endsWith('NOTE-000001.md'), 'F1-05 md path shape');
  check(fs.existsSync(mdp), 'F1-05 md exists');
  const md = fs.readFileSync(mdp, 'utf8');
  check(md.includes('NOTE-000001') && md.includes('hello first'), 'F1-05 md content');
}

console.log('\n── F1-06 canonical JSON uses atomic write semantics ──');
{
  // Observable: file is valid JSON, no partial/corrupt state, no .tmp left
  const dir = path.dirname(taskMemo.noteJsonPath(dataRoot, project, task.taskId, 'NOTE-000001'));
  const tmps = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  check(tmps.length === 0, 'F1-06 no tmp leftover');
  // Check source uses writeJsonAtomic
  const src = fs.readFileSync('src/backend/task-memo.ts', 'utf8');
  check(src.includes('writeJsonAtomic'), 'F1-06 source uses writeJsonAtomic');
  // Also verify atomic helper itself: create a new memo and ensure file parses immediately
  const m = await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'atomic check' });
  const p = taskMemo.noteJsonPath(dataRoot, project, task.taskId, m.noteId);
  let ok = false;
  try { JSON.parse(fs.readFileSync(p, 'utf8')); ok = true; } catch {}
  check(ok, 'F1-06 new file valid JSON');
}

console.log('\n── F1-07 empty/whitespace Memo rejected ──');
{
  let threw = false;
  try { await taskMemo.createMemo(dataRoot, project, task.taskId, { body: '   ' }); } catch (e) { threw = true; check(String(e.message).includes('비어'), 'F1-07 error message'); }
  check(threw, 'F1-07 rejected');
  threw = false;
  try { await taskMemo.createMemo(dataRoot, project, task.taskId, { body: '' }); } catch (e) { threw = true; }
  check(threw, 'F1-07 empty rejected');
}

console.log('\n── F1-08 body >2000 chars rejected ──');
{
  let threw = false;
  try { await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'a'.repeat(2001) }); } catch (e) { threw = true; check(String(e.message).includes('2000'), 'F1-08 2000 limit'); }
  check(threw, 'F1-08 rejected');
  // Exactly 2000 should pass
  const m = await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'a'.repeat(2000) });
  check(m.body.length === 2000, 'F1-08 2000 accepted');
}

console.log('\n── F1-09 nonexistent Task rejected ──');
{
  let threw = false;
  try { await taskMemo.createMemo(dataRoot, project, 'TASK-9999', { body: 'hi' }); } catch (e) { threw = true; }
  check(threw, 'F1-09 rejected');
}

console.log('\n── F1-10 Memo does NOT mutate Task state ──');
{
  const tBefore = goalTask.getTask(dataRoot, project, task.taskId);
  const beforeExec = tBefore.executionState;
  const beforePm = tBefore.pmState;
  const beforeUpdated = tBefore.updatedAt;
  const beforeRuns = JSON.stringify(tBefore.linkedRuns);
  const beforeAccepted = tBefore.acceptedRunId;
  await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'no mutate' });
  const tAfter = goalTask.getTask(dataRoot, project, task.taskId);
  check(tAfter.executionState === beforeExec, 'F1-10 executionState unchanged');
  check(tAfter.pmState === beforePm, 'F1-10 pmState unchanged');
  check(tAfter.updatedAt === beforeUpdated, 'F1-10 updatedAt unchanged');
  check(JSON.stringify(tAfter.linkedRuns) === beforeRuns, 'F1-10 linkedRuns unchanged');
  check(tAfter.acceptedRunId === beforeAccepted, 'F1-10 acceptedRunId unchanged');
}

console.log('\n── F1-11 Memo does NOT create Evidence ──');
{
  const before = evidence.listEvidenceForTask(dataRoot, project, task.taskId, true).length;
  await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'no evidence' });
  const after = evidence.listEvidenceForTask(dataRoot, project, task.taskId, true).length;
  check(after === before, `F1-11 evidence unchanged ${before}==${after}`);
}

console.log('\n── F1-12 Memo does NOT create Event ──');
{
  const before = eventK.listEvents(dataRoot, project).events.length;
  await taskMemo.createMemo(dataRoot, project, task.taskId, { body: 'no event' });
  const after = eventK.listEvents(dataRoot, project).events.length;
  check(after === before, `F1-12 event unchanged ${before}==${after}`);
}

console.log('\n── F1-13 concurrent Promise.all yields unique monotonic IDs ──');
{
  const g3 = tmpProject();
  const dr = g3.dataRoot; const pr = g3.project;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G', goalStatement: 'S' });
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  taskMemo._resetMemoLockForTests();
  const [a, b, c] = await Promise.all([
    taskMemo.createMemo(dr, pr, tt.taskId, { body: 'concurrent A' }),
    taskMemo.createMemo(dr, pr, tt.taskId, { body: 'concurrent B' }),
    taskMemo.createMemo(dr, pr, tt.taskId, { body: 'concurrent C' }),
  ]);
  const ids = [a.noteId, b.noteId, c.noteId].sort();
  check(new Set(ids).size === 3, 'F1-13 unique ids');
  check(ids[0] === 'NOTE-000001' && ids[1] === 'NOTE-000002' && ids[2] === 'NOTE-000003', `F1-13 monotonic ${ids.join(',')}`);
  // No overwrite: each file exists with correct body
  for (const rec of [a, b, c]) {
    const p = taskMemo.noteJsonPath(dr, pr, tt.taskId, rec.noteId);
    check(fs.existsSync(p), `F1-13 file exists ${rec.noteId}`);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    check(j.body === rec.body, `F1-13 body preserved ${rec.noteId}`);
  }
  // No tmp left
  const dir = taskMemo.notesDir(dr, pr, tt.taskId);
  const tmps = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  check(tmps.length === 0, 'F1-13 no tmp leftover');
  cleanup(g3.tmp);
}

console.log('\n── F1-14 ACCEPTED Task permits Memo ──');
{
  const g4 = tmpProject();
  const dr = g4.dataRoot; const pr = g4.project;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G', goalStatement: 'S' });
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  await rt.transitionTaskExecution(dr, pr, tt.taskId, { expectedExecutionState: 'PLANNED', to: 'READY' });
  const run = await fslib.atomicMaterializeRun(dr, pr, '2026-09-02', 'Agent');
  await goalTask.linkRunToTask(dr, pr, tt.taskId, run.folder);
  await rt.transitionTaskExecution(dr, pr, tt.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED' });
  await rt.transitionTaskExecution(dr, pr, tt.taskId, { expectedExecutionState: 'DISPATCHED', to: 'RUNNING' });
  await rt.markResultReceived(dr, pr, tt.taskId, run.runId);
  // before accept
  const m1 = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'before accept' });
  check(m1.noteId.includes('NOTE-'), 'F1-14 before accept memo');
  await rt.acceptResult(dr, pr, tt.taskId, run.runId, {
    goalId: gg.goalId, expectedExecutionState: 'RESULT_RECEIVED', expectedPmState: 'VERIFYING',
  });
  const m2 = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'after accept memo' });
  check(m2.noteId.includes('NOTE-'), 'F1-14 after accept memo');
  cleanup(g4.tmp);
}

console.log('\n── F1-15 CANCELLED Task rejects Memo ──');
{
  const g5 = tmpProject();
  const dr = g5.dataRoot; const pr = g5.project;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G', goalStatement: 'S' });
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  await rt.transitionTaskExecution(dr, pr, tt.taskId, { expectedExecutionState: 'PLANNED', to: 'CANCELLED' });
  let threw = false;
  try { await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'cancelled memo' }); } catch (e) { threw = true; check(String(e.message).includes('CANCELLED'), 'F1-15 CANCELLED message'); }
  check(threw, 'F1-15 rejected');
  cleanup(g5.tmp);
}

console.log('\n── Counter Interop: Memo -> Goal/Task/Evidence/Event preserves nextNoteNumber ──');
{
  const g6 = tmpProject();
  const dr = g6.dataRoot; const pr = g6.project;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G', goalStatement: 'S' });
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  const m1 = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'interop memo 1' });
  check(m1.noteId === 'NOTE-000001', 'interop memo1');
  let cnt = readCounters(dr, pr);
  check(cnt.nextNoteNumber === 2, 'interop after memo nextNoteNumber=2');
  // Allocate Goal/Task/Evidence/Event afterward
  const gg2 = await goalTask.createGoal(dr, pr, { title: 'G2', goalStatement: 'S2' });
  cnt = readCounters(dr, pr);
  check(cnt.nextNoteNumber === 2, 'interop after goal nextNoteNumber preserved');
  const tt2 = await goalTask.createTask(dr, pr, { goalId: gg2.goalId, title: 'T2', goal: 'g2', reason: 'r2', scope: 's2' });
  cnt = readCounters(dr, pr);
  check(cnt.nextNoteNumber === 2, 'interop after task nextNoteNumber preserved');
  // Evidence
  const run = await fslib.atomicMaterializeRun(dr, pr, '2026-09-02', 'Agent');
  await goalTask.linkRunToTask(dr, pr, tt.taskId, run.folder);
  const ev = await evidence.recordWorkerClaim(dr, pr, { summary: 'interop ev', taskId: tt.taskId, runId: run.runId });
  cnt = readCounters(dr, pr);
  check(cnt.nextNoteNumber === 2, 'interop after evidence nextNoteNumber preserved');
  check(cnt.nextEvidenceNumber !== undefined, 'interop evidence counter exists');
  // Event
  const ev2 = await eventK.recordRunResultReceived(dr, pr, { summary: 'interop event', taskId: tt.taskId, runId: run.runId, source: { kind: 'test' } });
  cnt = readCounters(dr, pr);
  check(cnt.nextNoteNumber === 2, 'interop after event nextNoteNumber preserved');
  // Next memo still monotonic
  const m2 = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'interop memo 2' });
  check(m2.noteId === 'NOTE-000002', 'interop memo2 NOTE-000002');
  cleanup(g6.tmp);
}

console.log('\n── Counter Interop Reverse: Goal/Task/Evidence/Event -> Memo preserves other counters ──');
{
  const g7 = tmpProject();
  const dr = g7.dataRoot; const pr = g7.project;
  const gg = await goalTask.createGoal(dr, pr, { title: 'G', goalStatement: 'S' });
  let cnt2 = readCounters(dr, pr);
  const beforeGoal = cnt2.nextGoalNumber;
  const tt = await goalTask.createTask(dr, pr, { goalId: gg.goalId, title: 'T', goal: 'g', reason: 'r', scope: 's' });
  cnt2 = readCounters(dr, pr);
  const beforeTask = cnt2.nextTaskNumber;
  const run = await fslib.atomicMaterializeRun(dr, pr, '2026-09-02', 'Agent');
  await goalTask.linkRunToTask(dr, pr, tt.taskId, run.folder);
  const ev = await evidence.recordWorkerClaim(dr, pr, { summary: 'rev ev', taskId: tt.taskId, runId: run.runId });
  cnt2 = readCounters(dr, pr);
  const beforeEv = cnt2.nextEvidenceNumber;
  const evnt = await eventK.recordRunResultReceived(dr, pr, { summary: 'rev event', taskId: tt.taskId, runId: run.runId, source: { kind: 'test' } });
  cnt2 = readCounters(dr, pr);
  const beforeEvent = cnt2.nextEventNumber;
  // Now create memo
  const m = await taskMemo.createMemo(dr, pr, tt.taskId, { body: 'reverse memo' });
  check(m.noteId === 'NOTE-000001', 'reverse memo NOTE-000001');
  cnt2 = readCounters(dr, pr);
  check(cnt2.nextGoalNumber === beforeGoal, 'reverse goal counter preserved');
  check(cnt2.nextTaskNumber === beforeTask, 'reverse task counter preserved');
  check(cnt2.nextEvidenceNumber === beforeEv, 'reverse evidence counter preserved');
  check(cnt2.nextEventNumber === beforeEvent, 'reverse event counter preserved');
  cleanup(g7.tmp);
}

cleanup(g.tmp);

console.log(`\nphase-i3f1-task-memo: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
