import * as fs from 'node:fs';
import * as path from 'node:path';

export const ROLE_IDS = ['pm', 'builder', 'qa', 'architect'] as const;
export type RoleId = typeof ROLE_IDS[number];
export const ROLE_ENVELOPES = ['TASK_CONTRACT', 'RESULT', 'CHANGES', 'PASS', 'BLOCKED_GATE', 'NEXT_TASK', 'OWNER_REQUIRED'] as const;
export type RoleEnvelope = typeof ROLE_ENVELOPES[number];
export type RoleCapabilityFlags = { persistentSession: boolean; structuredInput: boolean; structuredOutput: boolean; readWorkspace: boolean; writeWorkspace: boolean; shell: boolean; subscriptionAuth: boolean; freeTier: boolean };
export type RoleAssignment = { roleId: RoleId; runtimeAdapterId: string; provider?: string; model?: string; workspace: { project: string; workspaceRoot: string }; sessionPolicy: 'persistent' | 'per-task'; permissionProfile: 'read-only' | 'write-workspace' | 'shell'; capabilityRequirements: Partial<RoleCapabilityFlags>; zeroExtraBilling: true; fallbackChain: string[]; enabled: boolean };
export type RoleGraphEdge = { from: RoleId | 'owner'; to: RoleId | 'owner'; envelope: RoleEnvelope };
export type RoleConfig = { schema_version: 'role-config.v1'; project: string; assignments: RoleAssignment[]; graph: RoleGraphEdge[] };
const roles = new Set<string>(ROLE_IDS); const envelopes = new Set<string>(ROLE_ENVELOPES);
const requiredCapabilities = Object.keys({ persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: true, shell: true, subscriptionAuth: true, freeTier: true }) as (keyof RoleCapabilityFlags)[];
const fail = (field: string, detail: string): never => { throw new Error(`Invalid ${field}: ${detail}`); };

export function defaultV1RoleGraph(): RoleGraphEdge[] { return [
  { from: 'pm', to: 'builder', envelope: 'TASK_CONTRACT' }, { from: 'builder', to: 'qa', envelope: 'RESULT' },
  { from: 'qa', to: 'builder', envelope: 'CHANGES' }, { from: 'qa', to: 'pm', envelope: 'PASS' },
  { from: 'qa', to: 'pm', envelope: 'BLOCKED_GATE' }, { from: 'pm', to: 'builder', envelope: 'CHANGES' },
  { from: 'pm', to: 'builder', envelope: 'NEXT_TASK' }, { from: 'pm', to: 'owner', envelope: 'OWNER_REQUIRED' },
]; }
export function defaultV1RoleConfig(project: string, assignments: RoleAssignment[] = []): RoleConfig { return { schema_version: 'role-config.v1', project, assignments, graph: defaultV1RoleGraph() }; }
export function validateRoleGraph(graph: unknown): asserts graph is RoleGraphEdge[] {
  if (!Array.isArray(graph)) fail('graph', 'must be an array'); const seen = new Set<string>(); const edges = graph as any[];
  edges.forEach((e: any, i: number) => { if (!e || typeof e !== 'object') fail(`graph[${i}]`, 'must be an object'); const x = e as any;
    if (!roles.has(x.from) && x.from !== 'owner') fail(`graph[${i}].from`, 'unknown role'); if (!roles.has(x.to) && x.to !== 'owner') fail(`graph[${i}].to`, 'unknown role'); if (!envelopes.has(x.envelope)) fail(`graph[${i}].envelope`, 'unknown envelope'); const key = `${x.from}|${x.to}|${x.envelope}`; if (seen.has(key)) fail(`graph[${i}]`, 'duplicate edge'); seen.add(key); });
}
export function validateRoleAssignment(a: unknown, capabilities?: (adapterId: string) => RoleCapabilityFlags | undefined): asserts a is RoleAssignment {
  if (!a || typeof a !== 'object') fail('assignment', 'must be an object'); const x = a as any;
  if (!roles.has(x.roleId)) fail('roleId', 'unknown role'); if (typeof x.runtimeAdapterId !== 'string' || !x.runtimeAdapterId) fail('runtimeAdapterId', 'must be non-empty');
  if (!x.workspace || typeof x.workspace.project !== 'string' || !x.workspace.project || typeof x.workspace.workspaceRoot !== 'string' || !x.workspace.workspaceRoot) fail('workspace', 'project and workspaceRoot are required');
  if (!['persistent', 'per-task'].includes(x.sessionPolicy)) fail('sessionPolicy', 'invalid value'); if (!['read-only', 'write-workspace', 'shell'].includes(x.permissionProfile)) fail('permissionProfile', 'invalid value');
  if (x.roleId === 'pm' && x.permissionProfile !== 'read-only') fail('permissionProfile', 'pm must be read-only in V1'); if (x.zeroExtraBilling !== true) fail('zeroExtraBilling', 'must be true'); if (!Array.isArray(x.fallbackChain) || x.fallbackChain.some((v: unknown) => typeof v !== 'string')) fail('fallbackChain', 'must be string[]'); if (typeof x.enabled !== 'boolean') fail('enabled', 'must be boolean');
  if (!x.capabilityRequirements || typeof x.capabilityRequirements !== 'object') fail('capabilityRequirements', 'must be an object'); for (const k of Object.keys(x.capabilityRequirements)) { if (!requiredCapabilities.includes(k as any)) fail(`capabilityRequirements.${k}`, 'unknown capability'); if (typeof x.capabilityRequirements[k] !== 'boolean') fail(`capabilityRequirements.${k}`, 'must be boolean'); }
  if (capabilities && x.enabled) { const actual = capabilities(x.runtimeAdapterId); if (!actual) fail('runtimeAdapterId', 'adapter not registered'); const actualCaps = actual as RoleCapabilityFlags; for (const k of requiredCapabilities) if (x.capabilityRequirements[k] === true && actualCaps[k] !== true) fail(`capabilityRequirements.${k}`, 'adapter capability is missing'); }
}
export function validateRoleConfig(config: unknown, capabilities?: (adapterId: string) => RoleCapabilityFlags | undefined): asserts config is RoleConfig {
  if (!config || typeof config !== 'object') fail('config', 'must be an object'); const x = config as any; if (x.schema_version !== 'role-config.v1') fail('schema_version', 'must be role-config.v1'); if (typeof x.project !== 'string' || !x.project) fail('project', 'must be non-empty'); if (!Array.isArray(x.assignments)) fail('assignments', 'must be an array'); const seen = new Set<string>(); x.assignments.forEach((a: unknown, i: number) => { validateRoleAssignment(a, capabilities); if (seen.has((a as any).roleId)) fail(`assignments[${i}].roleId`, 'duplicate role'); seen.add((a as any).roleId); }); validateRoleGraph(x.graph); }
export function roleConfigPath(dataRoot: string, project: string): string { if (!project || project.includes('/') || project.includes('\\') || project === '.' || project === '..') fail('project', 'must be a safe name'); return path.join(dataRoot, '_relay', 'roles', `${project}.json`); }
export function readRoleConfig(dataRoot: string, project: string): RoleConfig { const file = roleConfigPath(dataRoot, project); let value: unknown; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('config', `cannot read ${file}`); } validateRoleConfig(value); return value; }
export function writeRoleConfig(dataRoot: string, project: string, config: RoleConfig): RoleConfig { validateRoleConfig(config); if (config.project !== project) fail('project', 'does not match path'); const file = roleConfigPath(dataRoot, project); fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n'); fs.renameSync(tmp, file); return config; }
