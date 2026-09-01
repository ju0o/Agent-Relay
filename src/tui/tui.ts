/**
 * Minimal TUI — visual status only, read-only, no mutations.
 * Refresh 500-1500ms, snapshot reused, graceful failure.
 */
import { buildTuiSnapshot, TUI_REFRESH_MS } from './snapshot.js';
import { renderFull, renderCompact } from './render.js';

export interface TuiOptions {
  cwd: string;
  refreshMs?: number;
}

function isTTY(): boolean {
  return !!process.stdout.isTTY && !!process.stdin.isTTY;
}

function getTermSize(): { cols: number; rows: number } {
  const cols = (process.stdout as any).columns ?? 80;
  const rows = (process.stdout as any).rows ?? 24;
  return { cols, rows };
}

export function shouldLaunchTui(cwd: string, opts: { noTui: boolean }): boolean {
  if (opts.noTui) return false;
  if (!isTTY()) return false;
  return true;
}

export async function launchTui(opts: TuiOptions): Promise<void> {
  const cwd = opts.cwd;
  const refreshMs = Math.min(1500, Math.max(500, opts.refreshMs ?? TUI_REFRESH_MS));

  if (!isTTY()) {
    const { buildStatusSnapshot, renderStatusHuman } = await import('../cli/status.js');
    const snap = buildStatusSnapshot(cwd);
    console.log(renderStatusHuman(snap));
    return;
  }

  const stdin: NodeJS.ReadStream & { isTTY?: boolean } = process.stdin as any;
  const stdout = process.stdout;
  let interval: NodeJS.Timeout | null = null;
  let lastError: string | undefined;
  let focused = 0;
  let running = true;

  function cleanup(): void {
    running = false;
    if (interval) clearInterval(interval);
    try {
      stdout.write('\x1b[?25h');
      stdout.write('\x1b[0m');
    } catch {}
    try {
      if (stdin.isTTY && typeof (stdin as any).setRawMode === 'function') (stdin as any).setRawMode(false);
    } catch {}
    try { stdin.pause(); } catch {}
    try { stdin.removeAllListeners('data'); } catch {}
    try { stdout.removeAllListeners('resize'); } catch {}
  }

  const onExit = () => {
    cleanup();
    process.exit(0);
  };

  const onData = (buf: Buffer) => {
    const s = buf.toString('utf8');
    if (s === '\u0003' || s === 'q' || s === 'Q') {
      cleanup();
      process.exit(0);
    }
    if (s === 'r' || s === 'R') {
      doRefresh();
    }
    if (s === '\t') {
      focused = (focused + 1) % 4;
      doRefresh();
    }
  };

  function doRefresh(): void {
    if (!running) return;
    try {
      const snap = buildTuiSnapshot(cwd);
      const size = getTermSize();
      const compact = size.cols < 80 || size.rows < 20;
      const out = compact ? renderCompact(snap, size) : renderFull(snap, size, lastError);
      lastError = undefined;
      stdout.write('\x1b[2J\x1b[H');
      stdout.write(out);
      stdout.write('\x1b[?25l');
      void focused;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg.slice(0, 200);
      try {
        stdout.write('\x1b[2J\x1b[H');
        stdout.write(`State refresh failed — retrying\n${lastError.slice(0, 80)}\n`);
        stdout.write('\x1b[?25l');
      } catch {}
    }
  }

  try {
    if (stdin.isTTY && typeof (stdin as any).setRawMode === 'function') {
      (stdin as any).setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  } catch {}

  (stdout as any).on('resize', () => {
    doRefresh();
  });

  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  doRefresh();

  interval = setInterval(() => {
    doRefresh();
  }, refreshMs);

  await new Promise<void>(() => {});
}
