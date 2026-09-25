/* Version per build — one task, one evidence line.
 *
 * package.json stayed 0.3.1 across builds v1-v11 so installers could not be
 * told apart. This script sets package.json (and package-lock.json, when
 * present) to 0.3.<N> where N = the count of commits on
 * agent-relay/integration since the 0.3.1 commit, or a passed number:
 *
 *   node scripts/next-version.mjs        # count from git history
 *   node scripts/next-version.mjs 12     # explicit build number N
 *
 * Pure computation (versionForBuildCount) is unit-tested in
 * test/version-per-build.test.mjs alongside the window-title helper.
 * Build scripts are otherwise untouched.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_VERSION_MAJOR_MINOR = "0.3";
export const APP_BASE_VERSION = "0.3.1";
export const APP_BASE_COMMIT = "d16c60cfd134e87a75d149acb47a89c81aa32969";
export const COUNT_BRANCH = "agent-relay/integration";

/** Pure: build number N → '0.3.<N>' (non-finite/negative clamps to 0). */
export function versionForBuildCount(count) {
  const n =
    typeof count === "number" && Number.isFinite(count)
      ? Math.max(0, Math.floor(count))
      : 0;
  return `${APP_VERSION_MAJOR_MINOR}.${n}`;
}

/** Find the 0.3.1 commit: pickaxe search first, known SHA fallback. */
export function resolveBaseCommit(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["log", "--format=%H", COUNT_BRANCH, "-S", '"version": "0.3.1"', "--", "package.json"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const shas = out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (shas.length > 0) return shas[shas.length - 1]; // oldest = the 0.3.1 commit
  } catch {
    // fall through to the known SHA
  }
  return APP_BASE_COMMIT;
}

/** Pure-adjacent: N = `git rev-list <base>..<branch> --count`. */
export function countCommitsSince(base, branch = COUNT_BRANCH, cwd) {
  const out = execFileSync("git", ["rev-list", `${base}..${branch}`, "--count"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const n = Number.parseInt(out.trim(), 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`bad commit count: ${out.trim()}`);
  return n;
}

/** Resolve N: explicit CLI number wins, otherwise count from git history. */
export function resolveBuildNumber(argv, cwd) {
  const raw = argv[2];
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return countCommitsSince(resolveBaseCommit(cwd), COUNT_BRANCH, cwd);
}

function writeVersion(pkgPath, version) {
  // Targeted single-line replacement — keeps every other byte (incl. the
  // single-line "bin" object) untouched so the diff is exactly the version.
  // A replacer function avoids `$`-pattern pitfalls; rewriting the same
  // version is a no-op success (idempotent re-runs).
  const text = fs.readFileSync(pkgPath, "utf8");
  const pattern = /"version"\s*:\s*"[^"]*"/;
  if (!pattern.test(text)) throw new Error(`no "version" field in ${pkgPath}`);
  const next = text.replace(pattern, () => `"version": "${version}"`);
  JSON.parse(next); // still valid JSON after the swap
  fs.writeFileSync(pkgPath, next, "utf8");
}

/** Set package.json (+ package-lock.json when present) to 0.3.<N>. Returns the version. */
export function setNextVersion(buildNumber, root) {
  const version = versionForBuildCount(buildNumber);
  writeVersion(path.join(root, "package.json"), version);
  const lockPath = path.join(root, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      lock.version = version;
      if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } catch {
      // package.json is the source of truth; a lock rewrite failure never blocks.
    }
  }
  return version;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const n = resolveBuildNumber(process.argv, root);
  const version = setNextVersion(n, root);
  process.stdout.write(`${version}\n`);
}
