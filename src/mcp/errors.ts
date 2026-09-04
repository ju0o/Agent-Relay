/**
 * Normalized MCP error codes for the Relay MCP layer.
 * These are transport-level error categories; Relay Core exceptions are mapped
 * into them by mapCoreError. Core's own exception architecture is untouched.
 */
export type McpErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR';

export class McpError extends Error {
  readonly mcpCode: McpErrorCode;
  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.name = 'McpError';
    this.mcpCode = code;
  }
}

/** JSON-RPC numeric error code for a normalized MCP error code. */
export function jsonRpcCodeFor(code: McpErrorCode): number {
  switch (code) {
    case 'INVALID_ARGUMENT': return -32602;
    case 'NOT_FOUND': return -32001;
    case 'CONFLICT': return -32002;
    case 'FORBIDDEN': return -32003;
    case 'INVALID_STATE': return -32004;
    case 'INTERNAL_ERROR': return -32603;
  }
}

/**
 * Map a Relay Core (or unexpected) error into a normalized McpError.
 * Heuristic on message/name only — Core exceptions are NOT redesigned here.
 */
export function mapCoreError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);

  // Phase H permission / orphan typed errors
  if (name === 'PermissionDeniedError') {
    return new McpError('FORBIDDEN', msg);
  }
  if (name === 'OrphanResolutionError' || name === 'ObservationLockError' || name === 'ResultBridgeError' || name === 'PmDeliveryError' || name === 'VerificationContextError' || name === 'PmJudgmentError' || name === 'RetryPreparationError') {
    const hCode = (err as { code?: string } | null)?.code;
    switch (hCode) {
      case 'FORBIDDEN':
        return new McpError('FORBIDDEN', msg);
      case 'NOT_FOUND':
        return new McpError('NOT_FOUND', msg);
      case 'CONFLICT':
        return new McpError('CONFLICT', msg);
      case 'INVALID_STATE':
        return new McpError('INVALID_STATE', msg);
      case 'INVALID_ARGUMENT':
        return new McpError('INVALID_ARGUMENT', msg);
      default:
        return new McpError('INTERNAL_ERROR', msg);
    }
  }

  // Phase G Dispatcher / WorkerRegistry typed errors
  const code = (err as { code?: string } | null)?.code;
  if (name === 'DispatcherError' || name === 'WorkerRegistryError') {
    switch (code) {
      case 'NOT_FOUND':
        return new McpError('NOT_FOUND', msg);
      case 'CONFLICT':
        return new McpError('CONFLICT', msg);
      case 'INVALID_STATE':
        return new McpError('INVALID_STATE', msg);
      case 'INVALID_ARGUMENT':
        return new McpError('INVALID_ARGUMENT', msg);
      case 'ORPHAN_SUSPECTED':
        return new McpError('CONFLICT', msg);
      case 'WORKER_UNAVAILABLE':
        return new McpError('NOT_FOUND', msg);
      case 'LAUNCH_FAILED':
        return new McpError('INTERNAL_ERROR', msg);
      default:
        return new McpError('INTERNAL_ERROR', msg);
    }
  }

  if (name === 'RuntimeConflictError' || msg.includes('CONFLICT:')) {
    return new McpError('CONFLICT', msg);
  }
  if (
    msg.includes('찾을 수 없습니다')
    || msg.includes('ENOENT')
    || msg.includes('존재하지 않습니다')
  ) {
    return new McpError('NOT_FOUND', msg);
  }
  if (
    name === 'TypeError'
    || msg.includes('잘못된')
    || msg.includes('필수')
    || msg.includes('형식')
  ) {
    return new McpError('INVALID_ARGUMENT', msg);
  }
  if (msg.includes('가능합니다') || msg.includes('할 수 없습니다')) {
    return new McpError('INVALID_STATE', msg);
  }
  return new McpError('INTERNAL_ERROR', msg);
}
