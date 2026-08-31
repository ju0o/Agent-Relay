import { McpError } from './errors.js';

/**
 * Minimal MCP argument validation helpers.
 *
 * Tool arguments are the ONLY input channel; project/dataRoot/surface scope is
 * process configuration and is NEVER accepted through tool arguments.
 */

export function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || !v.trim()) {
    throw new McpError('INVALID_ARGUMENT', `필수 인자 누락 또는 형식 오류: ${name}`);
  }
  return v.trim();
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v.trim()) {
    throw new McpError('INVALID_ARGUMENT', `잘못된 인자 형식: ${name}`);
  }
  return v.trim();
}

export function requireEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const v = requireString(args, name);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new McpError('INVALID_ARGUMENT', `${name}는 [${allowed.join(', ')}] 중 하나여야 합니다: ${v}`);
  }
  return v as T;
}

export function rejectUnknownFields(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new McpError('INVALID_ARGUMENT', `허용되지 않은 인자: ${key}`);
    }
  }
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
