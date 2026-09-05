import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type ClaudeConfigProfile = 'inherited' | 'team' | 'pro' | 'default';

export interface ClaudeConfigContext {
  /** Absolute, directory-only Claude configuration path. Never credential content. */
  configDir: string;
  profile: ClaudeConfigProfile;
}

/**
 * Resolve the Claude configuration directory for one Worker launch.
 *
 * This is deliberately a launch-context decision, not an observer decision:
 * callers persist the returned directory on the Run and pass it to both the
 * Worker and its observer. `env` is injectable only for deterministic tests.
 */
export function resolveClaudeConfigContext(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeConfigContext {
  const inherited = env['CLAUDE_CONFIG_DIR'];
  if (inherited?.trim()) {
    const configDir = path.resolve(inherited.trim());
    if (fs.existsSync(configDir) && fs.statSync(configDir).isDirectory()) {
      return { configDir, profile: 'inherited' };
    }
    throw new Error('Inherited CLAUDE_CONFIG_DIR must be an existing directory.');
  }

  const home = env['HOME']?.trim() || os.homedir();
  const teamRoot = path.resolve(home, 'Desktop', 'Projects', 'Team');
  const workspace = path.resolve(workspaceRoot);
  const isTeamWorkspace = workspace === teamRoot || workspace.startsWith(teamRoot + path.sep);
  const profile: ClaudeConfigProfile = isTeamWorkspace ? 'team' : 'pro';
  const routed = path.join(home, isTeamWorkspace ? '.claude-team' : '.claude-pro');

  if (fs.existsSync(routed) && fs.statSync(routed).isDirectory()) {
    return { configDir: routed, profile };
  }

  // Preserve Claude's documented default when a routed profile is unavailable.
  return { configDir: path.join(home, '.claude'), profile: 'default' };
}

/** Validate persisted metadata before using it as a transcript root selector. */
export function normalizeClaudeConfigDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return undefined;
  const resolved = path.resolve(value.trim());
  return path.isAbsolute(resolved) ? resolved : undefined;
}
