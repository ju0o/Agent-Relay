/* Temporary diagnostic — real CaptureManager.arm() path for both adapters. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CaptureManager } from '../dist/server/backend/capture-manager.js';
import { listAdapters } from '../dist/server/integrations/core/registry.js';

const TEST_ROOT = path.join(process.cwd(), '.test-data-root', 'dogfood-diag');
fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });
const folder = path.join(TEST_ROOT, '2026-08-28', 'OpenCode', '01');
fs.mkdirSync(folder, { recursive: true });

for (const adapterId of ['claude-code', 'opencode']) {
  const pushes = [];
  const manager = new CaptureManager((s) => {
    pushes.push({ at: new Date().toISOString(), ...s });
    console.log('PUSH', JSON.stringify(s));
  });
  console.log('ADAPTERS', JSON.stringify(listAdapters().map((a) => ({ id: a.id, name: a.agentName }))));
  console.log(`\n=== arm(${adapterId}) ===`);
  const t0 = Date.now();
  try {
    await manager.arm(folder, adapterId);
    console.log(`arm resolved in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`arm THREW in ${Date.now() - t0}ms:`, e instanceof Error ? e.message : String(e));
  }
  await new Promise((r) => setTimeout(r, 4000));
  console.log(`total pushes (${pushes.length}):`);
  for (const p of pushes) console.log('  ', p.at.slice(11), p.phase, p.adapterId ?? '', p.boundSessionId ?? '', p.message ?? '');
  await manager.disarm().catch(() => undefined);
}

console.log('\nDIAG DONE');
process.exit(0);