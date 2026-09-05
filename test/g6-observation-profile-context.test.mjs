/**
 * G6 observation profile context — Run-bound Claude profile propagation.
 * Hermetic: no Claude invocation, no credentials, no real Relay Task.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.join(os.tmpdir(), `arl-g6-profile-${process.pid}-${Date.now()}`);
fs.mkdirSync(ROOT, { recursive: true });

let passed = 0;
let failed = 0;
const check = (condition, message) => {
  if (condition) { console.log(`  PASS  ${message}`); passed++; }
  else { console.log(`  FAIL  ${message}`); failed++; process.exitCode = 1; }
};

const profile = await import('../dist/server/integrations/claude/profile.js');
const storage = await import('../dist/server/integrations/claude/storage.js');
const fsApi = await import('../dist/server/backend/fs.js');
const dispatcher = await import('../dist/server/backend/dispatcher.js');
const registry = await import('../dist/server/integrations/core/registry.js');
const { CaptureManager } = await import('../dist/server/backend/capture-manager.js');

function makeHome(name) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(path.join(home, '.claude-pro', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-team', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

console.log('\n-- Run-bound Claude profile context --');
const home = makeHome('home');
const proWorkspace = path.join(home, 'Desktop', 'Projects', 'Core', 'Relay');
const teamWorkspace = path.join(home, 'Desktop', 'Projects', 'Team', 'Relay');
fs.mkdirSync(proWorkspace, { recursive: true });
fs.mkdirSync(teamWorkspace, { recursive: true });

// 1. Pro profile: Worker resolution and observer transcript root agree.
const pro = profile.resolveClaudeConfigContext(proWorkspace, { HOME: home });
check(pro.profile === 'pro' && pro.configDir === path.join(home, '.claude-pro'), 'pro Run resolves ~/.claude-pro');
check(storage.claudeProjectsRoot(pro.configDir) === path.join(home, '.claude-pro', 'projects'), 'pro observer watches ~/.claude-pro/projects');

// 2. Team profile: directory-only routing remains exact.
const team = profile.resolveClaudeConfigContext(teamWorkspace, { HOME: home });
check(team.profile === 'team' && team.configDir === path.join(home, '.claude-team'), 'team Run resolves ~/.claude-team');
check(storage.claudeProjectsRoot(team.configDir) === path.join(home, '.claude-team', 'projects'), 'team observer watches ~/.claude-team/projects');

// 3. Explicit inherited profile wins over workspace routing.
const explicitDir = path.join(home, 'explicit-profile');
fs.mkdirSync(path.join(explicitDir, 'projects'), { recursive: true });
const inherited = profile.resolveClaudeConfigContext(proWorkspace, { HOME: home, CLAUDE_CONFIG_DIR: explicitDir });
check(inherited.profile === 'inherited' && inherited.configDir === explicitDir, 'explicit CLAUDE_CONFIG_DIR wins');
check(storage.claudeProjectsRoot(inherited.configDir) === path.join(explicitDir, 'projects'), 'explicit observer root is exact');

// 4. A mismatched observer parent cannot override the Run-bound target.
const previousAmbient = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-team');
let seenTarget;
registry.clearAdapters();
registry.registerAdapter({
  id: 'profile-probe',
  agentName: 'Profile probe',
  startWatch: async (target) => {
    seenTarget = target;
    return { adapterId: 'profile-probe', stop: async () => undefined };
  },
});
const cm = new CaptureManager(() => undefined);
await cm.arm('profile-probe-run', 'profile-probe', {
  folder: path.join(ROOT, 'run'),
  workspaceRoot: proWorkspace,
  claudeConfigDir: pro.configDir,
});
check(seenTarget?.claudeConfigDir === pro.configDir, 'Run-specific profile is passed to observer despite mismatched parent env');
check(storage.claudeProjectsRoot(seenTarget?.claudeConfigDir) === path.join(home, '.claude-pro', 'projects'), 'Run-specific profile wins over ambient parent profile');
await cm.dispose();
if (previousAmbient === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = previousAmbient;

// 5. Legacy Run behavior has no Run context and retains the ambient/default fallback.
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-team');
check(storage.claudeProjectsRoot() === path.join(home, '.claude-team', 'projects'), 'legacy Run without stored context retains ambient fallback');
if (previousAmbient === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = previousAmbient;

// 6. Metadata is directory-only and dispatcher supplies the same trusted arg.
const run = path.join(ROOT, 'meta-run');
fsApi.writeRunMeta(run, { tags: [], runId: '11111111-1111-1111-1111-111111111111', claudeConfigDir: pro.configDir });
const rawMeta = fs.readFileSync(path.join(run, 'meta.json'), 'utf8');
check(fsApi.readRunMeta(run).claudeConfigDir === pro.configDir, 'Run metadata preserves effective config directory');
check(!rawMeta.includes('oauth') && !rawMeta.includes('token') && !rawMeta.includes('secret'), 'Run metadata contains no credential material');
const argv = dispatcher.buildDispatchArgv(['wrapper.mjs'], {
  dataRoot: ROOT, project: 'p', taskId: 'TASK-0001', runId: '11111111-1111-1111-1111-111111111111',
  workspaceRoot: proWorkspace, claudeConfigDir: pro.configDir,
});
check(argv.includes('--claudeConfigDir') && argv.includes(pro.configDir), 'dispatcher passes persisted profile context to wrapper');

console.log(`\nG6 observation profile context tests complete. Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exitCode = 1;
