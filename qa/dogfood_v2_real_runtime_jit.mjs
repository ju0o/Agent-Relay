import {
  CodexRuntimeAdapter,
  PortfolioJitScheduler,
  ProjectRegistry,
  RuntimeAllocator,
  WorkQueue,
} from "../src/v2/portfolio-jit/index.mjs";

const marker = "ACTL_V2_REAL_JIT_DOGFOOD_20260922_K7M4Q9";
const adapter = new CodexRuntimeAdapter();
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
