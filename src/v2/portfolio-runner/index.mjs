"use strict";

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { FounderGateManager } from "../portfolio-jit/index.mjs";
import { createRuntimeAdapters } from "../runtime-adapters/index.mjs";

export const STATES = Object.freeze(["QUEUED", "RUNNING", "QA", "REQUEST_CHANGES", "VERIFIED_DONE", "V1_COMPLETE", "HOLD", "BLOCKED_SCOPE", "BLOCKED_WORKTREE", "BLOCKED_TARGET", "BLOCKED_SSOT_CONFLICT", "BLOCKED_RUNTIME_ADAPTER", "BLOCKED_SECRET", "BLOCKED_PAYMENT", "BLOCKED_EXTERNAL", "FOUNDER_GATE", "INTEGRATION_TARGET"]);
export const QA_VERDICTS = Object.freeze(["ACCEPT", "REQUEST_CHANGES", "FOUNDER_GATE"]);

export function discoverCodexCommand(env = process.env) {
  const candidates = [env.CODEX_BIN, join(homedir(), ".local", "bin", "codex"), "/usr/local/bin/codex", "/usr/bin/codex"];
  for (const candidate of candidates) if (candidate && (candidate.includes("/") ? existsSync(candidate) : true)) return candidate;
  try { const found = execFileSync("sh", ["-lc", "command -v codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); if (found) return found; } catch {}
  return null;
}

function processAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

function runtimeLaunchFailure(error) { return /(?:spawn|ENOENT|runtime command missing|cannot execute)/i.test(String(error?.message || error)); }

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function packetLine(text, prefix) {
  const line = String(text).split(/\r?\n/).reverse().find((item) => item.trim().startsWith(prefix));
  if (!line) return null;
  try { return JSON.parse(line.trim().slice(prefix.length).trim()); } catch { return null; }
}

// A quota/rate-limit failure moves the lane to the next runtime in its chain instead of holding the task.
export const QUOTA_ERROR = /rate.?limit|quota|usage limit|limit (reached|exceeded)|hit your [a-z ]*limit|weekly limit|too many requests|\b429\b|insufficient[_ ]quota|out of credits|credit balance|exceeded your/i;
// Provider-side outages (free models overload): the next runtime in the chain takes the turn, like a quota hit.
export const TRANSIENT_ERROR = /\b50[234]\b|overloaded|temporarily unavailable|service unavailable|upstream error|ECONNRESET|ETIMEDOUT|socket hang up|model not found|hook dispatch failed/i; // last two: a misconfigured runtime (cline 2026-09-23) — the next runtime takes over
// Lane config: runtime / qaRuntime may be one id or an ordered fallback list, e.g. ["opencode", "codex"].
const chainOf = (value) => [value].flat().filter(Boolean);

const SETTLED = new Set(["VERIFIED_DONE", "HOLD", "FOUNDER_GATE", "BLOCKED_SCOPE"]);

function definitions(project) { return project?.tasks || (project?.task ? [project.task] : []); }

function nextDefinition(project, state) {
  return definitions(project).find((definition) => !state.tasks.some((task) => task.projectId === project.id && task.taskId === definition.taskId && task.state === "VERIFIED_DONE"));
}

export function buildCoreV1Snapshot(manifest, state) {
  const lanes = manifest.projects.filter((project) => project.coreV1 !== false).map((project) => {
    const tasks = state.tasks.filter((task) => task.projectId === project.id);
    const task = tasks.at(-1) || null;
    const next = nextDefinition(project, state);
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
    };
  });
  return { schema: "agent-relay.core-v1.inbox.v1", program: "CORE_V1", service: state.service || "UNKNOWN", updatedAt: state.updatedAt || null, lanes };
}

export function formatCoreV1Text(snapshot) {
  const lines = [`CORE_V1 ${snapshot.service} · ${snapshot.updatedAt || "no timestamp"}`];
  for (const lane of snapshot.lanes) lines.push(`${lane.project} | PM=${lane.pm.state} ${lane.pm.channel} | task=${lane.currentTask || "-"} | worker=${lane.worker.runtime}/${lane.worker.state}${lane.worker.pid ? `#${lane.worker.pid}` : ""} | result=${lane.result?.status || "-"} | QA=${lane.qa.verdict || "-"} | retries=${lane.retries} | next=${lane.next || "-"} | blocker=${lane.blocker || "-"}${lane.founderGate ? ` | FOUNDER_GATE=${lane.founderGate.gateId}` : ""}`);
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

// Local-only branch that collects accepted candidates in order, so each task starts from the previous ones.
// Agent Relay never pushes it and never touches the user's checkout; merging it anywhere else is the Founder's call.
export const INTEGRATION_REF = "refs/heads/agent-relay/integration";
const gitRef = (repo, ref) => exec("git", ["-C", repo, "rev-parse", "--verify", "-q", `${ref}^{commit}`]).then((r) => r.stdout.trim(), () => null);
const isAncestor = (repo, a, b) => exec("git", ["-C", repo, "merge-base", "--is-ancestor", a, b]).then(() => true, () => false);

// Reuse the project's installed deps (root and per-package, e.g. pnpm workspaces) so build/typecheck/test really run
// in a worktree; the links are git-excluded so they are never committed.
async function linkDeps(projectPath, path) {
  const linked = [];
  const walk = async (rel, depth) => {
    if (existsSync(join(projectPath, rel, "node_modules")) && existsSync(join(path, rel)) && !existsSync(join(path, rel, "node_modules"))) { await symlink(join(projectPath, rel, "node_modules"), join(path, rel, "node_modules"), "dir"); linked.push(rel); }
    if (depth >= 2) return;
    for (const entry of await readdir(join(projectPath, rel), { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && !["node_modules", ".git"].includes(entry.name)) await walk(join(rel, entry.name), depth + 1);
  };
  await walk("", 0);
  if (linked.length) {
    const exclude = resolve(path, (await exec("git", ["-C", path, "rev-parse", "--git-path", "info/exclude"])).stdout.trim());
    if (!(await readFile(exclude, "utf8").catch(() => "")).split(/\r?\n/).includes("node_modules")) { await mkdir(resolve(exclude, ".."), { recursive: true }); await appendFile(exclude, "\nnode_modules\n"); }
  }
  return linked;
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
    // Build on accepted work: start from the project's integration branch when it descends from the project base.
    const integration = await gitRef(project.path, INTEGRATION_REF);
    if (integration && await isAncestor(project.path, base, integration)) base = integration;
    const name = `${project.id}-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const path = join(this.root, name);
    await mkdir(this.root, { recursive: true });
    await exec("git", ["-C", project.path, "worktree", "add", "--detach", path, base]);
    // Reuse the project's installed deps so Worker and QA can really build/typecheck/test (a fresh worktree has none).
    await linkDeps(project.path, path);
    return { path, base, projectId: project.id, async cleanup() { await exec("git", ["-C", project.path, "worktree", "remove", "--force", path]).catch(() => {}); await rm(path, { recursive: true, force: true }); } };
  }

  // Add an accepted candidate to the integration branch: fast-forward when possible, otherwise cherry-pick
  // base..commit onto the tip in a scratch worktree and re-run the task's tests there. Never moves on failure.
  async integrate(project, task, { gate = runTestGate } = {}) {
    const commit = task.result?.commitSha; const base = task.builderEvidence?.base;
    let tip = await gitRef(project.path, INTEGRATION_REF);
    if (!tip) { const start = base || (await gitRef(project.path, project.ref || "HEAD")); await exec("git", ["-C", project.path, "update-ref", INTEGRATION_REF, start]); tip = start; }
    if (await isAncestor(project.path, tip, commit)) { await exec("git", ["-C", project.path, "update-ref", INTEGRATION_REF, commit, tip]); return { state: "FAST_FORWARD", tip: commit }; }
    if (!base) return { state: "NOT_INTEGRATED", reason: "unknown candidate base", tip };
    const scratch = join(this.root, `${project.id}-integrate-${task.taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`);
    await exec("git", ["-C", project.path, "worktree", "add", "--detach", scratch, tip]);
    try {
      try { await exec("git", ["-C", scratch, "-c", "user.name=Agent Relay", "-c", "user.email=agent-relay@localhost", "cherry-pick", "--allow-empty", `${base}..${commit}`]); }
      catch (error) { await exec("git", ["-C", scratch, "cherry-pick", "--abort"]).catch(() => {}); return { state: "CONFLICT", reason: String(error.message || error).slice(0, 500), tip }; }
      await linkDeps(project.path, scratch);
      const result = await gate(scratch, task.tests);
      if (!result.ok) { const failed = result.results.find((item) => item.code !== 0); return { state: "GATE_FAILED", reason: failed ? `${failed.cmd} exit ${failed.code}: ${failed.tail.slice(-800)}` : "gate failed", tip }; }
      const merged = (await exec("git", ["-C", scratch, "rev-parse", "HEAD"])).stdout.trim();
      await exec("git", ["-C", project.path, "update-ref", INTEGRATION_REF, merged, tip]);
      return { state: "CHERRY_PICKED", tip: merged };
    } finally { await exec("git", ["-C", project.path, "worktree", "remove", "--force", scratch]).catch(() => {}); await rm(scratch, { recursive: true, force: true }); }
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
  constructor({ command = discoverCodexCommand(), timeoutMs = 30 * 60_000 } = {}) { this.command = command; this.timeoutMs = timeoutMs; this.children = new Set(); }

  async run({ workspace, prompt, sandbox, signal }) {
    const output = join(workspace, `.agent-relay-${sandbox}-output.txt`);
    const args = ["exec", "--ephemeral", ...(sandbox === "workspace-write" ? ["--approve-for-me"] : ["--sandbox", sandbox]), "--skip-git-repo-check", "--cd", workspace, "--json", "-o", output, "-"];
    if (!this.command) throw new Error("CODEX_RUNTIME_UNAVAILABLE: set CODEX_BIN or install codex in a known runtime location");
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

// Deterministic gate: the runner itself runs the task's tests in the candidate worktree before promotion,
// because LLM QA runs read-only and often cannot execute them (EROFS) yet still says ACCEPT.
export function runTestGate(workspace, tests, { timeoutMs = 15 * 60_000, signal } = {}) {
  const runOneCommand = (cmd) => new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", cmd], { cwd: workspace, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; const add = (chunk) => { output = (output + chunk).slice(-4000); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs); const abort = () => child.kill("SIGTERM"); signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => { clearTimeout(timer); resolvePromise({ cmd, code: -1, tail: String(error.message) }); });
    child.once("close", (code) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolvePromise({ cmd, code: code ?? -1, tail: output.slice(-1500) }); });
  });
  return (async () => { const results = []; for (const cmd of tests || []) { const result = await runOneCommand(cmd); results.push(result); if (result.code !== 0) return { ok: false, results }; } return { ok: true, results }; })();
}

// Founder plan harness (Founder 2026-09-23, the most important agent rule): what the Founder already planned is settled.
export const FOUNDER_PLAN_HARNESS = "Founder plan harness: the SSOT, the Founder direction and this task packet were already planned with the Founder and are settled. Do not ask about them or re-open them. Follow the plan straight through. Before changing anything, check the files, tests and dependencies the task needs, so nothing surprising appears mid-way. Resolve anything inside the plan yourself. The Founder only sees results.";

export function builderPrompt(task) {
  const mode = task.verificationOnly ? "Do not modify files or commit; verify the existing implementation only." : "Implement the bounded task and commit locally.";
  return `${FOUNDER_PLAN_HARNESS}\nYou are the Agent Relay Builder. Execute ONLY this repository-backed authorized task. Do not widen scope, ask the Founder routine questions, touch other repositories, or push.\nTASK_PACKET: ${JSON.stringify({ schema: "agent-relay.task.v1", taskId: task.taskId, projectId: task.projectId, scope: task.scope, files: task.files, tests: task.tests, verificationOnly: Boolean(task.verificationOnly) })}\nRead the repository SSOT first. ${mode} Run the listed tests.${task.qa?.findings?.length ? ` This is a retry: fix these findings from the previous QA/test gate first: ${JSON.stringify(task.qa.findings).slice(0, 3000)}` : ""} End with exactly one line: RESULT_PACKET: ${JSON.stringify({ schema: "agent-relay.result.v1", taskId: task.taskId, status: "IMPLEMENTED", changedFiles: [], tests: [], commitSha: "<git-sha>", summary: "<summary>" })}`;
}

export function qaPrompt(task, base) {
  return `${FOUNDER_PLAN_HARNESS}\nYou are an independent read-only QA Agent. Do not modify files, commit, or push. Use FOUNDER_GATE only for money, secrets/credentials, external publish/push or scope outside the task packet; anything the plan already covers is ACCEPT or REQUEST_CHANGES. Verify task ${task.taskId} by inspecting git diff ${base}..HEAD (the supplied base is the parent, not the candidate commit), then run relevant read-only-safe checks. The runner executes the listed tests itself after you, so a test blocked only by the read-only sandbox (EROFS) is not a reason to reject; say so. Any type error, failing check you can run, scope violation, or missing test coverage when the task's files include a test file and a harness exists, IS a reason (do not demand tests the task's file list cannot contain): verdict REQUEST_CHANGES with concrete findings. Validate scope. End with exactly one line: QA_PACKET: ${JSON.stringify({ schema: "agent-relay.qa.v1", taskId: task.taskId, verdict: "<ACCEPT|REQUEST_CHANGES|FOUNDER_GATE>", tests: [], findings: [], summary: "<evidence>" })}`;
}

export class PortfolioRunner {
  constructor({ manifest, statePath, worktreeRoot, gateRoot, intakeRoot, resultRoot, runtime = new CodexDevelopmentRuntime(), runtimeAdapters, worktrees = new WorktreeManager(worktreeRoot), gateManager, testGate = runTestGate, manifestPath = null }) {
    this.testGate = testGate; this.manifestPath = manifestPath; this._manifestMtime = null;
    this.manifest = manifest; this.statePath = statePath; this.worktrees = worktrees; this.runtime = runtime; this.runtimeAdapters = runtimeAdapters || createRuntimeAdapters({ codex: runtime }); this.worktreeRoot = worktreeRoot; this.gateRoot = gateRoot || join(resolve(statePath, ".."), "founder-outbox"); this.intakeRoot = intakeRoot || join(resolve(statePath, ".."), "pm-inbox"); this.resultRoot = resultRoot || join(resolve(statePath, ".."), "result-outbox"); this.gateManager = gateManager || new FounderGateManager({ root: this.gateRoot }); this._saveChain = Promise.resolve(); this._qaBusy = false; this._qaWaiters = [];
  }

  async load() { try { return JSON.parse(await readFile(this.statePath, "utf8")); } catch { return { schema: "agent-relay.portfolio-state.v1", service: "STOPPED", tasks: [], activeBuilders: [], activeQa: [], events: [], updatedAt: new Date().toISOString() }; } }
  async save(state) { const snapshot = { ...state, updatedAt: new Date().toISOString() }; this._saveChain = this._saveChain.then(async () => {
    // The continuous loop holds state in memory; a Founder answer written meanwhile by the CLI (founder-response) must not be overwritten.
    if (this._continuous) { const disk = await this.load(); if ((disk.resolvedFounderGates || []).length > (snapshot.resolvedFounderGates || []).length) for (const key of ["founderDecisions", "resolvedFounderGates"]) { snapshot[key] = disk[key]; state[key] = disk[key]; } } await mkdir(resolve(this.statePath, ".."), { recursive: true }); await writeFile(`${this.statePath}.tmp`, JSON.stringify(snapshot, null, 2)); await rm(this.statePath, { force: true }); await writeFile(this.statePath, JSON.stringify(snapshot, null, 2)); }); return this._saveChain; }

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

  // A new WBS / plan approval / lane setting only changes the manifest: pick it up in place instead of
  // restarting the runner (a restart interrupts every running task and makes it start over).
  async reloadManifestIfChanged() {
    if (!this.manifestPath) return false;
    const mtime = await stat(this.manifestPath).then((s) => s.mtimeMs, () => null);
    if (!mtime || mtime === this._manifestMtime) return false;
    const first = this._manifestMtime === null; this._manifestMtime = mtime;
    if (first) return false;
    try { this.manifest = await loadManifest(this.manifestPath); return true; } catch { return false; }  // a half-written file: keep the old manifest, retry next loop
  }

  // Each active lane gets its next unsettled definition queued (one task per lane at a time).
  queueNext(state) {
    const activeIds = new Set(this.manifest.projects.filter((project) => project.active !== false).map((project) => project.id));
    for (const project of this.manifest.projects.filter((item) => item.active !== false)) {
      // A task that ended in HOLD/gate is settled for now: report it, and let the lane continue with the next definition.
      const next = definitions(project).find((definition) => !state.tasks.some((task) => task.taskId === definition.taskId && SETTLED.has(task.state)));
      // Plan Studio "stop after each task": a lane paused by the runner waits for `night roadmap resume` (it removes the flag).
      if (existsSync(join(resolve(this.statePath, ".."), "lane-pause", project.id))) continue;
      if (next && !state.tasks.some((task) => task.projectId === project.id && task.taskId === next.taskId)) state.tasks.push({ ...next, projectId: project.id, state: "QUEUED", attempts: 0, qaAttempts: 0 });
    }
    if (activeIds.size) state.tasks = state.tasks.map((task) => !activeIds.has(task.projectId) && task.state === "QUEUED" ? { ...task, state: "HOLD", blocker: "OUT_OF_CORE_V1_SCOPE" } : task);
  }

  async reconcile() {
    await this.reloadManifestIfChanged();
    const state = await this.load();
    state.activeBuilders = []; state.activeQa = [];
    state.tasks = state.tasks.map((task) => {
      if (task.state === "HOLD" && String(task.error || "").startsWith("RUNTIME_LAUNCH:")) return { ...task, state: "QUEUED", error: null, reconcile: "REQUEUED_AFTER_RUNTIME_RECOVERY" };
      if (task.state === "HOLD" && (TRANSIENT_ERROR.test(String(task.error || "")) || QUOTA_ERROR.test(String(task.error || ""))) && (task.outageRequeues || 0) < 2) return { ...task, state: "QUEUED", error: null, attempts: 0, outageRequeues: (task.outageRequeues || 0) + 1, reconcile: "REQUEUED_AFTER_PROVIDER_OUTAGE" };
      if (task.state === "RUNNING" || task.state === "QA") {
        const pid = task.state === "QA" ? task.qaEvidence?.pid : task.builderEvidence?.pid;
        return pid && processAlive(pid) ? { ...task, reconcile: "ACTIVE_PROCESS_PRESERVED" } : { ...task, state: "QUEUED", reconcile: "REQUEUED_AFTER_RESTART" };
      }
      return task;
    });
    this.queueNext(state);
    await this.reconcileProjects(state);
    for (const task of state.tasks.filter((item) => item.state === "BLOCKED_RUNTIME_ADAPTER")) {
      const project = this.manifest.projects.find((item) => item.id === task.projectId); const adapter = project && this.runtimeAdapters[project.runtime || project.owner];
      if (adapter && (await adapter.availability()).ok) { task.state = "QUEUED"; task.error = null; task.reconcile = "REQUEUED_AFTER_RUNTIME_RECOVERY"; }
    }
    state.service = "RECONCILED"; await this.save(state); return state;
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

  async publishResult(task) {
    if (!task.result) return;
    await mkdir(this.resultRoot, { recursive: true });
    await writeFile(join(this.resultRoot, `${task.taskId}.json`), JSON.stringify({ schema: "agent-relay.result-return.v1", taskId: task.taskId, result: task.result, qa: task.qa || null, state: task.state }, null, 2));
  }

  async _acquireQa() { const slots = Math.max(1, Number(this.manifest.maxQa) || 1); this._qaActive = this._qaActive || 0; while (this._qaActive >= slots) await new Promise((resolvePromise) => this._qaWaiters.push(resolvePromise)); this._qaActive += 1; }
  _releaseQa() { this._qaActive = Math.max(0, (this._qaActive || 1) - 1); this._qaWaiters.shift()?.(); }

  // Run the first available runtime in the chain; a quota/rate-limit error falls through to the next one.
  // A quota error, a hang killed by the timeout ("exit null"), or output without a valid packet means this
  // runtime can't do the job right now: try the next one. Other failures are real and hold the task.
  async runChain(chain, request, validate = null) {
    const tried = []; const now = Date.now(); this._cooldown ??= {};
    // A model that just hit quota / timed out / was down goes to the back of the chain for COOLDOWN_MS instead of being tried first again.
    const ordered = [...chain.filter((id) => !(this._cooldown[id] > now)), ...chain.filter((id) => this._cooldown[id] > now)];
    const cool = (id) => { this._cooldown[id] = Date.now() + (this.cooldownMs ?? 30 * 60_000); };
    for (const id of ordered) {
      const adapter = this.runtimeAdapters[id];
      if (!adapter) { tried.push(`${id}: not configured`); continue; }
      const status = await adapter.availability();
      if (!status.ok) { tried.push(`${id}: ${status.reason}`); continue; }
      let result;
      try { result = await adapter.run(request); }
      catch (error) { const message = String(error.message || error); if (request.signal?.aborted || !(QUOTA_ERROR.test(message) || TRANSIENT_ERROR.test(message) || /exit null/.test(message))) throw error; cool(id); tried.push(`${id}: ${QUOTA_ERROR.test(message) ? "quota" : TRANSIENT_ERROR.test(message) ? "unavailable" : "timeout"}`); continue; }
      if (validate) { try { validate(result.text); } catch { tried.push(`${id}: invalid output`); if (id !== ordered.at(-1)) continue; } }
      return { ...result, runtime: id, fallbacks: tried };
    }
    throw new Error(`NO_RUNTIME_AVAILABLE: ${tried.join("; ")}`);
  }

  async runOne(task, state, { signal } = {}) {
    const project = this.manifest.projects.find((item) => item.id === task.projectId);
    const workerChain = chainOf(project?.runtime || project?.owner); const qaChain = chainOf(project?.qaRuntime || project?.runtime || project?.owner);
    let adapter = null; let availability = { ok: false, reason: "runtime adapter not configured" };
    for (const id of workerChain) { const candidate = this.runtimeAdapters[id]; if (!candidate) continue; const status = await candidate.availability(); availability = status; if (status.ok) { adapter = candidate; break; } }
    if (!definitions(project).some((definition) => definition.taskId === task.taskId)) { task.state = project?.state || "BLOCKED_SCOPE"; return; }
    if (!adapter || !availability.ok) { task.state = "BLOCKED_RUNTIME_ADAPTER"; task.error = availability.reason; return; }
    if (!Array.isArray(project.runtime)) { try { adapter.assertOwnership(project); } catch (error) { task.state = "BLOCKED_RUNTIME_ADAPTER"; task.error = error.message; return; } }
    const retained = task.builderEvidence?.workspace && existsSync(task.builderEvidence.workspace);
    const builder = retained ? { path: task.builderEvidence.workspace, base: task.builderEvidence.base || (await exec("git", ["-C", task.builderEvidence.workspace, "rev-parse", "HEAD"])).stdout.trim(), projectId: project.id, cleanup: async () => {} } : await this.worktrees.create(project, task.taskId);
    state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); task.state = "RUNNING"; task.attempts += 1; task.builderEvidence = { ...(task.builderEvidence || {}), workspace: builder.path, base: builder.base, startedAt: new Date().toISOString(), pid: null }; await this.save(state);
    let preserveWorktree = retained;
    try {
      for (;;) {
      const builderRun = await this.runChain(workerChain, { workspace: builder.path, sandbox: "workspace-write", prompt: builderPrompt({ ...task, projectId: project.id }), signal }, parseResultPacket);
      task.builderEvidence = { pid: builderRun.pid, workspace: builder.path, base: builder.base, startedAt: builderRun.startedAt, exitCode: builderRun.code, runtime: builderRun.runtime, fallbacks: builderRun.fallbacks };
      task.result = parseResultPacket(builderRun.text); await this.publishResult(task); if (task.result.status !== "IMPLEMENTED") { task.state = "HOLD"; break; } task.state = "QA"; state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); await this.save(state);
      await this._acquireQa();
      let qaRun;
      try { task.qaAttempts += 1; qaRun = await this.runChain(qaChain, { workspace: builder.path, sandbox: "read-only", prompt: qaPrompt(task, builder.base), signal }, parseQaPacket); }
      finally { this._releaseQa(); }
      task.qaEvidence = { pid: qaRun.pid, startedAt: qaRun.startedAt, exitCode: qaRun.code, runtime: qaRun.runtime, fallbacks: qaRun.fallbacks }; task.qa = parseQaPacket(qaRun.text); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId);
      if (task.qa.verdict === "ACCEPT" && !task.verificationOnly && this.testGate) {
        const headOf = () => exec("git", ["-C", builder.path, "rev-parse", "HEAD"]).then((result) => result.stdout.trim(), () => null);
        const head = await headOf();
        const gate = await this.testGate(builder.path, task.tests, { signal });
        const moved = head !== null && (await headOf()) !== head;
        task.testGate = { ok: gate.ok && !moved, results: gate.results.map(({ cmd, code }) => ({ cmd, code })), at: new Date().toISOString() };
        const failed = gate.results.find((result) => result.code !== 0);
        if (!task.testGate.ok) task.qa = { ...task.qa, verdict: "REQUEST_CHANGES", findings: [...(task.qa.findings || []), failed ? `TEST_GATE: \`${failed.cmd}\` exit ${failed.code}: ${failed.tail}` : "TEST_GATE: tests changed HEAD"] };
      }
      if (task.qa.verdict === "ACCEPT") { task.promotionRef = await this.worktrees.promote?.(project, task.taskId, task.result.commitSha, builder.path) || `candidate:${task.result.commitSha}`; if (this.worktrees.integrate && !task.verificationOnly) task.integration = await this.worktrees.integrate(project, task).catch((error) => ({ state: "NOT_INTEGRATED", reason: String(error.message || error).slice(0, 500) })); task.state = "VERIFIED_DONE"; await this.publishResult(task); if (project.autoContinue === false) { const pause = join(resolve(this.statePath, ".."), "lane-pause"); await mkdir(pause, { recursive: true }); await writeFile(join(pause, project.id), `${task.taskId} done ${new Date().toISOString()}\n`); } break; }
      if (task.qa.verdict === "REQUEST_CHANGES" && task.attempts < 3) { task.state = "REQUEST_CHANGES"; await this.publishResult(task); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); await this.save(state); task.state = "RUNNING"; task.attempts += 1; state.activeBuilders.push({ taskId: task.taskId, pid: null, workspace: builder.path, owner: "agent-relay", managed: true }); await this.save(state); continue; }
      if (task.qa.verdict === "FOUNDER_GATE") task.state = "FOUNDER_GATE"; else task.state = "HOLD"; await this.publishResult(task); break;
      }
    } catch (error) { if (signal?.aborted) { preserveWorktree = true; task.state = "RUNNING"; task.error = "CHECKPOINTED_DEADLINE"; } else if (runtimeLaunchFailure(error)) { task.state = "HOLD"; task.error = `RUNTIME_LAUNCH:${String(error.message || error)}`; } else { task.state = "HOLD"; task.error = String(error.message || error); } state.activeBuilders = state.activeBuilders.filter((item) => item.taskId !== task.taskId); state.activeQa = state.activeQa.filter((item) => item.taskId !== task.taskId); }
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
    const queued = state.tasks.filter((task) => task.state === "QUEUED").slice(0, Math.max(1, Number(this.manifest.maxBuilders) || 2));
    await Promise.all(queued.map((task) => this.runOne(task, state, { signal }))); state.service = "IDLE"; await this.save(state); return state;
  }

  // One continuous wave: lanes that finish start their next task while slower lanes keep running (runOnce waits for its
  // whole batch). Returns when nothing is in flight or queued. No new dispatch after `dispatchUntil` (Night Run freeze).
  async runWave({ signal, dispatchUntil = Infinity, intervalMs = 15_000 } = {}) {
    const inflight = new Map(); const state = await this.reconcile(); this._continuous = true;
    for (;;) {
      if (!signal?.aborted && Date.now() < Number(dispatchUntil) && !this.draining()) {
        const slots = Math.max(1, Number(this.manifest.maxBuilders) || 2) - inflight.size;
        for (const task of state.tasks.filter((item) => item.state === "QUEUED" && !inflight.has(item.taskId)).slice(0, Math.max(0, slots))) {
          inflight.set(task.taskId, this.runOne(task, state, { signal }).catch((error) => { if (!signal?.aborted) { task.state = "HOLD"; task.error = `RUNNER_ERROR: ${String(error?.message || error)}`; } }).finally(() => inflight.delete(task.taskId)));
        }
      }
      state.service = inflight.size ? "RUNNING" : "IDLE"; await this.save(state);
      if (!inflight.size) return state;
      await Promise.race([sleep(intervalMs), ...inflight.values()]);
      if (!signal?.aborted) { await this.reloadManifestIfChanged(); this.queueNext(state); await this.reconcileProjects(state); } // new WBS / plan approvals join mid-flight
    }
  }

  // `runner.drain` next to state.json: finish what is in flight, dispatch nothing new, then leave (the watchdog restarts on new code).
  draining() { return existsSync(join(resolve(this.statePath, ".."), "runner.drain")); }

  // Day runner (상시 자동화): waves back to back until stopped or drained.
  async runLoop({ intervalMs = 15_000, signal } = {}) {
    while (!signal?.aborted) {
      await this.runWave({ signal, intervalMs });
      if (this.draining()) { await rm(join(resolve(this.statePath, ".."), "runner.drain"), { force: true }); break; }
      await sleep(intervalMs);
    }
    return this.load();
  }
}

export async function loadManifest(path) { return JSON.parse(await readFile(path, "utf8")); }
