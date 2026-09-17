/**
 * Deterministic QA → VERIFIED Evidence (round 38, root-cause fix).
 *
 * LIVE DEFECT (Phase C pilot, JuControler-Private-planning TASK-0002): a Task
 * whose `required_evidence` asks for machine-level proof that the deterministic
 * QA actually ran never saw one — the relay worker deliberately never writes
 * Evidence, the QA gate did not either, and the only records bound to the run
 * were ADAPTER_OBSERVATION (trust OBSERVED) and worker prose (CLAIMED). The
 * trust ladder (src/shared/types.ts) correctly refuses to infer ACCEPTED from
 * that — but no component produced VERIFIED evidence, so the loop starved.
 *
 * THIS MODULE is that missing component: when a deterministic QA attempt
 * reaches a PASS/FAIL aggregate verdict, it mints exactly ONE Evidence record
 * through the existing certified collectors (recordTestEvidence /
 * recordQaEvidence — always trustLevel VERIFIED, runId mandatory, resolved
 * server-side). Type is TEST when the attempt contains at least one `command`
 * check, otherwise QA; status mirrors the deterministic aggregate (PASS or
 * FAIL). A BLOCKED aggregate writes nothing: BLOCKED means the check could not
 * run, so there is nothing machine-verified yet (never guess).
 *
 * Idempotency (exactly-once per attempt): the Evidence kernel itself dedupes on
 * `sourceEventId` (`qa-attempt:{qaAttemptId}`) — createEvidenceInternal returns
 * the FIRST record for that key, so a replay of the same attempt never writes a
 * second record and never burns a second EVIDENCE-N. The linkage field
 * `QaAttemptRecord.evidenceIds` is appended through qa-attempt.ts's own
 * idempotent linkQaAttemptEvidence, so reconciliation on the ALREADY_EVALUATED
 * replay path heals a crash between the evidence write and the link without
 * duplicating either side.
 *
 * Summary discipline: check list only; for `command` checks the exact argv
 * (JSON-stringified) + exit code + wall-clock duration, and for FAILing command
 * checks a BOUNDED, secret-scrubbed stdout/stderr tail via the same exporter
 * qa-semantic-evaluator uses (workerOutputTail: ANSI strip → PEM/keys/Bearer/
 * URL-creds/AWS/JWT/token/base64-redaction → last 400 chars). Never raw stdout
 * in the summary, never an unbounded paste; the full (already-bounded) output
 * stays on the attempt's own durable evidence.
 */
import * as path from 'node:path';
import type { EvidenceRecord, EvidenceStatus } from '../shared/types.js';
import {
  linkQaAttemptEvidence,
  qaAttemptFolder,
  type QaAttemptRecord,
  type QaDeterministicCheckResult,
} from './qa-attempt.js';
import { recordQaEvidence, recordTestEvidence } from './evidence.js';
import { workerOutputTail } from './qa-semantic-evaluator.js';

/** Bounded check-listing in the Evidence summary (mirrors the semantic
 * evaluator's own MAX_DETERMINISTIC_SUMMARY_CHARS convention). */
export const MAX_QA_ATTEMPT_EVIDENCE_SUMMARY_CHARS = 4_000;
/** Per-command argv rendering bound inside the details bag. */
const MAX_COMMAND_DETAILS_CHARS = 1_000;
/** Evidence-status of the aggregate (PASS/FAIL only; BLOCKED writes nothing). */
type VerdictStatus = Extract<EvidenceStatus, 'PASS' | 'FAIL'>;

/** Collector idempotency key — exactly one Evidence record per QA attempt,
 * enforced by the Evidence kernel's own `sourceEventId` dedupe. */
export function qaAttemptSourceEventId(qaAttemptId: string): string {
  return `qa-attempt:${qaAttemptId}`;
}

function commandArgvText(c: QaDeterministicCheckResult): string {
  const raw = Array.isArray(c.evidence?.argv) ? c.evidence.argv.map((a) => String(a)) : [];
  const argv = raw.length > 0 ? raw : [c.detail];
  return argv.map((a) => JSON.stringify(a)).join(' ');
}

function describeOneCheck(c: QaDeterministicCheckResult): string {
  const id = c.criterionId ? ` (${c.criterionId})` : '';
  if (c.kind !== 'command') {
    // fileExists / fileExactContent / diffScope: verdict + bounded detail only.
    return `- [${c.status}] ${c.kind}${id}: ${c.detail}`.slice(0, 500);
  }
  const argvText = commandArgvText(c);
  const exit =
    typeof c.evidence?.exitCode === 'number'
      ? ` exit=${String(c.evidence.exitCode)}`
      : c.status === 'FAIL'
        ? ' exit=null'
        : '';
  const dur = typeof c.durationMs === 'number' ? ` ${c.durationMs}ms` : '';
  let line = `- [${c.status}] command${id}: ${argvText}${exit}${dur}`;
  // FAILing command checks may carry a bounded, secret-scrubbed output tail —
  // the scrubber (ANSI strip, PEM/Bearer/JWT/token/base64 redaction, final 400
  // chars) is exported from qa-semantic-evaluator and reused verbatim.
  if (c.status === 'FAIL') {
    const stdout = typeof c.evidence?.stdout === 'string' ? c.evidence.stdout : '';
    const stderr = typeof c.evidence?.stderr === 'string' ? c.evidence.stderr : '';
    if (stdout || stderr) {
      const tail = workerOutputTail({
        stdout,
        stderr,
        exitCode: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      });
      if (tail && tail !== '(no worker output)') line += `\n  output tail: ${tail}`;
    }
  }
  return line;
}

/** Bounded check listing for the summary — check verdicts + (for command
 * checks) exact argv / exit code / duration, and FAIL output tails only. */
export function summarizeQaAttemptDeterministic(attempt: QaAttemptRecord): string {
  const checks = attempt.deterministic?.checks ?? [];
  if (!Array.isArray(checks) || checks.length === 0) return '(no deterministic checks recorded)';
  return checks.map(describeOneCheck).join('\n').slice(0, MAX_QA_ATTEMPT_EVIDENCE_SUMMARY_CHARS);
}

export interface QaAttemptVerifiedEvidenceResult {
  evidenceId?: string;
  evidenceRecord?: EvidenceRecord;
  /** The attempt as durably persisted AFTER linking the evidence id, when a
   * new linkage was applied; otherwise the input attempt (already linked). */
  updatedAttempt?: QaAttemptRecord;
}

/**
 * Mint exactly-one VERIFIED Evidence for a deterministic QA attempt.
 *
 * - Only PASS/FAIL aggregates qualify (BLOCKED = no machine verdict → no write).
 * - `recordTestEvidence` (type TEST) when at least one `command` check ran,
 *   otherwise `recordQaEvidence` (type QA) — both are VERIFIED collectors.
 * - Replay-safe: the Evidence kernel dedupes on `qaAttemptSourceEventId`, and
 *   `linkQaAttemptEvidence` never appends a duplicate id.
 */
export async function recordQaAttemptVerifiedEvidence(
  dataRoot: string,
  project: string,
  attempt: QaAttemptRecord,
): Promise<QaAttemptVerifiedEvidenceResult> {
  const det = attempt.deterministic;
  if (!det) return {};
  if (det.status !== 'PASS' && det.status !== 'FAIL') return {};
  const checks = Array.isArray(det.checks) ? det.checks : [];
  if (checks.length === 0) return {};

  const status: VerdictStatus = det.status;
  const summary = summarizeQaAttemptDeterministic(attempt);
  const sourceEventId = qaAttemptSourceEventId(attempt.qaAttemptId);
  const rawRef = path.join(qaAttemptFolder(dataRoot, project, attempt.qaAttemptId), 'qa.json');
  const source = { kind: 'qa-gate', tool: 'qa-deterministic-evaluator' } as const;
  const hasCommand = checks.some((c) => c.kind === 'command');

  const record = hasCommand
    ? await recordTestEvidence(dataRoot, project, {
      summary,
      status,
      source,
      taskId: attempt.taskId,
      runId: attempt.runId,
      sourceEventId,
      rawRef,
      details: buildTestDetails(checks, summary),
    })
    : await recordQaEvidence(dataRoot, project, {
      summary,
      status,
      source,
      taskId: attempt.taskId,
      runId: attempt.runId,
      sourceEventId,
      rawRef,
      details: { verdict: status, findingsSummary: summary.slice(0, 2_000) },
    });

  // Link the Evidence id onto the durable attempt (append-only, idempotent).
  const linked = (attempt.evidenceIds ?? []).includes(record.evidenceId)
    ? attempt
    : await linkQaAttemptEvidence(dataRoot, project, attempt.qaAttemptId, record.evidenceId);
  return { evidenceId: record.evidenceId, evidenceRecord: record, updatedAttempt: linked };
}

function buildTestDetails(checks: QaDeterministicCheckResult[], summary: string): {
  command?: string;
  exitCode?: number;
  durationMs?: number;
  resultSummary: string;
} {
  const commandChecks = checks.filter((c) => c.kind === 'command');
  const single = commandChecks.length === 1 ? commandChecks[0] : undefined;
  return {
    ...(single !== undefined
      ? { command: commandArgvText(single).slice(0, MAX_COMMAND_DETAILS_CHARS) }
      : {}),
    ...(single !== undefined && typeof single.evidence?.exitCode === 'number'
      ? { exitCode: single.evidence.exitCode as number }
      : {}),
    ...(single !== undefined && typeof single.durationMs === 'number'
      ? { durationMs: single.durationMs }
      : {}),
    resultSummary: summary.slice(0, 2_000),
  };
}
