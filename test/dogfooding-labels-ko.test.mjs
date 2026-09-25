/* Dogfooding labels KO — Dogfooding panel + Quick Capture display labels are plain Korean.
   Stored DfType/status values and file tokens ('Status: OPEN', 'Type: UX / Friction', 'Priority: …') stay English.
   Reads sources as plain text so no build is required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const panel = read('src/frontend/dogfooding.tsx');
const quick = read('src/frontend/quickdf.tsx');
const backendFs = read('src/backend/fs.ts');
const sharedTypes = read('src/shared/types.ts');

test('dogfooding panel uses Korean display labels (종류/중요도/모든 종류/함께 기록된 정보)', () => {
  assert.match(panel, /<span className="flabel">종류<\/span>/);
  assert.match(panel, /<span className="flabel">중요도<\/span>/);
  assert.match(panel, /<option value="ALL">모든 종류<\/option>/);
  assert.match(panel, /aria-label="종류 필터"/);
  assert.match(panel, /함께 기록된 정보/);
});

test('dogfooding panel has no leftover English display labels', () => {
  assert.doesNotMatch(panel, /<span className="flabel">Type<\/span>/);
  assert.doesNotMatch(panel, /<span className="flabel">Priority<\/span>/);
  assert.doesNotMatch(panel, /All Types/);
  assert.doesNotMatch(panel, /aria-label="Type 필터"/);
  assert.doesNotMatch(panel, /자동 첨부 Context/);
  assert.doesNotMatch(panel, /<b>Context<\/b>/);
});

test('dogfooding panel shows status as 열림/고침/보류 with Korean cycle title', () => {
  assert.match(panel, /열림/);
  assert.match(panel, /고침/);
  assert.match(panel, /보류/);
  assert.match(panel, /클릭하면 상태가 순환합니다 \(열림 → 고침 → 보류\)/);
  assert.doesNotMatch(panel, /클릭하면 상태가 순환합니다 \(OPEN → FIXED → HOLD\)/);
  assert.doesNotMatch(panel, /\{item\.status\}</);
  assert.doesNotMatch(panel, />OPEN \{countOf/);
  assert.doesNotMatch(panel, />FIXED \{countOf/);
  assert.doesNotMatch(panel, />HOLD \{countOf/);
});

test('quick capture uses Korean labels + 빠른 피드백 dialog name', () => {
  assert.match(quick, /aria-label="빠른 피드백"/);
  assert.match(quick, /<span className="flabel">종류<\/span>/);
  assert.match(quick, /<span className="flabel">중요도<\/span>/);
  assert.match(quick, /함께 기록된 정보/);
  assert.doesNotMatch(quick, /aria-label="Quick Dogfooding"/);
  assert.doesNotMatch(quick, /<span className="flabel">Type<\/span>/);
  assert.doesNotMatch(quick, /<span className="flabel">Priority<\/span>/);
  assert.doesNotMatch(quick, /자동 첨부 Context/);
  assert.doesNotMatch(quick, /Status는 OPEN으로/);
});

test('stored values and file tokens stay English', () => {
  // Frontend still drives logic with enum values.
  assert.match(panel, /DF_STATUSES/);
  assert.match(panel, /countOf\('OPEN'\)/);
  assert.match(panel, /countOf\('FIXED'\)/);
  assert.match(panel, /countOf\('HOLD'\)/);
  assert.match(quick, /useState<DfType>\('UX'\)/);
  assert.match(quick, /useState<DfPriority>\('MEDIUM'\)/);
  // Shared enums unchanged.
  assert.match(sharedTypes, /export type DfStatus = 'OPEN' \| 'FIXED' \| 'HOLD'/);
  assert.match(sharedTypes, /export const DF_STATUSES: DfStatus\[\] = \['OPEN', 'FIXED', 'HOLD'\]/);
  // Backend file tokens unchanged.
  assert.match(backendFs, /`Status: \$\{input\.status\}`/);
  assert.match(backendFs, /`Type: \$\{input\.typeLabel\}`/);
  assert.match(backendFs, /`Priority: \$\{input\.priority\}`/);
});
