import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'App.tsx'), 'utf8');
const controlRoomSrc = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'controlRoom.tsx'), 'utf8');

describe('topbar founder-first', () => {
  it("order 관제실 → 승인 규칙 → 계획 appears before '개발 도구'", () => {
    const headerStart = src.indexOf('<header className="topbar">');
    assert.ok(headerStart !== -1, 'missing topbar header');
    const headerEnd = src.indexOf('</header>', headerStart);
    const header = src.slice(headerStart, headerEnd !== -1 ? headerEnd : undefined);
    const iControl = header.indexOf('관제실');
    const iApproval = header.indexOf('승인 규칙');
    const iPlan = header.indexOf('>계획<');
    const iDev = header.indexOf('개발 도구');
    assert.ok(iControl !== -1, 'missing 관제실');
    assert.ok(iApproval !== -1, 'missing 승인 규칙');
    assert.ok(iPlan !== -1, 'missing 계획 button label');
    assert.ok(iDev !== -1, "missing 개발 도구");
    assert.ok(iControl < iApproval, '관제실 should come before 승인 규칙');
    assert.ok(iApproval < iPlan, '승인 규칙 should come before 계획');
    assert.ok(iPlan < iDev, '계획 should come before 개발 도구');
  });

  it("'Founder 승인 내역' no longer appears", () => {
    assert.ok(!src.includes('Founder 승인 내역'), "'Founder 승인 내역' should be renamed");
  });

  it('dev tools stay in code with handlers (closed by default)', () => {
    assert.ok(src.includes('App Dogfooding'), 'missing App Dogfooding');
    assert.ok(src.includes('Project Dogfooding'), 'missing Project Dogfooding');
    assert.ok(src.includes('피드백'), 'missing 피드백');
    assert.ok(src.includes('Ctrl+S') && src.includes('Ctrl+N') && src.includes('Ctrl+T'), 'missing shortcut hints');
    assert.match(src, /showDevTools.*useState\(false\)|useState\(false\)[\s\S]*showDevTools/, 'dev tools menu should be closed by default');
  });

  it('keeps --view names unchanged', () => {
    assert.ok(src.includes("'control-room'") || src.includes('"control-room"') || src.includes('control-room'), 'missing control-room view');
    assert.ok(src.includes("'approvals'") || src.includes('"approvals"') || src.includes('approvals'), 'missing approvals view');
    assert.ok(src.includes("'plan-studio'") || src.includes('"plan-studio"') || src.includes('plan-studio'), 'missing plan-studio view');
  });

  it('uses Korean topbar tooltips and hides raw control-room values by default', () => {
    assert.ok(src.includes('관제실 — 프로젝트별 진행 상황 보기'));
    assert.ok(src.includes('계획 — 목표와 작업 순서 보고 PM에게 요청'));
    assert.ok(controlRoomSrc.includes('<summary>원문 검수 의견</summary>'));
    assert.ok(!controlRoomSrc.includes('원문 QA finding'));
    assert.match(controlRoomSrc, /<details><summary>원문 보기<\/summary><p className="muted mono gate-id">\{parsed\.gateId\}<\/p><\/details>/);
  });
});
