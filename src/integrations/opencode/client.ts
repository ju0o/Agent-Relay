import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/**
 * Thin client over a local headless OpenCode server (`opencode serve`).
 *
 * The server reads the SAME session storage as the interactive TUI
 * (`opencode --yolo`), so sessions created interactively are fully visible
 * here. Everything is read-only HTTP against 127.0.0.1; no OpenCode
 * configuration, auth, or plugin state is touched.
 *
 * IMPORTANT: `GET /session` is scoped by the server process's resolved
 * project (git root of its working directory). To observe ALL local sessions,
 * launch without `cwd` — the client then spawns the server inside a neutral
 * non-git temporary directory, which yields the global session view.
 */

const HOST = '127.0.0.1';
const PORT_CANDIDATES = [47800, 47801, 47802, 47803, 47804, 47805, 47806, 47807, 47808, 47809];
const SERVER_START_TIMEOUT_MS = 12_000;
const LISTEN_LINE = /opencode server listening on (https?:\/\/[0-9A-Za-z.:[\]-]+)(\/)?/;

export interface OcSessionInfo {
  id: string;
  directory?: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

export interface OcMessage {
  info: Record<string, unknown>;
  parts: unknown[];
}

/**
 * Prefer the real executable over the npm .cmd shim: the shim detaches the
 * actual server into a separate process, which makes reliable teardown
 * impossible. Direct spawn gives us the true root PID.
 */
function resolveBinary(): { cmd: string; shell: boolean } {
  if (process.platform === 'win32') {
    const exe = path.join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
    if (exe && fs.existsSync(exe)) return { cmd: exe, shell: false };
    return { cmd: 'opencode.cmd', shell: true };
  }
  return { cmd: 'opencode', shell: false };
}

function getJson<T>(port: number, urlPath: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port, path: urlPath, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`OpenCode 서버 응답 오류 ${res.statusCode}: ${urlPath}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('OpenCode 서버 응답 시간 초과')));
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Kill a process tree reliably on Windows. */
function killTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      proc.kill();
    }
  } else {
    proc.kill('SIGTERM');
  }
}

interface LaunchAttempt {
  ok: boolean;
  port: number;
  url?: string;
  proc: ChildProcess;
}

/**
 * Spawn one server attempt and wait until IT ITSELF announces its listen
 * address on stdout. We never trust a bare TCP probe — a stale foreign
 * server occupying the port could otherwise answer for us.
 */
function attemptPort(port: number, cwd: string): Promise<LaunchAttempt> {
  return new Promise((resolve) => {
    const bin = resolveBinary();
    const proc = spawn(
      bin.cmd,
      ['serve', '--port', String(port), '--hostname', HOST],
      {
        cwd,
        shell: bin.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let settled = false;
    const finish = (r: LaunchAttempt, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.removeAllListeners();
      proc.stderr?.removeAllListeners();
      proc.removeAllListeners('exit');
      if (kill || !r.ok) killTree(proc);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, port, proc }, true), SERVER_START_TIMEOUT_MS);
    const onChunk = (d: Buffer | string): void => {
      out += d.toString();
      const m = LISTEN_LINE.exec(out);
      if (m?.[1]) {
        const url = m[1];
        const announced = Number(url.match(/:(\d+)$/)?.[1]);
        finish(
          { ok: Number.isFinite(announced) ? announced === port : true, port, url, proc },
          false,
        );
      }
    };
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('exit', () => finish({ ok: false, port, proc }, false));
  });
}

export class OpenCodeServerClient {
  private constructor(private port: number, private proc: ChildProcess | null) {}

  /** HTTP port of this client's server instance. */
  get endpointPort(): number {
    return this.port;
  }

  /**
   * Attach to an already-running local OpenCode server (e.g. the one behind
   * the user's interactive TUI). We never own that process — stop() is a
   * no-op and the port is used strictly for read-only GETs.
   */
  static attach(port: number): OpenCodeServerClient {
    return new OpenCodeServerClient(port, null);
  }

  /** True when this client spawned the server it talks to. */
  get owned(): boolean {
    return this.proc !== null;
  }

  /** Launch a local headless server bound to 127.0.0.1 and wait until healthy. */
  static async launch(cwd?: string): Promise<OpenCodeServerClient> {
    const spawnCwd =
      cwd && fs.existsSync(cwd)
        ? cwd
        : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-oc-view-'));
    let lastDetail = '';
    for (const port of PORT_CANDIDATES) {
      const attempt = await attemptPort(port, spawnCwd);
      if (!attempt.ok) {
        lastDetail = `포트 ${port}에서 서버가 시작되지 않았습니다.`;
        continue;
      }
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          await getJson<unknown>(attempt.port, '/session', 2_000);
          return new OpenCodeServerClient(attempt.port, attempt.proc);
        } catch (e) {
          lastDetail = e instanceof Error ? e.message : String(e);
          await sleep(250);
        }
      }
      killTree(attempt.proc);
    }
    throw new Error(
      `OpenCode 로컬 서버를 시작할 수 없습니다 (포트 ${PORT_CANDIDATES[0]}~${PORT_CANDIDATES[PORT_CANDIDATES.length - 1]} 시도). ${lastDetail}`,
    );
  }

  async listSessions(): Promise<OcSessionInfo[]> {
    const raw = await getJson<unknown>(this.port, '/session');
    if (!Array.isArray(raw)) throw new Error('OpenCode /session 응답이 배열이 아닙니다.');
    const out: OcSessionInfo[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o['id'] !== 'string') continue;
      const timeRec =
        typeof o['time'] === 'object' && o['time'] !== null ? (o['time'] as Record<string, unknown>) : undefined;
      out.push({
        id: o['id'],
        directory: typeof o['directory'] === 'string' ? o['directory'] : undefined,
        title: typeof o['title'] === 'string' ? o['title'] : undefined,
        time: {
          created: typeof timeRec?.['created'] === 'number' ? timeRec['created'] : undefined,
          updated: typeof timeRec?.['updated'] === 'number' ? timeRec['updated'] : undefined,
        },
      });
    }
    return out;
  }

  async listMessages(sessionId: string): Promise<OcMessage[]> {
    const raw = await getJson<unknown>(
      this.port,
      `/session/${encodeURIComponent(sessionId)}/message`,
      12_000,
    );
    if (!Array.isArray(raw)) throw new Error('OpenCode message 응답이 배열이 아닙니다.');
    return raw.filter(
      (m): m is OcMessage => typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>)['info'] === 'object',
    );
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    killTree(this.proc);
    this.proc.unref?.();
  }
}

function execText(cmd: string, args: string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: false });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Discover already-running local OpenCode servers so the adapter can observe
 * the user's LIVE interactive session — including sessions created inside git
 * repositories, which a neutral-directory server instance cannot see.
 *
 * Read-only: netstat + tasklist + a GET /session probe. Nothing is killed or
 * reconfigured. Windows-only; other platforms return [].
 */
export async function discoverRunningServers(selfPort: number | null): Promise<OpenCodeServerClient[]> {
  if (process.platform !== 'win32') return [];
  try {
    const [netstatOut, tasklistOut] = await Promise.all([
      execText('netstat', ['-ano', '-p', 'tcp']),
      execText('tasklist', ['/FI', 'IMAGENAME eq opencode.exe', '/FO', 'CSV', '/NH']),
    ]);
    const pids = new Set<string>();
    for (const line of tasklistOut.split('\n')) {
      const m = /^"opencode\.exe","(\d+)"/i.exec(line.trim());
      if (m) pids.add(m[1]!);
    }
    if (pids.size === 0) return [];

    const ports = new Set<number>();
    for (const line of netstatOut.split('\n')) {
      const m = /^\s*TCP\s+\S*?:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (m && pids.has(m[2]!)) ports.add(Number(m[1]));
    }

    const found: OpenCodeServerClient[] = [];
    for (const port of ports) {
      if (selfPort !== null && port === selfPort) continue;
      try {
        await getJson<unknown>(port, '/session', 1_500);
        found.push(OpenCodeServerClient.attach(port));
      } catch {
        // not an opencode HTTP server (or auth-protected) — skip silently
      }
    }
    return found;
  } catch {
    return [];
  }
}
