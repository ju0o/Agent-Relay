import * as fs from 'node:fs';
import * as path from 'node:path';
import { getTask, createTask, listTasks } from '../backend/goal-task.js';
import { transitionTaskExecution } from '../backend/goal-task-runtime.js';
import { listPendingPmDeliveries, getPmDelivery, listPmDeliveries, ensurePmDeliveryForFailedRun } from '../backend/pm-delivery.js';
import { submitPmJudgment, listPmJudgments } from '../backend/pm-judgment.js';
import { prepareRetryForJudgment } from '../backend/retry-preparation.js';
import { reconcileReadyRetryDispatches } from '../backend/retry-dispatch.js';
import { ensureV1ContainerGoal } from '../backend/v1-intake.js';
import { buildTaskContract } from '../backend/task-contract.js';
import type { RoleConfig, RoleAssignment } from '../roles/role-config.js';
import type { RoleRuntimeAdapter, InputEnvelope } from '../integrations/core/role-runtime.js';
import { readRoleSession, roleSessionPath, writeRoleSession } from '../integrations/core/role-runtime.js';
import type { TaskRecord } from '../shared/types.js';
import { buildPmBootstrapPacket, buildPmFinalGatePacket, type PmFinalGatePacket } from './pm-packets.js';
import { parsePmTaskDecision, parsePmJudgment, type PmTaskDecision, type PmJudgment } from './pm-schemas.js';

export type DispatchHook = (dataRoot: string, project: string, task: TaskRecord) => Promise<{ runId: string } | void>;

export interface RoleLoopConfig {
  dataRoot: string;
  project: string;
  roleConfig: RoleConfig;
  pmAdapter: RoleRuntimeAdapter;
  dispatchHook: DispatchHook;
  auditDir: string;
  stateFile: string;
  /** Default 120_000ms per the WBS-5/8 redirect's binding condition (d). */
  pmSendTimeoutMs?: number;
  /** Resolves a fallbackChain adapter id to a registered RoleRuntimeAdapter, or null if unregistered. */
  resolveAdapter?: (adapterId: string) => RoleRuntimeAdapter | null;
  /** Maximum re-asks for contract/QA validation failures; schema errors remain single-reask. */
  maxValidationReasks?: number;
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
class PmContractValidationError extends Error {}

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
  pendingReask?: Record<string, { contextHash: string; reason: string; retryAfter?: number; updatedAt: string }>;
}

function readState(stateFile: string): OrchestratorStateFile {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as OrchestratorStateFile;
  } catch {
    return { schemaVersion: 1, blocked: {}, pendingReask: {} };
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
  writeState(stateFile, state);
}

function audit(auditDir: string, item: Record<string, unknown>): void {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.appendFileSync(path.join(auditDir, 'role-loop.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...item }) + '\n');
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
  return listTasks(dataRoot, project).some((t) => t.pmState !== 'ACCEPTED' && t.executionState !== 'CANCELLED');
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
    const preamble = fs.readFileSync(path.resolve(process.cwd(), 'docs/PM_ROLE_INSTRUCTIONS.md'), 'utf8');
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

async function handleAcceptAndNext(cfg: RoleLoopConfig, currentTask: TaskRecord, judgment: PmJudgment): Promise<Record<string, unknown>> {
  const raw = judgment.next_task_contract!;
  if (typeof raw.task_id === 'string' && listTasks(cfg.dataRoot, cfg.project).some((task) => task.taskId === raw.task_id)) {
    return { status: 'CONTRACT_FROZEN', reason: `CONTRACT_FROZEN: next_task_contract.task_id ${raw.task_id} already exists` };
  }
  const proposedProject = typeof raw.project === 'string' ? raw.project : cfg.project;
  if (proposedProject !== cfg.project) {
    return { status: 'OWNER_REQUIRED', reason: `next_task_contract.project (${proposedProject}) is outside the approved scope (${cfg.project})` };
  }
  const { goal } = await ensureV1ContainerGoal(cfg.dataRoot, cfg.project);
  if (currentTask.goalId !== goal.goalId) {
    return { status: 'OWNER_REQUIRED', reason: 'current Task is outside the V1 container Goal; refusing automatic next-Task creation' };
  }
  try {
    dryRunValidateContract(cfg.project, raw);
  } catch (err) {
    return { status: 'OWNER_REQUIRED', reason: `next_task_contract is invalid: ${err instanceof Error ? err.message : String(err)}` };
  }
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

async function applyFinalGateJudgment(cfg: RoleLoopConfig, deliveryId: string, packet: PmFinalGatePacket, judgment: PmJudgment): Promise<Record<string, unknown>> {
  const currentTask = getTask(cfg.dataRoot, cfg.project, packet.context.task.taskId);
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
    const result = await submitPmJudgment(cfg.dataRoot, cfg.project, { deliveryId, decision: 'ACCEPT', reason: judgment.reason });
    let nextTask: Record<string, unknown> | undefined;
    if (judgment.decision === 'ACCEPT_AND_NEXT') nextTask = await handleAcceptAndNext(cfg, currentTask, judgment);
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
  const blockKey = `final-gate:${deliveryId}`;
  const prevBlock = state.blocked[blockKey];
  if (prevBlock && prevBlock.contextHash === packet.contextHash) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: prevBlock.reason });
    return { outcome: 'BLOCKED', reason: prevBlock.reason };
  }

  const assignment = cfg.roleConfig.assignments.find((a) => a.roleId === 'pm');
  if (!assignment) {
    audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' });
    return { outcome: 'OWNER_REQUIRED', reason: 'no pm RoleAssignment in role config' };
  }

  let adapter: RoleRuntimeAdapter;
  let sessionId: string;
  try {
    ({ adapter, sessionId } = await ensurePmAdapterAndSession(cfg, assignment, packet.contextHash));
  } catch (err) {
    if (err instanceof BillingGuardError || err instanceof PmOwnerRequiredError) {
      const outcome = err instanceof BillingGuardError ? 'BLOCKED_BILLING' : 'OWNER_REQUIRED';
      audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome, reason: err.message });
      return { outcome, reason: err.message };
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
      parsePmJudgment,
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
      }, parsePmJudgment, timeoutMs);
      if (!retry.ok) { audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: retry.error }); return { outcome: 'BLOCKED', reason: retry.error }; }
      return applyFinalGateJudgment(cfg, deliveryId, packet, retry.value);
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
      }, parsePmJudgment, timeoutMs);
      if (!retry.ok) { audit(cfg.auditDir, { step: 'final-gate', deliveryId, outcome: 'BLOCKED', reason: retry.error }); return { outcome: 'BLOCKED', reason: retry.error }; }
      return applyFinalGateJudgment(cfg, deliveryId, packet, retry.value);
    }
    audit(cfg.auditDir, {
      step: 'final-gate', deliveryId, outcome: 'REJECTED_STALE',
      reason: `contract_hash mismatch: Task has ${currentContractHash ?? '(none)'}, judgment carried ${judgment.contract_hash}`,
    });
    return { outcome: 'REJECTED_STALE' };
  }

  return applyFinalGateJudgment(cfg, deliveryId, packet, judgment);
}

// ── top-level pass ────────────────────────────────────────────────────────────

export async function runOnce(cfg: RoleLoopConfig): Promise<{ steps: Array<Record<string, unknown>> }> {
  const steps: Array<Record<string, unknown>> = [];
  await reconcileReadyRetryDispatches(cfg.dataRoot, cfg.project);

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
    if (!link || listPmDeliveries(cfg.dataRoot, cfg.project).some((d) => d.taskId === task.taskId && d.runId === link.runId)) continue;
    await ensurePmDeliveryForFailedRun(cfg.dataRoot, cfg.project, task.taskId, link.runId);
  }

  for (const d of listPendingPmDeliveries(cfg.dataRoot, cfg.project)) {
    const result = await processFinalGate(cfg, d.deliveryId);
    steps.push({ deliveryId: d.deliveryId, ...result });
  }

  if (!hasOpenTask(cfg.dataRoot, cfg.project)) {
    const result = await processBootstrap(cfg);
    steps.push({ step: 'bootstrap', ...result });
  }

  return { steps };
}
