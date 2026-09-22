import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { FounderGateUiServer, parseFounderPacket } from "../../src/v2/founder-ui/index.mjs";

const roots = [];
test.after(async () => Promise.all(roots.map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp("/tmp/agent-relay-ui-"); roots.push(root); await mkdir(join(root, "JuActl"));
  const packet = `# Founder Gate\nGATE_ID: FG-ui\nPROJECT: juactl\nTYPE: FOUNDER_E2E_REQUIRED\nSTATUS: BLOCKED_FOR_FOUNDER\nCREATED_AT: 2026-09-22T00:00:00.000Z\nTASK_ID: JuActl\nRUN_ID: run-1\n\n## 지금 어디까지 됐나\n\n검증 완료\n\n## 왜 사람 확인이 필요한가\n\nWindows E2E 필요\n\n## 이미 Agent가 확인한 것\n\n- SHA exact\n\n## Founder가 해야 할 것\n\nRun E2E\n\n## 결정 후 자동으로 할 일\n\nResume exact lane\n\n## 관련 증거\n\n- repo=https://github.com/ju0o/JuActl.git ref=feat/test sha=${"a".repeat(40)}\n`;
  await writeFile(join(root, "JuActl/FG-ui.md"), packet); return root;
}

test("Founder UI lists read-only gate details and emits uploaded response", async () => {
  const root = await fixture(); const uploaded = []; const bridge = { async uploadResponses() { uploaded.push(true); return [{ gateId: "FG-ui" }]; } };
  const parsed = parseFounderPacket(await readFile(join(root, "JuActl/FG-ui.md"), "utf8"), join(root, "JuActl/FG-ui.md")); assert.equal(parsed.summary, "검증 완료"); assert.equal(parsed.reason, "Windows E2E 필요"); assert.equal(parsed.checklist.length, 5);
  const server = new FounderGateUiServer({ localInbox: root, bridge, port: 0 }); const port = await server.start();
  const list = await (await fetch(`http://127.0.0.1:${port}/api/gates`)).json(); assert.equal(list[0].gateId, "FG-ui"); assert.equal(list[0].raw.sha.length, 40);
  const detail = await (await fetch(`http://127.0.0.1:${port}/api/gates/FG-ui`)).json(); assert.match(detail.reason, /Windows/); const home = await (await fetch(`http://127.0.0.1:${port}/`)).text(); assert.match(home, /Founder gates/);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/gates/FG-ui/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gateId: "FG-ui", decision: "APPROVE", answers: { sendSuccess: "true" }, founderNote: "확인" }) });
    assert.deepEqual(await response.json(), { state: "SUBMITTED", gateId: "FG-ui" }); assert.equal(uploaded.length, 1);
    const saved = JSON.parse(await readFile(join(root, "JuActl/FG-ui.response.json"), "utf8")); assert.equal(saved.answers.sendSuccess, "true"); assert.equal(saved.founderNote, "확인");
  } finally { await server.stop(); }
});

test("Founder UI binds loopback only and rejects wrong gate response", async () => {
  const root = await fixture(); const server = new FounderGateUiServer({ localInbox: root, bridge: { async uploadResponses() { return []; } }, port: 0 }); const port = await server.start();
  const response = await fetch(`http://127.0.0.1:${port}/api/gates/FG-ui/respond`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ gateId: "FG-other", decision: "APPROVE" }) });
  assert.equal(response.status, 400); await server.stop();
});
