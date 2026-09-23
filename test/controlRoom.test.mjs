import assert from "node:assert/strict";
import test from "node:test";
import { ControlRoomError, runControlRoom, runControlRoomApprovalAdd, runControlRoomLaneSet, runControlRoomResume, runGateAnswer, runGatesList, runPlanStudioApprove, runPlanStudioChat, runPlanStudioGet, runPlanStudioSave, shQuote } from "../dist/server/backend/controlRoom.js";

test("board uses the fixed ssh command and parses JSON", async () => {
  let call;
  const value = await runControlRoom("board", async (...args) => {
    call = args;
    return { stdout: '{"lanes":[]}', stderr: "" };
  });

  assert.deepEqual(value, { lanes: [] });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "board", "--json"]);
  assert.deepEqual(call[2], { shell: false, timeout: 10_000 });
});

test("approvals uses the fixed ssh command", async () => {
  let call;
  const value = await runControlRoom("approvals", async (...args) => {
    call = args;
    return { stdout: "[]", stderr: "" };
  });

  assert.deepEqual(value, []);
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "approvals", "list", "--json"]);
  assert.deepEqual(call[2], { shell: false, timeout: 10_000 });
});

test("command failures and invalid JSON are typed", async () => {
  const failed = await runControlRoom("board", async () => { throw new Error("offline"); }).catch((error) => error);
  assert.ok(failed instanceof ControlRoomError);
  assert.equal(failed.code, "EXEC_FAILED");

  const invalid = await runControlRoom("approvals", async () => ({ stdout: "nope", stderr: "" })).catch((error) => error);
  assert.ok(invalid instanceof ControlRoomError);
  assert.equal(invalid.code, "INVALID_JSON");
});

test("planStudio:get uses roadmap get with validated project", async () => {
  let call;
  const value = await runPlanStudioGet("agent-relay", async (...args) => {
    call = args;
    return { stdout: '{"draft":"x"}', stderr: "" };
  });

  assert.deepEqual(value, { draft: "x" });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "roadmap", "get", "agent-relay", "--json"]);
  assert.equal(call[2].shell, false);
});

test("planStudio:save passes draft via stdin, never argv", async () => {
  let call;
  const value = await runPlanStudioSave("agent-relay", '{"a":1}', async (...args) => {
    call = args;
    return { stdout: '{"ok":true}', stderr: "" };
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "roadmap", "save", "agent-relay", "--json"]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].input, '{"a":1}');
  assert.ok(!call[1].includes('{"a":1}'));
});

test("planStudio:chat passes message via stdin, never argv", async () => {
  let call;
  const value = await runPlanStudioChat("agent-relay", "hello; rm -rf /", async (...args) => {
    call = args;
    return { stdout: '{"reply":"hi"}', stderr: "" };
  });

  assert.deepEqual(value, { reply: "hi" });
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "roadmap", "chat", "agent-relay", "--json"]);
  assert.equal(call[2].input, "hello; rm -rf /");
  assert.ok(!call[1].includes("hello; rm -rf /"));
});

test("planStudio:approve uses roadmap approve", async () => {
  let call;
  const value = await runPlanStudioApprove("agent-relay", async (...args) => {
    call = args;
    return { stdout: '{"approved":true}', stderr: "" };
  });

  assert.deepEqual(value, { approved: true });
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "roadmap", "approve", "agent-relay", "--json"]);
});

test("gates:list uses gate list", async () => {
  let call;
  const value = await runGatesList(async (...args) => {
    call = args;
    return { stdout: "[]", stderr: "" };
  });

  assert.deepEqual(value, []);
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "gate", "list", "--json"]);
  assert.equal(call[2].shell, false);
});

test("gates:answer uses gate answer with validated ids", async () => {
  let call;
  const value = await runGateAnswer("FG-a7ac130dd74dead09ac35559", 1, async (...args) => {
    call = args;
    return { stdout: '{"ok":true}', stderr: "" };
  });

  assert.deepEqual(value, { ok: true });
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "gate", "answer", "FG-a7ac130dd74dead09ac35559", "1", "--json"]);
});

test("invalid project, gate and option inputs throw before spawning", async () => {
  let spawned = 0;
  const fake = async () => { spawned += 1; return { stdout: "{}", stderr: "" }; };

  for (const bad of ["", "ABC", "a", "a; rm -rf /", "a b", "-lead"]) {
    const err = await runPlanStudioGet(bad, fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, bad);
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "planStudio:get");
  }

  const badGate = await runGateAnswer("bad id!", 0, fake).catch((e) => e);
  assert.ok(badGate instanceof ControlRoomError);
  assert.equal(badGate.code, "INVALID_INPUT");

  for (const badIndex of [-1, 1.5, Number.NaN, "1", null, 100000]) {
    const err = await runGateAnswer("FG-ok_123", badIndex, fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError);
    assert.equal(err.code, "INVALID_INPUT");
  }

  const emptyDraft = await runPlanStudioSave("agent-relay", "", fake).catch((e) => e);
  assert.ok(emptyDraft instanceof ControlRoomError);
  assert.equal(emptyDraft.code, "INVALID_INPUT");

  assert.equal(spawned, 0);
});

test("planStudio and gates surface EXEC_FAILED and INVALID_JSON", async () => {
  const failed = await runPlanStudioGet("agent-relay", async () => { throw new Error("offline"); }).catch((e) => e);
  assert.ok(failed instanceof ControlRoomError);
  assert.equal(failed.code, "EXEC_FAILED");
  assert.equal(failed.operation, "planStudio:get");

  const invalid = await runGatesList(async () => ({ stdout: "nope", stderr: "" })).catch((e) => e);
  assert.ok(invalid instanceof ControlRoomError);
  assert.equal(invalid.code, "INVALID_JSON");
});

test("controlRoom:laneSet uses lane set with quoted args and parses JSON", async () => {
  let call;
  const value = await runControlRoomLaneSet("agent-relay", "worker", ["codex", "opencode"], async (...args) => {
    call = args;
    return { stdout: '{"ok":true}', stderr: "" };
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "lane", "set", "'agent-relay'", "'worker'", "'codex,opencode'", "--json"]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, 10_000);
});

test("controlRoom:resume uses roadmap resume with quoted project", async () => {
  let call;
  const value = await runControlRoomResume("agent-relay", async (...args) => {
    call = args;
    return { stdout: '{"resumed":true}', stderr: "" };
  });

  assert.deepEqual(value, { resumed: true });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "roadmap", "resume", "'agent-relay'", "--json"]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, 10_000);
});

test("controlRoom:approvalAdd uses approvals add with quoted args", async () => {
  let call;
  const value = await runControlRoomApprovalAdd("bug-fix", "fix login", async (...args) => {
    call = args;
    return { stdout: '{"ok":true}', stderr: "" };
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "approvals", "add", "'bug-fix'", "'fix login'", "--source", "app"]);
  assert.equal(call[2].shell, false);
  assert.equal(call[2].timeout, 10_000);
});

test("controlRoom write actions reject invalid input before spawning", async () => {
  let spawned = 0;
  const fake = async () => { spawned += 1; return { stdout: "{}", stderr: "" }; };

  for (const bad of ["", "ABC", "a", "a; rm -rf /", "a b", "-lead"]) {
    const err = await runControlRoomLaneSet(bad, "worker", ["codex"], fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, bad);
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:laneSet");
  }

  for (const badRole of ["", "admin", "Worker", "QA", null, 123, "worker qa"]) {
    const err = await runControlRoomLaneSet("agent-relay", badRole, ["codex"], fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, String(badRole));
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:laneSet");
  }

  const badRuntimes = [
    [],
    ["codex", "codex"],
    ["bogus"],
    ["codex", "opencode", "cline", "grok", "cursor"],
    "codex",
    null,
    ["codex", 123],
    [["codex"]],
  ];
  for (const bad of badRuntimes) {
    const err = await runControlRoomLaneSet("agent-relay", "qa", bad, fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, JSON.stringify(bad));
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:laneSet");
  }

  for (const bad of ["", "ABC", "a b", "-lead"]) {
    const err = await runControlRoomResume(bad, fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, bad);
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:resume");
  }

  for (const bad of ["", "A", "a", "ab c", "BUG", "a;rm", "x".repeat(31), "ok!", null, 123]) {
    const err = await runControlRoomApprovalAdd(bad, "ok summary", fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, String(bad));
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:approvalAdd");
  }

  for (const bad of ["", "x".repeat(201), null, 123]) {
    const err = await runControlRoomApprovalAdd("bug-fix", bad, fake).catch((e) => e);
    assert.ok(err instanceof ControlRoomError, String(bad)?.slice(0, 20));
    assert.equal(err.code, "INVALID_INPUT");
    assert.equal(err.operation, "controlRoom:approvalAdd");
  }

  assert.equal(spawned, 0);
});

test("controlRoom write actions surface EXEC_FAILED and INVALID_JSON", async () => {
  const failed = await runControlRoomLaneSet("agent-relay", "worker", ["codex"], async () => { throw new Error("offline"); }).catch((e) => e);
  assert.ok(failed instanceof ControlRoomError);
  assert.equal(failed.code, "EXEC_FAILED");
  assert.equal(failed.operation, "controlRoom:laneSet");

  const invalidResume = await runControlRoomResume("agent-relay", async () => ({ stdout: "nope", stderr: "" })).catch((e) => e);
  assert.ok(invalidResume instanceof ControlRoomError);
  assert.equal(invalidResume.code, "INVALID_JSON");
  assert.equal(invalidResume.operation, "controlRoom:resume");

  const invalidAdd = await runControlRoomApprovalAdd("bug-fix", "hi", async () => ({ stdout: "nope", stderr: "" })).catch((e) => e);
  assert.ok(invalidAdd instanceof ControlRoomError);
  assert.equal(invalidAdd.code, "INVALID_JSON");
  assert.equal(invalidAdd.operation, "controlRoom:approvalAdd");
});

test("injection payload stays inside one single-quoted argument", async () => {
  const summary = "'; rm -rf ~";
  let call;
  const value = await runControlRoomApprovalAdd("bug-fix", summary, async (...args) => {
    call = args;
    return { stdout: '{"ok":true}', stderr: "" };
  });

  assert.deepEqual(value, { ok: true });
  const expected = shQuote(summary);
  assert.equal(expected, `''\\''; rm -rf ~'`);
  assert.ok(call[1].includes(expected));
  const hits = call[1].filter((a) => a.includes("rm -rf"));
  assert.equal(hits.length, 1);
  assert.ok(hits[0].startsWith("'") && hits[0].endsWith("'"));
  assert.ok(!call[1].includes(summary));
});
