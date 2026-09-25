import React, { useCallback, useEffect, useState } from 'react';
import { must } from './bridge.js';
import { ModelUsagePanel } from './approvals.js';
import { InlineConfirm } from './components.js';
import type { ControlRoomModelUsage } from '../shared/types.js';
import { controlRoomTaskId, controlRoomTaskTitle, founderTaskTitle, controlRoomHasDoneData, controlRoomTodayCount, controlRoomTodayDone, controlRoomVerifiedDoneTotal, controlRoomWorkingRows, laneAttention } from '../shared/types.js';
import { PROJECT_LABELS, holdCardMessage, holdStepLabel, isSelfReviewChain, isSelfReviewOption, visibleHoldEntries } from '../shared/projectLabels.js';

export interface ControlRoomHoldExplain {
  sentence?: unknown;
  choice?: unknown;
  recommended?: unknown;
  [key: string]: unknown;
}

export interface ControlRoomHold {
  taskId?: string;
  reason?: string;
  step?: string | number;
  explain?: string | ControlRoomHoldExplain;
  choice?: string | number;
  options?: unknown;
  [key: string]: unknown;
}

export interface ControlRoomLane {
  id?: string;
  project?: string;
  current?: { stage?: number | string; taskId?: string; worker?: unknown; qa?: unknown; [key: string]: unknown };
  workerChain?: unknown;
  qaChain?: unknown;
  holds?: Array<ControlRoomHold | string>;
  humanGate?: Record<string, unknown>;
  founderGate?: Record<string, unknown>;
  blocker?: string;
  [key: string]: unknown;
}

interface ControlRoomBoard {
  lanes?: ControlRoomLane[];
  models?: Record<string, ControlRoomModelUsage>;
  todayDone?: unknown;
  routing?: unknown;
}
type FlowState = 'done' | 'active' | 'blocked' | 'pending';
type ActionStatus = { state: 'pending' | 'done' | 'error'; text: string } | null;

const FLOW = ['계획', '확인', '작업', '검수', '시험', '사람 확인', '반영'];

/** 8 runtime ids offered by the night orchestrator (first = preferred, rest = 예비). */
const RUNTIMES: readonly string[] = [
  'codex',
  'opencode',
  'cline',
  'grok',
  'cursor',
  'claude',
  'claude-team',
  'claude-pro',
];

/** Approval categories that must never be offered a save-as-rule shortcut. */
const NEVER_AUTO_CATEGORIES: ReadonlySet<string> = new Set([
  'secret',
  'auth',
  'payment',
  'delete',
  'destructive',
]);

function label(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stageIndex(stage: number | string): number {
  if (typeof stage === 'number' && Number.isFinite(stage)) return Math.max(0, Math.min(FLOW.length - 1, stage));
  const value = String(stage).toUpperCase();
  if (value.includes('INTEGR') || value.includes('통합') || value.includes('반영') || value === 'DONE' || value === 'COMPLETE') return 6;
  if (value.includes('HUMAN') || value.includes('FOUNDER') || value.includes('사람 확인')) return 5;
  if (value.includes('GATE') || value.includes('시험')) return 4;
  if (value.includes('QA') || value.includes('검수')) return 3;
  if (value.includes('WORKER') || value.includes('BUILDER') || value.includes('작업')) return 2;
  if (value.includes('VERIF') || value.includes('VALID') || value.includes('검증') || value.includes('확인')) return 1;
  return 0;
}

function flowState(stage: number | string, index: number): FlowState {
  const value = String(stage).toUpperCase();
  if (value.includes('BLOCK') || value.includes('HOLD')) return index < stageIndex(stage) ? 'done' : index === stageIndex(stage) ? 'blocked' : 'pending';
  if (value === 'DONE' || value === 'COMPLETE' || value === 'V1_COMPLETE' || value === 'INTEGRATED') return 'done';
  const current = stageIndex(stage);
  return index < current ? 'done' : index === current ? 'active' : 'pending';
}

function detail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return label(record.reason ?? record.ask ?? record.verdict ?? record.state ?? record.status);
  }
  return '—';
}

function projectOf(lane: ControlRoomLane): string {
  const raw = lane.project ?? lane.id;
  return typeof raw === 'string' ? raw : '';
}

function projectPresentation(lane: ControlRoomLane): { id: string; name: string; goal: string } {
  const id = projectOf(lane);
  const known = PROJECT_LABELS[id];
  const current = lane.current ?? {};
  return {
    id,
    name: known?.name ?? label(lane.project ?? lane.id, '알 수 없는 프로젝트'),
    goal: label(lane.goal ?? lane.summary ?? current.goal ?? current.summary, known?.goal ?? '현재 작업 목표를 확인하세요.'),
  };
}

function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function qaFindingOf(lane: ControlRoomLane): unknown {
  const current = lane.current ?? {};
  const qa = current.qa;
  if (lane.qaFinding ?? lane.qaFindings ?? current.qaFinding ?? current.qaFindings) return lane.qaFinding ?? lane.qaFindings ?? current.qaFinding ?? current.qaFindings;
  if (qa && typeof qa === 'object') return (qa as Record<string, unknown>).finding ?? (qa as Record<string, unknown>).findings;
  return undefined;
}

function holdSummary(lane: ControlRoomLane, reason: string): string | null {
  return holdCardMessage(lane.blocker, reason);
}

/** Normalize a worker/QA chain value (string | string[] | {chain|name|...}) to an ordered id list. */
function chainToList(value: unknown): string[] {
  const clean = (items: unknown[]): string[] =>
    items.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (Array.isArray(value)) return clean(value);
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,|\s>→]+/).map(part => part.trim()).filter(part => part.length > 0);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const chain = record.chain ?? record.runtimes ?? record.order;
    if (Array.isArray(chain)) return clean(chain);
    const single = record.name ?? record.id ?? record.runtime;
    if (typeof single === 'string' && single.trim()) return [single.trim()];
  }
  return [];
}

function isPaused(lane: ControlRoomLane): boolean {
  const current = lane.current ?? {};
  if (lane.paused === true || current.paused === true) return true;
  if (/paus|hold|stop|block/i.test(String(current.stage ?? ''))) return true;
  if (typeof lane.blocker === 'string' && lane.blocker.trim()) return true;
  // choice가 'skip'인 보류는 보여주지 않으므로 멈춤 판단에서도 제외한다.
  return visibleHoldEntries(lane.holds).length > 0;
}

// ── R5/R6 "오늘 끝난 일 / 지금 일하는 AI" ───────────────────────────────────
// 현재 작업은 한국어 title을 보여주고 ID는 원문 보기로만 둔다.
// current가 비어 있는 레인은 쉬는 중 — 모든 단계 pending.

const currentTitleOf = founderTaskTitle;

const currentIdOf = controlRoomTaskId;

function hasWork(lane: ControlRoomLane): boolean {
  const current = lane.current ?? {};
  return controlRoomTaskTitle(current) !== '' || currentIdOf(current) !== '';
}

interface TodayItem { lane: string; taskId: string; title: string; scope?: string }

function todayItemsOf(board: ControlRoomBoard | null): TodayItem[] {
  return controlRoomTodayDone(board).map(item => ({ lane: item.project, taskId: item.taskId, title: item.title, scope: item.scope }));
}

function TodayCard({ board }: { board: ControlRoomBoard | null }): React.ReactElement {
  const items = todayItemsOf(board).slice(0, 3);
  const count = controlRoomTodayCount(board);
  const hasData = controlRoomHasDoneData(board);
  const total = controlRoomVerifiedDoneTotal(board);
  return (
    <section className="control-card today-card" aria-label="오늘 끝난 일">
      <h2>오늘 끝난 일</h2>
      {!hasData
        ? <p className="muted">오늘 기록은 아직 안 왔어요 · 지금까지 끝난 작업 {total}개</p>
        : count === 0
          ? <p className="muted">오늘 끝난 일은 아직 없어요.</p>
          : <><p className="control-card-value">오늘 {count}개 끝났어요</p><ul className="today-list">
            {items.map((item, index) => (
              <li key={`${item.lane}-${item.taskId || item.title}-${index}`}>
                <span><strong>{item.lane ? `${PROJECT_LABELS[item.lane]?.name ?? item.lane} · ` : ''}{item.title}</strong></span>
                <details><summary>원문 보기</summary><p className="muted mono">ID: {item.taskId || '—'}</p>{item.scope && <p className="muted mono">범위: {item.scope}</p>}</details>
              </li>
            ))}
          </ul></>}
    </section>
  );
}

function WhoLine({ board }: { board: ControlRoomBoard | null }): React.ReactElement {
  const rows = controlRoomWorkingRows(board?.lanes ?? [], board?.routing);
  return (
    <section className="control-card who-line" aria-label="지금 일하는 AI">
      <p className="control-card-value who-text">지금 일하는 AI</p>
      {rows.length === 0 ? <p className="muted">쉬는 중</p> : rows.map(row => <p key={row} className="muted">{row}</p>)}
    </section>
  );
}

interface ParsedGate {
  gateId: string;
  title: string;
  options: string[];
  category: string;
  summary: string;
  canSaveRule: boolean;
}

function sanitizeCategory(raw: unknown): string {
  const lowered = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return /^[a-z-]{2,30}$/.test(lowered) ? lowered : 'gate-approval';
}

function parseGate(gate: Record<string, unknown>): ParsedGate | null {
  const rawId = gate.gateId ?? gate.id;
  if (typeof rawId !== 'string' || !rawId) return null;
  const title = label(gate.ask ?? gate.title ?? gate.question ?? gate.summary, rawId);
  const rawOptions = gate.options ?? gate.choices ?? gate.candidates;
  const options = Array.isArray(rawOptions)
    ? rawOptions
      .map(option => {
        if (typeof option === 'string') return option;
        if (option && typeof option === 'object') {
          const record = option as Record<string, unknown>;
          return label(record.label ?? record.title, '');
        }
        return '';
      })
      .filter(option => option !== '')
    : [];
  const list = options.length > 0 ? options : ['승인', '반려'];
  const category = sanitizeCategory(gate.category ?? gate.kind ?? 'gate-approval');
  const summary = title.slice(0, 200) || rawId;
  return { gateId: rawId, title, options: list, category, summary, canSaveRule: !NEVER_AUTO_CATEGORIES.has(category) };
}

function statusText(status: ActionStatus): string {
  if (!status) return '';
  const prefix = status.state === 'pending' ? '…' : status.state === 'done' ? '✓ ' : '! ';
  return `${prefix}${status.text}`;
}

function ChainEditor({ project, role, initial, workerChain, onRefresh }: {
  project: string;
  role: 'worker' | 'qa';
  initial: string[];
  workerChain?: string[];
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [picked, setPicked] = useState<string[]>(initial);
  const [status, setStatus] = useState<ActionStatus>(null);
  const [busy, setBusy] = useState(false);
  const selfReview = role === 'qa' ? isSelfReviewChain(workerChain ?? [], picked) : false;

  function toggle(runtime: string): void {
    setPicked(prev => {
      if (prev.includes(runtime)) return prev.filter(item => item !== runtime);
      if (prev.length >= 4) return prev;
      return [...prev, runtime];
    });
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || picked.length < 1) return;
    setBusy(true);
    setStatus({ state: 'pending', text: '저장 중…' });
    try {
      await must({ op: 'controlRoom:laneSet', project, role, runtimes: picked });
      setStatus({ state: 'done', text: `저장됨 (${role}: ${picked.join(' → ')})` });
      await onRefresh();
    } catch (err) {
      setStatus({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="chain-editor" onSubmit={e => void submit(e)} aria-label={`${role === 'worker' ? '만드는 AI 순서 저장' : '검수하는 AI 순서 저장'}`}>
      <h4>{role === 'worker' ? '만드는 AI 바꾸기' : '검수하는 AI 바꾸기'}</h4>
      <p className="muted">순서대로 선택 — 첫 번째가 우선, 나머지는 예비 (최대 4개)</p>
      <div className="chain-picks" role="group" aria-label={`${role} runtime 순서 선택`}>
        {RUNTIMES.map(runtime => {
          const order = picked.indexOf(runtime);
          return (
            <button
              key={runtime}
              type="button"
              className={`chain-pick${order >= 0 ? ' selected' : ''}`}
              aria-pressed={order >= 0}
              onClick={() => toggle(runtime)}
            >
              {order >= 0 && <span className="chain-order">{order + 1}</span>}
              {runtime}
            </button>
          );
        })}
      </div>
      <p className="chain-current">현재 순서: <strong>{picked.length ? picked.join(' → ') : '—'}</strong></p>
      {selfReview && <p className="muted">만든 AI가 스스로 검수할 수 없어요. 다른 AI를 첫 번째로 골라 주세요.</p>}
      <button className="btn" type="submit" disabled={busy || picked.length < 1 || selfReview}>
        {busy ? '저장 중…' : 'AI 순서 저장'}
      </button>
      {status && <p className={`control-status ${status.state}`} role="status">{statusText(status)}</p>}
    </form>
  );
}

function ResumeControl({ project, onRefresh }: {
  project: string;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [status, setStatus] = useState<ActionStatus>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  async function resume(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus({ state: 'pending', text: '다시 시작 중…' });
    try {
      await must({ op: 'controlRoom:resume', project });
      setStatus({ state: 'done', text: '다시 시작됨' });
      setPending(false);
      await onRefresh();
    } catch (err) {
      setStatus({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="resume-control">
      <button className="btn primary" type="button" disabled={busy} onClick={() => setPending(true)}>
        {busy ? '다시 시작 중…' : '다시 시작'}
      </button>
      {pending && (
        <InlineConfirm
          message="다시 시작하시겠어요?"
          confirmLabel="다시 시작"
          busy={busy}
          busyLabel="다시 시작 중…"
          onConfirm={() => void resume()}
          onCancel={() => setPending(false)}
        />
      )}
      {status && <p className={`control-status ${status.state}`} role="status">{statusText(status)}</p>}
    </div>
  );
}

function GateForm({ gate, onRefresh }: {
  gate: Record<string, unknown>;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const parsed = parseGate(gate);
  const [pick, setPick] = useState(0);
  const [saveRule, setSaveRule] = useState(false);
  const [status, setStatus] = useState<ActionStatus>(null);
  const [busy, setBusy] = useState(false);

  if (!parsed) {
    return <p>{detail(gate.ask ?? gate.title ?? gate.gateId ?? gate.status ?? '확인 필요')}</p>;
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !parsed) return;
    setBusy(true);
    setStatus({ state: 'pending', text: '제출 중…' });
    try {
      await must({ op: 'gates:answer', gateId: parsed.gateId, optionIndex: pick });
      let text = `제출됨 (${parsed.options[pick] ?? String(pick)})`;
      if (saveRule && parsed.canSaveRule) {
        await must({ op: 'controlRoom:approvalAdd', category: parsed.category, summary: parsed.summary });
        text += ` · 규칙 저장됨 (${parsed.category})`;
      }
      setStatus({ state: 'done', text });
      await onRefresh();
    } catch (err) {
      setStatus({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={e => void submit(e)}>
      <fieldset className="gate-fieldset">
        <legend>{parsed.title}</legend>
        <details><summary>원문 보기</summary><p className="muted mono gate-id">{parsed.gateId}</p></details>
        {parsed.options.map((option, index) => (
          <label key={`${parsed.gateId}-${index}`} className="plan-radio">
            <input
              type="radio"
              name={`gate-${parsed.gateId}`}
              checked={pick === index}
              onChange={() => setPick(index)}
            />
            {option}
          </label>
        ))}
        {parsed.canSaveRule && (
          <label className="save-rule">
            <input
              type="checkbox"
              checked={saveRule}
              onChange={e => setSaveRule(e.target.checked)}
            />
            승인 + 규칙으로 저장 ({parsed.category})
          </label>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '제출 중…' : '답변 제출'}
        </button>
        {status && <p className={`control-status ${status.state}`} role="status">{statusText(status)}</p>}
      </fieldset>
    </form>
  );
}

function HoldOptionButtons({ hold, gateId, taskTitle, onRefresh }: {
  hold: { options: string[]; optionIds: string[]; recommendedIndex: number; taskId?: string };
  gateId: string | null;
  taskTitle: string;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [pending, setPending] = useState<number | null>(null);
  const [status, setStatus] = useState<ActionStatus>(null);
  const [busy, setBusy] = useState(false);

  async function confirm(optionIndex: number, optionLabel: string): Promise<void> {
    if (busy) return;
    const optionId = hold.optionIds[optionIndex];
    if (isSelfReviewOption(optionLabel)) {
      setPending(null);
      setStatus({ state: 'done', text: '직접 확인할게요 — 아래 원문 보기에서 증거를 확인하세요.' });
      return;
    }
    setBusy(true);
    setStatus({ state: 'pending', text: `실행 중… (${optionLabel})` });
    try {
      if (gateId) {
        await must({ op: 'gates:answer', gateId, optionIndex });
      } else {
        if (!hold.taskId || !optionId) throw new Error('보류 작업 정보가 없어 실행할 수 없습니다.');
        await must({ op: 'controlRoom:holdChoose', taskId: hold.taskId, option: optionId as 'retry' | 'narrow' | 'skip' });
      }
      setStatus({ state: 'done', text: `실행됨 (${optionLabel})` });
      setPending(null);
      await onRefresh();
    } catch (err) {
      setStatus({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hold-options" role="group" aria-label="보류 선택지">
      {hold.options.map((option, optionIndex) => {
        const recommended = optionIndex === hold.recommendedIndex;
        const isPending = pending === optionIndex;
        return (
          <div key={`${hold.taskId ?? 'hold'}-${optionIndex}`} className="hold-option-row">
            <button
              type="button"
              className={`hold-option${recommended ? ' recommended' : ''}`}
              aria-pressed={isPending}
              disabled={busy}
              onClick={() => setPending(isPending ? null : optionIndex)}
            >
              {option}{recommended ? ' (추천)' : ''}
            </button>
            {isPending && (
              <div className="hold-confirm">
                <p>‘{taskTitle}’을 ‘{option}’로 진행할게요</p>
                <div className="hold-confirm-actions">
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void confirm(optionIndex, option)}>
                    {busy ? '실행 중…' : '확인'}
                  </button>
                  <button className="btn subtle" type="button" disabled={busy} onClick={() => setPending(null)}>
                    취소
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {status && <p className={`control-status ${status.state}`} role="status">{statusText(status)}</p>}
    </div>
  );
}

function LaneView({ lane, onRefresh }: {
  lane: ControlRoomLane;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const current = lane.current ?? {};
  const holds = visibleHoldEntries(lane.holds);
  const hasCurrent = hasWork(lane);
  const holdCurrent = !hasCurrent ? holds[0] : undefined;
  const rawHold = holdCurrent && lane.holds?.find(entry => entry && typeof entry === 'object' && controlRoomTaskId(entry) === holdCurrent.taskId);
  const currentTask = hasCurrent ? current : rawHold;
  const stageValue = hasCurrent ? current.stage ?? 0 : holdCurrent?.step ?? 0;
  const working = hasCurrent || Boolean(holdCurrent);
  const taskTitle = currentTitleOf(currentTask);
  const taskId = hasCurrent ? currentIdOf(current) : holdCurrent?.taskId ?? '';
  const stage = working ? (holdCurrent ? `멈춤 · ${holdStepLabel(stageValue) || FLOW[stageIndex(stageValue)] || '계획'}` : (FLOW[stageIndex(stageValue)] ?? '계획')) : '쉬는 중';
  const gate = lane.humanGate ?? lane.founderGate;
  const worker = lane.workerChain ?? current.worker;
  const qa = lane.qaChain ?? current.qa;
  const project = projectOf(lane);
  const presentation = projectPresentation(lane);
  const qaFinding = qaFindingOf(lane);
  const paused = isPaused(lane);
  const workerText = detail(worker);
  const qaText = detail(qa);
  const showWorker = workerText !== '' && workerText !== '—';
  const showQa = qaText !== '' && qaText !== '—';
  const explainedHolds = holds.filter(hold => hold.sentence);
  const plainReasons = holds.filter(hold => !hold.sentence).map(hold => hold.reason || hold.taskId).filter(text => text.trim().length > 0);
  const holdText = explainedHolds.length > 0
    ? holdSummary(lane, plainReasons.join(', '))
    : holdSummary(lane, holds.map(hold => hold.reason || hold.taskId).join(', '));
  const rawReasons = holds.map(hold => hold.reason).filter(text => text.trim().length > 0);
  const holdTitle = (hold: { taskId?: string; reason?: string }): string => {
    const raw = lane.holds?.find(entry => entry && typeof entry === 'object' &&
      controlRoomTaskId(entry) === hold.taskId);
    return founderTaskTitle(raw ?? hold);
  };
  const holdTitles = holds.map(hold => holdTitle(hold));
  const showHoldCard = explainedHolds.length > 0 || holdText !== null;
  const gateRecord = (lane.humanGate ?? lane.founderGate) as Record<string, unknown> | undefined;
  const gateIdForHold = typeof gateRecord?.gateId === 'string' && gateRecord.gateId
    ? gateRecord.gateId
    : typeof gateRecord?.id === 'string' && gateRecord.id ? gateRecord.id : null;
  return (
    <section className="control-lane-view">
      <header className="control-card">
        <h2>{presentation.name}</h2>
        <details>
          <summary>원문 보기</summary>
          <p className="muted mono">{presentation.id || '—'}</p>
          {taskId && <p className="muted mono">ID: {taskId}</p>}
          <pre className="mono">{rawText(lane)}</pre>
        </details>
      </header>
      <div className="control-flow" aria-label="진행 단계">
        {FLOW.map((name, index) => {
          const state = working && holdCurrent ? flowState(`BLOCK ${stageValue}`, index) : working ? flowState(stageValue, index) : 'pending';
          return <div className={`control-step ${state}`} key={name}><span className="control-step-dot">{state === 'done' ? '✓' : state === 'blocked' ? '!' : state === 'active' ? '●' : '○'}</span><span>{name}</span></div>;
        })}
      </div>
      <div className="control-cards">
        <article className="control-card">
          <h3>현재 작업</h3>
          <p className="control-card-value">{working ? (taskTitle || '지금 하는 일 없음') : '쉬는 중'}</p>
          <p className="muted">단계: {stage}</p>
          {working && <details><summary>원문 보기</summary><p className="muted mono">ID: {taskId || '—'}</p><pre className="mono">{rawText(currentTask)}</pre></details>}
          {paused && project && holds.length === 0 && <ResumeControl project={project} onRefresh={onRefresh} />}
        </article>
        <article className="control-card wide">
          <h3>담당 AI</h3>
          {showWorker && <p>만드는 AI: <strong>{workerText}</strong></p>}
          {showQa && <p>검수하는 AI: <strong>{qaText}</strong></p>}
          {project && (
            <div className="control-actions">
              <ChainEditor key={`${project}-worker`} project={project} role="worker" initial={chainToList(worker)} onRefresh={onRefresh} />
              <ChainEditor key={`${project}-qa`} project={project} role="qa" initial={chainToList(qa)} workerChain={chainToList(worker)} onRefresh={onRefresh} />
            </div>
          )}
        </article>
        {showHoldCard && <article className="control-card blocked"><h3>보류 / 차단</h3>{explainedHolds.map((hold, index) => (
          <div key={hold.taskId || hold.sentence || index} className="hold-explain">
            <p><strong>{founderTaskTitle(lane.holds?.find(entry => entry && typeof entry === 'object' && controlRoomTaskId(entry) === hold.taskId) ?? hold)}</strong></p>
            <p>{hold.sentence}</p>
            {hold.step && <p className="muted">단계: {holdStepLabel(hold.step)}</p>}
            <HoldOptionButtons hold={hold} gateId={gateIdForHold} taskTitle={holdTitle(hold)} onRefresh={onRefresh} />
          </div>
        ))}{holdText !== null && <p>{holdTitles.join(' · ')}</p>}{explainedHolds.length > 0
          ? <details><summary>원문 보기</summary>{holds.map((hold, index) => <><p key={`id-${index}`} className="muted mono">ID: {hold.taskId || '—'}</p><pre key={`reason-${index}`} className="mono">{rawReasons[index] || hold.reason}</pre></>)}{qaFinding !== undefined && <pre className="mono">{rawText(qaFinding)}</pre>}</details>
          : qaFinding !== undefined && <details><summary>원문 검수 의견</summary><pre className="mono">{rawText(qaFinding)}</pre></details>}</article>}
        {gate && <article className="control-card human"><h3>사람 확인</h3><GateForm gate={gate} onRefresh={onRefresh} /></article>}
      </div>
    </section>
  );
}

/** Stable key for lane selection — lane id first, never a bare index. */
function laneSelectKey(lane: ControlRoomLane, index: number): string {
  if (typeof lane.id === 'string' && lane.id) return lane.id;
  if (typeof lane.project === 'string' && lane.project) return lane.project;
  return `__index-${index}`;
}

/** Sort rank for attention badges: decision first, then hold, then the rest. */
function attentionRank(lane: ControlRoomLane): number {
  const attn = laneAttention(lane);
  if (attn === 'decision') return 0;
  if (attn === 'hold') return 1;
  return 2;
}

/** Stable-sort lanes so 'decision' lanes come first, then 'hold', then the rest. */
function sortLanesByAttention(lanes: ControlRoomLane[]): ControlRoomLane[] {
  return lanes
    .map((lane, index) => ({ lane, index }))
    .sort((a, b) => attentionRank(a.lane) - attentionRank(b.lane) || a.index - b.index)
    .map(entry => entry.lane);
}

export function ControlRoom({ onClose }: { onClose: () => void }): React.ReactElement {
  const [board, setBoard] = useState<ControlRoomBoard | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await must<ControlRoomBoard>({ op: 'controlRoom:board' });
      setBoard({
        lanes: Array.isArray(next?.lanes) ? next.lanes : [],
        models: next?.models && typeof next.models === 'object' ? next.models : undefined,
        routing: (next as Record<string, unknown>)?.routing,
        todayDone: (next as Record<string, unknown>)?.todayDone
          ?? (next as Record<string, unknown>)?.today_done
          ?? (next as Record<string, unknown>)?.doneToday
          ?? (next as Record<string, unknown>)?.completedToday
          ?? (next as Record<string, unknown>)?.done,
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      if (alive) void load();
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [load]);

  const lanes = board?.lanes ?? [];
  const sortedLanes = sortLanesByAttention(lanes);
  const decisionCount = sortedLanes.filter(lane => laneAttention(lane) === 'decision').length;
  const activeLane = sortedLanes.find((lane, index) => laneSelectKey(lane, index) === selectedId) ?? sortedLanes[0];
  const activeKey = activeLane ? laneSelectKey(activeLane, sortedLanes.indexOf(activeLane)) : null;
  return (
    <main className="control-room">
      <div className="control-room-head"><div><h1>관제실</h1>{decisionCount > 0 && <p className="control-decision-count">결정 대기 {decisionCount}건</p>}<p className="muted">5초마다 자동으로 새로 고쳐요.</p></div><button className="btn" onClick={onClose}>닫기</button></div>
      <TodayCard board={board} />
      <WhoLine board={board} />
      <ModelUsagePanel models={board?.models} />
      {board === null && !error ? <div className="control-empty">작업 PC에서 불러오는 중…</div>
      : error && lanes.length === 0 ? <div className="control-empty">{error}</div>
      : !sortedLanes.length ? null : <>
        <div className="control-tabs" role="tablist" aria-label="프로젝트 목록">{sortedLanes.map((lane, index) => { const presentation = projectPresentation(lane); const key = laneSelectKey(lane, index); const isActive = key === activeKey; const attn = laneAttention(lane); return <button className={`control-tab${isActive ? ' active' : ''}`} key={lane.id ?? lane.project ?? index} onClick={() => setSelectedId(key)} role="tab" aria-selected={isActive} aria-label={`${presentation.name}: ${presentation.goal}`}><span>{presentation.name}</span>{attn === 'decision' && <span className="attn-badge decision">결정 필요</span>}{attn === 'hold' && <span className="attn-badge hold">보류</span>}<small style={{ display: 'block', marginTop: 4 }}>{presentation.goal}</small></button>; })}</div>
        {activeLane && <LaneView lane={activeLane} onRefresh={load} />}
      </>}
    </main>
  );
}
