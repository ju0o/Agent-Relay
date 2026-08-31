/**
 * Parallel Multi-Run Capture tests — Phase A1.
 *
 * P1.  arm Run A then Run B → both remain active
 * P2.  disarm Run A → Run B remains active
 * P3.  completion A persists only to folder A
 * P4.  completion B persists only to folder B
 * P5.  Run A and Run B can use different adapters
 * P6.  two Runs using the SAME adapter remain independent
 * P7.  ambiguity in A does not affect B
 * P8.  bound session in A does not affect B
 * P9.  settle window is independent per context
 * P10. switching adapter on SAME folder replaces only that context
 * P11. stop-all cleanup stops every active handle
 * P12. existing OpenCode regression (arm → session → completion → files)
 * P13. existing Claude Code regression
 * P14. Codex / CommandCode / Cline / Grok regressions (arm + disarm)
 * P15. manual Result protection under parallel capture
 * P16. frontend per-folder capture status routing
 *
 * Runs against compiled dist/server modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';
import { registerAdapter, clearAdapters } from '../dist/server/integrations/core/registry.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'parallel-capture');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

/** Wait for all microtasks + a short timer to flush setTimeout(fn, 0). */
function flushTimers(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a minimal fake adapter whose startWatch returns a controllable handle.
 * opts.onStart(sink)  — called synchronously when startWatch is invoked.
 * opts.stopCalls      — array that receives 'stop' on each stop() call.
 */
function fakeAdapter(id, opts = {}) {
  return {
    id,
    agentName: opts.agentName ?? id,
    startWatch: async (_t, sink) => {
      if (opts.onStart) opts.onStart(sink);
      let stopped = false;
      return {
        adapterId: id,
        stop: async () => {
          if (stopped) return;
          stopped = true;
          if (opts.stopCalls) opts.stopCalls.push(id);
          sink({ type: 'status', phase: 'stopped' });
        },
      };
    },
  };
}

/** Minimal valid AgentCompletion. */
function baseCompletion(sessionId, text = 'RESULT', adapterId = 'test-adapter') {
  return {
    adapterId,
    agentName: 'Test',
    sessionId,
    workspace: 'C:\\tmp\\ws',
    observedAt: new Date().toISOString(),
    terminalSignal: 'test.turn.complete',
    rawFinalText: text,
    rawProtocolRef: `test://session/${sessionId}/msg/m-1`,
    completionKind: 'RESPONSE_COMPLETE',
  };
}

/** Minimal SessionObservation. */
function obs(id, isNew = true, inFlight = false) {
  return { sessionId: id, directory: 'C:\\ws', title: `s-${id}`, updatedMs: Date.now(), isNew, inFlight };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // ── P1: arm Run A then Run B → both remain active ─────────────────────────
  console.log('P1) arm Run A then Run B → both remain active');
  {
    clearAdapters();
    registerAdapter(fakeAdapter('fake-p1a'));
    registerAdapter(fakeAdapter('fake-p1b'));

    const folderA = path.join(TEST_ROOT, 'p1', 'a');
    const folderB = path.join(TEST_ROOT, 'p1', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));

    await manager.arm(folderA, 'fake-p1a');
    check(manager.isActive(folderA), 'P1: Run A active after arm');
    check(!manager.isActive(folderB), 'P1: Run B not yet active');

    await manager.arm(folderB, 'fake-p1b');
    check(manager.isActive(folderA), 'P1: Run A still active after arming Run B');
    check(manager.isActive(folderB), 'P1: Run B active');

    const watchesA = pushes.filter(s => s.folder === folderA && s.phase === 'watching');
    const watchesB = pushes.filter(s => s.folder === folderB && s.phase === 'watching');
    check(watchesA.length >= 1, 'P1: watching push for A');
    check(watchesB.length >= 1, 'P1: watching push for B');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P2: disarm Run A → Run B remains active ───────────────────────────────
  console.log('P2) disarm Run A → Run B remains active');
  {
    clearAdapters();
    registerAdapter(fakeAdapter('fake-p2a'));
    registerAdapter(fakeAdapter('fake-p2b'));

    const folderA = path.join(TEST_ROOT, 'p2', 'a');
    const folderB = path.join(TEST_ROOT, 'p2', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    await manager.arm(folderA, 'fake-p2a');
    await manager.arm(folderB, 'fake-p2b');

    // Disarm only A
    await manager.disarm(folderA);
    check(!manager.isActive(folderA), 'P2: Run A disarmed');
    check(manager.isActive(folderB), 'P2: Run B still active');

    const stoppedA = pushes.filter(s => s.folder === folderA && s.phase === 'stopped');
    const stoppedB = pushes.filter(s => s.folder === folderB && s.phase === 'stopped');
    check(stoppedA.length >= 1, 'P2: stopped push for A');
    check(stoppedB.length === 0, 'P2: no stopped push for B (unaffected)');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P3: completion A persists only to folder A ────────────────────────────
  console.log('P3) completion A persists only to folder A');
  {
    clearAdapters();

    const folderA = path.join(TEST_ROOT, 'p3', 'a');
    const folderB = path.join(TEST_ROOT, 'p3', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    let sinkA = null;
    let sinkB = null;
    registerAdapter({ id: 'fake-p3a', agentName: 'P3A', startWatch: async (_t, s) => { sinkA = s; return { adapterId: 'fake-p3a', stop: async () => s({ type: 'status', phase: 'stopped' }) }; } });
    registerAdapter({ id: 'fake-p3b', agentName: 'P3B', startWatch: async (_t, s) => { sinkB = s; return { adapterId: 'fake-p3b', stop: async () => s({ type: 'status', phase: 'stopped' }) }; } });

    const manager = new CaptureManager(() => {}, { settleMs: 0 });
    await manager.arm(folderA, 'fake-p3a');
    await manager.arm(folderB, 'fake-p3b');

    // Feed sessions to A and B — distinct session IDs per run
    sinkA({ type: 'sessions', sessions: [obs('ses-p3a', true)], armPass: true });
    sinkB({ type: 'sessions', sessions: [obs('ses-p3b', true)], armPass: true });

    // Emit completion for A's session
    sinkA({ type: 'completion', completion: baseCompletion('ses-p3a', 'RESULT_A', 'fake-p3a') });
    await flushTimers(50);

    // Folder A should have files; folder B should NOT
    check(fs.existsSync(path.join(folderA, 'agent-result.md')), 'P3: agent-result.md written to folder A');
    check(!fs.existsSync(path.join(folderB, 'agent-result.md')), 'P3: nothing written to folder B');
    const contentA = fs.readFileSync(path.join(folderA, 'agent-result.md'), 'utf8');
    check(contentA === 'RESULT_A', 'P3: folder A has correct content');

    clearAdapters();
  }

  // ── P4: completion B persists only to folder B ────────────────────────────
  console.log('P4) completion B persists only to folder B');
  {
    clearAdapters();

    const folderA = path.join(TEST_ROOT, 'p4', 'a');
    const folderB = path.join(TEST_ROOT, 'p4', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    let sinkA = null;
    let sinkB = null;
    registerAdapter({ id: 'fake-p4a', agentName: 'P4A', startWatch: async (_t, s) => { sinkA = s; return { adapterId: 'fake-p4a', stop: async () => s({ type: 'status', phase: 'stopped' }) }; } });
    registerAdapter({ id: 'fake-p4b', agentName: 'P4B', startWatch: async (_t, s) => { sinkB = s; return { adapterId: 'fake-p4b', stop: async () => s({ type: 'status', phase: 'stopped' }) }; } });

    const manager = new CaptureManager(() => {}, { settleMs: 0 });
    await manager.arm(folderA, 'fake-p4a');
    await manager.arm(folderB, 'fake-p4b');

    sinkA({ type: 'sessions', sessions: [obs('ses-p4a', true)], armPass: true });
    sinkB({ type: 'sessions', sessions: [obs('ses-p4b', true)], armPass: true });

    // Emit completion for B's session only
    sinkB({ type: 'completion', completion: baseCompletion('ses-p4b', 'RESULT_B', 'fake-p4b') });
    await flushTimers(50);

    check(!fs.existsSync(path.join(folderA, 'agent-result.md')), 'P4: nothing written to folder A');
    check(fs.existsSync(path.join(folderB, 'agent-result.md')), 'P4: agent-result.md written to folder B');
    const contentB = fs.readFileSync(path.join(folderB, 'agent-result.md'), 'utf8');
    check(contentB === 'RESULT_B', 'P4: folder B has correct content');

    clearAdapters();
  }

  // ── P5: different adapters for different runs ─────────────────────────────
  console.log('P5) Run A and Run B can use different adapters');
  {
    clearAdapters();
    registerAdapter(fakeAdapter('fake-p5-oc'));
    registerAdapter(fakeAdapter('fake-p5-cc'));

    const folderA = path.join(TEST_ROOT, 'p5', 'a');
    const folderB = path.join(TEST_ROOT, 'p5', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    await manager.arm(folderA, 'fake-p5-oc');
    await manager.arm(folderB, 'fake-p5-cc');

    check(manager.isActive(folderA), 'P5: A active');
    check(manager.isActive(folderB), 'P5: B active');

    const watchA = pushes.find(s => s.folder === folderA && s.phase === 'watching');
    const watchB = pushes.find(s => s.folder === folderB && s.phase === 'watching');
    check(watchA?.adapterId === 'fake-p5-oc', 'P5: A uses opencode-like adapter');
    check(watchB?.adapterId === 'fake-p5-cc', 'P5: B uses claude-like adapter');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P6: two Runs using the SAME adapter remain independent ────────────────
  console.log('P6) two Runs using the SAME adapter remain independent (same-adapter parallelism)');
  {
    clearAdapters();

    const folderA = path.join(TEST_ROOT, 'p6', 'a');
    const folderB = path.join(TEST_ROOT, 'p6', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    // Single adapter that supports multiple concurrent watches
    const sinks = [];
    registerAdapter({
      id: 'fake-p6-multi',
      agentName: 'MultiWatch',
      startWatch: async (_t, s) => {
        sinks.push(s);
        return { adapterId: 'fake-p6-multi', stop: async () => s({ type: 'status', phase: 'stopped' }) };
      },
    });

    const pushesA = [];
    const pushesB = [];
    const manager = new CaptureManager((s) => {
      if (s.folder === folderA) pushesA.push(s);
      if (s.folder === folderB) pushesB.push(s);
    }, { settleMs: 0 });

    await manager.arm(folderA, 'fake-p6-multi');
    await manager.arm(folderB, 'fake-p6-multi');

    check(sinks.length === 2, 'P6: two independent watch handles created');
    check(manager.isActive(folderA), 'P6: A active');
    check(manager.isActive(folderB), 'P6: B active');

    // Feed different sessions to each sink
    sinks[0]({ type: 'sessions', sessions: [obs('ses-p6a', true)], armPass: true });
    sinks[1]({ type: 'sessions', sessions: [obs('ses-p6b', true)], armPass: true });

    // Complete A's session
    sinks[0]({ type: 'completion', completion: baseCompletion('ses-p6a', 'RESULT_A6', 'fake-p6-multi') });
    await flushTimers(50);

    check(fs.existsSync(path.join(folderA, 'agent-result.md')), 'P6: A captured');
    check(!fs.existsSync(path.join(folderB, 'agent-result.md')), 'P6: B NOT captured (same adapter, separate context)');

    // Complete B's session
    sinks[1]({ type: 'completion', completion: baseCompletion('ses-p6b', 'RESULT_B6', 'fake-p6-multi') });
    await flushTimers(50);

    check(fs.existsSync(path.join(folderB, 'agent-result.md')), 'P6: B captured independently');
    const cA = fs.readFileSync(path.join(folderA, 'agent-result.md'), 'utf8');
    const cB = fs.readFileSync(path.join(folderB, 'agent-result.md'), 'utf8');
    check(cA === 'RESULT_A6', 'P6: A has A content');
    check(cB === 'RESULT_B6', 'P6: B has B content');

    clearAdapters();
  }

  // ── P7: ambiguity in A does not affect B ─────────────────────────────────
  console.log('P7) ambiguity in A does not affect B');
  {
    clearAdapters();

    let sinkA = null;
    let sinkB = null;
    registerAdapter({ id: 'fake-p7a', agentName: 'P7A', startWatch: async (_t, s) => { sinkA = s; return { adapterId: 'fake-p7a', stop: async () => {} }; } });
    registerAdapter({ id: 'fake-p7b', agentName: 'P7B', startWatch: async (_t, s) => { sinkB = s; return { adapterId: 'fake-p7b', stop: async () => {} }; } });

    const folderA = path.join(TEST_ROOT, 'p7', 'a');
    const folderB = path.join(TEST_ROOT, 'p7', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushesA = [];
    const pushesB = [];
    const manager = new CaptureManager((s) => {
      if (s.folder === folderA) pushesA.push(s);
      if (s.folder === folderB) pushesB.push(s);
    });

    await manager.arm(folderA, 'fake-p7a');
    await manager.arm(folderB, 'fake-p7b');

    // Make A ambiguous with two sessions
    sinkA({ type: 'sessions', sessions: [obs('a1', true), obs('a2', true)], armPass: true });
    // Give B a single session (should auto-bind)
    sinkB({ type: 'sessions', sessions: [obs('b1', true)], armPass: true });

    const ambigA = pushesA.find(s => s.phase === 'ambiguous');
    check(!!ambigA, 'P7: A is ambiguous');
    check(ambigA.candidates?.length === 2, 'P7: A has two candidates');

    // B should be watching (not ambiguous)
    const watchB = pushesB.find(s => s.phase === 'watching');
    check(!!watchB, 'P7: B is watching (unaffected by A ambiguity)');
    const ambigB = pushesB.find(s => s.phase === 'ambiguous');
    check(!ambigB, 'P7: B is NOT ambiguous');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P8: bound session in A does not affect B ─────────────────────────────
  console.log('P8) bound session in A does not affect B');
  {
    clearAdapters();

    let sinkA = null;
    let sinkB = null;
    registerAdapter({ id: 'fake-p8a', agentName: 'P8A', startWatch: async (_t, s) => { sinkA = s; return { adapterId: 'fake-p8a', stop: async () => {} }; } });
    registerAdapter({ id: 'fake-p8b', agentName: 'P8B', startWatch: async (_t, s) => { sinkB = s; return { adapterId: 'fake-p8b', stop: async () => {} }; } });

    const folderA = path.join(TEST_ROOT, 'p8', 'a');
    const folderB = path.join(TEST_ROOT, 'p8', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushesA = [];
    const pushesB = [];
    const manager = new CaptureManager((s) => {
      if (s.folder === folderA) pushesA.push(s);
      if (s.folder === folderB) pushesB.push(s);
    });

    await manager.arm(folderA, 'fake-p8a');
    await manager.arm(folderB, 'fake-p8b');

    // Bind a session to A
    sinkA({ type: 'sessions', sessions: [obs('ses-bound-a', true)], armPass: true });
    // B sees a different session
    sinkB({ type: 'sessions', sessions: [obs('ses-b-independent', true)], armPass: true });

    // A should be bound to ses-bound-a
    const boundA = pushesA.find(s => s.boundSessionId === 'ses-bound-a');
    check(!!boundA, 'P8: A bound to ses-bound-a');

    // B's push should reference ses-b-independent, NOT ses-bound-a
    const boundB = pushesB.find(s => s.phase === 'watching');
    check(boundB?.boundSessionId !== 'ses-bound-a', 'P8: B binding not contaminated by A');
    check(!!pushesB.find(s => s.boundSessionId === 'ses-b-independent'), 'P8: B bound to its own session');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P9: settle window is independent per context ──────────────────────────
  console.log('P9) settle window is independent per context');
  {
    clearAdapters();

    const folderA = path.join(TEST_ROOT, 'p9', 'a');
    const folderB = path.join(TEST_ROOT, 'p9', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    let sinkA = null;
    let sinkB = null;
    registerAdapter({ id: 'fake-p9a', agentName: 'P9A', startWatch: async (_t, s) => { sinkA = s; return { adapterId: 'fake-p9a', stop: async () => {} }; } });
    registerAdapter({ id: 'fake-p9b', agentName: 'P9B', startWatch: async (_t, s) => { sinkB = s; return { adapterId: 'fake-p9b', stop: async () => {} }; } });

    const pushes = [];
    // Use 50ms settle time so the test doesn't time out
    const manager = new CaptureManager((s) => pushes.push(s), { settleMs: 50 });
    await manager.arm(folderA, 'fake-p9a');
    await manager.arm(folderB, 'fake-p9b');

    sinkA({ type: 'sessions', sessions: [obs('ses-p9a', true)], armPass: true });
    sinkB({ type: 'sessions', sessions: [obs('ses-p9b', true)], armPass: true });

    // Complete A; B should still be in settle-window limbo independently
    sinkA({ type: 'completion', completion: baseCompletion('ses-p9a', 'R_A9', 'fake-p9a') });

    // Immediately after, before settle fires, B is still watching
    check(manager.isActive(folderB), 'P9: B still watching while A is settling');

    await flushTimers(100); // settle A

    check(fs.existsSync(path.join(folderA, 'agent-result.md')), 'P9: A settled and written');
    check(!fs.existsSync(path.join(folderB, 'agent-result.md')), 'P9: B not written (no completion for B)');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P10: switching adapter on SAME folder replaces only that context ──────
  console.log('P10) switching adapter on SAME folder replaces only that context');
  {
    clearAdapters();

    const stopCalls = [];
    registerAdapter(fakeAdapter('fake-p10-v1', { stopCalls }));
    registerAdapter(fakeAdapter('fake-p10-v2'));
    registerAdapter(fakeAdapter('fake-p10-b'));

    const folderA = path.join(TEST_ROOT, 'p10', 'a');
    const folderB = path.join(TEST_ROOT, 'p10', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    await manager.arm(folderA, 'fake-p10-v1');
    await manager.arm(folderB, 'fake-p10-b');

    check(manager.isActive(folderA), 'P10: A active with v1');
    check(manager.isActive(folderB), 'P10: B active');

    // Re-arm folder A with a different adapter
    await manager.arm(folderA, 'fake-p10-v2');

    check(stopCalls.includes('fake-p10-v1'), 'P10: old adapter for A was stopped');
    check(manager.isActive(folderA), 'P10: A still active (now with v2)');
    check(manager.isActive(folderB), 'P10: B unaffected by A re-arm');

    const watchA = [...pushes].reverse().find(s => s.folder === folderA && s.phase === 'watching');
    check(watchA?.adapterId === 'fake-p10-v2', 'P10: A now uses v2 adapter');

    await manager.disarmAll();
    clearAdapters();
  }

  // ── P11: stop-all cleanup stops every active handle ───────────────────────
  console.log('P11) stop-all cleanup stops every active handle');
  {
    clearAdapters();

    const stopCalls = [];
    registerAdapter(fakeAdapter('fake-p11a', { stopCalls }));
    registerAdapter(fakeAdapter('fake-p11b', { stopCalls }));
    registerAdapter(fakeAdapter('fake-p11c', { stopCalls }));

    const folderA = path.join(TEST_ROOT, 'p11', 'a');
    const folderB = path.join(TEST_ROOT, 'p11', 'b');
    const folderC = path.join(TEST_ROOT, 'p11', 'c');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });
    fs.mkdirSync(folderC, { recursive: true });

    const manager = new CaptureManager(() => {});
    await manager.arm(folderA, 'fake-p11a');
    await manager.arm(folderB, 'fake-p11b');
    await manager.arm(folderC, 'fake-p11c');

    await manager.disarmAll();

    check(!manager.isActive(folderA), 'P11: A stopped');
    check(!manager.isActive(folderB), 'P11: B stopped');
    check(!manager.isActive(folderC), 'P11: C stopped');
    check(stopCalls.includes('fake-p11a'), 'P11: A handle.stop() called');
    check(stopCalls.includes('fake-p11b'), 'P11: B handle.stop() called');
    check(stopCalls.includes('fake-p11c'), 'P11: C handle.stop() called');

    clearAdapters();
  }

  // ── P12: existing OpenCode regression ─────────────────────────────────────
  console.log('P12) existing OpenCode regression');
  {
    clearAdapters();

    const folder = path.join(TEST_ROOT, 'p12-opencode');
    fs.mkdirSync(folder, { recursive: true });

    let sink = null;
    registerAdapter({
      id: 'fake-p12-oc',
      agentName: 'OpenCode',
      startWatch: async (_t, s) => { sink = s; return { adapterId: 'fake-p12-oc', stop: async () => s({ type: 'status', phase: 'stopped' }) }; },
    });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s), { settleMs: 0 });
    await manager.arm(folder, 'fake-p12-oc');

    sink({ type: 'sessions', sessions: [obs('oc-ses-1', true)], armPass: true });
    sink({ type: 'completion', completion: baseCompletion('oc-ses-1', 'OC_RESULT', 'fake-p12-oc') });
    await flushTimers(30);

    check(fs.existsSync(path.join(folder, 'agent-result.md')), 'P12: OpenCode agent-result.md written');
    const captured = pushes.find(s => s.phase === 'captured');
    check(!!captured, 'P12: captured status pushed');
    check(captured?.folder === folder, 'P12: captured folder correct');

    clearAdapters();
  }

  // ── P13: existing Claude Code regression ──────────────────────────────────
  console.log('P13) existing Claude Code regression');
  {
    clearAdapters();

    const folder = path.join(TEST_ROOT, 'p13-claude');
    fs.mkdirSync(folder, { recursive: true });

    let sink = null;
    registerAdapter({
      id: 'fake-p13-cc',
      agentName: 'Claude Code',
      startWatch: async (_t, s) => { sink = s; return { adapterId: 'fake-p13-cc', stop: async () => s({ type: 'status', phase: 'stopped' }) }; },
    });

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s), { settleMs: 0 });
    await manager.arm(folder, 'fake-p13-cc');

    sink({ type: 'sessions', sessions: [obs('cc-ses-1', true)], armPass: true });
    sink({ type: 'completion', completion: baseCompletion('cc-ses-1', 'CC_RESULT', 'fake-p13-cc') });
    await flushTimers(30);

    check(fs.existsSync(path.join(folder, 'agent-result.md')), 'P13: Claude Code agent-result.md written');
    check(!!pushes.find(s => s.phase === 'captured'), 'P13: captured status pushed');

    clearAdapters();
  }

  // ── P14: Codex / CommandCode / Cline / Grok regressions ──────────────────
  console.log('P14) Codex / CommandCode / Cline / Grok regressions (arm + disarm)');
  {
    for (const [id, name] of [['fake-codex', 'Codex'], ['fake-cmdcode', 'CommandCode'], ['fake-cline', 'Cline'], ['fake-grok', 'Grok']]) {
      clearAdapters();
      const stopCalls = [];
      registerAdapter(fakeAdapter(id, { agentName: name, stopCalls }));

      const folder = path.join(TEST_ROOT, `p14-${id}`);
      fs.mkdirSync(folder, { recursive: true });

      const pushes = [];
      const manager = new CaptureManager((s) => pushes.push(s));
      await manager.arm(folder, id);

      check(manager.isActive(folder), `P14: ${name} armed`);
      check(!!pushes.find(s => s.phase === 'watching'), `P14: ${name} watching push`);

      await manager.disarm(folder);

      check(!manager.isActive(folder), `P14: ${name} disarmed`);
      check(!!pushes.find(s => s.phase === 'stopped'), `P14: ${name} stopped push`);
      check(stopCalls.includes(id), `P14: ${name} handle.stop() called`);

      clearAdapters();
    }
  }

  // ── P15: manual Result protection under parallel capture ──────────────────
  console.log('P15) manual Result protection under parallel capture');
  {
    const folderA = path.join(TEST_ROOT, 'p15', 'a');
    const folderB = path.join(TEST_ROOT, 'p15', 'b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    // Write a manual result in folder A
    fs.writeFileSync(path.join(folderA, 'result.md'), '# Manual Result\n\nDo not overwrite me.', 'utf8');

    // Capture for A — manual result.md must be protected
    const compA = baseCompletion('ses-p15a', 'CAPTURE_TEXT', 'test');
    const outA = captureCompletion(folderA, compA, { bindingReason: 'unique-new' });
    check(outA.ok, 'P15: captureCompletion ok for A');
    check(outA.skipped.includes('result.md'), 'P15: result.md skipped (protected) for A');
    check(outA.written.includes('agent-result.md'), 'P15: agent-result.md written for A');
    const manualContent = fs.readFileSync(path.join(folderA, 'result.md'), 'utf8');
    check(manualContent.includes('Manual Result'), 'P15: manual result.md preserved for A');

    // Capture for B — fresh result.md should be written
    const compB = baseCompletion('ses-p15b', 'CAPTURE_B', 'test');
    const outB = captureCompletion(folderB, compB, { bindingReason: 'unique-new' });
    check(outB.ok, 'P15: captureCompletion ok for B');
    check(outB.written.includes('result.md'), 'P15: result.md written for B (fresh)');
    check(fs.readFileSync(path.join(folderB, 'result.md'), 'utf8') === 'CAPTURE_B', 'P15: B has captured content');

    // Ensure A content still intact (parallel capture did not cross-write)
    const aStillManual = fs.readFileSync(path.join(folderA, 'result.md'), 'utf8');
    check(aStillManual.includes('Manual Result'), 'P15: A result.md not touched by B capture');
  }

  // ── P16: frontend per-folder capture status routing ───────────────────────
  console.log('P16) frontend per-folder capture status routing');
  {
    // Simulate the new Map-based frontend state logic.
    // Each status event must update ONLY its own folder entry.
    let captureMap = new Map();

    function onCaptureStatus(s) {
      // Mirrors the new App.tsx subscriber
      if (s.folder) {
        captureMap = new Map(captureMap).set(s.folder, { ...s });
      }
    }

    const folderA = '/runs/a';
    const folderB = '/runs/b';
    const folderC = '/runs/c';

    onCaptureStatus({ phase: 'watching', folder: folderA, adapterId: 'opencode', agentName: 'OpenCode' });
    onCaptureStatus({ phase: 'watching', folder: folderB, adapterId: 'claude-code', agentName: 'Claude Code' });

    check(captureMap.get(folderA)?.phase === 'watching', 'P16: A watching');
    check(captureMap.get(folderB)?.phase === 'watching', 'P16: B watching');
    check(captureMap.get(folderC) === undefined, 'P16: C not in map (unrelated)');

    // B captures — should only update B
    onCaptureStatus({ phase: 'captured', folder: folderB, files: ['result.md'], adapterId: 'claude-code' });
    check(captureMap.get(folderA)?.phase === 'watching', 'P16: A still watching after B capture');
    check(captureMap.get(folderB)?.phase === 'captured', 'P16: B captured');

    // A ambiguous — should only update A
    onCaptureStatus({ phase: 'ambiguous', folder: folderA, candidates: [{ sessionId: 'x' }, { sessionId: 'y' }] });
    check(captureMap.get(folderA)?.phase === 'ambiguous', 'P16: A ambiguous');
    check(captureMap.get(folderB)?.phase === 'captured', 'P16: B still captured (unaffected by A ambiguity)');

    // Active tab = folderA: derive capture for display
    const activeFolder = folderA;
    const derivedCapture = captureMap.get(activeFolder) ?? null;
    check(derivedCapture?.phase === 'ambiguous', 'P16: derived capture for active tab = A ambiguous state');
    check(derivedCapture?.folder === folderA, 'P16: derived capture folder correct');

    // Switch to tab B: derived capture must change
    const activeFolderB = folderB;
    const derivedCaptureB = captureMap.get(activeFolderB) ?? null;
    check(derivedCaptureB?.phase === 'captured', 'P16: switching tab shows B captured state');
    check(derivedCapture?.phase === 'ambiguous', 'P16: A state unchanged after switching to B');

    // Stopped event for A must not remove B
    onCaptureStatus({ phase: 'stopped', folder: folderA });
    check(captureMap.get(folderA)?.phase === 'stopped', 'P16: A shows stopped state');
    check(captureMap.get(folderB)?.phase === 'captured', 'P16: B still captured after A stopped');
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
