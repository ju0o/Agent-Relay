/**
 * Project Current Resolver — bounded current-state evidence per lane.
 *
 * Before a Project PM proposes the next Task, the Runner collects from:
 * 1. local Git HEAD/status/branch/log
 * 2. Project SSOT docs (README + docs tree)
 * 3. Control Tower reference if discoverable
 * 4. MASTER WBS / Roadmap files if present
 * 5. Decision Log if present
 * 6. linked Private Product/PM repository if discoverable
 * 7. current open/accepted canonical Task state
 * 8. actual implemented repository state (file listing sample)
 *
 * Private SSOT outranks public README for planning authority. Private paths
 * are never assumed: they are discovered through docs/config/remotes and
 * the workspace lane roots supplied by the caller.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectCurrent {
  laneId: string;
  projectRoot: string;
  git: {
    headSha: string | null;
    branch: string | null;
    clean: boolean | null;
    statusShort: string[];
    recentCommits: string[];
  };
  readmeGoal: string | null;
  docIndex: string[];
  wbsFiles: Array<{ path: string; head: string }>;
  decisionLog: Array<{ path: string; head: string }>;
  remotes: string[];
  privateRepo: { root: string; via: string } | null;
  controlTower: { root: string; via: string } | null;
  canonical: { open: string[]; acceptedRecent: string[] } | null;
  treeSample: string[];
  collectedAt: string;
}

/** Pinned implementation base for executable contracts (§4 currentBaseSha). */
export function gitHeadSha(root: string): string | null {
  return sh(path.resolve(root), ['rev-parse', 'HEAD']);
}

function sh(cwd: string, args: string[]): string | null {  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function readHead(file: string, maxChars: number): string | null {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, maxChars);
  } catch {
    return null;
  }
}

function listTree(root: string, depth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    if (d < 0) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (n === 'node_modules' || n === '.git') continue;
      const p = path.join(dir, n);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      out.push(path.relative(root, p) + (st.isDirectory() ? '/' : ''));
      if (st.isDirectory()) walk(p, d - 1);
      if (out.length > 300) return;
    }
  };
  walk(root, depth);
  return out.slice(0, 300);
}

const WBS_PATTERNS = [/wbs/i, /roadmap/i, /\broad\b/i, /milestone/i, /plan\.md$/i, /backlog/i];
const DECISION_PATTERNS = [/decision/i, /adr\//i, /changelog/i, /gates?\.md/i];

export interface ResolverContext {
  laneRoots: string[];
  controlTowerRoot?: string;
  dataRoot?: string;
  project?: string;
  listOpenTasks?: (dataRoot: string, project: string) => Array<{ taskId: string; executionState: string; pmState: string }>;
}

export async function resolveProjectCurrent(
  laneId: string,
  projectRoot: string,
  ctx: ResolverContext,
): Promise<ProjectCurrent> {
  const root = path.resolve(projectRoot);
  const headSha = sh(root, ['rev-parse', 'HEAD']);
  const branch = sh(root, ['branch', '--show-current']);
  const statusRaw = sh(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  const logRaw = sh(root, ['log', '--oneline', '-8']);
  const readme = readHead(path.join(root, 'README.md'), 1500)
    ?? readHead(path.join(root, 'readme.md'), 1500);
  const tree = listTree(root, 2);
  const docs = tree.filter((p) => p.toLowerCase().startsWith('docs/'));
  const wbsFiles = tree
    .filter((p) => !p.endsWith('/') && WBS_PATTERNS.some((re) => re.test(p)))
    .slice(0, 6)
    .map((p) => ({ path: p, head: readHead(path.join(root, p), 1200) ?? '' }));
  const decisionLog = tree
    .filter((p) => !p.endsWith('/') && DECISION_PATTERNS.some((re) => re.test(p)))
    .slice(0, 6)
    .map((p) => ({ path: p, head: readHead(path.join(root, p), 1200) ?? '' }));
  const remotesRaw = sh(root, ['remote', '-v']);
  const remotes = remotesRaw ? [...new Set(remotesRaw.split('\n').map((l) => l.trim()).filter(Boolean))].slice(0, 6) : [];

  // Private repo discovery: docs/config/remotes/workspace roots that name a
  // sibling lane root. Never assumed; always recorded with provenance.
  let privateRepo: ProjectCurrent['privateRepo'] = null;
  const haystack = [readme ?? '', ...docs.slice(0, 40), ...remotes].join('\n').toLowerCase();
  for (const other of ctx.laneRoots) {
    if (path.resolve(other) === root) continue;
    const base = path.basename(path.resolve(other)).toLowerCase().replace(/[-_]/g, '');
    if (base.length >= 4 && haystack.includes(base)) {
      try {
        if (fs.statSync(other).isDirectory()) {
          privateRepo = { root: path.resolve(other), via: `workspace lane root referenced by name (${base})` };
          break;
        }
      } catch { /* ignore */ }
    }
  }
  if (!privateRepo) {
    const m = haystack.match(/github\.com[/:][A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/);
    if (m) privateRepo = { root: m[0], via: 'remote/docs reference (remote only, not checked out)' };
  }

  const controlTower = ctx.controlTowerRoot
    ? { root: path.resolve(ctx.controlTowerRoot), via: 'runner context' }
    : null;

  let canonical: ProjectCurrent['canonical'] = null;
  if (ctx.dataRoot && ctx.project && ctx.listOpenTasks) {
    try {
      const tasks = ctx.listOpenTasks(ctx.dataRoot, ctx.project);
      canonical = {
        open: tasks.filter((t) => t.pmState !== 'ACCEPTED').map((t) => `${t.taskId} ${t.executionState}/${t.pmState}`),
        acceptedRecent: tasks.filter((t) => t.pmState === 'ACCEPTED').slice(-5).map((t) => t.taskId),
      };
    } catch {
      canonical = { open: [], acceptedRecent: [] };
    }
  }

  return {
    laneId,
    projectRoot: root,
    git: {
      headSha,
      branch: branch || null,
      clean: statusRaw === null ? null : statusRaw.length === 0,
      statusShort: statusRaw ? statusRaw.split('\n').filter(Boolean).slice(0, 20) : [],
      recentCommits: logRaw ? logRaw.split('\n').filter(Boolean) : [],
    },
    readmeGoal: readme ? readme.split('\n').slice(0, 12).join('\n') : null,
    docIndex: docs.slice(0, 40),
    wbsFiles,
    decisionLog,
    remotes,
    privateRepo,
    controlTower,
    canonical,
    treeSample: tree.filter((p) => !p.startsWith('docs/')).slice(0, 60),
    collectedAt: new Date().toISOString(),
  };
}

/** Render the bounded PROJECT_CURRENT packet text for a tool-less PM. */
export function renderProjectCurrentPacket(cur: ProjectCurrent, maxChars = 6000): string {
  const lines: string[] = [];
  lines.push(`PROJECT_CURRENT ${cur.laneId} root=${cur.projectRoot}`);
  lines.push(`GIT head=${cur.git.headSha ?? '?'} branch=${cur.git.branch ?? '?'} clean=${cur.git.clean ?? '?'}`);
  if (cur.git.statusShort.length) lines.push(`DIRTY:\n${cur.git.statusShort.slice(0, 10).join('\n')}`);
  if (cur.git.recentCommits.length) lines.push(`RECENT:\n${cur.git.recentCommits.slice(0, 5).join('\n')}`);
  if (cur.readmeGoal) lines.push(`README:\n${cur.readmeGoal.slice(0, 800)}`);
  if (cur.docIndex.length) lines.push(`DOCS: ${cur.docIndex.slice(0, 15).join(', ')}`);
  for (const w of cur.wbsFiles.slice(0, 3)) lines.push(`WBS ${w.path}:\n${w.head.slice(0, 800)}`);
  for (const d of cur.decisionLog.slice(0, 2)) lines.push(`DECISION ${d.path}:\n${d.head.slice(0, 600)}`);
  if (cur.remotes.length) lines.push(`REMOTES: ${cur.remotes.slice(0, 3).join(' | ')}`);
  if (cur.privateRepo) lines.push(`PRIVATE: ${cur.privateRepo.root} (via ${cur.privateRepo.via}) — its SSOT outranks public README`);
  if (cur.controlTower) lines.push(`CONTROL_TOWER: ${cur.controlTower.root}`);
  if (cur.canonical) {
    lines.push(`OPEN_TASKS: ${cur.canonical.open.length ? cur.canonical.open.join(', ') : '(none)'}`);
    if (cur.canonical.acceptedRecent.length) lines.push(`ACCEPTED: ${cur.canonical.acceptedRecent.join(', ')}`);
  }
  lines.push(`TREE: ${cur.treeSample.slice(0, 25).join(', ')}`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}
