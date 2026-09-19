import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAutonomousPmAction } from '../dist/server/orchestrator/autonomous-actions.js';
import { TmuxRoleRuntimeAdapter } from '../dist/server/integrations/tmux/role-runtime-adapter.js';

test('autonomous PM actions accept only the first-line action vocabulary', () => {
  assert.deepEqual(parseAutonomousPmAction('DISPATCH\n{"taskId":"TASK-1"}'), { action: 'DISPATCH', taskId: 'TASK-1' });
  assert.throws(() => parseAutonomousPmAction('maybe DISPATCH'), /PM_ACTION_AMBIGUOUS/);
  assert.throws(() => parseAutonomousPmAction('DISPATCH\nnot-json'), /PM_ACTION_AMBIGUOUS/);
});

test('generic tmux adapter keeps project, role, runtime, and live session identity', async () => {
  const adapter = new TmuxRoleRuntimeAdapter({ targets: { pm: '%999999' } });
  await assert.rejects(() => adapter.ensureSession({ roleId: 'pm', project: 'P', sessionPolicy: 'persistent', sessionKey: 'P:pm' }));
});
