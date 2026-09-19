/**
 * WORKSPACE SHELL V0 — Current Work panel (most visually important).
 * Binds to real Relay backend state. Human labels first, technical
 * fields behind expandable details. No mutation buttons.
 */
import React, { useState } from 'react';
import type { WorkspaceViewModel } from '../relay/workspace-adapter.js';
import { deriveWorkspaceStatus, nextActionLabel, statusLabel } from '../shared/status-labels.js';

export function CurrentWorkPanel(props: { vm: WorkspaceViewModel | null }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const vm = props.vm;

  if (!vm) {
    return (
      <aside className="ws-current" aria-label="현재 작업">
        <h2>지금 하는 일</h2>
        <div className="ws-empty">불러오는 중…</div>
      </aside>
    );
  }

  if (!vm.currentTask) {
    return (
      <aside className="ws-current" aria-label="현재 작업">
        <h2>지금 하는 일</h2>
        <div className="ws-idle">진행 중인 작업이 없습니다.</div>
        <dl className="ws-facts">
          <div>
            <dt>다음</dt>
            <dd>{vm.nextTask ? `${vm.nextTask.taskId} — ${vm.nextTask.title}` : '새 목표 대기'}</dd>
          </div>
          {vm.pmActivity.latestSummary && (
            <div>
              <dt>최근 알림</dt>
              <dd>{vm.pmActivity.latestSummary}</dd>
            </div>
          )}
        </dl>
        {!vm.isRealRelayData && <div className="muted">Relay 기록 없음 (빈 프로젝트)</div>}
      </aside>
    );
  }

  const t = vm.currentTask;
  const statusKind = deriveWorkspaceStatus({
    executionState: vm.executionState ?? undefined,
    pmState: vm.pmState ?? undefined,
    hasCurrentTask: true,
  });
  const next = nextActionLabel({
    executionState: vm.executionState ?? undefined,
    pmState: vm.pmState ?? undefined,
    hasCurrentTask: true,
    hasNextTask: vm.nextTask !== null,
  });
  const prevJudgment =
    vm.taskHistory?.attempts.filter((a) => a.judgmentDecision)?.slice(-1)[0]?.judgmentDecision ??
    null;

  return (
    <aside className="ws-current" aria-label="현재 작업">
      <h2>지금 하는 일</h2>
      <div className="ws-task-id muted">{t.taskId}</div>
      <div className="ws-task-title">{t.title}</div>

      <dl className="ws-facts">
        <div>
          <dt>담당</dt>
          <dd>{vm.worker ? vm.worker.label : '미배정'}</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>
            <span className="ws-status">{statusLabel(statusKind)}</span>
          </dd>
        </div>
        {prevJudgment && (
          <div>
            <dt>이전 판단</dt>
            <dd>{prevJudgment === 'CHANGES' ? '수정 필요' : prevJudgment}</dd>
          </div>
        )}
        <div>
          <dt>다음</dt>
          <dd>{next}</dd>
        </div>
        {vm.currentRun && (
          <div>
            <dt>현재 Run</dt>
            <dd>
              #{vm.currentRun.seq} · {vm.currentRun.agent || 'worker'}
            </dd>
          </div>
        )}
        {vm.latestResultState && (
          <div>
            <dt>최근 결과</dt>
            <dd>{vm.latestResultState}</dd>
          </div>
        )}
      </dl>

      <button className="btn subtle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        {expanded ? '간략히' : '자세히'}
      </button>
      {expanded && (
        <dl className="ws-tech mono">
          <div>
            <dt>goalId</dt>
            <dd>{t.goalId}</dd>
          </div>
          <div>
            <dt>taskId</dt>
            <dd>{t.taskId}</dd>
          </div>
          <div>
            <dt>runId</dt>
            <dd>{vm.currentRun?.runId ?? '(없음)'}</dd>
          </div>
          <div>
            <dt>workerId</dt>
            <dd>{vm.worker?.workerId ?? '(미배정)'}</dd>
          </div>
          <div>
            <dt>executionState</dt>
            <dd>{vm.executionState}</dd>
          </div>
          <div>
            <dt>pmState</dt>
            <dd>{vm.pmState}</dd>
          </div>
          <div>
            <dt>acceptedRunId</dt>
            <dd>{t.acceptedRunId ?? '(없음)'}</dd>
          </div>
        </dl>
      )}
    </aside>
  );
}
