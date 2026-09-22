#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadManifest, PortfolioRunner } from "../src/v2/portfolio-runner/index.mjs";
import { CoreV1Team } from "../src/v2/core-v1/index.mjs";

const root = process.env.AGENT_RELAY_DATA_ROOT || join(homedir(), ".local", "share", "AgentRelay", "data", "portfolio-execution");
const founderOutbox = process.env.AGENT_RELAY_FOUNDER_OUTBOX || join(homedir(), ".local", "share", "AgentRelay", "data", "founder-outbox");
const manifestPath = process.env.AGENT_RELAY_PORTFOLIO_MANIFEST || new URL("../config/portfolio.json", import.meta.url).pathname;
const selfRepoPath = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const portfolioPidPath = join(root, "runner.pid");
const coreV1PidPath = join(root, "core-v1-runner.pid");

const createRunner = async () => {
  const manifest = await loadManifest(manifestPath);
  manifest.projects = manifest.projects.map((project) => ({
    ...project,
    path: project.path === "$AGENT_RELAY_REPO" ? selfRepoPath : project.path,
  }));
  const runner = new PortfolioRunner({
    manifest,
    statePath: join(root, "state.json"),
    worktreeRoot: join(root, "worktrees"),
    gateRoot: founderOutbox,
  });
  return { manifest, runner };
};

const createCoreV1 = async () => {
  const { manifest, runner } = await createRunner();
  const team = new CoreV1Team({
    runner,
    manifest,
    snapshotPath: join(root, "core-v1", "latest.json"),
  });
  return { manifest, runner, team };
};

async function ensureSingleRunner(pidPath, label) {
  try {
    const oldPid = Number(await readFile(pidPath, "utf8"));
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, 0);
      throw new Error(`${label} already active: ${oldPid}`);
    }
  } catch (error) {
    if (String(error.message).includes("already active")) throw error;
  }

  await mkdir(root, { recursive: true });
  await writeFile(pidPath, String(process.pid));
}

async function stopRunner(pidPath, runner) {
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (pid && pid !== process.pid) process.kill(pid, "SIGTERM");
  } catch {
    // already stopped
  }

  const state = await runner.load();
  state.service = "STOPPED";
  await runner.save(state);
  await rm(pidPath, { force: true });
}

const args = process.argv.slice(2);
const [area, command, arg1, arg2] = args;

if (!["portfolio", "project", "core-v1"].includes(area)) {
  console.error("usage: agent-relay core-v1 up|status|results|once|reconcile|stop | portfolio up|status|reconcile|stop | project run|retry|status <projectId>");
  process.exit(2);
}

if (area === "core-v1") {
  const { runner, team } = await createCoreV1();

  if (command === "status") {
    console.log(JSON.stringify(await team.status(), null, 2));
    process.exit(0);
  }

  if (command === "results") {
    const json = args.includes("--json");
    console.log(await team.results({ json }));
    process.exit(0);
  }

  if (command === "reconcile") {
    await runner.reconcile();
    console.log(JSON.stringify(await team.status(), null, 2));
    process.exit(0);
  }

  if (command === "once") {
    console.log(JSON.stringify(await team.runOnce(), null, 2));
    process.exit(0);
  }

  if (command === "stop") {
    await stopRunner(coreV1PidPath, runner);
    console.log("CORE_V1_STOPPED");
    process.exit(0);
  }

  if (command === "up" || command === "start") {
    await ensureSingleRunner(coreV1PidPath, "core-v1 runner");
    const controller = new AbortController();
    const shutdown = async () => {
      controller.abort();
      await rm(coreV1PidPath, { force: true });
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    try {
      await team.runLoop({ signal: controller.signal });
    } finally {
      await rm(coreV1PidPath, { force: true });
    }
    process.exit(0);
  }

  console.error("invalid core-v1 command");
  process.exit(2);
}

const { runner: instance } = await createRunner();

if (area === "portfolio" && command === "status") {
  console.log(JSON.stringify(await instance.load(), null, 2));
  process.exit(0);
}
if (area === "portfolio" && command === "reconcile") {
  console.log(JSON.stringify(await instance.reconcile(), null, 2));
  process.exit(0);
}
if (area === "portfolio" && command === "founder-response" && arg1 && arg2) {
  console.log(JSON.stringify(await instance.resolveFounderGate(arg1, arg2), null, 2));
  process.exit(0);
}
if (area === "portfolio" && command === "stop") {
  await stopRunner(portfolioPidPath, instance);
  console.log("STOPPED");
  process.exit(0);
}
if (area === "project" && command === "run" && arg1) {
  console.log(JSON.stringify(await instance.enqueue(arg1), null, 2));
  process.exit(0);
}
if (area === "portfolio" && command === "up") {
  await ensureSingleRunner(portfolioPidPath, "portfolio runner");
  const controller = new AbortController();
  const shutdown = async () => {
    controller.abort();
    await rm(portfolioPidPath, { force: true });
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await instance.runLoop({ signal: controller.signal });
  } finally {
    await rm(portfolioPidPath, { force: true });
  }
  process.exit(0);
}
if (area === "project" && command === "retry" && arg1) {
  await instance.enqueue(arg1);
  console.log(JSON.stringify(await instance.runOnce(), null, 2));
  process.exit(0);
}
if (area === "project" && command === "status" && arg1) {
  const state = await instance.load();
  console.log(JSON.stringify(state.tasks.filter((task) => task.projectId === arg1), null, 2));
  process.exit(0);
}

console.error("invalid command");
process.exit(2);
