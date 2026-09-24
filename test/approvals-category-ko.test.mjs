/* R8 approvals category KO — approvalCategoryLabel 한국어 확장 +
   모르는 키 '기타' + '(바뀜)' 대체 규칙은 접힌 '지난 결정'.
   Pure helpers → dist/server/shared/types.js, 렌더 규격 → src 소스 grep. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  approvalCategoryLabel,
  isSupersededApprovalRule,
  partitionSupersededApprovalRules,
} from "../dist/server/shared/types.js";

const root = new URL("..", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");

test("approvalCategoryLabel — 새 카테고리 한국어", () => {
  assert.equal(approvalCategoryLabel("permissions"), "권한");
  assert.equal(approvalCategoryLabel("physical-e2e"), "실물 E2E");
  assert.equal(approvalCategoryLabel("product-decision"), "제품 결정");
  assert.equal(approvalCategoryLabel("scope"), "범위");
  assert.equal(approvalCategoryLabel("visual-decision"), "화면 결정");
});

test("approvalCategoryLabel — 기존 키 유지", () => {
  assert.equal(approvalCategoryLabel("agents"), "에이전트 배치");
  assert.equal(approvalCategoryLabel("git"), "Git·브랜치");
  assert.equal(approvalCategoryLabel("install"), "설치");
  assert.equal(approvalCategoryLabel("lanes"), "작업 흐름");
  assert.equal(approvalCategoryLabel("merge-push"), "병합·올리기");
  assert.equal(approvalCategoryLabel("기타"), "기타");
});

test("approvalCategoryLabel — 모르는 키는 '기타'", () => {
  assert.equal(approvalCategoryLabel("deploy"), "기타");
  assert.equal(approvalCategoryLabel("unknown-xyz"), "기타");
  assert.equal(approvalCategoryLabel(""), "기타");
});

test("isSupersededApprovalRule — '(바뀜)' 포함만 지난 결정", () => {
  assert.equal(isSupersededApprovalRule({ summary: "구 규칙 (바뀜)" }), true);
  assert.equal(isSupersededApprovalRule({ summary: "새 규칙" }), false);
  assert.equal(isSupersededApprovalRule({ title: "옛 결정 (바뀜)" }), true);
  assert.equal(isSupersededApprovalRule({}), false);
  assert.equal(isSupersededApprovalRule({ summary: "" }), false);
});

test("partitionSupersededApprovalRules — 순서 유지하며 active/지난 결정 분리", () => {
  const active = { summary: "현행 규칙" };
  const past = { summary: "옛 규칙 (바뀜)" };
  const out = partitionSupersededApprovalRules([active, past]);
  assert.deepEqual(out.active, [active]);
  assert.deepEqual(out.superseded, [past]);
  assert.deepEqual(partitionSupersededApprovalRules([]), { active: [], superseded: [] });
});

test("approvals.tsx — '(바뀜)' 규칙은 접힌 '지난 결정' details", async () => {
  const source = await read("src/frontend/approvals.tsx");
  assert.match(source, /\(바뀜\)/);
  assert.match(source, /<details/);
  assert.match(source, /지난 결정/);
  assert.match(source, /aria-label="지난 결정"/);
  assert.match(source, /<summary>지난 결정/);
});
