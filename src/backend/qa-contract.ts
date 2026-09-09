/**
 * V1.6 Slice 4 — frozen Task-side QA contract validation + server-side
 * derivation.
 *
 * Frozen architecture: docs/V16-QA-GATE-PLAN-01.md §6, §7 (accepted commit
 * f1c8959). This module owns the ONLY trust boundary for the Task-side QA
 * contract:
 *
 *   - `validateTaskQaContractFields()` — creation-time (and persisted-read)
 *     validation of `acceptanceCriteria` + `qaContract`, enforcing every §7
 *     rule. Fail closed: any violation throws, nothing is persisted.
 *   - `deriveQaEvaluationContract()` — server-side derivation of everything
 *     the Slice 2/3 evaluators need (deterministic check defs,
 *     criteriaValidationModes snapshot, semantic criterion text, worker id,
 *     remediation budget) from the authoritative Task record. No MCP tool,
 *     Worker, or QA Agent caller may supply or override these — the
 *     instruction explicitly forbids trusting caller input for failed
 *     criteria, validation modes, Task/Worker/workspace identity, or the
 *     remediation count.
 *
 * Pure: no Task/Run storage reads, no persistence, no dispatch. The gate
 * (qa-gate.ts) reads the Task and passes it in.
 */

import type {
  AcceptanceCriterion,
  AcceptanceCriterionValidationMode,
  DeterministicQaCheck,
  QaContract,
  TaskRecord,
} from '../shared/types.js';
import type { QaDeterministicCheckDef } from './qa-deterministic-evaluator.js';
import type { QaCriterionValidationMode } from './qa-attempt.js';

/** Frozen default remediation budget (plan §12). */
export const DEFAULT_MAX_QA_REMEDIATION_ATTEMPTS = 2;
/** Hard ceiling for an explicit per-Task override — a bounded retry budget
 * must stay bounded; larger values are rejected at creation. */
export const MAX_QA_REMEDIATION_ATTEMPTS_CEILING = 10;
/** Frozen ceiling for `command` checks (plan §7 item 2). Mirrors the Slice 2
 * evaluator's own MAX_COMMAND_TIMEOUT_MS — validated here too so a bad
 * contract is rejected at creation, not at first evaluation. */
export const MAX_QA_COMMAND_TIMEOUT_MS = 300_000;

export class QaContractError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'INVALID_STATE';
  constructor(code: QaContractError['code'], message: string) {
    super(message);
    this.name = 'QaContractError';
    this.code = code;
  }
}

const VALIDATION_MODES: ReadonlySet<string> = new Set(['DETERMINISTIC', 'SEMANTIC', 'BOTH']);
const CHECK_KINDS: ReadonlySet<string> = new Set(['fileExists', 'fileExactContent', 'diffScope', 'command']);
const TASK_ID_RE = /^TASK-\d+$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && !!v.trim();
}

/** Normalize a workspace-relative path lexically (no filesystem access).
 * Returns null for absolute paths, NUL-containing paths, or `..` traversals
 * that would escape the workspace root. `.` (the root itself) is valid. */
function normalizeWorkspaceRelative(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) return null;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return null;
  const parts = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function validateAcceptanceCriteriaList(input: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new QaContractError('INVALID_ARGUMENT', 'acceptanceCriteria는 비어 있지 않은 배열이어야 합니다.');
  }
  const seen = new Set<string>();
  const out: AcceptanceCriterion[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      throw new QaContractError('INVALID_ARGUMENT', 'acceptanceCriteria 항목이 잘못되었습니다.');
    }
    const row = entry as Record<string, unknown>;
    if (!isNonEmptyString(row.id)) {
      throw new QaContractError('INVALID_ARGUMENT', 'acceptanceCriteria[].id가 필요합니다.');
    }
    const id = (row.id as string).trim();
    if (seen.has(id)) {
      throw new QaContractError('INVALID_ARGUMENT', `중복된 acceptanceCriteria id: ${id}`);
    }
    seen.add(id);
    if (!isNonEmptyString(row.description)) {
      throw new QaContractError('INVALID_ARGUMENT', `acceptanceCriteria ${id}의 description이 필요합니다.`);
    }
    if (typeof row.validationMode !== 'string' || !VALIDATION_MODES.has(row.validationMode)) {
      throw new QaContractError(
        'INVALID_ARGUMENT',
        `acceptanceCriteria ${id}의 validationMode는 DETERMINISTIC/SEMANTIC/BOTH 중 하나여야 합니다: ${String(row.validationMode)}`,
      );
    }
    out.push({
      id,
      description: (row.description as string).trim(),
      validationMode: row.validationMode as AcceptanceCriterionValidationMode,
    });
  }
  return out;
}

function validateCommandCheck(check: Record<string, unknown>, index: number): void {
  if (!isNonEmptyString(check.command)) {
    throw new QaContractError('INVALID_ARGUMENT', `deterministic[${index}].command가 비어 있지 않은 문자열이어야 합니다.`);
  }
  // Never a shell string: the executable must be a single argv[0]-style
  // token, not a composed command line. Shell metacharacters that only make
  // sense inside a shell are rejected at creation.
  if (/[\s;|&$`"'<>(){}\\!]/.test(check.command as string)) {
    throw new QaContractError(
      'INVALID_ARGUMENT',
      `deterministic[${index}].command는 shell 문자열이 아니라 단일 실행 파일이어야 합니다: ${check.command as string}`,
    );
  }
  if (!Array.isArray(check.args) || (check.args as unknown[]).some((a) => typeof a !== 'string')) {
    throw new QaContractError('INVALID_ARGUMENT', `deterministic[${index}].args는 문자열 배열이어야 합니다.`);
  }
  if (check.cwd !== undefined) {
    if (normalizeWorkspaceRelative(check.cwd) === null) {
      throw new QaContractError('INVALID_ARGUMENT', `deterministic[${index}].cwd는 workspace 상대 경로여야 합니다.`);
    }
  }
  if (check.timeoutMs !== undefined) {
    const t = check.timeoutMs;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > MAX_QA_COMMAND_TIMEOUT_MS) {
      throw new QaContractError(
        'INVALID_ARGUMENT',
        `deterministic[${index}].timeoutMs는 1..${MAX_QA_COMMAND_TIMEOUT_MS} 범위여야 합니다: ${String(t)}`,
      );
    }
  }
  if (check.expectExitCode !== undefined) {
    if (typeof check.expectExitCode !== 'number' || !Number.isInteger(check.expectExitCode)) {
      throw new QaContractError('INVALID_ARGUMENT', `deterministic[${index}].expectExitCode는 정수여야 합니다.`);
    }
  }
}

function validateDeterministicChecks(input: unknown): DeterministicQaCheck[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new QaContractError('INVALID_ARGUMENT', 'qaContract.deterministic은 비어 있지 않은 배열이어야 합니다.');
  }
  const out: DeterministicQaCheck[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const check = input[i];
    if (!check || typeof check !== 'object') {
      throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}] 항목이 잘못되었습니다.`);
    }
    const row = check as Record<string, unknown>;
    if (typeof row.kind !== 'string' || !CHECK_KINDS.has(row.kind)) {
      throw new QaContractError('INVALID_ARGUMENT', `허용되지 않은 deterministic check kind: ${String(row.kind)}`);
    }
    if (row.criterionId !== undefined && !isNonEmptyString(row.criterionId)) {
      throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].criterionId는 비어 있지 않은 문자열이어야 합니다.`);
    }
    const criterionId = isNonEmptyString(row.criterionId) ? (row.criterionId as string).trim() : undefined;
    switch (row.kind) {
      case 'fileExists': {
        if (normalizeWorkspaceRelative(row.path) === null && row.path !== '.') {
          throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].path는 workspace 상대 경로여야 합니다.`);
        }
        out.push({ kind: 'fileExists', path: row.path as string, ...(criterionId ? { criterionId } : {}) });
        break;
      }
      case 'fileExactContent': {
        if (normalizeWorkspaceRelative(row.path) === null) {
          throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].path는 workspace 상대 경로여야 합니다.`);
        }
        if (typeof row.content !== 'string') {
          throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].content는 문자열이어야 합니다.`);
        }
        out.push({ kind: 'fileExactContent', path: row.path as string, content: row.content, ...(criterionId ? { criterionId } : {}) });
        break;
      }
      case 'diffScope': {
        if (!Array.isArray(row.allowedPaths) || (row.allowedPaths as unknown[]).some((p) => typeof p !== 'string')) {
          throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].allowedPaths는 문자열 배열이어야 합니다.`);
        }
        for (const p of row.allowedPaths as string[]) {
          if (normalizeWorkspaceRelative(p) === null && p !== '.') {
            throw new QaContractError('INVALID_ARGUMENT', `deterministic[${i}].allowedPaths 항목이 workspace 상대 경로가 아닙니다: ${p}`);
          }
        }
        out.push({ kind: 'diffScope', allowedPaths: [...(row.allowedPaths as string[])], ...(criterionId ? { criterionId } : {}) });
        break;
      }
      case 'command': {
        validateCommandCheck(row, i);
        out.push({
          kind: 'command',
          command: (row.command as string).trim(),
          args: [...(row.args as string[])],
          ...(row.cwd !== undefined ? { cwd: row.cwd as string } : {}),
          ...(typeof row.timeoutMs === 'number' ? { timeoutMs: row.timeoutMs } : {}),
          ...(typeof row.expectExitCode === 'number' ? { expectExitCode: row.expectExitCode } : {}),
          ...(criterionId ? { criterionId } : {}),
        });
        break;
      }
      default:
        throw new QaContractError('INVALID_ARGUMENT', `허용되지 않은 deterministic check kind: ${String(row.kind)}`);
    }
  }
  return out;
}

/**
 * Full §7 validation of the Task-side QA contract. Both-or-neither:
 * acceptanceCriteria and qaContract must be present together or both absent
 * (absent = no QA Gate). Throws QaContractError on any violation.
 *
 * Rules enforced (§7 items 1–5):
 * 1. Every deterministic[].kind is one of the four frozen kinds (plus
 *    per-kind shape: command/args split, bounded timeoutMs, workspace-
 *    relative cwd/paths — never a shell string).
 * 2. (Covered in 1 — command/args separation, timeoutMs ceiling, cwd bound
 *    to the Task workspace.)
 * 3. Every diffScope.allowedPaths entry must already be declared by the
 *    Task's own scope text (substring match on the normalized path; `.`
 *    means the whole workspace and is accepted as an explicit
 *    whole-workspace guard) — QA cannot silently broaden or narrow scope.
 * 4. DETERMINISTIC/BOTH ACs need ≥1 attributed deterministic check;
 *    SEMANTIC/BOTH ACs need qaContract.semantic.qaWorkerId.
 * 5. AC ids unique, non-empty (enforced while validating the list).
 */
export function validateTaskQaContractFields(input: {
  scope: unknown;
  acceptanceCriteria: unknown;
  qaContract: unknown;
}): { acceptanceCriteria: AcceptanceCriterion[]; qaContract: QaContract } | null {
  const { scope, acceptanceCriteria, qaContract } = input;
  if (acceptanceCriteria === undefined && qaContract === undefined) return null;
  if (acceptanceCriteria === undefined || qaContract === undefined) {
    throw new QaContractError(
      'INVALID_ARGUMENT',
      'acceptanceCriteria와 qaContract는 함께 있어야 합니다 (둘 다 있거나 둘 다 없어야 합니다).',
    );
  }
  const criteria = validateAcceptanceCriteriaList(acceptanceCriteria);
  if (!qaContract || typeof qaContract !== 'object') {
    throw new QaContractError('INVALID_ARGUMENT', 'qaContract가 잘못되었습니다.');
  }
  const contract = qaContract as Record<string, unknown>;
  const checks = validateDeterministicChecks(contract.deterministic);

  let semantic: { qaWorkerId: string } | undefined;
  if (contract.semantic !== undefined) {
    const sem = contract.semantic as Record<string, unknown>;
    if (!sem || typeof sem !== 'object' || !isNonEmptyString(sem.qaWorkerId)) {
      throw new QaContractError('INVALID_ARGUMENT', 'qaContract.semantic.qaWorkerId가 필요합니다.');
    }
    semantic = { qaWorkerId: (sem.qaWorkerId as string).trim() };
  }

  let maxQaRemediationAttempts: number | undefined;
  if (contract.maxQaRemediationAttempts !== undefined) {
    const m = contract.maxQaRemediationAttempts;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 0 || m > MAX_QA_REMEDIATION_ATTEMPTS_CEILING) {
      throw new QaContractError(
        'INVALID_ARGUMENT',
        `qaContract.maxQaRemediationAttempts는 0..${MAX_QA_REMEDIATION_ATTEMPTS_CEILING} 정수여야 합니다: ${String(m)}`,
      );
    }
    maxQaRemediationAttempts = m;
  }

  const attributed = new Set<string>();
  for (const c of checks) {
    if (c.criterionId) attributed.add(c.criterionId);
  }
  const scopeText = typeof scope === 'string' ? scope : '';
  for (const ac of criteria) {
    if ((ac.validationMode === 'DETERMINISTIC' || ac.validationMode === 'BOTH') && !attributed.has(ac.id)) {
      throw new QaContractError(
        'INVALID_ARGUMENT',
        `${ac.validationMode} 기준 ${ac.id}에 귀속된 deterministic check(criterionId)가 없습니다.`,
      );
    }
    if ((ac.validationMode === 'SEMANTIC' || ac.validationMode === 'BOTH') && !semantic) {
      throw new QaContractError(
        'INVALID_ARGUMENT',
        `${ac.validationMode} 기준 ${ac.id}가 있지만 qaContract.semantic.qaWorkerId가 없습니다.`,
      );
    }
  }
  // §7 item 3: diffScope guards must stay within the Task's own declared scope.
  for (let i = 0; i < checks.length; i += 1) {
    const c = checks[i];
    if (c.kind !== 'diffScope') continue;
    for (const p of c.allowedPaths) {
      if (p === '.') continue; // explicit whole-workspace guard, still scope-verified at evaluation
      const norm = normalizeWorkspaceRelative(p) ?? p;
      if (!scopeText.includes(norm) && !scopeText.includes(p)) {
        throw new QaContractError(
          'INVALID_ARGUMENT',
          `deterministic[${i}].diffScope.allowedPaths '${p}'가 Task scope에 선언되어 있지 않습니다 (QA는 scope를 넓히거나 좁힐 수 없습니다).`,
        );
      }
    }
  }

  return {
    acceptanceCriteria: criteria,
    qaContract: {
      deterministic: checks,
      ...(semantic ? { semantic } : {}),
      ...(maxQaRemediationAttempts !== undefined ? { maxQaRemediationAttempts } : {}),
    },
  };
}

// ── server-side derivation ───────────────────────────────────────────────────

export interface DerivedQaEvaluationContract {
  /** Slice 2 evaluator defs, derived from the frozen qaContract (Task-side
   * `content` mapped onto the evaluator's `expectedContent`). */
  checks: QaDeterministicCheckDef[];
  /** Slice 1 snapshot for the QaAttemptRecord — derived from the frozen AC
   * list, never caller-supplied. */
  criteriaValidationModes: Record<string, QaCriterionValidationMode>;
  /** Ids whose validationMode is SEMANTIC or BOTH (the semantic set —
   * derived, never re-declared). */
  semanticCriteriaIds: string[];
  /** id → frozen criterion text, for exactly the semantic set. */
  semanticCriteriaText: Record<string, string>;
  /** Configured semantic QA worker, if the contract requires semantic. */
  qaWorkerId?: string;
  /** Effective remediation budget (frozen default 2). */
  maxQaRemediationAttempts: number;
}

/**
 * Derive everything QA evaluation needs from the authoritative Task record.
 * Re-validates defensively (a Task that somehow carries a malformed
 * contract fails closed here too — never evaluated on a guess). The caller
 * (qa-gate.ts) passes the fresh server-side Task; nothing in the returned
 * contract originates from Worker/QA-Agent/caller input.
 */
export function deriveQaEvaluationContract(task: TaskRecord): DerivedQaEvaluationContract {
  if (!TASK_ID_RE.test(task.taskId)) {
    throw new QaContractError('INVALID_STATE', `잘못된 Task ID: ${task.taskId}`);
  }
  const validated = validateTaskQaContractFields({
    scope: task.scope,
    acceptanceCriteria: task.acceptanceCriteria,
    qaContract: task.qaContract,
  });
  if (!validated) {
    throw new QaContractError('INVALID_STATE', `Task ${task.taskId}에는 QA contract가 없습니다.`);
  }
  const checks: QaDeterministicCheckDef[] = validated.qaContract.deterministic.map((c) => {
    switch (c.kind) {
      case 'fileExists':
        return { kind: 'fileExists', path: c.path, ...(c.criterionId ? { criterionId: c.criterionId } : {}) };
      case 'fileExactContent':
        return {
          kind: 'fileExactContent',
          path: c.path,
          expectedContent: c.content,
          ...(c.criterionId ? { criterionId: c.criterionId } : {}),
        };
      case 'diffScope':
        return { kind: 'diffScope', allowedPaths: [...c.allowedPaths], ...(c.criterionId ? { criterionId: c.criterionId } : {}) };
      case 'command':
        return {
          kind: 'command',
          command: c.command,
          args: [...c.args],
          ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
          ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
          ...(c.expectExitCode !== undefined ? { expectExitCode: c.expectExitCode } : {}),
          ...(c.criterionId ? { criterionId: c.criterionId } : {}),
        };
    }
  });
  const criteriaValidationModes: Record<string, QaCriterionValidationMode> = {};
  const semanticCriteriaIds: string[] = [];
  const semanticCriteriaText: Record<string, string> = {};
  for (const ac of validated.acceptanceCriteria) {
    criteriaValidationModes[ac.id] = ac.validationMode;
    if (ac.validationMode === 'SEMANTIC' || ac.validationMode === 'BOTH') {
      semanticCriteriaIds.push(ac.id);
      semanticCriteriaText[ac.id] = ac.description;
    }
  }
  semanticCriteriaIds.sort();
  return {
    checks,
    criteriaValidationModes,
    semanticCriteriaIds,
    semanticCriteriaText,
    ...(validated.qaContract.semantic ? { qaWorkerId: validated.qaContract.semantic.qaWorkerId } : {}),
    maxQaRemediationAttempts:
      validated.qaContract.maxQaRemediationAttempts ?? DEFAULT_MAX_QA_REMEDIATION_ATTEMPTS,
  };
}

/**
 * Canonical QA-contract appendix for the owner-approved scope fingerprint.
 * Key-sorted JSON so the hash is deterministic. Only included in the
 * fingerprint when a contract exists — tasks without one hash exactly as
 * before (backward compatible with every stored V1/V1.5 authorization).
 */
export function canonicalizeQaContractForFingerprint(
  acceptanceCriteria: AcceptanceCriterion[] | undefined,
  qaContract: QaContract | undefined,
): string | null {
  if (acceptanceCriteria === undefined && qaContract === undefined) return null;
  const sortedCriteria = (acceptanceCriteria ?? []).map((c) => ({
    description: c.description,
    id: c.id,
    validationMode: c.validationMode,
  }));
  const det = (qaContract?.deterministic ?? []).map((c) => {
    const keys = Object.keys(c).sort();
    const row: Record<string, unknown> = {};
    for (const k of keys) row[k] = (c as unknown as Record<string, unknown>)[k];
    return row;
  });
  return JSON.stringify([
    sortedCriteria,
    {
      deterministic: det,
      ...(qaContract?.semantic ? { semantic: { qaWorkerId: qaContract.semantic.qaWorkerId } } : {}),
      ...(qaContract?.maxQaRemediationAttempts !== undefined
        ? { maxQaRemediationAttempts: qaContract.maxQaRemediationAttempts }
        : {}),
    },
  ]);
}
