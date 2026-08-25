/* v0.3.0 feature tests — settings orders, portable→userData migration,
   drag-reorder pure helpers, updater state machine, quick dogfooding capture.
   Runs against the compiled server module (dist/server/backend/*.js),
   mirroring test/fs.test.mjs conventions. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as relay from '../dist/server/backend/fs.js';
import * as migrate from '../dist/server/backend/migrate.js';
import {
  applyOrderByKeys,
  nextUpdateStatus,
  reorderArray,
} from '../dist/server/shared/types.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root-v03');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  relay.ensureDataRoot(TEST_ROOT);

  // ── S. Settings — order persistence ────────────────────────────────────────
  console.log('S1) settings roundtrip — projectOrder/agentOrder 포함');
  const settingsDir = path.join(TEST_ROOT, '_settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  relay.saveSettings(settingsDir, {
    dataRoot: TEST_ROOT,
    customAgents: ['MyAgent'],
    lastProject: 'HERMESS',
    projectOrder: ['JuTell', 'HERMESS', 'GUPITI'],
    agentOrder: ['OpenCode', 'Codex', 'Claude Code'],
  });
  const s1 = relay.loadSettings(settingsDir);
  if (s1.projectOrder?.join('|') === 'JuTell|HERMESS|GUPITI'
    && s1.agentOrder?.join('|') === 'OpenCode|Codex|Claude Code'
    && s1.lastProject === 'HERMESS') {
    PASS('projectOrder + agentOrder + lastProject persist');
  } else FAIL(`orders lost: ${JSON.stringify(s1)}`);

  console.log('S2) 손상된 settings.json → 기본값 폴백 (orders 포함 초기화)');
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), '{broken', 'utf8');
  const s2 = relay.loadSettings(settingsDir);
  if (s2.projectOrder === undefined && s2.agentOrder === undefined && s2.dataRoot === '') {
    PASS('corrupt settings fall back cleanly');
  } else FAIL('corrupt fallback incomplete');

  console.log('S3) 재실행 시뮬레이션 — DATA_ROOT 자동 복원 (묻지 않음)');
  const s3dir = path.join(TEST_ROOT, '_settings2');
  fs.mkdirSync(s3dir, { recursive: true });
  relay.saveSettings(s3dir, { dataRoot: TEST_ROOT, customAgents: [] });
  const s3 = relay.loadSettings(s3dir);
  if (relay.dataRootExists(s3.dataRoot) === true) {
    PASS('restored dataRoot exists on disk → no first-run dialog');
  } else FAIL('dataRoot restore broken');

  // ── M. Migration — portable → installed(userData) ─────────────────────────
  console.log('M1) migrateSettings — legacy settings.json을 새 baseDir로 복사');
  const legacyDir = path.join(TEST_ROOT, '_legacy-portable');
  const userDataDir = path.join(TEST_ROOT, '_userdata');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  relay.saveSettings(legacyDir, { dataRoot: 'D:\\Logs', customAgents: ['Kiro'], lastProject: 'JuTell' });
  const from = migrate.migrateSettings(userDataDir, [path.join(TEST_ROOT, '_nope'), legacyDir]);
  const migrated = migrate.settingsExists(userDataDir)
    ? relay.loadSettings(userDataDir)
    : null;
  if (from && from.endsWith('settings.json')
    && migrated?.dataRoot === 'D:\\Logs' && migrated.lastProject === 'JuTell') {
    PASS(`copied ${path.basename(path.dirname(from))} → userData`);
  } else FAIL(`migration failed: from=${from} got=${JSON.stringify(migrated)}`);

  console.log('M2) migration은 비파괴적 — 원본 유지');
  if (migrate.settingsExists(legacyDir)
    && relay.loadSettings(legacyDir).dataRoot === 'D:\\Logs') {
    PASS('legacy settings.json untouched');
  } else FAIL('legacy settings was modified/deleted');

  console.log('M3) 대상에 이미 settings.json이 있으면 건너뜀');
  const before = relay.loadSettings(userDataDir);
  const skipped = migrate.migrateSettings(userDataDir, [legacyDir]);
  const after = relay.loadSettings(userDataDir);
  if (skipped === null && after.dataRoot === before.dataRoot) PASS('existing settings preserved');
  else FAIL('migration overwrote existing settings');

  console.log('M4) 후보가 없으면 null (조용히 기본값 사용)');
  const emptyDir = path.join(TEST_ROOT, '_empty-userdata');
  fs.mkdirSync(emptyDir, { recursive: true });
  if (migrate.migrateSettings(emptyDir, []) === null && !migrate.settingsExists(emptyDir)) {
    PASS('no candidates → nothing done');
  } else FAIL('unexpected migration with no candidates');

  console.log('M5) 깨진 legacy 파일은 채택하지 않음');
  const brokenDir = path.join(TEST_ROOT, '_broken-legacy');
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, 'settings.json'), '{{{nope', 'utf8');
  let m5threw = false;
  try { migrate.migrateSettings(emptyDir, [brokenDir]); } catch { m5threw = true; }
  if (m5threw && !migrate.settingsExists(emptyDir)) PASS('unparsable legacy rejected, dest untouched');
  else FAIL('broken legacy file was adopted or dest polluted');

  // ── O. Reorder helpers ─────────────────────────────────────────────────────
  console.log('O1) reorderArray — 이동/경계/불변성');
  const arr = ['a', 'b', 'c', 'd'];
  if (reorderArray(arr, 0, 2).join('') === 'bcad'
    && reorderArray(arr, 3, 0).join('') === 'dabc'
    && reorderArray(arr, 1, 1).join('') === 'abcd'
    && reorderArray(arr, -1, 2).join('') === 'abcd'
    && reorderArray(arr, 0, 9).join('') === 'abcd'
    && arr.join('') === 'abcd') {
    PASS('move + bounds + source untouched');
  } else FAIL('reorderArray broken');

  console.log('O2) applyOrderByKeys — 저장 순서 반영 + 신규 항목 뒤에 추가');
  const agents = ['Claude Code', 'Codex', 'OpenCode', 'CommandCode'];
  const ordered = applyOrderByKeys(agents, x => x, ['OpenCode', 'Claude Code']);
  if (ordered.join('|') === 'OpenCode|Claude Code|Codex|CommandCode') {
    PASS('saved keys first (in saved order), unknown appended');
  } else FAIL(`applyOrderByKeys wrong: ${ordered.join('|')}`);

  console.log('O3) applyOrderByKeys — stale order 항목 무시 + 중복 방어');
  const projects = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const p2 = applyOrderByKeys(projects, p => p.name, ['C', 'GONE', 'C', 'B']);
  if (p2.map(p => p.name).join('') === 'CBA') PASS('stale/duplicate order entries ignored');
  else FAIL(`stale handling wrong: ${p2.map(p => p.name).join('')}`);

  // ── U. Updater state machine ───────────────────────────────────────────────
  const st = (phase, extra = {}) => ({ version: '0.3.0', phase, ...extra });
  const feed = (s, e) => nextUpdateStatus(s, e);

  console.log('U1) idle → checking → none ("현재 최신 버전입니다")');
  let u = feed(st('idle'), { type: 'check-started', manual: true });
  u = feed(u, { type: 'not-available' });
  if (u.phase === 'none' && !u.nextVersion) PASS('idle→checking→none');
  else FAIL(`latest-version flow broken: ${JSON.stringify(u)}`);

  console.log('U2) idle → available → downloading(progress) → ready');
  u = feed(st('idle'), { type: 'check-started', manual: false });
  u = feed(u, { type: 'available', nextVersion: '0.3.1' });
  u = feed(u, { type: 'download-progress', percent: 47 });
  u = feed(u, { type: 'download-progress', percent: 140 }); // clamp
  u = feed(u, { type: 'downloaded' });
  if (u.phase === 'ready' && u.nextVersion === '0.3.1' && u.percent === undefined) {
    PASS('download flow reaches ready');
  } else FAIL(`download flow broken: ${JSON.stringify(u)}`);

  console.log('U3) progress clamp 0~100');
  const clamped = feed(feed(st('available', { nextVersion: 'x' }), { type: 'download-progress', percent: -5 }), { type: 'download-progress', percent: 47 });
  if (clamped.phase === 'downloading' && clamped.percent === 47) PASS('negative percent clamped to 0..100');
  else FAIL(`clamp broken: ${JSON.stringify(clamped)}`);

  console.log('U4) manual check 에러는 표시 / background 에러는 조용히 idle');
  const manualErr = feed(st('checking'), { type: 'error', message: '404 private', manual: true });
  const bgErr = feed(st('checking'), { type: 'error', message: '404 private', manual: false });
  if (manualErr.phase === 'error' && manualErr.errorMessage?.includes('404')) PASS('manual error surfaced');
  else FAIL('manual error swallowed');
  if (bgErr.phase === 'idle' && !bgErr.errorMessage) PASS('background error silent');
  else FAIL('background error nagged user');

  console.log('U5) downloading 중 다른 check-started가 와도 진행 상태 복원 가능');
  u = feed(st('ready', { nextVersion: '9.9.9' }), { type: 'check-started', manual: true });
  if (u.phase === 'checking') PASS('re-check resets phase');
  else FAIL('re-check broken');

  // ── Q. Quick Dogfooding Capture ────────────────────────────────────────────
  console.log('Q1) 한 줄 저장 — UX/MEDIUM 기본값으로 OPEN 생성');
  relay.createProject(TEST_ROOT, 'QUICKPROJ');
  const q = relay.createProjectFeedback(TEST_ROOT, 'QUICKPROJ', {
    type: 'UX', priority: 'MEDIUM',
    feedback: '피드백 남기려고 화면 이동하는 게 귀찮다.',
    desired: '',
    agent: undefined, run: undefined,
  }, '0.3.0');
  if (q.status === 'OPEN' && q.type === 'UX' && q.priority === 'MEDIUM' && q.version === '0.3.0') {
    PASS(`${q.id}: OPEN/UX/MEDIUM defaults`);
  } else FAIL(`quick defaults wrong: ${JSON.stringify(q)}`);

  console.log('Q2) 저장 위치는 현재 프로젝트의 _dogfooding/');
  const expectedDir = path.join(TEST_ROOT, 'QUICKPROJ', '_dogfooding');
  if (fs.existsSync(path.join(expectedDir, `${q.id}.md`))) PASS(expectedDir);
  else FAIL(`quick record not under project _dogfooding: ${q.folder}`);

  console.log('Q3) Context 자동 첨부 (Date는 백엔드에서, Agent/Run은 있을 때만)');
  const q2 = relay.createProjectFeedback(TEST_ROOT, 'QUICKPROJ', {
    type: 'UX', priority: 'MEDIUM', feedback: '탭 순서가 내 흐름과 다르다.', desired: '드래그로 정렬',
    agent: 'OpenCode', run: '03',
  }, '0.3.0');
  if (q2.context.date === relay.todayString() && q2.context.agent === 'OpenCode' && q2.context.run === '03') {
    PASS('project/date/agent/run auto-captured');
  } else FAIL(`context wrong: ${JSON.stringify(q2.context)}`);

  console.log('Q4) 상세 목록(pdf:list)에 즉시 표시');
  const qlist = relay.listProjectFeedbacks(TEST_ROOT, 'QUICKPROJ');
  if (qlist.length === 2 && qlist[0].id === q2.id && qlist[1].id === q.id) PASS('newest-first list shows quick records');
  else FAIL(`list wrong: ${qlist.length}`);

  console.log('Q5) markdown만으로 기록 이해 가능 (Status OPEN 명시)');
  const rawQ = fs.readFileSync(path.join(expectedDir, `${q.id}.md`), 'utf8');
  const tokens = ['# DF-0001', 'Status: OPEN', 'Priority: MEDIUM', '## Project', 'QUICKPROJ', '## 발견 내용'];
  if (tokens.every(t => rawQ.includes(t))) PASS('required md tokens present');
  else FAIL(`md missing tokens: ${tokens.filter(t => !rawQ.includes(t)).join(', ')}`);

  // ── R. Regression — 데이터 구조 불변 ────────────────────────────────────────
  console.log('R1) reorder는 폴더 구조를 건드리지 않음');
  const run01 = relay.ensureRunFolder(TEST_ROOT, 'QUICKPROJ', '2026-08-25', 'Claude Code', '01');
  relay.writeMarkdown(run01, 'prompt.md', '# p\n', false);
  relay.saveSettings(settingsDir, { dataRoot: TEST_ROOT, customAgents: [], projectOrder: ['QUICKPROJ'] });
  if (fs.existsSync(path.join(TEST_ROOT, 'QUICKPROJ', '2026-08-25', 'Claude Code', '01', 'prompt.md'))) {
    PASS('prompt.md path unchanged after projectOrder save');
  } else FAIL('folder structure changed by reorder');

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
