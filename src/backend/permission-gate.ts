/**
 * Phase H — Central PermissionPolicy enforcement.
 *
 * Caller surfaces:
 *   PM_MCP | OWNER_IPC | INTERNAL_TRUSTED
 *
 * Hard ceilings: PM MCP can never MERGE_MAIN / RELEASE / DESTRUCTIVE_ACTION /
 * PRODUCTION_DEPLOY / SECRET_CHANGE even via overrides.
 */
import type { PermissionMode, PermissionPolicy } from '../shared/types.js';

export type CallerSurface = 'PM_MCP' | 'OWNER_IPC' | 'INTERNAL_TRUSTED';

export type PermissionEffect =
  | 'DISPATCH'
  | 'COMPLETE_GOAL'
  | 'ORPHAN_KEEP_WAITING'
  | 'ORPHAN_CONFIRM_FAILED'
  | 'ORPHAN_CONFIRM_CANCELLED'
  | 'RECOVER_COMPLETED_RUN'
  | 'ACCEPT_RESULT'
  | 'REQUEST_CHANGES'
  | 'REQUEST_RETRY'
  | 'MERGE_MAIN'
  | 'RELEASE'
  | 'DESTRUCTIVE_ACTION'
  | 'PRODUCTION_DEPLOY'
  | 'SECRET_CHANGE';

export class PermissionDeniedError extends Error {
  readonly code = 'FORBIDDEN' as const;
  readonly effect: PermissionEffect;
  readonly callerSurface: CallerSurface;
  readonly mode: PermissionMode;

  constructor(
    effect: PermissionEffect,
    callerSurface: CallerSurface,
    mode: PermissionMode,
    message?: string,
  ) {
    super(
      message
        ?? `FORBIDDEN: effect=${effect} denied for callerSurface=${callerSurface} mode=${mode}`,
    );
    this.name = 'PermissionDeniedError';
    this.effect = effect;
    this.callerSurface = callerSurface;
    this.mode = mode;
  }
}

const PM_HARD_DENIED: ReadonlySet<PermissionEffect> = new Set([
  'MERGE_MAIN',
  'RELEASE',
  'DESTRUCTIVE_ACTION',
  'PRODUCTION_DEPLOY',
  'SECRET_CHANGE',
]);

export interface AuthorizeEffectInput {
  effect: PermissionEffect;
  callerSurface: CallerSurface;
  permissionPolicy: PermissionPolicy;
}

export interface AuthorizeEffectResult {
  allowed: boolean;
  effect: PermissionEffect;
  callerSurface: CallerSurface;
  mode: PermissionMode;
  reason?: string;
}

function modeOf(policy: PermissionPolicy): PermissionMode {
  return policy?.mode ?? 'PLAN';
}

/**
 * Pure decision — does not throw. Use authorizeEffect() to enforce.
 */
export function evaluateEffect(input: AuthorizeEffectInput): AuthorizeEffectResult {
  const { effect, callerSurface, permissionPolicy } = input;
  const mode = modeOf(permissionPolicy);

  if (callerSurface === 'INTERNAL_TRUSTED') {
    return { allowed: true, effect, callerSurface, mode };
  }

  // PM hard ceilings — overrides MUST NOT grant these.
  if (callerSurface === 'PM_MCP' && PM_HARD_DENIED.has(effect)) {
    return {
      allowed: false,
      effect,
      callerSurface,
      mode,
      reason: `PM_MCP hard ceiling denies ${effect}`,
    };
  }

  // Orphan confirmations: OWNER_IPC only (even BYPASS).
  if (effect === 'ORPHAN_CONFIRM_FAILED' || effect === 'ORPHAN_CONFIRM_CANCELLED') {
    if (callerSurface !== 'OWNER_IPC') {
      return {
        allowed: false,
        effect,
        callerSurface,
        mode,
        reason: `${effect} is OWNER_IPC only`,
      };
    }
    return { allowed: true, effect, callerSurface, mode };
  }

  if (effect === 'ORPHAN_KEEP_WAITING') {
    // PM allowed all modes; Owner allowed all modes.
    return { allowed: true, effect, callerSurface, mode };
  }

  if (effect === 'RECOVER_COMPLETED_RUN') {
    // Fact-reconciliation of an already-completed Worker Run, not a new
    // judgment or dispatch decision — PM allowed all modes; Owner allowed all modes.
    return { allowed: true, effect, callerSurface, mode };
  }

  // PM judgment actions — ALLOW in PLAN / APPROVE / BYPASS
  if (
    effect === 'ACCEPT_RESULT'
    || effect === 'REQUEST_CHANGES'
    || effect === 'REQUEST_RETRY'
  ) {
    if (callerSurface === 'PM_MCP' || callerSurface === 'OWNER_IPC') {
      return { allowed: true, effect, callerSurface, mode };
    }
  }

  if (effect === 'DISPATCH') {
    if (callerSurface === 'OWNER_IPC') {
      return { allowed: true, effect, callerSurface, mode };
    }
    if (callerSurface === 'PM_MCP') {
      if (mode === 'PLAN') {
        return {
          allowed: false,
          effect,
          callerSurface,
          mode,
          reason: 'PM_MCP DISPATCH denied in PLAN mode',
        };
      }
      // APPROVE / BYPASS
      return { allowed: true, effect, callerSurface, mode };
    }
  }

  if (effect === 'COMPLETE_GOAL') {
    if (callerSurface === 'OWNER_IPC') {
      return { allowed: true, effect, callerSurface, mode };
    }
    if (callerSurface === 'PM_MCP') {
      if (mode === 'PLAN') {
        return {
          allowed: false,
          effect,
          callerSurface,
          mode,
          reason: 'PM_MCP COMPLETE_GOAL denied in PLAN mode',
        };
      }
      return { allowed: true, effect, callerSurface, mode };
    }
  }

  // Owner hard-ceiling effects (merge/release/…) — OWNER_IPC may still be gated
  // by overrides in future; for H freeze, OWNER_IPC ALLOW, PM already denied above.
  if (PM_HARD_DENIED.has(effect) && callerSurface === 'OWNER_IPC') {
    return { allowed: true, effect, callerSurface, mode };
  }

  return {
    allowed: false,
    effect,
    callerSurface,
    mode,
    reason: `No permission matrix entry for effect=${effect} callerSurface=${callerSurface}`,
  };
}

/** Enforce permission — throws PermissionDeniedError when denied. */
export function authorizeEffect(input: AuthorizeEffectInput): AuthorizeEffectResult {
  const result = evaluateEffect(input);
  if (!result.allowed) {
    throw new PermissionDeniedError(
      result.effect,
      result.callerSurface,
      result.mode,
      result.reason,
    );
  }
  return result;
}
