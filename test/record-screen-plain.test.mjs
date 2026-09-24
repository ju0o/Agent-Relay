import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'frontend', 'App.tsx'), 'utf8');

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
});
