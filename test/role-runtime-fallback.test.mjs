import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRoleRuntimeAdapters, registerRoleRuntimeAdapter, resolveRoleRuntimeWithFallback } from '../dist/server/integrations/core/role-runtime-registry.js';

const caps = (writeWorkspace = false) => ({ persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace, shell: false, subscriptionAuth: false, freeTier: true });
const adapter = (id, writeWorkspace = false) => ({ id, health: async () => ({ ok: true }), capabilities: () => caps(writeWorkspace), authMode: () => ({ mode: 'free' }), ensureSession: async () => ({ sessionId: id, created: true }), send: async () => ({ requestId: id }), collect: async () => ({ text: '' }), interrupt: async () => {}, resume: async () => ({ ok: true }), sessionIdentity: (sessionId) => ({ adapterId: id, sessionId }) });
const assignment = (roleId, primary, fallbackChain, capabilityRequirements = {}) => ({ roleId, runtimeAdapterId: primary, workspace: { project: 'P', workspaceRoot: '/tmp/P' }, sessionPolicy: 'per-task', permissionProfile: roleId === 'builder' ? 'write-workspace' : 'read-only', capabilityRequirements, zeroExtraBilling: true, fallbackChain, enabled: true });

test('builder and qa role chains select the registered capable fallback after primary exhaustion', () => {
  clearRoleRuntimeAdapters();
  const builderFallback = adapter('builder-fallback', true);
  const qaFallback = adapter('qa-fallback');
  registerRoleRuntimeAdapter(adapter('builder-primary', true));
  registerRoleRuntimeAdapter(builderFallback);
  registerRoleRuntimeAdapter(adapter('qa-primary'));
  registerRoleRuntimeAdapter(qaFallback);
  assert.equal(resolveRoleRuntimeWithFallback(assignment('builder', 'builder-primary', ['builder-fallback'], { writeWorkspace: true }), { primaryUsable: () => false }), builderFallback);
  assert.equal(resolveRoleRuntimeWithFallback(assignment('qa', 'qa-primary', ['qa-fallback']), { primaryUsable: () => false }), qaFallback);
});

test('role fallback remains fail-closed on missing or incapable entries', () => {
  clearRoleRuntimeAdapters();
  registerRoleRuntimeAdapter(adapter('qa-primary'));
  assert.throws(() => resolveRoleRuntimeWithFallback(assignment('builder', 'qa-primary', ['missing'], { writeWorkspace: true })), /ROLE_CAPABILITY_MISMATCH/);
});
