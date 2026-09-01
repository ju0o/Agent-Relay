/**
 * Phase I3E Relay TUI — single framed dashboard, alternate screen, stable redraw.
 * Read-only, no mutations. Animation derived from Core state only.
 */
import { buildTuiSnapshot, TUI_REFRESH_MS } from './snapshot.js';
import { renderRelayFrame, renderCompact } from './render.js';

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
  let animInterval: NodeJS.Timeout | null = null;
  let lastError: string | undefined;
  let running = true;
  let frameIndex = 0;
  let cachedSnapshot: ReturnType<typeof buildTuiSnapshot> | null = null;
  let enteredAlt = false;

  function enterAlt(): void {
    try {
      // Alternate screen buffer (safe on Windows Terminal / PowerShell)
      stdout.write('\x1b[?1049h');
      enteredAlt = true;
    } catch {}
    try { stdout.write('\x1b[?25l'); } catch {}
  }
  function leaveAlt(): void {
    try { stdout.write('\x1b[?25h'); } catch {}
    try {
      if (enteredAlt) stdout.write('\x1b[?1049l');
      else stdout.write('\x1b[0m');
    } catch {}
  }

  function cleanup(): void {
    running = false;
    if (interval) clearInterval(interval);
    if (animInterval) clearInterval(animInterval);
    try { leaveAlt(); } catch {}
    try {
      if (stdin.isTTY && typeof (stdin as any).setRawMode === 'function') (stdin as any).setRawMode(false);
    } catch {}
    try { stdin.pause(); } catch {}
    try { stdin.removeAllListeners('data'); } catch {}
    try { stdout.removeAllListeners('resize'); } catch {}
    // remove signal listeners to avoid duplicate
    try { (process as any).removeListener('SIGINT', onExit); } catch {}
    try { (process as any).removeListener('SIGTERM', onExit); } catch {}
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
      doSnapshotRefresh();
    }
    // Tab focus removed — intentionally no handling
  };

  function renderToScreen(): void {
    if (!running) return;
    try {
      const snap = cachedSnapshot ?? buildTuiSnapshot(cwd);
      // cache if not yet
      if (!cachedSnapshot) {
        try { cachedSnapshot = buildTuiSnapshot(cwd); } catch {}
      }
      const actualSnap = cachedSnapshot ?? snap;
      const size = getTermSize();
      const compact = size.cols < 80 || size.rows < 20;
      const out = compact ? renderCompact(actualSnap, size) : renderRelayFrame(actualSnap, frameIndex, size, lastError);
      lastError = undefined;
      // Stable redraw: home + clear to end, not full clear + scroll
      stdout.write('\x1b[H\x1b[J');
      stdout.write(out);
      // keep cursor hidden
      stdout.write('\x1b[?25l');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg.slice(0, 200);
      try {
        stdout.write('\x1b[H\x1b[J');
        stdout.write(`State refresh failed — retrying\n${lastError.slice(0, 80)}\n`);
        stdout.write('\x1b[?25l');
      } catch {}
    }
  }

  function doSnapshotRefresh(): void {
    if (!running) return;
    try {
      cachedSnapshot = buildTuiSnapshot(cwd);
      lastError = undefined;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg.slice(0, 200);
    }
    renderToScreen();
  }

  function doAnimTick(): void {
    if (!running) return;
    frameIndex = (frameIndex + 1) % 1000000;
    renderToScreen();
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
    renderToScreen();
  });

  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

  enterAlt();
  // Initial snapshot load
  try {
    cachedSnapshot = buildTuiSnapshot(cwd);
  } catch (e) {
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  renderToScreen();

  interval = setInterval(() => {
    doSnapshotRefresh();
  }, refreshMs);

  // lightweight animation ~ 250ms (4fps) — pure visual, no state mutation
  animInterval = setInterval(() => {
    doAnimTick();
  }, 250);

  await new Promise<void>(() => {});
}
