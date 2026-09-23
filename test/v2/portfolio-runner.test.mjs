import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildCoreV1Snapshot, discoverCodexCommand, formatCoreV1Results, formatCoreV1Text, parseQaPacket, parseResultPacket, parseTaskPacket, PortfolioRunner, STATES, QA_VERDICTS, TRANSIENT_ERROR } from "../../src/v2/portfolio-runner/index.mjs";
import { CommandRuntimeAdapter, RuntimeAdapter, createRuntimeAdapters } from "../../src/v2/runtime-adapters/index.mjs";
const passGate = async () => ({ ok: true, results: [] });

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
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { projects: [{ id: "p", active: true, task: { taskId: "P-1", scope: "bounded", files: ["a"], tests: ["test"] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees") });
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
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { maxBuilders: 2, projects: [{ id: "juactl", owner: "cursor", state: "BLOCKED_EXTERNAL" }] }, statePath, worktreeRoot: join(root, "worktrees"), runtime: { async run() { launched += 1; } } });
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
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  const state = await runner.reconcile();
  assert.equal(state.tasks[0].state, "QUEUED");
  assert.equal(state.activeBuilders.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("runner requires independent QA and never exceeds one QA slot", async () => {
  const root = await mkdtemp("/tmp/agent-relay-slots-test-");
  const statePath = join(root, "state.json");
  let qaActive = 0; let maxQa = 0; let seq = 0;
  const runner = new PortfolioRunner({ testGate: passGate,
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
  const runner = new PortfolioRunner({ testGate: passGate,
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
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { projects: [{ id: "juplan", coreV1: true, state: "INTEGRATION_TARGET", founderRequired: false }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees") });
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
  const runner = new PortfolioRunner({ testGate: passGate, manifest, statePath, worktreeRoot: join(root, "worktrees"), runtime: { command: "codex", async run() { throw new Error("spawn codex ENOENT"); } }, worktrees: { async create() { return { path: root, base: "base", async cleanup() {} }; } } });
  await runner.enqueue("p"); const failed = await runner.runOnce(); assert.equal(failed.tasks[0].state, "HOLD"); assert.match(failed.tasks[0].error, /^RUNTIME_LAUNCH:/);
  const recovered = await runner.reconcile(); assert.equal(recovered.tasks[0].state, "QUEUED"); assert.equal(recovered.tasks[0].attempts, failed.tasks[0].attempts);
  await rm(root, { recursive: true, force: true });
});

test("authorized verification task uses the common Codex adapter without fallback", async () => {
  const root = await mkdtemp("/tmp/agent-relay-adapter-test-");
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-VERIFY", scope: "verify", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { command: "codex", async run({ sandbox }) { return { pid: 7, code: 0, startedAt: new Date().toISOString(), text: sandbox === "workspace-write" ? 'RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"P-VERIFY","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"verified"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-VERIFY","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accepted"}' }; } } });
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
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-PROMOTE", scope: "verify", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_project, taskId, sha) { promoted = { taskId, sha }; return `refs/agent-relay/promotions/${taskId}`; } }, runtime: { command: "codex", async run({ sandbox }) { return { pid: 7, code: 0, startedAt: new Date().toISOString(), text: sandbox === "workspace-write" ? `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-PROMOTE", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "a".repeat(40), summary: "verified" })}` : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-PROMOTE","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accepted"}' }; } } });
  await runner.enqueue("p"); const state = await runner.runOnce();
  assert.equal(state.tasks[0].state, "VERIFIED_DONE"); assert.deepEqual(promoted, { taskId: "P-PROMOTE", sha: "a".repeat(40) }); assert.match(state.tasks[0].promotionRef, /refs\/agent-relay\/promotions/);
  await rm(root, { recursive: true, force: true });
});

test("REQUEST_CHANGES retries the same task, then promotion precedes NEXT", async () => {
  const root = await mkdtemp("/tmp/agent-relay-retry-test-"); let builds = 0; let qas = 0;
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", state: "QUEUED", tasks: [{ taskId: "P-RETRY", scope: "retry", files: [], tests: [] }, { taskId: "P-NEXT", scope: "next", files: [], tests: [] }] }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { command: "codex", async run({ sandbox }) { if (sandbox === "workspace-write") { builds += 1; return { pid: builds, code: 0, startedAt: new Date().toISOString(), text: `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-RETRY", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "b".repeat(40), summary: "retry" })}` }; } qas += 1; return { pid: qas, code: 0, startedAt: new Date().toISOString(), text: qas === 1 ? 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-RETRY","verdict":"REQUEST_CHANGES","tests":[],"findings":["retry"],"summary":"retry"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-RETRY","verdict":"ACCEPT","tests":[],"findings":[],"summary":"accept"}' }; } } });
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

test("test gate turns a failing ACCEPT into REQUEST_CHANGES, feeds findings back, and never promotes a failing candidate", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-gate-")); const prompts = []; let gateCalls = 0; const promoted = [];
  const runner = new PortfolioRunner({ testGate: async () => { gateCalls += 1; return gateCalls === 1 ? { ok: false, results: [{ cmd: "npm test", code: 1, tail: "TS2723 boom" }] } : { ok: true, results: [{ cmd: "npm test", code: 0, tail: "" }] }; },
    manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", tasks: [{ taskId: "P-GATE", scope: "gate", files: ["a"], tests: ["npm test"] }] }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "w"),
    worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { promoted.push(id); return `refs/agent-relay/promotions/${id}`; } },
    runtime: { command: "codex", async run({ sandbox, prompt }) { prompts.push(prompt); return { pid: 1, code: 0, startedAt: "t", text: sandbox === "workspace-write" ? 'RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"P-GATE","status":"IMPLEMENTED","changedFiles":["a"],"tests":[],"commitSha":"abc","summary":"s"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"P-GATE","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}' }; } } });
  await runner.enqueue("p"); const state = await runner.runOnce(); const task = state.tasks.find((t) => t.taskId === "P-GATE");
  assert.equal(gateCalls, 2); assert.equal(task.state, "VERIFIED_DONE"); assert.deepEqual(promoted, ["P-GATE"]);
  assert.match(prompts.filter((p) => p.includes("Agent Relay Builder"))[1], /TEST_GATE: `npm test` exit 1: TS2723 boom/, "retry prompt must carry the gate failure");
  assert.doesNotMatch(prompts.find((p) => p.includes("QA Agent")), /"verdict":"ACCEPT"/, "QA prompt must not pre-fill ACCEPT");
});

test("runTestGate runs commands in order in the workspace and stops at the first failure", async () => {
  const { runTestGate } = await import("../../src/v2/portfolio-runner/index.mjs");
  const dir = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-rtg-"));
  const gate = await runTestGate(dir, ["pwd", "exit 3", "echo never"]);
  assert.equal(gate.ok, false); assert.equal(gate.results.length, 2); assert.equal(gate.results[1].code, 3); assert.match(gate.results[0].tail, /ar-rtg-/);
  assert.equal((await runTestGate(dir, ["true"])).ok, true);
});

test("integration branch: next task builds on accepted work; stale candidates cherry-pick; conflicts and gate failures never move it", async () => {
  const { execFileSync } = await import("node:child_process"); const { tmpdir } = await import("node:os");
  const { WorktreeManager, INTEGRATION_REF } = await import("../../src/v2/portfolio-runner/index.mjs");
  const repo = await mkdtemp(join(tmpdir(), "ar-int-")); const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" }).trim();
  g(repo, "init", "-q"); await writeFile(join(repo, "a.txt"), "a\n"); await writeFile(join(repo, "b.txt"), "b\n"); g(repo, "add", "."); g(repo, "commit", "-qm", "base");
  const base = g(repo, "rev-parse", "HEAD"); const project = { id: "p", path: repo };
  const wm = new WorktreeManager(await mkdtemp(join(tmpdir(), "ar-int-root-"))); const pass = async () => ({ ok: true, results: [] });
  const candidate = async (id, file, text, from) => { const wt = from ? { path: join(wm.root, id), base: from } : await wm.create(project, id); if (from) g(repo, "worktree", "add", "-q", "--detach", wt.path, from); await writeFile(join(wt.path, file), text); g(wt.path, "commit", "-qam", id); return { taskId: id, tests: [], result: { commitSha: g(wt.path, "rev-parse", "HEAD") }, builderEvidence: { base: wt.base } }; };
  const t1 = await candidate("T-1", "a.txt", "a1\n");
  assert.equal((await wm.integrate(project, t1, { gate: pass })).state, "FAST_FORWARD");
  const wt2 = await wm.create(project, "T-2"); assert.equal(wt2.base, t1.result.commitSha, "next task must start from integration");
  const stale = await candidate("T-STALE", "b.txt", "b1\n", base);
  const picked = await wm.integrate(project, stale, { gate: pass }); assert.equal(picked.state, "CHERRY_PICKED");
  assert.equal(g(repo, "show", `${INTEGRATION_REF}:a.txt`), "a1"); assert.equal(g(repo, "show", `${INTEGRATION_REF}:b.txt`), "b1");
  const tip = g(repo, "rev-parse", INTEGRATION_REF);
  const clash = await candidate("T-CLASH", "a.txt", "zzz\n", base);
  assert.equal((await wm.integrate(project, clash, { gate: pass })).state, "CONFLICT"); assert.equal(g(repo, "rev-parse", INTEGRATION_REF), tip);
  const bad = await candidate("T-BAD", "c.txt", "c\n", base).catch(async () => null);
  const badTask = bad || (await (async () => { const p = join(wm.root, "T-BAD2"); g(repo, "worktree", "add", "-q", "--detach", p, base); await writeFile(join(p, "c.txt"), "c\n"); g(p, "add", "c.txt"); g(p, "commit", "-qm", "c"); return { taskId: "T-BAD2", tests: ["false"], result: { commitSha: g(p, "rev-parse", "HEAD") }, builderEvidence: { base } }; })());
  assert.equal((await wm.integrate(project, { ...badTask, tests: ["false"] }, { gate: async () => ({ ok: false, results: [{ cmd: "false", code: 1, tail: "" }] }) })).state, "GATE_FAILED");
  assert.equal(g(repo, "rev-parse", INTEGRATION_REF), tip, "gate failure must not move integration");
  assert.equal(g(repo, "rev-parse", "HEAD"), base, "the user's checkout never moves"); assert.equal(g(repo, "status", "--porcelain"), "");
});

test("a HOLD task does not block its lane: reconcile queues the next definition", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-hold-")); const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ schema: "agent-relay.portfolio-state.v1", tasks: [{ taskId: "L-1", projectId: "l", state: "HOLD" }], activeBuilders: [], activeQa: [], events: [] }));
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { projects: [{ id: "l", owner: "codex", runtime: "codex", tasks: [{ taskId: "L-1", scope: "s", files: [], tests: [] }, { taskId: "L-2", scope: "s", files: [], tests: [] }] }] }, statePath, worktreeRoot: join(root, "w") });
  const state = await runner.reconcile();
  assert.equal(state.tasks.find((t) => t.taskId === "L-1").state, "HOLD");
  assert.equal(state.tasks.find((t) => t.taskId === "L-2")?.state, "QUEUED");
});

test("a HOLD task is reported but does not block the lane's next definition", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-hold-"));
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ schema: "agent-relay.portfolio-state.v1", tasks: [{ taskId: "L-1", projectId: "l", state: "HOLD", attempts: 3 }], activeBuilders: [], activeQa: [], events: [] }));
  const runner = new PortfolioRunner({ testGate: passGate, manifest: { projects: [{ id: "l", owner: "codex", runtime: "codex", tasks: [{ taskId: "L-1", scope: "a", files: [], tests: [] }, { taskId: "L-2", scope: "b", files: [], tests: [] }] }] }, statePath, worktreeRoot: join(root, "w") });
  const state = await runner.reconcile();
  assert.equal(state.tasks.find((t) => t.taskId === "L-1").state, "HOLD");
  assert.equal(state.tasks.find((t) => t.taskId === "L-2")?.state, "QUEUED");
});

test("runtime chains: a quota error falls through to the next Worker, and QA uses the lane's own qaRuntime", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-chain-")); const calls = [];
  const packet = (kind) => kind === "workspace-write" ? 'RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"C-1","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"s"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"C-1","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}';
  const fake = (id, fail) => ({ id, async availability() { return { ok: true }; }, async run({ sandbox }) { calls.push(`${id}:${sandbox}`); if (fail) throw new Error(`${id} exit 1: Rate limit reached for requests`); return { pid: 1, code: 0, startedAt: "t", text: packet(sandbox) }; } });
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { opencode: fake("opencode", true), codex: fake("codex"), cline: fake("cline") },
    manifest: { maxBuilders: 4, maxQa: 4, projects: [{ id: "c", runtime: ["opencode", "codex"], qaRuntime: ["cline", "codex"], tasks: [{ taskId: "C-1", scope: "x", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { return `refs/agent-relay/promotions/${id}`; } } });
  await runner.enqueue("c"); const state = await runner.runOnce(); const task = state.tasks.find((t) => t.taskId === "C-1");
  assert.equal(task.state, "VERIFIED_DONE");
  assert.deepEqual(calls, ["opencode:workspace-write", "codex:workspace-write", "cline:read-only"]);
  assert.equal(task.builderEvidence.runtime, "codex"); assert.deepEqual(task.builderEvidence.fallbacks, ["opencode: quota"]); assert.equal(task.qaEvidence.runtime, "cline");
});

test("runLoop: a slow lane does not stop another lane from running its next tasks", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-loop-")); let release; const gate = new Promise((r) => { release = r; }); const order = [];
  const packet = (id, kind) => kind === "workspace-write" ? `RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"${id}","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"s"}` : `QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"${id}","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}`;
  const adapter = { async availability() { return { ok: true }; }, async run({ sandbox, prompt }) { const id = /S-1/.test(prompt) ? "S-1" : /F-2/.test(prompt) ? "F-2" : "F-1"; if (id === "S-1" && sandbox === "workspace-write") await gate; order.push(`${id}:${sandbox}`); return { pid: 1, code: 0, startedAt: "t", text: packet(id, sandbox) }; } };
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { codex: adapter },
    manifest: { maxBuilders: 4, maxQa: 4, projects: [{ id: "slow", runtime: ["codex"], tasks: [{ taskId: "S-1", scope: "x", files: [], tests: [] }] }, { id: "fast", runtime: ["codex"], tasks: [{ taskId: "F-1", scope: "x", files: [], tests: [] }, { taskId: "F-2", scope: "x", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { return `refs/agent-relay/promotions/${id}`; } } });
  const controller = new AbortController(); const loop = runner.runLoop({ intervalMs: 20, signal: controller.signal });
  for (let i = 0; i < 200 && !order.includes("F-2:read-only"); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(order.includes("F-2:read-only"), `fast lane stalled behind the slow one: ${order}`); assert.ok(!order.includes("S-1:workspace-write"));
  release(); for (let i = 0; i < 200 && !order.includes("S-1:read-only"); i++) await new Promise((r) => setTimeout(r, 10));
  controller.abort(); const state = await loop;
  assert.deepEqual(state.tasks.map((t) => `${t.taskId}:${t.state}`).sort(), ["F-1:VERIFIED_DONE", "F-2:VERIFIED_DONE", "S-1:VERIFIED_DONE"]);
});

test("runtime chains: a model that hit quota is tried last for the cooldown window", async () => {
  const calls = []; const ok = { pid: 1, code: 0, startedAt: "t", text: "x" };
  const fake = (id, fail) => ({ async availability() { return { ok: true }; }, async run() { calls.push(id); if (fail()) throw new Error(`${id} exit 1: Rate limit reached`); return ok; } });
  let clineDown = true;
  const runner = new PortfolioRunner({ runtimeAdapters: { cline: fake("cline", () => clineDown), codex: fake("codex", () => false) }, manifest: { projects: [] }, statePath: "/nonexistent/s.json", worktreeRoot: "/nonexistent/w" });
  assert.equal((await runner.runChain(["cline", "codex"], {})).runtime, "codex");
  assert.equal((await runner.runChain(["cline", "codex"], {})).runtime, "codex"); assert.deepEqual(calls, ["cline", "codex", "codex"]);
  runner._cooldown.cline = 0; clineDown = false; assert.equal((await runner.runChain(["cline", "codex"], {})).runtime, "cline");
});

test("runLoop drain: in-flight work finishes, nothing new starts, the loop exits and clears the flag", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-drain-")); let release; const gate = new Promise((r) => { release = r; }); const order = [];
  const packet = (id, kind) => kind === "workspace-write" ? `RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"${id}","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"s"}` : `QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"${id}","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}`;
  const adapter = { async availability() { return { ok: true }; }, async run({ sandbox, prompt }) { const id = /D-2/.test(prompt) ? "D-2" : "D-1"; if (sandbox === "workspace-write") await gate; order.push(`${id}:${sandbox}`); return { pid: 1, code: 0, startedAt: "t", text: packet(id, sandbox) }; } };
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { codex: adapter }, manifest: { maxBuilders: 4, projects: [{ id: "d", runtime: ["codex"], tasks: [{ taskId: "D-1", scope: "x", files: [], tests: [] }, { taskId: "D-2", scope: "x", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { return `refs/agent-relay/promotions/${id}`; } } });
  const loop = runner.runLoop({ intervalMs: 20 }); await new Promise((r) => setTimeout(r, 100));
  await writeFile(join(root, "runner.drain"), ""); release();
  const state = await loop;
  assert.deepEqual(state.tasks.map((t) => `${t.taskId}:${t.state}`), ["D-1:VERIFIED_DONE", "D-2:QUEUED"]); assert.ok(!order.some((x) => x.startsWith("D-2")));
  assert.equal(runner.draining(), false);
});

test("runtime chains: a provider outage (503 overloaded) falls through like a quota hit; a prompt error does not", () => {
  assert.ok(TRANSIENT_ERROR.test('opencode exit 1: Error: {"message":"Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded","type":"server_error"}'));
  assert.ok(!TRANSIENT_ERROR.test("opencode exit 1: syntax error in prompt"));
});

test("reconcile requeues a task held by a provider outage at most twice", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-outage-")); const statePath = join(root, "state.json");
  const held = { taskId: "O-1", projectId: "o", state: "HOLD", error: "opencode exit 1: [503] Upstream error: Service temporarily overloaded" };
  await writeFile(statePath, JSON.stringify({ tasks: [held, { ...held, taskId: "O-2", outageRequeues: 2 }, { ...held, taskId: "O-3", error: "QA rejected" }], activeBuilders: [], activeQa: [] }));
  const runner = new PortfolioRunner({ runtimeAdapters: {}, manifest: { projects: [{ id: "o", runtime: ["codex"], tasks: [{ taskId: "O-1" }, { taskId: "O-2" }, { taskId: "O-3" }] }] }, statePath, worktreeRoot: join(root, "w") });
  const state = await runner.reconcile();
  assert.deepEqual(state.tasks.map((t) => `${t.taskId}:${t.state}`), ["O-1:QUEUED", "O-2:HOLD", "O-3:HOLD"]);
});

test("runtime chains: a non-quota failure holds the task instead of silently switching models", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-chain2-")); const calls = [];
  const bad = { async availability() { return { ok: true }; }, async run() { calls.push("opencode"); throw new Error("opencode exit 1: syntax error in prompt"); } };
  const good = { async availability() { return { ok: true }; }, async run() { calls.push("codex"); return { pid: 1, code: 0, startedAt: "t", text: "" }; } };
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { opencode: bad, codex: good }, manifest: { projects: [{ id: "d", runtime: ["opencode", "codex"], tasks: [{ taskId: "D-1", scope: "x", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } } });
  await runner.enqueue("d"); const state = await runner.runOnce();
  assert.equal(state.tasks.find((t) => t.taskId === "D-1").state, "HOLD"); assert.deepEqual(calls, ["opencode"]);
});

test("CLI adapters build builder vs read-only QA arguments and pin Claude accounts", async () => {
  const { CLI_ARGS, createRuntimeAdapters } = await import("../../src/v2/runtime-adapters/index.mjs");
  const a = { prompt: "P", workspace: "/w" };
  assert.ok(CLI_ARGS.opencode({ ...a, sandbox: "workspace-write" }).includes("--auto")); { const qa = CLI_ARGS.opencode({ ...a, sandbox: "read-only" }); assert.equal(qa[qa.indexOf("--agent") + 1], "plan", "OpenCode QA must use the read-only plan agent"); }
  assert.ok(CLI_ARGS.cursor({ ...a, sandbox: "workspace-write" }).includes("--force")); assert.ok(!CLI_ARGS.cursor({ ...a, sandbox: "read-only" }).includes("--force"));
  assert.ok(CLI_ARGS.cline({ ...a, sandbox: "read-only" }).includes("-p"));
  assert.deepEqual(CLI_ARGS.grok({ ...a, sandbox: "read-only" }).slice(2, 4), ["--permission-mode", "plan"]);
  assert.ok(CLI_ARGS.claude({ ...a, sandbox: "read-only" }).includes("--disallowedTools")); assert.ok(CLI_ARGS.claude({ ...a, sandbox: "workspace-write" }).includes("acceptEdits"));
  const adapters = createRuntimeAdapters({ codex: { command: "codex", async run() {} } });
  assert.match(adapters["claude-team"].env.CLAUDE_CONFIG_DIR, /\.claude-team$/); assert.match(adapters["claude-pro"].env.CLAUDE_CONFIG_DIR, /\.claude-pro$/);
  for (const id of ["opencode", "cline", "grok", "cursor", "claude-team", "claude-pro", "codex"]) assert.ok(adapters[id], id);
});

test("runtime chains also fall through on a timeout kill and on output without a valid packet", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-chain3-")); const calls = [];
  const ok = (sandbox) => sandbox === "workspace-write" ? 'RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"T-1","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"s"}' : 'QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"T-1","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}';
  const hang = { async availability() { return { ok: true }; }, async run() { calls.push("hang"); throw new Error("opencode exit null: > build"); } };
  const garbled = { async availability() { return { ok: true }; }, async run() { calls.push("garbled"); return { pid: 1, code: 0, startedAt: "t", text: "sure, done!" }; } };
  const good = { async availability() { return { ok: true }; }, async run({ sandbox }) { calls.push(`good:${sandbox}`); return { pid: 1, code: 0, startedAt: "t", text: ok(sandbox) }; } };
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { hang, garbled, good }, manifest: { projects: [{ id: "t", runtime: ["hang", "good"], qaRuntime: ["garbled", "good"], tasks: [{ taskId: "T-1", scope: "x", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { return `refs/agent-relay/promotions/${id}`; } } });
  await runner.enqueue("t"); const task = (await runner.runOnce()).tasks.find((x) => x.taskId === "T-1");
  assert.equal(task.state, "VERIFIED_DONE"); assert.deepEqual(calls, ["hang", "good:workspace-write", "garbled", "good:read-only"]);
  assert.deepEqual(task.builderEvidence.fallbacks, ["hang: timeout"]); assert.deepEqual(task.qaEvidence.fallbacks, ["garbled: invalid output"]);
});

test("autoContinue=false pauses the lane after a finished task until the pause flag is removed", async () => {
  const { existsSync } = await import("node:fs"); const { rm: rmf } = await import("node:fs/promises");
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-pause-"));
  const ok = (sandbox, id) => sandbox === "workspace-write" ? `RESULT_PACKET: {"schema":"agent-relay.result.v1","taskId":"${id}","status":"IMPLEMENTED","changedFiles":[],"tests":[],"commitSha":"abc","summary":"s"}` : `QA_PACKET: {"schema":"agent-relay.qa.v1","taskId":"${id}","verdict":"ACCEPT","tests":[],"findings":[],"summary":"ok"}`;
  const runner = new PortfolioRunner({ testGate: passGate, runtimeAdapters: { codex: { async availability() { return { ok: true }; }, async run({ sandbox, prompt }) { const id = prompt.match(/"taskId":"(S-\d)"/)[1]; return { pid: 1, code: 0, startedAt: "t", text: ok(sandbox, id) }; } } },
    manifest: { projects: [{ id: "s", runtime: ["codex"], autoContinue: false, tasks: [{ taskId: "S-1", scope: "a", files: [], tests: [] }, { taskId: "S-2", scope: "b", files: [], tests: [] }] }] },
    statePath: join(root, "state.json"), worktreeRoot: join(root, "w"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; }, async promote(_p, id) { return `refs/agent-relay/promotions/${id}`; } } });
  let state = await runner.runOnce();
  assert.equal(state.tasks.find((t) => t.taskId === "S-1").state, "VERIFIED_DONE"); assert.ok(existsSync(join(root, "lane-pause", "s")));
  state = await runner.runOnce(); assert.equal(state.tasks.find((t) => t.taskId === "S-2"), undefined, "paused lane must not start S-2");
  await rmf(join(root, "lane-pause", "s")); state = await runner.runOnce();
  assert.equal(state.tasks.find((t) => t.taskId === "S-2").state, "VERIFIED_DONE");
});

test("a changed manifest is picked up in place by reconcile (no restart needed)", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR || "/tmp", "ar-reload-")); const mp = join(root, "portfolio.json");
  const write = async (tasks) => { await writeFile(mp, JSON.stringify({ projects: [{ id: "r", runtime: ["codex"], tasks }] })); };
  await write([{ taskId: "R-1", scope: "a", files: [], tests: [] }]);
  const { loadManifest } = await import("../../src/v2/portfolio-runner/index.mjs");
  const runner = new PortfolioRunner({ testGate: passGate, manifest: await loadManifest(mp), manifestPath: mp, statePath: join(root, "state.json"), worktreeRoot: join(root, "w") });
  await runner.reconcile();
  await new Promise((r) => setTimeout(r, 20));
  await write([{ taskId: "R-1", scope: "a", files: [], tests: [] }, { taskId: "R-2", scope: "b", files: [], tests: [] }]);
  await runner.reconcile();
  assert.equal(runner.manifest.projects[0].tasks.length, 2, "new WBS visible without a restart");
  await writeFile(mp, "{ half-written");
  await new Promise((r) => setTimeout(r, 20)); await runner.reconcile();
  assert.equal(runner.manifest.projects[0].tasks.length, 2, "a broken file keeps the last good manifest");
});
