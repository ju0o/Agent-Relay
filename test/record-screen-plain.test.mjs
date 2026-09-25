import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'App.tsx'), 'utf8');

// App.tsx is TSX — extract the pure visibleRecordAgents helper and evaluate it
// with a minimal normalizeModelUsage stub (keys → runtimeId), mirroring
// test/v03.test.mjs conventions.
function loadVisibleRecordAgents() {
  const m = src.match(/export function visibleRecordAgents[\s\S]*?\n\}/);
  assert.ok(m, 'visibleRecordAgents not found in App.tsx source');
  const ts = m[0].replace(/^export\s+/, '');
  const js = ts
    .replace(/activeAgent\?:/g, 'activeAgent:')
    .replace(/:\s*string\[\]/g, '')
    .replace(/:\s*unknown/g, '')
    .replace(/:\s*string/g, '')
    .replace(/<string>/g, '');
  function normalizeModelUsage(models) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
    return Object.entries(models).map(([runtimeId]) => ({ runtimeId }));
  }
  const fn = new Function('normalizeModelUsage', `${js}; return visibleRecordAgents;`)(normalizeModelUsage);
  assert.equal(typeof fn, 'function', 'visibleRecordAgents did not evaluate to a function');
  return fn;
}

const visibleRecordAgents = loadVisibleRecordAgents();

describe('record screen plain Korean', () => {
  it('shows plain-Korean header on 기록', () => {
    assert.ok(
      src.includes('작업 기록 — AI에게 준 지시와 받은 결과를 날짜별로 모아 둬요'),
      'missing plain-Korean record header',
    );
  });

  it("renames PROJECTS to 프로젝트", () => {
    assert.ok(src.includes('프로젝트'), 'missing 프로젝트 label');
    assert.doesNotMatch(src, /PROJECTS/);
    assert.doesNotMatch(src, />Projects</);
  });

  it('uses plain paste placeholder for result', () => {
    assert.ok(
      src.includes('여기에 AI에게 받은 결과를 붙여 넣으세요'),
      'missing plain result placeholder',
    );
  });

  it('GPT prompt wording is gone', () => {
    assert.doesNotMatch(src, /GPT에게 받은 다음 프롬프트/);
  });

  it('date field uses native date input defaulting to today', () => {
    assert.match(src, /type="date"|type='date'/);
    assert.ok(src.includes('todayLocal()'), 'date should default to today');
    assert.ok(src.includes('useState(todayLocal())'), 'date state should default to today');
  });

  it('agent chips list only runtimes in board/model usage', () => {
    assert.ok(src.includes('visibleRecordAgents'), 'missing visibleRecordAgents filter');
    assert.ok(src.includes('normalizeModelUsage'), 'missing board model usage normalization');
    assert.ok(src.includes('controlRoom:board'), 'missing board fetch for configured runtimes');
    assert.ok(src.includes('visibleAgents.map'), 'agent chips should render filtered visibleAgents');
  });

  it('keeps save/export behaviour', () => {
    assert.ok(src.includes('모두 저장'), 'missing 모두 저장');
    assert.ok(src.includes('.md 내보내기'), 'missing .md 내보내기');
    assert.ok(src.includes('prompt:save'), 'missing prompt:save');
    assert.ok(src.includes('result:save'), 'missing result:save');
    assert.ok(src.includes('run:export'), 'missing run:export');
  });

  it('visibleRecordAgents filters to configured board runtimes only', () => {
    const all = ['Claude Code', 'Kiro', 'Devin', 'CommandCode'];
    // board says only Claude Code is configured → unconfigured chips hidden
    assert.deepEqual(
      visibleRecordAgents(all, { 'Claude Code': { runs: 2 } }, []),
      ['Claude Code'],
    );
  });

  it('visibleRecordAgents includes history runtimes', () => {
    const all = ['Claude Code', 'Kiro', 'Devin'];
    assert.deepEqual(
      visibleRecordAgents(all, null, ['Kiro']),
      ['Kiro'],
    );
  });

  it('visibleRecordAgents keeps full list on first run (board and history empty)', () => {
    const all = ['Claude Code', 'Kiro', 'Devin'];
    assert.deepEqual(visibleRecordAgents(all, null, []), all);
    assert.deepEqual(visibleRecordAgents(all, {}, []), all);
  });

  it('visibleRecordAgents returns empty (not allAgents) on non-overlap', () => {
    const all = ['Claude Code', 'Kiro'];
    // configured runtime does not exist in the chip list → must not fall back to allAgents
    assert.deepEqual(
      visibleRecordAgents(all, { UnknownRuntime: { runs: 1 } }, []),
      [],
    );
  });

  it('visibleRecordAgents keeps active agent on non-overlap without restoring allAgents', () => {
    const all = ['Claude Code', 'Kiro'];
    assert.deepEqual(
      visibleRecordAgents(all, { UnknownRuntime: { runs: 1 } }, [], 'Kiro'),
      ['Kiro'],
    );
  });

  it('visibleRecordAgents never falls back to allAgents when filtered', () => {
    assert.doesNotMatch(src, /visible\.length > 0 \? visible :/);
  });
});
