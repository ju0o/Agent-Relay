/**
 * V1-G4-C — Resident PM Host Wake Bridge (local-first, host-independent).
 *
 * Relay Core owns durable PM Deliveries; this bridge notices pending
 * deliveries and hands the G4-B Verification Context to a configured PM Host
 * child process over stdio NDJSON — with NO user polling.
 *
 * Transport model (at-least-once, deliveryId is the dedupe identity):
 *   PENDING   = not yet handed to host transport
 *   DELIVERED = packet written to host stdin (receipt not yet confirmed)
 *   ACKNOWLEDGED = host returned a valid matching PM_DELIVERY_RECEIVED receipt
 *
 * Receipt means transport receipt ONLY — never PM judgment (G5 owns that).
 *
 * Security: the host command comes ONLY from trusted owner configuration
 * (.agent-relay/host.json). Never from Worker MCP, Task fields, results,
 * adapter output, or Delivery packets. Spawn uses argv + shell:false only.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  acknowledgePmDelivery,
  getPmDelivery,
  listPendingPmDeliveries,
  markPmDeliveryDelivered,
  reconcilePmDeliveries,
  reconcileFinalizedPmDeliveries,
  type PmDeliveryRecord,
} from './pm-delivery.js';
import { getVerificationContextForDelivery } from './pm-verification-context.js';
import { submitPmJudgment } from './pm-judgment.js';
import { prepareRetryForJudgment } from './retry-preparation.js';
import { dispatchV1Retry } from './retry-dispatch.js';
import { reconcileReadyRetryDispatches } from './retry-dispatch.js';
import { scanStuckWork } from './resume-scan.js';
import type { ResumeScanResult, ScanFinding } from './resume-scan.js';

/** Host protocol version (bridge ↔ PM Host child). */
export const PM_HOST_PROTOCOL_VERSION = 1;

/** host.json schema version. */
export const PM_HOST_CONFIG_SCHEMA_VERSION = 1;

/** Default internal watch cadence (ms). */
export const DEFAULT_POLL_MS = 1000;

/** Default receipt wait before a re-offer (ms). */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 30_000;

/** Default spawn backoff ceiling (ms). */
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Maximum runOnce drain iterations (re-entrancy guard). */
const RUN_ONCE_MAX_ITERATIONS = 25;

export interface PmHostTransportConfig {
  transport: 'stdio';
  command: string;
  args: string[];
}

export interface PmHostFileConfig {
  schemaVersion: 1;
  pmHost: PmHostTransportConfig;
}

export class PmHostConfigError extends Error {
  readonly code: 'HOST_CONFIG_MISSING' | 'HOST_CONFIG_INVALID' | 'HOST_TRANSPORT_UNSUPPORTED';
  constructor(code: PmHostConfigError['code'], message: string) {
    super(message);
    this.name = 'PmHostConfigError';
    this.code = code;
  }
}

export class PmHostBridgeError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'INTERNAL_ERROR';
  constructor(code: PmHostBridgeError['code'], message: string) {
    super(message);
    this.name = 'PmHostBridgeError';
    this.code = code;
  }
}

/** Conventional host config path: <configDir>/host.json (.agent-relay dir). */
export function hostConfigPath(configDir: string): string {
  return path.join(path.resolve(configDir), 'host.json');
}

function isForbiddenKey(k: string): boolean {
  const lower = k.toLowerCase();
  return lower.includes('secret') || lower.includes('token') || lower.includes('apikey');
}

/**
 * Load trusted owner host configuration. Strict shape; secrets forbidden.
 * Throws PmHostConfigError when missing/invalid.
 */
export function loadPmHostConfig(configDir: string): PmHostFileConfig {
  const file = hostConfigPath(configDir);
  if (!fs.existsSync(file)) {
    throw new PmHostConfigError('HOST_CONFIG_MISSING', `PM Host config not found: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PmHostConfigError('HOST_CONFIG_INVALID', `PM Host config parse error: ${msg}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PmHostConfigError('HOST_CONFIG_INVALID', 'PM Host config must be an object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key !== 'schemaVersion' && key !== 'pmHost') {
      throw new PmHostConfigError('HOST_CONFIG_INVALID', `PM Host config unknown field: ${key}`);
    }
    if (isForbiddenKey(key)) {
      throw new PmHostConfigError('HOST_CONFIG_INVALID', `PM Host config forbidden key: ${key}`);
    }
  }
  if (obj.schemaVersion !== PM_HOST_CONFIG_SCHEMA_VERSION) {
    throw new PmHostConfigError('HOST_CONFIG_INVALID', 'PM Host config schemaVersion must be 1');
  }
  const host = obj.pmHost;
  if (!host || typeof host !== 'object' || Array.isArray(host)) {
    throw new PmHostConfigError('HOST_CONFIG_INVALID', 'PM Host config missing pmHost object');
  }
  const h = host as Record<string, unknown>;
  for (const key of Object.keys(h)) {
    if (key !== 'transport' && key !== 'command' && key !== 'args') {
      throw new PmHostConfigError('HOST_CONFIG_INVALID', `PM Host config unknown pmHost field: ${key}`);
    }
    if (isForbiddenKey(key)) {
      throw new PmHostConfigError('HOST_CONFIG_INVALID', `PM Host config forbidden key: pmHost.${key}`);
    }
  }
  if (h.transport !== 'stdio') {
    throw new PmHostConfigError('HOST_TRANSPORT_UNSUPPORTED', 'Only stdio PM Host transport is supported in V1');
  }
  if (typeof h.command !== 'string' || !h.command.trim()) {
    throw new PmHostConfigError('HOST_CONFIG_INVALID', 'PM Host config pmHost.command is required');
  }
  if (h.args !== undefined && (!Array.isArray(h.args) || !h.args.every((a) => typeof a === 'string'))) {
    throw new PmHostConfigError('HOST_CONFIG_INVALID', 'PM Host config pmHost.args must be string[]');
  }
  return {
    schemaVersion: 1,
    pmHost: {
      transport: 'stdio',
      command: (h.command as string).trim(),
      args: [...((h.args ?? []) as string[])],
    },
  };
}

export interface HostBridgeOptions {
  dataRoot: string;
  project: string;
  hostCommand: string;
  hostArgs?: string[];
  /** Internal watch cadence ms (default 1000, clamped 25..60000). */
  pollMs?: number;
  /** Receipt wait before re-offer ms (default 30000, clamped >= pollMs). */
  receiptTimeoutMs?: number;
  /** Spawn backoff ceiling ms (default 30000). */
  maxBackoffMs?: number;
  logger?: (line: string) => void;
}

export interface HostBridgeOnceResult {
  reconciled: string[];
  delivered: string[];
  acknowledged: string[];
  /**
   * V2 R3 — read-only stuck-work scan snapshot (never blocks the drain).
   * Capped: at most 25 findings, `truncated` set when capped.
   */
  resumeScan: { scannedTasks: number; findings: ScanFinding[]; truncated: boolean };
}

interface InFlight {
  deliveryId: string;
  sentAtMs: number;
}

function clampPollMs(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_POLL_MS;
  return Math.min(60_000, Math.max(25, Math.floor(v)));
}

const RESUME_SCAN_LOG_MAX = 8;
const RESUME_SCAN_RESULT_MAX = 25;

/**
 * V2 R3 — best-effort read-only stuck-work scan. Never throws, never
 * executes anything. Returns a zeroed snapshot on any failure so bridge
 * startup / drain can never break on it.
 */
function scanStuckBestEffort(dataRoot: string, project: string): {
  scannedTasks: number;
  findings: ScanFinding[];
  truncated: boolean;
} {
  try {
    const r: ResumeScanResult = scanStuckWork(dataRoot, project);
    const capped = r.findings.slice(0, RESUME_SCAN_RESULT_MAX);
    return { scannedTasks: r.scannedTasks, findings: capped, truncated: r.findings.length > capped.length };
  } catch {
    return { scannedTasks: 0, findings: [], truncated: false };
  }
}

/**
 * Resident bridge: reconcile on start, then poll the durable pending queue
 * and hand verification packets to the PM Host child. Serial (V1): one
 * delivery at a time. At-least-once: deliveryId dedupes on the host side.
 */
export class PmHostBridge {
  private readonly dataRoot: string;
  private readonly project: string;
  private readonly hostCommand: string;
  private readonly hostArgs: string[];
  private readonly pollMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly maxBackoffMs: number;
  private readonly logger: (line: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private started = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = '';
  private inFlight: InFlight | null = null;
  private waiters = new Map<string, Array<(ok: boolean) => void>>();
  private spawnAttempts = 0;
  private backoffFailures = 0;
  private nextSpawnAtMs = 0;
  private idleLogged = false;

  constructor(opts: HostBridgeOptions) {
    if (!opts || typeof opts !== 'object') {
      throw new PmHostBridgeError('INVALID_ARGUMENT', 'HostBridgeOptions is required');
    }
    if (!opts.dataRoot || !opts.project) {
      throw new PmHostBridgeError('INVALID_ARGUMENT', 'dataRoot and project are required');
    }
    if (typeof opts.hostCommand !== 'string' || !opts.hostCommand.trim()) {
      throw new PmHostBridgeError('INVALID_ARGUMENT', 'hostCommand is required');
    }
    if (opts.hostArgs !== undefined && (!Array.isArray(opts.hostArgs) || !opts.hostArgs.every((a) => typeof a === 'string'))) {
      throw new PmHostBridgeError('INVALID_ARGUMENT', 'hostArgs must be string[]');
    }
    this.dataRoot = opts.dataRoot;
    this.project = opts.project;
    this.hostCommand = opts.hostCommand.trim();
    this.hostArgs = [...(opts.hostArgs ?? [])];
    this.pollMs = clampPollMs(opts.pollMs);
    this.receiptTimeoutMs = typeof opts.receiptTimeoutMs === 'number' && Number.isFinite(opts.receiptTimeoutMs)
      ? Math.max(this.pollMs, Math.floor(opts.receiptTimeoutMs))
      : DEFAULT_RECEIPT_TIMEOUT_MS;
    this.maxBackoffMs = typeof opts.maxBackoffMs === 'number' && Number.isFinite(opts.maxBackoffMs) && opts.maxBackoffMs > 0
      ? Math.floor(opts.maxBackoffMs)
      : DEFAULT_MAX_BACKOFF_MS;
    this.logger = opts.logger ?? ((line: string) => console.log(line));
  }

  /** Test introspection: spawn attempts so far. */
  getSpawnAttempts(): number {
    return this.spawnAttempts;
  }

  /** Test introspection: live host child present. */
  isHostAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  /** Start: reconcile, then watch persistently until stop(). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const rec = await reconcilePmDeliveries(this.dataRoot, this.project);
    this.log(`Bridge started (reconciled ${rec.ensured.length} delivery(s))`);
    // V1-G5-C restart reconciliation: adopt already-correlated retry Runs,
    // dispatch READY unconsumed preparations once, skip anything else.
    // Best-effort only — never breaks bridge startup.
    try {
      const retried = await reconcileReadyRetryDispatches(this.dataRoot, this.project);
      const acted = retried.filter((r) => r.outcome !== 'skipped');
      if (acted.length) {
        this.log(`Retry reconcile: ${acted.map((r) => `${r.preparationId}=${r.outcome}${r.runId ? `:${r.runId}` : ''}`).join(', ')}`);
      }
    } catch (err) {
      this.log(`Retry reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // V2 R3 — restart integration: read-only stuck-work scan at startup.
    // Report only via the log channel; executes nothing; never breaks startup.
    const stuck = scanStuckBestEffort(this.dataRoot, this.project);
    if (stuck.findings.length > 0) {
      this.log(`Resume scan: ${stuck.findings.length} stuck finding(s) in ${stuck.scannedTasks} task(s) — report only, see TUI [s] / resume-scan`);
      for (const f of stuck.findings.slice(0, RESUME_SCAN_LOG_MAX)) {
        this.log(`  [${f.pattern}] ${f.taskId}: ${f.detail.slice(0, 120)}`);
      }
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.failWaiters();
    const child = this.child;
    this.child = null;
    this.inFlight = null;
    if (child) {
      child.removeAllListeners();
      try {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      } catch { /* ignore */ }
    }
    this.log('Bridge stopped');
  }

  /**
   * Deterministic single pass for --once / tests: reconcile, then drain the
   * pending queue serially (bounded iterations). Returns what moved.
   */
  async runOnce(opts?: { maxDeliveries?: number }): Promise<HostBridgeOnceResult> {
    const rec = await reconcilePmDeliveries(this.dataRoot, this.project);
    await reconcileFinalizedPmDeliveries(this.dataRoot, this.project);
    const delivered: string[] = [];
    const acknowledged: string[] = [];
    // V2 R3 — same read-only scan snapshot for the single-pass path.
    const resumeScan = scanStuckBestEffort(this.dataRoot, this.project);
    const max = typeof opts?.maxDeliveries === 'number' && opts.maxDeliveries > 0
      ? Math.min(Math.floor(opts.maxDeliveries), RUN_ONCE_MAX_ITERATIONS)
      : RUN_ONCE_MAX_ITERATIONS;
    if (!this.ensureChild()) {
      return { reconciled: rec.ensured, delivered, acknowledged, resumeScan };
    }
    for (let i = 0; i < max; i++) {
      if (this.stopping) break;
      const next = await this.pickNext();
      if (!next) break;
      const sent = await this.sendDelivery(next);
      if (!sent) {
        if (!this.isHostAlive()) break;
        continue;
      }
      delivered.push(next.deliveryId);
      if (await this.waitReceipt(next.deliveryId, this.receiptTimeoutMs)) {
        acknowledged.push(next.deliveryId);
      }
    }
    return { reconciled: rec.ensured, delivered, acknowledged, resumeScan };
  }

  // ── internal tick ──────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (!this.ensureChild()) {
      this.logIdle('Waiting for PM Host… (host unavailable, deliveries retained)');
      return;
    }
    if (this.inFlight) {
      if (this.isHostAlive()) {
        if (Date.now() - this.inFlight.sentAtMs > this.receiptTimeoutMs) {
          this.log(`Receipt timeout for ${this.inFlight.deliveryId}; will re-offer`);
          this.inFlight = null;
        } else {
          return;
        }
      } else {
        // Child died after handoff — record stays DELIVERED; re-offer below.
        this.inFlight = null;
      }
    }
    const next = await this.pickNext();
    if (!next) {
      this.logIdle('Waiting for pending deliveries…');
      return;
    }
    this.idleLogged = false;
    await this.sendDelivery(next);
  }

  /** First non-terminal delivery (re-read latest; defensive terminal skip). */
  private async pickNext(): Promise<PmDeliveryRecord | null> {
    await reconcileFinalizedPmDeliveries(this.dataRoot, this.project);
    let queue: PmDeliveryRecord[];
    try {
      queue = listPendingPmDeliveries(this.dataRoot, this.project);
    } catch (err) {
      this.log(`queue read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    for (const item of queue) {
      let latest: PmDeliveryRecord;
      try {
        latest = getPmDelivery(this.dataRoot, this.project, item.deliveryId);
      } catch {
        continue;
      }
      if (latest.status === 'PENDING' || latest.status === 'DELIVERED') return latest;
    }
    return null;
  }

  /**
   * Compose + hand off one delivery. Returns true when the packet reached
   * host transport (record now DELIVERED, receipt awaited). Never throws for
   * per-delivery problems (warn + false); host death surfaces as false.
   */
  private async sendDelivery(rec: PmDeliveryRecord): Promise<boolean> {
    const child = this.child;
    if (!child || !this.isHostAlive()) return false;
    let packet;
    try {
      packet = getVerificationContextForDelivery(this.dataRoot, this.project, rec.deliveryId);
    } catch (err) {
      this.log(`Skipping ${rec.deliveryId}: context failed (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
    const line = JSON.stringify({
      type: 'PM_VERIFICATION_DELIVERY',
      protocolVersion: PM_HOST_PROTOCOL_VERSION,
      deliveryId: rec.deliveryId,
      packet,
    });
    try {
      await this.writeLine(child, line);
    } catch (err) {
      this.log(`Handoff failed for ${rec.deliveryId} (remains PENDING): ${err instanceof Error ? err.message : String(err)}`);
      this.killChild();
      return false;
    }
    try {
      if (rec.status === 'PENDING') {
        await markPmDeliveryDelivered(this.dataRoot, this.project, rec.deliveryId, 'PENDING');
      } else {
        // Re-offer of a DELIVERED-unacked record: idempotent replay.
        await markPmDeliveryDelivered(this.dataRoot, this.project, rec.deliveryId, 'DELIVERED');
      }
    } catch (err) {
      this.log(`DELIVERED write failed for ${rec.deliveryId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.inFlight = { deliveryId: rec.deliveryId, sentAtMs: Date.now() };
    this.log(`Delivery ${rec.deliveryId} handed to PM Host`);
    return true;
  }

  private writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      child.stdin.write(line + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private waitReceipt(deliveryId: string, timeoutMs: number): Promise<boolean> {
    if (!this.inFlight || this.inFlight.deliveryId !== deliveryId) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(deliveryId);
        if (list) {
          const idx = list.indexOf(done);
          if (idx >= 0) list.splice(idx, 1);
        }
        resolve(false);
      }, timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const list = this.waiters.get(deliveryId) ?? [];
      list.push(done);
      this.waiters.set(deliveryId, list);
    });
  }

  private failWaiters(): void {
    for (const list of this.waiters.values()) {
      for (const done of list) {
        try { done(false); } catch { /* ignore */ }
      }
    }
    this.waiters.clear();
  }

  // ── child lifecycle ────────────────────────────────────────────────────────

  /** Ensure a live host child (bounded backoff). Returns aliveness. */
  private ensureChild(): boolean {
    if (this.isHostAlive()) return true;
    this.child = null;
    if (Date.now() < this.nextSpawnAtMs) return false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.hostCommand, this.hostArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.noteSpawnFailure(`spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.spawnAttempts += 1;
    this.child = child;
    this.stdoutBuf = '';
    child.stdout.on('data', (d: Buffer) => this.onHostStdout(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => {
      const preview = d.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (preview) this.log(`PM Host stderr: ${preview}`);
    });
    child.on('error', (err: Error) => {
      this.log(`PM Host spawn error: ${err.message}`);
      this.killChild();
      this.noteSpawnFailure('spawn error event');
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.log(`PM Host exited (code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''})`);
      this.killChild();
      this.inFlight = null;
      this.failWaitersForDeadHost();
      // Back off restarts; deliveries stay durable (PENDING or DELIVERED).
      this.backoffFailures += 1;
      this.nextSpawnAtMs = Date.now() + Math.min(1000 * 2 ** Math.min(this.backoffFailures, 5), this.maxBackoffMs);
    });
    this.log('PM Host connected');
    return true;
  }

  private killChild(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      child.removeAllListeners();
      try {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      } catch { /* ignore */ }
    }
  }

  private noteSpawnFailure(reason: string): void {
    this.log(`PM Host unavailable (${reason}); deliveries retained`);
    this.backoffFailures += 1;
    this.nextSpawnAtMs = Date.now() + Math.min(1000 * 2 ** Math.min(this.backoffFailures, 5), this.maxBackoffMs);
  }

  private failWaitersForDeadHost(): void {
    // Receipts can no longer arrive on a dead transport; waiters resolve false
    // so runOnce/callers re-offer later instead of hanging.
    this.failWaiters();
  }

  private onHostStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    const lines = this.stdoutBuf.split('\n');
    this.stdoutBuf = lines.pop() ?? '';
    for (const raw of lines) {
      this.onHostLine(raw);
    }
  }

  private onHostLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.log(`Ignoring malformed host line: ${trimmed.slice(0, 120)}`);
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      this.log('Ignoring malformed host message (not an object)');
      return;
    }
    const m = msg as Record<string, unknown>;
    if (m.type === 'PM_TASK_JUDGMENT') {
      void this.handleJudgment(m);
      return;
    }
    if (m.type !== 'PM_DELIVERY_RECEIVED' || m.protocolVersion !== PM_HOST_PROTOCOL_VERSION || typeof m.deliveryId !== 'string') {
      this.log('Ignoring non-receipt host message');
      return;
    }
    const deliveryId = m.deliveryId as string;
    if (!this.inFlight || this.inFlight.deliveryId !== deliveryId) {
      this.log(`Ignoring receipt for non-in-flight delivery: ${deliveryId.slice(0, 64)}`);
      return;
    }
    void this.confirmReceipt(deliveryId);
  }

  private async confirmReceipt(deliveryId: string): Promise<void> {
    try {
      await acknowledgePmDelivery(this.dataRoot, this.project, deliveryId, 'DELIVERED');
    } catch (err) {
      this.log(`ACK write failed for ${deliveryId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.inFlight?.deliveryId === deliveryId) this.inFlight = null;
    const list = this.waiters.get(deliveryId) ?? [];
    this.waiters.delete(deliveryId);
    for (const done of list) {
      try { done(true); } catch { /* ignore */ }
    }
    this.backoffFailures = 0;
    this.nextSpawnAtMs = 0;
    this.log(`Receipt confirmed for ${deliveryId}`);
  }

  /**
   * V1-G5-A: route a structured PM judgment from the host through the same
   * backend intake as the MCP surface, then report the operational outcome
   * back over stdio. Transport receipt (PM_DELIVERY_RECEIVED) stays separate.
   */
  private async handleJudgment(m: Record<string, unknown>): Promise<void> {
    const child = this.child;
    const reply = async (obj: Record<string, unknown>): Promise<void> => {
      if (!child || !this.isHostAlive()) return;
      try {
        await this.writeLine(child, JSON.stringify(obj));
      } catch {
        // Reply best-effort; judgment durability does not depend on it.
      }
    };
    const deliveryRaw = m.deliveryId;
    const deliveryId = typeof deliveryRaw === 'string' ? deliveryRaw : 'unknown';
    let result: { judgment: { judgmentId: string; decision: string; status: string }; applied: boolean; task: { executionState: string; pmState: string } };
    try {
      result = await submitPmJudgment(this.dataRoot, this.project, {
        deliveryId: typeof m.deliveryId === 'string' ? m.deliveryId : '',
        decision: m.decision as 'ACCEPT' | 'CHANGES',
        ...(typeof m.reason === 'string' ? { reason: m.reason } : {}),
        ...(typeof m.retryInstruction === 'string' ? { retryInstruction: m.retryInstruction } : {}),
        ...(m.protocolVersion !== undefined ? { protocolVersion: m.protocolVersion } : {}),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await reply({
        type: 'PM_JUDGMENT_REJECTED',
        protocolVersion: PM_HOST_PROTOCOL_VERSION,
        deliveryId,
        reason: reason.slice(0, 500),
      });
      this.log(`Judgment rejected for ${deliveryId.slice(0, 64)}`);
      return;
    }
    // V1-G5-B: one CHANGES judgment drives intake + retry preparation.
    // ACCEPT is fully applied by the intake itself. A preparation failure
    // reports REJECTED (bounded); durable intent/preparation survive anyway.
    let taskState = { executionState: result.task.executionState, pmState: result.task.pmState };
    let status = result.judgment.status === 'APPLIED'
      ? 'APPLIED'
      : result.judgment.status === 'RECEIVED' && result.judgment.decision === 'CHANGES'
        ? 'RECORDED'
        : result.judgment.status;
    if (result.judgment.decision === 'CHANGES') {
      try {
        const prepared = await prepareRetryForJudgment(this.dataRoot, this.project, deliveryId);
        taskState = { executionState: prepared.task.executionState, pmState: prepared.task.pmState };
        status = 'APPLIED';
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await reply({
          type: 'PM_JUDGMENT_REJECTED',
          protocolVersion: PM_HOST_PROTOCOL_VERSION,
          deliveryId,
          reason: reason.slice(0, 500),
        });
        this.log(`Retry preparation failed for ${deliveryId.slice(0, 64)}`);
        return;
      }
      // V1-G5-C: READY preparation automatically continues to same-Task
      // redispatch (no second owner GO). A redispatch failure keeps the
      // truthful APPLIED/READY state with a bounded retryError; the durable
      // preparation stays recoverable via retry-dispatch reconciliation.
      try {
        const redispatched = await dispatchV1Retry(this.dataRoot, this.project, { deliveryId });
        taskState = { executionState: redispatched.task.executionState, pmState: redispatched.task.pmState };
        status = 'REDISPATCHED';
        await reply({
          type: 'PM_JUDGMENT_APPLIED',
          protocolVersion: PM_HOST_PROTOCOL_VERSION,
          deliveryId,
          decision: result.judgment.decision,
          status,
          taskState,
          retryRunId: redispatched.runId,
        });
        this.log(`Judgment ${status} for ${deliveryId.slice(0, 64)} (${result.judgment.decision} → ${redispatched.runId})`);
        return;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await reply({
          type: 'PM_JUDGMENT_APPLIED',
          protocolVersion: PM_HOST_PROTOCOL_VERSION,
          deliveryId,
          decision: result.judgment.decision,
          status,
          taskState,
          retryError: reason.slice(0, 500),
        });
        this.log(`Redispatch failed for ${deliveryId.slice(0, 64)} (preparation recoverable)`);
        return;
      }
    }
    await reply({
      type: 'PM_JUDGMENT_APPLIED',
      protocolVersion: PM_HOST_PROTOCOL_VERSION,
      deliveryId,
      decision: result.judgment.decision,
      status,
      taskState,
    });
    this.log(`Judgment ${status} for ${deliveryId.slice(0, 64)} (${result.judgment.decision})`);
  }

  private log(line: string): void {
    this.idleLogged = false;
    try {
      this.logger(`[host-bridge] ${line}`);
    } catch { /* logger must never break the loop */ }
  }

  private logIdle(line: string): void {
    if (this.idleLogged) return;
    this.idleLogged = true;
    try {
      this.logger(`[host-bridge] ${line}`);
    } catch { /* ignore */ }
  }
}
