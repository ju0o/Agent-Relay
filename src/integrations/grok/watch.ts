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
import { grokSessionsRoot, listGrokSessions, decodeCwdDir, GrokSessionEntry } from './storage.js';
import { summarizeGrokSession, GrokSessionSummary } from './extract.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
const ARM_SKEW_MS = 1_500;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

class GrokWatchHandle implements WatchHandle {
  readonly adapterId = 'grok';
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
 * Grok adapter — passive completion observation over Grok CLI's on-disk
 * session storage (~/.grok/sessions/<cwd-encoded>/<session-uuid>/).
 *
 * Does NOT launch Grok, modify settings, or install plugins.
 * Purely read-only polling of summary.json and chat_history.jsonl.
 * The Owner runs `grok` normally; Relay observes from the outside.
 */
export class GrokAdapter implements AgentAdapter {
  readonly id = 'grok';
  readonly agentName = 'Grok';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new GrokWatchHandle(sink);
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';
    const workspaceFilter = target.workspaceRoot ? normalizePath(target.workspaceRoot) : null;

    const root = grokSessionsRoot();
    if (!root) {
      const message = 'Grok 세션 저장소(~/.grok/sessions)를 찾을 수 없습니다.';
      sink({ type: 'status', phase: 'error', detail: message });
      throw new Error(message);
    }
    sink({ type: 'status', phase: 'connecting' });

    if (debug) {
      console.error(`[grok-adapter] root=${root} workspaceFilter=${workspaceFilter ?? '(none)'}`);
    }

    const statCache = new Map<string, { mtimeMs: number; summary: GrokSessionSummary }>();
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
        let totalSessions = 0;
        let freshSessions = 0;

        try {
          const allSessions = listGrokSessions(root);
          totalSessions = allSessions.length;
          const sessions = allSessions.filter(
            (s: GrokSessionEntry) => s.mtimeMs >= sinceMs - ARM_SKEW_MS,
          );
          freshSessions = sessions.length;

          for (const s of sessions) {
            if (handle.isStopped()) break;

            const cached = statCache.get(s.sessionId);
            if (cached && cached.mtimeMs === s.mtimeMs) {
              const cs = cached.summary;
              const sid = cs.sessionId ?? s.sessionId;
              if (!observations.has(sid)) {
                const isNew = cs.createdAtIso !== null
                  ? Date.parse(cs.createdAtIso) >= sinceMs - ARM_SKEW_MS
                  : s.mtimeMs >= sinceMs - ARM_SKEW_MS;
                observations.set(sid, {
                  sessionId: sid,
                  directory: cs.cwd ?? undefined,
                  updatedMs: s.mtimeMs,
                  isNew,
                  inFlight:
                    cs.hasTurn && !cs.ready &&
                    turnStartedAfterArm(cs.startedAtIso, sinceMs, ARM_SKEW_MS),
                });
              }
              continue;
            }

            let summaryRaw: string;
            let chatHistoryRaw: string;

            try {
              summaryRaw = fs.readFileSync(s.summaryPath, 'utf8');
            } catch (err) {
              reportOnce(`Grok summary 읽기 실패(${s.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            try {
              chatHistoryRaw = fs.readFileSync(s.chatHistoryPath, 'utf8');
            } catch (err) {
              reportOnce(`Grok 채팅 히스토리 읽기 실패(${s.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            const summary = summarizeGrokSession(summaryRaw, chatHistoryRaw);
            statCache.set(s.sessionId, { mtimeMs: s.mtimeMs, summary });

            const sessionId = summary.sessionId ?? s.sessionId;

            // Workspace filter — Grok stores cwd in summary.json info.cwd.
            // Also derive from the URL-encoded directory name as a fallback.
            const effectiveCwd = summary.cwd ?? decodeCwdDir(s.cwdEncoded);
            if (workspaceFilter && effectiveCwd) {
              const cwdNorm = normalizePath(effectiveCwd);
              if (!cwdNorm.startsWith(workspaceFilter) && !workspaceFilter.startsWith(cwdNorm)) {
                if (debug) {
                  console.error(
                    `[grok-adapter] skip session=${sessionId} (cwd mismatch: ${effectiveCwd} vs ${target.workspaceRoot})`,
                  );
                }
                continue;
              }
            }

            const isNew = summary.createdAtIso !== null
              ? Date.parse(summary.createdAtIso) >= sinceMs - ARM_SKEW_MS
              : s.mtimeMs >= sinceMs - ARM_SKEW_MS;

            const startedAfterArm = turnStartedAfterArm(summary.startedAtIso, sinceMs, ARM_SKEW_MS);
            const completedAfterArm = turnCompletedAfterArm(summary.completedAtIso, sinceMs, ARM_SKEW_MS);

            if (debug) {
              console.error(
                `[grok-adapter] session=${sessionId} mtime=${s.mtimeMs} cwd=${effectiveCwd ?? '?'} ` +
                `hasTurn=${summary.hasTurn} ready=${summary.ready} ` +
                `startedAfterArm=${startedAfterArm} completedAfterArm=${completedAfterArm} isNew=${isNew}`,
              );
            }

            observations.set(sessionId, {
              sessionId,
              directory: effectiveCwd ?? undefined,
              updatedMs: s.mtimeMs,
              isNew,
              inFlight: summary.hasTurn && !summary.ready && startedAfterArm,
            });

            if (!summary.ready || !summary.turnKey) continue;

            // completedAt gate
            const completedGate = summary.completedAtIso
              ? completedAfterArm
              : s.mtimeMs >= sinceMs - ARM_SKEW_MS;
            if (!completedGate) continue;

            const key = `${sessionId}:${summary.turnKey}`;
            if (emittedTurns.has(key)) continue;
            emittedTurns.add(key);

            completions.push({
              adapterId: this.id,
              agentName: this.agentName,
              sessionId,
              workspace: effectiveCwd ?? '',
              startedAt: summary.startedAtIso ?? undefined,
              observedAt: new Date().toISOString(),
              terminalSignal: summary.terminalSignal,
              rawFinalText: summary.text,
              rawProtocolRef: `grok://session/${sessionId}`,
              completionKind:
                summary.kind === 'RESPONSE_COMPLETE' ||
                summary.kind === 'INTERRUPTED' ||
                summary.kind === 'PROCESS_FAILED'
                  ? summary.kind
                  : 'UNKNOWN',
            });
          }
        } catch (err) {
          reportOnce(`Grok 세션 스캔 실패: ${err instanceof Error ? err.message : String(err)}`);
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
            `[grok-adapter] poll#${successfulPasses}: sessions=${totalSessions} fresh=${freshSessions} ` +
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

export function createGrokAdapter(): GrokAdapter {
  return new GrokAdapter();
}
