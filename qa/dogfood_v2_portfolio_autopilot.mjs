import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AutopilotStateStore,
  CodexRuntimeAdapter,
  PortfolioAutopilot,
  RuntimeAllocator,
} from "../src/v2/portfolio-jit/index.mjs";

const builderAdapter = new CodexRuntimeAdapter({ timeoutMs: 120_000 });
const qaAdapter = new CodexRuntimeAdapter({ timeoutMs: 120_000 });
const builderAllocator = new RuntimeAllocator({ maxActive: 2, adapter: builderAdapter });
const qaAllocator = new RuntimeAllocator({ maxActive: 1, adapter: qaAdapter });
const stateDir = await mkdtemp(join(tmpdir(), "agent-relay-v2-autopilot-"));
const stateStore = new AutopilotStateStore(join(stateDir, "state.json"));
const qaEvidence = [];

const tasks = [
  { lane: "A", projectId: "juactl", provider: "codex", goal: "JUACTL_HARMLESS_INSPECTION_20260922", requiresQa: true },
  { lane: "B", projectId: "agent-relay", provider: "codex", goal: "AGENT_RELAY_HARMLESS_INSPECTION_20260922", requiresQa: true },
  { lane: "C", projectId: "juplan", provider: "codex", goal: "JUPLAN_HARMLESS_INSPECTION_20260922", requiresQa: true, qaPlan: ["REQUEST_CHANGES", "ACCEPT"] },
];

const qaRunner = async (task, result, attempt) => {
  const marker = `QA_${task.lane}_ATTEMPT_${attempt}`;
  const runtime = await qaAllocator.allocate({ projectId: `qa-${task.lane}`, provider: "codex" });
  qaEvidence.push({ lane: task.lane, attempt, pid: runtime.pid, startedAt: Date.now() });
  try {
    const qaResult = await qaAllocator.send(runtime, { ...task, goal: marker });
    assert.equal(qaResult.resultText, marker);
    qaEvidence[qaEvidence.length - 1].result = marker;
    qaEvidence[qaEvidence.length - 1].resultAck = qaResult.resultAck;
    return task.qaPlan?.[attempt - 1] || "ACCEPT";
  } finally {
    await qaAllocator.release(runtime);
    qaEvidence[qaEvidence.length - 1].stoppedAt = Date.now();
  }
};

const autopilot = new PortfolioAutopilot({
  tasks,
  builderAllocator,
  qaAllocator,
  stateStore,
  maxBuilders: 2,
  maxQa: 1,
  qaRunner,
});

console.log(JSON.stringify({ phase: "before", builderRuntimes: builderAllocator.list(), qaRuntimes: qaAllocator.list(), stateDir }));
const finalState = await autopilot.run();
const persisted = await stateStore.load();
const reconciled = AutopilotStateStore.reconcile(persisted);
const persistedAfterRestart = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
const builderStarts = finalState.events.filter((event) => event.type === "BUILDER_STARTED");
const builderStops = finalState.events.filter((event) => event.type === "BUILDER_STOPPED");
const resultEvents = finalState.events.filter((event) => event.type === "RESULT");
const retryEvents = finalState.events.filter((event) => event.type === "REQUEST_CHANGES");

assert.deepEqual(finalState.tasks.map((task) => task.state), ["DONE", "DONE", "DONE"]);
assert.equal(finalState.maxConcurrentBuilders, 2);
assert.equal(finalState.maxConcurrentQa, 1);
assert.equal(builderAllocator.activeCount(), 0);
assert.equal(qaAllocator.activeCount(), 0);
assert.equal(retryEvents.some((event) => event.lane === "C"), true);
assert.equal(reconciled.tasks.every((task) => task.state === "DONE"), true);
assert.equal(persistedAfterRestart.tasks.every((task) => task.state === "DONE"), true);
assert.equal(new Set(builderStarts.map((event) => event.pid)).size >= 3, true);
assert.equal(resultEvents.length >= 4, true);

console.log(JSON.stringify({
  phase: "after",
  tasks: finalState.tasks,
  builderStarts,
  builderStops,
  resultEvents,
  retryEvents,
  qaEvidence,
  maxConcurrentBuilders: finalState.maxConcurrentBuilders,
  maxConcurrentQa: finalState.maxConcurrentQa,
  stateSurvivedRestart: persistedAfterRestart.tasks.every((task) => task.state === "DONE"),
  orphanBuilders: builderAllocator.activeCount() === 0,
  orphanQa: qaAllocator.activeCount() === 0,
}));
