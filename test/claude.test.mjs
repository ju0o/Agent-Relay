/* Claude Code adapter tests (Packet 02).
   Deterministic fixture coverage + cross-adapter binding reuse + fallback.
   Runs against the compiled server modules under dist/server. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeClaudeTranscript } from '../dist/server/integrations/claude/extract.js';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';
import { SessionBindingPolicy } from '../dist/server/integrations/core/binding.js';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'claude');
const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'claude');

const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));
const loadFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function obs(id, o = {}) {
  return {
    sessionId: id, directory: o.dir ?? 'C:\\ws', title: `s-${id}`,
    updatedMs: o.updatedMs, isNew: !!o.isNew, inFlight: !!o.inFlight,
  };
}
const claudeCompletion = (sessionId, text) => ({
  adapterId: 'claude-code',
  agentName: 'Claude Code',
  sessionId,
  workspace: 'C:\\ws',
  observedAt: new Date().toISOString(),
  terminalSignal: 'claude.turn.end_turn',
  rawFinalText: text,
  rawProtocolRef: `claude://session/${sessionId}/msg/a-0002`,
  completionKind: 'RESPONSE_COMPLETE',
});

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  console.log('C1) 어댑터 등록 (claude-code + opencode 공존)');
  const manager = new CaptureManager(() => undefined);
  const ids = manager.listAdapters().map((a) => a.id).sort();
  check(ids.includes('claude-code') && ids.includes('opencode'), `registry holds both adapters: [${ids.join(', ')}]`);
  check(manager.listAdapters().find((a) => a.id === 'claude-code')?.agentName === 'Claude Code', 'agentName = Claude Code');

  console.log('C2) 유효 최종 응답 추출 (fixture)');
  {
    const s = summarizeClaudeTranscript(loadFixture('transcript-completed.jsonl'));
    check(s.ready && s.hasTurn, 'completed turn detected');
    check(s.kind === 'RESPONSE_COMPLETE' && s.terminalSignal === 'claude.turn.end_turn', 'end_turn → RESPONSE_COMPLETE');
    check(s.sessionId === '9f1c2a44-1111-4a5a-9a01-000000000001', 'sessionId read from entries');
    check(s.cwd === 'C:\\ws\\demo', 'workspace cwd mapped');
    check(s.title === 'README 요약 세션', 'ai-title captured');
    check(
      s.text === '파일을 먼저 확인하겠습니다.\n\n## 사용 방법\n\n1. npm run dev 실행\n2. DATA_ROOT 선택\n\n> 참고: ```코드 블록```도 그대로 보존됩니다.',
      'turn narration = ordered text blocks; thinking/tool_use excluded'
    );
    check(s.messageId === 'a-0002', 'final assistant uuid identified');
    const streaming = summarizeClaudeTranscript(loadFixture('transcript-streaming.jsonl'));
    check(!streaming.ready && streaming.hasTurn && streaming.inFlightCheck !== undefined || !streaming.ready, 'streaming transcript not ready');
  }

  console.log('C3) malformed/partial 프로토콜 안전');
  {
    let threw = false;
    let results;
    try {
      results = [
        summarizeClaudeTranscript(''),
        summarizeClaudeTranscript('not json at all\n{"type":"user"'),
        summarizeClaudeTranscript('{"type":"assistant","message":{"stop_reason":"end_turn"}}'),
        summarizeClaudeTranscript('[1,2,3]'),
        summarizeClaudeTranscript(null),
      ];
    } catch {
      threw = true;
    }
    check(!threw, 'never throws on malformed input');
    if (!threw) check(results.every((r) => r && typeof r.ready === 'boolean'), 'well-formed results');
    const partialTail = loadFixture('transcript-completed.jsonl').slice(0, -40);
    const sp = summarizeClaudeTranscript(partialTail);
    check(sp.ready === true && sp.messageId === 'a-0002', 'truncated trailing line tolerated (earlier entries intact)');
    check(summarizeClaudeTranscript(loadFixture('transcript-streaming.jsonl')).ready === false, 'no end_turn → not ready');
  }

  console.log('C4) 정확한 세션 바인딩 (기존 정책 재사용 — unique-new)');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('old_opencode_session'), obs('claude_target', { dir: 'C:\\ws\\demo', isNew: true })]);
    check(p.decide('old_opencode_session') === 'need-selection', 'unrelated old session cannot capture');
    check(p.decide('claude_target') === 'accept', 'the single new Claude session auto-binds');
    check(p.binding?.sessionId === 'claude_target', 'exact identity bound');
  }

  console.log('C5) 무관한 세션 무시 (바인딩 후)');
  {
    const p = new SessionBindingPolicy();
    p.bindManual('claude_bound');
    p.note([obs('claude_bound', { dir: 'C:\\ws\\demo' }), obs('other_claude_1'), obs('other_claude_2', { isNew: true })]);
    check(p.decide('other_claude_2') === 'ignore', 'even a NEWER session is ignored once bound');
    check(p.decide('claude_bound') === 'accept', 'bound session still accepted');
  }

  console.log('C6) 모호성 → 조용히 추측하지 않음');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('c1', { isNew: true }), obs('c2', { isNew: true })]);
    check(p.candidatesNeedSelection() === true, 'selection required for two candidates');
    check(p.decide('c1') === 'need-selection' && p.decide('c2') === 'need-selection', 'neither candidate silently captured');
  }

  console.log('C7) 바인딩된 세션 완료 캡처 (서비스 레벨 저장 포함)');
  {
    const folder = path.join(TEST_ROOT, 'bound-capture');
    fs.mkdirSync(folder, { recursive: true });
    const rawText = '## 사용 방법\n\n1. 실행\n2. 선택\n\n```js\nconst ok = true;\n```\n한글·이모지 ✅';
    const p = new SessionBindingPolicy();
    p.note([obs('cs_1', { isNew: true })]);
    check(p.decide('cs_1') === 'accept', 'completion accepted by policy');
    const out = captureCompletion(folder, claudeCompletion('cs_1', rawText), { bindingReason: p.binding.reason });
    check(out.ok && out.written.includes('agent-result.md'), 'agent-result.md written');
    check(fs.readFileSync(path.join(folder, 'agent-result.md'), 'utf8') === rawText, 'raw final text byte-identical');
    check(fs.readFileSync(path.join(folder, 'result.md'), 'utf8') === rawText, 'result.md mirror for GPT drag workflow');
    const ev = JSON.parse(fs.readFileSync(path.join(folder, 'evidence', 'adapter.json'), 'utf8'));
    check(ev.adapter?.id === 'claude-code' && ev.completion.sessionId === 'cs_1', 'provenance: adapter + sessionId');
    check(ev.binding?.reason === 'unique-new', 'provenance: binding reason');
  }

  console.log('C8) 중복 완료 멱등');
  {
    const folder = path.join(TEST_ROOT, 'dup');
    captureCompletion(folder, claudeCompletion('dup_s', '# SAME'));
    const again = captureCompletion(folder, claudeCompletion('dup_s', '# SAME'));
    check(again.duplicate === true && again.written.length === 0, 'duplicate observation → no rewrite');
  }

  console.log('C9) 원문 보존 (개행/한글/백틱/공백)');
  {
    const folder = path.join(TEST_ROOT, 'raw');
    const weird = '줄1\n\n  들여쓰기 유지\n```\n| 표 | |\n'; 
    captureCompletion(folder, claudeCompletion('raw_s', weird), { bindingReason: 'manual' });
    check(fs.readFileSync(path.join(folder, 'agent-result.md'), 'utf8') === weird, 'byte-for-byte preserved');
  }

  console.log('C10) 레거시/수동 Result 폴백 보존');
  {
    const folder = path.join(TEST_ROOT, 'fallback');
    fs.mkdirSync(folder, { recursive: true });
    const manual = path.join(folder, 'result.md');
    fs.writeFileSync(manual, '# 수동 결과 (v0.3.1 그대로)', 'utf8');
    const late = captureCompletion(folder, claudeCompletion('late_s', '# LATE'));
    check(late.ok && late.skipped.includes('result.md'), 'existing manual result.md never overwritten');
    check(fs.readFileSync(manual, 'utf8') === '# 수동 결과 (v0.3.1 그대로)', 'manual content intact');
  }

  console.log('C11) 크로스 어댑터 — 동일 코어 정책이 양쪽을 처리');
  {
    const p = new SessionBindingPolicy();
    p.note([
      obs('oc_new', { isNew: true, dir: 'C:\\ws-a' }),
      { sessionId: 'cl_new', directory: 'C:\\ws-b', title: 'claude', updatedMs: 5, isNew: true, inFlight: false },
    ]);
    check(p.candidatesNeedSelection() === true, 'two new sessions across DIFFERENT adapters → selection, no guessing');
    const p2 = new SessionBindingPolicy();
    p2.note([{ sessionId: 'only_one', directory: 'X', isNew: true }]);
    check(p2.decide('only_one') === 'accept', 'adapter-agnostic identity decision');
  }

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
