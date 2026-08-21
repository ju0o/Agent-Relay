/* Runs the Windows production build (npm run build:win) and logs output.
   Used via: node scripts/build-win.mjs */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = path.resolve('dist', 'buildwin.log');
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.writeFileSync(log, 'agent-relay-log Windows build runner starting...\n');

try {
  const out = execSync('npm run build:win', { shell: 'cmd.exe', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  fs.appendFileSync(log, out);
  fs.appendFileSync(log, '\n===== DONE ok=true =====\n');
} catch (e) {
  const err = (e.stdout || '') + '\n' + (e.stderr || '');
  fs.appendFileSync(log, err);
  fs.appendFileSync(log, '\n===== DONE ok=false =====\n');
}