/**
 * Harmless dogfood: enqueue one portfolio task and run a single tick
 * against the mock runtime adapter (no external provider / no payment).
 */
import { PortfolioJitScheduler, ProjectRegistry, WorkQueue } from "../src/v2/portfolio-jit/index.mjs";

const registry = new ProjectRegistry();
registry.upsert({
  id: "juactl",
  name: "JuActl",
  priority: 0,
  stableSha: "7f1d6c4e05b90a8b417c3952207027c4b77b1a69",
  candidateSha: "7bbdbb00e82a70a4bc66539199187eeb7f3d0d16",
});

const queue = new WorkQueue();
queue.enqueue({
  projectId: "juactl",
  goal: "NIGHT_DOGFOOD_HARMLESS_STATUS_ONLY",
  priority: 1,
});

const sched = new PortfolioJitScheduler({ registry, queue });
const result = await sched.tick();
const status = sched.status();
console.log(JSON.stringify({ resultOk: result.ok, status }, null, 2));
if (!result.ok) process.exit(1);
