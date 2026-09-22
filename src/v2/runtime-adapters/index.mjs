"use strict";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

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

function shellResolve(command) {
  return new Promise((resolve) => {
    if (!command) return resolve(null);
    if (command.includes("/")) return resolve(existsSync(command) ? command : null);

    const safe = command.replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!safe) return resolve(null);

    const child = spawn("bash", ["-lic", `type -P ${safe} 2>/dev/null || true`], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", () => resolve(null));
    child.once("close", () => resolve(output.trim().split(/\r?\n/).filter(Boolean).pop() || null));
  });
}

export class RuntimeAdapter {
  constructor({ id, owner, runtime, available = false, reason = "runtime adapter not configured" }) {
    this.id = id;
    this.owner = owner;
    this.runtime = runtime;
    this.available = available;
    this.reason = reason;
  }
  async availability() {
    return { id: this.id, owner: this.owner, runtime: this.runtime, ok: this.available, reason: this.available ? undefined : this.reason };
  }
  assertOwnership(project) {
    if (!project || project.owner !== this.owner || (project.runtime && project.runtime !== this.runtime)) {
      throw new Error(`runtime ownership mismatch: ${project?.id || "unknown"} -> ${this.id}`);
    }
  }
  async bindWorkspace(project, workspace) {
    this.assertOwnership(project);
    return { workspace, projectId: project.id };
  }
  async run() { throw new Error(`${this.id} cannot execute: ${this.reason}`); }
  async stop() {}
}

export class CodexRuntimeAdapter extends RuntimeAdapter {
  constructor(runtime) {
    super({ id: "codex", owner: "codex", runtime: "codex", available: true });
    this.runtimeImpl = runtime;
  }
  async availability() {
    return { id: this.id, owner: this.owner, runtime: this.runtime, ok: true, command: this.runtimeImpl.command };
  }
  async run(request) { return this.runtimeImpl.run(request); }
  async stop() {}
}

export class CommandRuntimeAdapter extends RuntimeAdapter {
  constructor({
    id,
    owner,
    runtime,
    command,
    commands,
    probeArgs = ["--version"],
    safeNonInteractive = false,
    reason,
    buildArgs,
    timeoutMs = 30 * 60_000,
  }) {
    super({ id, owner, runtime, available: false, reason });
    this.commands = [...new Set([command, ...(commands || [])].filter(Boolean))];
    this.probeArgs = probeArgs;
    this.safeNonInteractive = safeNonInteractive;
    this.buildArgs = buildArgs || (({ prompt, workspace }) => ["-p", prompt, "--add-dir", workspace, "--output-format", "text"]);
    this.timeoutMs = timeoutMs;
    this.children = new Set();
    this.resolvedCommand = null;
  }

  async resolveCommand() {
    if (this.resolvedCommand && existsSync(this.resolvedCommand)) return this.resolvedCommand;
    for (const candidate of this.commands) {
      const resolved = await shellResolve(candidate);
      if (resolved) {
        this.resolvedCommand = resolved;
        return resolved;
      }
    }
    return null;
  }

  async availability() {
    const command = await this.resolveCommand();
    if (!command) {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        reason: this.reason || `runtime command not found: ${this.commands.join(" | ")}`,
      };
    }

    const result = await probe(command, this.probeArgs);
    if (!result.ok) {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        command,
        reason: result.reason || result.output || "runtime readiness probe failed",
      };
    }

    if (!this.safeNonInteractive) {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        command,
        identity: result.output,
        reason: this.reason || "safe non-interactive execution contract is not configured",
      };
    }

    return {
      id: this.id,
      owner: this.owner,
      runtime: this.runtime,
      ok: true,
      command,
      identity: result.output,
    };
  }

  async run({ workspace, prompt, sandbox }) {
    const status = await this.availability();
    if (!status.ok) throw new Error(`${this.id} cannot execute: ${status.reason}`);

    const args = this.buildArgs({
      prompt,
      workspace,
      sandbox,
      command: status.command,
      executable: basename(status.command),
    });
    const child = spawn(status.command, args, {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);

    let text = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const startedAt = new Date().toISOString();

    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGTERM"), this.timeoutMs);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    this.children.delete(child);
    if (result.code !== 0) {
      throw new Error(`${this.id} exit ${result.code}: ${stderr.trim() || text.trim()}`);
    }
    if (!text.trim()) throw new Error(`${this.id} produced no packet`);
    return { pid: child.pid, startedAt, ...result, text };
  }

  async stop() {
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
  }
}

export function createRuntimeAdapters({ codex, commands = {} } = {}) {
  return {
    codex: new CodexRuntimeAdapter(codex),
    cursor: new CommandRuntimeAdapter({
      id: "cursor",
      owner: "cursor",
      runtime: "cursor",
      command: commands.cursor || process.env.CURSOR_BIN,
      commands: ["agent", "cursor-agent", "cursor"],
      probeArgs: ["--help"],
      safeNonInteractive: true,
      buildArgs: ({ prompt, executable }) =>
        executable === "cursor"
          ? ["agent", "-p", prompt, "--output-format", "text"]
          : ["-p", prompt, "--output-format", "text"],
    }),
    claude: new CommandRuntimeAdapter({
      id: "claude-code",
      owner: "claude",
      runtime: "claude",
      command: commands.claude || process.env.CLAUDE_BIN,
      commands: ["claude"],
      probeArgs: ["--version"],
      safeNonInteractive: true,
      reason: "Claude Code executable/authentication unavailable",
    }),
    "claude-team": new CommandRuntimeAdapter({
      id: "claude-team",
      owner: "claude-team",
      runtime: "claude-team",
      command: commands.claudeTeam || process.env.CLAUDE_TEAM_BIN || process.env.CLAUDE_BIN,
      commands: ["claude"],
      probeArgs: ["--version"],
      safeNonInteractive: true,
      reason: "Claude Code Team executable/authentication unavailable",
    }),
  };
}
