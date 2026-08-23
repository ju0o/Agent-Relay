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
}

/** A selectable project (a folder under DATA_ROOT/Projects). */
export interface ProjectInfo {
  name: string;
  path: string;
}

/** settings:get response — includes the app base dir where settings live. */
export interface SettingsView extends AppSettings {
  baseDir: string;
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
 | { op: 'pdf:read'; dataRoot: string; project: string; id: string };

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
