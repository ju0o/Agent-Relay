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
import { renderResumeScanView } from './views/resume-scan.js';
import { discoverConfig } from '../cli/config.js';
import * as taskMemo from '../backend/task-memo.js';
import * as eventKernel from '../backend/event.js';
import { scanStuckWork } from '../backend/resume-scan.js';
import type { ResumeScanResult } from '../backend/resume-scan.js';
import { executeGuidedAction } from '../backend/resume-actions.js';
import type { OrphanAction } from '../backend/orphan-resolution.js';
import { resolveCurrentAttemptRunId } from '../backend/goal-task-runtime.js';
import {
  deriveAvailableActions,
  executeOwnerAction,
  executeTaskEdit,
  reduceReasonInput,
  reduceBoundedTextInput,
  boundsForEditField,
  TASK_EDIT_FIELDS,
  type OwnerActionContext,
  type OwnerActionResult,
  type OwnerActionCode,
  type ReasonInputState,
  type TaskEditContext,
  type EditFieldKey,
  type BoundedTextState,
} from './actions.js';
import type { TaskRecord } from '../shared/types.js';

export interface TuiOptions {
  cwd: string;
  refreshMs?: number;
}

type ViewState =
  | 'MAIN' | 'TASK_DETAIL' | 'MEMO_INPUT' | 'MEMO_HISTORY' | 'EVENTS' | 'RESUME_SCAN' | 'CHANGES_INPUT'
  | 'TASK_EDIT_MENU' | 'TASK_EDIT_FIELD';

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
  // Phase I3F-4: Task Edit state. editTaskCtx is the CAS context (expectedUpdatedAt)
  // captured when [e] Edit was pressed (menu open) — never re-read at submit.
  // editFieldKey/editFieldState are the currently-open bounded field input.
  let editTaskCtx: TaskEditContext | null = null;
  let editFieldKey: EditFieldKey | null = null;
  let editFieldState: BoundedTextState = { draft: '', error: undefined };
  // V2 R1: cached read-only resume scan (refreshed on open / [r])
  let resumeScanReport: ResumeScanResult | null = null;
  let resumeScanError: string | undefined;
  // V2 R2: guided-action selection + explicit Owner confirm (y/n) inside scan view
  let resumeSelected = 0;
  let resumeConfirm: { index: number; orphanAction?: OrphanAction; label: string } | null = null;

  /** Re-run the read-only scan and reset selection/confirm. Read-only. */
  function refreshResumeScan(): void {
    try {
      const discovered = discoverConfig(cwd);
      if (!discovered.initialized || !discovered.config) {
        resumeScanReport = null;
        resumeScanError = 'not-initialized';
      } else {
        resumeScanReport = scanStuckWork(discovered.config.dataRoot, discovered.config.project);
        resumeScanError = undefined;
      }
    } catch (e) {
      resumeScanReport = null;
      resumeScanError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
    }
    resumeSelected = 0;
    resumeConfirm = null;
  }

  /** Current scan findings capped the same way the view renders them. */
  function visibleResumeFindings(): ResumeScanResult['findings'] {
    return (resumeScanReport?.findings ?? []).slice(0, 8);
  }

  function flashBanner(text: string): void {
    banner = text;
    bannerUntil = Date.now() + 4000;
    setTimeout(() => { bannerUntil = 0; banner = undefined; if (running) renderToScreen(); }, 4100);
  }

  /**
   * V2 R2 — arm (never execute): describe the guided action for the selected
   * finding and wait for an explicit y-confirm. Orphan findings need a
   * k/f/c choice; x on an orphan asks for that choice instead of acting.
   */
  function armResumeAction(key: string): void {
    const items = visibleResumeFindings();
    const finding = items[Math.min(resumeSelected, Math.max(0, items.length - 1))];
    if (!finding) {
      flashBanner('No findings to act on.');
      return;
    }
    const idx = items.indexOf(finding);
    if (finding.pattern === 'ORPHANED_DISPATCH') {
      const map: Record<string, OrphanAction> = { k: 'KEEP_WAITING', f: 'CONFIRM_FAILED', c: 'CONFIRM_CANCELLED' };
      const chosen = map[key];
      if (!chosen) {
        flashBanner('Orphan needs a choice: k=keep f=failed c=cancelled.');
        return;
      }
      resumeConfirm = { index: idx, orphanAction: chosen, label: `#${idx + 1} ${finding.pattern} ${finding.taskId} via ${chosen}` };
      return;
    }
    if (key !== 'x') {
      flashBanner('k/f/c are orphan-only; press x to act on this finding.');
      return;
    }
    resumeConfirm = { index: idx, label: `#${idx + 1} ${finding.pattern} ${finding.taskId}` };
  }

  /** V2 R2 — run only after an explicit y-confirm (confirmed:true). */
  async function runResumeConfirm(confirm: { index: number; orphanAction?: OrphanAction }): Promise<void> {
    const items = visibleResumeFindings();
    const finding = items[confirm.index];
    if (!finding) {
      lastError = 'finding vanished before confirm — nothing executed';
      renderToScreen();
      return;
    }
    try {
      const discovered = discoverConfig(cwd);
      if (!discovered.initialized || !discovered.config) throw new Error('not-initialized');
      const res = await executeGuidedAction(discovered.config.dataRoot, discovered.config.project, {
        pattern: finding.pattern,
        taskId: finding.taskId,
        ...(finding.runId ? { runId: finding.runId } : {}),
        ...(finding.preparationId ? { preparationId: finding.preparationId } : {}),
        ...(confirm.orphanAction ? { orphanAction: confirm.orphanAction } : {}),
        confirmed: true,
      });
      refreshResumeScan();
      flashBanner(res.executed ? `done: ${res.summary}`.slice(0, 100) : `not executed: ${res.summary}`.slice(0, 100));
    } catch (e) {
      lastError = (e instanceof Error ? e.message : String(e)).slice(0, 120);
    }
    renderToScreen();
  }

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

  // ── Phase I3F-4: Task Edit ([e] from Task Detail only — spec #1, no global shortcut) ──

  function fieldDraftFromTask(task: TaskRecord, field: EditFieldKey): string {
    switch (field) {
      case 'title': return task.title;
      case 'goal': return task.goal;
      case 'reason': return task.reason;
      case 'scope': return task.scope;
      case 'completionCriteria': return task.completionCriteria.join(', ');
      case 'dependencies': return task.dependencies.join(', ');
    }
  }

  /** [e] on TASK_DETAIL: capture CAS context (expectedUpdatedAt) now, open the field menu. */
  function handleEditKeyOpen(): void {
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
      linkedRunsCount: task.linkedRuns.length,
    });
    if (availability.TASK_EDIT.state !== 'ENABLED') {
      showBanner(
        availability.TASK_EDIT.state === 'DISABLED' ? availability.TASK_EDIT.reason : 'Task Edit unavailable.',
        2500,
      );
      renderToScreen();
      return;
    }
    editTaskCtx = { dataRoot, project, taskId: task.taskId, expectedUpdatedAt: task.updatedAt };
    view = 'TASK_EDIT_MENU';
    renderToScreen();
  }

  /** TASK_EDIT_MENU: [1]-[6] select a field, Esc back to Task Detail. No free text here — q stays global quit. */
  function handleTaskEditMenuKey(s: string): void {
    if (s === '\x1b') {
      view = 'TASK_DETAIL';
      editTaskCtx = null;
      renderToScreen();
      return;
    }
    const entry = TASK_EDIT_FIELDS.find((f) => f.menuKey === s);
    if (!entry || !editTaskCtx) return;
    const { dataRoot, project, task } = resolveActionTask();
    if (!dataRoot || !project || !task || task.taskId !== editTaskCtx.taskId) {
      showBanner('Task changed. Review current state and try again.', 3000);
      view = 'TASK_DETAIL';
      editTaskCtx = null;
      doSnapshotRefresh();
      return;
    }
    editFieldKey = entry.key;
    editFieldState = { draft: fieldDraftFromTask(task, entry.key), error: undefined };
    view = 'TASK_EDIT_FIELD';
    renderToScreen();
  }

  async function submitTaskEditField(field: EditFieldKey, value: string): Promise<void> {
    if (!editTaskCtx || actionBusy) return;
    const ctx = editTaskCtx;
    actionBusy = true;
    view = 'TASK_DETAIL';
    editTaskCtx = null;
    editFieldKey = null;
    editFieldState = { draft: '', error: undefined };
    renderToScreen();
    try {
      const result = await executeTaskEdit(ctx, field, value);
      handleActionResult(result, `Task updated · ${ctx.taskId}`);
    } finally {
      actionBusy = false;
    }
  }

  /** TASK_EDIT_FIELD keys — intercepted before the global q-quit so typed text stays literal. */
  function handleTaskEditFieldKey(s: string): void {
    if (!editFieldKey) { view = 'TASK_EDIT_MENU'; renderToScreen(); return; }
    const bounds = boundsForEditField(editFieldKey);
    const withLabel = { ...bounds, label: TASK_EDIT_FIELDS.find((f) => f.key === editFieldKey)?.label ?? 'Field' };
    if (s === '\x1b') { // Esc cancel — back to the field menu, no mutation call.
      view = 'TASK_EDIT_MENU';
      editFieldKey = null;
      editFieldState = { draft: '', error: undefined };
      renderToScreen();
      return;
    }
    if (s === '\r' || s === '\n') { // Enter submit
      const effect = reduceBoundedTextInput(editFieldState, { type: 'submit' }, withLabel);
      if (effect.action === 'update') {
        editFieldState = effect.state;
        renderToScreen();
        return;
      }
      if (effect.action === 'submit') {
        void submitTaskEditField(editFieldKey, effect.value);
      }
      return;
    }
    if (s === '\x7f' || s === '\x08') { // Backspace
      const effect = reduceBoundedTextInput(editFieldState, { type: 'backspace' }, withLabel);
      if (effect.action === 'update') editFieldState = effect.state;
      renderToScreen();
      return;
    }
    if (s.startsWith('\x1b[')) return; // arrow keys ignored
    for (const ch of s) {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) continue; // control chars ignored (q included — literal text here)
      const effect = reduceBoundedTextInput(editFieldState, { type: 'char', value: ch }, withLabel);
      if (effect.action === 'update') editFieldState = effect.state;
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

    // CHANGES_INPUT / TASK_EDIT_FIELD: intercepted before the global q-quit
    // below -- typed q is literal text here, not a shortcut (spec I3F-3 #20 /
    // I3F-4 field input). TASK_EDIT_MENU is number-key selection only (no
    // free text), so it does NOT need this early interception.
    if (view === 'CHANGES_INPUT') {
      handleChangesInputKey(s);
      return;
    }
    if (view === 'TASK_EDIT_FIELD') {
      handleTaskEditFieldKey(s);
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
      if (view === 'RESUME_SCAN') {
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
      if (s === 's' || s === 'S') {
        // V2 R1 — read-only resume scan. Actions run only via explicit
        // confirm inside the scan view (V2 R2), never on open.
        refreshResumeScan();
        view = 'RESUME_SCAN';
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
      // I3F-4: [e] Edit — only reachable from Task Detail (spec #1, no global shortcut).
      if (s === 'e' || s === 'E') {
        handleEditKeyOpen();
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
    } else if (view === 'RESUME_SCAN') {
      if (s === 'r' || s === 'R') {
        refreshResumeScan();
        renderToScreen();
        return;
      }
      // V2 R2 — select a finding, arm an action, confirm explicitly (y/n).
      // Nothing executes without the y-confirm; n/Esc cancels.
      if (s >= '1' && s <= '8') {
        const n = Number(s) - 1;
        const count = Math.min(8, resumeScanReport?.findings.length ?? 0);
        if (n < count) {
          resumeSelected = n;
          resumeConfirm = null;
          renderToScreen();
        }
        return;
      }
      if (s === 'x' || s === 'X' || s === 'k' || s === 'K' || s === 'f' || s === 'F' || s === 'c' || s === 'C') {
        armResumeAction(s.toLowerCase());
        renderToScreen();
        return;
      }
      if ((s === 'y' || s === 'Y' || s === 'n' || s === 'N') && resumeConfirm) {
        const confirm = resumeConfirm;
        resumeConfirm = null;
        if (s === 'y' || s === 'Y') {
          void runResumeConfirm(confirm);
        } else {
          renderToScreen();
        }
        return;
      }
    } else if (view === 'TASK_EDIT_MENU') {
      handleTaskEditMenuKey(s);
      return;
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
      } else if (view === 'RESUME_SCAN') {
        out = renderResumeScanView(resumeScanReport, size, resumeScanError, {
          selected: resumeSelected,
          ...(resumeConfirm ? { confirmPrompt: `act on ${resumeConfirm.label}? (y/n)` } : {}),
        });
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
      } else if (view === 'TASK_EDIT_MENU') {
        // Field-selection menu only — spec #8: no full-screen editor, just [1]-[6] + Esc.
        const inner = size.cols - 2;
        const menuLines: string[] = [];
        menuLines.push('┌' + '─'.repeat(inner) + '┐');
        menuLines.push('│' + padCenter('Edit Task', inner) + '│');
        menuLines.push('│' + ' '.repeat(inner) + '│');
        for (const f of TASK_EDIT_FIELDS) {
          menuLines.push('│' + padRight(` [${f.menuKey}] ${f.label}`, inner) + '│');
        }
        menuLines.push('│' + ' '.repeat(inner) + '│');
        menuLines.push('│' + padRight(' [Esc] Back', inner) + '│');
        menuLines.push('└' + '─'.repeat(inner) + '┘');
        out = menuLines.join('\n');
      } else if (view === 'TASK_EDIT_FIELD') {
        // Bounded field input, prefilled with the current value (spec #8/#9).
        const inner = size.cols - 2;
        const fieldLabel = TASK_EDIT_FIELDS.find((f) => f.key === editFieldKey)?.label ?? 'Field';
        const bounds = editFieldKey ? boundsForEditField(editFieldKey) : { min: 1, max: 5000 };
        const draft = editFieldState.draft;
        const preview = draft.length > inner - 14 ? draft.slice(-(inner - 14)) : draft;
        const cursor = '█';
        const inputLines: string[] = [];
        inputLines.push('┌' + '─'.repeat(inner) + '┐');
        inputLines.push('│' + padCenter(`Edit ${fieldLabel}`, inner) + '│');
        inputLines.push('│' + ' '.repeat(inner) + '│');
        const prompt = `${fieldLabel} > ${preview}${cursor}`;
        inputLines.push('│' + padRight(truncate(prompt, inner), inner) + '│');
        if (editFieldState.error) {
          inputLines.push('│' + padRight(truncate('! ' + editFieldState.error, inner), inner) + '│');
        } else {
          inputLines.push('│' + padRight(`${draft.length}/${bounds.max} chars (min ${bounds.min}) · Enter:submit  Esc:cancel  Backspace:edit`, inner) + '│');
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
