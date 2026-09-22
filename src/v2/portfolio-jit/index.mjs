/**
 * Agent Relay V2 — Portfolio JIT Scheduler (candidate).
 *
 * Does NOT claim V1 Stable already has these capabilities.
 * Certified V1 Stable remains untouched on ASUS:
 *   df03ebdacabba1ae95b91d916239927d65b023f7
 *
 * Model:
 *   Project Registry → Work Queue → Runtime Need → JIT Agent Start
 *   → Task → Result → QA if required → Agent Stop → next project
 */
"use strict";

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const RUNTIME_STATES = Object.freeze([
  "OFF",
  "STARTING",
  "READY",
  "BUSY",
  "DEGRADED",
  "STOPPING",
]);

export const MAX_ACTIVE_RUNTIMES = 2;

const CODEX_MARKER = /^[A-Z0-9_:-]+$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runProcess(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(result.stderr || `${command} exit ${code}`), result));
    });
  });
}

function normalizeRepository(repository) {
  const value = String(repository).replace(/\/$/, "");
  return /^(https?:\/\/|ssh:\/\/|git@)/.test(value) ? value.replace(/\.git$/, "") : value;
}

export function normalizeTarget(target) {
  if (!target || target.workspaceMode !== "READ_ONLY_QA") throw new Error("unsupported workspace mode");
  for (const field of ["projectId", "repository", "ref", "expectedHeadSha"]) {
    if (!String(target[field] || "").trim()) throw new Error(`target missing ${field}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(target.expectedHeadSha)) throw new Error("target expectedHeadSha invalid");
  if (target.implementationSha && !/^[0-9a-f]{40}$/i.test(target.implementationSha)) throw new Error("target implementationSha invalid");
  return { ...target, repository: normalizeRepository(target.repository), workspaceMode: "READ_ONLY_QA" };
}

async function walkDirectories(roots, depth = 2) {
  const found = [];
  async function visit(path, remaining) {
    if (remaining < 0) return;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some((entry) => entry.name === ".git")) found.push(path);
      if (remaining === 0) return;
      await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => visit(join(path, entry.name), remaining - 1)));
    } catch {
      /* inaccessible candidates are not safe candidates */
    }
  }
  await Promise.all(roots.map((root) => visit(root, depth)));
  return found;
}

export class TargetResolver {
  /** @param {{roots?: string[], tempRoot?: string, git?: Function}} [opts] */
  constructor(opts = {}) {
    this.roots = opts.roots || [];
    this.tempRoot = opts.tempRoot || tmpdir();
    this.git = opts.git || ((cwd, args) => runProcess("git", ["-C", cwd, ...args]));
  }

  async _inspect(path) {
    try {
      const remote = await this.git(path, ["remote", "get-url", "origin"]);
      const status = await this.git(path, ["status", "--porcelain"]);
      const branch = await this.git(path, ["branch", "--show-current"]);
      const head = await this.git(path, ["rev-parse", "HEAD"]);
      return {
        path,
        repository: normalizeRepository(remote.stdout),
        status: status.stdout,
        ref: branch.stdout,
        head: head.stdout,
      };
    } catch {
      return null;
    }
  }

  async _verify(path, target) {
    const inspection = await this._inspect(path);
    let refMatches = inspection?.ref === target.ref;
    if (inspection && !refMatches && !inspection.ref) {
      try { refMatches = (await this.git(path, ["rev-parse", `refs/remotes/origin/${target.ref}`])).stdout === target.expectedHeadSha; }
      catch { refMatches = false; }
    }
    if (!inspection || inspection.repository !== target.repository || !refMatches || inspection.head !== target.expectedHeadSha || inspection.status) return null;
    if (target.implementationSha) {
      try { await this.git(path, ["merge-base", "--is-ancestor", target.implementationSha, target.expectedHeadSha]); }
      catch { return null; }
    }
    return { ...inspection, temporary: false, workspaceMode: target.workspaceMode };
  }

  async resolve(rawTarget) {
    const target = normalizeTarget(rawTarget);
    const candidates = await walkDirectories(this.roots);
    for (const candidate of candidates) {
      const verified = await this._verify(candidate, target);
      if (verified) return { target, ...verified, cleanup: async () => {} };
    }

    const workspace = await mkdtemp(join(this.tempRoot, `agent-relay-${target.projectId}-qa-`));
    let keep = false;
    try {
      await runProcess("git", ["clone", "--no-checkout", "--branch", target.ref, target.repository, workspace]);
      await this.git(workspace, ["checkout", "--detach", target.expectedHeadSha]);
      const verified = await this._verify(workspace, target);
      if (!verified) throw new Error("target identity/ref/SHA/clean baseline verification failed");
      keep = true;
      return { target, ...verified, ref: target.ref, path: workspace, temporary: true, cleanup: async () => rm(workspace, { recursive: true, force: true }) };
    } finally {
      if (!keep) await rm(workspace, { recursive: true, force: true });
    }
  }

  async runReadOnlyQa(rawTarget, qa) {
    const resolved = await this.resolve(rawTarget);
    const before = (await this.git(resolved.path, ["status", "--porcelain"])).stdout;
    let result;
    let qaError;
    try {
      result = await qa(resolved);
    } catch (error) {
      qaError = error;
    }
    try {
      const after = (await this.git(resolved.path, ["status", "--porcelain"])).stdout;
      if (after || after !== before) throw new Error("READ_ONLY_QA target production modification detected");
      if (qaError) throw qaError;
      return { ...result, beforeStatus: before, afterStatus: after, targetProductionDiff: "" };
    } finally {
      await resolved.cleanup();
    }
  }
}

function commandVersion(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `version probe exit ${code}`)));
  });
}

function resolveCommand(command) {
  if (command.includes("/")) return realpathSync(command);
  for (const directory of (process.env.PATH || "").split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`runtime identity uncertain: ${command} not found on PATH`);
}

/** Real, disposable Codex CLI runtime. It never dispatches before identity and readiness pass. */
export class CodexRuntimeAdapter {
  /** @param {{command?: string, timeoutMs?: number}} [opts] */
  constructor(opts = {}) {
    this.command = opts.command || process.env.CODEX_BIN || "codex";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async start(need) {
    const executable = resolveCommand(this.command);
    const version = await commandVersion(executable);
    if (!/^codex-cli\s+\S+$/i.test(version)) throw new Error("runtime identity uncertain: Codex CLI version missing");
    const workspace = await mkdtemp(join(tmpdir(), "agent-relay-codex-"));
    const outputFile = join(workspace, "result.txt");
    const child = spawn(executable, [
      "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check",
      "--cd", workspace, "--json", "-o", outputFile, "-",
    ], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
    const runtime = {
      id: `codex-${child.pid}`,
      provider: "codex",
      state: "STARTING",
      projectId: need.projectId,
      pid: child.pid,
      executable,
      version,
      workspace,
      outputFile,
      child,
      stdout: "",
      stderr: "",
      exit: null,
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { runtime.stdout += chunk; });
    child.stderr.on("data", (chunk) => { runtime.stderr += chunk; });
    child.once("exit", (code, signal) => { runtime.exit = { code, signal }; });
    return runtime;
  }

  async ready(runtime) {
    if (!runtime.pid || !runtime.child || runtime.child.exitCode !== null) {
      throw new Error("runtime readiness uncertain: process is not alive");
    }
    const procExe = `/proc/${runtime.pid}/exe`;
    if (!existsSync(procExe) || (await realpath(procExe)) !== runtime.executable) {
      throw new Error("runtime identity uncertain: process executable mismatch");
    }
    const procCwd = `/proc/${runtime.pid}/cwd`;
    if (!existsSync(procCwd) || (await realpath(procCwd)) !== runtime.workspace) {
      throw new Error("runtime cwd uncertain: process workspace mismatch");
    }
    runtime.state = "READY";
    return true;
  }

  async dispatch(runtime, task) {
    if (!(await this.ready(runtime))) throw new Error("runtime readiness uncertain");
    const marker = String(task.goal || "").trim();
    if (!CODEX_MARKER.test(marker)) throw new Error("invalid harmless marker");
    runtime.expectedMarker = marker;
    runtime.child.stdin.end(`Reply with exactly this marker only: ${marker}\nDo not modify files or run commands.\n`);
    return { sendAck: true };
  }

  async collect(runtime) {
    const deadline = Date.now() + this.timeoutMs;
    while (runtime.exit === null && Date.now() < deadline) await sleep(100);
    if (runtime.exit === null) throw new Error("transport: Codex result timeout");
    const resultText = (await readFile(runtime.outputFile, "utf8")).trim();
    if (resultText !== runtime.expectedMarker) throw new Error("transport: exact marker result mismatch");
    return { ok: true, resultText, sendAck: true, resultAck: true };
  }

  async stop(runtime) {
    if (runtime.child && runtime.exit === null) {
      runtime.child.kill("SIGTERM");
      const deadline = Date.now() + 5_000;
      while (runtime.exit === null && Date.now() < deadline) await sleep(25);
      if (runtime.exit === null) runtime.child.kill("SIGKILL");
    }
    await this.cleanup(runtime);
  }

  async cleanup(runtime) {
    if (runtime.workspace) await rm(runtime.workspace, { recursive: true, force: true });
  }
}

export const FAILURE_CLASS = Object.freeze({
  PRODUCT: "PRODUCT",
  PROVIDER_429: "PROVIDER_429",
  QUOTA: "QUOTA",
  CAPACITY: "CAPACITY",
  RUNTIME_CRASH: "RUNTIME_CRASH",
  TRANSPORT: "TRANSPORT",
  UNKNOWN: "UNKNOWN",
});

/**
 * @param {unknown} err
 * @returns {string}
 */
export function classifyFailure(err) {
  const text = String(err && /** @type {{message?: string}} */ (err).message ? /** @type {{message:string}} */ (err).message : err).toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(text)) return FAILURE_CLASS.PROVIDER_429;
  if (/quota|billing|insufficient.?credit/.test(text)) return FAILURE_CLASS.QUOTA;
  if (/capacity|no.?slot|resource.?exhausted|overloaded/.test(text)) return FAILURE_CLASS.CAPACITY;
  if (/crash|segfault|exit.?code|process.?died|killed/.test(text)) return FAILURE_CLASS.RUNTIME_CRASH;
  if (/transport|ssh|timeout|econn|socket/.test(text)) return FAILURE_CLASS.TRANSPORT;
  if (/assert|product|logic|invalid.?task/.test(text)) return FAILURE_CLASS.PRODUCT;
  return FAILURE_CLASS.UNKNOWN;
}

/**
 * Failures that must trigger failover — never falsely fail the Product Task.
 * @param {string} klass
 */
export function isFailoverFailure(klass) {
  return (
    klass === FAILURE_CLASS.PROVIDER_429 ||
    klass === FAILURE_CLASS.QUOTA ||
    klass === FAILURE_CLASS.CAPACITY ||
    klass === FAILURE_CLASS.RUNTIME_CRASH ||
    klass === FAILURE_CLASS.TRANSPORT
  );
}

export class ProjectRegistry {
  constructor() {
    /** @type {Map<string, {id: string, name: string, priority: number, provider?: string, stableSha?: string, candidateSha?: string}>} */
    this._projects = new Map();
  }

  /**
   * @param {{id: string, name: string, priority?: number, provider?: string, stableSha?: string, candidateSha?: string}} project
   */
  upsert(project) {
    const priority = Number.isFinite(project.priority) ? /** @type {number} */ (project.priority) : 100;
    this._projects.set(project.id, {
      id: project.id,
      name: project.name,
      priority,
      provider: project.provider,
      stableSha: project.stableSha,
      candidateSha: project.candidateSha,
    });
    return this._projects.get(project.id);
  }

  get(id) {
    return this._projects.get(id) || null;
  }

  list() {
    return [...this._projects.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
}

export class WorkQueue {
  constructor() {
    /** @type {Array<{id: string, projectId: string, goal: string, priority: number, createdAt: number, state: string}>} */
    this._items = [];
    this._seq = 0;
  }

  /**
   * @param {{projectId: string, goal: string, priority?: number}} task
   */
  enqueue(task) {
    this._seq += 1;
    const item = {
      id: `task-${this._seq}`,
      projectId: task.projectId,
      goal: task.goal,
      priority: Number.isFinite(task.priority) ? /** @type {number} */ (task.priority) : 100,
      createdAt: Date.now(),
      state: "QUEUED",
    };
    this._items.push(item);
    this._items.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    return { ...item };
  }

  peek() {
    return this._items.find((t) => t.state === "QUEUED") || null;
  }

  /** @param {string} id */
  mark(id, state) {
    const item = this._items.find((t) => t.id === id);
    if (item) item.state = state;
    return item ? { ...item } : null;
  }

  list() {
    return this._items.map((t) => ({ ...t }));
  }
}

/**
 * Runtime allocator — injectable for tests or a real provider adapter.
 */
export class RuntimeAllocator {
  /**
   * @param {{
   *   maxActive?: number,
   *   startRuntime?: (need: object) => Promise<object>,
   *   stopRuntime?: (runtime: object) => Promise<void>,
   *   sendTask?: (runtime: object, task: object) => Promise<object>,
   *   adapter?: {start: Function, ready?: Function, dispatch?: Function, collect?: Function, stop?: Function, cleanup?: Function},
   * }} [opts]
   */
  constructor(opts = {}) {
    this.maxActive = Math.min(opts.maxActive ?? MAX_ACTIVE_RUNTIMES, MAX_ACTIVE_RUNTIMES);
    this.adapter = opts.adapter || null;
    this._start = opts.startRuntime || (async (need) => this.adapter?.start?.(need) || ({
      id: `rt-${need.projectId}-${Date.now()}`,
      provider: need.provider || "mock",
      state: "READY",
      projectId: need.projectId,
    }));
    this._stop = opts.stopRuntime || (async (runtime) => this.adapter?.stop?.(runtime));
    this._send = opts.sendTask || (async (runtime, task) => {
      if (this.adapter?.dispatch && this.adapter?.collect) {
        await this.adapter.dispatch(runtime, task);
        return this.adapter.collect(runtime, task);
      }
      return {
      ok: true,
      resultText: `ACK:${task.id}`,
      sendAck: true,
      resultAck: true,
      };
    });
    /** @type {Map<string, object>} */
    this._runtimes = new Map();
  }

  activeCount() {
    let n = 0;
    for (const rt of this._runtimes.values()) {
      if (rt.state !== "OFF" && rt.state !== "STOPPING") n += 1;
    }
    return n;
  }

  list() {
    return [...this._runtimes.values()].map((r) => ({ ...r }));
  }

  /**
   * @param {{projectId: string, provider?: string}} need
   */
  async allocate(need) {
    if (this.activeCount() >= this.maxActive) {
      const err = new Error("capacity: no runtime slot");
      /** @type {any} */ (err).failureClass = FAILURE_CLASS.CAPACITY;
      throw err;
    }
    const starting = {
      id: `starting-${need.projectId}`,
      provider: need.provider || "mock",
      state: "STARTING",
      projectId: need.projectId,
    };
    this._runtimes.set(starting.id, starting);
    let started = starting;
    try {
      const ready = started = await this._start(need);
      if (this.adapter?.ready && !(await this.adapter.ready(ready))) throw new Error("runtime readiness uncertain");
      ready.state = ready.state || "READY";
      this._runtimes.delete(starting.id);
      this._runtimes.set(ready.id, ready);
      return ready;
    } catch (err) {
      this._runtimes.delete(starting.id);
      try {
        if (this.adapter?.stop && started !== starting) await this.adapter.stop(started);
        else if (this.adapter?.cleanup) await this.adapter.cleanup(started);
      } catch {
        /* preserve the original fail-closed allocation error */
      }
      throw err;
    }
  }

  /** @param {object} runtime */
  async release(runtime) {
    const rt = this._runtimes.get(runtime.id);
    if (!rt) return;
    rt.state = "STOPPING";
    try {
      await this._stop(rt);
    } finally {
      rt.state = "OFF";
      this._runtimes.delete(rt.id);
    }
  }

  /**
   * @param {object} runtime
   * @param {object} task
   */
  async send(runtime, task) {
    runtime.state = "BUSY";
    try {
      const result = await this._send(runtime, task);
      runtime.state = "READY";
      return result;
    } catch (err) {
      runtime.state = "DEGRADED";
      throw err;
    }
  }
}

export class PortfolioJitScheduler {
  /**
   * @param {{
   *   registry?: ProjectRegistry,
   *   queue?: WorkQueue,
   *   allocator?: RuntimeAllocator,
   *   maxActive?: number,
   *   runtimeProvider?: string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.registry = opts.registry || new ProjectRegistry();
    this.queue = opts.queue || new WorkQueue();
    this.allocator = opts.allocator || new RuntimeAllocator({ maxActive: opts.maxActive ?? MAX_ACTIVE_RUNTIMES });
    this.runtimeProvider = opts.runtimeProvider || "mock";
    this._busy = false;
    this._lastStatus = this._emptyStatus();
    this._history = [];
  }

  _emptyStatus() {
    return {
      schema: "agent-relay.v2.portfolio-jit.status.v1",
      scheduler: "IDLE",
      currentTask: null,
      currentAgent: null,
      runtimeState: "OFF",
      qaState: "NONE",
      result: null,
      human: "대기 중 — 큐에 작업 없음",
      activeRuntimes: 0,
      maxActiveRuntimes: this.allocator.maxActive,
      projects: [],
      queue: [],
      failovers: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Human + JSON status suitable for JuControler adapters.
   */
  status() {
    const snap = {
      ...this._lastStatus,
      projects: this.registry.list(),
      queue: this.queue.list(),
      activeRuntimes: this.allocator.activeCount(),
      runtimes: this.allocator.list(),
      updatedAt: new Date().toISOString(),
    };
    return snap;
  }

  /**
   * One-task-at-a-time portfolio step.
   * Provider/runtime failures trigger failover attempts; only PRODUCT fails the task.
   * @param {{maxFailovers?: number}} [opts]
   */
  async tick(opts = {}) {
    if (this._busy) {
      return { skipped: true, reason: "scheduler_busy", status: this.status() };
    }
    const task = this.queue.peek();
    if (!task) {
      this._lastStatus = {
        ...this._emptyStatus(),
        human: "대기 중 — 큐에 작업 없음",
        projects: this.registry.list(),
        queue: this.queue.list(),
      };
      return { skipped: true, reason: "empty_queue", status: this.status() };
    }
    const project = this.registry.get(task.projectId);
    if (!project) {
      this.queue.mark(task.id, "FAILED_PRODUCT");
      this._lastStatus = {
        ...this._emptyStatus(),
        scheduler: "ERROR",
        currentTask: task,
        human: `프로젝트 없음: ${task.projectId}`,
        result: { ok: false, failureClass: FAILURE_CLASS.PRODUCT },
      };
      return { ok: false, failureClass: FAILURE_CLASS.PRODUCT, status: this.status() };
    }

    this._busy = true;
    this.queue.mark(task.id, "RUNNING");
    const maxFailovers = opts.maxFailovers ?? 2;
    let failovers = 0;
    let lastErr = null;
    /** @type {object | null} */
    let runtime = null;

    try {
      while (failovers <= maxFailovers) {
        try {
          this._lastStatus = {
            ...this._emptyStatus(),
            scheduler: "RUNNING",
            currentTask: { ...task, projectName: project.name },
            runtimeState: "STARTING",
            human: `런타임 시작 중 — ${project.name}`,
            failovers,
          };
          runtime = await this.allocator.allocate({
            projectId: project.id,
            provider: project.provider || this.runtimeProvider,
          });
          this._lastStatus.currentAgent = { id: runtime.id, provider: runtime.provider };
          this._lastStatus.runtimeState = runtime.state;
          this._lastStatus.human = `전송 중 — ${project.name} / ${task.id}`;

          const sendResult = await this.allocator.send(runtime, task);
          if (!sendResult || !sendResult.sendAck) {
            throw new Error("transport: SEND acknowledgement missing");
          }
          if (!sendResult.resultAck) {
            throw new Error("transport: result acknowledgement missing");
          }

          this.queue.mark(task.id, "DONE");
          await this.allocator.release(runtime);
          runtime = null;
          this._lastStatus = {
            ...this._emptyStatus(),
            scheduler: "IDLE",
            currentTask: { ...task, state: "DONE", projectName: project.name },
            currentAgent: null,
            runtimeState: "OFF",
            qaState: "PENDING",
            result: {
              ok: true,
              text: sendResult.resultText || "",
              sendAck: true,
              resultAck: true,
            },
            human: `완료 — ${project.name} · 결과 수신됨 (QA_PENDING)`,
            failovers,
            founderGate: "CANDIDATE_READY",
          };
          this._history.push({ taskId: task.id, ok: true, at: Date.now() });
          return { ok: true, status: this.status() };
        } catch (err) {
          lastErr = err;
          const klass = /** @type {any} */ (err).failureClass || classifyFailure(err);
          if (runtime) {
            try {
              await this.allocator.release(runtime);
            } catch {
              /* ignore release errors during failover */
            }
            runtime = null;
          }
          if (isFailoverFailure(klass) && failovers < maxFailovers) {
            failovers += 1;
            this._lastStatus = {
              ...this._emptyStatus(),
              scheduler: "FAILOVER",
              currentTask: { ...task, projectName: project.name },
              human: `런타임 장애 페일오버 (${klass}) — 재시도 ${failovers}/${maxFailovers}`,
              failovers,
              result: { ok: false, failureClass: klass, failover: true },
            };
            continue;
          }
          // PRODUCT or exhausted failovers
          this.queue.mark(task.id, klass === FAILURE_CLASS.PRODUCT ? "FAILED_PRODUCT" : "FAILED_RUNTIME");
          this._lastStatus = {
            ...this._emptyStatus(),
            scheduler: "ERROR",
            currentTask: { ...task, projectName: project.name },
            human:
              klass === FAILURE_CLASS.PRODUCT
                ? `제품 작업 실패 — ${project.name}`
                : `런타임 장애로 중단 (페일오버 소진) — ${klass}`,
            result: {
              ok: false,
              failureClass: klass,
              productFailed: klass === FAILURE_CLASS.PRODUCT,
              error: String(/** @type {any} */ (err).message || err),
            },
            failovers,
            founderGate: "BLOCKED",
          };
          return { ok: false, failureClass: klass, status: this.status() };
        }
      }
      return { ok: false, failureClass: classifyFailure(lastErr), status: this.status() };
    } finally {
      this._busy = false;
    }
  }
}

export class AutopilotStateStore {
  constructor(path) {
    this.path = path;
  }

  async save(state) {
    await writeFile(`${this.path}.tmp`, JSON.stringify(state, null, 2));
    await rm(this.path, { force: true });
    await writeFile(this.path, JSON.stringify(state, null, 2));
  }

  async load() {
    return JSON.parse(await readFile(this.path, "utf8"));
  }

  static reconcile(state) {
    return {
      ...state,
      tasks: state.tasks.map((task) => task.state === "RUNNING" ? { ...task, state: "QUEUED", reconcile: "REQUEUED_AFTER_RESTART" } : task),
    };
  }
}

/** Bounded real-lane orchestration: two Builder runtimes, one QA runtime. */
export class PortfolioAutopilot {
  /** @param {{tasks?: object[], builderAllocator: RuntimeAllocator, qaAllocator?: RuntimeAllocator, stateStore?: AutopilotStateStore, maxBuilders?: number, maxQa?: number, qaRunner?: Function}} opts */
  constructor(opts) {
    this.tasks = (opts.tasks || []).map((task) => ({ ...task, state: task.state || "QUEUED", attempts: task.attempts || 0, qaAttempts: task.qaAttempts || 0 }));
    this.builderAllocator = opts.builderAllocator;
    this.qaAllocator = opts.qaAllocator || null;
    this.stateStore = opts.stateStore || null;
    this.maxBuilders = Math.min(opts.maxBuilders ?? 2, 2);
    this.maxQa = Math.min(opts.maxQa ?? 1, 1);
    this.qaRunner = opts.qaRunner || null;
    this.activeBuilders = new Map();
    this.qaActive = 0;
    this.qaWaiters = [];
    this.events = [];
    this.maxConcurrentBuilders = 0;
    this.maxConcurrentQa = 0;
  }

  snapshot() {
    return {
      schema: "agent-relay.v2.portfolio-autopilot.state.v1",
      tasks: this.tasks.map((task) => ({ ...task })),
      activeBuilders: this.activeBuilders.size,
      activeQa: this.qaActive,
      maxConcurrentBuilders: this.maxConcurrentBuilders,
      maxConcurrentQa: this.maxConcurrentQa,
      events: [...this.events],
      updatedAt: new Date().toISOString(),
    };
  }

  async persist() {
    if (this.stateStore) await this.stateStore.save(this.snapshot());
  }

  async _acquireQa() {
    if (this.qaActive >= this.maxQa) await new Promise((resolve) => this.qaWaiters.push(resolve));
    this.qaActive += 1;
    this.maxConcurrentQa = Math.max(this.maxConcurrentQa, this.qaActive);
    await this.persist();
  }

  async _releaseQa() {
    this.qaActive -= 1;
    this.qaWaiters.shift()?.();
    await this.persist();
  }

  async _runQa(task, result) {
    if (!task.requiresQa) return "ACCEPT";
    await this._acquireQa();
    try {
      task.qaAttempts += 1;
      const verdict = this.qaRunner
        ? await this.qaRunner(task, result, task.qaAttempts)
        : "ACCEPT";
      this.events.push({ type: "QA", lane: task.lane, attempt: task.qaAttempts, verdict });
      await this.persist();
      return verdict;
    } finally {
      await this._releaseQa();
    }
  }

  async _runTask(task) {
    task.state = "RUNNING";
    this.events.push({ type: "TASK_RUNNING", lane: task.lane });
    await this.persist();
    while (true) {
      task.attempts += 1;
      const runtime = await this.builderAllocator.allocate({ projectId: task.projectId, provider: task.provider || "codex" });
      task.builder = { id: runtime.id, pid: runtime.pid, workspace: runtime.workspace, startedAt: Date.now() };
      this.events.push({ type: "BUILDER_STARTED", lane: task.lane, pid: runtime.pid, at: task.builder.startedAt });
      await this.persist();
      try {
        const startedAt = Date.now();
        const result = await this.builderAllocator.send(runtime, task);
        task.result = { text: result.resultText, sendAck: result.sendAck, resultAck: result.resultAck, at: Date.now() };
        task.overlap = { dispatchAt: startedAt, resultAt: task.result.at };
        this.events.push({ type: "RESULT", lane: task.lane, pid: runtime.pid, text: result.resultText, at: task.result.at });
        await this.builderAllocator.release(runtime);
        this.events.push({ type: "BUILDER_STOPPED", lane: task.lane, pid: runtime.pid, at: Date.now() });
        task.builder.stoppedAt = Date.now();
        await this.persist();
        const verdict = await this._runQa(task, result);
        if (verdict === "REQUEST_CHANGES" && task.attempts < (task.maxAttempts || 2)) {
          task.state = "QUEUED";
          task.retry = "SAME_TASK";
          this.events.push({ type: "REQUEST_CHANGES", lane: task.lane, attempt: task.attempts });
          await this.persist();
          continue;
        }
        if (verdict === "QA_CHANGES") {
          task.state = "QA_CHANGES";
          task.acceptance = "QA_CHANGES";
          await this.persist();
          return task;
        }
        if (verdict !== "ACCEPT") throw new Error(`QA did not accept ${task.lane}: ${verdict}`);
        task.state = "DONE";
        task.acceptance = "ACCEPT";
        await this.persist();
        return task;
      } catch (error) {
        try { await this.builderAllocator.release(runtime); } catch { /* cleanup remains fail-closed */ }
        task.state = "FAILED";
        task.error = String(error?.message || error);
        await this.persist();
        throw error;
      }
    }
  }

  async run() {
    await this.persist();
    while (true) {
      while (this.activeBuilders.size < this.maxBuilders) {
        const task = this.tasks.find((item) => item.state === "QUEUED");
        if (!task) break;
        const promise = this._runTask(task);
        this.activeBuilders.set(task.lane, promise);
        this.maxConcurrentBuilders = Math.max(this.maxConcurrentBuilders, this.activeBuilders.size);
        await this.persist();
        promise.finally(async () => {
          this.activeBuilders.delete(task.lane);
          await this.persist();
        }).catch(() => {});
      }
      if (!this.activeBuilders.size) break;
      await Promise.race(this.activeBuilders.values());
    }
    await this.persist();
    return this.snapshot();
  }
}
