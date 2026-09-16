# Independent review of the certification P1 closure (df7523d) — Codex builder10 (%17), 2026-09-16 11:47Z

PM disposition: PASS accepted → with the Claude Pro certification review (PASS_WITH_CONDITIONS, conditions now closed), the orchestrator range 9af10aa..df7523d has P0 = 0 and P1 = 0. PM proposes AGENT_RELAY_ROLE_ORCHESTRATOR_V1 = CERTIFIED to the Owner (Owner sets the flag).

P1_CLOSURE: PASS
NEW_P0: NONE
NEW_P1: NONE
NEW_P2: NONE
TESTS_RUN: 218/0

| Certification P1 | Verdict | Fix and revert-guard test |
|---|---|---|
| (a) `diffScope` collapses untracked directories and produces a wrong QA FAIL | CLOSED | `src/backend/qa-deterministic-evaluator.ts:437-457` runs `git status --porcelain=v1 --no-renames -uall` and evaluates individual paths. Revert guard: `test/v16-slice2-deterministic-qa.test.mjs:225-249`, cases 12b (allowed untracked file PASS) and 12c (extra untracked file FAIL); file total `67/0`. |
| (b) Consumed retry preparation with an expired/released reservation is silent | CLOSED | `src/backend/retry-dispatch.ts:470-483` detects the linked `RESERVED` + `RELEASED` run and returns the auditable expired-before-send outcome; the loop records it as `BLOCKED_RUNTIME`. Revert guard: `test/v1-g5c-auto-redispatch.test.mjs:709-723`, assertions require the audit and no third Run; file total `116/0`. |
| (c) `PROJECT_COMPLETE` is re-asked every idle cycle | CLOSED | `src/orchestrator/role-loop.ts:381-387,458-463` caches completion by bootstrap `contextHash`, audits `PROJECT_COMPLETE_CACHED`, and invalidates the cache after canonical change. Revert guard: `test/v1-orchestrator.test.mjs:344-360`, the PM send count stays at one until a new canonical goal, then becomes two; file total `35/0`. |
