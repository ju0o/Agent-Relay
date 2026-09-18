#!/usr/bin/env node
/**
 * AUTO Goal Loop E2E test worker (disposable proof only).
 * Protocol: node goal-loop-worker.mjs --dataRoot X --project Y --taskId T --runId R [--workspaceRoot W]
 * Finds the Run folder by scanning dataRoot for meta.json with matching runId,
 * writes prompt.md (if absent) + result.md, touches a workspace artifact, exits 0.
 * No network, no tmux, no clipboard.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}

const dataRoot = arg('--dataRoot');
const taskId = arg('--taskId');
const runId = arg('--runId');
const workspaceRoot = arg('--workspaceRoot');

if (!dataRoot || !runId) {
  console.error('goal-loop-worker: missing --dataRoot/--runId');
  process.exit(2);
}

function findRunFolder(root, targetRunId) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        stack.push(p);
      } else if (e.name === 'meta.json') {
        try {
          const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (meta && meta.runId === targetRunId) return path.dirname(p);
        } catch { /* ignore */ }
      }
    }
  }
  return null;
}

const folder = findRunFolder(dataRoot, runId);
if (!folder) {
  console.error(`goal-loop-worker: run folder not found for ${runId}`);
  process.exit(3);
}

try {
  const promptPath = path.join(folder, 'prompt.md');
  if (!fs.existsSync(promptPath)) {
    fs.writeFileSync(promptPath, `# AUTO task ${taskId}\n\nBounded disposable proof task. No destructive actions.\n`, 'utf8');
  }
  fs.writeFileSync(
    path.join(folder, 'result.md'),
    `# AUTO result ${taskId} / ${runId}\n\nWorker completed the bounded step.\nArtifact: auto-proof.txt in workspace.\n`,
    'utf8',
  );
  if (workspaceRoot) {
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true });
      fs.writeFileSync(path.join(workspaceRoot, 'auto-proof.txt'), `task=${taskId} run=${runId}\n`, 'utf8');
    } catch { /* workspace artifact best-effort */ }
  }
} catch (e) {
  console.error(`goal-loop-worker failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(4);
}
process.exit(0);
