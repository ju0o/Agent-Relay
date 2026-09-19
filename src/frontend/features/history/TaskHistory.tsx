/**
 * WORKSPACE SHELL V0 — Task-focused timeline.
 * Same Task → multiple Runs, never flattened. Reuses the H1 read model
 * (history:get) via WorkspaceViewModel. No second history store.
 */
import React, { useState } from 'react';
import type { WorkspaceTaskHistory } from '../relay/workspace-adapter.js';

function judgmentKo(decision: string | null): string {
  if (decision === 'CHANGES') return 'PM → 수정 필요';
  if (decision === 'ACCEPT') return 'PM → 승인';
  if (decision) return `PM → ${decision}`;
  return '판정 대기';
}

export function TaskHistory(props: { history: WorkspaceTaskHistory | null }): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const h = props.history;

  if (!h) {
    return (
      <section className="ws-history" aria-label="작업 기록">
        <h2>작업 기록</h2>
        <div className="ws-empty">기록이 없습니다.</div>
      </section>
    );
  }

  return (
    <section className="ws-history" aria-label="작업 기록">
      <div className="ws-history-head">
        <h2>
          작업 기록 <span className="muted mono">{h.taskId}</span>
        </h2>
        <button className="btn subtle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? '접기' : '펼치기'}
        </button>
      </div>
      {!expanded && <div className="muted">Run {h.attempts.length}개 · {h.pmState}</div>}
      {expanded && (
        <ol className="ws-runs">
          {h.attempts.length === 0 && <li className="ws-empty">연결된 Run이 없습니다 (아직 dispatch 전).</li>}
          {h.attempts.map((a) => (
            <li key={a.runId} className={`ws-run ${a.isAccepted ? 'accepted' : ''}`}>
              <div className="ws-run-head">
                <strong>Run #{a.seq}</strong>
                <span className="muted">{a.agent || 'worker'}</span>
                {a.hasPrompt && a.hasResult ? (
                  <span className="ws-pill ghost">P/R</span>
                ) : (
                  <span className="ws-pill ghost">기록 확인 중</span>
                )}
                {a.isAccepted && <span className="ws-pill">승인됨</span>}
              </div>
              <div className="ws-run-body">
                <div>{a.hasResult ? 'Worker 완료 · 결과 도착' : 'Worker 진행 중'}</div>
                <div className="ws-judgment">{judgmentKo(a.judgmentDecision)}</div>
                {a.judgmentReason && (
                  <div className="ws-reason">
                    <span className="ws-k">이유</span>
                    <p>{a.judgmentReason}</p>
                  </div>
                )}
                {a.retryInstruction && (
                  <div className="ws-retry">
                    <span className="ws-k">다시 작업 지시</span>
                    <p>{a.retryInstruction}</p>
                  </div>
                )}
                <details className="ws-tech-inline mono">
                  <summary>자세히</summary>
                  <div>runId: {a.runId}</div>
                  <div>delivery: {a.deliveryStatus ?? '(없음)'}</div>
                </details>
              </div>
            </li>
          ))}
        </ol>
      )}
      {h.acceptedRunId ? (
        <div className="ws-next">승인됨 · 다음 작업으로 이동 가능</div>
      ) : h.attempts.some((a) => a.judgmentDecision === 'CHANGES') ? (
        <div className="ws-next">수정 후 같은 Task로 재실행됩니다 (Run 추가, Task 유지)</div>
      ) : null}
    </section>
  );
}
