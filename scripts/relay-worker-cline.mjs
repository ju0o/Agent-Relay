#!/usr/bin/env node
/**
 * Phase W-G2 — Relay-aware Cline worker.
 *
 * Consumes the same Relay protocol argv as relay-worker-claude.mjs and runs
 * the trusted Cline OAuth provider. Relay args never reach Cline. This worker
 * never writes Result/Evidence or calls MCP; observation remains a Core
 * adapter concern.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_BACKEND = path.join(__dirname, '..', 'dist', 'server', 'backend');
const PROMPT_LIMIT = 16 * 1024;
const DIAG_LIMIT = 16 * 1024;
const RELAY_ARGS = new Set(['--dataRoot', '--project', '--taskId', '--runId', '--workspaceRoot']);

class ArgError extends Error {}

function parseRelayArgs(argv) {
  const out = {};
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!RELAY_ARGS.has(token)) continue;
    const key = token.slice(2);
    if (seen.has(key)) throw new ArgError(`Duplicate relay arg: ${token}`);
    const value = argv[++i];
    if (value === undefined || RELAY_ARGS.has(value) || !value.trim()) throw new ArgError(`Missing value for relay arg: ${token}`);
    seen.add(key);
    out[key] = value.trim();
  }
  for (const key of ['dataRoot', 'project', 'taskId', 'runId', 'workspaceRoot']) {
    if (!out[key]) throw new ArgError(`Required relay arg missing: --${key}`);
  }
  return out;
}

function validateWorkspaceRoot(raw) {
  if (!path.isAbsolute(raw)) throw new Error(`workspaceRoot must be an absolute path: ${raw}`);
  const resolved = path.resolve(raw);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`workspaceRoot must be a directory: ${resolved}`);
  return resolved;
}

async function loadTask(dataRoot, project, taskId) {
  const file = path.join(DIST_BACKEND, 'goal-task.js');
  if (!fs.existsSync(file)) throw new Error(`Relay backend dist not found: ${file}; run npm run build first.`);
  return (await import(pathToFileURL(file).href)).getTask(dataRoot, project, taskId);
}

function linkedRun(task, runId) {
  const link = task.linkedRuns.find((entry) => entry.runId === runId);
  if (!link) throw new Error(`runId '${runId}' is not linked to Task '${task.taskId}'.`);
  const max = Math.max(...task.linkedRuns.map((entry) => entry.taskRunSequence));
  if (link.taskRunSequence !== max) throw new Error(`runId '${runId}' is not the current linked attempt.`);
  if (!['DISPATCHED', 'RUNNING'].includes(task.executionState)) throw new Error(`Task '${task.taskId}' is not dispatchable: ${task.executionState}`);
  if (task.pmState === 'ACCEPTED') throw new Error(`Task '${task.taskId}' is already PM accepted.`);
  return link;
}

function buildPrompt(task, runId) {
  const prompt = [
    'You are executing one Agent Relay Task.', '',
    `Task ID: ${task.taskId}`, `Run ID: ${runId}`, '',
    'Title:', task.title, '', 'Goal:', task.goal, '',
    'Reason:', task.reason || '(none)', '', 'Scope:', task.scope || '(none)', '',
    'Completion criteria:', ...(task.completionCriteria ?? []).map((item) => `- ${item}`),
    '', 'Instructions:', '- Work only inside the provided coding workspace.',
    '- Complete the requested task.', '- Do not alter Agent Relay state files directly.',
    '- When finished, provide a concise final response describing what changed,',
    '  verification performed, and remaining blockers.',
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_LIMIT) throw new Error(`Worker prompt exceeds ${PROMPT_LIMIT} bytes.`);
  return prompt;
}

function promptForRun(task, runFolder, runId) {
  const file = path.join(runFolder, 'prompt.md');
  if (!fs.existsSync(file)) return buildPrompt(task, runId);
  const prompt = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_LIMIT) throw new Error(`prompt.md exceeds ${PROMPT_LIMIT} bytes.`);
  return prompt;
}

function writePrompt(runFolder, prompt) {
  const file = path.join(runFolder, 'prompt.md');
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== prompt) throw new Error('prompt.md already exists with different content; refusing overwrite.');
    return;
  }
  fs.writeFileSync(file, prompt, 'utf8');
}

function workerSessionPath(dataRoot, project, workerId) {
  return path.join(dataRoot, '_relay', 'worker-sessions', project, `${workerId}.json`);
}

function readSessionId(dataRoot, project, workerId) {
  try {
    const raw = JSON.parse(fs.readFileSync(workerSessionPath(dataRoot, project, workerId), 'utf8'));
    return typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : undefined;
  } catch { return undefined; }
}

function writeSessionId(dataRoot, project, workerId, sessionId) {
  const file = workerSessionPath(dataRoot, project, workerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ workerId, sessionId, updatedAt: new Date().toISOString() }) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function writeLaunchLog(runFolder, entry) {
  try {
    const file = path.join(runFolder, 'worker-launch.log');
    fs.appendFileSync(file, `${fs.existsSync(file) ? '\n---\n' : ''}${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch { /* diagnostics never change the worker result */ }
}

function runCline(prompt, workspaceRoot, sessionId) {
  const args = ['--json', '--auto-approve', 'true', '-c', workspaceRoot, '--provider', 'cline-pass'];
  if (sessionId) args.push('--id', sessionId);
  args.push(prompt);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('cline', args, { cwd: workspaceRoot, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    const stderr = [];
    let stderrBytes = 0;
    let lineBuffer = '';
    let observedSessionId;
    let resultText = '';
    const onSignal = (signal) => () => { try { child.kill(signal); } catch {} };
    const onTerm = onSignal('SIGTERM');
    const onInt = onSignal('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        if (typeof record.taskId === 'string') observedSessionId = record.taskId;
        if (record.event && typeof record.event.taskId === 'string') observedSessionId = record.event.taskId;
        if (record.type === 'run_result' && typeof record.text === 'string') resultText = record.text;
      } catch { /* non-JSON diagnostics are ignored, never echoed to stdout */ }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk;
      let at;
      while ((at = lineBuffer.indexOf('\n')) !== -1) { consume(lineBuffer.slice(0, at)); lineBuffer = lineBuffer.slice(at + 1); }
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= DIAG_LIMIT) return;
      const text = String(chunk).slice(0, DIAG_LIMIT - stderrBytes);
      stderr.push(text);
      stderrBytes += text.length;
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => {
      if (lineBuffer) consume(lineBuffer);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      resolve({ code: code ?? (signal ? 1 : 0), signal, sessionId: observedSessionId, resultText, stderr: stderr.join('').trim() });
    });
  });
}

async function main() {
  let runFolder;
  let args;
  const startedAt = new Date().toISOString();
  try {
    args = parseRelayArgs(process.argv.slice(2));
    const workspaceRoot = validateWorkspaceRoot(args.workspaceRoot);
    const task = await loadTask(args.dataRoot, args.project, args.taskId);
    const run = linkedRun(task, args.runId);
    runFolder = run.folder;
    const meta = JSON.parse(fs.readFileSync(path.join(runFolder, 'meta.json'), 'utf8'));
    if (meta.workerId !== 'builder-cline') throw new Error(`Run meta workerId mismatch: expected builder-cline, got ${String(meta.workerId)}`);
    const workerId = meta.workerId;
    const prompt = promptForRun(task, runFolder, args.runId);
    writePrompt(runFolder, prompt);
    const priorSession = readSessionId(args.dataRoot, args.project, workerId);
    const result = await runCline(prompt, workspaceRoot, priorSession);
    if (result.sessionId) writeSessionId(args.dataRoot, args.project, workerId, result.sessionId);
    writeLaunchLog(runFolder, {
      startedAt, finishedAt: new Date().toISOString(), taskId: args.taskId, runId: args.runId,
      workerId, provider: 'cline-pass', sessionResumed: !!priorSession,
      phase: 'completed', exitCode: result.code, ...(result.signal ? { signal: result.signal } : {}),
      ...(result.code !== 0 && result.stderr ? { stderrExcerpt: result.stderr.slice(0, DIAG_LIMIT) } : {}),
    });
    process.exit(result.code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[relay-worker-cline] ${message}\n`);
    if (runFolder) writeLaunchLog(runFolder, { startedAt, finishedAt: new Date().toISOString(), taskId: args?.taskId, runId: args?.runId, phase: 'fatal', error: message, exitCode: 1 });
    process.exit(1);
  }
}

main();
