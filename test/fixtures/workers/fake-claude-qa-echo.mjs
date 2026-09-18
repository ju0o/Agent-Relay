#!/usr/bin/env node
/** Fixture: fake `claude` executable for wrapper QA-passthrough tests.
 * Echoes the trailing prompt argv back inside a structured semantic-QA block,
 * proving the wrapper forwards `--print <prompt>` verbatim and propagates
 * stdout + exit code without alteration. When FAKE_CLAUDE_ARGV_DUMP is set,
 * additionally writes the received argv (one per line) there so tests can
 * prove argv receipt without depending on stdout plumbing. */
import fs from 'node:fs';
const args = process.argv.slice(2);
const flagIdx = args.indexOf('--print');
const prompt = flagIdx !== -1 ? args[flagIdx + 1] ?? '' : '';
process.stdout.write(`status: PASS\ncriteria:\n- AC-02: PASS\nECHO:${String(prompt).slice(0, 64)}\n`);
const dumpPath = process.env.FAKE_CLAUDE_ARGV_DUMP;
if (dumpPath) {
  try { fs.writeFileSync(dumpPath, args.join('\n'), 'utf8'); } catch { /* best-effort evidence */ }
}
process.exit(0);
