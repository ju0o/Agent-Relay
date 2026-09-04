/**
 * V1-G6-MCP — Agent Relay MCP App server (Streamable HTTP).
 *
 * Serves the PM MCP surface over Streamable HTTP for ChatGPT MCP Apps:
 *   - tools/list        → PM read/write tools + wake tools + relay_pm_open_widget
 *   - tools/call        → existing canonical PM tool handlers (structured + text)
 *   - resources/list    → the Agent Relay PM widget resource (ui://agent-relay/pm-widget)
 *   - resources/read    → serves the widget HTML (text/html;profile=mcp-app)
 *
 * The widget is a wake adapter ONLY: no business logic moves into it. All
 * reads/writes go through the existing canonical kernels (pm-delivery,
 * pm-verification-context, pm-judgment, retry-preparation, retry-dispatch).
 *
 * Transport: SDK StreamableHTTPServerTransport, stateless single-session
 * pattern (fresh Server + transport per request), identical to the
 * live-proven spike.
 */

import * as http from 'node:http';
import type { PmServerContext } from './server.js';
import { buildPmReadTools, buildPmWriteTools } from './pm-tools.js';
import { buildPmWakeTools } from './app/pm-wake-tools.js';
import {
  PM_WIDGET_MIME_TYPE,
  PM_WIDGET_RESOURCE_NAME,
  PM_WIDGET_RESOURCE_URI,
  pmWidgetHtml,
} from './app/pm-widget-resource.js';
import { mapCoreError } from './errors.js';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { Server: SdkServer } = require('@modelcontextprotocol/sdk/server') as {
  Server: new (info: { name: string; version: string }, opts: { capabilities: Record<string, unknown> }) => SdkServerInstance;
};
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as {
  StreamableHTTPServerTransport: new (opts: { sessionIdGenerator?: unknown }) => SdkTransportInstance;
};
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js') as {
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
  ListResourcesRequestSchema: unknown;
  ReadResourceRequestSchema: unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

interface SdkServerInstance {
  setRequestHandler(schema: unknown, handler: (req: any) => any): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}
interface SdkTransportInstance {
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
}

/** App tool descriptor: canonical McpTool + optional MCP Apps UI metadata. */
export interface AppTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpAppServerOptions {
  dataRoot: string;
  project: string;
  port: number;
  /** Display name shown to the MCP Apps host. */
  serverName?: string;
}

export function buildAppTools(ctx: PmServerContext): AppTool[] {
  const tools: AppTool[] = [
    ...buildPmReadTools(ctx),
    ...buildPmWriteTools(ctx),
    ...buildPmWakeTools(ctx),
  ];
  // Widget-opener tool: linking a tool to the UI resource is how the MCP Apps
  // host renders the widget in a conversation.
  tools.push({
    name: 'relay_pm_open_widget',
    description:
      'Open the Agent Relay PM widget. The widget monitors pending PM Deliveries and wakes GPT PM ' +
      'with a bounded AGENT_RELAY_PM_WAKE instruction when a result is ready for review. ' +
      'Pure read; the widget then uses the standard Agent Relay PM tools.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    _meta: { ui: { resourceUri: PM_WIDGET_RESOURCE_URI } },
    handler: async () => ({ ok: true, widget: PM_WIDGET_RESOURCE_URI }),
  });
  return tools;
}

function newAppServer(tools: AppTool[]): SdkServerInstance {
  const sdk = new SdkServer(
    { name: 'agent-relay-mcp-app', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t._meta ? { _meta: t._meta } : {}),
    })),
  }));

  sdk.setRequestHandler(
    CallToolRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const tool = tools.find((t) => t.name === req.params.name);
      if (!tool) {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        };
      }
      const args = typeof req.params.arguments === 'object' && req.params.arguments !== null
        ? req.params.arguments
        : {};
      try {
        const result = await tool.handler(args);
        const isObject = result !== null && typeof result === 'object' && !Array.isArray(result);
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(isObject ? { structuredContent: result } : {}),
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

  sdk.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: PM_WIDGET_RESOURCE_URI,
        name: PM_WIDGET_RESOURCE_NAME,
        description: 'Agent Relay PM wake widget: monitors pending PM Deliveries and wakes GPT PM.',
        mimeType: PM_WIDGET_MIME_TYPE,
      },
    ],
  }));

  sdk.setRequestHandler(
    ReadResourceRequestSchema,
    async (req: { params: { uri?: string } }) => {
      const uri = req.params.uri;
      if (uri !== PM_WIDGET_RESOURCE_URI) {
        throw new Error(`Unknown resource: ${uri}`);
      }
      return {
        contents: [
          {
            uri: PM_WIDGET_RESOURCE_URI,
            mimeType: PM_WIDGET_MIME_TYPE,
            text: pmWidgetHtml(),
          },
        ],
      };
    },
  );

  return sdk;
}

export async function startMcpAppServer(opts: McpAppServerOptions): Promise<http.Server> {
  const ctx: PmServerContext = { dataRoot: opts.dataRoot, project: opts.project };
  const tools = buildAppTools(ctx);

  const app = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'agent-relay-mcp-app' }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      res.writeHead(404); res.end('not found'); return;
    }
    const sdk = newAppServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await sdk.connect(transport);
      // The Hono-backed transport reads the request body itself; pass
      // undefined (plain node http has no req.body), matching the spike.
      await transport.handleRequest(req, res, undefined);
      res.on('close', () => {
        void transport.close();
        void sdk.close();
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32603, message: 'Internal server error' } }));
      }
    }
  });

  await new Promise<void>((resolve) => app.listen(opts.port, resolve));
  return app;
}