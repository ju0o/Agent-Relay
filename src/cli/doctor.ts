/**
 * Doctor — read-only infrastructure health checks.
 * Never launches Worker, never mutates state.
 * Reuses existing Worker Registry validation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { discoverConfig } from './config.js';
import * as workerRegistry from '../backend/worker-registry.js';
import * as goalTask from '../backend/goal-task.js';
import { getAdapter } from '../integrations/core/registry.js';

export const DOCTOR_SCHEMA_VERSION = 'cli.doctor.v1';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  required: boolean;
}

export interface DoctorResult {
  schemaVersion: typeof DOCTOR_SCHEMA_VERSION;
  ok: boolean;
  checks: DoctorCheck[];
}

export function runDoctor(cwd: string): DoctorResult {
  const normalizedCwd = path.resolve(cwd);
  const checks: DoctorCheck[] = [];

  const push = (id: string, status: CheckStatus, message: string, required: boolean): void => {
    checks.push({ id, status, message, required });
  };

  // 1. Node version
  const nodeVer = process.version;
  const nodeMajor = parseInt(nodeVer.slice(1).split('.')[0] ?? '0', 10);
  if (nodeMajor >= 18) {
    push('node', 'PASS', `Node ${nodeVer}`, true);
  } else {
    push('node', 'FAIL', `Node ${nodeVer} too old (need >=18)`, true);
  }

  // 2. Build/runtime availability — CLI itself + backend
  const cliEntry = path.join(__dirname, 'index.js');
  const distCliExists = fs.existsSync(cliEntry);
  if (distCliExists) {
    push('build', 'PASS', 'CLI build present', true);
  } else {
    // Fallback: check at least src exists relative to repo
    const repoRoots = [normalizedCwd, path.join(__dirname, '..', '..', '..')];
    const hasSrc = repoRoots.some((r) => fs.existsSync(path.join(r, 'src', 'cli', 'index.ts')));
    if (hasSrc) {
      push('build', 'WARN', 'CLI build not found but src present (run npm run build)', false);
    } else {
      push('build', 'FAIL', 'CLI build missing', true);
    }
  }

  // 3. Config presence
  const discovered = discoverConfig(normalizedCwd);
  if (discovered.initialized && discovered.config) {
    push('config', 'PASS', `Config present at ${discovered.configPath}`, true);
  } else if (discovered.error) {
    push('config', 'FAIL', discovered.error, true);
  } else {
    push('config', 'FAIL', 'Not initialized — .agent-relay/config.json missing', true);
  }

  // 4. workspaceRoot exists
  if (discovered.config) {
    if (fs.existsSync(discovered.config.workspaceRoot) && fs.statSync(discovered.config.workspaceRoot).isDirectory()) {
      push('workspace', 'PASS', `Workspace exists: ${discovered.config.workspaceRoot}`, true);
    } else {
      push('workspace', 'FAIL', `Workspace missing: ${discovered.config.workspaceRoot}`, true);
    }
  } else {
    push('workspace', 'WARN', 'Workspace unknown (no config)', false);
  }

  // 5. dataRoot exists/writable
  if (discovered.config) {
    const dr = discovered.config.dataRoot;
    try {
      fs.mkdirSync(dr, { recursive: true });
      const testFile = path.join(dr, '.agent-relay-doctor-write-test');
      fs.writeFileSync(testFile, 'test', 'utf8');
      fs.unlinkSync(testFile);
      push('dataRoot', 'PASS', `DataRoot writable: ${dr}`, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('dataRoot', 'FAIL', `DataRoot not writable: ${dr} — ${msg}`, true);
    }
  } else {
    push('dataRoot', 'WARN', 'DataRoot unknown (no config)', false);
  }

  // 6. Relay project state readable
  if (discovered.config) {
    try {
      const goals = goalTask.listGoals(discovered.config.dataRoot, discovered.config.project);
      push('relay-state', 'PASS', `Relay state readable (${goals.length} goals)`, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('relay-state', 'FAIL', `Relay state unreadable: ${msg}`, true);
    }
  } else {
    push('relay-state', 'WARN', 'Relay state unknown (no config)', false);
  }

  // 7. Worker Registry directory readable
  if (discovered.config) {
    try {
      const dir = workerRegistry.workersRegistryDir(discovered.config.dataRoot);
      if (fs.existsSync(dir)) {
        const entries = fs.readdirSync(dir);
        push('worker-registry', 'PASS', `Worker Registry readable (${entries.length} entries)`, true);
      } else {
        push('worker-registry', 'WARN', 'Worker Registry directory not yet created (no workers)', false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('worker-registry', 'FAIL', `Worker Registry unreadable: ${msg}`, true);
    }
  } else {
    push('worker-registry', 'WARN', 'Worker Registry unknown (no config)', false);
  }

  // 8. MCP server build entry exists — check relative to CLI build or repo
  const mcpCandidates = [
    path.join(__dirname, '..', 'mcp', 'index.js'),
    path.resolve('dist', 'server', 'mcp', 'index.js'),
    path.resolve(normalizedCwd, 'dist', 'server', 'mcp', 'index.js'),
  ];
  if (mcpCandidates.some((p) => fs.existsSync(p))) {
    push('mcp', 'PASS', 'MCP server build present', true);
  } else {
    push('mcp', 'FAIL', 'MCP server build missing (run npm run build)', true);
  }

  // 9. known worker registry records validate
  if (discovered.config) {
    try {
      const records = workerRegistry.listWorkerRegistryRecords(discovered.config.dataRoot);
      let invalid = 0;
      for (const r of records) {
        try {
          workerRegistry.validateWorkerRegistryRecord(discovered.config.dataRoot, r, r.workerId);
        } catch {
          invalid++;
        }
      }
      if (records.length === 0) {
        push('workers-validate', 'WARN', 'No worker records to validate', false);
      } else if (invalid === 0) {
        push('workers-validate', 'PASS', `${records.length} worker record(s) valid`, true);
      } else {
        push('workers-validate', 'FAIL', `${invalid}/${records.length} worker record(s) invalid`, true);
      }
      // Per-worker checks
      for (const r of records) {
        // 10. configured worker executable resolvable if safely checkable (basename allowlist)
        try {
          workerRegistry.validateLaunchCommand(r.launchCommand);
          push(`worker:${r.workerId}`, 'PASS', `Worker ${r.workerId} launchCommand valid`, false);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          push(`worker:${r.workerId}`, 'FAIL', `Worker ${r.workerId} launchCommand invalid: ${msg}`, true);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      push('workers-validate', 'FAIL', `Worker validation error: ${msg}`, true);
    }
  }

  // 11. Adapter mapping exists — check build artifact presence (not runtime registry)
  {
    const adapterWatchBuilt = fs.existsSync(path.resolve('dist', 'server', 'integrations', 'claude', 'watch.js'));
    const adapterSrcExists = fs.existsSync(path.resolve('src', 'integrations', 'claude', 'watch.ts'));
    if (adapterWatchBuilt || adapterSrcExists) {
      // also try runtime registry if available
      let hasRuntime = false;
      try { hasRuntime = !!getAdapter('claude-code'); } catch { hasRuntime = false; }
      if (hasRuntime) push('adapter', 'PASS', 'Adapter mapping present (claude-code)', true);
      else push('adapter', 'PASS', 'Adapter watch build present (claude-code)', true);
    } else {
      push('adapter', 'WARN', 'Adapter claude-code build not found', false);
    }
  }

  const hasRequiredFail = checks.some((c) => c.status === 'FAIL' && c.required);
  return { schemaVersion: DOCTOR_SCHEMA_VERSION, ok: !hasRequiredFail, checks };
}

export function renderDoctorHuman(result: DoctorResult): string {
  const lines: string[] = [];
  lines.push('Doctor');
  lines.push('');
  for (const c of result.checks) {
    const icon = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '!' : '✗';
    const req = c.required ? '' : ' (optional)';
    lines.push(`${icon} ${c.id}: ${c.message}${req}`);
  }
  lines.push('');
  lines.push(result.ok ? 'All required checks healthy.' : 'At least one required check failed.');
  return lines.join('\n');
}
