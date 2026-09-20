/**
 * Verification Packet — the unit Independent QA verifies.
 *
 * The packet binds, for ONE lane attempt: Task Contract, Acceptance
 * Criteria, exact Run identity, HEAD/diff evidence, Builder RESULT,
 * commands/tests, and known risks. QA output is QA_PASS or QA_CHANGES
 * with concrete evidence. Builder can never self-certify: the packet
 * carries both session ids and verification refuses when they match.
 */
export const VERIFICATION_PACKET_SCHEMA = 'verification-packet.v1' as const;

export interface VerificationPacket {
  schemaVersion: typeof VERIFICATION_PACKET_SCHEMA;
  laneId: string;
  project: string;
  projectRoot: string;
  taskId: string;
  attempt: number;
  runId: string;
  taskContract: unknown;
  acceptanceCriteria: unknown;
  headSha?: string;
  diffSummary?: string;
  builderResult: string;
  commands: string[];
  tests: string[];
  knownRisks: string[];
  builderSessionId: string;
  qaSessionId: string;
  builtAt: string;
}

export type QaVerdictKind = 'QA_PASS' | 'QA_CHANGES' | 'QA_UNAVAILABLE';

export interface QaVerdict {
  verdict: QaVerdictKind;
  reason: string;
  findings?: string[];
  /** Present when verdict is QA_UNAVAILABLE: one of the five configured causes. */
  unavailabilityCause?: string;
}

/** The five configured primary-QA unavailability causes (§6). */
export const QA_UNAVAILABILITY_CAUSES = [
  'free quota exhausted',
  'rate limit',
  'auth unavailable',
  'provider unavailable',
  'runtime failure after bounded recovery',
] as const;

export function buildVerificationPacket(input: Omit<VerificationPacket, 'schemaVersion' | 'builtAt'>): VerificationPacket {
  if (!input.taskId.trim()) throw new Error('Verification packet requires taskId');
  if (!input.runId.trim()) throw new Error('Verification packet requires runId');
  if (!input.builderResult.trim()) throw new Error('Verification packet requires builderResult');
  return { schemaVersion: VERIFICATION_PACKET_SCHEMA, builtAt: new Date().toISOString(), ...input };
}

/**
 * Independence guard: QA session must differ from the Builder session.
 * Returns the packet unchanged when independent, else throws
 * QA_NOT_INDEPENDENT (durable BLOCKED, never silently certified).
 */
export function assertQaIndependent(packet: VerificationPacket): VerificationPacket {
  if (!packet.qaSessionId.trim()) throw new Error('QA_NOT_INDEPENDENT: qaSessionId missing');
  if (packet.qaSessionId === packet.builderSessionId) {
    throw new Error('QA_NOT_INDEPENDENT: Builder cannot self-certify (qaSessionId == builderSessionId)');
  }
  return packet;
}

/** QA_PASS requires concrete evidence of verification, not bare prose. */
export function validateQaVerdict(packet: VerificationPacket, verdict: QaVerdict): QaVerdict {
  assertQaIndependent(packet);
  if (verdict.verdict === 'QA_CHANGES' && (!verdict.findings || verdict.findings.length === 0)) {
    throw new Error('QA_CHANGES requires concrete findings (evidence), not bare prose');
  }
  if (verdict.verdict === 'QA_UNAVAILABLE') {
    if (!verdict.unavailabilityCause || !(QA_UNAVAILABILITY_CAUSES as readonly string[]).includes(verdict.unavailabilityCause)) {
      throw new Error('QA_UNAVAILABLE requires one of the five configured causes');
    }
  }
  if (!verdict.reason.trim()) throw new Error('QA verdict requires a reason');
  return verdict;
}
