"use strict";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

function safeCommand(command) {
  if (!command || typeof command !== "string") return null;
  if (command.includes("/")) return `'${command.replace(/'/g, `'\\''`)}'`;
  return /^[a-zA-Z0-9_.-]+$/.test(command) ? command : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function shellProbe(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const executable = safeCommand(command);
    if (!executable) {
      resolve({ ok: false, reason: `invalid runtime command: ${command}` });
      return;
    }

    const argv = args.map(shellQuote).join(" ");
    const script = `command -v ${executable} >/dev/null 2>&1 || exit 127; ${executable}${argv ? ` ${argv}` : ""}`;
    const child = spawn("bash", ["-lic", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => resolve({ ok: false, reason: error.message }));
    child.once("close", (code) => resolve({ ok: code === 0, output: output.trim(), code }));
  });
}

export async function runCodexViaLoginShell({
  command = process.env.CODEX_BIN || "codex",
  workspace,
  prompt,
  sandbox,
  timeoutMs = 30 * 60_000,
}) {
  const commandToken = safeCommand(command);
  if (!commandToken) throw new Error(`invalid Codex command: ${command}`);

  const probe = await shellProbe(command, ["--version"]);
  if (!probe.ok) {
    throw new Error(`Codex runtime unavailable: ${probe.reason || probe.output || command}`);
  }

  // Keep transient CLI output outside the managed Git worktree. A crashed/killed
  // runtime must never make the parent project checkout appear dirty.
  const output = join(tmpdir(), `agent-relay-${sandbox}-${randomUUID()}.txt`);
  const args = [
    "exec",
    "--ephemeral",
    ...(sandbox === "workspace-write" ? ["--approve-for-me"] : ["--sandbox", sandbox]),
    "--skip-git-repo-check",
    "--cd",
    workspace,
    "--json",
    "-o",
    output,
    "-",
  ];
  const script = `${commandToken} ${args.map(shellQuote).join(" ")}`;
  const child = spawn("bash", ["-lic", script], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const startedAt = new Date().toISOString();
  child.stdin.end(prompt);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  const text = existsSync(output) ? await readFile(output, "utf8") : "";
  await unlink(output).catch(() => {});

  if (result.code !== 0) {
    throw new Error(`Codex ${sandbox} exit ${result.code}: ${stderr.trim() || stdout.trim()}`);
  }
  if (!text.trim()) throw new Error(`Codex ${sandbox} produced no packet`);
  return { pid: child.pid, startedAt, ...result, text };
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
    return {
      id: this.id,
      owner: this.owner,
      runtime: this.runtime,
      ok: this.available,
      reason: this.available ? undefined : this.reason,
    };
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
    if (!this.runtimeImpl || typeof this.runtimeImpl.run !== "function") {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        reason: "Codex runtime implementation is missing",
      };
    }

    // Production wrappers opt into a real login-shell readiness probe. Injected
    // runtimes used by tests/dogfood remain first-class and must not be replaced
    // by a process-spawn fallback, otherwise runtime injection stops being deterministic.
    if (this.runtimeImpl.managedLoginShell === true) {
      const result = await shellProbe(this.runtimeImpl.command, ["--version"]);
      return result.ok
        ? { id: this.id, owner: this.owner, runtime: this.runtime, ok: true, command: this.runtimeImpl.command, identity: result.output }
        : { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, command: this.runtimeImpl.command, reason: result.reason || result.output || "Codex runtime unavailable" };
    }

    return {
      id: this.id,
      owner: this.owner,
      runtime: this.runtime,
      ok: true,
      command: this.runtimeImpl.command || "injected",
      injected: true,
    };
  }

  async run(request) {
    return this.runtimeImpl.run(request);
  }

  async stop() {
    await this.runtimeImpl?.stop?.();
  }
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
    buildShell,
    timeoutMs = 30 * 60_000,
  }) {
    super({ id, owner, runtime, available: false, reason });
    this.commands = [...new Set([command, ...(commands || [])].filter(Boolean))];
    this.probeArgs = probeArgs;
    this.safeNonInteractive = safeNonInteractive;
    this.buildShell = buildShell;
    this.timeoutMs = timeoutMs;
    this.children = new Set();
    this.resolvedCommand = null;
  }

  async resolveCommand() {
    if (this.resolvedCommand) {
      const cached = await shellProbe(this.resolvedCommand, this.probeArgs);
      if (cached.ok) return { command: this.resolvedCommand, probe: cached };
      this.resolvedCommand = null;
    }

    for (const candidate of this.commands) {
      const result = await shellProbe(candidate, this.probeArgs);
      if (result.ok) {
        this.resolvedCommand = candidate;
        return { command: candidate, probe: result };
      }
    }

    return null;
  }

  async availability() {
    const resolved = await this.resolveCommand();
    if (!resolved) {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        reason: this.reason || `runtime command not found in login shell: ${this.commands.join(" | ")}`,
      };
    }

    if (!this.safeNonInteractive) {
      return {
        id: this.id,
        owner: this.owner,
        runtime: this.runtime,
        ok: false,
        command: resolved.command,
        identity: resolved.probe.output,
        reason: this.reason || "safe non-interactive execution contract is not configured",
      };
    }

    return {
      id: this.id,
      owner: this.owner,
      runtime: this.runtime,
      ok: true,
      command: resolved.command,
      identity: resolved.probe.output,
    };
  }

  async run({ workspace, prompt, sandbox }) {
    const status = await this.availability();
    if (!status.ok) throw new Error(`${this.id} cannot execute: ${status.reason}`);

    const executable = basename(status.command);
    const commandToken = safeCommand(status.command);
    const script = this.buildShell
      ? this.buildShell({ command: commandToken, executable, sandbox })
      : `${commandToken} -p "$AGENT_RELAY_PROMPT" --add-dir "$AGENT_RELAY_WORKSPACE" --output-format text`;

    const child = spawn("bash", ["-lic", script], {
      cwd: workspace,
      env: {
        ...process.env,
        AGENT_RELAY_PROMPT: prompt,
        AGENT_RELAY_WORKSPACE: workspace,
      },
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
      buildShell: ({ command, executable }) =>
        executable === "cursor"
          ? `${command} agent -p "$AGENT_RELAY_PROMPT" --output-format text`
          : `${command} -p "$AGENT_RELAY_PROMPT" --output-format text`,
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
      buildShell: ({ command }) => `${command} -p "$AGENT_RELAY_PROMPT" --add-dir "$AGENT_RELAY_WORKSPACE" --output-format text`,
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
      buildShell: ({ command }) => `${command} -p "$AGENT_RELAY_PROMPT" --add-dir "$AGENT_RELAY_WORKSPACE" --output-format text`,
    }),
  };
}
