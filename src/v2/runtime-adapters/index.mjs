"use strict";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const known = (name) => process.env[`${name.toUpperCase()}_BIN`] || `${homedir()}/.local/bin/${name}`;

// Headless argument sets per CLI, verified on this machine 2026-09-23 (Worker commits in a temp repo, QA replies).
// Builders edit and run tools inside their own Agent Relay worktree; QA uses each tool's read-only/plan mode
// (the runner's own test gate executes the tests, so QA does not need write access).
const OPENCODE_FREE = process.env.AGENT_RELAY_OPENCODE_FREE_MODEL || "opencode/nemotron-3-ultra-free";
export const CLI_ARGS = {
  claude: ({ prompt, workspace, sandbox }) => sandbox === "read-only"
    ? ["-p", prompt, "--add-dir", workspace, "--output-format", "text", "--disallowedTools", "Edit", "Write", "NotebookEdit", "--allowedTools", "Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git status:*)"]
    : ["-p", prompt, "--add-dir", workspace, "--output-format", "text", "--permission-mode", "acceptEdits", "--allowedTools", "Bash(git:*)", "Bash(npm:*)", "Bash(npx:*)", "Bash(node:*)", "Bash(pnpm:*)", "Bash(python3:*)"],
  // QA uses OpenCode's built-in read-only "plan" agent; without --auto a headless run waits forever on a permission ask.
  opencode: ({ prompt, workspace, sandbox }) => sandbox === "read-only" ? ["run", "--dir", workspace, "--agent", "plan", "--auto", "-m", OPENCODE_FREE, prompt] : ["run", "--dir", workspace, "--auto", prompt],
  cursor: ({ prompt, sandbox }) => sandbox === "read-only" ? ["-p", "--trust", "--mode", "ask", "--output-format", "text", prompt] : ["-p", "--force", "--trust", "--output-format", "text", prompt],
  cline: ({ prompt, workspace, sandbox }) => sandbox === "read-only" ? ["--cwd", workspace, "-p", prompt] : ["--cwd", workspace, "--auto-approve", "true", prompt],
  // Free model through the installed OpenCode (Founder 2026-09-24: 무료 모델은 보조, 이미 있는 도구부터) — builds and reviews.
  "opencode-free": ({ prompt, workspace, sandbox }) => sandbox === "read-only" ? ["run", "--dir", workspace, "--agent", "plan", "--auto", "-m", OPENCODE_FREE, prompt] : ["run", "--dir", workspace, "--auto", "-m", OPENCODE_FREE, prompt],
  grok: ({ prompt, workspace, sandbox }) => ["--cwd", workspace, "--permission-mode", sandbox === "read-only" ? "plan" : "acceptEdits", "-p", prompt],
};

// This machine has no global git identity; Workers must still be able to commit in their worktree.
const GIT_IDENTITY = () => ({ GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Agent Relay Worker", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "agent-relay@localhost", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Agent Relay Worker", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "agent-relay@localhost" });

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
  constructor({ id, owner, runtime, command, probeArgs = ["--version"], safeNonInteractive = false, reason, buildArgs, env = {}, timeoutMs = 30 * 60_000 }) { super({ id, owner, runtime, available: false, reason }); this.command = command; this.probeArgs = probeArgs; this.safeNonInteractive = safeNonInteractive; this.buildArgs = buildArgs || CLI_ARGS.claude; this.env = env; this.timeoutMs = timeoutMs; this.children = new Set(); }
  async availability() {
    if (!this.command) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, reason: this.reason || "runtime command is not configured" };
    if (this.command.includes("/") && !existsSync(this.command)) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, reason: `runtime command missing: ${this.command}` };
    const result = await probe(this.command, this.probeArgs);
    if (!result.ok) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, command: this.command, reason: result.reason || result.output || "runtime readiness probe failed" };
    if (!this.safeNonInteractive) return { id: this.id, owner: this.owner, runtime: this.runtime, ok: false, command: this.command, identity: result.output, reason: this.reason || "safe non-interactive execution contract is not configured" };
    return { id: this.id, owner: this.owner, runtime: this.runtime, ok: true, command: this.command, identity: result.output };
  }
  async run({ workspace, prompt, sandbox, signal }) {
    const status = await this.availability();
    if (!status.ok) throw new Error(`${this.id} cannot execute: ${status.reason}`);
    const child = spawn(this.command, this.buildArgs({ prompt, workspace, sandbox }), { cwd: workspace, env: { ...process.env, ...GIT_IDENTITY(), ...this.env }, stdio: ["ignore", "pipe", "pipe"] });
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
  const cli = (id, command) => new CommandRuntimeAdapter({ id, owner: id, runtime: id, command, probeArgs: ["--version"], safeNonInteractive: true, buildArgs: CLI_ARGS[id] });
  const claudeAt = (id, dir) => new CommandRuntimeAdapter({ id, owner: id, runtime: id, command: commands.claude || process.env.CLAUDE_BIN || known("claude"), probeArgs: ["--help"], safeNonInteractive: true, buildArgs: CLI_ARGS.claude, env: { CLAUDE_CONFIG_DIR: dir } });
  return {
    codex: new CodexRuntimeAdapter(codex),
    opencode: cli("opencode", commands.opencode || process.env.OPENCODE_BIN || "/usr/local/bin/opencode"),
    "opencode-free": new CommandRuntimeAdapter({ id: "opencode-free", owner: "opencode", runtime: "opencode-free", command: commands.opencode || process.env.OPENCODE_BIN || "/usr/local/bin/opencode", probeArgs: ["--version"], safeNonInteractive: true, buildArgs: CLI_ARGS["opencode-free"] }),
    cline: cli("cline", commands.cline || process.env.CLINE_BIN || "/usr/local/bin/cline"),
    grok: cli("grok", commands.grok || process.env.GROK_BIN || `${homedir()}/.grok/bin/grok`),
    cursor: new CommandRuntimeAdapter({ id: "cursor", owner: "cursor", runtime: "cursor", command: commands.cursor || process.env.CURSOR_BIN || known("cursor-agent"), probeArgs: ["--version"], safeNonInteractive: true, buildArgs: CLI_ARGS.cursor }),
    claude: new CommandRuntimeAdapter({ id: "claude-code", owner: "claude", runtime: "claude", command: commands.claude || process.env.CLAUDE_BIN || known("claude"), probeArgs: ["--help"], safeNonInteractive: true, buildArgs: CLI_ARGS.claude, reason: "Claude Code authentication probe failed" }),
    "claude-team": claudeAt("claude-team", process.env.CLAUDE_TEAM_CONFIG_DIR || `${homedir()}/.claude-team`),
    "claude-pro": claudeAt("claude-pro", process.env.CLAUDE_PRO_CONFIG_DIR || `${homedir()}/.claude-pro`),
  };
}
