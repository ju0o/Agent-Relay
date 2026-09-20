/**
 * Workspace manifest — multi-project lane registry for auto bootstrap.
 *
 * Pane numbers are NEVER stored here. This file holds only stable identity:
 * project id, project root, product goal, and logical role runtimes.
 * Live pane_id + pid + cwd + health are resolved at runtime by probe.ts
 * and cached ephemerally in workspace-state.json (never in the manifest).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORKSPACE_MANIFEST_SCHEMA = 'workspace.v1' as const;

export type WorkspaceRole = 'pm' | 'builder' | 'qa';

export interface WorkspaceLaneRoles {
  pm: string;
  builder: string;
  qa: string;
}

export interface WorkspaceLane {
  /** Stable project id: agent-relay | actl | juplan | jucontroller */
  id: string;
  /** Human label shown in `workspace status` */
  label: string;
  /** Absolute project root; verified to exist at `workspace start` time */
  root: string;
  /** Independent product goal (one line, from PM packet) */
  goal: string;
  /** Logical runtime labels (NOT tmux pane numbers) */
  roles: WorkspaceLaneRoles;
  /** Primary QA runtime label; fallback resolved by qa-fallback.ts */
  primaryQa: string;
}

export interface WorkspaceManifest {
  schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA;
  /** Max concurrently active builders (default 2) */
  maxActiveBuilders: number;
  /** Max concurrently active QA (default 1) */
  maxActiveQa: number;
  /** QA fallback runtime label (default "cursor") */
  qaFallbackRuntime: string;
  lanes: WorkspaceLane[];
}

export const DEFAULT_WORKSPACE_ROOTS: Record<string, string> = {
  'agent-relay': '/home/skkse12/Desktop/Projects/Core/Agent-Relay',
  actl: '/home/skkse12/Desktop/Projects/Core/actl-v0.1.1-managed',
  juplan: '/home/skkse12/Desktop/Projects/Team/JuPlan',
  jucontroller: '/home/skkse12/Desktop/Projects/Core/JuControler',
};

export function defaultWorkspaceManifest(): WorkspaceManifest {
  return {
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA,
    maxActiveBuilders: 2,
    maxActiveQa: 1,
    qaFallbackRuntime: 'cursor',
    lanes: [
      {
        id: 'agent-relay',
        label: 'Agent-Relay',
        root: DEFAULT_WORKSPACE_ROOTS['agent-relay']!,
        goal: 'Autonomous PM <-> Builder <-> QA orchestration engine (Goal -> Task -> Builder -> QA -> PM -> Changes/Accept -> Next Task without manual copy-paste).',
        roles: { pm: 'chatgpt', builder: 'opencode', qa: 'cline' },
        primaryQa: 'cline',
      },
      {
        id: 'actl',
        label: 'actl',
        root: DEFAULT_WORKSPACE_ROOTS['actl']!,
        goal: 'Independently installable AI Agent Universal Remote Control (discover/identity/bind/send/collect/interrupt/health/recovery).',
        roles: { pm: 'chatgpt', builder: 'codex-luna', qa: 'commandcode' },
        primaryQa: 'commandcode',
      },
      {
        id: 'juplan',
        label: 'JuPlan',
        root: DEFAULT_WORKSPACE_ROOTS['juplan']!,
        goal: 'Independently installable AI planning tool (Idea/Repository -> PRD/users/features/architecture/ERD/WBS/acceptance/QA plan/flows/wireframe plan/risks/gates -> Frozen Plan).',
        roles: { pm: 'chatgpt', builder: 'grok', qa: 'claude-team' },
        primaryQa: 'claude-team',
      },
      {
        id: 'jucontroller',
        label: 'JuControler',
        root: DEFAULT_WORKSPACE_ROOTS['jucontroller']!,
        goal: 'AI Software Company Control Tower plugging independent AI tools/runtimes via Stable Contracts (Context/Supervisor/Scheduler/Skill Router/QA Persona/Human Gate/Control UI).',
        roles: { pm: 'chatgpt', builder: 'claude-team', qa: 'opencode' },
        primaryQa: 'opencode',
      },
    ],
  };
}

export function workspaceManifestPath(hostRoot: string): string {
  return path.join(path.resolve(hostRoot), '.agent-relay', 'workspace.json');
}

export function workspaceStatePath(hostRoot: string): string {
  return path.join(path.resolve(hostRoot), '.agent-relay', 'workspace-state.json');
}

function fail(msg: string): never {
  throw new Error(`Invalid workspace manifest: ${msg}`);
}

export function validateWorkspaceManifest(raw: unknown): asserts raw is WorkspaceManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be an object');
  const m = raw as Record<string, unknown>;
  if (m.schemaVersion !== WORKSPACE_MANIFEST_SCHEMA) fail('schemaVersion must be workspace.v1');
  if (typeof m.maxActiveBuilders !== 'number' || m.maxActiveBuilders < 1) fail('maxActiveBuilders must be >= 1');
  if (typeof m.maxActiveQa !== 'number' || m.maxActiveQa < 1) fail('maxActiveQa must be >= 1');
  if (typeof m.qaFallbackRuntime !== 'string' || !m.qaFallbackRuntime.trim()) fail('qaFallbackRuntime required');
  if (!Array.isArray(m.lanes) || m.lanes.length === 0) fail('lanes must be a non-empty array');
  const seen = new Set<string>();
  for (const [i, lane] of (m.lanes as unknown[]).entries()) {
    if (!lane || typeof lane !== 'object') fail(`lanes[${i}] must be an object`);
    const l = lane as Record<string, unknown>;
    if (typeof l.id !== 'string' || !l.id.trim()) fail(`lanes[${i}].id required`);
    if (seen.has(l.id as string)) fail(`lanes[${i}].id duplicate: ${l.id}`);
    seen.add(l.id as string);
    if (typeof l.label !== 'string' || !l.label.trim()) fail(`lanes[${i}].label required`);
    if (typeof l.root !== 'string' || !path.isAbsolute(l.root as string)) fail(`lanes[${i}].root must be absolute`);
    // Forbid pane-number hardcoding: root/pane fields must not look like %N.
    for (const v of [l.root, l.label, l.id]) {
      if (typeof v === 'string' && /%\d+\b/.test(v)) fail(`lanes[${i}] must not hardcode tmux pane numbers`);
    }
    if (typeof l.goal !== 'string' || !l.goal.trim()) fail(`lanes[${i}].goal required`);
    const roles = l.roles as Record<string, unknown> | undefined;
    if (!roles || typeof roles.pm !== 'string' || typeof roles.builder !== 'string' || typeof roles.qa !== 'string') {
      fail(`lanes[${i}].roles must define pm/builder/qa runtime labels`);
    }
    for (const r of [roles!.pm, roles!.builder, roles!.qa]) {
      if (typeof r !== 'string' || !r.trim() || /%\d+\b/.test(r)) fail(`lanes[${i}].roles must be logical labels, not pane numbers`);
    }
    if (typeof l.primaryQa !== 'string' || !l.primaryQa.trim()) fail(`lanes[${i}].primaryQa required`);
  }
}

export function readWorkspaceManifest(hostRoot: string): WorkspaceManifest | null {
  const file = workspaceManifestPath(hostRoot);
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateWorkspaceManifest(raw);
    return raw as WorkspaceManifest;
  } catch {
    return null;
  }
}

export function writeWorkspaceManifest(hostRoot: string, manifest: WorkspaceManifest): WorkspaceManifest {
  validateWorkspaceManifest(manifest);
  const file = workspaceManifestPath(hostRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return manifest;
}
