import React, { useEffect, useMemo, useRef, useState } from 'react';
import { must, hasBridge } from './bridge.js';
import { DataRootWidget, FieldSelect, FieldText } from './components.js';
import { renderMd } from './md.js';
import {
  DEFAULT_AGENTS,
  HistoryItem,
  ProjectInfo,
  ProjectViewData,
  RunFolderResult,
  SettingsView,
  TAG_PRESETS,
} from '../shared/types.js';

/** Local today string, YYYY-MM-DD. */
function todayLocal(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

interface ModalState {
  title: string;
  placeholder: string;
  onOk: (v: string) => void;
}

interface ConfirmState {
  text: string;
  confirmBtn?: string;
  onOk: () => void | Promise<void>;
}

export function App(): React.ReactElement {
  // ── core state ──────────────────────────────────────────────────────────────
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState('');
  const [agents, setAgents] = useState<string[]>([...DEFAULT_AGENTS]);
  const [agent, setAgent] = useState('Claude Code');
  const [date, setDate] = useState(todayLocal());
  const [run, setRun] = useState('');
  const [folder, setFolder] = useState('');
  const [promptText, setPromptText] = useState('');
  const [resultText, setResultText] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [inputVal, setInputVal] = useState('');

  // ── V1 feature state ────────────────────────────────────────────────────────
  const [promptPreview, setPromptPreview] = useState(false);
  const [resultPreview, setResultPreview] = useState(false);
  const [histSearch, setHistSearch] = useState('');
  const [promptDrag, setPromptDrag] = useState(false);
  const [resultDrag, setResultDrag] = useState(false);
  const [currentTags, setCurrentTags] = useState<string[]>([]);

  const dataRoot = settings?.dataRoot ?? '';

  // ── filtered history ─────────────────────────────────────────────────────────
  const filteredHistory = useMemo(() => {
    const q = histSearch.toLowerCase().trim();
    if (!q) return history;
    return history.filter(
      (h) =>
        h.agent.toLowerCase().includes(q) ||
        h.date.includes(q) ||
        h.run.includes(q) ||
        h.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [history, histSearch]);

  // ── notify ───────────────────────────────────────────────────────────────────
  function notify(kind: 'ok' | 'err' | 'info', text: string): void {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg({ kind, text });
    msgTimer.current = setTimeout(() => setMsg(null), kind === 'err' ? 6000 : 4000);
  }

  function dismissMsg(): void {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg(null);
  }

  // ── settings ─────────────────────────────────────────────────────────────────
  async function applySettings(s: SettingsView): Promise<void> {
    setSettings(s);
    setAgents([...DEFAULT_AGENTS, ...(s?.customAgents ?? [])]);
  }

  async function loadView(projectName: string): Promise<void> {
    if (!projectName || !dataRoot) return;
    const view = await must<ProjectViewData>({
      op: 'project:view',
      dataRoot,
      project: projectName,
    });
    setProjects(view.projects);
    setHistory(view.history);
  }

  /** Ensure the run folder exists. Returns the result so callers can use the
   *  folder path immediately — React state updates are asynchronous. */
  async function prepRunFor(p: string, a: string, d: string): Promise<RunFolderResult | null> {
    if (!p || !a || !d || !dataRoot) return null;
    const next = await must<string>({ op: 'run:next', dataRoot, project: p, date: d, agent: a });
    const res = await must<RunFolderResult>({
      op: 'run:ensureFolder',
      dataRoot,
      project: p,
      date: d,
      agent: a,
      run: next,
    });
    setRun(next);
    setFolder(res.folder);
    return res;
  }

  async function prepRun(): Promise<RunFolderResult | null> {
    return prepRunFor(project, agent, date);
  }

  async function pickProject(name: string): Promise<void> {
    if (!name) return;
    setProject(name);
    await loadView(name);
    await prepRunFor(name, agent, date);
  }

  async function pickAgent(name: string): Promise<void> {
    if (!name) return;
    setAgent(name);
    setPromptText('');
    setResultText('');
    setCurrentTags([]);
    await prepRunFor(project, name, date);
  }

  async function editDate(d: string): Promise<void> {
    if (!d) return;
    setDate(d);
    setPromptText('');
    setResultText('');
    setRun('');
    setFolder('');
    setCurrentTags([]);
    await prepRunFor(project, agent, d);
  }

  async function refreshHistory(): Promise<void> {
    if (project) await loadView(project);
  }

  async function openRun(h: HistoryItem): Promise<void> {
    const rec = await must<{ prompt: string; result: string; tags: string[] }>({
      op: 'run:read',
      folder: h.folder,
    });
    setAgent(h.agent);
    setDate(h.date);
    setRun(h.run);
    setFolder(h.folder);
    setPromptText(rec.prompt);
    setResultText(rec.result);
    setCurrentTags(rec.tags ?? []);
    setPromptPreview(false);
    setResultPreview(false);
    notify('info', `${h.folder} 불러옴`);
  }

  // ── save ─────────────────────────────────────────────────────────────────────
  async function savePrompt(overwrite: boolean): Promise<void> {
    if (!dataRoot) return;
    // folder 상태가 아직 비어 있으면 즉시 생성 후 반환값을 직접 사용한다.
    const activeFolder = folder || (await prepRun())?.folder || '';
    if (!activeFolder) {
      notify('err', 'Project / Agent / Date를 설정하세요.');
      return;
    }
    const activeRun = run || activeFolder.split(/[\\/]/).pop() || '';
    if (!/^\d+$/.test(activeRun)) {
      notify('err', `Run 번호가 올바르지 않습니다: ${activeRun}`);
      return;
    }
    try {
      await must({ op: 'prompt:save', folder: activeFolder, content: promptText, overwrite });
      notify('ok', `prompt.md 저장됨 — ${activeFolder}\\prompt.md`);
      await refreshHistory();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!overwrite && text.includes('이미 있어')) {
        setConfirm({
          text: 'prompt.md이 이미 존재합니다. 덮어쓸까요?',
          confirmBtn: '덮어쓰기',
          onOk: () => void savePrompt(true),
        });
        return;
      }
      notify('err', text);
    }
  }

  async function saveResult(overwrite: boolean): Promise<void> {
    if (!dataRoot) return;
    const activeFolder = folder || (await prepRun())?.folder || '';
    if (!activeFolder) {
      notify('err', 'Project / Agent / Date를 설정하세요.');
      return;
    }
    const activeRun = run || activeFolder.split(/[\\/]/).pop() || '';
    if (!/^\d+$/.test(activeRun)) {
      notify('err', `Run 번호가 올바르지 않습니다: ${activeRun}`);
      return;
    }
    try {
      await must({ op: 'result:save', folder: activeFolder, content: resultText, overwrite });
      notify('ok', `result.md 저장됨 — ${activeFolder}\\result.md`);
      await refreshHistory();
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!overwrite && text.includes('이미')) {
        setConfirm({
          text: 'result.md이 이미 존재합니다. 덮어쓸까요?',
          confirmBtn: '덮어쓰기',
          onOk: () => void saveResult(true),
        });
        return;
      }
      notify('err', text);
    }
  }

  async function newRun(): Promise<void> {
    setPromptText('');
    setResultText('');
    setCurrentTags([]);
    setPromptPreview(false);
    setResultPreview(false);
    await refreshHistory();
    await prepRun();
    notify('info', `다음 Run 준비됨 (${project}/${date}/${agent}/)`);
  }

  async function saveBoth(): Promise<void> {
    await savePrompt(false);
    await saveResult(false);
  }

  // ── V1: run deletion ─────────────────────────────────────────────────────────
  async function deleteRun(h: HistoryItem): Promise<void> {
    setConfirm({
      text: `Run #${h.run} (${h.agent} · ${h.date})를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`,
      confirmBtn: '삭제',
      onOk: async () => {
        await must({ op: 'run:delete', folder: h.folder });
        if (folder === h.folder) {
          setFolder('');
          setRun('');
          setPromptText('');
          setResultText('');
          setCurrentTags([]);
        }
        await refreshHistory();
        notify('ok', `Run #${h.run} 삭제됨`);
      },
    });
  }

  // ── V1: export run ───────────────────────────────────────────────────────────
  async function exportRunFile(): Promise<void> {
    if (!folder) { notify('err', '내보낼 런이 없습니다. Run을 먼저 열거나 저장하세요.'); return; }
    const res = await must<{ saved: boolean; filePath?: string }>({ op: 'run:export', folder });
    if (res.saved && res.filePath) notify('ok', `내보내기 완료: ${res.filePath}`);
  }

  // ── V1: tags ─────────────────────────────────────────────────────────────────
  async function updateTags(tags: string[]): Promise<void> {
    if (!folder) return;
    await must({ op: 'run:tagUpdate', folder, tags });
    setCurrentTags(tags);
    await refreshHistory();
  }

  // ── V1: drag & drop ──────────────────────────────────────────────────────────
  function onDropFile(pane: 'prompt' | 'result') {
    return (e: React.DragEvent): void => {
      e.preventDefault();
      if (pane === 'prompt') setPromptDrag(false);
      else setResultDrag(false);
      const file = e.dataTransfer.files[0];
      if (!file || !file.name.endsWith('.md')) {
        notify('err', '.md 파일만 드래그할 수 있습니다.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (pane === 'prompt') setPromptText(text);
        else setResultText(text);
        notify('info', `${file.name} 불러옴`);
      };
      reader.readAsText(file, 'utf-8');
    };
  }

  // ── V1: keyboard shortcuts ────────────────────────────────────────────────────
  // Use a ref so the event listener always calls the latest version of the function.
  const actionsRef = useRef({ saveBoth, newRun });
  actionsRef.current = { saveBoth, newRun };

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // Ctrl+S → Save Both
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 's') {
        e.preventDefault();
        void actionsRef.current.saveBoth();
      }
      // Ctrl+N → New Run
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'n') {
        e.preventDefault();
        void actionsRef.current.newRun();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── lifecycle ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      if (!hasBridge()) {
        notify('err', 'Electron IPC 브리지를 사용할 수 없습니다. 로컬 앱이 아닙니다.');
        return;
      }
      const s = await must<SettingsView>({ op: 'settings:get' });
      await applySettings(s);
    })();
  }, []);

  async function changeDataRoot(): Promise<void> {
    const pick = await must<{ selected: string | null }>({ op: 'folder:pick' });
    if (!pick.selected) return;
    const s = await must<SettingsView>({ op: 'settings:setDataRoot', path: pick.selected });
    await applySettings(s);
    setProject('');
    setHistory([]);
    notify('ok', `DATA_ROOT = ${s.dataRoot}`);
  }

  function modalOk(): void {
    if (!modal) return;
    const cb = modal.onOk;
    setModal(null);
    setInputVal('');
    cb(inputVal);
  }

  // ── render ────────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {!dataRoot && settings && (
        <div className="setup">
          <div className="setupcard">
            <h1>Agent Relay Log · V0</h1>
            <p>
              기록을 저장할 <code>DATA_ROOT</code> 폴더를 먼저 선택하세요.
              <br />
              예: <code>D:\AgentRelayLogs</code> — 아래에 <code>Projects/</code>가 생성됩니다.
            </p>
            <button className="btn primary" onClick={() => void changeDataRoot()}>
              데이터 폴더 선택
            </button>
          </div>
        </div>
      )}

      {dataRoot && (
        <>
          <header className="topbar">
            <div className="brand">Agent Relay Log · V0</div>
            <div className="topbar-shortcuts">
              <kbd>Ctrl+S</kbd> 저장
              <kbd>Ctrl+N</kbd> 새 런
            </div>
            <DataRootWidget
              settings={settings}
              onChanged={applySettings}
              onPick={() => void changeDataRoot()}
            />
          </header>

          <section className="fields">
            <FieldSelect
              label="Project"
              value={project}
              options={projects.map((p) => ({ value: p.name, label: p.name }))}
              onChange={(v) => void pickProject(v)}
              onAdd={() =>
                setModal({
                  title: '새 Project',
                  placeholder: 'Project 이름 (예: HERMESS)',
                  onOk: async (v) => {
                    const created = await must<ProjectInfo>({
                      op: 'projects:create',
                      dataRoot,
                      name: v,
                    });
                    await pickProject(created.name);
                    notify('ok', `Project '${created.name}' 생성됨`);
                  },
                })
              }
            />
            <FieldSelect
              label="Agent"
              value={agent}
              options={agents.map((a) => ({ value: a, label: a }))}
              onChange={(v) => void pickAgent(v)}
              onAdd={() =>
                setModal({
                  title: '새 에이전트',
                  placeholder: '에이전트 이름',
                  onOk: async (v) => {
                    const name = v.trim();
                    if (!name) return;
                    const newCustomAgents = await must<string[]>({ op: 'agents:add', name });
                    if (settings) setSettings({ ...settings, customAgents: newCustomAgents });
                    setAgents([...DEFAULT_AGENTS, ...newCustomAgents]);
                    await pickAgent(name);
                    notify('ok', `에이전트 '${name}' 추가됨`);
                  },
                })
              }
            />
            <FieldText label="Date (YYYY-MM-DD)" value={date} onChange={(v) => void editDate(v)} />
            <div className="field readonly">
              <span className="flabel">Run</span>
              <span className="fvalue mono">{run || '—'}</span>
            </div>
          </section>

          {msg && (
            <div className={`flash ${msg.kind}`}>
              <span>{msg.text}</span>
              <button className="flash-close" onClick={dismissMsg} title="닫기">✕</button>
            </div>
          )}

          {/* Tags row — visible once a run folder is set */}
          {folder && (
            <div className="tags-row">
              <span className="tags-label">태그</span>
              {TAG_PRESETS.map((p) => {
                const active = currentTags.includes(p.label);
                return (
                  <button
                    key={p.label}
                    className={`tag-chip${active ? ' on' : ''}`}
                    style={{
                      color: active ? '#fff' : p.color,
                      borderColor: p.color,
                      background: active ? p.color : 'transparent',
                    }}
                    onClick={() => {
                      const next = active
                        ? currentTags.filter((t) => t !== p.label)
                        : [...currentTags, p.label];
                      void updateTags(next);
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          )}

          <section className="actions">
            <button className="btn" onClick={() => void savePrompt(false)}>
              Save Prompt
            </button>
            <button className="btn" onClick={() => void saveResult(false)}>
              Save Result
            </button>
            <button className="btn" onClick={() => void saveBoth()}>
              Save Both
            </button>
            <span className="sep" />
            <button className="btn" onClick={() => copyText(promptText)}>Copy Prompt</button>
            <button className="btn" onClick={() => copyText(resultText)}>Copy Result</button>
            <span className="sep" />
            <button
              className="btn"
              disabled={!folder}
              onClick={() => void must({ op: 'folder:open', folder })}
            >
              Open Folder
            </button>
            <button className="btn" disabled={!folder} onClick={() => void exportRunFile()}>
              Export .md
            </button>
            <button className="btn" onClick={() => void newRun()}>
              New Run
            </button>
          </section>

          <main className="body">
            {/* ── Prompt pane ── */}
            <div
              className={`pane prompt${promptDrag ? ' drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setPromptDrag(true); }}
              onDragLeave={() => setPromptDrag(false)}
              onDrop={onDropFile('prompt')}
            >
              <div className="panehead">
                <span>PROMPT</span>
                <div className="paneacts">
                  <button
                    className={`mini${promptPreview ? ' preview-on' : ''}`}
                    onClick={() => setPromptPreview((v) => !v)}
                  >
                    {promptPreview ? 'Raw' : 'Preview'}
                  </button>
                  <button className="mini" onClick={() => copyText(promptText)}>Copy</button>
                  <button className="mini" onClick={() => void savePrompt(false)}>Save</button>
                </div>
              </div>
              {promptPreview ? (
                <div
                  className="md-preview"
                  dangerouslySetInnerHTML={{ __html: renderMd(promptText) }}
                />
              ) : (
                <textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  placeholder={'# 작업 Prompt를 여기에 붙여넣기\n# (또는 .md 파일을 드래그)'}
                  spellCheck={false}
                />
              )}
            </div>

            {/* ── Result pane ── */}
            <div
              className={`pane result${resultDrag ? ' drag-over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setResultDrag(true); }}
              onDragLeave={() => setResultDrag(false)}
              onDrop={onDropFile('result')}
            >
              <div className="panehead">
                <span>RESULT</span>
                <div className="paneacts">
                  <button
                    className={`mini${resultPreview ? ' preview-on' : ''}`}
                    onClick={() => setResultPreview((v) => !v)}
                  >
                    {resultPreview ? 'Raw' : 'Preview'}
                  </button>
                  <button className="mini" onClick={() => copyText(resultText)}>Copy</button>
                  <button className="mini" onClick={() => void saveResult(false)}>Save</button>
                </div>
              </div>
              {resultPreview ? (
                <div
                  className="md-preview"
                  dangerouslySetInnerHTML={{ __html: renderMd(resultText) }}
                />
              ) : (
                <textarea
                  value={resultText}
                  onChange={(e) => setResultText(e.target.value)}
                  placeholder={'# 작업 Result / 보고서를 여기에 붙여넣기\n# (또는 .md 파일을 드래그)'}
                  spellCheck={false}
                />
              )}
            </div>

            {/* ── History panel ── */}
            <aside className="history">
              <div className="histhead">
                <span>History{project ? ` · ${project}` : ''}</span>
                <button className="mini" onClick={() => void refreshHistory()}>
                  ♻ 새로고침
                </button>
              </div>

              {/* Search */}
              <div className="hist-search-wrap">
                <input
                  className="hist-search"
                  placeholder="🔍 에이전트, 날짜, 태그..."
                  value={histSearch}
                  onChange={(e) => setHistSearch(e.target.value)}
                />
                {histSearch && (
                  <button className="mini" onClick={() => setHistSearch('')} title="지우기">
                    ✕
                  </button>
                )}
              </div>

              {filteredHistory.length === 0 && (
                <div className="muted nohist">
                  {histSearch ? '검색 결과가 없습니다.' : '아직 기록이 없습니다.'}
                </div>
              )}

              <ul className="histlist">
                {filteredHistory.map((h) => (
                  <li key={`${h.date}|${h.agent}|${h.run}`}>
                    <div className="histrow-wrap">
                      <button
                        className="histrow"
                        onClick={() => void openRun(h)}
                        title={`${h.folder}\n${h.hasPrompt ? '· prompt.md\n' : ''}${h.hasResult ? '· result.md' : ''}`}
                      >
                        <span className="mono">
                          #{h.run} {h.agent}
                        </span>
                        <span className="histmarker">
                          {h.hasPrompt && h.hasResult ? '◉' : h.hasPrompt || h.hasResult ? '◐' : '○'}
                        </span>
                        <span className="hdate">{h.date}</span>
                      </button>
                      <button
                        className="hist-del"
                        title="Run 삭제"
                        onClick={(e) => { e.stopPropagation(); void deleteRun(h); }}
                      >
                        ✕
                      </button>
                    </div>
                    {h.tags.length > 0 && (
                      <div className="hist-tags">
                        {h.tags.map((t) => {
                          const preset = TAG_PRESETS.find((p) => p.label === t);
                          return (
                            <span
                              key={t}
                              className="hist-tag"
                              style={{
                                background: (preset?.color ?? '#8E8E93') + '22',
                                color: preset?.color ?? '#8E8E93',
                                border: `1px solid ${preset?.color ?? '#8E8E93'}55`,
                              }}
                            >
                              {t}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </aside>
          </main>
        </>
      )}

      {/* ── Modal (text input) ── */}
      {modal && (
        <div className="modal">
          <div className="modcard">
            <h3>{modal.title}</h3>
            <input
              autoFocus
              value={inputVal}
              onChange={(e) => setInputVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') modalOk();
                if (e.key === 'Escape') setModal(null);
              }}
              placeholder={modal.placeholder}
            />
            <div className="modalbtns">
              <button className="btn" onClick={modalOk}>확인</button>
              <button className="btn subtle" onClick={() => setModal(null)}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm dialog ── */}
      {confirm && (
        <div className="modal">
          <div className="modcard">
            <h3>확인</h3>
            <p style={{ whiteSpace: 'pre-line' }}>{confirm.text}</p>
            <div className="modalbtns">
              <button
                className="btn"
                onClick={() => {
                  const f = confirm.onOk;
                  setConfirm(null);
                  void f();
                }}
              >
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
