/**
 * Dogfooding panel — 두 스트림을 하나의 컴포넌트로 처리한다.
 *   kind='app'     : Agent Relay 앱 자체 개선 기록   → DATA_ROOT/.agent-relay/dogfooding/
 *   kind='project' : 현재 선택된 프로젝트 사용성 기록 → DATA_ROOT/{project}/_dogfooding/
 * 데이터 위치와 의미는 완전히 분리되며, UI 컴포넌트/로직만 재사용한다.
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
  PROJECT_DF_TYPE_LABELS,
  dfTypeLabel,
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

/** 표시 전용 상태 라벨 — 저장값(OPEN/FIXED/HOLD)은 그대로 둔다. */
const STATUS_LABELS: Record<DfStatus, string> = {
  OPEN: '열림',
  FIXED: '고침',
  HOLD: '보류',
};

const FILTER_LABELS: Record<Filter, string> = {
  ALL: '전체',
  OPEN: '열림',
  FIXED: '고침',
  HOLD: '보류',
};

type Filter = 'ALL' | DfStatus;
const FILTERS: Filter[] = ['ALL', 'OPEN', 'FIXED', 'HOLD'];
type TypeFilter = 'ALL' | DfType;

export function nextDfStatus(s: DfStatus): DfStatus {
  const i = DF_STATUSES.indexOf(s);
  return DF_STATUSES[(i + 1) % DF_STATUSES.length];
}

export interface DogfoodPanelProps {
  kind: 'app' | 'project';
  dataRoot: string;
  /** kind='project'일 때 필수 — 기록 대상 프로젝트. */
  project?: string;
  /** 현재 작업 컨텍스트 (가능한 필드만 채워서 전달). */
  context: DfContext;
  notify: (kind: 'ok' | 'err' | 'info', text: string) => void;
  onClose: () => void;
  /**
   * 값이 바뀔 때마다 목록을 다시 읽는다 — Quick Capture로 저장 직후
   * 열려있는 목록에도 즉시 표시하기 위한 신호.
   */
  refreshSignal?: number;
}

export function DogfoodPanel(props: DogfoodPanelProps): React.ReactElement {
  const isProject = props.kind === 'project';
  const project = isProject ? (props.project ?? '') : '';
  const [items, setItems] = useState<DfItem[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [type, setType] = useState<DfType>(isProject ? 'UX' : 'UX');
  const [priority, setPriority] = useState<DfPriority>('MEDIUM');
  const [content, setContent] = useState('');
  const [desired, setDesired] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const title = isProject
    ? `📋 Project Dogfooding — ${project || '(프로젝트 미선택)'}`
    : '🐾 App Dogfooding';
  const subtitle = isProject
    ? '이 프로젝트를 실제로 사용하면서 발견한 문제·불편·아이디어'
    : 'Agent Relay 프로그램 자체를 개선하기 위한 기록';
  const typeOptions = isProject ? PROJECT_DF_TYPE_LABELS : DF_TYPE_LABELS;

  async function refresh(): Promise<void> {
    try {
      if (!props.dataRoot) return;
      if (isProject && !project) { setItems([]); return; }
      const items: DfItem[] = isProject
        ? await must<DfItem[]>({ op: 'pdf:list', dataRoot: props.dataRoot, project })
        : await must<DfItem[]>({ op: 'df:list', dataRoot: props.dataRoot });
      setItems(items);
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { void refresh(); /* eslint-disable react-hooks/exhaustive-deps */ }, [props.dataRoot, project]);

  // Quick Capture 등 외부에서 저장되었을 때 즉시 반영
  const signal = props.refreshSignal ?? 0;
  useEffect(() => {
    if (signal > 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);

  function contextLine(): string {
    if (isProject) {
      const parts = [`Project: ${project || '(없음)'}`];
      if (props.context.date) parts.push(`Date: ${props.context.date}`);
      if (props.context.agent) parts.push(`Agent: ${props.context.agent}`);
      if (props.context.run) parts.push(`Run: ${props.context.run}`);
      return parts.join(' · ');
    }
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
      if (isProject) {
        await must({
          op: 'pdf:create', dataRoot: props.dataRoot, project,
          type, priority, feedback: content, desired,
          agent: props.context.agent, run: props.context.run,
        });
      } else {
        await must({
          op: 'df:create', dataRoot: props.dataRoot, type, priority,
          feedback: content, desired, context: props.context,
        });
      }
      setContent(''); setDesired(''); setFormOpen(false);
      props.notify('ok', isProject ? `${project} 피드백이 기록되었습니다.` : '피드백이 기록되었습니다.');
      await refresh();
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function cycleStatus(item: DfItem): Promise<void> {
    const next = nextDfStatus(item.status);
    try {
      await must(isProject
        ? { op: 'pdf:setStatus', dataRoot: props.dataRoot, project, id: item.id, status: next }
        : { op: 'df:setStatus', dataRoot: props.dataRoot, id: item.id, status: next });
      await refresh();
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  async function copyItem(item: DfItem): Promise<void> {
    try {
      const raw = await must<string>(isProject
        ? { op: 'pdf:read', dataRoot: props.dataRoot, project, id: item.id }
        : { op: 'df:read', dataRoot: props.dataRoot, id: item.id });
      void navigator.clipboard.writeText(raw);
      props.notify('ok', `${item.id} 복사됨`);
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  function revealItem(item: DfItem): void {
    void must({ op: 'file:reveal', path: item.folder }).catch(() => props.notify('err', '파일을 열 수 없습니다.'));
  }

  const query = search.trim().toLowerCase();
  const shown = items.filter(item => {
    if (filter !== 'ALL' && item.status !== filter) return false;
    if (typeFilter !== 'ALL' && item.type !== typeFilter) return false;
    if (!query) return true;
    return [item.id, item.feedback, item.desired, item.project, item.context.project, item.context.agent, item.context.run]
      .filter(Boolean)
      .some(value => value!.toLowerCase().includes(query));
  });
  const countOf = (s: DfStatus): number => items.filter(i => i.status === s).length;

  return (
    <div className="df-wrap">
      <div className="df-head">
        <div className="df-titlewrap">
          <span className="df-title">{title}</span>
          <span className="muted df-subtitle">{subtitle}</span>
        </div>
        <div className="df-filters">
          {FILTERS.map(f => (
            <button key={f} className={`df-filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{FILTER_LABELS[f]}</button>
          ))}
        </div>
        <input
          className="df-search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="검색"
          aria-label="피드백 검색"
        />
        <select
          className="df-type-filter"
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value as TypeFilter)}
          aria-label="종류 필터"
        >
          <option value="ALL">모든 종류</option>
          {typeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        {isProject && (
          <span className="df-counts" title="상태별 개수">
            <span style={{ color: STATUS_COLORS.OPEN }}>열림 {countOf('OPEN')}</span>
            <span style={{ color: STATUS_COLORS.FIXED }}>고침 {countOf('FIXED')}</span>
            <span style={{ color: STATUS_COLORS.HOLD }}>보류 {countOf('HOLD')}</span>
          </span>
        )}
        <button className="btn primary" onClick={() => setFormOpen(o => !o)}>
          {formOpen ? '취소' : isProject ? '+ Project Feedback' : '+ Feedback'}
        </button>
        <button className="btn subtle" onClick={props.onClose} title="작업 화면으로 돌아가기">닫기</button>
      </div>

      {formOpen && (
        <div className="df-form">
          <div className="df-form-row">
            <label className="field">
              <span className="flabel">종류</span>
              <select value={type} onChange={e => setType(e.target.value as DfType)}>
                {typeOptions.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="flabel">중요도</span>
              <select value={priority} onChange={e => setPriority(e.target.value as DfPriority)}>
                {DF_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <div className="field" style={{ flex: 2 }}>
              <span className="flabel">함께 기록된 정보</span>
              <span className={`fvalue mono${contextLine() ? '' : ' muted'}`}>{contextLine() || '(현재 작업 Context 없음)'}</span>
            </div>
          </div>
          <label className="field">
            <span className="flabel">{isProject ? '발견 내용 *' : '내용 *'}</span>
            <textarea
              rows={4}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={isProject
                ? '예) Diff 설명을 읽었지만 비개발자인 사용자가 이 변경을 신경 써야 하는지 판단하기 어렵다.'
                : '불편한 점을 한 줄이라도 바로 기록하세요.'}
            />
          </label>
          <label className="field">
            <span className="flabel">{isProject ? '기대했던 동작 / 원하는 방향 (선택)' : '원하는 동작 (선택)'}</span>
            <textarea
              rows={2}
              value={desired}
              onChange={e => setDesired(e.target.value)}
              placeholder={isProject
                ? '예) 기술 설명보다 "지금 사용자가 신경 써야 하는 변경인지" 알려주면 좋겠다.'
                : '예) 앱에서 result.md를 바로 ChatGPT 입력창으로 드래그하고 싶다.'}
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
            {items.length === 0
              ? (isProject ? '이 프로젝트에는 아직 피드백이 없습니다.' : '아직 피드백이 없습니다. 불편한 점을 + Feedback으로 남겨보세요.')
              : '해당 상태의 피드백이 없습니다.'}
          </div>
        )}
        {shown.map(item => {
          const expanded = expandedId === item.id;
          return (
            <div key={item.id} className={`df-row${expanded ? ' expanded' : ''}`}>
              <button className="mini df-viewbtn" onClick={() => setExpandedId(expanded ? null : item.id)} title="내용 보기">{expanded ? '▾' : '▸'}</button>
              <span className="mono df-id">{item.id}</span>
              <span className="df-type">{dfTypeLabel(item.type, item.kind)}</span>
              <span className="df-pri" style={{ color: PRIORITY_COLORS[item.priority], borderColor: PRIORITY_COLORS[item.priority] }}>
                {item.priority}
              </span>
              <button
                className="df-status"
                style={{ color: '#fff', background: STATUS_COLORS[item.status] }}
                title="클릭하면 상태가 순환합니다 (열림 → 고침 → 보류)"
                onClick={() => void cycleStatus(item)}
              >{STATUS_LABELS[item.status]}</button>
              {!expanded ? (
                <>
                  <span className="muted df-created">{item.created}</span>
                  <span className="df-ctx mono" title={[item.project ?? item.context.project, item.context.agent && `${item.context.agent}${item.context.run ? ' #' + item.context.run : ''}`].filter(Boolean).join(' · ')}>
                    {[item.project ?? item.context.project, item.context.agent ? `${item.context.agent}${item.context.run ? ' #' + item.context.run : ''}` : ''].filter(Boolean).join(' · ') || '—'}
                  </span>
                  <span className="df-feedback" title={item.feedback}>{item.feedback}</span>
                </>
              ) : (
                <span className="df-detail">
                  <div className="df-detail-block"><b>발견 내용</b><pre>{item.feedback}</pre></div>
                  {item.desired && <div className="df-detail-block"><b>기대했던 동작 / 원하는 방향</b><pre>{item.desired}</pre></div>}
                  <div className="df-detail-block muted">
                    <b>함께 기록된 정보</b>
                    <pre>{[
                      (item.project ?? item.context.project) ? `Project: ${item.project ?? item.context.project}` : '',
                      item.context.date ? `Date: ${item.context.date}` : '',
                      item.context.agent ? `Agent: ${item.context.agent}` : '',
                      item.context.run ? `Run: ${item.context.run}` : '',
                    ].filter(Boolean).join('\n') || '(none)'}</pre>
                  </div>
                </span>
              )}
              <span className="df-actions">
                <button className="mini" onClick={() => void copyItem(item)}>복사</button>
                <button className="mini" onClick={() => revealItem(item)}>파일 열기</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
