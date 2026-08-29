/**
 * Capture result refresh tests — Owner Dogfood Correction 02.
 *
 * Proves the complete file→state refresh pipeline:
 *   1. captureCompletion writes result.md (including when result.md was empty)
 *   2. captured event carries result.md in `files`
 *   3. Frontend logic refreshes the editor result pane correctly
 *   4. Data-safety: unsaved manual edits are protected
 *
 * Covers the exact owner scenario:
 *   - saveTabBoth before capture → empty result.md on disk
 *   - OpenCode completes → captureCompletion must overwrite empty result.md
 *   - files includes 'result.md' → frontend refreshes result pane
 *
 * Runs against compiled dist/server modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureCompletion } from '../dist/server/integrations/core/capture.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'capture-result-refresh');

const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

/** Minimal valid AgentCompletion for testing. */
function baseCompletion(text = 'OPENCODE_OWNER_CAPTURE_OK', overrides = {}) {
  return {
    adapterId: 'opencode',
    agentName: 'OpenCode',
    sessionId: `ses_${Date.now()}`,
    workspace: 'C:\\tmp\\ws',
    observedAt: new Date().toISOString(),
    terminalSignal: 'opencode.message.completed',
    rawFinalText: text,
    rawProtocolRef: `opencode://session/ses_test/msg/m-${Date.now()}`,
    completionKind: 'RESPONSE_COMPLETE',
    ...overrides,
  };
}

// ── Pure frontend logic simulation ──────────────────────────────────────────
//
// Mirrors the logic in App.tsx handleCapturedStatus + setSessions updater.
// Extracted as a pure function so it can be tested without React.
//
// Input:  sessions (array of {tabs}), captured event (folder + files), resultContent
// Output: updated sessions array
//
// This matches the EXACT guard introduced in the fix:
//   if (tab.result && !tab.resultSaved) return sess; // protect unsaved manual edits
//
function applyCapture(sessions, capturedEvent, resultContent) {
  const { folder, files } = capturedEvent;
  if (!files.includes('result.md')) {
    // result.md was skipped (non-empty manual content on disk) — pane not updated.
    return sessions;
  }
  return sessions.map(sess => {
    const idx = sess.tabs.findIndex(t => t.folder === folder);
    if (idx < 0) return sess;
    const tab = sess.tabs[idx];
    // Data-safety guard: don't overwrite unsaved manual content.
    if (tab.result && !tab.resultSaved) return sess;
    const nextTabs = [...sess.tabs];
    nextTabs[idx] = { ...tab, result: resultContent, resultSaved: true };
    return { ...sess, tabs: nextTabs };
  });
}

/** Build a minimal session/tab for testing. */
function makeSession(tabs) {
  return { id: 'sess-1', tabs };
}

function makeTab(overrides = {}) {
  return {
    id: 'tab-1',
    folder: '',
    result: '',
    resultSaved: false,
    prompt: '',
    promptSaved: false,
    ...overrides,
  };
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  // ── A. CAPTURE PERSISTENCE TESTS ─────────────────────────────────────────

  console.log('A1) Fresh run (no result.md) → capture writes result.md');
  {
    const folder = path.join(TEST_ROOT, 'a1-fresh');
    fs.mkdirSync(folder, { recursive: true });
    const out = captureCompletion(folder, baseCompletion('OPENCODE_OWNER_CAPTURE_OK'));
    check(out.ok, 'captureCompletion ok');
    check(out.written.includes('result.md'), 'result.md in written');
    check(!out.skipped.includes('result.md'), 'result.md not in skipped');
    check(!out.duplicate, 'not duplicate');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === 'OPENCODE_OWNER_CAPTURE_OK', 'result.md has captured text');
    const agentContent = fs.readFileSync(path.join(folder, 'agent-result.md'), 'utf8');
    check(agentContent === 'OPENCODE_OWNER_CAPTURE_OK', 'agent-result.md has captured text');
  }

  console.log('A2) OWNER SCENARIO: empty result.md (from saveTabBoth) → capture overwrites it');
  {
    const folder = path.join(TEST_ROOT, 'a2-empty-result');
    fs.mkdirSync(folder, { recursive: true });
    // Simulate saveTabBoth with empty result (Ctrl+S before entering any result)
    fs.writeFileSync(path.join(folder, 'prompt.md'), '# Test Prompt\n', 'utf8');
    fs.writeFileSync(path.join(folder, 'result.md'), '', 'utf8'); // empty result.md

    const out = captureCompletion(folder, baseCompletion('OPENCODE_OWNER_CAPTURE_OK'));
    check(out.ok, 'captureCompletion ok despite empty result.md');
    check(out.written.includes('result.md'), 'empty result.md → overwritten → in written');
    check(!out.skipped.includes('result.md'), 'not skipped (was empty, not manual content)');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === 'OPENCODE_OWNER_CAPTURE_OK', 'result.md now has captured text');
  }

  console.log('A3) result.md with whitespace-only → also overwritten (no manual content)');
  {
    const folder = path.join(TEST_ROOT, 'a3-whitespace-result');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'result.md'), '   \n  \t  \n', 'utf8'); // whitespace only

    const out = captureCompletion(folder, baseCompletion('NEW_CONTENT'));
    check(out.ok, 'captureCompletion ok');
    check(out.written.includes('result.md'), 'whitespace-only result.md → overwritten');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === 'NEW_CONTENT', 'result.md has new captured content');
  }

  console.log('A4) result.md with manual content → protected (not overwritten)');
  {
    const folder = path.join(TEST_ROOT, 'a4-manual-result');
    fs.mkdirSync(folder, { recursive: true });
    const manualContent = '# Manual result from GPT drag\n\nSome actual content here.';
    fs.writeFileSync(path.join(folder, 'result.md'), manualContent, 'utf8');

    const out = captureCompletion(folder, baseCompletion('CAPTURE_TEXT'));
    check(out.ok, 'captureCompletion ok');
    check(out.skipped.includes('result.md'), 'result.md with content → skipped (protected)');
    check(!out.written.includes('result.md'), 'result.md not in written');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === manualContent, 'manual result.md content preserved');
  }

  console.log('A5) agent-result.md already exists (prior capture) → skipped; result.md fresh → written');
  {
    const folder = path.join(TEST_ROOT, 'a5-prior-capture');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'agent-result.md'), 'PRIOR_CAPTURE', 'utf8');
    // result.md absent → fresh → should be written

    const out = captureCompletion(folder, baseCompletion('NEW_CAPTURE'));
    check(out.ok, 'captureCompletion ok');
    check(out.skipped.includes('agent-result.md'), 'agent-result.md skipped (prior capture)');
    check(out.written.includes('result.md'), 'result.md written (fresh)');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === 'NEW_CAPTURE', 'result.md has new capture');
  }

  console.log('A6) Duplicate capture event → deduplicated (no double write)');
  {
    const folder = path.join(TEST_ROOT, 'a6-dedupe');
    fs.mkdirSync(folder, { recursive: true });
    const completion = baseCompletion('DEDUPE_TEST');
    const out1 = captureCompletion(folder, completion);
    check(out1.ok && !out1.duplicate, 'first capture ok, not duplicate');
    const out2 = captureCompletion(folder, completion);
    check(out2.ok && out2.duplicate, 'second capture → duplicate detected');
    check(out2.written.length === 0, 'no files written on duplicate');
    // Content unchanged
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === 'DEDUPE_TEST', 'result.md content unchanged on duplicate');
  }

  // ── B. FRONTEND STATE SIMULATION TESTS ───────────────────────────────────

  console.log('B1) Empty clean result pane → capture refreshes it');
  {
    const folder = '/run/01';
    const tab = makeTab({ folder, result: '', resultSaved: false });
    const sessions = [makeSession([tab])];
    const capturedEvent = { folder, files: ['agent-result.md', 'result.md', 'evidence/adapter.json'] };
    const updated = applyCapture(sessions, capturedEvent, 'OPENCODE_OWNER_CAPTURE_OK');
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === 'OPENCODE_OWNER_CAPTURE_OK', 'result pane refreshed with captured text');
    check(updatedTab.resultSaved === true, 'resultSaved set to true after auto-refresh');
  }

  console.log('B2) Capture for a DIFFERENT run folder → active tab unaffected');
  {
    const activeFolder = '/run/01';
    const capturedFolder = '/run/02'; // different run
    const tab = makeTab({ folder: activeFolder, result: '', resultSaved: false });
    const sessions = [makeSession([tab])];
    const capturedEvent = { folder: capturedFolder, files: ['result.md'] };
    const updated = applyCapture(sessions, capturedEvent, 'OTHER_RUN_RESULT');
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === '', 'active tab result unchanged (wrong run)');
    check(updatedTab.resultSaved === false, 'resultSaved unchanged');
  }

  console.log('B3) Unsaved manual result → NOT silently overwritten (data-safety guard)');
  {
    const folder = '/run/01';
    // User typed in the result pane but did not save
    const tab = makeTab({ folder, result: 'My manual draft — do not destroy', resultSaved: false });
    const sessions = [makeSession([tab])];
    const capturedEvent = { folder, files: ['result.md'] };
    const updated = applyCapture(sessions, capturedEvent, 'CAPTURED_CONTENT');
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === 'My manual draft — do not destroy', 'manual draft preserved');
    check(updatedTab.resultSaved === false, 'resultSaved unchanged (still unsaved)');
  }

  console.log('B4) result.md in skipped (not in files) → pane not updated');
  {
    const folder = '/run/01';
    const tab = makeTab({ folder, result: '', resultSaved: false });
    const sessions = [makeSession([tab])];
    // result.md was skipped (had manual content on disk) → not in files
    const capturedEvent = { folder, files: ['agent-result.md', 'evidence/adapter.json'] };
    const updated = applyCapture(sessions, capturedEvent, 'CAPTURED');
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === '', 'pane not updated when result.md skipped');
  }

  console.log('B5) Previously saved result pane (resultSaved=true) → refreshed with new capture');
  {
    const folder = '/run/01';
    // User opened an old run from history — result already loaded and saved
    const tab = makeTab({ folder, result: 'Old saved result', resultSaved: true });
    const sessions = [makeSession([tab])];
    const capturedEvent = { folder, files: ['result.md'] };
    const updated = applyCapture(sessions, capturedEvent, 'NEW_CAPTURED_CONTENT');
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === 'NEW_CAPTURED_CONTENT', 'saved pane refreshed with new capture');
    check(updatedTab.resultSaved === true, 'resultSaved remains true');
  }

  console.log('B6) Duplicate captured event → second call is harmless (idempotent pane state)');
  {
    const folder = '/run/01';
    const tab = makeTab({ folder, result: '', resultSaved: false });
    const sessions = [makeSession([tab])];
    const capturedEvent = { folder, files: ['result.md'] };
    // First capture
    const s1 = applyCapture(sessions, capturedEvent, 'CAPTURED_TEXT');
    // Second capture (duplicate event) — same content, same files
    const s2 = applyCapture(s1, capturedEvent, 'CAPTURED_TEXT');
    const tab2 = s2[0].tabs[0];
    check(tab2.result === 'CAPTURED_TEXT', 'result unchanged after duplicate event');
    check(tab2.resultSaved === true, 'resultSaved still true');
  }

  console.log('B7) Multiple sessions — only matching session/tab updated');
  {
    const folder1 = '/run/01';
    const folder2 = '/run/02';
    const tab1 = makeTab({ id: 'tab-1', folder: folder1, result: '', resultSaved: false });
    const tab2 = makeTab({ id: 'tab-2', folder: folder2, result: '', resultSaved: false });
    const sess1 = { id: 'sess-1', tabs: [tab1] };
    const sess2 = { id: 'sess-2', tabs: [tab2] };
    const capturedEvent = { folder: folder1, files: ['result.md'] };
    const updated = applyCapture([sess1, sess2], capturedEvent, 'SESS1_RESULT');
    // sess1/tab1 updated
    check(updated[0].tabs[0].result === 'SESS1_RESULT', 'session 1 tab updated');
    // sess2/tab2 NOT updated
    check(updated[1].tabs[0].result === '', 'session 2 tab NOT updated (different folder)');
  }

  console.log('B8) Manual result preserved — existing save workflow unaffected');
  {
    // Simulate: user typed result, saved it (resultSaved=true), capture fires
    // Saved result = non-empty, resultSaved = true → treat as saved (refresh allowed)
    // BUT the key protection is against resultSaved=false (manual unsaved edits)
    const folder = '/run/01';
    const tab = makeTab({ folder, result: 'GPT drag result', resultSaved: true });
    const sessions = [makeSession([tab])];
    // No capture (no result.md in files) — manual save workflow simulated
    const noCaptureEvent = { folder, files: ['agent-result.md'] };
    const unchanged = applyCapture(sessions, noCaptureEvent, 'IGNORED');
    check(unchanged[0].tabs[0].result === 'GPT drag result', 'manual save result preserved when no capture');
  }

  // ── C. END-TO-END FILE→STATE INTEGRATION TESTS ───────────────────────────

  console.log('C1) Full E2E: empty result.md → capture → result.md written → frontend state updated');
  {
    const folder = path.join(TEST_ROOT, 'c1-e2e');
    fs.mkdirSync(folder, { recursive: true });

    // Step 1: User saves run with empty result (saveTabBoth before entering result)
    fs.writeFileSync(path.join(folder, 'prompt.md'), '# GPT Prompt\n', 'utf8');
    fs.writeFileSync(path.join(folder, 'result.md'), '', 'utf8'); // empty result.md

    // Step 2: OpenCode completes → captureCompletion
    const completion = baseCompletion('OPENCODE_OWNER_CAPTURE_UI_OK');
    const outcome = captureCompletion(folder, completion);
    check(outcome.ok, 'captureCompletion succeeded');
    check(outcome.written.includes('result.md'), 'result.md written (empty → overwritten)');

    // Step 3: Simulated captured event carries folder + files
    const capturedEvent = { folder, files: outcome.written };

    // Step 4: Frontend reads result.md from disk
    const resultOnDisk = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(resultOnDisk === 'OPENCODE_OWNER_CAPTURE_UI_OK', 'result.md has captured text');

    // Step 5: Frontend applyCapture updates the session state
    const tab = makeTab({ folder, result: '', resultSaved: false });
    const sessions = [makeSession([tab])];
    const updated = applyCapture(sessions, capturedEvent, resultOnDisk);
    const updatedTab = updated[0].tabs[0];
    check(updatedTab.result === 'OPENCODE_OWNER_CAPTURE_UI_OK', 'result pane shows captured text');
    check(updatedTab.resultSaved === true, 'resultSaved=true after auto-refresh');
  }

  console.log('C2) Full E2E: manual result.md protected through entire pipeline');
  {
    const folder = path.join(TEST_ROOT, 'c2-protected');
    fs.mkdirSync(folder, { recursive: true });

    // User had a real result.md from GPT drag
    const manualResult = '# Manual Result\n\nThis was dragged from GPT.';
    fs.writeFileSync(path.join(folder, 'result.md'), manualResult, 'utf8');

    // Capture fires
    const outcome = captureCompletion(folder, baseCompletion('CAPTURE_RESULT'));
    check(outcome.ok, 'captureCompletion ok');
    check(outcome.skipped.includes('result.md'), 'result.md skipped (protected)');

    // Captured event has NO result.md in files
    const capturedEvent = { folder, files: outcome.written };
    check(!capturedEvent.files.includes('result.md'), 'captured event does not include result.md');

    // Frontend: pane not updated
    const tab = makeTab({ folder, result: manualResult, resultSaved: true });
    const sessions = [makeSession([tab])];
    const updated = applyCapture(sessions, capturedEvent, /* readRun result= */ '');
    check(updated[0].tabs[0].result === manualResult, 'manual result preserved in pane');
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('test harness error', e); process.exitCode = 1; });
