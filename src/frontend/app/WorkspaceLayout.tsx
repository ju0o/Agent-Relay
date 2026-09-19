/**
 * WORKSPACE SHELL V0 — desktop 3-column layout + history strip.
 * Desktop-first (1280/1600/1920). Sidebar collapses on narrow width;
 * Current Work becomes drawer/tab via CSS. No mobile slice.
 */
import React from 'react';
import type { SidebarProject } from '../features/projects/ProjectSidebar.js';
import { ProjectSidebar } from '../features/projects/ProjectSidebar.js';
import { WorkspaceHome } from '../features/workspace/WorkspaceHome.js';
import { CurrentWorkPanel } from '../features/relay/CurrentWorkPanel.js';
import { TaskHistory } from '../features/history/TaskHistory.js';
import type { ChatBinding } from '../features/chat/chat-bindings.js';
import type { WorkspaceViewModel } from '../features/relay/workspace-adapter.js';

interface Props {
  projects: SidebarProject[];
  activeProject: string;
  bindings: ChatBinding[];
  activeBindingId: string;
  onSelectProject: (name: string) => void;
  onSelectBinding: (projectName: string, bindingId: string) => void;
  onSelectCenterBinding: (id: string) => void;
  vm: WorkspaceViewModel | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  onBack: () => void;
}

export function WorkspaceLayout(props: Props): React.ReactElement {
  return (
    <div className="ws-root">
      <header className="ws-topbar">
        <span className="ws-brand">AGENT RELAY</span>
        <span className="ws-proj-title">{props.activeProject || '—'}</span>
        <span className={`ws-conn ${props.connected ? 'on' : 'off'}`}>
          {props.connected ? 'Connected' : 'Bridge 없음'}
        </span>
        <button className="btn subtle" onClick={props.onBack} title="기존 로그 화면으로">
          로그 화면
        </button>
      </header>
      <div className="ws-main">
        <ProjectSidebar
          projects={props.projects}
          activeProject={props.activeProject}
          activeBindingId={props.activeBindingId}
          onSelectProject={props.onSelectProject}
          onSelectBinding={props.onSelectBinding}
        />
        <main className="ws-main-center">
          <WorkspaceHome
            projectName={props.activeProject}
            bindings={props.bindings}
            activeBindingId={props.activeBindingId}
            onSelectBinding={props.onSelectCenterBinding}
            vm={props.vm}
            loading={props.loading}
            error={props.error}
          />
        </main>
        <CurrentWorkPanel vm={props.vm} />
      </div>
      <footer className="ws-foot">
        <TaskHistory history={props.vm?.taskHistory ?? null} />
      </footer>
    </div>
  );
}
