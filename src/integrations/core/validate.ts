import { AgentCompletion, COMPLETION_KINDS } from './types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  value?: AgentCompletion;
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isOptionalStr(v: unknown): boolean {
  return v === undefined || isStr(v);
}

function isIsoDate(v: unknown): boolean {
  if (!isStr(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

/** Structural validation of an untrusted AgentCompletion-shaped value. */
export function validateAgentCompletion(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['완료 패킷은 객체여야 합니다.'] };
  }
  const o = input as Record<string, unknown>;

  if (!isStr(o.adapterId) || !o.adapterId.trim()) errors.push('adapterId가 필요합니다.');
  if (!isStr(o.agentName) || !o.agentName.trim()) errors.push('agentName이 필요합니다.');
  if (!isStr(o.workspace)) errors.push('workspace가 필요합니다.');
  if (!isStr(o.observedAt) || !isIsoDate(o.observedAt)) errors.push('observedAt은 유효한 ISO 시각이어야 합니다.');
  if (!isStr(o.terminalSignal) || !o.terminalSignal.trim()) errors.push('terminalSignal이 필요합니다.');
  if (!isStr(o.rawFinalText)) errors.push('rawFinalText는 문자열이어야 합니다.');
  if (o.exitCode !== undefined && typeof o.exitCode !== 'number') errors.push('exitCode는 숫자여야 합니다.');
  if (!isOptionalStr(o.sessionId)) errors.push('sessionId는 문자열이어야 합니다.');
  if (!isOptionalStr(o.rawProtocolRef)) errors.push('rawProtocolRef는 문자열이어야 합니다.');
  if (o.startedAt !== undefined && !isIsoDate(o.startedAt)) errors.push('startedAt은 유효한 ISO 시각이어야 합니다.');

  const kind = o.completionKind;
  if (typeof kind !== 'string' || !COMPLETION_KINDS.includes(kind as never)) {
    errors.push(`completionKind는 ${COMPLETION_KINDS.join('|')} 중 하나여야 합니다.`);
  }

  if (errors.length) return { valid: false, errors };
  return {
    valid: true,
    errors: [],
    value: {
      adapterId: o.adapterId as string,
      agentName: o.agentName as string,
      sessionId: o.sessionId as string | undefined,
      workspace: o.workspace as string,
      startedAt: o.startedAt as string | undefined,
      observedAt: o.observedAt as string,
      terminalSignal: o.terminalSignal as string,
      exitCode: o.exitCode as number | undefined,
      rawFinalText: o.rawFinalText as string,
      rawProtocolRef: o.rawProtocolRef as string | undefined,
      completionKind: kind as AgentCompletion['completionKind'],
    },
  };
}
