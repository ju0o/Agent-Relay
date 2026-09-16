#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') out.list = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--release-id') out.releaseId = argv[++i];
    else if (argv[i] === '--repo-root') out.repoRoot = argv[++i];
  }
  if (!out.list || !out.out || !out.releaseId) throw new Error('required: --list --out --release-id');
  return out;
}

export function runRegressionList(list, repoRoot) {
  return list.commands.map((item) => {
    const cwd = item.cwd ? path.resolve(repoRoot, item.cwd) : repoRoot;
    const started = Date.now();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(item.command, item.args, { cwd, env, encoding: 'utf8', timeout: item.timeoutMs ?? 300_000, maxBuffer: 1024 * 1024 });
    const exitCode = typeof child.status === 'number' ? child.status : 124;
    const expected = item.expectExitCode ?? 0;
    return { file: item.args[item.args.indexOf('--test') + 1] ?? item.args.join(' '), command: item.command, args: item.args, exitCode, expectedExitCode: expected, passed: exitCode === expected, durationMs: Date.now() - started };
  });
}

export function buildEvidence(list, results, releaseId) {
  const failed = results.filter((result) => !result.passed).length;
  const metadata = { schema_version: 'quality.evidence.v1', pipeline_step: 4, contract_hash: null, release_id: releaseId, mechanical_check: { rule_ko: '모든 regression commands가 선언된 기대 종료 코드로 순차 실행되어야 합니다.', result: failed === 0 ? 'PASS' : 'FAIL' }, findings: [], commands_total: results.length, commands_passed: results.length - failed, commands_failed: failed, results };
  metadata.evidence_hash = crypto.createHash('sha256').update(canonical({ ...metadata, evidence_hash: undefined })).digest('hex');
  delete metadata.evidence_hash;
  metadata.evidence_hash = crypto.createHash('sha256').update(canonical(metadata)).digest('hex');
  return { schemaVersion: 1, evidenceId: `QUALITY-EVIDENCE-${releaseId}`, project: list.repo, taskId: null, type: 'TEST', trustLevel: 'OBSERVED', status: failed === 0 ? 'PASS' : 'FAIL', source: { kind: 'regression-runner', command: 'node scripts/run-regression-list.mjs' }, summary: `Regression suite ${results.length - failed}/${results.length} passed for ${releaseId}`, createdAt: new Date().toISOString(), metadata };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = args(process.argv.slice(2));
    const listPath = path.resolve(options.list);
    const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));
    const repoRoot = path.resolve(options.repoRoot ?? list.repo_root ?? path.join(path.dirname(listPath), '../..'));
    const results = runRegressionList(list, repoRoot);
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'quality.evidence.v1.json'), `${JSON.stringify(buildEvidence(list, results, options.releaseId), null, 2)}\n`);
    console.log(`REGRESSION ${results.filter((result) => result.passed).length}/${results.length} passed`);
    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
