/**
 * V1.6 Slice 3 — Semantic QA Agent dispatch.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §7, §8, §10 (accepted
 * f1c8959; Slice 1 kernel c57d996, dac4ed6; Slice 2 deterministic evaluator
 * 8380dda). This file implements ONLY the semantic half of the QA Attempt
 * state machine: dispatching one bounded QA Agent invocation, parsing its
 * strict structured output, and persisting the result via Slice 1's own
 * `recordSemanticEvidence`. It does NOT:
 *
 *   - wire into result-bridge.ts or auto-run on any Task/Run event
 *   - implement QA FAIL remediation dispatch (§11) or retry-limit escalation
 *     (§12) — those are later slices
 *   - expose any MCP tool
 *   - read a Task's `qaContract`/`acceptanceCriteria` (those fields do not
 *     exist on TaskRecord yet — this Slice takes the frozen Task
 *     prompt/goal/scope and the SEMANTIC/BOTH criterion text as trusted
 *     fixture input, the same seam Slice 2 established for `checks`)
 *
 * ── Invocation rule (§10, mandatory not optional) ───────────────────────
 * Only ever called when deterministic already PASSed AND at least one AC
 * has validationMode SEMANTIC or BOTH — both preconditions are re-checked
 * here defensively (never trusted from the caller), mirroring how Slice 1's
 * own `recordSemanticEvidence` already refuses to run without deterministic
 * PASS. This evaluator does not decide WHETHER to invoke — that's Slice 4's
 * job once it wires the real Task; it only performs the invocation once
 * asked, and refuses if the precondition doesn't actually hold.
 *
 * ── Dispatch (isolated path — confirmed with the user, not a redesign of
 * the implementation-Worker dispatch pipeline) ──────────────────────────
 * The QA Agent is a disposable non-canonical sub-run — never linked into
 * Task.linkedRuns, never routed through dispatcher.ts/relay-worker-claude.mjs.
 * `qaWorkerId` resolves through the existing worker-registry.ts record set
 * (`role` tag additive, worker-registry.ts). spawn(launchCommand, argv,
 * {shell:false}) with the bounded composed prompt as a single trailing argv
 * element (never a shell string, never stdin timing to reason about) — same
 * runProcess() mechanics Slice 2 already uses for `command`/`diffScope`,
 * reused as-is. cwd = the implementation Run's own workspaceRoot (same
 * canonical binding Slice 2 resolves), so the Agent can independently
 * inspect the actual code if the bounded prompt text isn't sufficient.
 * Its own artifacts live under a distinct namespace,
 * `{dataRoot}/{project}/_relay/qa-semantic-runs/{qaAttemptId}/`, entirely
 * outside the Run-folder tree so no existing history/evidence scanner can
 * ever mistake it for a real Run — referenced only via
 * `QaAttemptRecord.semantic.sessionRef`, never via Task.linkedRuns.
 *
 * ── Input (§10, bounded, Relay-composed) ────────────────────────────────
 * Frozen Task prompt/goal/scope (caller-supplied fixture input); only the
 * AC ids whose validationMode is SEMANTIC or BOTH — this SET is DERIVED
 * from the QaAttemptRecord's own `criteriaValidationModes` snapshot, never
 * separately re-declared by the caller (§7 point 4: "this set is derived,
 * never separately re-declared, so it can never drift out of sync"); bounded
 * Worker Result text (same truncation convention as
 * pm-verification-context.ts's VERIFICATION_RESULT_TEXT_MAX_CHARS, reused
 * directly — that module's own reader is private, so the reading logic is
 * replicated at the same bound, not reinvented at a different one); bounded
 * deterministic QA summary read from the attempt's own persisted evidence.
 * Never sent: the entire repository, full conversation history, GPT PM
 * chain-of-thought, secrets, unrelated Task history.
 *
 * ── Output (§10) ─────────────────────────────────────────────────────────
 * Strict structured text only, parsed by a narrow deterministic line parser
 * — tolerant of surrounding whitespace, never guesses PASS on anything it
 * can't fully validate against the derived SEMANTIC/BOTH id set. Any output
 * that fails to parse, times out, or errors → BLOCKED, with exactly ONE
 * bounded auto-reattempt of the invocation itself (never a second QA
 * attempt, never consumes any remediation budget — Slice 4's concern) before
 * finalizing BLOCKED.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { relayDir } from './goal-task.js';
import { loadWorkerRegistryRecord, WorkerRegistryError } from './worker-registry.js';
import {
  ProcessOutcome,
  QaDeterministicEvaluatorError,
  resolveAuthoritativeRunBinding,
  runProcess,
  withQaEvaluatorLock,
} from './qa-deterministic-evaluator.js';
import {
  type QaAttemptRecord,
  type QaSemanticCriterionResult,
  getQaAttempt,
  recordSemanticEvidence,
} from './qa-attempt.js';

// ── bounds ───────────────────────────────────────────────────────────────────

/** Same truncation convention pm-verification-context.ts already applies for
 * the GPT-facing Worker Result view — replicated here at the identical bound
 * (that module's own reader is private, not exported). */
export const SEMANTIC_QA_RESULT_TEXT_MAX_CHARS = 10_000;
/** Per-field bound for the frozen Task prompt/goal/scope, mirroring
 * retry-prompt.ts's own narrative bounds. */
const MAX_TASK_FIELD_CHARS = 4_000;
/** Bound per SEMANTIC/BOTH criterion's frozen text. */
const MAX_CRITERION_TEXT_CHARS = 1_000;
/** Bound for the deterministic-check summary line included in the prompt. */
const MAX_DETERMINISTIC_SUMMARY_CHARS = 4_000;
/** Total composed prompt cap — same 16 KiB cap retry-prompt.ts/the initial
 * Worker prompt already use. */
export const SEMANTIC_QA_PROMPT_SIZE_LIMIT_BYTES = 16 * 1024;
/** Default/ceiling invocation timeout — a QA Agent turn is a single bounded
 * judgment call, not an implementation session. */
export const DEFAULT_SEMANTIC_QA_TIMEOUT_MS = 120_000;
export const MAX_SEMANTIC_QA_TIMEOUT_MS = 300_000;

function boundText(value: unknown, maxChars: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

// ── errors ───────────────────────────────────────────────────────────────────

export class QaSemanticEvaluatorError extends Error {
  /**
   * INVALID_ARGUMENT: a caller-input shape violation (SEMANTIC/BOTH id set
   * mismatch, missing criterion text, empty derived set) — refused up
   * front, nothing dispatched, nothing persisted.
   * BLOCKED: a precondition failed (deterministic not PASS yet, no
   * qaWorkerId configured, worker registry entry missing/invalid, canonical
   * Run/Task binding broken) — refused before dispatch, QaAttemptRecord
   * untouched, mirroring qa-deterministic-evaluator.ts's own precondition
   * refusals exactly.
   */
  readonly code: 'INVALID_ARGUMENT' | 'BLOCKED';
  constructor(code: QaSemanticEvaluatorError['code'], message: string) {
    super(message);
    this.name = 'QaSemanticEvaluatorError';
    this.code = code;
  }
}

// ── bounded Worker Result text (same convention as pm-verification-context.ts) ─

/** Read Worker result text from the exact bound Run folder — result.md then
 * agent-result.md fallback, missing/empty both → empty text (never
 * fabricated). Mirrors pm-verification-context.ts's private reader at the
 * identical bound; that function isn't exported, so this small amount of
 * logic is replicated rather than reaching into a private module internal. */
function readBoundedWorkerResultText(runFolder: string): { text: string; truncated: boolean; source: string } {
  const readArtifact = (name: string): string | undefined => {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(runFolder, name), 'utf8');
    } catch {
      return undefined;
    }
    return raw.trim().length > 0 ? raw : undefined;
  };
  const bound = (text: string, source: string) =>
    text.length > SEMANTIC_QA_RESULT_TEXT_MAX_CHARS
      ? { text: text.slice(0, SEMANTIC_QA_RESULT_TEXT_MAX_CHARS), truncated: true, source }
      : { text, truncated: false, source };
  const fromResult = readArtifact('result.md');
  if (fromResult !== undefined) return bound(fromResult, 'result.md');
  const fromAgent = readArtifact('agent-result.md');
  if (fromAgent !== undefined) return bound(fromAgent, 'agent-result.md');
  return { text: '', truncated: false, source: 'missing' };
}

// ── bounded deterministic QA summary ────────────────────────────────────────

/** Bounded check-id + verdict summary — never raw stdout unless a check
 * FAILed, and even then truncated (§10). */
function summarizeDeterministicEvidence(attempt: QaAttemptRecord): string {
  const checks = attempt.deterministic?.checks ?? [];
  if (checks.length === 0) return '(no deterministic checks recorded)';
  const lines = checks.map((c) => {
    const base = `- [${c.status}] ${c.kind}${c.criterionId ? ` (${c.criterionId})` : ''}: ${c.detail}`;
    if (c.status !== 'FAIL') return base;
    const stdout = typeof c.evidence?.stdout === 'string' ? c.evidence.stdout : undefined;
    return stdout ? `${base}\n  stdout: ${boundText(stdout, 500)}` : base;
  });
  return boundText(lines.join('\n'), MAX_DETERMINISTIC_SUMMARY_CHARS);
}

// ── prompt composition (mirrors retry-prompt.ts's composeRetryPrompt style) ────

export interface SemanticQaPromptInput {
  qaAttemptId: string;
  task: { title: string; goal: string; reason: string; scope: string };
  /** id → frozen criterion text, exactly the SEMANTIC/BOTH set derived from
   * the attempt's own criteriaValidationModes (never caller-declared). */
  criteria: { id: string; text: string }[];
  workerResult: { text: string; truncated: boolean; source: string };
  deterministicSummary: string;
}

/** Pure, deterministic prompt composition — no I/O. Throws if the composed
 * prompt would exceed the 16 KiB cap (fail safe, never silently truncate an
 * already-bounded composition into a misleading instruction). */
export function composeSemanticQaPrompt(input: SemanticQaPromptInput): string {
  const criteriaBlock = input.criteria
    .map((c) => `- ${c.id}: ${boundText(c.text, MAX_CRITERION_TEXT_CHARS)}`)
    .join('\n') || '- (none)';
  const prompt = [
    'You are the Semantic QA Agent for one Agent Relay QA Attempt.',
    'You verify — you do not implement, and you are not the PM.',
    '',
    `QA Attempt ID: ${input.qaAttemptId}`,
    '',
    'FROZEN TASK',
    'Title:',
    boundText(input.task.title, 2000),
    '',
    'Goal:',
    boundText(input.task.goal, MAX_TASK_FIELD_CHARS),
    '',
    'Reason:',
    boundText(input.task.reason, MAX_TASK_FIELD_CHARS) || '(none)',
    '',
    'Scope:',
    boundText(input.task.scope, MAX_TASK_FIELD_CHARS) || '(none)',
    '',
    'ACCEPTANCE CRITERIA REQUIRING YOUR JUDGMENT (SEMANTIC/BOTH only)',
    criteriaBlock,
    '',
    'DETERMINISTIC QA ALREADY PASSED — mechanical facts only, not intent:',
    input.deterministicSummary,
    '',
    'WORKER RESULT (as claimed by the Worker; verify, do not just trust)',
    `Source: ${input.workerResult.source}${input.workerResult.truncated ? ' (truncated)' : ''}`,
    input.workerResult.text || '(no result text available)',
    '',
    'RULES',
    'Evaluate ONLY the acceptance criteria listed above.',
    'Do not invent new requirements. Do not broaden scope. Do not improve the product beyond what was asked.',
    'Do not alter or reinterpret the acceptance criteria.',
    'You never ACCEPT or request CHANGES on the Task — that is GPT PM authority only.',
    '',
    'OUTPUT — respond with EXACTLY ONE of the two following forms, nothing else:',
    '',
    'status: PASS',
    'criteria:',
    ...input.criteria.map((c) => `- ${c.id}: PASS`),
    '',
    'or',
    '',
    'status: FAIL',
    'failedCriteria:',
    '- <criterion id that failed>',
    'reason: <bounded free text>',
    'remediationInstruction: <bounded free text, no new requirements>',
  ].join('\n');

  const encoded = Buffer.byteLength(prompt, 'utf8');
  if (encoded > SEMANTIC_QA_PROMPT_SIZE_LIMIT_BYTES) {
    throw new QaSemanticEvaluatorError(
      'INVALID_ARGUMENT',
      `Semantic QA prompt exceeds size limit: ${encoded} bytes > ${SEMANTIC_QA_PROMPT_SIZE_LIMIT_BYTES} bytes (16 KiB).`,
    );
  }
  return prompt;
}

// ── output parsing (tolerant-but-never-guessing, mirrors extract.ts's style) ───

export type ParsedSemanticOutput =
  | { kind: 'pass'; criteria: QaSemanticCriterionResult[] }
  | { kind: 'fail'; failedCriteria: string[]; reason?: string; remediationInstruction?: string; criteria: QaSemanticCriterionResult[] }
  | { kind: 'unparseable'; reason: string };

/** Extract the value after "key:" on a line, or undefined if the line
 * doesn't start with that key (case-sensitive, per the frozen output spec). */
function lineValue(line: string, key: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.toLowerCase().startsWith(`${key.toLowerCase()}:`)) return undefined;
  return trimmed.slice(key.length + 1).trim();
}

/** "- <text>" bullet line, or undefined. */
function bulletValue(line: string): string | undefined {
  const trimmed = line.trim();
  return trimmed.startsWith('- ') ? trimmed.slice(2).trim() : undefined;
}

/**
 * Parse the QA Agent's raw stdout against the exact SEMANTIC/BOTH id set
 * this invocation was asked to judge (`requiredIds`). Never accepts an
 * output that claims to cover a different set — a PASS missing a required
 * id, a PASS covering an id outside the set, or a FAIL citing an unknown id
 * are all treated as unparseable (fail closed), never partially trusted.
 */
export function parseSemanticQaOutput(raw: string, requiredIds: readonly string[]): ParsedSemanticOutput {
  const lines = raw.split('\n');
  const required = new Set(requiredIds);
  let statusLine: string | undefined;
  let statusIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const v = lineValue(lines[i], 'status');
    if (v !== undefined) {
      statusLine = v;
      statusIndex = i;
      break;
    }
  }
  if (statusLine === undefined) return { kind: 'unparseable', reason: '"status:" 라인을 찾을 수 없습니다.' };

  if (statusLine === 'PASS') {
    // Expect a "criteria:" header followed by "- AC-xx: PASS|FAIL" bullets.
    const seen = new Map<string, 'PASS' | 'FAIL'>();
    for (let i = statusIndex + 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === '' || trimmed === 'criteria:') continue;
      const bullet = bulletValue(lines[i]);
      if (bullet === undefined) break; // next top-level key or end of block
      const m = /^(.+?):\s*(PASS|FAIL)$/.exec(bullet);
      if (!m) return { kind: 'unparseable', reason: `criteria 항목 형식이 잘못되었습니다: "${bullet}"` };
      seen.set(m[1].trim(), m[2] as 'PASS' | 'FAIL');
    }
    for (const id of required) {
      if (seen.get(id) !== 'PASS') {
        return { kind: 'unparseable', reason: `status:PASS 이지만 요구된 기준 ${id}가 criteria 목록에서 PASS로 확인되지 않았습니다.` };
      }
    }
    for (const id of seen.keys()) {
      if (!required.has(id)) {
        return { kind: 'unparseable', reason: `criteria 목록에 요청되지 않은 기준 ${id}가 포함되어 있습니다 (새 요구사항 발명 금지).` };
      }
    }
    const criteria: QaSemanticCriterionResult[] = [...seen.entries()].map(([id, status]) => ({ id, status, note: 'semantic PASS' }));
    return { kind: 'pass', criteria };
  }

  if (statusLine === 'FAIL') {
    const failedCriteria: string[] = [];
    let reason: string | undefined;
    let remediationInstruction: string | undefined;
    let cursor = statusIndex + 1;
    // "failedCriteria:" header + bullets
    if (lineValue(lines[cursor] ?? '', 'failedCriteria') === undefined && (lines[cursor] ?? '').trim() !== 'failedCriteria:') {
      return { kind: 'unparseable', reason: '"failedCriteria:" 헤더를 찾을 수 없습니다.' };
    }
    cursor += 1;
    for (; cursor < lines.length; cursor += 1) {
      const bullet = bulletValue(lines[cursor]);
      if (bullet === undefined) break;
      failedCriteria.push(bullet);
    }
    if (failedCriteria.length === 0) {
      return { kind: 'unparseable', reason: 'status:FAIL 이지만 failedCriteria가 비어 있습니다.' };
    }
    for (const id of failedCriteria) {
      if (!required.has(id)) {
        return { kind: 'unparseable', reason: `failedCriteria에 요청되지 않은 기준 ${id}가 포함되어 있습니다 (새 요구사항 발명 금지).` };
      }
    }
    for (; cursor < lines.length; cursor += 1) {
      const r = lineValue(lines[cursor], 'reason');
      if (r !== undefined) { reason = r; continue; }
      const ri = lineValue(lines[cursor], 'remediationInstruction');
      if (ri !== undefined) { remediationInstruction = ri; continue; }
    }
    const criteria: QaSemanticCriterionResult[] = [...required].map((id) => ({
      id,
      status: failedCriteria.includes(id) ? 'FAIL' : 'PASS',
      note: failedCriteria.includes(id) ? (reason ?? 'semantic FAIL') : 'semantic PASS',
    }));
    return { kind: 'fail', failedCriteria, ...(reason ? { reason: boundText(reason, 1000) } : {}), ...(remediationInstruction ? { remediationInstruction: boundText(remediationInstruction, 4000) } : {}), criteria };
  }

  return { kind: 'unparseable', reason: `알 수 없는 status 값: "${statusLine}" (PASS 또는 FAIL만 허용)` };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function qaSemanticRunDir(dataRoot: string, project: string, qaAttemptId: string): string {
  return path.join(relayDir(dataRoot, project), 'qa-semantic-runs', qaAttemptId);
}

async function invokeOnce(
  launchCommand: string,
  launchArgsPrefix: string[],
  prompt: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  return runProcess(launchCommand, [...launchArgsPrefix, '--print', prompt], cwd, timeoutMs);
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface EvaluateSemanticQaInput {
  qaAttemptId: string;
  /** Frozen Task prompt/goal/scope — trusted fixture input (Slice 4 derives
   * this from the real Task; TaskRecord has no such field yet). */
  task: { title: string; goal: string; reason: string; scope: string };
  /** id → frozen criterion text for EXACTLY the SEMANTIC/BOTH set on this
   * attempt's own criteriaValidationModes — validated, not trusted verbatim. */
  criteriaText: Record<string, string>;
  timeoutMs?: number;
}

export type QaSemanticEvaluationOutcome =
  | { outcome: 'EVALUATED'; record: QaAttemptRecord }
  | { outcome: 'ALREADY_EVALUATED'; record: QaAttemptRecord };

/**
 * Dispatch one bounded Semantic QA Agent invocation (with one bounded
 * auto-reattempt on parse failure/timeout/error) for a PENDING QaAttemptRecord
 * whose deterministic layer already PASSed, and persist the outcome via
 * Slice 1's own recordSemanticEvidence. Never fabricates semantic evidence;
 * never invoked when deterministic hasn't PASSed (Slice 1's non-override
 * invariant, re-checked defensively here too); never touches Task/RunMeta/
 * ExecutionPlan storage — only reads them to validate the canonical binding,
 * exactly like qa-deterministic-evaluator.ts.
 *
 * Idempotent: an attempt that already has semantic evidence is never
 * re-evaluated (no duplicate Agent dispatch). Concurrent calls for the same
 * qaAttemptId are serialized by the SAME process-local lock Slice 2 uses.
 */
export function evaluateSemanticQa(
  dataRoot: string,
  project: string,
  input: EvaluateSemanticQaInput,
): Promise<QaSemanticEvaluationOutcome> {
  return withQaEvaluatorLock(dataRoot, project, input.qaAttemptId, async (): Promise<QaSemanticEvaluationOutcome> => {
    // getQaAttempt propagates NOT_FOUND / CORRUPT_RECORD untouched — this
    // evaluator never treats a corrupt attempt as absent or repairs it.
    const attempt = getQaAttempt(dataRoot, project, input.qaAttemptId);
    if (attempt.semantic !== undefined) {
      return { outcome: 'ALREADY_EVALUATED', record: attempt };
    }
    // Non-override invariant, re-checked defensively (Slice 1's own
    // recordSemanticEvidence already enforces this — this is defense in
    // depth, never a second source of truth for the rule).
    if (!attempt.deterministic || attempt.deterministic.status !== 'PASS') {
      throw new QaSemanticEvaluatorError(
        'BLOCKED',
        `QA Attempt ${input.qaAttemptId}는 deterministic PASS 없이는 semantic 평가를 시작할 수 없습니다 (non-override invariant).`,
      );
    }

    // The SEMANTIC/BOTH id set is DERIVED from the attempt's own snapshot —
    // never separately declared by the caller (§7 point 4).
    const requiredIds = Object.entries(attempt.criteriaValidationModes ?? {})
      .filter(([, mode]) => mode === 'SEMANTIC' || mode === 'BOTH')
      .map(([id]) => id)
      .sort();
    if (requiredIds.length === 0) {
      throw new QaSemanticEvaluatorError(
        'INVALID_ARGUMENT',
        `QA Attempt ${input.qaAttemptId}에는 SEMANTIC/BOTH 기준이 없습니다 — semantic 평가를 호출할 필요가 없습니다.`,
      );
    }
    const providedIds = Object.keys(input.criteriaText).sort();
    if (JSON.stringify(providedIds) !== JSON.stringify(requiredIds)) {
      throw new QaSemanticEvaluatorError(
        'INVALID_ARGUMENT',
        `criteriaText는 정확히 파생된 SEMANTIC/BOTH 집합과 일치해야 합니다. required=${JSON.stringify(requiredIds)} provided=${JSON.stringify(providedIds)}`,
      );
    }

    if (!attempt.qaWorkerId) {
      throw new QaSemanticEvaluatorError('BLOCKED', `QA Attempt ${input.qaAttemptId}에 qaWorkerId가 설정되어 있지 않습니다.`);
    }
    let worker;
    try {
      worker = loadWorkerRegistryRecord(dataRoot, attempt.qaWorkerId);
    } catch (err) {
      const msg = err instanceof WorkerRegistryError ? err.message : String(err);
      throw new QaSemanticEvaluatorError('BLOCKED', `qaWorkerId '${attempt.qaWorkerId}'를 worker registry에서 확인할 수 없습니다: ${msg}`);
    }

    const { workspaceRoot, runFolder } = resolveAuthoritativeRunBindingOrRethrow(dataRoot, project, attempt);

    const timeoutMs = input.timeoutMs ?? DEFAULT_SEMANTIC_QA_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SEMANTIC_QA_TIMEOUT_MS) {
      throw new QaSemanticEvaluatorError('INVALID_ARGUMENT', `timeoutMs가 유효하지 않습니다 (1..${MAX_SEMANTIC_QA_TIMEOUT_MS}): ${String(input.timeoutMs)}`);
    }

    const workerResult = readBoundedWorkerResultText(runFolder);
    const deterministicSummary = summarizeDeterministicEvidence(attempt);
    const criteria = requiredIds.map((id) => ({ id, text: input.criteriaText[id] }));
    const prompt = composeSemanticQaPrompt({
      qaAttemptId: input.qaAttemptId,
      task: input.task,
      criteria,
      workerResult,
      deterministicSummary,
    });

    const runDir = qaSemanticRunDir(dataRoot, project, input.qaAttemptId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'prompt.md'), prompt, 'utf8');

    const sessionRef = `qa-semantic-runs/${input.qaAttemptId}`;
    const startedAt = new Date().toISOString();

    // One invocation, then — only on parse failure/timeout/error — exactly
    // one bounded auto-reattempt of the invocation itself (§10 Q9). Never a
    // second QA attempt, never a remediation-budget consumption.
    let parsed: ParsedSemanticOutput = { kind: 'unparseable', reason: '(invocation not attempted)' };
    let lastOutcome: ProcessOutcome | undefined;
    for (let attemptNo = 1; attemptNo <= 2; attemptNo += 1) {
      const outcome = await invokeOnce(worker.launchCommand, worker.launchArgsPrefix, prompt, workspaceRoot, timeoutMs);
      lastOutcome = outcome;
      fs.writeFileSync(path.join(runDir, `attempt-${attemptNo}-stdout.txt`), outcome.stdout, 'utf8');
      if (outcome.stderr) fs.writeFileSync(path.join(runDir, `attempt-${attemptNo}-stderr.txt`), outcome.stderr, 'utf8');
      if (outcome.spawnError || outcome.timedOut || outcome.exitCode === null) {
        parsed = { kind: 'unparseable', reason: outcome.spawnError ? `실행 실패: ${outcome.spawnError}` : outcome.timedOut ? '시간 초과' : '종료 코드를 확인할 수 없습니다.' };
        continue; // try the bounded reattempt (attemptNo 2), or fall through to BLOCKED
      }
      parsed = parseSemanticQaOutput(outcome.stdout, requiredIds);
      if (parsed.kind !== 'unparseable') break; // success — no reattempt needed
    }
    const completedAt = new Date().toISOString();

    if (parsed.kind === 'unparseable') {
      fs.writeFileSync(path.join(runDir, 'blocked-reason.txt'), parsed.reason, 'utf8');
      const record = await recordSemanticEvidence(dataRoot, project, input.qaAttemptId, {
        status: 'BLOCKED',
        criteria: [],
        qaWorkerId: attempt.qaWorkerId,
        sessionRef,
        startedAt,
        completedAt,
      });
      return { outcome: 'EVALUATED', record };
    }

    if (parsed.kind === 'pass') {
      const record = await recordSemanticEvidence(dataRoot, project, input.qaAttemptId, {
        status: 'PASS',
        criteria: parsed.criteria,
        qaWorkerId: attempt.qaWorkerId,
        sessionRef,
        startedAt,
        completedAt,
      });
      return { outcome: 'EVALUATED', record };
    }

    // parsed.kind === 'fail'
    const record = await recordSemanticEvidence(dataRoot, project, input.qaAttemptId, {
      status: 'FAIL',
      criteria: parsed.criteria,
      failedCriteria: parsed.failedCriteria,
      qaWorkerId: attempt.qaWorkerId,
      sessionRef,
      startedAt,
      completedAt,
      ...(parsed.remediationInstruction ? { remediationInstruction: parsed.remediationInstruction } : {}),
    });
    void lastOutcome;
    return { outcome: 'EVALUATED', record };
  });
}

/** Thin rethrow wrapper so a QaDeterministicEvaluatorError('BLOCKED', …) from
 * the shared binding resolver surfaces as this module's own error type —
 * callers of this module should only ever see QaSemanticEvaluatorError. */
function resolveAuthoritativeRunBindingOrRethrow(
  dataRoot: string,
  project: string,
  attempt: QaAttemptRecord,
): { workspaceRoot: string; runFolder: string } {
  try {
    return resolveAuthoritativeRunBinding(dataRoot, project, attempt);
  } catch (err) {
    if (err instanceof QaDeterministicEvaluatorError) {
      throw new QaSemanticEvaluatorError('BLOCKED', err.message);
    }
    throw err;
  }
}
