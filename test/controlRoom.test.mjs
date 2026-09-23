import assert from "node:assert/strict";
import test from "node:test";
import { ControlRoomError, runControlRoom } from "../dist/server/backend/controlRoom.js";

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
