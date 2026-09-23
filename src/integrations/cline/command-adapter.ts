import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InputEnvelope, RoleRuntimeAdapter, RoleCapabilityFlags } from '../core/role-runtime.js';

export interface ClineCommandAdapterConfig {
  cwd: string;
  dataRoot?: string;
  /** Test seam only; production defaults to the installed `cline` binary. */
  command?: string;
  provider?: 'cline' | 'cline-pass';
  model?: string;
  timeoutSeconds?: number;
}

type Pending = { text: string; raw: unknown; child?: ChildProcess };

/** Cline CLI adapter. It deliberately has no API-key option or key handling. */
export class ClineCommandAdapter implements RoleRuntimeAdapter {
  readonly id = 'cline-command';
  private readonly cwd: string;
  private readonly command: string;
  private readonly dataRoot?: string;
  private readonly provider: 'cline' | 'cline-pass';
  private readonly model?: string;
  private readonly timeoutSeconds: number;
  private readonly sessions = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private readonly children = new Map<string, ChildProcess>();

  constructor(config: ClineCommandAdapterConfig) {
    this.cwd = path.resolve(config.cwd);
    this.command = config.command ?? 'cline';
    this.dataRoot = config.dataRoot;
    this.provider = config.provider ?? 'cline-pass';
    this.model = config.model;
    this.timeoutSeconds = config.timeoutSeconds ?? 120;
  }

  health(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
      child.on('error', (error) => resolve({ ok: false, detail: error.message }));
      child.on('close', (code) => resolve(code === 0 ? { ok: true, detail: output.trim() } : { ok: false, detail: `cline exited ${code}` }));
    });
  }

  capabilities(): RoleCapabilityFlags {
    return {
      persistentSession: true,
      structuredInput: true,
      structuredOutput: true,
      readWorkspace: true,
      // Proven by the disposable cline-pass smoke in the task evidence.
      writeWorkspace: true,
      // Shell execution was not part of the bounded smoke; do not claim it.
      shell: false,
      subscriptionAuth: this.provider === 'cline-pass',
      freeTier: true,
    };
  }

  authMode(): { mode: 'oauth-subscription' | 'existing-plan-key' | 'free' | 'unknown'; provider?: string } {
    // Only the named Cline OAuth provider is accepted. No key or token is read.
    return this.provider === 'cline-pass'
      ? { mode: 'oauth-subscription', provider: this.provider }
      : { mode: 'unknown', provider: this.provider };
  }

  private sessionFile(project: string, roleId: string): string | null {
    return this.dataRoot ? path.join(this.dataRoot, '_relay', 'role-sessions', project, `${roleId}.json`) : null;
  }

  async ensureSession(args: { roleId: string; project: string; sessionPolicy: 'persistent' | 'per-task'; sessionKey: string }): Promise<{ sessionId: string; created: boolean }> {
    if (args.sessionPolicy === 'persistent') {
      const file = this.sessionFile(args.project, args.roleId);
      if (file && fs.existsSync(file)) {
        try {
          const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { adapterId?: string; sessionId?: string };
          if (record.adapterId === this.id && record.sessionId) {
            this.sessions.set(`${args.project}:${args.roleId}`, record.sessionId);
            return { sessionId: record.sessionId, created: false };
          }
        } catch { /* recreate below */ }
      }
    }
    const sessionId = `cline-pending-${randomUUID()}`;
    this.sessions.set(`${args.project}:${args.roleId}`, sessionId);
    return { sessionId, created: true };
  }

  private args(sessionId: string, prompt: string): string[] {
    const args = ['--json', '--provider', this.provider, '--cwd', this.cwd, '--auto-approve', 'true'];
    if (this.model) args.push('--model', this.model);
    if (this.timeoutSeconds) args.push('--timeout', String(this.timeoutSeconds));
    if (!sessionId.startsWith('cline-pending-')) args.push('--id', sessionId);
    args.push(prompt);
    return args;
  }

  async send(sessionId: string, envelope: InputEnvelope): Promise<{ requestId: string }> {
    const requestId = `cline-request-${randomUUID()}`;
    const child = spawn(this.command, this.args(sessionId, envelope.body), { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    this.children.set(requestId, child);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => errors.push(Buffer.from(chunk)));
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`cline exited ${code}: ${Buffer.concat(errors).toString('utf8').trim() || 'no error detail'}`));
        else resolve();
      });
    }).finally(() => this.children.delete(requestId));
    const rawText = Buffer.concat(chunks).toString('utf8');
    let taskId: string | undefined;
    const records: unknown[] = [];
    for (const line of rawText.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        records.push(record);
        if (typeof record.taskId === 'string') taskId = record.taskId;
        const event = record.event as Record<string, unknown> | undefined;
        if (typeof event?.taskId === 'string') taskId = event.taskId;
      } catch { /* --json may include a non-JSON diagnostic; retain raw output */ }
    }
    if (taskId) {
      const projectRole = [...this.sessions.entries()].find(([, value]) => value === sessionId)?.[0];
      this.sessions.set(sessionId, taskId);
      if (projectRole && this.dataRoot) {
        const [project, roleId] = projectRole.split(':');
        const file = this.sessionFile(project!, roleId!);
        if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ adapterId: this.id, sessionId: taskId, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }) + '\n'); }
      }
    }
    let finalText: Record<string, unknown> | undefined;
    for (const record of records) if ((record as Record<string, unknown>).type === 'run_result') finalText = record as Record<string, unknown>;
    this.pending.set(requestId, { text: typeof finalText?.text === 'string' ? finalText.text : rawText, raw: records });
    return { requestId };
  }

  async collect(sessionId: string, requestId: string): Promise<{ text: string; raw?: unknown }> {
    const result = this.pending.get(requestId);
    if (!result) throw new Error(`unknown requestId for session ${sessionId}: ${requestId}`);
    this.pending.delete(requestId);
    return { text: result.text, raw: result.raw };
  }

  async interrupt(_sessionId: string): Promise<void> {
    for (const child of this.children.values()) child.kill('SIGINT');
  }

  async resume(sessionId: string): Promise<{ ok: boolean }> {
    return { ok: !!sessionId && !sessionId.startsWith('cline-pending-') };
  }

  sessionIdentity(sessionId: string): { adapterId: string; sessionId: string; provider?: string; model?: string } {
    return { adapterId: this.id, sessionId: this.sessions.get(sessionId) ?? sessionId, provider: this.provider, ...(this.model ? { model: this.model } : {}) };
  }
}
