/**
 * `workspace cert` — compose + store the complete Builder Result artifact.
 *
 * Inputs: cycle id (required), task text, mandatory-tests summary (explicit
 * file or latest in .agent-relay/cert/), commands file (one command per
 * line, recorded by the Builder during verification), risks file (one per
 * line), base SHA, ready override. Everything else (final HEAD, changed
 * files, diff stat, worktree cleanliness, delivery tag) is collected from
 * git so the artifact cannot drift from the revision it certifies.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  beginCertArtifact,
  completeCertArtifact,
  latestMandatorySummary,
  writeCertArtifact,
  type BuilderResultArtifact,
  type CertTestRecord,
} from './cert-artifact.js';

export interface CertCliOptions {
  cycle: string;
  task?: string;
  testsFile?: string;
  commandsFile?: string;
  risksFile?: string;
  base?: string;
  ready?: string;
}

export interface CertCliResult {
  artifactPath: string;
  artifact: BuilderResultArtifact;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).trim();
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function runWorkspaceCert(hostRoot: string, opts: CertCliOptions): Promise<CertCliResult> {
  const root = path.resolve(hostRoot);
  const cycle = opts.cycle.trim();
  if (!cycle) throw new Error('cert requires --cycle <id>');
  if (/[\\/]/.test(cycle)) throw new Error('cycle id must be a safe name');
  const starter = beginCertArtifact(cycle, opts.task ?? 'MULTI-PROJECT PROJECT-LANE RUNNER');

  // Mandatory-tests summary: explicit file wins, else latest in cert dir.
  let summaryFile: string;
  let summary: Record<string, unknown>;
  if (opts.testsFile) {
    summaryFile = path.resolve(opts.testsFile);
    summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as Record<string, unknown>;
  } else {
    const latest = latestMandatorySummary(root);
    if (!latest) throw new Error('no mandatory-tests summary found — run the mandatory orchestration first (npm test)');
    summaryFile = latest.file;
    summary = latest.summary;
  }
  if (summary.schemaVersion !== 'mandatory-tests.v1') {
    throw new Error(`tests summary schema mismatch: ${String(summary.schemaVersion)}`);
  }
  const suites = summary.suites as Array<{ suite: string; status: string; durationMs?: number; tail?: string }>;
  if (!Array.isArray(suites) || suites.length === 0) throw new Error('tests summary carries no suites');
  const tests: CertTestRecord[] = suites.map((s) => ({
    suite: String(s.suite),
    status: s.status === 'PASS' ? 'PASS' : 'FAIL',
    ...(typeof s.durationMs === 'number' ? { durationMs: s.durationMs } : {}),
  }));
  const overall = summary.overall === 'PASS' ? 'PASS' : 'FAIL';
  void summaryFile;

  // Commands actually executed: recorded file (fail closed when absent).
  if (!opts.commandsFile) throw new Error('cert requires --commands-file <path> (one executed command per line)');
  const commands = readLines(path.resolve(opts.commandsFile));
  if (commands.length === 0) throw new Error('commands file is empty');

  const risks = opts.risksFile ? readLines(path.resolve(opts.risksFile)) : [];

  // Git truth (cannot drift: collected now, from this worktree).
  const finalHeadSha = git(root, ['rev-parse', 'HEAD']);
  const base = opts.base?.trim() || finalHeadSha;
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error(`--base must be a full SHA (got ${opts.base})`);
  const changedTracked = git(root, ['diff', '--name-only', base, 'HEAD']).split('\n').map((l) => l.trim()).filter(Boolean);
  const untracked = git(root, ['status', '--porcelain', '--untracked-files=normal'])
    .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('??'))
    .map((l) => l.slice(2).trim()).filter(Boolean);
  // Review scope: tracked diff vs base + cycle-created files under product
  // dirs. Pre-existing stray roots are listed separately (not hidden).
  const isProductPath = (p: string): boolean =>
    /^(src|scripts|test)\//.test(p) || /^docs\/BOOTSTRAP/.test(p);
  const productUntracked = untracked.filter(isProductPath);
  const untrackedOther = untracked.filter((p) => !isProductPath(p));
  const changedFiles = [...new Set([...changedTracked, ...productUntracked])].sort();
  const diffStat = git(root, ['diff', '--stat', base, 'HEAD']);
  const worktreeClean = git(root, ['status', '--porcelain', '--untracked-files=no']).length === 0;
  let tag: string | null = null;
  try {
    tag = git(root, ['tag', '--points-at', 'HEAD']).split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? null;
  } catch {
    tag = null;
  }

  const ready = opts.ready?.trim().toUpperCase() ?? (overall === 'PASS' ? 'YES' : 'NO');
  if (ready !== 'YES' && ready !== 'NO') throw new Error('--ready must be YES|NO');

  const artifact = completeCertArtifact(starter, {
    baseCheckpointSha: base,
    finalHeadSha,
    changedFiles: changedFiles.length ? changedFiles : ['(no changes vs base)'],
    diffStat,
    untrackedOther,
    commands,
    tests,
    overallTestStatus: overall as 'PASS' | 'FAIL',
    deliveryCommit: finalHeadSha,
    ...(tag ? { deliveryTag: tag } : {}),
    worktreeClean,
    knownRisks: risks,
    readyForIndependentQA: ready as 'YES' | 'NO',
  });
  const artifactPath = writeCertArtifact(root, artifact);
  return { artifactPath, artifact };
}
