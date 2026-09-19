/**
 * GOAL INTAKE 01 — real PM planner (Codex subscription provider).
 *
 * Reuses the already-proven real Codex subscription/provider invocation
 * pattern from scripts/real-pm-host-codex.mjs:
 *   - `codex exec --skip-git-repo-check -s read-only` + prompt appended
 *   - subscription auth owned by Codex itself (never argv/env credentials)
 *   - bounded output, strict parsing, FAIL CLOSED (never guess a Plan)
 *
 * This module NEVER writes durable state: no goal/task/plan/run files, no
 * dispatch, no advancement. It returns a strictly validated Plan Draft, or
 * throws. All persistence stays in the canonical kernels (goal-intake.ts
 * orchestrates createGoal / createTask / createExecutionPlan).
 *
 * Configuration via environment (same knobs as the PM host):
 *   GOAL_INTAKE_PLANNER_CMD       LLM executable (default: codex)
 *   GOAL_INTAKE_PLANNER_ARGV      JSON string array of leading argv
 *                                 (default: ["exec","--skip-git-repo-check","-s","read-only"])
 *   GOAL_INTAKE_PLANNER_TIMEOUT_MS per-plan LLM timeout (default: 180000)
 */
import { spawn } from 'node:child_process';

export class GoalPlannerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoalPlannerError';
    this.code = code;
  }
}

/** One canonical Task contract as derived by the real PM planner. */
export interface PlannedTaskDraft {
  title: string;
  goal: string;
  reason: string;
  scope: string;
  completionCriteria: string[];
}

/** Strictly validated structured Plan Draft — the only planner output shape. */
export interface ValidatedPlanDraft {
  title: string;
  tasks: PlannedTaskDraft[];
}

export const PLAN_DRAFT_MIN_TASKS = 1;
export const PLAN_DRAFT_MAX_TASKS = 8;
const TITLE_MAX = 200;
const TEXT_MAX = 2000;
const CRITERION_MAX = 500;
const CRITERIA_MAX = 10;

const PLANNER_CMD = (process.env.GOAL_INTAKE_PLANNER_CMD || 'codex').trim() || 'codex';
function plannerArgv(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      process.env.GOAL_INTAKE_PLANNER_ARGV ?? '["exec","--skip-git-repo-check","-s","read-only"]',
    );
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
      throw new Error('must be a JSON string array');
    }
    return parsed as string[];
  } catch (err) {
    throw new GoalPlannerError(
      'INVALID_CONFIG',
      `Bad GOAL_INTAKE_PLANNER_ARGV: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
const PLANNER_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.GOAL_INTAKE_PLANNER_TIMEOUT_MS || '180000', 10) || 180000,
);
const LLM_OUTPUT_MAX_CHARS = 65536;

function bound(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function requireDraftString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GoalPlannerError('MALFORMED_DRAFT', `${field} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new GoalPlannerError('MALFORMED_DRAFT', `${field} exceeds ${max} chars.`);
  }
  return trimmed;
}

/**
 * Strict Plan Draft validation — pure, no I/O. Malformed/empty output is
 * rejected here so it can never become Tasks, a Plan, or a dispatch.
 */
export function validatePlanDraft(raw: unknown): ValidatedPlanDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GoalPlannerError('MALFORMED_DRAFT', 'Plan Draft must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  const title = requireDraftString(obj.title, 'title', TITLE_MAX);
  if (!Array.isArray(obj.tasks)) {
    throw new GoalPlannerError('MALFORMED_DRAFT', 'tasks must be an array.');
  }
  if (obj.tasks.length < PLAN_DRAFT_MIN_TASKS) {
    throw new GoalPlannerError('MALFORMED_DRAFT', 'tasks must contain at least one Task.');
  }
  if (obj.tasks.length > PLAN_DRAFT_MAX_TASKS) {
    throw new GoalPlannerError(
      'MALFORMED_DRAFT',
      `tasks must contain at most ${PLAN_DRAFT_MAX_TASKS} Tasks.`,
    );
  }
  const tasks: PlannedTaskDraft[] = obj.tasks.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GoalPlannerError('MALFORMED_DRAFT', `tasks[${index}] must be an object.`);
    }
    const t = entry as Record<string, unknown>;
    const allowed = new Set(['title', 'goal', 'reason', 'scope', 'completionCriteria']);
    for (const key of Object.keys(t)) {
      if (!allowed.has(key)) {
        throw new GoalPlannerError('MALFORMED_DRAFT', `tasks[${index}] has unknown field: ${key}.`);
      }
    }
    let completionCriteria: string[] = [];
    if (t.completionCriteria !== undefined) {
      if (!Array.isArray(t.completionCriteria)) {
        throw new GoalPlannerError(
          'MALFORMED_DRAFT',
          `tasks[${index}].completionCriteria must be a string array.`,
        );
      }
      if (t.completionCriteria.length > CRITERIA_MAX) {
        throw new GoalPlannerError(
          'MALFORMED_DRAFT',
          `tasks[${index}].completionCriteria exceeds ${CRITERIA_MAX} entries.`,
        );
      }
      completionCriteria = t.completionCriteria.map((c, ci) =>
        requireDraftString(c, `tasks[${index}].completionCriteria[${ci}]`, CRITERION_MAX),
      );
    }
    return {
      title: requireDraftString(t.title, `tasks[${index}].title`, TITLE_MAX),
      goal: requireDraftString(t.goal, `tasks[${index}].goal`, TEXT_MAX),
      reason: requireDraftString(t.reason, `tasks[${index}].reason`, TEXT_MAX),
      scope: requireDraftString(t.scope, `tasks[${index}].scope`, TEXT_MAX),
      completionCriteria,
    };
  });
  return { title, tasks };
}

function extractFencedDraft(text: string): unknown {
  const match = /```json\s*PLAN_DRAFT v1\s*\n([\s\S]*?)\n```/.exec(text);
  if (!match) {
    throw new GoalPlannerError(
      'MALFORMED_DRAFT',
      'Planner output has no fenced ```json PLAN_DRAFT v1 block.',
    );
  }
  try {
    return JSON.parse(match[1] as string);
  } catch {
    throw new GoalPlannerError('MALFORMED_DRAFT', 'Planner fenced block is not valid JSON.');
  }
}

function buildPlannerPrompt(input: { title: string; goalStatement: string }): string {
  const lines = [
    '# PM planning — decompose ONE Founder Goal into canonical Tasks',
    '',
    `Founder Goal title: ${bound(input.title, 300)}`,
    `Founder Goal statement: ${bound(input.goalStatement, 2000)}`,
    '',
    'Decompose the Goal into an ORDERED list of Tasks (first = do first).',
    'Each Task must be a bounded unit of work with verifiable completion criteria.',
    '',
    '## OUTPUT CONTRACT (only this, nothing else)',
    'Emit exactly one fenced block:',
    '```json PLAN_DRAFT v1',
    '{"title":"<plan title>","tasks":[{"title":"<task title>","goal":"<what done looks like>","reason":"<why this task>","scope":"<bounded scope>","completionCriteria":["<verifiable criterion>"]}]}',
    '```',
    'Rules: 1-8 tasks. No unknown fields. No markdown outside the fence.',
  ];
  return lines.join('\n').slice(0, 6000);
}

function runPlannerLlm(prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PLANNER_CMD, [...plannerArgv(), prompt], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn threw: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve({ ok: false, error: `Planner timeout after ${PLANNER_TIMEOUT_MS}ms` });
    }, PLANNER_TIMEOUT_MS);
    child.stdout?.on('data', (c) => {
      if (out.length < LLM_OUTPUT_MAX_CHARS) out += c.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `Planner spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `Planner exited code=${code}` });
        return;
      }
      resolve({ ok: true, text: out });
    });
  });
}

export interface FounderGoalInput {
  title: string;
  goalStatement: string;
}

/**
 * Ask the REAL PM planner for a structured Plan Draft. Throws (fail closed)
 * on transport failure, malformed output, or validation failure. Never writes.
 */
export async function planDraftFromFounderGoal(
  input: FounderGoalInput,
): Promise<ValidatedPlanDraft> {
  if (!input || typeof input.title !== 'string' || !input.title.trim()) {
    throw new GoalPlannerError('INVALID_ARGUMENT', 'Founder Goal title is required.');
  }
  if (typeof input.goalStatement !== 'string' || !input.goalStatement.trim()) {
    throw new GoalPlannerError('INVALID_ARGUMENT', 'Founder Goal statement is required.');
  }
  const prompt = buildPlannerPrompt({ title: input.title.trim(), goalStatement: input.goalStatement.trim() });
  const res = await runPlannerLlm(prompt);
  if (!res.ok) {
    throw new GoalPlannerError('PLANNER_FAILED', res.error);
  }
  return validatePlanDraft(extractFencedDraft(res.text));
}
