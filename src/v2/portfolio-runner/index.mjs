"use strict";

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { FounderGateManager } from "../portfolio-jit/index.mjs";

export const STATES = Object.freeze(["QUEUED", "RUNNING", "QA", "REQUEST_CHANGES", "VERIFIED_DONE", "HOLD", "BLOCKED_SCOPE", "BLOCKED_WORKTREE", "BLOCKED_TARGET", "BLOCKED_SSOT_CONFLICT", "BLOCKED_SECRET", "BLOCKED_PAYMENT", "BLOCKED_EXTERNAL", "FOUNDER_GATE"]);
export const QA_VERDICTS = Object.freeze(["ACCEPT", "REQUEST_CHANGES", "FOUNDER_GATE"]);

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function packetLine(text, prefix) {
  const line = String(text).split(/\r?\n/).reverse().find((item) => item.trim().startsWith(prefix));
  if (!line) return null;
  try { return JSON.parse(line.trim().slice(prefix.length).trim()); } catch { return null; }
}

export function parseResultPacket(text) {
  const packet = packetLine(text, "RESULT_PACKET:");
  if (!packet || packet.schema !== "agent-relay.result.v1" || !packet.taskId || !["IMPLEMENTED", "BLOCKED"].includes(packet.status) || !Array.isArray(packet.changedFiles) || !Array.isArray(packet.tests)) throw new Error("invalid RESULT_PACKET");
  return packet;
}

export function parseQaPacket(text) {
  const packet = packetLine(text, "QA_PACKET:");
  if (!packet || packet.schema !== "agent-relay.qa.v1" || !packet.taskId || !QA_VERDICTS.includes(packet.verdict) || !Array.isArray(packet.tests)) throw new Error("invalid QA_PACKET");
  return packet;
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
    const status = (await exec("git", ["-C", project.path, "status", "--porcelain"])).stdout.trim();
    if (status) throw new Error(`worktree dirty: ${project.id}`);
    const base = (await exec("git", ["-C", project.path, "rev-parse", project.ref || "HEAD"])).stdout.trim();
    const name = `${project.id}-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const path = join(this.root, name);
    await mkdir(this.root, { recursive: true });
    await exec("git", ["-C", project.path, "worktree", "add", "--detach", path, base]);
    return { path, base, projectId: project.id, async cleanup() { await exec("git", ["-C", project.path, "worktree", "remove", "--force", path]).catch(() => {}); await rm(path, { recursive: true, force: true }); } };
  }
}

export class CodexDevelopmentRuntime {
  constructor({ command = process.env.CODEX_BIN || "codex", timeoutMs = 30 * 60_000 } = {}) { this.command = command; this.timeoutMs = timeoutMs; }

  async run({ workspace, prompt, sandbox }) {
    const output = join(workspace, `.agent-relay-${sandbox}-output.txt`);
    const args = ["exec", "--ephemeral", ...(sandbox === "workspace-write" ? ["--approve-for-me"] : ["--sandbox", sandbox]), "--skip-git-repo-check", "--cd", workspace, "--json", "-o", output, "-"];
    const child = spawn(this.command, args, { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    const startedAt = new Date().toISOString();
    child.stdin.end(prompt);
    const exit = await new Promise((resolvePromise, reject) => { const timer = setTimeout(() => child.kill("SIGTERM"), this.timeoutMs); child.once("error", reject); child.once("close", (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }); }); });
    const text = existsSync(output) ? await readFile(output, "utf8") : "";
    await unlink(output).catch(() => {});
    if (exit.code !== 0) throw new Error(`Codex ${sandbox} exit ${exit.code}: ${stderr.trim() || stdout.trim()}`);
    if (!text.trim()) throw new Error(`Codex ${sandbox} produced no packet`);
    return { pid: child.pid, startedAt, ...exit, text };
  }
}

export function builderPrompt(task) {
  return `You are the Agent Relay Builder. Execute ONLY this repository-backed authorized task. Do not widen scope, ask the Founder routine questions, touch other repositories, or push.\nTASK_PACKET: ${JSON.stringify({ schema: "agent-relay.task.v1", taskId: task.taskId, projectId: task.projectId, scope: task.scope, files: task.files, tests: task.tests })}\nRead the repository SSOT first. Implement the bounded task in this isolated writable worktree. Run the listed tests. Commit the implementation locally. End with exactly one line: RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: task.taskId, status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "<git-sha>", summary: "<summary>" })}`;
}

export function qaPrompt(task, base) {
  return `You are an independent read-only QA Agent. Do not modify files, commit, or push. Verify task ${task.taskId} against base ${base}. Inspect the diff, run the relevant tests, and validate scope. End with exactly one line: QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: task.taskId, verdict: "ACCEPT", tests: [], findings: [], summary: "<evidence>" })}`;
}

export class PortfolioRunner {
  constructor({ manifest, statePath, worktreeRoot, gateRoot, runtime = new CodexDevelopmentRuntime(), worktrees = new WorktreeManager(worktreeRoot), gateManager }) {
    this.manifest = manifest; this.statePath = statePath; this.worktrees = worktrees; this.runtime = runtime; this.worktreeRoot = worktreeRoot; this.gateRoot = gateRoot || join(resolve(statePath, ".."), "founder-outbox"); this.gateManager = gateManager || new FounderGateManager({ root: this.gateRoot }); this._saveChain = Promise.resolve(); this._qaBusy = false; this._qaWaiters = [];
  }

  async load() { try { return JSON.parse(await readFile(this.statePath, "utf8")); } catch { return { schema: "agent-relay.portfolio-state.v1", service: "STOPPED", tasks: [], activeBuilders: [], activeQa: [], events: [], updatedAt: new Date().toISOString() }; } }
  async save(state) { const snapshot = { ...state, updatedAt: new Date().toISOString() }; this._saveChain = this._saveChain.then(async () => { await mkdir(resolve(this.statePath, ".."), { recursive: true }); await writeFile(`${this.statePath}.tmp`, JSON.stringify(snapshot, null, 2)); await rm(this.statePath, { force: true }); await writeFile(this.statePath, JSON.stringify(snapshot, null, 2)); }); return this._saveChain; }

  async reconcileProjects(state) {
    const projects = []; const founderGates = [];
    for (const project of this.manifest.projects) {
      const task = state.tasks.find((item) => item.projectId === project.id && item.state === "VERIFIED_DONE");
      if (task) { projects.push({ ...project, state: "VERIFIED_DONE", taskId: task.taskId, qa: task.qa?.verdict || "ACCEPT", blockers: [] }); continue; }
      let gate = null;
      if (project.founderRequired && project.founderGate) {
        const gateManager = new FounderGateManager({ root: join(this.gateRoot, project.id) });
        gate = await gateManager.create({ project: project.id, runId: `portfolio-${project.id}`, ...project.founderGate });
        founderGates.push({ gateId: gate.gateId, project: project.id, type: gate.type, packet: gate.packet, deliveryState: gate.deliveryState, status: gate.status });
      }
      projects.push({ ...project, state: gate ? "FOUNDER_GATE" : (project.state || "BLOCKED_SCOPE"), blockers: project.blockers || [], founderRequired: Boolean(project.founderRequired), gateId: gate?.gateId || null, gatePacket: gate?.packet || null, deliveryState: gate?.deliveryState || null });
    }
    state.projects = projects; state.founderGates = founderGates; return state;
  }

  async reconcile() {
    const state = await this.load();
    state.activeBuilders = []; state.activeQa = [];
    state.tasks = state.tasks.map((task) => task.state === "RUNNING" || task.state === "QA" ? { ...task, state: "QUEUED", reconcile: "REQUEUED_AFTER_RESTART" } : task);
    await this.reconcileProjects(state); state.service = "RECONCILED"; await this.save(state); return state;
  }

  async enqueue(projectId) {
    const project = this.manifest.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`unknown project: ${projectId}`);
    const task = project.task ? { ...project.task, projectId, state: "QUEUED", attempts: 0, qaAttempts: 0 } : { taskId: `${projectId.toUpperCase()}-DISCOVERY`, projectId, state: project.state || "BLOCKED_SCOPE", scope: "repository SSOT discovery only" };
    const state = await this.load(); state.tasks = state.tasks.filter((item) => item.projectId !== projectId || item.state === "VERIFIED_DONE"); state.tasks.push(task); await this.save(state); return task;
  }

  async _acquireQa() { if (this._qaBusy) await new Promise((resolvePromise) => this._qaWaiters.push(resolvePromise)); this._qaBusy = true; }
  _releaseQa() { this._qaBusy = false; this._qaWaiters.shift()?.(); }

  async runOne(task, state) {
    const project = this.manifest.projects.find((item) => item.id === task.projectId);
    if (!project?.task || project.owner !== "codex") { task.state = project?.state || "BLOCKED_SCOPE"; return; }
    const builder = await this.worktrees.create(project, task.taskId); state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path }); task.state = "RUNNING"; task.attempts += 1; await this.save(state);
    try {
      for (;;) {
      const builderRun = await this.runtime.run({ workspace: builder.path, sandbox: "workspace-write", prompt: builderPrompt({ ...task, projectId: project.id }) });
      task.builderEvidence = { pid: builderRun.pid, workspace: builder.path, startedAt: builderRun.startedAt, exitCode: builderRun.code };
      task.result = parseResultPacket(builderRun.text); if (task.result.status !== "IMPLEMENTED") { task.state = "HOLD"; break; } task.state = "QA"; state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa.push({ taskId: task.taskId, pid: null, workspace: builder.path }); await this.save(state);
      await this._acquireQa();
      let qaRun;
      try { task.qaAttempts += 1; qaRun = await this.runtime.run({ workspace: builder.path, sandbox: "read-only", prompt: qaPrompt(task, task.result.commitSha) }); }
      finally { this._releaseQa(); }
      task.qaEvidence = { pid: qaRun.pid, startedAt: qaRun.startedAt, exitCode: qaRun.code }; task.qa = parseQaPacket(qaRun.text); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId);
      if (task.qa.verdict === "ACCEPT") { task.state = "VERIFIED_DONE"; break; }
      if (task.qa.verdict === "REQUEST_CHANGES" && task.attempts < 3) { task.state = "REQUEST_CHANGES"; state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); await this.save(state); task.state = "RUNNING"; task.attempts += 1; state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path }); await this.save(state); continue; }
      if (task.qa.verdict === "FOUNDER_GATE") task.state = "FOUNDER_GATE"; else task.state = "HOLD"; break;
      }
    } catch (error) { task.state = "HOLD"; task.error = String(error.message || error); state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); }
    await builder.cleanup(); await this.save(state);
  }

  async runOnce() {
    const state = await this.reconcile(); state.service = "RUNNING";
    const queued = state.tasks.filter((task) => task.state === "QUEUED").slice(0, Math.min(2, this.manifest.maxBuilders));
    await Promise.all(queued.map((task) => this.runOne(task, state))); state.service = "IDLE"; await this.save(state); return state;
  }

  async runLoop({ intervalMs = 15_000, signal } = {}) { while (!signal?.aborted) { await this.runOnce(); await sleep(intervalMs); } return this.load(); }
}

export async function loadManifest(path) { return JSON.parse(await readFile(path, "utf8")); }
