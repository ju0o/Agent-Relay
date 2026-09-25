import assert from 'node:assert/strict';
import { buildAllPmTools } from '../dist/server/mcp/pm-tools.js';

const base = { dataRoot: '/tmp/agent-relay-goal-loop-mcp-test', project: 'test' };
const baseTool = buildAllPmTools(base).find((candidate) => candidate.name === 'relay_pm_start_goal_loop');
assert.ok(baseTool);
await assert.rejects(
  () => baseTool.handler({ ownerConfirmed: true, goalTitle: 'x', goalStatement: 'y' }),
  (error) => error?.mcpCode === 'INVALID_ARGUMENT',
);

const tools = buildAllPmTools({
  ...base,
  goalLoop: { workerId: 'worker-1', workspaceRoot: '/tmp/workspace' },
});
const tool = tools.find((candidate) => candidate.name === 'relay_pm_start_goal_loop');
assert.ok(tool);

await assert.rejects(
  () => tool.handler({ ownerConfirmed: false, goalTitle: 'x', goalStatement: 'y' }),
  (error) => error?.mcpCode === 'FORBIDDEN',
);
await assert.rejects(
  () => tool.handler({ ownerConfirmed: true }),
  (error) => error?.mcpCode === 'INVALID_ARGUMENT',
);

console.log('PASS goal-loop MCP registration and fail-closed confirmation');
