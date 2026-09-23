import { RoleRuntimeAdapter } from './role-runtime.js';
import { RoleCapabilityFlags, RoleAssignment } from '../../roles/role-config.js';
const adapters = new Map<string, RoleRuntimeAdapter>();
export function registerRoleRuntimeAdapter(adapter: RoleRuntimeAdapter): void { if (!adapter || !adapter.id) throw new Error('Invalid adapter.id: required'); if (adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`); adapters.set(adapter.id, adapter); }
export function getRoleRuntimeAdapter(id: string): RoleRuntimeAdapter | null { return adapters.get(id) ?? null; }
export function listRoleRuntimeAdapters(): RoleRuntimeAdapter[] { return [...adapters.values()]; }
export function clearRoleRuntimeAdapters(): void { adapters.clear(); }
export function assertRoleSatisfiable(assignment: RoleAssignment, adapter: RoleRuntimeAdapter): void { const missing = (Object.keys(assignment.capabilityRequirements) as (keyof RoleCapabilityFlags)[]).filter(k => assignment.capabilityRequirements[k] === true && adapter.capabilities()[k] !== true); if (missing.length) throw new Error(`ROLE_CAPABILITY_MISMATCH: ${assignment.roleId} requires missing capabilities: ${missing.join(', ')}`); }
export function resolveRoleRuntime(assignment: RoleAssignment): RoleRuntimeAdapter { const adapter = getRoleRuntimeAdapter(assignment.runtimeAdapterId); if (!adapter) throw new Error(`ROLE_CAPABILITY_MISMATCH: adapter ${assignment.runtimeAdapterId} is not registered`); assertRoleSatisfiable(assignment, adapter); return adapter; }

/**
 * Resolve any role's runtime, falling through only to registered adapters
 * that satisfy that role's capability contract.  The caller supplies the
 * primary-health/limit decision because the registry has no billing or
 * provider-quota knowledge.  Builder/QA integrations can use this seam
 * without silently treating an unrelated worker record as an adapter.
 */
export function resolveRoleRuntimeWithFallback(
  assignment: RoleAssignment,
  options: { primaryUsable?: (adapter: RoleRuntimeAdapter) => boolean; resolve?: (id: string) => RoleRuntimeAdapter | null } = {},
): RoleRuntimeAdapter {
  const resolve = options.resolve ?? getRoleRuntimeAdapter;
  const candidates = [assignment.runtimeAdapterId, ...(assignment.fallbackChain ?? [])];
  const failures: string[] = [];
  for (const [index, id] of candidates.entries()) {
    const adapter = resolve(id);
    if (!adapter) { failures.push(`${id}: unregistered`); continue; }
    if (index === 0 && options.primaryUsable && !options.primaryUsable(adapter)) {
      failures.push(`${id}: primary unavailable`);
      continue;
    }
    try {
      assertRoleSatisfiable(assignment, adapter);
      return adapter;
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`ROLE_CAPABILITY_MISMATCH: no usable runtime for ${assignment.roleId}; ${failures.join('; ') || 'empty runtime chain'}`);
}
