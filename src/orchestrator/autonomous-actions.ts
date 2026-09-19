export const AUTONOMOUS_ACTIONS = ['DISPATCH', 'REQUEST_CHANGES', 'ACCEPT', 'HUMAN_GATE', 'MILESTONE_COMPLETE'] as const;
export type AutonomousAction = typeof AUTONOMOUS_ACTIONS[number];

export type AutonomousPmAction = { action: AutonomousAction; taskId?: string; reason?: string; evidence?: unknown };

/** Parse the only accepted top-level PM action. Any prose or ambiguity fails closed. */
export function parseAutonomousPmAction(text: string): AutonomousPmAction {
  const first = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!AUTONOMOUS_ACTIONS.includes(first as AutonomousAction)) throw new Error('PM_ACTION_AMBIGUOUS');
  const body = text.trim().slice(first.length).trim();
  if (!body) return { action: first as AutonomousAction };
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error('PM_ACTION_AMBIGUOUS'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PM_ACTION_AMBIGUOUS');
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!['taskId', 'reason', 'evidence'].includes(key)) throw new Error('PM_ACTION_AMBIGUOUS');
  if (record.taskId !== undefined && (typeof record.taskId !== 'string' || !record.taskId.trim())) throw new Error('PM_ACTION_AMBIGUOUS');
  if (record.reason !== undefined && (typeof record.reason !== 'string' || !record.reason.trim())) throw new Error('PM_ACTION_AMBIGUOUS');
  return { action: first as AutonomousAction, ...(record.taskId ? { taskId: record.taskId.trim() } : {}), ...(record.reason ? { reason: record.reason.trim() } : {}), ...(record.evidence !== undefined ? { evidence: record.evidence } : {}) };
}
