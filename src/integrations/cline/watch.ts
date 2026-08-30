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
import { clineSessionsRoot, listClineSessions, ClineSessionEntry } from './storage.js';
import { summarizeClineSession, ClineSessionSummary } from './extract.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
const ARM_SKEW_MS = 1_500;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

class ClineWatchHandle implements WatchHandle {
  readonly adapterId = 'cline';
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
 * Cline adapter — passive completion observation over Cline CLI's on-disk
 * session state (~/.cline/data/sessions/<id>/).
 *
 * Does NOT launch Cline, modify settings, install hooks, or use ACP.
 * Purely read-only file polling.
 */
export class ClineAdapter implements AgentAdapter {
  readonly id = 'cline';
  readonly agentName = 'Cline';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new ClineWatchHandle(sink);
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';
    const workspaceFilter = target.workspaceRoot ? normalizePath(target.workspaceRoot) : null;

    const root = clineSessionsRoot();
    if (!root) {
      const message = 'Cline 세션 저장소(~/.cline/data/sessions)를 찾을 수 없습니다.';
      sink({ type: 'status', phase: 'error', detail: message });
      throw new Error(message);
    }
    sink({ type: 'status', phase: 'connecting' });

    if (debug) {
      console.error(`[cline-adapter] root=${root} workspaceFilter=${workspaceFilter ?? '(none)'}`);
    }

    /** sessionId → last {mtimeMs, summary}. */
    const statCache = new Map<string, { mtimeMs: number; summary: ClineSessionSummary }>();
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
          const allSessions = listClineSessions(root);
          totalSessions = allSessions.length;
          const sessions = allSessions.filter(
            (s: ClineSessionEntry) => s.mtimeMs >= sinceMs - ARM_SKEW_MS,
          );
          freshSessions = sessions.length;

          for (const s of sessions) {
            if (handle.isStopped()) break;

            const cached = statCache.get(s.sessionId);
            if (cached && cached.mtimeMs === s.mtimeMs) {
              const cs = cached.summary;
              const sid = cs.sessionId ?? s.sessionId;
              if (!observations.has(sid)) {
                const isNew = s.mtimeMs >= sinceMs - ARM_SKEW_MS;
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

            let metaRaw: string | null = null;
            let messagesRaw: string;

            try {
              metaRaw = fs.readFileSync(s.metaPath, 'utf8');
            } catch { /* meta file may be absent */ }

            try {
              messagesRaw = fs.readFileSync(s.messagesPath, 'utf8');
            } catch (err) {
              reportOnce(`Cline 세션 읽기 실패(${s.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            const summary = summarizeClineSession(metaRaw, messagesRaw);
            statCache.set(s.sessionId, { mtimeMs: s.mtimeMs, summary });

            const sessionId = summary.sessionId ?? s.sessionId;

            // Workspace filter
            if (workspaceFilter && summary.cwd) {
              const cwdNorm = normalizePath(summary.cwd);
              if (!cwdNorm.startsWith(workspaceFilter) && !workspaceFilter.startsWith(cwdNorm)) {
                if (debug) {
                  console.error(
                    `[cline-adapter] skip session=${sessionId} (cwd mismatch: ${summary.cwd} vs ${target.workspaceRoot})`,
                  );
                }
                continue;
              }
            }

            // isNew: session created at/after arm time
            const isNew = s.mtimeMs >= sinceMs - ARM_SKEW_MS;

            const startedAfterArm = turnStartedAfterArm(summary.startedAtIso, sinceMs, ARM_SKEW_MS);
            const completedAfterArm = turnCompletedAfterArm(summary.completedAtIso, sinceMs, ARM_SKEW_MS);

            if (debug) {
              console.error(
                `[cline-adapter] session=${sessionId} mtime=${s.mtimeMs} cwd=${summary.cwd ?? '?'} ` +
                `hasTurn=${summary.hasTurn} ready=${summary.ready} ` +
                `startedAfterArm=${startedAfterArm} completedAfterArm=${completedAfterArm} isNew=${isNew}`,
              );
            }

            observations.set(sessionId, {
              sessionId,
              directory: summary.cwd ?? undefined,
              updatedMs: s.mtimeMs,
              isNew,
              inFlight: summary.hasTurn && !summary.ready && startedAfterArm,
            });

            if (!summary.ready) continue;
            // completedAtIso gate: fall back to mtime-based check if no timestamp
            const completedGate = summary.completedAtIso
              ? completedAfterArm
              : s.mtimeMs >= sinceMs - ARM_SKEW_MS;
            if (!completedGate) continue;

            // Dedupe key: sessionId + messageId (or mtime if no messageId)
            const dedupeId = summary.messageId ?? String(s.mtimeMs);
            const key = `${sessionId}:${dedupeId}`;
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
              rawProtocolRef: summary.messageId
                ? `cline://session/${sessionId}/msg/${summary.messageId}`
                : undefined,
              completionKind:
                summary.kind === 'RESPONSE_COMPLETE' ||
                summary.kind === 'INTERRUPTED' ||
                summary.kind === 'PROCESS_FAILED'
                  ? summary.kind
                  : 'UNKNOWN',
            });
          }
        } catch (err) {
          reportOnce(`Cline 세션 스캔 실패: ${err instanceof Error ? err.message : String(err)}`);
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
            `[cline-adapter] poll#${successfulPasses}: sessions=${totalSessions} fresh=${freshSessions} ` +
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

export function createClineAdapter(): ClineAdapter {
  return new ClineAdapter();
}
