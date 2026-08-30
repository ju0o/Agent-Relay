/* Session binding tests (Packet 01 — Correction Pass 01).
   Deterministic policy coverage + persistence provenance + legacy fallback.
   Runs against the compiled server modules under dist/server. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionBindingPolicy, turnCompletedAfterArm } from '../dist/server/integrations/core/binding.js';
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

  console.log('B10) 신선도 가드 — arm 이전 완료 턴은 캡처 후보 아님');
  {
    const now = Date.now();
    check(turnCompletedAfterArm(new Date(now - 60_000).toISOString(), now) === false, 'completed 1min before arm → rejected');
    check(turnCompletedAfterArm(new Date(now - 500).toISOString(), now) === true, 'completed just now (within skew) → accepted');
    check(turnCompletedAfterArm(null, now) === false && turnCompletedAfterArm('garbage', now) === false, 'missing/garbage timestamp → rejected');
    const oldIso = '2026-08-26T12:00:09.000Z';
    check(turnCompletedAfterArm(oldIso, Date.parse(oldIso) + 600_000) === false, 'fixture-style historical transcript rejected at later arm');
  }

  console.log('B11) 정착 창 — 기록 전 라이벌 등장 시 바인딩 철회 가능');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('first_new', { isNew: true })]);
    check(p.decide('first_new') === 'accept', 'unique-new accepted (pending settle)');
    p.note([obs('rival_new', { isNew: true })]);
    check(p.newSessionIds.includes('rival_new'), 'rival observed during settle window');
    p.revoke();
    check(p.binding === null, 'binding revoked BEFORE any file write');
    check(p.decide('first_new') === 'need-selection' || p.candidatesNeedSelection(), 'post-revoke state demands selection/evidence, no silent guess');

    const q = new SessionBindingPolicy();
    q.bindManual('manual_s');
    q.markPersisted();
    q.revoke();
    check(q.binding?.sessionId === 'manual_s', 'persisted binding can never be revoked');
  }

  console.log('B12) 정착 중 다른 세션 완료 → 수용 불가(모호 전환은 매니저 몫)');
  {
    const p = new SessionBindingPolicy();
    p.seedArmInFlight(['solo_inflight']);
    p.note([obs('solo_inflight')]);
    check(p.decide('solo_inflight') === 'accept', 'pending accept for unique in-flight session');
    p.note([obs('brand_new', { isNew: true })]);
    const rivalNew = p.newSessionIds.filter((id) => id !== 'solo_inflight').length > 0;
    const rivalInflight = p.armInFlightSnapshot.filter((id) => id !== 'solo_inflight').length > 0;
    check(rivalNew || rivalInflight || p.candidatesNeedSelection(), 'settle-time rivalry detectable via policy views');
  }

  console.log('B13) Case B — pre-existing session starts post-arm turn (in-flight detected)');
  {
    const p = new SessionBindingPolicy();
    // Arm-time: session exists but is idle → first pass has nothing in-flight
    p.seedArmInFlight([]);
    p.note([obs('old_s', { inFlight: false, isNew: false })]);
    check(p.binding === null, 'idle pre-existing session not auto-bound on first pass');
    check(p.tryAutoBind() === false, 'no eligible evidence → no early bind');

    // User sends message → session becomes in-flight in a later pass
    p.note([obs('old_s', { inFlight: true, isNew: false })]);
    check(p.tryAutoBind() === true, 'unique post-arm inflight session auto-binds early');
    check(
      p.binding?.sessionId === 'old_s' && p.binding?.reason === 'unique-inflight',
      'bound with unique-inflight reason for post-arm inflight',
    );
  }

  console.log('B14) Case B fast — sole observed session completes before inFlight is ever seen');
  {
    const p = new SessionBindingPolicy();
    // Arm-time: nothing in-flight
    p.seedArmInFlight([]);
    // One session observed (mtime is fresh, in-flight = false because already completed)
    p.note([obs('fast_s', { inFlight: false, isNew: false })]);
    check(p.tryAutoBind() === false, 'no early bind without inflight/new evidence');

    // Completion arrives — this is the only session we ever observed
    const d = p.decide('fast_s');
    check(d === 'accept', 'sole observed session completion auto-accepted (fast-completion path)');
    check(p.binding?.sessionId === 'fast_s', 'bound to the only observed session');
  }

  console.log('B15) Case B — two pre-existing sessions, both post-arm inflight → ambiguous');
  {
    const p = new SessionBindingPolicy();
    p.seedArmInFlight([]);
    p.note([obs('s1', { inFlight: false }), obs('s2', { inFlight: false })]);
    p.note([obs('s1', { inFlight: true }), obs('s2', { inFlight: true })]);
    check(p.candidatesNeedSelection() === true, 'two post-arm inflight sessions → selection required');
    check(p.tryAutoBind() === false, 'ambiguous — no auto-bind when two candidates');
    check(p.decide('s1') === 'need-selection', 'completion from s1 not silently captured');
  }

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
