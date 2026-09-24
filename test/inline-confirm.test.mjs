/* R2/R3/R7 inline confirm for destructive actions (native dialog 금지).
   - 계획 [삭제]·[계획 승인 → 자동 진행]·진행 방식 라디오·관제실 [다시 시작]은
     인라인 확인(InlineConfirm)을 거쳐 실행한다.
   - 삭제 후 되돌리기(undo)를 제공한다.
   - flashInfo/버튼 문구에서 op 이름(planStudio:save 등)을 노출하지 않는다.
   - 'Run policy' 표기는 '진행 방식'으로 통일한다. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("no native dialog/confirm in planStudio + controlRoom + components", async () => {
  for (const file of ["src/frontend/planStudio.tsx", "src/frontend/controlRoom.tsx", "src/frontend/components.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /window\.confirm/);
    assert.doesNotMatch(source, /window\.alert/);
    assert.doesNotMatch(source, /showModal/);
    assert.doesNotMatch(source, /<dialog/);
    assert.doesNotMatch(source, /from ['"]electron['"]/);
  }
});

test("shared InlineConfirm lives in components.tsx", async () => {
  const source = await read("src/frontend/components.tsx");
  assert.match(source, /export function InlineConfirm/);
  assert.match(source, /className="inline-confirm"/);
  assert.match(source, /취소/);
});

test("planStudio delete asks inline + supports undo", async () => {
  const source = await read("src/frontend/planStudio.tsx");
  assert.match(source, /InlineConfirm/);
  assert.match(source, /pendingDeleteId/);
  assert.match(source, /삭제하시겠어요/);
  assert.match(source, /lastDeleted/);
  assert.match(source, /되돌리기/);
  assert.match(source, /undoDelete/);
});

test("planStudio approve + run policy go through inline confirm", async () => {
  const source = await read("src/frontend/planStudio.tsx");
  assert.match(source, /pendingApprove/);
  assert.match(source, /계획을 승인하고 자동 진행하시겠어요/);
  assert.match(source, /pendingPolicy/);
  assert.match(source, /바꾸시겠어요/);
  // backend ops still fire only after confirm
  assert.match(source, /op: 'planStudio:approve'/);
  assert.match(source, /op: 'planStudio:save'/);
});

test("controlRoom resume goes through inline confirm", async () => {
  const source = await read("src/frontend/controlRoom.tsx");
  assert.match(source, /InlineConfirm/);
  assert.match(source, /다시 시작하시겠어요/);
  assert.match(source, /op: 'controlRoom:resume'/);
});

test("user-facing copy has no op names, uses 진행 방식", async () => {
  const studio = await read("src/frontend/planStudio.tsx");
  assert.doesNotMatch(studio, /초안 저장됨 \(planStudio:save\)/);
  assert.doesNotMatch(studio, /planStudio:chat\)/);
  assert.doesNotMatch(studio, /planStudio:approve\)/);
  assert.doesNotMatch(studio, /gates:answer\)/);
  assert.doesNotMatch(studio, /<h3>Run policy<\/h3>/);
  assert.doesNotMatch(studio, /RUN POLICY/);
  assert.match(studio, /진행 방식/);
  assert.match(studio, /초안 저장됨/);
});

test("inline-confirm styles exist", async () => {
  const css = await read("src/frontend/style.css");
  assert.match(css, /\.inline-confirm/);
  assert.match(css, /\.plan-undo/);
});
