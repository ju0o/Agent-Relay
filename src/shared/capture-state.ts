import { CaptureStatusView } from './types.js';

/**
 * Agent-neutral Session-bound capture state (Session-Bound Capture UX, packet 03).
 *
 * This is a pure projection of the BACKEND/canonical CaptureStatusView — the
 * frontend renders it verbatim and never invents its own interpretation. It
 * satisfies the minimum product state model using the existing canonical
 * phases owned by CaptureManager / SessionBindingPolicy:
 *
 *   idle        (no capture armed)      → UNBOUND        (연결 안 됨)
 *   unbound     watching, no binding    → BINDING        (세션 연결 대기 중 / 세션 찾는 중)
 *   bound       watching + boundSession → BOUND / WAITING_RESPONSE (연결됨 · 응답 대기 중)
 *   ambiguous   candidatesNeedSelection → AMBIGUOUS      (세션 선택 필요)
 *   result      captured                → RESULT_RECEIVED (Result 수신 완료)
 *   error       error                   → ERROR
 *   stopped     disarmed                → stopped (연결 해제)
 */
export type CaptureViewState =
  | 'idle'
  | 'unbound'
  | 'bound'
  | 'ambiguous'
  | 'result'
  | 'error'
  | 'stopped';

/**
 * Map the canonical backend capture status to a display state.
 * `null` (no active capture) is explicitly UNBOUND/idle — never a false
 * "waiting for response" claim.
 */
export function captureViewState(c: CaptureStatusView | null): CaptureViewState {
  if (!c) return 'idle';
  switch (c.phase) {
    case 'watching':
      return c.boundSessionId ? 'bound' : 'unbound';
    case 'ambiguous':
      return 'ambiguous';
    case 'captured':
      return 'result';
    case 'error':
      return 'error';
    case 'stopped':
      return 'stopped';
    default:
      return 'idle';
  }
}

/** True only when a deterministic Session has actually been bound. */
export function isSessionBound(c: CaptureStatusView | null): boolean {
  return !!c && captureViewState(c) === 'bound' && !!c.boundSessionId;
}

/** True only when a Result has already been captured from the bound Session. */
export function isResultReceived(c: CaptureStatusView | null): boolean {
  return !!c && captureViewState(c) === 'result';
}

/** Shorten a sessionId for display only (full id always kept in state/evidence). */
export function shortId(id: string | undefined, len = 8): string {
  if (!id) return '';
  return id.length <= len + 2 ? id : `${id.slice(0, len)}…`;
}

/**
 * Display label for the bound session: "<title> · <shortId>" when a title is
 * available from the adapter, otherwise just the short ID.
 */
export function sessionLabel(c: CaptureStatusView | null): string {
  if (!c?.boundSessionId) return '';
  const short = shortId(c.boundSessionId);
  return c.boundSessionTitle ? `${c.boundSessionTitle} · ${short}` : short;
}
