/* Lane attention badges — pure helper tests.
   Covers laneAttention() behind the Control Room '결정 필요' / '보류' tabs:
   humanGate / founderGate → 'decision', blocker / non-empty holds → 'hold',
   empty lanes → null. Runs against dist/server/shared/types.js. */
import assert from "node:assert/strict";
import test from "node:test";
import { laneAttention } from "../dist/server/shared/types.js";

test("laneAttention — humanGate is truthy → 'decision'", () => {
  assert.equal(laneAttention({ humanGate: { gateId: "G-1" } }), "decision");
  assert.equal(laneAttention({ humanGate: { ask: "pick one" } }), "decision");
});

test("laneAttention — founderGate is truthy → 'decision'", () => {
  assert.equal(laneAttention({ founderGate: { gateId: "FG-1" } }), "decision");
  assert.equal(laneAttention({ founderGate: true }), "decision");
});

test("laneAttention — decision wins over hold signals", () => {
  assert.equal(
    laneAttention({ humanGate: { gateId: "G-1" }, blocker: "stuck", holds: [{ reason: "x" }] }),
    "decision",
  );
  assert.equal(
    laneAttention({ founderGate: { gateId: "FG-1" }, blocker: "stuck" }),
    "decision",
  );
});

test("laneAttention — blocker is truthy → 'hold'", () => {
  assert.equal(laneAttention({ blocker: "waiting on founder" }), "hold");
  assert.equal(laneAttention({ blocker: "x", humanGate: null, founderGate: undefined }), "hold");
});

test("laneAttention — non-empty holds array → 'hold'", () => {
  assert.equal(laneAttention({ holds: [{ taskId: "T-1", reason: "scope" }] }), "hold");
  assert.equal(laneAttention({ holds: ["paused"] }), "hold");
});

test("laneAttention — empty lanes → null", () => {
  assert.equal(laneAttention({}), null);
  assert.equal(laneAttention({ humanGate: null, founderGate: undefined }), null);
  assert.equal(laneAttention({ blocker: "", holds: [] }), null);
  assert.equal(laneAttention({ blocker: "   ".trim(), holds: [] }), null);
  assert.equal(laneAttention(null), null);
  assert.equal(laneAttention(undefined), null);
});
