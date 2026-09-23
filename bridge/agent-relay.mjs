#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCoreV1Snapshot, formatCoreV1Results, formatCoreV1Text, loadManifest, parseTaskPacket, PortfolioRunner } from "../src/v2/portfolio-runner/index.mjs";
import { DEFAULT_DEADLINE, finalizeNightRun, NightRunSupervisor, runPoweroff } from "../src/v2/night-run/index.mjs";

const root = process.env.AGENT_RELAY_DATA_ROOT || join(homedir(), ".local", "share", "AgentRelay", "data", "portfolio-execution");
const founderOutbox = process.env.AGENT_RELAY_FOUNDER_OUTBOX || join(homedir(), ".local", "share", "AgentRelay", "data", "founder-outbox");
const manifestPath = process.env.AGENT_RELAY_PORTFOLIO_MANIFEST || new URL("../config/portfolio.json", import.meta.url).pathname;
const runner = () => loadManifest(manifestPath).then((manifest) => new PortfolioRunner({ manifest, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), gateRoot: founderOutbox }));
const pidPath = join(root, "runner.pid");
const nightPath = join(root, "LAST_NIGHT_RUN.json");
const nightPidPath = join(root, "night-run.pid");
const [area, command, project, decision] = process.argv.slice(2);
if (!["portfolio", "project", "core-v1", "night-run"].includes(area)) { console.error("usage: agent-relay core-v1 status|results [--json]|start|resume | night-run once|up|status|stop | portfolio ... | project ..."); process.exit(2); }
const instance = await runner();
const night = ({ deferPoweroff = false } = {}) => {
  const supervisor = new NightRunSupervisor({ runner: instance, checkpointPath: nightPath });
  if (deferPoweroff) supervisor.finalize = (record) => finalizeNightRun({ record, checkpointPath: nightPath, persist: (value) => supervisor.persist(value), deferPoweroff: true });
  return supervisor;
};
if (area === "core-v1" && command === "status") { const state = await instance.load(); console.log(formatCoreV1Text(buildCoreV1Snapshot(instance.manifest, state))); process.exit(0); }
if (area === "core-v1" && command === "results") { const state = await instance.load(); console.log(formatCoreV1Results(buildCoreV1Snapshot(instance.manifest, state), process.argv.includes("--json"))); process.exit(0); }
if (area === "night-run" && command === "status") { console.log(JSON.stringify(await night().status(), null, 2)); process.exit(0); }
if (area === "night-run" && command === "shutdown") { const supervisor = night(); const result = await runPoweroff({ checkpoint: await supervisor.status() }); const checkpoint = await supervisor.status(); if (checkpoint) { checkpoint.shutdownState = result.status; checkpoint.shutdownError = result.reason || null; await supervisor.persist(checkpoint); } console.log(JSON.stringify(result, null, 2)); process.exit(0); }
if (area === "night-run" && command === "once") {
  const deadlineIndex = process.argv.indexOf("--deadline");
  const deadline = deadlineIndex >= 0 ? process.argv[deadlineIndex + 1] : DEFAULT_DEADLINE;
  console.log(JSON.stringify(await night().once({ deadline }), null, 2)); process.exit(0);
}
if (area === "night-run" && command === "up") {
  const deadlineIndex = process.argv.indexOf("--deadline");
  const deadline = deadlineIndex >= 0 ? process.argv[deadlineIndex + 1] : DEFAULT_DEADLINE;
  const noPoweroff = process.argv.includes("--no-poweroff");
  try { const oldPid = Number(await readFile(nightPidPath, "utf8")); if (oldPid && oldPid !== process.pid) { process.kill(oldPid, 0); throw new Error(`night run already active: ${oldPid}`); } } catch (error) { if (String(error.message).includes("already active")) throw error; }
  await mkdir(root, { recursive: true }); await writeFile(nightPidPath, String(process.pid));
  const controller = new AbortController(); const shutdown = async () => { controller.abort(); await instance.stop(); await rm(nightPidPath, { force: true }); process.exit(0); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try {
    const supervisor = night({ deferPoweroff: true });
    const result = await supervisor.run({ deadline, signal: controller.signal });
    console.log(JSON.stringify(result, null, 2));
    if (!noPoweroff && result.shutdownState === "READY_FOR_ASUS_POWEROFF") {
      const checkpoint = { ...result, asusShutdownRequested: true, shutdownState: "ASUS_POWEROFF_REQUESTED" };
      await supervisor.persist(checkpoint);
      const power = await runPoweroff({ checkpoint });
      await supervisor.persist({ ...checkpoint, asusShutdownState: power.status, shutdownState: power.ok ? "POWEROFF_REQUESTED" : power.status, shutdownError: power.reason || null });
    }
  } finally { await rm(nightPidPath, { force: true }); }
  process.exit(0);
}
if (area === "night-run" && command === "stop") { try { const pid = Number(await readFile(nightPidPath, "utf8")); if (pid && pid !== process.pid) process.kill(pid, "SIGTERM"); } catch {} console.log(JSON.stringify(await night().status(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "status") { console.log(JSON.stringify(await instance.load(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "reconcile") { console.log(JSON.stringify(await instance.reconcile(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "intake" && project) { const packet = parseTaskPacket(await readFile(project, "utf8")); console.log(JSON.stringify(await instance.acceptTaskPacket(packet), null, 2)); process.exit(0); }
// TEMPORARY repository-file PM contract for the codex-chatgpt-web bootstrap:
// pm-intake accepts a TASK_PACKET file via the canonical validator and
// result-return reads a canonical result-inbox file with validation. No
// permanent transport dependency; remove with PM_FILE_CONTRACT when done.
if (area === "portfolio" && command === "pm-intake" && project) { console.log(JSON.stringify(await instance.acceptTaskPacketFile(project), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "result" && project) { console.log(await readFile(join(instance.resultRoot, `${project}.json`), "utf8")); process.exit(0); }
if (area === "portfolio" && command === "result-return" && project) { console.log(JSON.stringify(await instance.readResultReturn(project), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "founder-response" && project && decision) { console.log(JSON.stringify(await instance.resolveFounderGate(project, decision), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "stop") { try { const pid = Number(await readFile(pidPath, "utf8")); if (pid && pid !== process.pid) process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } const state = await instance.load(); state.service = "STOPPED"; await instance.save(state); await rm(pidPath, { force: true }); console.log("STOPPED"); process.exit(0); }
if (area === "project" && command === "run" && project) { console.log(JSON.stringify(await instance.enqueue(project), null, 2)); process.exit(0); }
if ((area === "portfolio" && command === "up") || (area === "core-v1" && ["start", "resume"].includes(command))) {
  try { const oldPid = Number(await readFile(pidPath, "utf8")); if (oldPid && oldPid !== process.pid) { process.kill(oldPid, 0); throw new Error(`portfolio runner already active: ${oldPid}`); } } catch (error) { if (String(error.message).includes("already active")) throw error; }
  await mkdir(root, { recursive: true }); await writeFile(pidPath, String(process.pid));
  const controller = new AbortController(); const shutdown = async () => { controller.abort(); await rm(pidPath, { force: true }); process.exit(0); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try { await instance.runLoop({ signal: controller.signal }); } finally { await rm(pidPath, { force: true }); }
  process.exit(0);
}
if (area === "project" && command === "retry" && project) { await instance.enqueue(project); console.log(JSON.stringify(await instance.runOnce(), null, 2)); process.exit(0); }
if (area === "project" && command === "status" && project) { const state = await instance.load(); console.log(JSON.stringify(state.tasks.filter((task) => task.projectId === project), null, 2)); process.exit(0); }
console.error("invalid command"); process.exit(2);
