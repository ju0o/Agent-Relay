/**
 * Minimal PM connect helper — Phase I3C
 * Only `claude-code` is supported if config format can be verified.
 * Otherwise prints manual MCP snippet.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverConfig } from './config.js';
import { findPackageRoot, resolveMcpEntry } from './init.js';

export interface ConnectResult {
  schemaVersion: string;
  ok: boolean;
  client: string;
  configured: boolean;
  configPath?: string;
  backupPath?: string;
  mcpCommand?: string;
  message: string;
  warnings?: string[];
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

function candidateClaudeConfigPaths(): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  // Common locations
  candidates.push(path.join(home, '.claude.json'));
  candidates.push(path.join(home, '.claude', 'config.json'));
  candidates.push(path.join(home, '.config', 'claude', 'config.json'));
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) candidates.push(path.join(appData, 'Claude', 'claude.json'));
    const localApp = process.env.LOCALAPPDATA?.trim();
    if (localApp) candidates.push(path.join(localApp, 'Claude', 'config.json'));
  }
  // Also check XDG
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) candidates.push(path.join(xdg, 'claude', 'config.json'));
  return candidates;
}

export function generateMcpSnippet(cwd: string, packageRoot?: string): { command: string; entry: string; dataRoot: string; project: string } | null {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) return null;
  const pkgRoot = packageRoot ?? findPackageRoot();
  const entry = resolveMcpEntry(pkgRoot);
  const cmd = `"${process.execPath}" "${entry}" --surface pm --dataRoot "${discovered.config.dataRoot}" --project "${discovered.config.project}"`;
  return { command: cmd, entry, dataRoot: discovered.config.dataRoot, project: discovered.config.project };
}

export function runConnect(cwd: string, client: string): ConnectResult {
  const warnings: string[] = [];
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      message: 'Not initialized — run agent-relay init first.',
    };
  }
  const pkgRoot = findPackageRoot();
  const entry = resolveMcpEntry(pkgRoot);
  const mcpCommand = `"${process.execPath}" "${entry}" --surface pm --dataRoot "${discovered.config.dataRoot}" --project "${discovered.config.project}"`;
  const mcpArgs = [entry, '--surface', 'pm', '--dataRoot', discovered.config.dataRoot, '--project', discovered.config.project];

  if (client !== 'claude-code') {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      mcpCommand,
      message: `Client '${client}' not supported for auto-connect. Only 'claude-code' is supported. Manual MCP config:\n  { "mcpServers": { "agent-relay-pm": { "command": "${process.execPath}", "args": ${JSON.stringify(mcpArgs)} } } }`,
    };
  }

  // Try to locate claude-code config
  const candidates = candidateClaudeConfigPaths();
  let targetPath: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { targetPath = p; break; }
  }
  if (!targetPath) {
    // No proven config — print instructions instead of editing
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: false,
      mcpCommand,
      message: `No Claude Code config file found at checked locations. Add manually:\n${JSON.stringify({ mcpServers: { 'agent-relay-pm': { command: process.execPath, args: mcpArgs } } }, null, 2)}\nChecked: ${candidates.join(', ')}`,
      warnings,
    };
  }

  // Verify format: must be JSON with object, and mcpServers is object or absent
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(targetPath, 'utf8')); } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      configPath: targetPath,
      mcpCommand,
      message: `Claude config at ${targetPath} is not valid JSON — not modifying. Manual: ${msg}`,
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      configPath: targetPath,
      mcpCommand,
      message: `Claude config at ${targetPath} has unexpected format — not modifying.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  // mcpServers should be object if present
  if (obj.mcpServers !== undefined && (typeof obj.mcpServers !== 'object' || obj.mcpServers === null || Array.isArray(obj.mcpServers))) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      configPath: targetPath,
      mcpCommand,
      message: `Claude config at ${targetPath} has invalid mcpServers type — not modifying.`,
    };
  }

  // Preserve unrelated entries, backup first, idempotent
  const mcpServers = (obj.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existing = mcpServers['agent-relay-pm'] as Record<string, unknown> | undefined;
  const desired = { command: process.execPath, args: mcpArgs };
  const isSame = existing && (existing as Record<string, unknown>).command === desired.command && JSON.stringify((existing as Record<string, unknown>).args) === JSON.stringify(desired.args);
  if (isSame) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: true,
      configPath: targetPath,
      mcpCommand,
      message: `Already configured at ${targetPath}`,
    };
  }

  // Backup
  const backupPath = `${targetPath}.bak.${Date.now()}`;
  try { fs.copyFileSync(targetPath, backupPath); } catch { /* ignore */ }

  const next = { ...obj, mcpServers: { ...mcpServers, 'agent-relay-pm': desired } };
  try {
    atomicWriteJson(targetPath, next);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // restore backup
    try { if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, targetPath); } catch {}
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      configPath: targetPath,
      backupPath,
      mcpCommand,
      message: `Failed to write Claude config: ${msg}`,
    };
  }

  return {
    schemaVersion: 'cli.connect.v1',
    ok: true,
    client,
    configured: true,
    configPath: targetPath,
    backupPath,
    mcpCommand,
    message: `Configured Claude Code MCP at ${targetPath} (backup: ${backupPath})`,
  };
}
