# Independent review of the WBS-10 fix series 9af10aa..68bace9 — Claude Pro, read-only, 2026-09-16 10:08Z

PM disposition: PASS_WITH_CONDITIONS accepted; no P0/P1. P2 (disabled-tool list completeness vs the installed OpenCode package; secrets check conditions) folded into the next Builder round. Later commits 6d411d4 (failed-run recovery) and the stale-hash fix will be reviewed before certification.

WBS10_SERIES_REVIEW: PASS_WITH_CONDITIONS

Range: `git log --oneline 9af10aa..68bace9` (14 commits, HEAD = `68bace9`, matches the current worktree).
Read-only: no edits, no git mutations, no writes under `~/.local/share/AgentRelay/data`, no tmux/systemd.
Allowed commands only: `npx tsc -p tsconfig.server.json --noEmit` (clean), `node --test <file>`, `git log/show/diff`,
read-only greps, plus offline inspection of the installed `opencode-ai` package/binary for check 2 (no network,
no live server call).

P0:
- NONE.

P1:
- NONE.

P2:
- **Check 2 (tool-less PM) — incomplete disabled-tool list, not proven exploitable.** `OPENCODE_TOOL_IDS_DISABLED`
  (`src/integrations/opencode/command-adapter.ts:91-94`) lists 18 ids: `bash, edit, write, read, glob, grep, list,
  webfetch, websearch, todowrite, todoread, task, patch, multiedit, question, skill, lsp, codesearch`. Extracting
  strings from the installed binary (`strings -a /usr/local/lib/node_modules/opencode-ai/bin/opencode.exe`, "offline
  in node_modules/opencode*" per the check's own instruction) surfaces a distinct tool-id registration:
  `Set(["bash","glob","read","grep","webfetch","websearch","write","edit","task","apply_patch","todowrite",
  "question","skill","execute"])`, plus separately-quoted `"apply_patch"` tied to its own call-result plumbing
  (`apply_patch_call_output`, `response.apply_patch_call_operation_diff.*`). Neither `apply_patch` nor `execute`
  appears in `OPENCODE_TOOL_IDS_DISABLED`. This is NOT confirmed exploitable: the `response.*` framing strongly
  suggests `apply_patch`/the OpenAI-Responses-API code-interpreter family are provider-native tool primitives for
  Codex/Responses-API-style models, not OpenCode's own `tools:{key:boolean}` permission-map keys — and the real
  WBS-10 Pass-1 evidence (`docs/WBS10_RUNBOOK.md:14-15`) proves the disabled-list fix empirically converges the
  PM's ACTUALLY-configured models (`mimo-v2.5-free`, `big-pickle`, both native OpenCode tool-calling, not
  Responses-API passthrough) to a tool-less single-block reply. No test failed and no regression was found; this
  is a documentation/completeness gap in the allowlist against a broader binary surface, not a proven live defect
  against V1CERT's actual role config. Recommend either widening the disabled map to include `apply_patch`/
  `execute` defensively, or verifying completeness against the live `GET /tool/ids` endpoint (confirmed to exist:
  `@opencode-ai/sdk/dist/gen/types.gen.d.ts:1215` `export type ToolIds = Array<string>`) the next time the PM
  model roster changes.
- **Check 9 (session rotation) — preamble-resend-after-rotation is logically sound but not directly tested.**
  `rotateTimedOutPmSession` (`src/orchestrator/role-loop.ts:242-250`) deletes the durable PM role-session record
  after a timeout, and `test/v1-orchestrator.test.mjs:632` directly proves the file is gone. Combined with
  `ensurePmAdapterAndSession`'s preamble gate (`role-loop.ts:289-291`: sends the preamble when `!existing`, among
  other conditions), a deleted record necessarily makes the NEXT turn look like a fresh session and resend the
  preamble — but no single test drives timeout → rotation → next turn and asserts
  `adapter.preambleBodies.length === 2`. The property holds by inspection of the two tests together, not by one
  direct test. Recommend adding that one end-to-end assertion.
- **Check 8 (secrets) — inspection-only, no dedicated regression test for this commit range.** No
  `/config/providers` call and no password/bearer logging was found anywhere in the touched files (see table),
  but unlike checks 1–7/9 there is no test in this range that would independently fail if someone later added a
  `console.log` of the OpenCode password or an authorization header. Recommend one bounded assertion (e.g. grep
  stdout/audit-log output for the literal password-file contents in a disposable test) so this becomes
  test-enforced rather than inspection-only.

TESTS_RUN: 165/0
(`node --test test/v1-orchestrator.test.mjs` 30/0; `node --test test/v1-orchestrator-drills.test.mjs
test/opencode-command-adapter.test.mjs` 18/0; `node --test test/v1-orchestrator-actl-dispatch.test.mjs` 2/0;
`node --test test/v1-g5a-pm-judgment.test.mjs test/v1-g5a-judgment-durability.test.mjs test/b15-fix-01-a.test.mjs
test/b15-fix-03-a.test.mjs` 4 files / 115 internal assertions, 0/0 failed — see check 7 detail. All run live this
session, not assumed from `docs/WBS58_EVIDENCE.md`'s own prior numbers. `npx tsc -p tsconfig.server.json --noEmit`
clean.)

| # | Check | Verdict | Evidence (file:line) | Test that fails on revert |
|---|---|---|---|---|
| 1 | No new direct canonical writes; no canonical mutation on invalid/timeout PM turn | **PASS** | Every `fs.*` write in `role-loop.ts` targets only `stateFile` (`role-loop.ts:210-215`), `auditDir/role-loop.jsonl` (`:223-226`), or the non-canonical PM role-session bookkeeping file (`:249`, `roleSessionPath` under `_relay/role-sessions/`, explicitly not Task/Run/Result truth). `createTask`/`submitPmJudgment`/`transitionTaskExecution` are only reached after `parsed.ok` is true and (for CREATE_TASK) `dryRunValidateContract` has already succeeded inside the parse closure (`role-loop.ts:379-390`); `recordRuntimeBlock` (`:233-240`) returns before any of those calls on every error path. | `test/v1-orchestrator.test.mjs:252` "four invalid contract responses exhaust validation re-asks and create no Task"; `:620` "(d) PM send timeout ... canonical untouched" |
| 2 | Tool-less PM: disabled map complete; instructions forbid tool markup; re-ask text correct | **PASS_WITH_CONDITIONS** (P2 above) | `OPENCODE_TOOL_IDS_DISABLED` (`command-adapter.ts:91-94`) sent as `tools:{}` on every message (`:296` per the prior session's read, confirmed unchanged); `docs/PM_ROLE_INSTRUCTIONS.md:29-33` "## No tools" section forbids `<tool_call>`/`<function=...>` markup; `reaskEnvelope`'s `noTools` detection (`role-loop.ts:262`) matches those exact patterns and emits "you have no tools; answer with the JSON block only". Empirically proven against the two live PM models in `docs/WBS10_RUNBOOK.md:14-15`. | `test/v1-orchestrator.test.mjs:325` "PM tool-call markup receives a no-tools re-ask..." (asserts the exact re-ask sentence at `:336`); `test/opencode-command-adapter.test.mjs` "send then collect..." asserts every sent tool flag is `false` |
| 3 | Preamble sent once per session; OUTPUT CONTRACT on every packet; rendered CREATE_TASK example passes real validators | **PASS** | `renderOutputContract()` appended in both `buildPmBootstrapPacket` (`pm-packets.ts:138`) and `buildPmFinalGatePacket` (`:231`) — unconditional, every packet. Preamble gate: `role-loop.ts:289-302`. | `test/v1-orchestrator.test.mjs:185` "every PM packet ends with a code-generated contract whose example parses strictly" — extracts the LITERAL fenced example from the rendered packet text, parses it with the real `parsePmTaskDecision`, then calls the real `contracts.buildTaskContract` + `contracts.validateTaskContract` + `qaContracts.validateTaskQaContractFields` (`:194-204`) — genuinely exercises the validators, not a hand-rolled check; `:340` "a new PM session receives the role preamble once and reuse does not resend it" (two `processBootstrap` calls, one preamble send asserted) |
| 4 | `qaWorkerId` taken only from role config; PM value overridden + audited; no PM-controlled worker pick | **PASS** | `normalizePmTaskContract` (`role-loop.ts:321-337`) unconditionally rewrites `qa_route.semantic.qaWorkerId` to the configured `qa` assignment's worker id whenever a `semantic` object is present, regardless of what the PM supplied, and sets `overridden=true` when the values differed; `processBootstrap` audits `QA_WORKER_OVERRIDDEN` (`:429`). | `test/v1-orchestrator.test.mjs:213-218` — PM supplies `qaWorkerId: 'invented-pm-worker'`, asserts the canonical Task's contract carries `'configured-qa'` instead, and that a `QA_WORKER_OVERRIDDEN` audit line exists |
| 5 | Validation re-ask bounded (3), validation-only; header/schema errors single re-ask; BLOCKED afterwards; `--retry-blocked` local-only | **PASS** | `sendAndParseWithReask`'s loop (`role-loop.ts:169-191`) reasks up to `maxValidationReasks` (default 3, `:175`) only while `err instanceof PmContractValidationError`; a non-validation (schema/header) error gets exactly one reask via the separate `schemaReasked` flag, and once either budget is spent the function returns `{ok:false}` → BLOCKED. `clearBlockedState` (`role-loop.ts:217-221`) only rewrites `state.blocked = {}` in the state file; `main.ts:206-211`'s `--retry-blocked` path calls only that, never touches `dataRoot`. | `test/v1-orchestrator.test.mjs:246` asserts exactly `['VALIDATION_REASK 1/3','VALIDATION_REASK 2/3']` audit entries on convergence; `:252-262` "four invalid contract responses exhaust validation re-asks and create no Task" asserts exactly 3 `VALIDATION_REASK` entries then BLOCKED, zero Tasks |
| 6 | Selector fail-closed (missing/role/ambiguous); permit factory checks runtimeId/READY/context/pane/snapshot-hash before `buildDefaultInputPermit`; no busy/wrong-pane dispatch path | **PASS** | `selectBuilderWorker` (`main.ts:91-122`): exact `<workerId>.json` match required, scans ALL worker files for `workerId` duplicates → ambiguity fails closed, requires `role==='implementation'`, requires `driverOptions.actl.runtimeId` or `launchCommand`. `installActlPermitFactory`'s `checkReady()` (`main.ts:132-152`) checks, IN ORDER, `data.runtimeId !== actl.runtimeId` → MISMATCH, `data.inputState !== 'READY'` → INPUT_STATE_UNKNOWN, every `expectedContext` key, `context.paneId` non-empty, `currentSnapshotHash` non-empty — all BEFORE `buildDefaultInputPermit` is ever called (`:159`), and `defaultDispatchHook` calls `checkReady()` a SECOND time before `dispatchV1OwnerApproved` (`:169-171`) as defense in depth. `invokeActlRuntimeOrThrow` (`actl-bridge.ts:522-538`) performs a fresh `status` subprocess call each time — not cached. No branch returns a permit without passing every check. | `test/v1-orchestrator.test.mjs` "(P1-3)" selector test (missing/ambiguous/role-mismatch fixtures); `test/v1-orchestrator-actl-dispatch.test.mjs` — "dispatches once through fake actl" (1/1 pass) and "refuses a busy fake actl pane before leaving a Run behind" (1/1 pass, live-run confirmed this session) |
| 7 | Merge `61df4c7`: `pm-judgment.ts` keeps BOTH AR-04 reconcile and `persistDecisionEvidence` on every early-return path | **PASS** | Every `submitPmJudgment` return site either calls `persistDecisionEvidence` directly (`pm-judgment.ts:605,608,617,656`) or returns a `.then(result => persistDecisionEvidence(...))`-wrapped promise (`:613,678`); `applyAccept`'s two internal branches (idempotent-already-ACCEPTED at `:740-744`, and the real apply at `:763-766`) don't call `persistDecisionEvidence` themselves, but BOTH of `applyAccept`'s only two call sites (`:678` direct, `:613` via `resumeAcceptApply` which itself only forwards `applyAccept`'s result, `:828-835`) wrap it — so the property holds for every reachable path, not just the visible ones. `reconcileJudgedDelivery` (AR-04) is called on every early-return AND inside both `applyAccept` branches (`:741,763`). | `node --test test/v1-g5a-pm-judgment.test.mjs test/v1-g5a-judgment-durability.test.mjs test/b15-fix-01-a.test.mjs test/b15-fix-03-a.test.mjs` — run live this session: 4 files, 0 failed, 115 internal assertions passed (69 + 15 + 21 + 10) |
| 8 | Secrets: no new password/bearer/provider-key logging; no `/config/providers` call | **PASS_WITH_CONDITIONS** (P2 above) | `grep` of every file touched in `9af10aa..68bace9` for `config/providers`, `password`, `bearer`, `authorization` logging found only `DEFAULT_PASSWORD_FILE` (path constant, not a value) and `authHeader()` reading the password file into a Basic-auth header that is passed to `http.request`, never logged (`command-adapter.ts:182-188`); the only `console.*` calls added are `console.error(String(e))` in `main.ts:220,224,229` (generic error messages). No `/config/providers` call found anywhere in this range. | None dedicated to this range — inspection-only (see P2) |
| 9 | Session rotation: abort best-effort; role-session record rotated; `preambleSent` cannot skip the preamble on a fresh session | **PASS_WITH_CONDITIONS** (P2 above) | `rotateTimedOutPmSession` (`role-loop.ts:242-250`): `try { abortSession ?? interrupt } catch { /* best-effort */ }` then unconditionally `fs.rmSync(roleSessionPath(...), {force:true})`. `ensurePmAdapterAndSession`'s preamble condition (`:289-291`) includes `!existing`, which is guaranteed true immediately after rotation. | `test/v1-orchestrator.test.mjs:632` proves the role-session file is deleted after a timeout (direct); the preamble-resend consequence is inferred from the code + `:340`'s preamble-once test, not directly exercised end-to-end (see P2) |

Verdict rationale: no P0, no P1 — every one of the nine checks is backed by real file:line evidence and, for all but
check 8, an actual test I ran live this session (165/0 total). `PASS_WITH_CONDITIONS` rather than a clean PASS
because of three P2 items: a real (if likely-inert) gap in the tool-disable allowlist found via offline binary
inspection (`apply_patch`/`execute`), and two test-coverage gaps (session-rotation-then-preamble-resend,
secret-non-logging) where the underlying property is sound by inspection but not independently regression-tested.
None of the three blocks WBS-10's own certification gate on their own; all three are cheap to close.
