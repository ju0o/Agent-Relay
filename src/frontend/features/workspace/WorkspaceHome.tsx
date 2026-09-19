/**
 * WORKSPACE SHELL V0 — workspace center (selected project/binding).
 * Chat name / role / provider / URL + Open Chat, current goal summary,
 * latest PM activity, workspace status. No embedded WebView in V0.
 */
import React from 'react';
import type { ChatBinding } from '../chat/chat-bindings.js';
import type { WorkspaceViewModel } from '../relay/workspace-adapter.js';
import { deriveWorkspaceStatus, statusLabel } from '../shared/status-labels.js';
import { ChatBindingPanel } from '../chat/ChatBindingPanel.js';

interface Props {
  projectName: string;
  bindings: ChatBinding[];
  activeBindingId: string;
  onSelectBinding: (id: string) => void;
  vm: WorkspaceViewModel | null;
  loading: boolean;
  error: string | null;
}

export function WorkspaceHome(props: Props): React.ReactElement {
  const vm = props.vm;
  const statusKind = deriveWorkspaceStatus({
    executionState: vm?.executionState ?? undefined,
    pmState: vm?.pmState ?? undefined,
    hasCurrentTask: !!vm?.currentTask,
  });

  return (
    <div className="ws-center">
      <header className="ws-project-head">
        <h1>{props.projectName || '프로젝트 선택'}</h1>
        <span className="ws-pill">{statusLabel(statusKind)}</span>
        {vm && !vm.isRealRelayData && <span className="ws-pill ghost">Relay 기록 없음</span>}
        {vm?.isRealRelayData && <span className="ws-pill ghost">REAL RELAY DATA</span>}
      </header>

      <ChatBindingPanel
        projectName={props.projectName}
        bindings={props.bindings}
        activeBindingId={props.activeBindingId}
        onSelectBinding={props.onSelectBinding}
      />

      <section className="ws-card" aria-label="현재 목표">
        <h3>현재 목표</h3>
        {props.loading && <div className="ws-empty">Relay에서 읽는 중…</div>}
        {props.error && <div className="ws-error">읽기 실패: {props.error}</div>}
        {!props.loading && !props.error && !vm?.currentGoal && (
          <div className="ws-empty">활성 목표가 없습니다.</div>
        )}
        {!props.loading && !props.error && vm?.currentGoal && (
          <div>
            <div className="ws-goal-title">{vm.currentGoal.title}</div>
            <p className="ws-goal-stmt">{vm.currentGoal.goalStatement}</p>
            <div className="muted mono ws-goal-id">{vm.currentGoal.goalId}</div>
          </div>
        )}
      </section>

      <section className="ws-card" aria-label="최근 PM 활동">
        <h3>최근 PM 활동</h3>
        {!vm && <div className="ws-empty">불러오는 중…</div>}
        {vm && vm.pmActivity.pendingCount === 0 && !vm.pmActivity.latestSummary && (
          <div className="ws-empty">대기 중인 PM 알림이 없습니다.</div>
        )}
        {vm && (vm.pmActivity.pendingCount > 0 || vm.pmActivity.latestSummary) && (
          <div>
            <div>대기 중 {vm.pmActivity.pendingCount}건</div>
            {vm.pmActivity.latestSummary && <p>{vm.pmActivity.latestSummary}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
