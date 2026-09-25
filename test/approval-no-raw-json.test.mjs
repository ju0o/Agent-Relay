import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const approvals = await readFile(new URL('../src/frontend/approvals.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/frontend/App.tsx', import.meta.url), 'utf8');

test('approval headlines never fall back to raw JSON', () => {
  assert.match(approvals, /APPROVAL_NO_TEXT_LABEL = '설명이 없는 규칙이에요'/);
  assert.equal(approvals.match(/JSON\.stringify/g).length, 1, 'only the 원문 보기 original may stringify');
  assert.match(approvals, /const original = [^\n]*JSON\.stringify\(rule\)/);
  assert.match(approvals, /<summary>원문 보기<\/summary>/);
  assert.doesNotMatch(app, /JSON\.stringify/);
  assert.match(app, /'설명이 없는 항목이에요'/);
});
