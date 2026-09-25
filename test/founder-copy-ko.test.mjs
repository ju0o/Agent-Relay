/* Founder copy KO (R9/R10/R11) — Korean UI copy + settings path SSOT + lane goal dedupe + light contrast.
   Reads sources as plain text so no build is required. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const controlRoom = read('src/frontend/controlRoom.tsx');
const appTsx = read('src/frontend/App.tsx');
const labelsTs = read('src/shared/projectLabels.ts');
const css = read('src/frontend/style.css');
const mainTs = read('src/backend/main.ts');
const typesTs = read('src/shared/types.ts');
const backendFs = read('src/backend/fs.ts');

test('controlRoom uses 사람 확인 / 만드는 AI / 검수하는 AI / AI 순서 저장', () => {
  assert.match(controlRoom, /<h3>사람 확인<\/h3>/);
  assert.match(controlRoom, /만드는 AI:/);
  assert.match(controlRoom, /검수하는 AI:/);
  assert.match(controlRoom, /AI 순서 저장/);
});

test('controlRoom has no leftover English copy (Human Gate / Worker: / QA: / Agent 바꾸기)', () => {
  assert.doesNotMatch(controlRoom, /Human Gate/);
  assert.doesNotMatch(controlRoom, /<p>Worker:/);
  assert.doesNotMatch(controlRoom, /<p>QA:/);
  assert.doesNotMatch(controlRoom, /[Aa]gent 바꾸기/);
});

test('settings section uses 저장 폴더 / 앱 정보', () => {
  assert.match(appTsx, /저장 폴더/);
  assert.match(appTsx, /앱 정보/);
  assert.doesNotMatch(appTsx, /Storage — Current Data Root/);
  assert.doesNotMatch(appTsx, /About —/);
  assert.doesNotMatch(appTsx, /저장공간\(Storage\)/);
  assert.doesNotMatch(appTsx, /Storage \/ About/);
});

test('settings file path comes from the backend path.join value', () => {
  // Backend SSOT: settingsPath(baseDir) = path.join(baseDir, 'settings.json').
  assert.match(backendFs, /export function settingsPath\(baseDir: string\): string/);
  assert.match(backendFs, /return path\.join\(baseDir, 'settings\.json'\)/);
  // settings:get exposes that joined value; the type carries it.
  assert.match(mainTs, /settingsFile: relay\.settingsPath\(baseDir\)/);
  assert.match(typesTs, /settingsFile: string/);
  // Frontend renders the backend value instead of hardcoding a separator.
  assert.match(appTsx, /\{settings\.settingsFile\}/);
  assert.doesNotMatch(appTsx, /\{settings\.baseDir\}\\settings\.json/);
  assert.doesNotMatch(appTsx, /\{settings\.baseDir\}\/settings\.json/);
});

test('lane goals are deduped (통합 관제 화면 · JuCeipt 기획 keep names, unique goals)', () => {
  assert.match(labelsTs, /'jucontroler-app': \{\s*name: '통합 관제 화면'/);
  assert.match(labelsTs, /'juceipt-planning': \{\s*name: 'JuCeipt 기획'/);
  const goals = [...labelsTs.matchAll(/goal: '([^']+)'/g)].map((m) => m[1]);
  const goalOf = (id) => {
    const m = labelsTs.match(new RegExp(`['"]?${id}['"]?: \\{[^}]*?goal: '([^']+)'`));
    return m ? m[1] : null;
  };
  const appGoal = goalOf('jucontroler-app');
  const parentGoal = goalOf('jucontroler');
  const planningGoal = goalOf('juceipt-planning');
  assert.ok(appGoal && parentGoal && appGoal !== parentGoal, '통합 관제 화면 goal must differ from jucontroler goal');
  for (const other of [goalOf('juplan'), goalOf('juceipt')]) {
    assert.ok(planningGoal && other && planningGoal !== other, 'JuCeipt 기획 goal must differ from JuPlan/JuCeipt goals');
  }
  assert.ok(!goals.includes('프로젝트 통합 제어와 운영 가시성') || appGoal !== '프로젝트 통합 제어와 운영 가시성', 'no duplicated parent goal on jucontroler-app');
});

/** WCAG relative luminance + contrast ratio. */
function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test('light mode active tab + primary button meet 4.5:1', () => {
  // Primary button: white text on #0066cc.
  assert.match(css, /\.app\[data-theme="light"\] \.btn\.primary\s*\{[^}]*#0066cc[^}]*#fff[^}]*\}/);
  assert.ok(contrast('#ffffff', '#0066cc') >= 4.5, 'primary button contrast < 4.5:1');
  // Order badge in light mode must also use white text (#08121f on #0066cc is 3.38:1).
  assert.match(css, /\.app\[data-theme="light"\] \.chain-order\s*\{[^}]*#fff[^}]*\}/);
  // Active tabs: dark text (light-theme --tab-active-fg) on near-white surfaces.
  assert.match(css, /\.app\[data-theme="light"\] \.tab-btn\.active\s*\{[^}]*var\(--tab-active-fg\)[^}]*\}/);
  assert.match(css, /\.app\[data-theme="light"\] \.control-tab\.active\s*\{[^}]*var\(--tab-active-fg\)[^}]*\}/);
  const tabFg = css.match(/\.app\[data-theme="light"\][^{]*\{[^}]*--tab-active-fg:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(tabFg, 'light --tab-active-fg not defined');
  assert.ok(contrast(tabFg, '#ffffff') >= 4.5, 'active tab contrast < 4.5:1');
  assert.ok(contrast(tabFg, '#fafafa') >= 4.5, 'control active tab contrast < 4.5:1');
});
