import React from 'react';
import type { ApprovalRuleJson, ControlRoomModelUsage } from '../shared/types.js';

// ── CR-08 model quota board + approval learning ─────────────────────────────
// board JSON carries `models: { runtimeId: { runs, quota?, failed? } }`.
// approval rules carry `usedCount` / `lastUsedAt` (both optional).

/** Normalize a raw models map (missing fields → 0). */
export function normalizeModelUsage(
  models: unknown,
): { runtimeId: string; runs: number; quota: number; failed: number }[] {
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
  return Object.entries(models as Record<string, unknown>).map(([runtimeId, raw]) => {
    const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<ControlRoomModelUsage>;
    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    return { runtimeId, runs: num(record.runs), quota: num(record.quota), failed: num(record.failed) };
  });
}

/** Missing/invalid usedCount renders as 0. */
export function approvalUsedCount(rule: ApprovalRuleJson): number {
  return typeof rule.usedCount === 'number' && Number.isFinite(rule.usedCount) && rule.usedCount >= 0
    ? Math.floor(rule.usedCount)
    : 0;
}

/** Missing/invalid lastUsedAt renders as '-'; otherwise YYYY-MM-DD. */
export function approvalLastUsed(rule: ApprovalRuleJson): string {
  if (typeof rule.lastUsedAt !== 'string' || !rule.lastUsedAt.trim()) return '-';
  const parsed = new Date(rule.lastUsedAt);
  if (Number.isNaN(parsed.getTime())) return '-';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** '자동 승인 N회 · 마지막 YYYY-MM-DD' per rule. */
export function approvalStatsLine(rule: ApprovalRuleJson): string {
  return `자동 승인 ${approvalUsedCount(rule)}회 · 마지막 ${approvalLastUsed(rule)}`;
}

/**
 * Sort rules within a category by usedCount (desc, missing = 0).
 * Stable — ties keep their original relative order.
 */
export function sortRulesByUsage<T extends ApprovalRuleJson>(rules: readonly T[]): T[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => approvalUsedCount(b.rule) - approvalUsedCount(a.rule) || a.index - b.index)
    .map(entry => entry.rule);
}

/** Group rules by category (missing/blank → '기타'), each group sorted by usedCount. */
export function groupRulesByCategory<T extends ApprovalRuleJson>(
  rules: readonly T[],
): { category: string; rules: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const rule of rules) {
    const category =
      typeof rule.category === 'string' && rule.category.trim() ? rule.category.trim() : '기타';
    const list = groups.get(category);
    if (list) list.push(rule);
    else groups.set(category, [rule]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({ category, rules: sortRulesByUsage(list) }));
}

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
            className={`model-usage-row${row.quota > 0 ? ' quota-hit' : ''}`}
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
