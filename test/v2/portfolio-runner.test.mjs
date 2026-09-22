import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseQaPacket, parseResultPacket, PortfolioRunner, STATES, QA_VERDICTS } from "../../src/v2/portfolio-runner/index.mjs";

test("packet parsers are strict and exit-zero without a packet is not completion", () => {
  assert.equal(parseResultPacket('RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"T","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"ok"}').status, "IMPLEMENTED");
  assert.equal(parseQaPacket('QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"T","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}').verdict, "ACCEPT");
  assert.deepEqual(STATES.includes("VERIFIED_DONE"), true);
  assert.deepEqual(QA_VERDICTS, ["ACCEPT", "REQUEST_CHANGES", "FOUNDER_GATE"]);
  assert.throws(() => parseResultPacket("completed successfully"), /invalid RESULT_PACKET/);
  assert.throws(() => parseQaPacket("exit 0"), /invalid QA_PACKET/);
});

test("runner blocks external/no-scope projects without launching a Builder", async () => {
  const root = await mkdtemp("/tmp/agent-relay-runner-test-");
  const statePath = join(root, "state.json");
  let launched = 0;
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 2, projects: [{ id: "juactl", owner: "cursor", state: "BLOCKED_EXTERNAL" }] }, statePath, worktreeRoot: join(root, "worktrees"), runtime: { async run() { launched += 1; } } });
  await runner.enqueue("juactl");
  const state = await runner.runOnce();
  assert.equal(state.tasks[0].state, "BLOCKED_EXTERNAL");
  assert.equal(launched, 0);
  await rm(root, { recursive: true, force: true });
});

test("runner requeues interrupted execution on reconcile", async () => {
  const root = await mkdtemp("/tmp/agent-relay-reconcile-test-");
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ tasks: [{ taskId: "T", projectId: "p", state: "RUNNING" }], activeBuilders: [{ taskId: "T", pid: 1 }], activeQa: [] }));
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  const state = await runner.reconcile();
  assert.equal(state.tasks[0].state, "QUEUED");
  assert.equal(state.activeBuilders.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("runner requires independent QA and never exceeds one QA slot", async () => {
  const root = await mkdtemp("/tmp/agent-relay-slots-test-");
  const statePath = join(root, "state.json");
  let qaActive = 0; let maxQa = 0; let seq = 0;
  const runner = new PortfolioRunner({
    manifest: { maxBuilders: 2, projects: [{ id: "a", owner: "codex", path: "/safe", task: { taskId: "A", projectId: "a", scope: "bounded", files: [], tests: [] } }, { id: "b", owner: "codex", path: "/safe", task: { taskId: "B", projectId: "b", scope: "bounded", files: [], tests: [] } }] },
    statePath, worktreeRoot: join(root, "worktrees"),
    worktrees: { async create(project) { return { path: join(root, project.id), base: "base", async cleanup() {} }; } },
    runtime: { async run({ sandbox, workspace }) { const taskId = workspace.endsWith("/a") ? "A" : "B"; if (sandbox === "workspace-write") return { pid: ++seq, code: 0, startedAt: new Date().toISOString(), text: `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId, status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "base", summary: "ok" })}` }; qaActive += 1; maxQa = Math.max(maxQa, qaActive); await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); qaActive -= 1; return { pid: ++seq, code: 0, startedAt: new Date().toISOString(), text: `QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId, verdict: "ACCEPT", tests: [], findings: [], summary: "ok" })}` }; } },
  });
  await runner.enqueue("a"); await runner.enqueue("b");
  const state = await runner.runOnce();
  assert.equal(maxQa, 1);
  assert.deepEqual(state.tasks.map((task) => task.state), ["VERIFIED_DONE", "VERIFIED_DONE"]);
  await rm(root, { recursive: true, force: true });
});
