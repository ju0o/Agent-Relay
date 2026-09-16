import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultV1RoleGraph, validateRoleConfig, validateRoleGraph, writeRoleConfig, readRoleConfig } from '../dist/server/roles/role-config.js';

const caps = { persistentSession: true, structuredInput: true, structuredOutput: true, readWorkspace: true, writeWorkspace: true, shell: true, subscriptionAuth: true, freeTier: true };
const assignment = (extra = {}) => ({ roleId: 'builder', runtimeAdapterId: 'fake', workspace: { project: 'P', workspaceRoot: '/tmp/P' }, sessionPolicy: 'persistent', permissionProfile: 'write-workspace', capabilityRequirements: { writeWorkspace: true }, zeroExtraBilling: true, fallbackChain: [], enabled: true, ...extra });
const config = () => ({ schema_version: 'role-config.v1', project: 'P', assignments: [assignment()], graph: defaultV1RoleGraph() });

test('default V1 graph validates', () => assert.doesNotThrow(() => validateRoleConfig(config(), () => caps)));
test('unknown role and envelope are rejected with field names', () => { const g = defaultV1RoleGraph(); g[0] = { ...g[0], from: 'bad' }; assert.throws(() => validateRoleGraph(g), /graph\[0\]\.from/); const h = defaultV1RoleGraph(); h[0] = { ...h[0], envelope: 'bad' }; assert.throws(() => validateRoleGraph(h), /envelope/); });
test('zeroExtraBilling false is rejected', () => assert.throws(() => validateRoleConfig({ ...config(), assignments: [assignment({ zeroExtraBilling: false })] }), /zeroExtraBilling/));
test('PM write permission is rejected', () => assert.throws(() => validateRoleConfig({ ...config(), assignments: [assignment({ roleId: 'pm', permissionProfile: 'shell' })] }), /permissionProfile/));
test('capability mismatch names ROLE_CAPABILITY_MISMATCH', () => assert.throws(() => validateRoleConfig(config(), () => ({ ...caps, writeWorkspace: false })), /capabilityRequirements\.writeWorkspace/));
test('role config round trip uses atomic file replacement', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-')); writeRoleConfig(root, 'P', config()); assert.deepEqual(readRoleConfig(root, 'P'), config()); assert.ok(fs.existsSync(path.join(root, '_relay/roles/P.json'))); });
