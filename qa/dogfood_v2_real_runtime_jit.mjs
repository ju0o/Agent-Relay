import {
  CodexRuntimeAdapter,
  PortfolioJitScheduler,
  ProjectRegistry,
  RuntimeAllocator,
  WorkQueue,
} from "../src/v2/portfolio-jit/index.mjs";

const marker = "ACTL_V2_REAL_JIT_DOGFOOD_20260922_K7M4Q9";
const adapter = new CodexRuntimeAdapter();
const start = adapter.start.bind(adapter);
const ready = adapter.ready.bind(adapter);
const dispatch = adapter.dispatch.bind(adapter);
const collect = adapter.collect.bind(adapter);
const stop = adapter.stop.bind(adapter);
adapter.start = async (need) => {
  const runtime = await start(need);
  console.log(JSON.stringify({ phase: "started", pid: runtime.pid, executable: runtime.executable, version: runtime.version }));
  return runtime;
};
adapter.ready = async (runtime) => {
  const result = await ready(runtime);
  console.log(JSON.stringify({ phase: "ready", pid: runtime.pid, result }));
  return result;
};
adapter.dispatch = async (runtime, task) => {
  const result = await dispatch(runtime, task);
  console.log(JSON.stringify({ phase: "dispatched", pid: runtime.pid, marker: task.goal, sendAck: result.sendAck }));
  return result;
};
adapter.collect = async (runtime, task) => {
  const result = await collect(runtime, task);
  console.log(JSON.stringify({ phase: "collected", pid: runtime.pid, marker: result.resultText, resultAck: result.resultAck }));
  return result;
};
adapter.stop = async (runtime) => {
  await stop(runtime);
  console.log(JSON.stringify({ phase: "stopped", pid: runtime.pid, workspaceRemoved: true }));
};
const registry = new ProjectRegistry();
registry.upsert({ id: "agent-relay-v2-dogfood", name: "Agent Relay V2", provider: "codex", priority: 0 });
const queue = new WorkQueue();
queue.enqueue({ projectId: "agent-relay-v2-dogfood", goal: marker, priority: 0 });
const allocator = new RuntimeAllocator({ maxActive: 2, adapter });
const scheduler = new PortfolioJitScheduler({ registry, queue, allocator });

console.log(JSON.stringify({ phase: "before", runtimes: allocator.list(), activeRuntimes: allocator.activeCount() }));
const result = await scheduler.tick({ maxFailovers: 0 });
console.log(JSON.stringify({ phase: "after", result: result.ok, status: scheduler.status() }));
if (!result.ok || result.status.result?.text !== marker || allocator.activeCount() !== 0) process.exit(1);
console.log(JSON.stringify({ phase: "verified", marker, taskState: queue.list()[0].state, orphanRuntime: false }));
