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
