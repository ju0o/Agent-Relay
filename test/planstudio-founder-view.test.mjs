/* Plan Studio founder view — ordering helper + Korean label guard.
   Covers sortPlanStudioTasks() from src/shared/types.ts (via
   dist/server/shared/types.js): active/queued first, then HOLD, then finished,
   stable within groups. Also asserts the English-heavy labels
   ('TASK CHAIN', 'PLANSTUDIO:CHAT', 'gate가 없습니다') no longer appear in
   src/frontend/planStudio.tsx. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPlanStudioTaskDone,
  isPlanStudioTaskHold,
  planStudioTaskGroup,
  sortPlanStudioTasks,
} from "../dist/server/shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioSrc = fs.readFileSync(path.join(here, "..", "src", "frontend", "planStudio.tsx"), "utf8");

test("sortPlanStudioTasks — active first, then HOLD, then finished", () => {
  const tasks = [
    { id: "done-1", stage: 6, blocker: "" },
    { id: "hold-1", stage: 2, blocker: "waiting on founder" },
    { id: "active-1", stage: 0, blocker: "" },
    { id: "active-2", stage: 3, blocker: "" },
  ];
  const ordered = sortPlanStudioTasks(tasks).map((t) => t.id);
  assert.deepEqual(ordered, ["active-1", "active-2", "hold-1", "done-1"]);
});

test("sortPlanStudioTasks — finished detected by stage string, HOLD by stage too", () => {
  const tasks = [
    { id: "done-str", stage: "DONE", blocker: "" },
    { id: "hold-str", stage: "HOLD", blocker: "" },
    { id: "queued", stage: "queued", blocker: "" },
  ];
  const ordered = sortPlanStudioTasks(tasks).map((t) => t.id);
  assert.deepEqual(ordered, ["queued", "hold-str", "done-str"]);
  assert.equal(isPlanStudioTaskDone({ stage: "DONE" }), true);
  assert.equal(isPlanStudioTaskDone({ stage: "반영" }), true);
  assert.equal(isPlanStudioTaskDone({ stage: 2 }), false);
  assert.equal(isPlanStudioTaskHold({ stage: "HOLD", blocker: "" }), true);
  assert.equal(isPlanStudioTaskHold({ stage: 2, blocker: "x" }), true);
  assert.equal(isPlanStudioTaskHold({ stage: 2, blocker: "" }), false);
});

test("sortPlanStudioTasks — done wins over hold, stable within groups", () => {
  assert.equal(planStudioTaskGroup({ stage: "DONE", blocker: "stuck" }), "done");
  assert.equal(planStudioTaskGroup({ stage: 2, blocker: "stuck" }), "hold");
  assert.equal(planStudioTaskGroup({ stage: 0, blocker: "" }), "active");
  const tasks = [
    { id: "b", stage: 1, blocker: "" },
    { id: "a", stage: 0, blocker: "" },
    { id: "c", stage: 5, blocker: "" },
  ];
  assert.deepEqual(sortPlanStudioTasks(tasks).map((t) => t.id), ["b", "a", "c"]);
  // does not mutate the input
  assert.deepEqual(tasks.map((t) => t.id), ["b", "a", "c"]);
});

test("planStudio.tsx — English-heavy labels are gone", () => {
  assert.ok(!studioSrc.includes("TASK CHAIN"), "'TASK CHAIN' should be renamed");
  assert.ok(!studioSrc.includes("Task chain"), "'Task chain' should be renamed");
  assert.ok(!studioSrc.includes("PLANSTUDIO:CHAT"), "'PLANSTUDIO:CHAT' should be renamed");
  assert.ok(!studioSrc.includes("PM chat (planStudio:chat)"), "'PM chat (planStudio:chat)' should be renamed");
  assert.ok(!studioSrc.includes("gate가 없습니다"), "'gate가 없습니다' should be renamed");
  assert.ok(!studioSrc.includes("board에 lane이 없습니다."), "board empty copy should be Korean");
  assert.ok(!studioSrc.includes("표시할 task가 없습니다."), "task empty copy should be Korean");
  assert.ok(!studioSrc.includes("task를 선택하세요."), "task selection copy should be Korean");
  assert.ok(!studioSrc.includes("Blocker:"), "blocker label should be Korean");
  assert.ok(!studioSrc.includes("시작 전 task 삭제"), "delete title should be Korean");
});

test("planStudio.tsx — raw gate ID is collapsed", () => {
  assert.match(
    studioSrc,
    /<details>\s*<summary>원문 보기<\/summary><p className="muted mono" style=\{\{ fontSize: 11 \}\}>\{gate\.gateId\}<\/p><\/details>/,
    "gateId should render inside a collapsed raw-value disclosure",
  );
});

test("planStudio.tsx — Founder Korean labels present, finished toggle closed by default", () => {
  assert.ok(studioSrc.includes("작업 순서 ("), "missing '작업 순서 (N개)' heading");
  assert.ok(studioSrc.includes("PM에게 요청"), "missing 'PM에게 요청' heading");
  assert.ok(studioSrc.includes("선택한 작업"), "missing '선택한 작업' heading");
  assert.ok(studioSrc.includes("사람 확인"), "missing '사람 확인' heading");
  assert.ok(studioSrc.includes("지금 답할 것이 없어요."), "missing empty-gate copy");
  assert.ok(studioSrc.includes("PM이 답하면 작업 순서가 새로 그려져요."), "missing chat helper copy");
  assert.ok(studioSrc.includes("끝난 작업"), "missing finished-tasks toggle");
  assert.match(studioSrc, /showDone.*useState\(false\)|useState\(false\)[\s\S]*showDone/, "finished toggle should be closed by default");
  assert.ok(studioSrc.includes("sortPlanStudioTasks"), "should order via the shared helper");
});
