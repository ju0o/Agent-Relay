import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  FAILURE_CLASS,
  FounderGateManager,
  MAX_ACTIVE_RUNTIMES,
  PortfolioJitScheduler,
  PortfolioAutopilot,
  ProjectRegistry,
  RuntimeAllocator,
  TargetResolver,
  deterministicGateId,
  isFounderGateType,
  WorkQueue,
  classifyFailure,
  isFailoverFailure,
} from "../../src/v2/portfolio-jit/index.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const fixtures = [];

async function gitFixture() {
  const root = await mkdtemp("/tmp/agent-relay-target-");
  fixtures.push(root);
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "main", source]);
  await git(source, "config", "user.email", "qa@example.invalid");
  await git(source, "config", "user.name", "QA");
  await writeFile(join(source, "README.md"), "safe\n");
  await git(source, "add", "README.md");
  await git(source, "commit", "-m", "candidate");
  await git(source, "branch", "feature");
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main", "feature");
  const head = await git(source, "rev-parse", "feature");
  return { root, remote, source, head };
}

test.after(async () => {
  await Promise.all(fixtures.map((path) => rm(path, { recursive: true, force: true })));
});

test("classifyFailure maps 429/quota/capacity/crash to failover classes", () => {
  assert.equal(classifyFailure(new Error("HTTP 429 rate limit")), FAILURE_CLASS.PROVIDER_429);
  assert.equal(classifyFailure("quota exceeded"), FAILURE_CLASS.QUOTA);
  assert.equal(classifyFailure("capacity: no slot"), FAILURE_CLASS.CAPACITY);
  assert.equal(classifyFailure("process died exit code 139"), FAILURE_CLASS.RUNTIME_CRASH);
  assert.equal(isFailoverFailure(FAILURE_CLASS.PROVIDER_429), true);
  assert.equal(isFailoverFailure(FAILURE_CLASS.PRODUCT), false);
});

test("work queue is priority ordered and one-task scheduler is serial", async () => {
  const registry = new ProjectRegistry();
  registry.upsert({ id: "juactl", name: "JuActl", priority: 0, stableSha: "7f1d6c4" });
  registry.upsert({ id: "juplan", name: "JuPlan", priority: 3 });
  const queue = new WorkQueue();
  queue.enqueue({ projectId: "juplan", goal: "later", priority: 30 });
  queue.enqueue({ projectId: "juactl", goal: "first", priority: 1 });
  assert.equal(queue.peek().projectId, "juactl");

  let concurrent = 0;
  let maxConcurrent = 0;
  const allocator = new RuntimeAllocator({
    maxActive: MAX_ACTIVE_RUNTIMES,
    startRuntime: async (need) => ({ id: `rt-${need.projectId}`, provider: "mock", state: "READY", projectId: need.projectId }),
    sendTask: async (_rt, task) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return { ok: true, resultText: `ACK:${task.id}`, sendAck: true, resultAck: true };
    },
  });
  const sched = new PortfolioJitScheduler({ registry, queue, allocator });
  const a = sched.tick();
  const b = sched.tick();
  const ra = await a;
  const rb = await b;
  assert.equal(ra.ok, true);
  assert.equal(rb.skipped, true);
  assert.equal(maxConcurrent, 1);
  const status = sched.status();
  assert.equal(status.schema, "agent-relay.v2.portfolio-jit.status.v1");
  assert.match(status.human, /완료/);
  assert.equal(status.result.sendAck, true);
  assert.equal(status.qaState, "PENDING");
});

test("429 triggers failover and does not mark product task failed", async () => {
  const registry = new ProjectRegistry();
  registry.upsert({ id: "juactl", name: "JuActl", priority: 0 });
  const queue = new WorkQueue();
  queue.enqueue({ projectId: "juactl", goal: "harmless", priority: 1 });
  let attempts = 0;
  const allocator = new RuntimeAllocator({
    startRuntime: async (need) => ({ id: `rt-${attempts}-${need.projectId}`, provider: "mock", state: "READY", projectId: need.projectId }),
    sendTask: async (_rt, task) => {
      attempts += 1;
      if (attempts === 1) throw new Error("429 too many requests");
      return { ok: true, resultText: `OK:${task.id}`, sendAck: true, resultAck: true };
    },
  });
  const sched = new PortfolioJitScheduler({ registry, queue, allocator });
  const result = await sched.tick({ maxFailovers: 2 });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(queue.list()[0].state, "DONE");
  assert.notEqual(result.status.result.failureClass, FAILURE_CLASS.PRODUCT);
});

test("runtime capacity respects max 2 active", async () => {
  const allocator = new RuntimeAllocator({ maxActive: 2 });
  const a = await allocator.allocate({ projectId: "p1" });
  const b = await allocator.allocate({ projectId: "p2" });
  assert.equal(allocator.activeCount(), 2);
  await assert.rejects(() => allocator.allocate({ projectId: "p3" }), /capacity/);
  await allocator.release(a);
  await allocator.release(b);
  assert.equal(allocator.activeCount(), 0);
});

test("JSON status exposes Founder Gate fields for JuControler", async () => {
  const registry = new ProjectRegistry();
  registry.upsert({
    id: "juactl",
    name: "JuActl",
    priority: 0,
    stableSha: "7f1d6c4",
    candidateSha: "7bbdbb0",
  });
  const queue = new WorkQueue();
  queue.enqueue({ projectId: "juactl", goal: "status-dogfood", priority: 1 });
  const sched = new PortfolioJitScheduler({ registry, queue });
  await sched.tick();
  const json = JSON.stringify(sched.status());
  const parsed = JSON.parse(json);
  assert.equal(parsed.projects[0].stableSha, "7f1d6c4");
  assert.equal(parsed.projects[0].candidateSha, "7bbdbb0");
  assert.equal(parsed.founderGate, "CANDIDATE_READY");
  assert.ok(parsed.human);
});

test("real adapter lifecycle is start-ready-dispatch-collect-stop and fail-closed", async () => {
  const events = [];
  const marker = "REAL_JIT_TEST_MARKER";
  const adapter = {
    async start() { events.push("start"); return { id: "codex-test", provider: "codex", state: "STARTING" }; },
    async ready(runtime) { events.push("ready"); runtime.state = "READY"; return true; },
    async dispatch(_runtime, task) { events.push(`dispatch:${task.goal}`); },
    async collect() { events.push("collect"); return { resultText: marker, sendAck: true, resultAck: true }; },
    async stop() { events.push("stop"); },
  };
  const registry = new ProjectRegistry();
  registry.upsert({ id: "p", name: "p", provider: "codex" });
  const queue = new WorkQueue();
  queue.enqueue({ projectId: "p", goal: marker });
  const allocator = new RuntimeAllocator({ maxActive: 99, adapter });
  const result = await new PortfolioJitScheduler({ registry, queue, allocator }).tick({ maxFailovers: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(events, ["start", "ready", `dispatch:${marker}`, "collect", "stop"]);
  assert.equal(allocator.activeCount(), 0);
  assert.equal(allocator.maxActive, MAX_ACTIVE_RUNTIMES);
});

test("portfolio autopilot overlaps two builders, rolls a slot, and retries the same task", async () => {
  let sequence = 0;
  const adapter = {
    async start() { sequence += 1; return { id: `rt-${sequence}`, provider: "codex", state: "STARTING" }; },
    async ready(runtime) { runtime.state = "READY"; return true; },
    async dispatch() { await new Promise((resolve) => setTimeout(resolve, 5)); },
    async collect(runtime, task) { return { resultText: task.goal, sendAck: true, resultAck: true, runtime }; },
    async stop() {},
  };
  const builderAllocator = new RuntimeAllocator({ maxActive: 2, adapter });
  const qaAllocator = new RuntimeAllocator({ maxActive: 1, adapter });
  const tasks = [
    { lane: "A", projectId: "juactl", goal: "A_MARKER", requiresQa: true },
    { lane: "B", projectId: "agent-relay", goal: "B_MARKER", requiresQa: true },
    { lane: "C", projectId: "juplan", goal: "C_MARKER", requiresQa: true, qaPlan: ["REQUEST_CHANGES", "ACCEPT"] },
  ];
  const autopilot = new PortfolioAutopilot({
    tasks,
    builderAllocator,
    qaAllocator,
    qaRunner: async (task, result, attempt) => {
      assert.equal(result.resultText, task.goal);
      return task.qaPlan?.[attempt - 1] || "ACCEPT";
    },
  });
  const state = await autopilot.run();
  assert.deepEqual(state.tasks.map((task) => task.state), ["DONE", "DONE", "DONE"]);
  assert.equal(state.maxConcurrentBuilders, 2);
  assert.equal(state.maxConcurrentQa, 1);
  assert.equal(state.events.filter((event) => event.type === "REQUEST_CHANGES").length, 1);
  assert.equal(builderAllocator.activeCount(), 0);
  assert.equal(qaAllocator.activeCount(), 0);
});

test("target resolver validates repository/ref/SHA and reuses a clean checkout", async () => {
  const f = await gitFixture();
  const checkout = join(f.root, "checkout");
  await exec("git", ["clone", "--branch", "feature", f.remote, checkout]);
  const target = { projectId: "juactl", repository: f.remote, ref: "feature", expectedHeadSha: f.head, workspaceMode: "READ_ONLY_QA" };
  const resolved = await new TargetResolver({ roots: [f.root] }).resolve(target);
  assert.equal(resolved.path, checkout);
  assert.equal(resolved.temporary, false);
  await resolved.cleanup();
});

test("target resolver fails closed on wrong SHA, wrong repository, and default-branch substitution", async () => {
  const f = await gitFixture();
  const base = { projectId: "juactl", repository: f.remote, workspaceMode: "READ_ONLY_QA" };
  await assert.rejects(() => new TargetResolver().resolve({ ...base, ref: "feature", expectedHeadSha: "0".repeat(40) }), /exit|failed|not found|verification|unable|tree/i);
  await assert.rejects(() => new TargetResolver().resolve({ ...base, repository: join(f.root, "missing.git"), ref: "feature", expectedHeadSha: f.head }), /exit|failed|not found|does not exist/i);
  await assert.rejects(() => new TargetResolver().resolve({ ...base, ref: "main-only", expectedHeadSha: f.head }), /exit|failed|not found/i);
});

test("target resolver creates and cleans a temporary READ_ONLY_QA checkout", async () => {
  const f = await gitFixture();
  const target = { projectId: "juactl", repository: f.remote, ref: "feature", expectedHeadSha: f.head, workspaceMode: "READ_ONLY_QA" };
  const resolved = await new TargetResolver({ roots: [], tempRoot: f.root }).resolve(target);
  assert.equal(resolved.temporary, true);
  assert.equal(resolved.ref, "feature");
  assert.equal(await git(resolved.path, "rev-parse", "HEAD"), f.head);
  const workspace = resolved.path;
  await resolved.cleanup();
  await assert.rejects(() => readFile(join(workspace, "README.md")));
});

test("READ_ONLY_QA detects target modification and leaves unrelated dirty checkout untouched", async () => {
  const f = await gitFixture();
  const target = { projectId: "juactl", repository: f.remote, ref: "feature", expectedHeadSha: f.head, workspaceMode: "READ_ONLY_QA" };
  const resolver = new TargetResolver({ roots: [], tempRoot: f.root });
  let modifiedPath = "";
  await assert.rejects(() => resolver.runReadOnlyQa(target, async (resolved) => {
    modifiedPath = resolved.path;
    await writeFile(join(resolved.path, "forbidden.txt"), "nope\n");
  }), /modification detected/i);
  await assert.rejects(() => readFile(join(modifiedPath, "forbidden.txt")));

  const dirty = join(f.root, "dirty");
  await exec("git", ["clone", "--branch", "main", f.remote, dirty]);
  await writeFile(join(dirty, "unrelated.txt"), "preserve\n");
  const resolved = await resolver.resolve(target);
  assert.notEqual(resolved.path, dirty);
  assert.equal(await readFile(join(dirty, "unrelated.txt"), "utf8"), "preserve\n");
  await resolved.cleanup();
});

test("Founder Gates classify strictly, deduplicate, and preserve pending delivery", async () => {
  const root = await mkdtemp("/tmp/agent-relay-gate-"); fixtures.push(root);
  const manager = new FounderGateManager({ root });
  assert.equal(isFounderGateType("FOUNDER_E2E_REQUIRED"), true);
  assert.equal(isFounderGateType("QA_CHANGES"), false);
  const input = { project: "juactl", taskId: "task-a", type: "FOUNDER_E2E_REQUIRED", summary: "확인 필요", reason: "Linux cannot prove Windows E2E", evidence: ["exact SHA"], founderAction: "Run the E2E", expectedInput: "APPROVE", resumeAction: "Resume JuActl only", relatedEvidence: ["report"] };
  const a = await manager.create(input); const b = await manager.create(input);
  assert.equal(a.gateId, b.gateId); assert.equal(a.deliveryState, "DELIVERY_PENDING");
  assert.equal(a.gateId, deterministicGateId({ project: "juactl", taskId: "task-a", type: input.type, evidenceHash: a.evidenceHash }));
  assert.match(await readFile(a.packet, "utf8"), /STATUS: BLOCKED_FOR_FOUNDER/);
});

test("blocked lane releases slots, other lane continues, and valid response resumes only it", async () => {
  const root = await mkdtemp("/tmp/agent-relay-gate-"); fixtures.push(root);
  const gateManager = new FounderGateManager({ root });
  const adapter = { async start(need) { return { id: `rt-${need.projectId}-${Date.now()}`, provider: "mock", state: "STARTING" }; }, async ready(rt) { rt.state = "READY"; return true; }, async dispatch() {}, async collect(_rt, task) { return { resultText: task.goal, sendAck: true, resultAck: true }; }, async stop() {} };
  const tasks = [{ lane: "JuActl", projectId: "juactl", goal: "JUACTL_MARKER", requiresQa: true }, { lane: "JuPlan", projectId: "juplan", goal: "JUPLAN_MARKER", requiresQa: true }];
  const autopilot = new PortfolioAutopilot({ tasks, gateManager, builderAllocator: new RuntimeAllocator({ maxActive: 2, adapter }), qaAllocator: new RuntimeAllocator({ maxActive: 1, adapter }), qaRunner: async (task) => task.founderDecision ? "ACCEPT" : task.lane === "JuActl" ? { verdict: "QA_CHANGES", founderGate: { type: "FOUNDER_E2E_REQUIRED", summary: "확인 필요", reason: "live E2E", evidence: ["QA_CHANGES"], founderAction: "Run E2E", expectedInput: "APPROVE", resumeAction: "resume JuActl", relatedEvidence: [] } } : "ACCEPT" });
  let state = await autopilot.run();
  assert.equal(state.tasks[0].state, "BLOCKED_FOR_FOUNDER"); assert.equal(state.tasks[1].state, "DONE"); assert.equal(state.activeBuilders, 0); assert.equal(state.activeQa, 0);
  const durable = JSON.parse(await readFile(join(root, "states", `${state.tasks[0].gateId}.json`)));
  assert.equal(durable.status, "BLOCKED_FOR_FOUNDER");
  await assert.rejects(() => gateManager.respond({ GATE_ID: state.tasks[0].gateId, DECISION: "", timestamp: new Date().toISOString() }), /invalid Founder response/);
  const before = state.tasks[1].attempts; state = await autopilot.applyFounderResponse({ GATE_ID: state.tasks[0].gateId, DECISION: "APPROVE", timestamp: new Date().toISOString() });
  assert.equal(state.tasks[0].state, "DONE"); assert.equal(state.tasks[1].attempts, before); assert.equal(state.activeBuilders, 0);
});
