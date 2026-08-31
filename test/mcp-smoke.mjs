/**
 * MCP server stdio smoke tests (PM + Worker surfaces).
 *
 * Uses the official @modelcontextprotocol/sdk Client + StdioClientTransport to
 * verify that the server speaks standard MCP (tools/list, tools/call) rather
 * than the hand-rolled JSON-RPC dispatcher that used custom method names.
 */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_ROOT = path.join(os.tmpdir(), `arl-mcp-smoke-${process.pid}-${Date.now()}`);
fs.mkdirSync(TEST_ROOT, { recursive: true });

const SERVER = path.resolve(process.cwd(), 'dist', 'server', 'mcp', 'index.js');

const PASS = (m) => console.log('  PASS  ' + m);
const FAIL = (m) => { console.log('  FAIL  ' + m); process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

/**
 * Connect an MCP client to a server subprocess with the given extra args.
 * Calls fn(client) then closes the connection.
 */
async function withMcpClient(extraArgs, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, '--dataRoot', TEST_ROOT, '--project', 'SmokeProj', ...extraArgs],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'smoke-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Set up Worker fixture ────────────────────────────────────────────────────

async function setupWorkerFixture() {
  const { createGoal, createTask, linkRunToTask } = await import('../dist/server/backend/goal-task.js');
  const relay = await import('../dist/server/backend/fs.js');

  const goalId = (await createGoal(TEST_ROOT, 'SmokeProj', {
    title: 'Smoke Goal',
    goalStatement: 'smoke test goal',
    completionCriteria: ['done'],
  })).goalId;

  const taskId = (await createTask(TEST_ROOT, 'SmokeProj', {
    goalId,
    title: 'Smoke Task',
    goal: 'do smoke',
    reason: 'test',
    scope: 'test',
    completionCriteria: ['done'],
  })).taskId;

  const run = await relay.atomicMaterializeRun(TEST_ROOT, 'SmokeProj', relay.todayString(), 'SmokeAgent');
  const task = await linkRunToTask(TEST_ROOT, 'SmokeProj', taskId, run.folder);
  const link = task.linkedRuns.find((r) => r.folder === path.resolve(run.folder));
  const runId = link.runId;

  return { taskId, runId };
}

async function main() {
  console.log(`MCP server: ${SERVER}`);
  console.log(`TEST_ROOT: ${TEST_ROOT}`);

  // ── PM surface smoke ──────────────────────────────────────────────────────
  console.log('\n── PM surface smoke ──');
  await withMcpClient(['--surface', 'pm'], async (client) => {
    // Standard MCP tools/list
    const { tools } = await client.listTools();
    check(Array.isArray(tools) && tools.length > 0, 'E-34 PM: tools/list returns PM tools');
    check(tools.some((t) => t.name === 'relay_pm_get_goal'), 'E-34 PM: list contains relay_pm_get_goal');
    check(!tools.some((t) => t.name.startsWith('relay_worker_')), 'E-34 PM: list excludes Worker tools');

    // Standard MCP tools/call — unknown tool returns isError (not a protocol error)
    const unknownResult = await client.callTool({ name: 'unknown_method_xyz' });
    check(unknownResult.isError === true, 'E-35 PM: unknown tool → isError: true');

    // tools/call on a valid tool (project is in server context — no args needed)
    const listResult = await client.callTool({ name: 'relay_pm_list_goals' });
    check(!listResult.isError && Array.isArray(listResult.content), 'E-34 PM: callTool(relay_pm_list_goals) succeeds');
  });

  // ── Worker surface smoke ──────────────────────────────────────────────────
  console.log('\n── Worker surface smoke ──');
  let taskId, runId;
  try {
    ({ taskId, runId } = await setupWorkerFixture());
  } catch (e) {
    console.log('  SKIP  Worker smoke — fixture setup failed:', e.message);
    taskId = 'TASK-1'; runId = 'run-test';
  }

  await withMcpClient(
    ['--surface', 'worker', '--taskId', taskId, '--runId', runId],
    async (client) => {
      // Standard MCP tools/list
      const { tools } = await client.listTools();
      check(Array.isArray(tools) && tools.length > 0, 'E-34 Worker: tools/list returns Worker tools');
      check(tools.some((t) => t.name === 'relay_worker_get_assignment'),
        'E-34 Worker: list contains relay_worker_get_assignment');
      check(!tools.some((t) => t.name.startsWith('relay_pm_')), 'E-34 Worker: list excludes PM tools');

      // tools/call — unknown tool returns isError
      const unknownResult = await client.callTool({ name: 'unknown_method_xyz' });
      check(unknownResult.isError === true, 'E-35 Worker: unknown tool → isError: true');

      // tools/call on a valid worker tool
      const assignResult = await client.callTool({ name: 'relay_worker_get_assignment' });
      check(!assignResult.isError && Array.isArray(assignResult.content),
        'E-34 Worker: callTool(relay_worker_get_assignment) succeeds');
    },
  );

  // ── Missing --surface error ────────────────────────────────────────────────
  console.log('\n── Missing --surface error ──');
  try {
    await withMcpClient([], async (_client) => {
      FAIL('Missing --surface: expected connection to fail, but server connected');
    });
  } catch {
    PASS('Missing --surface: server rejects connection (no --surface given)');
  }

  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  console.log('\nMCP SMOKE DONE');
}

main().catch((err) => { console.error(err); process.exit(1); });
