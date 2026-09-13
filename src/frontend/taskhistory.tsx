/**
 * V2 R4 — Electron Task History panel (read-only).
 *
 * Reuses the H1 read model via IPC `history:get` — no second model, no
 * writes. Goal/task pickers reuse the existing `goal:list` / `task:list`
 * ops. Unknown/corrupt input fails closed (error shown, nothing repaired).
 */
import React, { useEffect, useState } from 'react';
import { must } from './bridge.js';
import type { GoalRecord, TaskRecord } from '../shared/types.js';
import type { TaskHistory } from '../backend/task-history.js';

export interface TaskHistoryPanelProps {
  dataRoot: string;
  project: string;
  notify: (kind: 'ok' | 'err' | 'info', text: string) => void;
  onClose: () => void;
}

function lastKey(project: string): string {
  return `agent-relay.lasthistory:${project}`;
}

function pr(hasPrompt: boolean, hasResult: boolean): string {
  return `${hasPrompt ? 'P' : '–'}/${hasResult ? 'R' : '–'}`;
}

export function TaskHistoryPanel(props: TaskHistoryPanelProps): React.ReactElement {
  const { dataRoot, project } = props;
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [goalId, setGoalId] = useState('');
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [taskId, setTaskId] = useState(() => {
    try { return localStorage.getItem(lastKey(project)) ?? ''; } catch { return ''; }
  });
  const [manualId, setManualId] = useState('');
  const [history, setHistory] = useState<TaskHistory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Goals for the picker (read-only).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await must<GoalRecord[]>({ op: 'goal:list', dataRoot, project });
        if (!cancelled) {
          setGoals(list);
          if (!goalId && list.length > 0) setGoalId(list[0]!.goalId);
        }
      } catch (e) {
        if (!cancelled) props.notify('err', e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRoot, project]);

  // Tasks for the picked goal (read-only).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!goalId) { setTasks([]); return; }
      try {
        const list = await must<TaskRecord[]>({ op: 'task:list', dataRoot, project, goalId });
        if (!cancelled) setTasks(list);
      } catch (e) {
        if (!cancelled) props.notify('err', e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataRoot, project, goalId]);

  async function loadHistory(id: string): Promise<void> {
    const tid = id.trim();
    if (!tid) return;
    setLoading(true);
    setError('');
    try {
      const h = await must<TaskHistory>({ op: 'history:get', dataRoot, project, taskId: tid });
      setHistory(h);
      setTaskId(tid);
      try { localStorage.setItem(lastKey(project), tid); } catch { /* ignore */ }
    } catch (e) {
      // Fail closed: show the backend error, keep the previous view untouched.
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      props.notify('err', msg);
    } finally {
      setLoading(false);
    }
  }

  // Restore last-viewed task on open (read-only).
  useEffect(() => {
    if (taskId) void loadHistory(taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const t = history?.task ?? null;
  const qaEvidence = (history?.evidence ?? []).filter(e => e.type === 'QA');

  return (
    <div className="df-wrap">
      <div className="df-head">
        <div className="df-titlewrap">
          <span className="df-title">📜 Task History — {project}</span>
          <span className="muted df-subtitle">읽기 전용 타임라인 (H1 모델 · 상태 변경 없음)</span>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn subtle" onClick={props.onClose} title="작업 화면으로 돌아가기">닫기</button>
      </div>

      <div className="df-form">
        <div className="df-form-row">
          <label className="field">
            <span className="flabel">Goal</span>
            <select value={goalId} onChange={e => setGoalId(e.target.value)}>
              <option value="">(선택)</option>
              {goals.map(g => <option key={g.goalId} value={g.goalId}>{g.goalId} — {g.title}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="flabel">Task</span>
            <select
              value={taskId}
              onChange={e => { const id = e.target.value; setTaskId(id); void loadHistory(id); }}
            >
              <option value="">(선택)</option>
              {tasks.map(x => <option key={x.taskId} value={x.taskId}>{x.taskId} — {x.title}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="flabel">Task ID 직접 입력</span>
            <input
              type="text"
              value={manualId}
              onChange={e => setManualId(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void loadHistory(manualId); }}
              placeholder="예) TASK-0001 (Enter)"
            />
          </label>
          <button
            className="btn"
            disabled={loading || !taskId}
            title="다시 읽기 (읽기 전용 새로고침)"
            onClick={() => void loadHistory(taskId)}
          >{loading ? '읽는 중...' : '새로고침'}</button>
        </div>
      </div>

      {error && (
        <div className="df-list">
          <div className="muted" style={{ padding: 16 }}>
            ⚠️ 기록을 읽지 못했습니다 (fail-closed, 복구 시도 없음): {error}
          </div>
        </div>
      )}

      {!error && !t && (
        <div className="df-list">
          <div className="muted" style={{ padding: 20 }}>
            Goal → Task를 선택하거나 Task ID를 입력하세요.
          </div>
        </div>
      )}

      {!error && t && history && (
        <div className="df-list">
          <div className="df-row expanded">
            <span className="mono df-id">{t.taskId}</span>
            <span className="df-type">{t.executionState}</span>
            <span className="df-type">{t.pmState}</span>
            <span className="df-detail">
              <div className="df-detail-block"><b>{t.title}</b><pre>{`goal: ${t.goalId}`}</pre></div>
              {t.acceptedRunId && <div className="df-detail-block"><b>acceptedRun</b><pre>{t.acceptedRunId}</pre></div>}
            </span>
          </div>

          {history.attempts.length === 0 && (
            <div className="muted" style={{ padding: 12 }}>연결된 Run이 없습니다 (아직 dispatch 전).</div>
          )}
          {history.attempts.map(a => {
            const isWinner = t.acceptedRunId === a.runId;
            return (
              <div key={a.runId} className="df-row">
                <span className="mono df-id">#{a.taskRunSequence}</span>
                <span className="df-type">{a.agent ?? '?'}</span>
                <span className="df-type" title={a.folder}>{pr(a.hasPrompt, a.hasResult)}</span>
                {isWinner && <span className="df-type" title="PM이 채택한 Run">accepted</span>}
                {!a.folderExists && <span className="df-type" title="폴더가 이동/삭제됨">missing-folder</span>}
                <span className="df-detail">
                  <div className="df-detail-block">
                    <b>Run {a.runId.slice(0, 8)}{a.date ? ` · ${a.date}` : ''}</b>
                    <pre>{[
                      `delivery: ${a.delivery ? `${a.delivery.deliveryId} (${a.delivery.status})` : '(없음 — 아직 발행 안 됨)'}`,
                      `judgment: ${a.judgment ? `${a.judgment.decision}:${a.judgment.status}${a.judgment.reason ? ` — ${a.judgment.reason}` : ''}` : '(없음 — 아직 판정 안 됨)'}`,
                      a.tags.length ? `tags: ${a.tags.join(', ')}` : '',
                    ].filter(Boolean).join('\n')}</pre>
                  </div>
                </span>
              </div>
            );
          })}

          {qaEvidence.length > 0 && (
            <div className="df-row">
              <span className="mono df-id">QA</span>
              <span className="df-detail">
                <div className="df-detail-block"><b>QA evidence ({qaEvidence.length})</b><pre>{qaEvidence.map(e => `${e.evidenceId}: ${e.status} — ${e.summary.slice(0, 120)}`).join('\n')}</pre></div>
              </span>
            </div>
          )}

          {(history.events.length > 0 || history.evidence.length > qaEvidence.length) && (
            <div className="df-row">
              <span className="mono df-id">±{history.events.length}/{history.evidence.length}</span>
              <span className="df-detail">
                <div className="df-detail-block"><b>Events / Evidence 요약</b><pre>{[
                  ...history.events.slice(0, 8).map(e => `${e.eventId} ${e.type} (${e.severity})`),
                  ...history.evidence.filter(e => e.type !== 'QA').slice(0, 8).map(e => `${e.evidenceId} ${e.type} ${e.status}`),
                ].join('\n') || '(없음)'}</pre></div>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
