/**
 * V1-G2 — Owner-approved one-call dispatch.
 *
 * Narrow explicit surface representing "the owner approved this one dispatch".
 *
 * Design (frozen):
 *   - The V1 internal technical Goal intentionally remains PLAN (least
 *     privilege). This helper MUST NOT mutate Goal permissionPolicy and MUST
 *     NOT switch PLAN → APPROVE/BYPASS.
 *   - The User's explicit "GO" is a one-time Owner authorization for THIS Task
 *     dispatch only. It is expressed by evaluating/enforcing the existing
 *     central permission gate (`authorizeEffect`) with OWNER_IPC-equivalent
 *     authorization semantics for this ONE DISPATCH effect only.
 *   - No reusable approval token is created, no broad elevated permission is
 *     persisted, and no other effect is granted owner semantics.
 *   - After authorization, this helper delegates to the existing canonical
 *     `dispatcher.dispatchTask()`. No Dispatcher logic is duplicated here:
 *     Run materialization, Task READY→DISPATCHED→RUNNING, Capture arm, Worker
 *     spawn, and observation binding all remain Dispatcher-owned.
 *
 * Accepted inputs (exactly these four — no goalId, permission mode, runId,
 * launch command, adapter id, CLI args, env, or shell flags):
 *   - taskId, workerId, workspaceRoot, expectedExecutionState ('READY' only)
 */

import { getGoal, getTask } from './goal-task.js';
import { authorizeEffect } from './permission-gate.js';
import { DispatcherError, dispatchTask, type DispatchResult } from './dispatcher.js';
import { computeTaskScopeFingerprint, mintRetryAuthorization } from './retry-authorization.js';
import { recordRuntimeWarning } from './event.js';

export interface V1OwnerApprovedDispatchInput {
  taskId: string;
  workerId: string;
  workspaceRoot: string;
  expectedExecutionState: 'READY';
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DispatcherError('INVALID_ARGUMENT', `${field}이(가) 필요합니다.`);
  }
  return value.trim();
}

/**
 * Perform ONE owner-authorized dispatch of ONE READY Task to ONE worker.
 *
 * Preconditions (canonical Dispatcher errors where possible):
 *   - Task must exist (else NOT_FOUND)
 *   - expectedExecutionState must be READY (else INVALID_ARGUMENT)
 *   - Task must currently be READY / match expected state (else stale → CONFLICT/INVALID_STATE)
 *   - worker / workspaceRoot / active-conflict / orphan-suspected failures
 *     surface from the canonical dispatcher unchanged.
 */
export async function dispatchV1OwnerApproved(
  dataRoot: string,
  project: string,
  input: V1OwnerApprovedDispatchInput,
): Promise<DispatchResult> {
  const taskId = requireNonEmptyString(input?.taskId, 'taskId');
  const workerId = requireNonEmptyString(input?.workerId, 'workerId');
  const workspaceRoot = requireNonEmptyString(input?.workspaceRoot, 'workspaceRoot');

  if (input?.expectedExecutionState !== 'READY') {
    throw new DispatcherError(
      'INVALID_ARGUMENT',
      `expectedExecutionState must be READY, got: ${String(input?.expectedExecutionState)}`,
    );
  }

  // Resolve owning Goal BEFORE authorization (NOT_FOUND when Task missing).
  // goalId is resolved server-side — never accepted from the caller.
  let goalId: string;
  try {
    goalId = getTask(dataRoot, project, taskId).goalId;
  } catch {
    throw new DispatcherError('NOT_FOUND', `Task '${taskId}' 찾을 수 없습니다.`);
  }

  // Stale / non-READY precondition BEFORE any dispatch effect.
  const current = getTask(dataRoot, project, taskId);
  if (current.executionState !== 'READY') {
    throw new DispatcherError(
      'INVALID_STATE',
      `Task executionState must be READY to dispatch (found ${current.executionState}).`,
    );
  }

  // V1-G5-C correction: compute the ORIGINAL owner-approved scope fingerprint
  // from the canonical Task BEFORE dispatch, and carry it as trusted internal
  // owner-approval context into the Dispatcher so it is persisted on the
  // initial RunMeta. The SAME precomputed value is used for the authorization
  // mint below — never recomputed from post-dispatch/current Task state.
  const ownerApprovedScopeFingerprint = computeTaskScopeFingerprint(current);

  // ONE-TIME owner authorization for THIS dispatch effect only.
  // Uses the existing central gate with OWNER_IPC-equivalent semantics.
  // Does NOT mutate Goal permissionPolicy; does NOT grant owner semantics
  // to any other effect; creates no token and persists no elevation.
  let policy: { mode: 'PLAN' | 'APPROVE' | 'BYPASS' };
  try {
    policy = getGoal(dataRoot, project, goalId).permissionPolicy ?? { mode: 'PLAN' };
  } catch {
    policy = { mode: 'PLAN' };
  }
  authorizeEffect({
    effect: 'DISPATCH',
    callerSurface: 'OWNER_IPC',
    permissionPolicy: policy,
  });

  // Canonical dispatch — Dispatcher owns Run, CAS, Capture, spawn, binding.
  // ownerApprovalContext carries the precomputed original owner-approved
  // fingerprint for persistence on the initial RunMeta (repair truth).
  const result = await dispatchTask(dataRoot, project, {
    taskId,
    workerId,
    workspaceRoot,
    expectedExecutionState: 'READY',
    ownerApprovalContext: { scopeFingerprint: ownerApprovedScopeFingerprint },
  });

  // V1-G5-C: mint the narrow retry authorization ONLY after the canonical
  // initial dispatch has succeeded (the Task/Run binding is real). The mint
  // uses the SAME precomputed owner-approved fingerprint — NOT a fingerprint
  // recomputed from the current Task — so normal mint and crash repair share
  // identical approval truth. A mint failure never rolls back the real
  // dispatch; it records a bounded warning and the binding can be repaired
  // later from the trusted first-run binding.
  try {
    mintRetryAuthorization(dataRoot, project, {
      taskId,
      goalId,
      workerId,
      workspaceRoot,
      scopeFingerprint: ownerApprovedScopeFingerprint,
      source: 'OWNER_APPROVED_INITIAL_DISPATCH',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await recordRuntimeWarning(dataRoot, project, {
        summary: `RETRY_AUTH_MINT_FAILED: initial dispatch of Task ${taskId} succeeded but retry authorization could not be persisted; repair from first-run binding may be required.`,
        taskId,
        runId: result.runId,
        goalId,
        source: { kind: 'v1-dispatch', subsystem: 'retry-authorization' },
        details: { workerId, error: msg },
      });
    } catch { /* warning best-effort; dispatch result stands */ }
  }
  return result;
}
