/* Adapter foundation tests (Packet 01).
   Runs against the compiled server modules under dist/server. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as registry from '../dist/server/integrations/core/registry.js';
import { COMPLETION_KINDS } from '../dist/server/integrations/core/types.js';
import { validateAgentCompletion } from '../dist/server/integrations/core/validate.js';
import { captureCompletion, dedupeKeyOf } from '../dist/server/integrations/core/capture.js';
import { summarizeLastTurn, pickLastTurn, messageText } from '../dist/server/integrations/opencode/extract.js';
import { selectCandidateSessions } from '../dist/server/integrations/opencode/watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'opencode');
const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'adapter');

const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

function baseCompletion(overrides = {}) {
  return {
    adapterId: 'opencode',
    agentName: 'OpenCode',
    sessionId: 'ses_test',
    workspace: 'C:\\tmp\\ws',
    observedAt: new Date().toISOString(),
    terminalSignal: 'opencode.message.completed',
    rawFinalText: '# RAW RESULT\n\n한글 · emoji ✅\n```js\nconst x = 1;\n```',
    rawProtocolRef: 'opencode://session/ses_test/message/msg_a02',
    completionKind: 'RESPONSE_COMPLETE',
    ...overrides,
  };
}

function freshFolder(name) {
  const folder = path.join(TEST_ROOT, name);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  console.log('1) 어댑터 등록 (registry)');
  registry.clearAdapters();
  const fakeAdapter = {
    id: 'fake',
    agentName: 'Fake Agent',
    startWatch: async () => ({ adapterId: 'fake', stop: async () => undefined }),
  };
  registry.registerAdapter(fakeAdapter);
  check(registry.getAdapter('fake')?.agentName === 'Fake Agent', 'register/get round-trip');
  let dupRejected = false;
  try { registry.registerAdapter(fakeAdapter); } catch { dupRejected = true; }
  check(dupRejected, 'duplicate registration rejected');
  check(!registry.getAdapter('opencode'), 'unregistered id returns null');

  console.log('2) AgentCompletion 검증');
  for (const kind of COMPLETION_KINDS) {
    if (!validateAgentCompletion(baseCompletion({ completionKind: kind })).valid) FAIL(`kind ${kind} rejected`);
  }
  PASS('all five completionKind values accepted');
  const badOnes = [
    ['missing adapterId', baseCompletion({ adapterId: undefined })],
    ['bad kind', baseCompletion({ completionKind: 'SUCCESS' })],
    ['non-string text', baseCompletion({ rawFinalText: 42 })],
    ['bad observedAt', baseCompletion({ observedAt: 'not-a-date' })],
    ['array input', [1, 2, 3]],
    ['null input', null],
  ];
  const allBad = badOnes.every(([, v]) => !validateAgentCompletion(v).valid);
  check(allBad, 'malformed packets rejected');
  check(validateAgentCompletion(baseCompletion({ sessionId: undefined, exitCode: 0 })).valid, 'optional fields may be absent');

  console.log('3) raw 결과 저장 (agent-result.md 원문 보존)');
  const f3 = freshFolder('capture-raw');
  const c3 = baseCompletion();
  const out3 = captureCompletion(f3, c3);
  check(out3.ok && out3.written.includes('agent-result.md'), 'agent-result.md written');
  const storedRaw = fs.readFileSync(path.join(f3, 'agent-result.md'), 'utf8');
  check(storedRaw === c3.rawFinalText, 'raw content byte-identical (no rewrite/normalize)');
  check(out3.written.includes('result.md'), 'result.md mirror written (v0.3.1 drag workflow)');
  check(fs.readFileSync(path.join(f3, 'result.md'), 'utf8') === c3.rawFinalText, 'result.md content matches raw');
  const evidence = JSON.parse(fs.readFileSync(path.join(f3, 'evidence', 'adapter.json'), 'utf8'));
  check(evidence.adapter.id === 'opencode' && typeof evidence.dedupeKey === 'string', 'evidence/adapter.json written with metadata');
  check(evidence.completion.rawFinalText === undefined, 'rawFinalText not duplicated inside evidence');

  console.log('4) 레거시 Run 호환 (agent-result.md 없는 런)');
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const f4 = path.join(TEST_ROOT, ymd, 'OpenCode', '01');
  fs.rmSync(path.join(TEST_ROOT, ymd), { recursive: true, force: true });
  fs.mkdirSync(f4, { recursive: true });
  fs.writeFileSync(path.join(f4, 'prompt.md'), '# P', 'utf8');
  fs.writeFileSync(path.join(f4, 'result.md'), '# manual legacy result', 'utf8');
  fs.writeFileSync(path.join(f4, 'meta.json'), JSON.stringify({ tags: ['성공'] }, null, 2), 'utf8');
  const relayFs = await import('../dist/server/backend/fs.js');
  const run4 = relayFs.readRun(f4);
  check(run4.result === '# manual legacy result' && run4.tags[0] === '성공', 'legacy run reads exactly as before');
  const hist4 = relayFs.buildHistory(TEST_ROOT, '.').find((h) => h.folder.endsWith('legacy-run') || h.folder.endsWith(path.join('OpenCode', '01')));
  check(hist4?.hasResult === true, 'history still flags hasResult for legacy run');

  console.log('5) 기존 수동 데이터 보존 (자동 수신이 덮어쓰지 않음)');
  const f5 = freshFolder('manual-first');
  fs.writeFileSync(path.join(f5, 'result.md'), '# 사용자가 먼저 저장한 수동 결과', 'utf8');
  fs.writeFileSync(path.join(f5, 'agent-result.md'), '# 이전 자동 결과', 'utf8');
  const out5 = captureCompletion(f5, baseCompletion());
  check(out5.ok, 'capture completes without error');
  check(out5.skipped.includes('result.md') && out5.skipped.includes('agent-result.md'), 'both existing files skipped');
  check(fs.readFileSync(path.join(f5, 'result.md'), 'utf8') === '# 사용자가 먼저 저장한 수동 결과', 'manual result.md untouched');
  check(fs.readFileSync(path.join(f5, 'agent-result.md'), 'utf8') === '# 이전 자동 결과', 'existing agent-result.md untouched');

  console.log('6) 어댑터 실패 시 안전 폴백');
  const f6 = freshFolder('fallback');
  const out6 = captureCompletion(f6, { broken: true });
  check(!out6.ok && out6.written.length === 0, 'invalid packet → no writes, no throw');
  check(fs.readdirSync(f6).length === 0, 'run folder left clean');
  const savedManual = relayFs.writeMarkdown(f6, 'result.md', '# v0.3.1 수동 저장', false);
  check(fs.existsSync(savedManual), 'manual save still works after adapter failure');

  console.log('7) OpenCode 최종 응답 추출 (fixture)');
  const completed = loadFixture('messages-completed-turn.json');
  const s7 = summarizeLastTurn(completed);
  check(s7.ready && s7.kind === 'RESPONSE_COMPLETE', 'completed turn detected');
  check(s7.messageId === 'msg_a02' && s7.sessionId === 'ses_fix01', 'final assistant message identified');
  check(
    s7.text === '파일을 확인하는 중입니다.\n\n## 사용 방법\n\n1. `npm run dev`\n2. DATA_ROOT 선택\n3. 프롬프트 저장 → 결과 드래그\n\n추가 질문이 있으면 알려주세요.',
    'turn narration = ordered non-synthetic text parts across steps'
  );
  check(s7.terminalSignal === 'opencode.message.completed', 'terminal signal set');
  const streaming = summarizeLastTurn(loadFixture('messages-streaming-turn.json'));
  check(!streaming.ready, 'streaming turn not ready (no completed timestamp)');
  const aborted = summarizeLastTurn(loadFixture('messages-aborted-turn.json'));
  check(aborted.ready && aborted.kind === 'INTERRUPTED' && aborted.terminalSignal === 'opencode.message.aborted', 'aborted turn → INTERRUPTED');
  const turnOnly = pickLastTurn([
    { info: { id: 'u1', role: 'user', time: {} }, parts: [] },
    { info: { id: 'a1', role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: 'turn one' }] },
    { info: { id: 'u2', role: 'user', time: {} }, parts: [] },
    { info: { id: 'a2', role: 'assistant', time: { completed: 2 } }, parts: [{ type: 'text', text: 'turn two final' }] },
  ]);
  check(messageText(turnOnly[0]) === 'turn two final', 'pickLastTurn isolates the latest turn only');

  console.log('8) malformed OpenCode 데이터 안전 처리');
  const garbage = [null, 'nope', 123, {}, { info: null }, { info: { role: 'assistant' }, parts: 'x' }, [3, 4], [[[[1]]]]];
  let threw = false;
  let results;
  try {
    results = garbage.map((g) => summarizeLastTurn(g));
  } catch {
    threw = true;
  }
  check(!threw, 'summarizeLastTurn never throws on malformed data');
  if (!threw) check(results.every((r) => r && r.ready === false || r instanceof Object), 'results well-formed');
  const noAssistant = summarizeLastTurn([{ info: { role: 'user' }, parts: [] }]);
  check(noAssistant.ready === false && noAssistant.text === '', 'no-assistant list → not ready, empty text');
  const emptyText = summarizeLastTurn([{ info: { role: 'assistant', time: { completed: 1 } }, parts: [{ type: 'text', text: '   ' }] }]);
  check(emptyText.ready === true && emptyText.text === '', 'whitespace-only text fails safe to empty string');

  console.log('9) 중복 관찰 → 중복/파손 없음');
  const f9 = freshFolder('dedupe');
  const first9 = captureCompletion(f9, baseCompletion());
  const before = fs.readFileSync(path.join(f9, 'agent-result.md'), 'utf8');
  const second9 = captureCompletion(f9, baseCompletion());
  check(second9.duplicate === true && second9.written.length === 0, 'duplicate observation detected via evidence key');
  check(dedupeKeyOf(baseCompletion()) === dedupeKeyOf(baseCompletion()), 'dedupe key deterministic for same ref');
  check(fs.readFileSync(path.join(f9, 'agent-result.md'), 'utf8') === before, 'file bytes unchanged after duplicate');
  const differentTurn = captureCompletion(f9, baseCompletion({
    rawProtocolRef: 'opencode://session/ses_test/message/msg_zzz',
    rawFinalText: '# SECOND TURN',
  }));
  check(differentTurn.ok && differentTurn.duplicate === false, 'new turn recognized as distinct');
  check(differentTurn.skipped.includes('agent-result.md') && differentTurn.skipped.includes('result.md'), 'immutability kept — second turn never rewrites files');

  console.log('10) 세션 후보 선택 (workspace 필터)');
  const sessions = [
    { id: 's1', directory: 'C:\\proj\\alpha', time: { updated: 5000 } },
    { id: 's2', directory: 'C:\\proj\\alpha\\sub', time: { updated: 5000 } },
    { id: 's3', directory: 'C:\\other', time: { updated: 9000 } },
    { id: 's4', directory: 'C:\\proj\\alphabet', time: { updated: 9000 } },
  ];
  const picked = selectCandidateSessions(sessions, { sinceMs: 4000, workspaceRoot: 'C:\\proj\\alpha' }).map((x) => x.id);
  check(JSON.stringify(picked) === JSON.stringify(['s1', 's2']), 'exact dir + subdirs matched, prefix-collision excluded');
  const stale = selectCandidateSessions(sessions, { sinceMs: 8000 }).map((x) => x.id);
  check(JSON.stringify(stale) === JSON.stringify(['s3', 's4']), 'stale sessions filtered by updated time');
  const all = selectCandidateSessions(sessions, { sinceMs: 4000 }).map((x) => x.id);
  check(all.length === 4, 'no workspaceRoot → all sessions eligible');

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
