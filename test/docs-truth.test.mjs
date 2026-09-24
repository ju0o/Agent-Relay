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
