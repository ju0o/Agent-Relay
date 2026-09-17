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

## CHANGES round 20 (TASK-0073 asynchronous WAIT to COLLECT)

- `src/orchestrator/role-loop.ts`: added a pre-gate resume-collect pass for the latest `DISPATCHED`/`RUNNING` Run with a non-terminal binding. It skips `RESERVED` bindings owned by retry reconciliation, audits `COLLECTED` or `WAITING`, and leaves already `FINAL_BOUND` Runs untouched.
- `src/orchestrator/main.ts`: wires the pass to the existing `dispatcher.resumeActlManagedCollect` API, which performs actl final collection and routes admission through CaptureManager → Result Bridge → QA gate.
- `test/v1-orchestrator.test.mjs`: verifies a finished asynchronous Run is collected once and a busy worker produces a durable `WAITING` audit.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; orchestrator + actl + QA-loop + adapter tests — **59 passed, 0 failed**. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 21 (TASK-0074 ACCEPT_AND_NEXT contract normalization)

- `src/orchestrator/role-loop.ts`: `ACCEPT_AND_NEXT` now applies the same QA-worker normalization as `CREATE_TASK`, injecting the configured `qa-worker:<workerId>` and auditing overrides. Contract/QA validation errors receive bounded correction rounds using the existing `maxValidationReasks` budget; the ACCEPT judgment is submitted once before the next-task correction loop.
- `test/v1-orchestrator.test.mjs`: added semantic-true injection coverage and invalid-then-corrected next-task coverage, asserting one created/dispatched Task and one canonical ACCEPT judgment.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; orchestrator + actl + QA-loop + adapter tests — **61 passed, 0 failed**; B15 suites — **31 passed, 0 failed**. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 19 (TASK-0072 PM instructions path)

- `src/orchestrator/role-loop.ts`: PM instructions resolve from the compiled module directory (`dist/server/orchestrator/../../../docs/PM_ROLE_INSTRUCTIONS.md`), with a source-tree fallback and an explicit `RoleLoopConfig.pmInstructionsPath` override. The file is read before adapter/session creation; missing or unreadable instructions produce `BLOCKED_RUNTIME: pm instructions missing` without a PM send.
- `src/orchestrator/main.ts`: the CLI accepts `--pm-instructions <path>` and passes the override to the role loop.
- CWD audit: `rg -n "process\\.cwd\\(\\)" src/orchestrator src/integrations/opencode` returned no matches.
- `test/v1-orchestrator.test.mjs`: verifies module-relative lookup from another cwd and fail-closed behavior for a missing instructions file.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; `node --test test/v1-orchestrator.test.mjs test/opencode-command-adapter.test.mjs` — **47 passed, 0 failed**. `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 22 (TASK-0076 semantic QA BLOCKED)

- Root cause found read-only in V1CERT: both `blocked-reason.txt` files contain `"status:" 라인을 찾을 수 없습니다.` after the `claude-code` semantic invocation, so the strict semantic-output parser treated the transient response as BLOCKED; the old path escalated immediately and persisted no reason.
- `src/backend/qa-attempt.ts`: records a bounded `semanticBlockedAttempts` count and non-empty `reason`; the additive retry transition reopens only operational semantic BLOCKED records as PENDING. After three cycles, it finalizes BLOCKED with the reason.
- `src/backend/qa-gate.ts`: semantic BLOCKED is retried on later reconciliations and only escalates after the bounded budget; deterministic BLOCKED behavior is unchanged.
- `src/backend/pm-verification-context.ts` and `src/orchestrator/pm-packets.ts`: the PM packet includes the exact QA status/reason and excludes ACCEPT/ACCEPT_AND_NEXT unless the delivered attempt is PASS.
- `src/orchestrator/role-loop.ts`: later cycles resume pending QA semantic evaluation before the PM gate; an ACCEPT against BLOCKED/FAIL QA is rejected and re-asked once without canonical judgment mutation.
- `test/v1-qa-loop.test.mjs`: covers bounded crash escalation with persisted reason and BLOCKED→next-cycle PASS; the existing V16 gate expectations were updated to the new retry-before-Delivery contract.

Verification: `npx tsc -p tsconfig.server.json --pretty false` passed; focused QA suites (`v1-qa-loop` 6, V16 slice 4 1, V16 slice 7 1) — **8 node tests, 8 passed, 0 failed**; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 23 (ar/v1-pm)

- `src/orchestrator/role-loop.ts`: final-gate `OWNER_REQUIRED` outcomes are cached by `deliveryId` and packet `contextHash`; unchanged pending Deliveries audit `FINAL_GATE_DECISION_CACHED` without another PM turn. Canonical context changes invalidate the cache, and `--retry-blocked` clears it.
- `src/backend/qa-semantic-evaluator.ts`: unparseable semantic QA now records a bounded, secrets-scrubbed worker stdout/stderr tail in the semantic BLOCKED reason and persists each raw combined output as `semantic-output-attempt-N.txt` in the QA attempt folder.
- Tests cover unchanged OWNER_REQUIRED no-reask, cache audit, scrubbed QA reason tail, and raw attempt-folder persistence.

Verification: server build passed; focused orchestrator + QA checks — **48 passed, 0 failed**; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 24 (ar/v1-pm)

- `src/backend/worker-registry.ts`: Claude QA workers may now declare an absolute, existing `driverOptions.claude.configDir`; existing permission-mode validation remains strict.
- `src/backend/qa-semantic-evaluator.ts`: semantic QA passes trusted Claude `configDir` and optional `permissionMode` before `--print`, and records `profileSource` (`run-bound`, `inherited`, or `cwd`) on the QA attempt.
- `scripts/relay-worker-claude.mjs`: QA passthrough consumes and applies `--claudeConfigDir` and `--permissionMode`, while unknown flags remain fatal.
- Tests cover registry-to-worker argv/profile recording and wrapper passthrough option handling.

Verification: server build/typecheck passed; requested serial QA, adapter, and orchestrator suites passed; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 25 (ar/v1-pm)

- `src/backend/qa-semantic-evaluator.ts`: semantic prompts now include the absolute workspace root and require an initial observed `cwd:` line. A semantic FAIL claiming a covered path is missing while deterministic `fileExists`/`diffScope` checks passed is converted to `QA_INCONSISTENT`/BLOCKED, preserving the bounded retry path. QA stderr and `run-meta.json` (spawn cwd plus env-key names only) are persisted per semantic run.
- `src/backend/qa-gate.ts`: `QA_INCONSISTENT {attempt, path}` is recorded as a runtime audit event before the normal semantic BLOCKED retry/escalation handling.
- `src/backend/qa-attempt.ts`: additive `workerObservedCwd` field validates and persists the worker's absolute cwd echo.
- Tests cover the absolute-root/cwd prompt contract, inconsistency classification, stderr/run metadata persistence, and unchanged normal FAIL behavior.

Verification: server build passed; requested QA + orchestrator checks passed; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 26 (ar/v1-pm)

- QA passthrough now retains only the explicitly configured Claude `configDir`; `--permissionMode` is forbidden on the QA path and cannot grant Builder permissions to a QA worker. The stale passthrough comment now matches this least-privilege behavior.
- `workerOutputTail` now bounds output to 400 characters after scrubbing provider keys, bearer/key-value secrets, JWTs, token prefixes, and long base64/hex-looking runs.
- Semantic inconsistency detection requires an anchored non-existence claim and an exact match to a deterministic `fileExists` or `diffScope` path, preventing unrelated-file false positives.
- Documented the unconditional per-attempt `attempt-N-stderr.txt` persistence alongside `run-meta.json`; raw diagnostic output remains outside logs.

Verification: server build/typecheck and the requested semantic QA, wrapper, QA-loop, orchestrator, and adapter suites passed serially; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 27 (ar/v1-pm)

- `scripts/relay-worker-claude.mjs`: QA and relay Claude children retain PWD/OLDPWD normalisation as harmless hygiene; both paths pass `--add-dir <workspaceRoot>` before `--print`.
- `src/backend/qa-deterministic-evaluator.ts`: shared `runProcess` retains child PWD normalisation for consistency. Exact replays with mismatched PWD passed, so PWD was disproven as the root cause.
- `src/backend/qa-semantic-evaluator.ts`: semantic run metadata records the `--add-dir <cwd> --print <prompt>` argv shape; diagnostic tails strip ANSI escapes before scrubbing and bounding.
- Tests cover wrapper argv/env propagation, shared `runProcess` PWD, metadata, and ANSI-free scrubbed reasons.

Verification: server build/typecheck and the requested wrapper, semantic QA, deterministic QA, QA-loop, and orchestrator suites passed serially; `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 28 (ar/v1-pm)

- `src/backend/qa-semantic-evaluator.ts`: semantic prompts forbid shell globs/wildcard paths and require runtime-denial reporting; denial-shaped worker output is forced to bounded `BLOCKED`, never accepted as a semantic verdict.
- Verified mechanism: wildcard Bash calls are auto-rejected as `external_directory` in `--print` (round 28). Whether `--add-dir` alone prevents that rejection remains UNVERIFIED pending a live QA run.
- Tests cover the no-wildcard prompt contract and a parseable `PASS` accompanied by `external_directory`/permission denial.
## CHANGES round 29 (ar/v1-pm)

- `src/backend/qa-semantic-evaluator.ts`: added a quota runtime guard (`hasQuotaDenial`) that matches explicit Claude Code session/usage-limit signals (`hit your session limit`, `usage limit reached`, `rate limit`) on combined stdout+stderr and forces bounded `BLOCKED` with reason `QA_RUNTIME_QUOTA:` — infrastructure evidence, never accepted as a semantic verdict (shipped in dab7d84).
- Tests cover a fake worker that emits a session-limit banner: `finalQaStatus` is `BLOCKED` with the `QA_RUNTIME_QUOTA:` reason.

Verification: server build/typecheck and the requested wrapper, semantic QA, deterministic QA, QA-loop, and orchestrator suites passed serially (commit dab7d84); `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 30 (ar/v1-pm)

- `src/backend/qa-semantic-evaluator.ts`: narrowed runtime-denial detection. The Claude Code permission-challenge signature (`permission requested: … auto-rejecting`, including bare `auto-rejecting`) still matches anywhere (stdout or stderr); the broad denial phrases (`permission denied`, `access denied`, `operation not permitted`, `external[_ -]?directory`, `approval required`, …) now only match on stderr, or on a stdout that produced no parseable `status:` verdict at all. A semantic `status: FAIL` whose stdout reason mentions a real permissions bug in the implementation remains `FAIL` instead of being swallowed into `BLOCKED`.
- Tests add a fake-worker `status: FAIL` + `failedCriteria` + reason containing `permission denied` with empty stderr → `FAIL` (never BLOCKED); a fake-worker `status: FAIL … does not exist` with stderr `! permission requested: external_directory (/x/docs/*); auto-rejecting` → `BLOCKED` with `QA_RUNTIME_DENIED` (BLOCKED_RUNTIME); and keep the existing PASS-under-denial case (denial on stderr + parseable `PASS` → BLOCKED).
- `--add-dir` efficacy against `external_directory` auto-rejects remains **UNVERIFIED** until a live QA run — this round only proves the verdict/guard classification; it does not exercise a real Claude Code runtime.

## CHANGES round 32 (ar/v1-pm)

- **LIVE DEFECT (Phase B run 3, project V1CERT):** TASK-0009's Builder left its accepted deliverable uncommitted in the workspace (`docs/OPERATIONS.md`, `scripts/summary.mjs`). The next Task (TASK-0010, allowed path `docs/RELEASE_NOTES.md` only) then failed deterministic QA three times with `diffScope FAIL 허용되지 않은 경로가 변경되었습니다: docs/OPERATIONS.md, scripts/summary.mjs` and escalated to OWNER_REQUIRED although its own Builder touched nothing outside scope. In a Founder-absent loop nobody commits between Tasks, so every Task after the first would fail. Root cause: diffScope compared the whole `git status --porcelain=v1 --no-renames -uall` against the allowed paths with **no baseline**.
- `src/backend/dispatcher.ts`: when a Builder run is dispatched (generic `dispatchTask` and actl-managed paths), the workspace's dirty porcelain paths are snapshotted at dispatch time — written as `workspace-baseline.json` (sorted, normalized, unique path array) in the Run folder, right where `writeRunMeta` writes the per-run meta. Git is invoked via `spawn` with `shell:false` (30s bound); if the workspace cannot be authoritatively inspected (not a git repo, git missing, timeout, non-zero exit) no baseline file is written.
- `src/backend/qa-deterministic-evaluator.ts`: the diffScope check loads the Run folder's `workspace-baseline.json` (the run folder is already resolved by `resolveAuthoritativeRunBinding` and threaded into `runOneCheck`). Paths dirty NOW that are in the baseline are subtracted — only paths dirty now and NOT in the baseline count as changed by THIS run — and reported in the check detail as `pre-existing (excluded): …` plus `baselineApplied`/`preExistingCount`/`preExistingSample` evidence. No baseline file (older runs / lost capture) → legacy whole-workspace behavior unchanged. A present but malformed baseline fails closed (BLOCKED).
- Tests: `test/v16-slice2-deterministic-qa.test.mjs` 14b (baseline contains `docs/OPERATIONS.md` dirty; run changes only allowed `docs/RELEASE_NOTES.md` → PASS with the pre-existing note), 14c (same baseline + new out-of-scope `scripts/x.mjs` → FAIL naming only `scripts/x.mjs`, outOfScopeSample exactly `['scripts/x.mjs']`), 14d (no baseline file → legacy FAIL on any out-of-scope dirty path, no pre-existing note/evidence keys). `test/phase-g-dispatcher.test.mjs` G-14a: a generic (non-actl) worker dispatch against a git workspace with a pre-existing dirty path writes a sorted `workspace-baseline.json` containing exactly that path.
- Verification: `npm run build:server` passed; `node --test test/v16-slice2-deterministic-qa.test.mjs` → **81 passed, 0 failed**; `test/phase-g-dispatcher.test.mjs` → **64 passed, 0 failed**; `test/v1-qa-loop.test.mjs` → **6 passed, 0 failed**; `test/v1-orchestrator.test.mjs` (run last) → **41 passed, 0 failed** (one non-reproducible flake observed once among later 41/41 green runs; the orchestrator suite never calls the dispatcher's baseline path). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 33 (ar/v1-pm)

- **REVIEW DEFECT (round-32 closure review, Claude Pro P1):** the round-32 dispatch-time workspace baseline recorded PATHS only, so diffScope excluded a currently-dirty path the moment it matched a baseline path — a Builder could hide an out-of-scope edit behind ANY file already dirty at dispatch by merely editing that pre-existing dirty file further (the path stayed excluded, so the edit was never attributed to the run). Root cause: the baseline compared path membership, not content identity.
- **FIX (content-aware baseline, smallest):** `src/backend/dispatcher.ts` `writeWorkspaceBaseline`/`captureWorkspaceBaselineSnapshot` now records, for each dirty path from the authoritative `git status --porcelain=v1 --no-renames -uall`, a working-tree content digest at dispatch time — sha256 of the file bytes ("deleted" for an already-missing file) — written as backward-compatible `{ paths, entries, capturedAt }` (`paths` keeps the sorted round-32 path list; `entries` maps each path to `<sha256>|deleted`; skip-digest entries for non-plain-file paths such as gitlinks/submodules, which can never be proven unchanged). `src/backend/qa-deterministic-evaluator.ts` diffScope now excludes a currently-dirty path ONLY when it is in the baseline AND its current digest equals the baseline digest (or both "deleted"); a digest mismatch, or a baseline path with no recorded digest, counts as changed by THIS run and is reported with `pre-existing but modified by this run: <path>` (still scope-checked — PASS if inside `allowedPaths`, FAIL if out). Legacy baseline files without `entries` (round-32 bare array or `{ paths }` object) fall back to the exact round-32 path-only behavior and the check detail says `baseline: path-only (legacy)`; a present-but-malformed baseline still fails closed (BLOCKED).
- **P2 (shared helper):** normalization + porcelain parsing + digest computation live in ONE module — `src/backend/workspace-diff-common.ts` (`normalizeWorkspacePath`, `parsePorcelainPath`, `computeWorkspacePathDigest`) — imported by both the dispatcher and the evaluator, so both sides of the protocol compare the same normalized shape and the same digest definition (two copies was the round-32 defect class).
- Tests: `test/v16-slice2-deterministic-qa.test.mjs` — 14b/14c now also assert the `baseline: path-only (legacy)` note on round-32 array baselines; 14e (content baseline + path unchanged → excluded, PASS, `baselineMode: 'content'`); 14f (content baseline + pre-existing file further modified, out of scope → FAIL naming `pre-existing but modified by this run: docs/OPERATIONS.md`); 14g (same modification but IN allowed paths → PASS with the modified-note); 14h (`{ paths }` object baseline without entries → round-32 path-only PASS + legacy note). `test/phase-g-dispatcher.test.mjs` G-14a: a generic (non-actl) dispatch against a git workspace now asserts the `{ paths, entries, capturedAt }` shape AND records correct sha256 digests for both a `??` (untracked) and a ` M` (tracked-then-modified) entry.
- Residual risk: a path that is not a plain file (e.g. a submodule/gitlink) has no content digest and is therefore never excludable — treated as changed by the run (fail-closed by design). The digest read is a best-effort snapshot; a concurrent external mutation between the dispatch-time `git status` and the digest read is inherently outside the protocol's guarantees (a further mutation after the snapshot is correctly attributed to the run because digests no longer match).
- Verification: `npm run build:server` passed; `node --test test/v16-slice2-deterministic-qa.test.mjs test/phase-g-dispatcher.test.mjs test/v1-qa-loop.test.mjs` → **96 passed, 0 failed** (v16) / **68 passed, 0 failed** (phase-g) / **6 passed, 0 failed** (v1-qa-loop). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 35 (ar/v1-pm)

- **LIVE DEFECT (Phase C pilot, project JuControler-Private-planning TASK-0001):** the Builder runs through `scripts/relay-worker-claude.mjs` as `claude --print --permission-mode acceptEdits`. In --print mode every Bash tool call is auto-rejected unless allow-listed, so the Builder wrote `scripts/founder-brief.mjs` but could not run `node scripts/founder-brief.mjs --self-test`. It reported "every attempt … via Bash is being denied"; the PM issued CHANGES then OWNER_REQUIRED. Deterministic QA ran the same command fine (PASS). In a Founder-absent loop the Builder must be able to run bounded verification commands.
- **FIX (smallest, least privilege):** `src/backend/worker-registry.ts` — `driverOptions.claude.allowedTools: string[]` (optional) added to `ClaudeDriverOptions`; every entry is validated at record-write time against the strict allowlist (`isAllowedToolPattern`): `Bash(<cmd>:*)` with `<cmd>` ∈ `{node, npm, npx, git status, git diff, git log, ls, cat, head, tail, wc, grep, rg, find, test}` or exactly `Read`, `Glob`, `Grep`, `Edit`, `Write`; duplicates and everything else (e.g. `Bash(*)`, `Bash(rm:*)`, `Bash(git push:*)`, `Bash(sudo:*)`, `Bash(pkill:*)`) fail closed.
- `src/backend/dispatcher.ts` — `buildDispatchArgv` mirrors the existing `--claudeConfigDir`/`--permissionMode` forwarding and emits one repeated `--allowedTool <pattern>` relay arg per allowlist entry (trusted worker registry only — never from Task/Goal/PM narrative); `dispatchTask` pulls `worker.driverOptions?.claude?.allowedTools` into the binding.
- `scripts/relay-worker-claude.mjs` — relay path accepts repeatable `--allowedTool <pattern>`, re-validates each with the same strict allowlist (a forbidden pattern is a fatal `ArgError` before any Task load), and forwards them to Claude as a single `--allowedTools <p1> <p2> …` argv (exact Claude CLI flag spelling confirmed via `claude --help`) **on the Builder relay path only**. The QA passthrough rejects `--allowedTool` with a fatal error exactly like it rejects `--permissionMode` — QA never receives a permission mode or an allowed-tools allowlist (QA judges and never edits).
- **Still forbidden:** arbitrary Bash commands (`rm`, `sudo`, `pkill`, `git push`, wildcard-only patterns), arbitrary Claude CLI flags, and any allowlist supplied through Task/Goal/PM narrative. A Builder declare-it-or-die posture: no `allowedTools` → no Bash is allow-listed → every Builder Bash call is auto-rejected in --print (previous behavior preserved).
- Tests: `test/v16-slice8-wrapper-qa-mode.test.mjs` — Builder relay forwards `--allowedTools Bash(node:*) Read Bash(git status:*) Grep` to the (fake) Claude argv; each of `Bash(*)`, `Bash(rm:*)`, `Bash(git push:*)`, `Bash(sudo:*)`, `Bash(pkill:*)` is a fatal Builder-path `ArgError` that never reaches Claude; the QA passthrough rejects `--allowedTool` fail-closed before Claude. `test/phase-g-dispatcher.test.mjs` — R35: `buildDispatchArgv` forwards repeated `--allowedTool` patterns, absent allowlist injects nothing, registry rejects `Bash(rm:*)` at write time, and a registered worker record with `allowedTools` round-trips and produces the relay args.
- Verification: `npm run build:server`; `node --test test/v16-slice8-wrapper-qa-mode.test.mjs test/phase-g-dispatcher.test.mjs test/v1-qa-loop.test.mjs` → **41 passed, 0 failed** (slice8) / **76 passed, 0 failed** (phase-g) / **6 passed, 0 failed** (v1-qa-loop). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 36 (ar/v1-pm)

- **REVIEW DEFECT (round-33 closure review FAIL, P0 — non-ASCII/quoted/backslash paths):** `git status --porcelain=v1` C-quotes any path containing a byte ≥0x80 (every non-ASCII/Unicode filename, e.g. Korean), an embedded quote, or a backslash (`core.quotePath=true` is git's default). The round-33 parser stripped only the surrounding `"..."` wrapper, never decoded the `\NNN` octal escapes, and `normalizeWorkspacePath` then turned every escape backslash into a path separator — so a Korean-named dirty file at its REAL path (e.g. `docs/한글파일.txt`) was stat/read under a fabricated nested path (`docs/355/225/234/...`), got the literal `"deleted"` on BOTH sides of the protocol, and was silently excluded as `pre-existing (excluded)` regardless of how the run rewrote the real file. That reopened the exact round-32 path-only bypass the content-aware baseline was built to close, reproducible end-to-end against the compiled code.
- **FIX (NUL-separated porcelain on BOTH sides, one shared parser):** the dispatcher's baseline capture and the evaluator's diffScope now run the SAME `git status --porcelain=v1 -z --no-renames -uall` and parse the SAME `XY<space>path<0x00>` NUL records (path RAW, never C-quoted; `--no-renames` keeps exactly one path field per record) through `parsePorcelainZRecords`/`runGitStatusZ` in `src/backend/workspace-diff-common.ts`. Baseline keys and current-status keys therefore agree byte-for-byte for every real filename; the round-33 content-aware exclusion now works for Korean names, quotes, and backslashes. The textual `parsePorcelainPath` (quote-stripping, no octal decoding, backslash-to-separator mangling) is deleted; `-uall` is kept so untracked directories never collapse into a single `?? dir/` entry.
- **REVIEW DEFECT (round-33 closure review FAIL, P1 — unbounded hashing):** `captureWorkspaceBaselineSnapshot`'s digest loop did a full unbounded `fsp.readFile` per dirty path (no per-file size cap, no count cap, no time budget; the 30 s `git status` timer is cleared before the loop), and `writeWorkspaceBaseline` is awaited by every dispatch before the Worker can spawn — one accidentally-left build artifact/log/binary or a huge dirty-fileset could stall or exhaust every Task dispatch.
- **FIX (bounded digests):** per-file cap `MAX_DIGEST_FILE_BYTES` (8 MiB) — a plain file above it is recorded as `oversize:<bytes>` WITHOUT being read/hashed and is NEVER excludable at QA time (a dirty oversize path is always treated as changed by the run, fail-closed). Count cap `MAX_BASELINE_PATHS` (2000) — beyond it the dispatcher skips the digest loop entirely, writes the baseline with `truncated: true`, and the evaluator falls back to round-32 path-only subtraction with a visible `baseline: path-only (legacy, truncated)` note (never a silent exclusion). The `git status` subprocess keeps its 30 s timeout and the NUL stream has its own 4 MiB capture cap; an over-budget/invalid capture still fails closed (no baseline written → legacy behavior).
- Residual risks (disclosed, accepted by design): (a) modify-then-restore is accepted — if a pre-existing dirty path's working-tree bytes at QA time equal its dispatch-time digest, the run's net diff on that path is empty, matching how `git diff`/human review sees it; (b) symlinks are followed (`fsp.stat`), so the digest hashes the link TARGET's bytes rather than git's stored blob of the link string — a semantic mismatch that fails toward over-flagging (a symlink change reads as modified), never toward hiding a change; a broken link reads as `deleted` (a real `deleted` of the symlink's target also reads as `deleted`, over-flagging again, never under-flagging); (c) an over-count (truncated) baseline falls back to the weaker round-32 path-only semantics — which is why the note is visible rather than silent.
- Tests: `test/v16-slice2-deterministic-qa.test.mjs` — 14i (baseline keys for `docs/문서.md`, a quote-containing name, and a backslash-containing name are excluded byte-for-byte through the live `git status -z` stream; no octal/backslash-mangled path appears), 14j (pre-existing Korean-named file REWRITTEN out-of-scope → FAIL naming the real `docs/문서.md` as `pre-existing but modified by this run`), 14k (oversize digest never excluded: out-of-scope FAIL, in-scope PASS with the modified note), 14l (truncated baseline → `baseline: path-only (legacy, truncated)` note + `baselineTruncated` evidence). `test/phase-g-dispatcher.test.mjs` — G-14b (dispatcher baseline keys are the exact RAW Korean/quote/backslash strings and equal the evaluator-side shared parser's keys for the same NUL stream), G-14c (oversize dirty file recorded as `oversize:<bytes>`, not hashed), G-14d (MAX_BASELINE_PATHS+1 dirty files → `truncated: true`, zero digests).
- Verification: `npm run build:server`; `node --test test/v16-slice2-deterministic-qa.test.mjs test/phase-g-dispatcher.test.mjs test/v1-qa-loop.test.mjs` → totals below.

## CHANGES round 37 (ar/v1-pm)

- **PROVEN DEFECT (PM reproduced live against the real `claude` CLI, 2.1.273):** round 35 emitted the Builder relay argv as `claude --add-dir <root> --print --permission-mode acceptEdits --allowedTools Bash(node:*) Read … <prompt>`. `--allowedTools` is a VARIADIC option (`--allowedTools <tools...>`), so the real CLI consumes EVERY following argv element — including the positional prompt. The prompt was swallowed and claude exited 1 with `Error: Input must be provided either through stdin or as a prompt argument when using --print`. Live evidence: run `eeb756bd-…` of project JuControler-Private-planning failed in 2.8 s with exactly that argv shape recorded in its worker-launch.log.
- **FIX (`scripts/relay-worker-claude.mjs`, Builder relay path only):** the positional prompt is now emitted IMMEDIATELY after `--print` (before any other option), then the fixed-arity `--permission-mode` (acceptEdits only), and the variadic `--allowedTools` LAST with the patterns passed as ONE comma-joined value: `[ '--add-dir', workspaceRoot, '--print', prompt, ...(permissionMode==='acceptEdits' ? ['--permission-mode','acceptEdits'] : []), ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []) ]`. PM-verified working forms (both print OK): `claude --print "<prompt>" --allowedTools "Read,Glob"` and `echo "<prompt>" | claude --print --allowedTools "Read,Glob"`.
- **Validation unchanged + one addition:** the round-35 strict allowlist (`isValidAllowedToolPattern`, forbid Bash(*) / rm / sudo / pkill / git push / arbitrary flags) is byte-for-byte unchanged; since patterns are now comma-joined into one `--allowedTools` value, a pattern CONTAINING A COMMA is a new fatal `ArgError` with its own message (a comma would corrupt the joined value).
- **QA passthrough unchanged:** it still rejects `--allowedTool` outright (fail-closed, exactly like `--permissionMode`) and keeps its argv shape `claude --add-dir <cwd> --print <prompt>` — QA judges and never edits.
- Tests (`test/v16-slice8-wrapper-qa-mode.test.mjs`): assert the exact Builder argv ORDER (prompt immediately after `--print`; `--allowedTools` AFTER the prompt; its value a single comma-joined string consuming exactly one argv element); a comma-containing pattern is a fatal `ArgError` naming the comma; with NO allowedTools in the record the argv is byte-identical to the pre-round-35 shape (default permission mode → `--add-dir <ws> --print <prompt>`); the QA-passthrough `--allowedTool` rejection is kept.
- Verification: `npm run build:server` passed; `node --test test/v16-slice8-wrapper-qa-mode.test.mjs test/phase-g-dispatcher.test.mjs test/v1-qa-loop.test.mjs` → **41 passed, 0 failed** (slice8) / **76 passed, 0 failed** (phase-g) / **6 passed, 0 failed** (v1-qa-loop). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 38 (ar/v1-pm)

- **LIVE DEFECT (Phase C pilot, project JuControler-Private-planning, TASK-0002):** deterministic QA PASSED (its `command` check ran `node scripts/founder-brief.mjs --self-test`, exit 0) and semantic QA PASSED, yet the automatic PM judged CHANGES twice and was heading for exhaustion, because the only Evidence records bound to the run were `ADAPTER_OBSERVATION` (trust OBSERVED) and the worker's own prose (CLAIMED). The Task's `required_evidence` asks for machine-level proof that the test ran; the relay worker deliberately never writes Evidence (`scripts/relay-worker-claude.mjs` header) and the QA gate wrote none either. Root cause was a missing producer, not a broken judgement: the trust ladder (`src/shared/types.ts` — "Never infer ACCEPTED from VERIFIED, or VERIFIED from OBSERVED") is correct and the loop correctly refused to accept — no component ever produced VERIFIED evidence.
- **FIX (root cause, minimal — new `src/backend/qa-evidence.ts`, wired from `qa-deterministic-evaluator.ts`):** when a deterministic QA attempt reaches a PASS/FAIL aggregate, the gate now writes exactly ONE Evidence record through the existing certified collectors `recordTestEvidence` / `recordQaEvidence` (always trustLevel **VERIFIED**, runId mandatory). Type is **TEST** when the attempt contains at least one `command` check, otherwise **QA**; status mirrors the deterministic aggregate (PASS/FAIL). `QaAttemptRecord` gained an additive, append-only `evidenceIds: string[]` linkage (validator + `linkQaAttemptEvidence` in `qa-attempt.ts`). Idempotent on replay: the Evidence kernel itself dedupes on `sourceEventId = "qa-attempt:{qaAttemptId}"`, so the same attempt never produces a second EVIDENCE- record; the ALREADY_EVALUATED replay path reconciles the linkage only. Summary discipline: check list with exact argv (JSON-stringified) + exit code + duration for `command` checks, and a bounded secret-scrubbed tail of failing-command output via the SAME exporter `qa-semantic-evaluator.ts` uses (`workerOutputTail`: ANSI-strip → PEM/Bearer/JWT/token/base64 redaction → last 400 chars). A BLOCKED aggregate writes nothing — BLOCKED means nothing was machine-verified.
- **Trust ladder explicitly UNCHANGED:** nothing anywhere infers ACCEPTED from these VERIFIED records. The QA gate still never calls acceptResult/requestChanges; QA PASS still ≠ Task ACCEPT; only the GPT PM (or Owner) may turn VERIFIED evidence into an ACCEPTED verdict. What round 38 repairs is the *missing rung* — machine-level evidence for the deterministic run now exists where before only OBSERVED/CLAIMED did.
- Tests (`test/v16-slice2-deterministic-qa.test.mjs`, new §49–54): passing `command` attempt → exactly one TEST/PASS/VERIFIED Evidence bound to run/task/goal (summary carries exact argv + exit 0); failing attempt → TEST/FAIL (exit 7); file-only attempt → type QA; replay writes no second record (same single evidence id across the kernel); a secret emitted into a >24k stdout never lands in the summary (scrubbed `[REDACTED]`, bounded ≤ 4000 chars); BLOCKED aggregate writes zero Evidence.
- Verification: `npm run build:server` passed; `node --test test/v16-slice2-deterministic-qa.test.mjs test/v1-qa-loop.test.mjs test/phase-g-dispatcher.test.mjs` → **144 passed, 0 failed** (slice2) / **6 passed, 0 failed** (v1-qa-loop) / **88 passed, 0 failed** (phase-g). Safety regression: slice3–slice6 QA suites also green (65/105/43/72, all 0 failed). `LIVE_DATAROOT_WRITES: 0`.

## CHANGES round 38b (ar/v1-pm)

- **LIVE P0 (project JuControler-Private-planning, TASK-0002):** the automatic PM judged the SAME evidence class CHANGES, CHANGES, then ACCEPT. Its accepting reason claims the cited record held raw self-test output; the record (`ADAPTER_OBSERVATION`, trust `OBSERVED`, status `INFO`) says only `Adapter RESPONSE_COMPLETE observed for Task … Run …`. So ACCEPT-without-verification was reachable by retry pressure alone.
- **FIX (inside the existing final gate, no new architecture):** before an `ACCEPT` / `ACCEPT_AND_NEXT` decision is applied, `src/orchestrator/role-loop.ts` now mechanically checks the frozen contract's `required_evidence` (`task-contract.v1`, `string[]`) against the Evidence records actually bound to the accepted run. Each requirement names its minimum acceptable machine Evidence as a `<TYPE>/<TRUSTLEVEL>` token (e.g. `TEST/VERIFIED`); a requirement that names no such token cannot be machine-checked and is treated as unmet — ACCEPT must never be reached on prose. An ACCEPT is applied only if every requirement is satisfied by at least one Evidence record bound to that task/run whose `type` matches, whose `trustLevel` is at least the required level, and whose `status` is not `FAIL`. On any unmet requirement the gate REFUSES to apply ACCEPT and rewrites the outcome to `CHANGES` with a machine-generated reason naming exactly the unmet requirement and the records present (id/type/trustLevel/status); the PM's own prose reason is preserved verbatim underneath so nothing is hidden. The refusal is audited in `role-loop.jsonl` as `outcome: "ACCEPT_REFUSED_EVIDENCE"` with the unmet requirement ids. When the contract names no `required_evidence`, behaviour is unchanged.
- **The gate can only refuse, never upgrade:** nothing anywhere in round 38b promotes `VERIFIED` (or any other record) to `ACCEPTED` automatically; the final verdict stays the GPT PM's / Owner's. Round 38's producer (`src/backend/qa-evidence.ts` — one VERIFIED record per deterministic QA attempt) now feeds this gate: a PASSed deterministic run containing a `command` check mints `TEST/VERIFIED`, which is exactly what a `TEST/VERIFIED` contract requirement consumes, and a file-only PASS mints `QA/VERIFIED`.
- Tests (`test/v1-orchestrator.test.mjs` §r38b-a..e): (a) contract requires `TEST/VERIFIED`, only `ADAPTER_OBSERVATION/OBSERVED` exists → PM says ACCEPT → applied decision is CHANGES with `ACCEPT_REFUSED_EVIDENCE` and the unmet requirement named; (b) the required VERIFIED record exists → ACCEPT applies unchanged; (c) no `required_evidence` in the contract → ACCEPT applies unchanged; (d) a FAIL-status record of the right type/level does not satisfy the requirement; (e) the PM's original reason text is still present verbatim in the stored judgment. Drill/QA-loop fixtures updated to contracts with no `required_evidence` (behaviour unchanged), keeping their pre-round-38b meaning.
- Verification: `npm run build:server` passed; `node --test test/v1-orchestrator.test.mjs` → **46 passed, 0 failed**; `node --test test/v1-qa-loop.test.mjs` → **6 passed, 0 failed**; `node --test test/v1-orchestrator-drills.test.mjs` → **8 passed, 0 failed**.

## CHANGES round 38c (ar/v1-pm)

- **LIVE EVIDENCE (pilot project JuControler-Private-planning, TASK-0003, audit line 04:16:36Z):** the final-gate evidence check emitted `ACCEPT_REFUSED_EVIDENCE` with `unmet: ["REQ-1","REQ-2","REQ-3"]` and the reason `REQ-1 "node scripts/founder-brief.mjs --self-test 실행 결과(PASS 마커, exit 0)" (names no machine-checkable TYPE/TRUSTLEVEL token)` — and likewise for REQ-2/REQ-3. Real `task-contract.v1` `required_evidence` entries are PROSE written by the planning PM; they do not name an evidence `TYPE`/`TRUSTLEVEL`. The round-38b pure-token rule therefore refused every real Task forever — the same class of release blocker as accepting without verification, only mirrored.
- **FIX (bounded, both guarantees kept — `src/orchestrator/role-loop.ts`):** the gate now applies ONE of TWO rules per requirement. (1) A requirement that DOES name a machine-checkable `<TYPE>/<TRUSTLEVEL>` token (a type from `EVIDENCE_TYPES` and a level from `EVIDENCE_TRUST_LEVELS`, case-insensitive, e.g. `TEST/VERIFIED`) keeps the round-38b behaviour byte-for-byte: a non-FAIL record bound to the run must match the exact type and at least that trust level. (2) A requirement naming NO such token — the normal prose case — applies the **default floor** instead of refusing: the requirement is satisfied iff at least one Evidence record bound to that task+run has `trustLevel` VERIFIED (or higher, ACCEPTED) and `status` is not FAIL.
- **What the floor still blocks:** an `ADAPTER_OBSERVATION`/`OBSERVED`-only run can never satisfy a prose requirement (much less a token one), and a `VERIFIED` record whose `status` is `FAIL` never satisfies it either — so the DEC-2026-149 hole (ACCEPT on an OBSERVED observation alone) stays closed exactly as round 38b closed it, while an ordinary prose requirement is now met by the QA-minted VERIFIED record (`src/backend/qa-evidence.ts`).
- **Wording correctness (refusal + audit line):** the two cases are distinguished. Case 2 says `floor: VERIFIED evidence absent` per unmet requirement — never the old phrase claiming the requirement "names no machine-checkable token", which described the CONTRACT, not the failed VERIFICATION. Token-requirement refusals keep the round-38b `(requires TEST/VERIFIED)` wording. The `role-loop.jsonl` refusal line gains a `rules` field (`REQ-1:token` / `REQ-1:floor`) alongside the existing `unmet`/`requirements`/`present` fields.
- **Reviewer traceability (why it passed):** the applied judgment (`judgment.json`, surfaced by `getPmJudgment`/`listPmJudgments`) now carries an additive, validated (max 64 rows) `evidenceGate: [{requirementId: "REQ-N", requirement, rule: "token" | "floor"}]` array — one row per contract requirement, satisfied or not — so a reviewer can see exactly which rule matched per requirement. `src/backend/pm-judgment.ts` added the optional field (allowed-key + shape validation; idempotency/intent semantics unchanged; ACCEPT refuses the field when combined with `retryInstruction` exactly as before; judgment.md shows a compact `evidence gate: REQ-1:floor` line when present).
- Tests (`test/v1-orchestrator.test.mjs` §r38c-a..e): (a) prose requirement + a VERIFIED `TEST/PASS` record bound to the run → ACCEPT applies, judgment records `rule: "floor"`; (b) prose requirement + only `ADAPTER_OBSERVATION/OBSERVED` (delivery constructed without the QA gate so the QA-minted VERIFIED record is absent) → refused with `floor: VERIFIED evidence absent`, never the old contract-describing phrase; (c) prose requirement + a `VERIFIED` record whose `status` is `FAIL` → refused (the FAIL record is listed as present); (d) explicit `TEST/VERIFIED` token requirement keeps the round-38b behaviour both unsatisfied (refusal still reads `requires TEST/VERIFIED`, not the floor wording) and satisfied (ACCEPT applies), judgment records `rule: "token"`; (e) a contract with no `required_evidence` still applies ACCEPT unchanged with no `evidenceGate` rows. The round-38b a..e tests are untouched and still pass.
- Verification: `npm run build:server` passed; `node --test test/v1-orchestrator.test.mjs` → **51 passed, 0 failed**; `node --test test/v1-qa-loop.test.mjs` → **6 passed, 0 failed**. Safety regressions green: v1-orchestrator-drills (8/0), v1-g5a-pm-judgment (1/0), b15-fix-01-a (1/0), v1-g5a-judgment-durability (1/0).

## CHANGES round 39 (ar/v1-pm)

- **PROVEN DEFECT (live starvation in the final gate, JuControler-Private-planning):** TASK-0001 reached terminal `executionState: FAILED` while its delivery `PMD-TASK-0001-eeb756bd-…` stayed `PENDING` with a cached `OWNER_REQUIRED` final-gate decision. From 03:11Z to 04:16Z the orchestrator logged `final-gate FINAL_GATE_DECISION_CACHED` for that same delivery on every tick (~10 s) and never processed the live delivery of TASK-0003, so a healthy Task waited an hour behind a dead one; an operator had to consume the stale delivery by hand.
- **FIX (bounded, `src/orchestrator/role-loop.ts`, final-gate step `processFinalGate`):** before re-deciding a PENDING delivery from its cached decision, the step now reads the Task's `executionState`. When the Task is TERMINAL (`FAILED` or `CANCELLED`) the cached decision is NOT kept alive and the delivery is NOT re-decided — it is superseded EXACTLY ONCE through the existing certified delivery-consumption API (`ignorePmDelivery`, the same PENDING→IGNORED CAS transport that the `relay_pm_ignore_delivery` operator tool runs — no canonical file is written by hand), with a machine-generated reason naming the terminal state, and exactly one audit line `step: "final-gate", outcome: "DELIVERY_SUPERSEDED_TERMINAL_TASK"` carrying `deliveryId`, `taskId` and `terminalState`. The cached-decision and blocked entries for that deliveryId are dropped. Idempotent: a replay hits the existing PENDING guard and returns `REPLAY_IGNORED`, so a second supersede/audit is never emitted. After the supersede the SAME cycle continues to the remaining deliveries — one dead delivery can never end a cycle early. A FRESH failed-run recovery delivery (no cached decision yet) is untouched and still proceeds to the normal PM judgment, so the dispatch-failure recovery path is preserved.
- Tests (`test/v1-orchestrator.test.mjs` §r39-a..d): (a) a pending FAILED-task delivery with the cached OWNER_REQUIRED decision (the live shape) is superseded once, the audit line carries deliveryId/taskId/terminalState=FAILED, no `FINAL_GATE_DECISION_CACHED` is re-emitted, and a second LIVE delivery in the same cycle is still processed (ACKNOWLEDGED); (b) CANCELLED behaves identically; (c) a delivery whose Task is still open is untouched and decided normally (ACCEPT applies); (d) replaying the same cycle never supersedes twice (`IGNORED`, one audit line total; a direct final-gate replay is `REPLAY_IGNORED`).
- Verification: `npm run build:server` passed; `node --test test/v1-orchestrator.test.mjs test/v1-qa-loop.test.mjs` → **61 passed, 0 failed** (v1-orchestrator 55/0, v1-qa-loop 6/0).

## CHANGES round 40 (ar/v1-pm)

- **LIVE STRANDING (JuControler-Private-planning TASK-0003):** a normal supervisor stop/restart (the equivalent of a reboot) left two runs behind. Run 4 `5bdc800f-…` (folder `2026-09-17/worker-builder-claude-pro/12`) had already written `result.md` and `agent-result.md` but no Delivery was ever created; run 5 `d6813884-…` (folder `…/13`) is a QA-remediation run carrying `qa-remediation-context.json` that was dispatched and never collected. After the restart every orchestrator tick logged `cycle IDLE — no actionable work` while `openTasks: ["TASK-0003"]`, so the Task stuck forever. The operator's own collector cannot help: it only supports actl-managed runs and fails with `runtime-binding.json missing`, while this Builder is a relay-path worker.
- **FIX (deterministic restart recovery, `src/orchestrator/role-loop.ts` resume/collect step):** at the start of every cycle the cycle scans open Tasks (`executionState` DISPATCHED or RUNNING) for their latest dispatched-but-unfinished Run and recovers it for BOTH relay-path and actl-managed workers, before the actl-only `resumeActlManagedCollect` pass runs:
  - **Result on disk, no Delivery** (`result.md`/`agent-result.md` exist, no `PMD-{taskId}-{runId}` record) → the Run is re-admitted through the SAME certified primitives a normal collect uses — `markResultReceived` / `markQaResultReceived` plus the certified Delivery mint (`ensurePmDeliveryForTaskVerify` for the ordinary V1/V1.5 path, `reconcileQaGate` for QA-gated Tasks so PASS / budget-exhausted FAIL mints the Delivery as usual) — and the SAME cycle then continues into QA/gate exactly like a live `COLLECTED` run; the recovered QA-gated Tasks are added to the same `qaReconciled` set so the gate never runs twice.
  - **No result, no live process handle** (no result files, not in the dispatcher's process-local live-dispatch registry, no resumable actl runtime-binding) → the Run is recorded as FAILED through the certified failed-run API (`transitionTaskExecution` → `FAILED` with a machine reason naming the missing result, then `ensurePmDeliveryForFailedRun`), so the Task can retry through the existing failed-run PM path instead of hanging. Never silently dropped, never a fabricated result. RESERVED dispatcher lineage and FINAL_BOUND-without-result transports are left to their owners; binding-backed (possibly live tmux) runs are deferred to the collect hook, never declared failed.
  - **QA-remediation runs follow the same two rules** (folder-level `qa-remediation-context.json` lineage is recovered identically).
  - One audit line per recovered run: `step: "resume-collect", outcome: "RECOVERED_RESULT" | "RECOVERED_NO_RESULT"` with `taskId`, `runId` and `folder`. Idempotent: the deterministic `PMD-{taskId}-{runId}` delivery (or the post-FAILED state) makes a second cycle a no-op — no second Delivery, no second failure record, no duplicate audit — and `cycle IDLE` is never reported while an open Task still has an unresolved dispatched run (every recovery decision pushes a step, so the cycle audits ACTED).
- Tests (`test/v1-orchestrator.test.mjs` §r40-a..e): (a) a run folder with a worker result and no Delivery → exactly one Delivery minted, `RECOVERED_RESULT` audit with taskId/runId/folder, cycle ACTED not IDLE; (b) a run folder with no result → failure recorded once through the certified failed-run API (machine reason `run has no result.md/agent-result.md and no live process handle`), the failed-run packet names that reason and the Task can retry (`CHANGES` → SAME_TASK → READY); (c) replaying the same cycle → no second Delivery, no second failure record, exactly one audit per run; (d) a QA-remediation run (folder with `qa-remediation-context.json`) with a result recovers the same way through the QA gate (deterministic PASS mints the delivery, replay adds nothing); (e) a healthy cycle with nothing stranded is unchanged — no `RECOVERED_*` steps, the normal delivery is decided and Accepted.
- Verification: `npm run build:server` passed; `node --test test/v1-orchestrator.test.mjs test/v1-qa-loop.test.mjs` → **66 passed, 0 failed** (v1-orchestrator 60/0, v1-qa-loop 6/0). Regression-safe: v1-orchestrator-drills + v1-orchestrator-actl-dispatch 14/0, v1-g5c-auto-redispatch 116/0, v2-r3-restart 1/0.
## CHANGES round 41A (ar/v1-pm)

Round 41A updated the I-29 argv-ordering assertions in `test/phase-i-dogfood.test.mjs` to the round-37 contract (positional prompt immediately after `--print`, then fixed-arity `--permission-mode acceptEdits`, then `--allowedTools` emitted last as a single comma-joined value). This is test drift, not a product regression — the wrapper behaviour was already corrected in round 37, when variadic `--allowedTools` was swallowing the positional prompt on the live Builder. The assertions were strengthened, not weakened: they now pin all three orderings (`--print < prompt < --permission-mode`, `--print < prompt < --allowedTools`), the discrete-arity `['--permission-mode', 'acceptEdits']` pair, and the single comma-joined `--allowedTools` value.

## CHANGES round 41B (ar/v1-pm)

- **LIVE MISS (project JuControler-Private-planning, TASK-0003):** after a supervisor restart, `resume-collect RECOVERED_NO_RESULT` fired for run `d6813884…`, but run `5bdc800f…` of the SAME Task — which has `result.md` and `agent-result.md` in `2026-09-17/worker-builder-claude-pro/12` — was never recovered: `RECOVERED_RESULT` never appears in the audit and that run has no Delivery. The round-40 restart recovery scan (`src/orchestrator/role-loop.ts`, `recoverStrandedDispatchedRuns`) walked only the LATEST linked Run of each open Task, so a restart that strands several Runs of one Task at once (newer Run with no Result, older Run whose worker already wrote result files) recovered only the newest and left the older Result-bearing Run stranded forever in a now-FAILED Task.
- **FIX (minimal, per-run rules unchanged):** the scan now iterates over EVERY unresolved Run of EVERY open Task, newest attempt first, keeping each run's own round-40 decision rule, audit line (`resume-collect RECOVERED_RESULT|RECOVERED_NO_RESULT` with `taskId`/`runId`/`folder`) and idempotency anchor (`PMD-{taskId}-{runId}`, one per run, replay is a no-op). Because a Task occupies ONE executionState at a time, the current no-result attempt is recorded as FAILED first (the certified failed-run API can only record the current attempt); an older Run's already-written Result is then carried to PM through a NEW certified exact-run mint `ensurePmDeliveryForTaskVerifyRun` in `src/backend/pm-delivery.ts` (deterministic `PMD-{taskId}-{runId}`, same exclusive-mkdir idempotency, never fabricates: requires the Run linked and `result.md`/`agent-result.md` present, refuses accepted runs). Every unresolved run now recovers in the same cycle — exactly one audit line per run, no second Delivery, no second failure record, never IDLE while an open Task has stranded work.
- Tests (`test/v1-orchestrator.test.mjs` §r41-a, extends the round-40 block): ONE open Task with TWO stranded Runs — older with a Result, newer without — recovers BOTH in a single cycle, emits exactly one audit line per run (`RECOVERED_RESULT` and `RECOVERED_NO_RESULT` with `taskId`/`runId`/`folder`), the Result run holds its own `PMD-{taskId}-{runId}` Delivery and the no-result run its failed-run record, the cycle audits ACTED, and a replayed cycle adds no second Delivery, no second failure record and no duplicate audit line. Round-40 §r40-a..e still pass unchanged (single-run semantics untouched).
- Verification: `npm run build:server` passed; `node --test test/v1-orchestrator.test.mjs test/v1-qa-loop.test.mjs` → **67 passed, 0 failed** (v1-orchestrator 61/0, v1-qa-loop 6/0).


