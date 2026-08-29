import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentCompletion, CaptureOutcome } from './types.js';
import { validateAgentCompletion } from './validate.js';

/**
 * Stable identity of one observed completion — used so a duplicate
 * observation never produces a second/corrupted write set.
 */
export function dedupeKeyOf(c: AgentCompletion): string {
  const ref =
    c.rawProtocolRef ||
    crypto.createHash('sha256').update(c.rawFinalText, 'utf8').digest('hex').slice(0, 16);
  return `${c.adapterId}|${c.sessionId ?? '-'}|${ref}`;
}

interface EvidenceFile {
  dedupeKey: string;
  capturedAt: string;
  adapter: { id: string; agentName: string };
  completion: Omit<AgentCompletion, 'rawFinalText'>;
  /** How the source session was bound to this Run (Correction Pass 01). */
  binding?: { reason: string };
}

function readEvidence(folder: string): EvidenceFile | null {
  try {
    const raw = fs.readFileSync(path.join(folder, 'evidence', 'adapter.json'), 'utf8');
    const parsed = JSON.parse(raw) as EvidenceFile;
    return typeof parsed?.dedupeKey === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist an AgentCompletion into a run folder:
 *   agent-result.md      — raw agent output, written once, immutable in meaning
 *   result.md            — only when absent (manual/GPT-drag compatibility)
 *   evidence/adapter.json — completion metadata + dedupe key + binding provenance
 *
 * Never throws. Existing manual data is never overwritten.
 */
export function captureCompletion(
  folder: string,
  input: unknown,
  meta?: { bindingReason?: string },
): CaptureOutcome {
  try {
    if (!folder || typeof folder !== 'string') {
      return { ok: false, written: [], skipped: [], duplicate: false, reason: 'run folder가 지정되지 않았습니다.' };
    }
    const v = validateAgentCompletion(input);
    if (!v.valid || !v.value) {
      return { ok: false, written: [], skipped: [], duplicate: false, reason: v.errors.join(' ') };
    }
    const c = v.value;

    const agentResultPath = path.join(folder, 'agent-result.md');
    const resultMdPath = path.join(folder, 'result.md');
    const evidenceDir = path.join(folder, 'evidence');
    const evidencePath = path.join(evidenceDir, 'adapter.json');

    const key = dedupeKeyOf(c);
    const prev = readEvidence(folder);
    if (prev && prev.dedupeKey === key) {
      return { ok: true, written: [], skipped: [], duplicate: true };
    }

    const written: string[] = [];
    const skipped: string[] = [];

    if (fs.existsSync(agentResultPath)) {
      skipped.push('agent-result.md');
    } else {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(agentResultPath, c.rawFinalText, 'utf8');
      written.push('agent-result.md');
    }

    // result.md: write when absent OR when the file exists but is empty.
    // An empty result.md is an artifact of saving a run before entering a result
    // (e.g. Ctrl+S / 모두 저장 before capture); it holds no manual content and
    // must not block auto-capture from populating the result pane.
    // A non-empty result.md is treated as a manual/GPT-drag entry and protected.
    const existingResult = fs.existsSync(resultMdPath)
      ? fs.readFileSync(resultMdPath, 'utf8')
      : null;
    if (existingResult !== null && existingResult.trim().length > 0) {
      // Has real content — protect the manual/GPT-drag result entry.
      skipped.push('result.md');
    } else {
      fs.writeFileSync(resultMdPath, c.rawFinalText, 'utf8');
      written.push('result.md');
    }

    if (fs.existsSync(evidencePath)) {
      skipped.push(path.join('evidence', 'adapter.json'));
    } else {
      const { rawFinalText: _omit, ...rest } = c;
      const evidence: EvidenceFile = {
        dedupeKey: key,
        capturedAt: c.observedAt,
        adapter: { id: c.adapterId, agentName: c.agentName },
        completion: rest,
      };
      if (meta?.bindingReason) evidence.binding = { reason: meta.bindingReason };
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
      written.push(path.join('evidence', 'adapter.json'));
    }

    return { ok: true, written, skipped, duplicate: false };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, written: [], skipped: [], duplicate: false, reason };
  }
}
