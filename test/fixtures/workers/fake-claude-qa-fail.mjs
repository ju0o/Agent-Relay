#!/usr/bin/env node
/** Fixture: fake `claude` executable that fails, proving exit-code propagation. */
process.stderr.write('fake claude failure\n');
process.exit(3);
