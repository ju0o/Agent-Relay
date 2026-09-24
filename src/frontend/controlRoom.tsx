import React, { useCallback, useEffect, useState } from 'react';
import { must } from './bridge.js';
import { ModelUsagePanel } from './approvals.js';
import type { ControlRoomModelUsage } from '../shared/types.js';
import { PROJECT_LABELS } from '../shared/projectLabels.js';

export interface ControlRoomLane {
  id?: string;
  project?: string;
  current?: { stage?: number | string; taskId?: string; worker?: unknown; qa?: unknown; [key: string]: unknown };
  workerChain?: unknown;
  qaChain?: unknown;
  holds?: Array<{ taskId?: string; reason?: string } | string>;
  humanGate?: Record<string, unknown>;
  founderGate?: Record<string, unknown>;
  blocker?: string;
  [key: string]: unknown;
}

interface ControlRoomBoard {
  lanes?: ControlRoomLane[];
  models?: Record<string, ControlRoomModelUsage>;
}
type FlowState = 'done' | 'active' | 'blocked' | 'pending';
type ActionStatus = { state: 'pending' | 'done' | 'error'; text: string } | null;

const FLOW = ['PM', '검증', 'WORKER', 'QA', 'GATE', 'HUMAN', '통합'];

/** 8 runtime ids offered by the night orchestrator (first = preferred, rest = quota fallback). */
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
  if (value.includes('INTEGR') || value.includes('통합') || value === 'DONE' || value === 'COMPLETE') return 6;
  if (value.includes('HUMAN') || value.includes('FOUNDER')) return 5;
  if (value.includes('GATE')) return 4;
  if (value.includes('QA')) return 3;
  if (value.includes('WORKER') || value.includes('BUILDER')) return 2;
  if (value.includes('VERIF') || value.includes('VALID') || value.includes('검증')) return 1;
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

function holdSummary(lane: ControlRoomLane, reason: string): string {
  const text = `${lane.blocker ?? ''} ${reason}`.toUpperCase();
  if (text.includes('FOUNDER')) return 'Founder 확인이 필요해 작업을 보류했습니다.';
  if (text.includes('SCOPE')) return '승인된 작업 범위가 없어 작업을 보류했습니다.';
  if (text.includes('NOT_CONNECTED')) return 'PM 연결이 없어 다음 작업을 대기 중입니다.';
  return reason ? `작업이 보류되었습니다: ${reason}` : '작업이 보류되었습니다.';
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
  return Array.isArray(lane.holds) && lane.holds.length > 0;
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

function ChainEditor({ project, role, initial, onRefresh }: {
  project: string;
  role: 'worker' | 'qa';
  initial: string[];
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const [picked, setPicked] = useState<string[]>(initial);
  const [status, setStatus] = useState<ActionStatus>(null);
  const [busy, setBusy] = useState(false);

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
    <form className="chain-editor" onSubmit={e => void submit(e)} aria-label={`${role} agent 바꾸기`}>
      <h4>{role === 'worker' ? 'Worker Agent 바꾸기' : 'QA Agent 바꾸기'}</h4>
      <p className="muted">순서대로 선택 — 첫 번째가 우선, 나머지는 quota fallback (최대 4개)</p>
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
      <button className="btn" type="submit" disabled={busy || picked.length < 1}>
        {busy ? '저장 중…' : 'Agent 바꾸기'}
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

  async function resume(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus({ state: 'pending', text: '다시 시작 중…' });
    try {
      await must({ op: 'controlRoom:resume', project });
      setStatus({ state: 'done', text: '다시 시작됨' });
      await onRefresh();
    } catch (err) {
      setStatus({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="resume-control">
      <button className="btn primary" type="button" disabled={busy} onClick={() => void resume()}>
        {busy ? '다시 시작 중…' : '다시 시작'}
      </button>
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
        <p className="muted mono gate-id">{parsed.gateId}</p>
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

function LaneView({ lane, onRefresh }: {
  lane: ControlRoomLane;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const current = lane.current ?? {};
  const stageValue = current.stage ?? 0;
  const stage = typeof stageValue === 'number' ? FLOW[stageIndex(stageValue)] : label(stageValue, 'PM');
  const holds = Array.isArray(lane.holds) ? lane.holds : [];
  const gate = lane.humanGate ?? lane.founderGate;
  const worker = lane.workerChain ?? current.worker;
  const qa = lane.qaChain ?? current.qa;
  const project = projectOf(lane);
  const presentation = projectPresentation(lane);
  const qaFinding = qaFindingOf(lane);
  const paused = isPaused(lane);
  return (
    <section className="control-lane-view">
      <header className="control-card">
        <h2>{presentation.name}</h2>
        <p>{presentation.goal}</p>
        <details>
          <summary>원문 보기</summary>
          <p className="muted mono">{presentation.id || '—'}</p>
          <pre className="mono">{rawText(lane)}</pre>
        </details>
      </header>
      <div className="control-flow" aria-label="lane lifecycle">
        {FLOW.map((name, index) => {
          const state = flowState(stageValue, index);
          return <div className={`control-step ${state}`} key={name}><span className="control-step-dot">{state === 'done' ? '✓' : state === 'blocked' ? '!' : state === 'active' ? '●' : '○'}</span><span>{name}</span></div>;
        })}
      </div>
      <div className="control-cards">
        <article className="control-card">
          <h3>현재 작업</h3>
          <p className="control-card-value">{label(current.taskId, label(lane.id ?? lane.project))}</p>
          <p className="muted">단계: {stage}</p>
          {paused && project && <ResumeControl project={project} onRefresh={onRefresh} />}
        </article>
        <article className="control-card wide">
          <h3>WORKER → QA</h3>
          <p>Worker: <strong>{detail(worker)}</strong></p>
          <p>QA: <strong>{detail(qa)}</strong></p>
          {project && (
            <div className="control-actions">
              <ChainEditor key={`${project}-worker`} project={project} role="worker" initial={chainToList(worker)} onRefresh={onRefresh} />
              <ChainEditor key={`${project}-qa`} project={project} role="qa" initial={chainToList(qa)} onRefresh={onRefresh} />
            </div>
          )}
        </article>
        {(lane.blocker || holds.length > 0) && <article className="control-card blocked"><h3>보류 / 차단</h3><p>{holdSummary(lane, holds.map(detail).join(', '))}</p>{qaFinding !== undefined && <details><summary>원문 QA finding</summary><pre className="mono">{rawText(qaFinding)}</pre></details>}</article>}
        {gate && <article className="control-card human"><h3>Human Gate</h3><GateForm gate={gate} onRefresh={onRefresh} /></article>}
      </div>
    </section>
  );
}

export function ControlRoom({ onClose }: { onClose: () => void }): React.ReactElement {
  const [board, setBoard] = useState<ControlRoomBoard>({ lanes: [] });
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await must<ControlRoomBoard>({ op: 'controlRoom:board' });
      setBoard({
        lanes: Array.isArray(next?.lanes) ? next.lanes : [],
        models: next?.models && typeof next.models === 'object' ? next.models : undefined,
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

  const lanes = board.lanes ?? [];
  const activeLane = lanes[Math.min(selected, Math.max(0, lanes.length - 1))];
  return (
    <main className="control-room">
      <div className="control-room-head"><div><h1>Control Room</h1><p className="muted">5초마다 board를 읽습니다 · 액션 실행 후 다시 읽습니다</p></div><button className="btn" onClick={onClose}>닫기</button></div>
      {error && <div className="flash err">{error}</div>}
      <ModelUsagePanel models={board.models} />
      {!lanes.length ? <div className="control-empty">표시할 lane이 없습니다.</div> : <>
        <div className="control-tabs" role="tablist">{lanes.map((lane, index) => { const presentation = projectPresentation(lane); return <button className={`control-tab${index === selected ? ' active' : ''}`} key={lane.id ?? lane.project ?? index} onClick={() => setSelected(index)} role="tab" aria-label={`${presentation.name}: ${presentation.goal}`}><span>{presentation.name}</span><small style={{ display: 'block', marginTop: 4 }}>{presentation.goal}</small></button>; })}</div>
        {activeLane && <LaneView lane={activeLane} onRefresh={load} />}
      </>}
    </main>
  );
}
