/**
 * Transport boundary — tmux/actl/subprocess are TRANSPORT ONLY.
 *
 * The full capture-pane scrollback is NEVER the authoritative Result.
 * Every request carries a unique requestId; the transport embeds a
 * per-request begin marker and collects ONLY the response boundary that
 * belongs to that requestId:
 *
 *   AR_TURN_BEGIN:<requestId>
 *   ... response body ...
 *   AR_TURN_END:<requestId>
 *
 * Markers are random per request (uuid suffix), so historical markers from
 * older cycles can never match a new request. Collection requires BOTH the
 * matching end marker AND a stable capture (hash-quiet) or an idle prompt —
 * truncated scrollback without the end marker is NOT a result (retry /
 * timeout instead of pretending).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TurnRecord } from './turn-store.js';

const execFileAsync = promisify(execFile);

export interface TurnSession {
  kind: 'tmux' | 'subprocess';
  /** tmux pane target (e.g. %3) or subprocess command. */
  target: string;
  args?: string[];
  cwd?: string;
  /** Extra environment for spawned turn processes (subprocess only). */
  env?: Record<string, string>;
  /**
   * Readiness pattern the collected boundary must match (tmux only).
   * Interactive agents print free-form replies, so completion additionally
   * requires role-shaped content (e.g. a decision verb). A reply that never
   * matches is a bounded timeout — never a silent misread.
   */
  expect?: RegExp;
}

export interface CollectResult {
  text: string;
  requestId: string;
  stable: boolean;
}

export interface TurnTransport {
  readonly kind: string;
  sendTurn(turn: TurnRecord, session: TurnSession): Promise<void>;
  collectTurn(turn: TurnRecord, session: TurnSession, timeoutMs: number): Promise<CollectResult>;
  checkHealth(session: TurnSession): Promise<{ ok: boolean; detail?: string }>;
}

export function beginMarker(requestId: string): string {
  return `AR_TURN_BEGIN:${requestId}`;
}
export function endMarker(requestId: string): string {
  return `AR_TURN_END:${requestId}`;
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/** Extract the CURRENT request's boundary. Returns null when the matching
 *  end marker is absent (truncated/old output is never a result). */
export function extractBoundary(captured: string, requestId: string): string | null {
  const text = stripAnsi(captured).replace(/\r/g, '');
  const begin = beginMarker(requestId);
  const end = endMarker(requestId);
  const start = text.lastIndexOf(begin);
  if (start < 0) return null;
  const stop = text.indexOf(end, start + begin.length);
  if (stop < 0) return null;
  return text.slice(start + begin.length, stop).trim();
}

export function newRequestId(): string {
  return `r${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

// ── subprocess transport (real OS process, real pipes) ─────────────────────

async function tmux(args: string[], input?: string): Promise<string> {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (c) => out.push(Buffer.from(c)));
      child.stderr.on('data', (c) => err.push(Buffer.from(c)));
      child.on('error', reject);
      child.on('close', (code) => (code === 0
        ? resolve(Buffer.concat(out).toString('utf8'))
        : reject(new Error(Buffer.concat(err).toString('utf8') || `tmux exited ${code}`))));
      child.stdin.end(input);
    });
  }
  const res = await execFileAsync('tmux', args, { maxBuffer: 4 * 1024 * 1024 });
  return res.stdout;
}

/**
 * Subprocess lane transport: per turn, sendTurn() spawns `command [...args]`
 * ONCE, feeds the wire format on stdin, and redirects all output to a
 * durable per-turn file `<ioDir>/<turnId>.out`. collectTurn() tails THAT
 * file for this request's end marker.
 *
 * Why files, not pipes: if the Runner is kill -9'd mid-build, the orphaned
 * child keeps writing the same file; the resumed process collects the
 * boundary from disk — the Builder ran exactly once. Re-spawning happens
 * only for a NEW attempt turn (new turnId, new file). Old files are never
 * truncated or reused. Without ioDir, pipe mode spawns inside collectTurn.
 */
export class SubprocessTransport implements TurnTransport {
  readonly kind = 'subprocess';
  private readonly children = new Map<string, import('node:child_process').ChildProcess>();
  private readonly pendingWires = new Map<string, string>();

  constructor(private readonly ioDir?: string) {}

  private outFile(turnId: string): string | null {
    if (!this.ioDir) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(turnId)) throw new Error(`bad turnId: ${turnId}`);
    return path.join(path.resolve(this.ioDir), `${turnId}.out`);
  }

  async sendTurn(turn: TurnRecord, session: TurnSession): Promise<void> {
    const wire = `${beginMarker(turn.requestId)}\n${turn.requestBody}\n${endMarker(turn.requestId)}\n`;
    const file = this.outFile(turn.turnId);
    if (!file) {
      // Pipe mode (no ioDir): delivery deferred into collectTurn's spawn.
      this.pendingWires.set(turn.turnId, wire);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'w');
    const child = spawn(session.target, session.args ?? [], {
      cwd: session.cwd,
      env: { ...process.env, ...(session.env ?? {}) },
      stdio: ['pipe', fd, fd],
    });
    fs.closeSync(fd);
    child.unref();
    child.on('error', () => { this.children.delete(turn.turnId); });
    child.on('exit', () => { this.children.delete(turn.turnId); });
    this.children.set(turn.turnId, child);
    child.stdin!.end(wire);
  }

  private killBestEffort(turnId: string): void {
    const child = this.children.get(turnId);
    if (!child) return;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    this.children.delete(turnId);
  }

  private readOut(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  async collectTurn(turn: TurnRecord, session: TurnSession, timeoutMs: number): Promise<CollectResult> {
    const file = this.outFile(turn.turnId);
    if (!file) return this.collectPipe(turn, session, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = extractBoundary(this.readOut(file), turn.requestId);
      if (body !== null) {
        this.killBestEffort(turn.turnId);
        return { text: body, requestId: turn.requestId, stable: true };
      }
      if (Date.now() >= deadline) {
        this.killBestEffort(turn.turnId);
        throw new Error(`TURN_TIMEOUT: no end marker for ${turn.requestId} within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** Pipe mode: spawn-now-and-stream (used when no ioDir is configured). */
  private collectPipe(turn: TurnRecord, session: TurnSession, timeoutMs: number): Promise<CollectResult> {
    const wire = this.pendingWires.get(turn.turnId)
      ?? `${beginMarker(turn.requestId)}\n${turn.requestBody}\n${endMarker(turn.requestId)}\n`;
    this.pendingWires.delete(turn.turnId);
    return new Promise((resolve, reject) => {
      const child = spawn(session.target, session.args ?? [], {
        cwd: session.cwd,
        env: { ...process.env, ...(session.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
      let out = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        reject(new Error(`TURN_TIMEOUT: no end marker for ${turn.requestId} within ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on('data', (c) => {
        out += c.toString('utf8');
        const body = extractBoundary(out, turn.requestId);
        if (body !== null && !done) {
          done = true;
          clearTimeout(timer);
          try { child.kill('SIGKILL'); } catch { /* reaped */ }
          resolve({ text: body, requestId: turn.requestId, stable: true });
        }
      });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const body = extractBoundary(out, turn.requestId);
        if (body !== null) resolve({ text: body, requestId: turn.requestId, stable: true });
        else reject(new Error(`TURN_NO_BOUNDARY: process exited without end marker for ${turn.requestId}`));
      });
      child.stdin!.end(wire);
    });
  }

  async checkHealth(session: TurnSession): Promise<{ ok: boolean; detail?: string }> {
    try {
      await execFileAsync(session.target, ['--version'], { timeout: 8000 });
      return { ok: true };
    } catch {
      // No --version contract; existence of an executable target is enough.
      return { ok: true, detail: 'no version probe; target assumed executable' };
    }
  }
}

// ── tmux transport (real pane, request-scoped boundary) ─────────────────────

/**
 * TUI panes reflow pasted lines (wrapping at hyphens/width, adding `› `
 * prefixes), so a contiguous indexOf NEVER matches a marker reliably.
 * The anchor regex tolerates arbitrary whitespace (including newlines and
 * TUI prefixes are outside the tag itself) between every marker char.
 * RequestIds stay unique, so only this turn's tag can match.
 */
function anchorRe(requestId: string): RegExp {
  const tag = endMarker(requestId);
  const pat = [...tag].map((c) => c.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('\\s*');
  return new RegExp(pat);
}

function idleTail(text: string): boolean {
  const tail = stripAnsi(text).slice(-2000);
  return !/Working \(|esc to interrupt|Press enter to continue|Do you trust/i.test(tail);
}

/**
 * Tmux lane transport: pastes a per-request marked envelope and collects the
 * response window AFTER our just-sent end marker. Interactive agents do not
 * echo request markers, so completion = settled capture + idle pane +
 * role-shaped content (session.expect). Whole-scrollback greps and fixed
 * DONE strings are not used anywhere here; the unique per-request marker
 * anchors the window, so stale history can never match.
 */
export class TmuxTransport implements TurnTransport {
  readonly kind = 'tmux';

  private async inspect(pane: string): Promise<{ paneId: string; pid: string; cwd: string }> {
    const raw = await tmux(['display-message', '-p', '-t', pane, '#{pane_id}\t#{pane_pid}\t#{pane_current_path}']);
    const [paneId, pid, cwd] = raw.trimEnd().split('\t');
    if (!paneId || !pid || !cwd) throw new Error('TRANSPORT_LOST: pane unreadable');
    return { paneId, pid, cwd };
  }

  private async snapshot(paneId: string, lines = 400): Promise<string> {
    return tmux(['capture-pane', '-J', '-p', '-t', paneId, '-S', `-${lines}`]);
  }

  async sendTurn(turn: TurnRecord, session: TurnSession): Promise<void> {
    const cur = await this.inspect(session.target);
    try {
      process.kill(Number(cur.pid), 0);
    } catch {
      throw new Error('TRANSPORT_LOST: pane pid not alive');
    }
    const before = stripAnsi(await this.snapshot(cur.paneId, 30));
    if (!idleTail(before)) throw new Error('NOT_IDLE: pane is busy; turn deferred, nothing sent');
    const wire = `${beginMarker(turn.requestId)}\n${turn.requestBody}\n${endMarker(turn.requestId)}`;
    await tmux(['load-buffer', '-'], wire);
    await tmux(['paste-buffer', '-p', '-t', cur.paneId]);
    await tmux(['send-keys', '-t', cur.paneId, 'C-m']);
  }

  async collectTurn(turn: TurnRecord, session: TurnSession, timeoutMs: number): Promise<CollectResult> {
    const cur = await this.inspect(session.target);
    const anchor = anchorRe(turn.requestId);
    const deadline = Date.now() + timeoutMs;
    let prev = '';
    let stable = 0;
    for (;;) {
      const snap = await this.snapshot(cur.paneId);
      const h = hash(snap);
      stable = h === prev ? stable + 1 : 0;
      prev = h;
      const clean = stripAnsi(snap).replace(/\r/g, '');
      const hit = anchor.exec(clean);
      // anchorRe tolerates TUI reflow (wraps/prefixes) inside the marker.
      if (hit) {
        const after = clean.slice((hit.index ?? 0) + hit[0].length);
        // Drop trailing TUI prompt lines (›/❯); response content never uses them.
        const lines = after.split('\n');
        while (lines.length && /^[›❯]/.test(lines[lines.length - 1]!.trim())) lines.pop();
        const trimmed = lines.join('\n').trim();
        if (stable >= 2 && idleTail(snap) && (!session.expect || session.expect.test(trimmed))) {
          return { text: trimmed, requestId: turn.requestId, stable: true };
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`TURN_TIMEOUT: no settled boundary for ${turn.requestId} within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async checkHealth(session: TurnSession): Promise<{ ok: boolean; detail?: string }> {
    try {
      const cur = await this.inspect(session.target);
      try {
        process.kill(Number(cur.pid), 0);
      } catch {
        return { ok: false, detail: `pane pid ${cur.pid} not alive` };
      }
      return { ok: true, detail: `${cur.paneId}:${cur.pid}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
