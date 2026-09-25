import assert from "node:assert/strict";
import test from "node:test";
import { ControlRoomError, runControlRoom, runGatesList } from "../dist/server/backend/controlRoom.js";

const fail = (props) => async () => { throw Object.assign(new Error("x"), props); };

test("ssh connected but remote command failed -> REMOTE_FAILED with last 400 chars of stderr", async () => {
  const stderr = "a".repeat(500) + "Traceback: boom";
  for (const run of [
    (exec) => runControlRoom("board", exec),
    (exec) => runGatesList(exec),
  ]) {
    const err = await run(fail({ code: 1, stderr })).catch((e) => e);
    assert.ok(err instanceof ControlRoomError);
    assert.equal(err.code, "REMOTE_FAILED");
    assert.match(err.message, /작업 PC는 켜져 있는데/);
    assert.equal(err.detail.length, 400);
    assert.ok(err.detail.endsWith("Traceback: boom"));
  }
  const tb = await runControlRoom("board", fail({ stderr: "Traceback (most recent call last)" })).catch((e) => e);
  assert.equal(tb.code, "REMOTE_FAILED");
});

test("255 / ETIMEDOUT / ENOENT stay offline", async () => {
  for (const props of [{ code: 255, stderr: "ssh: connect to host asus" }, { code: "ETIMEDOUT" }, { code: "ENOENT" }]) {
    const err = await runControlRoom("approvals", fail(props)).catch((e) => e);
    assert.equal(err.code, "EXEC_FAILED");
    assert.match(err.message, /연결할 수 없습니다/);
    assert.equal(err.detail, undefined);
  }
});
