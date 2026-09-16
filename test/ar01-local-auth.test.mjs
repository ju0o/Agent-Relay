/**
 * AR-01 — local authenticated transport tests for the MCP App server
 * (dist/server/mcp/app-server.js).
 *
 * Proves:
 *   1. no authToken configured → POST /mcp unauthenticated (back-compat for
 *      existing in-process callers, e.g. g6-mcp-pm-wake.test.mjs)
 *   2. authToken configured: missing Authorization header → 401, no MCP call made
 *   3. authToken configured: wrong token → 401
 *   4. authToken configured: correct token → tools/list succeeds
 *   5. GET /health never requires auth and never echoes the token
 *   6. default host is loopback-only (127.0.0.1), not all interfaces
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

const TEST_ROOT = path.join(os.tmpdir(), `arl-ar01-auth-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

const appServer = await import('../dist/server/mcp/app-server.js');

function rawPost(port, host, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host, port, path: '/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  });
}

function rawGet(port, host, path) {
  return new Promise((resolve, reject) => {
    http.get({ host, port, path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function withServer(opts, fn) {
  const server = await appServer.startMcpAppServer(opts);
  try {
    await fn(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── 1: no authToken → back-compat, unauthenticated POST /mcp works ──
console.log('\n-- 1: no authToken configured (back-compat) --');
{
  const port = 4901;
  await withServer({ dataRoot: TEST_ROOT, project: 'Ar01NoAuth', port }, async () => {
    const res = await rawPost(port, '127.0.0.1', {});
    check(res.status === 200, '1 unauthenticated POST /mcp succeeds when no authToken configured');
  });
}

// ── 2/3/4: authToken configured ──
console.log('\n-- 2/3/4: authToken configured --');
{
  const port = 4902;
  const token = crypto.randomBytes(24).toString('hex');
  await withServer({ dataRoot: TEST_ROOT, project: 'Ar01Auth', port, authToken: token }, async () => {
    const noAuth = await rawPost(port, '127.0.0.1', {});
    check(noAuth.status === 401, '2 missing Authorization header → 401');
    check(!noAuth.body.includes(token), '2 401 body does not leak the token');

    const wrong = await rawPost(port, '127.0.0.1', { authorization: `Bearer ${crypto.randomBytes(24).toString('hex')}` });
    check(wrong.status === 401, '3 wrong token → 401');

    const right = await rawPost(port, '127.0.0.1', { authorization: `Bearer ${token}` });
    check(right.status === 200, '4 correct token → 200');
    check(right.body.includes('tools') && right.body.includes('relay_pm_open_widget'), '4 correct token → tools/list returns tools');
  });
}

// ── 5: GET /health unauthenticated, never echoes token ──
console.log('\n-- 5: GET /health --');
{
  const port = 4903;
  const token = crypto.randomBytes(24).toString('hex');
  await withServer({ dataRoot: TEST_ROOT, project: 'Ar01Health', port, authToken: token }, async () => {
    const health = await rawGet(port, '127.0.0.1', '/health');
    check(health.status === 200, '5 GET /health succeeds without auth when authToken is configured');
    check(!health.body.includes(token), '5 /health response never echoes the token');
  });
}

// ── 6: default host is loopback-only ──
console.log('\n-- 6: default host binding --');
{
  const port = 4904;
  await withServer({ dataRoot: TEST_ROOT, project: 'Ar01Host', port }, async (server) => {
    const addr = server.address();
    check(addr && (addr.address === '127.0.0.1'), `6 default bind address is 127.0.0.1 (got ${addr && addr.address})`);
  });
}

fs.rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(`\nAR-01 local auth tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
