import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const approvals = await readFile(new URL('../src/frontend/approvals.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/frontend/App.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/frontend/style.css', import.meta.url), 'utf8');

test('approval rules sort used entries and fold unused entries', () => {
  assert.match(app, /approvalUsedCount\(rule\) > 0/);
  assert.match(approvals, /아직 안 쓰인 규칙 \{rules\.length\}개/);
  assert.match(approvals, /<details className="approval-unused"/);
});

test('approval display uses plain words and keeps original text closed', () => {
  for (const phrase of ['SSOT', 'fast-forward 병합', 'worktree', 'E2E']) assert.match(approvals, new RegExp(`['"]${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`));
  assert.match(approvals, /replaceAll\(developerWord, plainWord\)/);
  assert.match(approvals, /<summary>원문 보기<\/summary>/);
});

test('light active control tab uses a high-contrast token', () => {
  assert.match(css, /--tab-active-fg:\s*#111111/);
  assert.match(css, /\.app\[data-theme="light"\] \.tab-btn\.active[^\{]*\{[^}]*color:\s*var\(--tab-active-fg\)/);
});
