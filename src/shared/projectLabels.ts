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

const AI_DISPLAY_NAMES: Record<string, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  cline: 'Cline',
  grok: 'Grok',
  cursor: 'Cursor',
  claude: 'Claude',
  'claude-team': 'Claude 팀',
  'claude-pro': 'Claude Pro',
};

/** runtime id → 제품 이름. 모르는 id는 그대로 돌려준다. */
export function aiDisplayName(runtimeId: string): string {
  return Object.prototype.hasOwnProperty.call(AI_DISPLAY_NAMES, runtimeId) ? AI_DISPLAY_NAMES[runtimeId] : runtimeId;
}

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
  // 원문 reason은 헤드라인에 넣지 않는다 — 원문 보기 details에서만 보여준다.
  return '작업이 보류되었습니다. 자세한 내용은 원문 보기에서 확인할 수 있어요.';
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
  /** 선택지 설명 (options와 같은 index). 없으면 ''. */
  optionDetails: string[];
  /** 이미 저장된 choice의 라벨 (choice가 없으면 ''). */
  choiceLabel: string;
  /** holds 항목의 heldSeen (epoch 초/ms 또는 날짜 문자열) — 없으면 null. */
  heldSeen: string | number | null;
  /** 아무것도 안 고르면 추천대로 진행하기까지 기다리는 분 — 없으면 null. */
  waitMin: number | null;
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

const DEFAULT_HOLD_OPTION_DETAILS: readonly string[] = [
  '같은 방법으로 한 번 더 해봐요.',
  '범위를 좁혀서 다음 단계로 넘어가요.',
  '자동으로 하지 않고 제가 직접 확인해요.',
];

function defaultOptions(): { labels: string[]; ids: string[]; details: string[] } {
  return { labels: [...HOLD_OPTION_LABELS], ids: ['retry', 'narrow', 'skip'], details: [...DEFAULT_HOLD_OPTION_DETAILS] };
}

function optionsOf(raw: unknown): { labels: string[]; ids: string[]; details: string[] } {
  if (!Array.isArray(raw)) return defaultOptions();
  const parsed = raw
    .map(option => {
      if (typeof option === 'string') return { id: '', label: option.trim(), detail: '' };
      if (option && typeof option === 'object') {
        const record = option as Record<string, unknown>;
        return { id: cleanText(record.id), label: cleanText(record.label ?? record.title ?? record.name), detail: cleanText(record.detail ?? record.description) };
      }
      return { id: '', label: '', detail: '' };
    })
    .filter(option => option.label.length > 0);
  return parsed.length > 0
    ? { labels: parsed.map(option => option.label), ids: parsed.map(option => option.id), details: parsed.map(option => option.detail) }
    : defaultOptions();
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
 * QA 체인이 작업자 체인과 겹치는지(스스로 검수) 판별 — 첫 번째 QA AI가 첫 번째 작업자 AI와 같으면 true.
 * Control Room 검수하는 AI 바꾸기 editor와 단위 테스트가 공유하는 순수 함수.
 */
export function isSelfReviewChain(worker: unknown, qa: unknown): boolean {
  const firstOf = (value: unknown): string => {
    if (Array.isArray(value)) {
      const first = value[0];
      return typeof first === 'string' ? first.trim() : '';
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    return '';
  };
  const firstWorker = firstOf(worker);
  const firstQa = firstOf(qa);
  return firstWorker !== '' && firstWorker === firstQa;
}

/**
 * holds 항목 1개를 정규화한다. 문자열이면 reason만 있는 항목으로 취급.
 * choice가 'skip'이거나 내용이 완전히 비어 있으면 null.
 */
export function normalizeHoldEntry(entry: unknown): NormalizedHold | null {
  if (typeof entry === 'string') {
    const reason = entry.trim();
    if (!reason || isEmptyReasons(reason)) return null;
    return { taskId: '', reason, step: '', sentence: '', choice: '', options: [...HOLD_OPTION_LABELS], optionIds: ['retry', 'narrow', 'skip'], optionDetails: [...DEFAULT_HOLD_OPTION_DETAILS], choiceLabel: '', heldSeen: null, waitMin: null, recommendedIndex: -1 };
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
  const choiceIndex = choice ? recommendedIndexOf(choice, options, optionIds, false) : -1;
  const heldSeenRaw = record.heldSeen ?? record.held_seen;
  const waitRaw = Number(record.waitMin ?? record.wait_min);
  return {
    taskId,
    reason,
    step,
    sentence,
    choice,
    options,
    optionIds,
    optionDetails: parsedOptions.details,
    choiceLabel: choice ? options[choiceIndex] ?? choice : '',
    heldSeen: typeof heldSeenRaw === 'string' || typeof heldSeenRaw === 'number' ? heldSeenRaw : null,
    waitMin: Number.isFinite(waitRaw) && waitRaw > 0 ? waitRaw : null,
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

// ── 멈춘 작업 카드 helper (Control Room 쉬운 카드) ─────────────────────────

/** 카드 제목 — '보류/차단' 같은 말 없이 멈춘 작업 수만 알려준다. */
export function holdHeadingText(count: number): string {
  return `멈춘 작업 ${Math.max(0, Math.trunc(count) || 0)}개`;
}

export const HOLD_FLOW_STEPS: readonly string[] = ['PM', 'Worker', 'QA', 'Tester', '반영'];
export type HoldFlowState = 'done' | 'hold' | 'pending';

/** hold.step을 HOLD_FLOW_STEPS index로 푼다. 숫자는 Control Room FLOW(계획~반영 7칸) 기준. 모르면 -1. */
export function holdFlowIndex(step: unknown): number {
  const text = (typeof step === 'number' ? String(step) : cleanText(step)).toLowerCase();
  if (!text) return -1;
  if (/^\d+$/.test(text)) {
    const at = [0, 0, 1, 2, 3, 4, 4][Number(text)];
    return at ?? -1;
  }
  if (/사람|human|반영|apply|merge|deploy|ship/.test(text)) return 4;
  if (/시험|테스트|test/.test(text)) return 3;
  if (/qa|검수|검증|확인|review/.test(text)) return 2;
  if (/작업|구현|work|build|code/.test(text)) return 1;
  if (/pm|plan|계획|설계/.test(text)) return 0;
  return -1;
}

/** PM → Worker → QA → Tester → 반영 한 줄 흐름: hold 앞은 done, hold 단계는 hold, 뒤는 pending. 단계를 모르면 전부 pending. */
export function holdFlowStates(step: unknown): Array<{ name: string; state: HoldFlowState }> {
  const at = holdFlowIndex(step);
  return HOLD_FLOW_STEPS.map((name, index) => ({
    name,
    state: at < 0 ? 'pending' : index < at ? 'done' : index === at ? 'hold' : 'pending',
  }));
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return toEpochMs(numeric);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** '아무것도 안 고르면 HH:MM에 추천대로 진행해요' (로컬 시각). heldSeen/waitMin 중 하나라도 없으면 ''. */
export function holdAutoProceedText(heldSeen: unknown, waitMin: unknown): string {
  const start = toEpochMs(heldSeen);
  const wait = Number(waitMin);
  if (start === null || !Number.isFinite(wait) || wait <= 0) return '';
  const at = new Date(start + wait * 60_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `아무것도 안 고르면 ${pad(at.getHours())}:${pad(at.getMinutes())}에 추천대로 진행해요`;
}
