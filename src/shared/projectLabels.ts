export interface ProjectLabel {
  name: string;
  goal: string;
}

export const PROJECT_LABELS: Record<string, ProjectLabel> = {
  'agent-relay': { name: 'Agent Relay', goal: 'CORE V1 자동 실행과 결과 수집' },
  actl: { name: 'actl', goal: '안전한 작업 전달과 Windows Board 검증' },
  juplan: { name: 'JuPlan', goal: '계획 기반 프로젝트 실행과 릴리스 검증' },
  juceipt: { name: 'JuCeipt', goal: '영수증 처리 재시도와 안정성 검증' },
  jucontroler: { name: 'JuControler', goal: '프로젝트 통합 제어와 운영 가시성' },
  'jucontroler-app': { name: '통합 관제 화면 (jucontroler-app)', goal: '프로젝트 통합 제어와 운영 가시성' },
  'juceipt-planning': { name: 'JuCeipt 기획 (juceipt-planning)', goal: 'JuCeipt 계획 기반 실행과 릴리스 검증' },
};
