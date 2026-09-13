/**
 * Phase 2 — actl Managed JSON bridge (single module).
 *
 * Spawns the approved actl absolute executable with shell:false:
 *   actl runtime <op> --request-stdin
 * One stdin JSON object → one stdout JSON envelope. No Task engine.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActlDriverOptions } from './worker-registry.js';

export const ACTL_CONTRACT_VERSION = 1 as const;

export type ActlRuntimeOp =
  | 'status'
  | 'discover'
  | 'reserve'
  | 'send'
  | 'collect'
  | 'interrupt';

export interface ActlErrorBody {
  code: string;
  detail?: string;
  sideEffect?: 'NONE' | 'POSSIBLE_INPUT' | 'INPUT_OBSERVED';
  retryAction?: string;
}

export interface ActlEnvelope {
  contractVersion?: number;
  requestId?: string;
  ok: boolean;
  observedAt?: string;
  data?: Record<string, unknown>;
  error?: ActlErrorBody;
}

export interface ActlInvokeResult {
  exitCode: number;
  envelope: ActlEnvelope | null;
  stdout: string;
  stderr: string;
}

export interface ActlInputPermit {
  commandId: string;
  runtimeId: string;
  fence: string;
  paneMode: 'normal';
  confirmedAt: string;
  snapshotHash: string;
}

export interface ActlRuntimeBinding {
  schemaVersion: 1;
  relayInstanceId: string;
  project: string;
  taskId: string;
  runId: string;
  runtimeId: string;
  agentKind: 'codex';
  expectedProfileRoot: string;
  socketPath: string;
  workspaceRoot: string;
  commandId: string;
  wirePromptSha256: string;
  /** Frozen Managed pane from live reserve — send must use this exact paneId. */
  paneId?: string;
  /** Exact expectedContext returned/frozen by reserve; send must not remap. */
  frozenExpectedContext?: Record<string, unknown>;
  reserveRequestId?: string;
  reservationId?: string;
  fence?: string;
  /** Controller-private lease token — never Task narrative / MCP public views. */
  leaseToken?: string;
  observationCursor?: unknown;
  transportReceipt?: unknown;
  agentReceived?: unknown;
  finalPacket?: unknown;
  sessionId?: string;
  turnId?: string;
  resultId?: string;
  /**
   * Collect/resume checkpoint for §9.3 restart / incomplete FINAL.
   * Durable across process-local lock release.
   */
  collectStatus?:
    | 'RESERVED'
    | 'SENT'
    | 'DELIVERY_AMBIGUOUS'
    | 'WAITING_AGENT_RECEIVED'
    | 'WAITING_FINAL'
    | 'FINAL_BOUND';
  updatedAt: string;
}

export class ActlBridgeError extends Error {
  readonly code: string;
  readonly sideEffect?: string;
  readonly exitCode?: number;
  readonly envelope?: ActlEnvelope | null;

  constructor(
    code: string,
    message: string,
    opts?: { sideEffect?: string; exitCode?: number; envelope?: ActlEnvelope | null },
  ) {
    super(message);
    this.name = 'ActlBridgeError';
    this.code = code;
    this.sideEffect = opts?.sideEffect;
    this.exitCode = opts?.exitCode;
    this.envelope = opts?.envelope;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function localHostKey(): string {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8').trim();
        if (raw) return sha256Hex(raw);
      }
    } catch {
      // try next
    }
  }
  return sha256Hex('unknown-machine-id');
}

export function localUid(): string {
  if (typeof process.getuid === 'function') return String(process.getuid());
  return String(os.userInfo().uid);
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function computeCommandId(args: {
  relayInstanceId: string;
  project: string;
  taskId: string;
  runId: string;
}): string {
  const digest = sha256Hex(
    Buffer.from(
      JSON.stringify(
        sortKeys({
          relayInstanceId: args.relayInstanceId,
          operation: 'worker_prompt',
          project: args.project,
          runId: args.runId,
          taskId: args.taskId,
        }),
      ),
      'utf8',
    ),
  );
  return `cmd1_${digest}`;
}

export function buildWirePromptHeader(commandId: string, nonceHex?: string): string {
  const nonce = nonceHex ?? crypto.randomBytes(16).toString('hex');
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw new ActlBridgeError('INVALID_ARGUMENT', 'nonce must be 128-bit lowercase hex');
  }
  return `[ACTL_MANAGED_V1 commandId=${commandId} nonce=${nonce}]`;
}

export function composeWirePrompt(commandId: string, promptMd: string, nonceHex?: string): {
  wirePrompt: string;
  promptSha256: string;
  nonce: string;
} {
  const header = buildWirePromptHeader(commandId, nonceHex);
  const nonce = header.match(/nonce=([0-9a-f]{32})/)![1]!;
  const wirePrompt = `${header}\n${promptMd}`;
  return { wirePrompt, promptSha256: sha256Hex(wirePrompt), nonce };
}

/** Same narrative shape as the Claude wrapper initial Worker prompt. */
export function composeManagedWorkerPrompt(
  task: {
    taskId: string;
    title: string;
    goal: string;
    reason?: string;
    scope?: string;
    completionCriteria?: string[];
  },
  runId: string,
): string {
  const criteria =
    (task.completionCriteria ?? []).map((c) => `- ${c}`).join('\n') || '- (none)';
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
  if (Buffer.byteLength(prompt, 'utf8') > 16 * 1024) {
    throw new ActlBridgeError('INVALID_ARGUMENT', 'Worker prompt exceeds the 16 KiB cap.');
  }
  return prompt;
}

export function relayInstancePath(dataRoot: string): string {
  return path.join(path.resolve(dataRoot), '_relay', 'instance.json');
}

export function ensureRelayInstanceId(dataRoot: string): string {
  const filePath = relayInstancePath(dataRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { relayInstanceId?: string };
      if (typeof raw.relayInstanceId === 'string' && raw.relayInstanceId) {
        return raw.relayInstanceId;
      }
    } catch (err) {
      throw new ActlBridgeError(
        'INVALID_STATE',
        `relay instance.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const relayInstanceId = crypto.randomUUID();
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ relayInstanceId }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return relayInstanceId;
}

export function runtimeBindingPath(runFolder: string): string {
  return path.join(runFolder, 'runtime-binding.json');
}

export function writeRuntimeBinding(runFolder: string, binding: ActlRuntimeBinding): void {
  const filePath = runtimeBindingPath(runFolder);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

export function readRuntimeBinding(runFolder: string): ActlRuntimeBinding | null {
  const filePath = runtimeBindingPath(runFolder);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ActlRuntimeBinding;
  } catch (err) {
    throw new ActlBridgeError(
      'INVALID_STATE',
      `runtime-binding.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function writeFileAtomicInRun(runFolder: string, name: string, content: string): void {
  const filePath = path.join(runFolder, name);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* cleanup */ }
    throw err;
  }
}

export function expectedContextFromActl(
  actl: ActlDriverOptions,
  workspaceRoot: string,
): Record<string, unknown> {
  return {
    agentKind: actl.agentKind,
    profileRoot: actl.expectedProfileRoot,
    workspaceRoot: path.resolve(workspaceRoot),
  };
}

/** Read paneId from status/reserve envelope data (context or identityEvidence). */
export function extractPaneIdFromActlData(
  data: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const ctx = data.context;
  if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
    const paneId = (ctx as Record<string, unknown>).paneId;
    if (typeof paneId === 'string' && paneId.trim()) return paneId.trim();
  }
  const evidence = data.identityEvidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const paneId = (evidence as Record<string, unknown>).paneId;
    if (typeof paneId === 'string' && paneId.trim()) return paneId.trim();
  }
  if (typeof data.paneId === 'string' && data.paneId.trim()) return data.paneId.trim();
  return undefined;
}

/**
 * Build the send/collect expectedContext exclusively from reserve's frozen context.
 * Fail closed when paneId is missing — no alias remap from registry/config.
 */
export function frozenExpectedContextFromReserve(
  reserveData: Record<string, unknown>,
  preflight: Record<string, unknown>,
): Record<string, unknown> {
  const rawCtx = reserveData.context;
  const fromReserve =
    rawCtx && typeof rawCtx === 'object' && !Array.isArray(rawCtx)
      ? { ...(rawCtx as Record<string, unknown>) }
      : {};
  const paneId =
    (typeof fromReserve.paneId === 'string' && fromReserve.paneId.trim()
      ? fromReserve.paneId.trim()
      : undefined)
    ?? extractPaneIdFromActlData(reserveData);
  if (!paneId) {
    throw new ActlBridgeError(
      'INVALID_STATE',
      'reserve did not freeze paneId into context; refusing Managed send without exact pane binding',
      { sideEffect: 'NONE' },
    );
  }
  // Prefer reserve-frozen fields; fill only missing keys from preflight (never override paneId).
  const frozen: Record<string, unknown> = { ...preflight, ...fromReserve, paneId };
  return frozen;
}

/** Send/collect must use binding.frozenExpectedContext — never rebuild/remap from registry. */
export function expectedContextFromBinding(binding: ActlRuntimeBinding): Record<string, unknown> {
  if (binding.frozenExpectedContext && typeof binding.frozenExpectedContext === 'object') {
    const frozen = { ...binding.frozenExpectedContext };
    const paneId =
      (typeof frozen.paneId === 'string' && frozen.paneId.trim() ? frozen.paneId.trim() : undefined)
      ?? (typeof binding.paneId === 'string' && binding.paneId.trim() ? binding.paneId.trim() : undefined);
    if (!paneId) {
      throw new ActlBridgeError(
        'INVALID_STATE',
        'runtime-binding frozenExpectedContext missing paneId',
        { sideEffect: 'NONE' },
      );
    }
    if (binding.paneId && binding.paneId !== paneId) {
      throw new ActlBridgeError(
        'MISMATCH',
        `runtime-binding paneId ${binding.paneId} disagrees with frozenExpectedContext.paneId ${paneId}`,
        { sideEffect: 'NONE' },
      );
    }
    frozen.paneId = paneId;
    return frozen;
  }
  throw new ActlBridgeError(
    'INVALID_STATE',
    'runtime-binding missing frozenExpectedContext; Managed send/collect cannot remap from registry',
    { sideEffect: 'NONE' },
  );
}

export function scopeFields(socketPath: string): {
  socketPath: string;
  hostKey: string;
  uid: string;
  serverScope: { hostKey: string; uid: string; socketPath: string };
} {
  const hostKey = localHostKey();
  const uid = localUid();
  const sock = path.resolve(socketPath);
  return {
    socketPath: sock,
    hostKey,
    uid,
    serverScope: { hostKey, uid, socketPath: sock },
  };
}

/**
 * Invoke `actl runtime <op> --request-stdin` with shell:false.
 * Parses the first non-empty stdout line as the JSON envelope.
 */
export async function invokeActlRuntime(
  actlAbsPath: string,
  operation: ActlRuntimeOp,
  request: Record<string, unknown>,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<ActlInvokeResult> {
  if (!path.isAbsolute(actlAbsPath)) {
    throw new ActlBridgeError('INVALID_ARGUMENT', 'actl executable path must be absolute');
  }
  if (request.operation !== operation) {
    throw new ActlBridgeError('INVALID_ARGUMENT', 'request.operation must match CLI operation');
  }
  if (request.contractVersion !== ACTL_CONTRACT_VERSION) {
    throw new ActlBridgeError('INVALID_ARGUMENT', 'contractVersion must be 1');
  }

  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const child = spawn(actlAbsPath, ['runtime', operation, '--request-stdin'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts?.env ?? process.env,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

  const stdinJson = JSON.stringify(request);
  child.stdin?.write(stdinJson, 'utf8');
  child.stdin?.end();

  const exitCode = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // Send timeout after the child may have crossed ATTEMPTING → treat as possible input.
      reject(new ActlBridgeError(
        'TIMEOUT',
        `actl runtime ${operation} timed out after ${timeoutMs}ms`,
        {
          sideEffect: operation === 'send' || operation === 'interrupt'
            ? 'POSSIBLE_INPUT'
            : 'NONE',
        },
      ));
    }, timeoutMs);
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ActlBridgeError('LAUNCH_FAILED', `actl spawn failed: ${err.message}`, {
        sideEffect: 'NONE',
      }));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let envelope: ActlEnvelope | null = null;
  if (line) {
    try {
      envelope = JSON.parse(line) as ActlEnvelope;
    } catch {
      envelope = null;
    }
  }
  return { exitCode, envelope, stdout, stderr };
}

export async function invokeActlRuntimeOrThrow(
  actlAbsPath: string,
  operation: ActlRuntimeOp,
  request: Record<string, unknown>,
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ envelope: ActlEnvelope; data: Record<string, unknown> }> {
  let result: ActlInvokeResult;
  try {
    result = await invokeActlRuntime(actlAbsPath, operation, request, opts);
  } catch (err) {
    // Re-throw TIMEOUT / spawn failures with their sideEffect intact.
    throw err;
  }
  if (!result.envelope) {
    throw new ActlBridgeError(
      'INVALID_STATE',
      `actl runtime ${operation} produced no JSON envelope (exit ${result.exitCode}): ${result.stderr.slice(0, 400)}`,
      {
        exitCode: result.exitCode,
        // Missing envelope after send/interrupt cannot prove no input occurred.
        sideEffect: operation === 'send' || operation === 'interrupt'
          ? 'POSSIBLE_INPUT'
          : 'NONE',
      },
    );
  }
  if (!result.envelope.ok) {
    const err = result.envelope.error;
    throw new ActlBridgeError(
      err?.code ?? 'ACTL_ERROR',
      err?.detail ?? `actl runtime ${operation} failed`,
      {
        sideEffect: err?.sideEffect ?? 'NONE',
        exitCode: result.exitCode,
        envelope: result.envelope,
      },
    );
  }
  const data = (result.envelope.data && typeof result.envelope.data === 'object')
    ? result.envelope.data
    : {};
  return { envelope: result.envelope, data };
}

/** True when a send failure must be treated as delivery-unknown (no FAILED / no resend). */
export function isPostAttemptSendAmbiguity(err: unknown): boolean {
  if (!(err instanceof ActlBridgeError)) return false;
  if (err.code === 'DELIVERY_AMBIGUOUS' || err.code === 'TIMEOUT') return true;
  const side = err.sideEffect;
  if (side === 'POSSIBLE_INPUT' || side === 'INPUT_OBSERVED') return true;
  // Missing envelope after send is tagged POSSIBLE_INPUT above; also treat bare INVALID_STATE
  // without NONE as ambiguous when envelope is absent.
  if (err.code === 'INVALID_STATE' && !err.envelope && side !== 'NONE') return true;
  return false;
}

export function buildDefaultInputPermit(args: {
  commandId: string;
  runtimeId: string;
  fence: string;
  snapshotHash: string;
  confirmedAt?: string;
}): ActlInputPermit {
  return {
    commandId: args.commandId,
    runtimeId: args.runtimeId,
    fence: String(args.fence),
    paneMode: 'normal',
    confirmedAt: args.confirmedAt ?? new Date().toISOString(),
    snapshotHash: args.snapshotHash,
  };
}

export type ActlInputPermitFactory = (args: {
  commandId: string;
  runtimeId: string;
  fence: string;
  currentSnapshotHash: string;
}) => ActlInputPermit | Promise<ActlInputPermit>;

/** Fail-closed default: Owner/Proof/tests must install a real permit provider. */
const refuseInputPermitFactory: ActlInputPermitFactory = async () => {
  throw new ActlBridgeError(
    'INPUT_STATE_UNKNOWN',
    'Owner inputPermit factory is not installed. Proof CLI or tests must call setActlInputPermitFactory before actl send.',
    { sideEffect: 'NONE' },
  );
};

let inputPermitFactory: ActlInputPermitFactory = refuseInputPermitFactory;

/** Install Owner/test inputPermit provider. null restores fail-closed default. */
export function setActlInputPermitFactory(factory: ActlInputPermitFactory | null): void {
  inputPermitFactory = factory ?? refuseInputPermitFactory;
}

export async function obtainInputPermit(args: {
  commandId: string;
  runtimeId: string;
  fence: string;
  currentSnapshotHash: string;
}): Promise<ActlInputPermit> {
  if (!args.currentSnapshotHash || !String(args.currentSnapshotHash).trim()) {
    throw new ActlBridgeError(
      'INPUT_STATE_UNKNOWN',
      'currentSnapshotHash is required before obtaining Owner inputPermit',
      { sideEffect: 'NONE' },
    );
  }
  return inputPermitFactory(args);
}

export function correlationDigestForRun(args: {
  relayInstanceId: string;
  project: string;
  taskId: string;
  runId: string;
  commandId: string;
}): string {
  return sha256Hex(
    Buffer.from(
      JSON.stringify(
        sortKeys({
          commandId: args.commandId,
          project: args.project,
          relayInstanceId: args.relayInstanceId,
          runId: args.runId,
          taskId: args.taskId,
        }),
      ),
      'utf8',
    ),
  );
}
