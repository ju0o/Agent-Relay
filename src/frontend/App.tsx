/**
 * Agent Relay — 메인 UI
 *
 * 프로젝트 세션 탭 + 에디터 탭 기반 병렬 편집 + 파일 트리 + 한국어 UI
 */
import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { must, hasBridge, dragLocalFile, onUpdateStatus } from './bridge.js';
import { FieldText } from './components.js';
import { DogfoodPanel } from './dogfooding.js';
import { QuickDogfood } from './quickdf.js';
import { ControlRoom } from './controlRoom.js';
import { approvalCategoryLabel, approvalStatsLine, dedupeApprovalRules, groupRulesByCategory } from './approvals.js';
import type { ApprovalRuleJson } from '../shared/types.js';
import { PlanStudio } from './planStudio.js';
import { renderMd } from './md.js';
import {
  DEFAULT_AGENTS,
  DfContext,
  HistoryItem,
  ProjectInfo,
  ProjectViewData,
  ROOT_PROJECT,
  RunFolderResult,
  SettingsView,
  StartView,
  StartViewResult,
  TAG_PRESETS,
  UpdateStatus,
  applyOrderByKeys,
  reorderArray,
} from '../shared/types.js';

// ── 트리 타입 ─────────────────────────────────────────────────────────────────
interface TreeRun  { run: string; folder: string; hasPrompt: boolean; hasResult: boolean; tags: string[]; }
interface TreeAgent { name: string; runs: TreeRun[]; }
interface TreeDate  { date: string; agents: TreeAgent[]; totalRuns: number; }

function buildTree(items: HistoryItem[]): TreeDate[] {
  const byDate = new Map<string, Map<string, TreeRun[]>>();
  for (const h of items) {
    if (!byDate.has(h.date)) byDate.set(h.date, new Map());
    const byAgent = byDate.get(h.date)!;
    if (!byAgent.has(h.agent)) byAgent.set(h.agent, []);
    byAgent.get(h.agent)!.push({ run: h.run, folder: h.folder, hasPrompt: h.hasPrompt, hasResult: h.hasResult, tags: h.tags });
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, byAgent]) => {
      const agents: TreeAgent[] = [...byAgent.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, runs]) => ({ name, runs: runs.sort((a, b) => parseInt(b.run, 10) - parseInt(a.run, 10)) }));
      return { date, agents, totalRuns: agents.reduce((s, a) => s + a.runs.length, 0) };
    });
}

function RunDot({ hasPrompt, hasResult }: { hasPrompt: boolean; hasResult: boolean }): React.ReactElement {
  const cls = hasPrompt && hasResult ? 'full' : hasPrompt || hasResult ? 'half' : 'empty';
  const title = hasPrompt && hasResult ? 'prompt + result 있음' : hasPrompt ? 'prompt만 있음' : hasResult ? 'result만 있음' : '없음';
  return <span className={`run-dot ${cls}`} title={title} />;
}

// ── 에디터 탭 타입 ───────────────────────────────────────────────────────────
interface EditorTab {
  id: string;
  agent: string;
  run: string;
  folder: string;
  prompt: string;
  result: string;
  tags: string[];
  promptPreview: boolean;
  resultPreview: boolean;
  promptDrag: boolean;
  resultDrag: boolean;
  /** prompt.md / result.md가 실제로 디스크에 저장된 상태인지 */
  promptSaved: boolean;
  resultSaved: boolean;
}

let _tabCounter = 0;
function makeTab(agent = 'Claude Code'): EditorTab {
  return {
    id: `tab-${++_tabCounter}`,
    agent,
    run: '', folder: '', prompt: '', result: '', tags: [],
    promptPreview: false, resultPreview: false, promptDrag: false, resultDrag: false,
    promptSaved: false, resultSaved: false,
  };
}

// ── 프로젝트 세션 타입 ────────────────────────────────────────────────────────
interface ProjectSession {
  id: string;
  project: string;         // '' = 아직 프로젝트 선택 안 됨
  history: HistoryItem[];
  tabs: EditorTab[];
  activeTabId: string;
  expandedKeys: Set<string>;
  treeSearch: string;
}

let _sessionCounter = 0;
function makeSession(project = ''): ProjectSession {
  const tab = makeTab();
  return {
    id: `sess-${++_sessionCounter}`,
    project,
    history: [],
    tabs: [tab],
    activeTabId: tab.id,
    expandedKeys: new Set(),
    treeSearch: '',
  };
}

function hasUnsavedContent(tab: EditorTab): boolean {
  return (tab.prompt.length > 0 && !tab.promptSaved) || (tab.result.length > 0 && !tab.resultSaved);
}

function hasUnsavedTabs(session: ProjectSession): boolean {
  return session.tabs.some(hasUnsavedContent);
}

// 초기 세션 — 모듈 로드 시 단 한 번 생성
const LAST_AGENT_STORAGE_KEY = 'agent-relay:last-agent';
function lastSelectedAgent(): string | undefined {
  try { return localStorage.getItem(LAST_AGENT_STORAGE_KEY) || undefined; }
  catch { return undefined; }
}
const _initSess = makeSession();
if (lastSelectedAgent()) _initSess.tabs[0]!.agent = lastSelectedAgent()!;

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function copyText(text: string): void { void navigator.clipboard.writeText(text); }

// ── 모달 타입 ─────────────────────────────────────────────────────────────────
interface ModalState   { title: string; placeholder: string; onOk: (v: string) => void; }
interface ConfirmState { text: string; confirmBtn?: string; onOk: () => void | Promise<void>; }

// ── ErrorBoundary ─────────────────────────────────────────────────────────────
class ErrorBoundary extends Component<{ children: React.ReactNode }, { err: string | null }> {
  constructor(props: { children: React.ReactNode }) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(e: unknown): { err: string } { return { err: e instanceof Error ? e.message : String(e) }; }
  render(): React.ReactNode {
    if (this.state.err) return (
      <div style={{ padding: 40, color: 'var(--danger)', fontFamily: 'monospace', background: 'var(--bg)', minHeight: '100vh' }}>
        <strong style={{ color: 'var(--fg)' }}>렌더 오류</strong>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12, color: 'var(--danger)' }}>{this.state.err}</pre>
        <p style={{ color: 'var(--muted)', fontSize: 12 }}>DevTools → Console에서 자세한 내용을 확인하세요.</p>
      </div>
    );
    return this.props.children;
  }
}

// ── 시작 화면 패널 (Automated Tester `--view=` 지원용, App.tsx 내장) ──────────
// 승인 규칙: 기존 controlRoom:approvals 읽기 전용 조회 결과를 그대로 보여준다.
function ApprovalsPanel({ onClose }: { onClose: () => void }): React.ReactElement {
  const [items, setItems] = useState<unknown>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void must<unknown>({ op: 'controlRoom:approvals' }).then(next => {
      if (alive) setItems(next);
    }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);
  const list = Array.isArray(items) ? items : items == null ? [] : [items];
  // Approval rules carry optional usedCount/lastUsedAt — normalize to rule
  // objects, group by category and sort each group by usedCount (desc).
  const ruleEntries = list.filter(
    (item): item is ApprovalRuleJson => !!item && typeof item === 'object' && !Array.isArray(item),
  );
  const otherEntries = list.filter(
    item => typeof item === 'string' || Array.isArray(item) || (item !== null && typeof item !== 'object'),
  );
  // Also unwrap { rules | items | list } envelope shapes into rule entries.
  const unwrapped: ApprovalRuleJson[] = [];
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      for (const key of ['rules', 'items', 'list']) {
        const nested = record[key];
        if (Array.isArray(nested)) {
          for (const entry of nested) {
            if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
              unwrapped.push(entry as ApprovalRuleJson);
            }
          }
        }
      }
    }
  }
  const hasNestedRules = (rule: ApprovalRuleJson): boolean => {
    const record = rule as Record<string, unknown>;
    return ['rules', 'items', 'list'].some(key => {
      const nested = record[key];
      return Array.isArray(nested) && nested.some(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
    });
  };
  const directRules = ruleEntries.filter(rule => !hasNestedRules(rule));
  // Envelope { rules: [A, B] } listed alongside the same A/B as top-level
  // entries must not render twice — dedupe by identity + content first.
  const groups = groupRulesByCategory(dedupeApprovalRules([...directRules, ...unwrapped]));
  const ruleLabel = (rule: ApprovalRuleJson): string => {
    const record = rule as Record<string, unknown>;
    const raw = rule.summary ?? record.title ?? record.ask ?? record.name;
    return typeof raw === 'string' && raw.trim() ? raw : JSON.stringify(rule);
  };
  return (
    <main className="control-room">
      <div className="control-room-head"><div><h1>승인 규칙</h1><p className="muted">Agent Relay가 묻지 않고 알아서 처리하도록 허락한 규칙입니다.</p></div><button className="btn" onClick={onClose}>닫기</button></div>
      {error && <div className="flash err">{error}</div>}
      {items === null && !error ? <div className="control-empty">불러오는 중...</div>
        : list.length === 0 ? <div className="control-empty">표시할 승인 내역이 없습니다.</div>
        : <>
          {groups.map(group => (
            <section className="approval-group" key={group.category} aria-label={`승인 규칙 ${approvalCategoryLabel(group.category)}`}>
              <h3 className="approval-category">{approvalCategoryLabel(group.category)}</h3>
              <div className="control-cards">{group.rules.map((rule, i) => (
                <article className="control-card" key={i}>
                  <p className="control-card-value" style={{ whiteSpace: 'pre-wrap' }}>{ruleLabel(rule)}</p>
                  <p className="muted approval-stats">{approvalStatsLine(rule)}</p>
                </article>
              ))}</div>
            </section>
          ))}
          {otherEntries.length > 0 && <div className="control-cards">{otherEntries.map((item, i) => (
            <article className="control-card" key={`other-${i}`}><p className="control-card-value" style={{ whiteSpace: 'pre-wrap' }}>{typeof item === 'string' ? item : JSON.stringify(item, null, 2)}</p></article>
          ))}</div>}
        </>}
    </main>
  );
}

// Plan Studio는 전용 뷰(src/frontend/planStudio.tsx)로 제공한다.

// ── Pointer Reorder fallback (touch) — 순수 헬퍼 (test/v03 검증용 export) ──────
// HTML5 DnD는 마우스 전용이라 터치에서는 동작하지 않는다.
// Pointer Events 최소 fallback으로 터치/펜 재정렬을 지원하고,
// 데스크톱 mouse DnD(draggable + onDragStart/onDrop)는 그대로 유지한다.
/** 터치/펜 포인터면 pointer fallback을 시작한다 (mouse는 HTML5 DnD 사용). */
export function shouldStartPointerReorder(pointerType: string): boolean {
  return pointerType !== 'mouse';
}
/** pointer fallback drop 위치를 검증한다. 실제 이동이면 over 인덱스, 아니면 null. */
export function resolvePointerDropIndex(from: number | null, over: number | null, len: number): number | null {
  if (from === null || over === null || from === over) return null;
  if (from < 0 || from >= len || over < 0 || over >= len) return null;
  return over;
}
/**
 * pointer 좌표(clientX/clientY)에서 elementFromPoint로 드롭 대상 인덱스를 찾는다.
 * source에 pointer capture를 걸면 move/up이 source에만 retarget되어
 * sibling 핸들러가 절대 발사되지 않으므로, capture 없이 좌표 기반으로 추적한다.
 * DOM이 없거나(테스트) 해당 그룹이 아니면 null을 반환하고 호출부는 closure 인덱스로 폴백한다.
 */
export function pointerOverIndexFromPoint(
  clientX: number,
  clientY: number,
  group: string,
  len: number,
): number | null {
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (!doc || typeof doc.elementFromPoint !== 'function') return null;
    const el = doc.elementFromPoint(clientX, clientY) as Element | null;
    const t = el?.closest?.(`[data-reorder-group="${group}"]`) ?? null;
    if (!t) return null;
    const raw = t.getAttribute('data-reorder-index');
    const idx = raw === null ? NaN : Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= len) return null;
    return idx;
  } catch { return null; }
}

// ── 최상위 App ────────────────────────────────────────────────────────────────
export function App(): React.ReactElement {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
function AppInner(): React.ReactElement {
  // 테마 (light / dark) — 저장된 선호가 없으면 다크가 기본
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('theme') === 'light' ? 'light' : 'dark'
  );
  function toggleTheme(): void {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
  }

  // 글로벌 상태
  const [loading, setLoading]     = useState(true);
  const [initError, setInitError] = useState('');
  const [settings, setSettings]   = useState<SettingsView | null>(null);
  const [projects, setProjects]   = useState<ProjectInfo[]>([]);
  const [agents, setAgents]       = useState<string[]>([...DEFAULT_AGENTS]);
  const [date, setDate]           = useState(todayLocal());
  const [msg, setMsg]             = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [modal, setModal]         = useState<ModalState | null>(null);
  const [confirm, setConfirm]     = useState<ConfirmState | null>(null);
  const [inputVal, setInputVal]   = useState('');

  // 설정 모달 / Dogfooding 모드 / 저장공간 유실 상태
  const [showSettings, setShowSettings] = useState(false);
  const [dfMode, setDfMode]             = useState(false);
  const [pdMode, setPdMode]             = useState(false);
  const [controlRoomMode, setControlRoomMode] = useState(false);
  const [approvalsMode, setApprovalsMode] = useState(false);
  const [planStudioMode, setPlanStudioMode] = useState(false);
  const [missingRoot, setMissingRoot]   = useState(false);
  // Quick Dogfooding Capture (작은 Popover)
  const [showQuickDf, setShowQuickDf]   = useState(false);
  // 개발 도구 메뉴 (닫힘 기본 — Founder 항목 우선)
  const [showDevTools, setShowDevTools] = useState(false);
  // 저장 후 열려있는 Project Dogfooding 목록을 즉시 새로고침하기 위한 신호
  const [pdRefreshSignal, setPdRefreshSignal] = useState(0);

  // In-app updater 상태 (main이 relay-update-status로 푸시)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);

  // 프로젝트 세션 상태 (멀티 프로젝트 탭)
  const [sessions, setSessions]           = useState<ProjectSession[]>([_initSess]);
  const [activeSessionId, setActiveSessionId] = useState<string>(_initSess.id);

  // 드래그 앤 드롭 (글로벌)
  const [dragRun, setDragRun]     = useState<HistoryItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // ── 활성 세션 파생값 ──────────────────────────────────────────────────────────
  const activeSession = sessions.find(s => s.id === activeSessionId) ?? sessions[0]!;
  const project       = activeSession.project;
  const history       = activeSession.history;
  const tabs          = activeSession.tabs;
  const activeTabId   = activeSession.activeTabId;
  const treeSearch    = activeSession.treeSearch;
  const expandedKeys  = activeSession.expandedKeys;
  const dataRoot      = settings?.dataRoot ?? '';
  const activeTab     = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  /** 프로젝트 이름 표시용 — '.' → 현재 폴더 이름 */
  function projectLabel(name: string): string {
    if (name === ROOT_PROJECT) {
      const parts = dataRoot.replace(/\\/g, '/').split('/');
      return `📂 현재 폴더 (${parts[parts.length - 1] ?? dataRoot})`;
    }
    return name;
  }

  // 필터된 히스토리 → 트리
  const filteredHistory = useMemo(() => {
    const q = treeSearch.toLowerCase().trim();
    if (!q) return history;
    return history.filter(h =>
      h.agent.toLowerCase().includes(q) ||
      h.date.includes(q) ||
      h.run.includes(q) ||
      h.tags.some(t => t.toLowerCase().includes(q))
    );
  }, [history, treeSearch]);

  const tree = useMemo(() => buildTree(filteredHistory), [filteredHistory]);

  // 사이드바 프로젝트 목록 — 저장된 projectOrder 순서를 반영해 표시 (UI 전용)
  const sortedProjects = useMemo(
    () => applyOrderByKeys(projects, p => p.name, settings?.projectOrder ?? []),
    [projects, settings?.projectOrder],
  );

  // 가장 최근 날짜 자동 펼침 (세션 전환 또는 새 날짜 추가 시)
  useEffect(() => {
    if (tree.length > 0) {
      const newest = tree[0]!;
      const dateKey = `d:${newest.date}`;
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        if (s.expandedKeys.has(dateKey)) return s;
        const next = new Set(s.expandedKeys);
        next.add(dateKey);
        newest.agents.forEach(a => next.add(`a:${newest.date}:${a.name}`));
        return { ...s, expandedKeys: next };
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, tree.length > 0 ? tree[0]?.date ?? '' : '']);

  // ── 세션 헬퍼 ────────────────────────────────────────────────────────────────
  function updateSession(id: string, patch: Partial<Omit<ProjectSession, 'id'>>): void {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  }
  function updateActiveSession(patch: Partial<Omit<ProjectSession, 'id'>>): void {
    updateSession(activeSessionId, patch);
  }

  // ── 탭 헬퍼 ─────────────────────────────────────────────────────────────────
  function updateTab(tabId: string, patch: Partial<EditorTab>): void {
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, tabs: s.tabs.map(t => t.id === tabId ? { ...t, ...patch } : t) }
        : s
    ));
  }

  // ── Drag Reorder (v0.3) ─────────────────────────────────────────────────────
  // HTML5 drag events만 사용 — 외부 DnD 라이브러리 없음.
  // 런 이동 DnD(파일 트리)와 별개 영역이라 충돌하지 않는다.
  const projDragFrom = useRef<number | null>(null);
  const [projDragOver, setProjDragOver] = useState<number | null>(null);
  const tabDragFrom  = useRef<number | null>(null);
  const [tabDragOver, setTabDragOver]   = useState<number | null>(null);
  const agentDragFrom = useRef<number | null>(null);
  const [agentDragOver, setAgentDragOver] = useState<number | null>(null);
  // Pointer fallback (touch/pen) 활성 상태 — mouse DnD와 공유하는 from ref를 재사용한다.
  const pointerProjActive = useRef(false);
  const pointerTabActive = useRef(false);
  const pointerAgentActive = useRef(false);
  // pointer 재정렬 직후 뒤따르는 click(탭 전환/에이전트 변경) 1회를 삼킨다.
  const pointerSuppressClick = useRef(false);

  /** 세션 탭 순서를 settings.projectOrder에 저장한다 (UI 순서 전용 — 폴더 불변). */
  function persistProjectOrder(sess: ProjectSession[]): void {
    const names = [...new Set(sess.map(s => s.project).filter((p): p is string => !!p))];
    if (!names.length) return;
    must<string[]>({ op: 'settings:setProjectOrder', order: names })
      .then(order => {
        if (Array.isArray(order)) setSettings(prev => prev ? { ...prev, projectOrder: order } : prev);
      })
      .catch(() => undefined);
  }

  function onProjectTabDrop(toIndex: number): void {
    const from = projDragFrom.current;
    projDragFrom.current = null;
    setProjDragOver(null);
    if (from === null || from === toIndex || from >= sessions.length) return;
    const next = reorderArray(sessions, from, toIndex);
    setSessions(next);
    persistProjectOrder(next);
  }

  function onWorkTabDrop(toIndex: number): void {
    const from = tabDragFrom.current;
    tabDragFrom.current = null;
    setTabDragOver(null);
    if (from === null || from === toIndex || from >= tabs.length) return;
    const next = reorderArray(tabs, from, toIndex);
    updateActiveSession({ tabs: next });
    persistWorkTabOrder(next);
  }

  function persistWorkTabOrder(nextTabs: EditorTab[]): void {
    must<string[]>({ op: 'settings:setWorkTabOrder', order: nextTabs.map(t => t.agent) })
      .catch(() => undefined);
  }

  function onAgentPillDrop(toIndex: number): void {
    const from = agentDragFrom.current;
    agentDragFrom.current = null;
    setAgentDragOver(null);
    if (from === null || from === toIndex || from >= agents.length) return;
    const next = reorderArray(agents, from, toIndex);
    setAgents(next);
    // 에이전트 순서 영구 저장 (재실행 후 유지)
    must<string[]>({ op: 'settings:setAgentOrder', order: next })
      .then(order => {
        if (Array.isArray(order)) setSettings(prev => prev ? { ...prev, agentOrder: order } : prev);
      })
      .catch(() => undefined);
  }

  // ── Updater 구독 + 백그라운드 새 버전 알림 (정책: 자동 설치 없음) ────────────
  useEffect(() => onUpdateStatus(s => setUpdateStatus({ ...s })), []);
  const noticedVersion = useRef<string | null>(null);
  useEffect(() => {
    if (updateStatus?.phase === 'available' && updateStatus.nextVersion
      && noticedVersion.current !== updateStatus.nextVersion) {
      noticedVersion.current = updateStatus.nextVersion;
      notify('info', `새 버전 ${updateStatus.nextVersion}이 있습니다. ⚙ 설정 → 업데이트에서 설치할 수 있습니다.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateStatus?.phase, updateStatus?.nextVersion]);

  // ── 알림 ─────────────────────────────────────────────────────────────────────
  function notify(kind: 'ok' | 'err' | 'info', text: string): void {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg({ kind, text });
    msgTimer.current = setTimeout(() => setMsg(null), kind === 'err' ? 6000 : 4000);
  }
  function dismissMsg(): void {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
  }

  // ── 설정 ─────────────────────────────────────────────────────────────────────
  async function applySettings(s: SettingsView): Promise<void> {
    setSettings(s);
    // 에이전트 순서 — 저장된 agentOrder를 반영해 표시 (신규 항목은 뒤에 추가)
    setAgents(applyOrderByKeys([...DEFAULT_AGENTS, ...(s.customAgents ?? [])], a => a, s.agentOrder ?? []));
    if (s.workTabOrder?.length) {
      setSessions(prev => prev.map((session, index) => {
        if (index !== 0) return session;
        const tabs = s.workTabOrder!.map((agent, tabIndex) =>
          tabIndex === 0 ? { ...session.tabs[0]!, agent } : makeTab(agent)
        );
        return { ...session, tabs, activeTabId: tabs[0]!.id };
      }));
    }
  }

  // ── 데이터 로드 ───────────────────────────────────────────────────────────────
  async function loadView(projectName: string, sessId?: string): Promise<void> {
    const sid = sessId ?? activeSessionId;
    if (!projectName || !dataRoot) return;
    const view = await must<ProjectViewData>({ op: 'project:view', dataRoot, project: projectName });
    setProjects(view.projects);
    setSessions(prev => prev.map(s => s.id === sid ? { ...s, history: view.history } : s));
  }
  async function refreshHistory(): Promise<void> {
    if (project) await loadView(project);
  }

  // ── 런 폴더 준비 ──────────────────────────────────────────────────────────────
  /**
   * 다음 런 번호 조회 (읽기 전용).
   * 파일시스템에 아무 것도 생성하지 않는다 — 폴더 생성은 실제 저장 시점에만.
   */
  async function peekNextRun(p: string, a: string, d: string, root?: string): Promise<string | null> {
    const rootPath = root ?? dataRoot;
    if (!p || !a || !d || !rootPath) return null;
    return await must<string>({ op: 'run:next', dataRoot: rootPath, project: p, date: d, agent: a });
  }

  /** 실제 저장 시점에만 호출 — 런 번호를 확정하고 폴더를 생성한다. */
  async function getNextRun(p: string, a: string, d: string): Promise<RunFolderResult | null> {
    if (!p || !a || !d || !dataRoot) return null;
    const next = await must<string>({ op: 'run:next', dataRoot, project: p, date: d, agent: a });
    return await must<RunFolderResult>({ op: 'run:ensureFolder', dataRoot, project: p, date: d, agent: a, run: next });
  }

  // ── Result → GPT 전달 ───────────────────────────────────────────────────────
  function mdFilePath(folder: string, file: string): string {
    const sep = folder.includes('\\') ? '\\' : '/';
    return folder.replace(/[\\/]+$/, '') + sep + file;
  }
  function dragResultToGpt(tab: EditorTab): void {
    if (!tab.folder) { notify('err', 'result.md를 먼저 저장하세요.'); return; }
    dragLocalFile(mdFilePath(tab.folder, 'result.md'));
    notify('info', '마우스를 놓지 말고 ChatGPT 입력창 위에서 놓으세요.');
  }
  async function revealResult(tab: EditorTab): Promise<void> {
    if (!tab.folder) { notify('err', 'result.md를 먼저 저장하세요.'); return; }
    await must({ op: 'file:reveal', path: mdFilePath(tab.folder, 'result.md') });
    notify('ok', '탐색기에서 result.md가 선택되었습니다.');
  }

  // ── 탭 추가 ─────────────────────────────────────────────────────────────────
  async function addTab(agentName?: string): Promise<void> {
    const agent = agentName ?? (activeTab?.agent ?? DEFAULT_AGENTS[0]);
    const tab = makeTab(agent);
    const nextTabs = [...tabs, tab];
    setSessions(prev => prev.map(s =>
      s.id === activeSessionId
        ? { ...s, tabs: nextTabs, activeTabId: tab.id }
        : s
    ));
    persistWorkTabOrder(nextTabs);
    if (project && date) {
      const n = await peekNextRun(project, agent, date);
      if (n !== null) updateTab(tab.id, { run: n });
    }
    notify('info', `새 탭 — ${agent}`);
  }

  // ── 탭 제거 ─────────────────────────────────────────────────────────────────
  function removeTab(id: string): void {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    const sessId = activeSessionId;
    const doRemove = (): void => {
      const next = tabs.filter(t => t.id !== id);
      const restored = next.length === 0 ? [makeTab(tab.agent)] : next;
      persistWorkTabOrder(restored);
      setSessions(prev => prev.map(s => {
        if (s.id !== sessId) return s;
        if (next.length === 0) return { ...s, tabs: restored, activeTabId: restored[0]!.id };
        return {
          ...s,
          tabs: restored,
          activeTabId: s.activeTabId === id ? restored[restored.length - 1]!.id : s.activeTabId,
        };
      }));
    };
    if (hasUnsavedContent(tab)) {
      setConfirm({ text: `탭 "${tab.agent} #${tab.run || '?'}"을 닫을까요?\n저장되지 않은 내용은 사라집니다.`, confirmBtn: '닫기', onOk: doRemove });
    } else {
      doRemove();
    }
  }

  // ── 탭에서 런 열기 ────────────────────────────────────────────────────────────
  async function openRunInTab(h: HistoryItem, tabId?: string): Promise<void> {
    const tid = tabId ?? activeTabId;
    const tab = tabs.find(t => t.id === tid);

    const doLoad = async (): Promise<void> => {
      const rec = await must<{ prompt: string; result: string; tags: string[] }>({ op: 'run:read', folder: h.folder });
      updateTab(tid, { agent: h.agent, run: h.run, folder: h.folder, prompt: rec.prompt, result: rec.result, tags: rec.tags ?? [], promptPreview: false, resultPreview: false, promptSaved: true, resultSaved: true });
      setSessions(prev => prev.map(s => {
        if (s.id !== activeSessionId) return s;
        const next = new Set(s.expandedKeys);
        next.add(`d:${h.date}`);
        next.add(`a:${h.date}:${h.agent}`);
        return { ...s, expandedKeys: next };
      }));
      notify('info', `런 #${h.run} (${h.agent}) 불러옴`);
    };

    const hasContent = !!tab && hasUnsavedContent(tab);
    const isDifferentRun = tab?.folder !== h.folder;
    if (hasContent && isDifferentRun) {
      setConfirm({
        text: `현재 탭에 저장되지 않은 내용이 있습니다.\n런 #${h.run} (${h.agent})을 불러오면 현재 내용이 사라집니다.`,
        confirmBtn: '불러오기',
        onOk: doLoad,
      });
      return;
    }
    await doLoad();
  }

  // ── 탭에서 새 런 ──────────────────────────────────────────────────────────────
  async function newRunInTab(tabId?: string): Promise<void> {
    const tid = tabId ?? activeTabId;
    const tab = tabs.find(t => t.id === tid);
    if (!tab) return;
    updateTab(tid, { prompt: '', result: '', tags: [], promptPreview: false, resultPreview: false, folder: '', run: '', promptSaved: false, resultSaved: false });
    await refreshHistory();
    const n = await peekNextRun(project, tab.agent, date);
    if (n !== null) updateTab(tid, { run: n });
    notify('info', `${tab.agent} — 새 런 준비됨`);
  }

  // ── 에이전트 변경 (탭 내) ─────────────────────────────────────────────────────
  async function changeTabAgent(tabId: string, agent: string): Promise<void> {
    try { localStorage.setItem(LAST_AGENT_STORAGE_KEY, agent); } catch { /* 무시 */ }
    updateTab(tabId, { agent, run: '', folder: '', prompt: '', result: '', tags: [], promptSaved: false, resultSaved: false });
    persistWorkTabOrder(tabs.map(t => t.id === tabId ? { ...t, agent } : t));
    const n = await peekNextRun(project, agent, date);
    if (n !== null) updateTab(tabId, { run: n });
  }

  // ── 프롬프트 저장 ─────────────────────────────────────────────────────────────
  /**
   * resolved: 호출부(모두 저장)가 이미 폴더를 확정해 넘겨줄 때 사용한다.
   * 각 저장이 폴더를 따로 만들면 한 번의 저장으로 런 2개가 생기는 회귀가 발생한다.
   */
  async function saveTabPrompt(tabId: string, overwrite = false, resolved?: RunFolderResult): Promise<void> {
    let tab = tabs.find(t => t.id === tabId);
    if (!tab || !dataRoot) return;
    let folder = resolved?.folder ?? tab.folder;
    if (!folder) {
      if (!project) { notify('err', '프로젝트를 먼저 선택하세요.'); return; }
      const res = await getNextRun(project, tab.agent, date);
      if (!res) { notify('err', '런 폴더를 생성할 수 없습니다.'); return; }
      resolved = res;
      folder = res.folder;
    }
    const runNo = resolved?.run ?? tab.run;
    try {
      await must({ op: 'prompt:save', folder, content: tab.prompt, overwrite });
      updateTab(tabId, { ...(resolved ?? {}), promptSaved: true });
      notify('ok', `프롬프트 저장됨 ← ${tab.agent} #${runNo}`);
      await refreshHistory();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!overwrite && text.includes('이미 있어')) {
        setConfirm({ text: 'prompt.md가 이미 존재합니다. 덮어쓸까요?', confirmBtn: '덮어쓰기', onOk: () => void saveTabPrompt(tabId, true) });
        return;
      }
      notify('err', text);
    }
  }

  // ── 결과 저장 ─────────────────────────────────────────────────────────────────
  async function saveTabResult(tabId: string, overwrite = false, resolved?: RunFolderResult): Promise<void> {
    let tab = tabs.find(t => t.id === tabId);
    if (!tab || !dataRoot) return;
    let folder = resolved?.folder ?? tab.folder;
    if (!folder) {
      if (!project) { notify('err', '프로젝트를 먼저 선택하세요.'); return; }
      const res = await getNextRun(project, tab.agent, date);
      if (!res) { notify('err', '런 폴더를 생성할 수 없습니다.'); return; }
      resolved = res;
      folder = res.folder;
    }
    const runNo = resolved?.run ?? tab.run;
    try {
      await must({ op: 'result:save', folder, content: tab.result, overwrite });
      updateTab(tabId, { ...(resolved ?? {}), resultSaved: true });
      notify('ok', `결과 저장됨 ← ${tab.agent} #${runNo}`);
      await refreshHistory();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!overwrite && text.includes('이미')) {
        setConfirm({ text: 'result.md가 이미 존재합니다. 덮어쓸까요?', confirmBtn: '덮어쓰기', onOk: () => void saveTabResult(tabId, true) });
        return;
      }
      notify('err', text);
    }
  }

  async function saveTabBoth(tabId: string): Promise<void> {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !dataRoot) return;

    // 런 폴더가 없으면 딱 한 번만 생성하고 두 저장에 같은 폴더를 넘긴다.
    // (stale closure로 인해 prompt/result가 서로 다른 런에 저장되는 문제 방지)
    let resolved: RunFolderResult | undefined;
    if (!tab.folder) {
      if (!project) { notify('err', '프로젝트를 먼저 선택하세요.'); return; }
      const res = await getNextRun(project, tab.agent, date);
      if (!res) { notify('err', '런 폴더를 생성할 수 없습니다.'); return; }
      resolved = res;
      updateTab(tabId, res);
    }
    await saveTabPrompt(tabId, false, resolved);
    await saveTabResult(tabId, false, resolved);
  }

  // ── 태그 ─────────────────────────────────────────────────────────────────────
  async function updateTabTags(tabId: string, newTags: string[]): Promise<void> {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab?.folder) return;
    await must({ op: 'run:tagUpdate', folder: tab.folder, tags: newTags });
    updateTab(tabId, { tags: newTags });
    await refreshHistory();
  }

  // ── 내보내기 ──────────────────────────────────────────────────────────────────
  async function exportTabRun(tabId: string): Promise<void> {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab?.folder) { notify('err', '저장된 런이 없습니다. 먼저 저장하세요.'); return; }
    const res = await must<{ saved: boolean; filePath?: string }>({ op: 'run:export', folder: tab.folder });
    if (res.saved && res.filePath) notify('ok', `내보내기 완료: ${res.filePath}`);
  }

  // ── 런 삭제 (히스토리에서) ────────────────────────────────────────────────────
  async function deleteHistoryRun(h: HistoryItem): Promise<void> {
    setConfirm({
      text: `런 #${h.run} (${h.agent} · ${h.date})를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`,
      confirmBtn: '삭제',
      onOk: async () => {
        await must({ op: 'run:delete', folder: h.folder });
        setSessions(prev => prev.map(s =>
          s.id !== activeSessionId ? s : {
            ...s,
            tabs: s.tabs.map(t => t.folder === h.folder
              ? { ...t, folder: '', run: '', prompt: '', result: '', tags: [], promptSaved: false, resultSaved: false }
              : t),
          }
        ));
        await refreshHistory();
        notify('ok', `런 #${h.run} 삭제됨`);
      },
    });
  }

  // ── 날짜 폴더 삭제 ────────────────────────────────────────────────────────────
  async function deleteDate(dateStr: string): Promise<void> {
    const runsCount = history.filter(h => h.date === dateStr).length;
    setConfirm({
      text: `📅 ${dateStr} 전체를 삭제하시겠습니까?\n(런 ${runsCount}개 포함 모든 파일이 삭제됩니다)\n이 작업은 되돌릴 수 없습니다.`,
      confirmBtn: '삭제',
      onOk: async () => {
        await must({ op: 'date:delete', dataRoot, project, date: dateStr });
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSessionId) return s;
            const affected = new Set(s.history.filter(h => h.date === dateStr).map(h => h.folder));
            return { ...s, tabs: s.tabs.map(t => affected.has(t.folder) ? { ...t, folder: '', run: '', prompt: '', result: '', tags: [], promptSaved: false, resultSaved: false } : t) };
          }));
        await refreshHistory();
        notify('ok', `📅 ${dateStr} 삭제됨`);
      },
    });
  }

  // ── 에이전트 폴더 삭제 ────────────────────────────────────────────────────────
  async function deleteAgent(dateStr: string, agentName: string): Promise<void> {
    const runsCount = history.filter(h => h.date === dateStr && h.agent === agentName).length;
    setConfirm({
      text: `🤖 ${agentName} (${dateStr}) 폴더를 삭제하시겠습니까?\n(런 ${runsCount}개 포함 모든 파일이 삭제됩니다)\n이 작업은 되돌릴 수 없습니다.`,
      confirmBtn: '삭제',
      onOk: async () => {
        await must({ op: 'agent:delete', dataRoot, project, date: dateStr, agent: agentName });
          setSessions(prev => prev.map(s => {
            if (s.id !== activeSessionId) return s;
            const affected = new Set(s.history.filter(h => h.date === dateStr && h.agent === agentName).map(h => h.folder));
            return { ...s, tabs: s.tabs.map(t => affected.has(t.folder) ? { ...t, folder: '', run: '', prompt: '', result: '', tags: [], promptSaved: false, resultSaved: false } : t) };
          }));
        await refreshHistory();
        notify('ok', `🤖 ${agentName} (${dateStr}) 삭제됨`);
      },
    });
  }

  // ── 프로젝트 삭제 ─────────────────────────────────────────────────────────────
  async function deleteProject(projectName: string): Promise<void> {
    if (!projectName || projectName === ROOT_PROJECT) { notify('err', '루트 프로젝트는 삭제할 수 없습니다.'); return; }
    const runsCount = history.length;
    setConfirm({
      text: `⚠️ 프로젝트 "${projectName}" 전체를 삭제하시겠습니까?\n(런 ${runsCount}개 포함 모든 파일이 영구 삭제됩니다)\n이 작업은 절대 되돌릴 수 없습니다!`,
      confirmBtn: '영구 삭제',
        onOk: async () => {
          setPdMode(false);
          await must({ op: 'project:delete', dataRoot, project: projectName });
        const deletingId = sessions.find(s => s.project === projectName)?.id;
        const remaining = sessions.filter(s => s.project !== projectName);
        if (remaining.length === 0) {
          const fresh = makeSession();
          setSessions([fresh]);
          setActiveSessionId(fresh.id);
        } else {
          setSessions(remaining);
          if (deletingId === activeSessionId) {
            setActiveSessionId(remaining[remaining.length - 1]!.id);
          }
        }
        const view = await must<ProjectViewData>({ op: 'project:view', dataRoot, project: ROOT_PROJECT });
        setProjects(view.projects);
        notify('ok', `프로젝트 "${projectName}" 삭제됨`);
      },
    });
  }

  // ── 트리 런 이동 (드래그 앤 드롭) ────────────────────────────────────────────
  async function moveRunToAgent(h: HistoryItem, toDate: string, toAgent: string): Promise<void> {
    if (!dataRoot || !project) return;
    if (h.date === toDate && h.agent === toAgent) return;
    const res = await must<{ folder: string }>({ op: 'run:move', fromFolder: h.folder, dataRoot, project, toDate, toAgent });
    const parts = res.folder.replace(/\\/g, '/').split('/');
    const newRun = parts[parts.length - 1] ?? '';
    setSessions(prev => prev.map(s =>
      s.id !== activeSessionId ? s : {
        ...s,
        tabs: s.tabs.map(t => t.folder === h.folder ? { ...t, folder: res.folder, run: newRun, agent: toAgent } : t),
      }
    ));
    await refreshHistory();
    notify('ok', `런을 ${toAgent} (${toDate})으로 이동했습니다.`);
  }

  // ── 드래그 앤 드롭 파일 (편집창) ──────────────────────────────────────────────
  function onDropFile(tabId: string, pane: 'prompt' | 'result') {
    return (e: React.DragEvent): void => {
      e.preventDefault();
      updateTab(tabId, pane === 'prompt' ? { promptDrag: false } : { resultDrag: false });
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith('.md')) { notify('err', '.md 파일만 드래그할 수 있습니다.'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        updateTab(tabId, pane === 'prompt' ? { prompt: text, promptSaved: false } : { result: text, resultSaved: false });
        notify('info', `${file.name} 불러옴`);
      };
      reader.readAsText(file, 'utf-8');
    };
  }

  // ── 키보드 단축키 ─────────────────────────────────────────────────────────────
  const actionsRef = useRef({ saveActiveBoth: () => {}, newRunInActive: () => {}, addNewTab: () => {} });
  actionsRef.current = {
    saveActiveBoth: () => { void saveTabBoth(activeTabId); },
    newRunInActive: () => { void newRunInTab(activeTabId); },
    addNewTab: () => { void addTab(); },
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!e.ctrlKey || e.shiftKey || e.altKey) return;
      if (e.key === 's') { e.preventDefault(); actionsRef.current.saveActiveBoth(); }
      if (e.key === 'n') { e.preventDefault(); actionsRef.current.newRunInActive(); }
      if (e.key === 't') { e.preventDefault(); actionsRef.current.addNewTab(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── 저장되지 않은 편집 보호 ───────────────────────────────────────────────────
  function confirmLeavingSession(action: () => void): void {
    if (!hasUnsavedTabs(activeSession)) { action(); return; }
    setConfirm({
      text: '현재 프로젝트 세션에 저장되지 않은 프롬프트 또는 결과가 있습니다.\n이동하면 내용이 사라질 수 있습니다.',
      confirmBtn: '이동',
      onOk: action,
    });
  }

  function switchSession(id: string): void {
    if (id === activeSessionId) return;
    confirmLeavingSession(() => setActiveSessionId(id));
  }

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent): void {
      if (!sessions.some(hasUnsavedTabs)) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [sessions]);

  // ── 시작 화면 (--view=home|control-room|approvals|plan-studio, 마운트 시 1회) ──
  // home(기본값)·알 수 없는 값은 오늘과 완전히 동일하게 둔다.
  const startViewApplied = useRef(false);
  useEffect(() => {
    if (startViewApplied.current) return;
    startViewApplied.current = true;
    void must<StartViewResult>({ op: 'app:startView' }).then(res => {
      const view: StartView = res?.view ?? 'home';
      if (view === 'control-room') {
        setControlRoomMode(true); setDfMode(false); setPdMode(false);
        setApprovalsMode(false); setPlanStudioMode(false);
      } else if (view === 'approvals') {
        setApprovalsMode(true); setControlRoomMode(false); setDfMode(false); setPdMode(false);
        setPlanStudioMode(false);
      } else if (view === 'plan-studio') {
        setPlanStudioMode(true); setControlRoomMode(false); setDfMode(false); setPdMode(false);
        setApprovalsMode(false);
      }
    }).catch(() => undefined);
  }, []);

  // ── 초기화 ────────────────────────────────────────────────────────────────────
  // settings.json의 DATA_ROOT/lastProject를 자동 복원한다.
  //  - 경로 존재 → 자동 사용 + 마지막 프로젝트 세션 복원
  //  - 경로 유실 → "저장공간을 찾을 수 없습니다" 화면
  useEffect(() => {
    void (async () => {
      try {
        if (!hasBridge()) { setInitError('Electron IPC 브리지를 사용할 수 없습니다.\nexe 파일을 직접 실행하세요.'); setLoading(false); return; }
        const s = await must<SettingsView>({ op: 'settings:get' });
        await applySettings(s);
        if (s.dataRoot && s.dataRootExists) {
          const projects = await must<ProjectInfo[]>({ op: 'projects:list', dataRoot: s.dataRoot });
          setProjects(projects);
          if (s.lastProject && projects.some(p => p.name === s.lastProject)) {
            await openProjectSession(s.lastProject, s.dataRoot);
          }
        } else if (s.dataRoot && !s.dataRootExists) {
          setMissingRoot(true);
        }
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── 프로젝트 세션 열기 ────────────────────────────────────────────────────────
  // 이미 열려있는 세션 → 전환. 현재 세션이 비어있으면 → 재사용. 그 외 → 새 세션 생성.
  async function openProjectSession(name: string, root?: string): Promise<void> {
    if (!name) return;
    const rootPath = root ?? dataRoot;
    if (!rootPath) return;

    // 이미 같은 프로젝트가 열려있으면 해당 세션으로 전환
    const existing = sessions.find(s => s.project === name);
    if (existing) {
      switchSession(existing.id);
      return;
    }

    // 현재 세션에 프로젝트가 없으면 현재 세션을 이 프로젝트로 설정
    const currSess = sessions.find(s => s.id === activeSessionId) ?? sessions[0]!;
    const useExisting = !currSess.project;

    if (hasUnsavedTabs(currSess)) {
      setConfirm({
        text: '현재 프로젝트 세션에 저장되지 않은 프롬프트 또는 결과가 있습니다.\n프로젝트를 전환하면 내용이 사라질 수 있습니다.',
        confirmBtn: '전환',
        onOk: () => { void openProjectSession(name, root); },
      });
      return;
    }

    let newSessId: string;
    if (useExisting) {
      newSessId = currSess.id;
      setSessions(prev => prev.map(s => s.id === currSess.id ? { ...s, project: name } : s));
      setActiveSessionId(currSess.id);
    } else {
      const newSess = makeSession(name);
      newSessId = newSess.id;
      setSessions(prev => [...prev, newSess]);
      setActiveSessionId(newSess.id);
    }

    // 히스토리 로드
    const view = await must<ProjectViewData>({ op: 'project:view', dataRoot: rootPath, project: name });
    setProjects(view.projects);

    // 마지막 프로젝트 기억 — 다음 실행 시 자동 복원용
    try { await must({ op: 'settings:setLastProject', project: name }); } catch { /* 무시 */ }

    // 다음 런 번호만 미리보기 — 폴더는 실제 저장 시점에 생성된다
    const sessNow = useExisting ? currSess : sessions.find(s => s.id === newSessId);
    const initTab = sessNow?.tabs[0] ?? { id: '', agent: DEFAULT_AGENTS[0] };
    const nextNum = initTab.id ? await peekNextRun(name, initTab.agent, date, rootPath) : null;

    setSessions(prev => prev.map(s => {
      if (s.id !== newSessId) return s;
      return {
        ...s,
        project: name,
        history: view.history,
        tabs: nextNum !== null
          ? s.tabs.map(t => t.id === initTab.id ? { ...t, run: nextNum, folder: '' } : t)
          : s.tabs,
      };
    }));
  }

  // ── 프로젝트 세션 닫기 ────────────────────────────────────────────────────────
  function closeSession(id: string): void {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const doClose = (): void => {
      const remaining = sessions.filter(s => s.id !== id);
      if (!remaining.some(s => s.project === project)) setPdMode(false);
      if (remaining.length === 0) {
        const fresh = makeSession();
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      } else {
        setSessions(remaining);
        if (activeSessionId === id) setActiveSessionId(remaining[remaining.length - 1]!.id);
      }
    };
    if (hasUnsavedTabs(session)) {
      setConfirm({
        text: `프로젝트 세션 "${session.project || '새 세션'}"에 저장되지 않은 내용이 있습니다.\n세션을 닫으면 내용이 사라집니다.`,
        confirmBtn: '닫기',
        onOk: doClose,
      });
      return;
    }
    doClose();
  }

  // ── 빈 세션 추가 ─────────────────────────────────────────────────────────────
  function addSession(): void {
    confirmLeavingSession(() => {
      const fresh = makeSession();
      setSessions(prev => [...prev, fresh]);
      setActiveSessionId(fresh.id);
    });
  }

  // ── 날짜 변경 ─────────────────────────────────────────────────────────────────
  async function editDate(d: string): Promise<void> {
    if (!d) return;
    setDate(d);
    // 현재 세션 탭들 초기화
    const currTabs = activeSession.tabs;
    setSessions(prev => prev.map(s =>
      s.id !== activeSessionId ? s : {
        ...s,
        tabs: s.tabs.map(t => ({ ...t, run: '', folder: '', prompt: '', result: '', tags: [], promptSaved: false, resultSaved: false })),
      }
    ));
    if (project) {
      for (const tab of currTabs) {
        const n = await peekNextRun(project, tab.agent, d);
        if (n !== null) updateTab(tab.id, { run: n });
      }
    }
  }

  // ── 데이터 루트 변경 ──────────────────────────────────────────────────────────
  async function setDataRoot(nextPath: string): Promise<void> {
    const s = await must<SettingsView>({ op: 'settings:setDataRoot', path: nextPath });
    await applySettings(s);
    setMissingRoot(false);
    setShowSettings(false);
    // 모든 세션 초기화
    const fresh = makeSession();
    setSessions([fresh]);
    setActiveSessionId(fresh.id);
    notify('ok', `데이터 폴더 설정됨: ${s.dataRoot}`);
    try {
      const view = await must<ProjectViewData>({ op: 'project:view', dataRoot: s.dataRoot, project: ROOT_PROJECT });
      setProjects(view.projects);
      if (view.projects.some(p => p.name === ROOT_PROJECT) && view.history.length > 0) {
        const rootSess = makeSession(ROOT_PROJECT);
        setSessions([{ ...rootSess, history: view.history }]);
        setActiveSessionId(rootSess.id);
        notify('ok', `기존 런 ${view.history.length}개를 발견했습니다.`);
      }
    } catch { /* 오류 무시 */ }
  }

  async function changeDataRoot(): Promise<void> {
    const pick = await must<{ selected: string | null }>({ op: 'folder:pick' });
    if (pick.selected) await setDataRoot(pick.selected);
  }

  function modalOk(): void {
    if (!modal) return;
    const cb = modal.onOk;
    setModal(null); setInputVal(''); cb(inputVal);
  }

  // ── 로딩 / 오류 화면 ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="app splash" data-theme={theme}>
      <div className="splash-inner">
        <div className="splash-logo">Agent Relay</div>
        <div className="splash-spin" />
        <div className="splash-hint">설정을 불러오는 중...</div>
      </div>
    </div>
  );
  if (initError) return (
    <div className="app splash" data-theme={theme}>
      <div className="splash-inner">
        <div className="splash-logo">Agent Relay</div>
        <div className="splash-err">{initError}</div>
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>DevTools (F12) → Console에서 자세한 내용을 확인하세요.</p>
      </div>
    </div>
  );

  // ── 저장공간 유실 화면 (외장 드라이브 제거, 폴더 삭제 등) ──
  if (missingRoot && settings) return (
    <div className="app splash" data-theme={theme}>
      <div className="splash-inner">
        <div className="splash-logo">Agent Relay</div>
        <div className="splash-err" style={{ whiteSpace: 'pre-line' }}>
          {'저장 폴더를 찾을 수 없습니다 (외장 드라이브가 빠졌거나 폴더가 옮겨졌을 수 있어요).\n\n'}
          {settings.dataRoot}
          {'\n\n새 저장공간을 선택하세요.'}
        </div>
        <button className="btn primary" onClick={() => void changeDataRoot()}>📁 새 저장공간 선택</button>
      </div>
    </div>
  );

  // 열려있는 프로젝트 이름 집합 (FileTree 사이드바에서 '이미 열림' 표시용)
  const openProjectNames = new Set(sessions.map(s => s.project).filter(Boolean));

  // ── Dogfooding 피드백에 자동 첨부할 현재 작업 Context ──
  function dfContext(): DfContext {
    return {
      project: project || undefined,
      date,
      agent: activeTab?.agent || undefined,
      run: activeTab?.run || undefined,
    };
  }

  // ── 렌더 ──────────────────────────────────────────────────────────────────────
  return (
    <div className="app" data-theme={theme}>
      {/* 데이터폴더 미설정 화면 */}
      {!dataRoot && settings && (
        <div className="setup">
          <div className="setupcard">
            <h1>Agent Relay</h1>
            <p>
              Agent Relay는 여러 프로젝트의 기획(PM) → 작업(Worker) → 검수(QA)를 자동으로 이어서 실행합니다.<br />
              사용자는 결과를 확인하고, 꼭 필요한 결정에만 답하면 됩니다.<br />
              먼저 결과와 기록을 저장할 폴더를 정해 주세요.
            </p>
            <div className="modalbtns" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => void setDataRoot(settings.defaultDataRoot)}>
                기본 폴더 사용 (문서 › Agent Relay)
              </button>
              <button className="btn" onClick={() => void changeDataRoot()}>
                다른 폴더 고르기
              </button>
            </div>
            <div className="muted" style={{ marginTop: 8, fontSize: 12, textAlign: 'center' }}>{settings.defaultDataRoot}</div>
          </div>
        </div>
      )}

      {dataRoot && (
        <>
          {/* 상단바 — Founder 우선: 관제실 · 승인 규칙 · 계획 → 설정 → 개발 도구 */}
          <header className="topbar">
            <div className="brand">Agent Relay</div>
            <button
              className={`mini df-toggle${controlRoomMode ? ' on' : ''}`}
              title="관제실 — lane 상태 보기"
              onClick={() => { setControlRoomMode(m => !m); setDfMode(false); setPdMode(false); setApprovalsMode(false); setPlanStudioMode(false); }}
            >관제실</button>
            <button
              className={`mini df-toggle${approvalsMode ? ' on' : ''}`}
              title="승인 규칙 — Agent Relay가 알아서 처리하도록 허락한 규칙"
              onClick={() => { setApprovalsMode(m => !m); setDfMode(false); setPdMode(false); setControlRoomMode(false); setPlanStudioMode(false); }}
            >승인 규칙</button>
            <button
              className={`mini df-toggle${planStudioMode ? ' on' : ''}`}
              title="계획 — Goal · Task chain · PM chat"
              onClick={() => { setPlanStudioMode(m => !m); setDfMode(false); setPdMode(false); setApprovalsMode(false); setControlRoomMode(false); }}
            >계획</button>
            <button
              className="mini"
              title="설정 — 저장공간(Storage)"
              onClick={() => setShowSettings(true)}
            >설정</button>
            <div className="devtools-wrap">
              <button
                className="mini devtools-toggle"
                title="개발자용 도구 모음"
                aria-expanded={showDevTools}
                onClick={() => setShowDevTools(v => !v)}
              >개발 도구 ▾</button>
              {showDevTools && (
                <div className="devtools-menu">
                  <div className="topbar-shortcuts">
                    <span title="모두 저장"><kbd>Ctrl+S</kbd> 저장</span>
                    <span title="현재 탭 새 런"><kbd>Ctrl+N</kbd> 새 런</span>
                    <span title="병렬 탭 추가"><kbd>Ctrl+T</kbd> 새 탭</span>
                  </div>
                  <button
                    className={`mini df-toggle${dfMode ? ' on' : ''}`}
                    title="Agent Relay 앱 자체 개선 기록 (App Dogfooding)"
                    onClick={() => { setDfMode(m => !m); setPdMode(false); setControlRoomMode(false); setApprovalsMode(false); setPlanStudioMode(false); }}
                  >App Dogfooding</button>
                  <button
                    className={`mini df-toggle${pdMode ? ' on' : ''}`}
                    disabled={!project}
                    title={project ? `"${projectLabel(project)}" 프로젝트 사용성 기록 (Project Dogfooding)` : '프로젝트를 먼저 선택하세요'}
                    onClick={() => { setPdMode(m => !m); setDfMode(false); setControlRoomMode(false); setApprovalsMode(false); setPlanStudioMode(false); }}
                  >Project Dogfooding</button>
                  <button
                    className="mini qdf-toggle"
                    disabled={!project}
                    title={project ? '불편한 순간 한 줄 기록 — 현재 프로젝트에 즉시 저장' : '프로젝트를 먼저 선택하세요'}
                    onClick={() => setShowQuickDf(true)}
                  >＋ 피드백</button>
                </div>
              )}
            </div>
            <button
              className="mini theme-toggle"
              title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              onClick={toggleTheme}
            >{theme === 'dark' ? '☀️' : '🌙'}</button>
          </header>

          {msg && (
            <div className={`flash ${msg.kind}`}>
              <span>{msg.text}</span>
              <button className="flash-close" onClick={dismissMsg} title="닫기">✕</button>
            </div>
          )}

          {controlRoomMode ? (
            <ControlRoom onClose={() => setControlRoomMode(false)} />
          ) : approvalsMode ? (
            <ApprovalsPanel onClose={() => setApprovalsMode(false)} />
          ) : planStudioMode ? (
            <PlanStudio onClose={() => setPlanStudioMode(false)} />
          ) : dfMode ? (
            /* ── App Dogfooding 패널 — Agent Relay 앱 자체 개선 기록 ── */
            <DogfoodPanel
              key="df-app"
              kind="app"
              dataRoot={dataRoot}
              context={dfContext()}
              notify={notify}
              onClose={() => setDfMode(false)}
            />
          ) : pdMode && project ? (
            /* ── Project Dogfooding 패널 — 현재 프로젝트 사용성 기록 ({project}/_dogfooding) ── */
            <DogfoodPanel
              key={`df-pd:${project}`}
              kind="project"
              dataRoot={dataRoot}
              project={project}
              context={dfContext()}
              notify={notify}
              refreshSignal={pdRefreshSignal}
              onClose={() => setPdMode(false)}
            />
          ) : (
            <>
          {/* ── 프로젝트 세션 탭 바 (Drag Reorder — 순서는 settings에 저장) ── */}
          <div className="proj-tab-bar">
            {sessions.map((sess, i) => {
              const isActive = sess.id === activeSessionId;
              const parts = dataRoot.replace(/\\/g, '/').split('/');
              const pLabel = !sess.project
                ? '새 세션'
                : sess.project === ROOT_PROJECT
                  ? (parts[parts.length - 1] ?? dataRoot)
                  : sess.project;
              return (
                <button
                  key={sess.id}
                  data-reorder-group="proj-tab"
                  data-reorder-index={i}
                  className={`proj-tab${isActive ? ' active' : ''}${projDragOver === i ? ' reorder-over' : ''}${pointerProjActive.current && projDragOver === i ? ' reorder-dragging' : ''}`}
                  onClick={() => {
                    if (pointerSuppressClick.current) { pointerSuppressClick.current = false; return; }
                    switchSession(sess.id);
                  }}
                  title={sess.project || '왼쪽 사이드바에서 프로젝트를 선택하세요'}
                  draggable
                  onDragStart={e => {
                    projDragFrom.current = i;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(i));
                  }}
                  onDragOver={e => { if (projDragFrom.current !== null) { e.preventDefault(); setProjDragOver(i); } }}
                  onDragLeave={() => setProjDragOver(prev => prev === i ? null : prev)}
                  onDrop={e => { e.preventDefault(); e.stopPropagation(); onProjectTabDrop(i); }}
                  onDragEnd={() => { projDragFrom.current = null; setProjDragOver(null); }}
                  onPointerDown={e => {
                    if (!shouldStartPointerReorder(e.pointerType)) return;
                    projDragFrom.current = i;
                    pointerProjActive.current = true;
                    setProjDragOver(i);
                    // 터치 implicit capture를 풀어야 sibling의 move/up이 발사된다.
                    try { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 무시 */ }
                  }}
                  onPointerMove={e => {
                    if (!pointerProjActive.current || projDragFrom.current === null) return;
                    const at = pointerOverIndexFromPoint(e.clientX, e.clientY, 'proj-tab', sessions.length);
                    setProjDragOver(at ?? i);
                  }}
                  onPointerUp={e => {
                    if (!pointerProjActive.current) return;
                    pointerProjActive.current = false;
                    const over = pointerOverIndexFromPoint(e.clientX, e.clientY, 'proj-tab', sessions.length) ?? i;
                    const to = resolvePointerDropIndex(projDragFrom.current, over, sessions.length);
                    if (to !== null) { pointerSuppressClick.current = true; onProjectTabDrop(to); }
                    else { projDragFrom.current = null; setProjDragOver(null); }
                  }}
                  onPointerCancel={() => {
                    if (!pointerProjActive.current) return;
                    pointerProjActive.current = false;
                    projDragFrom.current = null;
                    setProjDragOver(null);
                  }}
                >
                  <span className="proj-tab-icon">
                    {!sess.project ? '🔲' : sess.project === ROOT_PROJECT ? '📂' : '📁'}
                  </span>
                  <span className="proj-tab-name">{pLabel}</span>
                  {sessions.length > 1 && (
                    <span
                      className="proj-tab-close"
                      role="button"
                      tabIndex={0}
                      onClick={e => { e.stopPropagation(); closeSession(sess.id); }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); closeSession(sess.id); } }}
                      title="이 프로젝트 탭 닫기"
                    >✕</span>
                  )}
                </button>
              );
            })}
            <button
              className="proj-tab-add"
              onClick={addSession}
              title="새 프로젝트 탭 추가"
              aria-label="새 프로젝트 탭 추가"
            >+</button>
          </div>

          {/* 글로벌 필드 (날짜 + 저장위치) */}
          <section className="fields">
            <FieldText label="날짜 (YYYY-MM-DD)" value={date} onChange={v => void editDate(v)} />
            <div className="field breadcrumb-field">
              <span className="flabel">저장 위치</span>
              <span className="fvalue breadcrumb mono">
                {project
                  ? `${project === ROOT_PROJECT ? '📂' : '📁'} ${projectLabel(project)} / 📅 ${date} / 🤖 ${activeTab?.agent ?? '?'} / 런 #${activeTab?.run || '?'}`
                  : '← 왼쪽 사이드바에서 프로젝트를 선택하세요'}
              </span>
            </div>
          </section>

          {/* 메인 바디: 트리 | 편집 영역 */}
          <main className="body">
            {/* ── 파일 트리 패널 ── */}
            <FileTree
              project={project}
              projects={sortedProjects}
              dataRoot={dataRoot}
              openProjectNames={openProjectNames}
              onPickProject={name => void openProjectSession(name)}
              onAddProject={() => setModal({
                title: '새 프로젝트',
                placeholder: '프로젝트 이름 (예: HERMESS)',
                onOk: async v => {
                  const created = await must<ProjectInfo>({ op: 'projects:create', dataRoot, name: v });
                  await openProjectSession(created.name);
                  notify('ok', `프로젝트 '${created.name}' 생성됨`);
                },
              })}
              tree={tree}
              search={treeSearch}
              onSearchChange={v => updateActiveSession({ treeSearch: v })}
              expandedKeys={expandedKeys}
              onToggleKey={key => setSessions(prev => prev.map(s => {
                if (s.id !== activeSessionId) return s;
                const next = new Set(s.expandedKeys);
                next.has(key) ? next.delete(key) : next.add(key);
                return { ...s, expandedKeys: next };
              }))}
              activeFolder={activeTab?.folder ?? ''}
              dragRun={dragRun}
              dropTarget={dropTarget}
              onDragStart={h => setDragRun(h)}
              onDragEnd={() => { setDragRun(null); setDropTarget(null); }}
              onDropOnAgent={(d, agent) => { if (dragRun) void moveRunToAgent(dragRun, d, agent); setDragRun(null); setDropTarget(null); }}
              onSetDropTarget={setDropTarget}
              onOpenRun={h => void openRunInTab(h)}
              onOpenInNewTab={h => { void addTab(h.agent).then(() => void openRunInTab(h, tabs[tabs.length]?.id)); }}
              onDeleteRun={h => void deleteHistoryRun(h)}
              onDeleteDate={d => void deleteDate(d)}
              onDeleteAgent={(d, a) => void deleteAgent(d, a)}
              onDeleteProject={p => void deleteProject(p)}
              noProject={!project}
            />

            {/* ── 편집 영역 ── */}
            <div className="editor-area">
              {/* 탭 바 (Drag Reorder — 순서는 settings에 저장, 내용은 저장하지 않음) */}
              <div className="tab-bar">
                {tabs.map((tab, i) => (
                  <button
                    key={tab.id}
                    data-reorder-group="work-tab"
                    data-reorder-index={i}
                    className={`tab-btn${tab.id === activeTabId ? ' active' : ''}${tabDragOver === i ? ' reorder-over' : ''}${pointerTabActive.current && tabDragOver === i ? ' reorder-dragging' : ''}`}
                    onClick={() => {
                      if (pointerSuppressClick.current) { pointerSuppressClick.current = false; return; }
                      updateActiveSession({ activeTabId: tab.id });
                    }}
                    title={tab.folder || `${tab.agent} — 아직 저장 안 됨`}
                    draggable
                    onDragStart={e => {
                      tabDragFrom.current = i;
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(i));
                    }}
                    onDragOver={e => { if (tabDragFrom.current !== null) { e.preventDefault(); setTabDragOver(i); } }}
                    onDragLeave={() => setTabDragOver(prev => prev === i ? null : prev)}
                    onDrop={e => { e.preventDefault(); e.stopPropagation(); onWorkTabDrop(i); }}
                    onDragEnd={() => { tabDragFrom.current = null; setTabDragOver(null); }}
                    onPointerDown={e => {
                      if (!shouldStartPointerReorder(e.pointerType)) return;
                      tabDragFrom.current = i;
                      pointerTabActive.current = true;
                      setTabDragOver(i);
                      // 터치 implicit capture를 풀어야 sibling의 move/up이 발사된다.
                      try { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 무시 */ }
                    }}
                    onPointerMove={e => {
                      if (!pointerTabActive.current || tabDragFrom.current === null) return;
                      const at = pointerOverIndexFromPoint(e.clientX, e.clientY, 'work-tab', tabs.length);
                      setTabDragOver(at ?? i);
                    }}
                    onPointerUp={e => {
                      if (!pointerTabActive.current) return;
                      pointerTabActive.current = false;
                      const over = pointerOverIndexFromPoint(e.clientX, e.clientY, 'work-tab', tabs.length) ?? i;
                      const to = resolvePointerDropIndex(tabDragFrom.current, over, tabs.length);
                      if (to !== null) { pointerSuppressClick.current = true; onWorkTabDrop(to); }
                      else { tabDragFrom.current = null; setTabDragOver(null); }
                    }}
                    onPointerCancel={() => {
                      if (!pointerTabActive.current) return;
                      pointerTabActive.current = false;
                      tabDragFrom.current = null;
                      setTabDragOver(null);
                    }}
                  >
                    <span className="tab-label">
                      {tab.agent}
                      {tab.run && <span className="tab-runnum"> #{tab.run}</span>}
                    </span>
                    {hasUnsavedContent(tab) && <span className="tab-dot" title="저장되지 않은 내용 있음">●</span>}
                    <button
                      className="tab-close"
                      onClick={e => { e.stopPropagation(); removeTab(tab.id); }}
                      title="탭 닫기"
                    >✕</button>
                  </button>
                ))}
                <button
                  className="tab-btn add"
                  onClick={() => void addTab()}
                  title="새 병렬 탭 추가 (Ctrl+T)"
                  aria-label="새 탭 추가"
                >+ 새 탭</button>
              </div>

              {/* 탭 헤더: 에이전트 선택 + 태그 + 액션 */}
              {activeTab && (
                <div className="tab-header">
                  <div className="tab-header-row">
                    <div className="agent-pills-wrap">
                      <span className="flabel">에이전트 {activeTab.run && <span style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>— 런 #{activeTab.run}</span>}</span>
                      <div className="agent-pills-row">
                        <div className="agent-pills">
                          {agents.map((a, i) => (
                            <button
                              key={a}
                              data-reorder-group="agent-pill"
                              data-reorder-index={i}
                              className={`agent-pill${activeTab.agent === a ? ' active' : ''}${agentDragOver === i ? ' reorder-over' : ''}${pointerAgentActive.current && agentDragOver === i ? ' reorder-dragging' : ''}`}
                              title={`${a} — 드래그로 순서 변경 (설정에 저장됨)`}
                              draggable
                              onDragStart={e => {
                                agentDragFrom.current = i;
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/plain', String(i));
                              }}
                              onDragOver={e => { if (agentDragFrom.current !== null) { e.preventDefault(); setAgentDragOver(i); } }}
                              onDragLeave={() => setAgentDragOver(prev => prev === i ? null : prev)}
                              onDrop={e => { e.preventDefault(); e.stopPropagation(); onAgentPillDrop(i); }}
                              onDragEnd={() => { agentDragFrom.current = null; setAgentDragOver(null); }}
                              onPointerDown={e => {
                                if (!shouldStartPointerReorder(e.pointerType)) return;
                                agentDragFrom.current = i;
                                pointerAgentActive.current = true;
                                setAgentDragOver(i);
                                // 터치 implicit capture를 풀어야 sibling의 move/up이 발사된다.
                                try { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 무시 */ }
                              }}
                              onPointerMove={e => {
                                if (!pointerAgentActive.current || agentDragFrom.current === null) return;
                                const at = pointerOverIndexFromPoint(e.clientX, e.clientY, 'agent-pill', agents.length);
                                setAgentDragOver(at ?? i);
                              }}
                              onPointerUp={e => {
                                if (!pointerAgentActive.current) return;
                                pointerAgentActive.current = false;
                                const over = pointerOverIndexFromPoint(e.clientX, e.clientY, 'agent-pill', agents.length) ?? i;
                                const to = resolvePointerDropIndex(agentDragFrom.current, over, agents.length);
                                if (to !== null) { pointerSuppressClick.current = true; onAgentPillDrop(to); }
                                else { agentDragFrom.current = null; setAgentDragOver(null); }
                              }}
                              onPointerCancel={() => {
                                if (!pointerAgentActive.current) return;
                                pointerAgentActive.current = false;
                                agentDragFrom.current = null;
                                setAgentDragOver(null);
                              }}
                              onClick={() => {
                                if (pointerSuppressClick.current) { pointerSuppressClick.current = false; return; }
                                void changeTabAgent(activeTab.id, a);
                              }}
                            >{a}</button>
                          ))}
                        </div>
                        <button
                          className="agent-pill-add"
                          title="에이전트 추가"
                          aria-label="에이전트 추가"
                          onClick={() => setModal({
                            title: '새 에이전트',
                            placeholder: '에이전트 이름',
                            onOk: async v => {
                              const name = v.trim();
                              if (!name) return;
                              const newCustomAgents = await must<string[]>({ op: 'agents:add', name });
                              if (settings) setSettings({ ...settings, customAgents: newCustomAgents });
                              setAgents([...DEFAULT_AGENTS, ...newCustomAgents]);
                              await changeTabAgent(activeTab.id, name);
                              notify('ok', `에이전트 '${name}' 추가됨`);
                            },
                          })}
                        >+</button>
                      </div>
                    </div>

                    {/* 태그 */}
                    <div className="tags-inline">
                      {TAG_PRESETS.map(p => {
                        const on = activeTab.tags.includes(p.label);
                        return (
                          <button
                            key={p.label}
                            className={`tag-chip${on ? ' on' : ''}`}
                            style={{ color: on ? '#fff' : p.color, borderColor: p.color, background: on ? p.color : 'transparent' }}
                            title={`태그: ${p.label}`}
                            onClick={() => {
                              const next = on ? activeTab.tags.filter(t => t !== p.label) : [...activeTab.tags, p.label];
                              void updateTabTags(activeTab.id, next);
                            }}
                          >{p.label}</button>
                        );
                      })}
                    </div>

                    {/* 액션 버튼 */}
                    <div className="tab-actions">
                      <button className="btn" title="프롬프트 + 결과 모두 저장 (Ctrl+S)" onClick={() => void saveTabBoth(activeTab.id)}>모두 저장</button>
                      <button className="btn" title="현재 런 폴더 열기" disabled={!activeTab.folder} onClick={() => void must({ op: 'folder:open', folder: activeTab.folder })}>📂 폴더</button>
                      <button className="btn" title="런을 .md 파일로 내보내기" disabled={!activeTab.folder} onClick={() => void exportTabRun(activeTab.id)}>.md 내보내기</button>
                      <button className="btn" title="현재 탭에서 새 런 시작 (Ctrl+N)" onClick={() => void newRunInTab(activeTab.id)}>새 런</button>
                    </div>
                  </div>
                </div>
              )}

              {/* 편집 패널: 프롬프트 | 결과 */}
              {activeTab && (
                <div className="editor-panes">
                  {/* 프롬프트 */}
                  <div
                    className={`pane prompt${activeTab.promptDrag ? ' drag-over' : ''}`}
                    onDragOver={e => { e.preventDefault(); updateTab(activeTab.id, { promptDrag: true }); }}
                    onDragLeave={() => updateTab(activeTab.id, { promptDrag: false })}
                    onDrop={onDropFile(activeTab.id, 'prompt')}
                  >
                    <div className="panehead">
                      <span>📋 프롬프트</span>
                      <div className="paneacts">
                        <button
                          className={`mini${activeTab.promptPreview ? ' preview-on' : ''}`}
                          title={activeTab.promptPreview ? '원문으로 전환' : '마크다운 미리보기'}
                          onClick={() => updateTab(activeTab.id, { promptPreview: !activeTab.promptPreview })}
                        >{activeTab.promptPreview ? '원문' : '미리보기'}</button>
                        <button className="mini" title="클립보드에 복사" onClick={() => copyText(activeTab.prompt)}>복사</button>
                        <button className="mini" title="프롬프트만 저장" onClick={() => void saveTabPrompt(activeTab.id)}>저장</button>
                      </div>
                    </div>
                    {activeTab.promptPreview
                      ? <div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMd(activeTab.prompt) }} />
                      : <textarea
                          value={activeTab.prompt}
                          onChange={e => updateTab(activeTab.id, { prompt: e.target.value, promptSaved: false })}
                          placeholder={'# GPT에게 받은 다음 프롬프트를 여기에 붙여넣기\n# .md 파일을 드래그 앤 드롭할 수도 있습니다.'}
                          spellCheck={false}
                        />
                    }
                  </div>

                  {/* 결과 */}
                  <div
                    className={`pane result${activeTab.resultDrag ? ' drag-over' : ''}`}
                    onDragOver={e => { e.preventDefault(); updateTab(activeTab.id, { resultDrag: true }); }}
                    onDragLeave={() => updateTab(activeTab.id, { resultDrag: false })}
                    onDrop={onDropFile(activeTab.id, 'result')}
                  >
                    <div className="panehead">
                      <span>📊 결과 보고서</span>
                      <div className="paneacts">
                        {activeTab.resultSaved && activeTab.folder && (
                          <button
                            className="mini drag-chip"
                            draggable={false}
                            title="이 버튼을 누른 채 ChatGPT 입력창으로 끌어다 놓으세요 (result.md 첨부)"
                            onMouseDown={e => { e.preventDefault(); dragResultToGpt(activeTab); }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                void revealResult(activeTab);
                              }
                            }}
                          >📤 GPT로 드래그</button>
                        )}
                        {activeTab.resultSaved && activeTab.folder && (
                          <button
                            className="mini"
                            title="탐색기에서 result.md를 선택한 상태로 열기"
                            onClick={() => void revealResult(activeTab)}
                          >위치 열기</button>
                        )}
                        <button
                          className={`mini${activeTab.resultPreview ? ' preview-on' : ''}`}
                          title={activeTab.resultPreview ? '원문으로 전환' : '마크다운 미리보기'}
                          onClick={() => updateTab(activeTab.id, { resultPreview: !activeTab.resultPreview })}
                        >{activeTab.resultPreview ? '원문' : '미리보기'}</button>
                        <button className="mini" title="클립보드에 복사" onClick={() => copyText(activeTab.result)}>복사</button>
                        <button className="mini" title="결과만 저장" onClick={() => void saveTabResult(activeTab.id)}>저장</button>
                      </div>
                    </div>
                    {activeTab.resultPreview
                      ? <div className="md-preview" dangerouslySetInnerHTML={{ __html: renderMd(activeTab.result) }} />
                      : <textarea
                          value={activeTab.result}
                          onChange={e => updateTab(activeTab.id, { result: e.target.value, resultSaved: false })}
                          placeholder={'# 에이전트 실행 결과 보고서를 여기에 붙여넣기\n# .md 파일을 드래그 앤 드롭할 수도 있습니다.'}
                          spellCheck={false}
                        />
                    }
                  </div>
                </div>
              )}
            </div>
          </main>
            </>
          )}
        </>
      )}

      {showQuickDf && project && settings && (
        <QuickDogfood
          project={project}
          dataRoot={dataRoot}
          context={dfContext()}
          notify={notify}
          onClose={() => setShowQuickDf(false)}
          onSaved={() => {
            setDfMode(false);
            setPdMode(true);
            setPdRefreshSignal(n => n + 1);
          }}
        />
      )}

      {/* 설정 모달 — Storage / About(업데이트) */}
      {showSettings && settings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="modcard settings-card" onClick={e => e.stopPropagation()}>
            <h3>설정</h3>

            <div className="settings-section">
              <span className="flabel">Storage — Current Data Root</span>
              <div className="field" style={{ marginTop: 4 }}>
                <span className={`fvalue mono${settings.dataRoot ? '' : ' muted'}`} title={settings.dataRoot}>
                  {settings.dataRoot || '(저장공간이 선택되지 않았습니다)'}
                </span>
              </div>
              <div className="modalbtns" style={{ justifyContent: 'flex-start' }}>
                <button className="btn primary" onClick={() => void changeDataRoot()}>변경</button>
                <button
                  className="btn"
                  disabled={!settings.dataRoot}
                  title="저장공간 폴더를 탐색기로 열기"
                  onClick={() => { void must({ op: 'folder:open', folder: settings.dataRoot }); }}
                >폴더 열기</button>
              </div>
              <p className="muted" style={{ fontSize: 11, margin: '4px 0 0' }}>
                설정 파일: {settings.baseDir}\settings.json
              </p>
            </div>

            <div className="settings-section">
              <span className="flabel">About — Agent Relay v{updateStatus?.version ?? settings.appVersion}</span>
              <UpdateSection
                status={updateStatus ?? { phase: 'idle', version: settings.appVersion }}
                notify={notify}
                onOpen={() => undefined}
              />
            </div>

            <div className="modalbtns">
              <button className="btn subtle" onClick={() => setShowSettings(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 모달 */}
      {modal && (
        <div className="modal">
          <div className="modcard">
            <h3>{modal.title}</h3>
            <input autoFocus value={inputVal} onChange={e => setInputVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') modalOk(); if (e.key === 'Escape') setModal(null); }}
              placeholder={modal.placeholder}
            />
            <div className="modalbtns">
              <button className="btn" onClick={modalOk}>확인</button>
              <button className="btn subtle" onClick={() => setModal(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 확인 다이얼로그 */}
      {confirm && (
        <div className="modal">
          <div className="modcard">
            <h3>확인</h3>
            <p style={{ whiteSpace: 'pre-line' }}>{confirm.text}</p>
            <div className="modalbtns">
              <button className="btn" onClick={() => { const f = confirm.onOk; setConfirm(null); void f(); }}>
                {confirm.confirmBtn ?? '확인'}
              </button>
              <button className="btn subtle" onClick={() => setConfirm(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── 파일 트리 컴포넌트 ─────────────────────────────────────────────────────────
interface FileTreeProps {
  project: string;
  projects: ProjectInfo[];
  dataRoot: string;
  openProjectNames: Set<string>;
  onPickProject: (name: string) => void;
  onAddProject: () => void;
  tree: TreeDate[];
  search: string;
  onSearchChange: (v: string) => void;
  expandedKeys: Set<string>;
  onToggleKey: (key: string) => void;
  activeFolder: string;
  dragRun: HistoryItem | null;
  dropTarget: string | null;
  onDragStart: (h: HistoryItem) => void;
  onDragEnd: () => void;
  onDropOnAgent: (date: string, agent: string) => void;
  onSetDropTarget: (key: string | null) => void;
  onOpenRun: (h: HistoryItem) => void;
  onOpenInNewTab: (h: HistoryItem) => void;
  onDeleteRun: (h: HistoryItem) => void;
  onDeleteDate: (date: string) => void;
  onDeleteAgent: (date: string, agent: string) => void;
  onDeleteProject: (project: string) => void;
  noProject: boolean;
}

function FileTree({
  project, projects, dataRoot, openProjectNames,
  onPickProject, onAddProject,
  tree, search, onSearchChange, expandedKeys, onToggleKey,
  activeFolder, dragRun, dropTarget,
  onDragStart, onDragEnd, onDropOnAgent, onSetDropTarget,
  onOpenRun, onOpenInNewTab, onDeleteRun,
  onDeleteDate, onDeleteAgent, onDeleteProject, noProject,
}: FileTreeProps): React.ReactElement {

  const totalRuns = tree.reduce((s, d) => s + d.totalRuns, 0);

  function projLabel(name: string): string {
    if (name === ROOT_PROJECT) {
      const parts = dataRoot.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] ?? dataRoot;
    }
    return name;
  }

  return (
    <div className="filetree">
      {/* ── 프로젝트 사이드바 (다크) ── */}
      <div className="proj-sidebar">
        <span className="proj-sidebar-label">Projects</span>
        {projects.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--sb-muted)', padding: '4px 8px' }}>
            폴더를 선택하면<br />프로젝트가 표시됩니다
          </div>
        )}
        {projects.map(p => {
          const isActive = p.name === project;
          const isOpen = openProjectNames.has(p.name);
          return (
            <div
              key={p.name}
              className={`proj-item${isActive ? ' active' : ''}`}
              style={{ display: 'flex', alignItems: 'center' }}
              title={isOpen && !isActive ? `이미 열림 — 클릭하면 해당 탭으로 이동` : p.path}
            >
              <button
                style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0', minWidth: 0, textAlign: 'left' }}
                onClick={() => onPickProject(p.name)}
              >
                <span className={`proj-item-dot${isActive ? ' on' : isOpen ? ' open' : ' off'}`} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500, color: 'inherit' }}>
                  {projLabel(p.name)}
                </span>
              </button>
              {p.name !== ROOT_PROJECT && (
                <button
                  className="row-del"
                  title={`프로젝트 "${projLabel(p.name)}" 삭제`}
                  onClick={e => { e.stopPropagation(); onDeleteProject(p.name); }}
                >✕</button>
              )}
            </div>
          );
        })}
        <button className="proj-add" onClick={onAddProject} aria-label="새 프로젝트 추가">+ 새 프로젝트</button>
      </div>

      {/* 헤더 */}
      <div className="filetree-head">
        <span>📁 파일 트리</span>
        <span className="tree-badge">{project ? `${totalRuns}개 런` : ''}</span>
      </div>

      {/* 검색 */}
      <div className="hist-search-wrap">
        <input
          className="hist-search"
          placeholder="🔍 에이전트, 날짜, 태그..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
        />
        {search && <button className="mini" onClick={() => onSearchChange('')} title="검색 초기화">✕</button>}
      </div>

      {/* 트리 본문 */}
      <div className="filetree-body">
        {noProject && (
          <div className="muted" style={{ padding: '16px 10px', fontSize: 12, lineHeight: 1.6 }}>
            👆 프로젝트를 선택하거나<br />새로 만들면<br />파일 트리가 표시됩니다.
          </div>
        )}

        {!noProject && tree.length === 0 && (
          <div className="muted" style={{ padding: '16px 10px', fontSize: 12 }}>
            {search ? '검색 결과가 없습니다.' : '아직 저장된 런이 없습니다.\n프롬프트와 결과를 붙여넣고 저장해보세요!'}
          </div>
        )}

        {tree.map(dateNode => {
          const dateKey = `d:${dateNode.date}`;
          const dateOpen = expandedKeys.has(dateKey);

          return (
            <div key={dateNode.date} className="tree-section">
              {/* 날짜 행 */}
              <div className="tree-row tree-date" onClick={() => onToggleKey(dateKey)}>
                <span className="tree-chevron">{dateOpen ? '▾' : '▸'}</span>
                <span>📅 {dateNode.date}</span>
                <span className="tree-badge">{dateNode.totalRuns}개</span>
                <button
                  className="row-del"
                  title={`${dateNode.date} 날짜 전체 삭제 (런 ${dateNode.totalRuns}개)`}
                  onClick={e => { e.stopPropagation(); onDeleteDate(dateNode.date); }}
                >🗑</button>
              </div>

              {dateOpen && dateNode.agents.map(agentNode => {
                const agentKey = `a:${dateNode.date}:${agentNode.name}`;
                const agentOpen = expandedKeys.has(agentKey);
                const isDropTarget = dropTarget === agentKey;

                return (
                  <div key={agentNode.name}>
                    {/* 에이전트 행 */}
                    <div
                      className={`tree-row tree-agent${isDropTarget ? ' tree-drop-target' : ''}`}
                      onClick={() => onToggleKey(agentKey)}
                      onDragOver={e => { if (dragRun) { e.preventDefault(); onSetDropTarget(agentKey); } }}
                      onDragLeave={() => onSetDropTarget(null)}
                      onDrop={e => { e.preventDefault(); onDropOnAgent(dateNode.date, agentNode.name); }}
                      title={isDropTarget ? `여기에 놓으면 ${agentNode.name}으로 이동` : agentNode.name}
                    >
                      <span className="tree-chevron">{agentOpen ? '▾' : '▸'}</span>
                      <span>🤖 {agentNode.name}</span>
                      <span className="tree-badge">{agentNode.runs.length}</span>
                      <button
                        className="row-del"
                        title={`${agentNode.name} (${dateNode.date}) 폴더 삭제 (런 ${agentNode.runs.length}개)`}
                        onClick={e => { e.stopPropagation(); onDeleteAgent(dateNode.date, agentNode.name); }}
                      >🗑</button>
                    </div>

                    {agentOpen && agentNode.runs.map(run => {
                      const isActive = run.folder === activeFolder;
                      const histItem: HistoryItem = {
                        agent: agentNode.name,
                        date: dateNode.date,
                        run: run.run,
                        folder: run.folder,
                        hasPrompt: run.hasPrompt,
                        hasResult: run.hasResult,
                        tags: run.tags,
                      };

                      return (
                        <div
                          key={run.run}
                          className={`tree-run-row${isActive ? ' active' : ''}`}
                          draggable
                          onDragStart={() => onDragStart(histItem)}
                          onDragEnd={onDragEnd}
                          title={`${run.folder}\n${run.hasPrompt ? '· prompt.md\n' : ''}${run.hasResult ? '· result.md' : ''}\n더블클릭: 새 탭에서 열기`}
                        >
                          <button
                            className="tree-run-btn"
                            onClick={() => onOpenRun(histItem)}
                            onDoubleClick={() => onOpenInNewTab(histItem)}
                          >
                            <RunDot hasPrompt={run.hasPrompt} hasResult={run.hasResult} />
                            <span className="mono tree-run-num">#{run.run}</span>
                            {run.tags.length > 0 && (
                              <span className="tree-run-tags">
                                {run.tags.map(t => {
                                  const preset = TAG_PRESETS.find(p => p.label === t);
                                  return (
                                    <span key={t} className="hist-tag" style={{
                                      background: (preset?.color ?? '#8E8E93') + '22',
                                      color: preset?.color ?? '#8E8E93',
                                      border: `1px solid ${preset?.color ?? '#8E8E93'}55`,
                                    }}>{t}</span>
                                  );
                                })}
                              </span>
                            )}
                          </button>
                          <button
                            className="tree-del"
                            title="런 삭제"
                            onClick={e => { e.stopPropagation(); onDeleteRun(histItem); }}
                          >✕</button>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* 사용법 힌트 */}
      {!noProject && (
        <div className="filetree-hints">
          <div>클릭: 현재 탭에서 열기</div>
          <div>더블클릭: 새 탭에서 열기</div>
          <div>드래그: 에이전트 행에 놓으면 이동</div>
        </div>
      )}
    </div>
  );
}

// ── 업데이트 섹션 (설정 → About) ───────────────────────────────────────────────
// 정책: 확인/다운로드/설치 모두 사용자 클릭 기반. 자동 종료·자동 설치 없음.
function UpdateSection({ status, notify }: { status: UpdateStatus; notify: (kind: 'ok' | 'err' | 'info', text: string) => void; onOpen?: () => void }): React.ReactElement {
  async function run(op: 'update:check' | 'update:download' | 'update:install', okMsg?: string): Promise<void> {
    try {
      await must({ op });
      if (okMsg) notify('info', okMsg);
    } catch (e) {
      notify('err', e instanceof Error ? e.message : String(e));
    }
  }

  const line = ((): React.ReactNode => {
    switch (status.phase) {
      case 'idle':
        return <span className="muted">GitHub Releases에서 최신 버전을 확인할 수 있습니다.</span>;
      case 'checking':
        return <span className="muted">확인 중...</span>;
      case 'none':
        return (
          <span className="update-latest">
            ✔ 현재 최신 버전입니다. <span className="muted">(현재: v{status.version})</span>
          </span>
        );
      case 'available':
        return <span className="update-avail">새 버전 {status.nextVersion}이 있습니다.</span>;
      case 'downloading':
        return <span className="update-dl">다운로드 중... {status.percent ?? 0}%</span>;
      case 'ready':
        return <span className="update-ready">업데이트가 준비되었습니다.</span>;
      case 'error':
        return (
          <span className="update-err" title={status.errorMessage}>
            업데이트 확인 실패
            <span className="muted" style={{ display: 'block', fontSize: 11 }}>
              {(status.errorMessage ?? '').slice(0, 160)}
              {status.errorMessage && status.errorMessage.match(/40[134]|ENOTFOUND|ETIMEDOUT/) &&
                ' — Private 저장소는 공개 전환 전까지 앱 내 업데이트 확인이 제한될 수 있습니다.'}
            </span>
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <div className="update-row">
      {line}
      <div className="modalbtns" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
        {(status.phase === 'idle' || status.phase === 'none' || status.phase === 'error') && (
          <button className="btn" onClick={() => void run('update:check')}>
            업데이트 확인
          </button>
        )}
        {status.phase === 'available' && (
          <button className="btn primary" onClick={() => void run('update:download', '다운로드를 시작합니다.')}>
            다운로드 및 업데이트
          </button>
        )}
        {status.phase === 'downloading' && (
          <button className="btn" disabled>
            {status.percent ?? 0}%
          </button>
        )}
        {status.phase === 'ready' && (
          <button className="btn primary" onClick={() => void run('update:install')}>
            재시작하여 설치
          </button>
        )}
      </div>
    </div>
  );
}
