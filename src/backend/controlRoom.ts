import { execFile as nodeExecFile, ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const NIGHT_SCRIPT = '~/.agents/skills/auto-night-orchestrator/scripts/night';

export type ControlRoomOperation = 'board' | 'approvals';
export type ControlRoomErrorCode = 'EXEC_FAILED' | 'INVALID_JSON';
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

export async function runControlRoom(
  operation: ControlRoomOperation,
  execFileImpl: ControlRoomExec = execFile,
): Promise<unknown> {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'asus', NIGHT_SCRIPT];
  args.push(operation === 'board' ? 'board' : 'approvals', '--json');

  let stdout: string;
  try {
    ({ stdout } = await execFileImpl('ssh', args, { shell: false, timeout: 10_000 }));
  } catch (cause) {
    throw new ControlRoomError('EXEC_FAILED', operation, `Control Room ${operation} command failed`, cause);
  }

  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new ControlRoomError('INVALID_JSON', operation, `Control Room ${operation} returned invalid JSON`, cause);
  }
}
