/**
 * Phase I3F-1 Relay TUI — single framed dashboard, alternate screen, stable redraw.
 * I3F-1 adds read-only subviews: Task Detail, Memo History, Events, plus bounded Memo input.
 * Main Relay visualization remains primary; subviews are presentation-only.
 */
import { buildTuiSnapshot, TUI_REFRESH_MS } from './snapshot.js';
import { renderRelayFrame, renderCompact } from './render.js';
import { resolveDetailTask, renderTaskDetail } from './views/task-detail.js';
import { renderMemoHistory } from './views/memo-history.js';
import { renderEventsView } from './views/events.js';
import { discoverConfig } from '../cli/config.js';
import * as taskMemo from '../backend/task-memo.js';
import * as eventKernel from '../backend/event.js';
import { resolveCurrentAttemptRunId } from '../backend/goal-task-runtime.js';
import {
  deriveAvailableActions,
  executeOwnerAction,
  reduceReasonInput,
  type OwnerActionContext,
  type OwnerActionResult,
  type OwnerActionCode,
  type ReasonInputState,
} from './actions.js';
import type { TaskRecord } from '../shared/types.js';

export interface TuiOptions {
  cwd: string;
  refreshMs?: number;
}

type ViewState = 'MAIN' | 'TASK_DETAIL' | 'MEMO_INPUT' | 'MEMO_HISTORY' | 'EVENTS' | 'CHANGES_INPUT';

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
  let view: ViewState = 'MAIN';
  let memoDraft = '';
  let memoError: string | undefined;
  let banner: string | undefined;
  let bannerUntil = 0;
  // Phase I3F-3: Owner judgment action state. changesReasonState/pendingChangesCtx
  // are the bounded Reason input widget + the CAS context captured when [C] was
  // pressed (spec #21 — captured at open, never re-read at submit). actionBusy
  // guards against double-submit while an Owner action await is in flight.
  let changesReasonState: ReasonInputState = { draft: '', error: undefined };
  let pendingChangesCtx: OwnerActionContext | null = null;
  let actionBusy = false;

  function enterAlt(): void {
    try {
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
    try { (process as any).removeListener('SIGINT', onExit); } catch {}
    try { (process as any).removeListener('SIGTERM', onExit); } catch {}
  }

  const onExit = () => {
    cleanup();
    process.exit(0);
  };

  function getResolvedTaskInfo(): { dataRoot?: string; project?: string; taskId?: string; taskExists: boolean } {
    try {
      const discovered = discoverConfig(cwd);
      const dataRoot = discovered.config?.dataRoot;
      const project = discovered.config?.project;
      if (!dataRoot || !project || !discovered.initialized) return { taskExists: false };
      const snap = cachedSnapshot ?? buildTuiSnapshot(cwd);
      const model = resolveDetailTask(snap, dataRoot, project);
      return { dataRoot, project, taskId: model.task?.taskId, taskExists: !!model.task };
    } catch {
      return { taskExists: false };
    }
  }

  /** Same "current Task" resolution as Task Detail (resolveDetailTask) — full record, for the action bridge. */
  function resolveActionTask(): { dataRoot?: string; project?: string; task?: TaskRecord } {
    try {
      const discovered = discoverConfig(cwd);
      const dataRoot = discovered.config?.dataRoot;
      const project = discovered.config?.project;
      if (!dataRoot || !project || !discovered.initialized) return {};
      const snap = cachedSnapshot ?? buildTuiSnapshot(cwd);
      const model = resolveDetailTask(snap, dataRoot, project);
      return { dataRoot, project, task: model.task ?? undefined };
    } catch {
      return {};
    }
  }

  function showBanner(text: string, ms: number): void {
    banner = text;
    bannerUntil = Date.now() + ms;
    setTimeout(() => {
      if (Date.now() >= bannerUntil) {
        bannerUntil = 0;
        banner = undefined;
        if (running) renderToScreen();
      }
    }, ms + 100);
  }

  function bannerForActionError(code: OwnerActionCode, message: string): string {
    switch (code) {
      case 'CONFLICT': return 'Task changed. Review current state and try again.';
      case 'FORBIDDEN': return 'Action not allowed by current permission mode.';
      case 'INVALID_STATE': return 'Action is no longer available.';
      default: return truncate(message, 120);
    }
  }

  /** Refresh snapshot (Core remains authoritative) + show the outcome banner. No mutation retry. */
  function handleActionResult(result: OwnerActionResult, successBanner: string): void {
    if (result.ok) {
      showBanner(successBanner, 3000);
    } else {
      showBanner(bannerForActionError(result.code, result.message), 3500);
    }
    doSnapshotRefresh();
  }

  async function handleAcceptKey(): Promise<void> {
    if (actionBusy) return;
    const { dataRoot, project, task } = resolveActionTask();
    if (!dataRoot || !project || !task) {
      showBanner('No active Task.', 2500);
      renderToScreen();
      return;
    }
    const availability = deriveAvailableActions({
      executionState: task.executionState,
      pmState: task.pmState,
      acceptedRunId: task.acceptedRunId,
      currentRunId: resolveCurrentAttemptRunId(task),
    });
    if (availability.ACCEPT.state !== 'ENABLED') {
      showBanner(availability.ACCEPT.state === 'DISABLED' ? availability.ACCEPT.reason : 'Accept unavailable.', 2500);
      renderToScreen();
      return;
    }
    const ctx: OwnerActionContext = {
      dataRoot, project,
      goalId: task.goalId,
      taskId: task.taskId,
      runId: resolveCurrentAttemptRunId(task),
      expectedExecutionState: task.executionState,
      expectedPmState: task.pmState,
    };
    actionBusy = true;
    try {
      const result = await executeOwnerAction('ACCEPT', ctx);
      handleActionResult(result, `✓ Result accepted · ${ctx.taskId}`);
    } finally {
      actionBusy = false;
    }
  }

  async function handleRetryKey(): Promise<void> {
    if (actionBusy) return;
    const { dataRoot, project, task } = resolveActionTask();
    if (!dataRoot || !project || !task) {
      showBanner('No active Task.', 2500);
      renderToScreen();
      return;
    }
    const availability = deriveAvailableActions({
      executionState: task.executionState,
      pmState: task.pmState,
      acceptedRunId: task.acceptedRunId,
      currentRunId: resolveCurrentAttemptRunId(task),
    });
    if (availability.RETRY.state !== 'ENABLED') {
      showBanner(availability.RETRY.state === 'DISABLED' ? availability.RETRY.reason : 'Retry unavailable.', 2500);
      renderToScreen();
      return;
    }
    const ctx: OwnerActionContext = {
      dataRoot, project,
      goalId: task.goalId,
      taskId: task.taskId,
      expectedExecutionState: task.executionState,
      expectedPmState: task.pmState,
    };
    actionBusy = true;
    try {
      const result = await executeOwnerAction('RETRY', ctx);
      handleActionResult(result, `Retry ready · ${ctx.taskId}`);
    } finally {
      actionBusy = false;
    }
  }

  /** [C] on MAIN: capture CAS context now, open the bounded Reason input. */
  function handleChangesKeyOpen(): void {
    if (actionBusy) return;
    const { dataRoot, project, task } = resolveActionTask();
    if (!dataRoot || !project || !task) {
      showBanner('No active Task.', 2500);
      renderToScreen();
      return;
    }
    const availability = deriveAvailableActions({
      executionState: task.executionState,
      pmState: task.pmState,
      acceptedRunId: task.acceptedRunId,
      currentRunId: resolveCurrentAttemptRunId(task),
    });
    if (availability.REQUEST_CHANGES.state !== 'ENABLED') {
      showBanner(
        availability.REQUEST_CHANGES.state === 'DISABLED' ? availability.REQUEST_CHANGES.reason : 'Changes unavailable.',
        2500,
      );
      renderToScreen();
      return;
    }
    pendingChangesCtx = {
      dataRoot, project,
      goalId: task.goalId,
      taskId: task.taskId,
      runId: resolveCurrentAttemptRunId(task),
      expectedExecutionState: task.executionState,
      expectedPmState: task.pmState,
    };
    changesReasonState = { draft: '', error: undefined };
    view = 'CHANGES_INPUT';
    renderToScreen();
  }

  async function submitChanges(reason: string): Promise<void> {
    if (!pendingChangesCtx || actionBusy) return;
    const ctx = pendingChangesCtx;
    actionBusy = true;
    view = 'MAIN';
    pendingChangesCtx = null;
    changesReasonState = { draft: '', error: undefined };
    renderToScreen();
    try {
      const result = await executeOwnerAction('REQUEST_CHANGES', ctx, { reason });
      handleActionResult(result, 'Changes requested');
    } finally {
      actionBusy = false;
    }
  }

  /** CHANGES_INPUT keys — intercepted before the global q/Esc handling below so typed text stays literal. */
  function handleChangesInputKey(s: string): void {
    if (s === '\x1b') { // Esc cancel — no mutation call at all.
      view = 'MAIN';
      pendingChangesCtx = null;
      changesReasonState = { draft: '', error: undefined };
      renderToScreen();
      return;
    }
    if (s === '\r' || s === '\n') { // Enter submit
      const effect = reduceReasonInput(changesReasonState, { type: 'submit' });
      if (effect.action === 'update') {
        changesReasonState = effect.state;
        renderToScreen();
        return;
      }
      if (effect.action === 'submit') {
        void submitChanges(effect.reason);
      }
      return;
    }
    if (s === '\x7f' || s === '\x08') { // Backspace
      const effect = reduceReasonInput(changesReasonState, { type: 'backspace' });
      if (effect.action === 'update') changesReasonState = effect.state;
      renderToScreen();
      return;
    }
    if (s.startsWith('\x1b[')) return; // arrow keys ignored
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) continue; // control chars ignored (q included — literal text here)
      const effect = reduceReasonInput(changesReasonState, { type: 'char', value: ch });
      if (effect.action === 'update') changesReasonState = effect.state;
    }
    renderToScreen();
  }

  const onData = (buf: Buffer) => {
    const s = buf.toString('utf8');

    // Ctrl-C is a global escape hatch even inside bounded input (raw-mode safety net).
    if (s === '\u0003') {
      cleanup();
      process.exit(0);
    }

    // CHANGES_INPUT: intercepted before the global q-quit below -- typed q is
    // literal Reason text here, not a shortcut (spec I3F-3 #20).
    if (view === 'CHANGES_INPUT') {
      handleChangesInputKey(s);
      return;
    }

    // Global q quit (presentation: q always quits per spec "Esc=back q=global quit")
    if (s === 'q' || s === 'Q') {
      // In all other views, q is global quit (not back)
      cleanup();
      process.exit(0);
    }

    // MEMO_INPUT mode: handle typing separately
    if (view === 'MEMO_INPUT') {
      if (s === '\x1b') { // Esc cancel
        view = 'MAIN';
        memoDraft = '';
        memoError = undefined;
        cachedSnapshot = null;
        renderToScreen();
        return;
      }
      if (s === '\r' || s === '\n') { // Enter save
        const draft = memoDraft.trim();
        if (!draft) {
          memoError = 'Memo body is empty.';
          renderToScreen();
          return;
        }
        if (draft.length > 2000) {
          memoError = 'Memo body exceeds 2000 chars.';
          renderToScreen();
          return;
        }
        // Try save — need dataRoot/project/taskId
        const info = getResolvedTaskInfo();
        if (!info.dataRoot || !info.project || !info.taskId) {
          memoError = 'No active Task to attach memo.';
          // stay in input to allow cancel
          renderToScreen();
          return;
        }
        // Async save
        const toSave = draft;
        taskMemo.createMemo(info.dataRoot, info.project, info.taskId, { body: toSave, authorSurface: 'OWNER_IPC' }).then((rec) => {
          memoDraft = '';
          memoError = undefined;
          banner = `Memo saved \u00b7 ${rec.noteId}`;
          bannerUntil = Date.now() + 3000;
          view = 'MAIN';
          // schedule banner clear
          setTimeout(() => {
            bannerUntil = 0;
            banner = undefined;
            if (running) renderToScreen();
          }, 3100);
          doSnapshotRefresh();
        }).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          memoError = msg.slice(0, 120);
          renderToScreen();
        });
        return;
      }
      if (s === '\x7f' || s === '\x08') { // Backspace
        memoDraft = memoDraft.slice(0, -1);
        memoError = undefined;
        renderToScreen();
        return;
      }
      // Filter: printable single char without escape sequence; ignore \x1b[ sequences
      if (s.startsWith('\x1b[')) return; // arrow keys ignored
      // For multi-char paste, process each printable char bounded to 2000
      let appended = '';
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code < 32 || code === 127) continue; // control
        if (memoDraft.length + appended.length >= 2000) {
          memoError = 'Memo body max 2000 chars.';
          break;
        }
        appended += ch;
      }
      if (appended) {
        memoDraft += appended;
        memoError = undefined;
        renderToScreen();
      }
      return;
    }

    // Non-input views: handle navigation
    if (s === '\x1b') { // Esc
      if (view === 'MAIN') {
        // Esc on main does nothing (or could be no-op); keep consistent: stay on main
        return;
      }
      if (view === 'TASK_DETAIL') {
        view = 'MAIN';
        renderToScreen();
        return;
      }
      if (view === 'MEMO_HISTORY') {
        view = 'TASK_DETAIL';
        renderToScreen();
        return;
      }
      if (view === 'EVENTS') {
        view = 'MAIN';
        renderToScreen();
        return;
      }
    }

    if (view === 'MAIN') {
      if (s === 't' || s === 'T') {
        view = 'TASK_DETAIL';
        renderToScreen();
        return;
      }
      if (s === 'm' || s === 'M') {
        // Open memo input — validate task exists first
        const info = getResolvedTaskInfo();
        if (!info.taskExists) {
          banner = 'No active Task.';
          bannerUntil = Date.now() + 2500;
          setTimeout(() => { bannerUntil = 0; banner = undefined; if (running) renderToScreen(); }, 2600);
          renderToScreen();
          return;
        }
        view = 'MEMO_INPUT';
        memoDraft = '';
        memoError = undefined;
        renderToScreen();
        return;
      }
      if (s === 'e' || s === 'E') {
        view = 'EVENTS';
        renderToScreen();
        return;
      }
      // I3F-3: [A] Accept / [C] Changes / [R] Retry — canonical Owner action bridge only.
      // No lifecycle mutation logic here; see src/tui/actions.ts + task-actions.ts.
      if (s === 'a' || s === 'A') {
        void handleAcceptKey();
        return;
      }
      if (s === 'c' || s === 'C') {
        handleChangesKeyOpen();
        return;
      }
      if (s === 'r' || s === 'R') {
        void handleRetryKey();
        return;
      }
    } else if (view === 'TASK_DETAIL') {
      if (s === 'm' || s === 'M') {
        view = 'MEMO_HISTORY';
        renderToScreen();
        return;
      }
      if (s === 'r' || s === 'R') {
        doSnapshotRefresh();
        return;
      }
    } else if (view === 'MEMO_HISTORY') {
      if (s === 'r' || s === 'R') {
        doSnapshotRefresh();
        return;
      }
    } else if (view === 'EVENTS') {
      if (s === 'r' || s === 'R') {
        doSnapshotRefresh();
        return;
      }
    }
  };

  function renderToScreen(): void {
    if (!running) return;
    try {
      const snap = cachedSnapshot ?? buildTuiSnapshot(cwd);
      if (!cachedSnapshot) {
        try { cachedSnapshot = buildTuiSnapshot(cwd); } catch {}
      }
      const actualSnap = cachedSnapshot ?? snap;
      const size = getTermSize();
      const compact = size.cols < 80 || size.rows < 20;
      let out: string;

      if (compact) {
        out = renderCompact(actualSnap, size);
      } else if (view === 'TASK_DETAIL') {
        const discovered = discoverConfig(cwd);
        const dataRoot = discovered.config?.dataRoot;
        const project = discovered.config?.project;
        const model = resolveDetailTask(actualSnap, dataRoot, project);
        out = renderTaskDetail(model, size);
        if (banner && Date.now() < bannerUntil) {
          out += '\n' + banner;
        }
        if (lastError) out += '\n! ' + lastError.slice(0, 80);
      } else if (view === 'MEMO_HISTORY') {
        const discovered = discoverConfig(cwd);
        const dataRoot = discovered.config?.dataRoot;
        const project = discovered.config?.project;
        const model = resolveDetailTask(actualSnap, dataRoot, project);
        let memos: ReturnType<typeof taskMemo.listMemos> = [];
        try {
          if (dataRoot && project && model.task) {
            memos = taskMemo.listMemos(dataRoot, project, model.task.taskId);
          }
        } catch (e) {
          lastError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
        }
        out = renderMemoHistory(memos, model.task?.taskId, size);
        if (lastError) out += '\n! ' + lastError.slice(0, 80);
      } else if (view === 'EVENTS') {
        const discovered = discoverConfig(cwd);
        const dataRoot = discovered.config?.dataRoot;
        const project = discovered.config?.project;
        let events: ReturnType<typeof eventKernel.listEvents>['events'] = [];
        try {
          if (dataRoot && project && discovered.initialized) {
            const res = eventKernel.listEvents(dataRoot, project);
            events = res.events;
          }
        } catch (e) {
          lastError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
        }
        out = renderEventsView(events, size);
        if (lastError) out += '\n! ' + lastError.slice(0, 80);
      } else if (view === 'MEMO_INPUT') {
        // Render memo input overlay on top of main frame? Show simple prompt
        const inner = size.cols - 2;
        const preview = memoDraft.length > inner - 12 ? memoDraft.slice(- (inner - 12)) : memoDraft;
        const cursor = '█';
        // Show main frame dimmed + input line at bottom? For simplicity, show bounded input frame
        const inputLines: string[] = [];
        inputLines.push('┌' + '─'.repeat(inner) + '┐');
        inputLines.push('│' + padCenter('Memo', inner) + '│');
        inputLines.push('│' + ' '.repeat(inner) + '│');
        const prompt = `Memo > ${preview}${cursor}`;
        inputLines.push('│' + padRight(truncate(prompt, inner), inner) + '│');
        if (memoError) {
          inputLines.push('│' + padRight(truncate('! ' + memoError, inner), inner) + '│');
        } else {
          inputLines.push('│' + padRight(`${memoDraft.length}/2000 chars · Enter:save  Esc:cancel  Backspace:edit`, inner) + '│');
        }
        inputLines.push('└' + '─'.repeat(inner) + '┘');
        out = inputLines.join('\n');
      } else if (view === 'CHANGES_INPUT') {
        // Bounded Reason input for canonical Request Changes (min 10 / max 2000 chars).
        const inner = size.cols - 2;
        const draft = changesReasonState.draft;
        const preview = draft.length > inner - 14 ? draft.slice(-(inner - 14)) : draft;
        const cursor = '█';
        const inputLines: string[] = [];
        inputLines.push('┌' + '─'.repeat(inner) + '┐');
        inputLines.push('│' + padCenter('Request Changes', inner) + '│');
        inputLines.push('│' + ' '.repeat(inner) + '│');
        const prompt = `Reason > ${preview}${cursor}`;
        inputLines.push('│' + padRight(truncate(prompt, inner), inner) + '│');
        if (changesReasonState.error) {
          inputLines.push('│' + padRight(truncate('! ' + changesReasonState.error, inner), inner) + '│');
        } else {
          inputLines.push('│' + padRight(`${draft.length}/2000 chars (min 10) · Enter:submit  Esc:cancel  Backspace:edit`, inner) + '│');
        }
        inputLines.push('└' + '─'.repeat(inner) + '┘');
        out = inputLines.join('\n');
      } else {
        // MAIN
        out = renderRelayFrame(actualSnap, frameIndex, size, lastError);
        // Overlay transient banner
        if (banner && Date.now() < bannerUntil) {
          out += '\n' + banner;
        }
        lastError = undefined;
      }

      if (view !== 'MEMO_INPUT') {
        lastError = undefined;
      }
      // Stable redraw: home + clear to end
      stdout.write('\x1b[H\x1b[J');
      stdout.write(out);
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
    // Only animate MAIN; subviews are static — avoid unnecessary redraw flicker
    if (view === 'MAIN') {
      renderToScreen();
    }
  }

  function padRight(s: string, n: number): string {
    if (s.length >= n) return s.slice(0, n);
    return s + ' '.repeat(n - s.length);
  }
  function padCenter(s: string, n: number): string {
    if (s.length >= n) return s.slice(0, n);
    const left = Math.floor((n - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(n - s.length - left);
  }
  function truncate(s: string, n: number): string {
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + '…';
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
  try {
    cachedSnapshot = buildTuiSnapshot(cwd);
  } catch (e) {
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  renderToScreen();

  interval = setInterval(() => {
    doSnapshotRefresh();
  }, refreshMs);

  animInterval = setInterval(() => {
    doAnimTick();
  }, 250);

  await new Promise<void>(() => {});
}
