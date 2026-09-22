"use strict";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function probe(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolve({ ok: false, reason: error.message }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim(), code }));
  });
}

export class RuntimeAdapter {
  constructor({ id, owner, runtime, available = false, reason = "runtime adapter not configured" }) { this.id = id; this.owner = owner; this.runtime = runtime; this.available = available; this.reason = reason; }
  async availability() { return { id: this.id, owner: this.owner, runtime: this.runtime, ok: this.available, reason: this.available ? undefined : this.reason }; }
  assertOwnership(project) { if (!project || project.owner !== this.owner || (project.runtime && project.runtime !== this.runtime)) throw new Error(`runtime ownership mismatch: ${project?.id || "unknown"} -> ${this.id}`); }
  async bindWorkspace(project, workspace) { this.assertOwnership(project); return { workspace, projectId: project.id }; }
  async run() { throw new Error(`${this.id} cannot execute: ${this.reason}`); }
  async stop() {}
}

export class CodexRuntimeAdapter extends RuntimeAdapter {
  constructor(runtime) { super({ id: "codex", owner: "codex", runtime: "codex", available: true }); this.runtimeImpl = runtime; }
  async availability() { return { id: this.id, owner: this.owner, runtime: this.runtime, ok: true, command: this.runtimeImpl.command }; }
  async run(request) { return this.runtimeImpl.run(request); }
  async stop() { await this.runtimeImpl.stop?.(); }
}

export class CommandRuntimeAdapter extends RuntimeAdapter {
  constructor({ id, owner, runtime, command, probeArgs = ["--version"], safeNonInteractive = false, reason, buildArgs, timeoutMs = 30 * 60_000 }) { super({ id, owner, runtime, available: false, reason }); this.command = command; this.probeArgs = probeArgs; this.safeNonInteractive = safeNonInteractive; this.buildArgs = buildArgs || (({ prompt, workspace }) => ["-p", prompt, "--add-dir", workspace, "--output-format", "text"]); this.timeoutMs = timeoutMs; this.children = new Set(); }
  async availability() {
    if (!this.command) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, reason: this.reason || "runtime command is not configured" };
    if (this.command.includes("/") && !existsSync(this.command)) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, reason: `runtime command missing: ${this.command}` };
    const result = await probe(this.command, this.probeArgs);
    if (!result.ok) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, command: this.command, reason: result.reason || result.output || "runtime readiness probe failed" };
    if (!this.safeNonInteractive) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, command: this.command, identity: result.output, reason: this.reason || "safe non-interactive execution contract is not configured" };
    return { id: this.id, owner: this.owner, runtime: this.runtime, ok: true, command: this.command, identity: result.output };
  }
  async run({ workspace, prompt, signal }) {
    const status = await this.availability();
    if (!status.ok) throw new Error(`${this.id} cannot execute: ${status.reason}`);
    const child = spawn(this.command, this.buildArgs({ prompt, workspace }), { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    let text = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    const startedAt = new Date().toISOString();
    const abort = () => child.kill("SIGTERM"); signal?.addEventListener("abort", abort, { once: true });
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => child.kill("SIGTERM"), this.timeoutMs); child.once("error", reject); child.once("close", (code, exitSignal) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve({ code, signal: exitSignal }); }); });
    this.children.delete(child);
    if (result.code !== 0) throw new Error(`${this.id} exit ${result.code}: ${stderr.trim() || text.trim()}`);
    return { pid: child.pid, startedAt, ...result, text };
  }
  async stop({ graceMs = 1_000 } = {}) { const children = [...this.children]; for (const child of children) child.kill("SIGTERM"); await new Promise((resolve) => setTimeout(resolve, graceMs)); for (const child of children) { try { child.kill("SIGKILL"); } catch {} } this.children.clear(); }
}

export function createRuntimeAdapters({ codex, commands = {} } = {}) {
  return {
    codex: new CodexRuntimeAdapter(codex),
    cursor: new CommandRuntimeAdapter({ id: "cursor", owner: "cursor", runtime: "cursor", command: commands.cursor || process.env.CURSOR_BIN || "cursor", probeArgs: ["agent", "--help"], safeNonInteractive: true, buildArgs: ({ prompt }) => ["agent", "--trust", prompt] }),
    claude: new CommandRuntimeAdapter({ id: "claude-code", owner: "claude", runtime: "claude", command: commands.claude || process.env.CLAUDE_BIN || "claude", probeArgs: ["--help"], reason: "Claude Code authentication probe failed: OAuth session expired and could not be refreshed" }),
    "claude-team": new CommandRuntimeAdapter({ id: "claude-team", owner: "claude-team", runtime: "claude-team", command: commands.claudeTeam || process.env.CLAUDE_TEAM_BIN || "", reason: "Claude Team runtime adapter is not configured" }),
  };
}
