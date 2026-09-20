import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  beginCertArtifact,
  completeCertArtifact,
  readCertArtifact,
  writeCertArtifact,
  latestMandatorySummary,
} from '../dist/server/workspace/cert-artifact.js';
import {
  MANDATORY_SUITES,
  summarize,
  runAllSuites,
} from '../scripts/run-mandatory-tests.mjs';

const SHA_A = '1e267a28768dd0f2875c91c36cb20b688475c6e2';
const SHA_B = '46f33e8d01d6436873f16aa2c0320d4d78b83b9b';

function evidence(over = {}) {
  return {
    baseCheckpointSha: SHA_A,
    finalHeadSha: SHA_B,
    changedFiles: ['src/workspace/lane-runner.ts'],
    commands: ['npm run typecheck'],
    tests: [{ suite: 'test:workspace-runner', status: 'PASS' }],
    overallTestStatus: 'PASS',
    deliveryCommit: SHA_B,
    worktreeClean: true,
    knownRisks: ['r1'],
    readyForIndependentQA: 'YES',
    ...over,
  };
}

test('artifact has explicit beginning and completion identity on one cycle', () => {
  const starter = beginCertArtifact('runner-fix-1789871385', 'MULTI-PROJECT PROJECT-LANE RUNNER');
  assert.equal(starter.artifactId, 'builder-result-runner-fix-1789871385');
  assert.ok(starter.startedAt);
  const done = completeCertArtifact(starter, evidence());
  assert.equal(done.status, 'COMPLETE');
  assert.equal(done.cycleId, 'runner-fix-1789871385');
  assert.equal(done.identity.correlationId, 'runner-fix-1789871385');
  assert.ok(done.finishedAt >= done.startedAt);
  assert.deepEqual(done.untrackedOther, []);
  const withStray = completeCertArtifact(starter, evidence({ untrackedOther: ['.g6-dogfood/'] }));
  assert.deepEqual(withStray.untrackedOther, ['.g6-dogfood/']);
});

test('artifact validation fails closed on missing evidence', () => {
  const starter = beginCertArtifact('c1', 't');
  assert.throws(() => completeCertArtifact(starter, evidence({ changedFiles: [] })), /changed files/);
  assert.throws(() => completeCertArtifact(starter, evidence({ commands: [] })), /commands/);
  assert.throws(() => completeCertArtifact(starter, evidence({ tests: [] })), /test results/);
  assert.throws(() => completeCertArtifact(starter, evidence({ finalHeadSha: 'abc' })), /full SHA/);
  assert.throws(
    () => completeCertArtifact(starter, evidence({ overallTestStatus: 'FAIL', readyForIndependentQA: 'YES' })),
    /cannot be ready/,
  );
  assert.throws(() => beginCertArtifact('  ', 't'), /cycleId required/);
});

test('artifact truncates within the byte bound and round-trips on disk', () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-cert-'));
  const starter = beginCertArtifact('c2', 't');
  const big = 'x'.repeat(9000);
  const done = completeCertArtifact(starter, evidence({ commands: [big], knownRisks: [big] }));
  assert.equal(done.truncated, true);
  assert.ok(done.commands[0].includes('[truncated'));
  const file = writeCertArtifact(host, done);
  assert.ok(file.endsWith('BUILDER-RESULT-c2.json'));
  const back = readCertArtifact(host, 'c2');
  assert.equal(back.artifactId, done.artifactId);
  assert.equal(back.status, 'COMPLETE');
  assert.equal(readCertArtifact(host, 'nope'), null);
});

test('latestMandatorySummary discovers the newest orchestration record', async () => {
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-certsum-'));
  assert.equal(latestMandatorySummary(host), null);
  const dir = path.join(host, '.agent-relay', 'cert');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mandatory-old.json'), '{"schemaVersion":"mandatory-tests.v1","overall":"FAIL"}');
  await new Promise((r) => setTimeout(r, 15));
  fs.writeFileSync(path.join(dir, 'mandatory-new.json'), '{"schemaVersion":"mandatory-tests.v1","overall":"PASS"}');
  const latest = latestMandatorySummary(host);
  assert.ok(latest.file.endsWith('mandatory-new.json'));
  assert.equal(latest.summary.overall, 'PASS');
});

// ── orchestration semantics ─────────────────────────────────────────────────

test('orchestrator runs every suite even when one fails, never hides failures', () => {
  const order = [];
  const fake = (cmd, args) => {
    const suite = args[1];
    order.push(suite);
    if (suite === 'test:mid') return { status: 1, stdout: 'boom', stderr: '' };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  const results = runAllSuites(['test:a', 'test:mid', 'test:workspace-runner'], fake);
  assert.deepEqual(order, ['test:a', 'test:mid', 'test:workspace-runner']);
  assert.deepEqual(results.map((r) => r.status), ['PASS', 'FAIL', 'PASS']);
  const summary = summarize(results, 'cycle-1');
  assert.equal(summary.overall, 'FAIL');
  assert.deepEqual(summary.failed, ['test:mid']);
  assert.equal(summary.total, 3);
  assert.equal(summary.cycleId, 'cycle-1');
});

test('orchestrator treats spawn timeouts/kills as FAIL with evidence', () => {
  const fake = () => ({ status: null, stdout: '', stderr: 'SIGTERM' });
  const results = runAllSuites(['test:hung'], fake);
  assert.equal(results[0].status, 'FAIL');
  assert.ok(results[0].tail.includes('SIGTERM'));
});

test('mandatory set always includes the QA-gated suites and matches package scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  for (const must of ['test:workspace-runner', 'test:bootstrap-integrity', 'test:workspace-cert']) {
    assert.ok(MANDATORY_SUITES.includes(must), `${must} always attempted`);
  }
  for (const suite of MANDATORY_SUITES) {
    assert.ok(pkg.scripts[suite], `package script exists for ${suite}`);
  }
});
