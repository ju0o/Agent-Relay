#!/usr/bin/env node
/*
 * C1 Normal Chat promotion-boundary diagnostic server.
 *
 * This is intentionally separate from the production MCP App. It never reads
 * or writes Agent Relay data, never dispatches a Worker, and the sole write
 * probe is process-local memory. It exists only to vary the MCP catalog while
 * holding the UI resource and optional ui/message control constant.
 *
 * Usage:
 *   node scripts/c1-normal-chat-boundary-server.mjs --variant c1-a --port 3901
 */
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const VARIANTS = new Set(['c1-a', 'c1-b', 'c1-c', 'c1-d', 'c1-e']);
const WIDGET_URI = 'ui://agent-relay-diagnostic/c1-boundary-widget';
const WIDGET_MIME = 'text/html;profile=mcp-app';
let diagnosticWriteCount = 0;

function args(argv) {
  let variant = '';
  let port = 0;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--variant') variant = argv[++i] ?? '';
    if (argv[i] === '--port') port = Number(argv[++i]);
  }
  if (!VARIANTS.has(variant)) throw new Error(`--variant must be one of ${[...VARIANTS].join(', ')}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a valid TCP port');
  return { variant, port };
}

const emptySchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
const deliverySchema = {
  type: 'object',
  properties: { deliveryId: { type: 'string', minLength: 1 } },
  required: ['deliveryId'],
  additionalProperties: false,
};
const judgmentSchema = {
  type: 'object',
  properties: {
    deliveryId: { type: 'string', minLength: 1 },
    decision: { type: 'string', enum: ['ACCEPT', 'CHANGES'] },
  },
  required: ['deliveryId', 'decision'],
  additionalProperties: false,
};

function tool(name, description, inputSchema, handler, meta) {
  return { name, description, inputSchema, handler, ...(meta ? { _meta: meta } : {}) };
}

function buildTools(variant) {
  const tools = [
    tool(
      'relay_pm_open_widget',
      'C1 diagnostic opener. Opens the isolated Agent Relay promotion-boundary widget. No Relay data or Task is accessed.',
      emptySchema,
      async () => ({ ok: true, diagnostic: 'C1', variant, resourceUri: WIDGET_URI }),
      { ui: { resourceUri: WIDGET_URI } },
    ),
  ];
  if (variant === 'c1-a') return tools;

  if (variant === 'c1-b') {
    tools.push(tool(
      'relay_diag_read_status',
      'Harmless read-only diagnostic status. Returns static process information only; it never reads Agent Relay data.',
      emptySchema,
      async () => ({ ok: true, readOnly: true, variant, diagnostic: 'C1' }),
    ));
    return tools;
  }

  // C1-C replaces C1-B's generic status read with the two PM reads that a
  // minimum review surface needs. C1-D then changes only write capability.
  tools.push(tool(
    'relay_pm_list_pending_work',
    'Diagnostic PM read surface. Returns an intentionally empty list and never reads or changes Relay state.',
    emptySchema,
    async () => ({ deliveries: [], diagnostic: true, variant }),
  ));
  tools.push(tool(
    'relay_pm_get_verification_context',
    'Diagnostic PM read surface. Accepts a delivery identity and returns a bounded synthetic context; it never reads Relay state.',
    deliverySchema,
    async ({ deliveryId }) => ({ deliveryId, diagnostic: true, resultText: 'C1_DIAGNOSTIC_NO_WORKER_RESULT', allowedActions: [] }),
  ));
  if (variant === 'c1-c') return tools;

  tools.push(tool(
    'relay_pm_submit_judgment',
    'Harmless diagnostic PM write probe. Validates a bounded judgment shape and increments process-local memory only. It never creates or changes a Relay Task, Run, Delivery, Evidence, or judgment record.',
    judgmentSchema,
    async ({ deliveryId, decision }) => ({ ok: true, diagnostic: true, deliveryId, decision, processLocalWriteCount: ++diagnosticWriteCount }),
  ));
  if (variant === 'c1-d') return tools;

  // C1-E keeps the same minimum four-tool shape but describes the intended
  // production PM role. The handler remains deliberately inert for C1; the
  // experiment measures host catalog classification, not real judgment effects.
  const submit = tools.find((entry) => entry.name === 'relay_pm_submit_judgment');
  submit.description = 'Minimal production-shaped PM judgment surface for C1 catalog testing. This diagnostic endpoint is inert: it never writes production Relay state.';
  return tools;
}

function widgetHtml(variant) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Agent Relay C1</title><style>body{font:14px system-ui;margin:16px}.ok{color:#087a35}.muted{color:#666}button{padding:7px 10px}</style></head><body><h3>Agent Relay C1 diagnostic</h3><p class="ok" id="status">Connecting…</p><p class="muted">Variant: ${variant}. No Task, Worker, or Relay data is used.</p><button id="ping" type="button">Optional diagnostic follow-up</button><script>(function(){let next=1;function rpc(method,params){const id=next++;return new Promise((resolve,reject)=>{function on(e){const d=e.data;if(!d||d.id!==id)return;window.removeEventListener('message',on);if(Object.prototype.hasOwnProperty.call(d,'result'))resolve(d.result);else reject(new Error(d.error&&d.error.message||'bridge error'));}window.addEventListener('message',on);window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');});}rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'agent-relay-c1',version:'1.0.0'},appCapabilities:{}}).then(()=>{window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');document.getElementById('status').textContent='Connected — diagnostic idle';}).catch(e=>{document.getElementById('status').textContent='Initialization failed: '+e.message;});document.getElementById('ping').onclick=async()=>{try{await rpc('ui/message',{role:'user',content:[{type:'text',text:'C1_DIAGNOSTIC_FOLLOW_UP: Reply exactly C1_DIAGNOSTIC_ACK. Do not call tools.'}]});document.getElementById('status').textContent='Diagnostic follow-up requested';}catch(e){document.getElementById('status').textContent='Follow-up unavailable: '+e.message;}};})();</script></body></html>`;
}

function makeServer(variant) {
  const tools = buildTools(variant);
  const server = new Server({ name: `agent-relay-c1-${variant}`, version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema, _meta }) => ({ name, description, inputSchema, ...(_meta ? { _meta } : {}) })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const target = tools.find((candidate) => candidate.name === request.params.name);
    if (!target) return { content: [{ type: 'text', text: 'Unknown diagnostic tool' }], isError: true };
    try {
      const result = await target.handler(request.params.arguments ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: WIDGET_URI, name: 'Agent Relay C1 diagnostic widget', description: `Isolated promotion-boundary widget (${variant}).`, mimeType: WIDGET_MIME }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== WIDGET_URI) throw new Error('Unknown diagnostic resource');
    return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml(variant) }] };
  });
  return server;
}

const { variant, port } = args(process.argv.slice(2));
const httpServer = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, diagnostic: 'C1', variant }));
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/mcp') {
    response.writeHead(404).end('not found');
    return;
  }
  const server = makeServer(variant);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, undefined);
    response.on('close', () => { void transport.close(); void server.close(); });
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'diagnostic transport failure' }));
  }
});
httpServer.listen(port, () => console.log(`C1 diagnostic ${variant} listening on http://127.0.0.1:${port}/mcp`));
