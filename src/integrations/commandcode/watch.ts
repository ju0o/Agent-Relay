import * as fs from 'fs';
import {
  AgentAdapter,
  AgentCompletion,
  AdapterEvent,
  SessionObservation,
  WatchHandle,
  WatchTarget,
} from '../core/types.js';
import { turnStartedAfterArm, turnCompletedAfterArm } from '../core/binding.js';
import { commandCodeProjectsRoot, listCommandCodeSessionFiles, CmdcSessionFile } from './storage.js';
import { summarizeCmdcSession, CmdcSessionSummary } from './extract.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
const ARM_SKEW_MS = 1_500;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

class CommandCodeWatchHandle implements WatchHandle {
  readonly adapterId = 'commandcode';
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly sink: (e: AdapterEvent) => void) {}

  isStopped(): boolean { return this.stopped; }

  later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      if (!this.stopped) fn();
    }, ms);
    this.timers.push(t);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.sink({ type: 'status', phase: 'stopped' });
  }
}

/**
 * CommandCode (cmdc) adapter — passive completion observation over the
 * ~/.commandcode/projects/ session transcript files.
 *
 * Does NOT launch cmdc, modify any settings, or install hooks.
 * "Transport response completed" is separated from "task success": we report
 * RESPONSE_COMPLETE when the turn's final assistant message is a terminal
 * text response, regardless of whether the coding task itself succeeded.
 */
export class CommandCodeAdapter implements AgentAdapter {
  readonly id = 'commandcode';
  readonly agentName = 'CommandCode';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new CommandCodeWatchHandle(sink);
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';
    const workspaceFilter = target.workspaceRoot ? normalizePath(target.workspaceRoot) : null;

    const root = commandCodeProjectsRoot();
    if (!root) {
      const message = 'CommandCode 세션 저장소(~/.commandcode/projects)를 찾을 수 없습니다.';
      sink({ type: 'status', phase: 'error', detail: message });
      throw new Error(message);
    }
    sink({ type: 'status', phase: 'connecting' });

    if (debug) {
      console.error(`[cmdc-adapter] root=${root} workspaceFilter=${workspaceFilter ?? '(none)'}`);
    }

    const statCache = new Map<string, { size: number; mtimeMs: number; summary: CmdcSessionSummary }>();
    const emittedTurns = new Set<string>();
    let successfulPasses = 0;
    let lastErrorMessage = '';

    const reportOnce = (message: string): void => {
      if (message === lastErrorMessage) return;
      lastErrorMessage = message;
      sink({ type: 'error', message });
    };

    const tick = async (): Promise<void> => {
      if (handle.isStopped()) return;
      try {
        const observations = new Map<string, SessionObservation>();
        const completions: AgentCompletion[] = [];
        let failures = 0;
        let totalFiles = 0;
        let freshFiles = 0;

        try {
          const allFiles = listCommandCodeSessionFiles(root);
          totalFiles = allFiles.length;
          const files = allFiles.filter((f: CmdcSessionFile) => f.mtimeMs >= sinceMs - ARM_SKEW_MS);
          freshFiles = files.length;

          for (const f of files) {
            if (handle.isStopped()) break;

            const cached = statCache.get(f.sessionId);
            if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
              const cs = cached.summary;
              const sid = cs.sessionId ?? f.sessionId;
              if (!observations.has(sid)) {
                const isNew = f.mtimeMs >= sinceMs - ARM_SKEW_MS;
                observations.set(sid, {
                  sessionId: sid,
                  directory: cs.cwd ?? undefined,
                  updatedMs: f.mtimeMs,
                  isNew,
                  inFlight:
                    cs.hasTurn && !cs.ready &&
                    turnStartedAfterArm(cs.startedAtIso, sinceMs, ARM_SKEW_MS),
                });
              }
              continue;
            }

            let raw: string;
            try {
              raw = fs.readFileSync(f.path, 'utf8');
            } catch (err) {
              reportOnce(`CommandCode 세션 읽기 실패(${f.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            const summary = summarizeCmdcSession(raw);
            statCache.set(f.sessionId, { size: f.size, mtimeMs: f.mtimeMs, summary });

            const sessionId = summary.sessionId ?? f.sessionId;

            // Workspace filter
            if (workspaceFilter && summary.cwd) {
              const cwdNorm = normalizePath(summary.cwd);
              if (!cwdNorm.startsWith(workspaceFilter) && !workspaceFilter.startsWith(cwdNorm)) {
                if (debug) {
                  console.error(
                    `[cmdc-adapter] skip session=${sessionId} (cwd mismatch: ${summary.cwd} vs ${target.workspaceRoot})`,
                  );
                }
                continue;
              }
            }

            // isNew: session was created after arm time
            // We use the session's own startedAtIso as the creation timestamp.
            const isNew = summary.startedAtIso !== null
              ? Date.parse(summary.startedAtIso) >= sinceMs - ARM_SKEW_MS
              : f.mtimeMs >= sinceMs - ARM_SKEW_MS;

            const startedAfterArm = turnStartedAfterArm(summary.startedAtIso, sinceMs, ARM_SKEW_MS);
            const completedAfterArm = turnCompletedAfterArm(summary.completedAtIso, sinceMs, ARM_SKEW_MS);

            if (debug) {
              console.error(
                `[cmdc-adapter] session=${sessionId} mtime=${f.mtimeMs} cwd=${summary.cwd ?? '?'} ` +
                `hasTurn=${summary.hasTurn} ready=${summary.ready} ` +
                `startedAfterArm=${startedAfterArm} completedAfterArm=${completedAfterArm} isNew=${isNew}`,
              );
            }

            observations.set(sessionId, {
              sessionId,
              directory: summary.cwd ?? undefined,
              updatedMs: f.mtimeMs,
              isNew,
              inFlight: summary.hasTurn && !summary.ready && startedAfterArm,
            });

            if (!summary.ready || !summary.messageId) continue;
            if (!completedAfterArm) continue;

            const key = `${sessionId}:${summary.messageId}`;
            if (emittedTurns.has(key)) continue;
            emittedTurns.add(key);

            completions.push({
              adapterId: this.id,
              agentName: this.agentName,
              sessionId,
              workspace: summary.cwd ?? '',
              startedAt: summary.startedAtIso ?? undefined,
              observedAt: new Date().toISOString(),
              terminalSignal: summary.terminalSignal,
              rawFinalText: summary.text,
              rawProtocolRef: `commandcode://session/${sessionId}/msg/${summary.messageId}`,
              completionKind:
                summary.kind === 'RESPONSE_COMPLETE' ||
                summary.kind === 'INTERRUPTED' ||
                summary.kind === 'PROCESS_FAILED'
                  ? summary.kind
                  : 'UNKNOWN',
            });
          }
        } catch (err) {
          reportOnce(`CommandCode 세션 스캔 실패: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }

        if (handle.isStopped()) return;

        if (failures === 0 || observations.size > 0) {
          successfulPasses++;
          sink({ type: 'sessions', sessions: [...observations.values()], armPass: successfulPasses === 1 });
          for (const c of completions) sink({ type: 'completion', completion: c });
        }

        if (debug && !handle.isStopped()) {
          console.error(
            `[cmdc-adapter] poll#${successfulPasses}: files=${totalFiles} fresh=${freshFiles} ` +
            `obs=${observations.size} emitted=${emittedTurns.size} failures=${failures}`,
          );
        }
        if (!handle.isStopped()) sink({ type: 'status', phase: 'watching' });
      } finally {
        handle.later(() => void tick(), POLL_MS);
      }
    };

    handle.later(() => void tick(), POLL_MS);
    handle.later(() => {
      if (!handle.isStopped()) {
        sink({ type: 'status', phase: 'stopped', detail: '감시 시간이 초과되어 자동 수신을 종료했습니다.' });
        void handle.stop();
      }
    }, WATCH_TIMEOUT_MS);

    return handle;
  }
}

export function createCommandCodeAdapter(): CommandCodeAdapter {
  return new CommandCodeAdapter();
}
