#!/usr/bin/env node
/** Fixture: fake `claude` executable for wrapper QA-passthrough tests.
 * Echoes the trailing prompt argv back inside a structured semantic-QA block,
 * proving the wrapper forwards `--print <prompt>` verbatim and propagates
 * stdout + exit code without alteration. */
const args = process.argv.slice(2);
const flagIdx = args.indexOf('--print');
const prompt = flagIdx !== -1 ? args[flagIdx + 1] ?? '' : '';
process.stdout.write(`status: PASS\ncriteria:\n- AC-02: PASS\nECHO:${String(prompt).slice(0, 64)}\n`);
process.exit(0);
