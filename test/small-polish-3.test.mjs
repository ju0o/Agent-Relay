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
