/**
 * WORKSPACE SHELL V0 — human-readable status language.
 *
 * Pure presentation mapping only. No Relay business logic, no transitions,
 * no API calls. Technical literals stay in expandable details.
 */

export type WorkspaceStatusKind =
  | 'READY'
  | 'RUNNING'
  | 'RESULT_RECEIVED'
  | 'VERIFYING'
  | 'CHANGES_REQUESTED'
  | 'ACCEPTED'
  | 'BLOCKED'
  | 'OWNER_REQUIRED'
  | 'IDLE';

export const STATUS_LABEL_KO: Record<WorkspaceStatusKind, string> = {
  READY: '작업 준비됨',
  RUNNING: '작업 중',
  RESULT_RECEIVED: '결과 도착',
  VERIFYING: 'PM 검토 중',
  CHANGES_REQUESTED: '수정 필요',
  ACCEPTED: '완료 승인',
  BLOCKED: '진행 막힘',
  OWNER_REQUIRED: '사용자 확인 필요',
  IDLE: '대기 중',
};

export function statusLabel(kind: WorkspaceStatusKind): string {
  return STATUS_LABEL_KO[kind] ?? kind;
}

export type DotTone = 'idle' | 'active' | 'warn' | 'done' | 'blocked';

export function statusDotTone(kind: WorkspaceStatusKind): DotTone {
  switch (kind) {
    case 'RUNNING':
    case 'VERIFYING':
    case 'RESULT_RECEIVED':
      return 'active';
    case 'CHANGES_REQUESTED':
    case 'OWNER_REQUIRED':
      return 'warn';
    case 'ACCEPTED':
    case 'READY':
      return 'done';
    case 'BLOCKED':
      return 'blocked';
    case 'IDLE':
    default:
      return 'idle';
  }
}

/**
 * Derive a single human-facing workspace status from raw Relay axes.
 * Presentation-only: picks the most user-relevant label, never transitions.
 */
export function deriveWorkspaceStatus(input: {
  executionState?: string;
  pmState?: string;
  hasCurrentTask: boolean;
}): WorkspaceStatusKind {
  if (!input.hasCurrentTask) return 'IDLE';
  if (input.executionState === 'BLOCKED') return 'BLOCKED';
  if (input.pmState === 'ACCEPTED') return 'ACCEPTED';
  if (input.pmState === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  if (input.pmState === 'VERIFYING') return 'VERIFYING';
  if (input.executionState === 'RESULT_RECEIVED') return 'RESULT_RECEIVED';
  if (input.executionState === 'RUNNING' || input.executionState === 'DISPATCHED') return 'RUNNING';
  if (input.executionState === 'READY') return 'READY';
  if (input.executionState === 'FAILED' || input.executionState === 'CANCELLED') return 'BLOCKED';
  return 'IDLE';
}

/**
 * Next expected action — human hint derived from visible state.
 * Presentation only; the backend remains the only state machine.
 */
export function nextActionLabel(input: {
  executionState?: string;
  pmState?: string;
  hasCurrentTask: boolean;
  hasNextTask: boolean;
}): string {
  if (!input.hasCurrentTask) return input.hasNextTask ? '다음 작업 시작 대기' : '새 목표 대기';
  if (input.executionState === 'BLOCKED') return '막힘 해소 필요';
  if (input.pmState === 'ACCEPTED') return input.hasNextTask ? '다음 작업으로 이동' : '목표 완료 확인';
  if (input.pmState === 'CHANGES_REQUESTED') return '수정 후 재실행';
  if (input.pmState === 'VERIFYING') return 'PM 판단 대기';
  if (input.executionState === 'RESULT_RECEIVED') return 'PM 검토 대기';
  if (input.executionState === 'RUNNING' || input.executionState === 'DISPATCHED') return '작업자 결과 대기';
  if (input.executionState === 'READY') return '실행 대기';
  return '상태 확인';
}
