import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = file => readFile(new URL(file, root), "utf8");

test("shared project labels use the exact product names", async () => {
  const source = await read("src/shared/projectLabels.ts");
  for (const [id, name] of Object.entries({
    "agent-relay": "Agent Relay",
    actl: "actl",
    juplan: "JuPlan",
    juceipt: "JuCeipt",
    jucontroler: "JuControler",
    "jucontroler-app": "통합 관제 화면 (jucontroler-app)",
    "juceipt-planning": "JuCeipt 기획 (juceipt-planning)",
  })) {
    const key = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const value = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(source, new RegExp(`[\\"']?${key}[\\"']?:[\\s\\S]*?name: ['"]${value}`));
  }
  for (const oldName of ["에이전트 릴레이", "주플랜", "주싯", "주컨트롤러"]) assert.doesNotMatch(source, new RegExp(oldName));
});

test("Control Room and Plan Studio consume the shared map and render goals separately", async () => {
  const [controlRoom, planStudio] = await Promise.all([read("src/frontend/controlRoom.tsx"), read("src/frontend/planStudio.tsx")]);
  for (const source of [controlRoom, planStudio]) {
    assert.match(source, /PROJECT_LABELS/);
    assert.doesNotMatch(source, /에이전트 릴레이|주플랜|주싯|주컨트롤러/);
  }
  assert.match(controlRoom, /<span>\{presentation\.name\}<\/span>[\s\S]*?<small[^>]*>\{presentation\.goal\}<\/small>/);
  assert.match(planStudio, /<span>\{item\.name\}<\/span>[\s\S]*?<small[^>]*>\{item\.goal\}<\/small>/);
});

test("QA editor blocks self-review by the first worker AI", async () => {
  const [labels, controlRoom] = await Promise.all([read("src/shared/projectLabels.ts"), read("src/frontend/controlRoom.tsx")]);
  assert.match(labels, /export function isSelfReviewChain\s*\(/);
  assert.match(controlRoom, /isSelfReviewChain/);
  assert.match(controlRoom, /workerChain/);
  assert.match(controlRoom, /만든 AI가 스스로 검수할 수 없어요\. 다른 AI를 첫 번째로 골라 주세요\./);
  assert.match(controlRoom, /disabled=\{[^}]*selfReview/);
});
