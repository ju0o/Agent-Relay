/**
 * MCP transport/server layer (Phase E).
 *
 * Implements a minimal Model Context Protocol server over stdio (JSON-RPC 2.0).
 * Tools are registered at startup — the PM tool set or Worker tool set is composed
 * by the server entry and injected; the transport layer is surface-agnostic.
 *
 * Architecture:
 *   - Process configuration (dataRoot, project, surface scope) is set once at
 *     startup and never accepted from tool arguments.
 *   - Raw update/delete operations are NOT exposed as tools; every write goes
 *     through a Relay Core explicit command with expected-state CAS.
 *   - Errors are normalized via McpError / mapCoreError.
 *   - PM and Worker surfaces have structurally separate tool sets — the server
 *     does not register all tools and filter at runtime.
 */

import type { McpErrorCode } from './errors.js';
import { McpError, jsonRpcCodeFor, mapCoreError } from './errors.js';

// ── Types ──────────────────────────────────────────────────────────────────────

/** A registered MCP tool. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** Process-scoped context injected into PM tool factories. */
export interface PmServerContext {
  dataRoot: string;
  project: string;
}

/**
 * Process-scoped context for the Worker surface.
 * All fields are fixed at process startup; workers cannot override them via tool args.
 */
export interface WorkerServerContext {
  dataRoot: string;
  project: string;
  /** Bound Task ID — worker can only access this task. */
  taskId: string;
  /** Bound Run ID — worker can only access this run. */
  runId: string;
  /** Optional caller metadata (informational, not authorization). */
  clientId?: string;
  agentId?: string;
  sessionId?: string;
}

/** One JSON-RPC 2.0 request from stdin. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: number | string | null;
}

/** One JSON-RPC 2.0 success response. */
interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

/** One JSON-RPC 2.0 error response. */
interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ── Server ─────────────────────────────────────────────────────────────────────

/**
 * Generic MCP server — surface-agnostic stdio JSON-RPC dispatcher.
 * Callers inject exactly the tool set for their surface (PM or Worker).
 */
export class McpServer {
  private readonly tools = new Map<string, McpTool>();
  private closed = false;

  constructor(tools: McpTool[]) {
    for (const t of tools) {
      this.tools.set(t.name, t);
    }
  }

  /** Register an additional tool after construction (used in tests). */
  registerTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Names of all registered tools. */
  toolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Start listening on stdin (one-shot JSON-RPC request-response loop).
   * Reads one JSON object per line (MCP stdio framing).
   * Runs until stdin closes.
   */
  async serve(): Promise<void> {
    const stdin = process.stdin;
    stdin.setEncoding('utf8');

    let buffer = '';

    for await (const chunk of stdin) {
      if (this.closed) break;
      buffer += chunk;

      const lines = buffer.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const response = await this.dispatchLine(line);
        if (response !== null) {
          this.writeResponse(response);
        }
      }
      buffer = lines[lines.length - 1];
    }
  }

  /** Graceful shutdown. */
  close(): void {
    this.closed = true;
  }

  // ── internal ───────────────────────────────────────────────────────────

  private async dispatchLine(line: string): Promise<JsonRpcResponse | null> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return this.errorResponse(null, -32700, 'Parse error: invalid JSON');
    }

    if (req.jsonrpc !== '2.0') {
      return this.errorResponse(req.id ?? null, -32600, 'Invalid Request: jsonrpc must be 2.0');
    }

    if (typeof req.method !== 'string' || !req.method) {
      return this.errorResponse(req.id ?? null, -32600, 'Invalid Request: method required');
    }

    return this.handleMethod(req);
  }

  private async handleMethod(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    // Built-in methods
    if (req.method === 'ping') {
      return this.successResponse(id, 'pong');
    }

    // Protocol discovery — both surface-specific names and generic are accepted
    if (
      req.method === 'relay_pm_list_tools' ||
      req.method === 'relay_worker_list_tools' ||
      req.method === 'relay/list_tools'
    ) {
      const list = Array.from(this.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return this.successResponse(id, list);
    }

    // Dispatch to registered tool
    if (!this.tools.has(req.method)) {
      return this.errorResponse(id, -32601, `Method not found: ${req.method}`);
    }

    const tool = this.tools.get(req.method)!;
    const params =
      typeof req.params === 'object' && req.params !== null && !Array.isArray(req.params)
        ? (req.params as Record<string, unknown>)
        : {};

    try {
      const result = await tool.handler(params);
      return this.successResponse(id, result);
    } catch (err) {
      const mapped = mapCoreError(err);
      return this.errorResponse(id, jsonRpcCodeFor(mapped.mcpCode), mapped.message);
    }
  }

  private successResponse(id: number | string | null, result: unknown): JsonRpcSuccess {
    return { jsonrpc: '2.0', id, result };
  }

  private errorResponse(id: number | string | null, code: number, message: string): JsonRpcError {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private writeResponse(res: JsonRpcResponse): void {
    if (this.closed) return;
    try {
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch {
      // stdout closed — ignore
    }
  }
}

/** @deprecated Use McpServer. Kept for compatibility. */
export class PmServer extends McpServer {
  constructor(
    _ctx: PmServerContext,
    tools: McpTool[],
  ) {
    super(tools);
  }
}

// Re-export McpErrorCode for convenience
export type { McpErrorCode };
