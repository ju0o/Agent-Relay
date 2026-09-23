# Agent Relay V2 REAL JIT DOGFOOD-02 Independent QA

Date: 2026-09-22 (Asia/Seoul)

## Scope and identity

- Target: `9c6dd50133049a076c224e0ca03d713279e5254e` (HEAD verified).
- Parent: `1172ff5acd7dfeb39d94e4f3f4cf1d11c0495494` (verified ancestor).
- Worktree was clean before QA. Only this report is permitted to be created/changed.
- Parent-to-target changed paths: `src/v2/portfolio-jit/index.mjs`, `test/v2/portfolio-jit.test.mjs`, `qa/dogfood_v2_real_runtime_jit.mjs`. No Certified V1 path was in that diff.
- Certified V1 SHA `df03ebdacabba1ae95b91d916239927d65b023f7` exists as a commit. Its tree is distinct from the V2 candidate; no V1 file was changed by the reviewed parent-to-target diff.

## Evidence

| Check | Result | Evidence |
|---|---|---|
| Focused V2 tests | PASS | `node --test test/v2/portfolio-jit.test.mjs`: 1 test file, 1 pass, 0 fail, exit 0. |
| Real lifecycle harness | NOT_PROVEN / BLOCKED | `node qa/dogfood_v2_real_runtime_jit.mjs` reached `before`, then failed before `started` with `spawnSync which EPERM`; scheduler reported `FAILED_RUNTIME`, `failureClass: UNKNOWN`, `activeRuntimes: 0`, exit 1. |
| Runtime identity/cwd/readiness/dispatch/result/stop | NOT_PROVEN | No candidate runtime was spawned by the harness, so no target PID, executable/cwd, readiness, marker correlation, or stop event was captured. The outer Codex sandbox wrapper was observed, but it is not the candidate child runtime. |
| Orphan cleanup | PASS for observed run | No `/tmp/agent-relay-codex-*` directory and no matching candidate `codex exec --ephemeral` process remained after the failed run. |
| Full tests | BLOCKED | `npm test` exited 1 at `test/fs.test.mjs`: missing generated `dist/server/backend/fs.js`. |
| Typecheck | BLOCKED | `npm run typecheck` exited 127: `tsc: not found`. |
| Production/test/package mutation | PASS | Final `git status --short` was empty before this report was created. No production code, tests, or package files were edited. |

## Fail-closed assessment

The supplied harness is designed to require exact Codex identity, readiness, dispatch acknowledgement, exact result marker, release, and zero active runtimes. Because executable resolution was denied by the environment before `start()` completed, the required real lifecycle is not certified. This is an environment/runtime-evidence blocker, not a claim of a production defect.

## Verdict

QA_CHANGES
