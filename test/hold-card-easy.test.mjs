import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  holdAutoProceedText,
  holdFlowStates,
  holdHeadingText,
  normalizeHoldEntry,
} from "../dist/server/shared/projectLabels.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("heading is '멈춘 작업 N개' without 보류/차단", () => {
  assert.equal(holdHeadingText(2), "멈춘 작업 2개");
  assert.doesNotMatch(holdHeadingText(1), /보류|차단/);
});

test("flow states: before hold done, hold step warned, rest pending", () => {
  const names = holdFlowStates("QA").map(s => s.name);
  assert.deepEqual(names, ["PM", "Worker", "QA", "Tester", "반영"]);
  assert.deepEqual(holdFlowStates("검수").map(s => s.state), ["done", "done", "hold", "pending", "pending"]);
  assert.deepEqual(holdFlowStates("작업").map(s => s.state), ["done", "hold", "pending", "pending", "pending"]);
  assert.deepEqual(holdFlowStates(4).map(s => s.state), ["done", "done", "done", "hold", "pending"]);
  assert.deepEqual(holdFlowStates("시험").map(s => s.state), ["done", "done", "done", "hold", "pending"]);
  assert.deepEqual(holdFlowStates("").map(s => s.state), Array(5).fill("pending"));
  assert.deepEqual(holdFlowStates("???").map(s => s.state), Array(5).fill("pending"));
});

test("auto-proceed text uses local HH:MM and needs both fields", () => {
  const start = new Date(2026, 0, 2, 9, 50, 0);
  assert.equal(holdAutoProceedText(start.getTime(), 30), "아무것도 안 고르면 10:20에 추천대로 진행해요");
  assert.equal(holdAutoProceedText(Math.floor(start.getTime() / 1000), 15), "아무것도 안 고르면 10:05에 추천대로 진행해요");
  assert.equal(holdAutoProceedText(start.toISOString(), 10), "아무것도 안 고르면 10:00에 추천대로 진행해요");
  assert.equal(holdAutoProceedText(null, 30), "");
  assert.equal(holdAutoProceedText(start.getTime(), undefined), "");
  assert.equal(holdAutoProceedText("nope", 5), "");
});

test("normalized hold carries option details, saved choice label, heldSeen and waitMin", () => {
  const hold = normalizeHoldEntry({
    taskId: "T-1",
    step: "검수",
    heldSeen: 1767347400,
    waitMin: 20,
    explain: {
      sentence: "선택해 주세요.",
      options: [
        { id: "retry", label: "다시 시도", detail: "한 번 더" },
        { id: "narrow", label: "범위를 좁혀 진행", detail: "범위 조정" },
        { id: "skip", label: "건너뛰기", detail: "생략" },
      ],
    },
    choice: "narrow",
  });
  assert.deepEqual(hold.optionDetails, ["한 번 더", "범위 조정", "생략"]);
  assert.equal(hold.choiceLabel, "범위를 좁혀 진행");
  assert.equal(hold.heldSeen, 1767347400);
  assert.equal(hold.waitMin, 20);
  const plain = normalizeHoldEntry({ taskId: "T-2", reason: "x", explain: { sentence: "멈췄어요." } });
  assert.equal(plain.choiceLabel, "");
  assert.equal(plain.heldSeen, null);
  assert.equal(plain.waitMin, null);
  assert.equal(plain.optionDetails.length, 3);
});

test("controlRoom hold card: per-hold cards, 3 then 더 보기, radio + 이대로 진행, saved line", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  const css = await read("src/frontend/style.css");
  assert.doesNotMatch(source, /보류 \/ 차단/);
  assert.match(source, /holdHeadingText\(count\)/);
  assert.match(source, /HOLD_PAGE = 3/);
  assert.match(source, /더 보기/);
  assert.match(source, /type="radio"/);
  assert.match(source, /이대로 진행/);
  assert.match(source, /그래서/);
  assert.match(source, /선택했어요: \{savedLabel\} · 곧 다시 설계해요/);
  assert.match(source, /쉬운 말로 바꾸는 중이에요…/);
  assert.match(source, /holdAutoProceedText/);
  assert.match(source, /원문 보기/);
  assert.doesNotMatch(source, /window\.(prompt|confirm)/);
  assert.match(css, /\.hold-sentence\s*\{[^}]*font-size:\s*18px/);
  assert.match(css, /\.control-card\.hold-warn/);
  assert.match(css, /\.hold-flow-step\.hold/);
});
