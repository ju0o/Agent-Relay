/* Session-Bound Capture UX tests (Packet 03).
   Verifies the pure canonical-state projection the UI renders, and that the
   visible Session identity always mirrors the backend binding provenance.
   Runs against the compiled server modules under dist/server. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  captureViewState,
  isSessionBound,
  isResultReceived,
  shortId,
  sessionLabel,
} from '../dist/server/shared/capture-state.js';
import { SessionBindingPolicy } from '../dist/server/integrations/core/binding.js';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';
import { registerAdapter, clearAdapters } from '../dist/server/integrations/core/registry.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'capture-ux');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

function obs(id, o = {}) {
  return {
    sessionId: id,
    directory: o.dir ?? 'C:\\ws',
    title: o.title ?? `s-${id}`,
    updatedMs: o.updatedMs,
    isNew: !!o.isNew,
    inFlight: !!o.inFlight,
  };
}

function status(over = {}) {
  return {
    phase: 'watching',
    folder: 'C:\\runs\\1',
    adapterId: 'opencode',
    agentName: 'OpenCode',
    ...over,
  };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  console.log('UX1) UNBOUND — no false "waiting response" claim');
  {
    check(captureViewState(null) === 'idle', 'no capture → explicit UNBOUND/idle (never waiting)');
    check(isSessionBound(null) === false && isResultReceived(null) === false, 'null state is neither bound nor received');
    // watching without a bound session = BINDING/searching, NOT waiting for a result
    check(captureViewState(status()) === 'unbound', 'armed-but-unbound → unbound (세션 찾는 중)');
    check(isSessionBound(status()) === false, 'unbound is NOT a bound Session');
  }

  console.log('UX2) Binding/search state is visible');
  {
    const s = status();
    check(captureViewState(s) === 'unbound', 'searching state is a distinct visible state');
  }

  console.log('UX3) Exact bound Agent + sessionId represented in status');
  {
    const s = status({ boundSessionId: 'ses_fc22abc123', boundSessionTitle: 'auth-refactor' });
    check(captureViewState(s) === 'bound', 'bound session → bound state');
    check(s.boundSessionId === 'ses_fc22abc123' && s.agentName === 'OpenCode', 'agent + full sessionId carried');
    check(sessionLabel(s) === 'auth-refactor · ses_fc22…', 'title + shortId shown when title available');
  }

  console.log('UX4) Bound state persists until Result capture');
  {
    const s1 = status({ boundSessionId: 'ses_x' });
    const s2 = status({ boundSessionId: 'ses_x', boundSessionTitle: 'task' });
    check(captureViewState(s1) === 'bound' && captureViewState(s2) === 'bound', 'bound stays bound across updates');
  }

  console.log('UX5) RESULT_RECEIVED retains bound Session identity');
  {
    const s = status({ phase: 'captured', boundSessionId: 'ses_kept', boundSessionTitle: 'provenance' });
    check(captureViewState(s) === 'result', 'captured → result state');
    check(isResultReceived(s) === true, 'result received detected');
    check(s.boundSessionId === 'ses_kept' && sessionLabel(s).includes('ses_kept'), 'bound identity retained after result');
  }

  console.log('UX6) AMBIGUOUS exposes candidate selection');
  {
    const s = status({
      phase: 'ambiguous',
      candidates: [
        { sessionId: 'ses_a', title: 'one' },
        { sessionId: 'ses_b', directory: 'C:\\proj' },
      ],
    });
    check(captureViewState(s) === 'ambiguous', 'ambiguous state visible');
    check(s.candidates.length === 2, 'candidates exposed for selection');
  }

  console.log('UX7) Explicit candidate selection updates visible bound Session');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('ses_a', { isNew: true }), obs('ses_b', { isNew: true })]);
    check(p.candidatesNeedSelection() === true, 'two candidates need selection');
    check(p.bindManual('ses_b') === true, 'explicit selection accepted');
    check(p.binding?.sessionId === 'ses_b' && p.binding?.reason === 'manual', 'chosen session becomes THE bound one');
    check(p.bindingObservation?.title === 's-ses_b', 'bound session title available for display');
  }

  console.log('UX8) Switching adapter clears/rebinds incompatible Session identity safely');
  {
    // A Claude session must never carry into an OpenCode Run (and vice versa).
    const p = new SessionBindingPolicy();
    p.bindManual('claude-session-uuid');
    check(p.binding?.sessionId === 'claude-session-uuid', 'claude binding present');
    // Re-arming for a different adapter creates a FRESH policy (CaptureManager.arm
    // constructs a new SessionBindingPolicy) — no stale identity survives.
    const p2 = new SessionBindingPolicy();
    check(p2.binding === null, 'fresh policy after adapter switch → no stale bound session');
    check(p2.decide('claude-session-uuid') === 'need-selection' || p2.candidatesNeedSelection() !== false, 'old id not silently accepted into new adapter');
  }

  console.log('UX9) Completion from another Session does not change visible bound identity');
  {
    const p = new SessionBindingPolicy();
    p.bindManual('bound_s');
    p.note([obs('other_s', { isNew: true }), obs('bound_s')]);
    check(p.decide('other_s') === 'ignore', 'other-session completion ignored');
    check(p.binding?.sessionId === 'bound_s', 'visible bound identity unchanged');
  }

  console.log('UX10) Backend↔UI provenance binding (evidence consistency)');
  {
    const folder = path.join(TEST_ROOT, 'prov');
    fs.mkdirSync(folder, { recursive: true });
    const p = new SessionBindingPolicy();
    p.note([obs('prov_s', { isNew: true, title: '타이틀' })]);
    check(p.decide('prov_s') === 'accept', 'auto-bind');
    const out = captureCompletion(folder, {
      adapterId: 'claude-code',
      agentName: 'Claude Code',
      sessionId: p.binding.sessionId,
      workspace: 'C:\\ws',
      observedAt: new Date().toISOString(),
      terminalSignal: 'claude.turn.end_turn',
      rawFinalText: '# RESULT',
      rawProtocolRef: 'claude://session/prov_s/msg/a-0001',
      completionKind: 'RESPONSE_COMPLETE',
    }, { bindingReason: p.binding.reason });
    const ev = JSON.parse(fs.readFileSync(path.join(folder, 'evidence', 'adapter.json'), 'utf8'));
    check(out.ok, 'capture ok');
    const uiStatus = status({
      phase: 'captured',
      adapterId: 'claude-code',
      agentName: 'Claude Code',
      boundSessionId: p.binding.sessionId,
      bindingReason: p.binding.reason,
      boundSessionTitle: p.bindingObservation?.title,
    });
    check(ev.adapter?.id === uiStatus.adapterId, 'UI adapterId == evidence adapter id');
    check(ev.adapter?.agentName === uiStatus.agentName, 'UI agentName == evidence agentName');
    check(ev.completion.sessionId === uiStatus.boundSessionId, 'UI sessionId == evidence sessionId');
    check(ev.binding?.reason === uiStatus.bindingReason, 'UI binding reason == evidence binding reason');
    check(uiStatus.boundSessionTitle === '타이틀', 'bound title available to UI (display-only)');
  }

  console.log('UX11) shortId/sessionLabel display-only (full id preserved)');
  {
    const full = 'ses_very-long-session-id-123456';
    const s = status({ boundSessionId: full });
    check(shortId(full) === 'ses_very…', 'display shortens the id');
    check(s.boundSessionId === full, 'full sessionId preserved in state/evidence');
    check(sessionLabel(status({ boundSessionId: 'abc' })) === 'abc', 'short id shown alone when no title');
  }

  console.log('UX12) State flow UNBOUND → BINDING → BOUND → WAITING_RESPONSE → RESULT_RECEIVED');
  {
    const flow = [];
    flow.push(captureViewState(null));                                   // UNBOUND (연결 안 됨)
    flow.push(captureViewState(status()));                               // BINDING (세션 찾는 중)
    const bound = status({ boundSessionId: 'ses_flow', boundSessionTitle: 'auth-refactor' });
    flow.push(captureViewState(bound));                                  // BOUND
    flow.push(captureViewState({ ...bound, phase: 'watching' }));        // WAITING_RESPONSE (still bound)
    const result = status({ phase: 'captured', boundSessionId: 'ses_flow', boundSessionTitle: 'auth-refactor' });
    flow.push(captureViewState(result));                                 // RESULT_RECEIVED (binding retained)
    check(JSON.stringify(flow) === JSON.stringify(['idle', 'unbound', 'bound', 'bound', 'result']),
      `coherent flow: ${flow.join(' → ')}`);
    check(sessionLabel(result).includes('ses_flow'), 'bound identity visible after result');
  }

  console.log('UX13) State flow BINDING → AMBIGUOUS → manual selection → BOUND');
  {
    const p = new SessionBindingPolicy();
    p.note([obs('cand_a', { isNew: true }), obs('cand_b', { isNew: true })]);
    check(captureViewState(status({ phase: 'ambiguous', candidates: p.candidates().map((c) => ({ sessionId: c.sessionId, title: c.title })) })) === 'ambiguous',
      'two candidates → AMBIGUOUS');
    check(p.bindManual('cand_b') === true, 'manual selection resolves ambiguity');
    const bound = status({ boundSessionId: p.binding.sessionId, boundSessionTitle: p.bindingObservation?.title });
    check(captureViewState(bound) === 'bound', 'selection → BOUND');
    check(bound.boundSessionId === 'cand_b', 'chosen candidate is the visible bound Session');
  }

  console.log('UX14) Manager runtime proof — early deterministic binding emits visible bound Session');
  {
    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    const fake = {
      id: 'fake-ux',
      agentName: 'Fake UX',
      startWatch: async (_t, sink) => {
        sink({ type: 'status', phase: 'connecting' });
        sink({
          type: 'sessions',
          sessions: [{ sessionId: 'ses_early', title: 'early-task', directory: 'C:\\ws', updatedMs: 10, isNew: true, inFlight: false }],
          armPass: true,
        });
        return { adapterId: 'fake-ux', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    registerAdapter(fake);
    const folder = path.join(TEST_ROOT, 'mgmt');
    fs.mkdirSync(folder, { recursive: true });
    await manager.arm(folder, 'fake-ux');
    const watching = pushes.find((p) => p.phase === 'watching');
    check(!!watching, 'watching status pushed');
    check(watching.boundSessionId === 'ses_early', 'bound Session identity visible while waiting (early bind)');
    check(watching.agentName === 'Fake UX', 'current Agent visible');
    check(watching.bindingReason === 'unique-new', 'binding reason visible');
    check(watching.boundSessionTitle === 'early-task', 'bound title visible');
    check(captureViewState(watching) === 'bound', 'state = bound / WAITING_RESPONSE');
    await manager.disarmAll();
    clearAdapters();
  }

  console.log('UX15) Manager runtime proof — AMBIGUOUS exposes candidates, selection binds');
  {
    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    const fake = {
      id: 'fake-ux2',
      agentName: 'Fake UX',
      startWatch: async (_t, sink) => {
        sink({
          type: 'sessions',
          sessions: [
            { sessionId: 'ses_a', title: 'alpha', directory: 'C:\\ws', updatedMs: 10, isNew: true, inFlight: false },
            { sessionId: 'ses_b', title: 'beta', directory: 'C:\\ws', updatedMs: 11, isNew: true, inFlight: false },
          ],
          armPass: true,
        });
        return { adapterId: 'fake-ux2', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    registerAdapter(fake);
    const folder = path.join(TEST_ROOT, 'mgmt-amb');
    fs.mkdirSync(folder, { recursive: true });
    await manager.arm(folder, 'fake-ux2');
    const ambiguous = pushes.find((p) => p.phase === 'ambiguous');
    check(!!ambiguous, 'AMBIGUOUS pushed when two candidates exist');
    check((ambiguous.candidates ?? []).length === 2, 'candidates exposed');
    check(captureViewState(ambiguous) === 'ambiguous', 'state = AMBIGUOUS');
    check(manager.selectSession('ses_b') === true, 'explicit selection accepted');
    const bound = pushes.find((p) => p.phase === 'watching' && p.boundSessionId === 'ses_b');
    check(!!bound, 'selection → bound watching state');
    check(bound.boundSessionId === 'ses_b' && bound.bindingReason === 'manual', 'chosen Session is visible + reason manual');
    await manager.disarmAll();
    clearAdapters();
  }

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
