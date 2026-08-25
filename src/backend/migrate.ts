/**
 * Settings migration — portable exe → installed (userData) app.
 *
 * Non-destructive by contract: we only ever COPY a legacy settings.json into
 * the new baseDir when the destination has none. The source file is never
 * modified or deleted, so the old portable exe keeps working.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings } from '../shared/types.js';

/** True when baseDir already has a settings.json. */
export function settingsExists(baseDir: string): boolean {
  return fs.existsSync(path.join(baseDir, 'settings.json'));
}

/**
 * Find the first candidate directory that actually contains a settings.json.
 * Returns the full file path, or null when nothing to migrate.
 */
export function findLegacySettingsFile(candidates: readonly string[]): string | null {
  for (const dir of candidates) {
    if (!dir) continue;
    const p = path.join(dir, 'settings.json');
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not there — try next candidate
    }
  }
  return null;
}

/**
 * Copy legacy settings.json into baseDir when:
 *   - baseDir/settings.json does not exist yet, and
 *   - one of the candidate dirs holds a readable settings.json.
 *
 * Returns the source path on success, null when nothing was done.
 * Throws when the legacy file is unreadable or unparsable — caller decides
 * how loud to be (a broken legacy file must never block app startup).
 */
export function migrateSettings(baseDir: string, candidates: readonly string[]): string | null {
  if (settingsExists(baseDir)) return null;
  const src = findLegacySettingsFile(candidates);
  if (!src) return null;
  const raw = fs.readFileSync(src, 'utf8');
  JSON.parse(raw) as AppSettings; // throws → caller catches and skips migration
  fs.mkdirSync(baseDir, { recursive: true });
  const dest = path.join(baseDir, 'settings.json');
  fs.copyFileSync(src, dest);
  return src;
}
