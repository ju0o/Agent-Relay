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
import { codexSessionsRoot, listCodexSessionFiles, CodexSessionFile } from './storage.js';
import { summarizeCodexSession, CodexSessionSummary } from './extract.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
/** Clock-skew guard for arm-time comparisons. */
const ARM_SKEW_MS = 1_500;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

class CodexWatchHandle implements WatchHandle {
  readonly adapterId = 'codex';
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly sink: (e: AdapterEvent) => void) {}

  isStopped(): boolean {
    return this.stopped;
  }

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
 * Codex adapter — passive completion observation over Codex CLI's on-disk
 * session JSONL files (~/.codex/sessions/YYYY/MM/DD/<name>-<uuid>.jsonl).
 *
 * Does NOT launch Codex, modify any settings, or install hooks.
 * Completion is determined from the structured task_complete event,
 * NOT from exit codes.
 */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly agentName = 'Codex';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new CodexWatchHandle(sink);
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';
    const workspaceFilter = target.workspaceRoot ? normalizePath(target.workspaceRoot) : null;

    const root = codexSessionsRoot();
    if (!root) {
      const message = 'Codex 세션 저장소(~/.codex/sessions)를 찾을 수 없습니다.';
      sink({ type: 'status', phase: 'error', detail: message });
      throw new Error(message);
    }
    sink({ type: 'status', phase: 'connecting' });

    if (debug) {
      console.error(`[codex-adapter] root=${root} workspaceFilter=${workspaceFilter ?? '(none)'}`);
    }

    /** sessionId → last seen {size, mtimeMs, summary}. Unchanged ⇒ reuse cached summary. */
    const statCache = new Map<string, { size: number; mtimeMs: number; summary: CodexSessionSummary }>();
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
          const allFiles = listCodexSessionFiles(root);
          totalFiles = allFiles.length;
          // Only files modified at/after arm time are relevant for NEW turns.
          const files = allFiles.filter((f: CodexSessionFile) => f.mtimeMs >= sinceMs - ARM_SKEW_MS);
          freshFiles = files.length;

          for (const f of files) {
            if (handle.isStopped()) break;

            const cached = statCache.get(f.sessionId);
            if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
              // Reuse cached — still emit observation from cached summary
              const cs = cached.summary;
              if (cs.sessionId || cs.cwd) {
                const sid = cs.sessionId ?? f.sessionId;
                if (!observations.has(sid)) {
                  const isNew =
                    cs.startedAtIso !== null
                      ? Date.parse(cs.startedAtIso) >= sinceMs - ARM_SKEW_MS
                      : f.mtimeMs >= sinceMs - ARM_SKEW_MS;
                  observations.set(sid, {
                    sessionId: sid,
                    directory: cs.cwd ?? undefined,
                    updatedMs: f.mtimeMs,
                    isNew,
                    inFlight: cs.hasTurn && !cs.ready &&
                      turnStartedAfterArm(cs.startedAtIso, sinceMs, ARM_SKEW_MS),
                  });
                }
              }
              continue;
            }

            let raw: string;
            try {
              raw = fs.readFileSync(f.path, 'utf8');
            } catch (err) {
              reportOnce(`Codex 세션 읽기 실패(${f.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            const summary = summarizeCodexSession(raw);
            statCache.set(f.sessionId, { size: f.size, mtimeMs: f.mtimeMs, summary });

            const sessionId = summary.sessionId ?? f.sessionId;

            // Workspace filter
            if (workspaceFilter && summary.cwd) {
              const cwdNorm = normalizePath(summary.cwd);
              if (!cwdNorm.startsWith(workspaceFilter) && !workspaceFilter.startsWith(cwdNorm)) {
                if (debug) {
                  console.error(
                    `[codex-adapter] skip session=${sessionId} (cwd mismatch: ${summary.cwd} vs ${target.workspaceRoot})`,
                  );
                }
                continue;
              }
            }

            // "New" identity: session's first turn started after arming.
            const isNew = summary.startedAtIso !== null
              ? Date.parse(summary.startedAtIso) >= sinceMs - ARM_SKEW_MS
              : f.mtimeMs >= sinceMs - ARM_SKEW_MS;

            const startedAfterArm = turnStartedAfterArm(summary.startedAtIso, sinceMs, ARM_SKEW_MS);
            const completedAfterArm = turnCompletedAfterArm(summary.completedAtIso, sinceMs, ARM_SKEW_MS);

            if (debug) {
              console.error(
                `[codex-adapter] session=${sessionId} mtime=${f.mtimeMs} cwd=${summary.cwd ?? '?'} ` +
                `hasTurn=${summary.hasTurn} ready=${summary.ready} ` +
                `startedAfterArm=${startedAfterArm} completedAfterArm=${completedAfterArm} isNew=${isNew}`,
              );
            }

            observations.set(sessionId, {
              sessionId,
              directory: summary.cwd ?? undefined,
              updatedMs: f.mtimeMs,
              isNew,
              inFlight:
                summary.hasTurn &&
                !summary.ready &&
                startedAfterArm,
            });

            if (!summary.ready || !summary.turnId) continue;
            if (!completedAfterArm) continue;

            const key = `${sessionId}:${summary.turnId}`;
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
              rawProtocolRef: `codex://session/${sessionId}/turn/${summary.turnId}`,
              completionKind:
                summary.kind === 'RESPONSE_COMPLETE' ||
                summary.kind === 'INTERRUPTED' ||
                summary.kind === 'PROCESS_FAILED'
                  ? summary.kind
                  : 'UNKNOWN',
            });
          }
        } catch (err) {
          reportOnce(`Codex 세션 스캔 실패: ${err instanceof Error ? err.message : String(err)}`);
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
            `[codex-adapter] poll#${successfulPasses}: files=${totalFiles} fresh=${freshFiles} ` +
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

export function createCodexAdapter(): CodexAdapter {
  return new CodexAdapter();
}
