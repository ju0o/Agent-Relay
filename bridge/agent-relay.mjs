#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadManifest, PortfolioRunner } from "../src/v2/portfolio-runner/index.mjs";

const root = process.env.AGENT_RELAY_DATA_ROOT || join(homedir(), ".local", "share", "AgentRelay", "data", "portfolio-execution");
const founderOutbox = process.env.AGENT_RELAY_FOUNDER_OUTBOX || join(homedir(), ".local", "share", "AgentRelay", "data", "founder-outbox");
const manifestPath = process.env.AGENT_RELAY_PORTFOLIO_MANIFEST || new URL("../config/portfolio.json", import.meta.url).pathname;
const runner = () => loadManifest(manifestPath).then((manifest) => new PortfolioRunner({ manifest, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), gateRoot: founderOutbox }));
const pidPath = join(root, "runner.pid");
const [area, command, project] = process.argv.slice(2);
if (area !== "portfolio" && area !== "project") { console.error("usage: agent-relay portfolio up|status|reconcile|stop | project run <projectId>"); process.exit(2); }
const instance = await runner();
if (area === "portfolio" && command === "status") { console.log(JSON.stringify(await instance.load(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "reconcile") { console.log(JSON.stringify(await instance.reconcile(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "stop") { try { const pid = Number(await readFile(pidPath, "utf8")); if (pid && pid !== process.pid) process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } const state = await instance.load(); state.service = "STOPPED"; await instance.save(state); await rm(pidPath, { force: true }); console.log("STOPPED"); process.exit(0); }
if (area === "project" && command === "run" && project) { console.log(JSON.stringify(await instance.enqueue(project), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "up") {
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
