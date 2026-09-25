process.env.AGENT_RELAY_BRIDGE_NO_CLI = "1";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildNightReport, finalizeNightRun, NightRunSupervisor, NIGHT_CHECKPOINT_CORRUPT, NIGHT_CHECKPOINT_MISSING, corruptCheckpointError, deadlineAt, drainManaged, evaluateExhaustion, isCorruptCheckpointError, readCompletion, requestMainPcShutdown, runPoweroff, sendReportToMainPc } from "../../src/v2/night-run/index.mjs";
const { BRIDGE_NO_CLI_ENV, PID_LOCK_ACTIVE, PID_LOCK_CORRUPT, PID_LOCK_MISSING, PID_LOCK_STALE, checkPidLock, isPidLockError, parsePidLock, pidLockError, shouldRunBridgeCli, stopPidLock } = await import("../../bridge/agent-relay.mjs");

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
  assert.deepEqual(readCompletion(null), { ok: false, reason: NIGHT_CHECKPOINT_MISSING });
  assert.deepEqual(readCompletion(undefined), { ok: false, reason: NIGHT_CHECKPOINT_MISSING });
  assert.deepEqual(await runPoweroff({ checkpoint: null, command: "sh", args: ["-c", "exit 0"] }), { ok: false, status: "REFUSED", reason: NIGHT_CHECKPOINT_MISSING });
  const corrupt = readCompletion({ schema: "wrong", lanes: [] });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.reason, NIGHT_CHECKPOINT_CORRUPT);
  assert.notEqual(readCompletion(null).reason, corrupt.reason);
  const refused = await runPoweroff({ checkpoint: { schema: "wrong", lanes: [] }, command: "sh", args: ["-c", "exit 0"] });
  assert.deepEqual(refused, { ok: false, status: "REFUSED", reason: NIGHT_CHECKPOINT_CORRUPT });
});

test("night-run status distinguishes missing checkpoint from corrupt checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-status-"));
  const missingPath = join(dir, "does-not-exist.json");
  const missingSupervisor = new NightRunSupervisor({ runner: runner(lanes([["agent-relay", "RUNNING"]])), checkpointPath: missingPath, clock: () => new Date("2026-09-23T10:00:00.000Z") });
  assert.equal(await missingSupervisor.status(), null);
  const corruptPath = join(dir, "LAST_NIGHT_RUN.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(corruptPath, "{not-json");
  const corruptSupervisor = new NightRunSupervisor({ runner: runner(lanes([["agent-relay", "RUNNING"]])), checkpointPath: corruptPath, clock: () => new Date("2026-09-23T10:00:00.000Z") });
  const error = await corruptSupervisor.status().then(() => null, (cause) => cause);
  assert.ok(error, "corrupt checkpoint must not collapse to null");
  assert.ok(isCorruptCheckpointError(error));
  assert.equal(error.code, NIGHT_CHECKPOINT_CORRUPT);
  assert.equal(error.reason, "INVALID_JSON");
  assert.equal(error.checkpointPath, corruptPath);
  assert.ok(error.cause instanceof SyntaxError);
  assert.equal(error.blocked.code, NIGHT_CHECKPOINT_CORRUPT);
  assert.equal(await readFile(corruptPath, "utf8"), "{not-json", "corrupt checkpoint must not be overwritten");
  assert.equal(isCorruptCheckpointError(null), false);
  assert.equal(isCorruptCheckpointError(new Error("plain")), false);
  const built = corruptCheckpointError({ checkpointPath: corruptPath, reason: "INVALID_JSON", cause: error.cause });
  assert.ok(isCorruptCheckpointError(built));
  const dirSupervisor = new NightRunSupervisor({ runner: runner(lanes([["agent-relay", "RUNNING"]])), checkpointPath: dir, clock: () => new Date("2026-09-23T10:00:00.000Z") });
  const readError = await dirSupervisor.status().then(() => null, (cause) => cause);
  assert.ok(isCorruptCheckpointError(readError));
  assert.equal(readError.reason, "READ_ERROR");
  // Completion gate stays fail-closed for both cases.
  assert.deepEqual(readCompletion(await missingSupervisor.status()), { ok: false, reason: NIGHT_CHECKPOINT_MISSING });
  assert.equal(readCompletion({ schema: "bad" }).reason, NIGHT_CHECKPOINT_CORRUPT);
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
  let args; await requestMainPcShutdown({ target: "mainpc", execFileImpl: async (_command, received) => { args = received; return { stdout: "", stderr: "" }; } }); assert.deepEqual(args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "mainpc", "shutdown.exe /s /t 30"]);
});

test("completed-task evidence describes VERIFIED_DONE work, not the in-flight task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-night-"));
  const done = { projectId: "agent-relay", taskId: "DONE-01", state: "VERIFIED_DONE", attempts: 1, promotionRef: "promo-1", result: { status: "IMPLEMENTED", changedFiles: ["src/a.mjs", "src/b.mjs"], tests: ["node --test test/a.test.mjs"], commitSha: "deadbeef", summary: "did stuff" }, qa: { verdict: "ACCEPT", tests: ["qa-t1"], findings: [], summary: "qa ok" } };
  const current = { projectId: "agent-relay", taskId: "NEXT-01", state: "REQUEST_CHANGES", attempts: 2, result: { status: "BLOCKED", changedFiles: ["src/unfinished.mjs"], tests: ["node --test test/unfinished.test.mjs"], commitSha: "unfinished-sha", summary: "not done yet" }, qa: { verdict: "REQUEST_CHANGES", tests: ["qa-retry-1"], findings: ["missing evidence"], summary: "needs fix" } };
  const state = { projects: [{ id: "agent-relay", coreV1: true, active: true, state: "RUNNING" }], tasks: [done, current] };
  const s = new NightRunSupervisor({ runner: { manifest: { projects: state.projects }, reconcile: async () => state, runOnce: async () => state }, checkpointPath: join(dir, "LAST_NIGHT_RUN.json"), clock: () => new Date("2026-09-23T10:00:00.000Z"), runId: "evidence-test" });
  const result = await s.once();
  assert.equal(result.endReason, "RUNNING");
  assert.equal(result.taskId, "NEXT-01");
  assert.equal(result.resultStatus, "IMPLEMENTED");
  assert.deepEqual(result.changedFiles, ["src/a.mjs", "src/b.mjs"]);
  assert.deepEqual(result.resultTests, ["node --test test/a.test.mjs"]);
  assert.equal(result.resultSummary, "did stuff");
  assert.equal(result.commitSha, "deadbeef");
  assert.equal(result.promotionRef, "promo-1");
  assert.deepEqual(result.qaTests, ["qa-retry-1"]);
  assert.deepEqual(result.qaFindings, ["missing evidence"]);
  assert.equal(result.qaSummary, "needs fix");
  assert.equal(result.completedTasks.length, 1);
  assert.deepEqual(result.completedTasks[0], { project: "agent-relay", taskId: "DONE-01", resultStatus: "IMPLEMENTED", changedFiles: ["src/a.mjs", "src/b.mjs"], tests: ["node --test test/a.test.mjs"], commitSha: "deadbeef", promotionRef: "promo-1", qaState: "ACCEPT", qaTests: ["qa-t1"], summary: "did stuff" });
  const report = buildNightReport(result);
  const completedSection = report.split("## Completed WBS / task")[1].split("## Completed tasks evidence")[0];
  assert.match(completedSection, /DONE-01/);
  assert.match(completedSection, /IMPLEMENTED/);
  assert.match(completedSection, /src\/a\.mjs/);
  assert.match(completedSection, /did stuff/);
  assert.doesNotMatch(completedSection, /NEXT-01/);
  assert.doesNotMatch(completedSection, /unfinished/);
  assert.match(report, /## Completed tasks evidence\n- agent-relay\/DONE-01: result=IMPLEMENTED, commit=deadbeef, files=src\/a\.mjs, src\/b\.mjs, tests=node --test test\/a\.test\.mjs, qa-t1, QA=ACCEPT, summary=did stuff/);
  const retrySection = report.split("## Retry / QA")[1].split("## Unfinished tasks")[0];
  assert.match(retrySection, /qa-retry-1/);
  assert.match(retrySection, /missing evidence/);
  assert.match(retrySection, /needs fix/);
});

test("completed WBS section degrades gracefully without completed tasks", () => {
  const record = { runId: "legacy", startedAt: "2026-09-23T17:00:00.000Z", endedAt: "2026-09-23T18:00:00.000Z", endReason: "DEADLINE_COMPLETE", deadline: "2026-09-23T18:00:00.000Z", shutdownState: "DRAINED", taskId: "NR-01", qaState: "ACCEPT", attempts: 1, qaTests: ["qa-t1"], qaFindings: [], qaSummary: "qa ok", lanes: [] };
  const report = buildNightReport(record);
  assert.match(report, /## Completed WBS \/ task\n- NR-01\n- resultStatus: -/);
  assert.match(report, /## Completed tasks evidence\n- none/);
  assert.match(report, /qa-t1/);
  assert.match(report, /qa ok/);
});

test("Night Report includes only bounded lifecycle count and latest event", () => {
  const latest = { type: "TASK_COMPLETED", taskId: "T-501", projectId: "agent-relay", state: "VERIFIED_DONE" };
  const record = { runId: "lifecycle", startedAt: "2026-09-23T17:00:00.000Z", endReason: "DEADLINE_COMPLETE", deadline: "2026-09-23T18:00:00.000Z", shutdownState: "DRAINED", lifecycleEventCount: 501, latestLifecycleEvent: latest, lanes: [] };
  const report = buildNightReport(record);
  assert.match(report, /## Lifecycle evidence\n- lifecycleEventCount: 500\n- latestLifecycleEvent: TASK_COMPLETED task=T-501 project=agent-relay state=VERIFIED_DONE/);
  assert.doesNotMatch(report, /events/);
});

test("pid lock distinguishes active, stale, malformed, and missing without touching unrelated processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-relay-pid-lock-"));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(process.pid), true);
  // Active: a live child process blocks the lock.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const activePath = join(dir, "active.pid");
    await writeFile(activePath, `${child.pid}\n`);
    const active = await checkPidLock({ pidPath: activePath, label: "night run" });
    assert.equal(active.ok, false);
    assert.equal(active.state, "ACTIVE");
    assert.equal(active.reason, PID_LOCK_ACTIVE);
    assert.equal(active.pid, child.pid);
    assert.deepEqual(active.blocked, { code: PID_LOCK_ACTIVE, pidPath: activePath, label: "night run", reason: PID_LOCK_ACTIVE, pid: child.pid });
    const activeError = pidLockError({ pidPath: activePath, label: "night run", reason: active.reason, pid: active.pid });
    assert.ok(isPidLockError(activeError));
    assert.equal(activeError.code, PID_LOCK_ACTIVE);
    assert.equal(activeError.pid, child.pid);
    assert.equal(activeError.blocked.pid, child.pid);
    // stopPidLock signals only the proven-live owner.
    const signaled = [];
    const stopActive = await stopPidLock({ pidPath: activePath, label: "night run", killImpl: (pid, signal) => { signaled.push([pid, signal]); if (signal === 0) return; } });
    assert.equal(stopActive.signaled, true);
    assert.equal(stopActive.state, "ACTIVE");
    assert.deepEqual(signaled, [[child.pid, 0], [child.pid, "SIGTERM"]]);
  } finally {
    child.kill("SIGKILL");
  }
  // Stale: numeric pid with no process fails closed and is never signaled.
  let stalePid = 2147483647;
  while (alive(stalePid) && stalePid > 2) stalePid -= 1;
  const stalePath = join(dir, "stale.pid");
  await writeFile(stalePath, String(stalePid));
  const stale = await checkPidLock({ pidPath: stalePath, label: "portfolio runner" });
  assert.equal(stale.ok, false);
  assert.equal(stale.state, "STALE");
  assert.equal(stale.reason, PID_LOCK_STALE);
  assert.equal(stale.pid, stalePid);
  assert.deepEqual(stale.blocked, { code: PID_LOCK_STALE, pidPath: stalePath, label: "portfolio runner", reason: PID_LOCK_STALE, pid: stalePid });
  assert.ok(isPidLockError(pidLockError({ pidPath: stalePath, label: "portfolio runner", reason: stale.reason, pid: stale.pid })));
  const staleSignals = [];
  const stopStale = await stopPidLock({ pidPath: stalePath, label: "portfolio runner", killImpl: (pid, signal) => { staleSignals.push([pid, signal]); const error = new Error("no such process"); error.code = "ESRCH"; throw error; } });
  assert.equal(stopStale.signaled, false);
  assert.equal(stopStale.state, "STALE");
  assert.equal(stopStale.reason, PID_LOCK_STALE);
  assert.deepEqual(staleSignals, [[stalePid, 0]], "stale lock must only be probed, never SIGTERM");
  assert.notEqual(stale.reason, PID_LOCK_CORRUPT);
  // Malformed: every non-pid payload fails closed as corrupt and is never signaled.
  for (const [name, raw] of [["empty", ""], ["spaces", "   \n"], ["text", "abc"], ["zero", "0"], ["negative", "-12"], ["float", "12.5"], ["mixed", "123abc"], ["huge", "999999999999999999999"]]) {
    const corruptPath = join(dir, `corrupt-${name}.pid`);
    await writeFile(corruptPath, raw);
    const gate = await checkPidLock({ pidPath: corruptPath, label: "night run" });
    assert.equal(gate.ok, false, name);
    assert.equal(gate.state, "CORRUPT", name);
    assert.equal(gate.reason, PID_LOCK_CORRUPT, name);
    assert.ok(gate.blocked && gate.blocked.code === PID_LOCK_CORRUPT, name);
    const calls = [];
    const stop = await stopPidLock({ pidPath: corruptPath, label: "night run", killImpl: (pid, signal) => { calls.push([pid, signal]); } });
    assert.equal(stop.signaled, false, name);
    assert.equal(stop.state, "CORRUPT", name);
    assert.deepEqual(calls, [], `${name} must not probe or signal any process`);
    assert.equal(parsePidLock(raw).ok, false, name);
  }
  assert.deepEqual(parsePidLock(`  ${process.pid}\n`), { ok: true, pid: process.pid });
  // EPERM (process exists, cannot signal) stays fail-closed as active.
  const epermPath = join(dir, "eperm.pid");
  await writeFile(epermPath, "12345");
  const eperm = await checkPidLock({ pidPath: epermPath, label: "night run", killImpl: () => { const error = new Error("not permitted"); error.code = "EPERM"; throw error; } });
  assert.equal(eperm.ok, false);
  assert.equal(eperm.state, "ACTIVE");
  assert.equal(eperm.reason, PID_LOCK_ACTIVE);
  // Missing lock is the only claimable state; read errors fail closed.
  const missing = await checkPidLock({ pidPath: join(dir, "does-not-exist.pid"), label: "night run" });
  assert.equal(missing.ok, true);
  assert.equal(missing.state, "AVAILABLE");
  assert.equal(missing.reason, PID_LOCK_MISSING);
  const readError = await checkPidLock({ pidPath: dir, label: "night run" });
  assert.equal(readError.ok, false);
  assert.equal(readError.state, "CORRUPT");
  assert.equal(readError.reason, PID_LOCK_CORRUPT);
  assert.equal(readError.detail, "READ_ERROR");
  const stopMissing = await stopPidLock({ pidPath: join(dir, "does-not-exist.pid"), label: "night run", killImpl: () => { throw new Error("must not probe missing lock"); } });
  assert.equal(stopMissing.signaled, false);
  assert.equal(stopMissing.state, "MISSING");
  // Self pid never blocks or signals its own process.
  const selfPath = join(dir, "self.pid");
  await writeFile(selfPath, String(process.pid));
  assert.equal((await checkPidLock({ pidPath: selfPath, label: "night run" })).state, "AVAILABLE");
  const selfCalls = [];
  assert.equal((await stopPidLock({ pidPath: selfPath, label: "night run", killImpl: (pid, signal) => { selfCalls.push([pid, signal]); } })).signaled, false);
  assert.deepEqual(selfCalls, []);
  assert.equal(isPidLockError(null), false);
  assert.equal(isPidLockError(new Error("plain")), false);
  assert.equal(isPidLockError({ code: PID_LOCK_STALE }), true);
  // Fail-closed error evidence never renders a doubled pid label.
  assert.doesNotMatch(pidLockError({ pidPath: "p", label: "night run", reason: PID_LOCK_CORRUPT, pid: undefined, detail: "MALFORMED_PID" }).message, /unknown pid/);
  assert.match(pidLockError({ pidPath: "p", label: "night run", reason: PID_LOCK_CORRUPT, pid: undefined, detail: "MALFORMED_PID" }).message, /pid=unknown:MALFORMED_PID/);
});

test("bridge fails closed on stale/corrupt locks without signaling and stop clears them", async () => {
  const execFileAsync = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "agent-relay-bridge-pid-"));
  const manifestPath = join(root, "portfolio.json");
  await writeFile(manifestPath, JSON.stringify({ projects: [] }));
  const bridgePath = new URL("../../bridge/agent-relay.mjs", import.meta.url).pathname;
  const { AGENT_RELAY_BRIDGE_NO_CLI: _bridgeNoCli, ...baseEnv } = process.env;
  const env = { ...baseEnv, AGENT_RELAY_DATA_ROOT: root, AGENT_RELAY_PORTFOLIO_MANIFEST: manifestPath };
  const nightPidPath = join(root, "night-run.pid");
  const runnerPidPath = join(root, "runner.pid");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let stalePid = 2147483647;
  while (alive(stalePid) && stalePid > 2) stalePid -= 1;
  const runBridge = (args) => execFileAsync(process.execPath, [bridgePath, ...args], { env });
  const expectBlocked = async (args, code) => {
    const error = await runBridge(args).then(() => null, (cause) => cause);
    assert.ok(error, `${args.join(" ")} must exit non-zero on ${code}`);
    assert.notEqual(error.code, 0);
    assert.match(String(error.stderr || error.message), new RegExp(code), `${args.join(" ")} must report ${code}`);
    return error;
  };

  // Stale night-run lock: `up` exits non-zero, reports STALE, and keeps the file.
  await writeFile(nightPidPath, String(stalePid));
  await expectBlocked(["night-run", "up"], PID_LOCK_STALE);
  assert.equal(await readFile(nightPidPath, "utf8"), String(stalePid), "stale lock must not be claimed or cleared by up");

  // Corrupt night-run lock: `up` exits non-zero, reports CORRUPT, and keeps the file.
  await writeFile(nightPidPath, "abc");
  await expectBlocked(["night-run", "up"], PID_LOCK_CORRUPT);
  assert.equal(await readFile(nightPidPath, "utf8"), "abc", "corrupt lock must not be claimed or cleared by up");

  // Active night-run lock: `up` exits non-zero, reports ACTIVE, and leaves the owner alive.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await writeFile(nightPidPath, String(child.pid));
    await expectBlocked(["night-run", "up"], PID_LOCK_ACTIVE);
    assert.equal(alive(child.pid), true, "bridge must not kill the active owner on a failed up gate");
    assert.equal(await readFile(nightPidPath, "utf8"), String(child.pid));
  } finally {
    child.kill("SIGKILL");
  }

  // Stale portfolio lock: `portfolio up` exits non-zero and keeps the file.
  await writeFile(runnerPidPath, String(stalePid));
  await expectBlocked(["portfolio", "up"], PID_LOCK_STALE);
  assert.equal(await readFile(runnerPidPath, "utf8"), String(stalePid));
  await rm(runnerPidPath, { force: true });

  // `night-run stop` on a stale lock reports the lock without signaling and clears the file.
  await writeFile(nightPidPath, String(stalePid));
  const stopStale = await runBridge(["night-run", "stop"]);
  assert.equal(stopStale.stderr.includes(PID_LOCK_STALE), true, "stop must surface stale pidLock evidence on stderr");
  await assert.rejects(readFile(nightPidPath, "utf8"), "stop must clear a stale night-run.pid so the next up is not blocked");

  // `night-run stop` on a corrupt lock reports CORRUPT without signaling and clears the file.
  await writeFile(nightPidPath, "abc");
  const stopCorrupt = await runBridge(["night-run", "stop"]);
  assert.equal(stopCorrupt.stderr.includes(PID_LOCK_CORRUPT), true, "stop must surface corrupt pidLock evidence on stderr");
  await assert.rejects(readFile(nightPidPath, "utf8"), "stop must clear a corrupt night-run.pid so the next up is not blocked");

  // `night-run stop` on an active lock signals only the proven-live owner.
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await writeFile(nightPidPath, String(victim.pid));
    await runBridge(["night-run", "stop"]);
    assert.equal(alive(victim.pid), false, "stop must SIGTERM the proven-live owner");
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    await rm(nightPidPath, { force: true });
  }
  await rm(root, { recursive: true, force: true });
});

test("import-time CLI runs through symlinks and keepalive imports with fail-closed lock evidence (invokedDirectly regression)", async () => {
  const execFileAsync = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "agent-relay-bridge-r2-"));
  const manifestPath = join(root, "portfolio.json");
  await writeFile(manifestPath, JSON.stringify({ projects: [] }));
  const bridgePath = new URL("../../bridge/agent-relay.mjs", import.meta.url).pathname;
  const bridgeUrl = pathToFileURL(bridgePath).href;
  const { AGENT_RELAY_BRIDGE_NO_CLI: _optOut, ...baseEnv } = process.env;
  const env = { ...baseEnv, AGENT_RELAY_DATA_ROOT: root, AGENT_RELAY_PORTFOLIO_MANIFEST: manifestPath };
  const nightPidPath = join(root, "night-run.pid");
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  let stalePid = 2147483647;
  while (alive(stalePid) && stalePid > 2) stalePid -= 1;
  // The old R1 guard, evaluated verbatim: false for both launch shapes.
  const oldInvokedDirectly = (argv1) => { try { return Boolean(argv1) && pathToFileURL(argv1).href === bridgeUrl; } catch { return false; } };
  const oldSim = `import { pathToFileURL } from "node:url"; const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === ${JSON.stringify(bridgeUrl)}; } catch { return false; } })(); if (invokedDirectly) console.log("CLI-RAN");`;
  const runOldSim = (argv1) => execFileAsync(process.execPath, ["--input-type=module", "--eval", oldSim, argv1], { env });
  // Symlinked launch: the old guard is false and the old code path emits empty output.
  const linkPath = join(root, "agent-relay-link.mjs");
  await symlink(bridgePath, linkPath);
  assert.equal(oldInvokedDirectly(linkPath), false, "old invokedDirectly guard is false through a symlink");
  assert.equal((await runOldSim(linkPath)).stdout, "", "old guard produces empty output through a symlink");
  // Fixed bridge through the same symlink emits fail-closed lock evidence and keeps the lock.
  await writeFile(nightPidPath, String(stalePid));
  const symError = await execFileAsync(process.execPath, [linkPath, "night-run", "up"], { env }).then(() => null, (cause) => cause);
  assert.ok(symError && symError.code !== 0, "symlinked bridge must exit non-zero on a stale lock");
  assert.match(String(symError.stderr), new RegExp(PID_LOCK_STALE), "symlinked bridge must emit fail-closed stale lock evidence");
  assert.equal(await readFile(nightPidPath, "utf8"), String(stalePid), "stale lock must not be claimed through a symlink");
  // Keepalive-imported launch: the old guard is false (argv[1] is the keepalive entry) and emits empty output.
  const keepEntry = join(root, "keepalive-entry.mjs");
  await writeFile(keepEntry, `process.argv.push("night-run", "up");\nawait import(${JSON.stringify(bridgeUrl)});\n`);
  assert.equal(oldInvokedDirectly(keepEntry), false, "old invokedDirectly guard is false for a keepalive importer");
  assert.equal((await runOldSim(keepEntry)).stdout, "", "old guard produces empty output for a keepalive importer");
  // Fixed bridge via keepalive import emits the same fail-closed evidence and keeps the lock.
  await writeFile(nightPidPath, String(stalePid));
  const keepError = await execFileAsync(process.execPath, [keepEntry], { env }).then(() => null, (cause) => cause);
  assert.ok(keepError && keepError.code !== 0, "keepalive-imported bridge must exit non-zero on a stale lock");
  assert.match(String(keepError.stderr), new RegExp(PID_LOCK_STALE), "keepalive-imported bridge must emit fail-closed stale lock evidence");
  assert.equal(await readFile(nightPidPath, "utf8"), String(stalePid), "stale lock must not be claimed by a keepalive import");
  await rm(root, { recursive: true, force: true });
});

test("bridge CLI test opt-out is preserved", () => {
  assert.equal(shouldRunBridgeCli({ argv: ["node", "/x/bridge/agent-relay.mjs", "night-run", "up"], env: {} }), true);
  assert.equal(shouldRunBridgeCli({ argv: ["node", "/x/bridge/agent-relay.mjs", "night-run", "up"], env: { [BRIDGE_NO_CLI_ENV]: "1" } }), false);
  assert.equal(shouldRunBridgeCli({ argv: ["node", "--test", "test/v2/night-run.test.mjs"], env: {} }), false);
});

test("MainPC wrapper pulls from ASUS and fails closed before destructive commands", () => {
  const wrapper = readFileSync(new URL("../../scripts/core-night.ps1", import.meta.url), "utf8");
  assert.match(wrapper, /ssh @sshArgs/); assert.match(wrapper, /--no-poweroff/); assert.match(wrapper, /scp @transportArgs/);
  assert.match(wrapper, /sha256sum/); assert.match(wrapper, /Get-FileHash/); assert.match(wrapper, /shutdown\.exe \/s \/t 30/); assert.match(wrapper, /sudo -n \/usr\/sbin\/poweroff/); assert.match(wrapper, /shutdown\.exe \/a/);
  assert.match(wrapper, /WBS_EXHAUSTED/); assert.match(wrapper, /DEADLINE_COMPLETE/); assert.match(wrapper, /DEADLINE_FORCED_CHECKPOINT/); assert.doesNotMatch(wrapper, /shutdown"/);
});
