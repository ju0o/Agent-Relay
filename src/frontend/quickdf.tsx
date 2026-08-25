/**
 * Quick Dogfooding Capture — "불편하다고 느낀 순간 바로 기록".
 *
 * 큰 관리 화면으로 이동하지 않는 작은 Popover. 한 줄 입력 + 저장(또는 Enter)만으로
 * 현재 프로젝트의 _dogfooding/에 기록된다. 기본값 Type=UX, Priority=MEDIUM,
 * Status=OPEN이 자동 적용되고 Context(Project/Date/Agent/Run)는 자동 첨부된다.
 * [상세 옵션]을 펼치면 Type/Priority/기대한 동작을 수정할 수 있다.
 */
import React, { useEffect, useRef, useState } from 'react';
import { must } from './bridge.js';
import {
  DfContext,
  DfItem,
  DfPriority,
  DfType,
  DF_PRIORITIES,
  PROJECT_DF_TYPE_LABELS,
} from '../shared/types.js';

export interface QuickDogfoodProps {
  project: string;
  dataRoot: string;
  context: DfContext;
  notify: (kind: 'ok' | 'err' | 'info', text: string) => void;
  onClose: () => void;
  /** 저장 성공 직후 호출 — 열려있는 Project Dogfooding 목록 즉시 갱신용. */
  onSaved?: () => void;
}

export function QuickDogfood(props: QuickDogfoodProps): React.ReactElement {
  const [content, setContent] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [type, setType] = useState<DfType>('UX');
  const [priority, setPriority] = useState<DfPriority>('MEDIUM');
  const [desired, setDesired] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function save(): Promise<void> {
    const text = content.trim();
    if (!text) { props.notify('err', '내용을 입력하세요.'); return; }
    setSaving(true);
    try {
      const item: DfItem = await must({
        op: 'pdf:create',
        dataRoot: props.dataRoot,
        project: props.project,
        type,
        priority,
        feedback: text,
        desired: desired.trim(),
        agent: props.context.agent,
        run: props.context.run,
      });
      props.notify('ok', `기록됨 — ${item.id} (${props.project})`);
      props.onSaved?.();
      props.onClose();
    } catch (e) {
      props.notify('err', e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const ctxParts: string[] = [`Project: ${props.project}`];
  if (props.context.date) ctxParts.push(`Date: ${props.context.date}`);
  if (props.context.agent) ctxParts.push(`Agent: ${props.context.agent}`);
  if (props.context.run) ctxParts.push(`Run: #${props.context.run}`);

  return (
    <div className="qdf-overlay" onMouseDown={e => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div
        className="qdf-card"
        role="dialog"
        aria-label="Quick Dogfooding"
        onKeyDown={e => { if (e.key === 'Escape') props.onClose(); }}
      >
        <div className="qdf-head">
          <span className="qdf-title">📝 빠른 피드백</span>
          <button className="mini" title="닫기 (Esc)" onClick={props.onClose}>✕</button>
        </div>
        <textarea
          ref={inputRef}
          rows={2}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); }
          }}
          placeholder="무슨 일이 있었나요? (한 줄이면 충분 — Enter로 저장)"
        />
        <div className="qdf-foot">
          <button className="mini" onClick={() => setDetailOpen(o => !o)}>
            {detailOpen ? '상세 옵션 닫기 ▴' : '상세 옵션 ▾'}
          </button>
          <span className="muted qdf-ctx mono" title="자동 첨부 Context">{ctxParts.join(' · ')}</span>
          <button className="btn primary qdf-save" disabled={saving || !content.trim()} onClick={() => void save()}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>

        {detailOpen && (
          <div className="qdf-detail">
            <div className="df-form-row">
              <label className="field">
                <span className="flabel">Type</span>
                <select value={type} onChange={e => setType(e.target.value as DfType)}>
                  {PROJECT_DF_TYPE_LABELS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="flabel">Priority</span>
                <select value={priority} onChange={e => setPriority(e.target.value as DfPriority)}>
                  {DF_PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <label className="field" style={{ flex: 2 }}>
                <span className="flabel">기대했던 동작 / 원하는 방향 (선택)</span>
                <input
                  type="text"
                  value={desired}
                  onChange={e => setDesired(e.target.value)}
                  placeholder="예) 클릭 한 번으로 기록되면 좋겠다."
                />
              </label>
            </div>
            <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
              Status는 OPEN으로, Project/Date/Agent/Run은 현재 작업 상태로 자동 기록됩니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
