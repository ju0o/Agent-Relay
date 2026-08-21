/* Test harness for Agent Relay Log V0 filesystem layer.
   Runs against the compiled server module (dist/server/backend/fs.js).
   Mirrors the acceptance checklist from the spec. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as relay from '../dist/server/backend/fs.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  // limit to x,y integers within folder names
  const project = 'HERMESS';
  const date = relay.todayString();
  const agent1 = 'Claude Code';
  const agent2 = 'OpenCode';
  const base = TEST_ROOT;

  console.log('1) 새 Project 생성');
  relay.ensureDataRoot(base);
  const created = relay.createProject(base, project);
  if (fs.existsSync(created.path)) PASS(`project folder exists: ${created.path}`);
  else FAIL('project folder missing');

  console.log('2) Claude Code 선택 + Prompt 저장');
  const r01 = relay.nextRunNumber(base, project, date, agent1);
  if (r01 !== '01') FAIL(`expected run 01, got ${r01}`); else PASS(`next run = ${r01}`);
  const folder1 = relay.ensureRunFolder(base, project, date, agent1, r01);
  const promptPath = relay.writeMarkdown(folder1, 'prompt.md', '# Hello Prompt\n', false);
  if (fs.existsSync(path.join(folder1, 'prompt.md'))) PASS(`prompt.md written: ${promptPath}`);
  else FAIL('prompt.md missing');

  console.log('3) 실제 Markdown 생성 확인');
  const readBack = relay.readMarkdown(folder1, 'prompt.md');
  if (readBack.includes('Hello Prompt')) PASS('markdown content intact');
  else FAIL('markdown content mismatch');

  console.log('4) Result 저장');
  relay.writeMarkdown(folder1, 'result.md', '# Result OK\n', false);
  const runRead = relay.readRun(folder1);
  if (runRead.result.includes('Result OK')) PASS('result.md read back OK');
  else FAIL('result.md read back failed');

  console.log('5) 같은 Agent에서 New Run -> 02 자동 생성');
  const r02 = relay.nextRunNumber(base, project, date, agent1);
  if (r02 !== '02') FAIL(`expected run 02, got ${r02}`); else PASS(`next run = ${r02}`);

  console.log('6) 덮어쓰기 차단 (안전)');
  let blocked = false;
  try { relay.writeMarkdown(folder1, 'prompt.md', 'X', false); }
  catch (e) { blocked = true; }
  if (blocked) PASS('overwrite refused without flag');
  else FAIL('overwrite was not blocked');

  console.log('7) overwrite=true 덮어쓰기 허용');
  relay.writeMarkdown(folder1, 'prompt.md', '# Overwritten\n', true);
  if (relay.readMarkdown(folder1, 'prompt.md').includes('Overwritten')) PASS('overwrite allowed with flag');
  else FAIL('overwrite failed');

  console.log('8) OpenCode 선택 -> 별도 Agent 폴더 생성 + run 01');
  const rA2 = relay.nextRunNumber(base, project, date, agent2);
  if (rA2 !== '01') FAIL(`expected run 01 for agent2, got ${rA2}`); else PASS(`agent2 run = ${rA2}`);
  const folder2 = relay.ensureRunFolder(base, project, date, agent2, rA2);
  relay.writeMarkdown(folder2, 'prompt.md', '# OpenCode Prompt\n', false);
  if (fs.existsSync(path.join(folder2, 'prompt.md'))) PASS('OpenCode prompt.md written');

  console.log('9) History 정상 표시');
  const history = relay.buildHistory(base, project);
  const keys = history.map((h) => `${h.date}/${h.agent}/${h.run}`);
  console.log('     history entries:', JSON.stringify(keys));
  if (history.length === 2) PASS('history has 2 entries');
  else FAIL(`history size ${history.length} != 2`);

  console.log('10) slugify 안전 처리');
  if (relay.slugify('My:Proj/Name?<>') === 'My Proj Name') PASS('slugify cleaned invalid chars');
  else FAIL('slugify failed');

  console.log('11) 앱 재시작 시뮬레이션 (DATA_ROOT 유지)');
  const settings = relay.loadSettings(path.dirname(process.cwd()));
  relay.saveSettings(path.dirname(process.cwd()), { dataRoot: TEST_ROOT, customAgents: ['TestAgent'] });
  const reloaded = relay.loadSettings(path.dirname(process.cwd()));
  if (reloaded.dataRoot === TEST_ROOT && reloaded.customAgents.includes('TestAgent')) PASS('settings persisted');
  else FAIL('settings not persisted');
  fs.rmSync(path.join(path.dirname(process.cwd()), 'settings.json'), { force: true });

  console.log('12) 프로젝트 List');
  const list = relay.listProjects(base);
  if (list.some((p) => p.name === 'HERMESS')) PASS('projects list contains HERMESS');
  else FAIL('projects list missing HERMESS');

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });