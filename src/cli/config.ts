/**
 * Minimal project config discovery for CLI Phase I3B.
 *
 * Looks for `.agent-relay/config.json` under cwd.
 * Only project-safe references allowed; trusted Worker Registry stays under dataRoot.
 */
import * as fs from 'fs';
import * as path from 'path';

export const CLI_CONFIG_SCHEMA_VERSION = 'cli.config.v1';

export interface CliConfig {
  schemaVersion: string;
  project: string;
  dataRoot: string;
  workspaceRoot: string;
}

export interface ConfigDiscoveryResult {
  cwd: string;
  configPath: string | null;
  config: CliConfig | null;
  initialized: boolean;
  error?: string;
  warnings: string[];
}

const FORBIDDEN_KEYS = new Set([
  'launchCommand',
  'launchArgsPrefix',
  'permissionMode',
  'token',
  'tokens',
  'apiKey',
  'apiKeys',
  'secret',
  'secrets',
]);

function isForbiddenKey(k: string): boolean {
  return FORBIDDEN_KEYS.has(k) || k.toLowerCase().includes('secret') || k.toLowerCase().includes('token') || k.toLowerCase().includes('apikey');
}

export function discoverConfig(cwd: string): ConfigDiscoveryResult {
  const normalizedCwd = path.resolve(cwd);
  const configPath = path.join(normalizedCwd, '.agent-relay', 'config.json');
  const warnings: string[] = [];

  if (!fs.existsSync(configPath)) {
    return { cwd: normalizedCwd, configPath: null, config: null, initialized: false, warnings };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: `config.json parse error: ${msg}`, warnings };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: 'config.json must be an object', warnings };
  }

  const obj = raw as Record<string, unknown>;

  // Security: reject forbidden keys
  for (const key of Object.keys(obj)) {
    if (isForbiddenKey(key)) {
      return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: `config.json contains forbidden key: ${key}`, warnings };
    }
    // also check nested driverOptions etc if present
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      for (const sub of Object.keys(obj[key] as Record<string, unknown>)) {
        if (isForbiddenKey(sub)) {
          return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: `config.json contains forbidden nested key: ${key}.${sub}`, warnings };
        }
      }
    }
  }

  const schemaVersion = typeof obj.schemaVersion === 'string' ? obj.schemaVersion : CLI_CONFIG_SCHEMA_VERSION;
  const project = typeof obj.project === 'string' ? obj.project : '';
  const dataRoot = typeof obj.dataRoot === 'string' ? obj.dataRoot : '';
  const workspaceRoot = typeof obj.workspaceRoot === 'string' ? obj.workspaceRoot : normalizedCwd;

  if (!project || !project.trim()) {
    return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: 'config.json missing required field: project', warnings };
  }
  if (!dataRoot || !dataRoot.trim()) {
    return { cwd: normalizedCwd, configPath, config: null, initialized: false, error: 'config.json missing required field: dataRoot', warnings };
  }

  const config: CliConfig = {
    schemaVersion,
    project: project.trim(),
    dataRoot: path.resolve(dataRoot.trim()),
    workspaceRoot: path.resolve(workspaceRoot.trim()),
  };

  // Validate no secrets leak via values? Ensure workspaceRoot exists warning, not error
  if (!fs.existsSync(config.workspaceRoot)) {
    warnings.push(`workspaceRoot does not exist: ${config.workspaceRoot}`);
  }

  return { cwd: normalizedCwd, configPath, config, initialized: true, warnings };
}

export function notInitializedMessage(): string {
  return 'Agent Relay is not initialized in this project.\nRun: agent-relay init';
}
