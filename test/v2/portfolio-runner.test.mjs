import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildCoreV1Snapshot, discoverCodexCommand, formatCoreV1Results, formatCoreV1Text, parseQaPacket, parseResultPacket, parseTaskPacket, PortfolioRunner, STATES, QA_VERDICTS } from "../../src/v2/portfolio-runner/index.mjs";
import { CommandRuntimeAdapter, RuntimeAdapter, createRuntimeAdapters } from "../../src/v2/runtime-adapters/index.mjs";

test("packet parsers are strict and exit-zero without a packet is not completion", () => {
  assert.equal(parseResultPacket('RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"T","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"ok"}').status, "IMPLEMENTED");
  assert.equal(parseQaPacket('QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"T","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}').verdict, "ACCEPT");
  assert.deepEqual(STATES.includes("VERIFIED_DONE"), true);
  assert.deepEqual(STATES.includes("BLOCKED_RUNTIME_ADAPTER"), true);
  assert.deepEqual(QA_VERDICTS, ["ACCEPT", "REQUEST_CHANGES", "FOUNDER_GATE"]);
  assert.throws(() => parseResultPacket("completed successfully"), /invalid RESULT_PACKET/);
  assert.throws(() => parseQaPacket("exit 0"), /invalid QA_PACKET/);
  assert.equal(parseTaskPacket('TASK_PACKET: {"schema":"agent-relay.task.v1","taskId":"T","projectId":"p","scope":"bounded","files":[],"tests":[]}').taskId, "T");
  assert.throws(() => parseTaskPacket("TASK_PACKET: {}"), /invalid TASK_PACKET/);
});

test("repository TASK_PACKET intake is exact and rejects unauthorized scope", async () => {
  const root = await mkdtemp("/tmp/agent-relay-intake-test-");
  const runner = new PortfolioRunner({ manifest: { projects: [{ id: "p", active: true, task: { taskId: "P-1", scope: "bounded", files: ["a"], tests: ["test"] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees") });
  await runner.acceptTaskPacket({ schema: "agent-relay.task.v1", taskId: "P-1", projectId: "p", scope: "bounded", files: ["a"], tests: ["test"] });
  assert.equal((await runner.load()).tasks[0].state, "QUEUED");
  await assert.rejects(() => runner.acceptTaskPacket({ schema: "agent-relay.task.v1", taskId: "P-1", projectId: "p", scope: "bounded", files: ["b"], tests: ["test"] }), /scope mismatch/);
  await rm(root, { recursive: true, force: true });
});

test("CORE V1 Result Inbox keeps lane fields machine-readable and pipeable", () => {
  const snapshot = buildCoreV1Snapshot({ projects: [{ id: "p", coreV1: true, pmChannel: "pm/p", pmState: "READY", runtime: "codex", task: { taskId: "P-1", scope: "bounded", files: [], tests: [] } }] }, { service: "IDLE", updatedAt: "now", tasks: [{ projectId: "p", taskId: "P-1", state: "VERIFIED_DONE", attempts: 2, result: { status: "IMPLEMENTED" }, qa: { verdict: "ACCEPT" } }] });
  assert.equal(snapshot.lanes[0].next, null);
  assert.match(formatCoreV1Text(snapshot), /p \| PM=READY pm\/p/);
  assert.equal(JSON.parse(formatCoreV1Results(snapshot, true)).schema, "agent-relay.core-v1.inbox.v1");
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
  await writeFile(statePath, JSON.stringify({ tasks: [{ taskId: "T", projectId: "p", state: "RUNNING" }], activeBuilders: [{ taskId: "T", pid: 999999 }], activeQa: [] }));
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

test("reconcile creates one Founder Gate packet and preserves blocker arrays", async () => {
  const root = await mkdtemp("/tmp/agent-relay-founder-reconcile-");
  const runner = new PortfolioRunner({
    manifest: { projects: [
      { id: "juplan", state: "FOUNDER_GATE", founderRequired: true, founderGate: { type: "FOUNDER_DECISION", taskId: "JUPLAN-REVIEW", summary: "review", reason: "gate", evidence: ["ssot"], founderAction: "review", expectedInput: "DECISION: APPROVE|PAUSE", resumeAction: "resume lane", relatedEvidence: [] } },
      { id: "controler", state: "BLOCKED_RUNTIME_ADAPTER", blockers: ["Claude adapter missing", "Codex forbidden"] },
    ] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), gateRoot: join(root, "founder-outbox"),
  });
  const first = await runner.reconcile(); const second = await runner.reconcile();
  assert.equal(first.projects.find((p) => p.id === "juplan").state, "FOUNDER_GATE");
  assert.equal(first.founderGates.length, 1); assert.equal(first.founderGates[0].deliveryState, "DELIVERY_PENDING");
  assert.equal(first.founderGates[0].gateId, second.founderGates[0].gateId);
  assert.match(await readFile(first.founderGates[0].packet, "utf8"), /STATUS: BLOCKED_FOR_FOUNDER/);
  assert.deepEqual(second.projects.find((p) => p.id === "controler").blockers, ["Claude adapter missing", "Codex forbidden"]);
  await rm(root, { recursive: true, force: true });
});

test("reconcile ignores historical Founder decisions for non-gated integration lanes", async () => {
  const root = await mkdtemp("/tmp/agent-relay-stale-decision-test-");
  const runner = new PortfolioRunner({ manifest: { projects: [{ id: "juplan", coreV1: true, state: "INTEGRATION_TARGET", founderRequired: false }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees") });
  await writeFile(join(root, "state.json"), JSON.stringify({ founderDecisions: [{ projectId: "juplan", decision: "PAUSE", scope: "old V1.1 hold" }], tasks: [] }));
  const state = await runner.reconcile();
  assert.equal(state.projects[0].state, "INTEGRATION_TARGET");
  await rm(root, { recursive: true, force: true });
});

test("runtime adapters fail closed on ownership and unavailable execution", async () => {
  const adapter = new RuntimeAdapter({ id: "claude-team", owner: "claude-team", runtime: "claude-team" });
  assert.throws(() => adapter.assertOwnership({ id: "juactl", owner: "cursor", runtime: "cursor" }), /ownership mismatch/);
  const unavailable = new CommandRuntimeAdapter({ id: "missing", owner: "codex", runtime: "missing", command: "/tmp/agent-relay-missing-runtime" });
  assert.equal((await unavailable.availability()).ok, false);
  await assert.rejects(() => unavailable.run({ workspace: "/tmp", prompt: "no-op" }), /cannot execute/);
});

test("Codex discovery prefers an absolute configured or known login-shell path", () => {
  assert.equal(discoverCodexCommand({ CODEX_BIN: "/tmp/missing-codex" }) !== "/tmp/missing-codex", true);
  assert.equal(discoverCodexCommand({ CODEX_BIN: "/home/skkse12/.local/bin/codex" }), "/home/skkse12/.local/bin/codex");
});

test("installed Cursor and Claude runtimes are discoverable as non-interactive adapters", async () => {
  const adapters = createRuntimeAdapters({ codex: { command: "/bin/true" } });
  assert.equal((await adapters.cursor.availability()).ok, true);
  assert.equal((await adapters.claude.availability()).ok, true);
  assert.equal((await adapters["claude-team"].availability()).ok, true);
});

test("runtime launch failures reconcile back to the same authorized task", async () => {
  const root = await mkdtemp("/tmp/agent-relay-runtime-recovery-"); const statePath = join(root, "state.json");
  const manifest = { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-1", scope: "bounded", files: [], tests: [] } }] };
  const runner = new PortfolioRunner({ manifest, statePath, worktreeRoot: join(root, "worktrees"), runtime: { command: "codex", async run() { throw new Error("spawn codex ENOENT"); } }, worktrees: { async create() { return { path: root, base: "base", async cleanup() {} }; } } });
  await runner.enqueue("p"); const failed = await runner.runOnce(); assert.equal(failed.tasks[0].state, "HOLD"); assert.match(failed.tasks[0].error, /^RUNTIME_LAUNCH:/);
  const recovered = await runner.reconcile(); assert.equal(recovered.tasks[0].state, "QUEUED"); assert.equal(recovered.tasks[0].attempts, failed.tasks[0].attempts);
  await rm(root, { recursive: true, force: true });
});

test("authorized verification task uses the common Codex adapter without fallback", async () => {
  const root = await mkdtemp("/tmp/agent-relay-adapter-test-");
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-VERIFY", scope: "verify", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { command: "codex", async run({ sandbox }) { return { pid: 7, code: 0, startedAt: new Date().toISOString(), text: sandbox === "workspace-write" ? 'RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"P-VERIFY","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"verified"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-VERIFY","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accepted"}' }; } } });
  await runner.enqueue("p");
  const state = await runner.runOnce();
  assert.equal(state.tasks[0].state, "VERIFIED_DONE");
  const returned = JSON.parse(await readFile(join(root, "result-outbox", "P-VERIFY.json"), "utf8"));
  assert.equal(returned.result.taskId, "P-VERIFY");
  assert.equal(returned.qa.verdict, "ACCEPT");
  await rm(root, { recursive: true, force: true });
});

test("QA ACCEPT requires and records durable promotion when available", async () => {
  const root = await mkdtemp("/tmp/agent-relay-promotion-test-"); let promoted = null;
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-PROMOTE", scope: "verify", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_project, taskId, sha) { promoted = { taskId, sha }; return `refs/agent-relay/promotions/${taskId}`; } }, runtime: { command: "codex", async run({ sandbox }) { return { pid: 7, code: 0, startedAt: new Date().toISOString(), text: sandbox === "workspace-write" ? `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-PROMOTE", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "a".repeat(40), summary: "verified" })}` : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-PROMOTE","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accepted"}' }; } } });
  await runner.enqueue("p"); const state = await runner.runOnce();
  assert.equal(state.tasks[0].state, "VERIFIED_DONE"); assert.deepEqual(promoted, { taskId: "P-PROMOTE", sha: "a".repeat(40) }); assert.match(state.tasks[0].promotionRef, /refs\/agent-relay\/promotions/);
  await rm(root, { recursive: true, force: true });
});

test("REQUEST_CHANGES retries the same task, then promotion precedes NEXT", async () => {
  const root = await mkdtemp("/tmp/agent-relay-retry-test-"); let builds = 0; let qas = 0;
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", state: "QUEUED", tasks: [{ taskId: "P-RETRY", scope: "retry", files: [], tests: [] }, { taskId: "P-NEXT", scope: "next", files: [], tests: [] }] }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { command: "codex", async run({ sandbox }) { if (sandbox === "workspace-write") { builds += 1; return { pid: builds, code: 0, startedAt: new Date().toISOString(), text: `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-RETRY", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "b".repeat(40), summary: "retry" })}` }; } qas += 1; return { pid: qas, code: 0, startedAt: new Date().toISOString(), text: qas === 1 ? 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-RETRY","verdict":"REQUEST_CHANGES","tests":[],"findings":["retry"],"summary":"retry"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-RETRY","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accept"}' }; } } });
  await runner.enqueue("p"); const state = await runner.runOnce();
  assert.equal(builds, 2); assert.equal(qas, 2); assert.equal(state.tasks[0].state, "VERIFIED_DONE"); assert.equal(state.tasks[0].taskId, "P-RETRY");
  await rm(root, { recursive: true, force: true });
});

test("worktrees reuse project node_modules without making the tree dirty", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir, lstat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { WorktreeManager } = await import("../../src/v2/portfolio-runner/index.mjs");
  const repo = await mkdtemp(join(tmpdir(), "ar-wt-repo-")); const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
  await mkdir(join(repo, "packages", "a"), { recursive: true }); await writeFile(join(repo, "packages", "a", "package.json"), "{}");
  git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "pkg");
  await mkdir(join(repo, "packages", "a", "node_modules"), { recursive: true });
  const wt = await new WorktreeManager(await mkdtemp(join(tmpdir(), "ar-wt-root-"))).create({ id: "p", path: repo }, "T-1");
  assert.ok((await lstat(join(wt.path, "node_modules"))).isSymbolicLink());
  assert.ok((await lstat(join(wt.path, "packages", "a", "node_modules"))).isSymbolicLink(), "workspace package deps must be linked too");
  assert.equal(execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { encoding: "utf8" }), "");
  await wt.cleanup();
  assert.ok((await lstat(join(repo, "node_modules", ".bin"))).isDirectory(), "cleanup must not delete the project's node_modules");
});
