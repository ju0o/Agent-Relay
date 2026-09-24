/**
 * Shared type definitions for Agent Relay Log V0.
 * Used by the Electron backend (main process) and the React frontend.
 */

/** A row shown in the History list (displayed newest-first). */
export interface HistoryItem {
  agent: string;
  date: string;
  run: string;
  folder: string;
  hasPrompt: boolean;
  hasResult: boolean;
  tags: string[];
}

/** Full settings object persisted in settings.json. */
export interface AppSettings {
  dataRoot: string;
  customAgents: string[];
  /** Last project session opened — auto-restored on next launch ('' = none). */
  lastProject?: string;
  /**
   * 사용자가 지정한 프로젝트 표시 순서 (프로젝트 이름 배열).
   * UI 정렬 전용 — 실제 폴더 위치는 변경하지 않는다. 없는 이름은 무시됨.
   */
  projectOrder?: string[];
  /** 사용자가 지정한 에이전트 표시 순서 (에이전트 이름 배열). UI 정렬 전용. */
  agentOrder?: string[];
  /** Work Tab 표시 순서/개수 (에이전트 이름 배열). 편집 내용은 저장하지 않는다. */
  workTabOrder?: string[];
}

/** A selectable project (a folder under DATA_ROOT/Projects). */
export interface ProjectInfo {
  name: string;
  path: string;
}

/** settings:get response — includes the app base dir where settings live. */
export interface SettingsView extends AppSettings {
  baseDir: string;
  /** Backend path.join(baseDir, 'settings.json') — SSOT for the settings file path shown in 설정. */
  settingsFile: string;
  /** Default first-run location under the user's Documents folder. */
  defaultDataRoot: string;
  /** App version from package.json (surfaced for dogfooding context). */
  appVersion: string;
  /** Whether the persisted dataRoot currently exists on disk. */
  dataRootExists: boolean;
}

/** project:view response — projects list + full history for the selected project. */
export interface ProjectViewData {
  projects: ProjectInfo[];
  history: HistoryItem[];
}

/** A run folder payload returned to the UI. */
export interface RunFolderResult {
  folder: string;
  run: string;
}

/** Launch-time start view selected via `--view=<name>` (invalid/missing = control-room). */
export type StartView = 'home' | 'control-room' | 'approvals' | 'plan-studio';

/**
 * Launch-time start view for Automated Tester support (`--view=<name>`).
 *
 * Only 'home' | 'control-room' | 'approvals' | 'plan-studio' are accepted —
 * anything else (including a missing argument) resolves to 'control-room' and
 * never raises an error dialog. An explicit '--view=home' still returns 'home'.
 * The last '--view=' argument wins. Pure — unit-tested.
 */
const START_VIEW_PREFIX = '--view=';
export function parseStartView(argv: readonly string[]): StartView {
  let found: string | null = null;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(START_VIEW_PREFIX)) {
      found = arg.slice(START_VIEW_PREFIX.length).trim();
    }
  }
  if (found === 'control-room' || found === 'approvals' || found === 'plan-studio' || found === 'home') {
    return found;
  }
  return 'control-room';
}

/** app:startView response — which view the app should open on launch. */
export interface StartViewResult {
  view: StartView;
}

/**
 * Discriminated-union IPC request sent from the React UI to the Electron
 * backend (main process) via the single 'relay' channel.
 */
export type RelayRequest =
  | { op: 'settings:get' }
  | { op: 'settings:setDataRoot'; path: string }
  | { op: 'folder:pick' }
  | { op: 'projects:list'; dataRoot: string }
  | { op: 'projects:create'; dataRoot: string; name: string }
  | { op: 'project:view'; dataRoot: string; project: string }
  | { op: 'run:next'; dataRoot: string; project: string; date: string; agent: string }
  | { op: 'run:ensureFolder'; dataRoot: string; project: string; date: string; agent: string; run: string }
  | { op: 'run:read'; folder: string }
  | { op: 'run:delete'; folder: string }
  | { op: 'run:export'; folder: string }
  | { op: 'run:tagUpdate'; folder: string; tags: string[] }
  | { op: 'run:move'; fromFolder: string; dataRoot: string; project: string; toDate: string; toAgent: string }
  | { op: 'date:delete'; dataRoot: string; project: string; date: string }
  | { op: 'agent:delete'; dataRoot: string; project: string; date: string; agent: string }
  | { op: 'project:delete'; dataRoot: string; project: string }
  | { op: 'prompt:save'; folder: string; content: string; overwrite: boolean }
  | { op: 'result:save'; folder: string; content: string; overwrite: boolean }
 | { op: 'folder:open'; folder: string }
 | { op: 'agents:add'; name: string }
 | { op: 'settings:setLastProject'; project: string }
 | { op: 'file:reveal'; path: string }
 | { op: 'df:list'; dataRoot: string }
 | { op: 'df:create'; dataRoot: string; type: DfType; priority: DfPriority; feedback: string; desired: string; context: DfContext }
 | { op: 'df:setStatus'; dataRoot: string; id: string; status: DfStatus }
 | { op: 'df:read'; dataRoot: string; id: string }
 | { op: 'pdf:list'; dataRoot: string; project: string }
 | { op: 'pdf:create'; dataRoot: string; project: string; type: DfType; priority: DfPriority; feedback: string; desired: string; agent?: string; run?: string }
 | { op: 'pdf:setStatus'; dataRoot: string; project: string; id: string; status: DfStatus }
 | { op: 'pdf:read'; dataRoot: string; project: string; id: string }
 | { op: 'settings:setProjectOrder'; order: string[] }
 | { op: 'settings:setAgentOrder'; order: string[] }
 | { op: 'settings:setWorkTabOrder'; order: string[] }
 | { op: 'update:check' }
  | { op: 'update:download' }
 | { op: 'update:install' }
   | { op: 'controlRoom:board' }
  | { op: 'controlRoom:approvals' }
  | { op: 'planStudio:get'; project: string }
  | { op: 'planStudio:save'; project: string; draft: string }
  | { op: 'planStudio:chat'; project: string; message: string }
  | { op: 'planStudio:approve'; project: string }
  | { op: 'gates:list' }
  | { op: 'gates:answer'; gateId: string; optionIndex: number }
  | { op: 'controlRoom:laneSet'; project: string; role: string; runtimes: string[] }
  | { op: 'controlRoom:resume'; project: string }
  | { op: 'controlRoom:approvalAdd'; category: string; summary: string }
  | { op: 'app:startView' };

/** Standard successful response envelope. */
export type RelayResult<T = unknown> = { ok: true; value: T };

/** Standard failure response envelope (human-friendly message). */
export type RelayError = { ok: false; error: string };

export type RelayResponse<T = unknown> = RelayResult<T> | RelayError;

/**
 * Special project value meaning "use DATA_ROOT directly as the project root".
 * Directory structure: DATA_ROOT / [Date] / [Agent] / [NN] /
 */
export const ROOT_PROJECT = '.';

/** Default agent names shipped with the app. */
export const DEFAULT_AGENTS = [
  'Claude Code',
  'Codex',
  'OpenCode',
  'CommandCode',
  'Cline',
  'Kiro',
  'Devin',
  'Grok',
  'Other',
];

/** Preset tags for run labelling. */
export const TAG_PRESETS: { label: string; color: string }[] = [
  { label: '성공', color: '#30D158' },
  { label: '진행중', color: '#0066CC' },
  { label: '검토', color: '#FF9F0A' },
  { label: '실패', color: '#FF453A' },
  { label: '참고', color: '#8E8E93' },
];

// ── Dogfooding feedback ─────────────────────────────────────────────────────
//
// 두 종류가 있으며 절대 섞이지 않는다:
//   app     (DF-*.md under DATA_ROOT/.agent-relay/dogfooding/) — Agent Relay 앱 자체 개선 기록
//   project (DF-*.md under DATA_ROOT/{project}/_dogfooding/)  — 해당 프로젝트 사용성 피드백

/** Lifecycle state of a dogfooding feedback record. */
export type DfStatus = 'OPEN' | 'FIXED' | 'HOLD';

/** Feedback priority. */
export type DfPriority = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * Feedback category. App UI labels: UX=UX / 불편 등.
 * Project UI labels: UX=UX / Friction, IDEA=Idea 등.
 */
export type DfType = 'BUG' | 'UX' | 'IMPROVEMENT' | 'IDEA' | 'GOOD' | 'OTHER';

/** Which dogfooding stream a record belongs to. */
export type DfKind = 'app' | 'project';

/** Workspace context captured automatically when a feedback is created. */
export interface DfContext {
  project?: string;
  date?: string;
  agent?: string;
  run?: string;
}

/** A parsed dogfooding feedback record. */
export interface DfItem {
  id: string;            // "DF-0007"
  folder: string;        // full path of the .md file
  status: DfStatus;
  type: DfType;
  priority: DfPriority;
  created: string;       // YYYY-MM-DD
  version: string;       // app version at creation time
  feedback: string;
  desired: string;
  context: DfContext;
  /** Which stream this record belongs to. */
  kind: DfKind;
  /** project kind 전용 — 기록 대상 프로젝트 이름 (app kind는 undefined). */
  project?: string;
}

/** App Dogfooding 유형 라벨. */
export const DF_TYPE_LABELS: { value: DfType; label: string }[] = [
  { value: 'BUG', label: 'Bug' },
  { value: 'UX', label: 'UX / 불편' },
  { value: 'IMPROVEMENT', label: 'Improvement' },
  { value: 'GOOD', label: 'Good' },
  { value: 'OTHER', label: 'Other' },
];

/** Project Dogfooding 유형 라벨 (Bug / UX·Friction / Improvement / Idea / Good / Other). */
export const PROJECT_DF_TYPE_LABELS: { value: DfType; label: string }[] = [
  { value: 'BUG', label: 'Bug' },
  { value: 'UX', label: 'UX / Friction' },
  { value: 'IMPROVEMENT', label: 'Improvement' },
  { value: 'IDEA', label: 'Idea' },
  { value: 'GOOD', label: 'Good' },
  { value: 'OTHER', label: 'Other' },
];

/** markdown의 Type 토큰(enum 이름 또는 표시 라벨)을 enum으로 환원한다. */
export function dfTypeFromText(text: string): DfType | null {
  const raw = text.trim();
  const upper = raw.toUpperCase();
  const all: DfType[] = ['BUG', 'UX', 'IMPROVEMENT', 'IDEA', 'GOOD', 'OTHER'];
  if ((all as string[]).includes(upper)) return upper as DfType;
  for (const map of [DF_TYPE_LABELS, PROJECT_DF_TYPE_LABELS]) {
    const hit = map.find((m) => m.label.toUpperCase() === raw.toUpperCase());
    if (hit) return hit.value;
  }
  return null;
}

/** enum → 해당 스트림의 표시 라벨. */
export function dfTypeLabel(type: DfType, kind: DfKind): string {
  const map = kind === 'project' ? PROJECT_DF_TYPE_LABELS : DF_TYPE_LABELS;
  return map.find((m) => m.value === type)?.label ?? type;
}

export const DF_PRIORITIES: DfPriority[] = ['LOW', 'MEDIUM', 'HIGH'];
export const DF_STATUSES: DfStatus[] = ['OPEN', 'FIXED', 'HOLD'];

// ── In-app updater ──────────────────────────────────────────────────────────
//
// 업데이트는 사용자 통제 하에 진행된다 (v0.3 정책):
//   앱 시작 시 silent check 가능 → 새 버전 알림만, 자동 설치 없음.
//   다운로드/설치는 항상 사용자가 명시적으로 눌렀을 때만.

/** Updater lifecycle phase — pure state machine input/output (unit-testable). */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error';

/** One updater event, produced by electron-updater listeners in the main process. */
export type UpdateEvent =
  | { type: 'check-started'; manual: boolean }
  | { type: 'not-available' }
  | { type: 'available'; nextVersion: string }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; message: string; manual: boolean };

/** Snapshot the renderer polls/observes for the Settings → About UI. */
export interface UpdateStatus {
  phase: UpdatePhase;
  /** Current app version. */
  version: string;
  /** Version offered by the release feed (when phase = available/downloading/ready). */
  nextVersion?: string;
  percent?: number;
  errorMessage?: string;
}

/**
 * Pure updater state reducer — shared by main process wiring and tests.
 * Errors from background (non-manual) checks are swallowed into `idle`
 * so a private/unreachable repo never nags the user on launch.
 */
export function nextUpdateStatus(s: UpdateStatus, e: UpdateEvent): UpdateStatus {
  switch (e.type) {
    case 'check-started':
      return { ...s, phase: 'checking', errorMessage: undefined };
    case 'not-available':
      return { ...s, phase: 'none', nextVersion: undefined, percent: undefined };
    case 'available':
      return { ...s, phase: 'available', nextVersion: e.nextVersion, percent: undefined };
    case 'download-progress':
      return s.phase === 'downloading' || s.phase === 'available'
        ? { ...s, phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(e.percent))) }
        : s;
    case 'downloaded':
      return { ...s, phase: 'ready', percent: undefined };
    case 'error':
      return e.manual
        ? { ...s, phase: 'error', errorMessage: e.message }
        // background-check failure → 조용히 idle 복귀 (알림 없음)
        : { ...s, phase: 'idle' };
    default:
      return s;
  }
}

// ── Control Room board + approval learning (CR-08) ──────────────────────────
//
// board JSON now carries `models: { runtimeId: { runs, quota?, failed? } }`
// and approval rules carry `usedCount` / `lastUsedAt`.
// All new fields are optional — missing values render as 0 / '-'.

/** Per-runtime model quota usage carried by the board JSON. */
export interface ControlRoomModelUsage {
  runs: number;
  quota?: number;
  failed?: number;
}

/** Board JSON shape (lanes + optional per-runtime model usage). */
export interface ControlRoomBoardJson {
  lanes?: unknown[];
  models?: Record<string, ControlRoomModelUsage>;
}

/** An approval rule with optional auto-approval learning stats. */
export interface ApprovalRuleJson {
  category?: string;
  summary?: string;
  /** How often this rule auto-approved. Missing = 0. */
  usedCount?: number;
  /** Last auto-approval timestamp (any parseable date string). Missing = '-'. */
  lastUsedAt?: string;
  [key: string]: unknown;
}

/** One normalized per-runtime model usage row (missing fields → 0). */
export interface NormalizedModelUsage {
  runtimeId: string;
  runs: number;
  quota: number;
  failed: number;
}

/** Normalize a raw models map (missing/invalid fields → 0). Pure — unit-tested. */
export function normalizeModelUsage(models: unknown): NormalizedModelUsage[] {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
  return Object.entries(models as Record<string, unknown>).map(([runtimeId, raw]) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<ControlRoomModelUsage>;
    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return { runtimeId, runs: num(record.runs), quota: num(record.quota), failed: num(record.failed) };
  });
}

/**
 * True when a quota is actually hit/exhausted (quota set and runs reached it).
 * A missing/zero quota means "no limit" → never a hit. Pure — unit-tested.
 */
export function isModelQuotaHit(row: { runs: number; quota: number }): boolean {
  return row.quota > 0 && row.runs >= row.quota;
}

/** Missing/invalid usedCount renders as 0. Pure — unit-tested. */
export function approvalUsedCount(rule: ApprovalRuleJson): number {
  return typeof rule.usedCount === 'number' && Number.isFinite(rule.usedCount) && rule.usedCount >= 0
    ? Math.floor(rule.usedCount)
    : 0;
}

/** Missing/invalid lastUsedAt renders as '-'; otherwise YYYY-MM-DD. Pure — unit-tested. */
export function approvalLastUsed(rule: ApprovalRuleJson): string {
  if (typeof rule.lastUsedAt !== 'string' || !rule.lastUsedAt.trim()) return '-';
  const parsed = new Date(rule.lastUsedAt);
  if (Number.isNaN(parsed.getTime())) return '-';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** usedCount 0 → '아직 자동 적용된 적 없음', otherwise '자동 적용 N회 · 마지막 YYYY-MM-DD'. Pure — unit-tested. */
export function approvalStatsLine(rule: ApprovalRuleJson): string {
  const used = approvalUsedCount(rule);
  if (used === 0) return '아직 자동 적용된 적 없음';
  return `자동 적용 ${used}회 · 마지막 ${approvalLastUsed(rule)}`;
}

/**
 * Approval category → Korean group heading label. Pure — unit-tested.
 * Known keys map to fixed labels; anything else is '기타'.
 */
export function approvalCategoryLabel(category: string): string {
  switch (category) {
    case 'agents': return '에이전트 배치';
    case 'git': return 'Git·브랜치';
    case 'install': return '설치';
    case 'lanes': return '작업 흐름';
    case 'merge-push': return '병합·올리기';
    case 'permissions': return '권한';
    case 'physical-e2e': return '실물 E2E';
    case 'product-decision': return '제품 결정';
    case 'scope': return '범위';
    case 'visual-decision': return '화면 결정';
    case '기타': return '기타';
    default: return '기타';
  }
}

/**
 * Marker that flags a rule as superseded — "(바뀜)" in the display text
 * means a newer rule replaced it. Such rules fold into '지난 결정'.
 * Pure — unit-tested.
 */
export const SUPERSEDED_APPROVAL_MARKER = '(바뀜)';

/** True when the rule's display text carries the '(바뀜)' marker. Pure — unit-tested. */
export function isSupersededApprovalRule(rule: ApprovalRuleJson): boolean {
  if (!rule || typeof rule !== 'object') return false;
  const record = rule as Record<string, unknown>;
  const candidates = [rule.summary, record.title, record.ask, record.name];
  return candidates.some(
    (value) => typeof value === 'string' && value.includes(SUPERSEDED_APPROVAL_MARKER),
  );
}

/**
 * Split rules into active vs superseded (rules carrying '(바뀜)').
 * Order-preserving — superseded rules render folded under '지난 결정'.
 * Pure — unit-tested.
 */
export function partitionSupersededApprovalRules<T extends ApprovalRuleJson>(
  rules: readonly T[],
): { active: T[]; superseded: T[] } {
  const active: T[] = [];
  const superseded: T[] = [];
  for (const rule of rules) {
    (isSupersededApprovalRule(rule) ? superseded : active).push(rule);
  }
  return { active, superseded };
}

/**
 * Sort rules within a category by usedCount (desc, missing = 0).
 * Stable — ties keep their original relative order. Pure — unit-tested.
 */
export function sortRulesByUsage<T extends ApprovalRuleJson>(rules: readonly T[]): T[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => approvalUsedCount(b.rule) - approvalUsedCount(a.rule) || a.index - b.index)
    .map(entry => entry.rule);
}

/**
 * Remove duplicate rule entries, keeping the first occurrence.
 * Dedupes by object identity first, then by JSON content, so an envelope
 * `{ rules: [A, B] }` listed alongside the same A/B top-level entries only
 * renders once. Pure — unit-tested.
 */
export function dedupeApprovalRules<T extends ApprovalRuleJson>(rules: readonly T[]): T[] {
  const seenRef = new Set<unknown>();
  const seenContent = new Set<string>();
  const out: T[] = [];
  for (const rule of rules) {
    if (seenRef.has(rule)) continue;
    seenRef.add(rule);
    let key: string | null = null;
    try {
      key = JSON.stringify(rule) ?? null;
    } catch {
      key = null;
    }
    if (key !== null) {
      if (seenContent.has(key)) continue;
      seenContent.add(key);
    }
    out.push(rule);
  }
  return out;
}

/** Group rules by category (missing/blank → '기타'), each group sorted by usedCount. Pure — unit-tested. */
export function groupRulesByCategory<T extends ApprovalRuleJson>(
  rules: readonly T[],
): { category: string; rules: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const rule of rules) {
    const category =
      typeof rule.category === 'string' && rule.category.trim() ? rule.category.trim() : '기타';
    const list = groups.get(category);
    if (list) list.push(rule);
    else groups.set(category, [rule]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({ category, rules: sortRulesByUsage(list) }));
}

// ── Control Room lane attention (decision badges) ─────────────────────────
// Surface lanes that need the Founder. Pure — unit-tested.

/** Minimal lane shape needed for attention badges (extra fields ignored). */
export interface LaneAttentionInput {
  humanGate?: unknown;
  founderGate?: unknown;
  blocker?: unknown;
  holds?: unknown;
  [key: string]: unknown;
}

/** 'decision' = Founder/human gate open · 'hold' = blocked/held · null = clear. */
export type LaneAttention = 'decision' | 'hold' | null;

/**
 * Pure helper — 'decision' if lane.humanGate or lane.founderGate is truthy,
 * else 'hold' if lane.blocker is truthy or lane.holds is a non-empty array,
 * else null.
 */
export function laneAttention(lane: LaneAttentionInput | null | undefined): LaneAttention {
  if (!lane || typeof lane !== 'object') return null;
  if (lane.humanGate || lane.founderGate) return 'decision';
  if (lane.blocker) return 'hold';
  if (Array.isArray(lane.holds) && lane.holds.length > 0) return 'hold';
  return null;
}

// ── Drag reorder helpers ────────────────────────────────────────────────────

/** Return a new array with the element at `from` moved to index `to`. */
export function reorderArray<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = [...arr];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved!);
  return out;
}

/**
 * Sort items by a saved order list of keys. Known keys keep their saved
 * relative order first; unknown/new items are appended in their natural order.
 * Used for projectOrder / agentOrder — UI display only.
 */
export function applyOrderByKeys<T>(items: readonly T[], keyOf: (x: T) => string, order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
  const known: T[] = [];
  const unknown: T[] = [];
  for (const item of items) (rank.has(keyOf(item)) ? known : unknown).push(item);
  known.sort((a, b) => rank.get(keyOf(a))! - rank.get(keyOf(b))!);
  return [...known, ...unknown];
}

// ── Plan Studio founder view ordering ───────────────────────────────────────
// Founder view shows tasks in progress or queued first, then HOLD, then
// finished (finished rows collapse behind a '끝난 작업 N개 보기' toggle).
// Pure — unit-tested.

/** Minimal task shape needed for founder-view ordering (extra fields ignored). */
export interface PlanStudioOrderTask {
  stage?: number | string;
  blocker?: unknown;
}

/** Founder-view group rank: 'active' (진행중/대기) → 'hold' → 'done' (끝남). */
export type PlanStudioTaskGroup = 'active' | 'hold' | 'done';

/** True when a normalized stage value is explicitly negated (UNDONE/NOT_DONE/INCOMPLETE/NOT_COMPLETE). */
export function isNegatedPlanStudioDoneValue(value: string): boolean {
  const stripped = value.replace(/[\s_\-]+/g, '');
  return stripped.includes('UNDONE')
    || stripped.includes('NOTDONE')
    || stripped.includes('INCOMPLETE')
    || stripped.includes('NOTCOMPLETE')
    || stripped.includes('NONDONE')
    || stripped.includes('NONCOMPLETE')
    || stripped.includes('UNCOMPLETE')
    || stripped.includes('NOTINTEGRATED')
    || stripped.includes('NOTVERIFIED');
}

/** True when the stage string/number means finished (반영/DONE/COMPLETE/통합/INTEGRATED/VERIFIED_DONE). */
export function isPlanStudioTaskDone(task: PlanStudioOrderTask | null | undefined): boolean {
  if (!task || typeof task !== 'object') return false;
  const stage = (task as PlanStudioOrderTask).stage;
  if (typeof stage === 'number') return Number.isFinite(stage) && stage >= 6;
  const value = String(stage ?? '').toUpperCase();
  if (!value) return false;
  if (isNegatedPlanStudioDoneValue(value)) return false;
  return value.includes('INTEGR')
    || value.includes('통합')
    || value.includes('반영')
    || value.includes('DONE')
    || value.includes('COMPLETE')
    || value === 'V1_COMPLETE'
    || value === 'INTEGRATED'
    || value === 'VERIFIED_DONE';
}

/** True when the task is held/blocked (and not finished — done wins). */
export function isPlanStudioTaskHold(task: PlanStudioOrderTask | null | undefined): boolean {
  if (!task || typeof task !== 'object') return false;
  if (isPlanStudioTaskDone(task)) return false;
  const blocker = (task as PlanStudioOrderTask).blocker;
  if (typeof blocker === 'string' ? blocker.trim() : Boolean(blocker)) return true;
  const stage = (task as PlanStudioOrderTask).stage;
  if (typeof stage === 'string') {
    const value = stage.toUpperCase();
    if (value.includes('HOLD') || value.includes('BLOCK') || value.includes('보류')) return true;
  }
  return false;
}

/** Group a task for founder-view ordering. Pure. */
export function planStudioTaskGroup(task: PlanStudioOrderTask | null | undefined): PlanStudioTaskGroup {
  if (isPlanStudioTaskDone(task)) return 'done';
  if (isPlanStudioTaskHold(task)) return 'hold';
  return 'active';
}

/**
 * Sort tasks for the founder view: active (in progress or queued) first,
 * then HOLD, then finished. Stable — ties keep their original relative order.
 * Pure — unit-tested.
 */
export function sortPlanStudioTasks<T extends PlanStudioOrderTask>(tasks: readonly T[]): T[] {
  const rank = (task: T): number => {
    const group = planStudioTaskGroup(task);
    return group === 'active' ? 0 : group === 'hold' ? 1 : 2;
  };
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => rank(a.task) - rank(b.task) || a.index - b.index)
    .map(entry => entry.task);
}
