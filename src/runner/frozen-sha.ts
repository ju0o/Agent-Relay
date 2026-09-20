/**
 * Frozen certified Runner SHA (item 11) — separation between the certified
 * Runner checkout and Agent-Relay development checkouts.
 *
 * The certified deployment pins its SHA via `--expected-sha` (or the
 * AGENT_RELAY_RUNNER_SHA environment); startup attests the code it is about
 * to run and FAILS CLOSED on mismatch or a dirty tree. Development
 * checkouts run unpinned and only report their attestation to the audit log.
 * The running SHA is also recorded in the night summary (LAST_RUN.json)
 * for post-hoc verification.
 */
import { execFileSync } from 'node:child_process';

export interface RunnerAttestation {
  sha: string | null;
  dirty: boolean;
  pinned: boolean;
  expectedSha: string | null;
}

function gitOut(codeRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', codeRoot, ...args], { encoding: 'utf8', timeout: 10000 }).trim() || null;
  } catch {
    return null;
  }
}

export function attestRunnerCode(codeRoot: string, expectedSha?: string | null): RunnerAttestation {
  const top = gitOut(codeRoot, ['rev-parse', '--show-toplevel']) ?? codeRoot;
  const sha = gitOut(top, ['rev-parse', 'HEAD']);
  const porcelain = sha ? gitOut(top, ['status', '--porcelain']) : null;
  const dirty = porcelain !== null && porcelain.length > 0;
  const expected = (expectedSha ?? '').trim() || null;
  if (expected) {
    if (!sha) {
      throw new Error(
        `FROZEN_SHA_MISMATCH: pinned to ${expected} but ${top} is not a git checkout; run from the frozen certified checkout`,
      );
    }
    if (sha !== expected) {
      throw new Error(
        `FROZEN_SHA_MISMATCH: running ${sha} (dirty=${dirty}), certified ${expected}; ` +
          `run from the frozen checkout or update AGENT_RELAY_RUNNER_SHA`,
      );
    }
    if (dirty) {
      throw new Error(
        `FROZEN_SHA_DIRTY: checkout at certified ${sha} has uncommitted changes; ` +
          `certified runs must be clean (develop in a separate checkout)`,
      );
    }
  }
  return { sha, dirty, pinned: expected !== null, expectedSha: expected };
}
