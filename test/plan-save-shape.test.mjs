import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlanStudioGet } from "../dist/server/backend/controlRoom.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "frontend", "planStudio.tsx"), "utf8");

test("roadmap save uses the bounded payload shape", () => {
  assert.match(source, /export function toRoadmapPayload\(draft: StudioDraft\)/);
  assert.match(source, /policy: draft\.runPolicy/);
  assert.match(source, /filter\(task => !task\.registered\)\.slice\(0, 12\)/);
  assert.match(source, /taskId: task\.id,\s*title: task\.title,\s*scope: task\.scope/);
  assert.match(source, /JSON\.stringify\(toRoadmapPayload\(next\)\)/);
  assert.match(source, /!task\.registered/);
});

test("planStudio get keeps connection and remote failure messages distinct", async () => {
  const connection = await runPlanStudioGet("agent-relay", async () => {
    const error = new Error("ssh failed");
    error.code = 255;
    throw error;
  }).catch(error => error);
  assert.match(connection.message, /연결할 수 없습니다/);

  const remote = await runPlanStudioGet("agent-relay", async () => {
    const error = new Error("remote failed");
    error.code = 1;
    throw error;
  }).catch(error => error);
  assert.equal(remote.code, "REMOTE_FAILED");
});
