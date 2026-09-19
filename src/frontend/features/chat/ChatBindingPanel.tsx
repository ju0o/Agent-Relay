/**
 * WORKSPACE SHELL V0 — Chat binding panel (center top).
 * Read-only except "Open Chat" which only navigates to the bound URL.
 * No embedded WebView in V0.
 */
import React from 'react';
import type { ChatBinding } from './chat-bindings.js';
import { isBindingConnected, touchChatBindingOpened } from './chat-bindings.js';

interface Props {
  projectName: string;
  bindings: ChatBinding[];
  activeBindingId: string;
  onSelectBinding: (id: string) => void;
}

export function ChatBindingPanel(props: Props): React.ReactElement {
  const active = props.bindings.find((b) => b.id === props.activeBindingId) ?? props.bindings[0];

  function openChat(): void {
    if (!active) return;
    touchChatBindingOpened(props.projectName, active.id);
    if (active.chatUrl) {
      window.open(active.chatUrl, '_blank', 'noopener,noreferrer');
    }
  }

  if (!active) {
    return (
      <section className="ws-card" aria-label="채팅 연결">
        <h3>Chat Binding</h3>
        <div className="ws-empty">연결된 채팅이 없습니다.</div>
      </section>
    );
  }

  // FOUNDER FIX 01: connection display derives from isBindingConnected —
  // empty chatUrl can never render green, regardless of stored status.
  const connected = isBindingConnected(active);

  return (
    <section className="ws-card" aria-label="채팅 연결">
      <div className="ws-tabs" role="tablist" aria-label="Chat bindings">
        {props.bindings.map((b) => (
          <button
            key={b.id}
            role="tab"
            aria-selected={b.id === active.id}
            className={`ws-tab ${b.id === active.id ? 'active' : ''}`}
            onClick={() => props.onSelectBinding(b.id)}
          >
            {b.name}
          </button>
        ))}
      </div>
      <div className="ws-chat-meta">
        <span className="ws-chat-name">{active.name}</span>
        <span className="ws-pill">{active.role}</span>
        <span className="ws-pill ghost">{active.provider}</span>
        <span className={`ws-dot tone-${connected ? 'active' : 'idle'}`} />
        <span className="muted">{connected ? '채팅 바인딩 연결됨' : '미연결 바인딩'}</span>
        {active.chatUrl ? (
          <span className="ws-link muted">{active.chatUrl}</span>
        ) : (
          <span className="muted">URL 미연결 (UI 전용 데모 바인딩)</span>
        )}
      </div>
      <div className="ws-actions">
        <button className="btn" onClick={openChat} disabled={!active.chatUrl} title="바인딩된 채팅 URL 열기">
          Open Chat
        </button>
        {!active.chatUrl && <span className="muted">URL이 없어 열 수 없음</span>}
      </div>
    </section>
  );
}
