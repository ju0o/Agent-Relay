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

/** '모델 사용량' panel — one row per runtime, quota hits highlighted. */
export function ModelUsagePanel({ models }: { models: unknown }): React.ReactElement | null {
  const rows = normalizeModelUsage(models);
  if (rows.length === 0) return null;
  return (
    <section className="model-usage" aria-label="모델 사용량">
      <h3>모델 사용량</h3>
      <ul className="model-usage-list">
        {rows.map(row => (
          <li
            key={row.runtimeId}
            className={`model-usage-row${isModelQuotaHit(row) ? ' quota-hit' : ''}`}
          >
            <span className="model-usage-id">{row.runtimeId}</span>
            <span className="model-usage-nums">
              실행 {row.runs} · quota {row.quota} · 실패 {row.failed}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
