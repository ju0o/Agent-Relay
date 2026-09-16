import { RoleRuntimeAdapter } from './role-runtime.js';
import { RoleCapabilityFlags, RoleAssignment } from '../../roles/role-config.js';
const adapters = new Map<string, RoleRuntimeAdapter>();
export function registerRoleRuntimeAdapter(adapter: RoleRuntimeAdapter): void { if (!adapter || !adapter.id) throw new Error('Invalid adapter.id: required'); if (adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`); adapters.set(adapter.id, adapter); }
export function getRoleRuntimeAdapter(id: string): RoleRuntimeAdapter | null { return adapters.get(id) ?? null; }
export function listRoleRuntimeAdapters(): RoleRuntimeAdapter[] { return [...adapters.values()]; }
export function clearRoleRuntimeAdapters(): void { adapters.clear(); }
export function assertRoleSatisfiable(assignment: RoleAssignment, adapter: RoleRuntimeAdapter): void { const missing = (Object.keys(assignment.capabilityRequirements) as (keyof RoleCapabilityFlags)[]).filter(k => assignment.capabilityRequirements[k] === true && adapter.capabilities()[k] !== true); if (missing.length) throw new Error(`ROLE_CAPABILITY_MISMATCH: ${assignment.roleId} requires missing capabilities: ${missing.join(', ')}`); }
export function resolveRoleRuntime(assignment: RoleAssignment): RoleRuntimeAdapter { const adapter = getRoleRuntimeAdapter(assignment.runtimeAdapterId); if (!adapter) throw new Error(`ROLE_CAPABILITY_MISMATCH: adapter ${assignment.runtimeAdapterId} is not registered`); assertRoleSatisfiable(assignment, adapter); return adapter; }
