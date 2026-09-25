/* friendlyErrorMessage — fs errno codes become plain Korean, no code/path.
   Runs against the compiled shared module (dist/server/shared/types.js). */
import assert from "node:assert/strict";
import test from "node:test";
import { friendlyErrorMessage } from "../dist/server/shared/types.js";

const CODES = ["ENOENT", "EACCES", "EPERM", "EEXIST", "ENOSPC", "EBUSY"];

function withCode(code) {
  const err = new Error(`${code}: no such file or directory, open '/tmp/agent-relay-probe'`);
  err.code = code;
  return err;
}

test("friendlyErrorMessage — errno codes map to one plain Korean sentence", () => {
  for (const code of CODES) {
    const out = friendlyErrorMessage(withCode(code));
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0, `${code} mapped to empty string`);
    assert.ok(!out.includes(code), `${code} leaks raw code: ${out}`);
    assert.ok(!out.includes("/tmp/agent-relay-probe"), `leaks path: ${out}`);
    assert.match(out, /[가-힣]/, `${code} is not Korean: ${out}`);
  }
});

test("friendlyErrorMessage — raw 'ENOENT: …' text never reaches the UI", () => {
  const out = friendlyErrorMessage(
    new Error("ENOENT: no such file or directory, open 'C:\\data\\prompt.md'"),
  );
  assert.ok(!out.includes("ENOENT"), `leaks raw code: ${out}`);
  assert.ok(!out.includes("prompt.md"), `leaks path: ${out}`);
  assert.match(out, /[가-힣]/);
});

test("friendlyErrorMessage — other messages pass through unchanged", () => {
  assert.equal(friendlyErrorMessage(new Error("알 수 없는 요청입니다.")), "알 수 없는 요청입니다.");
  assert.equal(friendlyErrorMessage("plain string failure"), "plain string failure");
});
