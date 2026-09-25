import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HOLD_OPTION_LABELS,
  holdCardMessage,
  holdStepLabel,
  isSelfReviewOption,
  normalizeHoldEntry,
  visibleHoldEntries,
} from "../dist/server/shared/projectLabels.js";
import {
  holdOptionAction,
  isHoldSelfReviewOption,
} from "../dist/server/backend/controlRoom.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("hold option labels use '내가 직접 볼게요' (no 'Founder에게 확인')", () => {
  assert.deepEqual([...HOLD_OPTION_LABELS], ["다시 시도", "다음 작업으로 진행", "내가 직접 볼게요"]);
  assert.ok(!HOLD_OPTION_LABELS.includes("Founder에게 확인"));
});

test("recommended index still resolves for new + legacy choice text", () => {
  const direct = visibleHoldEntries([
    { taskId: "T-1", reason: "QA FAILED", step: "검수", explain: { sentence: "검수 자료가 빠져서 멈췄어요." }, choice: "내가 직접 볼게요" },
  ]);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].options[2], "내가 직접 볼게요");
  assert.equal(direct[0].recommendedIndex, 2);

  const legacy = normalizeHoldEntry({ reason: "x", step: "검수", explain: { sentence: "멈췄어요." }, choice: "Founder에게 확인" });
  assert.ok(legacy);
  assert.equal(legacy.recommendedIndex, 2);
});

test("step wording is unified to '검수'", () => {
  for (const raw of ["QA", "qa", "검증", "확인", "검수"]) {
    assert.equal(holdStepLabel(raw), "검수");
  }
  assert.equal(holdStepLabel("작업"), "작업");
  assert.equal(holdStepLabel(""), "");
});

test("self-review option never triggers a backend call", () => {
  assert.equal(isSelfReviewOption("내가 직접 볼게요"), true);
  assert.equal(isSelfReviewOption("다시 시도"), false);
  assert.equal(isHoldSelfReviewOption("내가 직접 볼게요"), true);
  assert.equal(holdOptionAction("내가 직접 볼게요", false), "none");
  assert.equal(holdOptionAction("내가 직접 볼게요", true), "none");
  assert.equal(holdOptionAction("다시 시도", false), "resume");
  assert.equal(holdOptionAction("다시 시도", true), "gate");
});

test("controlRoom renders hold options as buttons with recommend + inline confirm", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /HoldOptionButtons/);
  assert.match(source, /className="hold-options"/);
  assert.match(source, /hold-option/);
  assert.match(source, /recommended/);
  assert.match(source, /\(추천\)/);
  assert.match(source, /하시겠어요/);
  assert.match(source, /취소/);
  assert.match(source, /holdStepLabel/);
  assert.match(source, /op: 'controlRoom:resume'/);
  assert.match(source, /op: 'gates:answer'/);
  assert.doesNotMatch(source, /<ul className="hold-options">/);
  // user-facing hold card no longer shows the old label or raw 검증 step
  assert.doesNotMatch(source, /단계: \{hold\.step\}/);
});

test("hold button styles emphasize the recommendation", async () => {
  const css = await read("src/frontend/style.css");
  assert.match(css, /\.hold-option\.recommended/);
  assert.match(css, /\.hold-confirm/);
  assert.match(css, /\.hold-options/);
});

test("hold card headline does not include the raw English QA reason", () => {
  const reason = "QA FAILED: missing evidence file";
  const message = holdCardMessage("", reason);
  assert.match(message ?? "", /보류/);
  assert.doesNotMatch(message ?? "", /QA FAILED|missing evidence|[A-Za-z]{4,}/);
  assert.equal(holdCardMessage("", "  "), null);
});
