import React, { useEffect, useMemo, useState } from 'react';
import { must } from './bridge.js';
import { PROJECT_LABELS } from '../shared/projectLabels.js';
import { isPlanStudioTaskDone, sortPlanStudioTasks } from '../shared/types.js';
import { InlineConfirm } from './components.js';

const FLOW = ['계획', '확인', '작업', '검수', '시험', '사람 확인', '반영'] as const;

interface BoardLane {
  id?: string;
  project?: string;
  current?: { stage?: number | string; taskId?: string; worker?: unknown; qa?: unknown; [key: string]: unknown };
  workerChain?: unknown;
  qaChain?: unknown;
  holds?: Array<{ taskId?: string; reason?: string } | string>;
  humanGate?: Record<string, unknown>;
  founderGate?: Record<string, unknown>;
  blocker?: string;
  [key: string]: unknown;
}

interface StudioTask {
  id: string;
  title: string;
  scope: string;
  registered: boolean;
  stage: number | string;
  agents: string;
  blocker: string;
  expectedRisk: string;
  completedAt: string;
}

interface StudioGate {
  gateId: string;
  title: string;
  options: string[];
}

interface StudioDraft {
  goal: string;
  tasks: StudioTask[];
  runPolicy: 'continue' | 'stop';
}

const EMPTY_DRAFT: StudioDraft = { goal: '', tasks: [], runPolicy: 'continue' };

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function label(value: unknown, fallback = '—'): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function projectPresentation(project: string, lane?: BoardLane): { name: string; goal: string } {
  const known = PROJECT_LABELS[project];
  const current = lane?.current ?? {};
  return {
    name: known?.name ?? label(project, '알 수 없는 프로젝트'),
    goal: label(lane?.goal ?? lane?.summary ?? current.goal ?? current.summary, known?.goal ?? '현재 작업 목표를 확인하세요.'),
  };
}

function rawText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isNegatedDoneValue(value: string): boolean {
  const stripped = value.replace(/[\s_\-]+/g, '');
  return stripped.includes('UNDONE')
    || stripped.includes('NOTDONE')
    || stripped.includes('INCOMPLETE')
    || stripped.includes('NOTCOMPLETE')
    || stripped.includes('NONDONE')
    || stripped.includes('NONCOMPLETE')
    || stripped.includes('UNCOMPLETE')
    || stripped.includes('NOTINTEGRATED')
    || stripped.includes('NOTVERIFIED');
}

function stageIndex(stage: number | string): number {
  if (typeof stage === 'number' && Number.isFinite(stage)) return Math.max(0, Math.min(FLOW.length - 1, stage));
  const value = String(stage).toUpperCase();
  if (!isNegatedDoneValue(value) && (value.includes('INTEGR') || value.includes('통합') || value.includes('반영') || value.includes('DONE') || value.includes('COMPLETE'))) return 6;
  if (value.includes('HUMAN') || value.includes('FOUNDER') || value.includes('사람 확인')) return 5;
  if (value.includes('GATE') || value.includes('시험')) return 4;
  if (value.includes('QA') || value.includes('검수')) return 3;
  if (value.includes('WORKER') || value.includes('BUILDER') || value.includes('작업')) return 2;
  if (value.includes('VERIF') || value.includes('VALID') || value.includes('검증') || value.includes('확인')) return 1;
  return 0;
}

function formatDoneDate(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.trim();
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return text;
}

function doneLabel(task: StudioTask): string {
  const date = formatDoneDate(task.completedAt);
  return date ? `완료 · ${date}` : '완료';
}

function agentsText(record: Record<string, unknown>): string {
  const direct = record.agents ?? record.owner ?? record.assignee;
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (Array.isArray(direct)) return direct.map(v => str(v)).filter(Boolean).join(', ');
  const parts = [record.worker, record.qa].map(v => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      return str(r.name ?? r.id ?? r.state ?? r.status);
    }
    return '';
  }).filter(Boolean);
  return parts.join(' → ');
}

function unwrapDraft(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  for (const key of ['draft', 'roadmap', 'plan', 'data']) {
    const inner = root[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as Record<string, unknown>;
  }
  return root;
}

function toTask(item: unknown, index: number): StudioTask {
  const fallbackId = `task-${index + 1}`;
  if (typeof item === 'string') {
    return { id: fallbackId, title: item, scope: item, registered: false, stage: 0, agents: '', blocker: '', expectedRisk: '', completedAt: '' };
  }
  if (!item || typeof item !== 'object') {
    return { id: fallbackId, title: fallbackId, scope: fallbackId, registered: false, stage: 0, agents: '', blocker: '', expectedRisk: '', completedAt: '' };
  }
  const r = item as Record<string, unknown>;
  const taskId = str(r.taskId ?? r.task_id);
  const id = taskId || str(r.id ?? r.key, fallbackId);
  const title = str(r.title ?? r.name ?? r.label ?? r.taskId ?? r.id, id);
  const scope = str(r.scope ?? r.description, title);
  const stage = (r.stage ?? r.status ?? r.state ?? r.step ?? r.phase ?? 0) as number | string;
  const blocker = str(r.blocker ?? r.blockedReason ?? r.holdReason);
  const expectedRisk = str(r.expectedRisk ?? r.risk ?? r.expected_risk ?? r.danger);
  const completedAt = str(
    r.completedAt ?? r.completed_at ?? r.doneAt ?? r.done_at ?? r.finishedAt ?? r.finished_at
    ?? r.closedAt ?? r.closed_at ?? r.verifiedAt ?? r.updatedAt ?? r.updated_at ?? r.date,
  );
  return { id, title, scope, registered: Boolean(taskId), stage, agents: agentsText(r), blocker, expectedRisk, completedAt };
}

export function toRoadmapPayload(draft: StudioDraft): { goal: string; policy: 'continue' | 'stop'; tasks: Array<{ taskId: string; title: string; scope: string }> } {
  return {
    goal: draft.goal,
    policy: draft.runPolicy,
    tasks: draft.tasks.filter(task => !task.registered).slice(0, 12).map(task => ({
      taskId: task.id,
      title: task.title,
      scope: task.scope || task.title,
    })),
  };
}

function normalizeDraft(raw: unknown): StudioDraft {
  const root = unwrapDraft(raw);
  const goal = str(root.goal ?? root.title ?? root.objective ?? root.summary ?? root.description);
  const rawTasks = root.tasks ?? root.lanes ?? root.steps ?? root.items ?? root.chain;
  const tasks = Array.isArray(rawTasks) ? rawTasks.map((t, i) => toTask(t, i)) : [];
  const policyRaw = str(root.runPolicy ?? root.run_policy ?? root.policy ?? root.mode).toLowerCase();
  const runPolicy: 'continue' | 'stop' = /stop|pause|manual|hold|step/.test(policyRaw) ? 'stop' : 'continue';
  return { goal, tasks, runPolicy };
}

function normalizeGates(raw: unknown): StudioGate[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object'
    ? ((raw as Record<string, unknown>).gates as unknown)
    : [];
  if (!Array.isArray(list)) return [];
  const out: StudioGate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const gateId = str(r.gateId ?? r.id ?? r.gate_id);
    if (!gateId) continue;
    const title = str(r.ask ?? r.title ?? r.question ?? r.summary, gateId);
    const rawOptions = r.options ?? r.choices ?? r.candidates;
    const options = Array.isArray(rawOptions)
      ? rawOptions.map(o => typeof o === 'string' ? o : label((o as Record<string, unknown>)?.label ?? (o as Record<string, unknown>)?.title, '')).filter(Boolean)
      : [];
    out.push({ gateId, title, options: options.length ? options : ['승인', '반려'] });
  }
  return out;
}

function gateFromLane(lane: BoardLane | undefined): StudioGate | null {
  if (!lane) return null;
  const gate = lane.humanGate ?? lane.founderGate;
  if (!gate || typeof gate !== 'object') return null;
  const gateId = str(gate.gateId ?? gate.id);
  if (!gateId) return null;
  const title = str(gate.ask ?? gate.title ?? gate.question, '사람 확인이 필요해요.');
  const rawOptions = gate.options ?? gate.choices;
  const options = Array.isArray(rawOptions) ? rawOptions.map(o => label(o)).filter(o => o !== '—') : [];
  return { gateId, title, options: options.length ? options : ['승인', '반려'] };
}

export function PlanStudio({ onClose, initialProject }: { onClose: () => void; initialProject?: string }): React.ReactElement {
  const [lanes, setLanes] = useState<BoardLane[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState(initialProject ?? 'agent-relay');
  const [draft, setDraft] = useState<StudioDraft>(EMPTY_DRAFT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chat, setChat] = useState('');
  const [gates, setGates] = useState<StudioGate[]>([]);
  const [gatePick, setGatePick] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'chat' | 'save' | 'approve' | 'gate' | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingApprove, setPendingApprove] = useState(false);
  const [pendingPolicy, setPendingPolicy] = useState<'continue' | 'stop' | null>(null);
  const [lastDeleted, setLastDeleted] = useState<{ task: StudioTask; index: number } | null>(null);
  const [draftLoadError, setDraftLoadError] = useState(false);
  const [draftLoadAttempt, setDraftLoadAttempt] = useState(0);

  // Board polling — task progress rows are fed by controlRoom:board.
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void must<{ lanes?: BoardLane[] }>({ op: 'controlRoom:board' }).then(next => {
        if (!alive) return;
        const nextLanes = Array.isArray(next?.lanes) ? next.lanes : [];
        setLanes(nextLanes);
        const names = [...new Set(nextLanes.map(l => str(l.project ?? l.id)).filter(Boolean))];
        setProjects(names);
        setProject(prev => {
          if (prev && names.includes(prev)) return prev;
          if (initialProject && names.includes(initialProject)) return initialProject;
          return names[0] ?? prev;
        });
      }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [initialProject]);

  // Draft + gates load per project.
  useEffect(() => {
    if (!project) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError('');
    setDraftLoadError(false);
    void must<unknown>({ op: 'planStudio:get', project }).then(raw => {
      if (!alive) return;
      const next = normalizeDraft(raw);
      setDraft(next);
      setSelectedId(prev => (prev && next.tasks.some(t => t.id === prev) ? prev : next.tasks[0]?.id ?? null));
    }).catch(() => {
      if (alive) { setDraft(EMPTY_DRAFT); setDraftLoadError(true); }
    }).finally(() => { if (alive) setLoading(false); });
    void must<unknown>({ op: 'gates:list' }).then(raw => {
      if (alive) setGates(normalizeGates(raw));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [project, draftLoadAttempt]);

  const boardStageByTask = useMemo(() => {
    const map = new Map<string, number | string>();
    for (const lane of lanes) {
      const stage = lane.current?.stage ?? 0;
      const keys = [str(lane.current?.taskId), str(lane.id)].filter(Boolean);
      for (const key of keys) if (!map.has(key)) map.set(key, stage as number | string);
    }
    return map;
  }, [lanes]);

  // Draft tasks merged with live board stages; board-only tasks fill gaps.
  // Founder view: 진행중/대기 먼저, HOLD 다음, 끝난 작업 마지막.
  const tasks = useMemo<StudioTask[]>(() => {
    if (draftLoadError) return [];
    const merged = draft.tasks.map(t => ({ ...t, stage: boardStageByTask.get(t.id) ?? boardStageByTask.get(t.title) ?? t.stage }));
    if (merged.length > 0) return sortPlanStudioTasks(merged);
    const seen = new Set<string>();
    const derived: StudioTask[] = [];
    for (const lane of lanes) {
      if (project && str(lane.project ?? lane.id) !== project && lanes.some(l => str(l.project ?? l.id) === project)) continue;
      const id = str(lane.current?.taskId ?? lane.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      derived.push({
        id,
        title: id,
        scope: id,
        registered: true,
        stage: (lane.current?.stage ?? 0) as number | string,
        agents: agentsText({ worker: lane.workerChain ?? lane.current?.worker, qa: lane.qaChain ?? lane.current?.qa }),
        blocker: str(lane.blocker),
        expectedRisk: '',
        completedAt: '',
      });
    }
    return sortPlanStudioTasks(derived);
  }, [draft.tasks, boardStageByTask, lanes, project, draftLoadError]);

  const finishedCount = useMemo(() => tasks.filter(isPlanStudioTaskDone).length, [tasks]);
  const remainingCount = tasks.length - finishedCount;
  const visibleTasks = useMemo(
    () => (showDone ? tasks : tasks.filter(t => !isPlanStudioTaskDone(t))),
    [tasks, showDone],
  );

  const selected = tasks.find(t => t.id === selectedId) ?? tasks[0] ?? null;
  const projectLane = lanes.find(l => str(l.project ?? l.id) === project);
  const presentation = projectPresentation(project, projectLane);
  const activeLane = useMemo(
    () => lanes.find(l => str(l.current?.taskId ?? l.id) === (selected?.id ?? '') || str(l.current?.taskId ?? l.id) === (selected?.title ?? '')),
    [lanes, selected],
  );
  const laneGate = gateFromLane(activeLane ?? lanes.find(l => str(l.project ?? l.id) === project));
  const visibleGates = gates.length ? gates : laneGate ? [laneGate] : [];

  function flashInfo(text: string): void {
    setInfo(text);
    setError('');
  }

  function flashError(e: unknown): void {
    setError(e instanceof Error ? e.message : String(e));
  }

  async function persist(next: StudioDraft, what: 'chat' | 'save' | 'approve' | 'gate'): Promise<void> {
    setBusy(what);
    try {
      const payload = JSON.stringify(toRoadmapPayload(next));
      await must({ op: 'planStudio:save', project, draft: payload });
      setDraft(next);
      flashInfo('초안 저장됨');
    } catch (e) { flashError(e); } finally { setBusy(null); }
  }

  function isNotStarted(task: StudioTask): boolean {
    return stageIndex(boardStageByTask.get(task.id) ?? boardStageByTask.get(task.title) ?? task.stage) === 0;
  }

  async function sendChat(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const message = chat.trim();
    if (!message || busy) return;
    setBusy('chat');
    try {
      const reply = await must<unknown>({ op: 'planStudio:chat', project, message });
      const candidate = normalizeDraft(reply);
      if (candidate.tasks.length || candidate.goal) {
        setDraft(candidate);
        setSelectedId(prev => (prev && candidate.tasks.some(t => t.id === prev) ? prev : candidate.tasks[0]?.id ?? null));
        flashInfo('PM 초안이 갱신되었습니다');
      } else {
        const fresh = await must<unknown>({ op: 'planStudio:get', project });
        const next = normalizeDraft(fresh);
        setDraft(next);
        flashInfo('PM 답변 반영 후 초안을 다시 읽었습니다');
      }
      setChat('');
    } catch (err) { flashError(err); } finally { setBusy(null); }
  }

  async function approve(): Promise<void> {
    setBusy('approve');
    try {
      await must({ op: 'planStudio:approve', project });
      flashInfo('계획 승인 → 자동 진행 요청됨');
    } catch (e) { flashError(e); } finally { setBusy(null); setPendingApprove(false); }
  }

  async function answerGate(gateId: string): Promise<void> {
    const optionIndex = gatePick[gateId] ?? 0;
    setBusy('gate');
    try {
      await must({ op: 'gates:answer', gateId, optionIndex });
      flashInfo('응답 제출됨');
    } catch (e) { flashError(e); } finally { setBusy(null); }
  }

  function requestDelete(task: StudioTask): void {
    setLastDeleted(null);
    setPendingDeleteId(task.id);
  }

  function confirmDelete(task: StudioTask): void {
    const index = draft.tasks.findIndex(t => t.id === task.id);
    const target = draft.tasks[index] ?? task;
    const at = index >= 0 ? index : draft.tasks.length;
    const next = { ...draft, tasks: draft.tasks.filter(t => t.id !== task.id) };
    setPendingDeleteId(null);
    setSelectedId(next.tasks[Math.min(at, next.tasks.length - 1)]?.id ?? null);
    setLastDeleted({ task: target, index: at });
    void persist(next, 'save').then(() => flashInfo(`‘${target.title}’ 삭제됨`));
  }

  function undoDelete(): void {
    if (!lastDeleted) return;
    const restored = [...draft.tasks];
    restored.splice(Math.min(lastDeleted.index, restored.length), 0, lastDeleted.task);
    const next = { ...draft, tasks: restored };
    setLastDeleted(null);
    setSelectedId(lastDeleted.task.id);
    void persist(next, 'save').then(() => flashInfo(`‘${lastDeleted.task.title}’ 되돌림`));
  }

  return (
    <main className="control-room plan-studio">
      <div className="control-room-head">
        <div>
          <h1>계획</h1>
          <p className="muted">목표와 작업 순서를 보고, PM에게 바꿔 달라고 말할 수 있어요.</p>
        </div>
        <button className="btn" onClick={onClose}>닫기</button>
      </div>
      {draftLoadError && <div className="flash err" role="alert">
        <span>이 계획을 읽지 못했어요</span>{' '}
        <button className="mini" onClick={() => setDraftLoadAttempt(value => value + 1)}>다시 불러오기</button>
      </div>}
      {error && <div className="flash err">{error}</div>}
      {info && <div className="flash ok">{info}</div>}
      <div className="plan-studio-grid">
        <section className="control-card plan-projects" aria-label="project list">
          <h3>프로젝트</h3>
          {projects.length === 0
            ? <p className="muted">board에 lane이 없습니다.</p>
            : <div className="plan-project-list" role="listbox" aria-label="projects">
              {projects.map(name => {
                const lane = lanes.find(l => str(l.project ?? l.id) === name);
                const item = projectPresentation(name, lane);
                return (
                <button
                  key={name}
                  role="option"
                  aria-selected={name === project}
                  className={`plan-project${name === project ? ' active' : ''}`}
                  onClick={() => setProject(name)}
                ><span>{item.name}</span><small style={{ display: 'block', marginTop: 4 }}>{item.goal}</small></button>
                );
              })}
            </div>}
          <p className="muted">선택: <strong>{presentation.name}</strong></p>
        </section>

        <section className="plan-center" aria-label="goal and task chain">
          <article className="control-card" aria-label="goal card">
            <h3>목표</h3>
            {loading
              ? <p className="muted">불러오는 중...</p>
              : <>
                <p className="control-card-value" style={{ fontSize: 14 }}>{presentation.goal}</p>
                <details>
                  <summary>원문 보기</summary>
                  <pre className="mono">{rawText(projectLane ?? draft)}</pre>
                </details>
              </>}
          </article>

          <article className="control-card" aria-label="task chain">
            <h3>작업 순서 ({tasks.length}개)</h3>
            {tasks.length === 0
              ? <p className="muted">표시할 task가 없습니다.</p>
              : <>
                {remainingCount === 0 && <p className="muted" role="status">모두 끝났어요 — 남은 작업이 없습니다.</p>}
                <ol className="plan-tasks">
                {visibleTasks.map(task => {
                  const current = stageIndex(task.stage);
                  const done = isPlanStudioTaskDone(task);
                  const editable = isNotStarted(task) && !done && !task.registered;
                  return (
                    <li key={task.id} className={`plan-task${selected?.id === task.id ? ' selected' : ''}`}>
                      <button className="plan-task-head" onClick={() => setSelectedId(task.id)} title="상세 보기">
                        <span className="plan-task-title">{task.title}</span>
                        <span className="muted">{done ? doneLabel(task) : `${FLOW[current]} · ${current + 1}/7`}</span>
                      </button>
                      <div className="control-flow plan-steps" aria-label={`${task.title} progress`}>
                        {FLOW.map((name, index) => {
                          const state = done ? 'done' : task.blocker && index === current ? 'blocked' : index < current ? 'done' : index === current ? 'active' : 'pending';
                          return (
                            <div className={`control-step ${state}`} key={name} title={name}>
                              <span className="control-step-dot">{state === 'done' ? '✓' : state === 'blocked' ? '!' : state === 'active' ? '●' : '○'}</span>
                              <span>{name}</span>
                            </div>
                          );
                        })}
                      </div>
                      {editable && (
                        <div className="plan-task-edit">
                          <input
                            aria-label={`${task.title} 제목 편집`}
                            value={task.title}
                            onChange={e => setDraft(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === task.id ? { ...t, title: e.target.value } : t) }))}
                          />
                          <button
                            className="mini"
                            disabled={busy === 'save'}
                            onClick={() => void persist({ ...draft, tasks: draft.tasks.map(t => t.id === task.id ? { ...t, title: task.title } : t) }, 'save')}
                          >제목 저장</button>
                          <button
                            className="mini"
                            title="시작 전 task 삭제"
                            disabled={busy === 'save'}
                            onClick={() => requestDelete(task)}
                          >삭제</button>
                        </div>
                      )}
                      {pendingDeleteId === task.id && (
                        <InlineConfirm
                          message={`‘${task.title}’ 삭제하시겠어요?`}
                          confirmLabel="삭제"
                          busy={busy === 'save'}
                          busyLabel="삭제 중…"
                          onConfirm={() => confirmDelete(task)}
                          onCancel={() => setPendingDeleteId(null)}
                        />
                      )}
                    </li>
                  );
                })}
                </ol>
                {lastDeleted && (
                  <div className="plan-undo" role="status">
                    <span>‘{lastDeleted.task.title}’ 삭제됨</span>
                    <button className="mini" onClick={undoDelete} disabled={busy === 'save'}>
                      되돌리기
                    </button>
                  </div>
                )}
                {finishedCount > 0 && (
                  <button
                    className="mini"
                    aria-expanded={showDone}
                    onClick={() => setShowDone(prev => !prev)}
                  >
                    {showDone ? '끝난 작업 닫기' : `끝난 작업 ${finishedCount}개 보기`}
                  </button>
                )}
              </>}
          </article>

          <article className="control-card" aria-label="run policy">
            <h3>진행 방식</h3>
            <label className="plan-radio">
              <input
                type="radio"
                name="run-policy"
                value="continue"
                checked={pendingPolicy ? pendingPolicy === 'continue' : draft.runPolicy === 'continue'}
                onChange={() => { setLastDeleted(null); setPendingPolicy('continue'); }}
              />
              계속 진행 — 각 작업 완료 후 자동 계속
            </label>
            <label className="plan-radio">
              <input
                type="radio"
                name="run-policy"
                value="stop"
                checked={pendingPolicy ? pendingPolicy === 'stop' : draft.runPolicy === 'stop'}
                onChange={() => { setLastDeleted(null); setPendingPolicy('stop'); }}
              />
              각 작업 후 중단 — 확인 후 다음 진행
            </label>
            {pendingPolicy && pendingPolicy !== draft.runPolicy && (
              <InlineConfirm
                message={pendingPolicy === 'continue' ? '계속 진행으로 바꾸시겠어요?' : '각 작업 후 중단으로 바꾸시겠어요?'}
                confirmLabel="바꾸기"
                busy={busy === 'save'}
                busyLabel="저장 중…"
                onConfirm={() => { const next = pendingPolicy; setPendingPolicy(null); void persist({ ...draft, runPolicy: next }, 'save'); }}
                onCancel={() => setPendingPolicy(null)}
              />
            )}
            <div className="modalbtns" style={{ justifyContent: 'flex-start' }}>
              <button className="btn primary" disabled={busy === 'approve'} onClick={() => setPendingApprove(true)}>
                {busy === 'approve' ? '승인 중...' : '계획 승인 → 자동 진행'}
              </button>
            </div>
            {pendingApprove && (
              <InlineConfirm
                message="계획을 승인하고 자동 진행하시겠어요?"
                confirmLabel="승인"
                busy={busy === 'approve'}
                busyLabel="승인 중…"
                onConfirm={() => void approve()}
                onCancel={() => setPendingApprove(false)}
              />
            )}
          </article>
        </section>

        <aside className="plan-side" aria-label="chat detail gate">
          <article className="control-card" aria-label="pm chat">
            <h3>PM에게 요청</h3>
            <form onSubmit={e => void sendChat(e)} className="plan-chat-form">
              <textarea
                aria-label="PM에게 계획 수정 요청"
                value={chat}
                onChange={e => setChat(e.target.value)}
                placeholder="예: 3번 작업을 QA 먼저로 바꿔줘"
                rows={3}
              />
              <button className="btn primary" type="submit" disabled={!chat.trim() || busy === 'chat'}>
                {busy === 'chat' ? '전송 중...' : 'PM에게 요청'}
              </button>
            </form>
            <p className="muted">PM이 답하면 작업 순서가 새로 그려져요.</p>
          </article>

          <article className="control-card" aria-label="selected node detail">
            <h3>선택한 작업</h3>
            {!selected
              ? <p className="muted">task를 선택하세요.</p>
              : <>
                <p className="control-card-value" style={{ fontSize: 14 }}>{selected.title}</p>
                {isPlanStudioTaskDone(selected)
                  ? <p>{doneLabel(selected)}</p>
                  : <p>현재 단계: <strong>{FLOW[stageIndex(selected.stage)]}</strong> ({stageIndex(selected.stage) + 1}/7)</p>}
                {selected.agents.trim() ? <p>Agents: <strong>{selected.agents}</strong></p> : null}
                {selected.blocker.trim() ? <p>Blocker: <strong>{selected.blocker}</strong></p> : null}
                {selected.expectedRisk.trim() ? <p>예상 리스크: <strong>{selected.expectedRisk}</strong></p> : null}
              </>}
          </article>

          <article className="control-card human" aria-label="human gate">
            <h3>사람 확인</h3>
            {visibleGates.length === 0
              ? <p className="muted">지금 답할 것이 없어요.</p>
              : visibleGates.map(gate => (
                <form key={gate.gateId} onSubmit={e => { e.preventDefault(); void answerGate(gate.gateId); }}>
                  <fieldset className="plan-gate">
                    <legend>{gate.title}</legend>
                    <p className="muted mono" style={{ fontSize: 11 }}>{gate.gateId}</p>
                    {gate.options.map((option, index) => (
                      <label key={`${gate.gateId}-${index}`} className="plan-radio">
                        <input
                          type="radio"
                          name={`gate-${gate.gateId}`}
                          checked={(gatePick[gate.gateId] ?? 0) === index}
                          onChange={() => setGatePick(prev => ({ ...prev, [gate.gateId]: index }))}
                        />
                        {option}
                      </label>
                    ))}
                    <button className="btn primary" type="submit" disabled={busy === 'gate'}>답변 제출</button>
                  </fieldset>
                </form>
              ))}
          </article>
        </aside>
      </div>
    </main>
  );
}
