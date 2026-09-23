import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_RULE_ID_PATTERN, ControlRoomError, editApprovalRule, removeApprovalRule, runControlRoom } from "../dist/server/backend/controlRoom.js";

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

test("approvalEdit runs night approvals edit over the same ssh path", async () => {
  let call;
  const value = await editApprovalRule("A-01", "new summary", async (...args) => {
    call = args;
    return { stdout: "edited A-01\n", stderr: "" };
  });

  assert.equal(value, "edited A-01");
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "approvals", "edit", "A-01", "new summary"]);
  assert.deepEqual(call[2], { shell: false, timeout: 10_000 });
});

test("approvalRemove runs night approvals remove over the same ssh path", async () => {
  let call;
  const value = await removeApprovalRule("A-123", async (...args) => {
    call = args;
    return { stdout: "removed A-123\n", stderr: "" };
  });

  assert.equal(value, "removed A-123");
  assert.equal(call[0], "ssh");
  assert.deepEqual(call[1], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus", "~/.agents/skills/auto-night-orchestrator/scripts/night", "approvals", "remove", "A-123"]);
  assert.deepEqual(call[2], { shell: false, timeout: 10_000 });
});

test("approval rule id is validated before spawning", async () => {
  assert.ok(APPROVAL_RULE_ID_PATTERN.test("A-01"));
  assert.ok(APPROVAL_RULE_ID_PATTERN.test("A-123"));
  assert.ok(!APPROVAL_RULE_ID_PATTERN.test("A-1"));
  assert.ok(!APPROVAL_RULE_ID_PATTERN.test("A-1234"));
  assert.ok(!APPROVAL_RULE_ID_PATTERN.test("B-01"));
  assert.ok(!APPROVAL_RULE_ID_PATTERN.test("A-01; rm -rf /"));

  for (const bad of ["X-99", "A-1", "../etc", "A-01;evil"]) {
    let spawned = false;
    const editErr = await editApprovalRule(bad, "summary", async () => { spawned = true; return { stdout: "", stderr: "" }; }).catch((error) => error);
    assert.ok(editErr instanceof ControlRoomError);
    assert.equal(editErr.code, "INVALID_ID");
    assert.equal(spawned, false);

    spawned = false;
    const removeErr = await removeApprovalRule(bad, async () => { spawned = true; return { stdout: "", stderr: "" }; }).catch((error) => error);
    assert.ok(removeErr instanceof ControlRoomError);
    assert.equal(removeErr.code, "INVALID_ID");
    assert.equal(spawned, false);
  }
});
