/* Start-view default (Control Room) — pure helper tests.
   Runs against the compiled shared module (dist/server/shared/types.js),
   mirroring test/cr08.test.mjs conventions. */
import assert from "node:assert/strict";
import test from "node:test";
import { parseStartView } from "../dist/server/shared/types.js";

test("parseStartView — missing/unknown resolves to 'control-room'", () => {
  assert.equal(parseStartView([]), "control-room");
  assert.equal(parseStartView(["--view=bogus"]), "control-room");
});

test("parseStartView — explicit values are unchanged", () => {
  assert.equal(parseStartView(["--view=home"]), "home");
  assert.equal(parseStartView(["--view=plan-studio"]), "plan-studio");
});

test("parseStartView — last --view wins", () => {
  assert.equal(parseStartView(["--view=home", "--view=plan-studio"]), "plan-studio");
  assert.equal(parseStartView(["--view=plan-studio", "--view=home"]), "home");
});
