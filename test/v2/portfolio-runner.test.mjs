import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildCoreV1Snapshot, formatCoreV1Results, formatCoreV1Text, isCorruptStateError, parseQaPacket, parseResultPacket, parseResultReturn, parseTaskPacket, PM_FILE_CONTRACT, PORTFOLIO_STATE_CORRUPT, PortfolioRunner, readResultReturnFile, readTaskPacketFile, STATES, QA_VERDICTS } from "../../src/v2/portfolio-runner/index.mjs";
import { CommandRuntimeAdapter, RuntimeAdapter } from "../../src/v2/runtime-adapters/index.mjs";

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

test("portfolio state saves are atomic and never leave truncated JSON", async () => {
  const root = await mkdtemp("/tmp/agent-relay-atomic-state-");
  const statePath = join(root, "state.json");
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  await runner.save({ schema: "agent-relay.portfolio-state.v1", service: "IDLE", tasks: [{ taskId: "A" }] });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).tasks[0].taskId, "A");
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp")), []);
  await runner.save({ schema: "agent-relay.portfolio-state.v1", service: "IDLE", tasks: [{ taskId: "B" }] });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).tasks[0].taskId, "B");
  assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp")), []);
  await rm(root, { recursive: true, force: true });
});

test("stale temp files from an interrupted save never shadow valid state", async () => {
  const root = await mkdtemp("/tmp/agent-relay-atomic-crash-");
  const statePath = join(root, "state.json");
  await writeFile(statePath, JSON.stringify({ schema: "agent-relay.portfolio-state.v1", tasks: [{ taskId: "GOOD" }] }));
  await writeFile(`${statePath}.${process.pid}.crashed.tmp`, '{"tasks": [{"taskId": "TRUNC');
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  assert.equal((await runner.load()).tasks[0].taskId, "GOOD");
  await runner.save({ schema: "agent-relay.portfolio-state.v1", tasks: [{ taskId: "NEXT" }] });
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).tasks[0].taskId, "NEXT");
  await rm(root, { recursive: true, force: true });
});

test("corrupt portfolio state fails closed with blocked evidence instead of resetting", async () => {
  const root = await mkdtemp("/tmp/agent-relay-corrupt-state-");
  const statePath = join(root, "state.json");
  const corrupt = '{"tasks": [{"taskId": "TRUNC';
  await writeFile(statePath, corrupt);
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  const loadError = await runner.load().then(() => null, (error) => error);
  assert.ok(loadError, "load must reject on corrupt state");
  assert.equal(loadError.code, PORTFOLIO_STATE_CORRUPT);
  assert.equal(loadError.reason, "INVALID_JSON");
  assert.ok(loadError.cause instanceof SyntaxError, "INVALID_JSON must carry the JSON parse cause");
  assert.equal(loadError.statePath, statePath);
  assert.equal(loadError.blocked.code, PORTFOLIO_STATE_CORRUPT);
  assert.equal(loadError.blocked.statePath, statePath);
  assert.equal(loadError.blocked.reason, "INVALID_JSON");
  assert.ok(isCorruptStateError(loadError));
  await assert.rejects(() => runner.reconcile(), (error) => isCorruptStateError(error));
  assert.equal(await readFile(statePath, "utf8"), corrupt, "corrupt state must not be overwritten");
  await writeFile(statePath, JSON.stringify({ tasks: "not-an-array" }));
  await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE");
  for (const badTasks of [[null], ["x"], [42], [[]], [null, { taskId: "T" }]]) {
    await writeFile(statePath, JSON.stringify({ schema: "agent-relay.portfolio-state.v1", tasks: badTasks }));
    await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE" && error.blocked.reason === "INVALID_SHAPE", `tasks ${JSON.stringify(badTasks)} must fail closed as INVALID_SHAPE`);
  }
  await rm(join(root, "state.json"), { force: true });
  const fresh = await runner.load();
  assert.deepEqual(fresh.tasks, []);
  await rm(root, { recursive: true, force: true });
});

test("non-ENOENT state read errors fail closed as corrupt instead of propagating raw", async () => {
  const root = await mkdtemp("/tmp/agent-relay-corrupt-read-");
  const statePath = join(root, "state-dir");
  await mkdtemp(join(root, "placeholder-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(statePath, { recursive: true });
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "READ_ERROR" && Boolean(error.cause) && error.blocked.reason === "READ_ERROR");
  await rm(root, { recursive: true, force: true });
});

test("runLoop interval timer is defined on the live start path", async () => {
  const root = await mkdtemp("/tmp/agent-relay-runloop-");
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees") });
  let iterations = 0;
  runner.runOnce = async () => { iterations += 1; controller.abort(); return {}; };
  const controller = new AbortController();
  await runner.runLoop({ intervalMs: 1, signal: controller.signal });
  assert.equal(iterations, 1, "runLoop must execute runOnce then sleep without ReferenceError");
  await rm(root, { recursive: true, force: true });
});

test("result inbox publishes are atomic and never leave truncated JSON", async () => {
  const root = await mkdtemp("/tmp/agent-relay-atomic-result-");
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), resultRoot: join(root, "result-outbox") });
  await runner.publishResult({ taskId: "P-ATOMIC", state: "VERIFIED_DONE", result: { status: "IMPLEMENTED" }, qa: { verdict: "ACCEPT" } });
  const outPath = join(root, "result-outbox", "P-ATOMIC.json");
  assert.equal(JSON.parse(await readFile(outPath, "utf8")).result.status, "IMPLEMENTED");
  assert.deepEqual((await readdir(join(root, "result-outbox"))).filter((name) => name.includes(".tmp")), []);
  await rm(root, { recursive: true, force: true });
});

test("temporary repository-file PM contract reuses canonical packet validation", async () => {
  assert.equal(PM_FILE_CONTRACT.status, "TEMPORARY_BOOTSTRAP");
  assert.equal(PM_FILE_CONTRACT.transport, "repository-file");
  assert.equal(PM_FILE_CONTRACT.bootstrap, "codex-chatgpt-web");
  const root = await mkdtemp("/tmp/agent-relay-pm-file-contract-");
  const runner = new PortfolioRunner({ manifest: { projects: [{ id: "p", active: true, task: { taskId: "P-FILE", scope: "bounded", files: ["a"], tests: ["test"] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), resultRoot: join(root, "result-outbox") });
  const intakeFile = join(root, "pm-inbox-P-FILE.txt");
  await writeFile(intakeFile, `TASK_PACKET: ${JSON.stringify({ schema: "agent-relay.task.v1", taskId: "P-FILE", projectId: "p", scope: "bounded", files: ["a"], tests: ["test"] })}\n`);
  assert.equal((await readTaskPacketFile(intakeFile)).taskId, "P-FILE");
  assert.equal((await runner.acceptTaskPacketFile(intakeFile)).state, "QUEUED");
  await assert.rejects(() => readTaskPacketFile(join(root, "missing.txt")), /ENOENT/);
  const validReturn = JSON.stringify({ schema: "agent-relay.result-return.v1", taskId: "P-FILE", result: { schema: "agent-relay.result.v1", taskId: "P-FILE", status: "IMPLEMENTED", changedFiles: ["a"], tests: ["test"], commitSha: "abc", summary: "ok" }, qa: { schema: "agent-relay.qa.v1", taskId: "P-FILE", verdict: "ACCEPT", tests: ["test"], findings: [], summary: "ok" }, state: "VERIFIED_DONE" });
  assert.equal(parseResultReturn(validReturn).result.status, "IMPLEMENTED");
  assert.throws(() => parseResultReturn("not json"), /invalid RESULT_RETURN/);
  assert.throws(() => parseResultReturn(JSON.stringify({ schema: "agent-relay.result-return.v1", taskId: "P-FILE", result: { schema: "agent-relay.result.v1", taskId: "OTHER", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "abc", summary: "ok" }, state: "VERIFIED_DONE" })), /invalid RESULT_RETURN/);
  assert.throws(() => parseResultReturn(JSON.stringify({ schema: "agent-relay.result-return.v1", taskId: "P-FILE", result: { schema: "agent-relay.result.v1", taskId: "P-FILE", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "abc", summary: "ok" }, qa: { schema: "agent-relay.qa.v1", taskId: "OTHER", verdict: "ACCEPT", tests: [], findings: [], summary: "ok" }, state: "VERIFIED_DONE" })), /invalid RESULT_RETURN/);
  await runner.publishResult({ taskId: "P-FILE", state: "VERIFIED_DONE", result: { schema: "agent-relay.result.v1", taskId: "P-FILE", status: "IMPLEMENTED", changedFiles: ["a"], tests: ["test"], commitSha: "abc", summary: "ok" }, qa: { schema: "agent-relay.qa.v1", taskId: "P-FILE", verdict: "ACCEPT", tests: ["test"], findings: [], summary: "ok" } });
  const returned = await runner.readResultReturn("P-FILE");
  assert.equal(returned.result.status, "IMPLEMENTED");
  assert.equal(returned.qa.verdict, "ACCEPT");
  assert.equal((await readResultReturnFile(join(root, "result-outbox", "P-FILE.json"))).state, "VERIFIED_DONE");
  await rm(root, { recursive: true, force: true });
});
