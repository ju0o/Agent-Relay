# Independent V1 review #1 (Grok, read-only) — range 93506a0..b415a67

PM disposition (Execution PM, 2026-09-16 07:30Z): PASS WITH CONDITIONS accepted. P1(1) root cause found by PM probe: the free model `opencode/nemotron-3.5-lightning-free` currently hangs in the reasoning step (no response after 120s) while `mimo-v2.5-free` (1.9s), `big-pickle` (5.2s), `nemotron-3-ultra-free` (18.6s) answer normally → V1CERT PM default model switched to mimo-v2.5-free; WBS-3 proof to be re-run. P1(2), P2 and gaps (d)1–6 folded into the WBS-5/8 order as binding conditions (billing guard at send, fallback walker guard, contract_hash on judgments, bounded PM send timeout). No code was changed by the reviewer.

V1_REVIEW_1: PASS WITH CONDITIONS
P0: NONE
P1: (1) Live `node scripts/wbs3-proof.mjs` re-run this session → `WBS3_PROOF: FAIL` (`opencode request timed out: POST /session/…/message`) after health+ensureSession OK — unit tests 9/9 and committed `docs/WBS3_EVIDENCE.md` remain green, but certification re-proof is not reproducible right now. (2) `zeroExtraBilling: true` is enforced only in `validateRoleAssignment` / `validateRoleConfig` (`src/roles/role-config.ts:33`); `OpenCodeCommandAdapter.send` does not refuse a non-free `defaultModel` at runtime — WBS-5/8 must not rely on config typing alone.
P2: Duplicate `RoleCapabilityFlags` shapes in `role-config.ts:8` and `role-runtime.ts:4` (drift risk). `fallbackChain` is validated as `string[]` but no runtime walker exists yet (fine until orchestrator). `src/orchestrator/` only has `pm-schemas.ts` — WBS-5/8 loop not landed.
OBSERVATION_BOUNDARY_INTACT: YES
PM_READ_ONLY_ENFORCED: YES
SECRETS_IN_REPO_OR_EVIDENCE: NONE
PAID_FALLBACK_PATHS: NONE
TESTS_RUN: 33/0

# Independent V1 review #1 — `93506a0..HEAD` (`ar/github-pm-bridge-v0` @ `b415a67`)

Checklist applied: `docs/WBS23_REVIEW_CHECKLIST_GROK.md`. Read-only review (plus allowed test/proof runs). No git mutations; no live dataRoot writes from this seat.

**Range deliveries:** WBS-1/2 `d527c1b` · WBS-3 `5c4b63b` · WBS-4 `b415a67` · WBS-6/7 `c5e2522` · WBS-6/9 `38d1cd4`.

**Build:** `npx tsc -p tsconfig.server.json` → exit 0.

**Tests run this session:**  
`opencode-command-adapter` 9/0 · `v1-task-contract` 8/0 · `v1-qa-loop` 3/0 · `v1-builder-dispatch-drills` 5/0 · `test:roles` 8/0 → **33/0**.  
Live proof: **FAIL (timeout)** — see P1.

---

## 20-point checklist (evidence)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| 1 | `AgentAdapter` untouched | **PASS** | `git diff 93506a0..HEAD -- src/integrations/core/types.ts … opencode/{client,watch,extract}.ts` → **0 bytes**. `AgentAdapter` still only `startWatch` (`types.ts:85–94`). |
| 2 | Separate registries | **PASS** | Observation: `registry.ts` `registerAdapter`. Command: `role-runtime-registry.ts:4` `registerRoleRuntimeAdapter`. |
| 3 | Capability flags truthful | **PASS** | `command-adapter.ts:193–201`: `writeWorkspace:false`, `shell:false`, `persistentSession/structured*/readWorkspace/freeTier:true`. Test: “capabilities() flags match the WBS-3 spec”. |
| 4 | PM read-only / `tools:{}` | **PASS** | `command-adapter.ts:296` POST body includes `tools: {}`. |
| 5 | No write/shell for PM role | **PASS** | `role-config.ts:33` `pm must be read-only`; capabilities deny write/shell; `assertRoleSatisfiable` (`role-runtime-registry.ts:8`). |
| 6 | No secrets in logs/evidence | **PASS** | Evidence docs scrubbed; proof stdout has no password/`sk-`/`Bearer`; adapter reads pass file (`command-adapter.ts:172`) without logging it. |
| 7 | No paid API fallback | **PASS** | No `api.openai.com` / `OPENAI_API_KEY` call sites in adapter/scripts. Failures surface as HTTP/health errors. |
| 8 | `zeroExtraBilling` | **COND** | Enforced at **config validate** only (`role-config.ts:33`). Not checked in `send()` / model selection → **P1**. |
| 9 | Session bookkeeping ≠ Task SSOT | **PASS** | Paths `_relay/role-sessions/<project>/<roleId>.json` (`role-runtime.ts:8`, adapter `:227`). Shape `{adapterId,sessionId,createdAt,lastUsedAt}` only. |
| 10 | ensure→send→collect | **PASS** | Implemented on `OpenCodeCommandAdapter`; covered by fake-server tests 9/9. |
| 11 | resume after restart | **PASS** | Proof design + prior `WBS3_EVIDENCE.md` (session survives restart). This session’s live proof timed out before continuity steps. |
| 12 | Continuity two sends | **PASS (prior evidence)** / **COND live** | Evidence doc shows promptA→promptB; live re-run failed at first message POST. |
| 13 | Structured output ownership | **PASS** | Adapter returns text; `pm-schemas.ts` owns `parsePmTaskDecision` / `parsePmJudgment` (caller-side). |
| 14 | InputEnvelope kinds only | **PASS** | `role-runtime.ts:5` fixed kind union; adapter sends `envelope.body` only. |
| 15 | Tests not mocks-only | **PASS WITH COND** | Fake HTTP unit tests + committed live evidence; **this** live proof run failed timeout. |
| 16 | Observation regression | **PASS** | Observation files unchanged in range; tsc green. |
| 17 | Port isolation | **PASS** | Command adapter defaults `127.0.0.1:4111`; observation still `47800–47809` in untouched `client.ts`. |
| 18 | Role graph | **PASS** | `defaultV1RoleGraph()` (`role-config.ts:16–22`) matches issue #6 edges; tests reject unknown/duplicate. |
| 19 | PM ≠ Builder | **PASS** | PM `permissionProfile` forced read-only; tools emptied; capabilities forbid write/shell. |
| 20 | Proof vs loopback | **COND** | Prior evidence PASS on free model; **re-run FAIL timeout** (P1). Password file used, not printed. |

---

## Extra questions

### (a) Secrets in `WBS0_EVIDENCE.md` / `WBS3_EVIDENCE.md`?
**NONE.** Session ids, model ids, `cost: 0`, baseUrl only. Explicit note that `/config/providers` must never be persisted. No password/token material.

### (b) Any code path call `/config/providers`?
**NO** under `src/` and `scripts/` (`rg` empty).

### (c) Is `zeroExtraBilling` enforced at runtime or only config validation?
**Config validation only** (`validateRoleAssignment`). Runtime `send` will happily POST whatever `defaultModel` is configured — including a metered Go/OpenAI-OAuth model if selected. **P1 for WBS-5/8 integration.**

### (d) Gaps that would block WBS-5/8 integration
1. No `role-loop.ts` / orchestrator CLI yet — only `src/orchestrator/pm-schemas.ts` (parsers).  
2. No `buildPmBootstrapPacket` / `buildPmFinalGatePacket` / apply path wiring to `submitPmJudgment`.  
3. Runtime billing/model guard missing (above).  
4. Live OpenCode message latency/timeouts can block end-to-end PM loops (seen this session).  
5. `fallbackChain` unused — must not silently become a paid escape hatch when orchestrator lands.  
6. GitHub-PM importer does not yet require `contract_hash` on judgments (WBS-4 additive; WBS-8 must close).

---

## WBS-4 (reviewed as foreign lane)

| Concern | Finding |
|---|---|
| Hash canonicalization | Sorted-key recursive canonicalize; hash omits `contract_hash`; sha256 hex — `task-contract.ts:79–112` |
| Freeze | `isTaskDispatched` = `linkedRuns.length > 0`; post-dispatch revise → `CONTRACT_FROZEN` — verified by test 4 |
| Derive AC/qaContract | `deriveAcceptanceAndQaFromContract`; `createTask` path when `contract` set — `goal-task.ts` ~1118+ |
| Legacy opt-in | Test 7: no contract → no AC/qaContract; goal-task-kernel still green |
| Exposure | Verification context + QA attempt `contractHash` additive |

No behaviour regressions observed in suites run.

---

## Verdict rationale

Observation boundary intact; PM tools-off; no secrets; no paid HTTP fallback paths; unit/drill suites **33/0**. Conditions are (1) live WBS-3 proof timeout this session and (2) billing policy not enforced at send-time — both matter before claiming WBS-5/8 ready.

**PASS WITH CONDITIONS.**
