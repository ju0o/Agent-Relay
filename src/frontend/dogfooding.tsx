/**
 * Dogfooding panel — records inconveniences found while using the app itself.
 * Records live under DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md, fully
 * separated from real project runs. Markdown file is the single source of truth.
 */
import React, { useEffect, useState } from 'react';
import { must } from './bridge.js';
import {
  DfContext,
  DfItem,
  DfPriority,
  DfStatus,
  DfType,
  DF_PRIORITIES,
  DF_STATUSES,
  DF_TYPE_LABELS,
} from '../shared/types.js';

const STATUS_COLORS: Record<DfStatus, string> = {
  OPEN: '#FF9F0A',
  FIXED: '#30D158',
  HOLD: '#8E8E93',
};

const PRIORITY_COLORS: Record<DfPriority, string> = {
  LOW: '#8E8E93',
  MEDIUM: '#FF9F0A',
  HIGH: '#FF453A',
};

type Filter = 'ALL' | DfStatus;
const FILTERS: Filter[] = ['ALL', 'OPEN', 'FIXED', 'HOLD'];

export function nextDfStatus(s: DfStatus): DfStatus {
  const i = DF_STATUSES.indexOf(s);
  return DF_STATUSES[(i + 1) % DF_STATUSES.length];
}

export interface DogfoodPanelProps {
  dataRoot: string;
  context: DfContext;
  notify: (kind: 'ok' | 'err' | 'info', text: string) => void;
  onClose: () => void;
}

export function DogfoodPanel(props: DogfoodPanelProps): React.ReactElement {
  const [items, setItems] = useState<DfItem[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [formOpen, setFormOpen] = useState(false);
  const [type, setType] = useState<DfType>('UX');
  const [priority, setPriority] = useState<DfPriority>('MEDIUM');
  const [content, setContent] = useState('');
  const [desired, setDesired] = useState('');

  async function refresh(): Promise<void> {
    try {
      if (!props.dataRoot) return;
      setItems(await must<DfItem[]>({ op: 'df:list', dataRoot: props.dataRoot }));
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable react-hooks/exhaustive-deps */ }, [props.dataRoot]);

  function contextLine(): string {
    const c = props.context;
    const parts: string[] = [];
    if (c.project) parts.push(`Project: ${c.project}`);
    if (c.date) parts.push(`Date: ${c.date}`);
    if (c.agent) parts.push(`Agent: ${c.agent}`);
    if (c.run) parts.push(`Run: ${c.run}`);
    return parts.join(' · ');
  }

  async function submit(): Promise<void> {
    if (!content.trim()) { props.notify('err', '내용을 입력하세요.'); return; }
    try {
      await must({
        op: 'df:create', dataRoot: props.dataRoot, type, priority,
        feedback: content, desired, context: props.context,
      });
      setContent(''); setDesired(''); setFormOpen(false);
      props.notify('ok', '피드백이 기록되었습니다.');
      await refresh();
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function cycleStatus(item: DfItem): Promise<void> {
    const next = nextDfStatus(item.status);
    try {
      await must({ op: 'df:setStatus', dataRoot: props.dataRoot, id: item.id, status: next });
      await refresh();
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function copyItem(item: DfItem): Promise<void> {
    try {
      const raw = await must<string>({ op: 'df:read', dataRoot: props.dataRoot, id: item.id });
      void navigator.clipboard.writeText(raw);
      props.notify('ok', `${item.id} 복사됨`);
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  function revealItem(item: DfItem): void {
    void must({ op: 'file:reveal', path: item.folder }).catch(() => props.notify('err', '파일을 열 수 없습니다.'));
  }

  const shown = filter === 'ALL' ? items : items.filter(i => i.status === filter);

  return (
    <div className="df-wrap">
      <div className="df-head">
        <span className="df-title">🐾 Dogfooding</span>
        <div className="df-filters">
          {FILTERS.map(f => (
            <button key={f} className={`df-filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => setFormOpen(o => !o)}>
          {formOpen ? '취소' : '+ Feedback'}
        </button>
        <button className="btn subtle" onClick={props.onClose} title="작업 화면으로 돌아가기">닫기</button>
      </div>

      {formOpen && (
        <div className="df-form">
          <div className="df-form-row">
            <label className="field">
              <span className="flabel">Type</span>
              <select value={type} onChange={e => setType(e.target.value as DfType)}>
                {DF_TYPE_LABELS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="flabel">Priority</span>
              <select value={priority} onChange={e => setPriority(e.target.value as DfPriority)}>
                {DF_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <div className="field" style={{ flex: 2 }}>
              <span className="flabel">자동 첨부 Context</span>
              <span className={`fvalue mono${contextLine() ? '' : ' muted'}`}>{contextLine() || '(현재 작업 Context 없음)'}</span>
            </div>
          </div>
          <label className="field">
            <span className="flabel">내용 *</span>
            <textarea
              rows={4}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={'불편한 점을 한 줄이라도 바로 기록하세요.\n예) Result를 저장한 뒤 ChatGPT에 전달하려면 Explorer를 직접 찾아야 해서 번거롭다.'}
            />
          </label>
          <label className="field">
            <span className="flabel">원하는 동작 (선택)</span>
            <textarea
              rows={2}
              value={desired}
              onChange={e => setDesired(e.target.value)}
              placeholder="예) 앱에서 result.md를 바로 ChatGPT 입력창으로 드래그하고 싶다."
            />
          </label>
          <div className="df-form-actions">
            <button className="btn primary" onClick={() => void submit()}>기록</button>
          </div>
        </div>
      )}

      <div className="df-list">
        {shown.length === 0 && (
          <div className="muted" style={{ padding: 20 }}>
            {items.length === 0 ? '아직 피드백이 없습니다. 불편한 점을 + Feedback으로 남겨보세요.' : '해당 상태의 피드백이 없습니다.'}
          </div>
        )}
        {shown.map(item => (
          <div key={item.id} className="df-row">
            <span className="mono df-id">{item.id}</span>
            <span className="df-type">{item.type}</span>
            <span className="df-pri" style={{ color: PRIORITY_COLORS[item.priority], borderColor: PRIORITY_COLORS[item.priority] }}>
              {item.priority}
            </span>
            <button
              className="df-status"
              style={{ color: '#fff', background: STATUS_COLORS[item.status] }}
              title="클릭하면 상태가 순환합니다 (OPEN → FIXED → HOLD)"
              onClick={() => void cycleStatus(item)}
            >{item.status}</button>
            <span className="muted df-created">{item.created}</span>
            <span className="df-ctx mono" title={[item.context.project, item.context.agent &&`${item.context.agent} #${item.context.run}`].filter(Boolean).join(' · ')}>
              {[item.context.project, item.context.agent ? `${item.context.agent}${item.context.run ? ' #' + item.context.run : ''}` : ''].filter(Boolean).join(' · ') || '—'}
            </span>
            <span className="df-feedback" title={item.desired ? `원하는 동작: ${item.desired}` : item.feedback}>
              {item.feedback}
            </span>
            <span className="df-actions">
              <button className="mini" onClick={() => void copyItem(item)}>복사</button>
              <button className="mini" onClick={() => revealItem(item)}>파일 열기</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
