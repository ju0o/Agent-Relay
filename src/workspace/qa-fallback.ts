/**
 * QA fallback resolver.
 *
 * Primary QA unavailable reasons (per PM packet):
 *   free quota exhausted | rate limit | provider unavailable |
 *   auth unavailable | runtime failure after bounded recovery failure
 *
 * Policy: keep the current Task/Result, fall back ONLY the QA runtime:
 *   Primary QA -> Cursor QA (logical label from manifest.qaFallbackRuntime)
 * Builder re-execution and new Task creation are forbidden here.
 *
 * If the Cursor CLI/runtime is not actually installed, the lane records
 * QA_RUNTIME_UNAVAILABLE instead of pretending a fallback exists.
 */
import { spawnSync } from 'node:child_process';

export type QaFallbackStatus =
  | { kind: 'PRIMARY'; effectiveQa: string; detail: string }
  | { kind: 'FALLBACK_CURSOR'; effectiveQa: string; detail: string }
  | { kind: 'QA_RUNTIME_UNAVAILABLE'; effectiveQa: string; detail: string };

export function detectCursorRuntime(): { installed: boolean; version?: string; path?: string } {
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'cursor-agent', args: ['--version'] },
    { cmd: 'cursor', args: ['--version'] },
  ];
  for (const c of candidates) {
    try {
      const res = spawnSync(c.cmd, c.args, { encoding: 'utf8', timeout: 6000 });
      const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
      if (res.status === 0 && out) {
        return { installed: true, version: out.slice(0, 160), path: c.cmd };
      }
      // `cursor --version` without IDE prints guidance but still proves the
      // binary exists; cursor-agent is the real fallback target.
      if (c.cmd === 'cursor-agent' && out) {
        return { installed: true, version: out.slice(0, 160), path: c.cmd };
      }
    } catch {
      // try next candidate
    }
  }
  try {
    const which = spawnSync('which', ['cursor-agent'], { encoding: 'utf8', timeout: 3000 });
    if (which.status === 0 && which.stdout.trim()) {
      return { installed: true, path: which.stdout.trim().split('\n')[0]!.trim() };
    }
  } catch {
    // ignore
  }
  return { installed: false };
}

/**
 * Decide the effective QA runtime for one lane.
 * @param primaryQa logical primary label (e.g. "cline")
 * @param primaryUnavailable true when one of the five PM-listed reasons fired
 * @param fallbackRuntime logical fallback label (default "cursor")
 */
export function resolveQaFallback(
  primaryQa: string,
  primaryUnavailable: boolean,
  fallbackRuntime = 'cursor',
  detection?: { installed: boolean; version?: string; path?: string },
): QaFallbackStatus {
  if (!primaryUnavailable) {
    return { kind: 'PRIMARY', effectiveQa: primaryQa, detail: `primary QA healthy: ${primaryQa}` };
  }
  const det = detection ?? detectCursorRuntime();
  if (det.installed) {
    return {
      kind: 'FALLBACK_CURSOR',
      effectiveQa: fallbackRuntime,
      detail: `primary QA ${primaryQa} unavailable -> fallback ${fallbackRuntime}${det.version ? ` (${det.version.slice(0, 80)})` : ''}; Task/Result preserved, no Builder re-run`,
    };
  }
  return {
    kind: 'QA_RUNTIME_UNAVAILABLE',
    effectiveQa: primaryQa,
    detail: `primary QA ${primaryQa} unavailable and fallback ${fallbackRuntime} CLI not installed (QA_RUNTIME_UNAVAILABLE); Task/Result preserved, no Builder re-run`,
  };
}
