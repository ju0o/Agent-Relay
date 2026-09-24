import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PROJECT_LABELS, holdCardMessage } from "../dist/server/shared/projectLabels.js";

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
});

test("hold card render helper returns null for an empty hold", () => {
  assert.equal(holdCardMessage("", ""), null);
  assert.equal(holdCardMessage(undefined, []), null);
  assert.equal(holdCardMessage("   ", "—"), null);
  const message = holdCardMessage("", "Founder 승인 대기");
  assert.match(message ?? "", /보류/);
});
