/**
 * WORKSPACE SHELL V0 — Project sidebar (read-only selection).
 * No project creation flow. Status dot only.
 */
import React from 'react';
import type { WorkspaceProject } from '../relay/workspace-adapter.js';
import type { ChatBinding } from '../chat/chat-bindings.js';
import { isBindingConnected } from '../chat/chat-bindings.js';
import { statusDotTone } from '../shared/status-labels.js';

export interface SidebarProject extends WorkspaceProject {
  bindings: ChatBinding[];
  statusKind: 'RUNNING' | 'READY' | 'ACCEPTED' | 'BLOCKED' | 'IDLE';
}

interface Props {
  projects: SidebarProject[];
  activeProject: string;
  activeBindingId: string;
  onSelectProject: (name: string) => void;
  onSelectBinding: (projectName: string, bindingId: string) => void;
}

export function ProjectSidebar(props: Props): React.ReactElement {
  return (
    <aside className="ws-sidebar" aria-label="프로젝트 목록">
      <div className="ws-side-label">Projects</div>
      {props.projects.length === 0 && (
        <div className="ws-empty">프로젝트가 없습니다.</div>
      )}
      {props.projects.map((p) => {
        const active = p.name === props.activeProject;
        const tone = statusDotTone(
          p.statusKind === 'RUNNING'
            ? 'RUNNING'
            : p.statusKind === 'BLOCKED'
              ? 'BLOCKED'
              : p.statusKind === 'ACCEPTED'
                ? 'ACCEPTED'
                : p.statusKind === 'READY'
                  ? 'READY'
                  : 'IDLE',
        );
        return (
          <div key={p.name} className={`ws-proj ${active ? 'active' : ''}`}>
            <button
              className="ws-proj-head"
              onClick={() => props.onSelectProject(p.name)}
              aria-pressed={active}
            >
              <span className={`ws-dot tone-${tone}`} />
              <span className="ws-proj-name">{p.name}</span>
            </button>
            {active && (
              <div className="ws-bindings">
                {/* FOUNDER FIX 01: green only via isBindingConnected (chatUrl required).
                    Selection highlight stays neutral for unbound bindings. */}
                {p.bindings.map((b) => (
                  <button
                    key={b.id}
                    className={`ws-binding ${b.id === props.activeBindingId ? 'selected' : ''} ${isBindingConnected(b) ? 'bound' : 'unbound'}`}
                    onClick={() => props.onSelectBinding(p.name, b.id)}
                    title={isBindingConnected(b) ? '채팅 바인딩 연결됨' : '미연결 바인딩 (URL 없음)'}
                  >
                    <span className="ws-binding-role">{b.role}</span>
                    <span className="ws-binding-name">{b.name}</span>
                    <span className={`ws-dot sm tone-${isBindingConnected(b) ? 'active' : 'idle'}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="ws-side-foot muted">읽기 전용 · 생성 없음 (V0)</div>
    </aside>
  );
}
