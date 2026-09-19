/**
 * WORKSPACE SHELL V0 — ChatBinding UI-only model.
 *
 * ChatBinding is an INTERACTION binding only. It never owns Goal / Task /
 * Run / Result / Worker session. Relay backend remains the truth source.
 *
 * Storage is frontend-local (localStorage) and clearly isolated from Relay
 * SSOT. Never persisted as Relay truth, never forced into Task JSON.
 */

export type ChatRole = 'PM' | 'QA' | 'Runtime' | 'Product' | 'Research';
export type ChatProvider = 'ChatGPT' | 'Claude' | 'Gemini' | 'Other';
export type ChatBindingStatus = 'connected' | 'idle' | 'unknown';

export interface ChatBinding {
  id: string;
  projectId: string;
  name: string;
  role: ChatRole;
  provider: ChatProvider;
  chatUrl: string;
  lastOpenedAt?: string;
  status: ChatBindingStatus;
  /** Always true in V0 — marks UI-only seed data vs Relay SSOT. */
  uiOnly: boolean;
}

const STORE_KEY = 'agent-relay.workspace.chatBindings.v0';

function seedForProject(projectId: string): ChatBinding[] {
  const base = projectId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return [
    {
      id: `cb-${base}-pm`,
      projectId,
      name: 'PM Current',
      role: 'PM',
      provider: 'ChatGPT',
      chatUrl: '',
      status: 'connected',
      uiOnly: true,
    },
    {
      id: `cb-${base}-qa`,
      projectId,
      name: 'QA',
      role: 'QA',
      provider: 'ChatGPT',
      chatUrl: '',
      status: 'idle',
      uiOnly: true,
    },
  ];
}

function readStore(): Record<string, ChatBinding[]> {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, ChatBinding[]>;
    return {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ChatBinding[]>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore — UI-only cache */
  }
}

export function listChatBindings(projectId: string): ChatBinding[] {
  const store = readStore();
  const existing = store[projectId];
  if (existing && existing.length > 0) return existing;
  const seeded = seedForProject(projectId);
  writeStore({ ...store, [projectId]: seeded });
  return seeded;
}

export function touchChatBindingOpened(projectId: string, bindingId: string): void {
  const store = readStore();
  const list = store[projectId] ?? seedForProject(projectId);
  const now = new Date().toISOString();
  writeStore({
    ...store,
    [projectId]: list.map((b) => (b.id === bindingId ? { ...b, lastOpenedAt: now } : b)),
  });
}

export const CHAT_ROLE_LABEL: Record<ChatRole, string> = {
  PM: 'PM',
  QA: 'QA',
  Runtime: 'Runtime',
  Product: 'Product',
  Research: 'Research',
};
