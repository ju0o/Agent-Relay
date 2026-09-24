import React from 'react';
import {
  type ApprovalRuleJson,
  approvalStatsLine,
  isModelQuotaHit,
  isSupersededApprovalRule,
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
  isSupersededApprovalRule,
  normalizeModelUsage,
  partitionSupersededApprovalRules,
  sortRulesByUsage,
  SUPERSEDED_APPROVAL_MARKER,
} from '../shared/types.js';

const APPROVAL_PLAIN_WORDS: readonly [string, string][] = [
  ['fast-forward 병합', '그대로 합치기'],
  ['SSOT', '기준 문서'],
  ['worktree', '작업용 복사본'],
  ['OmniRoute', '전체 경로'],
  ['push merge', '올리기·합치기'],
  ['E2E', '실제 사용 시험'],
];

/** Display-only wording; the original approval text remains available below it. */
export function approvalReadableLabel(rule: ApprovalRuleJson): string {
  const record = rule as Record<string, unknown>;
  const raw = rule.summary ?? record.title ?? record.ask ?? record.name;
  const text = typeof raw === 'string' && raw.trim() ? raw : JSON.stringify(rule);
  return APPROVAL_PLAIN_WORDS.reduce((label, [developerWord, plainWord]) => label.replaceAll(developerWord, plainWord), text);
}

export function ApprovalRuleCard({ rule }: { rule: ApprovalRuleJson }): React.ReactElement {
  const record = rule as Record<string, unknown>;
  const raw = rule.summary ?? record.title ?? record.ask ?? record.name;
  const original = typeof raw === 'string' && raw.trim() ? raw : JSON.stringify(rule);
  return (
    <article className="control-card">
      <p className="control-card-value" style={{ whiteSpace: 'pre-wrap' }}>{approvalReadableLabel(rule)}</p>
      <p className="muted approval-stats">{approvalStatsLine(rule)}</p>
      <details className="approval-original">
        <summary>원문 보기</summary>
        <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{original}</p>
      </details>
    </article>
  );
}

export function UnusedApprovalRules({ rules }: { rules: readonly ApprovalRuleJson[] }): React.ReactElement | null {
  if (rules.length === 0) return null;
  return (
    <details className="approval-unused" aria-label="아직 안 쓰인 규칙">
      <summary>아직 안 쓰인 규칙 {rules.length}개</summary>
      <div className="control-cards">{rules.map((rule, i) => <ApprovalRuleCard key={i} rule={rule} />)}</div>
    </details>
  );
}

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

/** '(바뀜)'으로 대체된 규칙 — 접힌 '지난 결정' details, 펼치면 목록. */
export function SupersededApprovals({ rules }: { rules: readonly ApprovalRuleJson[] }): React.ReactElement | null {
  const past = rules.filter(isSupersededApprovalRule);
  if (past.length === 0) return null;
  const label = (rule: ApprovalRuleJson): string => {
    const record = rule as Record<string, unknown>;
    const raw = rule.summary ?? record.title ?? record.ask ?? record.name;
    return typeof raw === 'string' && raw.trim() ? raw : JSON.stringify(rule);
  };
  return (
    <details className="approval-superseded" aria-label="지난 결정">
      <summary>지난 결정 {past.length}개</summary>
      <ul className="approval-superseded-list">
        {past.map((rule, i) => (
          <li key={i} className="approval-superseded-row">
            <span className="control-card-value" style={{ whiteSpace: 'pre-wrap' }}>{label(rule)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
