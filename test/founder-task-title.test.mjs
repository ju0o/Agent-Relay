import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { founderTaskTitle } from '../dist/server/shared/types.js';

const source = await readFile(new URL('../src/frontend/controlRoom.tsx', import.meta.url), 'utf8');

test('founderTaskTitle keeps Hangul titles and hides raw ids', () => {
  assert.equal(founderTaskTitle({ taskId: 'AGENTRELAY-1', title: '로그인 수정' }), '로그인 수정');
  assert.equal(founderTaskTitle({ taskId: 'AGENTRELAY-1', title: 'AGENTRELAY-1' }), '이름 준비 중인 작업');
  assert.equal(founderTaskTitle({ scope: 'On the web board in src/actl/serve.py' }), '이름 준비 중인 작업');
});

test('a visible hold becomes the current blocked flow when current is absent', () => {
  assert.match(source, /const holdCurrent = !hasCurrent \? holds\[0\] : undefined/);
  assert.match(source, /`멈춤 · \$\{holdStepLabel\(stageValue\)/);
  assert.match(source, /flowState\(`BLOCK \$\{stageValue\}`, index\)/);
});
