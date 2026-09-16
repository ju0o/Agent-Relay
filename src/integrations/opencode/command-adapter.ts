import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/**
 * WBS-3: OpenCode command adapter implementing RoleRuntimeAdapter (WBS-2)
 * against a running `opencode serve` instance.
 *
 * TODO(WBS-2): once src/integrations/core/role-runtime.ts exists, delete the
 * local interface copies below and `import type {...} from '../core/role-runtime'`
 * instead. The shapes here are transcribed verbatim from docs/WBS1_2_SPEC.md.
 */

export interface RoleCapabilityFlags {
  persistentSession: boolean;
  structuredInput: boolean;
  structuredOutput: boolean;
  readWorkspace: boolean;
  writeWorkspace: boolean;
  shell: boolean;
  subscriptionAuth: boolean;
  freeTier: boolean;
}

export interface InputEnvelope {
  kind: 'PM_BOOTSTRAP' | 'PM_FINAL_GATE' | 'QA_PACKET' | 'TASK_CONTRACT' | 'CHANGES';
  schemaVersion: string;
  contractHash?: string;
  contextHash: string;
  body: string;
  attachments?: unknown[];
}

export type AuthMode = 'oauth-subscription' | 'existing-plan-key' | 'free' | 'unknown';

export interface RoleRuntimeAdapter {
  id: string;
  health(): Promise<{ ok: boolean; detail?: string }>;
  capabilities(): RoleCapabilityFlags;
  authMode(): Promise<{ mode: AuthMode; provider?: string }>;
  ensureSession(args: {
    roleId: string;
    project: string;
    sessionPolicy: 'persistent' | 'per-task';
    sessionKey: string;
  }): Promise<{ sessionId: string; created: boolean }>;
  send(sessionId: string, envelope: InputEnvelope): Promise<{ requestId: string }>;
  collect(
    sessionId: string,
    requestId: string,
    opts?: { timeoutMs?: number },
  ): Promise<{ text: string; structured?: unknown; raw?: unknown; tokens?: number; cost?: number }>;
  interrupt(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<{ ok: boolean }>;
  sessionIdentity(sessionId: string): { adapterId: string; sessionId: string; provider?: string; model?: string };
}

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeCommandAdapterConfig {
  baseUrl?: string;
  passwordFile?: string;
  defaultModel: OpenCodeModelRef;
  /** When set, persistent sessions survive a process restart at {dataRoot}/_relay/role-sessions/<project>/<roleId>.json (WBS-2 bookkeeping shape). Without it, persistence is in-memory only for this process's lifetime. */
  dataRoot?: string;
}

interface RoleSessionRecord {
  adapterId: string;
  sessionId: string;
  createdAt: number;
  lastUsedAt: number;
}

interface HttpResult {
  status: number;
  json?: unknown;
  raw: string;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:4111';
const DEFAULT_PASSWORD_FILE = path.join(os.homedir(), '.config', 'agent-relay', 'opencode-server.pass');

function requestRaw(
  baseUrl: string,
  method: string,
  urlPath: string,
  authHeader: string,
  body: unknown,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers: Record<string, string> = { authorization: authHeader };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = raw ? JSON.parse(raw) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, raw });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`opencode request timed out: ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runAuthList(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out: string): void => {
      if (settled) return;
      settled = true;
      resolve(out);
    };
    try {
      const child = spawn('opencode', ['auth', 'list'], { windowsHide: true, shell: false });
      let out = '';
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('close', () => finish(out));
      child.on('error', () => finish(out));
      setTimeout(() => {
        finish(out);
        child.kill();
      }, 5000);
    } catch {
      finish('');
    }
  });
}

export class OpenCodeCommandAdapter implements RoleRuntimeAdapter {
  readonly id = 'opencode-command';
  private readonly baseUrl: string;
  private readonly passwordFile: string;
  private readonly defaultModel: OpenCodeModelRef;
  private readonly dataRoot?: string;
  private readonly identities = new Map<string, { adapterId: string; sessionId: string; provider?: string; model?: string }>();
  private readonly pending = new Map<string, { text: string; raw: unknown; tokens?: number; cost?: number }>();
  private requestSeq = 0;
  private lastAuthMode: { mode: AuthMode; provider?: string } | null = null;

  constructor(config: OpenCodeCommandAdapterConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.passwordFile = config.passwordFile ?? DEFAULT_PASSWORD_FILE;
    this.defaultModel = config.defaultModel;
    this.dataRoot = config.dataRoot;
  }

  private authHeader(): string {
    const pass = fs.readFileSync(this.passwordFile, 'utf8').trim();
    return 'Basic ' + Buffer.from(`opencode:${pass}`).toString('base64');
  }

  private async request(method: string, urlPath: string, body?: unknown, timeoutMs = 15_000): Promise<HttpResult> {
    return requestRaw(this.baseUrl, method, urlPath, this.authHeader(), body, timeoutMs);
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await this.request('GET', '/global/health', undefined, 5_000);
      if (res.status === 401) return { ok: false, detail: 'unauthorized' };
      if (res.status >= 400) return { ok: false, detail: `HTTP ${res.status}` };
      const healthy = (res.json as { healthy?: boolean } | undefined)?.healthy === true;
      return healthy ? { ok: true } : { ok: false, detail: 'server reported unhealthy' };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  capabilities(): RoleCapabilityFlags {
    return {
      persistentSession: true,
      structuredInput: true,
      structuredOutput: true,
      readWorkspace: true,
      writeWorkspace: false,
      shell: false,
      subscriptionAuth: this.lastAuthMode?.mode === 'oauth-subscription',
      freeTier: true,
    };
  }

  async authMode(): Promise<{ mode: AuthMode; provider?: string }> {
    const { providerID, modelID } = this.defaultModel;
    let mode: AuthMode = 'unknown';
    if (/-free$/.test(modelID) || providerID === 'opencode') {
      mode = 'free';
    } else {
      const authList = await runAuthList();
      const openaiOauthLine = authList
        .split('\n')
        .find((l) => /openai|chatgpt/i.test(l) && /oauth/i.test(l));
      if (openaiOauthLine) {
        mode = 'oauth-subscription';
      } else if (providerID === 'opencode-go' || /opencode go/i.test(authList)) {
        mode = 'existing-plan-key';
      }
    }
    this.lastAuthMode = { mode, provider: providerID };
    return this.lastAuthMode;
  }

  private sessionRecordPath(project: string, roleId: string): string | null {
    if (!this.dataRoot) return null;
    return path.join(this.dataRoot, '_relay', 'role-sessions', project, `${roleId}.json`);
  }

  private readSessionRecord(project: string, roleId: string): RoleSessionRecord | null {
    const p = this.sessionRecordPath(project, roleId);
    if (!p || !fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as RoleSessionRecord;
    } catch {
      return null;
    }
  }

  private writeSessionRecord(project: string, roleId: string, sessionId: string): void {
    const p = this.sessionRecordPath(project, roleId);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const now = Date.now();
    const existing = this.readSessionRecord(project, roleId);
    const record: RoleSessionRecord = { adapterId: this.id, sessionId, createdAt: existing?.createdAt ?? now, lastUsedAt: now };
    const tmp = `${p}.tmp-${process.pid}-${now}`;
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, p);
  }

  async ensureSession(args: {
    roleId: string;
    project: string;
    sessionPolicy: 'persistent' | 'per-task';
    sessionKey: string;
  }): Promise<{ sessionId: string; created: boolean }> {
    if (args.sessionPolicy === 'persistent') {
      const existing = this.readSessionRecord(args.project, args.roleId);
      if (existing) {
        const resumed = await this.resume(existing.sessionId);
        if (resumed.ok) {
          this.identities.set(existing.sessionId, {
            adapterId: this.id,
            sessionId: existing.sessionId,
            provider: this.defaultModel.providerID,
            model: this.defaultModel.modelID,
          });
          return { sessionId: existing.sessionId, created: false };
        }
      }
    }
    const res = await this.request('POST', '/session', {
      title: `${args.project}/${args.roleId}/${args.sessionKey}`,
      // POST /session's model object uses {id, providerID}; POST /session/{id}/message
      // uses {providerID, modelID} (confirmed live against the WBS-0 server) -- not the same shape.
      model: { id: this.defaultModel.modelID, providerID: this.defaultModel.providerID },
    });
    if (res.status >= 400) throw new Error(`opencode session create failed: HTTP ${res.status}`);
    const sessionId = (res.json as { id?: string } | undefined)?.id;
    if (!sessionId) throw new Error('opencode session create response missing id');
    if (args.sessionPolicy === 'persistent') this.writeSessionRecord(args.project, args.roleId, sessionId);
    this.identities.set(sessionId, {
      adapterId: this.id,
      sessionId,
      provider: this.defaultModel.providerID,
      model: this.defaultModel.modelID,
    });
    return { sessionId, created: true };
  }

  async send(sessionId: string, envelope: InputEnvelope): Promise<{ requestId: string }> {
    const res = await this.request(
      'POST',
      `/session/${encodeURIComponent(sessionId)}/message`,
      { model: this.defaultModel, tools: {}, parts: [{ type: 'text', text: envelope.body }] },
      120_000,
    );
    if (res.status >= 400) throw new Error(`opencode message failed: HTTP ${res.status}`);
    const msg = res.json as { info?: Record<string, unknown>; parts?: Array<{ type: string; text?: string }> } | undefined;
    if (!msg) throw new Error('opencode message response was not JSON');
    const text = (msg.parts ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');
    const tokensInfo = msg.info?.['tokens'] as { total?: number } | undefined;
    const requestId = `req-${++this.requestSeq}-${Date.now()}`;
    this.pending.set(requestId, {
      text,
      raw: msg,
      tokens: typeof tokensInfo?.total === 'number' ? tokensInfo.total : undefined,
      cost: typeof msg.info?.['cost'] === 'number' ? (msg.info['cost'] as number) : undefined,
    });
    return { requestId };
  }

  async collect(
    sessionId: string,
    requestId: string,
    _opts?: { timeoutMs?: number },
  ): Promise<{ text: string; structured?: unknown; raw?: unknown; tokens?: number; cost?: number }> {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`unknown requestId for session ${sessionId}: ${requestId}`);
    this.pending.delete(requestId);
    return { text: entry.text, raw: entry.raw, tokens: entry.tokens, cost: entry.cost };
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`, undefined, 5_000).catch(() => undefined);
  }

  async resume(sessionId: string): Promise<{ ok: boolean }> {
    try {
      const res = await this.request('GET', `/session/${encodeURIComponent(sessionId)}/message`, undefined, 8_000);
      return { ok: res.status === 200 };
    } catch {
      return { ok: false };
    }
  }

  sessionIdentity(sessionId: string): { adapterId: string; sessionId: string; provider?: string; model?: string } {
    return this.identities.get(sessionId) ?? { adapterId: this.id, sessionId };
  }
}
