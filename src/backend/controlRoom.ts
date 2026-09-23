import { execFile as nodeExecFile, ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const NIGHT_SCRIPT = '~/.agents/skills/auto-night-orchestrator/scripts/night';

export type ControlRoomOperation = 'board' | 'approvals' | 'approvalEdit' | 'approvalRemove';
export type ControlRoomErrorCode = 'EXEC_FAILED' | 'INVALID_JSON' | 'INVALID_ID';
export type ControlRoomExec = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

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

/** Founder approval rule id — validated before any ssh spawn. */
export const APPROVAL_RULE_ID_PATTERN = /^A-\d{2,3}$/;

function baseSshArgs(): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'asus', NIGHT_SCRIPT];
}

async function runSsh(
  subArgs: readonly string[],
  operation: ControlRoomOperation,
  execFileImpl: ControlRoomExec,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileImpl('ssh', [...baseSshArgs(), ...subArgs], { shell: false, timeout: 10_000 }));
  } catch (cause) {
    throw new ControlRoomError('EXEC_FAILED', operation, `Control Room ${operation} command failed`, cause);
  }
  return stdout;
}
export async function runControlRoom(
  operation: 'board' | 'approvals',
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const subArgs = operation === 'board' ? ['board', '--json'] : ['approvals', 'list', '--json'];
  const stdout = await runSsh(subArgs, operation, execFileImpl);

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, `Control Room ${operation} returned invalid JSON`, cause);
  }
}

function assertApprovalRuleId(id: string, operation: ControlRoomOperation): void {
  if (!APPROVAL_RULE_ID_PATTERN.test(id)) {
    throw new ControlRoomError('INVALID_ID', operation, `Invalid approval rule id: ${id}`);
  }
}

/** Run `night approvals edit <id> "<summary>"` over the same ssh path. */
export async function editApprovalRule(
  id: string,
  summary: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<string> {
  assertApprovalRuleId(id, 'approvalEdit');
  if (!summary || !summary.trim()) {
    throw new ControlRoomError('INVALID_ID', 'approvalEdit', 'Approval summary is empty');
  }
  const stdout = await runSsh(['approvals', 'edit', id, summary], 'approvalEdit', execFileImpl);
  return stdout.trim();
}

/** Run `night approvals remove <id>` over the same ssh path. */
export async function removeApprovalRule(
  id: string,
  execFileImpl: ControlRoomExec = execFile,
): Promise<string> {
  assertApprovalRuleId(id, 'approvalRemove');
  const stdout = await runSsh(['approvals', 'remove', id], 'approvalRemove', execFileImpl);
  return stdout.trim();
}
