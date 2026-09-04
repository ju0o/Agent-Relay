/**
 * TEST-ONLY fake PM Host for V1-G4-C bridge tests.
 *
 * Speaks the host protocol over stdio NDJSON:
 *   in:  {"type":"PM_VERIFICATION_DELIVERY","protocolVersion":1,"deliveryId","packet"}
 *   out: {"type":"PM_DELIVERY_RECEIVED","protocolVersion":1,"deliveryId"}
 *
 * Configuration via environment (inherited from the bridge spawn):
 *   FAKE_HOST_RECORD_FILE  append-only NDJSON record of received packets (required)
 *   FAKE_HOST_MODE         ack | no-ack | crash-immediate | crash-after-receive
 *                          | wrong-id | malformed   (default: ack)
 *
 * The fixture dedupes deliveryIds per process lifetime and records repeats
 * with duplicate:true (at-least-once evidence). Receipt is transport receipt
 * only — never PM judgment. Diagnostics go to stderr; protocol on stdout.
 *
 * NEVER shipped as a production PM Host.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const recordFile = process.env.FAKE_HOST_RECORD_FILE || '';
if (!recordFile) {
  process.stderr.write('[fake-pm-host] FAKE_HOST_RECORD_FILE is required\n');
  process.exit(2);
}

const mode = process.env.FAKE_HOST_MODE || 'ack';

function record(obj) {
  try {
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    fs.appendFileSync(recordFile, JSON.stringify(obj) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[fake-pm-host] record failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

if (mode === 'crash-immediate') {
  process.exit(1);
}

process.stderr.write('[fake-pm-host] ready\n');

const seen = new Set();
let buf = '';
let received = 0;

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

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
    if (!msg || msg.type !== 'PM_VERIFICATION_DELIVERY' || msg.protocolVersion !== 1 || typeof msg.deliveryId !== 'string') {
      continue;
    }
    received += 1;
    const duplicate = seen.has(msg.deliveryId);
    seen.add(msg.deliveryId);
    record({ event: 'received', deliveryId: msg.deliveryId, duplicate, at: new Date().toISOString(), packet: msg.packet });

    if (mode === 'crash-after-receive') {
      process.exit(1);
    }
    if (mode === 'no-ack') {
      continue;
    }
    if (mode === 'wrong-id') {
      reply({ type: 'PM_DELIVERY_RECEIVED', protocolVersion: 1, deliveryId: 'PMD-TASK-0000-wronghost' });
      continue;
    }
    if (mode === 'malformed') {
      process.stdout.write('NOT-JSON{{{garbage\n');
      continue;
    }
    // ack (default): acknowledge every receipt, including duplicates.
    reply({ type: 'PM_DELIVERY_RECEIVED', protocolVersion: 1, deliveryId: msg.deliveryId });
  }
});
