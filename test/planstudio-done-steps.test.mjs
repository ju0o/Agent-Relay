/* R4: 끝난 작업(DONE/COMPLETE/INTEGRATED/VERIFIED_DONE)은 모든 단계 ✓와
   '완료 · 날짜', 남은 작업 0개면 '모두 끝났어요' 안내. */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlanStudioTaskDone } from "../dist/server/shared/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioSrc = fs.readFileSync(path.join(here, "..", "src", "frontend", "planStudio.tsx"), "utf8");

test("done detection — DONE/COMPLETE/INTEGRATED/VERIFIED_DONE + 한글", () => {
  for (const stage of ["DONE", "done", "COMPLETE", "complete", "INTEGRATED", "integrated", "VERIFIED_DONE", "verified_done", "V1_COMPLETE", "반영", "통합", 6, 7]) {
    assert.equal(isPlanStudioTaskDone({ stage }), true, `should be done: ${String(stage)}`);
  }
  for (const stage of [0, 2, 5, "queued", "HOLD", "작업"]) {
    assert.equal(isPlanStudioTaskDone({ stage }), false, `should not be done: ${String(stage)}`);
  }
});

test("planStudio.tsx — 끝난 작업은 모든 단계 ✓", () => {
  // done tasks force every step to 'done' (which renders ✓)
  assert.match(studioSrc, /const done = isPlanStudioTaskDone\(task\)/, "should compute done per task");
  assert.match(studioSrc, /done \? ['"]done['"]/, "done tasks should force step state to 'done'");
});

test("planStudio.tsx — '완료 · 날짜' 표시", () => {
  assert.ok(studioSrc.includes("완료 ·"), "missing '완료 ·' label");
  assert.match(studioSrc, /doneLabel\(task\)/, "should render doneLabel for finished tasks");
  assert.match(studioSrc, /completedAt/, "should carry a completion date field");
});

test("planStudio.tsx — 남은 작업 0개면 '모두 끝났어요' 안내", () => {
  assert.ok(studioSrc.includes("모두 끝났어요"), "missing '모두 끝났어요' empty-remaining copy");
  assert.match(studioSrc, /remainingCount/, "should compute remaining count");
  assert.match(studioSrc, /remainingCount === 0/, "should branch when nothing remains");
});

test("planStudio.tsx — VERIFIED_DONE도 마지막 단계(반영)로 매핑", () => {
  assert.match(studioSrc, /includes\(['"]DONE['"]\)/, "stageIndex should match DONE substring (covers VERIFIED_DONE)");
  assert.match(studioSrc, /includes\(['"]COMPLETE['"]\)/, "stageIndex should match COMPLETE substring");
});
