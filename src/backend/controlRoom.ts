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
  | 'gates:answer';
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
export const GATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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
    throw invalidInput(operation, `Invalid project id: ${String(project)}`);
  }
}

function assertGateId(operation: ControlRoomOperation, gateId: unknown): asserts gateId is string {
  if (!isValidGateId(gateId)) {
    throw invalidInput(operation, `Invalid gate id: ${String(gateId)}`);
  }
}

function assertOptionIndex(operation: ControlRoomOperation, optionIndex: unknown): asserts optionIndex is number {
  if (!isValidOptionIndex(optionIndex)) {
    throw invalidInput(operation, `Invalid option index: ${String(optionIndex)}`);
  }
}

function assertPayloadString(operation: ControlRoomOperation, name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidInput(operation, `Invalid ${name}: expected a non-empty string`);
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
    throw new ControlRoomError('EXEC_FAILED', operation, `Control Room ${operation} command failed`, cause);
  }

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, `Control Room ${operation} returned invalid JSON`, cause);
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
    throw new ControlRoomError('EXEC_FAILED', operation, `Control Room ${operation} command failed`, cause);
  }

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, `Control Room ${operation} returned invalid JSON`, cause);
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
