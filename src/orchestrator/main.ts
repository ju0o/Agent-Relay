import { readRoleConfig } from '../roles/role-config.js';
import { getRoleRuntimeAdapter, registerRoleRuntimeAdapter } from '../integrations/core/role-runtime-registry.js';
import type { RoleRuntimeAdapter } from '../integrations/core/role-runtime.js';
import { OpenCodeCommandAdapter } from '../integrations/opencode/command-adapter.js';
import { listWorkerRegistryRecords } from '../backend/worker-registry.js';
import { dispatchV1OwnerApproved } from '../backend/v1-dispatch.js';
import { runOnce, type DispatchHook, type RoleLoopConfig } from './role-loop.js';

interface Args {
  dataRoot: string;
  project: string;
  roleConfig: string;
  once?: boolean;
  pollMs?: string;
  auditDir: string;
  stateFile: string;
  dispatchHookModule?: string;
  pmSendTimeoutMs?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === '--once') a.once = true;
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

export function selectBuilderWorker(records: ReturnType<typeof listWorkerRegistryRecords>, runtimeAdapterId: string) {
  const workerId = runtimeAdapterId.startsWith('actl-managed:') ? runtimeAdapterId.slice('actl-managed:'.length) : runtimeAdapterId;
  const matches = records.filter((record) => record.role === 'implementation' && record.workerId === workerId);
  if (matches.length !== 1) throw new Error(`builder worker selection is ${matches.length === 0 ? 'missing' : 'ambiguous'} for ${runtimeAdapterId}`);
  return matches[0]!;
}

function defaultDispatchHook(dataRoot: string, roleConfig: ReturnType<typeof readRoleConfig>): DispatchHook {
  return async (dr, project, task) => {
    const builder = roleConfig.assignments.find((a) => a.roleId === 'builder');
    const worker = builder ? selectBuilderWorker(listWorkerRegistryRecords(dr), builder.runtimeAdapterId) : null;
    if (!builder || !worker) throw new Error('no builder RoleAssignment/worker-registry record (role: implementation) available for dispatch');
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
    resolveAdapter: (id) => getRoleRuntimeAdapter(id),
  };
}

async function run(a: Args): Promise<void> {
  const cfg = await buildConfig(a);
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

export { parseArgs, buildConfig, run };
