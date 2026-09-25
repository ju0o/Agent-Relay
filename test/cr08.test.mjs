/* CR-08 model quota board + approval learning — pure helper tests.
   Covers the helpers behind the '모델 사용량' panel and the per-rule
   approval stats (unused → '아직 자동 적용된 적 없음', else
   '자동 적용 N회 · 마지막 YYYY-MM-DD') plus approvalCategoryLabel.
   Runs against the compiled shared module (dist/server/shared/types.js),
   mirroring test/v03.test.mjs conventions. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalCategoryLabel,
  approvalLastUsed,
  approvalStatsLine,
  approvalUsedCount,
  dedupeApprovalRules,
  groupRulesByCategory,
  isModelQuotaHit,
  normalizeModelUsage,
  sortRulesByUsage,
} from "../dist/server/shared/types.js";

test("normalizeModelUsage — missing fields render as 0", () => {
  assert.deepEqual(normalizeModelUsage(undefined), []);
  assert.deepEqual(normalizeModelUsage(null), []);
  assert.deepEqual(normalizeModelUsage([]), []);
  assert.deepEqual(normalizeModelUsage("codex"), []);
  assert.deepEqual(normalizeModelUsage({}), []);
  assert.deepEqual(normalizeModelUsage({ codex: { runs: 3 } }), [
    { runtimeId: "codex", runs: 3, quota: 0, failed: 0 },
  ]);
  assert.deepEqual(normalizeModelUsage({ codex: null }), [
    { runtimeId: "codex", runs: 0, quota: 0, failed: 0 },
  ]);
});

test("normalizeModelUsage — invalid numbers clamp to 0, floats floor", () => {
  const [row] = normalizeModelUsage({
    opencode: { runs: 2.9, quota: -1, failed: Number.NaN },
  });
  assert.deepEqual(row, { runtimeId: "opencode", runs: 2, quota: 0, failed: 0 });
  const [bad] = normalizeModelUsage({ x: { runs: "9", quota: Infinity, failed: null } });
  assert.deepEqual(bad, { runtimeId: "x", runs: 0, quota: 0, failed: 0 });
});

test("isModelQuotaHit — only flags exhausted quotas (runs >= quota, quota > 0)", () => {
  assert.equal(isModelQuotaHit({ runs: 5, quota: 0 }), false); // no limit, never hit
  assert.equal(isModelQuotaHit({ runs: 0, quota: 0 }), false);
  assert.equal(isModelQuotaHit({ runs: 3, quota: 10 }), false); // quota exists but not hit
  assert.equal(isModelQuotaHit({ runs: 10, quota: 10 }), true); // exhausted
  assert.equal(isModelQuotaHit({ runs: 12, quota: 10 }), true); // over quota
});

test("approvalUsedCount — missing/invalid renders as 0", () => {
  assert.equal(approvalUsedCount({}), 0);
  assert.equal(approvalUsedCount({ usedCount: undefined }), 0);
  assert.equal(approvalUsedCount({ usedCount: -2 }), 0);
  assert.equal(approvalUsedCount({ usedCount: Number.NaN }), 0);
  assert.equal(approvalUsedCount({ usedCount: "3" }), 0);
  assert.equal(approvalUsedCount({ usedCount: 4.7 }), 4);
  assert.equal(approvalUsedCount({ usedCount: 3 }), 3);
});

test("approvalLastUsed — missing/invalid renders as '-', else YYYY-MM-DD", () => {
  assert.equal(approvalLastUsed({}), "-");
  assert.equal(approvalLastUsed({ lastUsedAt: "" }), "-");
  assert.equal(approvalLastUsed({ lastUsedAt: "   " }), "-");
  assert.equal(approvalLastUsed({ lastUsedAt: "not-a-date" }), "-");
  assert.match(approvalLastUsed({ lastUsedAt: "2026-09-20T12:34:56Z" }), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(approvalLastUsed({ lastUsedAt: "2026-09-20T12:34:56Z" }), "2026-09-20");
});

test("approvalStatsLine — unused → '아직 자동 적용된 적 없음', else '자동 적용 N회 · 마지막 YYYY-MM-DD'", () => {
  assert.equal(approvalStatsLine({}), "아직 자동 적용된 적 없음");
  assert.equal(approvalStatsLine({ usedCount: 0 }), "아직 자동 적용된 적 없음");
  assert.equal(
    approvalStatsLine({ usedCount: 7, lastUsedAt: "2026-09-20T00:00:00Z" }),
    "자동 적용 7회 · 마지막 2026-09-20",
  );
});

test("approvalCategoryLabel — known categories map to Korean headings, unknown → '기타'", () => {
  assert.equal(approvalCategoryLabel("agents"), "에이전트 배치");
  assert.equal(approvalCategoryLabel("git"), "Git·브랜치");
  assert.equal(approvalCategoryLabel("install"), "설치");
  assert.equal(approvalCategoryLabel("lanes"), "작업 흐름");
  assert.equal(approvalCategoryLabel("merge-push"), "병합·올리기");
  assert.equal(approvalCategoryLabel("기타"), "기타");
  assert.equal(approvalCategoryLabel("deploy"), "기타");
});

test("sortRulesByUsage — desc by usedCount, stable on ties, missing = 0", () => {
  const a = { summary: "a", usedCount: 1 };
  const b = { summary: "b" };
  const c = { summary: "c", usedCount: 5 };
  const d = { summary: "d", usedCount: 5 };
  const sorted = sortRulesByUsage([a, b, c, d]);
  assert.deepEqual(sorted.map((r) => r.summary), ["c", "d", "a", "b"]);
  // input untouched
  assert.deepEqual([a, b, c, d].map((r) => r.summary), ["a", "b", "c", "d"]);
});

test("dedupeApprovalRules — envelope + top-level duplicates render once", () => {
  const a = { summary: "A", category: "bug" };
  const b = { summary: "B", category: "bug" };
  // same reference twice
  assert.deepEqual(dedupeApprovalRules([a, a, b]).length, 2);
  // same content, different identity (envelope unwrapped vs top-level)
  const aClone = { summary: "A", category: "bug" };
  const deduped = dedupeApprovalRules([a, b, aClone]);
  assert.equal(deduped.length, 2);
  assert.deepEqual(deduped.map((r) => r.summary), ["A", "B"]);
  // first occurrence wins
  const first = { summary: "A", usedCount: 9 };
  const second = { summary: "A", usedCount: 1 };
  assert.equal(dedupeApprovalRules([first, second])[0].usedCount, 9);
});

test("groupRulesByCategory — missing category → '기타', each group sorted by usedCount", () => {
  const groups = groupRulesByCategory([
    { category: "deploy", summary: "d1", usedCount: 1 },
    { summary: "nogroup", usedCount: 9 },
    { category: "deploy", summary: "d2", usedCount: 4 },
    { category: "", summary: "blank", usedCount: 2 },
  ]);
  const byCat = new Map(groups.map((g) => [g.category, g.rules.map((r) => r.summary)]));
  assert.deepEqual(byCat.get("deploy"), ["d2", "d1"]);
  assert.deepEqual(byCat.get("기타"), ["nogroup", "blank"]);
  // groups sorted by category name (localeCompare, matching implementation)
  assert.deepEqual(groups.map((g) => g.category), [...groups.map((g) => g.category)].sort((a, b) => a.localeCompare(b)));
});
