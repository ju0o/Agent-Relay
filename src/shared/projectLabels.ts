export interface ProjectLabel {
  name: string;
  goal: string;
}

export const PROJECT_LABELS: Record<string, ProjectLabel> = {
  'agent-relay': { name: 'Agent Relay', goal: 'CORE V1 자동 실행과 결과 수집' },
  actl: { name: 'actl', goal: '안전한 작업 전달과 Windows Board 검증' },
  juactl: { name: 'actl', goal: '안전한 작업 전달과 Windows Board 검증' },
  juplan: { name: 'JuPlan', goal: '계획 기반 프로젝트 실행과 릴리스 검증' },
  juceipt: { name: 'JuCeipt', goal: '영수증 처리 재시도와 안정성 검증' },
  jucontroler: { name: 'JuControler', goal: '프로젝트 통합 제어와 운영 가시성' },
  'jucontroler-app': { name: '통합 관제 화면', goal: '프로젝트 통합 제어와 운영 가시성' },
  'juceipt-planning': { name: 'JuCeipt 기획', goal: 'JuCeipt 계획 기반 실행과 릴리스 검증' },
};

/** Joined hold reasons that count as "no hold" (empty, dash placeholder, or only separators). */
function isEmptyReasons(text: string): boolean {
  const stripped = text.trim().replace(/[,\s·・|—–-]+/g, '');
  return stripped.length === 0 || stripped === '—';
}

/**
 * 보류 / 차단 카드 문구 — 비어 있으면 null을 반환해 카드를 렌더링하지 않음.
 * Control Room LaneView와 단위 테스트가 공유하는 단일 진입점.
 */
export function holdCardMessage(blocker: unknown, reason: unknown): string | null {
  const blockerText = typeof blocker === 'string' ? blocker.trim() : '';
  const reasonText = Array.isArray(reason)
    ? reason.map(item => (typeof item === 'string' ? item : '')).join(', ')
    : typeof reason === 'string'
      ? reason
      : '';
  if (!blockerText && isEmptyReasons(reasonText)) return null;
  const cleanReason = reasonText.trim();
  const text = `${blockerText} ${cleanReason}`.toUpperCase();
  if (text.includes('FOUNDER')) return 'Founder 확인이 필요해 작업을 보류했습니다.';
  if (text.includes('SCOPE')) return '승인된 작업 범위가 없어 작업을 보류했습니다.';
  if (text.includes('NOT_CONNECTED')) return 'PM 연결이 없어 다음 작업을 대기 중입니다.';
  return cleanReason && !isEmptyReasons(cleanReason)
    ? `작업이 보류되었습니다: ${cleanReason}`
    : '작업이 보류되었습니다.';
}
