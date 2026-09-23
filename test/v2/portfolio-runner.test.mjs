import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildCoreV1Snapshot, formatCoreV1Results, formatCoreV1Text, isCorruptStateError, lastLifecycleEvent, LIFECYCLE_EVENT_TYPES, MAX_LIFECYCLE_EVENTS, parseQaPacket, parseResultPacket, parseTaskPacket, PORTFOLIO_STATE_CORRUPT, PortfolioRunner, recordLifecycleEvent, STATES, QA_VERDICTS } from "../../src/v2/portfolio-runner/index.mjs";
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
  const latest = { type: "TASK_COMPLETED", taskId: "P-1", projectId: "p", state: "VERIFIED_DONE" };
  const snapshot = buildCoreV1Snapshot({ projects: [{ id: "p", coreV1: true, pmChannel: "pm/p", pmState: "READY", runtime: "codex", task: { taskId: "P-1", scope: "bounded", files: [], tests: [] } }] }, { service: "IDLE", updatedAt: "now", events: [{ type: "TASK_DISPATCHED", taskId: "P-1", projectId: "p" }, latest], tasks: [{ projectId: "p", taskId: "P-1", state: "VERIFIED_DONE", attempts: 2, result: { status: "IMPLEMENTED" }, qa: { verdict: "ACCEPT" } }] });
  assert.equal(snapshot.lanes[0].next, null);
  assert.equal(snapshot.lanes[0].lifecycleEventCount, 2);
  assert.deepEqual(snapshot.lanes[0].latestLifecycleEvent, latest);
  assert.match(formatCoreV1Text(snapshot), /p \| PM=READY pm\/p/);
  assert.match(formatCoreV1Text(snapshot), /lifecycle=2 latest=TASK_COMPLETED/);
  assert.equal(JSON.parse(formatCoreV1Results(snapshot, true)).schema, "agent-relay.core-v1.inbox.v1");
  assert.equal(formatCoreV1Results(snapshot, false), formatCoreV1Text(snapshot));
});

test("CORE V1 snapshot prefers active task over historical completed task", () => {
  const snapshot = buildCoreV1Snapshot({ projects: [{ id: "p", coreV1: true, pmChannel: "pm/p", pmState: "READY", runtime: "codex", tasks: [{ taskId: "P-CURRENT", scope: "bounded", files: [], tests: [] }, { taskId: "P-OLD", scope: "bounded", files: [], tests: [] }] }] }, { service: "IDLE", updatedAt: "now", events: [], tasks: [{ projectId: "p", taskId: "P-CURRENT", state: "QA", attempts: 1 }, { projectId: "p", taskId: "P-OLD", state: "VERIFIED_DONE", attempts: 1 }] });
  assert.equal(snapshot.lanes[0].currentTask, "P-CURRENT");
  assert.equal(snapshot.lanes[0].next, null);
});

test("core-v1 status supports --json and preserves text default", async () => {
  const execFileAsync = promisify(execFile);
  const root = await mkdtemp("/tmp/agent-relay-core-status-json-");
  const manifestPath = join(root, "portfolio.json");
  await writeFile(manifestPath, JSON.stringify({ projects: [{ id: "p", coreV1: true, pmChannel: "pm/p", pmState: "READY", runtime: "codex", task: { taskId: "P-1", scope: "bounded", files: [], tests: [] } }] }));
  const bridgePath = new URL("../../bridge/agent-relay.mjs", import.meta.url).pathname;
  const env = { ...process.env, AGENT_RELAY_DATA_ROOT: root, AGENT_RELAY_PORTFOLIO_MANIFEST: manifestPath };
  try {
    const { stdout: jsonOut } = await execFileAsync(process.execPath, [bridgePath, "core-v1", "status", "--json"], { env });
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.schema, "agent-relay.core-v1.inbox.v1");
    assert.equal(parsed.lanes[0].project, "p");
    const { stdout: textOut } = await execFileAsync(process.execPath, [bridgePath, "core-v1", "status"], { env });
    assert.match(textOut, /^CORE_V1/m);
    assert.match(textOut, /p \| PM=READY pm\/p/);
    assert.throws(() => JSON.parse(textOut), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("malformed state arrays and lifecycle events fail closed instead of reaching runner logic", async () => {
  const root = await mkdtemp("/tmp/agent-relay-state-shape-");
  const statePath = join(root, "state.json");
  const runner = new PortfolioRunner({ manifest: { projects: [] }, statePath, worktreeRoot: join(root, "worktrees") });
  const base = { schema: "agent-relay.portfolio-state.v1", tasks: [] };
  for (const badEvents of ["not-an-array", "x", 42, {}, null]) {
    await writeFile(statePath, JSON.stringify({ ...base, events: badEvents }));
    await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE" && error.blocked.reason === "INVALID_SHAPE" && error.statePath === statePath, `events ${JSON.stringify(badEvents)} must fail closed as INVALID_SHAPE`);
  }
  for (const badEvents of [[null], ["x"], [42], [[]], [{ taskId: "T" }], [{ type: "TASK_DISPATCHED" }], [{ type: "TASK_DISPATCHED", taskId: "" }], [{ type: "NOPE", taskId: "T" }], [{ type: "TASK_DISPATCHED", taskId: 42 }]]) {
    await writeFile(statePath, JSON.stringify({ ...base, events: badEvents }));
    await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE" && error.blocked.reason === "INVALID_SHAPE", `events ${JSON.stringify(badEvents)} must fail closed as INVALID_SHAPE`);
  }
  for (const key of ["activeBuilders", "activeQa", "founderDecisions", "resolvedFounderGates"]) {
    await writeFile(statePath, JSON.stringify({ ...base, [key]: "not-an-array" }));
    await assert.rejects(() => runner.load(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE" && error.blocked.reason === "INVALID_SHAPE", `${key} must fail closed as INVALID_SHAPE`);
    await assert.rejects(() => runner.reconcile(), (error) => isCorruptStateError(error) && error.reason === "INVALID_SHAPE", `${key} must block reconcile`);
    assert.equal(await readFile(statePath, "utf8"), JSON.stringify({ ...base, [key]: "not-an-array" }), "corrupt state must not be overwritten");
  }
  await writeFile(statePath, JSON.stringify({ ...base, events: [{ type: "TASK_DISPATCHED", taskId: "T", projectId: "p", attempt: 1 }] }));
  assert.deepEqual((await runner.load()).events.map((event) => event.type), ["TASK_DISPATCHED"]);
  await writeFile(statePath, JSON.stringify({ ...base }));
  const backfilled = await runner.load();
  assert.deepEqual(backfilled.events, []);
  assert.deepEqual(backfilled.activeBuilders, []);
  assert.deepEqual(backfilled.activeQa, []);
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

test("lifecycle events persist dispatch, result, QA verdict, and completion in order", async () => {
  const root = await mkdtemp("/tmp/agent-relay-lifecycle-events-");
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-LIFE", scope: "bounded", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { async run({ sandbox }) { return { pid: 7, code: 0, startedAt: new Date().toISOString(), text: sandbox === "workspace-write" ? `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-LIFE", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "c".repeat(40), summary: "ok" })}` : `QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: "P-LIFE", verdict: "ACCEPT", tests: [], findings: [], summary: "ok" })}` }; } } });
  await runner.enqueue("p");
  const state = await runner.runOnce();
  const types = state.events.map((event) => event.type);
  assert.deepEqual(types, ["TASK_DISPATCHED", "WORKER_RESULT", "QA_VERDICT", "TASK_COMPLETED"]);
  for (const event of state.events) {
    assert.ok(LIFECYCLE_EVENT_TYPES.includes(event.type));
    assert.equal(event.taskId, "P-LIFE");
    assert.equal(event.projectId, "p");
    assert.ok(event.at);
  }
  assert.equal(lastLifecycleEvent(state, "P-LIFE").type, "TASK_COMPLETED");
  const persisted = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.deepEqual(persisted.events.map((event) => event.type), types);
  await rm(root, { recursive: true, force: true });
});

test("lifecycle events capture retry then completion, and failures stay diagnosable", async () => {
  const root = await mkdtemp("/tmp/agent-relay-lifecycle-retry-");
  let builds = 0; let qas = 0;
  const runner = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-RETRY-LIFE", scope: "bounded", files: [], tests: [] } }] }, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), worktrees: { async create() { return { path: root, base: "abc", async cleanup() {} }; } }, runtime: { async run({ sandbox }) { if (sandbox === "workspace-write") { builds += 1; return { pid: builds, code: 0, startedAt: new Date().toISOString(), text: `RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: "P-RETRY-LIFE", status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "d".repeat(40), summary: "ok" })}` }; } qas += 1; return { pid: 10 + qas, code: 0, startedAt: new Date().toISOString(), text: qas === 1 ? `QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: "P-RETRY-LIFE", verdict: "REQUEST_CHANGES", tests: [], findings: ["retry"], summary: "retry" })}` : `QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: "P-RETRY-LIFE", verdict: "ACCEPT", tests: [], findings: [], summary: "ok" })}` }; } } });
  await runner.enqueue("p");
  const state = await runner.runOnce();
  const types = state.events.map((event) => event.type);
  assert.deepEqual(types, ["TASK_DISPATCHED", "WORKER_RESULT", "QA_VERDICT", "TASK_RETRY", "TASK_DISPATCHED", "WORKER_RESULT", "QA_VERDICT", "TASK_COMPLETED"]);
  assert.equal(lastLifecycleEvent(state).type, "TASK_COMPLETED");

  const failRoot = await mkdtemp("/tmp/agent-relay-lifecycle-fail-");
  const failing = new PortfolioRunner({ manifest: { maxBuilders: 1, projects: [{ id: "p", owner: "codex", runtime: "codex", path: "/safe", task: { taskId: "P-FAIL", scope: "bounded", files: [], tests: [] } }] }, statePath: join(failRoot, "state.json"), worktreeRoot: join(failRoot, "worktrees"), worktrees: { async create() { return { path: failRoot, base: "abc", async cleanup() {} }; } }, runtime: { async run() { throw new Error("builder exploded"); } } });
  await failing.enqueue("p");
  const failed = await failing.runOnce();
  assert.equal(failed.tasks[0].state, "HOLD");
  assert.ok(failed.events.some((event) => event.type === "TASK_DISPATCHED"));
  assert.equal(lastLifecycleEvent(failed, "P-FAIL").type, "TASK_FAILED");
  assert.match(lastLifecycleEvent(failed, "P-FAIL").reason, /builder exploded/);
  await rm(root, { recursive: true, force: true });
  await rm(failRoot, { recursive: true, force: true });
});

test("lifecycle event store stays concise and bounded", () => {
  const state = { events: [] };
  for (let i = 0; i < MAX_LIFECYCLE_EVENTS + 10; i += 1) recordLifecycleEvent(state, { type: "TASK_DISPATCHED", taskId: `T-${i}`, projectId: "p", attempt: 1 });
  assert.equal(state.events.length, MAX_LIFECYCLE_EVENTS);
  assert.equal(lastLifecycleEvent(state).taskId, `T-${MAX_LIFECYCLE_EVENTS + 9}`);
  const longError = "x".repeat(1000);
  const entry = recordLifecycleEvent({ events: [] }, { type: "TASK_FAILED", taskId: "T", projectId: "p", state: "HOLD", reason: longError });
  assert.ok(entry.reason.length <= 301);
  assert.throws(() => recordLifecycleEvent({ events: [] }, { type: "NOPE", taskId: "T" }), /invalid lifecycle event type/);
});
