import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildNightReport, finalizeNightRun, NightRunSupervisor, deadlineAt, drainManaged, evaluateExhaustion, readCompletion, requestMainPcShutdown, runPoweroff, sendReportToMainPc } from "../../src/v2/night-run/index.mjs";
// Tests must never reach a real MainPC: the production defaults point at it (a no-arg shutdown test powered it off on 2026-09-23).
process.env.MAINPC_SSH_TARGET = "agent-relay-test.invalid"; process.env.MAINPC_SSH_KEY = "/nonexistent/agent-relay-test-key";

const lanes = (states) => ({ projects: states.map(([id, state]) => ({ id, coreV1: true, active: true, state })), tasks: [] });
const runner = (state, after = state) => ({ manifest: { projects: state.projects }, reconcile: async () => state, runOnce: async () => after });

test("uses Asia/Seoul default and rolls a passed deadline to the next night", () => {
  const now = new Date("2026-09-23T17:00:00.000Z");
  assert.equal(deadlineAt(now).toISOString(), "2026-09-23T18:00:00.000Z");
});

test("exhaustion requires every active CORE lane to be terminal", () => {
  assert.equal(evaluateExhaustion({ projects: lanes([["agent-relay", "V1_COMPLETE"], ["actl", "FOUNDER_GATE"]]).projects }, lanes([["agent-relay", "V1_COMPLETE"], ["actl", "FOUNDER_GATE"]])).complete, true);
  const open = lanes([["agent-relay", "V1_COMPLETE"], ["actl", "FOUNDER_GATE"]]); open.tasks.push({ projectId: "agent-relay", taskId: "T", state: "REQUEST_CHANGES" });
  assert.equal(evaluateExhaustion({ projects: open.projects }, open).complete, false);
});

test("once delegates to existing runOnce and persists the required checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-"));
  const state = lanes([["agent-relay", "RUNNING"]]);
  const next = lanes([["agent-relay", "V1_COMPLETE"]]);
  next.tasks.push({ projectId: "agent-relay", taskId: "NR-01", state: "VERIFIED_DONE", attempts: 1, result: { commitSha: "abc" } });
  let calls = 0;
  const s = new NightRunSupervisor({ runner: { ...runner(state, next), runOnce: async () => { calls += 1; return next; } }, checkpointPath: join(dir, "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T10:00:00.000Z"), runId: "night-test" });
  const result = await s.once();
  assert.equal(calls, 1); assert.equal(result.runId, "night-test"); assert.equal(result.endReason, "WBS_EXHAUSTED");
  assert.equal(JSON.parse(await readFile(join(dir, "LAST_NIGHT_RUN.json"))).commitSha, "abc");
});

test("deadline boundary checkpoints without dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-"));
  const state = lanes([["agent-relay", "RUNNING"]]); let calls = 0;
  const s = new NightRunSupervisor({ runner: { ...runner(state), runOnce: async () => { calls += 1; return state; } }, checkpointPath: join(dir, "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-24T18:00:00.000Z"), runId: "deadline-test" });
  const result = await s.once();
  assert.equal(calls, 0); assert.equal(result.endReason, "DEADLINE_COMPLETE"); assert.equal(result.resumeRequired, true);
});

test("shutdown gate refuses missing or corrupt completion", async () => {
  assert.deepEqual(readCompletion(null), { ok: false, reason: "UNKNOWN_NIGHT_RUN" });
  assert.deepEqual(await runPoweroff({ checkpoint: null, command: "sh", args: ["-c", "exit 0"] }), { ok: false, status: "REFUSED", reason: "UNKNOWN_NIGHT_RUN" });
});

test("shutdown uses non-interactive sudo and reports missing permission", async () => {
  const checkpoint = { schema: "agent-relay.last-night-run.v1", runId: "r", startedAt: "2026-09-23T17:00:00.000Z", deadline: "2026-09-23T18:00:00.000Z", freezeAt: "2026-09-23T17:55:00.000Z", checkpointAt: "2026-09-23T17:58:00.000Z", endedAt: "2026-09-23T18:00:00.000Z", endReason: "DEADLINE_COMPLETE", shutdownState: "DRAINED", lanes: [], resumeRequired: true };
  const result = await runPoweroff({ checkpoint, command: "sh", args: ["-c", "echo permission denied >&2; exit 1"] });
  assert.equal(result.status, "SHUTDOWN_PERMISSION_REQUIRED");
});

test("run loops through multiple NEXT iterations and exits on exhaustion", async () => {
  const state = lanes([["agent-relay", "RUNNING"]]);
  const done = lanes([["agent-relay", "V1_COMPLETE"]]);
  let calls = 0; const runner = { manifest: { projects: state.projects }, reconcile: async () => state, load: async () => done, stop: async () => {}, runOnce: async () => { calls += 1; return calls === 1 ? state : done; } };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T10:00:00.000Z"), sleep: async () => {}, runId: "loop-test" });
  const result = await s.run({ intervalMs: 1 });
  assert.equal(calls, 2); assert.equal(result.endReason, "WBS_EXHAUSTED");
});

test("freeze blocks dispatch, checkpoints at 02:58, then drains", async () => {
  let now = Date.parse("2026-09-23T17:55:00.000Z"); const state = lanes([["agent-relay", "RUNNING"]]); let calls = 0; let stopped = 0;
  const runner = { manifest: { projects: state.projects }, reconcile: async () => state, load: async () => state, stop: async () => { stopped += 1; }, runOnce: async () => { calls += 1; return state; } };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date(now), sleep: async (ms) => { now += Math.max(1, Math.min(ms, 60_000)); }, runId: "freeze-test" });
  const result = await s.run({ intervalMs: 15_000 });
  assert.equal(calls, 0); assert.equal(result.endReason, "DEADLINE_COMPLETE"); assert.ok(stopped >= 1); assert.equal(result.resumeRequired, true);
});

test("hung Worker is cancelled and its worktree is retained", async () => {
  let now = Date.parse("2026-09-23T17:00:00.000Z"); const state = lanes([["agent-relay", "RUNNING"]]); state.tasks.push({ projectId: "agent-relay", taskId: "T", state: "RUNNING", attempts: 1, builderEvidence: { workspace: "/preserve/me", base: "base" } }); let stopped = 0;
  const runner = { manifest: { projects: state.projects }, reconcile: async () => state, load: async () => state, stop: async () => { stopped += 1; }, runOnce: async () => new Promise(() => {}) };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date(now), sleep: async (ms) => { now += ms; }, runId: "hung-test" });
  const result = await s.run({ intervalMs: 1 });
  assert.equal(result.endReason, "DEADLINE_COMPLETE"); assert.equal(result.resumeRequired, true); assert.ok(stopped >= 1); assert.equal(result.worktree, "/preserve/me");
});

test("Founder Gate exhausts one lane while another lane continues", async () => {
  const state = lanes([["actl", "FOUNDER_GATE"], ["agent-relay", "RUNNING"]]); let calls = 0;
  const done = lanes([["actl", "FOUNDER_GATE"], ["agent-relay", "V1_COMPLETE"]]);
  const runner = { manifest: { projects: state.projects }, reconcile: async () => state, load: async () => done, stop: async () => {}, runOnce: async () => { calls += 1; return done; } };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T10:00:00.000Z"), sleep: async () => {}, runId: "gate-lane-test" });
  assert.equal((await s.run()).endReason, "WBS_EXHAUSTED"); assert.equal(calls, 1);
});

test("managed drain ignores unowned processes", async () => {
  const events = []; const entries = [
    { id: "owned", owner: "agent-relay", managed: true, stop: async () => events.push("stop-owned"), kill: async () => events.push("kill-owned") },
    { id: "user", owner: "user", managed: false, stop: async () => events.push("stop-user"), kill: async () => events.push("kill-user") },
  ];
  assert.deepEqual(await drainManaged(entries, { graceMs: 0, sleep: async () => {} }), ["owned"]); assert.deepEqual(events, ["stop-owned", "kill-owned"]);
});

test("completion allowlist rejects incomplete and unknown states", () => {
  const valid = { schema: "agent-relay.last-night-run.v1", runId: "r", startedAt: "s", deadline: "d", freezeAt: "f", checkpointAt: "c", endedAt: "x", shutdownState: "DRAINED", lanes: [] };
  assert.equal(readCompletion({ ...valid, endReason: "RUNNING" }).ok, false);
  assert.equal(readCompletion({ ...valid, endReason: "DEADLINE_COMPLETE" }).ok, true);
});

test("finalization dry-run proves report, transfer, MainPC shutdown, and ASUS poweroff order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-")); const events = [];
  const record = { schema: "agent-relay.last-night-run.v1", runId: "dry", startedAt: "2026-09-23T17:00:00.000Z", deadline: "2026-09-23T18:00:00.000Z", freezeAt: "2026-09-23T17:55:00.000Z", checkpointAt: "2026-09-23T17:58:00.000Z", endedAt: "2026-09-23T18:00:00.000Z", endReason: "DEADLINE_COMPLETE", shutdownState: "FINALIZING", lanes: [], taskId: "NR-01", qaState: "ACCEPT", promotionRef: "refs/agent-relay/promotions/NR-01" };
  const saved = []; const final = await finalizeNightRun({ record, checkpointPath: join(dir, "LAST_NIGHT_RUN.json"), reportPath: join(dir, "NIGHT_REPORT_2026-09-24.md"), persist: async (value) => { saved.push(value); return value; }, send: async ({ reportPath }) => { events.push("send"); return { state: "DELIVERED", path: "MainPC/Desktop/NIGHT_REPORT.md", remoteSha: (await import("node:crypto")).createHash("sha256").update(await readFile(reportPath)).digest("hex") }; }, requestShutdown: async () => { events.push("mainpc"); return { state: "REQUESTED", at: "2026-09-23T18:00:01.000Z" }; }, poweroff: async () => { events.push("asus"); return { ok: true, status: "POWEROFF_REQUESTED" }; } });
  assert.deepEqual(events, ["send", "mainpc", "asus"]); assert.equal(final.reportTransferState, "DELIVERED"); assert.equal(final.mainPcShutdownRequested, true); assert.equal(final.asusShutdownRequested, true); assert.equal(final.shutdownState, "POWEROFF_REQUESTED"); assert.match(await readFile(join(dir, "NIGHT_REPORT_2026-09-24.md"), "utf8"), /NR-01/); assert.ok(saved.length >= 3);
});

test("report transport verifies the destination hash and shutdown uses the exact command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-")); const report = join(dir, "NIGHT_REPORT.md"); await import("node:fs/promises").then(({ writeFile }) => writeFile(report, "report\n"));
  const crypto = await import("node:crypto"); const sha = crypto.createHash("sha256").update("report\n").digest("hex");
  const sent = await sendReportToMainPc({ reportPath: report, target: "mainpc", scriptPath: "send", execFileImpl: async () => ({ stdout: `SENT: C:/Desktop/NIGHT_REPORT.md\nSHA256: ${sha}\n`, stderr: "" }) }); assert.equal(sent.state, "DELIVERED");
  let args; await requestMainPcShutdown({ target: "mainpc", identity: null, execFileImpl: async (_command, received) => { args = received; return { stdout: "", stderr: "" }; } }); assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "mainpc", "shutdown.exe /s /t 30"]);
  await requestMainPcShutdown({ target: "User@h", identity: "/k", execFileImpl: async (_command, received) => { args = received; return { stdout: "", stderr: "" }; } }); assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", "/k", "-o", "IdentitiesOnly=yes", "User@h", "shutdown.exe /s /t 30"]);
});

test("MainPC-pull finalization writes local report without reverse transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-")); const saved = [];
  const record = { schema: "agent-relay.last-night-run.v1", runId: "pull", startedAt: "2026-09-23T17:00:00.000Z", deadline: "2026-09-23T18:00:00.000Z", freezeAt: "2026-09-23T17:55:00.000Z", checkpointAt: "2026-09-23T17:58:00.000Z", endedAt: "2026-09-23T18:00:00.000Z", endReason: "WBS_EXHAUSTED", shutdownState: "FINALIZING", lanes: [] };
  const result = await finalizeNightRun({ record, checkpointPath: join(dir, "LAST_NIGHT_RUN.json"), persist: async (value) => { saved.push(value); return value; }, transport: "mainpc-pull", send: async () => { throw new Error("reverse transport must not run"); }, requestShutdown: async () => { throw new Error("reverse transport must not run"); }, poweroff: async () => { throw new Error("poweroff must not run"); } });
  assert.equal(result.shutdownState, "READY_FOR_MAINPC_PULL"); assert.equal(result.reportTransferState, "LOCAL_ONLY"); assert.equal(result.asusShutdownRequested, false); assert.ok(saved.length >= 1);
});

test("MainPC wrapper pulls from ASUS and fails closed before destructive commands", () => {
  const wrapper = readFileSync(new URL("../../scripts/core-night.ps1", import.meta.url), "utf8");
  assert.match(wrapper, /ssh @sshArgs/); assert.match(wrapper, /--mainpc-pull/); assert.match(wrapper, /scp @transportArgs/);
  assert.match(wrapper, /sha256sum/); assert.match(wrapper, /Get-FileHash/); assert.match(wrapper, /shutdown\.exe \/s \/t 30/); assert.match(wrapper, /sudo -n \/usr\/sbin\/poweroff/); assert.match(wrapper, /shutdown\.exe \/a/);
  assert.match(wrapper, /WBS_EXHAUSTED/); assert.match(wrapper, /DEADLINE_COMPLETE/); assert.match(wrapper, /DEADLINE_FORCED_CHECKPOINT/); assert.doesNotMatch(wrapper, /shutdown"/);
  assert.ok(wrapper.indexOf("exit 0") < wrapper.indexOf("nohup $relay"), "DryRun must exit before launching a Night Run"); assert.match(wrapper, /NIGHT_RUN_ATTACHED/); assert.match(wrapper, /\$staleRunId/); assert.match(wrapper, /preflight --json/); assert.match(wrapper, /mainpc_push: OK/); assert.match(wrapper, /--self-poweroff/); assert.ok(wrapper.indexOf("Refusing activation: preflight BLOCKED") < wrapper.indexOf("nohup $relay"), "preflight gate must precede launch"); assert.match(wrapper, /shutdownState -eq "READY_FOR_MAINPC_PULL"\) \{ break \}/); assert.ok(wrapper.indexOf("$previous = Read-Status") < wrapper.indexOf("nohup $relay"), "previous runId must be read before launch");
});

test("requestMainPcShutdown accepts a no-argument call", async () => {
  const { requestMainPcShutdown } = await import("../../src/v2/night-run/index.mjs");
  let seen; await requestMainPcShutdown({ execFileImpl: async (_c, args) => { seen = args; return { stdout: "", stderr: "" }; } });
  assert.equal(seen.at(-2), "agent-relay-test.invalid"); assert.ok(!seen.includes("-i"));
});

test("night-run status survives a slow pipe reader beyond 64KB", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-status-"));
  const big = { schema: "agent-relay.last-night-run.v1", lanes: [{ id: "x", note: "y".repeat(200_000) }] };
  const { writeFile: write } = await import("node:fs/promises");
  await write(join(dir, "LAST_NIGHT_RUN.json"), JSON.stringify(big));
  const child = spawn(process.execPath, [new URL("../../bridge/agent-relay.mjs", import.meta.url).pathname, "night-run", "status"], { env: { ...process.env, AGENT_RELAY_DATA_ROOT: dir }, stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.pause(); await new Promise((r) => setTimeout(r, 500)); child.stdout.resume();
  let out = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { out += chunk; });
  await new Promise((r) => child.once("close", r));
  assert.equal(JSON.parse(out).lanes[0].note.length, 200_000);
});

test("night-run up never powers ASUS off without --self-poweroff", async () => {
  const { spawnSync } = await import("node:child_process");
  const { writeFile: write, readFile: read, mkdir: mk, chmod } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-nopower-")); const bin = join(dir, "bin"); await mk(bin);
  for (const cmd of ["sudo", "poweroff", "shutdown", "systemctl"]) { await write(join(bin, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${dir}/power.log"; exit 1\n`); await chmod(join(bin, cmd), 0o755); }
  await write(join(dir, "manifest.json"), JSON.stringify({ projects: [{ id: "sim", state: "HOLD", tasks: [] }] }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_RELAY_DATA_ROOT: join(dir, "data"), AGENT_RELAY_FOUNDER_OUTBOX: join(dir, "outbox"), AGENT_RELAY_PORTFOLIO_MANIFEST: join(dir, "manifest.json"), MAINPC_SSH_TARGET: "invalid.invalid", AGENT_RELAY_SEND_TO_MAINPC: "/bin/false" };
  const run = spawnSync(process.execPath, [new URL("../../bridge/agent-relay.mjs", import.meta.url).pathname, "night-run", "up", "--deadline", "04:30"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(await read(join(dir, "power.log"), "utf8").catch(() => ""), "");
  assert.equal(JSON.parse(await read(join(dir, "data", "LAST_NIGHT_RUN.json"), "utf8")).shutdownState, "REPORT_NOT_DELIVERED");
});

test("push finalize fails closed: no shutdowns without a delivered report, no ASUS poweroff without MainPC shutdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-push-"));
  const record = { schema: "agent-relay.last-night-run.v1", runId: "p", startedAt: "2026-09-23T17:00:00.000Z", deadline: "x", freezeAt: "x", checkpointAt: "x", endedAt: "x", endReason: "WBS_EXHAUSTED", shutdownState: "FINALIZING", lanes: [] };
  const calls = []; const persist = async (value) => value;
  const noSend = await finalizeNightRun({ record, checkpointPath: join(dir, "a.json"), persist, send: async () => { throw new Error("MAINPC_SSH_UNREACHABLE"); }, requestShutdown: async () => { calls.push("mainpc"); return { state: "REQUESTED" }; }, poweroff: async () => { calls.push("asus"); return { ok: true }; } });
  assert.equal(noSend.shutdownState, "REPORT_NOT_DELIVERED"); assert.deepEqual(calls, []);
  const noPc = await finalizeNightRun({ record, checkpointPath: join(dir, "b.json"), persist, send: async () => ({ state: "DELIVERED", path: "x", remoteSha: "y" }), requestShutdown: async () => { throw new Error("denied"); }, poweroff: async () => { calls.push("asus"); return { ok: true }; } });
  assert.equal(noPc.shutdownState, "MAINPC_SHUTDOWN_FAILED"); assert.deepEqual(calls, []);
  const ok = await finalizeNightRun({ record, checkpointPath: join(dir, "c.json"), persist, send: async () => ({ state: "DELIVERED", path: "x", remoteSha: "y" }), requestShutdown: async () => { calls.push("mainpc"); return { state: "REQUESTED", at: "t" }; }, poweroff: async () => { calls.push("asus"); return { ok: true, status: "POWEROFF_REQUESTED" }; } });
  assert.equal(ok.shutdownState, "POWEROFF_REQUESTED"); assert.deepEqual(calls, ["mainpc", "asus"]);
});

test("real power commands are refused under node --test", async () => {
  await assert.rejects(requestMainPcShutdown({ target: "agent-relay-test.invalid" }), /REAL_MAINPC_SHUTDOWN_UNDER_TEST/);
  const checkpoint = { schema: "agent-relay.last-night-run.v1", runId: "r", startedAt: "x", deadline: "x", freezeAt: "x", checkpointAt: "x", endedAt: "x", endReason: "WBS_EXHAUSTED", shutdownState: "x", lanes: [] };
  assert.equal((await runPoweroff({ checkpoint })).reason, "REAL_POWEROFF_UNDER_TEST");
});

test("run uses the runner's continuous wave and closes dispatch at the freeze time", async () => {
  const state = lanes([["agent-relay", "RUNNING"]]); const done = lanes([["agent-relay", "V1_COMPLETE"]]); let seen = null;
  const runner = { manifest: { projects: state.projects }, reconcile: async () => state, load: async () => done, stop: async () => {}, runOnce: async () => { throw new Error("runOnce must not be used"); }, runWave: async (opts) => { seen = opts; return done; } };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T10:00:00.000Z"), sleep: (ms) => ms > 1000 ? new Promise(() => {}) : Promise.resolve(), runId: "wave-test" });
  const result = await s.run({ intervalMs: 1 });
  assert.equal(result.endReason, "WBS_EXHAUSTED"); assert.ok(seen.dispatchUntil instanceof Date);
  assert.equal(seen.dispatchUntil.toISOString(), new Date(new Date(result.deadline) - 5 * 60_000).toISOString());
});

test("holdUntilDeadline: exhausted WBS does not finish early; only the deadline ends the night", async () => {
  const done = lanes([["agent-relay", "V1_COMPLETE"]]); let waves = 0; let now = new Date("2026-09-23T16:00:00.000Z");
  const runner = { manifest: { projects: done.projects }, reconcile: async () => done, load: async () => done, stop: async () => {}, runOnce: async () => done, runWave: async () => { waves += 1; return done; } };
  const s = new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => now, sleep: (ms) => ms > 120_000 ? new Promise(() => {}) : Promise.resolve().then(() => { now = new Date(now.getTime() + ms); }), runId: "hold-test" });
  const result = await s.run({ deadline: "05:00", intervalMs: 60_000, holdUntilDeadline: true });
  assert.equal(result.endReason, "DEADLINE_COMPLETE"); assert.ok(waves > 3, `kept working until the deadline (waves=${waves})`);
  const early = await new NightRunSupervisor({ runner, checkpointPath: join(await mkdtemp(join(tmpdir(), "agent-relay-night-")), "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T16:00:00.000Z"), sleep: async () => {}, runId: "early-test" }).run({ deadline: "05:00", intervalMs: 1 });
  assert.equal(early.endReason, "WBS_EXHAUSTED");
});
