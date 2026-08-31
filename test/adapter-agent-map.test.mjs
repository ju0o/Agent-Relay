/* adapter-agent-map tests (Owner Dogfood Correction 03 + Adapter Coverage Batch 01).
   Verifies:
     1. Claude Code Run → claude-code adapter selected
     2. OpenCode Run → opencode adapter selected
     3. Changing active Run OpenCode → Claude updates capture adapter
     4. Changing active Run Claude → OpenCode updates capture adapter
     5. V1 registered adapters present; still-unsupported agents do not fall back
     6. Active/bound capture does not carry across Agent switch (CaptureManager level)
     7. OpenCode Owner flow regression
     8. Claude adapter tests regression
     9. Manual Result fallback for still-unsupported agents
     10. Codex/CommandCode/Cline/Grok now registered
   Runs against the compiled server modules under dist/server. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentNameToAdapterId, hasRegisteredAdapter, supportedAgentNames } from '../dist/server/shared/adapter-map.js';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';
import { clearAdapters, registerAdapter } from '../dist/server/integrations/core/registry.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'adapter-agent-map');
const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

function freshFolder(name) {
  const folder = path.join(TEST_ROOT, name);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

async function main() {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });

  console.log('AM1) Claude Code Run → claude-code adapter selected');
  {
    const id = agentNameToAdapterId('Claude Code');
    check(id === 'claude-code', `agentNameToAdapterId('Claude Code') === 'claude-code' (got: ${id})`);
    check(hasRegisteredAdapter('Claude Code') === true, 'hasRegisteredAdapter(Claude Code)');
  }

  console.log('AM2) OpenCode Run → opencode adapter selected');
  {
    const id = agentNameToAdapterId('OpenCode');
    check(id === 'opencode', `agentNameToAdapterId('OpenCode') === 'opencode' (got: ${id})`);
    check(hasRegisteredAdapter('OpenCode') === true, 'hasRegisteredAdapter(OpenCode)');
  }

  console.log('AM3) Changing active Run OpenCode → Claude updates capture adapter');
  {
    // Simulates: user was on an OpenCode tab (got opencode), now switches to Claude Code tab.
    const fromId = agentNameToAdapterId('OpenCode');
    const toId = agentNameToAdapterId('Claude Code');
    check(fromId === 'opencode', 'source adapter is opencode');
    check(toId === 'claude-code', 'after tab switch, derived adapter is claude-code');
    check(fromId !== toId, 'adapter changes across agent switch (no stale carryover)');
  }

  console.log('AM4) Changing active Run Claude → OpenCode updates capture adapter');
  {
    const fromId = agentNameToAdapterId('Claude Code');
    const toId = agentNameToAdapterId('OpenCode');
    check(fromId === 'claude-code', 'source adapter is claude-code');
    check(toId === 'opencode', 'after tab switch, derived adapter is opencode');
    check(fromId !== toId, 'adapter changes across agent switch (no stale carryover)');
  }

  console.log('AM5) V1 registered adapters: Codex/CommandCode/Cline/Grok now registered; other unknown agents still null');
  {
    // V1 registered: opencode, claude-code, codex, commandcode, cline, grok
    const registeredAgents = [
      { name: 'Codex', expectedId: 'codex' },
      { name: 'CommandCode', expectedId: 'commandcode' },
      { name: 'Cline', expectedId: 'cline' },
      { name: 'Grok', expectedId: 'grok' },
    ];
    for (const { name, expectedId } of registeredAgents) {
      const id = agentNameToAdapterId(name);
      check(id === expectedId, `agentNameToAdapterId('${name}') === '${expectedId}' (got: ${id})`);
      check(hasRegisteredAdapter(name) === true, `hasRegisteredAdapter('${name}') === true`);
    }
    // Still-unregistered agents must not silently fall back
    const unsupportedAgents = ['Devin', 'Kiro', 'Other', '', 'Random'];
    for (const name of unsupportedAgents) {
      const id = agentNameToAdapterId(name);
      check(id === null, `agentNameToAdapterId('${name}') === null (no silent fallback)`);
      check(hasRegisteredAdapter(name) === false, `hasRegisteredAdapter('${name}') === false`);
    }
    // Codex now registered — does NOT silently fallback to opencode or claude-code
    const codeId = agentNameToAdapterId('Codex');
    check(codeId !== 'opencode', 'Codex does NOT silently get opencode adapter');
    check(codeId !== 'claude-code', 'Codex does NOT silently get claude-code adapter');
    check(codeId === 'codex', 'Codex correctly maps to codex adapter');
  }

  console.log('AM6) Active/bound capture does not carry across Agent switch (CaptureManager)');
  {
    // Simulate: arm with opencode, then arm with claude-code for a different folder.
    // The old opencode binding must NOT carry into the new claude-code arm.
    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));

    // fake adapters that report one session each
    const fakeOC = {
      id: 'fake-oc-am6',
      agentName: 'FakeOpenCode',
      startWatch: async (_t, sink) => {
        sink({
          type: 'sessions',
          sessions: [{ sessionId: 'oc-session-1', title: 'oc-task', directory: 'C:\\ws', updatedMs: 10, isNew: true, inFlight: false }],
          armPass: true,
        });
        return { adapterId: 'fake-oc-am6', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    const fakeCC = {
      id: 'fake-cc-am6',
      agentName: 'FakeClaudeCode',
      startWatch: async (_t, sink) => {
        sink({
          type: 'sessions',
          sessions: [{ sessionId: 'cc-session-1', title: 'cc-task', directory: 'C:\\ws', updatedMs: 20, isNew: true, inFlight: false }],
          armPass: true,
        });
        return { adapterId: 'fake-cc-am6', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    registerAdapter(fakeOC);
    registerAdapter(fakeCC);

    const folderOC = freshFolder('switch-oc');
    const folderCC = freshFolder('switch-cc');

    // Arm with opencode for folderOC → session oc-session-1 bound
    await manager.arm(folderOC, 'fake-oc-am6');
    const ocWatching = pushes.find((p) => p.phase === 'watching' && p.folder === folderOC);
    check(!!ocWatching, 'OpenCode arm: watching status pushed');
    check(ocWatching.boundSessionId === 'oc-session-1', 'OpenCode session bound in first arm');

    // Now switch to claude-code for folderCC — must NOT inherit oc-session-1
    await manager.arm(folderCC, 'fake-cc-am6');
    const ccWatching = pushes.find((p) => p.phase === 'watching' && p.folder === folderCC);
    check(!!ccWatching, 'Claude Code arm: watching status pushed for new folder');
    check(ccWatching.adapterId === 'fake-cc-am6', 'Claude adapter active after switch');
    // The cc-session-1 should be bound, NOT oc-session-1
    check(ccWatching.boundSessionId === 'cc-session-1', 'claude-code arm binds CC session, not OC session');
    check(ccWatching.boundSessionId !== 'oc-session-1', 'OC session NOT carried into CC arm');

    await manager.disarmAll();
    clearAdapters();
  }

  console.log('AM7) OpenCode Owner flow regression — existing opencode arm works');
  {
    // Existing flow: OpenCode run → arm → opencode session captured.
    // Verifies the mapping did not break the original behavior.
    const id = agentNameToAdapterId('OpenCode');
    check(id === 'opencode', 'OpenCode → opencode mapping intact');

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    const fake = {
      id: 'fake-oc-regression',
      agentName: 'OpenCode-reg',
      startWatch: async (_t, sink) => {
        sink({
          type: 'sessions',
          sessions: [{ sessionId: 'reg-ses', title: 'regression', directory: 'C:\\ws', updatedMs: 5, isNew: true, inFlight: false }],
          armPass: true,
        });
        return { adapterId: 'fake-oc-regression', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    registerAdapter(fake);
    const folder = freshFolder('regression-oc');
    await manager.arm(folder, 'fake-oc-regression');
    const w = pushes.find((p) => p.phase === 'watching');
    check(!!w, 'OpenCode regression: watching pushed');
    check(w.boundSessionId === 'reg-ses', 'OpenCode regression: session bound');
    await manager.disarmAll();
    clearAdapters();
  }

  console.log('AM8) Claude adapter regression — existing claude-code arm works');
  {
    const id = agentNameToAdapterId('Claude Code');
    check(id === 'claude-code', 'Claude Code → claude-code mapping intact');

    const pushes = [];
    const manager = new CaptureManager((s) => pushes.push(s));
    const fake = {
      id: 'fake-cc-regression',
      agentName: 'ClaudeCode-reg',
      startWatch: async (_t, sink) => {
        sink({
          type: 'sessions',
          sessions: [{ sessionId: 'cc-reg-ses', title: 'cc-regression', directory: 'C:\\ws', updatedMs: 5, isNew: true, inFlight: false }],
          armPass: true,
        });
        return { adapterId: 'fake-cc-regression', stop: async () => sink({ type: 'status', phase: 'stopped' }) };
      },
    };
    registerAdapter(fake);
    const folder = freshFolder('regression-cc');
    await manager.arm(folder, 'fake-cc-regression');
    const w = pushes.find((p) => p.phase === 'watching');
    check(!!w, 'Claude regression: watching pushed');
    check(w.boundSessionId === 'cc-reg-ses', 'Claude regression: session bound');
    await manager.disarmAll();
    clearAdapters();
  }

  console.log('AM9) Manual Result fallback — unsupported agent still allows manual save; V1 six now in supportedAgentNames');
  {
    // When no adapter is registered for an agent (e.g. Devin), the user can still
    // manually paste/save a result. The mapping returns null, triggering the UI error,
    // but the run folder and manual workflow remain unaffected.
    const devinAdapterId = agentNameToAdapterId('Devin');
    check(devinAdapterId === null, 'Devin has no adapter (returns null)');
    // Simulate: the UI would show "어댑터 없음" and the arm call would show an error.
    // The folder itself is writable (no capture lock needed for manual saves).
    const folder = freshFolder('manual-fallback');
    fs.writeFileSync(path.join(folder, 'prompt.md'), '# 수동 프롬프트', 'utf8');
    fs.writeFileSync(path.join(folder, 'result.md'), '# 수동 결과', 'utf8');
    const content = fs.readFileSync(path.join(folder, 'result.md'), 'utf8');
    check(content === '# 수동 결과', 'manual result.md writable even when agent has no adapter');
    // Verify supportedAgentNames includes all V1 six registered adapters
    const supported = supportedAgentNames();
    check(supported.includes('OpenCode'), 'OpenCode in supportedAgentNames');
    check(supported.includes('Claude Code'), 'Claude Code in supportedAgentNames');
    check(supported.includes('Codex'), 'Codex in supportedAgentNames (Adapter Coverage Batch 01)');
    check(supported.includes('CommandCode'), 'CommandCode in supportedAgentNames (Adapter Coverage Batch 01)');
    check(supported.includes('Cline'), 'Cline in supportedAgentNames (Adapter Coverage Batch 01)');
    check(supported.includes('Grok'), 'Grok in supportedAgentNames (Adapter Coverage Batch 01)');
    check(!supported.includes('Devin'), 'Devin NOT in supportedAgentNames (still unregistered)');
    check(!supported.includes('Kiro'), 'Kiro NOT in supportedAgentNames (still unregistered)');
    // Total: 6 registered adapters in V1
    check(supported.length === 6, `supportedAgentNames has 6 entries (got: ${supported.length})`);
  }

  const ok = process.exitCode === undefined;
  console.log('\n결과:', ok ? 'ALL PASS' : 'SOME FAILED');
}

main().catch((e) => { console.error('harness error', e); process.exitCode = 1; });
