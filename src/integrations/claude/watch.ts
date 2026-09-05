import * as fs from 'fs';
import { AgentAdapter, AgentCompletion, AdapterEvent, SessionObservation, WatchHandle, WatchTarget } from '../core/types.js';
import { turnStartedAfterArm, turnCompletedAfterArm } from '../core/binding.js';
import { ClaudeTranscriptSummary, summarizeClaudeTranscript } from './extract.js';
import { claudeProjectsRoot, listTranscriptFiles } from './storage.js';

const POLL_MS = 2_000;
const WATCH_TIMEOUT_MS = 120 * 60 * 1000;
/** Clock-skew guard for arm-time comparisons. */
const ARM_SKEW_MS = 1_500;

class ClaudeWatchHandle implements WatchHandle {
  readonly adapterId = 'claude-code';
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
 * Normalize a filesystem path for cross-platform comparison.
 * On Windows paths may differ in case (C:\Users\user\Desktop vs desktop)
 * or use backslashes vs forward slashes. Normalize to lowercase forward slashes.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * Claude Code adapter — passive completion observation over the official
 * on-disk session transcripts. No hooks, no settings changes, no plugins,
 * no terminal scraping; purely read-only file observation.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly agentName = 'Claude Code';

  async startWatch(target: WatchTarget, sink: (e: AdapterEvent) => void): Promise<WatchHandle> {
    const handle = new ClaudeWatchHandle(sink);
    const sinceMs = Date.now();
    const debug = process.env['AGENT_RELAY_CAPTURE_DEBUG'] === '1';
    const workspaceFilter = target.workspaceRoot ? normalizePath(target.workspaceRoot) : null;

    // A Dispatcher-bound Run carries the effective Worker config directory.
    // Never let this observer's ambient process profile override that Run.
    const root = claudeProjectsRoot(target.claudeConfigDir);
    if (!root) {
      const message = 'Claude Code 세션 저장소를 찾을 수 없습니다.';
      sink({ type: 'status', phase: 'error', detail: message });
      throw new Error(message);
    }
    sink({ type: 'status', phase: 'connecting' });

    if (debug) {
      console.error(`[claude-adapter] root=${root} workspaceFilter=${workspaceFilter ?? '(none)'}`);
    }

    /** sessionId → last seen {size,mtimeMs}; unchanged ⇒ reuse cached summary. */
    const statCache = new Map<string, { size: number; mtimeMs: number; summary: ClaudeTranscriptSummary }>();
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

        // Only transcripts modified at/after arming are relevant; everything
        // older can never produce a NEW post-arm turn.
        let failures = 0;
        let totalFiles = 0;
        let freshFiles = 0;
        try {
          const allFiles = listTranscriptFiles(root);
          totalFiles = allFiles.length;
          const files = allFiles.filter((f) => f.mtimeMs >= sinceMs - ARM_SKEW_MS);
          freshFiles = files.length;

          for (const f of files) {
            if (handle.isStopped()) break;
            const cached = statCache.get(f.sessionId);
            if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) continue;

            let raw: string;
            try {
              raw = fs.readFileSync(f.path, 'utf8');
            } catch (err) {
              reportOnce(`트랜스크립트 읽기 실패(${f.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }
            // WATCH-01: summarizeClaudeTranscript must be guarded per-file so
            // a malformed transcript cannot abort observations for other sessions.
            let summary: ReturnType<typeof summarizeClaudeTranscript>;
            try {
              summary = summarizeClaudeTranscript(raw);
              statCache.set(f.sessionId, { size: f.size, mtimeMs: f.mtimeMs, summary });
            } catch (err) {
              reportOnce(`트랜스크립트 분석 실패(${f.sessionId}): ${err instanceof Error ? err.message : String(err)}`);
              failures++;
              continue;
            }

            const sessionId = summary.sessionId ?? f.sessionId;

            // Workspace filter: when the target specifies a workspaceRoot, skip
            // sessions from unrelated project directories. Comparison is
            // case-insensitive and slash-normalized for Windows compatibility.
            if (workspaceFilter && summary.cwd) {
              const cwdNorm = normalizePath(summary.cwd);
              // Allow both exact match and subdirectory match.
              if (!cwdNorm.startsWith(workspaceFilter) && !workspaceFilter.startsWith(cwdNorm)) {
                if (debug) {
                  console.error(
                    `[claude-adapter] skip session=${sessionId} (cwd mismatch: ${summary.cwd} vs ${target.workspaceRoot})`,
                  );
                }
                continue;
              }
            }

            // "New" identity evidence = session CREATED after arming, taken
            // from the transcript's own first timestamp.
            const createdIso = firstTimestamp(raw);
            const isNew = createdIso !== null && Date.parse(createdIso) >= sinceMs - ARM_SKEW_MS;

            const startedAfterArm = turnStartedAfterArm(summary.startedAtIso, sinceMs, ARM_SKEW_MS);
            const completedAfterArm = turnCompletedAfterArm(summary.completedAtIso, sinceMs, ARM_SKEW_MS);

            if (debug) {
              console.error(
                `[claude-adapter] session=${sessionId} mtime=${f.mtimeMs} cwd=${summary.cwd ?? '?'} ` +
                `hasTurn=${summary.hasTurn} ready=${summary.ready} ` +
                `startedAfterArm=${startedAfterArm} completedAfterArm=${completedAfterArm} isNew=${isNew}`,
              );
            }

            observations.set(sessionId, {
              sessionId,
              directory: summary.cwd ?? undefined,
              title: summary.title ?? undefined,
              updatedMs: f.mtimeMs,
              isNew,
              // Stale zombies (turn started long before arming, file merely
              // touched) never count as live work.
              inFlight:
                summary.hasTurn &&
                !summary.ready &&
                startedAfterArm,
            });

            if (!summary.ready || !summary.messageId) continue;
            // Historical turns (completed before arming) are never captures.
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
              rawProtocolRef: `claude://session/${sessionId}/msg/${summary.messageId}`,
              completionKind:
                summary.kind === 'RESPONSE_COMPLETE' || summary.kind === 'INTERRUPTED' || summary.kind === 'PROCESS_FAILED'
                  ? summary.kind
                  : 'UNKNOWN',
            });
          }
        } catch (err) {
          reportOnce(`Claude 세션 스캔 실패: ${err instanceof Error ? err.message : String(err)}`);
          failures++;
        }
        if (handle.isStopped()) return;

        if (failures === 0 || observations.size > 0) {
          successfulPasses++;
          // Snapshot FIRST so the binding policy is armed before any
          // completion from the same pass is evaluated.
          sink({ type: 'sessions', sessions: [...observations.values()], armPass: successfulPasses === 1 });
          for (const c of completions) sink({ type: 'completion', completion: c });
        }
        if (debug && !handle.isStopped()) {
          console.error(
            `[claude-adapter] poll#${successfulPasses}: files=${totalFiles} fresh=${freshFiles} ` +
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

function firstTimestamp(raw: string): string | null {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      if (typeof j['timestamp'] === 'string') return j['timestamp'];
    } catch {
      continue;
    }
  }
  return null;
}

export function createClaudeCodeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter();
}
