/**
 * 작업탭 + 미저장 초안 영속 — 순수 로직 (BACKLOG 5/9/10번).
 *
 * localStorage 전용, 백엔드 무변경. 저장된 런(폴더)은 디스크가 SSOT라
 * 기술자(agent/folder/run)만 저장하고, 미저장 초안(prompt/result)은
 * 용량 상한 내에서 함께 저장한다.
 */

/** snapshotOfSession / flush 대상 세션의 최소 구조 (App의 ProjectSession과 호환). */
export interface WorkTabLike {
  id: string;
  agent: string;
  run: string;
  folder: string;
  prompt: string;
  result: string;
  tags: string[];
  promptSaved: boolean;
  resultSaved: boolean;
}
export interface WorkSessionLike {
  project: string;
  tabs: WorkTabLike[];
  activeTabId: string;
}

export interface PersistedWorkTab {
  agent: string;
  folder: string;
  run: string;
  /** 미저장 초안 — 저장된 탭은 ''이며 복원 시 디스크에서 다시 읽는다. */
  draftPrompt?: string;
  draftResult?: string;
  tags?: string[];
}
export interface PersistedSession { tabs: PersistedWorkTab[]; activeIndex: number; }

export const WORKTABS_KEY = 'agent-relay.worktabs.v1';
export const MAX_DRAFT_CHARS = 200_000;      // 탭당 초안 상한
export const MAX_SNAPSHOT_CHARS = 2_000_000; // 전체 스냅샷 상한
export const MAX_RESTORE_TABS = 10;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch { /* SSR 등 — 없음 */ }
  return null;
}

export function readWorktabSnapshots(storage?: StorageLike): Record<string, PersistedSession> {
  try {
    const store = storage ?? defaultStorage();
    const raw = store?.getItem(WORKTABS_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === 'object') return v as Record<string, PersistedSession>;
  } catch { /* 파싱 실패 → 빈 상태로 시작 */ }
  return {};
}

export function snapshotOfSession(sess: WorkSessionLike): PersistedSession {
  const tabs: PersistedWorkTab[] = sess.tabs.slice(0, MAX_RESTORE_TABS).map(t => {
    const unsavedPrompt = t.prompt.trim() && !t.promptSaved ? t.prompt : '';
    const unsavedResult = t.result.trim() && !t.resultSaved ? t.result : '';
    const entry: PersistedWorkTab = { agent: t.agent, folder: t.folder, run: t.run };
    if ((unsavedPrompt || unsavedResult)
      && unsavedPrompt.length + unsavedResult.length <= MAX_DRAFT_CHARS) {
      if (unsavedPrompt) entry.draftPrompt = unsavedPrompt;
      if (unsavedResult) entry.draftResult = unsavedResult;
    }
    if (t.tags.length) entry.tags = [...t.tags];
    return entry;
  });
  const found = sess.tabs.findIndex(t => t.id === sess.activeTabId);
  return { tabs, activeIndex: Math.max(0, found) };
}

/** 모든 프로젝트 세션의 작업탭 스냅샷을 동기적으로 기록 (언마운트/종료 플러시용). */
export function flushWorktabSnapshots(sessions: WorkSessionLike[], storage?: StorageLike): boolean {
  try {
    const store = storage ?? defaultStorage();
    if (!store) return false;
    const snap: Record<string, PersistedSession> = {};
    for (const s of sessions) {
      if (!s.project) continue;
      snap[s.project] = snapshotOfSession(s);
    }
    const raw = JSON.stringify(snap);
    if (raw.length > MAX_SNAPSHOT_CHARS) return false;
    store.setItem(WORKTABS_KEY, raw);
    return true;
  } catch { /* quota 등 — 영속 실패해도 앱 동작은 계속 */ }
  return false;
}
