/**
 * Structured turn-result parsing — from a request BOUNDARY, never from
 * scrollback history. Verbs are parsed per-turn; fixed global DONE strings
 * play no role here.
 */
export type PmTurnDecision =
  | { kind: 'DISPATCH'; taskId: string; reason?: string }
  | { kind: 'REQUEST_CHANGES'; changes: string; reason?: string }
  | { kind: 'ACCEPT'; reason?: string }
  | { kind: 'HUMAN_GATE'; reason: string }
  | { kind: 'MILESTONE_COMPLETE'; reason: string };

export interface BuilderTurnResult {
  taskId: string;
  runId: string;
  resultPacket: string;
  commands: string[];
  tests: string[];
  knownRisks: string[];
  headSha?: string;
}

export type QaTurnVerdict =
  | { verdict: 'QA_PASS'; reason: string }
  | { kind2?: never; verdict: 'QA_CHANGES'; reason: string; findings: string[] }
  | { verdict: 'QA_UNAVAILABLE'; reason: string; cause: string };

const PM_VERBS = ['DISPATCH', 'REQUEST_CHANGES', 'ACCEPT', 'HUMAN_GATE', 'MILESTONE_COMPLETE'] as const;

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

/**
 * Find the first line carrying a decision verb, tolerating TUI bullet
 * prefixes (`•`, `>`, `*`, `-`) and hook/preamble chatter above it.
 * Deterministic: first verb-line wins; everything else is not a decision.
 */
function findVerbLine<V extends string>(text: string, verbs: readonly V[]): { verb: V; rest: string } | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const clean = lines[i]!.trim().replace(/^[•>*\-]+\s*/, '');
    for (const v of verbs) {
      if (clean === v || clean.startsWith(`${v} `) || clean.startsWith(`${v}:`)) {
        const afterVerb = clean.slice(v.length).trim().replace(/^[:\s]+/, '');
        const following = lines.slice(i + 1).join('\n').trim();
        const rest = afterVerb || following;
        return { verb: v, rest };
      }
    }
  }
  return null;
}

export function parsePmTurn(text: string): PmTurnDecision {
  const found = findVerbLine(text, PM_VERBS);
  if (!found) throw new Error(`PM_TURN_AMBIGUOUS: no decision verb line (head: ${firstLine(text).slice(0, 80)})`);
  const { verb, rest } = found;
  let payload: Record<string, unknown> = {};
  if (rest) {
    try {
      const src = rest.startsWith('{') ? rest : rest.slice(rest.indexOf('{'));
      const parsed: unknown = parseJsonTolerant(src);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      throw new Error('PM_TURN_AMBIGUOUS: decision body is not JSON');
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  switch (verb) {
    case 'DISPATCH': {
      const taskId = str(payload.taskId);
      if (!taskId) throw new Error('PM_TURN_AMBIGUOUS: DISPATCH requires taskId');
      return { kind: 'DISPATCH', taskId, ...(str(payload.reason) ? { reason: str(payload.reason)! } : {}) };
    }
    case 'REQUEST_CHANGES': {
      const changes = str(payload.changes) ?? str(payload.reason);
      if (!changes) throw new Error('PM_TURN_AMBIGUOUS: REQUEST_CHANGES requires changes');
      return { kind: 'REQUEST_CHANGES', changes, ...(str(payload.reason) ? { reason: str(payload.reason)! } : {}) };
    }
    case 'ACCEPT':
      return { kind: 'ACCEPT', ...(str(payload.reason) ? { reason: str(payload.reason)! } : {}) };
    case 'HUMAN_GATE': {
      const reason = str(payload.reason) ?? 'owner checkpoint';
      return { kind: 'HUMAN_GATE', reason };
    }
    case 'MILESTONE_COMPLETE': {
      const reason = str(payload.reason) ?? 'milestone reported';
      return { kind: 'MILESTONE_COMPLETE', reason };
    }
  }
}

function section(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^${name}\\s*[:=]\\s*(.+)$`, 'im'));
  return m?.[1]?.trim() ?? null;
}

export function parseBuilderTurn(text: string): BuilderTurnResult {
  if (!/RESULT_PACKET/.test(text)) throw new Error('BUILDER_TURN_AMBIGUOUS: no RESULT_PACKET envelope');
  const taskId = section(text, 'Task(?: ID)?') ?? section(text, 'taskId');
  const runId = section(text, 'Run(?: ID)?') ?? section(text, 'runId');
  if (!taskId || !runId) throw new Error('BUILDER_TURN_AMBIGUOUS: RESULT_PACKET must carry Task and Run identity');
  const lines = (name: string): string[] => {
    const m = text.match(new RegExp(`^${name}\\s*[:=]\\s*(.+)$`, 'im'));
    return m?.[1] ? m[1].split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
  };
  return {
    taskId,
    runId,
    resultPacket: text.trim(),
    commands: lines('Commands?'),
    tests: lines('Tests?'),
    knownRisks: lines('Known risks?'),
    ...(section(text, 'HEAD(?: SHA)?') ? { headSha: section(text, 'HEAD(?: SHA)?')! } : {}),
  };
}

export function parseQaTurn(text: string): QaTurnVerdict {
  const found = findVerbLine(text, ['QA_PASS', 'QA_CHANGES', 'QA_UNAVAILABLE']);
  if (!found) throw new Error(`QA_TURN_AMBIGUOUS: expected QA_PASS|QA_CHANGES|QA_UNAVAILABLE (head: ${firstLine(text).slice(0, 80)})`);
  if (found.verb === 'QA_PASS') {
    const reason = found.rest.trim() || 'QA verified';
    return { verdict: 'QA_PASS', reason: reason.slice(0, 2000) };
  }
  if (found.verb === 'QA_CHANGES') {
    const findings = found.rest.split(/\r?\n/).map((l) => l.trim().replace(/^[-*•>]+\s*/, '')).filter(Boolean);
    if (findings.length === 0) throw new Error('QA_TURN_AMBIGUOUS: QA_CHANGES requires concrete findings');
    return { verdict: 'QA_CHANGES', reason: findings[0]!, findings };
  }
  const cause = found.rest.split(/\r?\n/, 1)[0]!.trim();
  if (!cause) throw new Error('QA_TURN_AMBIGUOUS: QA_UNAVAILABLE requires a cause');
  return { verdict: 'QA_UNAVAILABLE', reason: cause, cause };
}

export type TaskType = 'IMPLEMENTATION' | 'FIX' | 'REVIEW_ONLY' | 'VERIFICATION' | 'PLANNING';

export interface TaskProposal {
  goal: string;
  bounded_scope: string;
  acceptance_criteria: Array<{ id: string; description: string }>;
  qa_notes?: string;
  // §4 executable-contract fields (optional at parse; enforced by gate).
  taskType?: TaskType;
  whyNow?: string;
  inScope?: string[];
  outOfScope?: string[];
  requiredTests?: string[];
  requiredEvidence?: string[];
  knownRisks?: string[];
  sourceReferences?: string[];
  rolePlan?: string;
  fileScope?: string[];
}

/**
 * Parse a PM task proposal for canonical intake (no-READY lanes).
 * Expects exactly one fenced ```json TASK_PROPOSAL v1 {...}``` block with
 * the smallest legitimate next task. Anything else fails closed.
 */
export function parseTaskProposal(text: string): TaskProposal {
  const m = text.match(/```json\s*TASK_PROPOSAL v1\s*([\s\S]*?)```/);
  if (m) return checkProposal(parseJsonBlock(m[1]!, 'fenced TASK_PROPOSAL v1 block'));
  // Tolerant fallback: a bare JSON object carrying the same fields (some
  // transports/agents drop the fence). Balanced-brace scan from each `{`
  // in turn; content is validated identically — decoration never
  // substitutes for fields.
  let pos = text.indexOf('{');
  let lastErr: string | null = null;
  while (pos >= 0) {
    const span = balancedSpan(text, pos);
    if (span !== null) {
      try {
        return checkProposal(parseJsonBlock(span, 'bare proposal object'));
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
    }
    pos = text.indexOf('{', pos + 1);
  }
  throw new Error(`PROPOSAL_AMBIGUOUS: no fenced TASK_PROPOSAL v1 block${lastErr ? ` (best bare candidate: ${lastErr})` : ''}`);
}

function parseJsonBlock(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerant retry: TUI word-wrap puts RAW newlines inside string values,
    // which strict JSON rejects. Sanitize control chars that appear inside
    // string spans (escapes like \\n are already valid and untouched).
    return JSON.parse(sanitizeJsonStrings(raw, what));
  }
}

/** Strict first, then TUI-wrap-tolerant (raw newlines inside strings). */
export function parseJsonTolerant(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(sanitizeJsonStrings(raw, 'tolerant JSON block'));
  }
}

/** Replace raw control chars inside "..." spans with spaces. */
function sanitizeJsonStrings(raw: string, what: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const c of raw) {
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
      } else if (c === '\\') {
        out += c;
        esc = true;
      } else if (c === '"') {
        out += c;
        inStr = false;
      } else if (c === '\n' || c === '\r' || c === '\t' || (c < ' ' && c !== '')) {
        out += ' ';
      } else {
        out += c;
      }
    } else {
      out += c;
      if (c === '"') inStr = true;
    }
  }
  if (inStr) throw new Error(`PROPOSAL_AMBIGUOUS: ${what} is not JSON`);
  try {
    JSON.parse(out);
    return out;
  } catch {
    throw new Error(`PROPOSAL_AMBIGUOUS: ${what} is not JSON`);
  }
}

/** Minimal balanced-brace scan honoring strings and escapes. */
function balancedSpan(text: string, start: number): string | null {
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function checkProposal(raw: unknown): TaskProposal {
  const p = raw as Record<string, unknown>;
  if (typeof p.goal !== 'string' || !p.goal.trim()) throw new Error('PROPOSAL_AMBIGUOUS: goal required');
  if (typeof p.bounded_scope !== 'string' || !p.bounded_scope.trim()) throw new Error('PROPOSAL_AMBIGUOUS: bounded_scope required');
  if (!Array.isArray(p.acceptance_criteria) || p.acceptance_criteria.length === 0) {
    throw new Error('PROPOSAL_AMBIGUOUS: non-empty acceptance_criteria required');
  }
  for (const [i, ac] of (p.acceptance_criteria as unknown[]).entries()) {
    if (!ac || typeof ac !== 'object') throw new Error(`PROPOSAL_AMBIGUOUS: acceptance_criteria[${i}] must be an object`);
    const r = ac as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim() || typeof r.description !== 'string' || !r.description.trim()) {
      throw new Error(`PROPOSAL_AMBIGUOUS: acceptance_criteria[${i}] needs id + description`);
    }
  }
  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    return out.length ? out : undefined;
  };
  const rawType = typeof p.taskType === 'string' ? p.taskType.trim().toUpperCase() : undefined;
  const taskType = (['IMPLEMENTATION', 'FIX', 'REVIEW_ONLY', 'VERIFICATION', 'PLANNING'] as const)
    .find((t) => t === rawType);
  return {
    goal: (p.goal as string).trim(),
    bounded_scope: (p.bounded_scope as string).trim(),
    acceptance_criteria: (p.acceptance_criteria as Array<{ id: string; description: string }>).map((ac) => ({
      id: ac.id.trim(),
      description: ac.description.trim(),
    })),
    ...(typeof p.qa_notes === 'string' && p.qa_notes.trim() ? { qa_notes: p.qa_notes.trim() } : {}),
    ...(taskType ? { taskType } : {}),
    ...(typeof p.whyNow === 'string' && p.whyNow.trim() ? { whyNow: p.whyNow.trim() } : {}),
    ...(strArr(p.inScope) ? { inScope: strArr(p.inScope)! } : {}),
    ...(strArr(p.outOfScope) ? { outOfScope: strArr(p.outOfScope)! } : {}),
    ...(strArr(p.requiredTests) ? { requiredTests: strArr(p.requiredTests)! } : {}),
    ...(strArr(p.requiredEvidence) ? { requiredEvidence: strArr(p.requiredEvidence)! } : {}),
    ...(strArr(p.knownRisks) ? { knownRisks: strArr(p.knownRisks)! } : {}),
    ...(strArr(p.sourceReferences) ? { sourceReferences: strArr(p.sourceReferences)! } : {}),
    ...(typeof p.rolePlan === 'string' && p.rolePlan.trim() ? { rolePlan: p.rolePlan.trim() } : {}),
    ...(strArr(p.fileScope) ? { fileScope: strArr(p.fileScope)! } : {}),
  };
}

export interface ExecutableEnvelope {
  taskType: TaskType;
  whyNow: string;
  inScope: string[];
  outOfScope: string[];
  currentBaseSha: string;
  acceptanceCriteria: Array<{ id: string; description: string }>;
  requiredTests: string[];
  requiredEvidence: string[];
  knownRisks: string[];
  sourceReferences: string[];
  rolePlan: string;
  fileScope: string[];
}

/** Route implied by task type (§5). REVIEW_ONLY/VERIFICATION skip Builder. */
export function routeForTaskType(t: TaskType): 'full' | 'review' {
  return t === 'IMPLEMENTATION' || t === 'FIX' || t === 'PLANNING' ? 'full' : 'review';
}

/**
 * Executable-contract gate (§4): a Task MUST NOT dispatch unless complete.
 * Returns the envelope (with rolePlan defaulted per task type) or throws
 * TASK_NOT_EXECUTABLE naming every missing field. fileScope entries for
 * implementation work must already be named in bounded_scope (diffScope
 * rule: QA cannot silently broaden scope).
 */
export function assertExecutableContract(
  proposal: TaskProposal,
  current: { baseSha: string | null },
): ExecutableEnvelope {
  const missing: string[] = [];
  const taskType = proposal.taskType ?? 'IMPLEMENTATION';
  if (!proposal.whyNow?.trim()) missing.push('whyNow');
  if (!proposal.inScope?.length) missing.push('inScope');
  if (!proposal.outOfScope?.length) missing.push('outOfScope');
  if (!current.baseSha) missing.push('currentBaseSha');
  if (!proposal.requiredTests?.length) missing.push('requiredTests');
  if (!proposal.requiredEvidence?.length) missing.push('requiredEvidence');
  if (!proposal.sourceReferences?.length) missing.push('sourceReferences');
  const needsFiles = taskType === 'IMPLEMENTATION' || taskType === 'FIX';
  if (needsFiles && !proposal.fileScope?.length) missing.push('fileScope');
  if (missing.length) {
    throw new Error(`TASK_NOT_EXECUTABLE: missing ${missing.join(', ')} (taskType ${taskType})`);
  }
  const defaultRolePlan: Record<TaskType, string> = {
    IMPLEMENTATION: 'PM → Builder → QA → PM',
    FIX: 'PM → Builder → QA → PM',
    REVIEW_ONLY: 'PM → Independent Reviewer/QA → PM (no Builder)',
    VERIFICATION: 'PM → QA → PM (no Builder)',
    PLANNING: 'PM → planning Agent → review',
  };
  if (needsFiles) {
    const scopeFlat = proposal.bounded_scope.replace(/\s+/g, '');
    const cleanScope: string[] = [];
    for (const f of proposal.fileScope!) {
      // TUI reflow may wrap long paths with whitespace; paths never contain
      // significant whitespace, so compare/store the collapsed form.
      const flat = f.replace(/\s+/g, '');
      if (!flat) continue;
      if (!scopeFlat.includes(flat)) {
        throw new Error(`TASK_NOT_EXECUTABLE: fileScope '${f}' not declared in bounded_scope`);
      }
      cleanScope.push(flat);
    }
    if (cleanScope.length === 0) {
      throw new Error('TASK_NOT_EXECUTABLE: missing fileScope (taskType IMPLEMENTATION|FIX)');
    }
    return {
      taskType,
      whyNow: proposal.whyNow!.trim(),
      inScope: proposal.inScope!,
      outOfScope: proposal.outOfScope!,
      currentBaseSha: current.baseSha!,
      acceptanceCriteria: proposal.acceptance_criteria,
      requiredTests: proposal.requiredTests!,
      requiredEvidence: proposal.requiredEvidence!,
      knownRisks: proposal.knownRisks ?? [],
      sourceReferences: proposal.sourceReferences!,
      rolePlan: proposal.rolePlan?.trim() || defaultRolePlan[taskType],
      fileScope: cleanScope,
    };
  }
  return {
    taskType,
    whyNow: proposal.whyNow!.trim(),
    inScope: proposal.inScope!,
    outOfScope: proposal.outOfScope!,
    currentBaseSha: current.baseSha!,
    acceptanceCriteria: proposal.acceptance_criteria,
    requiredTests: proposal.requiredTests!,
    requiredEvidence: proposal.requiredEvidence!,
    knownRisks: proposal.knownRisks ?? [],
    sourceReferences: proposal.sourceReferences!,
    rolePlan: proposal.rolePlan?.trim() || defaultRolePlan[taskType],
    fileScope: proposal.fileScope ?? [],
  };
}

/**
 * Lenient builder-result acceptance: agents often return rich CORRECT
 * content without the RESULT_PACKET wrapper (proven live three times).
 * Strict envelope first; fallback binds identity from the TURN (same
 * task/run by construction) when the body is substantive evidence.
 * Refusals and chatter fail the substance floor and stay BLOCKED.
 * QA + PM review downstream still judge content — framing tolerance here
 * never certifies quality.
 */
export function looksSubstantiveResult(text: string): boolean {
  const t = text.trim();
  return t.length >= 200
    && /(exit\s*0|passed|\bPASS\b|FAIL|created|wrote|modified|\.(ts|py|md|json|sh)\b|AC-\d|Task:|Run:)/i.test(t);
}

export function parseBuilderTurnLenient(
  text: string,
  taskId: string,
  runId: string,
  note?: (msg: string) => void,
): BuilderTurnResult {
  try {
    return parseBuilderTurn(text);
  } catch (err) {
    if (!looksSubstantiveResult(text)) throw err;
    note?.('accepted without RESULT_PACKET envelope: identity turn-bound, content judged downstream');
    return {
      taskId,
      runId,
      resultPacket: text.trim(),
      commands: [],
      tests: [],
      knownRisks: ['result accepted without agent-echoed envelope; verify content at QA/PM'],
    };
  }
}
