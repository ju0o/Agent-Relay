/**
 * V1-G6-MCP — Agent Relay MCP App server CLI entry.
 *
 * Usage:
 *   node dist/server/mcp/app-server-main.js --dataRoot <path> --project <name> [--port 3899]
 *     [--host 127.0.0.1] [--auth-token-file <path> | --allow-unauthenticated]
 *
 * Serves the PM MCP surface (read/write/wake tools + Agent Relay PM widget)
 * over Streamable HTTP for ChatGPT MCP Apps. dataRoot/project are process
 * configuration, never tool arguments.
 *
 * Fails closed: refuses to start unless --auth-token-file is given or
 * --allow-unauthenticated is explicitly passed.
 */
import * as fs from 'node:fs';
import { startMcpAppServer } from './app-server.js';

interface Args {
  dataRoot: string;
  project: string;
  port: number;
  host: string;
  authTokenFile?: string;
  allowUnauthenticated: boolean;
  goalWorker?: string;
  goalWorkspace?: string;
  goalTransport?: 'internal' | 'actl';
  goalActlAgent?: string;
}

function parseArgs(argv: string[]): Args {
  let dataRoot = '';
  let project = '';
  let port = 3899;
  let host = '127.0.0.1';
  let authTokenFile: string | undefined;
  let allowUnauthenticated = false;
  let goalWorker = '';
  let goalWorkspace = '';
  let goalTransport = '';
  let goalActlAgent = '';
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dataRoot': if (i + 1 < argv.length) dataRoot = argv[++i]; break;
      case '--project':  if (i + 1 < argv.length) project = argv[++i]; break;
      case '--port':     if (i + 1 < argv.length) { const n = Number(argv[++i]); if (Number.isInteger(n) && n > 0) port = n; } break;
      case '--host':     if (i + 1 < argv.length) host = argv[++i]; break;
      case '--auth-token-file': if (i + 1 < argv.length) authTokenFile = argv[++i]; break;
      case '--allow-unauthenticated': allowUnauthenticated = true; break;
      case '--goal-worker': if (i + 1 < argv.length) goalWorker = argv[++i]; break;
      case '--goal-workspace': if (i + 1 < argv.length) goalWorkspace = argv[++i]; break;
      case '--goal-transport': if (i + 1 < argv.length) goalTransport = argv[++i]; break;
      case '--goal-actl-agent': if (i + 1 < argv.length) goalActlAgent = argv[++i]; break;
    }
  }
  if (!dataRoot) throw new Error('--dataRoot is required');
  if (!project) throw new Error('--project is required');
  if ((goalWorker && !goalWorkspace) || (!goalWorker && goalWorkspace)) {
    throw new Error('--goal-worker and --goal-workspace must be provided together');
  }
  return {
    dataRoot, project, port, host, authTokenFile, allowUnauthenticated,
    ...(goalWorker && goalWorkspace ? {
      goalWorker,
      goalWorkspace,
      ...(goalTransport === 'actl' ? { goalTransport: 'actl' as const } : {}),
      ...(goalActlAgent ? { goalActlAgent } : {}),
    } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let authToken: string | undefined;
  if (args.authTokenFile) {
    authToken = fs.readFileSync(args.authTokenFile, 'utf8').trim();
    if (!authToken) throw new Error('--auth-token-file is empty');
  } else if (!args.allowUnauthenticated) {
    throw new Error(
      'Refusing to start unauthenticated: pass --auth-token-file <path> or explicitly pass --allow-unauthenticated.',
    );
  } else {
    console.warn('WARNING: starting agent-relay-mcp-app with no authentication (--allow-unauthenticated)');
  }

  const server = await startMcpAppServer({
    dataRoot: args.dataRoot,
    project: args.project,
    port: args.port,
    host: args.host,
    authToken,
    ...(args.goalWorker && args.goalWorkspace ? {
      goalLoop: {
        workerId: args.goalWorker,
        workspaceRoot: args.goalWorkspace,
        ...(args.goalTransport ? { transport: args.goalTransport } : {}),
        ...(args.goalActlAgent ? { actlAgent: args.goalActlAgent } : {}),
      },
    } : {}),
  });
  console.log(`Agent Relay MCP App listening on http://${args.host}:${args.port}/mcp (project=${args.project})`);
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
