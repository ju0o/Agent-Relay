/**
 * TEST-ONLY fake LLM runtime for real-pm-host tests.
 *
 * Stands in for `codex exec` (selected via REAL_PM_HOST_CODEX_CMD): receives
 * the judgment prompt as argv, records it for arrival/leakage assertions, and
 * answers per FAKE_LLM_MODE. Hash values are EXTRACTED from the prompt's
 * HASHES block and echoed back, so the host's echo-verification is genuinely
 * exercised without hard-coding per-delivery values.
 *
 * Modes (FAKE_LLM_MODE): accept | changes | malformed | slow | crash
 *   FAKE_LLM_RECORD_FILE  appends JSON {argv,prompt} per invocation (required)
 *   FAKE_LLM_SLOW_MS      sleep before answering in slow mode (default 3000)
 *   FAKE_LLM_RETRY_TEXT   retry_instruction body for changes mode
 *
 * NEVER used outside tests. LIVE smoke always uses the real provider.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const recordFile = process.env.FAKE_LLM_RECORD_FILE || '';
if (!recordFile) {
  process.stderr.write('[fake-llm-judge] FAKE_LLM_RECORD_FILE is required\n');
  process.exit(2);
}

const mode = process.env.FAKE_LLM_MODE || 'accept';
const prompt = process.argv.slice(2).join('\n');

try {
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  fs.appendFileSync(recordFile, JSON.stringify({ argv: process.argv.slice(2), prompt }) + '\n', 'utf8');
} catch (err) {
  process.stderr.write(`[fake-llm-judge] record failed: ${err instanceof Error ? err.message : String(err)}\n`);
}

const pick = (re) => {
  const m = prompt.match(re);
  return m ? m[1].trim() : '';
};
const contractHash = pick(/^contract_hash:\s*(.*)$/m);
const contextHash = pick(/^context_hash:\s*(.*)$/m);

const fence = (obj) => `Here is my review.\n\`\`\`json\nPM_JUDGMENT v1\n${JSON.stringify(obj)}\n\`\`\`\n`;

if (mode === 'crash') {
  process.stderr.write('[fake-llm-judge] simulated provider crash\n');
  process.exit(1);
}
if (mode === 'slow') {
  const ms = Number.parseInt(process.env.FAKE_LLM_SLOW_MS || '3000', 10) || 3000;
  await new Promise((r) => setTimeout(r, ms));
}
if (mode === 'malformed') {
  process.stdout.write('I think this looks fine, ship it! No structured block here.\n');
  process.exit(0);
}
if (mode === 'changes') {
  process.stdout.write(fence({
    decision: 'CHANGES',
    retry: 'SAME_TASK',
    reason: 'fixture review: result does not satisfy the criterion',
    contract_hash: contractHash,
    context_hash: contextHash,
    retry_instruction: process.env.FAKE_LLM_RETRY_TEXT || 'fixture retry: produce the correct content and resubmit',
  }));
  process.exit(0);
}
// accept (default)
process.stdout.write(fence({
  decision: 'ACCEPT',
  retry: 'NONE',
  reason: 'fixture review: result satisfies the criterion',
  contract_hash: contractHash,
  context_hash: contextHash,
}));
process.exit(0);
