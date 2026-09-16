#!/usr/bin/env node
// WBS-3 proof: ensureSession(pm) -> prompt A -> collect -> prompt B referencing A -> collect
// (continuity) -> new process resumes the same session -> history readable; plus health()
// and authMode(). Prints non-secret evidence JSON. Never touches live dataRoot/units/tmux.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function argVal(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const modelArg = argVal('model', 'opencode/nemotron-3.5-lightning-free');
const slash = modelArg.indexOf('/');
const providerID = modelArg.slice(0, slash);
const modelID = modelArg.slice(slash + 1);
const passwordFile = argVal('password-file', path.join(os.homedir(), '.config', 'agent-relay', 'opencode-server.pass'));
const baseUrl = argVal('base-url', 'http://127.0.0.1:4111');

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { cwd: repoRoot, stdio: 'inherit' });
const compiledAdapterPath = path.join(repoRoot, 'dist/server/integrations/opencode/command-adapter.js');
const { OpenCodeCommandAdapter } = await import(compiledAdapterPath);

const proofRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-wbs3-proof-'));
const dataRoot = path.join(proofRoot, 'data');
const project = 'WBS3Proof';
const roleId = 'pm';
const sessionKey = 'pm-proof';
const config = { baseUrl, passwordFile, defaultModel: { providerID, modelID }, dataRoot };

const evidence = { model: { providerID, modelID }, baseUrl, dataRoot };

function rawHistoryCount(sessionId) {
  const pass = fs.readFileSync(passwordFile, 'utf8').trim();
  const auth = 'Basic ' + Buffer.from(`opencode:${pass}`).toString('base64');
  return new Promise((resolve, reject) => {
    const u = new URL(`/session/${encodeURIComponent(sessionId)}/message`, baseUrl);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { authorization: auth } }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        try {
          const arr = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(arr) ? arr.length : -1);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

let failed = false;
try {
  const adapter1 = new OpenCodeCommandAdapter(config);

  const health = await adapter1.health();
  evidence.health = health;
  if (!health.ok) throw new Error(`server unhealthy: ${health.detail}`);

  const authMode = await adapter1.authMode();
  evidence.authMode = authMode;

  const ensured1 = await adapter1.ensureSession({ roleId, project, sessionPolicy: 'persistent', sessionKey });
  evidence.ensureSession1 = ensured1;
  if (!ensured1.created) throw new Error('expected a fresh session on first ensureSession call');

  const a = await adapter1.send(ensured1.sessionId, {
    kind: 'PM_BOOTSTRAP',
    schemaVersion: 'wbs3-proof.v1',
    contextHash: 'proof-a',
    body: 'Prompt A. Remember the word BLUEBERRY. Reply with exactly: WBS3_A_OK',
  });
  const collectedA = await adapter1.collect(ensured1.sessionId, a.requestId);
  evidence.promptA = { text: collectedA.text, tokens: collectedA.tokens, cost: collectedA.cost };

  const b = await adapter1.send(ensured1.sessionId, {
    kind: 'PM_BOOTSTRAP',
    schemaVersion: 'wbs3-proof.v1',
    contextHash: 'proof-b',
    body: 'Prompt B, referencing prompt A: what single word did I ask you to remember? Reply with exactly that word, nothing else.',
  });
  const collectedB = await adapter1.collect(ensured1.sessionId, b.requestId);
  evidence.promptB = { text: collectedB.text, tokens: collectedB.tokens, cost: collectedB.cost };
  evidence.continuity = /blueberry/i.test(collectedB.text);
  if (!evidence.continuity) throw new Error(`continuity check failed: prompt B reply did not reference BLUEBERRY: ${JSON.stringify(collectedB.text)}`);

  // Simulate a Relay restart: a brand-new OS process re-imports the compiled adapter and
  // resumes the same session via the durable role-sessions bookkeeping file under dataRoot.
  const resumeScriptPath = path.join(proofRoot, 'resume-child.mjs');
  fs.writeFileSync(
    resumeScriptPath,
    `import { OpenCodeCommandAdapter } from ${JSON.stringify(compiledAdapterPath)};
const adapter = new OpenCodeCommandAdapter(${JSON.stringify(config)});
const ensured = await adapter.ensureSession({ roleId: ${JSON.stringify(roleId)}, project: ${JSON.stringify(project)}, sessionPolicy: 'persistent', sessionKey: ${JSON.stringify(sessionKey)} });
const resumed = await adapter.resume(ensured.sessionId);
console.log(JSON.stringify({ ensured, resumed }));
`,
  );
  const childOut = execFileSync(process.execPath, [resumeScriptPath], { encoding: 'utf8' }).trim();
  const restartResume = JSON.parse(childOut.split('\n').pop());
  evidence.restartResume = restartResume;
  if (restartResume.ensured.created !== false) throw new Error('restart did not reuse the persisted session (created should be false)');
  if (restartResume.ensured.sessionId !== ensured1.sessionId) throw new Error('restart resumed a different sessionId');
  if (!restartResume.resumed.ok) throw new Error('resume() reported not ok after restart');

  const historyCount = await rawHistoryCount(ensured1.sessionId);
  evidence.historyReadableMessageCount = historyCount;
  if (historyCount < 4) throw new Error(`expected >=4 history messages (2 user + 2 assistant), got ${historyCount}`);
} catch (e) {
  failed = true;
  evidence.error = e instanceof Error ? e.message : String(e);
} finally {
  fs.rmSync(proofRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(evidence, null, 2));
console.log(failed ? 'WBS3_PROOF: FAIL' : 'WBS3_PROOF: PASS');
process.exit(failed ? 1 : 0);
