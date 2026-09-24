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
  'jucontroler-app': { name: '통합 관제 화면', goal: '여러 프로젝트 진행 상황을 한눈에 확인' },
  'juceipt-planning': { name: 'JuCeipt 기획', goal: 'JuCeipt 기획안 정리와 실행 준비' },
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

// ── 보류 explain (holds/<id>.json → night board step/explain/choice) ──────
// night board의 lane.holds 항목이 문자열이 아니라
// { taskId, reason, step, explain: { sentence }, choice } 형태일 수 있다.
// explain.sentence가 있으면 그 한국어 문장을 보여주고,
// 원문 영문 reason은 닫힌 <details>원문 보기</details> 안에만 둔다.
// choice가 'skip'인 항목은 보여주지 않는다. Pure — 단위 테스트 대상.

/** explain.sentence가 없을 때 대신 보여주는 보류 선택지 3개 (순수 한국어 라벨). */
export const HOLD_OPTION_LABELS: readonly string[] = [
  '다시 시도',
  '다음 작업으로 진행',
  '내가 직접 볼게요',
];

/** '내가 직접 볼게요' 선택지(직접 확인 — 자동 재개 없음)인지 판별. 구 라벨 'Founder에게 확인'도 포함. */
export function isSelfReviewOption(label: unknown): boolean {
  const text = cleanText(label);
  if (!text) return false;
  if (text === '내가 직접 볼게요') return true;
  if (text === 'Founder에게 확인') return true;
  return /직접/.test(text);
}

/** 보류 단계 표기 — 검수 단계 용어로 통일. QA/검증/확인 표기는 모두 '검수'로 보여준다. */
export function holdStepLabel(step: unknown): string {
  const text = cleanText(step);
  if (!text) return '';
  const upper = text.toUpperCase();
  if (text.includes('검수') || upper.includes('QA') || text.includes('검증') || text.includes('확인')) return '검수';
  return text;
}

/** Control Room 보류 항목 1개의 정규화 결과. */
export interface NormalizedHold {
  taskId: string;
  reason: string;
  step: string;
  /** explain.sentence — 한국어 문장. 없으면 '' . */
  sentence: string;
  /** holds/<id>.json의 choice 원문 (소문자 비교용으로 다듬지 않은 값). */
  choice: string;
  /** 보여줄 선택지 라벨 (holds 항목의 options가 있으면 그것을, 없으면 HOLD_OPTION_LABELS). */
  options: string[];
  /** Backend option ids matching options by index. */
  optionIds: string[];
  /** 추천 선택지 index — sentence가 있을 때만 사용, 없으면 -1. */
  recommendedIndex: number;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function explainSentenceOf(explain: unknown): string {
  if (typeof explain === 'string') return explain.trim();
  if (explain && typeof explain === 'object') {
    const record = explain as Record<string, unknown>;
    const direct = cleanText(record.sentence ?? record.text ?? record.summary);
    if (direct) return direct;
  }
  return '';
}

function optionsOf(raw: unknown): { labels: string[]; ids: string[] } {
  if (!Array.isArray(raw)) return { labels: [...HOLD_OPTION_LABELS], ids: ['retry', 'narrow', 'skip'] };
  const parsed = raw
    .map(option => {
      if (typeof option === 'string') return { id: '', label: option.trim() };
      if (option && typeof option === 'object') {
        const record = option as Record<string, unknown>;
        return { id: cleanText(record.id), label: cleanText(record.label ?? record.title ?? record.name) };
      }
      return { id: '', label: '' };
    })
    .filter(option => option.label.length > 0);
  return parsed.length > 0
    ? { labels: parsed.map(option => option.label), ids: parsed.map(option => option.id) }
    : { labels: [...HOLD_OPTION_LABELS], ids: ['retry', 'narrow', 'skip'] };
}

/** choice 원문을 options index로 푼다. 못 찾으면 sentence가 있을 때 0, 없으면 -1. */
function recommendedIndexOf(choice: unknown, options: string[], optionIds: string[], hasSentence: boolean): number {
  const normalized = cleanText(choice).toLowerCase();
  if (!normalized) return hasSentence ? 0 : -1;
  const byNumber = Number(normalized);
  if (Number.isInteger(byNumber) && byNumber >= 0 && byNumber < options.length) return byNumber;
  const hit = options.findIndex(label => label === cleanText(choice) || label.toLowerCase() === normalized);
  if (hit >= 0) return hit;
  const idHit = optionIds.findIndex(id => id === cleanText(choice) || id.toLowerCase() === normalized);
  if (idHit >= 0) return idHit;
  if (/(retry|reattempt|again|다시)/.test(normalized)) return 0;
  if (/(next|continue|proceed|다음)/.test(normalized)) return 1;
  if (/(founder|ask|confirm|확인|직접|볼게요)/.test(normalized)) return 2;
  return hasSentence ? 0 : -1;
}

/** choice가 'skip'이면 true — 대소문자/공백 무시. */
export function isHoldSkipped(choice: unknown): boolean {
  return cleanText(choice).toLowerCase() === 'skip';
}

/**
 * holds 항목 1개를 정규화한다. 문자열이면 reason만 있는 항목으로 취급.
 * choice가 'skip'이거나 내용이 완전히 비어 있으면 null.
 */
export function normalizeHoldEntry(entry: unknown): NormalizedHold | null {
  if (typeof entry === 'string') {
    const reason = entry.trim();
    if (!reason || isEmptyReasons(reason)) return null;
    return { taskId: '', reason, step: '', sentence: '', choice: '', options: [...HOLD_OPTION_LABELS], optionIds: ['retry', 'narrow', 'skip'], recommendedIndex: -1 };
  }
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const explain = record.explain ?? record.explanation;
  const choiceRaw = record.choice ?? (explain && typeof explain === 'object'
    ? (explain as Record<string, unknown>).choice
    : undefined);
  const choice = cleanText(choiceRaw);
  if (isHoldSkipped(choice)) return null;
  const sentence = explainSentenceOf(explain);
  const reason = cleanText(record.reason ?? record.message ?? record.finding ?? record.detail);
  const taskId = cleanText(record.taskId ?? record.task ?? record.id);
  const stepValue = record.step ?? record.stage;
  const step = typeof stepValue === 'number' && Number.isFinite(stepValue) ? String(stepValue) : cleanText(stepValue);
  if (!sentence && !reason && !taskId && !step) return null;
  const optionSource = explain && typeof explain === 'object'
    ? (explain as Record<string, unknown>).options ?? record.options ?? record.choices
    : record.options ?? record.choices;
  const parsedOptions = optionsOf(optionSource);
  const options = parsedOptions.labels;
  const optionIds = parsedOptions.ids.map((id, index) => id || ['retry', 'narrow', 'skip'][index] || '');
  const recommended = explain && typeof explain === 'object'
    ? (explain as Record<string, unknown>).recommended ?? record.recommended ?? (Array.isArray(record.options) ? choiceRaw : record.options ?? choiceRaw) ?? HOLD_OPTION_LABELS[0]
    : record.recommended ?? (Array.isArray(record.options) ? choiceRaw : record.options ?? choiceRaw) ?? HOLD_OPTION_LABELS[0];
  return {
    taskId,
    reason,
    step,
    sentence,
    choice,
    options,
    optionIds,
    recommendedIndex: recommendedIndexOf(recommended, options, optionIds, sentence.length > 0),
  };
}

/**
 * lane.holds 배열에서 보여줄 항목만 골라 정규화한다.
 * choice 'skip' 항목과 빈 항목은 제외된다. 배열이 아니면 [].
 */
export function visibleHoldEntries(holds: unknown): NormalizedHold[] {
  if (!Array.isArray(holds)) return [];
  const out: NormalizedHold[] = [];
  for (const entry of holds) {
    const normalized = normalizeHoldEntry(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}
