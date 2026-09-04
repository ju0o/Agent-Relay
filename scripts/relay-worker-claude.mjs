/**
 * Phase I — Relay-aware Claude Code wrapper.
 *
 * Protocol adapter between Relay Dispatcher argv and real Claude Code CLI.
 *
 * Accepts (and consumes) Relay internal args:
 *   --dataRoot, --project, --taskId, --runId, --workspaceRoot
 *
 * None of these are forwarded to Claude Code.
 *
 * Exit semantics:
 *   0  → Claude process completed normally. NOT RESULT_RECEIVED by itself.
 *   non-zero → propagated to Dispatcher's non-zero failure path.
 *
 * Observation is handled by the claude-code adapter, not by this wrapper.
 * This wrapper never calls markResultReceived, creates Evidence, or calls MCP.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── dist resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_BACKEND = path.join(__dirname, '..', 'dist', 'server', 'backend');

// ── constants ─────────────────────────────────────────────────────────────────

/** Maximum total prompt size (bytes, UTF-8). V1 = 16 KiB is sufficient. */
const PROMPT_SIZE_LIMIT_BYTES = 16 * 1024;

/**
 * Bound for captured worker stdout/stderr diagnostic excerpts. Never logs a
 * full transcript, chain-of-thought, or unbounded session output.
 */
const MAX_WORKER_DIAG_CHARS = 16 * 1024;

/** Relay wrapper protocol arg keys (consumed here, never forwarded). */
const RELAY_ARGS = new Set([
  '--dataRoot',
  '--project',
  '--taskId',
  '--runId',
  '--workspaceRoot',
  '--permissionMode',
]);

/**
 * Allowed Claude permission mode values (narrow enum).
 * 'dangerously-skip-permissions' is intentionally absent.
 */
const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits']);

// ── argv parsing ──────────────────────────────────────────────────────────────

/**
 * Parse Relay wrapper protocol args from a raw argv array.
 *
 * Rules:
 *   - No shell parsing, no eval, no exec, no command concatenation.
 *   - process.argv array only.
 *   - Rejects: missing required arg, duplicate key, empty value.
 *   - Optional: --permissionMode (enum: 'default' | 'acceptEdits').
 *     Duplicate, empty, or invalid enum values are rejected.
 *     'dangerously-skip-permissions' is explicitly rejected.
 *
 * @param {string[]} argv  Slice of process.argv (caller provides slice(2)).
 * @returns {{ dataRoot: string; project: string; taskId: string; runId: string; workspaceRoot: string; permissionMode?: string }}
 */
function parseRelayArgs(argv) {
  const result = {};
  const seen = new Set();

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!RELAY_ARGS.has(tok)) continue;

    const key = tok.slice(2); // strip leading '--'

    if (seen.has(key)) {
      throw new ArgError(`Duplicate relay arg: ${tok}`);
    }
    seen.add(key);

    const next = argv[i + 1];

    // Missing value: next token is another relay arg or beyond array end.
    if (next === undefined || RELAY_ARGS.has(next)) {
      throw new ArgError(`Missing value for relay arg: ${tok}`);
    }
    if (!next.trim()) {
      throw new ArgError(`Empty value for relay arg: ${tok}`);
    }

    result[key] = next.trim();
    i++; // consume the value token
  }

  for (const req of ['dataRoot', 'project', 'taskId', 'runId', 'workspaceRoot']) {
    if (!result[req]) {
      throw new ArgError(`Required relay arg missing: --${req}`);
    }
  }

  // Validate optional --permissionMode (narrow enum — no arbitrary Claude flags).
  if (result.permissionMode !== undefined) {
    const pm = result.permissionMode;
    if (pm === 'dangerously-skip-permissions') {
      throw new ArgError(
        "--permissionMode 'dangerously-skip-permissions' is not supported by this driver. " +
        "Allowed values: 'default', 'acceptEdits'.",
      );
    }
    if (!VALID_PERMISSION_MODES.has(pm)) {
      throw new ArgError(
        `Invalid --permissionMode value: '${pm}'. Allowed values: 'default', 'acceptEdits'.`,
      );
    }
  }

  return /** @type {{ dataRoot: string; project: string; taskId: string; runId: string; workspaceRoot: string; permissionMode?: string }} */ (result);
}

class ArgError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ArgError';
  }
}

// ── workspaceRoot security validation ────────────────────────────────────────

/**
 * Validate workspaceRoot as the coding workspace cwd.
 * Must be an existing absolute directory path.
 * Result is used only as child spawn cwd — never injected into shell or env.
 *
 * @param {string} raw
 * @returns {string} resolved absolute path
 */
function validateWorkspaceRoot(raw) {
  if (!path.isAbsolute(raw)) {
    throw new Error(`workspaceRoot must be an absolute path: ${raw}`);
  }
  const resolved = path.resolve(raw);
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`workspaceRoot does not exist: ${resolved}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`workspaceRoot must be a directory: ${resolved}`);
  }
  return resolved;
}

// ── canonical Task loading ────────────────────────────────────────────────────

/**
 * Load the canonical Task record using the compiled backend module.
 * Never duplicates path rules — uses existing getTask() SSOT.
 *
 * @param {string} dataRoot
 * @param {string} project
 * @param {string} taskId
 * @returns {Promise<import('../src/shared/types.js').TaskRecord>}
 */
async function loadCanonicalTask(dataRoot, project, taskId) {
  const goalTaskPath = path.join(DIST_BACKEND, 'goal-task.js');
  if (!fs.existsSync(goalTaskPath)) {
    throw new Error(
      `Relay backend dist not found: ${goalTaskPath}\n` +
      'Run "npm run build" before using the relay worker.',
    );
  }
  // Use pathToFileURL for Windows compatibility (absolute paths must be file:// URLs in ESM).
  const gt = await import(pathToFileURL(goalTaskPath).href);
  return gt.getTask(dataRoot, project, taskId);
}

// ── Task validation ───────────────────────────────────────────────────────────

/**
 * Validate that the given runId is the current (most recent) linked attempt
 * and that the Task is in a dispatchable execution state.
 *
 * @param {import('../src/shared/types.js').TaskRecord} task
 * @param {string} runId
 * @returns {{ runFolder: string }} folder path for the matched run
 */
function validateTaskAndRun(task, runId) {
  // 1. runId must be linked to this Task.
  const linkedRun = task.linkedRuns.find((r) => r.runId === runId);
  if (!linkedRun) {
    throw new Error(
      `runId '${runId}' is not linked to Task '${task.taskId}'. ` +
      `Linked runs: [${task.linkedRuns.map((r) => r.runId).join(', ')}]`,
    );
  }

  // 2. runId must be the current attempt (highest taskRunSequence).
  const maxSeq = task.linkedRuns.reduce((m, r) => Math.max(m, r.taskRunSequence), 0);
  if (linkedRun.taskRunSequence !== maxSeq) {
    throw new Error(
      `runId '${runId}' (seq=${linkedRun.taskRunSequence}) is not the current attempt ` +
      `(max seq=${maxSeq}). This wrapper only runs the latest linked attempt.`,
    );
  }

  // 3. Task execution state must be DISPATCHED or RUNNING.
  if (task.executionState !== 'DISPATCHED' && task.executionState !== 'RUNNING') {
    throw new Error(
      `Task '${task.taskId}' executionState must be DISPATCHED or RUNNING, ` +
      `found: ${task.executionState}`,
    );
  }

  // 4. Task must not be PM-ACCEPTED.
  if (task.pmState === 'ACCEPTED') {
    throw new Error(
      `Task '${task.taskId}' pmState is ACCEPTED. Cannot dispatch an accepted task.`,
    );
  }

  return { runFolder: linkedRun.folder };
}

// ── bounded Worker prompt construction ───────────────────────────────────────

/**
 * Build a deterministic, bounded prompt from Task SSOT fields.
 *
 * Includes: taskId, runId, title, goal, reason, scope, completionCriteria.
 * Does NOT include arbitrary Relay storage paths.
 * Total size bounded to PROMPT_SIZE_LIMIT_BYTES (16 KiB for V1).
 *
 * @param {import('../src/shared/types.js').TaskRecord} task
 * @param {string} runId
 * @returns {string}
 */
function buildWorkerPrompt(task, runId) {
  const criteria = (task.completionCriteria ?? [])
    .map((c) => `- ${c}`)
    .join('\n') || '- (none)';

  const prompt = [
    'You are executing one Agent Relay Task.',
    '',
    `Task ID: ${task.taskId}`,
    `Run ID: ${runId}`,
    '',
    'Title:',
    task.title,
    '',
    'Goal:',
    task.goal,
    '',
    'Reason:',
    task.reason || '(none)',
    '',
    'Scope:',
    task.scope || '(none)',
    '',
    'Completion criteria:',
    criteria,
    '',
    'Instructions:',
    '- Work only inside the provided coding workspace.',
    '- Complete the requested task.',
    '- Do not alter Agent Relay state files directly.',
    '- When finished, provide a concise final response describing what changed,',
    '  verification performed, and remaining blockers.',
  ].join('\n');

  const encoded = Buffer.byteLength(prompt, 'utf8');
  if (encoded > PROMPT_SIZE_LIMIT_BYTES) {
    throw new Error(
      `Worker prompt exceeds size limit: ${encoded} bytes > ${PROMPT_SIZE_LIMIT_BYTES} bytes (16 KiB). ` +
      'Truncate task narrative fields before dispatching.',
    );
  }

  return prompt;
}

// ── prompt.md write ───────────────────────────────────────────────────────────

/**
 * V1-G5-C: read and minimally validate retry-context.json from a Run folder.
 * Returns null for initial Runs (file absent). Malformed context fails safe
 * (throw) rather than silently falling back to the initial prompt.
 *
 * @param {string} runFolder
 * @returns {{ preparationId: string; sourceRunId: string; taskId: string; judgmentId: string; deliveryId: string } | null}
 */
function readRetryContext(runFolder) {
  const ctxPath = path.join(runFolder, 'retry-context.json');
  if (!fs.existsSync(ctxPath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
  } catch (err) {
    throw new Error(`retry-context.json unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const f of ['preparationId', 'sourceRunId', 'taskId', 'judgmentId', 'deliveryId']) {
    if (!raw || typeof raw[f] !== 'string' || !raw[f]) {
      throw new Error(`retry-context.json missing field: ${f}`);
    }
  }
  return {
    preparationId: raw.preparationId,
    sourceRunId: raw.sourceRunId,
    taskId: raw.taskId,
    judgmentId: raw.judgmentId,
    deliveryId: raw.deliveryId,
  };
}

/**
 * V1-G5-C: recompute the retry prompt with the shared dist composer
 * (identical bytes to the backend pre-write). Reads the durable
 * instruction + reason from the G5-A judgment/intent and the bounded prior
 * excerpt from the source Run — same inputs as retry-dispatch.ts.
 */
async function buildRetryPrompt(dataRoot, project, task, retryCtx) {
  if (retryCtx.taskId !== task.taskId) {
    throw new Error(`retry-context taskId mismatch: ${retryCtx.taskId} ≠ ${task.taskId}`);
  }
  const retryPromptPath = path.join(DIST_BACKEND, 'retry-prompt.js');
  const pmJudgmentPath = path.join(DIST_BACKEND, 'pm-judgment.js');
  if (!fs.existsSync(retryPromptPath) || !fs.existsSync(pmJudgmentPath)) {
    throw new Error(
      'Relay backend dist not found for retry prompt composition.\n' +
      'Run "npm run build" before using the relay worker.',
    );
  }
  const rp = await import(pathToFileURL(retryPromptPath).href);
  const pmJud = await import(pathToFileURL(pmJudgmentPath).href);
  const judgment = pmJud.getPmJudgment(dataRoot, project, retryCtx.judgmentId);
  const instruction = pmJud.getRetryInstructionForDelivery(dataRoot, project, retryCtx.deliveryId);
  const sourceLink = task.linkedRuns.find((r) => r.runId === retryCtx.sourceRunId);
  if (!sourceLink) {
    throw new Error(`Source Run ${retryCtx.sourceRunId} is no longer linked.`);
  }
  const prior = rp.readPriorResultExcerpt(sourceLink.folder);
  return rp.composeRetryPrompt({
    task,
    preparationId: retryCtx.preparationId,
    sourceRunId: retryCtx.sourceRunId,
    reason: judgment.reason || '',
    retryInstruction: instruction,
    priorExcerpt: prior.excerpt,
    priorAvailable: prior.available,
  });
}

/**
 * Write the bounded Worker prompt to prompt.md inside the existing Run folder.
 *
 * Idempotency rules:
 *   - If prompt.md does not exist → write it.
 *   - If prompt.md exists and content is identical → idempotent continue.
 *   - If prompt.md exists and content differs → fail safely.
 *
 * Never materializes a new Run.
 * Resolves Run folder only through canonical Task.linkedRuns/runId.
 *
 * @param {string} runFolder
 * @param {string} prompt
 */
function writePromptMd(runFolder, prompt) {
  if (!fs.existsSync(runFolder)) {
    throw new Error(`Run folder does not exist: ${runFolder}`);
  }

  const promptPath = path.join(runFolder, 'prompt.md');

  if (fs.existsSync(promptPath)) {
    const existing = fs.readFileSync(promptPath, 'utf8');
    if (existing === prompt) {
      // Idempotent: same content — safe to continue.
      return;
    }
    throw new Error(
      `prompt.md already exists in Run folder with DIFFERENT content.\n` +
      `Run folder: ${runFolder}\n` +
      'Refusing to overwrite. Manual resolution required.',
    );
  }

  fs.writeFileSync(promptPath, prompt, 'utf8');
}

// ── Claude executable resolution ─────────────────────────────────────────────

/**
 * Resolve the Claude Code CLI executable.
 *
 * Resolution order:
 *   1. CLAUDE_EXE environment variable (operator override).
 *   2. On Windows: PATH scan for claude.exe (native, shell:false safe).
 *   3. Fallback: bare 'claude' (works on Unix / when claude is in PATH).
 *
 * Security: executable path is NOT derived from Task content, run folder, or
 * any user-provided data. Only env and PATH are consulted.
 *
 * @returns {string} resolved executable path or basename
 */
function resolveClaudeExecutable() {
  // 1. Operator-supplied override (escape hatch for non-standard installs).
  const envOverride = process.env['CLAUDE_EXE'];
  if (envOverride && envOverride.trim()) {
    return envOverride.trim();
  }

  // 2. Windows: native .exe preferred (shell:false safe; .cmd requires cmd.exe).
  if (process.platform === 'win32') {
    const pathDirs = (process.env['PATH'] || '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = path.join(dir, 'claude.exe');
      try {
        fs.accessSync(candidate, fs.constants.F_OK);
        return candidate;
      } catch {
        // Not found in this directory — continue scanning.
      }
    }
    // Note: claude.cmd requires shell:true which is forbidden here.
    // If claude.exe is not found, fall through to 'claude' fallback.
    // Operators should set CLAUDE_EXE if claude.exe is not in PATH.
  }

  // 3. Unix / fallback: rely on PATH.
  return 'claude';
}

// ── diagnostic log ────────────────────────────────────────────────────────────

/**
 * Write worker-launch.log to the Run folder for operator inspection.
 * Safe fields only — no secrets, no full env, no chain-of-thought.
 *
 * @param {string} runFolder
 * @param {object} entry
 */
function writeLaunchLog(runFolder, entry) {
  try {
    const logPath = path.join(runFolder, 'worker-launch.log');
    const data = JSON.stringify(entry, null, 2) + '\n';
    // Append if file exists (non-blocking best-effort).
    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, '\n---\n' + data, 'utf8');
    } else {
      fs.writeFileSync(logPath, data, 'utf8');
    }
  } catch {
    // Diagnostic log write must never crash the wrapper.
  }
}

/**
 * Collect a child stream into a bounded UTF-8 excerpt (capped at
 * MAX_WORKER_DIAG_CHARS). Never unbounded; never a full transcript.
 *
 * @param {import('node:stream').Readable | null} stream
 * @returns {Promise<string>} bounded excerpt ('' when stream is null)
 */
function collectBoundedStream(stream) {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (text.length < MAX_WORKER_DIAG_CHARS) {
        text += String(chunk).slice(0, MAX_WORKER_DIAG_CHARS - text.length);
      }
    });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

/**
 * Safe redacted summary of the Claude argv (non-secret shape only). The full
 * prompt is intentionally NOT logged.
 *
 * @param {string} exe
 * @param {string[]} args
 * @returns {string[]}
 */
function redactedArgvShape(exe, args) {
  return [exe, ...args.map((a) => {
    if (/^-/.test(a)) return a;                 // flags are non-secret shape
    return a.length <= 80 ? a : a.slice(0, 40) + '…(truncated)';
  })];
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  let runFolder = null;
  let taskId = null;
  let runId = null;

  try {
    // ── 1. Parse Relay args (no shell, no eval, process.argv array only) ──────
    const args = parseRelayArgs(process.argv.slice(2));
    taskId = args.taskId;
    runId = args.runId;
    const permissionMode = args.permissionMode; // 'default' | 'acceptEdits' | undefined

    // ── 2. Validate workspaceRoot (security) ──────────────────────────────────
    const workspaceRoot = validateWorkspaceRoot(args.workspaceRoot);

    // ── 3. Load canonical Task ────────────────────────────────────────────────
    let task;
    try {
      task = await loadCanonicalTask(args.dataRoot, args.project, args.taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[relay-worker-claude] Task load failed: ${msg}\n`);
      process.exit(1);
    }

    // ── 4. Validate Task + runId ──────────────────────────────────────────────
    let runFolder_;
    try {
      ({ runFolder: runFolder_ } = validateTaskAndRun(task, args.runId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[relay-worker-claude] Task/run validation failed: ${msg}\n`);
      process.exit(1);
    }
    runFolder = runFolder_;

    // ── 5. Build bounded Worker prompt ────────────────────────────────────────
    // V1-G5-C: retry Runs carry retry-context.json (written pre-commit by the
    // canonical Dispatcher from backend-composed data). Recompute the
    // identical retry prompt via the shared dist composer so the idempotent
    // prompt.md write below agrees byte-for-byte; initial Runs use the
    // canonical Task prompt as before.
    let prompt;
    try {
      const retryCtx = readRetryContext(runFolder);
      if (retryCtx) {
        prompt = await buildRetryPrompt(args.dataRoot, args.project, task, retryCtx);
      } else {
        prompt = buildWorkerPrompt(task, args.runId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[relay-worker-claude] Prompt construction failed: ${msg}\n`);
      writeLaunchLog(runFolder, {
        startedAt,
        taskId,
        runId,
        phase: 'prompt-construction',
        error: msg,
        exitCode: 1,
      });
      process.exit(1);
    }

    // ── 6. Write prompt.md to existing Run (idempotent) ───────────────────────
    try {
      writePromptMd(runFolder, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[relay-worker-claude] prompt.md write failed: ${msg}\n`);
      writeLaunchLog(runFolder, {
        startedAt,
        taskId,
        runId,
        phase: 'prompt-write',
        error: msg,
        exitCode: 1,
      });
      process.exit(1);
    }

    // ── 7. Resolve Claude executable ──────────────────────────────────────────
    const claudeExe = resolveClaudeExecutable();

    // ── 8. Write launch log (pre-spawn diagnostics) ───────────────────────────
    writeLaunchLog(runFolder, {
      startedAt,
      taskId,
      runId,
      claudeExecutableResolved: claudeExe,
      workspaceRoot,
      // Safe normalized field — not an env dump or raw token
      permissionMode: permissionMode ?? 'default',
      phase: 'spawning',
    });

    // ── 9. Spawn Claude Code CLI (shell:false mandatory) ─────────────────────
    //
    // The prompt is passed as a direct argv element — NOT through a shell.
    // No shell interpolation, no command concatenation, no eval.
    //
    // Claude CLI: `claude --print [--permission-mode acceptEdits] <prompt>`
    //   --print is a boolean flag; prompt is positional.
    //   --permission-mode acceptEdits is injected ONLY when registry specifies 'acceptEdits'.
    //
    // Relay args (--dataRoot etc.) are NOT forwarded here.
    // workspaceRoot is used only as spawn cwd.
    //
    // Permission mode → Claude CLI flag mapping (narrow enum, no arbitrary injection):
    //   'acceptEdits' → --permission-mode acceptEdits
    //   'default' / undefined → no --permission-mode flag (least privilege)
    //
    const claudeArgs = ['--print'];
    if (permissionMode === 'acceptEdits') {
      claudeArgs.push('--permission-mode', 'acceptEdits');
    }
    claudeArgs.push(prompt);

    let exitCode = 1;
    let exitSignal = null;
    let stderrExcerpt = '';
    let stdoutExcerpt = '';
    try {
      exitCode = await new Promise((resolve) => {
        const child = spawn(claudeExe, claudeArgs, {
          cwd: workspaceRoot,    // workspaceRoot = coding workspace cwd only
          shell: false,          // MANDATORY: no shell
          stdio: ['ignore', 'pipe', 'pipe'], // capture bounded CLI stdout/stderr for diagnostics
          windowsHide: true,
          // env: intentionally NOT passed — no arbitrary env injection from Task content
          // Claude inherits process.env (which is the trusted operator env)
        });

        const stderrP = collectBoundedStream(child.stderr);
        const stdoutP = collectBoundedStream(child.stdout);

        child.on('error', (err) => {
          process.stderr.write(
            `[relay-worker-claude] Claude spawn error: ${err.message}\n`,
          );
          resolve(1);
        });

        child.on('exit', (code, sig) => {
          exitSignal = sig;
          Promise.all([stderrP, stdoutP]).then(([se, so]) => {
            stderrExcerpt = se;
            stdoutExcerpt = so;
            resolve(code ?? (sig ? 1 : 0));
          });
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[relay-worker-claude] Spawn threw: ${msg}\n`);
      writeLaunchLog(runFolder, {
        startedAt,
        finishedAt: new Date().toISOString(),
        taskId,
        runId,
        claudeExecutableResolved: claudeExe,
        argvShape: redactedArgvShape(claudeExe, claudeArgs),
        phase: 'spawn-threw',
        error: msg,
        exitCode: 1,
      });
      process.exit(1);
    }

    // ── 10. Write final log entry ──────────────────────────────────────────────
    const finalEntry = {
      startedAt,
      finishedAt: new Date().toISOString(),
      taskId,
      runId,
      claudeExecutableResolved: claudeExe,
      // Safe normalized field — records what was used, not a raw arg
      permissionMode: permissionMode ?? 'default',
      argvShape: redactedArgvShape(claudeExe, claudeArgs),
      phase: 'completed',
      // exitCode=0 does NOT mean RESULT_RECEIVED.
      // The claude-code adapter observes RESPONSE_COMPLETE independently.
      exitCode,
    };
    // Non-zero exits carry bounded CLI launch diagnostics only — no transcript,
    // no chain-of-thought, no secrets/env.
    if (exitCode !== 0 || exitSignal !== null) {
      if (exitSignal !== null) finalEntry.signal = exitSignal;
      if (stderrExcerpt.trim()) finalEntry.stderrExcerpt = stderrExcerpt.trim().slice(0, MAX_WORKER_DIAG_CHARS);
      if (stdoutExcerpt.trim()) finalEntry.stdoutExcerpt = stdoutExcerpt.trim().slice(0, MAX_WORKER_DIAG_CHARS);
    }
    writeLaunchLog(runFolder, finalEntry);

    // ── 11. Propagate Claude exit code ────────────────────────────────────────
    //
    // exitCode=0 → Claude completed normally. NOT RESULT_RECEIVED.
    // exitCode≠0 → Dispatcher existing non-zero failure path handles FAILED.
    //
    // NEVER calls markResultReceived.
    // NEVER creates Evidence.
    // NEVER calls MCP.
    //
    process.exit(exitCode);
  } catch (err) {
    // Outer catch: handles arg parsing errors and any unexpected failures.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[relay-worker-claude] Fatal: ${msg}\n`);

    if (runFolder) {
      writeLaunchLog(runFolder, {
        startedAt,
        finishedAt: new Date().toISOString(),
        taskId,
        runId,
        phase: 'fatal',
        error: msg,
        exitCode: 1,
      });
    }

    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[relay-worker-claude] Unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
