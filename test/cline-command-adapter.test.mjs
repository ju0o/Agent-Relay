import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClineCommandAdapter } from '../dist/server/integrations/cline/command-adapter.js';

test('ClineCommandAdapter uses JSON OAuth-provider CLI, writes in cwd, and persists resumable session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-adapter-'));
  const workspace = path.join(root, 'workspace');
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(workspace);
  const fake = path.join(root, 'fake-cline.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
    import fs from 'node:fs';
    const cwd = process.argv[process.argv.indexOf('--cwd') + 1];
    fs.writeFileSync(cwd + '/adapter-output.txt', 'ADAPTER_OK\\n');
    console.log(JSON.stringify({type:'hook_event', taskId:'cline-test-session'}));
    console.log(JSON.stringify({type:'run_result', text:'JSON_RESULT_OK'}));
  `);
  fs.chmodSync(fake, 0o755);
  const adapter = new ClineCommandAdapter({ command: fake, cwd: workspace, dataRoot, provider: 'cline-pass' });
  assert.equal(adapter.capabilities().writeWorkspace, true);
  assert.equal(adapter.capabilities().structuredOutput, true);
  assert.deepEqual(adapter.authMode(), { mode: 'oauth-subscription', provider: 'cline-pass' });
  const session = await adapter.ensureSession({ roleId: 'builder', project: 'P', sessionPolicy: 'persistent', sessionKey: 'P:builder' });
  const request = await adapter.send(session.sessionId, { kind: 'TASK_CONTRACT', schemaVersion: 'v1', contextHash: 'h', body: 'write output' });
  assert.equal((await adapter.collect(session.sessionId, request.requestId)).text, 'JSON_RESULT_OK');
  assert.equal(fs.readFileSync(path.join(workspace, 'adapter-output.txt'), 'utf8').trim(), 'ADAPTER_OK');
  const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, '_relay/role-sessions/P/builder.json'), 'utf8'));
  assert.equal(saved.sessionId, 'cline-test-session');
  assert.equal((await adapter.ensureSession({ roleId: 'builder', project: 'P', sessionPolicy: 'persistent', sessionKey: 'P:builder' })).created, false);
});
