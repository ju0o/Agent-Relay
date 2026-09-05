/**
 * V1.5 Slice 1 — durable ExecutionPlan kernel.
 *
 * This module owns Plan storage, validation, serialized lifecycle transitions,
 * and immutable authorization evidence only. It deliberately does NOT read or
 * mutate Task/Run/PM records, dispatch Workers, advance a successor, recover a
 * Plan, or expose MCP/TUI surfaces.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EXECUTION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_STATES,
  type ExecutionPlanAuthorization,
  type ExecutionPlanBlock,
  type ExecutionPlanRecord,
  type ExecutionPlanState,
  type ExecutionPlanTaskBinding,
} from '../shared/types.js';
import { relayDir, writeJsonAtomic } from './goal-task.js';

export {
  EXECUTION_PLAN_SCHEMA_VERSION,
  EXECUTION_PLAN_STATES,
  type ExecutionPlanAuthorization,
  type ExecutionPlanBlock,
  type ExecutionPlanRecord,
  type ExecutionPlanState,
  type ExecutionPlanTaskBinding,
};

const PLAN_ID_RE = /^PLAN-(\d+)$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const TERMINAL_STATES = new Set<ExecutionPlanState>(['COMPLETED', 'FAILED', 'CANCELLED']);
const TRANSITIONS: Readonly<Record<ExecutionPlanState, readonly ExecutionPlanState[]>> = {
  PLANNED: ['RUNNING'],
  RUNNING: ['COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['RUNNING'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class ExecutionPlanError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'INVALID_ARGUMENT'
    | 'INVALID_STATE'
    | 'CONFLICT'
    | 'IO_FAILURE';

  constructor(code: ExecutionPlanError['code'], message: string) {
    super(message);
    this.name = 'ExecutionPlanError';
    this.code = code;
  }
}

export interface CreateExecutionPlanInput {
  title: string;
  orderedTaskIds: string[];
  taskBindings: ExecutionPlanTaskBinding[];
}

export interface StartExecutionPlanInput {
  expectedState: 'PLANNED';
  activeTaskId: string;
  ownerAuthorization: ExecutionPlanAuthorization;
}

export interface TransitionExecutionPlanInput {
  expectedState: ExecutionPlanState;
  to: 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'CANCELLED';
  reason?: string;
  block?: Omit<ExecutionPlanBlock, 'at'>;
}

export interface ResumeBlockedExecutionPlanInput {
  expectedState: 'BLOCKED';
  /** Future Owner-recovery path must provide a durable authority identity. */
  ownerRecoveryId: string;
}

const _planLocks = new Map<string, Promise<void>>();
const _planCreateLocks = new Map<string, Promise<void>>();

function lock<T>(locks: Map<string, Promise<void>>, key: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const work = previous.then(fn);
  locks.set(key, work.then(() => undefined, () => undefined));
  return work;
}

function rootProjectKey(dataRoot: string, project: string): string {
  return `${path.resolve(dataRoot)}@@${project}`;
}

export function withExecutionPlanLock<T>(
  dataRoot: string,
  project: string,
  planId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const normalizedProject = requireNonEmpty(project, 'project', 256);
  const normalizedPlanId = requirePlanId(planId);
  return lock(_planLocks, `${rootProjectKey(dataRoot, normalizedProject)}::${normalizedPlanId}`, async () => {
    const lockFile = executionPlanLockPath(dataRoot, normalizedProject, normalizedPlanId);
    let handle: number;
    try {
      handle = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(handle, `${JSON.stringify({ planId: normalizedPlanId, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new ExecutionPlanError('CONFLICT', `ExecutionPlan mutation lock is held: ${normalizedPlanId}`);
      }
      throw new ExecutionPlanError('IO_FAILURE', `ExecutionPlan mutation lock acquisition failed: ${normalizedPlanId}`);
    }
    try {
      return await fn();
    } finally {
      try { fs.closeSync(handle); } catch { /* best effort before unlink */ }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // The mutation may already be durable. Leave the lock rather than
        // guessing ownership; the next mutation fails closed and surfaces it.
      }
    }
  });
}

export function _resetExecutionPlanLocksForTests(): void {
  _planLocks.clear();
  _planCreateLocks.clear();
}

export function executionPlansDir(dataRoot: string, project: string): string {
  return path.join(relayDir(dataRoot, project), 'plans');
}

export function executionPlanFolder(dataRoot: string, project: string, planId: string): string {
  return path.join(executionPlansDir(dataRoot, project), requirePlanId(planId));
}

export function executionPlanPath(dataRoot: string, project: string, planId: string): string {
  return path.join(executionPlanFolder(dataRoot, project, planId), 'plan.json');
}

/** Local exclusive mutation lock. A leftover lock is intentionally fail-closed. */
export function executionPlanLockPath(dataRoot: string, project: string, planId: string): string {
  return path.join(executionPlanFolder(dataRoot, project, planId), '.plan-mutation.lock');
}

function requireNonEmpty(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', `${field} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function requirePlanId(value: unknown): string {
  const id = requireNonEmpty(value, 'planId', 64);
  if (!PLAN_ID_RE.test(id)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', `Invalid planId: ${id}`);
  }
  return id;
}

function requireIso(value: unknown, field: string): string {
  const iso = requireNonEmpty(value, field, 64);
  if (Number.isNaN(Date.parse(iso))) {
    throw new ExecutionPlanError('INVALID_STATE', `${field} must be an ISO timestamp.`);
  }
  return iso;
}

function requireFingerprint(value: unknown, field: string): string {
  const fingerprint = requireNonEmpty(value, field, 128);
  if (!FINGERPRINT_RE.test(fingerprint)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', `${field} must be a lowercase SHA-256 fingerprint.`);
  }
  return fingerprint;
}

function normalizeBinding(value: ExecutionPlanTaskBinding): ExecutionPlanTaskBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', 'taskBinding must be an object.');
  }
  const taskId = requireNonEmpty(value.taskId, 'taskBinding.taskId', 128);
  const workerId = requireNonEmpty(value.workerId, 'taskBinding.workerId', 128);
  const workspaceRoot = requireNonEmpty(value.workspaceRoot, 'taskBinding.workspaceRoot', 2048);
  if (workspaceRoot.includes('\0') || !path.isAbsolute(workspaceRoot)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', 'taskBinding.workspaceRoot must be an absolute NUL-free path.');
  }
  return { taskId, workerId, workspaceRoot, scopeFingerprint: requireFingerprint(value.scopeFingerprint, 'taskBinding.scopeFingerprint') };
}

/** Deterministic frozen definition hash. Do not include lifecycle fields. */
export function computeExecutionPlanScopeFingerprint(input: Pick<ExecutionPlanRecord, 'project' | 'title' | 'orderedTaskIds' | 'taskBindings'>): string {
  const bindings = [...input.taskBindings]
    .map((binding) => ({
      taskId: binding.taskId,
      workerId: binding.workerId,
      workspaceRoot: binding.workspaceRoot,
      scopeFingerprint: binding.scopeFingerprint,
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const canonical = JSON.stringify({
    project: input.project,
    title: input.title,
    orderedTaskIds: [...input.orderedTaskIds],
    taskBindings: bindings,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function validateAuthorization(record: ExecutionPlanRecord, authorization: ExecutionPlanAuthorization): void {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    throw new ExecutionPlanError('INVALID_STATE', 'ownerAuthorization must be an object.');
  }
  requireNonEmpty(authorization.authorizationId, 'ownerAuthorization.authorizationId', 256);
  requireIso(authorization.approvedAt, 'ownerAuthorization.approvedAt');
  if (authorization.approvedBy !== 'OWNER') {
    throw new ExecutionPlanError('INVALID_STATE', 'ownerAuthorization.approvedBy must be OWNER.');
  }
  const planFingerprint = requireFingerprint(authorization.planScopeFingerprint, 'ownerAuthorization.planScopeFingerprint');
  const expected = computeExecutionPlanScopeFingerprint(record);
  if (planFingerprint !== expected) {
    throw new ExecutionPlanError('INVALID_STATE', 'ownerAuthorization.planScopeFingerprint does not match frozen Plan definition.');
  }
  if (!authorization.taskScopeFingerprints || typeof authorization.taskScopeFingerprints !== 'object' || Array.isArray(authorization.taskScopeFingerprints)) {
    throw new ExecutionPlanError('INVALID_STATE', 'ownerAuthorization.taskScopeFingerprints must be an object.');
  }
  const keys = Object.keys(authorization.taskScopeFingerprints).sort();
  const expectedKeys = [...record.orderedTaskIds].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new ExecutionPlanError('INVALID_STATE', 'ownerAuthorization.taskScopeFingerprints must contain exactly the Plan Task IDs.');
  }
  const bindings = new Map(record.taskBindings.map((binding) => [binding.taskId, binding]));
  for (const taskId of record.orderedTaskIds) {
    if (requireFingerprint(authorization.taskScopeFingerprints[taskId], `ownerAuthorization.taskScopeFingerprints.${taskId}`) !== bindings.get(taskId)?.scopeFingerprint) {
      throw new ExecutionPlanError('INVALID_STATE', `ownerAuthorization fingerprint does not match binding for ${taskId}.`);
    }
  }
}

export function validateExecutionPlanRecord(record: ExecutionPlanRecord): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ExecutionPlanError('INVALID_STATE', 'ExecutionPlan record must be an object.');
  }
  if (record.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION) {
    throw new ExecutionPlanError('INVALID_STATE', `Unsupported ExecutionPlan schemaVersion: ${String(record.schemaVersion)}`);
  }
  requirePlanId(record.planId);
  requireNonEmpty(record.project, 'project', 256);
  requireNonEmpty(record.title, 'title', 500);
  if (!Array.isArray(record.orderedTaskIds) || record.orderedTaskIds.length < 1) {
    throw new ExecutionPlanError('INVALID_STATE', 'orderedTaskIds must contain at least one Task.');
  }
  const ids = record.orderedTaskIds.map((taskId) => requireNonEmpty(taskId, 'orderedTaskIds[]', 128));
  if (new Set(ids).size !== ids.length) {
    throw new ExecutionPlanError('INVALID_STATE', 'orderedTaskIds must not contain duplicates.');
  }
  if (!Array.isArray(record.taskBindings)) {
    throw new ExecutionPlanError('INVALID_STATE', 'taskBindings must be an array.');
  }
  const bindings = record.taskBindings.map(normalizeBinding);
  if (bindings.length !== ids.length || new Set(bindings.map((binding) => binding.taskId)).size !== bindings.length) {
    throw new ExecutionPlanError('INVALID_STATE', 'Each ordered Task must have exactly one binding.');
  }
  const orderedSet = new Set(ids);
  if (bindings.some((binding) => !orderedSet.has(binding.taskId))) {
    throw new ExecutionPlanError('INVALID_STATE', 'taskBindings must not contain an out-of-plan Task.');
  }
  if (!(EXECUTION_PLAN_STATES as readonly string[]).includes(record.state)) {
    throw new ExecutionPlanError('INVALID_STATE', `Unknown ExecutionPlan state: ${String(record.state)}`);
  }
  if (record.activeTaskId !== null && (typeof record.activeTaskId !== 'string' || !orderedSet.has(record.activeTaskId))) {
    throw new ExecutionPlanError('INVALID_STATE', 'activeTaskId must be null or a declared Plan Task.');
  }
  const createdAt = requireIso(record.createdAt, 'createdAt');
  const updatedAt = requireIso(record.updatedAt, 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ExecutionPlanError('INVALID_STATE', 'updatedAt must not precede createdAt.');
  }
  if (record.state === 'PLANNED') {
    if (record.activeTaskId !== null || record.ownerAuthorization || record.completedAt || record.terminalAt || record.terminalReason || record.block) {
      throw new ExecutionPlanError('INVALID_STATE', 'PLANNED Plan must not contain active, authorization, terminal, or block state.');
    }
  } else {
    if (!record.ownerAuthorization) {
      throw new ExecutionPlanError('INVALID_STATE', 'Non-PLANNED Plan requires immutable ownerAuthorization.');
    }
    validateAuthorization(record, record.ownerAuthorization);
  }
  if (record.state === 'RUNNING') {
    if (record.activeTaskId === null || record.completedAt || record.terminalAt || record.terminalReason || record.block) {
      throw new ExecutionPlanError('INVALID_STATE', 'RUNNING Plan requires one active Task and no terminal/block metadata.');
    }
  }
  if (record.state === 'BLOCKED') {
    if (record.activeTaskId === null || !record.block || record.completedAt || record.terminalAt || record.terminalReason) {
      throw new ExecutionPlanError('INVALID_STATE', 'BLOCKED Plan requires activeTaskId and block metadata only.');
    }
    requireNonEmpty(record.block.code, 'block.code', 128);
    requireNonEmpty(record.block.reason, 'block.reason', 500);
    requireIso(record.block.at, 'block.at');
    if (record.block.taskId !== undefined && !orderedSet.has(record.block.taskId)) {
      throw new ExecutionPlanError('INVALID_STATE', 'block.taskId must be a declared Plan Task.');
    }
  }
  if (record.state === 'COMPLETED') {
    if (record.activeTaskId !== null || !record.completedAt || record.terminalAt || record.terminalReason || record.block) {
      throw new ExecutionPlanError('INVALID_STATE', 'COMPLETED Plan requires completedAt only.');
    }
    requireIso(record.completedAt, 'completedAt');
  }
  if (record.state === 'FAILED' || record.state === 'CANCELLED') {
    if (record.activeTaskId === null || !record.terminalAt || !record.terminalReason || record.completedAt || record.block) {
      throw new ExecutionPlanError('INVALID_STATE', `${record.state} Plan requires activeTaskId, terminalAt, and terminalReason.`);
    }
    requireIso(record.terminalAt, 'terminalAt');
    requireNonEmpty(record.terminalReason, 'terminalReason', 500);
  }
}

function nextTimestamp(previous: string): string {
  const candidate = Date.now();
  const prior = Date.parse(previous);
  return new Date(candidate > prior ? candidate : prior + 1).toISOString();
}

function planJsonPath(folder: string): string {
  return path.join(folder, 'plan.json');
}

function readExecutionPlan(dataRoot: string, project: string, planId: string): ExecutionPlanRecord {
  const file = executionPlanPath(dataRoot, project, planId);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ExecutionPlanError('NOT_FOUND', `ExecutionPlan not found: ${requirePlanId(planId)}`);
    throw new ExecutionPlanError('IO_FAILURE', `ExecutionPlan read failed: ${requirePlanId(planId)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExecutionPlanError('INVALID_STATE', `ExecutionPlan JSON is malformed: ${requirePlanId(planId)}`);
  }
  const record = parsed as ExecutionPlanRecord;
  validateExecutionPlanRecord(record);
  if (record.project !== project || record.planId !== planId) {
    throw new ExecutionPlanError('INVALID_STATE', 'ExecutionPlan storage identity does not match requested project/planId.');
  }
  return record;
}

function persistExecutionPlan(dataRoot: string, project: string, record: ExecutionPlanRecord): ExecutionPlanRecord {
  validateExecutionPlanRecord(record);
  try {
    writeJsonAtomic(executionPlanPath(dataRoot, project, record.planId), record);
  } catch {
    throw new ExecutionPlanError('IO_FAILURE', `ExecutionPlan persist failed: ${record.planId}`);
  }
  return record;
}

function allocatePlanFolder(dataRoot: string, project: string): { planId: string; folder: string } {
  const dir = executionPlansDir(dataRoot, project);
  fs.mkdirSync(dir, { recursive: true });
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const match = PLAN_ID_RE.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  for (let number = max + 1; ; number += 1) {
    const planId = `PLAN-${String(number).padStart(4, '0')}`;
    const folder = path.join(dir, planId);
    try {
      fs.mkdirSync(folder);
      return { planId, folder };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ExecutionPlanError('IO_FAILURE', 'ExecutionPlan ID allocation failed.');
    }
  }
}

export async function createExecutionPlan(
  dataRoot: string,
  project: string,
  input: CreateExecutionPlanInput,
): Promise<ExecutionPlanRecord> {
  const normalizedProject = requireNonEmpty(project, 'project', 256);
  const title = requireNonEmpty(input?.title, 'title', 500);
  if (!Array.isArray(input?.orderedTaskIds) || !Array.isArray(input?.taskBindings)) {
    throw new ExecutionPlanError('INVALID_ARGUMENT', 'orderedTaskIds and taskBindings are required arrays.');
  }
  return lock(_planCreateLocks, rootProjectKey(dataRoot, normalizedProject), async () => {
    const { planId, folder } = allocatePlanFolder(dataRoot, normalizedProject);
    const timestamp = new Date().toISOString();
    const record: ExecutionPlanRecord = {
      schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
      planId,
      project: normalizedProject,
      title,
      orderedTaskIds: [...input.orderedTaskIds],
      taskBindings: input.taskBindings.map(normalizeBinding),
      state: 'PLANNED',
      activeTaskId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      validateExecutionPlanRecord(record);
      persistExecutionPlan(dataRoot, normalizedProject, record);
      return record;
    } catch (error) {
      try { fs.rmdirSync(folder); } catch { /* preserve non-empty forensic state */ }
      throw error;
    }
  });
}

export function getExecutionPlan(dataRoot: string, project: string, planId: string): ExecutionPlanRecord {
  return readExecutionPlan(dataRoot, requireNonEmpty(project, 'project', 256), requirePlanId(planId));
}

/** Lists every canonical Plan directory; malformed Plan records fail closed. */
export function listExecutionPlans(dataRoot: string, project: string): ExecutionPlanRecord[] {
  const normalizedProject = requireNonEmpty(project, 'project', 256);
  const dir = executionPlansDir(dataRoot, normalizedProject);
  if (!fs.existsSync(dir)) return [];
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => PLAN_ID_RE.test(name)).sort(); } catch {
    throw new ExecutionPlanError('IO_FAILURE', 'ExecutionPlan list failed.');
  }
  return names.map((planId) => readExecutionPlan(dataRoot, normalizedProject, planId));
}

function immutableAuthorization(input: ExecutionPlanAuthorization): ExecutionPlanAuthorization {
  return {
    authorizationId: requireNonEmpty(input.authorizationId, 'ownerAuthorization.authorizationId', 256),
    approvedAt: requireIso(input.approvedAt, 'ownerAuthorization.approvedAt'),
    approvedBy: 'OWNER',
    planScopeFingerprint: requireFingerprint(input.planScopeFingerprint, 'ownerAuthorization.planScopeFingerprint'),
    taskScopeFingerprints: Object.fromEntries(Object.entries(input.taskScopeFingerprints ?? {}).map(([taskId, fingerprint]) => [taskId, requireFingerprint(fingerprint, `ownerAuthorization.taskScopeFingerprints.${taskId}`)])),
  };
}

/** Future Slice 2 calls this from the narrowly authorized Owner-GO boundary. */
export async function startExecutionPlan(
  dataRoot: string,
  project: string,
  planId: string,
  input: StartExecutionPlanInput,
): Promise<ExecutionPlanRecord> {
  return withExecutionPlanLock(dataRoot, project, planId, () => {
    const current = getExecutionPlan(dataRoot, project, planId);
    if (current.state !== input.expectedState) {
      throw new ExecutionPlanError('CONFLICT', `Expected Plan state ${input.expectedState}, found ${current.state}.`);
    }
    if (current.state !== 'PLANNED') {
      throw new ExecutionPlanError('INVALID_STATE', 'Only PLANNED Plan may start.');
    }
    const activeTaskId = requireNonEmpty(input.activeTaskId, 'activeTaskId', 128);
    if (!current.orderedTaskIds.includes(activeTaskId)) {
      throw new ExecutionPlanError('INVALID_ARGUMENT', 'activeTaskId must be a declared Plan Task.');
    }
    const next: ExecutionPlanRecord = {
      ...current,
      state: 'RUNNING',
      activeTaskId,
      ownerAuthorization: immutableAuthorization(input.ownerAuthorization),
      updatedAt: nextTimestamp(current.updatedAt),
    };
    return persistExecutionPlan(dataRoot, project, next);
  });
}

/** Controlled terminal/block transition only; no arbitrary Plan patch surface. */
export async function transitionExecutionPlan(
  dataRoot: string,
  project: string,
  planId: string,
  input: TransitionExecutionPlanInput,
): Promise<ExecutionPlanRecord> {
  return withExecutionPlanLock(dataRoot, project, planId, () => {
    const current = getExecutionPlan(dataRoot, project, planId);
    if (current.state !== input.expectedState) {
      throw new ExecutionPlanError('CONFLICT', `Expected Plan state ${input.expectedState}, found ${current.state}.`);
    }
    if (current.state === input.to) return current; // identical replay is safe and side-effect free
    if (!TRANSITIONS[current.state].includes(input.to)) {
      throw new ExecutionPlanError('INVALID_STATE', `Illegal ExecutionPlan transition: ${current.state} -> ${input.to}.`);
    }
    if (current.state !== 'RUNNING') {
      throw new ExecutionPlanError('INVALID_STATE', 'Only RUNNING Plans may transition through this primitive.');
    }
    const timestamp = nextTimestamp(current.updatedAt);
    const reason = input.reason ? requireNonEmpty(input.reason, 'reason', 500) : undefined;
    if (input.to === 'BLOCKED') {
      if (!input.block) throw new ExecutionPlanError('INVALID_ARGUMENT', 'BLOCKED transition requires block metadata.');
      const block: ExecutionPlanBlock = {
        code: requireNonEmpty(input.block.code, 'block.code', 128),
        reason: requireNonEmpty(input.block.reason, 'block.reason', 500),
        at: timestamp,
        ...(input.block.taskId ? { taskId: requireNonEmpty(input.block.taskId, 'block.taskId', 128) } : {}),
      };
      const next: ExecutionPlanRecord = { ...current, state: 'BLOCKED', block, updatedAt: timestamp };
      return persistExecutionPlan(dataRoot, project, next);
    }
    if (input.to === 'COMPLETED') {
      const next: ExecutionPlanRecord = { ...current, state: 'COMPLETED', activeTaskId: null, completedAt: timestamp, updatedAt: timestamp };
      return persistExecutionPlan(dataRoot, project, next);
    }
    const terminalReason = reason ?? `${input.to} recorded by controlled Plan transition.`;
    const next: ExecutionPlanRecord = { ...current, state: input.to, terminalAt: timestamp, terminalReason, updatedAt: timestamp };
    return persistExecutionPlan(dataRoot, project, next);
  });
}

/** Guarded kernel primitive; no Owner/MCP surface is exposed in Slice 1. */
export async function resumeBlockedExecutionPlan(
  dataRoot: string,
  project: string,
  planId: string,
  input: ResumeBlockedExecutionPlanInput,
): Promise<ExecutionPlanRecord> {
  return withExecutionPlanLock(dataRoot, project, planId, () => {
    const current = getExecutionPlan(dataRoot, project, planId);
    if (current.state !== input.expectedState) {
      throw new ExecutionPlanError('CONFLICT', `Expected Plan state ${input.expectedState}, found ${current.state}.`);
    }
    if (current.state !== 'BLOCKED' || !current.ownerAuthorization || current.activeTaskId === null) {
      throw new ExecutionPlanError('INVALID_STATE', 'Only a valid BLOCKED Plan may resume.');
    }
    requireNonEmpty(input.ownerRecoveryId, 'ownerRecoveryId', 256);
    const next: ExecutionPlanRecord = {
      ...current,
      state: 'RUNNING',
      block: undefined,
      updatedAt: nextTimestamp(current.updatedAt),
    };
    return persistExecutionPlan(dataRoot, project, next);
  });
}

export function isTerminalExecutionPlanState(state: ExecutionPlanState): boolean {
  return TERMINAL_STATES.has(state);
}
