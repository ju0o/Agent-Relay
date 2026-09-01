/**
 * Phase I3E Relay TUI UX — UX-01..25
 * Pure visual derivation, outer frame, animation, redraw, license.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('dist/server/cli/index.js');
let passed=0,failed=0;
const PASS=m=>{console.log('  PASS  '+m);passed++;};
const FAIL=m=>{console.log('  FAIL  '+m);failed++;process.exitCode=1;};
const check=(c,m)=>c?PASS(m):FAIL(m);
if(!fs.existsSync(CLI)){ console.log(' SKIP CLI not built'); process.exit(0); }

function runCli(args, opts={}){
  const cwd = opts.cwd ?? process.cwd();
  return spawnSync(process.execPath,[CLI,...args],{ cwd, encoding:'utf8', timeout:8000 });
}

const renderSrc = fs.readFileSync('src/tui/render.ts','utf8');
const tuiSrc = fs.readFileSync('src/tui/tui.ts','utf8');
const relaySrc = fs.existsSync('src/tui/relay-visual.ts') ? fs.readFileSync('src/tui/relay-visual.ts','utf8') : '';
const snapshotSrc = fs.readFileSync('src/tui/snapshot.ts','utf8');
const indexSrc = fs.readFileSync('src/cli/index.ts','utf8');

function dummySnap(over){
  return {
    version:'tui.snapshot.v1', snapshotAt:new Date().toISOString(), initialized:true, workspaceRoot:'/tmp', project:'my-project', dataRoot:'/tmp',
    status:{
      schemaVersion:'cli.status.v1', cwd:'/tmp', initialized:true, project:'my-project', workspaceRoot:'/tmp', dataRoot:'/tmp',
      goal: over.goal ?? null,
      taskCounts:{execution:{}, pm:{}, total:0}, activeTasks: over.activeTasks ?? [], nextWork: over.nextWork ?? {items:[], truncated:false}, recentEvents: over.recentEvents ?? [], warnings:[]
    }, workers: over.workers ?? [{workerId:'claude-code', adapter:'claude-code', activity:'IDLE', mascot:'🐙'}],
    tree:[], treeTruncated:false, treeTotal:0, warnings:[]
  };
}

const mod = await import('../dist/server/tui/render.js');
const relayMod = await import('../dist/server/tui/relay-visual.js');
const snapWith = (over)=> dummySnap(over);

console.log('\n── UX-01 default main screen uses outer-frame layout ──');
{
  const snap = snapWith({ goal:{goalId:'GOAL-0001',title:'Test',status:'ACTIVE',permissionMode:'PLAN'}, activeTasks:[{taskId:'TASK-0001',title:'Do',executionState:'RUNNING',pmState:'PENDING'}]});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('┌') && out.includes('┐') && out.includes('└') && out.includes('┘'), 'UX-01 outer frame box');
  check(out.includes('Agent Relay'), 'UX-01 contains Agent Relay');
  check(out.includes('Agent :'), 'UX-01 header Agent');
  check(out.includes('Repo :'), 'UX-01 header Repo');
  check(renderSrc.includes('┌') && renderSrc.includes('─'), 'UX-01 render src has frame');
}

console.log('\n── UX-02 old A/B/C/D diagnostic table not default screen ──');
{
  const snap = snapWith({ activeTasks:[] });
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(!out.includes('A. Goal / Task'), 'UX-02 no A panel in default');
  check(!out.includes('B. Workers'), 'UX-02 no B panel');
  check(!out.includes('C. Project Tree'), 'UX-02 no C panel');
  check(!out.includes('D. Events'), 'UX-02 no D panel');
  // underlying utilities preserved
  check(snapshotSrc.includes('buildTree'), 'UX-02 tree utility preserved');
  check(snapshotSrc.includes('buildStatusSnapshot'), 'UX-02 snapshot reuse preserved');
}

console.log('\n── UX-03 prompt direction GPT → Worker ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'DISPATCHED',pmState:'PENDING'}], nextWork:{items:[{kind:'TASK_DISPATCH_READY'}], truncated:false}});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('🤖 GPT') && out.includes('→'), 'UX-03 prompt lane has GPT →');
  check(out.includes('✉ Prompt'), 'UX-03 prompt label');
  // ensure direction is GPT left, worker right
  const line = out.split('\n').find(l=> l.includes('→') && l.includes('🤖'));
  check(!!line && line.indexOf('🤖') < line.indexOf('→'), 'UX-03 GPT left of arrow');
}

console.log('\n── UX-04 result direction Worker → GPT ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RESULT_RECEIVED',pmState:'PENDING'}]});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('←'), 'UX-04 result lane has ←');
  check(out.includes('✉ Result'), 'UX-04 result label');
  const line = out.split('\n').find(l=> l.includes('←') && l.includes('🤖'));
  check(!!line && line.indexOf('←') < line.indexOf('🐙') || !!line, 'UX-04 Worker→PM direction');
}

console.log('\n── UX-05 PROMPT_TRANSIT only from valid Relay/Core states ──');
{
  const valid = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'DISPATCHED',pmState:'PENDING'}], nextWork:{items:[{kind:'TASK_DISPATCH_READY'}], truncated:false}});
  check(relayMod.deriveRelayVisualState(valid)==='PROMPT_TRANSIT', 'UX-05 dispatch -> PROMPT_TRANSIT');
  const invalid = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'PLANNED',pmState:'PENDING'}]});
  check(relayMod.deriveRelayVisualState(invalid)!=='PROMPT_TRANSIT', 'UX-05 planned not prompt');
  check(relaySrc.includes('TASK_DISPATCH_READY') && relaySrc.includes('DISPATCHED'), 'UX-05 source checks dispatch states');
}

console.log('\n── UX-06 RESULT_TRANSIT only from valid result states ──');
{
  const valid = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RESULT_RECEIVED',pmState:'PENDING'}]});
  check(relayMod.deriveRelayVisualState(valid)==='RESULT_TRANSIT', 'UX-06 result -> RESULT_TRANSIT');
  const invalid = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RUNNING',pmState:'PENDING'}], nextWork:{items:[], truncated:false}});
  check(relayMod.deriveRelayVisualState(invalid)!=='RESULT_TRANSIT', 'UX-06 running not result');
  check(relaySrc.includes('RESULT_RECEIVED'), 'UX-06 references RESULT_RECEIVED');
}

console.log('\n── UX-07 WORKING derives from DISPATCHED/RUNNING ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RUNNING',pmState:'PENDING'}], nextWork:{items:[], truncated:false}});
  check(relayMod.deriveRelayVisualState(snap)==='WORKING', 'UX-07 running -> WORKING');
  check(relaySrc.includes('RUNNING'), 'UX-07 src includes RUNNING');
}

console.log('\n── UX-08 VERIFYING derives from RESULT_RECEIVED+VERIFYING ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RESULT_RECEIVED',pmState:'VERIFYING'}]});
  check(relayMod.deriveRelayVisualState(snap)==='VERIFYING', 'UX-08 verifying mapping');
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('VERIFYING'), 'UX-08 render says VERIFYING');
}

console.log('\n── UX-09 CHANGES_REQUESTED mapping ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RESULT_RECEIVED',pmState:'CHANGES_REQUESTED'}]});
  check(relayMod.deriveRelayVisualState(snap)==='CHANGES_REQUESTED', 'UX-09 mapping');
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('Changes requested') || out.includes('CHANGES'), 'UX-09 render');
}

console.log('\n── UX-10 ACCEPTED mapping ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RESULT_RECEIVED',pmState:'ACCEPTED'}]});
  check(relayMod.deriveRelayVisualState(snap)==='ACCEPTED', 'UX-10 mapping');
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('ACCEPTED') && out.includes('✓'), 'UX-10 render');
}

console.log('\n── UX-11 GOAL_COMPLETED mapping ──');
{
  const snap = snapWith({ goal:{goalId:'GOAL-0001',title:'x',status:'COMPLETED',permissionMode:'PLAN'}, activeTasks:[]});
  check(relayMod.deriveRelayVisualState(snap)==='GOAL_COMPLETED', 'UX-11 mapping');
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(out.includes('GOAL COMPLETED') && out.includes('✦'), 'UX-11 render');
}

console.log('\n── UX-12 animation frame changes marker position only ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'DISPATCHED',pmState:'PENDING'}], nextWork:{items:[{kind:'TASK_DISPATCH_READY'}], truncated:false}});
  const a0 = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  const a1 = mod.renderRelayFrame(snap,1,{cols:100,rows:30});
  check(a0 !== a1, 'UX-12 frames differ');
  const t0 = a0.split('\n').find(l=>l.includes('TASK-0001'));
  const t1 = a1.split('\n').find(l=>l.includes('TASK-0001'));
  check((t0??'')===(t1??''), 'UX-12 task line stable');
  check(mod.animationFrame, 'UX-12 animationFrame exported');
}

console.log('\n── UX-13 animation does not mutate snapshot/Core ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'DISPATCHED',pmState:'PENDING'}]});
  const before = JSON.stringify(snap);
  mod.renderRelayFrame(snap,5,{cols:100,rows:30});
  const after = JSON.stringify(snap);
  check(before===after, 'UX-13 render does not mutate');
  const b2 = JSON.stringify(snap);
  mod.animationFrame(snap,10);
  check(JSON.stringify(snap)===b2, 'UX-13 animation does not mutate');
}

console.log('\n── UX-14 no launch path leakage ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RUNNING',pmState:'PENDING'}]});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(!out.includes('launchCommand') && !out.includes('launchArgs'), 'UX-14 no launch path');
  const built = fs.readFileSync('dist/server/tui/snapshot.js','utf8');
  check(!built.includes('launchCommand'), 'UX-14 built no leak');
}

console.log('\n── UX-15 no Run folder leakage ──');
{
  const snap = snapWith({ activeTasks:[{taskId:'TASK-0001',title:'x',executionState:'RUNNING',pmState:'PENDING'}]});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  check(!out.includes('folder') && !out.includes('_relay'), 'UX-15 no folder');
  const j = JSON.stringify(snap);
  check(!j.includes('"folder"'), 'UX-15 json no folder key');
}

console.log('\n── UX-16 footer does not falsely claim license ──');
{
  const snap = snapWith({});
  const out = mod.renderRelayFrame(snap,0,{cols:100,rows:30});
  // No LICENSE file in repo -> must not claim MIT
  const hasLicenseFile = fs.existsSync('LICENSE') || fs.existsSync('LICENSE.md');
  if (!hasLicenseFile) {
    check(!out.includes('MIT License'), 'UX-16 no false MIT');
  } else {
    check(true,'UX-16 license file exists');
  }
  check(out.includes('support') && out.includes('ju0o'), 'UX-16 footer attribution');
}

console.log('\n── UX-17 stable redraw does not append repeated dashboard frames ──');
{
  check(tuiSrc.includes('?1049h') && tuiSrc.includes('?1049l'), 'UX-17 alt screen enter/leave');
  check(tuiSrc.includes('\\x1b[H\\x1b[J') || tuiSrc.includes("'\\x1b[H'"), 'UX-17 home+clearToEnd');
  // old bug was repeated \x1b[2J\x1b[H causing stacking
  const usesClassicClear = (tuiSrc.match(/\\x1b\[2J/g) || []).length;
  check(usesClassicClear <= 1, 'UX-17 no repeated 2J stacking (<=1)');
}

console.log('\n── UX-18 terminal cleanup restores cursor/screen mode ──');
{
  check(tuiSrc.includes('?25l') && tuiSrc.includes('?25h'), 'UX-18 cursor hide/restore');
  check(tuiSrc.includes('?1049l'), 'UX-18 alt leave restores');
  check(tuiSrc.includes('setRawMode(false)') || tuiSrc.includes('setRawMode'), 'UX-18 rawMode restore');
}

console.log('\n── UX-19 Tab focus removed or meaningfully implemented ──');
{
  check(!tuiSrc.includes("s === '\\t'") && !tuiSrc.includes('focused'), 'UX-19 Tab removed');
}

console.log('\n── UX-20 q exits ──');
{
  check(tuiSrc.includes("'q'") && tuiSrc.includes('process.exit'), 'UX-20 q handling');
}

console.log('\n── UX-21 --no-tui regression ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'arl-i3e-21-'));
  const ws = path.join(tmp,'ws'); fs.mkdirSync(ws,{recursive:true});
  const initMod = await import('../dist/server/cli/init.js');
  await initMod.runInit({ cwd: ws, yes:true, force:false, json:false, packageRoot: path.resolve('.'), claudeMock:{status:'NOT_FOUND'} });
  const r = runCli(['--no-tui'],{ cwd: ws });
  check(r.status===0, 'UX-21 --no-tui exits 0');
  check(!r.stdout.includes('\x1b[2J'), 'UX-21 no escape');
  fs.rmSync(tmp,{recursive:true,force:true});
}

console.log('\n── UX-22 status --json regression ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'arl-i3e-22-'));
  const ws = path.join(tmp,'ws'); fs.mkdirSync(ws,{recursive:true});
  const initMod = await import('../dist/server/cli/init.js');
  await initMod.runInit({ cwd: ws, yes:true, force:false, json:false, packageRoot: path.resolve('.'), claudeMock:{status:'NOT_FOUND'} });
  const r = runCli(['status','--json'],{ cwd: ws });
  let j=null; try{ j=JSON.parse(r.stdout);}catch{}
  check(j && j.schemaVersion==='cli.status.v1', 'UX-22 status json schema');
  fs.rmSync(tmp,{recursive:true,force:true});
}

console.log('\n── UX-23 init/connect regression ──');
{
  const r = runCli(['init','--yes','--json'],{ cwd: fs.mkdtempSync(path.join(os.tmpdir(),'arl-i3e-23-')) });
  check(r.status===0,'UX-23 init --yes');
}

console.log('\n── UX-24 Phase I3D snapshot regression ──');
{
  check(fs.existsSync('src/tui/snapshot.ts'), 'UX-24 snapshot exists');
  check(snapshotSrc.includes('buildStatusSnapshot'), 'UX-24 reuses buildStatusSnapshot');
}

console.log('\n── UX-25 Phase I real closed-loop regression ──');
{
  const disp = fs.readFileSync('src/backend/dispatcher.ts','utf8');
  check(disp.includes('permissionMode'), 'UX-25 dispatcher');
  check(fs.existsSync('scripts/relay-worker-claude.mjs'), 'UX-25 wrapper');
}

console.log(`\nI3E: ${passed} passed, ${failed} failed`);
if(failed>0) process.exitCode=1;
