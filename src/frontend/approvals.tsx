import React from 'react';
import {
  isModelQuotaHit,
  normalizeModelUsage,
} from '../shared/types.js';

// ── CR-08 model quota board + approval learning ─────────────────────────────
// board JSON carries `models: { runtimeId: { runs, quota?, failed? } }`.
// approval rules carry `usedCount` / `lastUsedAt` (both optional).
// Pure helpers live in shared/types.ts (compiled to dist → unit-tested);
// this module re-exports them so existing `./approvals.js` imports keep working.
export {
  approvalCategoryLabel,
  approvalLastUsed,
  approvalStatsLine,
  approvalUsedCount,
  dedupeApprovalRules,
  groupRulesByCategory,
  isModelQuotaHit,
  normalizeModelUsage,
  sortRulesByUsage,
} from '../shared/types.js';

/** '모델 사용량' panel — 접힌 details, 한 줄 요약 뒤에 펼치면 runtimes. */
export function ModelUsagePanel({ models }: { models: unknown }): React.ReactElement | null {
  const rows = normalizeModelUsage(models);
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, row) => sum + row.runs, 0);
  return (
    <details className="model-usage" aria-label="모델 사용량">
      <summary>모델 사용량 (실행 {total}회)</summary>
      <ul className="model-usage-list">
        {rows.map(row => (
          <li
            key={row.runtimeId}
            className={`model-usage-row${isModelQuotaHit(row) ? ' quota-hit' : ''}`}
          >
            <span className="model-usage-id">{row.runtimeId}</span>
            <span className="model-usage-nums">
              실행 {row.runs} · 한도 초과 {row.quota} · 실패 {row.failed}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
