/* Docs-truth regression — docs stay in line with the app.
   README describes the current app (control room); the night-run doc states
   the operational deadline. Reads the two markdown files as plain text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const nightDoc = fs.readFileSync(
  path.join(root, 'docs/CORE_V1_AUTO_NIGHT_RUN.md'),
  'utf8',
);

test('README describes the control room app', () => {
  assert.ok(readme.includes('관제실'), "README should mention '관제실'");
  assert.ok(readme.includes('승인 규칙'), "README should mention '승인 규칙'");
  assert.ok(readme.includes('계획'), "README should mention '계획'");
});

test('night-run doc states the operational deadline', () => {
  assert.ok(
    nightDoc.includes('05:00'),
    'night-run doc should state the 05:00 deadline',
  );
});

// Every app string the README quotes must exist verbatim in the app source.
const appSrc = [
  'src/backend/controlRoom.ts',
  'src/shared/projectLabels.ts',
  'src/frontend/controlRoom.tsx',
]
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
  .join('\n');

test('README quotes of app copy exist in the app source', () => {
  for (const q of [
    '아무것도 안 고르면',
    '에 추천대로 진행해요',
    '에 연결할 수 없습니다',
    '다시 시도',
    '다음 작업으로 진행',
    '내가 직접 볼게요',
    '원문 보기',
    '무료 모델(예비)',
  ]) {
    assert.ok(readme.includes(q), `README should quote '${q}'`);
    assert.ok(appSrc.includes(q), `app source should contain '${q}'`);
  }
  assert.ok(!readme.includes('연결 안 됨'), "README must not quote '연결 안 됨'");
});
