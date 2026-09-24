import { execFile as nodeExecFile, ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const NIGHT_SCRIPT = '~/.agents/skills/auto-night-orchestrator/scripts/night';
const SSH_BASE_ARGS: readonly string[] = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'asus', NIGHT_SCRIPT];
const EXEC_TIMEOUT = 10_000;
const MAX_OPTION_INDEX = 9999;

export type ControlRoomOperation =
  | 'board'
  | 'approvals'
  | 'planStudio:get'
  | 'planStudio:save'
  | 'planStudio:chat'
  | 'planStudio:approve'
  | 'gates:list'
  | 'gates:answer'
  | 'controlRoom:laneSet'
  | 'controlRoom:resume'
  | 'controlRoom:holdChoose'
  | 'controlRoom:approvalAdd';
export type PlanStudioAction = 'get' | 'save' | 'chat' | 'approve';
export type GateAction = 'list' | 'answer';
export type ControlRoomErrorCode = 'EXEC_FAILED' | 'INVALID_JSON' | 'INVALID_INPUT';
export type ControlRoomExecOptions = ExecFileOptions & { input?: string | Uint8Array };
export type ControlRoomExec = (
  file: string,
  args: readonly string[],
  options: ControlRoomExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
export const TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]{1,40}$/;
export const HOLD_OPTIONS = ['retry', 'narrow', 'skip'] as const;
export type HoldOption = (typeof HOLD_OPTIONS)[number];
export const GATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const APPROVAL_CATEGORY_PATTERN = /^[a-z-]{2,30}$/;
export const MAX_APPROVAL_SUMMARY_LENGTH = 200;
export const LANE_ROLES = ['worker', 'qa'] as const;
export type LaneRole = (typeof LANE_ROLES)[number];
export const NIGHT_RUNTIMES = [
  'codex',
  'opencode',
  'cline',
  'grok',
  'cursor',
  'claude',
  'claude-team',
  'claude-pro',
] as const;
export type NightRuntime = (typeof NIGHT_RUNTIMES)[number];

/** 보류 선택지 라벨이 '직접 확인'(자동 재개 없음)인지 판별. 구 라벨 'Founder에게 확인' 포함. Pure. */
export function isHoldSelfReviewOption(optionLabel: unknown): boolean {
  if (typeof optionLabel !== 'string') return false;
  const text = optionLabel.trim();
  if (!text) return false;
  if (text === '내가 직접 볼게요' || text === 'Founder에게 확인') return true;
  return text.includes('직접');
}

/**
 * 보류 선택지 버튼이 눌렸을 때 호출할 백엔드 동작을 정한다. Pure — 단위 테스트 대상.
 * - 'none': '내가 직접 볼게요' — 자동 호출 없이 원문/증거를 직접 확인한다.
 * - 'gate': gate가 열려 있으면 `gates:answer`(optionIndex 전달).
 * - 'resume': gate가 없으면 `controlRoom:resume`(project 전달).
 */
export function holdOptionAction(
  optionLabel: unknown,
  hasGate: boolean,
): 'gate' | 'resume' | 'none' {
  if (isHoldSelfReviewOption(optionLabel)) return 'none';
  return hasGate ? 'gate' : 'resume';
}

export function isValidProjectId(project: unknown): project is string {
  return typeof project === 'string' && PROJECT_ID_PATTERN.test(project);
}

export function isValidGateId(gateId: unknown): gateId is string {
  return typeof gateId === 'string' && GATE_ID_PATTERN.test(gateId);
}

export function isValidOptionIndex(optionIndex: unknown): optionIndex is number {
  return (
    typeof optionIndex === 'number' &&
    Number.isInteger(optionIndex) &&
    optionIndex >= 0 &&
    optionIndex <= MAX_OPTION_INDEX
  );
}

/**
 * POSIX single-quote one remote argument. ssh joins remote arguments into a
 * remote shell command line, so every variable remote argument goes through
 * this single helper: wrap in ' and escape embedded ' as '\''.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isValidLaneRole(role: unknown): role is LaneRole {
  return typeof role === 'string' && (LANE_ROLES as readonly string[]).includes(role);
}

export function isValidRuntimes(runtimes: unknown): runtimes is string[] {
  if (!Array.isArray(runtimes) || runtimes.length < 1 || runtimes.length > 4) return false;
  const allowed = new Set<string>(NIGHT_RUNTIMES as readonly string[]);
  const seen = new Set<string>();
  for (const runtime of runtimes) {
    if (typeof runtime !== 'string' || !allowed.has(runtime) || seen.has(runtime)) return false;
    seen.add(runtime);
  }
  return true;
}

export function isValidApprovalCategory(category: unknown): category is string {
  return typeof category === 'string' && APPROVAL_CATEGORY_PATTERN.test(category);
}

export function isValidApprovalSummary(summary: unknown): summary is string {
  return (
    typeof summary === 'string' && summary.length >= 1 && summary.length <= MAX_APPROVAL_SUMMARY_LENGTH
  );
}

export class ControlRoomError extends Error {
  constructor(
    readonly code: ControlRoomErrorCode,
    readonly operation: ControlRoomOperation,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ControlRoomError';
  }
}

function invalidInput(operation: ControlRoomOperation, message: string): ControlRoomError {
  return new ControlRoomError('INVALID_INPUT', operation, message);
}

function assertProjectId(operation: ControlRoomOperation, project: unknown): asserts project is string {
  if (!isValidProjectId(project)) {
    throw invalidInput(operation, '프로젝트 ID가 올바르지 않습니다.');
  }
}

function assertTaskId(operation: ControlRoomOperation, taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw invalidInput(operation, '작업 ID가 올바르지 않습니다.');
  }
}

function assertGateId(operation: ControlRoomOperation, gateId: unknown): asserts gateId is string {
  if (!isValidGateId(gateId)) {
    throw invalidInput(operation, '게이트 ID가 올바르지 않습니다.');
  }
}

function assertOptionIndex(operation: ControlRoomOperation, optionIndex: unknown): asserts optionIndex is number {
  if (!isValidOptionIndex(optionIndex)) {
    throw invalidInput(operation, '선택 번호가 올바르지 않습니다.');
  }
}

function assertHoldOption(operation: ControlRoomOperation, option: unknown): asserts option is HoldOption {
  if (typeof option !== 'string' || !(HOLD_OPTIONS as readonly string[]).includes(option)) {
    throw invalidInput(operation, '보류 선택지가 올바르지 않습니다.');
  }
}

function assertPayloadString(operation: ControlRoomOperation, name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(operation, '입력값이 올바르지 않습니다.');
  }
}

function assertLaneRole(operation: ControlRoomOperation, role: unknown): asserts role is LaneRole {
  if (!isValidLaneRole(role)) {
    throw invalidInput(operation, '역할이 올바르지 않습니다.');
  }
}

function assertRuntimes(operation: ControlRoomOperation, runtimes: unknown): asserts runtimes is string[] {
  if (!isValidRuntimes(runtimes)) {
    throw invalidInput(operation, '실행 환경이 올바르지 않습니다.');
  }
}

function assertApprovalCategory(operation: ControlRoomOperation, category: unknown): asserts category is string {
  if (!isValidApprovalCategory(category)) {
    throw invalidInput(operation, '승인 분류가 올바르지 않습니다.');
  }
}

function assertApprovalSummary(operation: ControlRoomOperation, summary: unknown): asserts summary is string {
  if (!isValidApprovalSummary(summary)) {
    throw invalidInput(operation, '요약을 입력해 주세요.');
  }
}

async function runSshJson(
  operation: ControlRoomOperation,
  args: string[],
  execFileImpl: ControlRoomExec,
  options?: ControlRoomExecOptions,
): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileImpl('ssh', args, { shell: false, timeout: EXEC_TIMEOUT, ...options }));
  } catch (cause) {
    throw new ControlRoomError('EXEC_FAILED', operation, '작업 PC(ASUS)에 연결할 수 없습니다. 꺼져 있거나 네트워크가 끊겼을 수 있어요. 켜지면 자동으로 다시 불러옵니다.', cause);
  }

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, '작업 PC의 응답을 읽지 못했습니다. 잠시 후 자동으로 다시 시도합니다.', cause);
  }
}

export async function runControlRoom(
  operation: 'board' | 'approvals',
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const args = [...SSH_BASE_ARGS];
  args.push(...(operation === 'board' ? ['board', '--json'] : ['approvals', 'list', '--json']));

  let stdout: string;
  try {
    ({ stdout } = await execFileImpl('ssh', args, { shell: false, timeout: EXEC_TIMEOUT }));
  } catch (cause) {
    throw new ControlRoomError('EXEC_FAILED', operation, '작업 PC(ASUS)에 연결할 수 없습니다. 꺼져 있거나 네트워크가 끊겼을 수 있어요. 켜지면 자동으로 다시 불러옵니다.', cause);
  }

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, '작업 PC의 응답을 읽지 못했습니다. 잠시 후 자동으로 다시 시도합니다.', cause);
  }
}

export async function runPlanStudioGet(
  project: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'planStudio:get';
  assertProjectId(operation, project);
  return runSshJson(operation, [...SSH_BASE_ARGS, 'roadmap', 'get', project, '--json'], execFileImpl);
}

export async function runPlanStudioSave(
  project: string,
  draft: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'planStudio:save';
  assertProjectId(operation, project);
  assertPayloadString(operation, 'draft', draft);
  return runSshJson(
    operation,
    [...SSH_BASE_ARGS, 'roadmap', 'save', project, '--json'],
    execFileImpl,
    { input: draft },
  );
}

export async function runPlanStudioChat(
  project: string,
  message: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'planStudio:chat';
  assertProjectId(operation, project);
  assertPayloadString(operation, 'message', message);
  return runSshJson(
    operation,
    [...SSH_BASE_ARGS, 'roadmap', 'chat', project, '--json'],
    execFileImpl,
    { input: message },
  );
}

export async function runPlanStudioApprove(
  project: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'planStudio:approve';
  assertProjectId(operation, project);
  return runSshJson(operation, [...SSH_BASE_ARGS, 'roadmap', 'approve', project, '--json'], execFileImpl);
}

export async function runGatesList(execFileImpl: ControlRoomExec = execFile): Promise<unknown> {
  const operation: ControlRoomOperation = 'gates:list';
  return runSshJson(operation, [...SSH_BASE_ARGS, 'gate', 'list', '--json'], execFileImpl);
}

export async function runGateAnswer(
  gateId: string,
  optionIndex: number,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'gates:answer';
  assertGateId(operation, gateId);
  assertOptionIndex(operation, optionIndex);
  return runSshJson(
    operation,
    [...SSH_BASE_ARGS, 'gate', 'answer', gateId, String(optionIndex), '--json'],
    execFileImpl,
  );
}

export async function runControlRoomLaneSet(
  project: string,
  role: string,
  runtimes: string[],
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'controlRoom:laneSet';
  assertProjectId(operation, project);
  assertLaneRole(operation, role);
  assertRuntimes(operation, runtimes);
  return runSshJson(
    operation,
    [
      ...SSH_BASE_ARGS,
      'lane',
      'set',
      shQuote(project),
      shQuote(role),
      shQuote(runtimes.join(',')),
      '--json',
    ],
    execFileImpl,
  );
}

export async function runControlRoomResume(
  project: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'controlRoom:resume';
  assertProjectId(operation, project);
  return runSshJson(
    operation,
    [...SSH_BASE_ARGS, 'roadmap', 'resume', shQuote(project), '--json'],
    execFileImpl,
  );
}

export async function runControlRoomHoldChoose(
  taskId: string,
  option: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'controlRoom:holdChoose';
  assertTaskId(operation, taskId);
  assertHoldOption(operation, option);
  return runSshJson(operation, [...SSH_BASE_ARGS, 'hold', 'choose', shQuote(taskId), option, '--json'], execFileImpl);
}

export async function runControlRoomApprovalAdd(
  category: string,
  summary: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const operation: ControlRoomOperation = 'controlRoom:approvalAdd';
  assertApprovalCategory(operation, category);
  assertApprovalSummary(operation, summary);
  return runSshJson(
    operation,
    [...SSH_BASE_ARGS, 'approvals', 'add', shQuote(category), shQuote(summary), '--source', 'app'],
    execFileImpl,
  );
}

// ── Control Room "오늘 끝난 일 / 지금 일하는 AI" (R5/R6) ───────────────────
// Pure helpers — 단위 테스트 대상. board JSON 모양이 바뀌어도 깨지지 않게
// todayDone 계열 키를 넓게 읽고, 현재 작업은 한국어 title 우선·ID는 원문용으로 분리한다.

export interface TodayDoneItem {
  lane: string;
  taskId: string;
  title: string;
}

const TODAY_DONE_KEYS = ['todayDone', 'today_done', 'doneToday', 'done_today', 'completedToday', 'completed_today', 'done', 'today'] as const;

const CURRENT_TITLE_KEYS = ['title', 'taskTitle', 'task_title', 'name', 'label', 'subject', 'summary'] as const;

const CURRENT_ID_KEYS = ['taskId', 'task_id', 'id', 'key'] as const;

const CURRENT_START_KEYS = ['startedAt', 'started_at', 'startAt', 'start_at', 'beginAt', 'begin_at', 'since'] as const;

export const CONTROL_ROOM_FLOW = ['계획', '확인', '작업', '검수', '시험', '사람 확인', '반영'] as const;

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function laneIdOf(lane: unknown, fallback = ''): string {
  if (!lane || typeof lane !== 'object') return fallback;
  const record = lane as Record<string, unknown>;
  return cleanString(record.project ?? record.id ?? record.lane) || fallback;
}

function normalizeTodayEntry(entry: unknown, laneFallback: string): TodayDoneItem | null {
  if (typeof entry === 'string') {
    const text = entry.trim();
    if (!text) return null;
    return { lane: laneFallback, taskId: text, title: text };
  }
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const lane = cleanString(record.lane ?? record.project) || laneFallback;
  const taskId = cleanString(record.taskId ?? record.task_id ?? record.id ?? record.key);
  const title = cleanString(record.title ?? record.taskTitle ?? record.name ?? record.label ?? record.summary) || taskId;
  if (!taskId && !title) return null;
  return { lane, taskId, title };
}

/** board.todayDone(계열) 또는 각 lane의 todayDone(계열) 배열을 모아 정규화한다. Pure. */
export function normalizeTodayDone(board: unknown): TodayDoneItem[] {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return [];
  const root = board as Record<string, unknown>;
  const out: TodayDoneItem[] = [];
  for (const key of TODAY_DONE_KEYS) {
    const list = root[key];
    if (Array.isArray(list)) {
      for (const entry of list) {
        const fallback = entry && typeof entry === 'object'
          ? cleanString((entry as Record<string, unknown>).lane ?? (entry as Record<string, unknown>).project)
          : '';
        const item = normalizeTodayEntry(entry, fallback);
        if (item) out.push(item);
      }
      if (out.length > 0) return out;
    }
  }
  const lanes = root.lanes;
  if (!Array.isArray(lanes)) return out;
  for (const lane of lanes) {
    if (!lane || typeof lane !== 'object') continue;
    const record = lane as Record<string, unknown>;
    const laneId = laneIdOf(lane);
    for (const key of TODAY_DONE_KEYS) {
      const list = record[key];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const item = normalizeTodayEntry(entry, laneId);
        if (item) out.push({ ...item, lane: item.lane || laneId });
      }
    }
  }
  return out;
}

/** current 객체에서 한국어 title 후보를 우선 반환, 없으면 taskId로 폴백. Pure. */
export function currentTaskTitle(current: unknown): string {
  if (typeof current === 'string') return current.trim();
  if (!current || typeof current !== 'object') return '';
  const record = current as Record<string, unknown>;
  for (const key of CURRENT_TITLE_KEYS) {
    const text = cleanString(record[key]);
    if (text) return text;
  }
  for (const key of CURRENT_ID_KEYS) {
    const text = cleanString(record[key]);
    if (text) return text;
  }
  return '';
}

/** current 객체의 작업 ID (원문 보기용). Pure. */
export function currentTaskId(current: unknown): string {
  if (typeof current === 'string') return current.trim();
  if (!current || typeof current !== 'object') return '';
  const record = current as Record<string, unknown>;
  for (const key of CURRENT_ID_KEYS) {
    const text = cleanString(record[key]);
    if (text) return text;
  }
  return '';
}

/** 현재 작업이 있으면 true (title 또는 ID 중 하나라도 비어 있지 않음). Pure. */
export function hasCurrentWork(lane: unknown): boolean {
  if (!lane || typeof lane !== 'object') return false;
  const current = (lane as Record<string, unknown>).current;
  return currentTaskTitle(current) !== '' || currentTaskId(current) !== '';
}

function parseStartMs(startedAt: unknown): number | null {
  if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
    return startedAt < 1e12 ? startedAt * 1000 : startedAt;
  }
  if (typeof startedAt === 'string' && startedAt.trim()) {
    const parsed = Date.parse(startedAt.trim());
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function startOfCurrent(current: unknown): unknown {
  if (!current || typeof current !== 'object') return undefined;
  const record = current as Record<string, unknown>;
  for (const key of CURRENT_START_KEYS) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (cleanString(value) !== '') return value;
  }
  return undefined;
}

/** 시작 시각 → 한국어 경과 ("방금 시작" / "N분째" / "N시간째" / "N시간 M분째" / "N일째"). Pure. */
export function elapsedKorean(startedAt: unknown, nowMs: number = Date.now()): string {
  const start = parseStartMs(startedAt);
  if (start === null || !Number.isFinite(nowMs)) return '';
  const diff = Math.max(0, nowMs - start);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '방금 시작';
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}시간째` : `${hours}시간 ${rest}분째`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}일째` : `${days}일 ${restHours}시간째`;
}

/** stage 값 → 한국어 단계 라벨 (숫자는 FLOW, 문자열은 그대로). Pure. */
export function laneStageLabel(stage: unknown): string {
  if (typeof stage === 'number' && Number.isFinite(stage)) {
    const index = Math.max(0, Math.min(CONTROL_ROOM_FLOW.length - 1, Math.floor(stage)));
    return CONTROL_ROOM_FLOW[index] as string;
  }
  const text = cleanString(stage);
  return text || CONTROL_ROOM_FLOW[0] as string;
}

function firstChainName(value: unknown): string {
  if (typeof value === 'string') {
    const parts = value.split(/[,|\s>→]+/).map(part => part.trim()).filter(part => part.length > 0);
    return parts[0] ?? '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) return item.trim();
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const chain = record.chain ?? record.runtimes ?? record.order;
    if (Array.isArray(chain)) return firstChainName(chain);
    for (const key of ['name', 'id', 'runtime', 'worker', 'owner']) {
      const text = cleanString(record[key]);
      if (text) return text;
    }
  }
  return '';
}

/** lane의 담당 AI 이름 (workerChain → current.worker 순). Pure. */
export function laneWorkerName(lane: unknown): string {
  if (!lane || typeof lane !== 'object') return '';
  const record = lane as Record<string, unknown>;
  const current = (record.current ?? {}) as Record<string, unknown>;
  return firstChainName(record.workerChain ?? current.worker ?? record.worker) || cleanString(current.worker);
}

/** 일하는 lane 1개의 "레인 · 단계 · 경과 · AI" 조각, 쉬는 lane은 null. Pure. */
export function whoSegmentForLane(lane: unknown, nowMs: number = Date.now()): string | null {
  if (!hasCurrentWork(lane)) return null;
  const record = lane as Record<string, unknown>;
  const current = (record.current ?? {}) as Record<string, unknown>;
  const laneName = laneIdOf(lane, '알 수 없는 레인');
  const stage = laneStageLabel(current.stage);
  const elapsed = elapsedKorean(startOfCurrent(current), nowMs) || '경과 확인 중';
  const worker = laneWorkerName(lane);
  return worker ? `${laneName} · ${stage} · ${elapsed} · ${worker}` : `${laneName} · ${stage} · ${elapsed}`;
}

/** 관제실 맨 위 한 줄: 일하는 AI가 있으면 "지금 일하는 AI: …", 없으면 "…쉬는 중". Pure. */
export function workingSummary(lanes: unknown, nowMs: number = Date.now()): string {
  if (!Array.isArray(lanes)) return '지금 일하는 AI: 쉬는 중';
  const segments: string[] = [];
  for (const lane of lanes) {
    const segment = whoSegmentForLane(lane, nowMs);
    if (segment) segments.push(segment);
  }
  if (segments.length === 0) return '지금 일하는 AI: 쉬는 중';
  return `지금 일하는 AI: ${segments.join(' / ')}`;
}

// Aliases for relay wiring flexibility.
export const runLaneSet = runControlRoomLaneSet;
export const runRoadmapResume = runControlRoomResume;
export const runApprovalAdd = runControlRoomApprovalAdd;
