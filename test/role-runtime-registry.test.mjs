import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerRoleRuntimeAdapter, clearRoleRuntimeAdapters, assertRoleSatisfiable, resolveRoleRuntime } from '../dist/server/integrations/core/role-runtime-registry.js';
import { ensureRoleSession, readRoleSession } from '../dist/server/integrations/core/role-runtime.js';

const adapter = { id: 'fake', health: async () => ({ ok: true }), capabilities: () => ({ persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: true, shell: false, subscriptionAuth: false, freeTier: true }), authMode: () => ({ mode: 'free' }), ensureSession: async () => ({ sessionId: 's1', created: true }), send: async () => ({ requestId: 'r1' }), collect: async () => ({ text: 'ok', structured: { ok: true } }), interrupt: async () => {}, resume: async () => ({ ok: true }), sessionIdentity: (sessionId) => ({ adapterId: 'fake', sessionId }) };
const assignment = { roleId: 'builder', runtimeAdapterId: 'fake', workspace: { project: 'P', workspaceRoot: '/tmp/P' }, sessionPolicy: 'persistent', permissionProfile: 'write-workspace', capabilityRequirements: { writeWorkspace: true }, zeroExtraBilling: true, fallbackChain: [], enabled: true };

test('capability mismatch is ROLE_CAPABILITY_MISMATCH and fake adapter passes registry assertions', async () => { clearRoleRuntimeAdapters(); registerRoleRuntimeAdapter(adapter); assert.doesNotThrow(() => assertRoleSatisfiable(assignment, adapter)); assert.throws(() => assertRoleSatisfiable({ ...assignment, capabilityRequirements: { shell: true } }, adapter), /ROLE_CAPABILITY_MISMATCH/); assert.equal(resolveRoleRuntime(assignment), adapter); });
test('session bookkeeping persists and full ensureSession send collect cycle works', async () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-')); const s = await ensureRoleSession(root, assignment, adapter); assert.equal(s.sessionId, 's1'); assert.deepEqual(await adapter.send(s.sessionId, { kind: 'TASK_CONTRACT', schemaVersion: 'v1', contextHash: 'h', body: 'body' }), { requestId: 'r1' }); assert.equal((await adapter.collect(s.sessionId, 'r1', { timeoutMs: 100 })).text, 'ok'); assert.equal(readRoleSession(root, 'P', 'builder').sessionId, 's1'); });
