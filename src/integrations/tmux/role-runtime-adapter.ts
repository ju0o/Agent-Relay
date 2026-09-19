import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { InputEnvelope, LiveSessionIdentity, RoleCapabilityFlags, RoleRuntimeAdapter } from '../core/role-runtime.js';

const execFileAsync = promisify(execFile);
const BLOCKED_COMMANDS = /tunnel-client|codex[- ](app-server|code-mode-host)|app-server/i;

type Pane = { paneId: string; pid: string; cwd: string; command: string; title: string };
type Session = { identity: LiveSessionIdentity; pane: Pane; marker?: string; completionMarker?: string; before?: string };

async function tmux(args: string[], input?: string): Promise<string> {
  if (input !== undefined) return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk) => out.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => err.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(Buffer.concat(err).toString('utf8') || `tmux exited ${code}`)));
    child.stdin.end(input);
  });
  const result = await execFileAsync('tmux', args, { maxBuffer: 256 * 1024 });
  return result.stdout;
}

function hash(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function stripAnsi(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); }

/** Generic role transport for an explicitly reserved tmux pane. */
export class TmuxRoleRuntimeAdapter implements RoleRuntimeAdapter {
  readonly id = 'tmux-external';
  private readonly targets: Record<string, string>;
  private readonly sessions = new Map<string, Session>();

  constructor(options: { targets: Record<string, string> }) { this.targets = { ...options.targets }; }

  capabilities(): RoleCapabilityFlags { return { persistentSession: true, structuredInput: true, structuredOutput: false, readWorkspace: true, writeWorkspace: true, shell: true, subscriptionAuth: true, freeTier: false }; }
  authMode() { return { mode: 'oauth-subscription' as const, provider: 'external-tmux-session' }; }

  private async inspect(target: string): Promise<Pane> {
    const raw = await tmux(['display-message', '-p', '-t', target, '#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{pane_title}']);
    const [paneId, pid, cwd, command, title] = raw.trimEnd().split('\t');
    if (!paneId || !pid || !cwd || !command) throw new Error('SESSION_TRANSPORT_LOST');
    if (BLOCKED_COMMANDS.test(command) || BLOCKED_COMMANDS.test(title ?? '')) throw new Error('WORKER_IDENTITY_EXCLUDED');
    return { paneId, pid, cwd, command, title: title ?? '' };
  }

  private async snapshot(paneId: string): Promise<string> { return tmux(['capture-pane', '-J', '-p', '-t', paneId, '-S', '-400']); }

  private idle(snapshot: string): boolean {
    const text = stripAnsi(snapshot);
    const tail = text.slice(-2000);
    return /› Ask Codex[^\n]*/.test(tail) && !/Working \(|esc to interrupt|Press enter to continue/.test(tail);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try { const roles = Object.keys(this.targets); if (!roles.length) return { ok: false, detail: 'no explicit role targets' }; await Promise.all(roles.map((role) => this.inspect(this.targets[role]!))); return { ok: true }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
  }

  async ensureSession(input: { roleId: string; project: string; sessionPolicy: 'persistent' | 'per-task'; sessionKey: string }): Promise<{ sessionId: string; created: boolean }> {
    const target = this.targets[input.roleId];
    if (!target) throw new Error(`SESSION_TARGET_MISSING:${input.roleId}`);
    const pane = await this.inspect(target);
    const before = await this.snapshot(pane.paneId);
    if (!this.idle(before)) throw new Error('INPUT_STATE_UNKNOWN');
    const sessionId = `${pane.paneId}:${pane.pid}`;
    const identity = { project: input.project, role: input.roleId, runtime: this.id, liveSessionIdentity: sessionId };
    this.sessions.set(sessionId, { identity, pane, before });
    return { sessionId, created: true };
  }

  async send(sessionId: string, envelope: InputEnvelope): Promise<{ requestId: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('SESSION_IDENTITY_MISMATCH');
    const current = await this.inspect(session.pane.paneId);
    if (current.pid !== session.pane.pid || current.cwd !== session.pane.cwd || !(await this.idle(await this.snapshot(current.paneId)))) throw new Error('STALE_OR_BUSY_SESSION');
    const marker = `AR${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const endMarker = `AE${marker.slice(2)}`;
    const completionMarker = `OK${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const wire = `${marker}\n${envelope.body}\nTransport completion marker: ${completionMarker}\n${endMarker}`;
    await tmux(['load-buffer', '-'], wire);
    await tmux(['paste-buffer', '-p', '-t', current.paneId]);
    await tmux(['send-keys', '-t', current.paneId, 'C-m']);
    session.marker = marker;
    session.completionMarker = completionMarker;
    session.before = await this.snapshot(current.paneId);
    return { requestId: `tmux-request-${randomUUID()}` };
  }

  async collect(sessionId: string, requestId: string, options: { timeoutMs: number }): Promise<{ text: string; raw?: unknown }> {
    const session = this.sessions.get(sessionId);
    if (!session?.marker) throw new Error(`unknown requestId: ${requestId}`);
    const deadline = Date.now() + options.timeoutMs;
    let current = '';
    let previousHash = '';
    let stable = 0;
    while (Date.now() < deadline) {
      current = await this.snapshot(session.pane.paneId);
      const text = stripAnsi(current);
      const currentHash = hash(current);
      stable = currentHash === previousHash ? stable + 1 : 0;
      previousHash = currentHash;
        const endMarker = `AE${session.marker.slice(2)}`;
        const start = text.lastIndexOf(endMarker);
        const completion = session.completionMarker ? text.lastIndexOf(session.completionMarker) : -1;
        if (start >= 0 && stable >= 1 && this.idle(text.slice(start))) {
        let response = text.slice(start + endMarker.length, completion > start ? completion : undefined).replace(/\r/g, '');
        const prompt = response.lastIndexOf('\n› Ask Codex');
        if (prompt >= 0) response = response.slice(0, prompt);
        const actionLines = [...response.matchAll(/(?:^|\n)\s*[•>*]?\s*(DISPATCH|REQUEST_CHANGES|ACCEPT|HUMAN_GATE|MILESTONE_COMPLETE)(?:\s+([^\n]+))?/g)];
        if (actionLines.length) {
          const last = actionLines[actionLines.length - 1]!;
          const rest = response.slice((last.index ?? 0) + last[0].length).trim();
          response = `${last[1]}${last[2] ? `\n${last[2].trim()}` : ''}${rest ? `\n${rest}` : ''}`;
        }
        else response = response.replace(/^\s*[•>*]\s?/gm, '').trim();
        if (!actionLines.length && (!/RESULT_PACKET/.test(response) || !/actual commands executed/i.test(response) || !/test\/build result/i.test(response) || !/acceptance criteria evidence/i.test(response) || !/known risks/i.test(response))) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        return { text: response, raw: { paneId: session.pane.paneId, snapshotHash: hash(current), requestId } };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('PM_BUILDER_TRANSPORT_TIMEOUT');
  }

  async interrupt(sessionId: string): Promise<void> { const session = this.sessions.get(sessionId); if (!session) throw new Error('SESSION_IDENTITY_MISMATCH'); await tmux(['send-keys', '-t', session.pane.paneId, 'C-c']); }
  async resume(sessionId: string): Promise<{ ok: boolean }> { try { const session = this.sessions.get(sessionId); if (!session) return { ok: false }; const pane = await this.inspect(session.pane.paneId); return { ok: pane.pid === session.pane.pid && this.idle(await this.snapshot(pane.paneId)) }; } catch { return { ok: false }; } }
  sessionIdentity(sessionId: string) { const identity = this.sessions.get(sessionId)?.identity; return { adapterId: this.id, sessionId, provider: 'external-tmux-session', ...(identity ? { identity } : {}) }; }
}
