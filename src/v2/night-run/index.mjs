"use strict";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const DEFAULT_TIMEZONE = "Asia/Seoul";
export const DEFAULT_DEADLINE = "03:00";
export const DEFAULT_SEND_TO_MAINPC = "/home/skkse12/.agents/skills/send-to-mainpc/scripts/send-to-mainpc.sh";
const TERMINAL = new Set(["COMPLETE", "V1_COMPLETE", "HOLD", "FOUNDER_GATE", "BLOCKED_SCOPE"]);
const COMPLETE_REASONS = new Set(["WBS_EXHAUSTED", "DEADLINE_COMPLETE"]);

export function deadlineAt(now, value = DEFAULT_DEADLINE, timezone = DEFAULT_TIMEZONE) {
  if (timezone !== DEFAULT_TIMEZONE || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`invalid deadline/timezone: ${value}/${timezone}`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
  const [hour, minute] = value.split(":").map(Number);
  const today = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour - 9, minute);
  const result = new Date(today);
  return result >= now ? result : new Date(today + 86_400_000);
}

export function laneExhausted(project, state, definitions = []) {
  const tasks = (state.tasks || []).filter((task) => task.projectId === project.id);
  const pending = tasks.some((task) => ["QUEUED", "RUNNING", "QA", "REQUEST_CHANGES"].includes(task.state));
  const remaining = definitions.some((definition) => !tasks.some((task) => task.taskId === definition.taskId && task.state === "VERIFIED_DONE"));
  return !pending && (!remaining || ["HOLD", "FOUNDER_GATE", "BLOCKED_SCOPE"].includes(project.state)) && TERMINAL.has(project.state || "");
}

export function evaluateExhaustion(manifest, state) {
  const lanes = manifest.projects.filter((project) => project.active !== false && project.coreV1 !== false).map((project) => ({ project: project.id, exhausted: laneExhausted(state.projects?.find((item) => item.id === project.id) || project, state, project.tasks || (project.task ? [project.task] : [])) }));
  return { complete: lanes.every((lane) => lane.exhausted), lanes };
}

export function readCompletion(value) {
  const required = ["runId", "startedAt", "deadline", "freezeAt", "checkpointAt", "endedAt", "endReason", "shutdownState"];
  if (!value || value.schema !== "agent-relay.last-night-run.v1" || required.some((field) => !value[field]) || !Array.isArray(value.lanes) || !COMPLETE_REASONS.has(value.endReason)) return { ok: false, reason: "UNKNOWN_NIGHT_RUN" };
  return { ok: true, reason: value.endReason, resumeRequired: Boolean(value.resumeRequired) };
}

export function runPoweroff({ checkpoint, command = "sudo", args = ["-n", "/usr/sbin/poweroff"] }) {
  const gate = readCompletion(checkpoint);
  if (!gate.ok) return Promise.resolve({ ok: false, status: "REFUSED", reason: gate.reason });
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ ok: false, status: "SHUTDOWN_PERMISSION_REQUIRED", reason: error.message }));
    child.once("close", (code) => resolve(code === 0 ? { ok: true, status: "POWEROFF_REQUESTED" } : { ok: false, status: "SHUTDOWN_PERMISSION_REQUIRED", reason: stderr.trim() || `exit ${code}` }));
  });
}

export async function drainManaged(entries = [], { graceMs = 1_000, sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)) } = {}) {
  const owned = entries.filter((entry) => entry?.managed === true && entry.owner === "agent-relay");
  await Promise.all(owned.map((entry) => entry.stop?.()));
  await sleep(graceMs);
  await Promise.all(owned.map((entry) => entry.kill?.()));
  return owned.map((entry) => entry.id);
}

export function mainPcTarget(env = process.env) {
  return env.MAINPC_SSH_TARGET || env.MAINPC_SSH_ALIAS || (env.MAINPC_SSH_USER && env.MAINPC_SSH_HOST ? `${env.MAINPC_SSH_USER}@${env.MAINPC_SSH_HOST}` : "mainpc");
}

export function seoulDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export function buildNightReport(record) {
  const lanes = (record.lanes || []).map((lane) => `- ${lane.id || lane.project}: state=${lane.state || "UNKNOWN"}, blocker=${lane.blockers?.[0] || lane.blocker || "-"}`).join("\n") || "- none";
  const unfinished = (record.unfinishedTasks || []).map((task) => `- ${task.project}/${task.taskId}: worker=${task.workerState || "-"}, QA=${task.qaState || "-"}, worktree=${task.worktree || "-"}, resume=${task.resumeRequired ? "yes" : "no"}`).join("\n") || "- none";
  return [`# Night Report ${seoulDate(new Date(record.startedAt))}`, "", `- runId: ${record.runId}`, `- start: ${record.startedAt}`, `- end: ${record.endedAt || "-"}`, `- endReason: ${record.endReason}`, `- deadline: ${record.deadline}`, `- shutdownState: ${record.shutdownState}`, "", "## Completed projects / lanes", lanes, "", "## Completed WBS / task", `- ${record.taskId || "-"}`, `- promotion: ${record.promotionRef || record.commitSha || "-"}`, "", "## Retry / QA", `- QA: ${record.qaState || "-"}`, `- attempts: ${record.attempts || 0}`, "", "## Unfinished tasks", unfinished, "", "## Founder Gate", `- ${record.founderGate || "none"}`, "", "## Blockers / next WBS", `- blocker: ${record.blocker || "-"}`, `- next: ${record.next || "-"}`, `- checkpoint: ${record.checkpointPath || "-"}`, "", "## Shutdown", `- reportPathAsus: ${record.reportPathAsus || "-"}`, `- reportTransferState: ${record.reportTransferState || "-"}`, `- reportPathMainPC: ${record.reportPathMainPC || "-"}`, `- mainPcShutdownRequested: ${record.mainPcShutdownRequested ? "yes" : "no"}`, `- asusShutdownRequested: ${record.asusShutdownRequested ? "yes" : "no"}`, ""].join("\n");
}

export async function sendReportToMainPc({ reportPath, target = mainPcTarget(), scriptPath = process.env.AGENT_RELAY_SEND_TO_MAINPC || DEFAULT_SEND_TO_MAINPC, execFileImpl = execFile }) {
  const localSha = createHash("sha256").update(await readFile(reportPath)).digest("hex");
  const result = await execFileImpl(scriptPath, [reportPath, target], { env: process.env });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const remoteSha = output.match(/SHA256:\s*([0-9a-f]{64})/i)?.[1]?.toLowerCase();
  if (!output.includes("SENT:") || remoteSha !== localSha) throw new Error(`REPORT_TRANSFER_FAILED: expected ${localSha}, got ${remoteSha || "none"}`);
  return { state: "DELIVERED", target, remoteSha, output: output.trim(), path: output.match(/SENT:\s*(\S+)/)?.[1] || null };
}

export async function requestMainPcShutdown({ target = mainPcTarget(), execFileImpl = execFile }) {
  const result = await execFileImpl("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, "shutdown.exe /s /t 30"], { env: process.env });
  return { state: "REQUESTED", target, command: "shutdown.exe /s /t 30", at: new Date().toISOString(), output: String(result.stdout || "").trim() };
}

export async function finalizeNightRun({ record: initial, checkpointPath, persist, send = sendReportToMainPc, requestShutdown = requestMainPcShutdown, poweroff = runPoweroff, reportPath, dryRun = false, deferPoweroff = false }) {
  let record = { ...initial, checkpointPath, shutdownState: "REPORTING", reportPathAsus: reportPath || `${dirname(checkpointPath)}/NIGHT_REPORT_${seoulDate(new Date(initial.startedAt))}.md`, reportPathMainPC: null, reportTransferState: "PENDING", mainPcShutdownRequested: false, mainPcShutdownAt: null, asusShutdownRequested: false, unfinishedTasks: initial.unfinishedTasks || [] };
  await mkdir(dirname(record.reportPathAsus), { recursive: true });
  await writeFile(record.reportPathAsus, buildNightReport(record));
  try { const transfer = dryRun ? { state: "DRY_RUN", path: `MainPC/Desktop/${record.reportPathAsus.split("/").pop()}`, remoteSha: createHash("sha256").update(await readFile(record.reportPathAsus)).digest("hex") } : await send({ reportPath: record.reportPathAsus }); record = { ...record, reportTransferState: transfer.state, reportPathMainPC: transfer.path || null, reportTransferSha256: transfer.remoteSha || null }; }
  catch (error) { record = { ...record, reportTransferState: "REPORT_TRANSFER_FAILED", reportTransferError: String(error.message || error) }; }
  await persist(record);
  try { const shutdown = dryRun ? { state: "DRY_RUN", command: "shutdown.exe /s /t 30", at: new Date().toISOString() } : await requestShutdown(); record = { ...record, mainPcShutdownRequested: shutdown.state === "REQUESTED" || shutdown.state === "DRY_RUN", mainPcShutdownAt: shutdown.at, mainPcShutdownState: shutdown.state }; }
  catch (error) { record = { ...record, mainPcShutdownState: "FAILED", mainPcShutdownError: String(error.message || error) }; }
  await persist(record);
  if (dryRun || deferPoweroff) return persist({ ...record, shutdownState: dryRun ? "DRY_RUN_COMPLETE" : "READY_FOR_ASUS_POWEROFF", asusShutdownRequested: false });
  record = { ...record, asusShutdownRequested: true, shutdownState: "ASUS_POWEROFF_REQUESTED" }; await persist(record);
  const asus = await poweroff({ checkpoint: record });
  return persist({ ...record, asusShutdownState: asus.status, shutdownState: asus.ok ? "POWEROFF_REQUESTED" : asus.status });
}

function currentTask(state) {
  return (state.tasks || []).find((task) => !["VERIFIED_DONE"].includes(task.state)) || (state.tasks || []).at(-1) || null;
}

function record({ runId, startedAt, deadline, freezeAt, checkpointAt, endedAt = null, endReason, shutdownState = "NOT_REQUESTED", state, resumeRequired }) {
  const task = currentTask(state);
  return {
    schema: "agent-relay.last-night-run.v1", runId, startedAt, deadline, freezeAt, checkpointAt, endedAt, endReason, shutdownState,
    project: task?.projectId || null, taskId: task?.taskId || null,
    pmState: state.projects?.find((project) => project.id === task?.projectId)?.state || null,
    runtime: state.projects?.find((project) => project.id === task?.projectId)?.runtime || null,
    workerState: task?.state || null, qaState: task?.qa?.verdict || null,
    attempts: task?.attempts || 0, worktree: task?.builderEvidence?.workspace || null,
    commitSha: task?.result?.commitSha || null, promotionRef: task?.promotionRef || null,
    blocker: task?.error || task?.blocker || null, resumeRequired,
    lanes: state.projects || [], updatedAt: new Date().toISOString(),
  };
}

export class NightRunSupervisor {
  constructor({ runner, checkpointPath, clock = () => new Date(), sleep = (ms) => new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, ms); timer.unref?.(); }), runId = `night-${Date.now()}`, finalize = null }) {
    this.runner = runner; this.checkpointPath = checkpointPath; this.clock = clock; this.sleep = sleep; this.runId = runId; this.finalize = finalize;
  }

  async persist(value) {
    await mkdir(dirname(this.checkpointPath), { recursive: true });
    const temp = `${this.checkpointPath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, this.checkpointPath);
    return value;
  }

  async status() { try { return JSON.parse(await readFile(this.checkpointPath, "utf8")); } catch { return null; } }

  async once({ deadline = DEFAULT_DEADLINE } = {}) {
    const started = this.clock();
    let state = await this.runner.reconcile();
    const cutoff = deadlineAt(started, deadline);
    const times = { deadline: cutoff.toISOString(), freezeAt: new Date(cutoff - 5 * 60_000).toISOString(), checkpointAt: new Date(cutoff - 2 * 60_000).toISOString() };
    if (started >= cutoff) return this.persist(record({ runId: this.runId, startedAt: started.toISOString(), ...times, endedAt: started.toISOString(), endReason: "DEADLINE_COMPLETE", shutdownState: "DRAIN_REQUIRED", state, resumeRequired: true }));
    if (evaluateExhaustion(this.runner.manifest, state).complete) return this.persist(record({ runId: this.runId, startedAt: started.toISOString(), ...times, endedAt: started.toISOString(), endReason: "WBS_EXHAUSTED", shutdownState: "DRAIN_REQUIRED", state, resumeRequired: false }));
    state = await this.runner.runOnce();
    const complete = evaluateExhaustion(this.runner.manifest, state).complete;
    return this.persist(record({ runId: this.runId, startedAt: started.toISOString(), ...times, endedAt: complete ? this.clock().toISOString() : null, endReason: complete ? "WBS_EXHAUSTED" : "RUNNING", shutdownState: complete ? "DRAIN_REQUIRED" : "NOT_REQUESTED", state, resumeRequired: !complete }));
  }

  async run({ deadline = DEFAULT_DEADLINE, intervalMs = 15_000, signal } = {}) {
    const started = this.clock();
    const cutoff = deadlineAt(started, deadline);
    const freezeAt = new Date(cutoff - 5 * 60_000);
    const checkpointAt = new Date(cutoff - 2 * 60_000);
    const drainAt = new Date(cutoff - 60_000);
    let state = await this.runner.reconcile();
    const write = (endReason, endedAt = null, shutdownState = "NOT_REQUESTED", resumeRequired = true) => this.persist(record({ runId: this.runId, startedAt: started.toISOString(), deadline: cutoff.toISOString(), freezeAt: freezeAt.toISOString(), checkpointAt: checkpointAt.toISOString(), endedAt, endReason, shutdownState, state, resumeRequired }));
    const finish = async (reason, resumeRequired) => { await this.runner.stop?.(); state = await this.runner.load(); const result = await write(reason, this.clock().toISOString(), "FINALIZING", resumeRequired); return this.finalize ? this.finalize(result) : result; };
    const drain = async () => { await this.runner.stop?.(); while (this.clock() < drainAt && !signal?.aborted) await this.sleep(Math.max(1, drainAt - this.clock())); };
    if (evaluateExhaustion(this.runner.manifest, state).complete) return finish("WBS_EXHAUSTED", false);
    while (!signal?.aborted) {
      const now = this.clock();
      if (now >= cutoff) return finish("DEADLINE_COMPLETE", true);
      if (now >= checkpointAt) {
        state = await this.runner.load(); await write("CHECKPOINTED_DEADLINE", null, "CHECKPOINT_REQUIRED", true);
        await drain();
        return finish("DEADLINE_COMPLETE", true);
      }
      if (now >= freezeAt) {
        state = await this.runner.load();
        if (evaluateExhaustion(this.runner.manifest, state).complete) return finish("WBS_EXHAUSTED", false);
        await this.sleep(Math.min(intervalMs, Math.max(1, checkpointAt - now)));
        continue;
      }
      const childSignal = new AbortController();
      const abort = () => childSignal.abort(); signal?.addEventListener("abort", abort, { once: true });
      let completed = false;
      const work = this.runner.runOnce({ signal: childSignal.signal }).then((value) => { completed = true; return value; });
      const untilCheckpoint = this.sleep(Math.max(1, checkpointAt - now)).then(() => null);
      state = (await Promise.race([work, untilCheckpoint])) || state;
      signal?.removeEventListener("abort", abort);
      if (!completed) { childSignal.abort(); state = await this.runner.load(); await write("CHECKPOINTED_DEADLINE", null, "CHECKPOINT_REQUIRED", true); await drain(); return finish("DEADLINE_COMPLETE", true); }
      if (evaluateExhaustion(this.runner.manifest, state).complete) return finish("WBS_EXHAUSTED", false);
      await this.sleep(intervalMs);
    }
    await this.runner.stop?.(); state = await this.runner.load(); return write("STOPPED", this.clock().toISOString(), "DRAINED", true);
  }
}
