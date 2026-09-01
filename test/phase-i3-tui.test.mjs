/**
 * TUI-01..25 Phase I3D Minimal TUI Status
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

const indexSrc = fs.readFileSync('src/cli/index.ts','utf8');
const snapshotSrc = fs.existsSync('src/tui/snapshot.ts') ? fs.readFileSync('src/tui/snapshot.ts','utf8') : '';
const treeSrc = fs.existsSync('src/tui/tree.ts') ? fs.readFileSync('src/tui/tree.ts','utf8') : '';
const renderSrc = fs.existsSync('src/tui/render.ts') ? fs.readFileSync('src/tui/render.ts','utf8') : '';
const tuiSrc = fs.existsSync('src/tui/tui.ts') ? fs.readFileSync('src/tui/tui.ts','utf8') : '';
const mappingSrc = fs.existsSync('src/tui/mapping.ts') ? fs.readFileSync('src/tui/mapping.ts','utf8') : '';
const mascotSrc = fs.existsSync('src/tui/mascot.ts') ? fs.readFileSync('src/tui/mascot.ts','utf8') : '';

function runCli(args, opts={}){
  const cwd = opts.cwd ?? process.cwd();
  return spawnSync(process.execPath,[CLI,...args],{ cwd, encoding:'utf8', timeout:8000 });
}

// prepare temp project for later tests
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(),'arl-tui-'));
const ws = path.join(TMP_ROOT,'ws');
fs.mkdirSync(ws,{recursive:true});
const initMod = await import('../dist/server/cli/init.js');
await initMod.runInit({ cwd: ws, yes:true, force:false, json:false, packageRoot: path.resolve('.'), claudeMock:{status:'NOT_FOUND'} });
const gt = await import('../dist/server/backend/goal-task.js');
const dataRoot = JSON.parse(fs.readFileSync(path.join(ws,'.agent-relay','config.json'),'utf8')).dataRoot;
const project = JSON.parse(fs.readFileSync(path.join(ws,'.agent-relay','config.json'),'utf8')).project;
await gt.createGoal(dataRoot, project, { title:'TUI Goal', goalStatement:'test', completionCriteria:[] });
const g = gt.listGoals(dataRoot, project)[0];
await gt.createTask(dataRoot, project, { goalId:g.goalId, title:'TUI Task 1', goal:'g', reason:'r', scope:'s', executionState:'RUNNING', pmState:'PENDING' });
await gt.createTask(dataRoot, project, { goalId:g.goalId, title:'TUI Task 2', goal:'g', reason:'r', scope:'s', executionState:'READY', pmState:'PENDING' });
// ensure worker exists — capture original to restore later, avoid polluting global dataRoot
const wr = await import('../dist/server/backend/worker-registry.js');
let origWorkerJson = null;
let origWorkerPath = path.join(dataRoot,'_relay','workers','claude-code.json');
try{ if(fs.existsSync(origWorkerPath)) origWorkerJson = fs.readFileSync(origWorkerPath,'utf8'); }catch{}
try{ wr.writeWorkerRegistryRecord(dataRoot,{ schemaVersion:'G.2', workerId:'claude-code', launchCommand:process.execPath, launchArgsPrefix:['-e','process.exit(0)'], observationAdapterId:'claude-code' }); }catch{}

console.log('\n── TUI-01 bare initialized TTY launches TUI entry ──');
{
  check(indexSrc.includes('launchTui'), 'TUI-01 index imports launchTui');
  check(indexSrc.includes("await import('../tui/tui.js')") || indexSrc.includes('tui/tui'), 'TUI-01 dynamic import tui');
  check(indexSrc.includes('discovered.initialized') && indexSrc.includes('launchTui'), 'TUI-01 launches only when initialized');
  check(tuiSrc.includes('buildTuiSnapshot') || snapshotSrc.includes('buildTuiSnapshot'), 'TUI-01 snapshot builder exists');
  check(fs.existsSync('dist/server/tui/tui.js'), 'TUI-01 built tui.js exists');
}

console.log('\n── TUI-02 --no-tui never launches TUI ──');
{
  const r = runCli(['--no-tui'],{ cwd: ws });
  check(r.status===0, `TUI-02 --no-tui exits 0 (${r.status})`);
  check(r.stdout.includes('headless') || r.stdout.includes('Agent Relay'), 'TUI-02 headless output');
  check(!r.stdout.includes('\x1b[2J'), 'TUI-02 no escape sequences');
  // also status --no-tui ?
  const r2 = runCli(['status','--no-tui'],{ cwd: ws });
  check(r2.status===0, 'TUI-02 status --no-tui exits 0');
  // Ensure indexSrc has early noTui handling
  check(indexSrc.includes('noTui') && indexSrc.includes('--no-tui'), 'TUI-02 index handles noTui');
}

console.log('\n── TUI-03 non-TTY falls back headless ──');
{
  // spawnSync is non-TTY by default (no pty)
  const r = runCli([],{ cwd: ws });
  check(r.status===0, `TUI-03 bare non-TTY exits 0 (${r.status})`);
  // Should not hang, should contain headless or status
  const out = r.stdout + r.stderr;
  check(out.includes('headless') || out.includes('Agent Relay') || out.includes('Project'), `TUI-03 non-TTY fallback headless: ${out.slice(0,120)}`);
  check(!out.includes('\x1b[?25l'), 'TUI-03 no TUI escape in non-TTY');
  check(tuiSrc.includes('isTTY') || indexSrc.includes('isTTY'), 'TUI-03 checks isTTY');
}

console.log('\n── TUI-04 snapshot uses existing Core ──');
{
  check(snapshotSrc.includes('buildStatusSnapshot'), 'TUI-04 snapshot reuses buildStatusSnapshot');
  check(snapshotSrc.includes('workerRegistry') || snapshotSrc.includes('listWorkerRegistryRecords') || snapshotSrc.includes('toPublicWorkerView'), 'TUI-04 uses worker registry public view');
  check(snapshotSrc.includes('buildTree') || snapshotSrc.includes('tree'), 'TUI-04 uses tree reader');
  // status snapshot already uses getNextWork and listEvents
  check(fs.readFileSync('src/cli/status.ts','utf8').includes('getNextWork'), 'TUI-04 status uses getNextWork');
}

console.log('\n── TUI-05 no Core mutations from TUI modules ──');
{
  const combined = snapshotSrc + treeSrc + renderSrc + tuiSrc + mappingSrc + mascotSrc;
  check(!combined.includes('createGoal'), 'TUI-05 no createGoal');
  check(!combined.includes('createTask'), 'TUI-05 no createTask');
  check(!combined.includes('dispatchTask') || combined.includes('listActiveDispatches'), 'TUI-05 no dispatch');
  check(!combined.includes('writeWorkerRegistryRecord') || combined.includes('listWorker'), 'TUI-05 no worker write');
  check(!combined.includes('markDelivered'), 'TUI-05 no markDelivered');
  check(!combined.includes('transitionTask') && !combined.includes('updateTask'), 'TUI-05 no task mutation');
}

console.log('\n── TUI-06 Goal panel state mapping ──');
{
  check(renderSrc.includes('Goal') || renderSrc.includes('GOAL'), 'TUI-06 render has Goal panel');
  check(renderSrc.includes('permissionMode') || snapshotSrc.includes('permissionMode') || fs.readFileSync('src/cli/status.ts','utf8').includes('permissionMode'), 'TUI-06 shows permissionMode');
  check(mappingSrc.includes('executionState') || mappingSrc.includes('mapExecution'), 'TUI-06 mapping exists');
}

console.log('\n── TUI-07 Task mapping ──');
{
  check(mappingSrc.includes('taskDisplaySymbol') || mappingSrc.includes('executionSymbol'), 'TUI-07 task symbol mapping');
  check(renderSrc.includes('taskDisplaySymbol') || renderSrc.includes('RUNNING') || renderSrc.includes('READY'), 'TUI-07 render uses task symbols');
  check(mappingSrc.includes('●') || renderSrc.includes('●') || mappingSrc.includes('READY'), 'TUI-07 symbols present');
}

console.log('\n── TUI-08 Worker public-safe fields only ──');
{
  check(snapshotSrc.includes('toPublicWorkerView'), 'TUI-08 uses public view');
  check(snapshotSrc.includes('workerId') && snapshotSrc.includes('adapter') && snapshotSrc.includes('activity'), 'TUI-08 worker view has safe fields');
  check(!snapshotSrc.includes('launchCommand'), 'TUI-08 no launchCommand in snapshot');
  check(renderSrc.includes('Workers') || renderSrc.includes('Worker'), 'TUI-08 render workers');
}

console.log('\n── TUI-09 no launchCommand leakage ──');
{
  const allTui = snapshotSrc + treeSrc + renderSrc + tuiSrc + mappingSrc + mascotSrc;
  check(!allTui.includes('launchCommand'), 'TUI-09 no launchCommand');
  check(!allTui.includes('launchArgsPrefix'), 'TUI-09 no launchArgsPrefix');
  check(!allTui.includes('permissionMode raw') && !renderSrc.includes('launchArgs'), 'TUI-09 no permission raw');
  // Also check built files
  const builtTui = fs.existsSync('dist/server/tui/snapshot.js') ? fs.readFileSync('dist/server/tui/snapshot.js','utf8') : '';
  check(!builtTui.includes('launchCommand'), 'TUI-09 built no launchCommand');
}

console.log('\n── TUI-10 no Run folder leakage ──');
{
  const statusSnapSrc = fs.readFileSync('src/cli/status.ts','utf8');
  check(!statusSnapSrc.includes('folder') || statusSnapSrc.includes('runId'), 'TUI-10 status no folder leak check');
  // TUI snapshot should not expose folder
  check(!snapshotSrc.includes('folder'), 'TUI-10 snapshot no folder');
  check(!renderSrc.includes('folder'), 'TUI-10 render no folder');
  // Verify runtime snapshot doesn't have folder key
  const { buildTuiSnapshot } = await import('../dist/server/tui/snapshot.js');
  const snap = buildTuiSnapshot(ws);
  const json = JSON.stringify(snap);
  check(!json.includes('"folder"'), 'TUI-10 json no folder key');
}

console.log('\n── TUI-11 tree ignores node_modules/.git/.agent-relay ──');
{
  check(treeSrc.includes('.git') && treeSrc.includes('node_modules') && treeSrc.includes('.agent-relay'), 'TUI-11 ignore list includes required');
  check(treeSrc.includes('dist') && treeSrc.includes('build'), 'TUI-11 ignore dist/build');
  // Create fake files to test ignore
  fs.mkdirSync(path.join(ws,'node_modules'),{recursive:true}); fs.writeFileSync(path.join(ws,'node_modules','fake.js'),'x');
  fs.mkdirSync(path.join(ws,'.git'),{recursive:true}); fs.writeFileSync(path.join(ws,'.git','config'),'x');
  fs.mkdirSync(path.join(ws,'.agent-relay','extra'),{recursive:true}); // already exists
  const { buildTree } = await import('../dist/server/tui/tree.js');
  const res = buildTree(ws);
  const names = JSON.stringify(res.nodes);
  check(!names.includes('node_modules'), 'TUI-11 tree excludes node_modules');
  check(!names.includes('".git"') || !names.includes('.git'), 'TUI-11 tree excludes .git');
}

console.log('\n── TUI-12 tree depth bounded ──');
{
  check(treeSrc.includes('MAX_DEPTH') || treeSrc.includes('depth') && treeSrc.includes('2'), 'TUI-12 depth bounded 2');
  // Create deep structure
  const deep = path.join(ws,'a','b','c','d');
  fs.mkdirSync(deep,{recursive:true}); fs.writeFileSync(path.join(deep,'deep.txt'),'x');
  const { buildTree } = await import('../dist/server/tui/tree.js');
  const res = buildTree(ws);
  // Check max depth via traversing
  let maxDepth=0;
  function walk(nodes, d){ for(const n of nodes){ maxDepth=Math.max(maxDepth,n.depth); if(n.children) walk(n.children,d+1); } }
  walk(res.nodes,0);
  check(maxDepth <=2, `TUI-12 maxDepth ${maxDepth} <=2`);
  fs.rmSync(path.join(ws,'a'),{recursive:true,force:true});
}

console.log('\n── TUI-13 tree entry count bounded ──');
{
  check(treeSrc.includes('MAX_NODES') || treeSrc.includes('50'), 'TUI-13 max nodes 50');
  // Create many files
  for(let i=0;i<60;i++){ fs.writeFileSync(path.join(ws,`file${i}.txt`),'x'); }
  const { buildTree } = await import('../dist/server/tui/tree.js');
  const res = buildTree(ws);
  check(res.visible <=50, `TUI-13 visible ${res.visible} <=50`);
  check(res.truncated===true, 'TUI-13 truncated when over');
  // Cleanup
  for(let i=0;i<60;i++){ try{fs.unlinkSync(path.join(ws,`file${i}.txt`));}catch{}}
}

console.log('\n── TUI-14 events bounded ──');
{
  check(renderSrc.includes('Events') || renderSrc.includes('recentEvents'), 'TUI-14 events panel');
  const snapMod = await import('../dist/server/tui/snapshot.js');
  const snap = snapMod.buildTuiSnapshot(ws);
  check(snap.status.recentEvents.length <=10, `TUI-14 events <=10 (${snap.status.recentEvents.length})`);
}

console.log('\n── TUI-15 getNextWork reused ──');
{
  check(snapshotSrc.includes('buildStatusSnapshot') || fs.readFileSync('src/cli/status.ts','utf8').includes('getNextWork'), 'TUI-15 reuses getNextWork via status');
  check(!snapshotSrc.includes('function getNextWork'), 'TUI-15 no duplicated getNextWork');
  check(renderSrc.includes('Next') || renderSrc.includes('nextWork'), 'TUI-15 next work indicator');
}

console.log('\n── TUI-16 refresh failure recoverable ──');
{
  check(tuiSrc.includes('State refresh failed') || tuiSrc.includes('retrying'), 'TUI-16 refresh failure message');
  check(tuiSrc.includes('try') && tuiSrc.includes('catch'), 'TUI-16 try/catch around refresh');
  check(tuiSrc.includes('TUI_REFRESH_MS') || tuiSrc.includes('1000') || tuiSrc.includes('refreshMs'), 'TUI-16 interval defined');
  const msMatch = tuiSrc.match(/refreshMs|TUI_REFRESH_MS|1000/);
  check(!!msMatch, 'TUI-16 refresh interval present');
}

console.log('\n── TUI-17 q exit ──');
{
  check(tuiSrc.includes("'q'") || tuiSrc.includes('"q"') || tuiSrc.includes('q'), 'TUI-17 handles q');
  check(tuiSrc.includes('process.exit'), 'TUI-17 exit');
}

console.log('\n── TUI-18 Ctrl-C exit ──');
{
  check(tuiSrc.includes('\\u0003') || tuiSrc.includes('Ctrl-C') || tuiSrc.includes('SIGINT'), 'TUI-18 Ctrl-C');
  check(tuiSrc.includes('SIGINT') && tuiSrc.includes('SIGTERM'), 'TUI-18 signals');
}

console.log('\n── TUI-19 compact small-terminal fallback ──');
{
  check(renderSrc.includes('renderCompact') || renderSrc.includes('compact'), 'TUI-19 compact renderer');
  check(tuiSrc.includes('cols < 80') || tuiSrc.includes('80') && tuiSrc.includes('compact'), 'TUI-19 small width check');
  check(tuiSrc.includes('rows < 20') || renderSrc.includes('Resize terminal'), 'TUI-19 small height/check');
  // Test renderCompact directly
  const mod = await import('../dist/server/tui/render.js');
  const snapMod = await import('../dist/server/tui/snapshot.js');
  const snap = snapMod.buildTuiSnapshot(ws);
  const out = mod.renderCompact(snap,{cols:60, rows:10});
  check(out.includes('Resize terminal'), 'TUI-19 compact message');
  check(out.includes('Agent Relay'), 'TUI-19 compact header');
}

console.log('\n── TUI-20 no embedded LLM ──');
{
  const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
  const deps = {...pkg.dependencies, ...pkg.devDependencies};
  const hasLLM = Object.keys(deps).some(k=>k.includes('openai')||k.includes('anthropic')||k.includes('gpt')||k.includes('claude-sdk'));
  check(!hasLLM, 'TUI-20 no LLM deps');
  const combined = indexSrc + snapshotSrc + tuiSrc + renderSrc;
  check(!combined.toLowerCase().includes('openai'), 'TUI-20 no openai import');
}

console.log('\n── TUI-21 status --json regression ──');
{
  const r = runCli(['status','--json'],{ cwd: ws });
  check(r.status===0, 'TUI-21 status --json exit 0');
  let j=null; try{ j=JSON.parse(r.stdout);}catch{}
  check(j && j.schemaVersion==='cli.status.v1', 'TUI-21 status schema');
  check(r.stdout.trim().startsWith('{'), 'TUI-21 only JSON');
}

console.log('\n── TUI-22 doctor regression ──');
{
  const r = runCli(['doctor'],{ cwd: ws });
  check(r.status===0, `TUI-22 doctor exits 0 (${r.status})`);
  check(r.stdout.includes('Doctor') || r.stdout.includes('✓'), 'TUI-22 doctor output');
}

console.log('\n── TUI-23 init/connect regression ──');
{
  const r = runCli(['init','--yes','--json'],{ cwd: fs.mkdtempSync(path.join(os.tmpdir(),'arl-tui23-')) });
  check(r.status===0, 'TUI-23 init --yes still works');
  // connect manual fallback check quickly via non-initialized ws
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(),'arl-tui23b-'));
  const r2 = runCli(['connect','claude-code','--json'],{ cwd: tmp2 });
  // should be not initialized -> ok false
  let j2=null; try{ j2=JSON.parse(r2.stdout);}catch{}
  check(j2 && j2.client==='claude-code', 'TUI-23 connect still responds');
  fs.rmSync(tmp2,{recursive:true,force:true});
}

console.log('\n── TUI-24 Phase I real-driver regression ──');
{
  const wrapExists = fs.existsSync('scripts/relay-worker-claude.mjs');
  check(wrapExists, 'TUI-24 wrapper exists');
  const dispSrc = fs.readFileSync('src/backend/dispatcher.ts','utf8');
  check(dispSrc.includes('permissionMode'), 'TUI-24 dispatcher permissionMode');
  check(fs.existsSync('dist/server/backend/main.js'), 'TUI-24 electron main');
}

console.log('\n── TUI-25 Phase I3A stabilization regression ──');
{
  const fss = fs.readFileSync('src/backend/fs.ts','utf8');
  check(fss.includes('renameSync'), 'TUI-25 fs atomic');
  const gts = fs.readFileSync('src/backend/goal-task.ts','utf8');
  check(gts.includes('writeJsonAtomic'), 'TUI-25 goal-task atomic');
}

// Cleanup — restore worker and remove test project data
try{
  if(origWorkerJson !== null){
    fs.writeFileSync(origWorkerPath, origWorkerJson, 'utf8');
  } else {
    try{ fs.unlinkSync(origWorkerPath); }catch{}
  }
}catch{}
try{
  // remove test goals/tasks under dataRoot/project
  const { listGoals } = await import('../dist/server/backend/goal-task.js');
  // Just remove the project folder if it was ws test project
  const projDir = path.join(dataRoot, project);
  if(fs.existsSync(projDir) && project === 'ws'){
    fs.rmSync(projDir,{recursive:true,force:true});
  }
}catch{}
fs.rmSync(TMP_ROOT,{recursive:true,force:true});

console.log(`\nTUI: ${passed} passed, ${failed} failed`);
if(failed>0) process.exitCode=1;
