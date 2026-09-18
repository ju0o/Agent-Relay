/**
 * AUTO Goal Loop — minimal execution view (§10).
 * Primary path is AUTO; manual GPT drag remains only as a labelled fallback.
 */
import React, { useState } from 'react';
import { must } from './bridge.js';

interface Props {
  dataRoot: string;
  project: string;
  notify: (kind: 'ok' | 'err' | 'info', text: string) => void;
}

export function GoalLoopPanel(props: Props): React.ReactElement {
  const [goalTitle, setGoalTitle] = useState('');
  const [goalStatement, setGoalStatement] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [status, setStatus] = useState<string>('idle');
  const [busy, setBusy] = useState(false);

  async function start(): Promise<void> {
    if (!goalTitle.trim() || !goalStatement.trim() || !workerId.trim() || !workspaceRoot.trim()) {
      props.notify('err', 'Goal 제목/내용, workerId, workspace를 입력하세요.');
      return;
    }
    setBusy(true);
    setStatus('RUNNING — 자동 디스패치 중 (수동 복사/드래그 없음)');
    try {
      const res = await must<{ status: string; goalId: string; tasksDriven: string[]; lastVerdict?: string; stoppedDetail?: string }>({
        op: 'goal-loop:start',
        dataRoot: props.dataRoot,
        project: props.project,
        goalTitle: goalTitle.trim(),
        goalStatement: goalStatement.trim(),
        workerId: workerId.trim(),
        workspaceRoot: workspaceRoot.trim(),
      });
      setStatus(`${res.status} goal=${res.goalId} tasks=${res.tasksDriven.length} verdict=${res.lastVerdict ?? '-'}${res.stoppedDetail ? ` — ${res.stoppedDetail}` : ''}`);
      props.notify(res.status === 'GOAL_COMPLETE' ? 'ok' : 'info', `AUTO loop ${res.status}`);
    } catch (e) {
      setStatus(`failed: ${e instanceof Error ? e.message : String(e)}`);
      props.notify('err', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="goalloop" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>AUTO Goal Loop <span className="muted" style={{ fontWeight: 400 }}>(권장 — 수동 릴레이 없음)</span></div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        Goal 1개 입력 → Task/Run 자동 디스패치 → Result 자동 수집 → ChatGPT 자동 리뷰 → PASS/CHANGES → 재시도/NEXT → GOAL_COMPLETE.
        수동 복사·붙여넣기·GPT 드래그는 폴백(디버깅/히스토리)으로만 유지됩니다.
      </div>
      <input className="input" placeholder="Goal 제목" value={goalTitle} onChange={e => setGoalTitle(e.target.value)} style={{ width: '100%', marginBottom: 6 }} />
      <textarea className="input" placeholder="Goal 내용 (bounded, 1개 목표만)" value={goalStatement} onChange={e => setGoalStatement(e.target.value)} rows={2} style={{ width: '100%', marginBottom: 6 }} />
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input className="input" placeholder="workerId (⚙ workers:list)" value={workerId} onChange={e => setWorkerId(e.target.value)} style={{ flex: 1 }} />
        <input className="input" placeholder="workspace 절대경로" value={workspaceRoot} onChange={e => setWorkspaceRoot(e.target.value)} style={{ flex: 2 }} />
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button className="btn primary" disabled={busy} onClick={() => void start()}>▶ AUTO 시작</button>
        <span className="muted" style={{ fontSize: 12 }}>{status}</span>
      </div>
    </div>
  );
}
