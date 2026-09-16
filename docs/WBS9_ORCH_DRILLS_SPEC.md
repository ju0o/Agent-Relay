# WBS-9 — orchestrator-side resilience/idempotency drills (spec for the Codex Builder lane; dispatch after WBS-5/8 lands)

Builder-side drills already PASS (`38d1cd4`, `test/v1-builder-dispatch-drills.test.mjs`: duplicate Result, restart Builder→QA, runtime death, stale Result, dispatch idempotency). WBS-5/8 tests cover duplicate judgment (REPLAY_IGNORED), restart QA→PM, stale contract/context hash, invalid PM output (re-ask once → BLOCKED), billing guard, hung PM send. This file lists what remains, one `test()` each in `test/v1-orchestrator-drills.test.mjs` (disposable dataRoot, fake pm adapter, fake dispatch hook, zero live writes):

1. duplicate QA response — the QA gate re-run for an attempt already FINAL mints no second Delivery and no second PM invocation (count deliveries/audit entries).
2. provider/session unavailable — fake pm adapter throws ECONNREFUSED/503 on ensureSession → canonical untouched, audit `BLOCKED_RUNTIME`, per-delivery state file still says pending; next `--once` with a healthy adapter resumes and applies exactly once.
3. subscription usage limit / rate limit — adapter returns 429 → same as (2) plus `retryAfter` recorded; no fallback to a non-free entry.
4. certified zero-billing fallback — assignment with fallbackChain `[free-B]`; primary hangs/fails → loop walks to free-B (registered + passes billing guard) and completes once; audit shows the switch; a chain `[paid-X]` → OWNER_REQUIRED audit only.
5. PM judgment applied twice by two concurrent `--once` processes (spawn two) → exactly one judgment record, one Delivery reconcile, second sees REPLAY_IGNORED or lock conflict; no throw that leaves partial state.
6. restart mid-CREATE_TASK — kill after createTask but before dispatch hook (inject a fault) → next `--once` dispatches the existing Task, does not create a second Task (Task count unchanged).
7. session file corrupted (`_relay/role-sessions/<project>/pm.json` invalid JSON) → new session created, loop continues, no canonical impact.
8. contract frozen — PM emits ACCEPT_AND_NEXT whose next contract targets an already-dispatched Task id → CONTRACT_FROZEN fail-closed, no mutation.

Report: `docs/WBS9_ORCH_DRILLS_EVIDENCE.md` with the pasted `node --test` summary and, per drill, the canonical counts before/after.
