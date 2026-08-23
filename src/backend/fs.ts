/**
 * Filesystem helpers for Agent Relay Log V0.
 *
 * All records live under DATA_ROOT/Projects/{project}/{YYYY-MM-DD}/{agent}/{NN}/
 * where NN is a zero-padded run number. Only markdown files are ever written.
 * Existing files are never overwritten unless the caller explicitly opts in.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AppSettings,
  DfContext,
  DfItem,
  DfKind,
  DfPriority,
  DfStatus,
  DfType,
  DEFAULT_AGENTS,
  HistoryItem,
  PROJECT_DF_TYPE_LABELS,
  ProjectInfo,
  ROOT_PROJECT,
  dfTypeFromText,
  dfTypeLabel,
} from '../shared/types.js';

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

/** True when the path exists and is a directory — used to detect a vanished DATA_ROOT. */
export function dataRootExists(dataRoot: string): boolean {
  if (!dataRoot) return false;
  try {
    return fs.statSync(dataRoot).isDirectory();
  } catch {
    return false;
  }
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

/** List YYYY-MM-DD sub-folders for a project, newest first. `_dogfooding` 등 내부 폴더는 제외. */
export function listDates(dataRoot: string, project: string): string[] {
  const root = projectDir(dataRoot, project);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
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

/** Delete an entire date folder (all agents + runs within that date). */
export function deleteDateFolder(dataRoot: string, project: string, date: string): void {
  const dir = dateDir(dataRoot, project, date);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Delete an agent folder under a date (all runs for that agent on that date). */
export function deleteAgentFolder(dataRoot: string, project: string, date: string, agent: string): void {
  const dir = agentDir(dataRoot, project, date, agent);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Delete a project folder entirely (all dates/agents/runs).
 * ROOT_PROJECT ('.') cannot be deleted — that is the data root itself.
 */
export function deleteProject(dataRoot: string, project: string): void {
  if (!project || project === '.') throw new Error('루트 프로젝트는 삭제할 수 없습니다.');
  const dir = projectDir(dataRoot, project);
  fs.rmSync(dir, { recursive: true, force: true });
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

/** The exact file that gets dragged to GPT / revealed in Explorer for a run. */
export function resolveResultPath(folder: string): string {
  return path.join(folder, 'result.md');
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

// ── dogfooding feedback ─────────────────────────────────────────────────────
//
// 서로 절대 섞이지 않는 두 종류의 기록이 있다:
//   app     : DATA_ROOT/.agent-relay/dogfooding/DF-NNNN.md  — Agent Relay 앱 자체 개선 기록
//   project : DATA_ROOT/{project}/_dogfooding/DF-NNNN.md    — 해당 프로젝트 사용성 피드백
// markdown 파일 자체가 SSOT다 (index.json 없음 — 동기화 실패 지점을 만들지 않는다).
// `listProjects`는 dot-folder를 무시하고 `listDates`는 '_' 시작 폴더를 무시하므로
// 두 기록 모두 Work Log(프로젝트/날짜 트리)에 나타나지 않는다.
// ID는 스트림마다(그리고 프로젝트마다) 독립적으로 증가한다.

export function dogfoodingDir(dataRoot: string): string {
  return path.join(dataRoot, '.agent-relay', 'dogfooding');
}

/** Project Dogfooding 디렉터리 — 항상 {project}/_dogfooding/ 하위 (Run 하위가 아니다). */
export function projectDogfoodingDir(dataRoot: string, project: string): string {
  return path.join(projectDir(dataRoot, project), '_dogfooding');
}

interface DfHeader {
  status: DfStatus;
  typeLabel: string;
  priority: DfPriority;
  created: string;
  version: string;
}

interface DfRenderInput extends DfHeader {
  id: string;
  kind: DfKind;
  /** project kind — 기록 대상 프로젝트 이름. */
  project?: string;
  date?: string;
  agent?: string;
  run?: string;
  feedback: string;
  desired: string;
}

/**
 * Render the canonical markdown for a feedback record.
 * app flavor는 v0.2.0 형식을 그대로 유지하고, project flavor는 스펙 형식
 * (## Project / ## Context / ## 발견 내용 / ## 기대했던 동작 / 원하는 방향)을 쓴다.
 */
export function renderFeedbackMarkdown(input: DfRenderInput): string {
  const lines: string[] = [
    `# ${input.id}`,
    '',
    `Status: ${input.status}`,
    `Type: ${input.typeLabel}`,
    `Priority: ${input.priority}`,
    `Created: ${input.created}`,
    `Version: ${input.version}`,
    '',
  ];

  if (input.kind === 'project') {
    lines.push('## Project', '', input.project || '(unknown)', '');

    lines.push('## Context', '');
    let ctxWrote = false;
    if (input.date) { lines.push(`Date: ${input.date}`); ctxWrote = true; }
    if (input.agent) { lines.push(`Agent: ${input.agent}`); ctxWrote = true; }
    if (input.run) { lines.push(`Run: ${input.run}`); ctxWrote = true; }
    if (!ctxWrote) lines.push('(none)');

    lines.push('', '## 발견 내용', '', input.feedback.trim(), '');
    if (input.desired.trim()) lines.push('## 기대했던 동작 / 원하는 방향', '', input.desired.trim(), '');
    return lines.join('\n');
  }

  // app flavor — v0.2.0과 동일한 출력
  lines.push('## Context', '');
  let wrote = false;
  if (input.project) { lines.push(`Project: ${input.project}`); wrote = true; }
  if (input.date) { lines.push(`Date: ${input.date}`); wrote = true; }
  if (input.agent) { lines.push(`Agent: ${input.agent}`); wrote = true; }
  if (input.run) { lines.push(`Run: ${input.run}`); wrote = true; }
  if (!wrote) lines.push('(none)');
  lines.push('', '## Feedback', '', input.feedback.trim(), '');
  if (input.desired.trim()) lines.push('## Desired', '', input.desired.trim(), '');
  return lines.join('\n');
}

/** Parse one DF-*.md file back into a DfItem (app/project 양쪽 형식 허용). Returns null for unparsable files. */
export function parseFeedbackFile(folder: string, file: string): DfItem | null {
  const idMatch = /^DF-(\d+)\.md$/.exec(file);
  if (!idMatch) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, file), 'utf8');
  } catch {
    return null;
  }
  const id = `DF-${idMatch[1]!.padStart(4, '0')}`;

  // Header block: "Key: value" lines between the title and the first '## ' section.
  const bodyStart = /^## /m.exec(raw);
  const headerBlock = bodyStart ? raw.slice(0, bodyStart.index) : raw;
  const readKey = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(headerBlock);
    return (m?.[1] ?? '').trim();
  };

  const section = (name: string): string => {
    const start = raw.indexOf(`## ${name}`);
    if (start < 0) return '';
    const after = raw.indexOf('\n', start);
    if (after < 0) return '';
    const next = raw.slice(after + 1).search(/^## /m);
    const body = next >= 0 ? raw.slice(after + 1, after + 1 + next) : raw.slice(after + 1);
    return body.trim();
  };

  const kind: DfKind = raw.includes('## 발견 내용') ? 'project' : 'app';

  const context: DfContext = {};
  const ctxBody = section('Context');
  for (const line of ctxBody.split('\n')) {
    const m = /^(Project|Date|Agent|Run):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase() as 'project' | 'date' | 'agent' | 'run';
    context[key] = m[2]!.trim();
  }

  const statuses: DfStatus[] = ['OPEN', 'FIXED', 'HOLD'];
  const priorities: DfPriority[] = ['LOW', 'MEDIUM', 'HIGH'];
  const status = readKey('Status') as DfStatus;
  const type = dfTypeFromText(readKey('Type'));
  const priority = readKey('Priority') as DfPriority;
  if (!statuses.includes(status) || !type || !priorities.includes(priority)) {
    return null;
  }

  const projectName = kind === 'project'
    ? (section('Project').split('\n').map((s) => s.trim()).find(Boolean) || undefined)
    : undefined;

  return {
    id,
    folder: path.join(folder, file),
    status,
    type,
    priority,
    created: readKey('Created'),
    version: readKey('Version'),
    feedback: section('Feedback') || section('발견 내용'),
    desired: section('Desired') || section('기대했던 동작 / 원하는 방향'),
    context,
    kind,
    project: projectName ?? context.project,
  };
}

function nextIdInDir(dir: string): string {
  const nums: number[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^DF-(\d+)\.md$/.exec(f);
      if (m) nums.push(parseInt(m[1]!, 10));
    }
  }
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `DF-${String(next).padStart(4, '0')}`;
}

/** Next App Dogfooding id (zero-padded 4 digits). Gaps are not reused. */
export function nextFeedbackId(dataRoot: string): string {
  return nextIdInDir(dogfoodingDir(dataRoot));
}

/** Next Project Dogfooding id — 프로젝트마다 독립적인 번호 체계다. */
export function nextProjectFeedbackId(dataRoot: string, project: string): string {
  return nextIdInDir(projectDogfoodingDir(dataRoot, project));
}

interface DfWriteInput {
  kind: DfKind;
  project?: string;
  type: DfType;
  priority: DfPriority;
  feedback: string;
  desired: string;
  date?: string;
  agent?: string;
  run?: string;
}

/** Shared writer — app/project 모두 이 함수 하나로 파일을 만든다. */
function writeFeedbackFile(dir: string, payload: DfWriteInput, version: string): DfItem {
  fs.mkdirSync(dir, { recursive: true });
  const id = nextIdInDir(dir);
  // project md는 스펙 예시대로 사람이 읽는 라벨(UX / Friction 등)을 적고,
  // app md는 v0.2.0 호환을 위해 enum 토큰(UX 등)을 유지한다. 파서는 둘 다 받는다.
  const typeToken = payload.kind === 'project' ? dfTypeLabel(payload.type, 'project') : payload.type;
  const md = renderFeedbackMarkdown({
    id,
    kind: payload.kind,
    status: 'OPEN',
    typeLabel: typeToken,
    priority: payload.priority,
    created: todayString(),
    version,
    project: payload.project,
    date: payload.date,
    agent: payload.agent,
    run: payload.run,
    feedback: payload.feedback,
    desired: payload.desired,
  });
  fs.writeFileSync(path.join(dir, `${id}.md`), md, 'utf8');
  const item = parseFeedbackFile(dir, `${id}.md`);
  if (!item) throw new Error('피드백 파일을 다시 읽지 못했습니다.');
  return item;
}

/** Create an App Dogfooding record and return it. */
export function createFeedback(
  dataRoot: string,
  input: { type: DfType; priority: DfPriority; feedback: string; desired: string; context: DfContext },
  version: string,
): DfItem {
  const c = input.context;
  return writeFeedbackFile(dogfoodingDir(dataRoot), {
    kind: 'app',
    type: input.type,
    priority: input.priority,
    feedback: input.feedback,
    desired: input.desired,
    project: c?.project,
    date: c?.date,
    agent: c?.agent,
    run: c?.run,
  }, version);
}

/**
 * Create a Project Dogfooding record.
 * Project는 필수 Context, Agent/Run은 optional — 프로그램 사용 중 발견한 문제는
 * Run 없이도 기록할 수 있어야 하기 때문이다. 저장 위치는 항상 {project}/_dogfooding/.
 */
export function createProjectFeedback(
  dataRoot: string,
  project: string,
  input: { type: DfType; priority: DfPriority; feedback: string; desired: string; agent?: string; run?: string },
  version: string,
): DfItem {
  const projName = project === ROOT_PROJECT ? path.basename(dataRoot) : project;
  return writeFeedbackFile(projectDogfoodingDir(dataRoot, project), {
    kind: 'project',
    project: projName,
    type: input.type,
    priority: input.priority,
    feedback: input.feedback,
    desired: input.desired,
    date: todayString(),
    agent: input.agent || undefined,
    run: input.run || undefined,
  }, version);
}

function listInDir(dir: string): DfItem[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^DF-\d+\.md$/.test(f))
    .map((f) => parseFeedbackFile(dir, f))
    .filter((x): x is DfItem => x !== null)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** All App Dogfooding records, newest id first. */
export function listFeedbacks(dataRoot: string): DfItem[] {
  return listInDir(dogfoodingDir(dataRoot));
}

/** 현재 프로젝트의 Dogfooding만 반환한다 — 다른 프로젝트/App 기록과 절대 섞이지 않는다. */
export function listProjectFeedbacks(dataRoot: string, project: string): DfItem[] {
  return listInDir(projectDogfoodingDir(dataRoot, project));
}

function setStatusInDir(dir: string, id: string, status: DfStatus): DfItem {
  const safeId = slugify(id);
  const file = path.join(dir, `${safeId}.md`);
  const raw = fs.readFileSync(file, 'utf8');
  if (!/^Status:/m.test(raw)) throw new Error(`${id} 기록에서 Status를 찾을 수 없습니다.`);
  const updated = raw.replace(/^Status:\s*.*$/m, `Status: ${status}`);
  fs.writeFileSync(file, updated, 'utf8');
  const item = parseFeedbackFile(dir, `${safeId}.md`);
  if (!item) throw new Error(`${id} 기록을 다시 읽지 못했습니다.`);
  return item;
}

/** Change an App record's Status line (in the markdown — the SSOT). Returns the updated item. */
export function setFeedbackStatus(dataRoot: string, id: string, status: DfStatus): DfItem {
  return setStatusInDir(dogfoodingDir(dataRoot), id, status);
}

/** Change a Project record's Status line. Returns the updated item. */
export function setProjectFeedbackStatus(
  dataRoot: string,
  project: string,
  id: string,
  status: DfStatus,
): DfItem {
  return setStatusInDir(projectDogfoodingDir(dataRoot, project), id, status);
}

function readRawInDir(dir: string, id: string): string {
  const safeId = slugify(id);
  return readMarkdown(dir, `${safeId}.md`);
}

/** Raw markdown content of one App feedback record (for copy/export). */
export function readFeedbackRaw(dataRoot: string, id: string): string {
  return readRawInDir(dogfoodingDir(dataRoot), id);
}

/** Raw markdown content of one Project feedback record (for copy/export). */
export function readProjectFeedbackRaw(dataRoot: string, project: string, id: string): string {
  return readRawInDir(projectDogfoodingDir(dataRoot, project), id);
}
