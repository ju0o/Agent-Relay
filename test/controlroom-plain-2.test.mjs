import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROJECT_LABELS, holdCardMessage, visibleHoldEntries, normalizeHoldEntry, HOLD_OPTION_LABELS } from "../dist/server/shared/projectLabels.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("shared label map uses plain names without raw lane ids", () => {
  assert.equal(PROJECT_LABELS["juactl"]?.name, "actl");
  assert.equal(PROJECT_LABELS["jucontroler-app"]?.name, "통합 관제 화면");
  assert.equal(PROJECT_LABELS["juceipt-planning"]?.name, "JuCeipt 기획");
  for (const id of ["juactl", "jucontroler-app", "juceipt-planning"]) {
    assert.doesNotMatch(PROJECT_LABELS[id].name, new RegExp(`\\(${id}\\)`));
  }
});

test("controlRoom has no quota/board jargon", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.doesNotMatch(source, /quota/);
  assert.doesNotMatch(source, /board를 읽습니다/);
  assert.match(source, /5초마다 자동으로 새로 고쳐요\./);
  assert.doesNotMatch(source, /WORKER → QA/);
  assert.doesNotMatch(source, /<h1>Control Room<\/h1>/);
  assert.doesNotMatch(source, /Worker Agent 바꾸기/);
  assert.doesNotMatch(source, /QA Agent 바꾸기/);
  assert.match(source, /관제실/);
  assert.match(source, /담당 AI/);
  assert.match(source, /만드는 AI 바꾸기/);
  assert.match(source, /검수하는 AI 바꾸기/);
});

test("hold card render helper returns null for an empty hold", () => {
  assert.equal(holdCardMessage("", ""), null);
  assert.equal(holdCardMessage(undefined, []), null);
  assert.equal(holdCardMessage("   ", "—"), null);
  const message = holdCardMessage("", "Founder 승인 대기");
  assert.match(message ?? "", /보류/);
});

test("hold with explain.sentence keeps the Korean sentence and 3 options", () => {
  assert.equal(HOLD_OPTION_LABELS.length, 3);
  const holds = visibleHoldEntries([
    {
      taskId: "T-1",
      reason: "QA FAILED: missing evidence file",
      step: "검수",
      explain: { sentence: "검수 자료가 빠져서 멈췄어요." },
      choice: "다시 시도",
    },
  ]);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].sentence, "검수 자료가 빠져서 멈췄어요.");
  assert.equal(holds[0].options.length, 3);
  assert.ok(holds[0].recommendedIndex >= 0 && holds[0].recommendedIndex < 3);
  assert.equal(holds[0].options[holds[0].recommendedIndex], "다시 시도");
});

test("hold without explain falls back to the plain hold message", () => {
  const holds = visibleHoldEntries(["Founder 승인 대기"]);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].sentence, "");
  const message = holdCardMessage("", holds[0].reason);
  assert.match(message ?? "", /보류/);
});

test("hold with choice skip is not shown", () => {
  const holds = visibleHoldEntries([
    { taskId: "T-skip", reason: "stale hold", explain: { sentence: "이미 지난 보류입니다." }, choice: "skip" },
    "Founder 승인 대기",
  ]);
  assert.equal(holds.length, 1);
  assert.equal(holds[0].reason, "Founder 승인 대기");
  assert.equal(normalizeHoldEntry({ reason: "x", choice: " skip " }), null);
});

test("controlRoom hold card shows explain sentence with recommended option", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /explain/);
  assert.match(source, /sentence/);
  assert.match(source, /원문 보기/);
  assert.match(source, /추천/);
  assert.match(source, /skip/);
});
