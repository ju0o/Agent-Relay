# V2 History/Resume — Plan (Step 1, no implementation)

- Status: PLAN ONLY. No product code changed for this plan. V1/V1.5/V1.6
  runtime behavior untouched. No commit yet — awaiting Owner/PM scope
  confirmation (charter Step 2) before the first V2 commit lands.
- Authorization: Owner/PM V2 charter (History/Resume only). Lifts the V2
  HARD gate recorded in `docs/V16-PM-ACCEPTANCE-01.md` for this direction
  only. Sub-Agent / Parallel Multi-Worker / Cost-Aware Orchestration /
  Stable PM Runtime remain closed.
- Roadmap anchor: `docs/PM-COST-BENCHMARK-01.md` —
  `... -> V1.5 Sequential Tasks -> V2 History/Resume -> V2.5 Sub-Agent -> ...`

## 1. What "History" means in the existing data model

No new concept. Everything History needs already exists on disk as JSON
SSOT under `{DATA_ROOT}/{project}/_relay/` (+ Run folders). History is a
**read-only join** over records the kernel already writes:

| Record | Location | Join key |
|---|---|---|
| Goal | `_relay/goals/GOAL-NNNN/goal.json` | `goalId` |
| Task | `_relay/tasks/TASK-NNNN/task.json` (`linkedRuns[]`, `acceptedRunId`) | `taskId`, `goalId` |
| Run | `{date}/{agent}/{NN}/meta.json` (`runId` UUID, `taskId`, `taskRunSequence`, `sourceRunId`, `retryPreparationId`) | `runId` (logical, survives folder moves) |
| Delivery | `_relay/pm-deliveries/PMD-{taskId}-{runId}/delivery.json` | deterministic ID, one per attempt |
| Judgment | `_relay/pm-judgments/PMJ-{deliveryId}/judgment.json` (`ACCEPT`/`CHANGES`, `intent.json` for CHANGES) | `deliveryId` |
| Event | `_relay/events/EVENT-NNNNNN/event.json` (16 types, `taskId?/runId?`) | `taskId`/`runId` |
| Evidence | `_relay/evidence/EVIDENCE-NNNNNN/evidence.json` (immutable, 10 types) | `taskId`/`runId` |

Chain: `Goal ─1:N─ Task ─linkedRuns[]─ Run ─mint─ Delivery ─submit─ Judgment`,
with Events/Evidence attached via `taskId`/`runId` (`runId` is the join key).

Gap today: the only History UI (`buildHistory` in `src/backend/fs.ts`) reads
date/agent/Run + prompt/result presence + tags. It knows nothing about
Goals, Tasks, Deliveries, Judgments, Events, or Evidence. A Task-level
detail view exists only in the TUI (`src/tui/views/task-detail.ts`,
`events.ts`, `memo-history.ts`); the Electron app has no Task UI at all.

**History = a browsable per-Task timeline** (Task record + its Runs in
`taskRunSequence` order + Delivery/Judgment per attempt + linked Events and
Evidence), read-only, resolved via `runId → taskId → PMD-* → PMJ-*`.
No new files, no new writers, no index files (same rationale as the
dogfooding "markdown/JSON itself is SSOT, no index.json" rule).

## 2. What "Resume" means — recommendation

Three candidates were considered against what the kernel can actually back:

- **(a) Reopen a historical Task's full record (read-only).** Fully
  supported today — pure read path over the join in §1. No state machine
  involvement. This is the safe core of "History".
- **(b) Resume an interrupted/incomplete Run.** Partially supported. The
  kernel already has narrow, proven re-entry points, each covering only its
  own seam (see §4). What is NOT covered: orphaned `DISPATCHED`/`RUNNING`
  Tasks whose worker died without a terminal transcript (permanently
  orphaned today), retry preparations crashed mid-`RECEIVED`/`CHANGES_APPLIED`,
  QA-gate-mid-crash (`RESULT_RECEIVED+PENDING` is not a delivery-reconcile
  target), and completed-Run recovery which is manual-MCP-trigger only
  (`relay_pm_recover_completed_run` never runs automatically).
- **(c) Restore the app's own session/window state after restart.**
  Already shipped (v0.3.2/v0.3.3: `lastProject`/`lastAgent` settings +
  `src/frontend/worktabs.ts` localStorage snapshot of tab
  descriptors/order/active tab/capped unsaved drafts). Pure UI restore —
  deliberately does NOT re-arm backend watch/dispatch/Delivery. Any gap
  here (e.g. tab shows `RESULT_RECEIVED` but no Delivery was minted) is a
  backend-consistency question, not a UI question.

**Recommendation: (a) now, (b) as guided semi-automatic recovery, (c) is
done.** Specifically for (b): do NOT build automatic re-dispatch or
transparent continuation. Build **"Resume scan + guided actions"**: after
restart (or on demand), scan for Tasks/Runs stuck in the five known gaps
(orphaned dispatch, unrecovered completed Run, crashed preparation,
crashed QA gate, UI/backend mismatch) and surface each with the one action
the kernel already blesses for it (`orphan-resolution` CONFIRM_*,
`recover_completed_run`, reconcile re-run, reconcileQaGate re-run,
ensurePmDelivery). Every ambiguous case stays fail-closed
(`BLOCKED`/`REJECTED`), Owner confirms — same posture as the existing
`orphan-resolution` design. If the scan reveals a gap that needs
Sub-Agent/Parallel-Worker groundwork to be meaningful, that is flagged as
a separate scope question per the charter, not pulled in.

## 3. Invariants this must NOT violate (V1/V1.5/V1.6)

1. `RESULT_RECEIVED` is terminal for raw transitions — only `requestRetry`
   (`+CHANGES_REQUESTED → READY+PENDING`) or QA-remediation retry may move it.
2. `ACCEPTED`/`CHANGES_REQUESTED` change only via `acceptResult`/
   `requestChanges` (dual-CAS on `RESULT_RECEIVED+VERIFYING`, current-attempt
   Run binding, duplicate calls CONFLICT — never silent retry).
3. Dependencies are satisfied only by `pmState == ACCEPTED`; readiness
   refresh only ever promotes `PLANNED → READY` (no demotion, no chaining).
4. Retry lineage is append-only: `RTP-<judgmentId>`/`sourceRunId` fixed,
   `linkedRuns` preserved, exactly one Run per `dispatchedRunId`, no Task
   re-dispatch off a `READY` terminal-success path.
5. Terminal intact: `ACCEPTED`/`CANCELLED`/`BLOCKED`/`FAILED` (or
   source-displaced) Tasks are never reverse-transitioned; safe-fail to
   `FAILED` only.
6. QA semantics: QA only engages with a `qaContract`; `QA PASS ≠ ACCEPT`
   (never advances a Plan); budget-capped (`maxQaRemediationAttempts`,
   default 2 / max 10); `BLOCKED` verdict escalates only.
7. Delivery idempotency: one `PMD-{task}-{run}` per attempt, minted only for
   `RESULT_RECEIVED+VERIFYING` current attempt; terminal deliveries
   (`ACKNOWLEDGED`/`IGNORED`) are never reset; never mint for stale Runs.
8. New Runs only from `READY` via `dispatchTask` CAS
   (`READY → DISPATCHED → RUNNING`); blocked on orphan-suspect, live
   dispatch, or observation-lock contention.
9. Promotion single path: only `result-bridge` may promote to
   `RESULT_RECEIVED`; never re-open `ACCEPTED`, never promote stale
   attempts, never fabricate `result.md`/Delivery. Ambiguity → fail-closed.
10. Reconciles stay restart-safe, idempotent, best-effort, and never block
    bridge startup.

Corollaries for this plan: History压力 is read-only — no writes to
Task/Delivery/Preparation/Run-meta, no transitions, no mint/consume/
dispatch, no readiness side-effects. Resume actions reuse the exact
existing functions (no parallel implementations).

## 4. Rough cut — small shippable increments

1. **H1 — Task timeline read model (backend, read-only).** One function
   `getTaskHistory(dataRoot, project, taskId)` returning Task + ordered
   linked Runs (each with Delivery + Judgment status or "none") + linked
   Events + Evidence summaries. Pure read over §1 join. Tested with
   fixture trees. No IPC yet.
2. **H2 — Surface it where Tasks already render.** TUI first
   (`task-detail` view extension — the only existing Task UI). Electron
   Task panel is a separate increment, not smuggled into H1.
3. **R1 — Resume scan (read-only report).** Enumerate the five stuck
   patterns from §2(b) across a project. Output is a list with the
   blessed action named per item. No actions executed.
4. **R2 — Guided actions behind Owner confirmation.** Wire each scan item
   to its existing kernel function (`CONFIRM_*`, `recover_completed_run`,
   reconcile re-runs) through the current confirmation UX. One action
   type per increment; fail-closed on anything unrecognized.
5. **R3 — Restart integration.** Run R1 scan automatically where the
   existing `bridge start()/runOnce()` reconciles already run (same
   best-effort, never-blocking contract); surface results, execute
   nothing automatically.

Explicitly NOT in this plan: automatic re-dispatch, transparent Run
continuation, new adapters, installer/release changes, credential-model
changes, any Sub-Agent/Parallel-Worker groundwork.

## 5. Open questions for Owner/PM (Step 2 check-in)

1. Surface priority: TUI-first (recommended — Task UI lives there) or
   Electron Task panel first?
2. Is read-only History alone (H1+H2) shippable as V2-slice-1, or must the
   first slice include at least the R1 scan?
3. For R2: per-action explicit Owner confirm (recommended, matches
   orphan-resolution posture) vs. auto-apply for the provably-idempotent
   subset (delivery/QA-gate reconcile re-runs)?
4. `relay_pm_recover_completed_run` automation: promote to automatic scan
   action, or keep manual-trigger with scan only surfacing candidates?

## 6. Locked decisions (dated log — §1–5 untouched)

- 2026-09-12 (slice-1 GO): TUI first + CLI read surface; slice-1 = H1+H2
  only; R2 = explicit Owner confirm on every guided action (no auto-apply,
  not even idempotent subset); `recover_completed_run` stays manual-trigger.
- 2026-09-12 (QRP scope decision): **Option B — QRP-RECEIVED stays
  permanently report-only.** No kernel producer exists for that status
  (sole writer persists READY; see `qa-remediation-preparation.ts`), so no
  real stuck work lacks a path. The R1 finding + R2 refusal stand as the
  tripwire: if a non-forged QRP-RECEIVED record ever appears, that is the
  evidence a producer exists — revisit then with a real case. No new
  transition is invented for it.
