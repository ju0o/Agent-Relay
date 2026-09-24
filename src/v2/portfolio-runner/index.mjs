"use strict";

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { FounderGateManager } from "../portfolio-jit/index.mjs";
import { createRuntimeAdapters } from "../runtime-adapters/index.mjs";

export const STATES = Object.freeze(["QUEUED", "RUNNING", "QA", "REQUEST_CHANGES", "VERIFIED_DONE", "V1_COMPLETE", "HOLD", "BLOCKED_SCOPE", "BLOCKED_WORKTREE", "BLOCKED_TARGET", "BLOCKED_SSOT_CONFLICT", "BLOCKED_RUNTIME_ADAPTER", "BLOCKED_SECRET", "BLOCKED_PAYMENT", "BLOCKED_EXTERNAL", "FOUNDER_GATE", "INTEGRATION_TARGET"]);
export const QA_VERDICTS = Object.freeze(["ACCEPT", "REQUEST_CHANGES", "FOUNDER_GATE"]);
export const LIFECYCLE_EVENT_TYPES = Object.freeze(["TASK_DISPATCHED", "WORKER_RESULT", "QA_VERDICT", "TASK_RETRY", "TASK_FAILED", "TASK_COMPLETED"]);
export const MAX_LIFECYCLE_EVENTS = 500;

function truncateLifecycleText(value, limit = 300) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function recordLifecycleEvent(state, event) {
  if (!state || typeof state !== "object" || !event || typeof event !== "object") return null;
  if (!Array.isArray(state.events)) state.events = [];
  const entry = { at: new Date().toISOString(), ...event };
  if (typeof entry.type !== "string" || !LIFECYCLE_EVENT_TYPES.includes(entry.type)) throw new Error(`invalid lifecycle event type: ${entry.type}`);
  if (typeof entry.taskId !== "string" || !entry.taskId) throw new Error("lifecycle event requires taskId");
  for (const key of ["reason", "error", "verdict", "status", "state"]) {
    if (typeof entry[key] === "string" && entry[key].length > 300) entry[key] = truncateLifecycleText(entry[key]);
  }
  state.events.push(entry);
  if (state.events.length > MAX_LIFECYCLE_EVENTS) state.events.splice(0, state.events.length - MAX_LIFECYCLE_EVENTS);
  return entry;
}

export function lastLifecycleEvent(state, taskId) {
  const events = Array.isArray(state?.events) ? state.events : [];
  const scoped = taskId ? events.filter((event) => event.taskId === taskId) : events;
  return scoped.at(-1) || null;
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function isValidLifecycleEvent(event) {
  return Boolean(event && typeof event === "object" && !Array.isArray(event)
    && typeof event.type === "string" && LIFECYCLE_EVENT_TYPES.includes(event.type)
    && typeof event.taskId === "string" && event.taskId.length > 0);
}

const OPTIONAL_STATE_ARRAYS = Object.freeze(["activeBuilders", "activeQa", "founderDecisions", "resolvedFounderGates"]);

export const PORTFOLIO_STATE_CORRUPT = "PORTFOLIO_STATE_CORRUPT";

export function isCorruptStateError(error) {
  return Boolean(error && error.code === PORTFOLIO_STATE_CORRUPT);
}

export function corruptStateError({ statePath, reason, cause }) {
  const error = new Error(`portfolio state corrupt: ${statePath}: ${reason}`);
  error.code = PORTFOLIO_STATE_CORRUPT;
  error.statePath = statePath;
  error.reason = reason;
  error.blocked = { code: PORTFOLIO_STATE_CORRUPT, statePath, reason };
  if (cause !== undefined) error.cause = cause;
  return error;
}

function freshPortfolioState() {
  return { schema: "agent-relay.portfolio-state.v1", service: "STOPPED", tasks: [], activeBuilders: [], activeQa: [], events: [], updatedAt: new Date().toISOString() };
}

let atomicCounter = 0;

async function writeFileAtomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.${atomicCounter++}.tmp`;
  await writeFile(temp, contents);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function packetLine(text, prefix) {
  const line = String(text).split(/\r?\n/).reverse().find((item) => item.trim().startsWith(prefix));
  if (!line) return null;
  try { return JSON.parse(line.trim().slice(prefix.length).trim()); } catch { return null; }
}

function definitions(project) { return project?.tasks || (project?.task ? [project.task] : []); }

function nextDefinition(project, state) {
  return definitions(project).find((definition) => !state.tasks.some((task) => task.projectId === project.id && task.taskId === definition.taskId && task.state === "VERIFIED_DONE"));
}

export function buildCoreV1Snapshot(manifest, state) {
  const lanes = manifest.projects.filter((project) => project.coreV1 !== false).map((project) => {
    const tasks = state.tasks.filter((task) => task.projectId === project.id);
    const task = tasks.find((candidate) => candidate.state !== "VERIFIED_DONE" && candidate.state !== "V1_COMPLETE") || tasks.at(-1) || null;
    const next = nextDefinition(project, state);
    const lifecycleEvents = (Array.isArray(state.events) ? state.events : []).filter((event) => event.projectId === project.id);
    return {
      project: project.id,
      pm: { channel: project.pmChannel || `pm/${project.id}`, state: project.pmState || project.state || "UNKNOWN" },
      currentTask: task?.taskId || next?.taskId || null,
      worker: { runtime: project.runtime || project.owner || null, state: task?.state || project.state || "IDLE", pid: ["RUNNING", "QA"].includes(task?.state) ? task?.builderEvidence?.pid || null : null },
      result: task?.result || null,
      qa: { runtime: project.qaRuntime || "codex", verdict: task?.qa?.verdict || null, pid: task?.qaEvidence?.pid || null },
      retries: Math.max(0, (task?.attempts || 0) - 1),
      next: task?.state === "VERIFIED_DONE" ? next?.taskId || null : null,
      blocker: task?.error || task?.blocker || project.blockers?.[0] || null,
      founderGate: project.gateId ? { gateId: project.gateId, packet: project.gatePacket || null } : null,
      lifecycleEventCount: lifecycleEvents.length,
      latestLifecycleEvent: lifecycleEvents.at(-1) || null,
    };
  });
  return { schema: "agent-relay.core-v1.inbox.v1", program: "CORE_V1", service: state.service || "UNKNOWN", updatedAt: state.updatedAt || null, lanes };
}

export function formatCoreV1Text(snapshot) {
  const lines = [`CORE_V1 ${snapshot.service} · ${snapshot.updatedAt || "no timestamp"}`];
  for (const lane of snapshot.lanes) lines.push(`${lane.project} | PM=${lane.pm.state} ${lane.pm.channel} | task=${lane.currentTask || "-"} | worker=${lane.worker.runtime}/${lane.worker.state}${lane.worker.pid ? `#${lane.worker.pid}` : ""} | result=${lane.result?.status || "-"} | QA=${lane.qa.verdict || "-"} | retries=${lane.retries} | next=${lane.next || "-"} | lifecycle=${lane.lifecycleEventCount} latest=${lane.latestLifecycleEvent?.type || "-"} | blocker=${lane.blocker || "-"}${lane.founderGate ? ` | FOUNDER_GATE=${lane.founderGate.gateId}` : ""}`);
  return lines.join("\n");
}

export function formatCoreV1Results(snapshot, json = false) {
  return json ? JSON.stringify(snapshot, null, 2) : formatCoreV1Text(snapshot);
}

export function parseResultPacket(text) {
  const packet = packetLine(text, "RESULT_PACKET:");
  if (!packet || packet.schema !== "agent-relay.result.v1" || !packet.taskId || !["IMPLEMENTED", "BLOCKED"].includes(packet.status) || !Array.isArray(packet.changedFiles) || !Array.isArray(packet.tests)) throw new Error("invalid RESULT_PACKET");
  return packet;
}

export function parseTaskPacket(text) {
  const packet = packetLine(text, "TASK_PACKET:");
  if (!packet || packet.schema !== "agent-relay.task.v1" || !packet.taskId || !packet.projectId || !packet.scope || !Array.isArray(packet.files) || !Array.isArray(packet.tests)) throw new Error("invalid TASK_PACKET");
  return packet;
}

export function parseQaPacket(text) {
  const packet = packetLine(text, "QA_PACKET:");
  if (!packet || packet.schema !== "agent-relay.qa.v1" || !packet.taskId || !QA_VERDICTS.includes(packet.verdict) || !Array.isArray(packet.tests)) throw new Error("invalid QA_PACKET");
  return packet;
}

export const PM_FILE_CONTRACT = Object.freeze({
  status: "TEMPORARY_BOOTSTRAP",
  transport: "repository-file",
  bootstrap: "codex-chatgpt-web",
  intakeDir: "pm-inbox",
  resultDir: "result-outbox",
});

export function parseResultReturn(text) {
  let parsed;
  try { parsed = JSON.parse(String(text)); } catch { throw new Error("invalid RESULT_RETURN"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.schema !== "agent-relay.result-return.v1"
    || typeof parsed.taskId !== "string" || !parsed.taskId
    || typeof parsed.state !== "string" || !STATES.includes(parsed.state)) throw new Error("invalid RESULT_RETURN");
  const result = parseResultPacket(`RESULT_PACKET: ${JSON.stringify(parsed.result)}`);
  if (result.taskId !== parsed.taskId) throw new Error("invalid RESULT_RETURN");
  let qa = null;
  if (parsed.qa !== null && parsed.qa !== undefined) {
    qa = parseQaPacket(`QA_PACKET: ${JSON.stringify(parsed.qa)}`);
    if (qa.taskId !== parsed.taskId) throw new Error("invalid RESULT_RETURN");
  }
  return { ...parsed, result, qa };
}

export async function readTaskPacketFile(path) {
  return parseTaskPacket(await readFile(path, "utf8"));
}

export async function readResultReturnFile(path) {
  return parseResultReturn(await readFile(path, "utf8"));
}

function exec(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolvePromise({ code, signal, stdout, stderr, pid: child.pid }) : reject(Object.assign(new Error(stderr.trim() || `${command} exit ${code}`), { code, signal, stdout, stderr, pid: child.pid })));
  });
}

export class WorktreeManager {
  constructor(root) { this.root = root; }

  async create(project, taskId) {
    if (!project?.path || !existsSync(project.path)) throw new Error(`target unavailable: ${project?.id || "unknown"}`);
    const remote = project.repository ? (await exec("git", ["-C", project.path, "remote", "get-url", "origin"])).stdout.trim().replace(/\.git$/, "") : null;
    if (project.repository && remote !== project.repository.replace(/\.git$/, "")) throw new Error(`target repository mismatch: ${project.id}`);
    let base;
    try { base = (await exec("git", ["-C", project.path, "rev-parse", project.ref || "HEAD"])).stdout.trim(); }
    catch { base = (await exec("git", ["-C", project.path, "rev-parse", `refs/remotes/origin/${project.ref}`])).stdout.trim(); }
    if (project.expectedHeadSha && base !== project.expectedHeadSha) throw new Error(`target SHA mismatch: ${project.id}`);
    const name = `${project.id}-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const path = join(this.root, name);
    await mkdir(this.root, { recursive: true });
    await exec("git", ["-C", project.path, "worktree", "add", "--detach", path, base]);
    return { path, base, projectId: project.id, async cleanup() { await exec("git", ["-C", project.path, "worktree", "remove", "--force", path]).catch(() => {}); await rm(path, { recursive: true, force: true }); } };
  }

  async promote(project, taskId, commitSha) {
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error(`invalid promotion commit: ${taskId}`);
    const ref = `refs/agent-relay/promotions/${taskId}`;
    await exec("git", ["-C", project.path, "cat-file", "-e", `${commitSha}^{commit}`]);
    await exec("git", ["-C", project.path, "update-ref", ref, commitSha]);
    return ref;
  }
}

export class CodexDevelopmentRuntime {
  constructor({ command = process.env.CODEX_BIN || "codex", timeoutMs = 30 * 60_000 } = {}) { this.command = command; this.timeoutMs = timeoutMs; this.children = new Set(); }

  async run({ workspace, prompt, sandbox, signal }) {
    const output = join(workspace, `.agent-relay-${sandbox}-output.txt`);
    const args = ["exec", "--ephemeral", ...(sandbox === "workspace-write" ? ["--approve-for-me"] : ["--sandbox", sandbox]), "--skip-git-repo-check", "--cd", workspace, "--json", "-o", output, "-"];
    const child = spawn(this.command, args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child);
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    const startedAt = new Date().toISOString();
    child.stdin.end(prompt);
    const abort = () => child.kill("SIGTERM"); signal?.addEventListener("abort", abort, { once: true });
    const exit = await new Promise((resolvePromise, reject) => { const timer = setTimeout(() => child.kill("SIGTERM"), this.timeoutMs); child.once("error", reject); child.once("close", (code, exitSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolvePromise({ code, signal: exitSignal }); }); });
    this.children.delete(child);
    const text = existsSync(output) ? await readFile(output, "utf8") : "";
    await unlink(output).catch(() => {});
    if (exit.code !== 0) throw new Error(`Codex ${sandbox} exit ${exit.code}: ${stderr.trim() || stdout.trim()}`);
    if (!text.trim()) throw new Error(`Codex ${sandbox} produced no packet`);
    return { pid: child.pid, startedAt, ...exit, text };
  }
  async stop({ graceMs = 1_000 } = {}) {
    const children = [...this.children];
    for (const child of children) child.kill("SIGTERM");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, graceMs));
    for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
    this.children.clear();
  }
}

export function builderPrompt(task) {
  const mode = task.verificationOnly ? "Do not modify files or commit; verify the existing implementation only." : "Implement the bounded task and commit locally.";
  return `You are the Agent Relay Builder. Execute ONLY this repository-backed authorized task. Do not widen scope, ask the Founder routine questions, touch other repositories, or push.\nTASK_PACKET: ${JSON.stringify({ schema: "agent-relay.task.v1", taskId: task.taskId, projectId: task.projectId, scope: task.scope, files: task.files, tests: task.tests, verificationOnly: Boolean(task.verificationOnly) })}\nRead the repository SSOT first. ${mode} Run the listed tests. End with exactly one line: RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: task.taskId, status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "<git-sha>", summary: "<summary>" })}`;
}

export function qaPrompt(task, base) {
  return `You are an independent read-only QA Agent. Do not modify files, commit, or push. Verify task ${task.taskId} by inspecting git diff ${base}..HEAD (the supplied base is the parent, not the candidate commit), then run relevant read-only-safe checks. If a test is blocked only because the read-only sandbox forbids temporary writes, report that as an environment limitation and continue with static/type checks; do not request changes for EROFS alone. Validate scope. End with exactly one line: QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: task.taskId, verdict: "ACCEPT", tests: [], findings: [], summary: "<evidence>" })}`;
}

export class PortfolioRunner {
  constructor({ manifest, statePath, worktreeRoot, gateRoot, intakeRoot, resultRoot, runtime = new CodexDevelopmentRuntime(), runtimeAdapters, worktrees = new WorktreeManager(worktreeRoot), gateManager }) {
    this.manifest = manifest; this.statePath = statePath; this.worktrees = worktrees; this.runtime = runtime; this.runtimeAdapters = runtimeAdapters || createRuntimeAdapters({ codex: runtime }); this.worktreeRoot = worktreeRoot; this.gateRoot = gateRoot || join(resolve(statePath, ".."), "founder-outbox"); this.intakeRoot = intakeRoot || join(resolve(statePath, ".."), "pm-inbox"); this.resultRoot = resultRoot || join(resolve(statePath, ".."), "result-outbox"); this.gateManager = gateManager || new FounderGateManager({ root: this.gateRoot }); this._saveChain = Promise.resolve(); this._qaBusy = false; this._qaWaiters = [];
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return freshPortfolioState();
      throw corruptStateError({ statePath: this.statePath, reason: "READ_ERROR", cause: error });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw corruptStateError({ statePath: this.statePath, reason: "INVALID_JSON", cause });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.tasks) || !parsed.tasks.every((task) => task && typeof task === "object" && !Array.isArray(task))) {
      throw corruptStateError({ statePath: this.statePath, reason: "INVALID_SHAPE" });
    }
    for (const key of OPTIONAL_STATE_ARRAYS) {
      if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
        throw corruptStateError({ statePath: this.statePath, reason: "INVALID_SHAPE" });
      }
    }
    if (parsed.events === undefined) {
      parsed.events = [];
    } else if (!Array.isArray(parsed.events) || !parsed.events.every(isValidLifecycleEvent)) {
      throw corruptStateError({ statePath: this.statePath, reason: "INVALID_SHAPE" });
    }
    if (parsed.activeBuilders === undefined) parsed.activeBuilders = [];
    if (parsed.activeQa === undefined) parsed.activeQa = [];
    return parsed;
  }
  async save(state) { const snapshot = { ...state, updatedAt: new Date().toISOString() }; this._saveChain = this._saveChain.catch(() => {}).then(async () => writeFileAtomic(this.statePath, JSON.stringify(snapshot, null, 2))); return this._saveChain; }

  async reconcileProjects(state) {
    const projects = []; const founderGates = [];
    for (const project of this.manifest.projects) {
      const defs = definitions(project);
      const verified = defs.filter((definition) => state.tasks.some((item) => item.projectId === project.id && item.taskId === definition.taskId && item.state === "VERIFIED_DONE"));
      const task = state.tasks.find((item) => item.projectId === project.id && item.state === "VERIFIED_DONE");
      if ((defs.length && verified.length === defs.length) || (!defs.length && task)) { projects.push({ ...project, state: defs.length ? "V1_COMPLETE" : "VERIFIED_DONE", founderRequired: false, gateStatus: state.founderDecisions?.some((item) => item.projectId === project.id) ? "RESOLVED" : undefined, taskId: task?.taskId, qa: task?.qa?.verdict || "ACCEPT", blockers: [] }); continue; }
      const decision = project.founderRequired || project.founderGate ? state.founderDecisions?.find((item) => item.projectId === project.id) : null;
      if (decision?.decision === "PAUSE") { projects.push({ ...project, state: "HOLD", founderRequired: false, blockers: [decision.scope], gateId: decision.gateId, gateStatus: "RESOLVED", deliveryState: null }); continue; }
      if (decision?.decision === "APPROVE" && !project.task && !defs.length) { projects.push({ ...project, state: "V1_COMPLETE", founderRequired: false, blockers: [], gateId: decision.gateId, gateStatus: "RESOLVED", deliveryState: null }); continue; }
      const authorizedTask = decision?.decision === "APPROVE" ? project.task : null;
      const taskState = authorizedTask && state.tasks.find((item) => item.taskId === authorizedTask.taskId)?.state;
      if (taskState === "VERIFIED_DONE") { projects.push({ ...project, state: "VERIFIED_DONE", founderRequired: false, gateStatus: "RESOLVED", taskId: authorizedTask.taskId, qa: "ACCEPT", blockers: [] }); continue; }
      let gate = null;
      if (project.founderRequired && project.founderGate && !decision) {
        const gateManager = new FounderGateManager({ root: join(this.gateRoot, project.id) });
        gate = await gateManager.create({ project: project.id, runId: `portfolio-${project.id}`, ...project.founderGate });
        founderGates.push({ gateId: gate.gateId, project: project.id, type: gate.type, packet: gate.packet, deliveryState: gate.deliveryState, status: gate.status });
      }
      const adapter = this.runtimeAdapters[project.runtime || project.owner];
      const adapterStatus = adapter ? await adapter.availability() : { ok: false, reason: "runtime adapter not configured" };
      const blockers = [...(project.blockers || [])];
      if (adapter && !adapterStatus.ok && project.state !== "BLOCKED_TARGET" && project.state !== "FOUNDER_GATE" && adapterStatus.reason && !blockers.includes(adapterStatus.reason)) blockers.push(adapterStatus.reason);
      const visibleState = taskState === "BLOCKED_RUNTIME_ADAPTER" ? "BLOCKED_SCOPE" : (taskState || project.state || "BLOCKED_SCOPE");
      projects.push({ ...project, task: authorizedTask || project.task, state: gate ? "FOUNDER_GATE" : visibleState, blockers, founderRequired: Boolean(project.founderRequired), gateId: gate?.gateId || null, gatePacket: gate?.packet || null, deliveryState: gate?.deliveryState || null, runtimeStatus: adapterStatus });
    }
    state.projects = projects; state.founderGates = founderGates; return state;
  }

  async reconcile() {
    const state = await this.load();
    state.activeBuilders = []; state.activeQa = [];
    state.tasks = state.tasks.map((task) => task.state === "RUNNING" || task.state === "QA" ? { ...task, state: "QUEUED", reconcile: "REQUEUED_AFTER_RESTART" } : task);
    const activeIds = new Set(this.manifest.projects.filter((project) => project.active !== false).map((project) => project.id));
    for (const project of this.manifest.projects.filter((item) => item.active !== false)) {
      const next = definitions(project).find((definition) => !state.tasks.some((task) => task.taskId === definition.taskId && task.state === "VERIFIED_DONE"));
      if (next && !state.tasks.some((task) => task.projectId === project.id && task.taskId === next.taskId)) state.tasks.push({ ...next, projectId: project.id, state: "QUEUED", attempts: 0, qaAttempts: 0 });
    }
    if (activeIds.size) state.tasks = state.tasks.map((task) => !activeIds.has(task.projectId) && task.state === "QUEUED" ? { ...task, state: "HOLD", blocker: "OUT_OF_CORE_V1_SCOPE" } : task);
    await this.reconcileProjects(state); state.service = "RECONCILED"; await this.save(state); return state;
  }

  async enqueue(projectId) {
    const project = this.manifest.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    const current = await this.load();
    const approved = current.founderDecisions?.some((item) => item.projectId === projectId && item.decision === "APPROVE");
    const definition = definitions(project).find((candidate) => !current.tasks.some((item) => item.taskId === candidate.taskId && item.state === "VERIFIED_DONE"));
    const task = definition ? { ...definition, projectId, state: "QUEUED", attempts: 0, qaAttempts: 0, verificationOnly: approved && projectId === "juagenteconomy" } : { taskId: `${projectId.toUpperCase()}-DISCOVERY`, projectId, state: project.state || "BLOCKED_SCOPE", scope: "repository SSOT discovery only" };
    const state = await this.load(); state.tasks = state.tasks.filter((item) => item.projectId !== projectId || item.state === "VERIFIED_DONE"); state.tasks.push(task); await this.save(state); return task;
  }

  async acceptTaskPacket(packet) {
    const project = this.manifest.projects.find((item) => item.id === packet.projectId);
    const definition = definitions(project).find((item) => item.taskId === packet.taskId);
    if (!project || !definition || project.active === false) throw new Error(`unauthorized TASK_PACKET: ${packet.projectId}/${packet.taskId}`);
    if (JSON.stringify(packet.files) !== JSON.stringify(definition.files || []) || JSON.stringify(packet.tests) !== JSON.stringify(definition.tests || [])) throw new Error(`TASK_PACKET scope mismatch: ${packet.taskId}`);
    const state = await this.load();
    if (state.tasks.some((item) => item.taskId === packet.taskId && item.state === "VERIFIED_DONE")) return state.tasks.find((item) => item.taskId === packet.taskId);
    const task = { ...definition, projectId: project.id, state: "QUEUED", attempts: 0, qaAttempts: 0 };
    state.tasks = state.tasks.filter((item) => item.projectId !== project.id || item.state === "VERIFIED_DONE"); state.tasks.push(task); await this.save(state); return task;
  }

  async acceptTaskPacketFile(filePath) {
    return this.acceptTaskPacket(await readTaskPacketFile(filePath));
  }

  async readResultReturn(taskId) {
    return readResultReturnFile(join(this.resultRoot, `${taskId}.json`));
  }

  async publishResult(task) {
    if (!task.result) return;
    await writeFileAtomic(join(this.resultRoot, `${task.taskId}.json`), JSON.stringify({ schema: "agent-relay.result-return.v1", taskId: task.taskId, result: task.result, qa: task.qa || null, state: task.state }, null, 2));
  }

  async _acquireQa() { if (this._qaBusy) await new Promise((resolvePromise) => this._qaWaiters.push(resolvePromise)); this._qaBusy = true; }
  _releaseQa() { this._qaBusy = false; this._qaWaiters.shift()?.(); }

  async runOne(task, state, { signal } = {}) {
    const project = this.manifest.projects.find((item) => item.id === task.projectId);
    const adapter = project && this.runtimeAdapters[project.runtime || project.owner];
    const availability = adapter ? await adapter.availability() : { ok: false, reason: "runtime adapter not configured" };
    if (!Array.isArray(state.events)) state.events = [];
    if (!definitions(project).some((definition) => definition.taskId === task.taskId)) { task.state = project?.state || "BLOCKED_SCOPE"; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts || 0, state: task.state, reason: "task definition not authorized" }); return; }
    if (!adapter || !availability.ok) { task.state = "BLOCKED_RUNTIME_ADAPTER"; task.error = availability.reason; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts || 0, state: task.state, reason: availability.reason || "runtime unavailable" }); return; }
    try { adapter.assertOwnership(project); } catch (error) { task.state = "BLOCKED_RUNTIME_ADAPTER"; task.error = error.message; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts || 0, state: task.state, reason: error.message }); return; }
    const retained = task.builderEvidence?.workspace && existsSync(task.builderEvidence.workspace);
    const builder = retained ? { path: task.builderEvidence.workspace, base: task.builderEvidence.base || (await exec("git", ["-C", task.builderEvidence.workspace, "rev-parse", "HEAD"])).stdout.trim(), projectId: project.id, cleanup: async () => {} } : await this.worktrees.create(project, task.taskId);
    state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); task.state = "RUNNING"; task.attempts += 1; task.builderEvidence = { ...(task.builderEvidence || {}), workspace: builder.path, base: builder.base, startedAt: new Date().toISOString(), pid: null }; recordLifecycleEvent(state, { type: "TASK_DISPATCHED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts }); await this.save(state);
    let preserveWorktree = retained;
    try {
      for (;;) {
      const builderRun = await adapter.run({ workspace: builder.path, sandbox: "workspace-write", prompt: builderPrompt({ ...task, projectId: project.id }), signal });
      task.builderEvidence = { pid: builderRun.pid, workspace: builder.path, base: builder.base, startedAt: builderRun.startedAt, exitCode: builderRun.code };
      task.result = parseResultPacket(builderRun.text); recordLifecycleEvent(state, { type: "WORKER_RESULT", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, status: task.result.status }); await this.publishResult(task); if (task.result.status !== "IMPLEMENTED") { task.state = "HOLD"; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, state: task.state, reason: `result status ${task.result.status}` }); break; } task.state = "QA"; state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); await this.save(state);
      await this._acquireQa();
      let qaRun;
      try { task.qaAttempts += 1; qaRun = await adapter.run({ workspace: builder.path, sandbox: "read-only", prompt: qaPrompt(task, builder.base), signal }); }
      finally { this._releaseQa(); }
      task.qaEvidence = { pid: qaRun.pid, startedAt: qaRun.startedAt, exitCode: qaRun.code }; task.qa = parseQaPacket(qaRun.text); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); recordLifecycleEvent(state, { type: "QA_VERDICT", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, qaAttempt: task.qaAttempts, verdict: task.qa.verdict });
      if (task.qa.verdict === "ACCEPT") { task.promotionRef = await this.worktrees.promote?.(project, task.taskId, task.result.commitSha, builder.path) || `candidate:${task.result.commitSha}`; task.state = "VERIFIED_DONE"; recordLifecycleEvent(state, { type: "TASK_COMPLETED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, state: task.state }); await this.publishResult(task); break; }
      if (task.qa.verdict === "REQUEST_CHANGES" && task.attempts < 3) { task.state = "REQUEST_CHANGES"; recordLifecycleEvent(state, { type: "TASK_RETRY", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, qaAttempt: task.qaAttempts, verdict: task.qa.verdict }); await this.publishResult(task); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); await this.save(state); task.state = "RUNNING"; task.attempts += 1; recordLifecycleEvent(state, { type: "TASK_DISPATCHED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts }); state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); await this.save(state); continue; }
      if (task.qa.verdict === "FOUNDER_GATE") task.state = "FOUNDER_GATE"; else task.state = "HOLD"; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts, qaAttempt: task.qaAttempts, state: task.state, reason: `QA verdict ${task.qa.verdict}` }); await this.publishResult(task); break;
      }
    } catch (error) { if (signal?.aborted) { preserveWorktree = true; task.state = "RUNNING"; task.error = "CHECKPOINTED_DEADLINE"; recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts || 0, state: task.state, reason: "CHECKPOINTED_DEADLINE" }); } else { task.state = "HOLD"; task.error = String(error.message || error); recordLifecycleEvent(state, { type: "TASK_FAILED", taskId: task.taskId, projectId: task.projectId, attempt: task.attempts || 0, state: task.state, reason: task.error }); } state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); }
    if (!preserveWorktree) await builder.cleanup(); await this.save(state);
  }

  async resolveFounderGate(gateId, decision) {
    const state = await this.reconcile();
    const project = state.projects?.find((item) => item.gateId === gateId);
    if (!project) throw new Error(`unknown Founder Gate: ${gateId}`);
    const gate = await new FounderGateManager({ root: join(this.gateRoot, project.id) }).respond({ GATE_ID: gateId, DECISION: decision, timestamp: new Date().toISOString() });
    state.founderDecisions = (state.founderDecisions || []).filter((item) => item.projectId !== project.id);
    if (project.id === "juagenteconomy" && decision === "APPROVE") {
      state.founderDecisions.push({ projectId: project.id, gateId, decision, scope: "P2.1 Double-Entry Ledger Engine only", forbidden: ["P2.2+", "production spending", "real external money movement", "OAuth", "secrets", "payment credentials", "new Product scope"], resolvedAt: gate.response.timestamp });
      const task = this.manifest.projects.find((item) => item.id === project.id)?.task;
      if (task) state.tasks = [...state.tasks.filter((item) => item.projectId !== project.id || item.state === "VERIFIED_DONE"), { ...task, projectId: project.id, state: "QUEUED", attempts: 0, qaAttempts: 0, verificationOnly: true }];
    } else if (project.id === "juplan" && decision === "PAUSE") {
      state.founderDecisions.push({ projectId: project.id, gateId, decision, scope: "JuPlan V1 stable; V1.1 HOLD / PORTFOLIO BACKLOG", resolvedAt: gate.response.timestamp });
    } else if (project.id === "juactl" && ["APPROVE", "PAUSE"].includes(decision)) {
      state.founderDecisions.push({ projectId: project.id, gateId, decision, scope: "ACTL existing V1 Windows Board E2E only; no Product expansion", resolvedAt: gate.response.timestamp });
    } else throw new Error(`unsupported Founder decision: ${project.id}/${decision}`);
    state.resolvedFounderGates = [...(state.resolvedFounderGates || []), { gateId, projectId: project.id, decision, resolvedAt: gate.response.timestamp }];
    await this.save(state); return { gate, state };
  }

  async stop() { await Promise.all(Object.values(this.runtimeAdapters).map((adapter) => adapter.stop?.())); await this.runtime.stop?.(); }
  async runOnce({ signal } = {}) {
    const state = await this.reconcile(); state.service = "RUNNING";
    const queued = state.tasks.filter((task) => task.state === "QUEUED").slice(0, Math.min(2, this.manifest.maxBuilders));
    await Promise.all(queued.map((task) => this.runOne(task, state, { signal }))); state.service = "IDLE"; await this.save(state); return state;
  }

  async runLoop({ intervalMs = 15_000, signal } = {}) { while (!signal?.aborted) { await this.runOnce({ signal }); await sleep(intervalMs); } return this.load(); }
}

export async function loadManifest(path) { return JSON.parse(await readFile(path, "utf8")); }
