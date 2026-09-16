import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const runner = path.resolve('scripts/run-regression-list.mjs');

test('serial regression runner writes quality.evidence.v1 with per-command results and fails on one dummy test', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-regression-'));
  const tests = path.join(root, 'tests');
  const out = path.join(root, 'evidence');
  fs.mkdirSync(tests, { recursive: true });
  fs.writeFileSync(path.join(tests, 'pass-a.test.mjs'), "import { test } from 'node:test'; test('a', () => {});\n");
  fs.writeFileSync(path.join(tests, 'pass-b.test.mjs'), "import { test } from 'node:test'; test('b', () => {});\n");
  fs.writeFileSync(path.join(tests, 'fail.test.mjs'), "import { test } from 'node:test'; test('fail', () => { throw new Error('expected'); });\n");
  const list = { schema_version: 'quality.regression_list.v1', repo: 'quality-test', list_version: 1, commands: ['pass-a.test.mjs', 'pass-b.test.mjs', 'fail.test.mjs'].map((file) => ({ command: process.execPath, args: ['--test', path.join(tests, file)], timeoutMs: 30_000 })) };
  const listPath = path.join(root, 'list.json');
  fs.writeFileSync(listPath, JSON.stringify(list));
  const run = spawnSync(process.execPath, [runner, '--list', listPath, '--repo-root', root, '--out', out, '--release-id', 'test-release'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`);
  const evidence = JSON.parse(fs.readFileSync(path.join(out, 'quality.evidence.v1.json'), 'utf8'));
  assert.equal(evidence.metadata.schema_version, 'quality.evidence.v1');
  assert.equal(evidence.metadata.pipeline_step, 4);
  assert.equal(evidence.metadata.release_id, 'test-release');
  assert.equal(evidence.metadata.commands_total, 3);
  assert.equal(evidence.metadata.commands_passed, 2);
  assert.equal(evidence.metadata.commands_failed, 1);
  assert.equal(evidence.metadata.results.length, 3);
  assert.ok(evidence.metadata.results.every((item) => typeof item.durationMs === 'number' && typeof item.exitCode === 'number'));
  assert.equal(evidence.metadata.evidence_hash.length, 64);
  fs.rmSync(root, { recursive: true, force: true });
});
