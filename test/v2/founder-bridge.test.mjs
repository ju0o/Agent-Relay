import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FounderInboxBridge } from "../../src/v2/founder-bridge/index.mjs";
import { FounderGateManager } from "../../src/v2/portfolio-jit/index.mjs";

const roots = [];
test.after(async () => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));

function transport(remotePath, bytes) {
  const pushed = []; let pulls = 0;
  return { pushed, get pulls() { return pulls; }, async discover() { return [remotePath]; }, async hash() { return (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"); }, async pull(_remote, local) { pulls += 1; await writeFile(local, bytes); }, async push(local, remote) { pushed.push({ local, remote, bytes: await readFile(local) }); } };
}

test("bridge pulls UTF-8 packet, reuses identical local packet, and writes idempotent receipt", async () => {
  const root = await mkdtemp("/tmp/agent-relay-bridge-"); roots.push(root);
  const packet = Buffer.from("# Founder Gate\nGATE_ID: FG-utf8\nPROJECT: JuActl\n\n## 지금 어디까지 됐나\n\n확인 필요\n", "utf8");
  const remote = "/remote/founder-outbox/JuActl/packets/FG-utf8.md"; const tx = transport(remote, packet);
  const bridge = new FounderInboxBridge({ localInbox: root, remoteRoot: "/remote/data", transport: tx });
  const first = await bridge.syncOnce(); assert.equal(first[0].state, "DELIVERED"); assert.equal(tx.pulls, 1);
  assert.deepEqual(await readFile(join(root, "JuActl/FG-utf8.md")), packet);
  await bridge.syncOnce(); assert.equal(tx.pulls, 1); assert.equal(tx.pushed.length, 2);
});

test("bridge fails closed on local hash mismatch and keeps response lane exact", async () => {
  const root = await mkdtemp("/tmp/agent-relay-bridge-"); roots.push(root);
  const packet = Buffer.from("# Founder Gate\nGATE_ID: FG-hash\nPROJECT: JuActl\n", "utf8"); const remote = "/remote/founder-outbox/JuActl/packets/FG-hash.md"; const tx = transport(remote, packet);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "JuActl"), { recursive: true }));
  await writeFile(join(root, "JuActl/FG-hash.md"), "tampered\n");
  await assert.rejects(() => new FounderInboxBridge({ localInbox: root, transport: tx }).syncOnce(), /hash mismatch/); assert.equal(tx.pulls, 0);
  await writeFile(join(root, "JuActl/FG-hash.md"), packet);
  await writeFile(join(root, "JuActl/FG-hash.response.json"), JSON.stringify({ gateId: "FG-hash", decision: "APPROVE", timestamp: new Date().toISOString() }));
  const uploaded = await new FounderInboxBridge({ localInbox: root, remoteRoot: "/remote/data", transport: tx }).uploadResponses(); assert.equal(uploaded[0].gateId, "FG-hash");
  await writeFile(join(root, "JuActl/FG-stale.response.json"), JSON.stringify({ gateId: "FG-stale", decision: "APPROVE", timestamp: new Date().toISOString() }));
  await assert.rejects(() => new FounderInboxBridge({ localInbox: root, transport: tx }).uploadResponses(), /stale Founder response/);
});

test("transport failure leaves the packet pending for the next poll", async () => {
  const root = await mkdtemp("/tmp/agent-relay-bridge-"); roots.push(root);
  const bridge = new FounderInboxBridge({ localInbox: root, transport: { async discover() { return ["/remote/founder-outbox/JuActl/packets/FG-fail.md"]; }, async hash() { return "0".repeat(64); }, async pull() { throw new Error("scp unavailable"); } } });
  await assert.rejects(() => bridge.syncOnce(), /scp unavailable/);
  await assert.rejects(() => readFile(join(root, "JuActl/FG-fail.md")));
});

test("single instance, receipt reconciliation, response normalization, and packet newlines", async () => {
  const root = await mkdtemp("/tmp/agent-relay-bridge-"); roots.push(root);
  const manager = new FounderGateManager({ root }); const gate = await manager.create({ project: "JuActl", taskId: "t", type: "FOUNDER_E2E_REQUIRED", summary: "확인", reason: "Windows", evidence: [], founderAction: "Run E2E", expectedInput: "GATE_ID=<exact>\\nDECISION: APPROVE\\ntimestamp: <ISO>", resumeAction: "Resume", relatedEvidence: [] });
  const packet = await readFile(gate.packet, "utf8"); assert.match(packet, /GATE_ID=<exact>\nDECISION: APPROVE\ntimestamp: <ISO>/);
  const firstBridge = new FounderInboxBridge({ localInbox: root }); await firstBridge.acquireSingleInstance();
  await assert.rejects(() => new FounderInboxBridge({ localInbox: root }).acquireSingleInstance(), /already running/); await firstBridge.releaseSingleInstance();
  const hash = (await import("node:crypto")).createHash("sha256").update(await readFile(gate.packet)).digest("hex");
  await (await import("node:fs/promises")).mkdir(join(root, "receipts"), { recursive: true });
  await writeFile(join(root, "receipts", `${gate.gateId}.json`), JSON.stringify({ gateId: gate.gateId, contentHash: hash }));
  assert.deepEqual(await manager.reconcileDeliveryReceipts(), [gate.gateId]);
  assert.equal(JSON.parse(await readFile(join(root, "states", `${gate.gateId}.json`))).deliveryState, "DELIVERED");
  assert.deepEqual(await manager.consumeResponses(), []);
});
