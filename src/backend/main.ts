/**
 * Agent Relay Log V0 — Electron main process.
 *
 * No database, no API, no cloud. This process only:
 *   - creates the branded window (React UI from dist/client)
 *   - answers single 'relay' IPC operations that read/write Markdown under
 *     the user-chosen DATA_ROOT.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as relay from './fs.js';
import {
  AppSettings,
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
      const view: SettingsView = { ...s, baseDir };
      return view;
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

    case 'prompt:save':
      return relay.writeMarkdown(req.folder, 'prompt.md', req.content, req.overwrite);

    case 'result:save':
      return relay.writeMarkdown(req.folder, 'result.md', req.content, req.overwrite);

    case 'folder:open': {
      await shell.openPath(req.folder);
      return true;
    }

    default:
      throw new Error('알 수 없는 요청입니다.');
  }
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

  // DEBUG: auto-open DevTools so renderer errors are always visible
  mainWindow.webContents.openDevTools();

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
