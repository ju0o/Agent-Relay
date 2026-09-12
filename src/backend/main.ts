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
import * as goalTask from './goal-task.js';
import * as goalTaskRuntime from './goal-task-runtime.js';
import * as evidenceKernel from './evidence.js';
import * as eventKernel from './event.js';
import * as dispatcher from './dispatcher.js';
import * as pmWork from './pm-work.js';
import * as orphanResolution from './orphan-resolution.js';
import * as taskActions from './task-actions.js';
import { authorizeEffect } from './permission-gate.js';
import { CaptureManager } from './capture-manager.js';
import { setCaptureManager } from './capture-service.js';
import { migrateSettings } from './migrate.js';
import { checkForUpdates, downloadUpdate, initUpdater, installUpdate, updaterSupported } from './updater.js';
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
  UpdateEvent,
  UpdateStatus,
  CaptureStatusView,
  nextUpdateStatus,
} from '../shared/types.js';

/** Mutable runtime state. */
let baseDir = '';
let captureManager: CaptureManager | null = null;

function pushCaptureStatus(s: CaptureStatusView): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('relay-capture-status', s);
  }
}
function currentSettings(): AppSettings {
  return relay.loadSettings(baseDir);
}
function saveSettings(s: AppSettings): void {
  relay.saveSettings(baseDir, s);
}

/**
 * Choose where settings.json lives.
 *
 * v0.3 — 설치형/포터블이 뚜렷이 갈린다:
 *  - Portable exe: electron-builder portable이 설정하는 PORTABLE_EXECUTABLE_DIR
 *    (= exe 위치)에 그대로 저장 — USB 휴대 시 설정이 함께 이동.
 *  - Installed (NSIS): Program Files는 절대 쓰지 않고 Electron userData
 *    (%APPDATA%/agent-relay-log)를 사용한다.
 *  - Dev: 컴파일 출력 옆(__dirname).
 */
function resolveBaseDir(): string {
  if (!app.isPackaged) return __dirname;
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) {
    try {
      const probe = path.join(portableDir, '.agent-relay-log-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return portableDir;
    } catch {
      // fall through to userData
    }
  }
  return app.getPath('userData');
}

/**
 * 최초 실행 시 과거 버전의 settings.json을 현재 baseDir(userData)로 조용히 복사한다.
 *
 * 커버 범위:
 *  - v0.3.0 설치형: userData가 package.json name 기준이라 동일 위치 → 이관 불필요
 *  - ~v0.2.x portable 폴백: %APPDATA%/agent-relay-log/AgentRelayLog → 후보로 복사
 *  - portable exe 옆 settings.json: 위치를 알 수 없어 자동 이관 대상 아님 (문서화됨)
 *
 * - 원본은 절대 삭제하지 않는다 (destructive migration 금지).
 * - 실패해도 앱 시작을 막지 않는다.
 */
function migrateLegacySettings(): void {
  try {
    if (baseDir !== app.getPath('userData')) return; // installed 전용
    const candidates = [
      path.join(app.getPath('userData'), 'AgentRelayLog'),
    ];
    migrateSettings(baseDir, candidates);
  } catch {
    // 마이그레이션 실패는 치명적이지 않다 — 기본값으로 시작.
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

    case 'settings:setProjectOrder': {
      if (!Array.isArray(req.order)) throw new Error('order 배열이 필요합니다.');
      const s = currentSettings();
      s.projectOrder = req.order.map((x) => String(x));
      saveSettings(s);
      return s.projectOrder;
    }

    case 'settings:setAgentOrder': {
      if (!Array.isArray(req.order)) throw new Error('order 배열이 필요합니다.');
      const s = currentSettings();
      s.agentOrder = req.order.map((x) => String(x));
      saveSettings(s);
      return s.agentOrder;
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
      const prev = relay.readRunMeta(req.folder);
      relay.writeRunMeta(req.folder, { ...prev, tags: req.tags });
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

    case 'adapters:list': {
      if (!captureManager) throw new Error('앱이 아직 준비되지 않았습니다.');
      return captureManager.listAdapters();
    }

    case 'capture:arm': {
      if (!captureManager) throw new Error('앱이 아직 준비되지 않았습니다.');
      const adapterId = typeof req.adapterId === 'string' && req.adapterId ? req.adapterId : 'opencode';
      const captureId = typeof req.captureId === 'string' && req.captureId ? req.captureId : (req.folder ?? '');
      const folder = typeof req.folder === 'string' && req.folder ? req.folder : undefined;
      const isDraft = req.isDraft === true;
      await captureManager.arm(captureId, adapterId, { folder, isDraft, materializeParams: req.materializeParams });
      return { armed: true, captureId, folder: folder ?? null, adapterId };
    }

    case 'capture:disarm': {
      if (!captureManager) throw new Error('앱이 아직 준비되지 않았습니다.');
      const captureIdOrFolder = typeof req.captureId === 'string' && req.captureId
        ? req.captureId
        : typeof req.folder === 'string' && req.folder
          ? req.folder
          : null;
      if (!captureIdOrFolder) throw new Error('disarm에는 captureId 또는 folder가 필요합니다.');
      await captureManager.disarm(captureIdOrFolder);
      return true;
    }

    case 'capture:select': {
      if (!captureManager) throw new Error('앱이 아직 준비되지 않았습니다.');
      const captureIdOrFolder = typeof req.captureId === 'string' && req.captureId
        ? req.captureId
        : typeof req.folder === 'string' && req.folder
          ? req.folder
          : undefined;
      const ok = captureManager.selectSession(req.sessionId, captureIdOrFolder);
      if (!ok) throw new Error('세션을 선택할 수 없습니다. 감시가 활성 상태인지 확인하세요.');
      return { selected: req.sessionId };
    }

    case 'run:materialize': {
      // Authoritative path: if a captureId is present, route through materializeOnce()
      // which deduplicates concurrent requests for the SAME captureId — preventing a
      // prompt-save IPC and an auto-capture persist() from allocating two different
      // Run numbers and splitting prompt.md / agent-result.md across them.
      const params = { dataRoot: req.dataRoot, project: req.project, date: req.date, agent: req.agent };
      let result: { folder: string; run: string };
      if (captureManager && typeof req.captureId === 'string' && req.captureId) {
        result = await captureManager.materializeOnce(req.captureId, params);
      } else {
        // Legacy / no-captureId path: direct allocation.
        result = await relay.atomicMaterializeRun(req.dataRoot, req.project, req.date, req.agent);
      }
      const out: RunFolderResult = { folder: result.folder, run: result.run };
      return out;
    }

    case 'capture:updateDraftParams': {
      if (!captureManager) throw new Error('앱이 아직 준비되지 않았습니다.');
      if (typeof req.captureId !== 'string' || !req.captureId) throw new Error('captureId가 필요합니다.');
      captureManager.updateDraftParams(req.captureId, req.materializeParams);
      return true;
    }

    case 'goal:create':
      return goalTask.createGoal(req.dataRoot, req.project, {
        title: req.title,
        goalStatement: req.goalStatement,
        description: req.description,
        tags: req.tags,
        completionCriteria: req.completionCriteria,
        permissionPolicy: req.permissionPolicy,
        status: req.status,
      });

    case 'goal:get':
      return goalTask.getGoal(req.dataRoot, req.project, req.goalId);

    case 'goal:list':
      return goalTask.listGoals(req.dataRoot, req.project);

    case 'goal:update':
      return goalTask.updateGoal(req.dataRoot, req.project, req.goalId, req.patch ?? {});

    case 'goal:progress':
      return goalTask.getGoalProgress(req.dataRoot, req.project, req.goalId);

    case 'goal:getRuntimeState':
      return goalTaskRuntime.getGoalRuntimeState(req.dataRoot, req.project, req.goalId);

    case 'goal:evaluateCompletion':
      return goalTaskRuntime.evaluateGoalCompletionForId(req.dataRoot, req.project, req.goalId);

    case 'goal:transition':
      return goalTaskRuntime.transitionGoalStatus(req.dataRoot, req.project, req.goalId, req.to, req.reason);

    case 'goal:complete': {
      const goal = goalTask.getGoal(req.dataRoot, req.project, req.goalId);
      authorizeEffect({
        effect: 'COMPLETE_GOAL',
        callerSurface: 'OWNER_IPC',
        permissionPolicy: goal.permissionPolicy ?? { mode: 'PLAN' },
      });
      const completed = req.expectedGoalStatus
        ? goalTaskRuntime.completeGoalWithExpected(req.dataRoot, req.project, req.goalId, {
            expectedGoalStatus: req.expectedGoalStatus,
            reason: req.reason,
          })
        : goalTaskRuntime.completeGoal(req.dataRoot, req.project, req.goalId, req.reason);
      try {
        await eventKernel.recordGoalCompleted(req.dataRoot, req.project, {
          summary: `Goal ${req.goalId} completed`,
          goalId: req.goalId,
          source: { kind: 'owner-ipc', subsystem: 'goal:complete' },
          details: { status: completed.status },
          sourceEventId: `goal-completed:${req.project}:${req.goalId}:${completed.updatedAt}`,
        });
      } catch { /* best-effort */ }
      return completed;
    }

    case 'task:dispatch': {
      const task = goalTask.getTask(req.dataRoot, req.project, req.taskId);
      const goal = goalTask.getGoal(req.dataRoot, req.project, task.goalId);
      authorizeEffect({
        effect: 'DISPATCH',
        callerSurface: 'OWNER_IPC',
        permissionPolicy: goal.permissionPolicy ?? { mode: 'PLAN' },
      });
      return dispatcher.dispatchTask(req.dataRoot, req.project, {
        taskId: req.taskId,
        workerId: req.workerId,
        workspaceRoot: req.workspaceRoot,
        expectedExecutionState: req.expectedExecutionState,
      });
    }

    case 'task:resolveOrphan':
      return orphanResolution.resolveOrphan({
        dataRoot: req.dataRoot,
        project: req.project,
        taskId: req.taskId,
        action: req.action,
        callerSurface: 'OWNER_IPC',
        expectedExecutionState: req.expectedExecutionState,
        reason: req.reason,
      });

    case 'pm:getNextWork':
      return pmWork.getNextWork(req.dataRoot, req.project);

    case 'workers:list':
      return dispatcher.listWorkersPublic(req.dataRoot);

    case 'task:create':
      return goalTask.createTask(req.dataRoot, req.project, {
        goalId: req.goalId,
        title: req.title,
        goal: req.goal,
        reason: req.reason,
        scope: req.scope,
        completionCriteria: req.completionCriteria,
        dependencies: req.dependencies,
        executionState: req.executionState,
        pmState: req.pmState,
      });

    case 'task:get':
      return goalTask.getTask(req.dataRoot, req.project, req.taskId);

    case 'task:list':
      return goalTask.listTasks(req.dataRoot, req.project, req.goalId);

    case 'task:update':
      return goalTask.updateTask(req.dataRoot, req.project, req.taskId, req.patch ?? {});

    case 'task:linkRun':
      return goalTask.linkRunToTask(req.dataRoot, req.project, req.taskId, req.runFolder);

    case 'task:unlinkRun':
      return goalTask.unlinkRunFromTask(req.dataRoot, req.project, req.taskId, req.runFolder);

    case 'task:getReadiness':
      return goalTaskRuntime.getTaskReadinessForId(req.dataRoot, req.project, req.taskId);

    case 'task:refreshReadiness':
      return goalTaskRuntime.refreshTaskReadiness(req.dataRoot, req.project, req.taskId);

    case 'task:transitionExecution':
      return goalTaskRuntime.transitionTaskExecution(req.dataRoot, req.project, req.taskId, {
        expectedExecutionState: req.expectedExecutionState,
        to: req.to,
        reason: req.reason,
      });

    case 'task:transitionPm':
      return goalTaskRuntime.transitionTaskPm(req.dataRoot, req.project, req.taskId, {
        expectedPmState: req.expectedPmState,
        to: req.to,
        reason: req.reason,
        acceptedRunId: req.acceptedRunId,
      });

    case 'task:markResultReceived':
      return goalTaskRuntime.markResultReceived(req.dataRoot, req.project, req.taskId, req.runId, {
        expectedExecutionState: req.expectedExecutionState,
      });

    case 'task:acceptResult':
      return taskActions.acceptTaskResult({
        dataRoot: req.dataRoot,
        project: req.project,
        goalId: req.goalId,
        taskId: req.taskId,
        runId: req.runId,
        reason: req.reason,
        expectedPmState: req.expectedPmState,
        expectedExecutionState: req.expectedExecutionState,
        callerSurface: 'OWNER_IPC',
      });

    case 'task:requestChanges':
      return taskActions.requestTaskChanges({
        dataRoot: req.dataRoot,
        project: req.project,
        goalId: req.goalId,
        taskId: req.taskId,
        runId: req.runId,
        reason: req.reason,
        expectedExecutionState: req.expectedExecutionState,
        expectedPmState: req.expectedPmState,
        callerSurface: 'OWNER_IPC',
      });

    case 'task:requestRetry':
      return taskActions.requestTaskRetry({
        dataRoot: req.dataRoot,
        project: req.project,
        goalId: req.goalId,
        taskId: req.taskId,
        reason: req.reason,
        expectedExecutionState: req.expectedExecutionState,
        expectedPmState: req.expectedPmState,
        callerSurface: 'OWNER_IPC',
      });

    case 'evidence:recordWorkerClaim':
      return evidenceKernel.recordWorkerClaim(req.dataRoot, req.project, req.input);

    case 'evidence:recordAdapterObservation':
      return evidenceKernel.recordAdapterObservation(req.dataRoot, req.project, req.input);

    case 'evidence:recordGit':
      return evidenceKernel.recordGitEvidence(req.dataRoot, req.project, req.input);

    case 'evidence:recordTest':
      return evidenceKernel.recordTestEvidence(req.dataRoot, req.project, req.input);

    case 'evidence:recordBuild':
      return evidenceKernel.recordBuildEvidence(req.dataRoot, req.project, req.input);

    case 'evidence:recordQa':
      return evidenceKernel.recordQaEvidence(req.dataRoot, req.project, req.input);

    case 'evidence:recordPmDecision':
      return evidenceKernel.recordPmDecision(req.dataRoot, req.project, req.input);

    case 'evidence:get':
      return evidenceKernel.getEvidence(req.dataRoot, req.project, req.evidenceId);

    case 'evidence:listForRun':
      return evidenceKernel.listEvidenceForRun(req.dataRoot, req.project, req.runId);

    case 'evidence:listForTask':
      return evidenceKernel.listEvidenceForTask(
        req.dataRoot,
        req.project,
        req.taskId,
        req.includeRunEvidence !== false,
      );

    case 'evidence:listForGoal':
      return evidenceKernel.listEvidenceForGoal(req.dataRoot, req.project, req.goalId);

    case 'evidence:getRunSummary':
      return evidenceKernel.getRunEvidenceSummary(req.dataRoot, req.project, req.runId);

    case 'evidence:getTaskSummary':
      return evidenceKernel.getTaskEvidenceSummary(req.dataRoot, req.project, req.taskId);

    case 'evidence:evaluateTask':
      return evidenceKernel.evaluateTaskEvidence(req.dataRoot, req.project, req.taskId);

    // Phase D — Event runtime kernel. Read + delivery ops only.
    // NO raw event:create is exposed; Event creation happens via trusted typed helpers internally.
    case 'event:get':
      return eventKernel.getEvent(req.dataRoot, req.project, req.eventId);

    case 'event:list':
      return eventKernel.listEvents(req.dataRoot, req.project, req.filter);

    case 'event:listPendingPm':
      return eventKernel.listPendingPmEvents(req.dataRoot, req.project);

    case 'event:getSummary':
      return eventKernel.getEventRuntimeSummary(req.dataRoot, req.project);

    case 'event:markDelivered':
      if (req.expectedStatus === undefined) {
        throw new Error('event:markDelivered에는 expectedStatus가 필요합니다.');
      }
      return eventKernel.markDelivered(req.dataRoot, req.project, req.eventId, req.expectedStatus);

    case 'event:acknowledge':
      if (req.expectedStatus === undefined) {
        throw new Error('event:acknowledge에는 expectedStatus가 필요합니다.');
      }
      return eventKernel.acknowledge(req.dataRoot, req.project, req.eventId, req.expectedStatus);

    case 'event:ignore':
      if (req.expectedStatus === undefined) {
        throw new Error('event:ignore에는 expectedStatus가 필요합니다.');
      }
      return eventKernel.ignore(req.dataRoot, req.project, req.eventId, req.expectedStatus);

    case 'update:check': {
      if (!updaterSupported(app.isPackaged)) {
        throw new Error('개발 모드에서는 업데이트를 확인할 수 없습니다. (설치된 앱에서만 동작)');
      }
      manualCheck = true;
      void checkForUpdates().catch(() => undefined); // errors arrive via 'error' event
      return true;
    }

    case 'update:download':
      downloadUpdate();
      return true;

    case 'update:install':
      installUpdate();
      return true;

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

// ── In-app updater state ────────────────────────────────────────────────────
// electron-updater 이벤트 → 순수 상태 머신(nextUpdateStatus) → 렌더러 푸시.
let manualCheck = false;
const initialUpdateStatus: UpdateStatus = { phase: 'idle', version: app.getVersion() };
let updateStatusState: UpdateStatus = initialUpdateStatus;

function pushUpdateStatus(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('relay-update-status', updateStatusState);
  }
}

function handleUpdateEvent(e: UpdateEvent): void {
  // 한 사이클(확인 결과/에러)이 끝나면 manual 플래그를 되돌린다.
  // (updater는 이벤트 발생 시점에 isManual()으로 플래그를 읽어 간다)
  if (e.type === 'not-available' || e.type === 'available' || e.type === 'error') {
    manualCheck = false;
  }
  updateStatusState = nextUpdateStatus(updateStatusState, e);
  pushUpdateStatus();
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

/** DevTools 단축키는 개발 중에만 허용 — packaged production에서는 F12 노출 금지. */
export function shouldEnableDevToolsShortcut(isPackaged: boolean): boolean {
  return !isPackaged;
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

  // ── F12 / Ctrl+Shift+I → DevTools (개발 중에만; production 패키지에서는 비활성화) ──
  if (shouldEnableDevToolsShortcut(app.isPackaged)) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (
        input.type === 'keyDown' &&
        ((input.key === 'F12') ||
          (input.control && input.shift && input.key === 'I'))
      ) {
        mainWindow?.webContents.openDevTools();
      }
    });
  }

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
  migrateLegacySettings();
  registerIpc();
  createWindow();

  // ── Agent adapter auto-capture ──
  captureManager = new CaptureManager(pushCaptureStatus, {
    materializeFn: async (_captureId, params) => {
      return relay.atomicMaterializeRun(params.dataRoot, params.project, params.date, params.agent);
    },
  });
  setCaptureManager(captureManager);

  // ── Updater ──
  // 시작 후 조용히 1회 확인(정책상 자동 다운로드/설치 없음). 새 버전이 있으면
  // 렌더러가 작은 알림을 띄우고, 설치는 사용자가 설정에서 진행한다.
  if (updaterSupported(app.isPackaged)) {
    initUpdater({ emit: handleUpdateEvent, isManual: () => manualCheck });
    setTimeout(() => {
      void checkForUpdates().catch(() => undefined);
    }, 4000);
  }

  app.on('window-all-closed', () => {
    void captureManager?.dispose();
    app.quit();
  });
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
