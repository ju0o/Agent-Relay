import React, { useCallback, useEffect, useState } from 'react';
import { must } from './bridge.js';
import { ApprovalsData, groupApprovalRules } from '../shared/types.js';

function normalizeApprovals(raw: unknown): ApprovalsData {
  if (Array.isArray(raw)) {
    return { categories: {}, neverAuto: [], rules: [] };
  }
  const data = (raw ?? {}) as Partial<ApprovalsData>;
  return {
    kind: data.kind,
    ok: data.ok,
    categories: data.categories ?? {},
    neverAuto: data.neverAuto ?? [],
    rules: Array.isArray(data.rules) ? data.rules : [],
  };
}

export function Approvals({ onClose }: { onClose: () => void }): React.ReactElement {
  const [data, setData] = useState<ApprovalsData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    setError('');
    void must<unknown>({ op: 'controlRoom:approvals' }).then(raw => {
      setData(normalizeApprovals(raw));
    }).catch(e => { setError(e instanceof Error ? e.message : String(e)); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function saveEdit(id: string): Promise<void> {
    const summary = draft.trim();
    if (!summary) { setError('새 요약이 비어 있습니다.'); return; }
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await must({ op: 'controlRoom:approvalEdit', id, summary });
      setNotice(`${id} 수정됨`);
      setEditingId(null);
      setDraft('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(id: string): Promise<void> {
    if (!window.confirm(`${id} 규칙을 삭제할까요?`)) return;
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      await must({ op: 'controlRoom:approvalRemove', id });
      setNotice(`${id} 삭제됨`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const groups = data ? groupApprovalRules(data) : [];
  const total = data?.rules.length ?? 0;

  return (
    <main className="control-room">
      <div className="control-room-head">
        <div>
          <h1>Founder 승인 내역</h1>
          <p className="muted">controlRoom:approvals · 카테고리별 그룹 · {total}개 규칙</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn subtle" onClick={refresh}>새로고침</button>
          <button className="btn" onClick={onClose}>닫기</button>
        </div>
      </div>
      {error && <div className="flash err">{error}</div>}
      {notice && <div className="flash ok">{notice}</div>}
      {data === null && !error ? <div className="control-empty">불러오는 중...</div>
        : groups.length === 0 ? <div className="control-empty">표시할 승인 내역이 없습니다.</div>
        : groups.map(group => (
          <section className="control-lane-view" key={group.category}>
            <h2>{group.label} <span className="muted mono">{group.category}</span>{' '}
              {group.alwaysAsk && <span className="hist-tag" title="neverAuto 범주 — 자동 승인 없이 항상 질문">항상 질문 · always-ask</span>}
              <span className="tree-badge"> {group.rules.length}개</span>
            </h2>
            {group.rules.length === 0
              ? <p className="muted">{group.alwaysAsk ? '등록된 규칙 없음 — 항상 Founder에게 묻습니다.' : '등록된 규칙 없음'}</p>
              : <div className="control-cards">{group.rules.map(rule => (
                <article className="control-card" key={rule.id}>
                  <h3 className="mono">{rule.id}</h3>
                  <p className="control-card-value">{rule.summary}</p>
                  <p className="muted">scope: {rule.scope}{rule.approvedAt ? ` · ${rule.approvedAt}` : ''}</p>
                  {editingId === rule.id ? (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <input
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        placeholder="새 요약"
                        style={{ flex: 1 }}
                      />
                      <button className="btn primary" disabled={busyId === rule.id} onClick={() => void saveEdit(rule.id)}>저장</button>
                      <button className="btn subtle" onClick={() => { setEditingId(null); setDraft(''); }}>취소</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button
                        className="mini"
                        disabled={busyId === rule.id}
                        onClick={() => { setEditingId(rule.id); setDraft(rule.summary); }}
                      >수정</button>
                      <button
                        className="mini"
                        disabled={busyId === rule.id}
                        onClick={() => void removeRule(rule.id)}
                      >삭제</button>
                    </div>
                  )}
                </article>
              ))}</div>}
          </section>
        ))}
    </main>
  );
}
