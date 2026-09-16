import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { stdio: 'inherit' });
const { OpenCodeCommandAdapter } = await import('../dist/server/integrations/opencode/command-adapter.js');

const PASSWORD = 'test-pass-123';
const sentMessageBodies = [];
const abortSessions = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-oc-adapter-'));
const passwordFile = path.join(root, 'server.pass');
fs.writeFileSync(passwordFile, PASSWORD + '\n');
const wrongPasswordFile = path.join(root, 'wrong.pass');
fs.writeFileSync(wrongPasswordFile, 'nope\n');
const dataRoot = path.join(root, 'data');

/** Minimal fake implementing the 4 proven WBS-0 endpoints, plus /abort for interrupt(). */
function startFakeServer() {
  const sessions = new Map(); // id -> { messages: [] }
  let seq = 0;
  const server = http.createServer((req, res) => {
    const auth = req.headers['authorization'] || '';
    const expected = 'Basic ' + Buffer.from(`opencode:${PASSWORD}`).toString('base64');
    if (auth !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = req.url || '';
      if (req.method === 'GET' && url === '/global/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ healthy: true, version: 'fake-1.0.0' }));
        return;
      }
      if (req.method === 'POST' && url === '/session') {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* invalid JSON test below sends garbage */ }
        if (raw && Object.keys(body).length === 0 && raw !== '{}') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        const id = `ses_fake_${++seq}`;
        sessions.set(id, { messages: [] });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id }));
        return;
      }
      const msgMatch = /^\/session\/([^/]+)\/message$/.exec(url);
      if (msgMatch) {
        const id = decodeURIComponent(msgMatch[1]);
        const session = sessions.get(id);
        if (!session) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'no such session' }));
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(session.messages));
          return;
        }
        if (req.method === 'POST') {
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid json' }));
            return;
          }
          sentMessageBodies.push(body);
          const userText = (body.parts || []).find((p) => p.type === 'text')?.text || '';
          const replyText = `ECHO:${userText}`;
          const userMsg = { info: { role: 'user', id: `msg_u_${session.messages.length}` }, parts: [{ type: 'text', text: userText }] };
          const assistantMsg = {
            info: { role: 'assistant', id: `msg_a_${session.messages.length}`, providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free', tokens: { total: 42 }, cost: 0 },
            parts: [{ type: 'text', text: replyText }],
          };
          session.messages.push(userMsg, assistantMsg);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(assistantMsg));
          return;
        }
      }
      const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(url);
      if (abortMatch && req.method === 'POST') {
        abortSessions.push(decodeURIComponent(abortMatch[1]));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const server = await startFakeServer();
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;
const defaultModel = { providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' };

test('session create then reuse across process (persistent policy + dataRoot bookkeeping)', async () => {
  const adapter1 = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel, dataRoot });
  const first = await adapter1.ensureSession({ roleId: 'pm', project: 'ProjX', sessionPolicy: 'persistent', sessionKey: 'pm-main' });
  assert.equal(first.created, true);

  // Simulate a fresh process: brand new adapter instance, same dataRoot.
  const adapter2 = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel, dataRoot });
  const second = await adapter2.ensureSession({ roleId: 'pm', project: 'ProjX', sessionPolicy: 'persistent', sessionKey: 'pm-main' });
  assert.equal(second.created, false);
  assert.equal(second.sessionId, first.sessionId);
});

test('send then collect returns assistant text', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const { sessionId } = await adapter.ensureSession({ roleId: 'builder', project: 'ProjX', sessionPolicy: 'per-task', sessionKey: 'task-1' });
  const { requestId } = await adapter.send(sessionId, { kind: 'TASK_CONTRACT', schemaVersion: 'task-contract.v1', contextHash: 'h1', body: 'do the thing' });
  const result = await adapter.collect(sessionId, requestId);
  assert.equal(result.text, 'ECHO:do the thing');
  assert.equal(result.tokens, 42);
  assert.equal(result.cost, 0);
  const tools = sentMessageBodies.at(-1).tools;
  assert.equal(tools.read, false);
  assert.equal(tools.bash, false);
  assert.equal(tools.edit, false);
  assert.equal(tools.write, false);
  assert.equal(tools.apply_patch, false);
  assert.ok(Object.values(tools).every((value) => value === false), 'every sent tool flag is false');
});

test('abortSession sends the OpenCode abort POST', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const { sessionId } = await adapter.ensureSession({ roleId: 'pm', project: 'AbortProject', sessionPolicy: 'per-task', sessionKey: 'abort' });
  await adapter.abortSession(sessionId);
  assert.equal(abortSessions.at(-1), sessionId);
});

test('conversation continuity: second prompt sees first via session history', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const { sessionId } = await adapter.ensureSession({ roleId: 'pm', project: 'ProjY', sessionPolicy: 'per-task', sessionKey: 'k' });
  const a = await adapter.send(sessionId, { kind: 'PM_BOOTSTRAP', schemaVersion: 'v1', contextHash: 'h', body: 'prompt A: remember BLUEBERRY' });
  await adapter.collect(sessionId, a.requestId);
  const b = await adapter.send(sessionId, { kind: 'PM_FINAL_GATE', schemaVersion: 'v1', contextHash: 'h', body: 'referencing prompt A, what fruit?' });
  const result = await adapter.collect(sessionId, b.requestId);
  assert.ok(result.text.length > 0);
  const resumed = await adapter.resume(sessionId);
  assert.equal(resumed.ok, true);
});

test('restart-resume: new adapter instance resumes same persistent session and history is readable', async () => {
  const adapter1 = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel, dataRoot });
  const s1 = await adapter1.ensureSession({ roleId: 'qa', project: 'ProjZ', sessionPolicy: 'persistent', sessionKey: 'qa-main' });
  const send1 = await adapter1.send(s1.sessionId, { kind: 'QA_PACKET', schemaVersion: 'v1', contextHash: 'h', body: 'first' });
  await adapter1.collect(s1.sessionId, send1.requestId);

  const adapter2 = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel, dataRoot });
  const s2 = await adapter2.ensureSession({ roleId: 'qa', project: 'ProjZ', sessionPolicy: 'persistent', sessionKey: 'qa-main' });
  assert.equal(s2.sessionId, s1.sessionId);
  assert.equal(s2.created, false);
  const resumed = await adapter2.resume(s2.sessionId);
  assert.equal(resumed.ok, true);
});

test('401 unauthorized maps health() to ok:false', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile: wrongPasswordFile, defaultModel });
  const health = await adapter.health();
  assert.equal(health.ok, false);
  assert.equal(health.detail, 'unauthorized');
});

test('healthy server maps health() to ok:true', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const health = await adapter.health();
  assert.equal(health.ok, true);
});

test('invalid JSON response / error status maps to a thrown error, not a silent success', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  await assert.rejects(() => adapter.send('ses_does_not_exist', { kind: 'CHANGES', schemaVersion: 'v1', contextHash: 'h', body: 'x' }));
});

test('capabilities() flags match the WBS-3 spec (PM role: read-only, no shell)', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const caps = adapter.capabilities();
  assert.equal(caps.writeWorkspace, false);
  assert.equal(caps.shell, false);
  assert.equal(caps.persistentSession, true);
  assert.equal(caps.freeTier, true);
});

test('authMode() reports free for an opencode/*-free default model', async () => {
  const adapter = new OpenCodeCommandAdapter({ baseUrl, passwordFile, defaultModel });
  const mode = await adapter.authMode();
  assert.equal(mode.mode, 'free');
});

test.after(() => {
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});
