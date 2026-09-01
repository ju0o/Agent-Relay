/**
 * Phase I3C — agent-relay init
 * Interactive (<=5 decisions) + --yes non-interactive + --force + --json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import { slugify } from '../backend/fs.js';
import { CLI_CONFIG_SCHEMA_VERSION, type CliConfig } from './config.js';
import * as workerRegistry from '../backend/worker-registry.js';

export const INIT_SCHEMA_VERSION = 'cli.init.v1';

// ── helpers ───────────────────────────────────────────────────────────────

export function getDefaultDataRoot(): string {
  const plat = process.platform;
  if (plat === 'win32') {
    const local = process.env.LOCALAPPDATA?.trim();
    if (local) return path.join(local, 'AgentRelay', 'data');
    const appData = process.env.APPDATA?.trim();
    if (appData) return path.join(appData, 'AgentRelay', 'data');
    return path.join(os.homedir(), 'AppData', 'Local', 'AgentRelay', 'data');
  }
  // unix: respect XDG_DATA_HOME
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, 'agent-relay');
  return path.join(os.homedir(), '.local', 'share', 'agent-relay');
}

export function findPackageRoot(startDir?: string): string {
  let dir = startDir ?? path.join(__dirname, '..', '..', '..');
  // When running from src via ts-node, __dirname is src/cli; when built, dist/server/cli
  // Walk up until package.json found with name containing agent-relay
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (typeof raw.name === 'string' && raw.name.includes('agent-relay')) return path.resolve(dir);
      } catch { /* continue */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // fallback: cwd
  return path.resolve(process.cwd());
}

export function resolveWrapperPath(packageRoot: string): string {
  const candidates = [
    path.join(packageRoot, 'scripts', 'relay-worker-claude.mjs'),
    path.join(packageRoot, 'dist', 'scripts', 'relay-worker-claude.mjs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  // default to first even if not exists (doctor will warn)
  return path.resolve(candidates[0]!);
}

export function resolveMcpEntry(packageRoot: string): string {
  const candidates = [
    path.join(packageRoot, 'dist', 'server', 'mcp', 'index.js'),
    path.join(packageRoot, 'dist', 'mcp', 'index.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  return path.resolve(candidates[0]!);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export type ClaudeDetection = 'DETECTED' | 'NOT_FOUND' | 'UNSUPPORTED';

export function detectClaude(): { status: ClaudeDetection; version?: string; path?: string } {
  // Try claude --version without launching session
  try {
    const res = spawnSync('claude', ['--version'], { timeout: 4000, windowsHide: true, encoding: 'utf8' });
    if (res.status === 0) {
      const out = (res.stdout ?? res.stderr ?? '').trim();
      return { status: 'DETECTED', version: out.slice(0, 120), path: 'claude' };
    }
  } catch { /* ignore */ }
  // Windows: try where
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('where', ['claude'], { timeout: 3000, windowsHide: true, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return { status: 'DETECTED', path: r.stdout.trim().split('\n')[0]!.trim() };
    } catch { /* ignore */ }
    try {
      const r2 = spawnSync('where', ['claude.cmd'], { timeout: 3000, windowsHide: true, encoding: 'utf8' });
      if (r2.status === 0 && r2.stdout.trim()) return { status: 'DETECTED', path: r2.stdout.trim().split('\n')[0]!.trim() };
    } catch { /* ignore */ }
  } else {
    try {
      const r = spawnSync('which', ['claude'], { timeout: 3000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return { status: 'DETECTED', path: r.stdout.trim() };
    } catch { /* ignore */ }
  }
  // Not found is not error
  return { status: 'NOT_FOUND' };
}

export function ensureGitignore(workspaceRoot: string, yes: boolean, interactive: boolean): { added: boolean; created: boolean; already: boolean } {
  const giPath = path.join(workspaceRoot, '.gitignore');
  const entry = '.agent-relay/';
  let content = '';
  let exists = fs.existsSync(giPath);
  if (exists) content = fs.readFileSync(giPath, 'utf8');
  else {
    if (!yes && interactive) {
      // For now, interactive caller should have asked; this helper is non-interactive when called via init's prompts
    }
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(entry) || lines.includes('.agent-relay')) return { added: false, created: false, already: true };

  // Only add if yes or interactive approved (init will gate this)
  if (!exists) {
    // Create case handled by caller; here we just write if told to
    // But ensureGitignore is called only when decision is to add
  }
  const toWrite = exists
    ? (content.endsWith('\n') || content === '' ? content : content + '\n') + entry + '\n'
    : entry + '\n';
  if (exists) {
    fs.writeFileSync(giPath, toWrite, 'utf8');
    return { added: true, created: false, already: false };
  } else {
    fs.writeFileSync(giPath, toWrite, 'utf8');
    return { added: true, created: true, already: false };
  }
}

function promptSync(question: string, defaultValue?: string): string {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // synchronous via spawnSync? Instead use async but caller is async
  // This sync version is not used directly; interactive flow uses async prompts
  rl.close();
  return defaultValue ?? '';
}

// ── main init ────────────────────────────────────────────────────────────

export interface InitOptions {
  cwd: string;
  yes: boolean;
  force: boolean;
  json: boolean;
  // for testing injection
  packageRoot?: string;
  claudeMock?: { status: ClaudeDetection; version?: string };
}

export interface InitResult {
  schemaVersion: typeof INIT_SCHEMA_VERSION;
  ok: boolean;
  initialized: boolean;
  project: string;
  workspaceRoot: string;
  dataRoot: string;
  configPath: string;
  config: CliConfig;
  gitignore: { added: boolean; created: boolean; already: boolean } | null;
  claudeDetection: { status: ClaudeDetection; version?: string; path?: string };
  worker: { installed: boolean; workerId: string; path: string; already: boolean; overwritten: boolean; skipped?: string } | null;
  mcp: { command: string; entry: string; surface: string };
  warnings: string[];
  error?: string;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const cwd = path.resolve(opts.cwd);
  const warnings: string[] = [];

  // Validate workspaceRoot
  let workspaceRoot = cwd;
  try {
    const st = fs.statSync(workspaceRoot);
    if (!st.isDirectory()) throw new Error('workspaceRoot is not a directory');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid workspaceRoot: ${msg}`);
  }
  if (!path.isAbsolute(workspaceRoot)) throw new Error('workspaceRoot must be absolute');

  // Warn if looks like Agent Relay source itself
  const isRelayRepo = fs.existsSync(path.join(workspaceRoot, 'src', 'cli', 'index.ts')) && fs.existsSync(path.join(workspaceRoot, 'src', 'backend', 'goal-task.ts'));
  if (isRelayRepo) warnings.push('Workspace looks like Agent Relay repository itself — ensure this is intended.');

  const configPath = path.join(workspaceRoot, '.agent-relay', 'config.json');
  const alreadyExists = fs.existsSync(configPath);

  if (alreadyExists && !opts.force) {
    // Read existing for error reporting
    let existingRaw: unknown = null;
    try { existingRaw = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* ignore */ }
    const existingProject = (existingRaw as Record<string, unknown> | null)?.project ?? '(unknown)';
    throw Object.assign(new Error(`Already initialized (project: ${existingProject}). Use --force to overwrite.`), { code: 'ALREADY_INITIALIZED', existingPath: configPath });
  }

  // Determine project name
  let project = path.basename(workspaceRoot);
  if (!project || project === '.' || project === path.sep) project = 'my-app';
  project = slugify(project);
  // Interactive override
  if (!opts.yes) {
    const ans = await ask(`Project name [${project}]: `, project);
    const sanitized = slugify(ans.trim() || project);
    if (sanitized) project = sanitized;
  }

  // Determine dataRoot
  let dataRoot = getDefaultDataRoot();
  if (!opts.yes) {
    const ans2 = await ask(`Data location [default: ${dataRoot} or enter custom path]: `, 'default');
    const trimmed = ans2.trim();
    if (trimmed && trimmed !== 'default' && trimmed.toLowerCase() !== 'default') {
      dataRoot = path.resolve(trimmed);
    }
  }
  dataRoot = path.resolve(dataRoot);

  if (dataRoot.startsWith(workspaceRoot + path.sep) || dataRoot === workspaceRoot) {
    warnings.push('dataRoot is inside workspace — prefer user-local default outside project.');
  }
  // Ensure dataRoot not inside package install dir (node_modules)
  if (dataRoot.includes('node_modules')) warnings.push('dataRoot inside node_modules is not recommended.');

  // Resolve package root and wrapper
  const packageRoot = opts.packageRoot ? path.resolve(opts.packageRoot) : findPackageRoot();
  const wrapperPath = resolveWrapperPath(packageRoot);
  const mcpEntry = resolveMcpEntry(packageRoot);
  if (!fs.existsSync(wrapperPath)) warnings.push(`Wrapper not found at ${wrapperPath} — run npm run build`);
  if (!fs.existsSync(mcpEntry)) warnings.push(`MCP entry not found at ${mcpEntry} — run npm run build`);

  // Detect Claude
  const detection = opts.claudeMock ?? detectClaude();

  // Decide worker install
  let doInstallWorker = false;
  if (detection.status === 'DETECTED') {
    if (opts.yes) doInstallWorker = true;
    else {
      const ans3 = await ask(`Claude Code detected${detection.version ? ` (${detection.version})` : ''}. Use Claude Code? [Y/n]: `, 'Y');
      const v = ans3.trim().toLowerCase();
      doInstallWorker = v === '' || v === 'y' || v === 'yes';
    }
  } else {
    warnings.push('Claude Code not detected — no executable Worker will be configured (doctor will show WARN).');
  }

  // Handle gitignore
  let gitignoreResult: InitResult['gitignore'] = null;
  const giPath = path.join(workspaceRoot, '.gitignore');
  const giExists = fs.existsSync(giPath);
  const giContentExists = giExists ? fs.readFileSync(giPath, 'utf8').split('\n').map((l) => l.trim()).includes('.agent-relay/') || fs.readFileSync(giPath, 'utf8').split('\n').map((l) => l.trim()).includes('.agent-relay') : false;
  if (!giContentExists) {
    let shouldAdd = false;
    if (opts.yes) shouldAdd = true;
    else {
      const ans4 = await ask(`Add .agent-relay/ to .gitignore? [Y/n]: `, 'Y');
      const v2 = ans4.trim().toLowerCase();
      shouldAdd = v2 === '' || v2 === 'y' || v2 === 'yes';
    }
    if (shouldAdd) {
      // atomic via write (ensureGitignore does overwrite)
      const toWrite = giExists
        ? (fs.readFileSync(giPath, 'utf8').endsWith('\n') || fs.readFileSync(giPath, 'utf8') === '' ? fs.readFileSync(giPath, 'utf8') : fs.readFileSync(giPath, 'utf8') + '\n') + '.agent-relay/\n'
        : '.agent-relay/\n';
      // Use atomic write via temp
      const tmp = `${giPath}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(tmp, toWrite, 'utf8');
        fs.renameSync(tmp, giPath);
        gitignoreResult = { added: true, created: !giExists, already: false };
      } catch {
        try { fs.unlinkSync(tmp); } catch {}
        // fallback direct write
        fs.writeFileSync(giPath, toWrite, 'utf8');
        gitignoreResult = { added: true, created: !giExists, already: false };
      }
    } else {
      gitignoreResult = { added: false, created: false, already: false };
      warnings.push('Skipped .gitignore update — .agent-relay/ may be committed with absolute paths.');
    }
  } else {
    gitignoreResult = { added: false, created: false, already: true };
  }

  // Build config
  const config: CliConfig = {
    schemaVersion: CLI_CONFIG_SCHEMA_VERSION,
    project,
    dataRoot,
    workspaceRoot,
  };

  // Atomic write config
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true });
  // If overwriting with --force, ensure we don't delete dataRoot history: just overwrite config file
  atomicWriteJson(configPath, config);

  // Install worker registry if requested
  let workerResult: InitResult['worker'] = null;
  if (doInstallWorker) {
    const workerId = 'claude-code';
    const launchCommand = process.execPath;
    const launchArgsPrefix = [wrapperPath];
    const newRecord: workerRegistry.WorkerRegistryRecord = {
      schemaVersion: 'G.2',
      workerId,
      launchCommand,
      launchArgsPrefix,
      observationAdapterId: 'claude-code',
      driverOptions: { claude: { permissionMode: 'acceptEdits' } },
    };
    // Validate before write
    workerRegistry.validateWorkerRegistryRecord(dataRoot, newRecord, workerId);
    const existingPath = workerRegistry.workerRegistryPath(dataRoot, workerId);
    const exists = fs.existsSync(existingPath);
    let already = false;
    let overwritten = false;
    if (exists) {
      try {
        const existing = workerRegistry.loadWorkerRegistryRecord(dataRoot, workerId);
        const same =
          existing.launchCommand === newRecord.launchCommand &&
          JSON.stringify(existing.launchArgsPrefix) === JSON.stringify(newRecord.launchArgsPrefix) &&
          existing.observationAdapterId === newRecord.observationAdapterId &&
          existing.driverOptions?.claude?.permissionMode === newRecord.driverOptions?.claude?.permissionMode;
        if (same) {
          already = true;
          workerResult = { installed: true, workerId, path: existingPath, already, overwritten };
        } else if (!opts.force) {
          // Different and not forced — skip with warning
          warnings.push(`Worker ${workerId} already exists with different config — use --force to overwrite.`);
          workerResult = { installed: false, workerId, path: existingPath, already: false, overwritten: false, skipped: 'conflicting worker requires --force' };
        } else {
          workerRegistry.writeWorkerRegistryRecord(dataRoot, newRecord);
          overwritten = true;
          workerResult = { installed: true, workerId, path: existingPath, already: false, overwritten };
        }
      } catch {
        if (!opts.force) {
          warnings.push(`Worker ${workerId} exists but unreadable — use --force to overwrite.`);
          workerResult = { installed: false, workerId, path: existingPath, already: false, overwritten: false, skipped: 'unreadable existing' };
        } else {
          workerRegistry.writeWorkerRegistryRecord(dataRoot, newRecord);
          overwritten = true;
          workerResult = { installed: true, workerId, path: existingPath, already: false, overwritten };
        }
      }
    } else {
      workerRegistry.writeWorkerRegistryRecord(dataRoot, newRecord);
      workerResult = { installed: true, workerId, path: existingPath, already: false, overwritten: false };
    }
  } else if (detection.status === 'DETECTED') {
    workerResult = { installed: false, workerId: 'claude-code', path: workerRegistry.workerRegistryPath(dataRoot, 'claude-code'), already: false, overwritten: false, skipped: 'user declined' };
  } else {
    workerResult = null;
  }

  // Ensure dataRoot/_relay exists (for doctor)
  try { fs.mkdirSync(path.join(path.resolve(dataRoot), '_relay'), { recursive: true }); } catch { /* ignore */ }

  // Build MCP command
  const mcpCommand = `"${process.execPath}" "${mcpEntry}" --surface pm --dataRoot "${dataRoot}" --project "${project}"`;
  const mcp = { command: mcpCommand, entry: mcpEntry, surface: 'pm' };

  return {
    schemaVersion: INIT_SCHEMA_VERSION,
    ok: true,
    initialized: true,
    project,
    workspaceRoot,
    dataRoot,
    configPath,
    config,
    gitignore: gitignoreResult,
    claudeDetection: detection,
    worker: workerResult,
    mcp,
    warnings,
  };
}

function ask(question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      if (!ans.trim() && defaultValue) resolve(defaultValue);
      else resolve(ans);
    });
  });
}

export function renderInitHuman(result: InitResult): string {
  const lines: string[] = [];
  lines.push('Agent Relay Setup');
  lines.push('');
  lines.push(`Workspace: ${result.workspaceRoot} ✓`);
  lines.push(`Project: ${result.project}`);
  lines.push(`DataRoot: ${result.dataRoot}`);
  lines.push(`Config: ${result.configPath}`);
  lines.push('');
  if (result.gitignore?.added) lines.push(`✓ .gitignore updated (.agent-relay/)`);
  else if (result.gitignore?.already) lines.push(`✓ .gitignore already excludes .agent-relay/`);
  lines.push('');
  if (result.claudeDetection.status === 'DETECTED') lines.push(`✓ Claude Code detected${result.claudeDetection.version ? ` (${result.claudeDetection.version})` : ''}`);
  else lines.push(`! Claude Code not found`);
  if (result.worker?.installed) {
    if (result.worker.already) lines.push(`✓ Worker claude-code already configured`);
    else if (result.worker.overwritten) lines.push(`✓ Worker claude-code updated (overwritten)`);
    else lines.push(`✓ Worker claude-code configured`);
    lines.push(`  launchCommand: ${process.execPath}`);
  } else if (result.worker?.skipped) {
    lines.push(`! Worker not installed: ${result.worker.skipped}`);
  }
  lines.push('');
  lines.push(`PM MCP command:`);
  lines.push(`  ${result.mcp.command}`);
  lines.push('');
  lines.push('MCP setup: add to your PM client config, e.g. Claude Code:');
  lines.push(`  { "mcpServers": { "agent-relay-pm": { "command": "${process.execPath}", "args": ["${result.mcp.entry}", "--surface", "pm", "--dataRoot", "${result.dataRoot}", "--project", "${result.project}"] } } }`);
  lines.push('');
  if (result.warnings.length) {
    lines.push('Warnings:');
    for (const w of result.warnings) lines.push(`  ! ${w}`);
    lines.push('');
  }
  lines.push('Agent Relay is ready.');
  lines.push('Next: agent-relay doctor / agent-relay status');
  return lines.join('\n');
}
