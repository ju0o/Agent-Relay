import assert from 'node:assert/strict';
import test from 'node:test';
import { controlRoomTaskTitle, controlRoomTodayCount, controlRoomTodayDone, controlRoomWorkingRows } from '../dist/server/shared/types.js';

test('today done filters local-date timestamps, uses counts, and keeps the last three', () => {
  const now = new Date(2026, 8, 24, 12);
  const board = {
    lanes: [{
      project: 'agent-relay',
      counts: { done: 101 },
      done: [
        { taskId: 'old', title: '어제 일', finishedAt: '2026-09-23T23:59:00+09:00' },
        { taskId: 'new', title: '오늘 일', finishedAt: '2026-09-24T11:00:00+09:00' },
      ],
    }],
  };
  assert.equal(controlRoomTodayCount(board, now), 101);
  assert.deepEqual(controlRoomTodayDone(board, now).map(item => item.title), ['오늘 일']);
});

test('task titles prefer the plain title and IDs remain separate', () => {
  assert.equal(controlRoomTaskTitle({ taskId: 'T-1', title: '로그인 고치기' }), '로그인 고치기');
  assert.equal(controlRoomTaskTitle({ taskId: 'T-2' }), 'T-2');
});

test('working rows use project label, stage, AI, and Korean title', () => {
  assert.deepEqual(controlRoomWorkingRows([
    { project: 'agent-relay', current: { stage: 2, title: '작업' }, workerChain: ['codex'] },
    { project: 'juplan', current: { stage: 3, title: '검수' }, workerChain: ['opencode'] },
  ]), ['Agent Relay · 작업 · codex · 작업', 'JuPlan · 검수 · AI 확인 중 · 검수']);
});
