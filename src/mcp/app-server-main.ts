/**
 * V1-G6-MCP — Agent Relay MCP App server CLI entry.
 *
 * Usage:
 *   node dist/server/mcp/app-server-main.js --dataRoot <path> --project <name> [--port 3899]
 *
 * Serves the PM MCP surface (read/write/wake tools + Agent Relay PM widget)
 * over Streamable HTTP for ChatGPT MCP Apps. dataRoot/project are process
 * configuration, never tool arguments.
 */
import { startMcpAppServer } from './app-server.js';

interface Args { dataRoot: string; project: string; port: number; }

function parseArgs(argv: string[]): Args {
  let dataRoot = '';
  let project = '';
  let port = 3899;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dataRoot': if (i + 1 < argv.length) dataRoot = argv[++i]; break;
      case '--project':  if (i + 1 < argv.length) project = argv[++i]; break;
      case '--port':     if (i + 1 < argv.length) { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) port = n; } break;
    }
  }
  if (!dataRoot) throw new Error('--dataRoot is required');
  if (!project) throw new Error('--project is required');
  return { dataRoot, project, port };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await startMcpAppServer(args);
  console.log(`Agent Relay MCP App listening on http://localhost:${args.port}/mcp (project=${args.project})`);
  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});