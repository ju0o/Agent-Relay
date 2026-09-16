import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRoleConfig } from '../roles/role-config.js';
import { getRoleRuntimeAdapter, registerRoleRuntimeAdapter } from '../integrations/core/role-runtime-registry.js';
import type { RoleRuntimeAdapter } from '../integrations/core/role-runtime.js';
import { OpenCodeCommandAdapter } from '../integrations/opencode/command-adapter.js';
import { dispatchV1OwnerApproved } from '../backend/v1-dispatch.js';
import {
  ActlBridgeError,
  buildDefaultInputPermit,
  expectedContextFromActl,
  invokeActlRuntimeOrThrow,
  newRequestId,
  scopeFields,
  setActlInputPermitFactory,
} from '../backend/actl-bridge.js';
import { clearBlockedState, runOnce, type DispatchHook, type RoleLoopConfig } from './role-loop.js';

interface Args {
  dataRoot: string;
  project: string;
  roleConfig: string;
  once?: boolean;
  retryBlocked?: boolean;
  pollMs?: string;
  auditDir: string;
  stateFile: string;
  dispatchHookModule?: string;
  pmSendTimeoutMs?: string;
  maxValidationReasks?: string;
}

const execFileAsync = promisify(execFile);

function idlePromptMatches(agentKind: string, snapshot: string): boolean {
  const lines = snapshot.split(/\r?\n/).slice(-12);
  const text = lines.join('\n');
  if (/Working \(|esc to interrupt|Press enter to continue|Do you trust/.test(text)) return false;
  return agentKind === 'claude' ? lines.some((line) => /^❯/.test(line.trim())) : lines.some((line) => /› Ask Codex to do anything/.test(line));
}

async function captureIdleSnapshot(socketPath: string, paneId: string): Promise<string> {
  try {
    const result = await execFileAsync('tmux', ['-S', path.resolve(socketPath), 'capture-pane', '-p', '-t', paneId, '-S', '-12'], { maxBuffer: 64 * 1024 });
    return result.stdout;
  } catch {
    throw new ActlBridgeError('INPUT_STATE_UNKNOWN', `unable to capture idle prompt from actl pane ${paneId}`, { sideEffect: 'NONE' });
  }
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === '--once') a.once = true;
    else if (k === '--retry-blocked') a.retryBlocked = true;
    else if (k.startsWith('--')) {
      const name = k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      a[name] = argv[++i];
    }
  }
  if (!a.dataRoot || !a.project || !a.roleConfig || !a.auditDir || !a.stateFile) {
    throw new Error('required: --dataRoot --project --role-config --audit-dir --state-file');
  }
  return a as Args;
}

/** "opencode/big-pickle" -> {providerID:'opencode', modelID:'big-pickle'}. Bare id (no slash) -> null (caller uses its own default). */
function parseModelRef(key: string): { providerID: string; modelID: string } | null {
  const idx = key.indexOf('/');
  if (idx < 0) return null;
  return { providerID: key.slice(0, idx), modelID: key.slice(idx + 1) };
}

/** The registry keys by adapter.id (OpenCodeCommandAdapter's is fixed to 'opencode-command'); wrap with a delegating proxy so each distinct model gets its own registry entry. */
function withId(adapter: RoleRuntimeAdapter, id: string): RoleRuntimeAdapter {
  return {
    id,
    health: () => adapter.health(),
    capabilities: () => adapter.capabilities(),
    authMode: () => adapter.authMode(),
    ensureSession: (args) => adapter.ensureSession(args),
    send: (sessionId, envelope) => adapter.send(sessionId, envelope),
    collect: (sessionId, requestId, opts) => adapter.collect(sessionId, requestId, opts),
    interrupt: (sessionId) => adapter.interrupt(sessionId),
    resume: (sessionId) => adapter.resume(sessionId),
    sessionIdentity: (sessionId) => adapter.sessionIdentity(sessionId),
  };
}

/** Register one OpenCodeCommandAdapter per distinct primary+fallback key the pm RoleAssignment names. Idempotent (skips already-registered ids). */
function ensurePmAdaptersRegistered(dataRoot: string, roleConfig: ReturnType<typeof readRoleConfig>): void {
  const pm = roleConfig.assignments.find((a) => a.roleId === 'pm');
  if (!pm) return;
  const keys = [pm.runtimeAdapterId, ...(pm.fallbackChain ?? [])];
  for (const key of keys) {
    if (getRoleRuntimeAdapter(key)) continue;
    const modelRef = parseModelRef(key) ?? (pm.model ? parseModelRef(`opencode/${pm.model}`) : null) ?? { providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' };
    // Cast: WBS-3's OpenCodeCommandAdapter.authMode() is async (Promise-returning)
    // while WBS-2's committed RoleRuntimeAdapter interface declares authMode()
    // sync — a pre-existing drift between those two already-landed lanes, out
    // of scope to fix here. The shape is otherwise identical and role-loop.ts
    // never calls authMode() itself, so this is safe at the call sites that matter.
    const adapter = new OpenCodeCommandAdapter({ defaultModel: modelRef, dataRoot }) as unknown as RoleRuntimeAdapter;
    registerRoleRuntimeAdapter(withId(adapter, key));
  }
}

export function selectBuilderWorker(dataRoot: string, runtimeAdapterId: string) {
  const workerId = runtimeAdapterId.startsWith('actl-managed:') ? runtimeAdapterId.slice('actl-managed:'.length) : runtimeAdapterId;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workerId)) throw new Error(`builder worker id is invalid for ${runtimeAdapterId}`);
  const dir = path.join(path.resolve(dataRoot), '_relay', 'workers');
  const exact = path.join(dir, `${workerId}.json`);
  if (!fs.existsSync(exact)) throw new Error(`builder worker selection is missing for ${runtimeAdapterId}: ${exact}`);
  const read = (file: string): Record<string, any> => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('record is not an object');
      return value as Record<string, any>;
    } catch (error) {
      throw new Error(`builder worker record is unparsable: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const exactRecord = read(exact);
  const matches: Record<string, any>[] = [];
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const file = path.join(dir, name);
    const record = file === exact ? exactRecord : read(file);
    if (record.workerId === workerId) matches.push(record);
  }
  if (matches.length !== 1) throw new Error(`builder worker selection is ambiguous for ${runtimeAdapterId}: ${matches.length} matching records`);
  const worker = matches[0]!;
  if (worker.role !== 'implementation') throw new Error(`builder worker role mismatch for ${runtimeAdapterId}: expected implementation`);
  const hasActlRuntime = typeof worker.driverOptions?.actl?.runtimeId === 'string' && !!worker.driverOptions.actl.runtimeId.trim();
  const hasLaunchCommand = typeof worker.launchCommand === 'string' && !!worker.launchCommand.trim();
  if (!hasActlRuntime && !hasLaunchCommand) {
    throw new Error(`builder worker record is unusable for ${runtimeAdapterId}: expected driverOptions.actl.runtimeId or launchCommand`);
  }
  return worker;
}

function installActlPermitFactory(builder: ReturnType<typeof readRoleConfig>['assignments'][number], worker: Record<string, any>): (() => Promise<string>) | null {
  const actl = worker.driverOptions?.actl;
  if (!actl) {
    setActlInputPermitFactory(null);
    return null;
  }
  const expectedContext = expectedContextFromActl(actl, builder.workspace.workspaceRoot);
  const scope = scopeFields(actl.socketPath);
  const checkReady = async (): Promise<string> => {
    const status = await invokeActlRuntimeOrThrow(worker.launchCommand, 'status', {
      contractVersion: 1,
      requestId: newRequestId(),
      operation: 'status',
      runtimeId: actl.runtimeId,
      expectedContext,
      ...scope,
    });
    const data = status.data;
    if (data.runtimeId !== actl.runtimeId) throw new ActlBridgeError('MISMATCH', 'actl status runtimeId does not match the configured worker', { sideEffect: 'NONE' });
    const context = data.context && typeof data.context === 'object' ? data.context as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(expectedContext)) {
      if (context[key] !== value) throw new ActlBridgeError('MISMATCH', `actl status context mismatch for ${key}`, { sideEffect: 'NONE' });
    }
    if (typeof context.paneId !== 'string' || !context.paneId.trim()) throw new ActlBridgeError('INPUT_STATE_UNKNOWN', 'actl status omitted the target pane identity', { sideEffect: 'NONE' });
    const snapshotHash = typeof data.currentSnapshotHash === 'string' ? data.currentSnapshotHash.trim() : '';
    if (!snapshotHash) throw new ActlBridgeError('INPUT_STATE_UNKNOWN', 'actl status omitted currentSnapshotHash', { sideEffect: 'NONE' });
    if (data.inputState !== 'READY') {
      const inlineSnapshot = [data.snapshotText, data.snapshot, (data.identityEvidence as Record<string, unknown> | undefined)?.snapshotText]
        .find((value): value is string => typeof value === 'string');
      const snapshot = inlineSnapshot ?? await captureIdleSnapshot(actl.socketPath, context.paneId);
      if (!idlePromptMatches(actl.agentKind, snapshot)) throw new ActlBridgeError('INPUT_STATE_UNKNOWN', 'actl target pane is not idle at its prompt', { sideEffect: 'NONE' });
    }
    return snapshotHash;
  };
  // The orchestrator is the owner-approved dispatcher within this authorized project scope.
  setActlInputPermitFactory(async (args) => {
    if (args.runtimeId !== actl.runtimeId) {
      throw new ActlBridgeError('MISMATCH', `inputPermit runtimeId mismatch: expected ${actl.runtimeId}, got ${args.runtimeId}`, { sideEffect: 'NONE' });
    }
    const snapshotHash = await checkReady();
    return buildDefaultInputPermit({ ...args, snapshotHash, confirmedAt: new Date().toISOString() });
  });
  return checkReady;
}

export function defaultDispatchHook(dataRoot: string, roleConfig: ReturnType<typeof readRoleConfig>): DispatchHook {
  const builder = roleConfig.assignments.find((a) => a.roleId === 'builder');
  const worker = builder ? selectBuilderWorker(dataRoot, builder.runtimeAdapterId) : null;
  const checkReady = builder && worker ? installActlPermitFactory(builder, worker) : null;
  return async (dr, project, task) => {
    if (!builder || !worker) throw new Error('no builder RoleAssignment/worker-registry record (role: implementation) available for dispatch');
    if (checkReady) await checkReady();
    return dispatchV1OwnerApproved(dr, project, {
      taskId: task.taskId,
      workerId: worker.workerId,
      workspaceRoot: builder.workspace.workspaceRoot,
      expectedExecutionState: 'READY',
    });
  };
}

async function buildConfig(a: Args): Promise<RoleLoopConfig> {
  const roleConfig = readRoleConfig(a.dataRoot, a.project);
  ensurePmAdaptersRegistered(a.dataRoot, roleConfig);
  const pm = roleConfig.assignments.find((r) => r.roleId === 'pm');
  if (!pm) throw new Error(`role config for ${a.project} has no pm RoleAssignment`);
  const pmAdapter = getRoleRuntimeAdapter(pm.runtimeAdapterId);
  if (!pmAdapter) throw new Error(`pm adapter "${pm.runtimeAdapterId}" is not registered`);

  const dispatchHook: DispatchHook = a.dispatchHookModule
    ? (await import(a.dispatchHookModule)).default
    : defaultDispatchHook(a.dataRoot, roleConfig);

  return {
    dataRoot: a.dataRoot,
    project: a.project,
    roleConfig,
    pmAdapter,
    dispatchHook,
    auditDir: a.auditDir,
    stateFile: a.stateFile,
    pmSendTimeoutMs: a.pmSendTimeoutMs ? Number(a.pmSendTimeoutMs) : undefined,
    maxValidationReasks: a.maxValidationReasks ? Number(a.maxValidationReasks) : undefined,
    resolveAdapter: (id) => getRoleRuntimeAdapter(id),
  };
}

async function run(a: Args): Promise<void> {
  const cfg = await buildConfig(a);
  if (a.retryBlocked) {
    clearBlockedState(a.stateFile);
    a.retryBlocked = false;
  }
  await runOnce(cfg);
}

if (require.main === module) {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (a.pollMs && !a.once) {
      setInterval(() => {
        run(a).catch((e) => console.error(String(e)));
      }, Number(a.pollMs));
    } else {
      run(a).catch((e) => {
        console.error(String(e));
        process.exitCode = 1;
      });
    }
  } catch (e) {
    console.error(String(e));
    process.exitCode = 1;
  }
}

export { parseArgs, buildConfig, run, clearBlockedState };
