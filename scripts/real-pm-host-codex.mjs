/**
 * Real PM Host (Codex-subscription review path) for the canonical PmHostBridge.
 *
 * Speaks the host protocol over stdio NDJSON (same framing as the test fake):
 *   in:  {"type":"PM_VERIFICATION_DELIVERY","protocolVersion":1,"deliveryId","packet"}
 *   out: {"type":"PM_DELIVERY_RECEIVED","protocolVersion":1,"deliveryId"}   (transport receipt only)
 *   out: {"type":"PM_TASK_JUDGMENT","protocolVersion":1,"deliveryId","decision","reason","retryInstruction?"}
 *
 * For each delivery the host:
 *   1. receipts it immediately (transport receipt is never judgment),
 *   2. renders a bounded judgment prompt from the structured verification
 *      packet plus the canonical PM_JUDGMENT v1 output contract,
 *   3. calls the real LLM (`codex exec`, subscription auth, read-only sandbox),
 *   4. strictly parses the fenced PM_JUDGMENT block (existing pm-schemas
 *      parser — malformed output never becomes a judgment),
 *   5. verifies the echoed hashes against the packet, forwards ACCEPT/CHANGES
 *      only, and emits nothing otherwise (FAIL CLOSED — never guess ACCEPT).
 *
 * Configuration via environment (inherited from the bridge spawn; no secrets —
 * Codex uses its own subscription auth, never argv/env credentials):
 *   REAL_PM_HOST_CODEX_CMD    LLM executable (default: codex; tests point it at node)
 *   REAL_PM_HOST_CODEX_ARGV   JSON string array of leading argv (default:
 *                             ["exec","--skip-git-repo-check","-s","read-only"];
 *                             tests use [fixtureScript]); prompt is appended
 *   REAL_PM_HOST_TIMEOUT_MS  per-judgment LLM timeout (default: 180000)
 *
 * The host NEVER writes durable state: no task/plan/judgment/retry files, no
 * dispatch, no advancement. Judgment durability, retry preparation and NEXT
 * all remain the existing Agent Relay backend's job (via submitPmJudgment).
 * Diagnostics go to stderr; protocol on stdout.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_ORCH = path.join(__dirname, '..', 'dist', 'server', 'orchestrator');

const { parsePmJudgment } = await import(pathToFileURL(path.join(DIST_ORCH, 'pm-schemas.js')).href);
const { contextHash, renderOutputContract } = await import(pathToFileURL(path.join(DIST_ORCH, 'pm-packets.js')).href);

const CODEX_CMD = (process.env.REAL_PM_HOST_CODEX_CMD || 'codex').trim() || 'codex';
let CODEX_ARGV;
try {
  const parsed = JSON.parse(process.env.REAL_PM_HOST_CODEX_ARGV ?? '["exec","--skip-git-repo-check","-s","read-only"]');
  if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) throw new Error('must be a JSON string array');
  CODEX_ARGV = parsed;
} catch (err) {
  process.stderr.write(`[real-pm-host] bad REAL_PM_HOST_CODEX_ARGV: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
const TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.REAL_PM_HOST_TIMEOUT_MS || '180000', 10) || 180000);
const PROTOCOL_VERSION = 1;

const RESULT_MAX_CHARS = 4000;
const PROMPT_MAX_CHARS = 12000;

function bound(value, max) {
  const t = String(value ?? '');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function diag(msg) {
  process.stderr.write(`[real-pm-host] ${msg}\n`);
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Render the bounded judgment prompt from the structured verification packet.
 * Returns { prompt, expectedContractHash, expectedContextHash }.
 */
function buildPrompt(packet) {
  const task = packet?.task ?? {};
  const attempt = packet?.attempt ?? {};
  const result = packet?.result ?? {};
  const criteria = Array.isArray(task.completionCriteria) ? task.completionCriteria : [];
  const evidence = Array.isArray(packet?.evidence?.selected) ? packet.evidence.selected : [];
  const lines = [];
  lines.push(`# PM judgment — Task ${task.taskId ?? '(unknown)'} / Run ${attempt.runId ?? '(unknown)'}`);
  lines.push('');
  lines.push(`Title: ${task.title ?? '(untitled)'}`);
  lines.push(`goal: ${bound(task.goal ?? '', 500)}`);
  lines.push(`scope: ${bound(task.scope ?? '', 300)}`);
  lines.push('');
  lines.push('## Completion criteria (verify EACH against the Result below)');
  if (criteria.length === 0) lines.push('(none stated)');
  for (const c of criteria) lines.push(`- ${bound(c, 300)}`);
  lines.push('');
  lines.push('## Result (this is the CLAIM to verify — not proof)');
  lines.push(bound(result.text ?? '(no result text)', RESULT_MAX_CHARS));
  lines.push('');
  lines.push('## Evidence (selected, exact-run)');
  if (evidence.length === 0) lines.push('(none)');
  for (const e of evidence) lines.push(`- ${e.evidenceId ?? '?'} [${e.type ?? '?'}]: ${bound(e.summary ?? '', 200)}`);
  if (Array.isArray(packet?.warnings) && packet.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    for (const w of packet.warnings) lines.push(`- ${bound(w, 200)}`);
  }
  if (Array.isArray(packet?.reviewActions) && packet.reviewActions.length > 0) {
    lines.push('');
    lines.push(`Allowed actions: ${packet.reviewActions.join(', ')}`);
  }
  // Binding discipline: the LLM must echo both hashes exactly. Tasks minted
  // through paths that attach no contract (e.g. V1 MCP intake) declare
  // contract_hash as the literal "none" — the context_hash binding (computed
  // over the entire received packet, always present) still ties the judgment
  // to the reviewed context. The bridge/submitPmJudgment never required
  // hashes; this echo check is strictly anti-confabulation, never a bypass.
  const expectedContractHash = typeof task.contract_hash === 'string' && task.contract_hash ? task.contract_hash : 'none';
  const expectedContextHash = contextHash(packet);
  lines.push('');
  lines.push('## HASHES TO ECHO EXACTLY');
  lines.push(`contract_hash: ${expectedContractHash}`);
  lines.push(`context_hash: ${expectedContextHash}`);
  lines.push('');
  lines.push(renderOutputContract('PM_JUDGMENT v1'));
  const prompt = bound(lines.join('\n'), PROMPT_MAX_CHARS);
  return { prompt, expectedContractHash, expectedContextHash };
}

function runLlm(prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CODEX_CMD, [...CODEX_ARGV, prompt], {
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
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: `LLM timeout after ${TIMEOUT_MS}ms` });
    }, TIMEOUT_MS);
    child.stdout?.on('data', (c) => { if (out.length < 65536) out += c.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `LLM spawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: `LLM exited code=${code}` });
        return;
      }
      resolve({ ok: true, text: out });
    });
  });
}

async function judgeDelivery(deliveryId, packet) {
  let built;
  try {
    built = buildPrompt(packet);
  } catch (err) {
    diag(`delivery ${deliveryId}: prompt build failed (${err instanceof Error ? err.message : String(err)}) — no judgment (fail closed)`);
    return;
  }
  const res = await runLlm(built.prompt);
  if (!res.ok) {
    diag(`delivery ${deliveryId}: ${res.error} — no judgment (fail closed)`);
    return;
  }
  let parsed;
  try {
    parsed = parsePmJudgment(res.text);
  } catch (err) {
    diag(`delivery ${deliveryId}: malformed PM output (${err instanceof Error ? err.message : String(err)}) — no judgment (fail closed)`);
    return;
  }
  if (parsed.decision !== 'ACCEPT' && parsed.decision !== 'CHANGES') {
    diag(`delivery ${deliveryId}: decision ${parsed.decision} is not directly actionable — no judgment (fail closed)`);
    return;
  }
  if (parsed.contract_hash !== built.expectedContractHash || parsed.context_hash !== built.expectedContextHash) {
    diag(`delivery ${deliveryId}: hash echo mismatch — no judgment (fail closed)`);
    return;
  }
  const judgment = {
    type: 'PM_TASK_JUDGMENT',
    protocolVersion: PROTOCOL_VERSION,
    deliveryId,
    decision: parsed.decision,
    reason: parsed.reason,
    ...(parsed.decision === 'CHANGES' ? { retryInstruction: parsed.retry_instruction } : {}),
  };
  reply(judgment);
  diag(`delivery ${deliveryId}: real ${parsed.decision} judgment emitted`);
}

// Sequential judgment queue: deterministic, bounded (one LLM call at a time).
let tail = Promise.resolve();
function enqueue(fn) {
  tail = tail.then(fn, fn);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // malformed inbound ignored
    }
    if (!msg || msg.type !== 'PM_VERIFICATION_DELIVERY' || msg.protocolVersion !== PROTOCOL_VERSION || typeof msg.deliveryId !== 'string') {
      continue; // bridge replies to our own judgments + noise ignored
    }
    const { deliveryId, packet } = msg;
    reply({ type: 'PM_DELIVERY_RECEIVED', protocolVersion: PROTOCOL_VERSION, deliveryId });
    enqueue(() => judgeDelivery(deliveryId, packet));
  }
});
process.stdin.on('end', () => {
  tail.finally(() => process.exit(0));
});

diag(`ready (llm=${CODEX_CMD} timeout=${TIMEOUT_MS}ms)`);
