import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "frontend", "planStudio.tsx"), "utf8");

test("project changes reset every pending inline confirmation", () => {
  assert.match(source, /export function resetPlanStudioPendingState/);
  assert.match(source, /setPendingApprove\(reset\.pendingApprove\)/);
  assert.match(source, /setPendingDeleteId\(reset\.pendingDeleteId\)/);
  assert.match(source, /setPendingPolicy\(reset\.pendingPolicy\)/);
  assert.match(source, /\}, \[project\]\);/);
});

test("approved roadmap with no remaining work shows the completed state", () => {
  assert.match(source, /approved: boolean/);
  assert.match(source, /draft\.approved && remainingCount === 0/);
  assert.match(source, /승인됨 · 모두 끝났어요/);
  assert.match(source, /tasks\.find\(task => !isPlanStudioTaskDone\(task\)\)/);
});
