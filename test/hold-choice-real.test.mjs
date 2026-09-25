import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { normalizeHoldEntry } from "../dist/server/shared/projectLabels.js";
import { runControlRoomHoldChoose, ControlRoomError } from "../dist/server/backend/controlRoom.js";

const root = new URL("..", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");

test("explain hold options keep labels, ids, and recommendation", () => {
  const hold = normalizeHoldEntry({
    taskId: "task-real",
    explain: {
      sentence: "선택해 주세요.",
      recommended: "narrow",
      options: [
        { id: "retry", label: "다시 시도", detail: "한 번 더" },
        { id: "narrow", label: "범위를 좁혀 진행", detail: "범위 조정" },
        { id: "skip", label: "건너뛰기", detail: "이번 작업 생략" },
      ],
    },
  });

  assert.deepEqual(hold.options, ["다시 시도", "범위를 좁혀 진행", "건너뛰기"]);
  assert.deepEqual(hold.optionIds, ["retry", "narrow", "skip"]);
  assert.equal(hold.recommendedIndex, 1);
});

test("hold choice sends allow-listed retry, narrow, and skip options", async () => {
  for (const taskId of ["T-1", "AGENTRELAY-NR-01"]) {
    for (const option of ["retry", "narrow", "skip"]) {
      let call;
      await runControlRoomHoldChoose(taskId, option, async (...args) => {
        call = args;
        return { stdout: '{"ok":true}', stderr: "" };
      });
      assert.deepEqual(call[1], [
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "asus",
        "~/.agents/skills/auto-night-orchestrator/scripts/night",
        "hold", "choose", `'${taskId}'`, option, "--json",
      ]);
    }
  }

  const invalid = await runControlRoomHoldChoose("bad task", "retry", async () => ({ stdout: "{}", stderr: "" })).catch(error => error);
  assert.ok(invalid instanceof ControlRoomError);
  assert.equal(invalid.code, "INVALID_INPUT");
});

test("hold buttons choose ids and hide generic resume while held", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /op: 'controlRoom:holdChoose'/);
  assert.match(source, /option: optionId/);
  assert.match(source, /holds\.length === 0 && <ResumeControl/);
  assert.match(source, /‘\{taskTitle\}’을 ‘\{option\}’로 진행할게요/);
  assert.doesNotMatch(source, /if \(gateId\)[\s\S]*?controlRoom:resume/);
});
