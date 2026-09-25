/* R2-2 honest "오늘 끝난 일": real board sends only lanes[].counts
   (VERIFIED_DONE totals) with no dated done list → do not claim zero,
   show '오늘 기록은 아직 안 왔어요 · 지금까지 끝난 작업 N개'.
   Dated lane.done[{taskId,title,finishedAt}] → local-date match → '오늘 N개 끝났어요'. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  controlRoomHasDoneData,
  controlRoomTodayCount,
  controlRoomTodayDone,
  controlRoomVerifiedDoneTotal,
} from "../dist/server/shared/types.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("real board shape (counts only) → honest total, not zero-today", () => {
  const now = new Date(2026, 8, 24, 12);
  const board = {
    lanes: [
      { project: "agent-relay", counts: { VERIFIED_DONE: 2 } },
      { project: "juplan", counts: { VERIFIED_DONE: 3 } },
    ],
  };
  assert.deepEqual(controlRoomTodayDone(board, now), []);
  assert.equal(controlRoomTodayCount(board, now), 0);
  assert.equal(controlRoomHasDoneData(board), false);
  assert.equal(controlRoomVerifiedDoneTotal(board), 5);
});

test("VERIFIED_DONE is never a today hint", () => {
  const now = new Date(2026, 8, 24, 12);
  const board = { lanes: [{ project: "p", counts: { VERIFIED_DONE: 99 } }] };
  assert.equal(controlRoomTodayCount(board, now), 0);
  assert.equal(controlRoomVerifiedDoneTotal(board), 99);
  assert.equal(controlRoomHasDoneData(board), false);
});

test("dated done list → local-date match → 오늘 N개", () => {
  const now = new Date(2026, 8, 24, 12);
  const board = {
    lanes: [
      {
        project: "agent-relay",
        counts: { VERIFIED_DONE: 5 },
        done: [
          { taskId: "old", title: "어제 일", finishedAt: "2026-09-23T23:00:00+09:00" },
          { taskId: "new", title: "오늘 일", finishedAt: "2026-09-24T11:00:00+09:00" },
        ],
      },
    ],
  };
  assert.equal(controlRoomHasDoneData(board), true);
  assert.deepEqual(
    controlRoomTodayDone(board, now).map((item) => item.title),
    ["오늘 일"],
  );
  assert.equal(controlRoomTodayCount(board, now), 1);
  assert.equal(controlRoomVerifiedDoneTotal(board), 5);
});

test("TodayCard renders honest line when no dated data, dated line otherwise", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /오늘 기록은 아직 안 왔어요/);
  assert.match(source, /지금까지 끝난 작업/);
  assert.match(source, /오늘 \{count\}개 끝났어요/);
  assert.match(source, /오늘 끝난 일은 아직 없어요/);
  assert.match(source, /controlRoomHasDoneData/);
  assert.match(source, /controlRoomVerifiedDoneTotal/);
});
