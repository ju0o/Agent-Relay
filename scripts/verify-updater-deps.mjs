/**
 * packaged app의 electron-updater 수집 누락을 빌드만으로 감지하기 위한 점검.
 * - electron-updater가 dependencies(런타임)에 있어야 함 (devDependencies면 asar 수집 누락)
 * - 빌드 출력 dist/server/backend/updater.js 존재
 * - electron.builder.yml에 publish provider 설정 존재
 * 사용: node scripts/verify-updater-deps.mjs (exit 1 = 문제 있음)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
let failed = false;
const fail = (m) => { console.log('  FAIL  ' + m); failed = true; };
const pass = (m) => console.log('  PASS  ' + m);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.dependencies && pkg.dependencies['electron-updater']) {
  pass(`electron-updater in dependencies (${pkg.dependencies['electron-updater']})`);
} else {
  fail('electron-updater가 dependencies에 없음 — packaged app 수집 누락 위험');
}
if (pkg.devDependencies && pkg.devDependencies['electron-updater']) {
  fail('electron-updater가 devDependencies에도 있음 — dependencies로만 유지해야 함');
} else {
  pass('electron-updater not in devDependencies');
}

const updaterOut = path.join(root, 'dist', 'server', 'backend', 'updater.js');
if (fs.existsSync(updaterOut)) pass('dist/server/backend/updater.js 존재');
else fail('dist/server/backend/updater.js 없음 — npm run build:server 먼저 실행');

const yml = fs.readFileSync(path.join(root, 'electron.builder.yml'), 'utf8');
if (/publish:/.test(yml) && /provider:\s*github/.test(yml)) pass('electron.builder.yml publish provider 설정 있음');
else fail('electron.builder.yml publish 설정 누락');

console.log(failed ? '\n결과: CHECK FAILED' : '\n결과: ALL PASS');
process.exit(failed ? 1 : 0);
