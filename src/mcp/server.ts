/**
 * MCP server layer (Phase E compliance) — uses official @modelcontextprotocol/sdk.
 *
 * Replaces the hand-rolled JSON-RPC dispatcher with the SDK's Server +
 * StdioServerTransport so any standard MCP client can discover and call tools
 * via tools/list and tools/call (JSON-RPC methods), not via custom method names.
 *
 * Architecture:
 *   - Process configuration (dataRoot, project, surface scope) is set once at
 *     startup and never accepted from tool arguments.
 *   - Raw update/delete operations are NOT exposed as tools; every write goes
 *     through a Relay Core explicit command with expected-state CAS.
 *   - Errors are normalized via McpError / mapCoreError.
 *   - PM and Worker surfaces have structurally separate tool sets — the server
 *     does not register all tools and filter at runtime.
 *
 * SDK note: The @modelcontextprotocol/sdk wildcard package-exports pattern
 * (`"./*": {"require":"./dist/cjs/*"}`) requires the `.js` extension on
 * subpath specifiers under Node.js v24+ (the bare path is not resolved).
 * We load via require() to bypass TypeScript's moduleResolution for those
 * subpaths; skipLibCheck: true suppresses declaration-file type errors.
 */

import type { McpErrorCode } from './errors.js';
import { McpError, mapCoreError } from './errors.js';

// ── SDK loader ─────────────────────────────────────────────────────────────────
// Use require() so we can reference the wildcard exports with `.js` extension
// without needing moduleResolution: node16 in the TypeScript config.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { Server: _SdkServer } = require('@modelcontextprotocol/sdk/server') as {
  Server: new (
    info: { name: string; version: string },
    opts: { capabilities: { tools?: Record<string, unknown> } },
  ) => _SdkServerInstance;
};

const { StdioServerTransport: _SdkStdioServerTransport } =
  require('@modelcontextprotocol/sdk/server/stdio.js') as {
    StdioServerTransport: new () => _SdkTransport;
  };

const { ListToolsRequestSchema, CallToolRequestSchema } =
  require('@modelcontextprotocol/sdk/types.js') as {
    ListToolsRequestSchema: unknown;
    CallToolRequestSchema: unknown;
  };
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

// Minimal SDK instance shapes — just enough for our usage.
interface _SdkTransport {
  onclose?: () => void;
}
interface _SdkServerInstance {
  setRequestHandler(schema: unknown, handler: (req: any) => any): void;
  connect(transport: _SdkTransport): Promise<void>;
  close(): Promise<void>;
}

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
  /** Optional process-bound runtime for the explicit AUTO Goal Loop tool. */
  goalLoop?: {
    workerId: string;
    workspaceRoot: string;
    transport?: 'internal' | 'actl';
    actlAgent?: string;
  };
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

// ── Server ─────────────────────────────────────────────────────────────────────

/**
 * Generic MCP server — surface-agnostic.
 *
 * Wraps the SDK's low-level Server, registering:
 *   - tools/list  → returns all registered tool descriptors
 *   - tools/call  → dispatches to the named tool's handler
 *
 * Callers inject exactly the tool set for their surface (PM or Worker).
 */
export class McpServer {
  private readonly tools = new Map<string, McpTool>();
  private readonly _sdk: _SdkServerInstance;

  constructor(tools: McpTool[]) {
    for (const t of tools) {
      this.tools.set(t.name, t);
    }

    this._sdk = new _SdkServer(
      { name: 'relay-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    // ── tools/list ────────────────────────────────────────────────────────────
    this._sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }));

    // ── tools/call ────────────────────────────────────────────────────────────
    this._sdk.setRequestHandler(
      CallToolRequestSchema,
      async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
        const toolName = req.params.name;
        const tool = this.tools.get(toolName);

        if (!tool) {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
        }

        const args =
          typeof req.params.arguments === 'object' && req.params.arguments !== null
            ? req.params.arguments
            : {};

        try {
          const result = await tool.handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        } catch (err) {
          const mapped = mapCoreError(err);
          return {
            content: [{ type: 'text', text: mapped.message }],
            isError: true,
          };
        }
      },
    );
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
   * Connect to stdio transport and serve until stdin closes.
   * The SDK handles the MCP initialize handshake automatically.
   */
  async serve(): Promise<void> {
    const transport = new _SdkStdioServerTransport();

    // Set onclose BEFORE connect() so the SDK wraps (not replaces) our handler.
    const closedPromise = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });

    await this._sdk.connect(transport);
    await closedPromise;
  }

  /** Graceful shutdown. */
  close(): void {
    this._sdk.close().catch(() => {
      // ignore shutdown errors
    });
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
