/**
 * Agent Relay Log V0 — 메인 UI
 *
 * 탭 기반 병렬 편집 + 파일 트리 + 한국어 UI
 */
import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { must, hasBridge } from './bridge.js';
import { DataRootWidget, FieldSelect, FieldText } from './components.js';
import { renderMd } from './md.js';
import {
  DEFAULT_AGENTS,
  HistoryItem,
  ProjectInfo,
  ProjectViewData,
  ROOT_PROJECT,
  RunFolderResult,
  SettingsView,
  TAG_PRESETS,
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

function runStatusIcon(r: { hasPrompt: boolean; hasResult: boolean }): string {
  return r.hasPrompt && r.hasResult ? '◉' : r.hasPrompt || r.hasResult ? '◐' : '○';
}

// ── 탭 타입 ──────────────────────────────────────────────────────────────────
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
}

let _tabCounter = 0;
function makeTab(agent = 'Claude Code'): EditorTab {
  return {
    id: `tab-${++_tabCounter}`,
    agent,
    run: '', folder: '', prompt: '', result: '', tags: [],
    promptPreview: false, resultPreview: false, promptDrag: false, resultDrag: false,
  };
}

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
      <div style={{ padding: 40, color: '#e06c5f', fontFamily: 'monospace' }}>
        <strong>렌더 오류</strong>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{this.state.err}</pre>
        <p style={{ color: '#8b8fa0', fontSize: 12 }}>DevTools → Console에서 자세한 내용을 확인하세요.</p>
      </div>
    );
    return this.props.children;
  }
}

// ── 최상위 App ────────────────────────────────────────────────────────────────
export function App(): React.ReactElement {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
function AppInner(): React.ReactElement {
  // 테마 (light / dark)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    return (localStorage.getItem('theme') as 'dark' | 'light') ?? 'dark';
  });
  function toggleTheme(): void {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
  }

  // 글로벌 상태
  const [loading, setLoading]       = useState(true);
  const [initError, setInitError]   = useState('');
  const [settings, setSettings]     = useState<SettingsView | null>(null);
  const [projects, setProjects]      = useState<ProjectInfo[]>([]);
  const [project, setProject]       = useState('');
  const [agents, setAgents]         = useState<string[]>([...DEFAULT_AGENTS]);
  const [date, setDate]             = useState(todayLocal());
  const [history, setHistory]       = useState<HistoryItem[]>([]);
  const [msg, setMsg]               = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [modal, setModal]           = useState<ModalState | null>(null);
  const [confirm, setConfirm]       = useState<ConfirmState | null>(null);
  const [inputVal, setInputVal]     = useState('');

  // 탭 상태
  const [tabs, setTabs]             = useState<EditorTab[]>([makeTab()]);
  const [activeTabId, setActiveTabId] = useState<string>('tab-1');

  // 트리 상태
  const [treeSearch, setTreeSearch] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [dragRun, setDragRun]       = useState<HistoryItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const dataRoot   = settings?.dataRoot ?? '';
  const activeTab  = tabs.find(t => t.id === activeTabId) ?? tabs[0];

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

  // 가장 최근 날짜 자동 펼침
  useEffect(() => {
    if (tree.length > 0) {
      const newest = tree[0];
      setExpandedKeys(prev => {
        const next = new Set(prev);
        next.add(`d:${newest.date}`);
        newest.agents.forEach(a => next.add(`a:${newest.date}:${a.name}`));
        return next;
      });
    }
  }, [tree.length > 0 ? tree[0].date : '']);

  // ── 탭 헬퍼 ─────────────────────────────────────────────────────────────────
  function updateTab(id: string, patch: Partial<EditorTab>): void {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t));
  }

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
    setAgents([...DEFAULT_AGENTS, ...(s.customAgents ?? [])]);
  }

  // ── 데이터 로드 ───────────────────────────────────────────────────────────────
  async function loadView(projectName: string): Promise<void> {
    if (!projectName || !dataRoot) return;
    const view = await must<ProjectViewData>({ op: 'project:view', dataRoot, project: projectName });
    setProjects(view.projects);
    setHistory(view.history);
  }
  async function refreshHistory(): Promise<void> { if (project) await loadView(project); }

  // ── 런 폴더 준비 ──────────────────────────────────────────────────────────────
  async function getNextRun(p: string, a: string, d: string): Promise<RunFolderResult | null> {
    if (!p || !a || !d || !dataRoot) return null;
    const next = await must<string>({ op: 'run:next', dataRoot, project: p, date: d, agent: a });
    return await must<RunFolderResult>({ op: 'run:ensureFolder', dataRoot, project: p, date: d, agent: a, run: next });
  }

  // ── 탭 추가 ─────────────────────────────────────────────────────────────────
  async function addTab(agentName?: string): Promise<void> {
    const agent = agentName ?? (activeTab?.agent ?? DEFAULT_AGENTS[0]);
    const tab = makeTab(agent);
    setTabs(prev => [...prev, tab]);
    setActiveTabId(tab.id);
    if (project && date) {
      const res = await getNextRun(project, agent, date);
      if (res) setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, ...res } : t));
    }
    notify('info', `새 탭 — ${agent}`);
  }

  // ── 탭 제거 ─────────────────────────────────────────────────────────────────
  function removeTab(id: string): void {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    const doRemove = (): void => {
      const next = tabs.filter(t => t.id !== id);
      if (next.length === 0) {
        const fresh = makeTab(tab.agent);
        setTabs([fresh]);
        setActiveTabId(fresh.id);
      } else {
        setTabs(next);
        if (activeTabId === id) setActiveTabId(next[next.length - 1].id);
      }
    };
    if (tab.prompt || tab.result) {
      setConfirm({ text: `탭 "${tab.agent} #${tab.run || '?'}"을 닫을까요?\n저장되지 않은 내용은 사라집니다.`, confirmBtn: '닫기', onOk: doRemove });
    } else {
      doRemove();
    }
  }

  // ── 탭에서 런 열기 ────────────────────────────────────────────────────────────
  async function openRunInTab(h: HistoryItem, tabId?: string): Promise<void> {
    const rec = await must<{ prompt: string; result: string; tags: string[] }>({ op: 'run:read', folder: h.folder });
    const tid = tabId ?? activeTabId;
    updateTab(tid, { agent: h.agent, run: h.run, folder: h.folder, prompt: rec.prompt, result: rec.result, tags: rec.tags ?? [], promptPreview: false, resultPreview: false });
    setExpandedKeys(prev => { const n = new Set(prev); n.add(`d:${h.date}`); n.add(`a:${h.date}:${h.agent}`); return n; });
    notify('info', `런 #${h.run} (${h.agent}) 불러옴`);
  }

  // ── 탭에서 새 런 ──────────────────────────────────────────────────────────────
  async function newRunInTab(tabId?: string): Promise<void> {
    const tid = tabId ?? activeTabId;
    const tab = tabs.find(t => t.id === tid);
    if (!tab) return;
    updateTab(tid, { prompt: '', result: '', tags: [], promptPreview: false, resultPreview: false, folder: '', run: '' });
    await refreshHistory();
    const res = await getNextRun(project, tab.agent, date);
    if (res) updateTab(tid, res);
    notify('info', `${tab.agent} — 새 런 준비됨`);
  }

  // ── 에이전트 변경 (탭 내) ─────────────────────────────────────────────────────
  async function changeTabAgent(tabId: string, agent: string): Promise<void> {
    updateTab(tabId, { agent, run: '', folder: '', prompt: '', result: '', tags: [] });
    const res = await getNextRun(project, agent, date);
    if (res) updateTab(tabId, res);
  }

  // ── 프롬프트 저장 ─────────────────────────────────────────────────────────────
  async function saveTabPrompt(tabId: string, overwrite = false): Promise<void> {
    let tab = tabs.find(t => t.id === tabId);
    if (!tab || !dataRoot) return;
    let folder = tab.folder;
    if (!folder) {
      if (!project) { notify('err', '프로젝트를 먼저 선택하세요.'); return; }
      const res = await getNextRun(project, tab.agent, date);
      if (!res) { notify('err', '런 폴더를 생성할 수 없습니다.'); return; }
      updateTab(tabId, res);
      folder = res.folder;
      tab = { ...tab, ...res };
    }
    try {
      await must({ op: 'prompt:save', folder, content: tab.prompt, overwrite });
      notify('ok', `프롬프트 저장됨 ← ${tab.agent} #${tab.run}`);
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
  async function saveTabResult(tabId: string, overwrite = false): Promise<void> {
    let tab = tabs.find(t => t.id === tabId);
    if (!tab || !dataRoot) return;
    let folder = tab.folder;
    if (!folder) {
      if (!project) { notify('err', '프로젝트를 먼저 선택하세요.'); return; }
      const res = await getNextRun(project, tab.agent, date);
      if (!res) { notify('err', '런 폴더를 생성할 수 없습니다.'); return; }
      updateTab(tabId, res);
      folder = res.folder;
      tab = { ...tab, ...res };
    }
    try {
      await must({ op: 'result:save', folder, content: tab.result, overwrite });
      notify('ok', `결과 저장됨 ← ${tab.agent} #${tab.run}`);
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
    await saveTabPrompt(tabId);
    await saveTabResult(tabId);
  }

  // ── 태그 ─────────────────────────────────────────────────────────────────────
  async function updateTabTags(tabId: string, tags: string[]): Promise<void> {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab?.folder) return;
    await must({ op: 'run:tagUpdate', folder: tab.folder, tags });
    updateTab(tabId, { tags });
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
        // 열려있는 탭에서 이 런을 사용 중이면 초기화
        setTabs(prev => prev.map(t => t.folder === h.folder ? { ...t, folder: '', run: '', prompt: '', result: '', tags: [] } : t));
        await refreshHistory();
        notify('ok', `런 #${h.run} 삭제됨`);
      },
    });
  }

  // ── 트리 런 이동 (드래그 앤 드롭) ────────────────────────────────────────────
  async function moveRunToAgent(h: HistoryItem, toDate: string, toAgent: string): Promise<void> {
    if (!dataRoot || !project) return;
    if (h.date === toDate && h.agent === toAgent) return;
    const res = await must<{ folder: string }>({ op: 'run:move', fromFolder: h.folder, dataRoot, project, toDate, toAgent });
    // 탭에서 해당 런이 열려있으면 업데이트
    const parts = res.folder.replace(/\\/g, '/').split('/');
    const newRun = parts[parts.length - 1] ?? '';
    setTabs(prev => prev.map(t => t.folder === h.folder ? { ...t, folder: res.folder, run: newRun, agent: toAgent } : t));
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
        updateTab(tabId, pane === 'prompt' ? { prompt: text } : { result: text });
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

  // ── 초기화 ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        if (!hasBridge()) { setInitError('Electron IPC 브리지를 사용할 수 없습니다.\nexe 파일을 직접 실행하세요.'); setLoading(false); return; }
        const s = await must<SettingsView>({ op: 'settings:get' });
        await applySettings(s);
      } catch (e) {
        setInitError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ── 프로젝트 선택 ─────────────────────────────────────────────────────────────
  async function pickProject(name: string): Promise<void> {
    if (!name) return;
    setProject(name);
    await loadView(name);
    // 모든 탭에 대해 런 폴더 준비
    for (const tab of tabs) {
      const res = await getNextRun(name, tab.agent, date);
      if (res) updateTab(tab.id, res);
    }
  }

  async function editDate(d: string): Promise<void> {
    if (!d) return;
    setDate(d);
    for (const tab of tabs) {
      updateTab(tab.id, { run: '', folder: '', prompt: '', result: '', tags: [] });
      if (project) {
        const res = await getNextRun(project, tab.agent, d);
        if (res) updateTab(tab.id, res);
      }
    }
  }

  async function changeDataRoot(): Promise<void> {
    const pick = await must<{ selected: string | null }>({ op: 'folder:pick' });
    if (!pick.selected) return;
    const s = await must<SettingsView>({ op: 'settings:setDataRoot', path: pick.selected });
    await applySettings(s);
    setProject(''); setHistory([]);
    notify('ok', `데이터 폴더 설정됨: ${s.dataRoot}`);
    // 설정 후 프로젝트 목록 로드하여 자동 선택
    try {
      const view = await must<ProjectViewData>({ op: 'project:view', dataRoot: s.dataRoot, project: ROOT_PROJECT });
      setProjects(view.projects);
      // 루트 폴더에 기존 데이터가 있으면 자동으로 루트 프로젝트 선택
      if (view.projects.some(p => p.name === ROOT_PROJECT) && view.history.length > 0) {
        setProject(ROOT_PROJECT);
        setHistory(view.history);
        for (const tab of tabs) {
          const res = await getNextRun(s.dataRoot, tab.agent, date);
          if (res) updateTab(tab.id, res);
        }
        notify('ok', `기존 런 ${view.history.length}개를 발견했습니다.`);
      }
    } catch { /* 오류 무시 */ }
  }

  function modalOk(): void {
    if (!modal) return;
    const cb = modal.onOk;
    setModal(null); setInputVal(''); cb(inputVal);
  }

  // ── 로딩 / 오류 화면 ──────────────────────────────────────────────────────────
  if (loading) return (
    <div className="app splash">
      <div className="splash-inner">
        <div className="splash-logo">Agent Relay Log · V0</div>
        <div className="splash-spin" />
        <div className="splash-hint">설정을 불러오는 중...</div>
      </div>
    </div>
  );
  if (initError) return (
    <div className="app splash">
      <div className="splash-inner">
        <div className="splash-logo">Agent Relay Log · V0</div>
        <div className="splash-err">{initError}</div>
        <p style={{ color: '#8b8fa0', fontSize: 12, marginTop: 8 }}>DevTools (F12) → Console에서 자세한 내용을 확인하세요.</p>
      </div>
    </div>
  );

  // ── 렌더 ──────────────────────────────────────────────────────────────────────
  return (
    <div className="app" data-theme={theme}>
      {/* 데이터폴더 미설정 화면 */}
      {!dataRoot && settings && (
        <div className="setup">
          <div className="setupcard">
            <h1>Agent Relay Log · V0</h1>
            <p>
              GPT → 에이전트 작업 결과를 체계적으로 기록하는 툴입니다.<br /><br />
              기록을 저장할 <code>데이터 폴더</code>를 먼저 선택하세요.<br />
              예: <code>D:\AgentRelayLogs</code> — 안에 <code>Projects/</code> 폴더가 자동 생성됩니다.
            </p>
            <button className="btn primary" onClick={() => void changeDataRoot()}>
              📁 데이터 폴더 선택
            </button>
          </div>
        </div>
      )}

      {dataRoot && (
        <>
          {/* 상단바 */}
          <header className="topbar">
            <div className="brand">Agent Relay Log · <span style={{ color: 'var(--muted)' }}>V0</span></div>
            <div className="topbar-shortcuts">
              <span title="모두 저장"><kbd>Ctrl+S</kbd> 저장</span>
              <span title="현재 탭 새 런"><kbd>Ctrl+N</kbd> 새 런</span>
              <span title="병렬 탭 추가"><kbd>Ctrl+T</kbd> 새 탭</span>
            </div>
            <button
              className="mini theme-toggle"
              title={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
              onClick={toggleTheme}
            >{theme === 'dark' ? '☀️' : '🌙'}</button>
            <DataRootWidget settings={settings} onChanged={applySettings} onPick={() => void changeDataRoot()} />
          </header>

          {/* 글로벌 필드 (프로젝트, 날짜) */}
          <section className="fields">
            <FieldSelect
              label="프로젝트"
              value={project}
              options={projects.map(p => ({ value: p.name, label: projectLabel(p.name) }))}
              onChange={v => void pickProject(v)}
              onAdd={() => setModal({
                title: '새 프로젝트',
                placeholder: '프로젝트 이름 (예: HERMESS)',
                onOk: async v => {
                  const created = await must<ProjectInfo>({ op: 'projects:create', dataRoot, name: v });
                  await pickProject(created.name);
                  notify('ok', `프로젝트 '${created.name}' 생성됨`);
                },
              })}
            />
            <FieldText label="날짜 (YYYY-MM-DD)" value={date} onChange={v => void editDate(v)} />
            <div className="field breadcrumb-field">
              <span className="flabel">저장 위치</span>
              <span className="fvalue breadcrumb mono">
                {project
                  ? `${project === ROOT_PROJECT ? '📂' : '📁'} ${projectLabel(project)} / 📅 ${date} / 🤖 ${activeTab?.agent ?? '?'} / 런 #${activeTab?.run || '?'}`
                  : '← 프로젝트를 선택하거나, 폴더를 새로 고르세요'}
              </span>
            </div>
          </section>

          {/* 알림 플래시 */}
          {msg && (
            <div className={`flash ${msg.kind}`}>
              <span>{msg.text}</span>
              <button className="flash-close" onClick={dismissMsg} title="닫기">✕</button>
            </div>
          )}

          {/* 메인 바디: 트리 | 편집 영역 */}
          <main className="body">
            {/* ── 파일 트리 패널 ── */}
            <FileTree
              project={project}
              tree={tree}
              search={treeSearch}
              onSearchChange={setTreeSearch}
              expandedKeys={expandedKeys}
              onToggleKey={key => setExpandedKeys(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; })}
              activeFolder={activeTab?.folder ?? ''}
              dragRun={dragRun}
              dropTarget={dropTarget}
              onDragStart={h => setDragRun(h)}
              onDragEnd={() => { setDragRun(null); setDropTarget(null); }}
              onDropOnAgent={(date, agent) => { if (dragRun) void moveRunToAgent(dragRun, date, agent); setDragRun(null); setDropTarget(null); }}
              onSetDropTarget={setDropTarget}
              onOpenRun={h => void openRunInTab(h)}
              onOpenInNewTab={h => { void addTab(h.agent).then(() => void openRunInTab(h, tabs[tabs.length]?.id)); }}
              onDeleteRun={h => void deleteHistoryRun(h)}
              noProject={!project}
            />

            {/* ── 편집 영역 ── */}
            <div className="editor-area">
              {/* 탭 바 */}
              <div className="tab-bar">
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    className={`tab-btn${tab.id === activeTabId ? ' active' : ''}`}
                    onClick={() => setActiveTabId(tab.id)}
                    title={tab.folder || `${tab.agent} — 아직 저장 안 됨`}
                  >
                    <span className="tab-agent">{tab.agent}</span>
                    {tab.run && <span className="tab-run mono">#{tab.run}</span>}
                    {(tab.prompt || tab.result) && <span className="tab-dot" title="저장되지 않은 내용 있음">●</span>}
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
                >
                  + 새 탭
                </button>
              </div>

              {/* 탭 헤더: 에이전트 선택 + 태그 + 액션 */}
              {activeTab && (
                <div className="tab-header">
                  <div className="tab-header-row">
                    <div className="field" style={{ minWidth: 0 }}>
                      <span className="flabel">에이전트</span>
                      <span className="fgrow">
                        <select
                          value={activeTab.agent}
                          onChange={e => void changeTabAgent(activeTab.id, e.target.value)}
                        >
                          {agents.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                        <button
                          className="mini add"
                          title="에이전트 추가"
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
                      </span>
                    </div>
                    <div className="field readonly" style={{ minWidth: 60 }}>
                      <span className="flabel">런</span>
                      <span className="fvalue mono">{activeTab.run || '—'}</span>
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
                          onChange={e => updateTab(activeTab.id, { prompt: e.target.value })}
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
                          onChange={e => updateTab(activeTab.id, { result: e.target.value })}
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
  noProject: boolean;
}

function FileTree({
  project, tree, search, onSearchChange, expandedKeys, onToggleKey,
  activeFolder, dragRun, dropTarget,
  onDragStart, onDragEnd, onDropOnAgent, onSetDropTarget,
  onOpenRun, onOpenInNewTab, onDeleteRun, noProject,
}: FileTreeProps): React.ReactElement {

  const totalRuns = tree.reduce((s, d) => s + d.totalRuns, 0);

  return (
    <div className="filetree">
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
              <div
                className="tree-row tree-date"
                onClick={() => onToggleKey(dateKey)}
              >
                <span className="tree-chevron">{dateOpen ? '▾' : '▸'}</span>
                <span>📅 {dateNode.date}</span>
                <span className="tree-badge">{dateNode.totalRuns}개</span>
              </div>

              {dateOpen && dateNode.agents.map(agentNode => {
                const agentKey = `a:${dateNode.date}:${agentNode.name}`;
                const agentOpen = expandedKeys.has(agentKey);
                const isDropTarget = dropTarget === agentKey;

                return (
                  <div key={agentNode.name}>
                    {/* 에이전트 행 (드롭 대상) */}
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
                    </div>

                    {agentOpen && agentNode.runs.map(run => {
                      const isActive = run.folder === activeFolder;
                      // HistoryItem 형태로 변환
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
                            <span className="tree-run-status">{runStatusIcon(run)}</span>
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
