import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTask, createTask, listTasks } from '../backend/goal-task.js';
import { transitionTaskExecution } from '../backend/goal-task-runtime.js';
import { listPendingPmDeliveries, getPmDelivery, listPmDeliveries, ensurePmDeliveryForFailedRun } from '../backend/pm-delivery.js';
import { submitPmJudgment, listPmJudgments, JUDGMENT_REASON_MAX_CHARS, JUDGMENT_RETRY_INSTRUCTION_MAX_CHARS, type PmJudgmentEvidenceGate } from '../backend/pm-judgment.js';
import { listEvidenceForRun } from '../backend/evidence.js';
import { prepareRetryForJudgment } from '../backend/retry-preparation.js';
import { reconcileReadyRetryDispatches } from '../backend/retry-dispatch.js';
import { reconcileQaGate, type QaRemediationDispatchHook } from '../backend/qa-gate.js';
import { listQaRemediationPreparations } from '../backend/qa-remediation-preparation.js';
import { ensureV1ContainerGoal } from '../backend/v1-intake.js';
import { buildTaskContract } from '../backend/task-contract.js';
import { readRuntimeBinding } from '../backend/actl-bridge.js';
import { listEvents } from '../backend/event.js';
import type { RoleConfig, RoleAssignment } from '../roles/role-config.js';
import type { RoleRuntimeAdapter, InputEnvelope } from '../integrations/core/role-runtime.js';
import { readRoleSession, roleSessionPath, writeRoleSession } from '../integrations/core/role-runtime.js';
import {
  EVIDENCE_TRUST_LEVELS,
  EVIDENCE_TYPES,
  type EvidenceRecord,
  type EvidenceTrustLevel,
  type EvidenceType,
  type TaskRecord,
} from '../shared/types.js';
import { buildPmBootstrapPacket, buildPmFinalGatePacket, listClosedTerminalTasks, type PmFinalGatePacket } from './pm-packets.js';
import { parsePmTaskDecision, parsePmJudgment, type PmTaskDecision, type PmJudgment } from './pm-schemas.js';

export type DispatchHook = (dataRoot: string, project: string, task: TaskRecord) => Promise<{ runId: string } | void>;
export type CollectHook = (dataRoot: string, project: string, runId: string) => Promise<{ collectStatus: string; runId: string }>;

export interface RoleLoopConfig {
  dataRoot: string;
  project: string;
  roleConfig: RoleConfig;
  pmAdapter: RoleRuntimeAdapter;
  dispatchHook: DispatchHook;
  /** Resume-only final collect for asynchronously dispatched Runs. */
  collectHook?: CollectHook;
  auditDir: string;
  stateFile: string;
  /** Default 120_000ms per the WBS-5/8 redirect's binding condition (d). */
  pmSendTimeoutMs?: number;
  /** Resolves a fallbackChain adapter id to a registered RoleRuntimeAdapter, or null if unregistered. */
  resolveAdapter?: (adapterId: string) => RoleRuntimeAdapter | null;
  /** Maximum re-asks for contract/QA validation failures; schema errors remain single-reask. */
  maxValidationReasks?: number;
  /** Optional operator-supplied PM role-instructions file. */
  pmInstructionsPath?: string;
  /** Orchestrator-owned, permit-checked QA remediation dispatch seam. */
  qaRemediationDispatchHook?: QaRemediationDispatchHook;
}

export class BillingGuardError extends Error {
  readonly code = 'BLOCKED_BILLING' as const;
}
export class PmOwnerRequiredError extends Error {
  readonly code = 'OWNER_REQUIRED' as const;
}
export class PmTimeoutError extends Error {
  readonly code = 'BLOCKED_RUNTIME' as const;
}

function isTerminalFailedRun(dataRoot: string, project: string, link: TaskRecord['linkedRuns'][number]): boolean {
  try {
    const binding = readRuntimeBinding(link.folder);
    if (binding && binding.collectStatus && binding.collectStatus !== 'FINAL_BOUND' && binding.closeoutStatus !== 'RELEASED') return false;
  } catch {
    return false;
  }
  const failedEvent = listEvents(dataRoot, project, { runId: link.runId }).events.some((event) => event.type === 'RUN_FAILED' || event.type === 'RUNTIME_ERROR');
  return failedEvent;
}
class PmContractValidationError extends Error {}

function parseFinalGateJudgment(packet: PmFinalGatePacket, text: string): PmJudgment {
  const judgment = parsePmJudgment(text);
  if ((judgment.decision === 'ACCEPT' || judgment.decision === 'ACCEPT_AND_NEXT')
    && packet.context.qa !== undefined && packet.context.qa.status !== 'PASS') {
    throw new Error(`ACCEPT requires QA PASS; latest QA status is ${packet.context.qa.status}${packet.context.qa.reason ? `: ${packet.context.qa.reason}` : ''}`);
  }
  return judgment;
}

// ── evidence gate for ACCEPT (round 38b / 38c) ────────────────────────────────
//
// LIVE P0 (JuControler-Private-planning TASK-0002, DEC-2026-149): the automatic
// PM judged the SAME evidence class CHANGES, CHANGES, then ACCEPT, because
// ACCEPT-without-machine-verification was reachable by retry pressure alone — its
// accepting reason claimed the cited record held raw self-test output, while the
// record (ADAPTER_OBSERVATION, trust OBSERVED, status INFO) only said
// "Adapter RESPONSE_COMPLETE observed for Task … Run …". Before an ACCEPT /
// ACCEPT_AND_NEXT decision is applied, the gate now mechanically checks the
// frozen contract's `required_evidence` (task-contract.v1, string[]) against the
// Evidence records actually bound to the accepted run.
//
// LIVE TASK-0003 (audit line 04:16:36Z): real task-contract.v1 `required_evidence`
// entries are PROSE written by the planning PM — e.g. "node
// scripts/founder-brief.mjs --self-test 실행 결과(PASS 마커, exit 0)". The pure-token
// rule below refused EVERY such task forever, i.e. the same class of release
// blocker as accepting-without-verification, only mirrored. Round 38c therefore
// applies ONE of TWO rules per requirement:
//   - `token`: the requirement names a machine-checkable `<TYPE>/<TRUSTLEVEL>`
//     token (a type from EVIDENCE_TYPES and a level from EVIDENCE_TRUST_LEVELS,
//     case-insensitive, e.g. "TEST/VERIFIED") — round 38b behaviour unchanged:
//     at least one non-FAIL record bound to the run must match the exact TYPE
//     and at least that trust level.
//   - `floor`: the requirement names no such token (the normal prose case) —
//     default floor: at least one record bound to the run has trustLevel
//     VERIFIED (or higher, ACCEPTED) and status is not FAIL. The QA-minted
//     VERIFIED record (src/backend/qa-evidence.ts) satisfies an ordinary prose
//     requirement, yet an ADAPTER_OBSERVATION/OBSERVED-only run never can.
// The gate can only REFUSE, never upgrade: nothing here promotes VERIFIED (or
// anything else) to ACCEPTED automatically. The applied judgment (and the audit
// line on refusal) records which rule matched per requirement (`token`/`floor`).

const EVIDENCE_TRUST_RANK: Record<string, number> = { CLAIMED: 0, OBSERVED: 1, VERIFIED: 2, ACCEPTED: 3 };

/** Round 38c default floor for prose requirements: VERIFIED, or higher (ACCEPTED). */
const DEFAULT_EVIDENCE_FLOOR_TRUST: EvidenceTrustLevel = 'VERIFIED';

type EvidenceGateRuleKind = 'token' | 'floor';

interface RequiredEvidenceSpec {
  /** 0-based index into contract.required_evidence (audit id = REQ-<index+1>). */
  requirementIndex: number;
  requirement: string;
  type: EvidenceType;
  trustLevel: EvidenceTrustLevel;
}

interface EvidenceGateRequirement {
  requirementIndex: number;
  requirement: string;
  /** Which rule matched this requirement: explicit TYPE/TRUST token, or the VERIFIED floor. */
  rule: EvidenceGateRuleKind;
}

interface EvidenceGateUnmet {
  requirementIndex: number;
  requirement: string;
  parsed?: RequiredEvidenceSpec;
}

interface EvidenceGateCheck {
  satisfied: boolean;
  /** Every contract requirement + the rule that matched it (satisfied or not). */
  known: EvidenceGateRequirement[];
  unmet: EvidenceGateUnmet[];
  present: EvidenceRecord[];
}

/** Read the minimum acceptable `<TYPE>/<TRUSTLEVEL>` the requirement text names. */
function parseRequiredEvidenceSpec(requirement: string, index: number): RequiredEvidenceSpec | null {
  const tokenRe = /([A-Za-z][A-Za-z0-9_]*)\s*\/\s*([A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(requirement)) !== null) {
    const type = (m[1] ?? '').toUpperCase();
    const trust = (m[2] ?? '').toUpperCase();
    if ((EVIDENCE_TYPES as readonly string[]).includes(type) && (EVIDENCE_TRUST_LEVELS as readonly string[]).includes(trust)) {
      return { requirementIndex: index, requirement, type: type as EvidenceType, trustLevel: trust as EvidenceTrustLevel };
    }
  }
  return null;
}

function trustLevelAtLeast(actual: EvidenceTrustLevel, required: EvidenceTrustLevel): boolean {
  const a = EVIDENCE_TRUST_RANK[actual];
  const r = EVIDENCE_TRUST_RANK[required];
  return a !== undefined && r !== undefined && a >= r;
}

function evidenceSatisfiesRequired(record: EvidenceRecord, spec: RequiredEvidenceSpec): boolean {
  return record.type === spec.type
    && trustLevelAtLeast(record.trustLevel, spec.trustLevel)
    && record.status !== 'FAIL';
}

/** Round 38c default floor for a prose (no-token) requirement: any non-FAIL
 * record at VERIFIED trust or higher (ACCEPTED). Never satisfied by OBSERVED. */
function evidenceSatisfiesDefaultFloor(record: EvidenceRecord): boolean {
  return record.status !== 'FAIL' && trustLevelAtLeast(record.trustLevel, DEFAULT_EVIDENCE_FLOOR_TRUST);
}

/**
 * Round 38b: every token-named requirement needs a non-FAIL record bound to the
 * run matching its type + trust level. Round 38c: a requirement naming NO
 * machine-checkable `<TYPE>/<TRUSTLEVEL>` token (the normal prose case) falls
 * back to the default floor — any non-FAIL VERIFIED-or-higher record bound to
 * the run satisfies it. Empty/absent `required_evidence` → behaviour unchanged.
 */
function checkRequiredEvidence(
  contract: TaskRecord['contract'] | undefined,
  runEvidence: EvidenceRecord[],
): EvidenceGateCheck {
  const required = contract?.required_evidence;
  if (!Array.isArray(required) || required.length === 0) {
    return { satisfied: true, known: [], unmet: [], present: runEvidence };
  }
  const unmet: EvidenceGateUnmet[] = [];
  const known: EvidenceGateRequirement[] = [];
  required.forEach((requirement, index) => {
    const spec = parseRequiredEvidenceSpec(requirement, index);
    if (spec) {
      // Requirement names a machine-checkable TYPE/TRUSTLEVEL token — round 38b
      // behaviour unchanged (type + trust level must both match).
      known.push({ requirementIndex: index, requirement, rule: 'token' });
      if (!runEvidence.some((e) => evidenceSatisfiesRequired(e, spec))) {
        unmet.push({ requirementIndex: index, requirement, parsed: spec });
      }
      return;
    }
    // Prose requirement (the normal task-contract.v1 case): apply the default
    // floor instead of refusing forever. Still fails on an
    // ADAPTER_OBSERVATION/OBSERVED-only run and on a FAIL-status record.
    known.push({ requirementIndex: index, requirement, rule: 'floor' });
    if (!runEvidence.some((e) => evidenceSatisfiesDefaultFloor(e))) {
      unmet.push({ requirementIndex: index, requirement });
    }
  });
  return { satisfied: unmet.length === 0, known, unmet, present: runEvidence };
}

function describeUnmetRequirement(u: EvidenceGateUnmet): string {
  const id = `REQ-${u.requirementIndex + 1}`;
  return u.parsed
    ? `${id} "${u.requirement}" (requires ${u.parsed.type}/${u.parsed.trustLevel})`
    : `${id} "${u.requirement}" (floor: VERIFIED evidence absent)`;
}

/** RequirementId + rule rows persisted on the APPLIED judgment (and audit line)
 * so a reviewer can see which rule matched per requirement. */
function evidenceGateJudgmentRows(check: EvidenceGateCheck): PmJudgmentEvidenceGate[] {
  return check.known.map((k) => ({
    requirementId: `REQ-${k.requirementIndex + 1}`,
    requirement: k.requirement,
    rule: k.rule,
  }));
}

/**
 * Apply the refusal: the PM's ACCEPT is NOT applied; the outcome is rewritten
 * to a CHANGES judgment whose reason is machine-generated and names exactly the
 * unmet requirements and the records actually present (id/type/trustLevel/
 * status). The PM's own prose reason is preserved verbatim at the end so
 * nothing is hidden. The retry lifecycle then proceeds exactly like a CHANGES
 * verdict (prepare + reconcile), so the loop re-runs the Task until machine
 * Evidence exists — but the gate never upgrades any record toward ACCEPTED.
 */
async function refuseAcceptForMissingEvidence(
  cfg: RoleLoopConfig,
  deliveryId: string,
  packet: PmFinalGatePacket,
  judgment: PmJudgment,
  check: EvidenceGateCheck,
): Promise<Record<string, unknown>> {
  const runId = packet.context.attempt.runId;
  const unmetIds = check.unmet.map((u) => `REQ-${u.requirementIndex + 1}`);
  const unmetText = check.unmet.map(describeUnmetRequirement);
  const presentText = check.present.length === 0
    ? '(none)'
    : check.present.map((e) => `${e.evidenceId} ${e.type}/${e.trustLevel}/${e.status}`).join('; ');

  const machinePrefix = `ACCEPT_REFUSED_EVIDENCE: contract required_evidence unmet (${unmetText.join('; ')}) — records bound to run ${runId}: ${presentText}. ACCEPT refused and rewritten to CHANGES.`;
  const pmReason = judgment.reason ?? '';
  const marker = '--- PM reason (verbatim):';
  let verbatimSuffix = `${marker} ${pmReason}`;
  // Keep at least a readable machine prefix; when a pathological max-length PM
  // prose cannot share the reason cap, the PM prose is the priority and the
  // full text is audited below (`pmReason`).
  const minMachine = 30;
  const maxSuffix = JUDGMENT_REASON_MAX_CHARS - minMachine;
  let pmReasonTruncated = false;
  if (verbatimSuffix.length > maxSuffix) {
    verbatimSuffix = `${marker} ${pmReason.slice(0, Math.max(1, maxSuffix - marker.length - 1))}…`;
    pmReasonTruncated = true;
  }
  const budgetForMachine = JUDGMENT_REASON_MAX_CHARS - verbatimSuffix.length;
  const machine = machinePrefix.length <= budgetForMachine
    ? machinePrefix
    : `${machinePrefix.slice(0, Math.max(1, budgetForMachine - 1))}…`;
  const reason = `${machine} ${verbatimSuffix}`.trim();

  const retryInstruction = [
    `Evidence gate refused ACCEPT: required_evidence unmet (${unmetText.join('; ')}).`,
    `Re-run the same Task so a QA/Builder attempt mints non-FAIL VERIFIED (or higher) Evidence bound to the run (matching the named TYPE/TRUSTLEVEL token when the requirement names one); prose claims and adapter observations alone cannot satisfy the frozen contract.`,
  ].join(' ').slice(0, JUDGMENT_RETRY_INSTRUCTION_MAX_CHARS);

  const judgmentRows = check.known.length > 0 ? evidenceGateJudgmentRows(check) : undefined;
  await submitPmJudgment(cfg.dataRoot, cfg.project, {
    deliveryId, decision: 'CHANGES', reason, retryInstruction,
    ...(judgmentRows ? { evidenceGate: judgmentRows } : {}),
  });
  await prepareRetryForJudgment(cfg.dataRoot, cfg.project, deliveryId);
  await reconcileReadyRetryDispatches(cfg.dataRoot, cfg.project);
  audit(cfg.auditDir, {
    step: 'final-gate',
    deliveryId,
    outcome: 'ACCEPT_REFUSED_EVIDENCE',
    decision: judgment.decision,
    runId,
    unmet: unmetIds,
    requirements: unmetText,
    rules: check.known.map((k) => `REQ-${k.requirementIndex + 1}:${k.rule}`),
    present: check.present.map((e) => `${e.evidenceId}:${e.type}/${e.trustLevel}/${e.status}`),
    pmReason,
    ...(pmReasonTruncated ? { pmReasonTruncatedInJudgment: true } : {}),
  });
  return { outcome: 'ACCEPT_REFUSED_EVIDENCE', decision: 'CHANGES', pmDecision: judgment.decision };
}

// ── (a) runtime billing guard ────────────────────────────────────────────────

function isFreeTierModel(model: string | undefined): boolean {
  // ponytail: this is a deliberately small model-ref allowlist; provider policy
  // remains outside the orchestrator until the runtime registry exposes it.
  if (!model) return false;
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return /-free$/.test(bare) || bare === 'big-pickle';
}

/**
 * Free-tier-or-explicit-opt-out model guard, asserted before every PM send.
 * Takes a structurally-widened shape (zeroExtraBilling: boolean, not the
 * config type's literal `true`) because `RoleAssignment.zeroExtraBilling` is
 * typed `true` only (role-config.ts enforces it at validateRoleConfig time);
 * this guard must still runtime-check a hand-constructed object that carries
 * `false` (a validated role-config can never have one today, but this guard
 * is defense in depth, not a re-statement of that validation).
 */
export function assertBillingAllowed(assignment: { roleId: string; model?: string; zeroExtraBilling: boolean }): void {
  if (assignment.zeroExtraBilling !== true) {
    throw new PmOwnerRequiredError(`OWNER_REQUIRED: role "${assignment.roleId}" must set zeroExtraBilling=true`);
  }
  if (!isFreeTierModel(assignment.model)) {
    throw new BillingGuardError(
      `BLOCKED_BILLING: model "${assignment.model ?? '(none)'}" for role "${assignment.roleId}" is not a recognized free-tier model (opencode/*-free or opencode/big-pickle) and zeroExtraBilling is not explicitly false`,
    );
  }
}

// ── (b) fallbackChain walker ─────────────────────────────────────────────────

/**
 * Resolve the adapter to use for this PM turn: the primary if it passes the
 * billing guard, else the first fallbackChain entry that is BOTH registered
 * AND passes the same guard (adapter-level `capabilities().freeTier` stands
 * in for "this concrete adapter is free-tier" — a fallback chain entry is
 * just an adapter id, it carries no separate model of its own). A paid or
 * unregistered entry is skipped, never silently used; an exhausted chain is
 * OWNER_REQUIRED.
 */
export function resolvePmAdapterForTurn(cfg: RoleLoopConfig, assignment: RoleAssignment): RoleRuntimeAdapter {
  const primary = cfg.resolveAdapter ? cfg.resolveAdapter(assignment.runtimeAdapterId) : (cfg.pmAdapter.id === assignment.runtimeAdapterId ? cfg.pmAdapter : null);
  if (!primary) throw new PmOwnerRequiredError(`OWNER_REQUIRED: PM adapter "${assignment.runtimeAdapterId}" is not registered`);
  try {
    assertBillingAllowed(assignment);
    return primary;
  } catch (primaryErr) {
    if (assignment.zeroExtraBilling !== true) throw primaryErr;
    if (!assignment.fallbackChain || assignment.fallbackChain.length === 0) {
      // No fallback configured at all: a plain billing block, not an
      // exhausted chain — surface the guard's own error/outcome directly.
      throw primaryErr;
    }
    for (const adapterId of assignment.fallbackChain ?? []) {
      const adapter = cfg.resolveAdapter?.(adapterId) ?? null;
      if (!adapter) continue;
      // The adapter id itself is model-qualified for OpenCode fallback entries
      // (e.g. "opencode/big-pickle") — check the SAME free-tier rule against
      // it. A generic adapter's capabilities().freeTier flag is model-agnostic
      // and cannot by itself distinguish a paid model, so a paid/unknown
      // entry (id doesn't match the free-tier pattern) is skipped, never
      // silently used.
      const zeroExtraBilling = assignment.zeroExtraBilling as unknown as boolean;
      if (zeroExtraBilling !== false && !isFreeTierModel(adapterId)) continue;
      return adapter;
    }
    throw new PmOwnerRequiredError(
      `OWNER_REQUIRED: PM adapter "${assignment.runtimeAdapterId}" failed the billing guard (${(primaryErr as Error).message}) and no compliant, registered fallback in [${(assignment.fallbackChain ?? []).join(', ') || '(empty)'}] was found`,
    );
  }
}

// ── (d) PM send timeout: bounded, collect-only recovery ─────────────────────

async function collectWithTimeout(adapter: RoleRuntimeAdapter, sessionId: string, requestId: string, timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PmTimeoutError(`BLOCKED_RUNTIME: PM adapter did not respond within ${timeoutMs}ms`)), timeoutMs); });
  try { return await Promise.race([adapter.collect(sessionId, requestId, { timeoutMs }), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function sendAndCollect(adapter: RoleRuntimeAdapter, sessionId: string, envelope: InputEnvelope, timeoutMs: number) {
  const { requestId } = await adapter.send(sessionId, envelope);
  try {
    return await collectWithTimeout(adapter, sessionId, requestId, timeoutMs);
  } catch (err) {
    if (!(err instanceof PmTimeoutError)) throw err;
    try {
      await adapter.interrupt(sessionId);
    } catch {
      /* best-effort */
    }
    try {
      // The first send may have been accepted even though collection timed out.
      // Collect once more, but never resend the same envelope in this cycle.
      return await collectWithTimeout(adapter, sessionId, requestId, Math.min(timeoutMs, 15_000));
    } catch (err2) {
      if (err2 instanceof PmTimeoutError) {
        throw new PmTimeoutError(`BLOCKED_RUNTIME: PM adapter timed out twice (initial + one retry) at ${timeoutMs}ms each`);
      }
      throw err2;
    }
  }
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

async function sendAndParseWithReask<T>(
  adapter: RoleRuntimeAdapter,
  sessionId: string,
  envelope: InputEnvelope,
  parseFn: (text: string) => T,
  buildReaskEnvelope: (err: string, pmReply: string, validation: boolean) => InputEnvelope,
  timeoutMs: number,
  options: { maxValidationReasks?: number; onValidationReask?: (round: number, error: string) => void } = {},
): Promise<ParseOutcome<T>> {
  const first = await sendAndCollect(adapter, sessionId, envelope, timeoutMs);
  let reply = first.text;
  let lastError = '';
  let schemaReasked = false;
  let validationReasks = 0;
  while (true) {
    try {
      return { ok: true, value: parseFn(reply) };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const validation = err instanceof PmContractValidationError;
      const maxValidationReasks = options.maxValidationReasks ?? 3;
      if (validation && !schemaReasked && validationReasks < maxValidationReasks) {
        validationReasks += 1;
        options.onValidationReask?.(validationReasks, lastError);
        const next = await sendAndCollect(adapter, sessionId, buildReaskEnvelope(lastError, reply, true), timeoutMs);
        reply = next.text;
        continue;
      }
      if (!validation && !schemaReasked) {
        schemaReasked = true;
        const next = await sendAndCollect(adapter, sessionId, buildReaskEnvelope(lastError, reply, false), timeoutMs);
        reply = next.text;
        continue;
      }
      return { ok: false, error: lastError };
    }
  }
}

async function sendAndParseOnce<T>(adapter: RoleRuntimeAdapter, sessionId: string, envelope: InputEnvelope, parseFn: (text: string) => T, timeoutMs: number): Promise<ParseOutcome<T>> {
  const reply = await sendAndCollect(adapter, sessionId, envelope, timeoutMs);
  try { return { ok: true, value: parseFn(reply.text) }; }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
}

// ── durable per-cycle "blocked, don't re-ask every poll" state + audit ──────

interface OrchestratorStateFile {
  schemaVersion: 1;
  blocked: Record<string, { contextHash: string; reason: string; updatedAt: string }>;
  finalGateDecisions?: Record<string, { contextHash: string; outcome: string; reason?: string; updatedAt: string }>;
  pendingReask?: Record<string, { contextHash: string; reason: string; retryAfter?: number; updatedAt: string }>;
  exhausted?: Record<string, { taskId: string; updatedAt: string }>;
  projectComplete?: { contextHash: string; reason: string; updatedAt: string };
}

function readState(stateFile: string): OrchestratorStateFile {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as OrchestratorStateFile;
  } catch {
    return { schemaVersion: 1, blocked: {}, finalGateDecisions: {}, pendingReask: {}, exhausted: {} };
  }
}

function writeState(stateFile: string, state: OrchestratorStateFile): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}

export function clearBlockedState(stateFile: string): void {
  const state = readState(stateFile);
  state.blocked = {};
  state.finalGateDecisions = {};
  writeState(stateFile, state);
}

function audit(auditDir: string, item: Record<string, unknown>): void {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, 'role-loop.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...item }) + '\n');
}

function cacheFinalGateDecision(state: OrchestratorStateFile, stateFile: string, deliveryId: string, contextHash: string, result: Record<string, unknown>): void {
  if (result.outcome !== 'OWNER_REQUIRED') return;
  state.finalGateDecisions ??= {};
  state.finalGateDecisions[deliveryId] = {
    contextHash,
    outcome: String(result.outcome),
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeState(stateFile, state);
}

function resolvePmInstructionsPath(override?: string): string {
  if (override) return path.resolve(override);
  // The server build is CommonJS, so __dirname is the compiled-module
  // equivalent of fileURLToPath(import.meta.url).
  const moduleDir = __dirname;
  const compiledPath = path.resolve(moduleDir, '../../../docs/PM_ROLE_INSTRUCTIONS.md');
  if (fs.existsSync(compiledPath)) return compiledPath;
  return path.resolve(moduleDir, '../../docs/PM_ROLE_INSTRUCTIONS.md');
}

function runtimeFailure(err: unknown): { reason: string; retryAfter?: number } {
  const e = err as { message?: string; retryAfter?: number; status?: number; code?: string };
  return { reason: e?.message ?? String(err), ...(typeof e?.retryAfter === 'number' ? { retryAfter: e.retryAfter } : {}) };
}

function recordRuntimeBlock(cfg: RoleLoopConfig, state: OrchestratorStateFile, key: string, contextHash: string, err: unknown): Record<string, unknown> {
  const failure = runtimeFailure(err);
  state.pendingReask ??= {};
  state.pendingReask[key] = { contextHash, reason: failure.reason, ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }), updatedAt: new Date().toISOString() };
  writeState(cfg.stateFile, state);
  audit(cfg.auditDir, { step: key.startsWith('final-gate:') ? 'final-gate' : 'bootstrap', ...(key.startsWith('final-gate:') ? { deliveryId: key.slice('final-gate:'.length) } : {}), outcome: 'BLOCKED_RUNTIME', reason: failure.reason, ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }) });
  return { outcome: 'BLOCKED_RUNTIME', reason: failure.reason, ...(failure.retryAfter === undefined ? {} : { retryAfter: failure.retryAfter }) };
}

async function rotateTimedOutPmSession(cfg: RoleLoopConfig, adapter: RoleRuntimeAdapter, sessionId: string): Promise<void> {
  try {
    if (adapter.abortSession) await adapter.abortSession(sessionId);
    else await adapter.interrupt(sessionId);
  } catch {
    // Best effort: the durable record must still be rotated.
  }
  fs.rmSync(roleSessionPath(cfg.dataRoot, cfg.project, 'pm'), { force: true });
}

function hasOpenTask(dataRoot: string, project: string): boolean {
  return listTasks(dataRoot, project).some((t) => t.pmState !== 'ACCEPTED' && t.executionState !== 'FAILED' && t.executionState !== 'CANCELLED');
}

function hasInFlightTerminalRun(dataRoot: string, project: string): boolean {
  return listTasks(dataRoot, project).some((task) => {
    if (task.executionState !== 'FAILED' && task.executionState !== 'CANCELLED') return false;
    const latest = [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
    if (!latest) return false;
    const binding = readRuntimeBinding(latest.folder);
    return !!binding && binding.closeoutStatus !== 'RELEASED' && binding.collectStatus !== 'FINAL_BOUND';
  });
}

function deriveTitle(rawContract: Record<string, unknown>): string {
  const goal = typeof rawContract.goal === 'string' ? rawContract.goal : 'next task';
  return goal.length > 80 ? goal.slice(0, 80) + '…' : goal;
}

function reaskEnvelope(kind: InputEnvelope['kind'], schemaVersion: string, contextHash: string, originalBody: string, error: string, pmReply = '', validation = false): InputEnvelope {
  const noTools = /<tool_call\b|<function\s*=/.test(pmReply) && !/```[a-zA-Z]*\r?\n/.test(pmReply);
  const instruction = validation
    ? `${error}\nReturn the COMPLETE corrected PM_TASK_DECISION v1 block; keep everything else unchanged.`
    : noTools
    ? 'you have no tools; answer with the JSON block only'
    : `Your previous reply did not match the required schema: ${error}`;
  return {
    kind,
    schemaVersion,
    contextHash,
    body: `${originalBody}\n\n---\n${instruction}\nReply again with exactly one fenced block as instructed, JSON only.`,
  };
}

async function ensurePmAdapterAndSession(
  cfg: RoleLoopConfig,
  assignment: RoleAssignment,
  contextHash: string,
): Promise<{ adapter: RoleRuntimeAdapter; sessionId: string }> {
  let preamble: string;
  try {
    preamble = fs.readFileSync(resolvePmInstructionsPath(cfg.pmInstructionsPath), 'utf8');
  } catch (err) {
    throw new Error(`BLOCKED_RUNTIME: pm instructions missing: ${err instanceof Error ? err.message : String(err)}`);
  }
  const adapter = resolvePmAdapterForTurn(cfg, assignment);
  const ensured = await adapter.ensureSession({
    roleId: 'pm',
    project: cfg.project,
    sessionPolicy: assignment.sessionPolicy,
    sessionKey: `${cfg.project}:pm`,
  });
  const sessionId = ensured.sessionId;
  const existing = readRoleSession(cfg.dataRoot, cfg.project, 'pm');
  const newSession = ensured.created && (!existing || existing.sessionId !== sessionId);
  if (newSession || !existing || existing.sessionId !== sessionId || existing.preambleSent !== true) {
    const request = await adapter.send(sessionId, { kind: 'PM_PREAMBLE', schemaVersion: 'pm-role-instructions.v1', contextHash, body: preamble });
    await adapter.collect(sessionId, request.requestId, { timeoutMs: cfg.pmSendTimeoutMs ?? 120_000 });
    writeRoleSession(cfg.dataRoot, cfg.project, 'pm', {
      adapterId: adapter.id,
      sessionId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      preambleSent: true,
    });
  }
  return { adapter, sessionId };
}

function dryRunValidateContract(project: string, raw: Record<string, unknown>): void {
  buildTaskContract({
    project,
    task_id: 'TASK-0', // placeholder; createTask always server-assigns the real task_id
    goal: String(raw.goal ?? ''),
    bounded_scope: String(raw.bounded_scope ?? ''),
    acceptance_criteria: raw.acceptance_criteria,
    required_evidence: raw.required_evidence as string[] | undefined,
    qa_route: raw.qa_route,
    retry_policy: raw.retry_policy as any,
    owner_gate_conditions: raw.owner_gate_conditions as string[] | undefined,
    contract_revision: raw.contract_revision as number | undefined,
  });
}

function normalizePmTaskContract(roleConfig: RoleConfig, raw: Record<string, unknown>): { contract: Record<string, unknown>; overridden: boolean } {
  const qa = roleConfig.assignments.find((assignment) => assignment.roleId === 'qa');
  const configuredWorkerId = qa?.runtimeAdapterId.startsWith('qa-worker:') ? qa.runtimeAdapterId.slice('qa-worker:'.length) : qa?.runtimeAdapterId;
  const route = raw.qa_route && typeof raw.qa_route === 'object' && !Array.isArray(raw.qa_route) ? { ...(raw.qa_route as Record<string, unknown>) } : raw.qa_route;
  if (!route || typeof route !== 'object' || !configuredWorkerId) return { contract: raw, overridden: false };
  const semantic = (route as Record<string, unknown>).semantic;
  let overridden = false;
  if (semantic === true) {
    (route as Record<string, unknown>).semantic = { qaWorkerId: configuredWorkerId };
  } else if (semantic === false) {
    delete (route as Record<string, unknown>).semantic;
  } else if (semantic && typeof semantic === 'object' && !Array.isArray(semantic)) {
    if (typeof (semantic as Record<string, unknown>).qaWorkerId === 'string' && (semantic as Record<string, unknown>).qaWorkerId !== configuredWorkerId) overridden = true;
    (route as Record<string, unknown>).semantic = { ...(semantic as Record<string, unknown>), qaWorkerId: configuredWorkerId };
  }
  return { contract: { ...raw, qa_route: route }, overridden };
}

// ── WBS-5: PM bootstrap / planning loop ──────────────────────────────────────

export async function processBootstrap(cfg: RoleLoopConfig): Promise<Record<string, unknown>> {
  const timeoutMs = cfg.pmSendTimeoutMs ?? 120_000;
  const packet = buildPmBootstrapPacket(cfg.dataRoot, cfg.project, cfg.roleConfig);
  const state = readState(cfg.stateFile);
  const blockKey = 'bootstrap';
  if (state.projectComplete?.contextHash === packet.contextHash) {
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'PROJECT_COMPLETE_CACHED', contextHash: packet.contextHash });
    return { outcome: 'PROJECT_COMPLETE_CACHED' };
  }
  if (state.projectComplete) {
    delete state.projectComplete;
    writeState(cfg.stateFile, state);
  }
  const prevBlock = state.blocked[blockKey];
  if (prevBlock && prevBlock.contextHash === packet.contextHash) {
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'BLOCKED', reason: prevBlock.reason });
    return { outcome: 'BLOCKED', reason: prevBlock.reason };
  }

  const assignment = cfg.roleConfig.assignments.find((a) => a.roleId === 'pm');
  if (!assignment) {
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' });
    return { outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' };
  }

  let adapter: RoleRuntimeAdapter;
  let sessionId: string;
  try {
    ({ adapter, sessionId } = await ensurePmAdapterAndSession(cfg, assignment, packet.contextHash));
  } catch (err) {
    if (err instanceof BillingGuardError || err instanceof PmOwnerRequiredError) {
      const outcome = err instanceof BillingGuardError ? 'BLOCKED_BILLING' : 'OWNER_REQUIRED';
      audit(cfg.auditDir, { step: 'bootstrap', outcome, reason: err.message });
      return { outcome, reason: err.message };
    }
    return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
  }

  const envelope: InputEnvelope = { kind: 'PM_BOOTSTRAP', schemaVersion: 'pm-bootstrap-packet.v1', contextHash: packet.contextHash, body: packet.text };
  let parsed: ParseOutcome<PmTaskDecision>;
  let qaWorkerOverridden = false;
  try {
    parsed = await sendAndParseWithReask(
      adapter,
      sessionId,
      envelope,
      (text) => {
        const decision = parsePmTaskDecision(text);
        if (decision.decision !== 'CREATE_TASK') return decision;
        const normalized = normalizePmTaskContract(cfg.roleConfig, decision.task_contract!);
        qaWorkerOverridden ||= normalized.overridden;
        try {
          dryRunValidateContract(cfg.project, normalized.contract);
        } catch (error) {
          throw new PmContractValidationError(error instanceof Error ? error.message : String(error));
        }
        return { ...decision, task_contract: normalized.contract };
      },
      (err, pmReply, validation) => reaskEnvelope('PM_BOOTSTRAP', 'pm-bootstrap-packet.v1', packet.contextHash, packet.text, err, pmReply, validation),
      timeoutMs,
      {
        maxValidationReasks: cfg.maxValidationReasks ?? 3,
        onValidationReask: (round, error) => audit(cfg.auditDir, { step: 'bootstrap', outcome: `VALIDATION_REASK ${round}/${cfg.maxValidationReasks ?? 3}`, reason: error }),
      },
    );
  } catch (err) {
    if (err instanceof PmTimeoutError) {
      await rotateTimedOutPmSession(cfg, adapter, sessionId);
      return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
    }
    return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
  }

  if (!parsed.ok) {
    state.blocked[blockKey] = { contextHash: packet.contextHash, reason: parsed.error, updatedAt: new Date().toISOString() };
    writeState(cfg.stateFile, state);
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'BLOCKED', reason: parsed.error });
    return { outcome: 'BLOCKED', reason: parsed.error };
  }
  delete state.blocked[blockKey];
  writeState(cfg.stateFile, state);

  const decision = parsed.value;
  if (decision.decision === 'PROJECT_COMPLETE') {
    state.projectComplete = { contextHash: packet.contextHash, reason: decision.reason, updatedAt: new Date().toISOString() };
    writeState(cfg.stateFile, state);
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'PROJECT_COMPLETE', reason: decision.reason });
    return { outcome: 'PROJECT_COMPLETE' };
  }
  if (decision.decision === 'OWNER_REQUIRED') {
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'OWNER_REQUIRED', reason: decision.reason });
    return { outcome: 'OWNER_REQUIRED', reason: decision.reason };
  }
  if (decision.decision === 'CHANGES') {
    audit(cfg.auditDir, { step: 'bootstrap', outcome: 'CHANGES', reason: decision.reason });
    return { outcome: 'CHANGES' };
  }

  if (qaWorkerOverridden) audit(cfg.auditDir, { step: 'bootstrap', outcome: 'QA_WORKER_OVERRIDDEN', reason: 'qa_route.semantic.qaWorkerId is controlled by role config' });

  // CREATE_TASK

  const { goal } = await ensureV1ContainerGoal(cfg.dataRoot, cfg.project);
  const created = await createTask(cfg.dataRoot, cfg.project, {
    goalId: goal.goalId,
    title: deriveTitle(decision.task_contract!),
    goal: String(decision.task_contract!.goal),
    reason: decision.reason,
    scope: String(decision.task_contract!.bounded_scope),
    contract: decision.task_contract,
  });
  const ready = await transitionTaskExecution(cfg.dataRoot, cfg.project, created.taskId, {
    expectedExecutionState: 'PLANNED',
    to: 'READY',
    reason: 'role-loop:bootstrap-create-task',
  });
  const dispatch = await cfg.dispatchHook(cfg.dataRoot, cfg.project, ready);
  audit(cfg.auditDir, { step: 'bootstrap', outcome: 'CREATE_TASK', taskId: created.taskId, runId: dispatch?.runId, contractHash: ready.contract?.contract_hash });
  return { outcome: 'CREATE_TASK', taskId: created.taskId, runId: dispatch?.runId };
}

// ── WBS-8: PM final gate ─────────────────────────────────────────────────────

async function handleAcceptAndNext(
  cfg: RoleLoopConfig,
  currentTask: TaskRecord,
  judgment: PmJudgment,
  correct?: (error: string) => Promise<PmJudgment>,
): Promise<Record<string, unknown>> {
  let raw = judgment.next_task_contract!;
  let overridden = false;
  const { goal } = await ensureV1ContainerGoal(cfg.dataRoot, cfg.project);
  if (currentTask.goalId !== goal.goalId) {
    return { status: 'OWNER_REQUIRED', reason: 'current Task is outside the V1 container Goal; refusing automatic next-Task creation' };
  }
  for (let round = 0; ; round += 1) {
    if (typeof raw.task_id === 'string' && listTasks(cfg.dataRoot, cfg.project).some((task) => task.taskId === raw.task_id)) {
      return { status: 'CONTRACT_FROZEN', reason: `CONTRACT_FROZEN: next_task_contract.task_id ${raw.task_id} already exists` };
    }
    const proposedProject = typeof raw.project === 'string' ? raw.project : cfg.project;
    if (proposedProject !== cfg.project) {
      return { status: 'OWNER_REQUIRED', reason: `next_task_contract.project (${proposedProject}) is outside the approved scope (${cfg.project})` };
    }
    try {
      const normalized = normalizePmTaskContract(cfg.roleConfig, raw);
      dryRunValidateContract(cfg.project, normalized.contract);
      raw = normalized.contract;
      overridden ||= normalized.overridden;
      break;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const max = cfg.maxValidationReasks ?? 3;
      if (!correct || round >= max) return { status: 'OWNER_REQUIRED', reason: `next_task_contract is invalid: ${error}` };
      audit(cfg.auditDir, { step: 'final-gate', outcome: `VALIDATION_REASK ${round + 1}/${max}`, reason: error });
      const corrected = await correct(error);
      if (corrected.decision !== 'ACCEPT_AND_NEXT' || !corrected.next_task_contract) {
        return { status: 'OWNER_REQUIRED', reason: 'next_task_contract correction did not return ACCEPT_AND_NEXT' };
      }
      raw = corrected.next_task_contract;
    }
  }
  if (overridden) audit(cfg.auditDir, { step: 'final-gate', outcome: 'QA_WORKER_OVERRIDDEN', reason: 'next_task_contract.qa_route.semantic.qaWorkerId is controlled by role config' });
  const created = await createTask(cfg.dataRoot, cfg.project, {
    goalId: goal.goalId,
    title: deriveTitle(raw),
    goal: String(raw.goal),
    reason: judgment.reason,
    scope: String(raw.bounded_scope),
    contract: raw,
  });
  const ready = await transitionTaskExecution(cfg.dataRoot, cfg.project, created.taskId, {
    expectedExecutionState: 'PLANNED',
    to: 'READY',
    reason: 'role-loop:accept-and-next',
  });
  try {
    const dispatch = await cfg.dispatchHook(cfg.dataRoot, cfg.project, ready);
    return { status: 'DISPATCHED', taskId: created.taskId, runId: dispatch?.runId, contractHash: ready.contract?.contract_hash };
  } catch (err) {
    return { status: 'CREATED_NOT_DISPATCHED', taskId: created.taskId, contractHash: ready.contract?.contract_hash, reason: err instanceof Error ? err.message : String(err) };
  }
}

async function applyFinalGateJudgment(cfg: RoleLoopConfig, deliveryId: string, packet: PmFinalGatePacket, judgment: PmJudgment, adapter: RoleRuntimeAdapter, sessionId: string): Promise<Record<string, unknown>> {
  const currentTask = getTask(cfg.dataRoot, cfg.project, packet.context.task.taskId);
  if ((judgment.decision === 'ACCEPT' || judgment.decision === 'ACCEPT_AND_NEXT')
    && packet.context.qa !== undefined && packet.context.qa.status !== 'PASS') {
    const reason = `ACCEPT requires QA PASS; latest QA status is ${packet.context.qa.status}${packet.context.qa.reason ? `: ${packet.context.qa.reason}` : ''}`;
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason });
    return { outcome: 'BLOCKED', reason };
  }
  if (judgment.decision === 'ACCEPT_AND_NEXT' && typeof judgment.next_task_contract?.task_id === 'string' && listTasks(cfg.dataRoot, cfg.project).some((task) => task.taskId === judgment.next_task_contract!.task_id)) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'CONTRACT_FROZEN', reason: `next_task_contract.task_id ${judgment.next_task_contract.task_id} already exists` });
    return { outcome: 'CONTRACT_FROZEN' };
  }
  if (judgment.decision === 'OWNER_REQUIRED') {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'OWNER_REQUIRED', reason: judgment.reason });
    return { outcome: 'OWNER_REQUIRED' };
  }
  const maxPmChanges = currentTask.contract?.retry_policy?.max_pm_changes;
  const priorPmChanges = listPmJudgments(cfg.dataRoot, cfg.project).filter((j) => j.taskId === currentTask.taskId && j.decision === 'CHANGES').length;
  if (judgment.decision === 'CHANGES' && typeof maxPmChanges === 'number' && priorPmChanges >= maxPmChanges) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'OWNER_REQUIRED', reason: `retry_policy.max_pm_changes exhausted (${priorPmChanges}/${maxPmChanges})` });
    return { outcome: 'OWNER_REQUIRED', reason: 'retry_policy.max_pm_changes exhausted' };
  }
  if (judgment.decision === 'ACCEPT' || judgment.decision === 'ACCEPT_AND_NEXT') {
    // Round 38b/38c: mechanically enforce the frozen contract's required_evidence
    // before applying ACCEPT. A token-named requirement must be covered by a
    // non-FAIL Evidence record bound to the accepted run at the required
    // type/trust; a prose requirement falls back to the default VERIFIED floor.
    // The gate can only REFUSE (never upgrade); on refusal the outcome is
    // rewritten to CHANGES and forwarded to the normal retry lifecycle. The
    // applied judgment records which rule matched per requirement.
    const runId = packet.context.attempt.runId;
    const evidenceGate = checkRequiredEvidence(currentTask.contract, listEvidenceForRun(cfg.dataRoot, cfg.project, runId));
    if (!evidenceGate.satisfied) {
      return refuseAcceptForMissingEvidence(cfg, deliveryId, packet, judgment, evidenceGate);
    }
    const judgmentRows = evidenceGate.known.length > 0 ? evidenceGateJudgmentRows(evidenceGate) : undefined;
    const result = await submitPmJudgment(cfg.dataRoot, cfg.project, {
      deliveryId, decision: 'ACCEPT', reason: judgment.reason,
      ...(judgmentRows ? { evidenceGate: judgmentRows } : {}),
    });
    let nextTask: Record<string, unknown> | undefined;
    if (judgment.decision === 'ACCEPT_AND_NEXT') {
      nextTask = await handleAcceptAndNext(cfg, currentTask, judgment, async (error) => {
        const correction = await sendAndParseOnce(adapter, sessionId, {
          kind: 'PM_FINAL_GATE', schemaVersion: 'pm-final-gate-packet.v1', contractHash: packet.context.task.contract_hash, contextHash: packet.contextHash,
          body: `${packet.text}\n\n---\nCONTRACT_VALIDATION_ERROR: ${error}\nReturn the COMPLETE corrected PM_JUDGMENT v1 block; keep everything else unchanged.`,
        }, (text) => parseFinalGateJudgment(packet, text), cfg.pmSendTimeoutMs ?? 120_000);
        if (!correction.ok) throw new Error(correction.error);
        return correction.value;
      });
    }
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'APPLIED', decision: judgment.decision, applied: result.applied, nextTask });
    return { outcome: 'APPLIED', decision: judgment.decision, nextTask };
  }
  await submitPmJudgment(cfg.dataRoot, cfg.project, { deliveryId, decision: 'CHANGES', reason: judgment.reason, retryInstruction: judgment.retry_instruction! });
  await prepareRetryForJudgment(cfg.dataRoot, cfg.project, deliveryId);
  await reconcileReadyRetryDispatches(cfg.dataRoot, cfg.project);
  audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'APPLIED', decision: 'CHANGES' });
  return { outcome: 'APPLIED', decision: 'CHANGES' };
}

export async function processFinalGate(cfg: RoleLoopConfig, deliveryId: string): Promise<Record<string, unknown>> {
  const timeoutMs = cfg.pmSendTimeoutMs ?? 120_000;
  const delivery = getPmDelivery(cfg.dataRoot, cfg.project, deliveryId);
  if (delivery.status !== 'PENDING') {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'REPLAY_IGNORED', status: delivery.status });
    return { outcome: 'REPLAY_IGNORED' };
  }

  const packet = buildPmFinalGatePacket(cfg.dataRoot, cfg.project, deliveryId);
  const state = readState(cfg.stateFile);
  const cached = state.finalGateDecisions?.[deliveryId];
  if (cached && cached.contextHash === packet.contextHash) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'FINAL_GATE_DECISION_CACHED', cachedOutcome: cached.outcome, ...(cached.reason ? { reason: cached.reason } : {}), contextHash: packet.contextHash });
    return { outcome: cached.outcome, ...(cached.reason ? { reason: cached.reason } : {}) };
  }
  const blockKey = `final-gate:${deliveryId}`;
  const prevBlock = state.blocked[blockKey];
  if (prevBlock && prevBlock.contextHash === packet.contextHash) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: prevBlock.reason });
    return { outcome: 'BLOCKED', reason: prevBlock.reason };
  }

  const assignment = cfg.roleConfig.assignments.find((a) => a.roleId === 'pm');
  if (!assignment) {
    const result = { outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' };
    cacheFinalGateDecision(state, cfg.stateFile, deliveryId, packet.contextHash, result);
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' });
    return result;
  }

  let adapter: RoleRuntimeAdapter;
  let sessionId: string;
  try {
    ({ adapter, sessionId } = await ensurePmAdapterAndSession(cfg, assignment, packet.contextHash));
  } catch (err) {
    if (err instanceof BillingGuardError || err instanceof PmOwnerRequiredError) {
      const outcome = err instanceof BillingGuardError ? 'BLOCKED_BILLING' : 'OWNER_REQUIRED';
      const result = { outcome, reason: err.message };
      cacheFinalGateDecision(state, cfg.stateFile, deliveryId, packet.contextHash, result);
      audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome, reason: err.message });
      return result;
    }
    return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
  }

  const envelope: InputEnvelope = {
    kind: 'PM_FINAL_GATE',
    schemaVersion: 'pm-final-gate-packet.v1',
    contractHash: packet.context.task.contract_hash,
    contextHash: packet.contextHash,
    body: packet.text,
  };
  let parsed: ParseOutcome<PmJudgment>;
  try {
    parsed = await sendAndParseWithReask(
      adapter,
      sessionId,
      envelope,
      (text) => parseFinalGateJudgment(packet, text),
      (err, pmReply) => reaskEnvelope('PM_FINAL_GATE', 'pm-final-gate-packet.v1', packet.contextHash, packet.text, err, pmReply),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof PmTimeoutError) {
      await rotateTimedOutPmSession(cfg, adapter, sessionId);
      return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
    }
    return recordRuntimeBlock(cfg, state, blockKey, packet.contextHash, err);
  }

  if (!parsed.ok) {
    state.blocked[blockKey] = { contextHash: packet.contextHash, reason: parsed.error, updatedAt: new Date().toISOString() };
    writeState(cfg.stateFile, state);
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: parsed.error });
    return { outcome: 'BLOCKED', reason: parsed.error };
  }
  delete state.blocked[blockKey];
  writeState(cfg.stateFile, state);

  const judgment = parsed.value;

  // Fail-closed re-read (V1_PACKETS_DESIGN.md §4): context_hash covers
  // contract_hash/QA-status/newer-run drift by construction; contract_hash is
  // additionally checked explicitly per the redirect's binding condition (c).
  const fresh = buildPmFinalGatePacket(cfg.dataRoot, cfg.project, deliveryId);
  if (fresh.contextHash !== judgment.context_hash) {
    if (fresh.contextHash === packet.contextHash) {
      audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'HASH_ECHO_REASK', field: 'context_hash', sent: packet.contextHash, expected: fresh.contextHash });
      const retry = await sendAndParseOnce(adapter, sessionId, {
        kind: 'PM_FINAL_GATE', schemaVersion: 'pm-final-gate-packet.v1', contractHash: packet.context.task.contract_hash, contextHash: packet.contextHash,
        body: `${packet.text}\n\n---\nHASH_ECHO_ERROR: echo contract_hash and context_hash exactly from the HASHES TO ECHO EXACTLY block.\ncontract_hash: ${packet.context.task.contract_hash}\ncontext_hash: ${packet.contextHash}`,
      }, (text) => parseFinalGateJudgment(packet, text), timeoutMs);
      if (!retry.ok) { audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: retry.error }); return { outcome: 'BLOCKED', reason: retry.error }; }
      return applyFinalGateJudgment(cfg, deliveryId, packet, retry.value, adapter, sessionId);
    }
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'REJECTED_STALE', reason: 'canonical state moved (context_hash mismatch after sent packet)' });
    return { outcome: 'REJECTED_STALE' };
  }
  const currentTask = getTask(cfg.dataRoot, cfg.project, fresh.context.task.taskId);
  const currentContractHash = currentTask.contract?.contract_hash;
  if ((currentContractHash ?? '') !== judgment.contract_hash) {
    if ((currentContractHash ?? '') === (packet.context.task.contract_hash ?? '')) {
      audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'HASH_ECHO_REASK', field: 'contract_hash', sent: packet.context.task.contract_hash, expected: currentContractHash });
      const retry = await sendAndParseOnce(adapter, sessionId, {
        kind: 'PM_FINAL_GATE', schemaVersion: 'pm-final-gate-packet.v1', contractHash: packet.context.task.contract_hash, contextHash: packet.contextHash,
        body: `${packet.text}\n\n---\nHASH_ECHO_ERROR: echo contract_hash and context_hash exactly from the HASHES TO ECHO EXACTLY block.\ncontract_hash: ${currentContractHash}\ncontext_hash: ${packet.contextHash}`,
      }, (text) => parseFinalGateJudgment(packet, text), timeoutMs);
      if (!retry.ok) { audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: retry.error }); return { outcome: 'BLOCKED', reason: retry.error }; }
      return applyFinalGateJudgment(cfg, deliveryId, packet, retry.value, adapter, sessionId);
    }
    audit(cfg.auditDir, {
      step: 'final-gate', deliveryId, outcome: 'REJECTED_STALE',
      reason: `contract_hash mismatch: Task has ${currentContractHash ?? '(none)'}, judgment carried ${judgment.contract_hash}`,
    });
    return { outcome: 'REJECTED_STALE' };
  }

  const result = await applyFinalGateJudgment(cfg, deliveryId, packet, judgment, adapter, sessionId);
  cacheFinalGateDecision(state, cfg.stateFile, deliveryId, packet.contextHash, result);
  return result;
}

// ── top-level pass ────────────────────────────────────────────────────────────

export async function runOnce(cfg: RoleLoopConfig): Promise<{ steps: Array<Record<string, unknown>> }> {
  const steps: Array<Record<string, unknown>> = [];
  const cycleState = readState(cfg.stateFile);
  cycleState.exhausted ??= {};
  for (const task of listClosedTerminalTasks(cfg.dataRoot, cfg.project)) {
    if (cycleState.exhausted[task.taskId]) continue;
    cycleState.exhausted[task.taskId] = { taskId: task.taskId, updatedAt: new Date().toISOString() };
    audit(cfg.auditDir, { step: 'TASK_EXHAUSTED', taskId: task.taskId, attempts: task.attempts, judgments: task.judgments });
    steps.push({ step: 'TASK_EXHAUSTED', taskId: task.taskId });
  }
  writeState(cfg.stateFile, cycleState);
  const retryOutcomes = await reconcileReadyRetryDispatches(cfg.dataRoot, cfg.project);
  for (const retry of retryOutcomes) {
    audit(cfg.auditDir, {
      step: 'retry-reconcile',
      preparationId: retry.preparationId,
      runId: retry.runId,
      outcome: retry.outcome === 'adopted' ? 'RETRY_ADOPTED' : retry.outcome === 'dispatched' ? 'RETRY_REDISPATCHED' : 'BLOCKED_RUNTIME',
      reason: retry.reason,
    });
  }

  // A retry/adoption dispatch sends asynchronously; the first dispatch path
  // collects in-process, but later supervisor cycles must resume that same
  // durable collect path. Never collect a RESERVED (not-sent) reservation;
  // retry reconciliation owns that state.
  const qaReconciled = new Set<string>();
  if (cfg.collectHook) {
    for (const task of listTasks(cfg.dataRoot, cfg.project)) {
      if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') continue;
      const latest = [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
      if (!latest) continue;
      let binding;
      try { binding = readRuntimeBinding(latest.folder); } catch { continue; }
      if (!binding || binding.collectStatus === 'FINAL_BOUND' || binding.collectStatus === 'RESERVED') continue;
      try {
        const collected = await cfg.collectHook(cfg.dataRoot, cfg.project, latest.runId);
        const outcome = collected.collectStatus === 'FINAL_BOUND' ? 'COLLECTED' : 'WAITING';
        audit(cfg.auditDir, { step: 'resume-collect', outcome, taskId: task.taskId, runId: latest.runId, ...(outcome === 'WAITING' ? { reason: 'worker has not produced a final result' } : {}) });
        steps.push({ step: 'resume-collect', outcome, taskId: task.taskId, runId: latest.runId });
        if (outcome === 'COLLECTED') {
          // Result Bridge normally invokes this; the explicit idempotent
          // reconcile also covers a completion admitted during this cycle.
          qaReconciled.add(task.taskId);
          await reconcileQaGate(cfg.dataRoot, cfg.project, task.taskId, { dispatchRemediation: cfg.qaRemediationDispatchHook }).catch(() => undefined);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        audit(cfg.auditDir, { step: 'resume-collect', outcome: 'WAITING', taskId: task.taskId, runId: latest.runId, reason });
        steps.push({ step: 'resume-collect', outcome: 'WAITING', taskId: task.taskId, runId: latest.runId, reason });
      }
    }
  }

  // A semantic QA precondition failure remains RESULT_RECEIVED+PENDING with
  // a durable retry count. Resume it on a later supervisor cycle; do not
  // manufacture a PM Delivery until the bounded semantic budget is exhausted.
  for (const task of listTasks(cfg.dataRoot, cfg.project)) {
    if (qaReconciled.has(task.taskId) || task.executionState !== 'RESULT_RECEIVED' || task.pmState !== 'PENDING' || !task.qaContract) continue;
    try {
      const result = await reconcileQaGate(cfg.dataRoot, cfg.project, task.taskId, { dispatchRemediation: cfg.qaRemediationDispatchHook });
      audit(cfg.auditDir, { step: 'qa-semantic-retry', outcome: result.outcome, taskId: task.taskId, ...(result.deliveryId ? { deliveryId: result.deliveryId } : {}) });
      steps.push({ step: 'qa-semantic-retry', taskId: task.taskId, outcome: result.outcome });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit(cfg.auditDir, { step: 'qa-semantic-retry', outcome: 'BLOCKED_RUNTIME', taskId: task.taskId, reason });
      steps.push({ step: 'qa-semantic-retry', taskId: task.taskId, outcome: 'BLOCKED_RUNTIME' });
    }
  }

  // QA FAIL creates a durable READY QRP before its remediation Run is
  // materialized. Resume that seam on every cycle, including after a crash;
  // the QA gate owns correlation, budget, and idempotency.
  for (const task of listTasks(cfg.dataRoot, cfg.project)) {
    if (task.executionState !== 'READY' || task.pmState !== 'PENDING') continue;
    const readyPreparations = listQaRemediationPreparations(cfg.dataRoot, cfg.project)
      .filter((prep) => prep.taskId === task.taskId && prep.status === 'READY' && !prep.dispatchedRunId);
    if (!readyPreparations.length) continue;
    try {
      const result = await reconcileQaGate(cfg.dataRoot, cfg.project, task.taskId, {
        dispatchRemediation: cfg.qaRemediationDispatchHook,
      });
      const outcome = result.outcome === 'FAIL_ESCALATED_BUDGET_EXHAUSTED'
        ? 'QA_BUDGET_EXHAUSTED'
        : result.alreadyDispatched ? 'QA_REMEDIATION_ADOPTED' : 'QA_REMEDIATION_DISPATCHED';
      audit(cfg.auditDir, {
        step: 'qa-remediation', outcome, taskId: task.taskId,
        ...(result.remediationRunId ? { runId: result.remediationRunId } : {}),
        remediationNumber: readyPreparations[0]!.qaRemediationNumber,
      });
      if (result.sourceSeatReleased) audit(cfg.auditDir, { step: 'qa-remediation', outcome: 'SEAT_RELEASED', ...result.sourceSeatReleased });
      steps.push({ step: 'qa-remediation', taskId: task.taskId, outcome, ...(result.remediationRunId ? { runId: result.remediationRunId } : {}) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit(cfg.auditDir, {
        step: 'qa-remediation',
        outcome: /budget|exceeds/i.test(reason) ? 'QA_BUDGET_EXHAUSTED' : 'BLOCKED_RUNTIME',
        taskId: task.taskId,
        reason,
      });
      steps.push({ step: 'qa-remediation', taskId: task.taskId, outcome: /budget|exceeds/i.test(reason) ? 'QA_BUDGET_EXHAUSTED' : 'BLOCKED_RUNTIME' });
    }
  }

  // A crash after createTask() but before dispatch leaves one canonical READY
  // Task with no linked Run. Adopt it before consulting PM again.
  for (const task of listTasks(cfg.dataRoot, cfg.project)) {
    if (task.executionState !== 'READY' || task.linkedRuns.length !== 0) continue;
    const dispatch = await cfg.dispatchHook(cfg.dataRoot, cfg.project, task);
    audit(cfg.auditDir, { step: 'dispatch-existing-ready', outcome: 'DISPATCHED', taskId: task.taskId, runId: dispatch?.runId });
    steps.push({ step: 'dispatch-existing-ready', taskId: task.taskId, runId: dispatch?.runId });
  }

  // A dispatch failure preserves the linked Run but has no Result to trigger
  // Result Bridge. Route that canonical failure into the same PM gate.
  for (const task of listTasks(cfg.dataRoot, cfg.project)) {
    if (task.executionState !== 'FAILED' || task.pmState !== 'PENDING') continue;
    const link = [...task.linkedRuns].sort((a, b) => b.taskRunSequence - a.taskRunSequence)[0];
    if (!link || !isTerminalFailedRun(cfg.dataRoot, cfg.project, link) || listPmDeliveries(cfg.dataRoot, cfg.project).some((d) => d.taskId === task.taskId && d.runId === link.runId)) continue;
    await ensurePmDeliveryForFailedRun(cfg.dataRoot, cfg.project, task.taskId, link.runId);
  }

  for (const d of listPendingPmDeliveries(cfg.dataRoot, cfg.project)) {
    const result = await processFinalGate(cfg, d.deliveryId);
    steps.push({ deliveryId: d.deliveryId, ...result });
  }

  if (!hasOpenTask(cfg.dataRoot, cfg.project) && listPendingPmDeliveries(cfg.dataRoot, cfg.project).length === 0 && !hasInFlightTerminalRun(cfg.dataRoot, cfg.project)) {
    const result = await processBootstrap(cfg);
    steps.push({ step: 'bootstrap', ...result });
  }

  const openTasks = listTasks(cfg.dataRoot, cfg.project)
    .filter((task) => task.pmState !== 'ACCEPTED' && task.executionState !== 'FAILED' && task.executionState !== 'CANCELLED')
    .map((task) => task.taskId);
  const pendingDeliveries = listPendingPmDeliveries(cfg.dataRoot, cfg.project).length;
  const blocked = Object.keys(readState(cfg.stateFile).blocked);
  audit(cfg.auditDir, { step: 'cycle', outcome: steps.length ? 'ACTED' : 'IDLE', openTasks, pendingDeliveries, blocked, reason: steps.length ? 'cycle work processed' : 'no actionable work' });

  return { steps };
}
