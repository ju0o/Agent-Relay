/* First-run copy regression — non-developer wording for the data-folder screen.
   Reads App.tsx, index.html and main.ts as plain text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appTsx = fs.readFileSync(path.join(root, 'src/frontend/App.tsx'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mainTs = fs.readFileSync(path.join(root, 'src/backend/main.ts'), 'utf8');

test('no legacy product name remains', () => {
  for (const [name, content] of [['App.tsx', appTsx], ['index.html', indexHtml], ['main.ts', mainTs]]) {
    assert.ok(!content.includes('Agent Relay Log'), `${name} still contains 'Agent Relay Log'`);
  }
});

test('no developer jargon remains in first-run copy', () => {
  for (const [name, content] of [['App.tsx', appTsx], ['index.html', indexHtml], ['main.ts', mainTs]]) {
    assert.ok(!content.includes('GPT →'), `${name} still contains 'GPT →'`);
  }
  // 'Markdown' is developer jargon for the setup screen (App.tsx) and window title files.
  // Backend record helper names (exportRunMarkdown/writeMarkdown in main.ts) are
  // internal API calls into fs.js and are intentionally out of scope here.
  for (const [name, content] of [['App.tsx', appTsx], ['index.html', indexHtml]]) {
    assert.ok(!content.includes('Markdown'), `${name} still contains 'Markdown'`);
  }
  assert.ok(!appTsx.includes("name: 'Markdown'"), "App.tsx still references a 'Markdown' dialog label");
  assert.ok(!mainTs.includes("name: 'Markdown'"), "main.ts still shows a 'Markdown' dialog label");
});

test('first-run setup card uses non-developer copy', () => {
  assert.ok(appTsx.includes('<h1>Agent Relay</h1>'), 'setup h1 should be exactly Agent Relay');
  assert.ok(
    appTsx.includes('Agent Relay는 여러 프로젝트의 기획(PM) → 작업(Worker) → 검수(QA)를 자동으로 이어서 실행합니다.'),
    'missing PM → Worker → QA line',
  );
  assert.ok(
    appTsx.includes('사용자는 결과를 확인하고, 꼭 필요한 결정에만 답하면 됩니다.'),
    'missing user/decision line',
  );
  assert.ok(appTsx.includes('먼저 결과와 기록을 저장할 폴더를 정해 주세요.'), 'missing folder-request line');
  assert.ok(appTsx.includes('기본 폴더 사용 (문서 › Agent Relay)'), 'missing primary button label');
  assert.ok(appTsx.includes('settings.defaultDataRoot'), 'full default path should be shown from settings.defaultDataRoot');
  assert.ok(appTsx.includes('다른 폴더 고르기'), 'missing secondary button label');
});

test('decision wording is present', () => {
  assert.ok(appTsx.includes('결정'), "App.tsx should contain the '결정' wording");
});

test('brand and window titles are Agent Relay', () => {
  assert.ok(indexHtml.includes('<title>Agent Relay</title>'), 'index.html title should be Agent Relay');
  assert.ok(mainTs.includes("title: 'Agent Relay'"), 'BrowserWindow title should be Agent Relay');
  assert.ok(
    appTsx.includes('저장 폴더를 찾을 수 없습니다 (외장 드라이브가 빠졌거나 폴더가 옮겨졌을 수 있어요).'),
    'missing-root copy not found',
  );
});
