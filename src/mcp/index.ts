/**
 * MCP server entry point (Phase E).
 *
 * Spawned as a separate stdio process by an MCP host (VS Code, Claude desktop, etc.).
 * Two structurally separated launch modes:
 *
 *   PM surface    — relay-mcp --surface pm --dataRoot /path --project MyProject
 *   Worker surface — relay-mcp --surface worker --dataRoot /path --project MyProject \
 *                               --taskId TASK-1 --runId RUN-abc123 [--clientId ...] [--agentId ...] [--sessionId ...]
 *
 * The --surface flag selects which tool set is registered at startup.
 * PM surface NEVER receives Worker tools; Worker surface NEVER receives PM tools.
 * No caller-supplied role string is accepted as authorization — the surface
 * is process configuration derived from the --surface flag.
 */
import { McpServer } from './server.js';
import { buildAllPmTools } from './pm-tools.js';
import { buildAllWorkerTools } from './worker-tools.js';

// ── CLI argument parsing ─────────────────────────────────────────────────────

interface ParsedArgs {
  surface: 'pm' | 'worker';
  dataRoot: string;
  project: string;
  taskId?: string;
  runId?: string;
  clientId?: string;
  agentId?: string;
  sessionId?: string;
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  let surface = '';
  let dataRoot = '';
  let project = '';
  let taskId = '';
  let runId = '';
  let clientId = '';
  let agentId = '';
  let sessionId = '';

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--surface':   if (i + 1 < argv.length) surface   = argv[++i]; break;
      case '--dataRoot':  if (i + 1 < argv.length) dataRoot  = argv[++i]; break;
      case '--project':   if (i + 1 < argv.length) project   = argv[++i]; break;
      case '--taskId':    if (i + 1 < argv.length) taskId    = argv[++i]; break;
      case '--runId':     if (i + 1 < argv.length) runId     = argv[++i]; break;
      case '--clientId':  if (i + 1 < argv.length) clientId  = argv[++i]; break;
      case '--agentId':   if (i + 1 < argv.length) agentId   = argv[++i]; break;
      case '--sessionId': if (i + 1 < argv.length) sessionId = argv[++i]; break;
    }
  }

  if (!dataRoot)  throw new Error('--dataRoot is required');
  if (!project)   throw new Error('--project is required');
  if (!surface)   throw new Error('--surface is required (pm | worker)');
  if (surface !== 'pm' && surface !== 'worker') {
    throw new Error(`--surface must be "pm" or "worker", got: ${surface}`);
  }
  if (surface === 'worker') {
    if (!taskId) throw new Error('--taskId is required for worker surface');
    if (!runId)  throw new Error('--runId is required for worker surface');
  }

  return {
    surface: surface as 'pm' | 'worker',
    dataRoot,
    project,
    taskId:    taskId    || undefined,
    runId:     runId     || undefined,
    clientId:  clientId  || undefined,
    agentId:   agentId   || undefined,
    sessionId: sessionId || undefined,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  let tools;
  if (args.surface === 'pm') {
    tools = buildAllPmTools({ dataRoot: args.dataRoot, project: args.project });
  } else {
    // surface === 'worker' — taskId and runId are guaranteed non-empty by parseArgs
    tools = buildAllWorkerTools({
      dataRoot:  args.dataRoot,
      project:   args.project,
      taskId:    args.taskId!,
      runId:     args.runId!,
      clientId:  args.clientId,
      agentId:   args.agentId,
      sessionId: args.sessionId,
    });
  }

  const server = new McpServer(tools);
  await server.serve();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
