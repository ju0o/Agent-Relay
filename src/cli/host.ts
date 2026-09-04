/**
 * V1-G4-C — `agent-relay host watch` entrypoint.
 *
 * Resident local Host Bridge: reconcile pending PM Deliveries, hand
 * verification packets to the configured PM Host child (stdio NDJSON),
 * and ACK on valid matching receipts. No user polling.
 *
 * Trusted owner configuration only (.agent-relay/host.json). Never from
 * Worker MCP, Task fields, or Delivery packets.
 */
import * as path from 'path';
import { discoverConfig } from './config.js';
import { loadPmHostConfig, PmHostBridge } from '../backend/pm-host-bridge.js';

export const HOST_CLI_SCHEMA_VERSION = 'cli.host.v1' as const;

export interface HostWatchOptions {
  cwd: string;
  once?: boolean;
  pollMs?: number;
  hostConfigDir?: string;
}

/**
 * Run the host bridge. Returns process exit code (0 ok, 1 config/runtime error).
 * Watch mode runs until SIGINT/SIGTERM; --once drains once and exits.
 */
export async function runHostWatch(opts: HostWatchOptions): Promise<number> {
  const discovered = discoverConfig(opts.cwd);
  if (!discovered.initialized || !discovered.config) {
    console.error(discovered.error ?? 'Agent Relay is not initialized in this project.\nRun: agent-relay init');
    return 1;
  }
  const { dataRoot, project } = discovered.config;
  const configDir = opts.hostConfigDir ?? path.join(path.resolve(opts.cwd), '.agent-relay');

  let hostConfig;
  try {
    hostConfig = loadPmHostConfig(configDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const bridge = new PmHostBridge({
    dataRoot,
    project,
    hostCommand: hostConfig.pmHost.command,
    hostArgs: hostConfig.pmHost.args,
    ...(opts.pollMs !== undefined ? { pollMs: opts.pollMs } : {}),
  });

  if (opts.once) {
    const result = await bridge.runOnce();
    await bridge.stop();
    console.log(JSON.stringify({ schemaVersion: HOST_CLI_SCHEMA_VERSION, ok: true, ...result }, null, 2));
    return 0;
  }

  await bridge.start();
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void bridge.stop().then(() => resolve(), () => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}
