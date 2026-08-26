/* Session binding tests (Packet 01 — Correction Pass 01).
   Deterministic policy coverage + persistence provenance + legacy fallback.
   Runs against the compiled server modules under dist/server. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionBindingPolicy } from '../dist/server/integrations/core/binding.js';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';
import * as relayFs from '../dist/server/backend/fs.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'binding');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

function obs(id, opts = {}) {
  return {
    sessionId: id,
    directory: opts.dir ?? 'C:\\ws',
    title: opts.title ?? `session-${id}`,
    updatedMs: opts.updatedMs,
    isNew: !!opts.isNew,
    inFlight: !!opts.inFlight,
  };
}

const completionFrom = (sessionId, text) => ({
  adapterId: 'opencode',
  agentName: 'OpenCode',
  sessionId,
  workspace: 'C:\\ws',
  observedAt: new Date().toISOString(),
  terminalSignal: 'opencode.message.completed',
  rawFinalText: text,
  rawProtocolRef: `opencode://session/${sessionId}/message/msg_x`,
  completionKind: 'RESPONSE_COMPLETE',
});

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  console.log('B1) 워크스페이스+후보 1개 → 자동 바인딩 (unique-new)');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('old_a'), obs('old_b')]);
    p.note([obs('new_1', { isNew: true }), obs('old_a')]);
    check(p.decide('old_a') === 'need-selection', 'completion from a non-plausible old session does not capture');
    const d = p.decide('new_1');
    check(d === 'accept', 'unique new session completion accepted');
    check(p.binding?.sessionId === 'new_1' && p.binding?.reason === 'unique-new', 'bound with exact identity + reason');
  }

  console.log('B2) 후보 2개 → 조용히 선택하지 않음');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('cand_1', { isNew: true })]);
    p.note([obs('cand_2', { isNew: true })]);
    check(p.candidatesNeedSelection() === true, 'two new candidates flagged for selection');
    check(p.decide('cand_1') === 'need-selection', 'first completion NOT captured');
    check(p.decide('cand_2') === 'need-selection', 'second completion NOT captured either');
    check(p.candidates().length >= 2, 'picker candidates exposed');
    check(p.isAmbiguous, 'policy reports ambiguous state');
  }

  console.log('B3) 명시적 선택 → 선택한 세션 바인딩');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('x1', { isNew: true }), obs('x2', { isNew: true })]);
    check(p.bindManual('x2') === true, 'manual bind accepted while unresolved');
    check(p.binding?.reason === 'manual' && p.binding?.sessionId === 'x2', 'manual binding recorded');
  }

  console.log('B4) 바인딩되지 않은 세션의 완료는 무시');
  {
    const p = new SessionBindingPolicy();
    p.seedArmInFlight(['solo']);
    p.note([obs('solo'), obs('other_1')]);
    check(p.decide('solo') === 'accept', 'bound session accepted');
    check(p.decide('other_1') === 'ignore' && p.decide('other_2') === 'ignore', 'all other sessions ignored');
  }

  console.log('B5) 바인딩된 세션의 완료는 캡처 대상 (unique-inflight 경로)');
  {
    const p = new SessionBindingPolicy();
    p.seedArmInFlight(['running_only']);
    p.note([obs('running_only'), obs('stale_1')]);
    check(p.binding === null, 'not bound before completion');
    check(p.decide('stale_1') === 'need-selection', 'stray stale completion cannot capture');
    check(p.decide('running_only') === 'accept', 'the unique in-flight session is auto-bound on its completion');
    check(p.binding?.reason === 'unique-inflight', 'in-flight evidence recorded as reason');
  }

  console.log('B6) 바인딩된 세션은 이후 세션으로 교체 불가');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('first_new', { isNew: true })]);
    check(p.decide('first_new') === 'accept', 'initial auto-bind');
    p.note([obs('later_new', { isNew: true })]);
    check(p.decide('later_new') === 'ignore', 'later session ignored after binding');
    check(p.bindManual('later_new') === false && p.binding?.sessionId === 'first_new', 'manual rebind refused; original kept');

    const p2 = new SessionBindingPolicy();
    p2.bindManual('chosen');
    p2.note([obs('impostor', { isNew: true })]);
    check(p2.decide('impostor') === 'ignore', 'even a NEW session cannot steal a manual binding');
  }

  console.log('B7) 중복 완료는 멱등');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('dup_s', { isNew: true })]);
    const r1 = p.decide('dup_s');
    const r2 = p.decide('dup_s');
    check(r1 === 'accept' && r2 === 'accept', 'same-session re-observation stays accept (file-level dedupe below)');
    const folder = path.join(TEST_ROOT, 'dedupe-run');
    fs.mkdirSync(folder, { recursive: true });
    const first = captureCompletion(folder, completionFrom('dup_s', '# SAME TEXT'));
    const second = captureCompletion(folder, completionFrom('dup_s', '# SAME TEXT'));
    check(first.ok && second.duplicate === true, 'duplicate observation → duplicate outcome, no rewrite');
  }

  console.log('B8) 모호성/실패 시 수동 Result 폴백 보존');
  {
    const folder = path.join(TEST_ROOT, 'fallback-run');
    fs.mkdirSync(folder, { recursive: true });
    const p = new SessionBindingPolicy();
    p.note([obs('a1'), obs('b1')]);
    check(p.decide('a1') === 'need-selection', 'ambiguous → nothing captured automatically');
    check(fs.readdirSync(folder).length === 0, 'run folder untouched during ambiguity');
    const manualPath = relayFs.writeMarkdown(folder, 'result.md', '# v0.3.1 수동 결과 저장', false);
    check(fs.existsSync(manualPath), 'manual result.md entry still works exactly as before');
    const late = captureCompletion(folder, completionFrom('a1', '# LATE AUTO'));
    check(late.skipped.includes('result.md'), 'late auto-capture never overwrites manual data');
  }

  console.log('B9) evidence 출처(provenance) 기록');
  {
    const folder = path.join(TEST_ROOT, 'provenance-run');
    const out = captureCompletion(
      folder,
      completionFrom('prov_s', '# PROVENANCE'),
      { bindingReason: 'unique-new' },
    );
    const ev = JSON.parse(fs.readFileSync(path.join(folder, 'evidence', 'adapter.json'), 'utf8'));
    check(out.ok, 'capture ok');
    check(ev.adapterId === undefined || ev.adapter?.id === 'opencode', 'adapter identity present');
    check(ev.completion.sessionId === 'prov_s', 'sessionId in evidence');
    check(typeof ev.dedupeKey === 'string' && ev.dedupeKey.length > 0, 'dedupe key present');
    check(ev.completion.terminalSignal === 'opencode.message.completed', 'terminal signal present');
    check(ev.completion.completionKind === 'RESPONSE_COMPLETE', 'completion kind present');
    check(ev.completion.workspace === 'C:\\ws', 'workspace present');
    check(typeof ev.capturedAt === 'string' && typeof ev.completion.observedAt === 'string', 'timestamps present');
    check(ev.binding?.reason === 'unique-new', 'binding reason recorded');
    check(ev.completion.rawFinalText === undefined, 'raw text not duplicated in evidence');
  }

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
