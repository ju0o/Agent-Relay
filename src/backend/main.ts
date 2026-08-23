/**
 * Agent Relay Log V0 — Electron main process.
 *
 * No database, no API, no cloud. This process only:
 *   - creates the branded window (React UI from dist/client)
 *   - answers single 'relay' IPC operations that read/write Markdown under
 *     the user-chosen DATA_ROOT.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as relay from './fs.js';
import {
  AppSettings,
  DfContext,
  DfItem,
  DfPriority,
  DfStatus,
  DfType,
  ProjectViewData,
  RelayRequest,
  RelayResponse,
  RunFolderResult,
  SettingsView,
} from '../shared/types.js';

/** Mutable runtime state. */
let baseDir = '';
function currentSettings(): AppSettings {
  return relay.loadSettings(baseDir);
}
function saveSettings(s: AppSettings): void {
  relay.saveSettings(baseDir, s);
}

/**
 * Choose where settings.json lives.
 *  - Dev / co-located builds: next to main.js (or a writable exe folder).
 *  - Portable single-exe (extracted to a temp dir): fall back to %APPDATA% so
 *    the chosen DATA_ROOT survives.
 */
function resolveBaseDir(): string {
  const exeDir = app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
  try {
    const probe = path.join(exeDir, '.agent-relay-log-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return exeDir;
  } catch {
    return path.join(app.getPath('userData'), 'AgentRelayLog');
  }
}

/** Dispatch a single relay operation to the filesystem layer. */
async function handleRequest(req: RelayRequest): Promise<unknown> {
  switch (req.op) {
    case 'settings:get': {
      const s = currentSettings();
      const view: SettingsView = {
        ...s,
        baseDir,
        appVersion: app.getVersion(),
        dataRootExists: relay.dataRootExists(s.dataRoot),
      };
      return view;
    }

    case 'settings:setLastProject': {
      const s = currentSettings();
      s.lastProject = req.project || '';
      saveSettings(s);
      return true;
    }

    case 'settings:setDataRoot': {
      if (!req.path) throw new Error('DATA_ROOT 경로가 비어 있습니다.');
      const resolved = path.resolve(req.path);
      relay.ensureDataRoot(resolved);
      const s = currentSettings();
      s.dataRoot = resolved;
      saveSettings(s);
      return s;
    }

    case 'folder:pick': {
      const picked = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || picked.filePaths.length === 0) return { selected: null };
      return { selected: picked.filePaths[0] };
    }

    case 'agents:add': {
      const s = currentSettings();
      const name = (req.name || '').trim();
      if (!name) throw new Error('에이전트 이름을 입력하세요.');
      if (!s.customAgents.includes(name)) {
        s.customAgents = [...s.customAgents, name];
        saveSettings(s);
      }
      return s.customAgents;
    }

    case 'projects:list':
      return relay.listProjects(req.dataRoot);

    case 'projects:create':
      return relay.createProject(req.dataRoot, req.name);

    case 'project:view': {
      const data: ProjectViewData = {
        projects: relay.listProjects(req.dataRoot),
        history: relay.buildHistory(req.dataRoot, req.project),
      };
      return data;
    }

    case 'run:next':
      return relay.nextRunNumber(req.dataRoot, req.project, req.date, req.agent);

    case 'run:ensureFolder': {
      const folder = relay.ensureRunFolder(
        req.dataRoot,
        req.project,
        req.date,
        req.agent,
        req.run,
      );
      const out: RunFolderResult = { folder, run: req.run };
      return out;
    }

    case 'run:read':
      return relay.readRun(req.folder);

    case 'run:delete': {
      if (!req.folder) throw new Error('folder가 필요합니다.');
      relay.deleteRun(req.folder);
      return true;
    }

    case 'run:export': {
      if (!req.folder) throw new Error('folder가 필요합니다.');
      const content = relay.exportRunMarkdown(req.folder);
      const runBase = path.basename(req.folder);
      const agentBase = path.basename(path.dirname(req.folder));
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: `${agentBase}-run-${runBase}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (canceled || !filePath) return { saved: false };
      fs.writeFileSync(filePath, content, 'utf8');
      return { saved: true, filePath };
    }

    case 'run:tagUpdate': {
      if (!req.folder) throw new Error('folder가 필요합니다.');
      relay.writeRunMeta(req.folder, { tags: req.tags });
      return req.tags;
    }

    case 'run:move': {
      if (!req.fromFolder) throw new Error('fromFolder가 필요합니다.');
      const newFolder = relay.moveRun(req.fromFolder, req.dataRoot, req.project, req.toDate, req.toAgent);
      return { folder: newFolder };
    }

    case 'date:delete': {
      if (!req.date) throw new Error('date가 필요합니다.');
      relay.deleteDateFolder(req.dataRoot, req.project, req.date);
      return true;
    }

    case 'agent:delete': {
      if (!req.agent) throw new Error('agent가 필요합니다.');
      relay.deleteAgentFolder(req.dataRoot, req.project, req.date, req.agent);
      return true;
    }

    case 'project:delete': {
      relay.deleteProject(req.dataRoot, req.project);
      return true;
    }

    case 'prompt:save':
      return relay.writeMarkdown(req.folder, 'prompt.md', req.content, req.overwrite);

    case 'result:save':
      return relay.writeMarkdown(req.folder, 'result.md', req.content, req.overwrite);

    case 'folder:open': {
      await shell.openPath(req.folder);
      return true;
    }

    case 'file:reveal': {
      // Opens Explorer (platform file manager) with the file selected.
      if (!req.path) throw new Error('path가 필요합니다.');
      shell.showItemInFolder(req.path);
      return true;
    }

    case 'df:list':
      return relay.listFeedbacks(req.dataRoot);

    case 'df:create': {
      const item: DfItem = relay.createFeedback(
        req.dataRoot,
        {
          type: req.type,
          priority: req.priority,
          feedback: req.feedback,
          desired: req.desired,
          context: sanitizeDfContext(req.context),
        },
        app.getVersion(),
      );
      return item;
    }

    case 'df:setStatus': {
      const statuses: DfStatus[] = ['OPEN', 'FIXED', 'HOLD'];
      if (!statuses.includes(req.status)) throw new Error('알 수 없는 상태입니다.');
      return relay.setFeedbackStatus(req.dataRoot, req.id, req.status);
    }

    case 'df:read':
      return relay.readFeedbackRaw(req.dataRoot, req.id);

    case 'pdf:list':
      return relay.listProjectFeedbacks(req.dataRoot, req.project);

    case 'pdf:create': {
      const item: DfItem = relay.createProjectFeedback(
        req.dataRoot,
        req.project,
        {
          type: req.type,
          priority: req.priority,
          feedback: req.feedback,
          desired: req.desired,
          agent: typeof req.agent === 'string' && req.agent ? req.agent : undefined,
          run: typeof req.run === 'string' && req.run ? req.run : undefined,
        },
        app.getVersion(),
      );
      return item;
    }

    case 'pdf:setStatus': {
      const statuses: DfStatus[] = ['OPEN', 'FIXED', 'HOLD'];
      if (!statuses.includes(req.status)) throw new Error('알 수 없는 상태입니다.');
      return relay.setProjectFeedbackStatus(req.dataRoot, req.project, req.id, req.status);
    }

    case 'pdf:read':
      return relay.readProjectFeedbackRaw(req.dataRoot, req.project, req.id);

    default:
      throw new Error('알 수 없는 요청입니다.');
  }
}

/** Keep only the known string fields of a feedback context. */
function sanitizeDfContext(ctx: DfContext): DfContext {
  return {
    project: typeof ctx?.project === 'string' ? ctx.project : undefined,
    date: typeof ctx?.date === 'string' ? ctx.date : undefined,
    agent: typeof ctx?.agent === 'string' ? ctx.agent : undefined,
    run: typeof ctx?.run === 'string' ? ctx.run : undefined,
  };
}

function registerIpc(): void {
  ipcMain.handle('relay', async (_e, req: RelayRequest): Promise<RelayResponse<unknown>> => {
    try {
      const value = await handleRequest(req);
      return { ok: true, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  // ── Native file drag-out (result.md → ChatGPT input 등) ──
  // Renderer calls window.relayApi.dragFile(path); we enter the OS drag loop
  // with the real file so dropping on another app attaches it like a normal
  // file drag from Explorer.
  ipcMain.on('relay-drag-file', (event, filePath: unknown) => {
    try {
      if (typeof filePath !== 'string' || !filePath) return;
      if (!fs.existsSync(filePath)) return;
      event.sender.startDrag({ file: filePath, icon: dragIcon() });
    } catch {
      // Drag-out is best-effort; never crash the app here.
    }
  });
}

/** 1x1 transparent PNG — fallback when the drag icon asset is missing. */
const DRAG_ICON_FALLBACK =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let _dragIcon: Electron.NativeImage | null = null;
function dragIcon(): Electron.NativeImage {
  if (!_dragIcon) {
    // vite copies public/ → dist/client; main.js sits in dist/server/backend.
    const p = path.join(__dirname, '..', '..', 'client', 'drag-md.png');
    const img = nativeImage.createFromPath(p);
    _dragIcon = img.isEmpty() ? nativeImage.createFromDataURL(DRAG_ICON_FALLBACK) : img;
  }
  return _dragIcon;
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    title: 'Agent Relay Log',
    backgroundColor: '#17181c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // contextIsolation defaults to true in Electron 28 — keep default
    },
  });

  // ── F12 / Ctrl+Shift+I → DevTools (even in production builds) ──
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (
      input.type === 'keyDown' &&
      ((input.key === 'F12') ||
        (input.control && input.shift && input.key === 'I'))
    ) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // DevTools는 F12 또는 Ctrl+Shift+I로 열 수 있습니다 (위에 등록됨)

  // ── Detect page-load failure and show a diagnostic dialog ──
  const clientPath = path.join(__dirname, '..', '..', 'client', 'index.html');

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    dialog.showErrorBox(
      'Agent Relay Log — 페이지 로드 실패',
      `오류 코드: ${code}\n설명: ${desc}\n\n시도한 경로:\n${clientPath}\n\n경로가 존재하는지 확인하세요.`,
    );
  });

  // ── Load UI ──
  if (!fs.existsSync(clientPath)) {
    dialog.showErrorBox(
      'Agent Relay Log — index.html 없음',
      `다음 경로에 index.html이 없습니다:\n${clientPath}\n\n앱을 다시 빌드하거나 재설치하세요.`,
    );
    return;
  }

  void mainWindow.loadFile(clientPath);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.agentrelaylog.v0');
  baseDir = resolveBaseDir();
  fs.mkdirSync(baseDir, { recursive: true });
  registerIpc();
  createWindow();

  app.on('window-all-closed', () => {
    app.quit();
  });
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
