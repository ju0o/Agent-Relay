WBS58: DONE
TESTS: 17/0
FILES: src/orchestrator/pm-schemas.ts, src/orchestrator/pm-packets.ts, src/orchestrator/role-loop.ts, src/orchestrator/main.ts, docs/PM_ROLE_INSTRUCTIONS.md, test/v1-orchestrator.test.mjs, tsconfig.server.json (added src/orchestrator and src/roles to `include`, both were missing and nothing compiled them)
LIVE_DATAROOT_WRITES: 0

# WBS-5 + WBS-8 — PM loop orchestrator (issue #6)

`WBS58_REPORT: 2026-09-16T07:49:44Z`

## Redirect compliance
The GitHub PM bridge task (cp-impl-prompt.md) was stopped immediately on receiving
`cp-wbs58-redirect.md`. Its files (`src/github-pm/{audit,importer,packet,transport}.ts`, the
`main.ts`/`test/github-pm-bridge.test.mjs` edits) were left untouched/unstaged, never
`git add`ed; the redirect noted the PM would dispose of them, and by the time this report was
written they were already gone from `git status` (external cleanup, not done by me). `git status`
right now shows only this task's files, nothing staged.

## What this delivers
- `src/orchestrator/pm-schemas.ts`: strict JSON-only fenced-block parsers `parsePmTaskDecision` /
  `parsePmJudgment` (`PmSchemaError`, code `INVALID_STRUCTURED_OUTPUT`). JSON-only, not
  JSON-or-YAML — see Deviations.
- `src/orchestrator/pm-packets.ts`: `buildPmBootstrapPacket` (bounded text + structured
  `contextHash`), `buildPmFinalGatePacket` (wraps the existing `getVerificationContextForDelivery`
  + retry-lineage join, same recipe as `V1_PACKETS_DESIGN.md` §2), `renderQaPacket` /
  `renderQaResult` (thin projections over `QaAttemptRecord`, reusing `qa-gate.ts`'s
  `summarizeAttemptDeterministic`/`semanticReasonFromAttempt`).
- `src/orchestrator/role-loop.ts`: the state machine — `processBootstrap` (WBS-5),
  `processFinalGate` (WBS-8), `runOnce` (top-level pass: `reconcileReadyRetryDispatches` first for
  restart-safety, then all pending deliveries, then bootstrap if no open Task). All four binding
  conditions from the redirect are implemented here, not in the adapter:
  - **(a) billing guard** — `assertBillingAllowed`: free-tier model (`*-free` or `big-pickle`)
    required unless `zeroExtraBilling === false` (unreachable via a validated role-config today —
    `role-config.ts` enforces `zeroExtraBilling: true` literal — implemented anyway as defense in
    depth against a hand-constructed assignment). Failure with an EMPTY fallback chain →
    `BLOCKED_BILLING` directly; with a non-empty chain, falls through to (b).
  - **(b) fallbackChain walker** — `resolvePmAdapterForTurn`: walks `fallbackChain` entries, each
    checked against `cfg.resolveAdapter(id)` (must be registered) AND the same free-tier check
    applied to the entry id itself (a fallback entry is model-qualified, e.g.
    `opencode/big-pickle` — confirmed by the real `docs/WBS3_EVIDENCE.md` re-proof note that
    appeared mid-task: V1CERT's actual PM fallbackChain is
    `[opencode/big-pickle, opencode/nemotron-3-ultra-free]`). Exhausted chain → `OWNER_REQUIRED`,
    never a silent switch to an unverified adapter.
  - **(c) contract_hash on every judgment** — `processFinalGate` re-reads the Task fresh and
    compares `currentTask.contract?.contract_hash` to the judgment's echoed `contract_hash`;
    mismatch (including "task has none, judgment claims one" or vice versa) → `REJECTED_STALE`.
    This is checked explicitly and redundantly with the `context_hash` check (which already
    subsumes it by construction, since `contract_hash` is embedded in the hashed packet) per the
    binding condition's own wording.
  - **(d) PM send timeout** — `sendAndCollect`: `Promise.race` against a real timer (default
    120s, `pmSendTimeoutMs` configurable), independent of whether the adapter itself respects its
    own `timeoutMs` param. On timeout: `interrupt()` best-effort, one retry; a second timeout →
    `PmTimeoutError` → `BLOCKED_RUNTIME`, audit only, canonical untouched.
- `src/orchestrator/main.ts`: CLI (`--dataRoot --project --role-config --once|--poll-ms
  --audit-dir --state-file [--dispatch-hook <module>] [--pm-send-timeout-ms]`). Default dispatch
  hook = `dispatchV1OwnerApproved` via the first `role: 'implementation'` worker-registry record
  and the `builder` RoleAssignment's `workspace.workspaceRoot`. Registers one
  `OpenCodeCommandAdapter` per distinct primary+fallback model key named in the `pm`
  RoleAssignment. Not itself unit-tested (no network in tests, per the rules) — `role-loop.ts` is
  exercised directly with fakes instead.
- `docs/PM_ROLE_INSTRUCTIONS.md`: system prompt for the pm adapter session, adapted from the
  existing `docs/GPT_PM_INSTRUCTION_CONTRACT.md` evidence-trust-ladder rules for this
  orchestrator's exactly-one-fenced-JSON-block transport, both schemas, `OWNER_REQUIRED`
  conditions, echo-the-hashes-back-exactly staleness discipline.
- `test/v1-orchestrator.test.mjs`: disposable dataRoot, a `FakePmAdapter` implementing
  `RoleRuntimeAdapter` with scripted replies (plus a `hang: true` mode for the timeout drill), a
  fake dispatch hook (records calls, no real dispatcher needed since `dispatchHook` is injectable),
  and a direct-construction QA-gated-Task helper (`mintPendingDelivery`) mirroring
  `test/v1-qa-loop.test.mjs`'s proven pattern (V16-dogfood-style `qaContract`, real
  `fake-qa-worker.mjs`/`fake-builder-worker.mjs` subprocesses, `runOrResumeQaGate` mints the real
  Delivery) — using `ensureV1ContainerGoal` for the Goal (not an ad-hoc one), so ACCEPT_AND_NEXT's
  same-Goal-scope check reflects real orchestrator-created Tasks.

## Tests — `node --test test/v1-orchestrator.test.mjs`
```
1..17
# tests 17
# suites 0
# pass 17
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
Covers, one `test()` per item: bootstrap packet bounded + contextHash stable; CREATE_TASK creates
a Task with a contract and calls the dispatch hook exactly once; invalid PM output re-asked once
then BLOCKED with zero canonical mutation (and a second pass over the same unchanged packet does
not re-ask); final gate ACCEPT applies once (judgment APPLIED, Delivery ACKNOWLEDGED); a second
pass over an already-ACKNOWLEDGED delivery is REPLAY_IGNORED; CHANGES+SAME_TASK prepares a retry
for the SAME Task (no new Task record); OWNER_REQUIRED makes no canonical write; stale
context_hash → REJECTED_STALE; (c) mismatched contract_hash alone → REJECTED_STALE;
ACCEPT_AND_NEXT creates+dispatches the next Task with a contract_hash inside the same Goal scope;
ACCEPT_AND_NEXT with an out-of-scope project applies the ACCEPT half but the next-Task half is
OWNER_REQUIRED; restart between QA PASS and PM (a second `processFinalGate` call with a fresh
adapter/config, same durable dataRoot+stateFile) resumes as REPLAY_IGNORED without re-consulting
the PM or duplicating the judgment; (a) billing guard unit test + integration (BLOCKED_BILLING,
zero PM sends, zero canonical mutation); (b) fallbackChain walks past an unregistered entry to a
compliant, registered one, and a chain with only paid/unregistered entries is exhausted to
OWNER_REQUIRED (never a silent switch); (d) a hanging adapter is sent to twice (initial + one
retry) then BLOCKED_RUNTIME with canonical untouched. Zero writes under the live dataRoot
(`find ~/.local/share/AgentRelay/data ... -newer <marker>` excluding `V02CControlTower`, asserted
in the suite's `after()` hook).

Regression check: `test/v1-qa-loop.test.mjs` still passes 3/3 after the `tsconfig.server.json`
`include` change (adding `src/orchestrator/**/*.ts` and `src/roles/**/*.ts`, which were missing
and meant nothing under those directories was ever type-checked or emitted before this task).

## Dependency on Grok's task-contract.ts
Not needed as a dependency risk: `src/backend/task-contract.ts` (`buildTaskContract`,
`computeContractHash`, `validateTaskContract`, `freezeCheck`) landed as commit `b415a67` before
this task started, exactly the names cp-wbs58-redirect.md named. Imported directly from
`../backend/task-contract.js`; no `contract-shim.ts` was written or needed.

## Deviations
- **pm-schemas.ts is JSON-only inside the fence, not JSON-or-YAML.** `js-yaml` is only a
  transitive dependency here (not in `package.json`, not used anywhere in `src/`), so relying on
  it would be fragile; `docs/PM_ROLE_INSTRUCTIONS.md` tells the PM to always emit JSON, which
  sidesteps the ambiguity entirely.
- **Owner locks / `ownerGateConditions`**: `docs/WBS4_8_SPEC.md` says the bootstrap packet's Owner
  locks come "from role config `ownerGateConditions`", but the committed `role-config.ts`'s
  `RoleAssignment` has no such field. `buildPmBootstrapPacket` falls back to the most recent
  accepted Task's own `contract.owner_gate_conditions` when one exists, else the
  `V1_01_TASK_CONTRACT_SPEC.md` default list.
- **CREATE_TASK / ACCEPT_AND_NEXT `title`**: `TASK_CONTRACT v1` has no `title` field, but
  `createTask` requires one. `deriveTitle` derives it from `task_contract.goal` (truncated to 80
  chars) rather than adding an undocumented required field to the PM's schema.
- **CHANGES + SAME_TASK dispatch adoption**: `reconcileReadyRetryDispatches` adopts a retry Run
  only via the ORIGINAL owner-approved dispatch's retry-authorization binding. A disposable Task
  minted directly for a test (never went through `v1-dispatch.ts`) has no such binding, so the
  retry preparation correctly reaches `READY` without an adopted Run in that specific test
  fixture; a real orchestrator-dispatched Task (via `dispatchHook` → `dispatchV1OwnerApproved`)
  would have the binding and the retry would auto-dispatch, exactly as WBS4_8_SPEC.md and
  `retry-dispatch.ts:401` describe. Noted so this isn't mistaken for a gap in `role-loop.ts`
  itself — it's a property of the test fixture's minting path, not the orchestrator's logic.
- **`main.ts`'s `OpenCodeCommandAdapter` → `RoleRuntimeAdapter` cast**: WBS-3's
  `OpenCodeCommandAdapter.authMode()` is `Promise`-returning; the committed WBS-2
  `role-runtime.ts` interface declares `authMode()` synchronous. Pre-existing drift between two
  already-landed lanes, out of scope for this task and not fixed in either file (per the redirect:
  "implement inside the orchestrator, not by editing the adapter"). Worked around with a narrow,
  commented cast in `main.ts` only; `role-loop.ts` itself never calls `authMode()`.
- **ACCEPT_AND_NEXT "ACCEPT still applies even if the next-Task half is rejected"**: interpreted
  WBS4_8_SPEC.md's "may dispatch the next Task automatically only when inside already-authorized
  scope" as gating only the dispatch-the-next-Task half, not the ACCEPT of the just-reviewed
  work — an out-of-scope `next_task_contract.project` degrades that half to `OWNER_REQUIRED`
  (audit, no Task created) while the ACCEPT itself still applies. Tested explicitly.

## CHANGES round 1

Implemented the review P1/P2 findings and WBS-9 D2/D3/D6/D8 fixes.

- `src/orchestrator/role-loop.ts`: timeout recovery interrupts then performs one bounded collect-only retry; no same-cycle resend; all session/send runtime failures become durable `BLOCKED_RUNTIME` audit entries, including `retryAfter`; timeout timers are cleared; primary adapters must resolve through the configured registry and `zeroExtraBilling` must be exactly `true`; existing READY Tasks with no linked Run are dispatched by `runOnce`; existing `next_task_contract.task_id` is rejected as `CONTRACT_FROZEN` before judgment mutation.
- `src/orchestrator/main.ts`: exported pure `selectBuilderWorker()` matches `actl-managed:<workerId>` to exactly one implementation worker and fails closed for missing/ambiguous records.
- `test/v1-orchestrator.test.mjs`: added late-response, registry/billing, and worker-selector tests; timeout expectation now proves one send; Builder subprocess receives explicit temporary output/counter paths.
- `test/v1-orchestrator-drills.test.mjs`: drills 2/3/6/8 now assert fixed behavior.

Fallback entries remain documented as model-qualified `<provider>/<model>` keys (for example `opencode/big-pickle`); symbolic names such as `free-B` are intentionally not certified.

## CHANGES round 2

WBS-10 pass 3 fixes:

- `src/orchestrator/pm-packets.ts`: `renderOutputContract()` is the single code-generated contract source. Bootstrap and final-gate envelopes end with their schema-specific no-tools instructions and a strict-parser-compatible minimal example.
- `src/orchestrator/role-loop.ts`: a newly created PM session receives `docs/PM_ROLE_INSTRUCTIONS.md` as one preamble before the packet; `preambleSent` is durable and prevents repeat delivery. Tool-call replies receive the explicit no-tools re-ask. Timeout recovery aborts best-effort, rotates the role-session record, and leaves the pending re-ask eligible for the next fresh session.
- `src/integrations/opencode/command-adapter.ts`: added `abortSession()` using the OpenCode abort endpoint; session writes preserve `preambleSent`.
- `src/integrations/core/role-runtime.ts`: added the PM preamble envelope kind, optional abort operation, and preamble bookkeeping field.
- `test/v1-orchestrator.test.mjs`: verifies packet contracts/examples, tool-call re-ask, preamble-once behavior, and session rotation; `test/opencode-command-adapter.test.mjs` verifies the abort POST and all-false tool map.

Targeted verification: `node --test test/v1-orchestrator.test.mjs test/opencode-command-adapter.test.mjs` — 33 passed, 0 failed; `node --test test/v1-orchestrator-drills.test.mjs` — 8 passed, 0 failed. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 3

WBS-10 pass 5 fixes:

- `src/orchestrator/pm-packets.ts`: the PM task contract section now renders every persisted `TASK_CONTRACT v1` field, the real acceptance-criterion shape, all `CHECK_KINDS` deterministic check shapes, and a complete example generated through `buildTaskContract`.
- `src/orchestrator/role-loop.ts`: CREATE_TASK contract/QA validation runs inside the existing single re-ask budget, so the exact validator error is returned to the PM. `qaWorkerId` is injected from the configured `qa-worker:<workerId>` assignment; a conflicting PM value is overridden and audited as `QA_WORKER_OVERRIDDEN`.
- `src/orchestrator/main.ts`: `--retry-blocked` clears only the durable `blocked` map before the operator-triggered run; pending re-ask records remain intact.
- `src/backend/qa-contract.ts`: exported the existing check-kind set for contract rendering; validation semantics are unchanged.
- `test/v1-orchestrator.test.mjs`: verifies the generated example with both task and QA validators, worker injection/override auditing, validation-error re-ask, and blocked-state reset.

Verification: `npx tsc -p tsconfig.server.json` passed; orchestrator tests — 26 passed, 0 failed.
