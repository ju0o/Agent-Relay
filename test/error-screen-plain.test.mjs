import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/frontend/App.tsx', import.meta.url), 'utf8');
const sentence = '문제가 생겼어요. 앱을 다시 시작해 보세요. 계속되면 이 화면을 캡처해 알려주세요.';

test('error screens use plain recovery copy and collapsed raw errors', () => {
  assert.equal(source.split(sentence).length - 1, 2);
  assert.equal(source.split('>다시 시작</button>').length - 1, 2);
  assert.equal(source.split('<summary>원문 보기</summary>').length - 1, 2);
  assert.match(source, /onClick=\{\(\) => window\.location\.reload\(\)\}/);
  assert.doesNotMatch(source, /DevTools.*Console/);
});
