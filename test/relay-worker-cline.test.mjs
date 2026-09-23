import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createV1TaskFromContract } from '../dist/server/backend/v1-intake.js';
import { atomicMaterializeRun, readRunMeta, writeRunMeta } from '../dist/server/backend/fs.js';
import { getTask, linkRunToTask } from '../dist/server/backend/goal-task.js';
import { transitionTaskExecution } from '../dist/server/backend/goal-task-runtime.js';

const WRAPPER = '/home/skkse12/Desktop/Projects/Core/Agent-Relay/scripts/relay-worker-cline.mjs';

test('relay-worker-cline consumes Relay argv, keeps stdout clean, and propagates Cline JSON completion', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-worker-data-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-worker-workspace-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-worker-bin-'));
  const fakeCline = path.join(fakeBin, 'cline');
  fs.writeFileSync(fakeCline, `#!/usr/bin/env node
import fs from 'node:fs';
const cwd = process.argv[process.argv.indexOf('-c') + 1];
fs.writeFileSync(cwd + '/unit-output.txt', 'UNIT_OK');
console.log(JSON.stringify({type:'hook_event', taskId:'unit-cline-session'}));
console.log(JSON.stringify({type:'run_result', text:'unit result'}));
`);
  fs.chmodSync(fakeCline, 0o755);
  const project = 'CLINEUNIT';
  const intake = await createV1TaskFromContract(dataRoot, project, {
    title: 'Cline worker unit', goal: 'Create unit-output.txt containing UNIT_OK.',
    reason: 'unit', scope: 'unit-output.txt only', completionCriteria: ['file exists'],
  });
  const materialized = await atomicMaterializeRun(dataRoot, project, new Date().toISOString().slice(0, 10), 'worker-builder-cline');
  await linkRunToTask(dataRoot, project, intake.task.taskId, materialized.folder);
  const linked = getTask(dataRoot, project, intake.task.taskId).linkedRuns.at(-1);
  writeRunMeta(materialized.folder, { ...readRunMeta(materialized.folder), workerId: 'builder-cline', workspaceRoot, taskId: intake.task.taskId, goalId: intake.goal.goalId, taskRunSequence: linked.taskRunSequence });
  await transitionTaskExecution(dataRoot, project, intake.task.taskId, { expectedExecutionState: 'READY', to: 'DISPATCHED' });
  await transitionTaskExecution(dataRoot, project, intake.task.taskId, { expectedExecutionState: 'DISPATCHED', to: 'RUNNING' });
  const result = spawnSync(process.execPath, [WRAPPER, '--dataRoot', dataRoot, '--project', project, '--taskId', intake.task.taskId, '--runId', materialized.runId, '--workspaceRoot', workspaceRoot], {
    encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(path.join(workspaceRoot, 'unit-output.txt'), 'utf8'), 'UNIT_OK');
  assert.ok(fs.existsSync(path.join(materialized.folder, 'prompt.md')));
  assert.ok(fs.existsSync(path.join(materialized.folder, 'worker-launch.log')));
});
