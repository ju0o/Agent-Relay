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

`isFreeTierModel()` (`src/orchestrator/role-loop.ts`) is a deliberately narrow ALLOWLIST heuristic — it recognizes only a `*-free` suffix or the literal `big-pickle` model id, not a registry capability or provider-cost lookup — documented inline as a `ponytail:` comment at its definition; the runtime registry does not yet expose a cost/policy fact this guard could consult instead.

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

## CHANGES round 4

WBS-10 pass 6 fixes:

- `src/orchestrator/role-loop.ts`: contract/QA validation failures are marked separately from structured-output failures. They receive up to `maxValidationReasks` (default 3) with the exact validator message and the complete-correction instruction; schema/header failures retain the single re-ask. Each validation round is audited as `VALIDATION_REASK n/3`, and exhaustion blocks without canonical Task creation.
- `src/orchestrator/pm-packets.ts`: the PM contract now states verbatim that `cwd` is omitted or workspace-relative, every DETERMINISTIC/BOTH criterion must have a matching `criterionId` check, and command/args are separated.
- `src/orchestrator/main.ts`: added `--max-validation-reasks` and passes the bounded value into the role loop.
- `test/v1-orchestrator.test.mjs`: added convergence, exhaustion/no-write, and exact validator-message assertions; existing malformed-header coverage confirms the one-reask rule.

Verification: `npx tsc -p tsconfig.server.json` passed; focused adapter/orchestrator/drill suites — 44 passed, 0 failed. Full V1 + adapter run — 72 tests, 70 passed, 2 pre-existing G4A/G4C failures. `LIVE_DATAROOT_WRITES: 0` for the focused disposable suites.

## CHANGES round 5

WBS-10 pass 7 dispatch fix:

- `src/orchestrator/main.ts`: `selectBuilderWorker()` now reads raw `_relay/workers/<workerId>.json` records instead of the strict public registry loader, preserving actl-managed `driverOptions.actl.runtimeId`. It requires an exact worker-id match, explicit `role: implementation`, and either an actl runtime id or launch command; missing, unparsable, role-mismatched, and duplicate records fail closed.
- `test/v1-orchestrator.test.mjs`: selector coverage uses a raw actl fixture plus untagged Claude and QA records, and asserts missing, role-mismatch, and ambiguous failures.

Known P2 follow-up: `worker-registry.ts` still rejects trusted actl `driverOptions.actl` records while the dispatcher consumes those raw fields. This lane intentionally does not widen that validator; the strict-loader/raw-record drift remains owner work for the worker-registry lane.

## CHANGES round 6

WBS-10 pass 9 actl permit fix:

- `src/orchestrator/main.ts`: the default owner-approved dispatch path installs a global actl input-permit factory from the selected Builder record. It performs a fresh actl `status` check for `runtimeId`, expected agent/profile/workspace context, pane identity, `inputState: READY`, socket scope, and `currentSnapshotHash`, then builds the permit from the fresh snapshot. The same check runs before `dispatchV1OwnerApproved`, so a busy pane leaves no Run behind.
- `test/v1-orchestrator-actl-dispatch.test.mjs`: disposable fake-actl tests prove one successful dispatch and pre-materialization refusal for a busy pane.
- `test/fixtures/actl/fake-actl.mjs`: additive `status-busy` mode supports the refusal drill.

The factory is deliberately installed at the orchestrator owner boundary; it never fabricates or bypasses the idle/identity/socket checks.

## CHANGES round 7

WBS-10 pass 10 failed-dispatch recovery:

- `src/backend/pm-delivery.ts`: added the locked, idempotent `ensurePmDeliveryForFailedRun` canonical mint for the current FAILED Run when neither Result artifact exists.
- `src/orchestrator/role-loop.ts`: scans the latest linked failed Run before PM work; failed-run final gates honor `max_pm_changes` and return `OWNER_REQUIRED` when exhausted.
- `src/orchestrator/pm-packets.ts`: failed no-Result packets include the bounded dispatch failure reason, attempt number, and `QA: not run`, with CHANGES/OWNER_REQUIRED actions only.
- `src/backend/pm-judgment.ts`, `src/backend/retry-preparation.ts`, `src/backend/task-actions.ts`, `src/backend/goal-task-runtime.ts`: the existing judgment/preparation route now has a narrow canonical FAILED+PENDING → READY same-Task recovery action; it preserves the failed Run and increments retryCount without creating a Task.
- `test/v1-orchestrator.test.mjs`: disposable tests assert delivery mint/idempotency, truthful no-Result packet, same-Task preparation, and exhausted PM-change budget with no judgment write.

Verification: `npx tsc -p tsconfig.server.json` passed; `node --test test/v1-orchestrator.test.mjs` — 30 passed, 0 failed.

## CHANGES round 8

WBS-10 passes 11–12:

- `test/v1-orchestrator.test.mjs`: failed-run Delivery packets are rebuilt twice before and after the PM turn; unchanged canonical state keeps an identical `contextHash`, while a newly linked Run changes it.
- `src/orchestrator/pm-packets.ts`: failed-run packet hashing is limited to the canonical verification context/retry lineage and bounded failure text from canonical Run Events; audit/state files and wall-clock values are not inputs. Live read-only check of `V1CERT` Delivery `PMD-TASK-0001-3989ec39-80c5-4009-9403-d015ba0a0339` produced the same hash twice (`6080cf2513f2709c943e50061c5fa3b1265acc05fe44c86ab4a614094c1a2bbd`).
- G4A bisect: `node --test test/v1-g4a-pm-delivery.test.mjs` fails identically at `9af10aa`, `61df4c7`, and `6d411d4`; the failing `IGNORED`/`PENDING` transition is therefore pre-existing and not introduced by this pass. The first relevant finalized-delivery reconciliation commit is `be7c41c`; its intended stale-delivery reconciliation remains unchanged. No safe production correction was identified without changing the certification fixture's historical sequence, so this remains a routed blocker.

Verification: `npx tsc -p tsconfig.server.json` passed; focused orchestrator — 30 passed, 0 failed. Full V1 — 66 tests, 65 passed, 1 pre-existing G4A failure. B15 + OpenCode adapter — 12 passed, 0 failed. Roles — 8 passed, 0 failed. Live dataRoot writes: 0.

## CHANGES round 9

WBS-10 passes 11–12 hash-echo and tool-list fixes:

- `src/orchestrator/pm-packets.ts`: final-gate packets now include a separate `HASHES TO ECHO EXACTLY` block with distinct `contract_hash` and `context_hash` values. The generated PM judgment contract uses distinct hash placeholders. Failed-run packets state the bounded `CHANGES`/`SAME_TASK` retry guidance, remaining budget, and `QA: not run`.
- `src/orchestrator/role-loop.ts`: after the fail-closed re-read, an incorrect echoed hash is classified as `HASH_ECHO_REASK` when the rebuilt packet still equals the sent packet; a real canonical change remains `REJECTED_STALE` with `canonical state moved`. The correction is sent once and then uses the existing judgment application APIs.
- `src/integrations/opencode/command-adapter.ts`: disabled PM tools now include the offline-installed OpenCode ids `apply_patch` and `execute` in addition to the existing map.
- Tests cover stable failed-run hashes, hash-block/placeholder rendering, context-hash echo re-ask, contract-hash echo re-ask, real canonical-move stale rejection, retry guidance, and `apply_patch: false`.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator.test.mjs test/opencode-command-adapter.test.mjs` — 42 passed, 0 failed; `npm run test:roles` — 8 passed, 0 failed. The requested combined V1 + B15 + adapter command reported 81 top-level tests, 78 passed, 3 failed: the pre-existing G4A failure and the pre-existing G4C host-wake subtest (2 internal assertions). The new/affected tests are green. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 10 (TASK-0063 retry-loop)

- `src/orchestrator/role-loop.ts`: `ensurePmDeliveryForFailedRun` is now gated by a terminal `RUN_FAILED`/`RUNTIME_ERROR` event and an inactive/released runtime binding. `RESERVED`, `SENT`, and active collect bindings are treated as in-flight and cannot create another Delivery or PM turn.
- `src/orchestrator/main.ts`: the default dispatch hook installs its actl permit factory at construction time, before `runOnce` performs retry reconciliation; retry dispatch therefore gets the same status, identity, READY, and snapshot checks as initial dispatch.
- `src/backend/retry-dispatch.ts`: raw actl worker records are accepted for retry validation when the legacy strict validator rejects `driverOptions.actl`, with exact worker id, explicit implementation role, runtime id, and launch command checks.
- `test/v1-orchestrator.test.mjs`: adds the in-flight RESERVED retry guard test.
- `test/v1-orchestrator-actl-dispatch.test.mjs`: fake-actl test covers initial clean send failure, CHANGES preparation, same-Task retry creation, and exactly one retry send.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator.test.mjs test/v1-orchestrator-actl-dispatch.test.mjs` — 36 passed, 0 failed; `npm run test:roles` — 8 passed, 0 failed. Requested combined V1 + B15 + adapter run — 82 top-level tests, 80 passed, 2 failed: pre-existing G4A and G4C failures. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 11 (TASK-0064 retry restart recovery)

- `src/backend/retry-dispatch.ts`: a correlated retry Run with a durable `RESERVED` binding is now resumed through the existing actl send contract, using the binding's frozen pane/lease/fence and the installed owner permit factory; after send it is marked `SENT` and the preparation is consumed without creating another Run or Delivery.
- `src/orchestrator/main.ts`: default dispatch construction installs the permit factory before retry reconciliation, so restart adoption has the same fail-closed identity and idle checks.
- `src/orchestrator/role-loop.ts`: retry reconciliation outcomes are audited as `RETRY_ADOPTED`, `RETRY_REDISPATCHED`, or `BLOCKED_RUNTIME`; an in-flight RESERVED retry remains excluded from failed-run Delivery minting.
- Tests cover same-Task retry send and the RESERVED in-flight no-duplicate guard. Expired-lease re-dispatch and superseded-run closeout remain blocked on a reusable canonical dispatcher resume/closeout API; no direct binding edits were introduced.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; orchestrator + actl tests — 36 passed, 0 failed; `npm run test:roles` — 8 passed, 0 failed. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 12 (TASK-0065 cycle closure)

- `src/orchestrator/role-loop.ts`: every `runOnce` now appends one `step: cycle` audit summary with `IDLE`/`ACTED`, open Task ids, pending Delivery count, blocked keys, and reason. Terminal `FAILED`/`CANCELLED` Tasks are excluded from the open-task predicate; pending Deliveries and active terminal bindings still block bootstrap. Exhausted terminal Tasks are durably marked and audited once as `TASK_EXHAUSTED`.
- `src/orchestrator/pm-packets.ts`: bootstrap packets now include `## Closed without acceptance (terminal)` with bounded Task id/title/failure reason, attempt count, and judgment count. These closed-task facts are part of the bootstrap context hash.
- `test/v1-orchestrator.test.mjs`: adds idle-cycle audit and exhausted-terminal Task → bootstrap → replacement Task/dispatch coverage; existing pending failed-Run Delivery coverage confirms final gate remains authoritative.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator.test.mjs` — 35 passed, 0 failed; `npm run test:roles` — 8 passed, 0 failed. Requested combined V1 + B15 + adapter run — 84 top-level tests, 82 passed, 2 failed: pre-existing G4A and G4C failures. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 13 (TASK-0066 actl idle semantics)

- `src/orchestrator/main.ts`: `INPUT_STATE_UNKNOWN` no longer automatically denies an actl dispatch. The permit factory accepts only a Codex snapshot whose last 12 lines contain `› Ask Codex to do anything`, or a Claude snapshot with an idle `❯` prompt, and rejects busy markers (`Working (`, `esc to interrupt`, `Press enter to continue`, `Do you trust`). `READY` remains accepted. Snapshot text is taken from actl status when present; otherwise the exact actl identity `paneId` is used for read-only `tmux capture-pane` on the configured socket. Runtime/context/pane/snapshot-hash checks remain unchanged.
- `test/fixtures/actl/fake-actl.mjs`: added additive UNKNOWN idle, UNKNOWN busy, and UNKNOWN missing-snapshot modes.
- `test/v1-orchestrator-actl-dispatch.test.mjs`: covers UNKNOWN+idle dispatch, UNKNOWN+busy refusal, UNKNOWN+missing snapshot refusal, and existing READY dispatch.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator-actl-dispatch.test.mjs` — 6 passed, 0 failed; requested full V1 + B15 + adapter command — 87 top-level tests, 85 passed, 2 failed (pre-existing G4A/G4C). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 14 (TASK-0067 trailing snapshot rows)

- `src/orchestrator/main.ts`: `idlePromptMatches` now removes CR characters and trailing whitespace-only capture rows before selecting the last 12 lines. Busy-marker rejection and agent-specific idle-prompt matching both use that normalized window.
- `test/fixtures/actl/fake-actl.mjs`: UNKNOWN idle and busy fixtures now append 40 blank rows, matching the real tmux capture shape.
- `test/v1-orchestrator-actl-dispatch.test.mjs`: the UNKNOWN idle-prompt and busy-marker tests exercise the trailing-row case; idle dispatch succeeds and busy dispatch remains refused.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator-actl-dispatch.test.mjs test/v1-orchestrator.test.mjs` — 41 passed, 0 failed. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 15 (TASK-0068 QA remediation resume)

- `src/backend/qa-gate.ts`: added an optional remediation-dispatch seam. Existing callers retain the canonical `dispatchTask` fallback; the orchestrator can supply its permit-checked dispatcher while the QA gate keeps preparation correlation, budget, and idempotency authoritative.
- `src/orchestrator/role-loop.ts`: before bootstrap, `runOnce` scans READY undispatched QRP records and resumes each through `reconcileQaGate`, auditing `QA_REMEDIATION_DISPATCHED`/`QA_REMEDIATION_ADOPTED` or `BLOCKED_RUNTIME`.
- `src/orchestrator/main.ts`: the default CLI supplies a QA remediation hook using the same actl permit checks and canonical dispatcher as Builder dispatch, with the QRP/source-run correlation preserved.
- `test/v1-qa-loop.test.mjs`: proves a READY QRP left by a simulated dispatch refusal is resumed once by `runOnce`, creates the same-Task remediation Run, and is not dispatched again on the next cycle. Existing tests cover FAIL→same-Task remediation→PASS→one Delivery and crash/budget escalation behavior.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-qa-loop.test.mjs` — 4 passed, 0 failed; focused QA + orchestrator + actl command — 45 passed, 0 failed. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 16 (TASK-0069 source-seat closeout)

- `src/backend/qa-gate.ts`: before a same-Task QA remediation dispatch, a source Run with `collectStatus: FINAL_BOUND` and an unreleased closeout is released through `closeActlManagedReservation`; the durable binding is written only after the canonical actl closeout succeeds. Already `RELEASED` is a no-op, and closeout failure blocks before creating the remediation Run.
- `src/orchestrator/role-loop.ts`: records `SEAT_RELEASED` with the source `runId` and `reservationId`; closeout failures remain `BLOCKED_RUNTIME`.
- `src/orchestrator/main.ts`: the default QA remediation hook continues to use the same permit-checked canonical dispatcher after source-seat release.
- `test/v1-qa-loop.test.mjs`: retains the disposable FAIL→QRP→same-Task resume proof; the canonical closeout seam is covered by the existing actl/dispatcher closeout certification fixtures.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; focused QA + orchestrator + actl tests — 45 passed, 0 failed; requested V1 + B15 + V16 QA + adapter run — 97 total, 94 passed, 3 pre-existing failures (G4A and two G4C host-wake assertions). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 17 (TASK-0070 delivery-test semantics)

- Bisect in temporary worktrees: parent of `be7c41c` (`8f6fe91`) passed G4A; `be7c41c` was the first bad commit. Its finalized-delivery reconciliation intentionally changes a superseded current-attempt delivery from `PENDING` to `IGNORED` during pending-list reads, so the old test's `D1 expectedStatus: PENDING` assertion encoded superseded semantics.
- `test/v1-g4a-pm-delivery.test.mjs`: now asserts superseded `D1` is `IGNORED`, while exercising PENDING and DELIVERED ignore transitions with fresh current deliveries. No production change was needed.
- G4C was independently green at both `be7c41c` and `8f6fe91`; no commit-level first-bad was reproducible. The prior red result came from concurrent full-suite interference. The full suite was rerun serially to make the shared test-process boundary deterministic.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; serialized V1 + V16 QA + B15 + adapter run — **97 passed, 0 failed**. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 18 (TASK-0071 post-chain P2 bundle)

- `src/orchestrator/role-loop.ts`: PROJECT_COMPLETE is cached by bootstrap `contextHash`, audited as `PROJECT_COMPLETE_CACHED`, and invalidated when canonical context changes. Consumed retry preparations with a linked RESERVED Run whose reservation was released now produce an explicit `retry reservation expired before send` reconciliation outcome, which is audited as `BLOCKED_RUNTIME` each cycle.
- `src/backend/qa-deterministic-evaluator.ts`: diffScope now invokes `git status --porcelain=v1 --no-renames -uall`, so untracked directories are evaluated as individual files.
- `src/backend/retry-dispatch.ts`: expired/released consumed retry reservations are no longer silently skipped; the canonical retry remains untouched and the loop records the bounded runtime block.
- Tests: orchestrator completion-cache invalidation and audit coverage; deterministic QA tests for one allowed untracked file versus an extra out-of-scope file in the same directory; G5-C test for a consumed expired retry audit with no extra Run.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; focused orchestrator + diffScope tests — **36 passed, 0 failed**; G5-C retry tests — **116 passed, 0 failed**; serialized V1 + V16 QA + B15 + adapter run — **97 passed, 0 failed**. `LIVE_DATAROOT_WRITES: 0`.
