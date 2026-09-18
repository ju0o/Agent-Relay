#!/usr/bin/env node
/** Fixture: fake `claude` executable that fails, proving exit-code propagation.
 * When FAKE_CLAUDE_ARGV_DUMP is set, writes the received argv (one per line)
 * there first, proving the process launched before returning exit 3. */
import fs from 'node:fs';
const dumpPath = process.env.FAKE_CLAUDE_ARGV_DUMP;
if (dumpPath) {
  try { fs.writeFileSync(dumpPath, process.argv.slice(2).join('\n'), 'utf8'); } catch { /* best-effort evidence */ }
}
process.stderr.write('fake claude failure\n');
process.exit(3);
