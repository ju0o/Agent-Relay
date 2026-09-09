# Slice 6 — Restart / Reconcile — Checkpoint Receipt

Slice: 6 (Restart / Reconcile)
Branch: dev/adapter-foundation-01
Parent commit: e1c5a70 (Slice 5)
Frozen SSOT: docs/V16-QA-GATE-PLAN-01.md §8, §11, §12, §14, §16

## Implementation
Test-only slice — ZERO production-code changes (`git diff --stat -- src/` empty).
All 8 §14 seams were already implemented by accepted Slice 4 (`reconcileQaGate`
+ kernels); this slice proves each seam resumes exactly once from durable state:
- `test/v16-slice6-restart-reconcile.test.mjs` (new): 13 sections, 72 assertions.
- `package.json`: +1 line (`test:v16-slice6-restart-reconcile` script).

Method: deterministic crash-state simulation. Exact durable states a crash would
leave (built with real kernels — never fabricated verdicts), all process-local
locks wiped (`simulateRestart`, = restart amnesia), then `reconcileQaGate`.

## Focused tests
`npm run test:v16-slice6-restart-reconcile` → 72 passed, 0 failed.
Seam 1 (evaluate-from-capture) · Seam 2 (stale sub-run treated as never-started,
exactly 1 QA-agent invocation, junk overwritten) · Seam 3 (prep+dispatch once) ·
Seam 4a (READY prep, no Run → one dispatch) · Seam 4b (materialized Run adopted,
Run count unchanged, marker persisted) · Seam 5a (PASS→mint once, duplicate
no-op, VERIFYING-never-ACCEPTED) · Seam 5b (real 3×FAIL exhaustion: 3 runs,
2 preps, 1 delivery, re-escalation no-op) · Seam 7b (duplicate pre-Result →
BLOCKED resumable, then normal resume) · Seam 8 (concurrent pair → ONE dispatch;
loser gets resumable BLOCKED, never a second dispatch — honest, since the lock
serializes callers and the world moves; adoption would fabricate causality) ·
corrupt attempt/prep fail closed · ghost-Run prep refused · stale consumed
lineage never re-fires · Plan cursor frozen across restart-framed FAIL→PASS.

## QA Agent verdict
PASS. Non-vacuous (mutations fail); 8/8 seams mapped to code+test; stale-PENDING
accumulation bounded (1 attempt/Run); only module-level Maps are documented
locks (loss-safe); semantic re-invocation ≤3 total matches seam-2 spec with
exactly-once terminal; chaos sequence counts exact (2/2/1/1, stable deliveryId);
no crash path mints early/accepts/moves Plan; triple-race still 1 prep + 1 run.
P0/P1: none.

## Architecture Review verdict
PASS. Zero src diff confirmed; test imports public modules + sanctioned reset
hooks only (no monkey-patching); every seam resolution lives in production code
(seam→line map verified); S8 loser-BLOCKED judged honest and race-safe (lock +
deterministic prep id + dispatchedRunId guard + consume CAS + dispatcher READY
expectation exclude double-dispatch); crash states built with real kernels
(only deliberate corruptions are raw JSON); authority clean in all paths.
P0/P1: none. P2 observations deferred to Slice 7: LAUNCH_FAILED injection,
restart mid-reattempt-loop, multi-task lock stress, mid-flight contract-change
refusal, adopt-with-capture fall-through.

## Regression
typecheck PASS; dist verified current (no rebuild needed).
PASS: v16-s6 (72), s5 (43), s4 (105), s3 (45), s2 (65), s1 (57), v1-g4b (82),
v1-g4a (61), v1-g5a (52), v1-g5b (82), v1-g5c (114), v15 kernel/accept/reconcile
(31/23/27), completed-run-recovery (26). g5c flake-watch: clean pass, no recurrence.

## Typecheck / Build
PASS / PASS (dist current; no src changes).

## Known limitations
- Crash windows simulated deterministically, not via real SIGKILL (same durable
states; process death adds nothing but timing).
- P2 gaps above belong to Slice 7's attack matrix.

## Next Slice authorized
YES → Slice 7 (Full QA).
