# Independent certification review of the fixed orchestrator (9af10aa) — Grok, read-only, 2026-09-16 08:27Z

PM disposition: PASS accepted. All 10 findings CLOSED with revert-guard tests named; no new P0/P1/P2; 28/0 tests run by the reviewer. WBS-5/8 = ACCEPTED pending WBS-10 real-runtime certification.

WBS58_CERT: PASS
NEW_P0: NONE
NEW_P1: NONE
NEW_P2: NONE
TESTS_RUN: 28/0

| Finding | Status | Fix (file:line) | Revert-guard test |
|---|---|---|---|
| P1-1 timeout no re-send | CLOSED | `role-loop.ts:125–147` — `send` once; on collect timeout → `interrupt` → collect-only with same `requestId` (“never resend”); `clearTimeout` in `collectWithTimeout` `:117–122` | `(d) PM send timeout: a hanging adapter is not resent…` (`assert.equal(adapter.sendLog.length, 1)`); `(d) PM late response after timeout is collected without a second send` |
| P1-2 registry-resolved primary + zeroExtraBilling→OWNER_REQUIRED | CLOSED | `role-loop.ts:63–66` `zeroExtraBilling !== true` → `PmOwnerRequiredError`; `:85–90` primary via `resolveAdapter` / id match, else `OWNER_REQUIRED` | `(a) primary PM adapter must be registered and zeroExtraBilling must be true`; `(a) billing guard: assertBillingAllowed…` (`zeroExtraBilling: false` → `/OWNER_REQUIRED/`) |
| P1-3 dispatch-hook worker identity | CLOSED | `main.ts:78–82` `selectBuilderWorker` matches `actl-managed:<workerId>` exactly one `implementation` record; `:88` uses it | `(P1-3) default worker selector matches actl-managed adapter identity and rejects missing/ambiguous records` |
| P2 timers | CLOSED | `role-loop.ts:117–122` `finally { clearTimeout(timer) }` | `(d) PM send timeout…` / late-response (suite exits; hung-handle symptom gone) |
| P2 hygiene | CLOSED | `test/v1-orchestrator.test.mjs:152` sets `FAKE_BUILDER_OUTPUT` / `FAKE_BUILDER_COUNTER` under temp workspace; `fake-builder-worker.mjs:2` honors env | CREATE_TASK / CHANGES tests that spawn builder; cwd has no leftover `.builder-attempt`/`out.txt` after run |
| P2 predicate doc | CLOSED | `role-loop.ts:46–47` comment: deliberately small model-ref allowlist | `(a) billing guard: assertBillingAllowed is a pure, directly-testable unit` |
| D2 ensureSession→BLOCKED_RUNTIME | CLOSED | `role-loop.ts:289–293` / `:437–441` + `recordRuntimeBlock` `:207–213` catch session/send failures → durable `BLOCKED_RUNTIME` + `pendingReask` | `2 provider/session unavailable leaves canonical state untouched and healthy retry applies once` |
| D3 429→BLOCKED_RUNTIME+retryAfter | CLOSED | `runtimeFailure` `:202–204` + `recordRuntimeBlock` persists/audits `retryAfter` | `3 rate limit 429 leaves canonical state untouched and does not use a paid fallback` (`blocked.retryAfter === 60`) |
| D6 restart-after-createTask idempotent | CLOSED | `role-loop.ts:530–537` `runOnce` dispatches existing `READY` Task with `linkedRuns.length===0` before bootstrap | `6 restart after CREATE_TASK before dispatch does not create a second Task` (`dispatch-existing-ready`, task count stable) |
| D8 CONTRACT_FROZEN on existing task_id | CLOSED | `role-loop.ts:370–372` `handleAcceptAndNext` early reject; `:496–499` final-gate pre-apply reject + audit | `8 ACCEPT_AND_NEXT targeting an already-dispatched Task is contract-frozen with no mutation` |

**New risks from `b0eeae7..9af10aa`:** no new direct canonical FS writes (still backend APIs only); no paid-fallback HTTP; no secrets in logs. `tsc --noEmit` clean. Orchestrator+drills: **28 pass / 0 fail** this run (an earlier combined run’s 2 fails were `after` live-dataRoot hygiene hits on concurrent `_relay/locks` — not product regressions from this diff).
