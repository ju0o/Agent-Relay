#!/usr/bin/env node
/**
 * TEST TOOLING ONLY — turn-protocol responder for runner tests.
 *
 * Never used by product code. Reads request wires (stdin: pipe or tty),
 * prints exactly one AR_TURN_BEGIN/END boundary per request on stdout.
 * Line-driven: it reacts when the end-marker LINE arrives, so it works
 * both with closed pipes and with live tmux pane input (no EOF needed).
 * Behavior switches on RR_ROLE so each turn spawns a fresh process:
 *
 *   RR_ROLE=echo     ECHO:<request body>
 *   RR_ROLE=pm       DISPATCH first READY task, or ACCEPT on REVIEW bodies
 *   RR_ROLE=builder  optional RR_COUNTER append + RR_SLEEP_MS delay, then a
 *                    RESULT_PACKET carrying the wire's Task/Run identity
 *   RR_ROLE=qa       QA_PASS
 */
import * as fs from 'node:fs';

const responded = new Set();
let buf = '';
let pending = 0;

// Startup line (no markers): lets harness wait for readiness deterministically.
process.stdout.write('TURN_RESPONDER_READY\n');

function respond(requestId, seg) {
  const out = (body) => process.stdout.write(`AR_TURN_BEGIN:${requestId}\n${body}\nAR_TURN_END:${requestId}\n`);
  const role = process.env.RR_ROLE ?? 'echo';
  if (role === 'pm') {
    if (/^REVIEW/m.test(seg)) {
      out(`ACCEPT\n${JSON.stringify({ reason: 'verified result accepted' })}`);
      return;
    }
    const ready = (seg.match(/^READY:\s*(.+)$/m) || [])[1] || process.env.RR_TASK || 'TASK-0001';
    out(`DISPATCH\n${JSON.stringify({ taskId: ready.split(',')[0].trim() })}`);
    return;
  }
  if (role === 'builder') {
    if (process.env.RR_COUNTER) fs.appendFileSync(process.env.RR_COUNTER, 'build\n');
    const tm = seg.match(/^TASK\s+(\S+)\s+RUN\s+(\S+)/m) || [];
    const body = ['RESULT_PACKET', `Task: ${tm[1] || 'TASK-?'}`, `Run: ${tm[2] || 'run-?'}`, 'Commands: npm test', 'Tests: e2e', 'Known risks: none'].join('\n');
    const sleepMs = Number(process.env.RR_SLEEP_MS ?? 0);
    if (sleepMs > 0) {
      pending += 1;
      setTimeout(() => { out(body); pending -= 1; maybeExit(); }, sleepMs);
      return;
    }
    out(body);
    return;
  }
  if (role === 'qa') {
    out('QA_PASS\ncontract and evidence verified');
    return;
  }
  if (role === 'propose') {
    out(`\`\`\`json TASK_PROPOSAL v1 ${JSON.stringify({
      goal: 'Run the dependency-free regression subset and report structured evidence',
      bounded_scope: 'Execute only the approved read-only regression commands; modify no product files; create no tmux sessions',
      acceptance_criteria: [{ id: 'AC-1', description: 'regression output captured with exit codes' }],
    })}\`\`\``);
    return;
  }
  if (role === 'propose-bad') {
    out('I propose we run the tests sometime (no fenced block)');
    return;
  }
  out(`ECHO:${seg.trim()}`);
}

function maybeExit() {
  if (process.stdin.readableEnded && pending === 0) process.exit(0);
}

function ingest(chunk) {
  buf += String(chunk);
  for (;;) {
    const m = buf.match(/^AR_TURN_END:(\S+)\s*$/m);
    if (!m) return;
    const requestId = m[1];
    const line = m[0];
    const endIdx = buf.indexOf(line);
    const beginTag = `AR_TURN_BEGIN:${requestId}`;
    const beginIdx = buf.lastIndexOf(beginTag, endIdx);
    const seg = beginIdx >= 0 ? buf.slice(beginIdx + beginTag.length, endIdx) : '';
    buf = buf.slice(endIdx + line.length).replace(/^\r?\n/, '');
    if (beginIdx >= 0 && !responded.has(requestId)) {
      responded.add(requestId);
      respond(requestId, seg);
    }
  }
}

process.stdin.on('data', ingest);
process.stdin.on('end', maybeExit);
