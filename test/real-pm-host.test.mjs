/**
 * Real PM Host (scripts/real-pm-host-codex.mjs) — contract + fail-closed tests.
 *
 * The host under test is REAL product-adjacent code (stdio NDJSON framing,
 * prompt rendering, strict PM_JUDGMENT parsing, hash verification, fail-closed
 * behavior). Only the LLM runtime is a fixture here (REAL_PM_HOST_CODEX_CMD
 * pointed at test/fixtures/real-pm-host/fake-llm-judge.mjs); LIVE smoke with
 * the real provider is a separate explicit step, never this file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.resolve(__dirname, '../scripts/real-pm-host-codex.mjs');
const FAKE_LLM = path.resolve(__dirname, 'fixtures/real-pm-host/fake-llm-judge.mjs');
const NODE = process.execPath;

const SENTINEL = 'REAL_PM_HOST_SENTINEL_SECRET';

let passed = 0, failed = 0;
const PASS = (m) => { console.log('  PASS  ' + m); passed++; };
const FAIL = (m) => { console.log('  FAIL  ' + m); failed++; process.exitCode = 1; };
const check = (cond, m) => { if (cond) PASS(m); else FAIL(m); };

function packet(taskId, runId, resultText) {
  return {
    schemaVersion: 'pm-verification-context.v1',
    project: 'pmhost',
    delivery: { deliveryId: `PMD-${taskId}-${runId}`, taskId, runId },
    task: {
      taskId, title: 't', goal: 'g', scope: 's',
      completionCriteria: ['content must be exactly status=correct'],
      contract_hash: 'ctr_' + taskId,
    },
    attempt: { runId, taskRunSequence: 1 },
    result: { text: resultText, source: 'fixture' },
    evidence: { summary: {}, selected: [] },
    reviewActions: ['ACCEPT', 'CHANGES'],
    cas: {},
    warnings: [],
  };
}

function startHost(extraEnv = {}) {
  const child = spawn(NODE, [HOST], {
    env: {
      ...process.env,
      REAL_PM_HOST_CODEX_CMD: NODE,
      REAL_PM_HOST_CODEX_ARGV: JSON.stringify([FAKE_LLM]),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const raw of parts) {
      if (!raw.trim()) continue;
      try { lines.push(JSON.parse(raw)); } catch { lines.push({ _raw: raw }); }
    }
  });
  let errText = '';
  child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
  return {
    child,
    lines,
    err: () => errText,
    send: (deliveryId, pkt) => child.stdin.write(JSON.stringify({ type: 'PM_VERIFICATION_DELIVERY', protocolVersion: 1, deliveryId, packet: pkt }) + '\n'),
    async waitFor(pred, timeoutMs = 15000) {
      const start = Date.now();
      for (;;) {
        const hit = lines.find(pred);
        if (hit) return hit;
        if (Date.now() - start > timeoutMs) return null;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    stop() {
      try { child.stdin.end(); } catch { /* ignore */ }
      return new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 3000);
        child.on('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}

const root = (tag) => {
  const dir = path.join(os.tmpdir(), `arl-realpmhost-${tag}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// ── 1. receipt ──
{
  const dir = root('receipt');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_HOST_RECORD_FILE: record, FAKE_LLM_RECORD_FILE: record });
  h.send('PMD-T1-R1', packet('T1', 'R1', 'status=correct'));
  const receipt = await h.waitFor((l) => l.type === 'PM_DELIVERY_RECEIVED' && l.deliveryId === 'PMD-T1-R1');
  check(receipt?.protocolVersion === 1, 'TASK_VERIFY receives PM_DELIVERY_RECEIVED receipt');
  await h.stop();
}

// ── 2/3. ACCEPT + CHANGES parsing ──
{
  const dir = root('judge');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'accept' });
  h.send('PMD-TA-RA', packet('TA', 'RA', 'status=correct'));
  const judgment = await h.waitFor((l) => l.type === 'PM_TASK_JUDGMENT' && l.deliveryId === 'PMD-TA-RA', 20000);
  check(judgment?.decision === 'ACCEPT' && typeof judgment?.reason === 'string' && judgment.reason.length > 0, 'ACCEPT parsed with reason');
  check(judgment?.retryInstruction === undefined, 'ACCEPT carries no retryInstruction');
  await h.stop();
}
{
  const dir = root('changes');
  const record = path.join(dir, 'llm.jsonl');
  const retryText = 'do the correct thing now: status=correct';
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'changes', FAKE_LLM_RETRY_TEXT: retryText });
  h.send('PMD-TB-RB', packet('TB', 'RB', 'status=wrong'));
  const judgment = await h.waitFor((l) => l.type === 'PM_TASK_JUDGMENT' && l.deliveryId === 'PMD-TB-RB', 20000);
  check(judgment?.decision === 'CHANGES', 'CHANGES parsed');
  check(judgment?.retryInstruction === retryText, 'retryInstruction preserved verbatim');
  await h.stop();
}

// ── 4. malformed fail-closed ──
{
  const dir = root('malformed');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'malformed' });
  h.send('PMD-TM-RM', packet('TM', 'RM', 'status=correct'));
  const receipt = await h.waitFor((l) => l.type === 'PM_DELIVERY_RECEIVED' && l.deliveryId === 'PMD-TM-RM');
  await new Promise((r) => setTimeout(r, 1500));
  const judgment = h.lines.find((l) => l.type === 'PM_TASK_JUDGMENT');
  check(!!receipt, 'malformed: transport receipt still sent');
  check(!judgment, 'malformed: no judgment emitted (fail closed, never guessed ACCEPT)');
  await h.stop();
}

// ── 5. provider unavailable fail-closed ──
{
  const dir = root('nollm');
  const h = startHost({ REAL_PM_HOST_CODEX_CMD: '/nonexistent-llm-binary-xyz' });
  h.send('PMD-TU-RU', packet('TU', 'RU', 'status=correct'));
  const receipt = await h.waitFor((l) => l.type === 'PM_DELIVERY_RECEIVED' && l.deliveryId === 'PMD-TU-RU');
  await new Promise((r) => setTimeout(r, 1500));
  const judgment = h.lines.find((l) => l.type === 'PM_TASK_JUDGMENT');
  check(!!receipt, 'provider-down: transport receipt still sent');
  check(!judgment, 'provider-down: no judgment emitted (fail closed)');
  check(h.child.exitCode === null, 'provider-down: host stays alive for later deliveries');
  await h.stop();
}

// ── 6. timeout fail-closed ──
{
  const dir = root('timeout');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'slow', FAKE_LLM_SLOW_MS: '5000', REAL_PM_HOST_TIMEOUT_MS: '500' });
  h.send('PMD-TT-RT', packet('TT', 'RT', 'status=correct'));
  await h.waitFor((l) => l.type === 'PM_DELIVERY_RECEIVED' && l.deliveryId === 'PMD-TT-RT');
  await new Promise((r) => setTimeout(r, 2500));
  const judgment = h.lines.find((l) => l.type === 'PM_TASK_JUDGMENT');
  check(!judgment, 'timeout: no judgment emitted (fail closed)');
  check(h.child.exitCode === null, 'timeout: host stays alive after killing the hung LLM call');
  await h.stop();
}

// ── 7. multi-delivery identity ──
{
  const dir = root('multi');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'accept' });
  h.send('PMD-M1-R1', packet('M1', 'R1', 'status=correct'));
  h.send('PMD-M2-R2', packet('M2', 'R2', 'status=correct'));
  const j1 = await h.waitFor((l) => l.type === 'PM_TASK_JUDGMENT' && l.deliveryId === 'PMD-M1-R1', 25000);
  const j2 = await h.waitFor((l) => l.type === 'PM_TASK_JUDGMENT' && l.deliveryId === 'PMD-M2-R2', 25000);
  check(!!j1 && !!j2, 'two deliveries yield two judgments with exact delivery identity (no cross-talk)');
  await h.stop();
}

// ── 8. secret leakage ──
{
  const dir = root('leak');
  const record = path.join(dir, 'llm.jsonl');
  const h = startHost({ FAKE_LLM_RECORD_FILE: record, FAKE_LLM_MODE: 'accept', LEAK_SENTINEL_ENV: SENTINEL });
  h.send('PMD-TL-RL', packet('TL', 'RL', 'status=correct'));
  await h.waitFor((l) => l.type === 'PM_TASK_JUDGMENT' && l.deliveryId === 'PMD-TL-RL', 20000);
  const stdoutText = h.lines.map((l) => JSON.stringify(l)).join('\n');
  const recorded = fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '';
  check(!stdoutText.includes(SENTINEL), 'host protocol output contains no env secret');
  check(!recorded.includes(SENTINEL), 'LLM prompt contains no env secret (packet data only)');
  const promptArg = recorded ? JSON.parse(recorded.split('\n')[0]).prompt : '';
  check(typeof promptArg === 'string' && promptArg.includes('PM_JUDGMENT v1'), 'LLM received the real packet-derived prompt with output contract');
  await h.stop();
}

console.log(`\nReal PM Host tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
