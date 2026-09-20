#!/usr/bin/env node
/**
 * Mandatory test orchestration — deterministic full-suite execution.
 *
 * The old `npm test` chain used `&&` semantics: one flaky/load-sensitive
 * suite aborted the chain and silently skipped every later suite (including
 * workspace-runner and bootstrap-integrity). This runner executes EVERY
 * mandatory suite, records PASS/FAIL per suite, always attempts the
 * workspace suites, and still exits non-zero when anything failed.
 *
 * - never hides or converts a failure into PASS
 * - reports exactly which suites failed (with tail evidence)
 * - writes a bounded machine-readable summary (consumed by `workspace cert`)
 *
 * Usage: node scripts/run-mandatory-tests.mjs [--cycle <id>] [--out <path>]
 *   --cycle  request/cycle identity recorded on the summary (default: none)
 *   --out    summary JSON path (default: .agent-relay/cert/mandatory-<ts>.json)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const MANDATORY_SUITES = [
  'test:fs',
  'test:vnext',
  'test:v03',
  'test:adapter',
  'test:binding',
  'test:claude',
  'test:capture-ux',
  'test:capture-result-refresh',
  'test:adapter-agent-map',
  'test:parallel-capture',
  'test:draft-materialization',
  'test:session-ownership',
  'test:draft-idempotency',
  'test:goal-task-kernel',
  'test:b1-corrections',
  'test:b2-runtime',
  'test:evidence-kernel',
  'test:event-kernel',
  'test:event-contract',
  'test:mcp-phase-e',
  'test:mcp-smoke',
  'test:mcp-phase-f',
  'test:mcp-phase-f-bounds',
  'test:mcp-phase-f-correction',
  'test:phase-g-dispatcher',
  'test:phase-g-hardening',
  'test:phase-h-closed-loop',
  'test:phase-i-dogfood',
  'test:phase-i3-stab',
  'test:phase-i3-watch',
  'test:phase-i3-goal',
  'test:phase-i3-cli',
  'test:phase-i3-init',
  'test:phase-i3-connect',
  'test:phase-i3-tui',
  'test:phase-i3e-relay-tui',
  'test:phase-i3f1-task-memo',
  'test:phase-i3f1-tui-subviews',
  'test:phase-i3f2-task-actions',
  'test:phase-i3f2h-pm-transition-hardening',
  'test:phase-i3f3-tui-mutation-bridge',
  'test:phase-i3f4-safe-task-edit',
  'test:v15-plan-kernel',
  'test:v15-plan-first-dispatch',
  'test:v15-plan-accept-advancement',
  'test:v15-plan-reconciliation',
  'test:v15-plan-mcp-surface',
  'test:actl-managed-bridge',
  'test:b15-fix-01-a',
  'test:b15-fix-03-a',
  'test:bootstrap-integrity',
  'test:workspace-runner',
  'test:workspace-cert',
  'test:runner-durable',
  'test:runner-restart',
  'test:night-run',
];

export const PER_SUITE_TIMEOUT_MS = 600000;
export const SUMMARY_SCHEMA = 'mandatory-tests.v1';

export function summarize(results, cycleId) {
  const failed = results.filter((r) => r.status !== 'PASS').map((r) => r.suite);
  return {
    schemaVersion: SUMMARY_SCHEMA,
    cycleId: cycleId ?? null,
    startedAt: results.length ? results[0].startedAt : new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === 'PASS').length,
    failed,
    overall: failed.length === 0 ? 'PASS' : 'FAIL',
    suites: results,
  };
}

function tailLines(text, n = 25) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).join('\n').slice(0, 4000);
}

export function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runAllSuites(suites = MANDATORY_SUITES, runner = spawnSync) {
  const results = [];
  for (const suite of suites) {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let status = 'PASS';
    let output = '';
    try {
      const res = runner(npmCmd(), ['run', suite], {
        encoding: 'utf8',
        timeout: PER_SUITE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      // spawnSync timeout kill yields status null / signal SIGTERM.
      if (res.status !== 0) status = 'FAIL';
    } catch (err) {
      status = 'FAIL';
      output = err instanceof Error ? err.message : String(err);
    }
    results.push({
      suite,
      status,
      exitCode: status === 'PASS' ? 0 : 1,
      durationMs: Date.now() - t0,
      startedAt,
      tail: tailLines(output),
    });
    // eslint-disable-next-line no-console
    console.log(`${status === 'PASS' ? 'PASS' : 'FAIL'}  ${suite}`);
  }
  return results;
}

function parseArgs(argv) {
  let cycle = null;
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cycle') cycle = argv[i + 1] ?? null;
    if (argv[i] === '--out') out = argv[i + 1] ?? null;
    if (argv[i] === '--cycle' || argv[i] === '--out') i += 1;
  }
  return { cycle, out };
}

export function defaultSummaryPath(cwd = process.cwd()) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(path.resolve(cwd), '.agent-relay', 'cert', `mandatory-${stamp}.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { cycle, out } = parseArgs(process.argv.slice(2));
  const results = runAllSuites();
  const summary = summarize(results, cycle);
  const file = out ?? defaultSummaryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(`suites: ${summary.total} passed: ${summary.passed} failed: ${summary.failed.length}`);
  if (summary.failed.length) {
    // eslint-disable-next-line no-console
    console.log(`failed: ${summary.failed.join(', ')}`);
  }
  // eslint-disable-next-line no-console
  console.log(`summary: ${file}`);
  process.exit(summary.overall === 'PASS' ? 0 : 1);
}
