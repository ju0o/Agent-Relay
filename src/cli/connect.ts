/**
 * Phase I3C PM Connect Safety Correction — Official Claude Connect Recipe
 *
 * Verified against real Claude Code 2.1.252 via:
 *   claude mcp --help
 *   claude mcp add --help      → usage: claude mcp add [options] <name> <commandOrUrl> [args...]  with --scope <scope> (local|user|project) default local, -- separator for stdio args
 *   claude mcp list --help     → claude mcp list
 *   claude mcp get --help      → claude mcp get <name>
 *   claude mcp remove --help   → claude mcp remove <name> [--scope <scope>]
 *
 * Verified Registration Syntax (stdio):
 *   claude mcp add --scope local agent-relay-pm -- <execPath> <mcpEntry> --surface pm --dataRoot <dataRoot> --project <project>
 * Observed get output includes:
 *   Scope: Local config (private to you in this project)
 *   Command: <execPath>
 *   Args: <mcpEntry> --surface pm --dataRoot <dataRoot> --project <project>
 * List/get are used for idempotency verification.
 * No shell, discrete argv, shell:false everywhere.
 */

import { spawnSync } from 'node:child_process';
import { discoverConfig } from './config.js';
import { findPackageRoot, resolveMcpEntry } from './init.js';

// keep small typed switch for future Codex/OpenCode recipes
type SupportedClient = 'claude-code';
type ConnectMethod = 'official-cli' | 'manual';
type ConnectScope = 'local' | 'user' | 'project';

export interface ConnectResult {
  schemaVersion: 'cli.connect.v1';
  ok: boolean;
  client: string;
  configured: boolean;
  method: ConnectMethod;
  scope?: ConnectScope;
  configPath?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  message: string;
  warnings?: string[];
  diagnostic?: string;
}

export interface ConnectOptions {
  force?: boolean;
  // injectable for tests; defaults to node spawnSync
  spawnSyncImpl?: typeof spawnSync;
  execPath?: string;
}

// bounded diagnostic helper
function bound(s: string, n = 800): string {
  if (!s) return '';
  const t = String(s).trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function manualSnippet(
  mcpArgs: string[],
  execPath: string,
): string {
  return JSON.stringify({ mcpServers: { 'agent-relay-pm': { command: execPath, args: mcpArgs } } }, null, 2);
}

function buildMcpArgs(entry: string, dataRoot: string, project: string): string[] {
  return [entry, '--surface', 'pm', '--dataRoot', dataRoot, '--project', project];
}

function detectClaudePresent(spawn: typeof spawnSync): { present: boolean; diagnostic?: string } {
  try {
    const r = spawn('claude', ['--version'], { encoding: 'utf8', shell: false, timeout: 4000, windowsHide: true } as any);
    if (r.error) {
      const msg = (r.error as Error).message || String(r.error);
      // ENOENT means not installed
      if (msg.includes('ENOENT') || msg.includes('not found')) return { present: false, diagnostic: bound(msg) };
      return { present: false, diagnostic: bound(msg) };
    }
    if (r.status === 0) return { present: true };
    // Some installs return version on stderr but status 0 expected; treat non-zero as present but maybe broken
    const out = bound(((r.stdout as string) || '') + ((r.stderr as string) || ''));
    if (out.includes('2.') || out.toLowerCase().includes('claude')) return { present: true };
    return { present: false, diagnostic: out };
  } catch (e) {
    return { present: false, diagnostic: bound(e instanceof Error ? e.message : String(e)) };
  }
}

function detectMcpCapability(spawn: typeof spawnSync): { supported: boolean; diagnostic?: string } {
  try {
    const r = spawn('claude', ['mcp', 'add', '--help'], { encoding: 'utf8', shell: false, timeout: 4000, windowsHide: true } as any);
    if (r.error) return { supported: false, diagnostic: bound((r.error as Error).message) };
    const out = String((r.stdout as string) || '') + String((r.stderr as string) || '');
    if (r.status === 0 && out.includes('--scope') && out.includes('Add an MCP server')) {
      return { supported: true };
    }
    return { supported: false, diagnostic: bound(out || `status ${r.status}`) };
  } catch (e) {
    return { supported: false, diagnostic: bound(e instanceof Error ? e.message : String(e)) };
  }
}

function getExistingRegistration(
  spawn: typeof spawnSync,
  cwd: string,
): { found: boolean; stdout: string; stderr: string; status: number | null; command?: string; argsRaw?: string; scopeRaw?: string } {
  try {
    const r = spawn('claude', ['mcp', 'get', 'agent-relay-pm'], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
      windowsHide: true,
    } as any);
    const stdout = String((r.stdout as string) || '');
    const stderr = String((r.stderr as string) || '');
    const status = r.status;
    if (status === 0) {
      // parse Command/Args/Scope lines
      let command: string | undefined;
      let argsRaw: string | undefined;
      let scopeRaw: string | undefined;
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (t.startsWith('Command:')) command = t.slice('Command:'.length).trim();
        else if (t.startsWith('Args:')) argsRaw = t.slice('Args:'.length).trim();
        else if (t.startsWith('Scope:')) scopeRaw = t.slice('Scope:'.length).trim();
      }
      return { found: true, stdout, stderr, status, command, argsRaw, scopeRaw };
    }
    // Not found case: claude prints "No MCP server named"
    if (stderr.includes('No MCP server named') || stdout.includes('No MCP server named')) {
      return { found: false, stdout, stderr, status };
    }
    // Fallback to list check? Try list to see if any, but treat as not found if not zero
    return { found: false, stdout, stderr, status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { found: false, stdout: '', stderr: bound(msg), status: null };
  }
}

function isSameRegistration(
  existing: { command?: string; argsRaw?: string; stdout: string },
  desiredCommand: string,
  desiredArgs: string[],
  desiredEntry: string,
  dataRoot: string,
  project: string,
): boolean {
  // Require command matches exactly and stdout contains entry, dataRoot, project, and surface pm
  if (!existing.command) return false;
  if (existing.command !== desiredCommand) return false;
  const hay = existing.stdout;
  // Must contain entry (basename check to avoid separator issues)
  if (!hay.includes(desiredEntry)) return false;
  // dataRoot and project must be present
  if (!hay.includes(dataRoot)) return false;
  if (!hay.includes(project)) return false;
  // surface pm check
  if (!hay.includes('--surface') || !hay.includes('pm')) return false;
  // Also verify argsRaw if present: should contain surface pm sequence
  // For strict argv equality, also check that desiredArgs elements appear in order in argsRaw
  // We do a lenient but deterministic ordered check
  if (existing.argsRaw !== undefined) {
    const argsStr = existing.argsRaw;
    // Check each desired arg appears sequentially
    let idx = 0;
    for (const part of desiredArgs) {
      const pos = argsStr.indexOf(part, idx);
      if (pos === -1) return false;
      idx = pos + part.length;
    }
  }
  return true;
}

export function generateMcpSnippet(cwd: string, packageRoot?: string): { command: string; entry: string; dataRoot: string; project: string } | null {
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) return null;
  const pkgRoot = packageRoot ?? findPackageRoot();
  const entry = resolveMcpEntry(pkgRoot);
  const cmd = `"${process.execPath}" "${entry}" --surface pm --dataRoot "${discovered.config.dataRoot}" --project "${discovered.config.project}"`;
  return { command: cmd, entry, dataRoot: discovered.config.dataRoot, project: discovered.config.project };
}

export function runConnect(cwd: string, client: string, opts?: ConnectOptions | boolean): ConnectResult {
  // Normalize opts: allow boolean as force for backward compat
  let force = false;
  let spawnImpl: typeof spawnSync = spawnSync;
  let execPath = process.execPath;
  if (typeof opts === 'boolean') {
    force = opts;
  } else if (opts) {
    force = !!opts.force;
    if (opts.spawnSyncImpl) spawnImpl = opts.spawnSyncImpl;
    if (opts.execPath) execPath = opts.execPath;
  }

  const warnings: string[] = [];
  const discovered = discoverConfig(cwd);
  if (!discovered.initialized || !discovered.config) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      method: 'manual',
      message: 'Not initialized — run agent-relay init first.',
      warnings,
    };
  }

  const pkgRoot = findPackageRoot();
  const entry = resolveMcpEntry(pkgRoot);
  const dataRoot = discovered.config.dataRoot;
  const project = discovered.config.project;
  const mcpArgs = buildMcpArgs(entry, dataRoot, project);
  const mcpCommand = `"${execPath}" "${entry}" --surface pm --dataRoot "${dataRoot}" --project "${project}"`;

  // Boundary: small typed switch for future recipes
  if (client !== 'claude-code') {
    const snippet = manualSnippet(mcpArgs, execPath);
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: false,
      method: 'manual',
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Client '${client}' not supported for auto-connect. Only 'claude-code' is supported via official CLI.\nManual MCP config (transport-correct stdio):\n${snippet}\nAdd this to your client's MCP configuration manually. Do not claim it was installed.`,
      warnings,
    };
  }

  // For claude-code: detect CLI presence
  const present = detectClaudePresent(spawnImpl);
  if (!present.present) {
    const snippet = manualSnippet(mcpArgs, execPath);
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: false,
      method: 'manual',
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Project initialized (${project})\n! Claude Code CLI not found (${bound(present.diagnostic || 'not installed')})\n! Automatic MCP registration unavailable\nRun this manual setup:\n${snippet}\n\nManual steps:\n1. Ensure Claude Code is installed (claude --version)\n2. Or add the above JSON to your Claude Code MCP config via official docs\n3. Verify with: claude mcp list`,
      warnings,
      diagnostic: bound(present.diagnostic || ''),
    };
  }

  const cap = detectMcpCapability(spawnImpl);
  if (!cap.supported) {
    const snippet = manualSnippet(mcpArgs, execPath);
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: false,
      method: 'manual',
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n! Official MCP CLI not supported (${bound(cap.diagnostic || 'no mcp add')})\n! Automatic MCP registration unavailable\nRun this manual setup:\n${snippet}\n\nTo register manually when supported:\n  claude mcp add --scope local agent-relay-pm -- ${execPath} ${entry} --surface pm --dataRoot ${dataRoot} --project ${project}\nVerify with: claude mcp get agent-relay-pm`,
      warnings,
      diagnostic: bound(cap.diagnostic || ''),
    };
  }

  // Official CLI supported — choose narrowest appropriate scope: local (private to you in this project)
  // Explicit scope local maps safely to current coding workspace (cwd). Documented: local is project-local private, not global.
  const scope: ConnectScope = 'local';

  // Idempotency: use official list/get
  const existing = getExistingRegistration(spawnImpl, cwd);
  if (existing.found) {
    if (isSameRegistration(existing, execPath, mcpArgs, entry, dataRoot, project)) {
      return {
        schemaVersion: 'cli.connect.v1',
        ok: true,
        client,
        configured: true,
        method: 'official-cli',
        scope,
        mcpCommand,
        mcpArgs: [execPath, ...mcpArgs],
        message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n✓ agent-relay-pm already registered\n✓ Registration verified\nScope: ${scope} (private to you in this project)\nCommand: ${execPath} ${mcpArgs.join(' ')}`,
        warnings,
      };
    }
    // Conflict: same name different config
    if (!force) {
      return {
        schemaVersion: 'cli.connect.v1',
        ok: false,
        client,
        configured: false,
        method: 'official-cli',
        scope,
        mcpCommand,
        mcpArgs: [execPath, ...mcpArgs],
        message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n! Conflicting MCP registration for 'agent-relay-pm' exists (different command/args)\nExisting: ${bound(existing.stdout.slice(0, 400)) || bound(existing.stderr.slice(0,400))}\nDesired: ${execPath} ${mcpArgs.join(' ')}\nRefusing to overwrite without --force.\nTo replace manually:\n  claude mcp remove agent-relay-pm --scope ${scope}\n  claude mcp add --scope ${scope} agent-relay-pm -- ${execPath} ${entry} --surface pm --dataRoot ${dataRoot} --project ${project}\nOr run: agent-relay connect claude-code --force`,
        warnings,
        diagnostic: bound(existing.stdout || existing.stderr),
      };
    }
    // --force: only replace agent-relay-pm via official CLI, do not mutate config file directly
    // Remove existing first (scope local explicit, but also try without scope if needed)
    const rm = spawnImpl('claude', ['mcp', 'remove', 'agent-relay-pm', '--scope', scope], {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 5000,
      windowsHide: true,
    } as any);
    if (rm.error || (rm.status !== 0 && !String((rm.stderr as string) || '').includes('No MCP server'))) {
      // If remove with scope failed, try without scope (removes from whichever scope)
      const rm2 = spawnImpl('claude', ['mcp', 'remove', 'agent-relay-pm'], {
        cwd,
        encoding: 'utf8',
        shell: false,
        timeout: 5000,
        windowsHide: true,
      } as any);
      if (rm2.error || rm2.status !== 0) {
        const diag = bound(String((rm.stderr as string) || '') + String((rm2.stderr as string) || '') + String((rm.stdout as string) || ''));
        return {
          schemaVersion: 'cli.connect.v1',
          ok: false,
          client,
          configured: false,
          method: 'official-cli',
          scope,
          mcpCommand,
          mcpArgs: [execPath, ...mcpArgs],
          message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n! Failed to remove conflicting 'agent-relay-pm' for --force replacement.\n${diag}\nManual fix:\n  claude mcp remove agent-relay-pm --scope ${scope}\n  claude mcp add --scope ${scope} agent-relay-pm -- ${execPath} ${entry} --surface pm --dataRoot ${dataRoot} --project ${project}`,
          warnings,
          diagnostic: diag,
        };
      }
    }
    // fall through to add after removal
  }

  // Execute official registration: discrete argv, shell:false
  const addArgv: string[] = ['mcp', 'add', '--scope', scope, 'agent-relay-pm', '--', execPath, ...mcpArgs];
  let addRes: any;
  try {
    addRes = spawnImpl('claude', addArgv, {
      cwd,
      encoding: 'utf8',
      shell: false,
      timeout: 10000,
      windowsHide: true,
    } as any);
  } catch (e) {
    const diag = bound(e instanceof Error ? e.message : String(e));
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      method: 'official-cli',
      scope,
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n✘ Registration failed\n${diag}\nDid not fall back to direct file mutation.`,
      warnings,
      diagnostic: diag,
    };
  }

  if (addRes.error) {
    const diag = bound((addRes.error as Error).message);
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      method: 'official-cli',
      scope,
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n✘ Registration spawn failed\n${diag}`,
      warnings,
      diagnostic: diag,
    };
  }

  if (addRes.status !== 0) {
    const diag = bound(String((addRes.stderr as string) || '') + String((addRes.stdout as string) || ''));
    return {
      schemaVersion: 'cli.connect.v1',
      ok: false,
      client,
      configured: false,
      method: 'official-cli',
      scope,
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n✘ Registration failed (exit ${addRes.status})\n${diag}\nDid not fall back to direct file mutation.`,
      warnings,
      diagnostic: diag,
    };
  }

  // Verification: configured=true only after verification via official list/get
  const verify = getExistingRegistration(spawnImpl, cwd);
  if (verify.found && isSameRegistration(verify, execPath, mcpArgs, entry, dataRoot, project)) {
    return {
      schemaVersion: 'cli.connect.v1',
      ok: true,
      client,
      configured: true,
      method: 'official-cli',
      scope,
      mcpCommand,
      mcpArgs: [execPath, ...mcpArgs],
      message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n✓ agent-relay-pm registered\n✓ Registration verified\nScope: ${scope}\nFile: verified via claude mcp get agent-relay-pm`,
      warnings,
    };
  }

  const diag = bound(verify.stderr || verify.stdout || 'verification failed: not found after add');
  return {
    schemaVersion: 'cli.connect.v1',
    ok: false,
    client,
    configured: false,
    method: 'official-cli',
    scope,
    mcpCommand,
    mcpArgs: [execPath, ...mcpArgs],
    message: `Agent Relay → Claude Code\n\n✓ Claude Code found\n✓ Official MCP CLI supported\n! Registration command succeeded but verification failed\n${diag}\nCheck: claude mcp get agent-relay-pm`,
    warnings,
    diagnostic: diag,
  };
}
