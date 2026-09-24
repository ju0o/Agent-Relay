/* R5/R6 관제실: 맨 위 '오늘 끝난 일' 카드 + '지금 일하는 AI' 한 줄,
   모델 사용량 접힌 details, 현재 작업 한국어 title(ID는 원문 보기),
   빈 레인은 전 단계 pending + '쉬는 중'.
   Backend pure helpers → dist/server/backend/controlRoom.js,
   렌더 규격 → src 소스 grep. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  currentTaskId,
  currentTaskTitle,
  elapsedKorean,
  hasCurrentWork,
  laneStageLabel,
  laneWorkerName,
  normalizeTodayDone,
  whoSegmentForLane,
  workingSummary,
} from "../dist/server/backend/controlRoom.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("normalizeTodayDone — board.todayDone 배열을 lane·taskId·title로", () => {
  assert.deepEqual(normalizeTodayDone(null), []);
  assert.deepEqual(normalizeTodayDone({}), []);
  const items = normalizeTodayDone({
    todayDone: [{ lane: "agent-relay", taskId: "T-1", title: "로그인 고치기" }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].lane, "agent-relay");
  assert.equal(items[0].taskId, "T-1");
  assert.equal(items[0].title, "로그인 고치기");
});

test("normalizeTodayDone — lane별 doneToday도 모은다", () => {
  const items = normalizeTodayDone({
    lanes: [
      { project: "agent-relay", doneToday: ["T-9"] },
      { project: "juplan", todayDone: [{ taskId: "P-2", title: "계획 정리" }] },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].lane, "agent-relay");
  assert.equal(items[0].title, "T-9");
  assert.equal(items[1].lane, "juplan");
  assert.equal(items[1].title, "계획 정리");
});

test("currentTaskTitle — 한국어 title 우선, 없으면 ID 폴백", () => {
  assert.equal(currentTaskTitle({ taskId: "T-1", title: "로그인 고치기" }), "로그인 고치기");
  assert.equal(currentTaskTitle({ taskId: "T-2" }), "T-2");
  assert.equal(currentTaskTitle({}), "");
  assert.equal(currentTaskId({ taskId: "T-1", title: "로그인 고치기" }), "T-1");
});

test("hasCurrentWork — title/ID 없으면 쉬는 중", () => {
  assert.equal(hasCurrentWork({ current: { taskId: "T-1" } }), true);
  assert.equal(hasCurrentWork({ current: { title: "할 일" } }), true);
  assert.equal(hasCurrentWork({ current: {} }), false);
  assert.equal(hasCurrentWork({}), false);
  assert.equal(hasCurrentWork(null), false);
});

test("elapsedKorean — 방금/분/시간/일 한국어 경과", () => {
  const now = Date.parse("2026-09-24T12:00:00+09:00");
  assert.equal(elapsedKorean(new Date(now - 10_000).toISOString(), now), "방금 시작");
  assert.equal(elapsedKorean(new Date(now - 12 * 60000).toISOString(), now), "12분째");
  assert.equal(elapsedKorean(new Date(now - 65 * 60000).toISOString(), now), "1시간 5분째");
  assert.equal(elapsedKorean("not-a-date", now), "");
});

test("whoSegment/workingSummary — 레인·단계·경과 한 줄, 없으면 쉬는 중", () => {
  const now = Date.parse("2026-09-24T12:00:00+09:00");
  const lane = {
    project: "agent-relay",
    current: { stage: 2, taskId: "T-1", title: "로그인 고치기", startedAt: new Date(now - 12 * 60000).toISOString() },
    workerChain: ["codex"],
  };
  const segment = whoSegmentForLane(lane, now);
  assert.ok(segment);
  assert.match(segment, /agent-relay/);
  assert.match(segment, /작업/);
  assert.match(segment, /12분째/);
  assert.match(segment, /codex/);
  assert.equal(whoSegmentForLane({ current: {} }, now), null);
  assert.match(workingSummary([lane], now), /지금 일하는 AI/);
  assert.match(workingSummary([lane], now), /12분째/);
  assert.match(workingSummary([], now), /쉬는 중/);
  assert.equal(laneStageLabel(2), "작업");
  assert.equal(laneWorkerName(lane), "codex");
});

test("controlRoom.tsx — 오늘 카드 + 지금 일하는 AI 한 줄이 맨 위", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /오늘 끝난 일/);
  assert.match(source, /aria-label="오늘 끝난 일"/);
  assert.match(source, /오늘 끝난 일은 아직 없어요/);
  assert.match(source, /지금 일하는 AI/);
  assert.match(source, /aria-label="지금 일하는 AI"/);
  assert.match(source, /쉬는 중/);
  const head = source.indexOf("<h1>관제실</h1>");
  const todayUse = source.indexOf("<TodayCard", head);
  const whoUse = source.indexOf("<WhoLine", head);
  const tabs = source.indexOf("control-tabs", head);
  assert.ok(head >= 0 && todayUse > head && whoUse > head, "today/who must render below header");
  assert.ok(todayUse < tabs && whoUse < tabs, "today/who must render above lane tabs");
});

test("controlRoom.tsx — 현재 작업은 title, ID는 원문 보기, 빈 레인은 pending", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /currentTitleOf/);
  assert.match(source, /ID: \{taskId\}/);
  assert.match(source, /working \? flowState\(stageValue, index\) : 'pending'/);
  assert.match(source, /단계: \{stage\}/);
  assert.doesNotMatch(source, /label\(current\.taskId, '지금 하는 일 없음'\)/);
});

test("모델 사용량은 접힌 details", async () => {
  const approvals = await read("src/frontend/approvals.tsx");
  assert.match(approvals, /<details/);
  assert.match(approvals, /<summary>모델 사용량/);
  assert.doesNotMatch(approvals, /<section className="model-usage"/);
  const room = await read("src/frontend/controlRoom.tsx");
  assert.match(room, /<TodayCard board=\{board\} \/>/);
  assert.match(room, /<WhoLine lanes=\{lanes\} \/>/);
});
