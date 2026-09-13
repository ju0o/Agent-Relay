# Agent Relay — V1 USER-STABLE FINAL CERTIFICATION REPORT

- Role: Independent Release Certification Lead (no Builder work)
- Candidate branch: `dev/adapter-foundation-01`
- Candidate HEAD: `5074f4e5a318cb3427b1a0ca8cc1629c7669e5c6`
- Production code commit: `c375e57c6a49bff6cccc40aab1f173bf01f78885` (Stable Hardening 01, BUG-001 fix)
  - `5074f4e` and `2ae3f69` are docs-only (`docs/V16-PM-ACCEPTANCE-01.md`); verified via
    `git show --stat`. Production code at HEAD == `c375e57`.
- Ancestry verified: `c375e57` is an ancestor of HEAD; `git log origin/dev/adapter-foundation-01..HEAD` empty (pushed).
- Duration: 2026-09-11 ~10:00–10:25 KST active execution (~25 min dense deterministic testing).
  The 4–5h budget was not fully consumed: fixture-driven E2E cycles execute in seconds each
  while meeting every required count. Counts were met, not shortcut.
- Production code modified: NO (`git diff --stat -- src/` empty after all runs)
- Commits created: NO (this report + cert harnesses are untracked; harnesses live in `/tmp/opencode/cert/`)
- Test double: `test-fixture` observation adapter + fixture workers (`stay-alive.mjs`,
  `exit-zero-instant.mjs`) against compiled `dist/server` modules built from the candidate
  (`npm run build:server` re-run during certification). No GPT calls; PM judgments were
  submitted through the real MCP tool `relay_pm_submit_judgment` / kernel paths with
  ACCEPT and CHANGES decisions exercising the exact daily-use state machine.

## Results

HAPPY PATH: 20 / 20
CHANGES SAME-TASK RETRY: 10 / 10
FAILURE / RECOVERY: PASS (10 scenarios, 31 checks)
RESTART / DURABILITY: PASS (10 seams, 26 checks — incl. real SIGKILL + fresh-process resume)
DUPLICATE / IDEMPOTENCY: PASS (7 groups, 14 checks — incl. concurrent submits)
BUG-001 REGRESSION: PASS (11 checks)
V1 REGRESSION: PASS (10 suites, 602 assertions, 0 failures)
V1.5 REGRESSION: PASS (5 suites, 160 assertions, 0 failures)
V1.6 REGRESSION: PASS (9 suites, 479 assertions, 0 failures)
TYPECHECK: PASS (`tsc` server + client, clean)
BUILD: PASS (`tsc -p tsconfig.server.json` + `vite build`, clean)

P0 OPEN: 0
P1 OPEN: 0
P2 OPEN: 0
P3 OPEN: 0

UNEXPECTED MANUAL INTERVENTIONS: 0 in defined core scenarios.
(D7's stripped preparation marker was harness fault-injection simulating a crash seam,
not a product manual operation. All recoveries used supported kernel paths:
`reconcilePmDeliveries`, `reconcileReadyRetryDispatches`, `promoteObservedResult`.)

REPRODUCED BUGS: none. No `.user-stable-cert/findings/BUG-*.md` created (nothing real found).

PRE-EXISTING KNOWN ISSUES:
- `test:phase-i-dogfood` has 3 failures (I-17 env-dump x2, I-32 `--claudeConfigDir` flag).
  Proven pre-existing: reproduced byte-identical (118 passed / 3 failed) on an isolated
  worktree at baseline `56a26c5` (pre-Slice-5). Zero regression delta from the candidate.
  V1/V1.5/V1.6 certification paths are unaffected (all green).

## Evidence (per target)

- Target A (`/tmp/opencode/cert/cert-a-happy.mjs`): 20 independent tasks, each
  owner-dispatch → exactly 1 Run → capture → delivery `PMD-<task>-<run>` → MCP ACCEPT →
  terminal ACCEPTED with `acceptedRunId` == single Run; stable across process-local reset;
  identical ACCEPT replay adds no Run. 20/20.
- Target B (`/tmp/opencode/cert/cert-b-retry.mjs`): 10 cycles Run1 → CHANGES → auto
  same-Task redispatch → new Run ID → lineage (`sourceRunId`, `retryPreparationId`,
  same worker + workspace) → Run2 result → delivery #2 → ACCEPT with retry Run as winner,
  `retryCount == 1`, exactly 2 Runs; stale source delivery rejected (CONFLICT); pre-terminal
  duplicate CHANGES replay adopts same Run; post-terminal CHANGES replay throws safe
  CONFLICT with zero mutation (designed behavior per `retry-preparation.ts`
  `reconcileReadyPreparation`). 10/10.
- Target C (`/tmp/opencode/cert/cert-c-failure.mjs`): F1 duplicate bridge promotion x3 →
  idempotent (1 Run/1 Delivery, ACCEPT still works); F2 stale runId/folder → null, no
  invented success; F3 PROCESS_FAILED → never promotes, no Delivery; F4 interrupted capture
  → no phantom, bridge re-promotion recovers; F5 spawn failure → canonical FAILED, no
  Delivery, re-dispatch refused, fresh task still dispatches; F6 completed-run reconcile →
  no-op; F7 reconcile/ensure repeats → single record; F8 ACCEPT with live worker → successor
  dispatches; F9 stale CHANGES post-ACCEPT → terminal intact; F10 instant-exit worker →
  exit alone never promotes, later completion works. 31/31.
- Target D (`/tmp/opencode/cert/cert-d-restart.mjs` + 2 child processes): D1 post-dispatch,
  D2 double restart, D3 mid-capture kill, D4 post-RESULT_RECEIVED, D5 around delivery,
  D6 around CHANGES prep (post-restart reconcile dispatches exactly once), D7 stripped
  consumption marker (post-restart adopts same Run, no second Run), D8 terminal no-op
  (task + delivery records byte-identical), D9 REAL SIGKILL of the capturing process
  mid-settle (state sane, parent completes from disk truth), D10 REAL fresh `node` process
  ACCEPTs a RESULT_RECEIVED task from disk only (`RESUME-OK`). 26/26.
- Target E (`/tmp/opencode/cert/cert-e-idempotency.mjs`): 10x ensure/reconcile → 1 delivery;
  3x ACCEPT → single ACCEPT/1 Run; 3x retry dispatch → same Run; 4x concurrent ACCEPT →
  single ACCEPT/1 Run; 8x concurrent reconcile/ensure → 1 delivery, uncorrupted; 3x
  concurrent dispatch → 1 canonical Run; 3x post-consume CHANGES replay → adopts same Run,
  still 2 Runs. 14/14.
- Target F (`/tmp/opencode/cert/cert-f-bug001.mjs`): QA-gated ACCEPT → same-worker /
  same-workspace successor with previous worker STILL ALIVE → dispatched exactly once, Plan
  cursor on successor, no `PLAN_SUCCESSOR_DISPATCH_FAILED_BEFORE_RUN`; duplicate ACCEPT hook
  is a no-op; actually-active Run still refuses concurrent reuse with CONFLICT, contender
  untouched. 11/11.
- Regression suites re-run from candidate build: `v1-g1..g5c` (602), `v15-*` (160),
  `completed-run-recovery` (26), `stable-hardening-01` (21), `v16-slice1..8` (479) — all 0
  failures. Full `npm test`: green except the 3 proven-pre-existing Phase-I failures above.

## Observations (not bugs, no BUG files)

1. Post-terminal identical CHANGES replay raises CONFLICT instead of adopting. Designed safe
   refusal (`reconcileReadyPreparation`: "Terminal states disprove this preparation — fail
   safely, no blind APPLIED"), verified zero-mutation. Acceptable for V1.
2. Capture-manager contexts are process-local: after a process death mid-capture, the
   in-flight capture is not re-armed by any dispatcher reconcile observed here; recovery
   goes through the durable bridge promotion (proven D1–D10, zero manual surgery). PM
   delivery + retry-preparation reconciles DO cover their seams. Residual note for PM:
   real-app restart with a still-alive worker re-attach was not exercised end-to-end (fixture
   scope); disk truth never corrupted in any seam tested.

## FINAL CERTIFICATION VERDICT: USER_STABLE_CERTIFICATION_PASS

All pass-bar items met: Happy 20/20, Retry 10/10, Failure PASS, Restart PASS, Idempotency
PASS, BUG-001 PASS, V1/V1.5/V1.6 regressions PASS, typecheck PASS, build PASS, P0 == 0,
P1 == 0, unexpected manual interventions == 0 in core scenarios.

RECOMMENDED PM ACTION: PROMOTE_V1_TO_USER_STABLE

IMPORTANT: This report has no authority to declare V1 USER-STABLE_CERTIFIED. Only GPT PM
may promote the release. After this report: STOP. No code modified. V2 not begun.
