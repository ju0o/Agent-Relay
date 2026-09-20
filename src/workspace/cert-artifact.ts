/**
 * Builder Result artifact — the durable, complete, QA-consumable record.
 *
 * Pane capture (tmux scrollback) is NEVER the authoritative Builder Result:
 * it truncates. This module builds one bounded JSON artifact per cycle with
 * an explicit beginning identity (artifactId/cycleId/startedAt) and an
 * explicit completion identity (finishedAt/status COMPLETE), carrying the
 * SAME correlation/cycle identity throughout. The QA handoff consumes THIS
 * file, not a scrollback fragment.
 *
 * Required content (per certification): cycleId, task identity, stable
 * base/checkpoint SHA, final HEAD SHA, exact changed files, commands
 * actually executed, test results, identity/correlation evidence,
 * cross-lane isolation evidence, delivery/commit evidence, known risks,
 * readyForIndependentQA.
 *
 * Storage: `<host>/.agent-relay/cert/BUILDER-RESULT-<cycle>.json`
 * (bounded: long fields truncate with a marker, total capped).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const CERT_ARTIFACT_SCHEMA = 'builder-result.v1' as const;
export const MAX_FIELD_CHARS = 8000;
export const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Durable pointers to the tests that certify the named properties. */
export const EVIDENCE_REFS = {
  identity: [
    'test/workspace-bootstrap.test.mjs: role session persists project+role+runtime+live_session_identity',
    'test/workspace-bootstrap.test.mjs: tmux adapter rejects stale/unknown session identities as live proof',
    'test/workspace-runner.test.mjs: builder task identity mismatch blocks the lane (taskId + runId asserted)',
    'test/workspace-runner.test.mjs: runner outcome and audit carry the request correlation id',
  ],
  isolation: [
    'test/workspace-runner.test.mjs: cross-lane isolation: lane A context/task/result never enters lane B packet/dispatch',
    'test/workspace-runner.test.mjs: runner HUMAN_GATE parks only that lane; siblings continue',
  ],
  dispatchSafety: [
    'test/workspace-bootstrap.test.mjs: DISPATCH with non-canonical id fails closed',
    'test/workspace-bootstrap.test.mjs: DISPATCH reuses one existing READY task exactly once',
    'test/workspace-bootstrap.test.mjs: DISPATCH refuses ACCEPTED-terminal tasks',
  ],
  handoffCorrelation: [
    'test/workspace-runner.test.mjs: handoff markers correlate to one request only (bare history never matches)',
  ],
} as const;

export interface CertTestRecord {
  suite: string;
  status: 'PASS' | 'FAIL';
  durationMs?: number;
  tail?: string;
}

export interface CertStarter {
  artifactId: string;
  cycleId: string;
  task: string;
  startedAt: string;
}

export interface BuilderResultArtifact {
  schemaVersion: typeof CERT_ARTIFACT_SCHEMA;
  artifactId: string;
  cycleId: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  status: 'COMPLETE';
  baseCheckpointSha: string;
  finalHeadSha: string;
  changedFiles: string[];
  diffStat: string;
  commands: string[];
  tests: CertTestRecord[];
  overallTestStatus: 'PASS' | 'FAIL';
  identity: { correlationId: string; refs: string[]; note: string };
  isolation: { refs: string[]; note: string };
  delivery: { commit: string; tag: string | null; worktreeClean: boolean; refs: string[] };
  knownRisks: string[];
  readyForIndependentQA: 'YES' | 'NO';
  truncated: boolean;
}

export interface CertEvidence {
  baseCheckpointSha: string;
  finalHeadSha: string;
  changedFiles: string[];
  diffStat?: string;
  commands: string[];
  tests: CertTestRecord[];
  overallTestStatus: 'PASS' | 'FAIL';
  identityNote?: string;
  isolationNote?: string;
  deliveryCommit: string;
  deliveryTag?: string | null;
  worktreeClean: boolean;
  knownRisks: string[];
  readyForIndependentQA: 'YES' | 'NO';
}

function fail(msg: string): never {
  throw new Error(`Incomplete Builder Result artifact: ${msg}`);
}

function trunc(value: string): { text: string; cut: boolean } {
  if (value.length <= MAX_FIELD_CHARS) return { text: value, cut: false };
  return { text: `${value.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${value.length - MAX_FIELD_CHARS} chars]`, cut: true };
}

export function beginCertArtifact(cycleId: string, task: string): CertStarter {
  if (!cycleId.trim()) fail('cycleId required');
  if (!task.trim()) fail('task identity required');
  return {
    artifactId: `builder-result-${cycleId.trim()}`,
    cycleId: cycleId.trim(),
    task: task.trim(),
    startedAt: new Date().toISOString(),
  };
}

export function completeCertArtifact(starter: CertStarter, evidence: CertEvidence): BuilderResultArtifact {
  if (!starter || !starter.artifactId || !starter.cycleId) fail('starter with artifactId/cycleId required');
  const need = (cond: boolean, msg: string) => { if (!cond) fail(msg); };
  need(/^[0-9a-f]{40}$/.test(evidence.baseCheckpointSha), 'baseCheckpointSha must be a full SHA');
  need(/^[0-9a-f]{40}$/.test(evidence.finalHeadSha), 'finalHeadSha must be a full SHA');
  need(evidence.changedFiles.length > 0, 'exact changed files required (non-empty)');
  need(evidence.commands.length > 0, 'commands actually executed required (non-empty)');
  need(evidence.tests.length > 0, 'test results required (non-empty)');
  need(evidence.overallTestStatus === 'PASS' || evidence.overallTestStatus === 'FAIL', 'overallTestStatus must be PASS|FAIL');
  need(evidence.deliveryCommit.length > 0, 'delivery commit required');
  need(evidence.readyForIndependentQA === 'YES' || evidence.readyForIndependentQA === 'NO', 'readyForIndependentQA must be YES|NO');
  if (evidence.overallTestStatus === 'FAIL' && evidence.readyForIndependentQA === 'YES') {
    fail('overall FAIL cannot be readyForIndependentQA YES');
  }

  let truncated = false;
  const cut = (s: string): string => {
    const r = trunc(s);
    if (r.cut) truncated = true;
    return r.text;
  };
  const artifact: BuilderResultArtifact = {
    schemaVersion: CERT_ARTIFACT_SCHEMA,
    artifactId: starter.artifactId,
    cycleId: starter.cycleId,
    task: starter.task,
    startedAt: starter.startedAt,
    finishedAt: new Date().toISOString(),
    status: 'COMPLETE',
    baseCheckpointSha: evidence.baseCheckpointSha,
    finalHeadSha: evidence.finalHeadSha,
    changedFiles: evidence.changedFiles.map((f) => cut(f)),
    diffStat: cut(evidence.diffStat ?? ''),
    commands: evidence.commands.map((c) => cut(c)),
    tests: evidence.tests.map((t) => ({
      suite: cut(t.suite),
      status: t.status,
      ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
      ...(t.tail ? { tail: cut(t.tail) } : {}),
    })),
    overallTestStatus: evidence.overallTestStatus,
    identity: {
      correlationId: starter.cycleId,
      refs: [...EVIDENCE_REFS.identity, ...EVIDENCE_REFS.handoffCorrelation, ...EVIDENCE_REFS.dispatchSafety],
      note: cut(evidence.identityNote ?? 'Task/Result identity asserted per attempt (taskId+runId); outcomes and audit carry the cycle correlation id.'),
    },
    isolation: {
      refs: [...EVIDENCE_REFS.isolation],
      note: cut(evidence.isolationNote ?? 'Lane A context/task/result cannot enter lane B packet/dispatch (binding triple enforced + distinct-scope test).'),
    },
    delivery: {
      commit: evidence.deliveryCommit,
      tag: evidence.deliveryTag ?? null,
      worktreeClean: evidence.worktreeClean,
      refs: ['git log', 'git tag', 'git status', 'git diff --check'],
    },
    knownRisks: evidence.knownRisks.map((r) => cut(r)),
    readyForIndependentQA: evidence.readyForIndependentQA,
    truncated,
  };
  const bytes = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) fail(`artifact exceeds ${MAX_ARTIFACT_BYTES} bytes (${bytes})`);
  if (artifact.finishedAt < artifact.startedAt) fail('finishedAt precedes startedAt');
  return artifact;
}

export function certArtifactPath(hostRoot: string, cycleId: string): string {
  return path.join(path.resolve(hostRoot), '.agent-relay', 'cert', `BUILDER-RESULT-${cycleId}.json`);
}

export function certDir(hostRoot: string): string {
  return path.join(path.resolve(hostRoot), '.agent-relay', 'cert');
}

export function writeCertArtifact(hostRoot: string, artifact: BuilderResultArtifact): string {
  if (artifact.status !== 'COMPLETE') fail('only COMPLETE artifacts are stored');
  const file = certArtifactPath(hostRoot, artifact.cycleId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readCertArtifact(hostRoot: string, cycleId: string): BuilderResultArtifact | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(certArtifactPath(hostRoot, cycleId), 'utf8'));
    const a = raw as BuilderResultArtifact;
    if (a.schemaVersion !== CERT_ARTIFACT_SCHEMA || a.status !== 'COMPLETE') return null;
    return a;
  } catch {
    return null;
  }
}

/** Newest mandatory orchestration summary in the cert dir (the QA handoff input). */
export function latestMandatorySummary(hostRoot: string): { file: string; summary: Record<string, unknown> } | null {
  const dir = certDir(hostRoot);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('mandatory-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const ranked = files
    .map((f) => ({ f, mt: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mt - a.mt);
  const file = path.join(dir, ranked[0]!.f);
  try {
    return { file, summary: JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> };
  } catch {
    return null;
  }
}
