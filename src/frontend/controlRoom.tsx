import React, { useEffect, useState } from 'react';
import { must } from './bridge.js';

export interface ControlRoomLane {
  id?: string;
  project?: string;
  current?: { stage?: string; taskId?: string; [key: string]: unknown };
  worker?: Record<string, unknown>;
  qa?: Record<string, unknown>;
  holds?: unknown[];
  humanGate?: Record<string, unknown>;
  founderGate?: Record<string, unknown>;
  blocker?: string;
  [key: string]: unknown;
}

interface ControlRoomBoard { lanes?: ControlRoomLane[] }
type FlowState = 'done' | 'active' | 'blocked';

const FLOW = ['PM', '검증', 'WORKER', 'QA', 'GATE', 'HUMAN', '통합'];

function label(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function stageIndex(stage: string): number {
  const value = stage.toUpperCase();
  if (value.includes('INTEGR') || value.includes('통합') || value === 'DONE' || value === 'COMPLETE') return 6;
  if (value.includes('HUMAN') || value.includes('FOUNDER')) return 5;
  if (value.includes('GATE')) return 4;
  if (value.includes('QA')) return 3;
  if (value.includes('WORKER') || value.includes('BUILDER')) return 2;
  if (value.includes('VERIF') || value.includes('VALID') || value.includes('검증')) return 1;
  return 0;
}

function flowState(stage: string, index: number): FlowState {
  const value = stage.toUpperCase();
  if (value.includes('BLOCK') || value.includes('HOLD')) return index < stageIndex(stage) ? 'done' : index === stageIndex(stage) ? 'blocked' : 'blocked';
  if (value === 'DONE' || value === 'COMPLETE' || value === 'V1_COMPLETE' || value === 'INTEGRATED') return 'done';
  const current = stageIndex(stage);
  return index < current ? 'done' : index === current ? 'active' : 'blocked';
}

function detail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '—';
}

function LaneView({ lane }: { lane: ControlRoomLane }): React.ReactElement {
  const current = lane.current ?? {};
  const stage = label(current.stage, 'PM');
  const holds = Array.isArray(lane.holds) ? lane.holds : [];
  const gate = lane.humanGate ?? lane.founderGate;
  return (
    <section className="control-lane-view">
      <div className="control-flow" aria-label="lane lifecycle">
        {FLOW.map((name, index) => {
          const state = flowState(stage, index);
          return <div className={`control-step ${state}`} key={name}><span className="control-step-dot">{state === 'done' ? '✓' : state === 'blocked' ? '!' : '●'}</span><span>{name}</span></div>;
        })}
      </div>
      <div className="control-cards">
        <article className="control-card">
          <h3>현재 작업</h3>
          <p className="control-card-value">{label(current.taskId, label(lane.id ?? lane.project))}</p>
          <p className="muted">단계: {stage}</p>
        </article>
        <article className="control-card">
          <h3>WORKER → QA</h3>
          <p>Worker: <strong>{detail(lane.worker?.state ?? lane.worker?.status)}</strong></p>
          <p>QA: <strong>{detail(lane.qa?.verdict ?? lane.qa?.state ?? lane.qa?.status)}</strong></p>
        </article>
        {(lane.blocker || holds.length > 0) && <article className="control-card blocked"><h3>Hold / Blocked</h3><p>{lane.blocker ?? holds.map(detail).join(', ')}</p></article>}
        {gate && <article className="control-card human"><h3>Human Gate</h3><p>{detail(gate.title ?? gate.gateId ?? gate.status ?? '확인 필요')}</p><p className="muted">사람 확인이 필요한 단계입니다.</p></article>}
      </div>
    </section>
  );
}

export function ControlRoom({ onClose }: { onClose: () => void }): React.ReactElement {
  const [board, setBoard] = useState<ControlRoomBoard>({ lanes: [] });
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void must<ControlRoomBoard>({ op: 'controlRoom:board' }).then(next => {
        if (!alive) return;
        setBoard({ lanes: Array.isArray(next?.lanes) ? next.lanes : [] });
        setError('');
      }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const lanes = board.lanes ?? [];
  const activeLane = lanes[Math.min(selected, Math.max(0, lanes.length - 1))];
  return (
    <main className="control-room">
      <div className="control-room-head"><div><h1>Control Room</h1><p className="muted">5초마다 board를 읽습니다 · 읽기 전용</p></div><button className="btn" onClick={onClose}>닫기</button></div>
      {error && <div className="flash err">{error}</div>}
      {!lanes.length ? <div className="control-empty">표시할 lane이 없습니다.</div> : <>
        <div className="control-tabs" role="tablist">{lanes.map((lane, index) => <button className={`control-tab${index === selected ? ' active' : ''}`} key={lane.id ?? lane.project ?? index} onClick={() => setSelected(index)} role="tab">{label(lane.project ?? lane.id, `Lane ${index + 1}`)}</button>)}</div>
        {activeLane && <LaneView lane={activeLane} />}
      </>}
    </main>
  );
}
