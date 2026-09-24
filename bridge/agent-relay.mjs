#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCoreV1Snapshot, formatCoreV1Results, loadManifest, parseTaskPacket, PortfolioRunner } from "../src/v2/portfolio-runner/index.mjs";
import { DEFAULT_DEADLINE, finalizeNightRun, NightRunSupervisor, runPoweroff } from "../src/v2/night-run/index.mjs";

export const PID_LOCK_ACTIVE = "PID_LOCK_ACTIVE";
export const PID_LOCK_STALE = "PID_LOCK_STALE";
export const PID_LOCK_CORRUPT = "PID_LOCK_CORRUPT";
export const PID_LOCK_MISSING = "PID_LOCK_MISSING";

export function isPidLockError(error) {
  return Boolean(error && (error.code === PID_LOCK_ACTIVE || error.code === PID_LOCK_STALE || error.code === PID_LOCK_CORRUPT));
}

export function pidLockError({ pidPath, label, reason, pid, detail, cause }) {
  const target = pid === undefined || pid === null ? "unknown" : String(pid);
  const error = new Error(`${label || "pid lock"} blocked: ${pidPath}: ${reason}: pid=${target}${detail ? `:${detail}` : ""}`);
  error.code = reason;
  error.pidPath = pidPath;
  error.label = label || null;
  error.reason = reason;
  if (pid !== undefined && pid !== null) error.pid = pid;
  if (detail !== undefined) error.detail = detail;
  error.blocked = { code: reason, pidPath, label: label || null, reason, ...(pid !== undefined && pid !== null ? { pid } : {}), ...(detail !== undefined ? { detail } : {}) };
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function parsePidLock(raw) {
  const text = String(raw ?? "").trim();
  if (!/^[1-9][0-9]*$/.test(text)) return { ok: false, reason: PID_LOCK_CORRUPT, detail: text === "" ? "EMPTY_LOCK" : "MALFORMED_PID" };
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: PID_LOCK_CORRUPT, detail: "MALFORMED_PID" };
  return { ok: true, pid };
}

function probePidLiveness(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "stale";
    if (error?.code === "EPERM") return "alive";
    if (error?.code === "EINVAL") return "corrupt";
    return "alive";
  }
}

export async function checkPidLock({ pidPath, label = "pid lock", killImpl = (pid, signal) => process.kill(pid, signal), selfPid = process.pid, readImpl = null } = {}) {
  if (!pidPath) throw new Error("checkPidLock requires pidPath");
  const read = readImpl || (() => readFile(pidPath, "utf8"));
  let raw;
  try {
    raw = await read();
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, state: "AVAILABLE", reason: PID_LOCK_MISSING, pidPath, label, pid: null };
    return { ok: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: "READ_ERROR", pidPath, label, pid: null, cause: error, blocked: { code: PID_LOCK_CORRUPT, pidPath, label, reason: PID_LOCK_CORRUPT, detail: "READ_ERROR" } };
  }
  const parsed = parsePidLock(raw);
  if (!parsed.ok) return { ok: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: parsed.detail, pidPath, label, pid: null, raw: String(raw).slice(0, 64), blocked: { code: PID_LOCK_CORRUPT, pidPath, label, reason: PID_LOCK_CORRUPT, detail: parsed.detail } };
  if (parsed.pid === selfPid) return { ok: true, state: "AVAILABLE", reason: "SELF_PID", pidPath, label, pid: parsed.pid };
  const liveness = probePidLiveness(parsed.pid, killImpl);
  if (liveness === "stale") return { ok: false, state: "STALE", reason: PID_LOCK_STALE, pidPath, label, pid: parsed.pid, blocked: { code: PID_LOCK_STALE, pidPath, label, reason: PID_LOCK_STALE, pid: parsed.pid } };
  if (liveness === "corrupt") return { ok: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: "INVALID_PID", pidPath, label, pid: parsed.pid, blocked: { code: PID_LOCK_CORRUPT, pidPath, label, reason: PID_LOCK_CORRUPT, detail: "INVALID_PID" } };
  return { ok: false, state: "ACTIVE", reason: PID_LOCK_ACTIVE, pidPath, label, pid: parsed.pid, blocked: { code: PID_LOCK_ACTIVE, pidPath, label, reason: PID_LOCK_ACTIVE, pid: parsed.pid } };
}

export async function stopPidLock({ pidPath, label = "pid lock", killImpl = (pid, signal) => process.kill(pid, signal), selfPid = process.pid, readImpl = null } = {}) {
  if (!pidPath) throw new Error("stopPidLock requires pidPath");
  const read = readImpl || (() => readFile(pidPath, "utf8"));
  let raw;
  try {
    raw = await read();
  } catch (error) {
    if (error?.code === "ENOENT") return { signaled: false, state: "MISSING", reason: PID_LOCK_MISSING, pidPath, label, pid: null };
    return { signaled: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: "READ_ERROR", pidPath, label, pid: null };
  }
  const parsed = parsePidLock(raw);
  if (!parsed.ok) return { signaled: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: parsed.detail, pidPath, label, pid: null };
  if (parsed.pid === selfPid) return { signaled: false, state: "SELF", reason: "SELF_PID", pidPath, label, pid: parsed.pid };
  const liveness = probePidLiveness(parsed.pid, killImpl);
  if (liveness === "stale") return { signaled: false, state: "STALE", reason: PID_LOCK_STALE, pidPath, label, pid: parsed.pid };
  if (liveness === "corrupt") return { signaled: false, state: "CORRUPT", reason: PID_LOCK_CORRUPT, detail: "INVALID_PID", pidPath, label, pid: parsed.pid };
  try {
    killImpl(parsed.pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return { signaled: false, state: "STALE", reason: PID_LOCK_STALE, pidPath, label, pid: parsed.pid };
    return { signaled: false, state: "ACTIVE", reason: PID_LOCK_ACTIVE, pidPath, label, pid: parsed.pid, detail: error?.code || String(error?.message || error) };
  }
  return { signaled: true, state: "ACTIVE", reason: PID_LOCK_ACTIVE, pidPath, label, pid: parsed.pid };
}

// Import-time CLI execution: symlinked (`node <symlink> ...`) and
// keepalive-imported (`await import(bridge)` with CLI argv) launches must run the
// CLI as an import side effect. The old `invokedDirectly`
// (`pathToFileURL(argv[1]).href === import.meta.url`) guard stayed false for both
// shapes, so those launches silently produced empty output. Only explicit test
// opt-out (env flag or node --test runner argv) skips the CLI.
export const BRIDGE_NO_CLI_ENV = "AGENT_RELAY_BRIDGE_NO_CLI";

export function shouldRunBridgeCli({ argv = process.argv, env = process.env } = {}) {
  const flag = env[BRIDGE_NO_CLI_ENV];
  if (flag === "1" || flag === "true" || flag === "yes") return false;
  if (argv.includes("--test") || argv.includes("--experimental-test-coverage")) return false;
  return true;
}

async function runCli() {
const root = process.env.AGENT_RELAY_DATA_ROOT || join(homedir(), ".local", "share", "AgentRelay", "data", "portfolio-execution");
const founderOutbox = process.env.AGENT_RELAY_FOUNDER_OUTBOX || join(homedir(), ".local", "share", "AgentRelay", "data", "founder-outbox");
const manifestPath = process.env.AGENT_RELAY_PORTFOLIO_MANIFEST || new URL("../config/portfolio.json", import.meta.url).pathname;
const runner = () => loadManifest(manifestPath).then((manifest) => new PortfolioRunner({ manifest, statePath: join(root, "state.json"), worktreeRoot: join(root, "worktrees"), gateRoot: founderOutbox }));
const pidPath = join(root, "runner.pid");
const nightPath = join(root, "LAST_NIGHT_RUN.json");
const nightPidPath = join(root, "night-run.pid");
const [area, command, project, decision] = process.argv.slice(2);
if (!["portfolio", "project", "core-v1", "night-run"].includes(area)) { console.error("usage: agent-relay core-v1 status|results [--json]|start|resume | night-run once|up|status|stop | portfolio pm-intake|result-return|... | project ..."); process.exit(2); }
const instance = await runner();
const night = ({ deferPoweroff = false } = {}) => {
  const supervisor = new NightRunSupervisor({ runner: instance, checkpointPath: nightPath });
  if (deferPoweroff) supervisor.finalize = (record) => finalizeNightRun({ record, checkpointPath: nightPath, persist: (value) => supervisor.persist(value), deferPoweroff: true });
  return supervisor;
};
if (area === "core-v1" && command === "status") { const state = await instance.load(); console.log(formatCoreV1Results(buildCoreV1Snapshot(instance.manifest, state), process.argv.includes("--json"))); process.exit(0); }
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
  { const gate = await checkPidLock({ pidPath: nightPidPath, label: "night run" }); if (!gate.ok) throw pidLockError({ pidPath: nightPidPath, label: "night run", reason: gate.reason, pid: gate.pid ?? undefined, detail: gate.detail }); }
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
if (area === "night-run" && command === "stop") { const outcome = await stopPidLock({ pidPath: nightPidPath, label: "night run" }); if (!outcome.signaled) console.error(JSON.stringify({ pidLock: outcome })); if (outcome.state === "STALE" || outcome.state === "CORRUPT") await rm(nightPidPath, { force: true }); console.log(JSON.stringify(await night().status(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "status") { console.log(JSON.stringify(await instance.load(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "reconcile") { console.log(JSON.stringify(await instance.reconcile(), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "intake" && project) { const packet = parseTaskPacket(await readFile(project, "utf8")); console.log(JSON.stringify(await instance.acceptTaskPacket(packet), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "pm-intake" && project) { console.log(JSON.stringify(await instance.acceptTaskPacketFile(project), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "result" && project) { console.log(await readFile(join(instance.resultRoot, `${project}.json`), "utf8")); process.exit(0); }
if (area === "portfolio" && command === "result-return" && project) { console.log(JSON.stringify(await instance.readResultReturn(project), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "founder-response" && project && decision) { console.log(JSON.stringify(await instance.resolveFounderGate(project, decision), null, 2)); process.exit(0); }
if (area === "portfolio" && command === "stop") { const outcome = await stopPidLock({ pidPath: pidPath, label: "portfolio runner" }); if (!outcome.signaled) console.error(JSON.stringify({ pidLock: outcome })); const state = await instance.load(); state.service = "STOPPED"; await instance.save(state); await rm(pidPath, { force: true }); console.log("STOPPED"); process.exit(0); }
if (area === "project" && command === "run" && project) { console.log(JSON.stringify(await instance.enqueue(project), null, 2)); process.exit(0); }
if ((area === "portfolio" && command === "up") || (area === "core-v1" && ["start", "resume"].includes(command))) {
  { const gate = await checkPidLock({ pidPath: pidPath, label: "portfolio runner" }); if (!gate.ok) throw pidLockError({ pidPath: pidPath, label: "portfolio runner", reason: gate.reason, pid: gate.pid ?? undefined, detail: gate.detail }); }
  await mkdir(root, { recursive: true }); await writeFile(pidPath, String(process.pid));
  const controller = new AbortController(); const shutdown = async () => { controller.abort(); await rm(pidPath, { force: true }); process.exit(0); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  try { await instance.runLoop({ signal: controller.signal }); } finally { await rm(pidPath, { force: true }); }
  process.exit(0);
}
if (area === "project" && command === "retry" && project) { await instance.enqueue(project); console.log(JSON.stringify(await instance.runOnce(), null, 2)); process.exit(0); }
if (area === "project" && command === "status" && project) { const state = await instance.load(); console.log(JSON.stringify(state.tasks.filter((task) => task.projectId === project), null, 2)); process.exit(0); }
console.error("invalid command"); process.exit(2);
}

if (shouldRunBridgeCli()) await runCli();
