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
 | { op: 'pdf:read'; dataRoot: string; project: string; id: string }
 | { op: 'settings:setProjectOrder'; order: string[] }
 | { op: 'settings:setAgentOrder'; order: string[] }
 | { op: 'adapters:list' }
 | { op: 'capture:arm'; captureId?: string; folder?: string; adapterId?: string; isDraft?: boolean; materializeParams?: MaterializeParams }
 | { op: 'capture:disarm'; captureId?: string; folder?: string }
 | { op: 'capture:select'; sessionId: string; captureId?: string; folder?: string }
 | { op: 'capture:updateDraftParams'; captureId: string; materializeParams: MaterializeParams }
 | { op: 'run:materialize'; captureId?: string; dataRoot: string; project: string; date: string; agent: string }
 | { op: 'goal:create'; dataRoot: string; project: string; title: string; goalStatement: string; description?: string; tags?: string[]; completionCriteria?: string[]; permissionPolicy?: PermissionPolicy; status?: GoalStatus }
 | { op: 'goal:get'; dataRoot: string; project: string; goalId: string }
 | { op: 'goal:list'; dataRoot: string; project: string }
 | { op: 'goal:update'; dataRoot: string; project: string; goalId: string; patch: GoalUpdatePatch }
 | { op: 'goal:progress'; dataRoot: string; project: string; goalId: string }
 | { op: 'goal:getRuntimeState'; dataRoot: string; project: string; goalId: string }
 | { op: 'goal:evaluateCompletion'; dataRoot: string; project: string; goalId: string }
 | { op: 'goal:transition'; dataRoot: string; project: string; goalId: string; to: GoalStatus; reason?: string }
 | { op: 'goal:complete'; dataRoot: string; project: string; goalId: string; reason?: string }
 | { op: 'task:create'; dataRoot: string; project: string; goalId: string; title: string; goal: string; reason: string; scope: string; completionCriteria?: string[]; dependencies?: string[]; executionState?: TaskExecutionState; pmState?: TaskPmState }
 | { op: 'task:get'; dataRoot: string; project: string; taskId: string }
 | { op: 'task:list'; dataRoot: string; project: string; goalId?: string }
 | { op: 'task:update'; dataRoot: string; project: string; taskId: string; patch: TaskUpdatePatch }
 | { op: 'task:linkRun'; dataRoot: string; project: string; taskId: string; runFolder: string }
 | { op: 'task:unlinkRun'; dataRoot: string; project: string; taskId: string; runFolder: string }
 | { op: 'task:getReadiness'; dataRoot: string; project: string; taskId: string }
 | { op: 'task:refreshReadiness'; dataRoot: string; project: string; taskId: string }
 | { op: 'task:transitionExecution'; dataRoot: string; project: string; taskId: string; expectedExecutionState: TaskExecutionState; to: TaskExecutionState; reason?: string }
 | { op: 'task:transitionPm'; dataRoot: string; project: string; taskId: string; expectedPmState: TaskPmState; to: TaskPmState; reason?: string; acceptedRunId?: string }
 | { op: 'task:markResultReceived'; dataRoot: string; project: string; taskId: string; runId: string; expectedExecutionState?: TaskExecutionState }
 | { op: 'task:acceptResult'; dataRoot: string; project: string; taskId: string; runId: string; reason?: string; expectedPmState?: TaskPmState; expectedExecutionState?: TaskExecutionState }
 | { op: 'task:requestChanges'; dataRoot: string; project: string; taskId: string; reason?: string; expectedPmState?: TaskPmState }
 | { op: 'task:requestRetry'; dataRoot: string; project: string; taskId: string; reason?: string; expectedExecutionState?: TaskExecutionState; expectedPmState?: TaskPmState }
 | { op: 'update:check' }
 | { op: 'update:download' }
 | { op: 'update:install' };

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

// ── Goal / Task data kernel (Phase B1) ───────────────────────────────────────
//
// Logical hierarchy: Project → Goal → Task → Run.
// Physical Run storage (YYYY-MM-DD/Agent/NN) is unchanged; Goals/Tasks live under
// Project/_relay/{goals,tasks}/ as Markdown + JSON SSOT. Progress is derived.

/** Goal lifecycle — explicit; B1 does not auto-complete Goals. */
export const GOAL_STATUSES = [
  'PLANNING',
  'ACTIVE',
  'WAITING_OWNER',
  'BLOCKED',
  'COMPLETED',
  'ABANDONED',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * Task execution lifecycle (worker/agent axis).
 * Distinct from PM verification — RESPONSE_COMPLETE must not imply ACCEPTED.
 */
export const TASK_EXECUTION_STATES = [
  'PLANNED',
  'READY',
  'DISPATCHED',
  'RUNNING',
  'RESULT_RECEIVED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
] as const;
export type TaskExecutionState = (typeof TASK_EXECUTION_STATES)[number];

/** Task PM verification axis (owner/GPT review). */
export const TASK_PM_STATES = [
  'PENDING',
  'VERIFYING',
  'CHANGES_REQUESTED',
  'ACCEPTED',
] as const;
export type TaskPmState = (typeof TASK_PM_STATES)[number];

/**
 * Legacy single-axis TaskStatus from schemaVersion=1 (e7e63fe).
 * Not persisted on schemaVersion=2; used only for read-migration / derived views.
 */
export const LEGACY_TASK_STATUSES = [
  'PLANNED',
  'READY',
  'DISPATCHED',
  'WORKING',
  'RESULT_RECEIVED',
  'VERIFYING',
  'CHANGES_REQUESTED',
  'BLOCKED',
  'ACCEPTED',
  'DONE',
  'ABANDONED',
] as const;
export type LegacyTaskStatus = (typeof LEGACY_TASK_STATUSES)[number];

/** Permission modes — structure only; runtime enforcement is deferred. */
export const PERMISSION_MODES = ['PLAN', 'APPROVE', 'BYPASS'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export interface PermissionOverrides {
  dispatch?: boolean;
  redispatch?: boolean;
  createTask?: boolean;
  runTests?: boolean;
  mergeMain?: boolean;
  release?: boolean;
  destructiveAction?: boolean;
  productionDeploy?: boolean;
  secretChange?: boolean;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  overrides?: PermissionOverrides;
}

/** Current Goal/Task JSON schema. v1 Task files are read-migrated to v2. */
export const GOAL_TASK_SCHEMA_VERSION = 2;

/** Persistent Goal record (JSON SSOT companion to goal.md). */
export interface GoalRecord {
  schemaVersion: number;
  goalId: string;
  project: string;
  title: string;
  goalStatement: string;
  status: GoalStatus;
  completionCriteria: string[];
  permissionPolicy: PermissionPolicy;
  createdAt: string;
  updatedAt: string;
  description?: string;
  tags?: string[];
}

/**
 * Linked Run reference on a Task.
 * runId is authoritative logical identity; folder is a physical locator/cache.
 */
export interface LinkedRunRef {
  runId: string;
  folder: string;
  taskRunSequence: number;
  agent?: string;
  date?: string;
}

/** Persistent Task record (JSON SSOT companion to task.md). */
export interface TaskRecord {
  schemaVersion: number;
  taskId: string;
  goalId: string;
  project: string;
  title: string;
  goal: string;
  reason: string;
  scope: string;
  completionCriteria: string[];
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  /** Optional winner/verified Run among linkedRuns — does not delete other attempts. */
  acceptedRunId?: string;
  dependencies: string[];
  linkedRuns: LinkedRunRef[];
  /**
   * Monotonic next sequence to allocate — starts at 1, only increases.
   * Legacy v2 files without this field derive max(linkedRuns.taskRunSequence)+1.
   * Unlink never decrements; failed link does not consume.
   */
  nextTaskRunSequence: number;
  createdAt: string;
  updatedAt: string;
  /** Explicit runtime blocker reason (executionState=BLOCKED). Cleared on unblock. */
  blockedReason?: string;
  /** ISO timestamp when explicit BLOCKED was set. Cleared on unblock. */
  blockedAt?: string;
  /** Optional last transition / PM reason (audit hint; not an event log). */
  lastTransitionReason?: string;
  /** Number of explicit requestRetry cycles completed (optional metadata). */
  retryCount?: number;
}

/**
 * Map legacy v1 TaskStatus → split axes.
 * DONE/ACCEPTED → pmState ACCEPTED; WORKING → RUNNING; ABANDONED → CANCELLED.
 */
export function mapLegacyTaskStatus(status: LegacyTaskStatus): {
  executionState: TaskExecutionState;
  pmState: TaskPmState;
} {
  switch (status) {
    case 'PLANNED':
      return { executionState: 'PLANNED', pmState: 'PENDING' };
    case 'READY':
      return { executionState: 'READY', pmState: 'PENDING' };
    case 'DISPATCHED':
      return { executionState: 'DISPATCHED', pmState: 'PENDING' };
    case 'WORKING':
      return { executionState: 'RUNNING', pmState: 'PENDING' };
    case 'RESULT_RECEIVED':
      return { executionState: 'RESULT_RECEIVED', pmState: 'PENDING' };
    case 'VERIFYING':
      return { executionState: 'RESULT_RECEIVED', pmState: 'VERIFYING' };
    case 'CHANGES_REQUESTED':
      return { executionState: 'RESULT_RECEIVED', pmState: 'CHANGES_REQUESTED' };
    case 'BLOCKED':
      return { executionState: 'BLOCKED', pmState: 'PENDING' };
    case 'ACCEPTED':
    case 'DONE':
      return { executionState: 'RESULT_RECEIVED', pmState: 'ACCEPTED' };
    case 'ABANDONED':
      return { executionState: 'CANCELLED', pmState: 'PENDING' };
    default:
      return { executionState: 'PLANNED', pmState: 'PENDING' };
  }
}

/**
 * Derived compatibility label only — never persisted as authoritative status.
 * RESPONSE_COMPLETE / RESULT_RECEIVED must not appear as ACCEPTED.
 */
export function deriveCompatTaskStatus(t: Pick<TaskRecord, 'executionState' | 'pmState'>): string {
  if (t.pmState === 'ACCEPTED') return 'ACCEPTED';
  if (t.pmState === 'VERIFYING') return 'VERIFYING';
  if (t.pmState === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  if (t.executionState === 'RUNNING') return 'WORKING';
  if (t.executionState === 'CANCELLED') return 'ABANDONED';
  return t.executionState;
}

/** Derived Goal progress — never authoritative on disk. */
export interface GoalProgress {
  goalId: string;
  totalTasks: number;
  doneTasks: number;
  activeTasks: number;
  blockedTasks: number;
  /** doneTasks / totalTasks, or 0 when no tasks. */
  weightedProgress: number;
}

/**
 * Narrative Goal patch. Status changes must use goal:transition / goal:complete.
 * Passing `status` here is rejected by the runtime layer.
 */
export type GoalUpdatePatch = Partial<
  Pick<
    GoalRecord,
    'title' | 'goalStatement' | 'completionCriteria' | 'permissionPolicy' | 'description' | 'tags'
  >
> & {
  /**
   * @deprecated B2 — use goal:transition / goal:complete. Rejected if present.
   */
  status?: GoalStatus;
};

/**
 * Privileged/legacy narrative Task patch.
 *
 * NOT the normal B2 runtime mutation path. Runtime axes
 * (executionState / pmState / acceptedRunId) are rejected here — use
 * transitionExecution / transitionPm / acceptResult / requestChanges /
 * requestRetry / markResultReceived instead.
 * Future MCP/Event Runtime must not use raw task:update for state.
 */
export type TaskUpdatePatch = Partial<
  Pick<
    TaskRecord,
    | 'title'
    | 'goal'
    | 'reason'
    | 'scope'
    | 'completionCriteria'
    | 'dependencies'
  >
> & {
  /** @deprecated Privileged/legacy — rejected. Use task:transitionExecution. */
  executionState?: TaskExecutionState;
  /** @deprecated Privileged/legacy — rejected. Use task:transitionPm / acceptResult / requestChanges. */
  pmState?: TaskPmState;
  /** @deprecated Privileged/legacy — rejected. Use task:acceptResult. */
  acceptedRunId?: string;
  /** @deprecated Privileged/legacy — rejected. Use task:transitionPm reopen. */
  clearAcceptedRunId?: boolean;
};

// ── Phase B2 runtime snapshots (derived / command results) ──────────────────

/** Derived readiness class — distinct from persisted executionState=BLOCKED. */
export const TASK_READINESS_KINDS = [
  'READY',
  'WAITING_DEPENDENCIES',
  'BLOCKED',
  'TERMINAL',
  'IN_PROGRESS',
  'PLANNED',
] as const;
export type TaskReadinessKind = (typeof TASK_READINESS_KINDS)[number];

export interface TaskReadiness {
  taskId: string;
  kind: TaskReadinessKind;
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  dependencies: string[];
  unsatisfiedDependencies: string[];
  /** Dependency taskIds that FAILED / BLOCKED / CANCELLED (hard blockers). */
  blockedBy: string[];
  /** True when all dependencies have pmState=ACCEPTED (or none). */
  dependenciesSatisfied: boolean;
  /**
   * Derived: dependencies satisfied and Task could be promoted to READY
   * (PLANNED, not terminal/accepted/explicit BLOCKED). Not the same as
   * persisted executionState=READY (which is an explicit declaration).
   */
  isEligibleForReady: boolean;
  /** Eligible for parallel dispatch consideration (persisted READY + deps satisfied + not accepted). */
  parallelizable: boolean;
}

export interface GoalCompletionEvaluation {
  eligible: boolean;
  reasons: string[];
  totalTasks: number;
  acceptedTasks: number;
  incompleteTasks: string[];
  blockedTasks: string[];
  abandonedTasks: string[];
  /** Present when Goal has completionCriteria text — B2 cannot objectively verify. */
  completionCriteriaPresent: boolean;
  completionCriteriaCount: number;
}

export interface TaskRuntimeSummary {
  taskId: string;
  title: string;
  executionState: TaskExecutionState;
  pmState: TaskPmState;
  dependencies: string[];
  unsatisfiedDependencies: string[];
  blockedBy: string[];
  linkedRunsCount: number;
  acceptedRunId?: string;
  latestRun?: LinkedRunRef;
  readiness: TaskReadinessKind;
  isEligibleForReady: boolean;
  parallelizable: boolean;
  blockedReason?: string;
}

export interface GoalRuntimeState {
  goal: GoalRecord;
  progress: GoalProgress;
  completionEligibility: GoalCompletionEvaluation;
  tasks: TaskRuntimeSummary[];
  readyTasks: TaskRuntimeSummary[];
  workingTasks: TaskRuntimeSummary[];
  resultReceivedTasks: TaskRuntimeSummary[];
  verifyingTasks: TaskRuntimeSummary[];
  changesRequestedTasks: TaskRuntimeSummary[];
  blockedTasks: TaskRuntimeSummary[];
  waitingDependencyTasks: TaskRuntimeSummary[];
  acceptedTasks: TaskRuntimeSummary[];
}

// ── Agent adapter auto-capture (vNext foundation) ───────────────────────────
//
// 어댑터가 에이전트 응답 완료를 관찰하면 main이 이 상태를 렌더러로 방송한다.
// RESPONSE_COMPLETE는 제품 과제(Task) 성공을 의미하지 않는다 — "에이전트가
// 응답 생성을 끝냈다"는 사실만 전달한다.

export type CapturePhase = 'watching' | 'ambiguous' | 'captured' | 'error' | 'stopped';

/** Parameters for on-demand physical Run folder creation (Phase A2). */
export interface MaterializeParams {
  dataRoot: string;
  project: string;
  date: string;
  agent: string;
}

/**
 * Agent-neutral Session-bound capture state (Session-Bound Capture UX, packet 03).
 *
 * This is the SAME canonical lifecycle the backend binding policy owns — the
 * frontend renders it verbatim and never invents its own interpretation. The
 * visible Session identity ALWAYS comes from the same backend binding state
 * that writes evidence/adapter.json; there is no frontend-only sessionId.
 *
 * Mapping to the product-visible state flow (Agent → bind → wait → result):
 *   watching + no boundSessionId  → UNBOUND / BINDING (세션 연결 대기 중)
 *   watching + boundSessionId     → BOUND / WAITING_RESPONSE (연결됨 · 응답 대기 중)
 *   ambiguous                     → AMBIGUOUS (세션 선택 필요)
 *   captured                      → RESULT_RECEIVED (Result 수신 완료, binding 유지)
 *   error                         → ERROR
 *   stopped                       → disarmed (연결 해제)
 */
export interface CaptureStatusView {
  /** Canonical capture lifecycle phase (owned by CaptureManager/binding policy). */
  phase: CapturePhase;
  /** Phase A2: stable Draft/Run capture identity. */
  captureId?: string;
  /** Phase A2: run number (e.g. "04"), set when materialization is known. */
  run?: string;
  /** Run folder the watch is bound to. */
  folder?: string;
  /** Adapter id this Run is listening to, e.g. 'opencode' / 'claude-code'. */
  adapterId?: string;
  /** Human-facing agent name, e.g. 'OpenCode' / 'Claude Code'. */
  agentName?: string;
  /** captured — files written inside the run folder. */
  files?: string[];
  message?: string;
  /**
   * The ONE session allowed to supply this Run's result (once bound).
   * Provenance-identical to evidence/adapter.json → completion.sessionId.
   */
  boundSessionId?: string;
  /** Optional bound-session title from the adapter (evidence title), display-only. */
  boundSessionTitle?: string;
  /** How the bound session was selected (manual / unique-new / unique-inflight). */
  bindingReason?: string;
  /** ambiguous — selectable source sessions for explicit binding. */
  candidates?: CaptureCandidateView[];
}

/** One selectable Agent session shown in the minimal ambiguity picker. */
export interface CaptureCandidateView {
  sessionId: string;
  title?: string;
  directory?: string;
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
