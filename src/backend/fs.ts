/**
 * Filesystem helpers for Agent Relay Log V0.
 *
 * All records live under DATA_ROOT/Projects/{project}/{YYYY-MM-DD}/{agent}/{NN}/
 * where NN is a zero-padded run number. Only markdown files are ever written.
 * Existing files are never overwritten unless the caller explicitly opts in.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, DEFAULT_AGENTS, HistoryItem, ProjectInfo } from '../shared/types.js';

/** Settings file lives next to the app so it travels with the portable build. */
export function settingsPath(baseDir: string): string {
  return path.join(baseDir, 'settings.json');
}

export function loadSettings(baseDir: string): AppSettings {
  const defaults: AppSettings = { dataRoot: '', customAgents: [] };
  try {
    const raw = fs.readFileSync(settingsPath(baseDir), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function saveSettings(baseDir: string, s: AppSettings): void {
  fs.writeFileSync(settingsPath(baseDir), JSON.stringify(s, null, 2), 'utf8');
}

/** Sanitize a user-supplied folder/component name into a safe Windows path segment. */
export function slugify(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/[. ]+$/g, '') // trailing dots/spaces are invalid on Windows
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length ? cleaned : 'untitled';
}

/** Today's date in YYYY-MM-DD using the local system clock. */
export function todayString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** No longer adds a 'Projects/' layer — DATA_ROOT itself is the projects container. */
export function projectsDir(dataRoot: string): string {
  return dataRoot;
}

/**
 * '.' = use DATA_ROOT directly (no project subfolder).
 * Any other name = DATA_ROOT/[slugified name]/.
 */
export function projectDir(dataRoot: string, project: string): string {
  if (!project || project === '.') return dataRoot;
  return path.join(dataRoot, slugify(project));
}

export function dateDir(dataRoot: string, project: string, date: string): string {
  return path.join(projectDir(dataRoot, project), date);
}

export function agentDir(dataRoot: string, project: string, date: string, agent: string): string {
  return path.join(dateDir(dataRoot, project, date), slugify(agent));
}

export function runDir(
  dataRoot: string,
  project: string,
  date: string,
  agent: string,
  run: string,
): string {
  return path.join(agentDir(dataRoot, project, date, agent), run);
}

/** Ensure a run folder exists and return its path. */
export function ensureRunFolder(
  dataRoot: string,
  project: string,
  date: string,
  agent: string,
  run: string,
): string {
  const dir = runDir(dataRoot, project, date, agent, run);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ensure DATA_ROOT exists. Throws a friendly message on failure. */
export function ensureDataRoot(dataRoot: string): void {
  if (!dataRoot) throw new Error('DATA_ROOT가 선택되지 않았습니다.');
  fs.mkdirSync(dataRoot, { recursive: true });
}

/**
 * List projects — the subfolders of DATA_ROOT that look like project containers
 * (i.e. they contain date-formatted subfolders, or are just plain directories).
 * Hidden folders and system folders are excluded.
 * '.' (root project) is always included as the first item if DATA_ROOT itself
 * contains date-formatted subfolders directly.
 */
export function listProjects(dataRoot: string): ProjectInfo[] {
  ensureDataRoot(dataRoot);
  const entries = fs.readdirSync(dataRoot, { withFileTypes: true });

  // Check if DATA_ROOT itself has date folders (YYYY-MM-DD) → ROOT_PROJECT mode available
  const hasDateDirsAtRoot = entries.some(
    (e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name),
  );

  const subProjects: ProjectInfo[] = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !/^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(dataRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (hasDateDirsAtRoot) {
    // Put the root-mode option first
    return [{ name: '.', path: dataRoot }, ...subProjects];
  }
  return subProjects;
}

/** Create a project folder (never deletes anything). Returns the project info. */
export function createProject(dataRoot: string, name: string): ProjectInfo {
  ensureDataRoot(dataRoot);
  const slug = slugify(name);
  const dir = path.join(dataRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  return { name: slug, path: dir };
}

/** List YYYY-MM-DD sub-folders for a project, newest first. */
export function listDates(dataRoot: string, project: string): string[] {
  const root = projectDir(dataRoot, project);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** List agent folders inside a project/date, sorted alphabetically. */
export function listAgents(dataRoot: string, project: string, date: string): string[] {
  const root = dateDir(dataRoot, project, date);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Compute the next run number for a Project/Date/Agent as a zero-padded string
 * (e.g. "04"). Existing numbered folders are inspected; gaps are NOT reused.
 */
export function nextRunNumber(
  dataRoot: string,
  project: string,
  date: string,
  agent: string,
): string {
  const dir = agentDir(dataRoot, project, date, agent);
  const nums: number[] = [];
  if (fs.existsSync(dir)) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && /^\d+$/.test(e.name)) nums.push(parseInt(e.name, 10));
    }
  }
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return String(next).padStart(2, '0');
}

/** Read a markdown file, or '' when missing. */
export function readMarkdown(folder: string, file: string): string {
  const p = path.join(folder, file);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Write a markdown file. Refuses to overwrite an existing file unless
 * `overwrite` is true. Returns the destination path.
 */
export function writeMarkdown(
  folder: string,
  file: string,
  content: string,
  overwrite: boolean,
): string {
  fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, file);
  if (!overwrite && fs.existsSync(p)) {
    throw new Error(`'${file}'이(가) 이미 있어 덮어쓰지 않았습니다.`);
  }
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── run meta (tags) ─────────────────────────────────────────────────────────

interface RunMeta { tags: string[] }

/** Read meta.json from a run folder. Returns empty defaults when missing. */
export function readRunMeta(folder: string): RunMeta {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8')) as RunMeta;
  } catch {
    return { tags: [] };
  }
}

/** Write meta.json to a run folder. */
export function writeRunMeta(folder: string, meta: RunMeta): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

// ── run operations ───────────────────────────────────────────────────────────

/** Read prompt.md and result.md (and tags) from a run folder. */
export function readRun(folder: string): { prompt: string; result: string; folder: string; tags: string[] } {
  return {
    folder,
    prompt: readMarkdown(folder, 'prompt.md'),
    result: readMarkdown(folder, 'result.md'),
    tags: readRunMeta(folder).tags,
  };
}

/** Delete a run folder and all contents (permanent). */
export function deleteRun(folder: string): void {
  fs.rmSync(folder, { recursive: true, force: true });
}

/**
 * Build a merged markdown export of a run (prompt + result in one file).
 * Returns the markdown string; does not write anything.
 */
export function exportRunMarkdown(folder: string): string {
  const parts = folder.replace(/\\/g, '/').split('/');
  const runN = parts[parts.length - 1] ?? '';
  const agentN = parts[parts.length - 2] ?? '';
  const dateN = parts[parts.length - 3] ?? '';
  const projN = parts[parts.length - 4] ?? '';

  const prompt = readMarkdown(folder, 'prompt.md');
  const result = readMarkdown(folder, 'result.md');
  const tags = readRunMeta(folder).tags;

  const header = `# ${projN} · ${agentN} · ${dateN} · Run ${runN}`;
  const tagLine = tags.length ? `\n> 태그: ${tags.join(', ')}` : '';
  const sections: string[] = [header + tagLine];
  if (prompt) sections.push(`\n## Prompt\n\n${prompt}`);
  if (result) sections.push(`\n## Result\n\n${result}`);
  return sections.join('\n');
}

/** Build a full history list for a project (all dates/agents/runs, newest first). */
export function buildHistory(dataRoot: string, project: string): HistoryItem[] {
  const out: HistoryItem[] = [];
  const root = projectDir(dataRoot, project);
  if (!fs.existsSync(root)) return out;
  for (const date of listDates(dataRoot, project)) {
    const datePath = dateDir(dataRoot, project, date);
    for (const e of fs.readdirSync(datePath, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const agent = e.name;
      const agentPath = path.join(datePath, agent);
      const runs = fs
        .readdirSync(agentPath, { withFileTypes: true })
        .filter((x) => x.isDirectory() && /^\d+$/.test(x.name))
        .map((x) => x.name)
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      for (const run of runs) {
        const folder = path.join(agentPath, run);
        out.push({
          agent,
          date,
          run,
          folder,
          hasPrompt: fs.existsSync(path.join(folder, 'prompt.md')),
          hasResult: fs.existsSync(path.join(folder, 'result.md')),
          tags: readRunMeta(folder).tags,
        });
      }
    }
  }
  // newest first: larger dates first, then larger run numbers first
  return out.sort((a, b) => {
    const dc = b.date.localeCompare(a.date);
    if (dc !== 0) return dc;
    const ac = b.agent.localeCompare(a.agent);
    if (ac !== 0) return ac;
    return parseInt(b.run, 10) - parseInt(a.run, 10);
  });
}

/** All agents = defaults + customs from settings. */
export function allAgents(settings: AppSettings): string[] {
  const merged = [...DEFAULT_AGENTS, ...settings.customAgents];
  return [...new Set(merged)];
}

/**
 * Move a run folder to a new project/date/agent location.
 * Copies all files, deletes the source, returns the new folder path.
 */
export function moveRun(
  fromFolder: string,
  dataRoot: string,
  project: string,
  toDate: string,
  toAgent: string,
): string {
  const nextRun = nextRunNumber(dataRoot, project, toDate, toAgent);
  const destFolder = ensureRunFolder(dataRoot, project, toDate, toAgent, nextRun);
  for (const entry of fs.readdirSync(fromFolder, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.copyFileSync(path.join(fromFolder, entry.name), path.join(destFolder, entry.name));
    }
  }
  fs.rmSync(fromFolder, { recursive: true, force: true });
  return destFolder;
}
