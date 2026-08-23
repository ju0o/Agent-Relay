/* V.next regression tests — Storage restore, lazy agent folders, result path,
   dogfooding feedback records. Runs against the compiled server module
   (dist/server/backend/fs.js), mirroring test/fs.test.mjs conventions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as relay from '../dist/server/backend/fs.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root-vnext');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  relay.ensureDataRoot(TEST_ROOT);

  // ── 1. Storage ────────────────────────────────────────────────────────────
  console.log('S1) dataRootExists — 존재하는 경로');
  if (relay.dataRootExists(TEST_ROOT) === true) PASS('existing dir detected');
  else FAIL('existing dir not detected');

  console.log('S2) dataRootExists — 존재하지 않는 경로');
  const ghost = path.join(TEST_ROOT, '..', '.does-not-exist-' + Date.now());
  if (relay.dataRootExists(ghost) === false) PASS('missing path detected');
  else FAIL('missing path not detected');
  console.log('S3) dataRootExists — 빈 문자열');
  if (relay.dataRootExists('') === false) PASS('empty string → false');
  else FAIL('empty string should be false');

  console.log('S4) settings 저장/복원 (lastProject 포함)');
  const settingsDir = TEST_ROOT; // 임의 디렉터리를 baseDir로 사용
  relay.saveSettings(settingsDir, { dataRoot: TEST_ROOT, customAgents: ['MyAgent'], lastProject: 'HERMESS' });
  const restored = relay.loadSettings(settingsDir);
  if (restored.dataRoot === TEST_ROOT && restored.lastProject === 'HERMESS' && restored.customAgents.includes('MyAgent')) {
    PASS('dataRoot + lastProject + customAgents roundtrip');
  } else FAIL(`settings roundtrip broken: ${JSON.stringify(restored)}`);

  console.log('S5) 손상된 settings.json → 기본값 폴백');
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{broken json', 'utf8');
  const fallback = relay.loadSettings(settingsDir);
  if (fallback.dataRoot === '' && fallback.lastProject === undefined) PASS('corrupt settings fall back to defaults');
  else FAIL('corrupt settings did not fall back cleanly');

  // ── 2. Agent lazy folder creation ────────────────────────────────────────
  console.log('A1) run 번호 조회만으로는 폴더가 생성되지 않음');
  relay.createProject(TEST_ROOT, 'LAZYTEST');
  const n = relay.nextRunNumber(TEST_ROOT, 'LAZYTEST', '2026-08-23', 'Claude Code');
  const agentDirAfterPeek = relay.agentDir(TEST_ROOT, 'LAZYTEST', '2026-08-23', 'Claude Code');
  if (n === '01' && !fs.existsSync(agentDirAfterPeek)) PASS(`next=${n}, no folder created`);
  else FAIL(`peek created folder or wrong number: ${n}`);

  console.log('A2) 실제 Run 생성 시에만 Agent 폴더 생성');
  const folder = relay.ensureRunFolder(TEST_ROOT, 'LAZYTEST', '2026-08-23', 'Claude Code', n);
  if (fs.existsSync(folder)) PASS('ensureRunFolder creates the run folder');
  else FAIL('ensureRunFolder did not create the folder');

  console.log('A3) 하드코딩 없음 — 다른 에이전트도 동일 규칙');
  const n2 = relay.nextRunNumber(TEST_ROOT, 'LAZYTEST', '2026-08-23', 'OpenCode');
  if (!fs.existsSync(relay.agentDir(TEST_ROOT, 'LAZYTEST', '2026-08-23', 'OpenCode'))) {
    PASS('no implicit folder for other agents either');
  } else FAIL('unexpected folder for OpenCode');

  // ── 3. Result 경로 ────────────────────────────────────────────────────────
  console.log('R1) drag/reveal 대상은 정확히 result.md');
  const rp = relay.resolveResultPath(folder);
  if (path.basename(rp) === 'result.md' && path.dirname(rp) === folder) PASS(rp);
  else FAIL(`wrong result path: ${rp}`);
  console.log('R2) result.md 실제 존재 확인 가능');
  relay.writeMarkdown(folder, 'result.md', '# hi\n', false);
  if (fs.existsSync(relay.resolveResultPath(folder))) PASS('file exists at resolved path');
  else FAIL('resolved path does not hold result.md');

  // ── 4. Dogfooding ─────────────────────────────────────────────────────────
  console.log('D1) 피드백 생성 — ID 자동 증가');
  const ctx = { project: 'HERMESS', date: '2026-08-23', agent: 'OpenCode', run: '07' };
  const f1 = relay.createFeedback(TEST_ROOT, {
    type: 'UX', priority: 'MEDIUM',
    feedback: 'Result 전달이 번거롭다.', desired: '드래그 앤 드롭 지원.', context: ctx,
  }, '0.2.0');
  if (f1.id === 'DF-0001' && f1.status === 'OPEN') PASS(f1.id);
  else FAIL(`first id wrong: ${f1.id}`);
  const dfFile = path.join(relay.dogfoodingDir(TEST_ROOT), 'DF-0001.md');
  if (!fs.existsSync(dfFile)) FAIL('markdown file missing');
  else PASS('DF-0001.md written');

  const f2 = relay.createFeedback(TEST_ROOT, {
    type: 'BUG', priority: 'HIGH',
    feedback: '크래시 재현 단계...', desired: '', context: {},
  }, '0.2.0');
  if (f2.id === 'DF-0002') PASS('id incremented to DF-0002');
  else FAIL(`second id wrong: ${f2.id}`);

  console.log('D2) Markdown 파싱 왕복 (header/context/feedback/desired)');
  if (f1.type === 'UX' && f1.priority === 'MEDIUM' && f1.version === '0.2.0'
    && f1.created === relay.todayString()
    && f1.context.project === 'HERMESS' && f1.context.run === '07'
    && f1.feedback.includes('번거롭다') && f1.desired.includes('드래그')) {
    PASS('all fields round-trip through markdown');
  } else FAIL(`parse mismatch: ${JSON.stringify(f1)}`);

  console.log('D3) desired 없이 생성 → 섹션 생략, 파싱 허용');
  if (f2.desired === '' && f2.context.project === undefined) PASS('optional sections tolerated');
  else FAIL(`optional sections mishandled: ${JSON.stringify(f2)}`);

  console.log('D4) 상태 변경 OPEN → FIXED (SSOT인 md 파일 갱신)');
  const fixed = relay.setFeedbackStatus(TEST_ROOT, 'DF-0001', 'FIXED');
  const rawMd = fs.readFileSync(dfFile, 'utf8');
  if (fixed.status === 'FIXED' && /^Status: FIXED$/m.test(rawMd)) PASS('status persisted in markdown');
  else FAIL('status change failed');

  console.log('D5) HOLD 상태 지원 + 목록 정렬(최신 우선)');
  relay.setFeedbackStatus(TEST_ROOT, 'DF-0002', 'HOLD');
  const list = relay.listFeedbacks(TEST_ROOT);
  if (list.length === 2 && list[0].id === 'DF-0002' && list[0].status === 'HOLD' && list[1].status === 'FIXED') {
    PASS('list sorted newest-first with statuses');
  } else FAIL(`list wrong: ${JSON.stringify(list.map(x => [x.id, x.status]))}`);

  console.log('D6) 일반 Project 데이터와 분리 (.agent-relay)');
  if (relay.dogfoodingDir(TEST_ROOT).includes(path.join('.agent-relay', 'dogfooding'))
    && !/HERMESS/.test(relay.dogfoodingDir(TEST_ROOT))) PASS(feedbackLocationMsg());
  else FAIL('dogfooding location wrong');
  console.log('D7) .agent-relay는 프로젝트 목록에 나타나지 않음');
  const projects = relay.listProjects(TEST_ROOT);
  if (!projects.some(p => p.name.startsWith('.'))) PASS('dot-folder hidden from project list');
  else FAIL('.agent-relay leaked into project list');

  console.log('D8) ID 유실 없음 — 삭제 후에도 번호 재사용 안 함');
  fs.rmSync(dfFile);
  const f3 = relay.createFeedback(TEST_ROOT, { type: 'GOOD', priority: 'LOW', feedback: 'x', desired: '', context: {} }, '0.2.0');
  if (f3.id === 'DF-0003') PASS('next id is DF-0003 (gap not reused)');
  else FAIL(`gap reuse detected: ${f3.id}`);

  function feedbackLocationMsg() {
    return `records under ${path.join('.agent-relay', 'dogfooding')}`;
  }

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
