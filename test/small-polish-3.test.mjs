import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('jutell project label exists', async () => {
  const src = await read('src/shared/projectLabels.ts');
  assert.match(src, /jutell:\s*\{\s*name:\s*'JuTell',\s*goal:\s*'짧고 쉬운 작업 보고서'\s*\}/);
});

test('AI 순서 저장 result says 만드는 AI / 검수하는 AI, not worker/qa', async () => {
  const src = await read('src/frontend/controlRoom.tsx');
  assert.match(src, /저장됨 \(\$\{role === 'worker' \? '만드는 AI' : '검수하는 AI'\}/);
  assert.doesNotMatch(src, /저장됨 \(\$\{role\}/);
});

test('chain editor offers opencode-free labelled 무료 모델(예비)', async () => {
  const src = await read('src/frontend/controlRoom.tsx');
  assert.match(src, /'opencode-free'/);
  assert.match(src, /무료 모델\(예비\)/);
});

test('담당 AI 줄도 opencode-free 대신 무료 모델(예비)로 보여준다', async () => {
  const src = await read('src/frontend/controlRoom.tsx');
  assert.match(src, /const workerText = chainText\(worker\)/);
  assert.match(src, /const qaText = chainText\(qa\)/);
  assert.doesNotMatch(src, /const (worker|qa)Text = detail\(/);
});

test('기록 header has side padding matching other screens', async () => {
  const css = await read('src/frontend/style.css');
  assert.match(css, /\.record-head\s*\{[^}]*padding:\s*12px 24px 0/);
});

test('light active tab color ends as #1d1d1f (last matching rule wins)', async () => {
  const css = await read('src/frontend/style.css');
  for (const sel of ['tab-btn', 'control-tab']) {
    const re = new RegExp(`\\.app\\[data-theme="light"\\] \\.${sel}\\.active\\s*\\{[^}]*?\\bcolor:\\s*([^;}\\s]+)`, 'g');
    const colors = [...css.matchAll(re)].map(m => m[1]);
    assert.equal(colors.at(-1), '#1d1d1f', `${sel}.active final color`);
  }
});
