/**
 * SessionBindingStatus — compact Agent + Session + Status strip (packet 03).
 *
 * Agent-neutral: it renders the canonical CaptureStatusView from the backend
 * verbatim. It answers, at a glance:
 *
 *   "What Agent Session is this Run currently connected to, and what state is
 *   Relay in?"
 *
 * State flow rendered (never invents its own interpretation):
 *   idle        → UNBOUND       (연결 안 됨 — this Run is not yet connected)
 *   unbound     → BINDING       (세션 연결 대기 중 · 세션 찾는 중)
 *   bound       → WAITING_RESPONSE (연결됨 · 응답 대기 중)
 *   ambiguous   → AMBIGUOUS     (세션 선택 필요)
 *   result      → RESULT_RECEIVED (Result 수신 완료 — binding 유지)
 *   error       → ERROR
 *
 * The Session ID is shortened for display only; the full sessionId remains in
 * the canonical CaptureStatusView / evidence/adapter.json. When a title is
 * available from the adapter it shows "<title> · <short sessionId>", otherwise
 * the short ID alone.
 */
import React from 'react';
import { CaptureStatusView } from '../shared/types.js';
import { captureViewState, sessionLabel } from '../shared/capture-state.js';

export interface SessionBindingStatusProps {
  capture: CaptureStatusView | null;
  /** Folder of the currently active Run. The strip answers for THIS run only. */
  activeFolder?: string;
}

export function SessionBindingStatus({ capture, activeFolder }: SessionBindingStatusProps): React.ReactElement {
  // The capture belongs to the active run only when its folder matches; the
  // strip must never claim THIS run is connected to a Session that was armed
  // on another Run.
  const applies = !!capture && !!activeFolder && capture.folder === activeFolder;
  const effective = applies ? capture : null;
  const state = captureViewState(effective);
  const agentName = effective?.agentName ?? '';
  const boundLabel = sessionLabel(effective);

  const sessionText = ((): string => {
    switch (state) {
      case 'idle':
        return '연결 안 됨';
      case 'unbound':
        return '연결 대기 중';
      case 'bound':
        return boundLabel || '세션 연결됨';
      case 'ambiguous':
        return '세션 선택 필요';
      case 'result':
        return boundLabel || '결과 수신됨';
      case 'error':
        return '오류';
      case 'stopped':
        return '연결 해제됨';
      default:
        return '';
    }
  })();

  const statusText = ((): string => {
    switch (state) {
      case 'idle':
        return '이 런은 아직 에이전트 세션에 연결되지 않았습니다';
      case 'unbound':
        return '세션 찾는 중 · 아직 응답 대기 아님';
      case 'bound':
        return '연결됨 · 응답 대기 중';
      case 'ambiguous':
        return '결과를 받을 세션을 선택하세요';
      case 'result':
        return 'Result 수신 완료';
      case 'error':
        return effective?.message ?? '자동 수신 오류';
      case 'stopped':
        return '자동 수신이 해제되었습니다';
      default:
        return '';
    }
  })();

  return (
    <div className={`sess-bound-status sbs-${state}`} data-testid="sess-bound-status">
      <div className="sbs-row">
        <span className="sbs-label">Agent</span>
        <span className="sbs-value sbs-agent">{agentName || '—'}</span>
      </div>
      <div className="sbs-row">
        <span className="sbs-label">Session</span>
        <span className="sbs-value sbs-session" title={effective?.boundSessionId}>
          {sessionText}
        </span>
      </div>
      <div className="sbs-row">
        <span className="sbs-label">Status</span>
        <span className="sbs-value sbs-status">{statusText}</span>
      </div>
    </div>
  );
}
