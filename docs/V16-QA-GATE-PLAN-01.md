# V1.6 QA Gate — Plan 01

Status: **FROZEN — ARCHITECTURE ONLY, NOT READY FOR IMPLEMENTATION.** This record designs a QA Gate between Worker Result and GPT PM review. It creates no runtime code, no Plan, no Task, dispatches no Worker, and changes no V1/V1.5/G4/G5/G6 behavior. It is documentation-only per its own instruction; the one code fact it depends on (`EvidenceType: 'QA'`, `EvidenceTrustLevel: 'VERIFIED'`, `EvidenceStatus: 'PASS'|'FAIL'|'INCONCLUSIVE'` already exist in `src/shared/types.ts`) was verified by reading, not by writing.

## 1. Current State

V1 is `OWNER_CERTIFIED`. V1.5 Sequential Orchestration is `OWNER_CERTIFIED`: one Owner GO drove Task A (ACCEPT) → Task B Run 1 (CHANGES) → Task B Run 2 same-Task retry (ACCEPT) → Task C (ACCEPT) → `PLAN-0001 = COMPLETED`, `TASK-0012/0013/0014 = ACCEPTED`, `workerRunCount=4`, `duplicateRuns=0`.

Two things were proven and closed in the same certification window, both durably recorded:

- **Durable completed-run recovery** (`src/backend/completed-run-recovery.ts`, `relay_pm_recover_completed_run`): a Run that finished successfully while no live capture watch observed it can be recovered through the SAME canonical `captureCompletion()`/`promoteObservedResult()` path a live observation uses, via unforgeable prompt-content transcript correlation. Dogfood-proven on the real TASK-0013 Run 2 blocker. **IMPLEMENTED.**
- **Headless Wake:** still **NOT CERTIFIED**. The only certified wake transport remains the MCP App widget/`ui-message` bridge.
- **Stable runtime supervision:** still a **FOLLOW-UP REQUIRED** item — the MCP/capture runtime has no supervisor (no systemd unit) and has already been restarted manually twice this project.

Both open items are explicitly out of scope for this plan (see §5).

## 2. Objective

Introduce a QA Gate that sits between Worker Result and GPT PM review:

```
GPT PM (frozen Task contract) → Worker → Result → deterministic checks → QA Agent
                                                         │
                                          PASS ──────────┴────────── FAIL
                                           │                           │
                                  ordinary PM Delivery          same-Task remediation
                                  GPT PM final judgment         → Worker retry → QA again
```

QA FAIL retries the current Task automatically, bounded, without ever reaching GPT PM, until either QA PASSes or the remediation budget is exhausted — at which point GPT PM receives the Result regardless, with QA context attached. This is architecture freeze only; §22 names the exact first implementation slice.

## 3. Why Now

V1.5 proved that GPT PM's own judgment loop (ACCEPT/CHANGES, same-Task retry, sequential Plan advancement) is solid and certified. The dogfood run also showed GPT spending a full review-and-CHANGES cycle on a Result that a purely mechanical check (file exists, exact content, scope) could have caught and corrected before ever reaching PM. QA is the smallest next capability that removes *mechanical* PM review load without touching PM's *judgment* authority — not parallelism, not a workflow engine, not a second orchestrator.

## 4. Scope

V1.6 adds:

- Two new durable record kinds — `QaAttemptRecord` and `QaRemediationPreparationRecord` — additive, project-local, mirroring the existing `pm-delivery.ts` / `retry-preparation.ts` storage and locking conventions exactly.
- One new Task-side, optional, frozen contract extension (`acceptanceCriteria`, `qaContract`) — Tasks that omit it behave exactly as today (QA Gate is opt-in per Task; V1.6 does not force QA onto V1/V1.5 Tasks retroactively).
- A deterministic QA evaluator (pure, sandboxed, `shell:false`) and a semantic QA Agent invocation (bounded, structured-output-only), both writing to the existing Evidence kernel using the already-reserved `EvidenceType: 'QA'`.
- One new remediation lineage, structurally parallel to but never sharing state with the existing G5 CHANGES-retry lineage.
- One additive field on the existing `relay_pm_get_verification_context` response (a bounded `qa` block) — no new PM-facing tool for the common path.
- One new narrow MCP/internal reconciliation seam (`reconcileQaGate`), mirroring `reconcileExecutionPlan`'s "explicit internal operation, not a startup daemon" posture.

V1.6 does **not** touch `capture-manager.ts`, `dispatcher.ts`, `result-bridge.ts`, `execution-plan.ts`, `execution-plan-continuation.ts`, or `retry-preparation.ts`. It inserts exactly one new decision point, described precisely in §16, into the single call site in `result-bridge.ts` (`promoteObservedResult` step 6) that currently mints the PM Delivery unconditionally.

### Domain model

```ts
// ── frozen Task-side extension (additive, optional) ──────────────────────
type AcceptanceCriterionValidationMode = 'DETERMINISTIC' | 'SEMANTIC' | 'BOTH';

interface AcceptanceCriterion {
  id: string;              // "AC-01", stable, referenced by QA output and remediation
  description: string;     // frozen at Task creation, never PM/Worker-mutable
  validationMode: AcceptanceCriterionValidationMode;
}

type DeterministicQaCheck =
  | { kind: 'fileExists'; path: string; criterionId?: string }
  | { kind: 'fileExactContent'; path: string; content: string; criterionId?: string }
  | { kind: 'diffScope'; allowedPaths: string[]; criterionId?: string }   // git status --porcelain, Relay-verified not Worker-claimed
  | { kind: 'command'; command: string; args: string[]; timeoutMs: number; expectExitCode: number; criterionId?: string };
// criterionId (optional) attributes a check to a specific AC for failedCriteria
// reporting; a check with no criterionId is a bare infrastructure/scope guard
// (e.g. diffScope) not tied to one AC.

interface QaContract {
  deterministic: DeterministicQaCheck[];
  semantic?: { qaWorkerId: string };   // NO criteriaIds — which ACs are semantic is read directly off
                                        // acceptanceCriteria[].validationMode (SEMANTIC or BOTH), never duplicated here
  maxQaRemediationAttempts?: number;   // omitted = frozen default 2 (§12)
}

// TaskRecord gains (additive, optional, absent = "no QA Gate for this Task"):
//   acceptanceCriteria?: AcceptanceCriterion[]
//   qaContract?: QaContract

// ── new durable records ───────────────────────────────────────────────────
type QaCheckStatus = 'PASS' | 'FAIL' | 'INFO' | 'BLOCKED';   // BLOCKED = the check itself could not run
                                                              // (spawn error, timeout, unreadable path) — distinct
                                                              // from FAIL, which means the check ran and answered "no"
type QaVerdict = 'PASS' | 'FAIL' | 'SKIPPED' | 'BLOCKED';

interface QaAttemptRecord {
  schemaVersion: 1;
  qaAttemptId: string;           // "QA-{taskId}-{runId}" — deterministic, one per Run, mirrors PMD-{taskId}-{runId}
  project: string;
  taskId: string;
  runId: string;                 // the IMPLEMENTATION Run being evaluated
  qaAttemptNumber: number;       // = that Run's taskRunSequence; 1:1, no separate counter
  deterministic: {
    status: QaVerdict;
    checks: Array<{ checkIndex: number; kind: DeterministicQaCheck['kind']; status: QaCheckStatus; detail: string }>;
    startedAt: string;
    completedAt: string;
    evidenceId: string;          // pointer into the Evidence kernel (EvidenceType='QA')
  };
  semantic: {
    status: QaVerdict;            // SKIPPED whenever deterministic did not PASS (FAIL/BLOCKED) — semantic never
                                   // runs in that case (non-override invariant, §8); SKIPPED also when
                                   // deterministic PASSed but no AC has validationMode SEMANTIC/BOTH
    criteria: Array<{ id: string; status: 'PASS' | 'FAIL'; note: string }>;
    qaWorkerId?: string;
    sessionRef?: string;          // disposable QA-Agent sub-run correlation, never in Task.linkedRuns
    startedAt?: string;
    completedAt?: string;
    evidenceId?: string;
  };
  finalQaStatus: QaVerdict;       // PASS | FAIL | BLOCKED (never SKIPPED at this level)
  failedCriteria: string[];       // AC ids, deterministic + semantic combined
  remediationInstruction?: string; // present only on FAIL with attempts remaining
  remediationPreparationId?: string; // set once a QaRemediationPreparationRecord is created
  createdAt: string;
  updatedAt: string;
}

interface QaRemediationPreparationRecord {
  schemaVersion: 1;
  preparationId: string;         // "QRP-{qaAttemptId}" — mirrors RTP-PMJ-{deliveryId}
  project: string;
  qaAttemptId: string;
  taskId: string;
  sourceRunId: string;           // the FAILing implementation Run
  nextAttemptSequence: number;
  status: 'RECEIVED' | 'READY' | 'FAILED';   // simpler than G5-B's 4 states — see §11
  remediationInstructionRef: string;         // logical pointer to QaAttemptRecord.remediationInstruction; never copied
  qaRemediationCountBefore: number;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  dispatchedRunId?: string;      // terminal-success bookkeeping — one prep binds at most one retry Run
  dispatchedAt?: string;
  consumedAt?: string;
}
```

Storage (mirrors `pm-deliveries/` and `retry-preparations/` exactly):

- `{dataRoot}/{project}/_relay/qa-attempts/{qaAttemptId}/{qa.json,qa.md}`
- `{dataRoot}/{project}/_relay/qa-remediation-preparations/{preparationId}/{preparation.json,preparation.md}`

Both go through the existing `relayDir()` + `writeJsonAtomic()` discipline and a per-record lock file, exactly like `pm-delivery.ts`'s `withDeliveryLock` and `retry-preparation.ts`'s per-preparation locking.

### Architectural questions — resolved

| # | Question | Answer | Authoritative section |
| --- | --- | --- | --- |
| 1 | Run-scoped or Task-scoped QA? | Run-scoped for correlation (one `QaAttemptRecord` per implementation Run, `qaAttemptId` derived from `{taskId, runId}`); the QA Agent's own execution is a disposable non-canonical sub-run, never linked into `Task.linkedRuns`. | §6, §10 |
| 2 | Where does QA state persist? | `_relay/qa-attempts/` and `_relay/qa-remediation-preparations/`, additive, same conventions as Deliveries/Retry Preparations. Run remains execution authority; QA record owns validation outcome; Task owns lifecycle/PM state — none of the three is duplicated. | §6, §13 |
| 3 | What event starts QA? | The same trusted internal call site that today calls `ensurePmDeliveryForTaskVerify` from `promoteObservedResult` step 6 — QA runs there instead, and *it* decides whether that Delivery call happens. No new Event type is required to *trigger* QA; `RUN_RESULT_RECEIVED` already fires unchanged. | §16 |
| 4 | What prevents PM Delivery before QA PASS? | `pmState` stays `PENDING` (never `VERIFYING`) until `finalQaStatus` is `PASS` or the remediation budget is exhausted/`BLOCKED`; `ensurePmDeliveryForTaskVerify` is only ever called after that gate, never unconditionally. | §8, §16 |
| 5 | How is QA remediation distinguished from GPT CHANGES retry? | Different lineage end-to-end: QA remediation never sets `pmState=CHANGES_REQUESTED`, is authorized by a `QaRemediationPreparationRecord` (`QRP-QA-…`) not a PM judgment (`RTP-PMJ-…`), and the resulting Run's `retry-context.json` carries a new `qaRemediationPreparationId` field, never `retryPreparationId`. | §8, §11 |
| 6 | How are QA retries counted? | `qaAttemptNumber` = the implementation Run's own `taskRunSequence` (no separate counter to drift out of sync); `qaRemediationCountBefore` on the preparation record is the authoritative budget counter. | §6, §12 |
| 7 | How does retry lineage work? | Identical shape to G5-C's `sourceRunId`/`retryPreparationId` linkage, field-renamed and namespace-separated (`qaRemediationPreparationId`/`sourceRunId`) so `completed-run-recovery.ts`'s existing retry-lineage check (`meta.sourceRunId` must be linked) applies unchanged to QA-driven Runs too. | §11, §14 |
| 8 | What prevents infinite QA loop? | Frozen `maxQaRemediationAttempts` (default 2) enforced when creating a new `QaRemediationPreparationRecord`; the Nth+1 attempt is refused and the Task is escalated instead. | §12 |
| 9 | What happens if QA Agent fails (errors/times out/unparseable output)? | `finalQaStatus=BLOCKED`. One bounded auto-reattempt of the *QA Agent invocation itself* is allowed (cheap, not a Worker remediation attempt, does not consume the remediation budget); a second failure escalates to GPT PM with `qa.status=BLOCKED`. Never inferred as PASS or FAIL. | §10, §12 |
| 10 | What if deterministic and semantic QA disagree? | They never vote on the same fact, so there is nothing to resolve by preference: deterministic checks mechanical facts (file/exit-code/scope) and is a **hard gate** — a deterministic `FAIL` or `BLOCKED` is final and short-circuits before semantic ever runs, regardless of what a Semantic Agent might have said. Semantic only runs after deterministic `PASS`, and for a `BOTH`-mode AC both layers must independently `PASS` — semantic can never turn a deterministic `FAIL`/`BLOCKED` into `PASS`. A genuine runtime contradiction (e.g. deterministic and semantic both ran but produced results the aggregation rule in §8 doesn't cover) is a bug, not a vote — it resolves to `BLOCKED`, never "deterministic wins" or "semantic wins" by ad hoc default. | §8, §9, §10 |
| 11 | How is QA PASS surfaced to GPT? | As an additive `qa` block in the existing `relay_pm_get_verification_context` response (status, attempt count, failed criteria if any, remediation history summary) — no new tool, no parallel PM surface. | §12, §16 |
| 12 | How does Plan continuation remain GPT-ACCEPT-only? | Unchanged: `execution-plan-continuation.ts` only ever advances on canonical `pmState=ACCEPTED`. QA never sets `ACCEPTED`, never sets `CHANGES_REQUESTED`, and while QA is pending/retrying, `executionState` cycles `RESULT_RECEIVED ⇄ READY` — a state Plan continuation already ignores (it only reacts to `ACCEPTED`). | §8, §16 |
| 13 | How does restart recovery avoid duplicate remediation? | `QaRemediationPreparationRecord.dispatchedRunId` is terminal-success bookkeeping identical to `RetryPreparationRecord`'s existing field: once set, the preparation is permanently consumed and `reconcileQaGate` never re-dispatches from it. | §11, §14 |
| 14 | What is the minimum QA Agent interface? | `{ qaWorkerId, prompt, timeoutMs } → strict structured PASS/FAIL text`, dispatched through the exact same `spawn(cmd, argv, {shell:false})` launch discipline as an implementation Worker, parsed by a narrow line-based parser — never `eval`, never free-form. | §10 |
| 15 | Future path to cheap/local QA without redesign? | `qaWorkerId` resolves through the existing `worker-registry.ts` record set (additive optional `role?: 'implementation' | 'qa'` tag), so a local-model or cheap-cloud QA worker is a new registry row, not a code change. Cost-routing itself is explicitly non-scope (§5). | §10, §18, §19 |

## 5. Non-Scope

Parallel QA; multiple QA Agents voting; adversarial red-team swarms; full browser E2E automation framework; autonomous arbitrary test generation; local-model routing; cost routing; Worker-selection optimization; multi-Worker scheduling; QA memory/learning; public onboarding; Headless Wake fix; Stable Runtime supervision. No V1, V1.5, G4/G5/G6 contract, or completed-run-recovery behavior changes.

## 6. Domain Model

Covered above (records, storage paths, and the 15 resolved architectural questions).

## 7. QA Contract

Frozen at Task creation, exactly like `scope`/`completionCriteria` today — never PM/Worker-mutable after creation, and (for Plan-owned Tasks) folded into the same scope-fingerprint hashing `computeTaskScopeFingerprint`/`computeExecutionPlanScopeFingerprint` already use, so a post-approval edit to `acceptanceCriteria` or `qaContract` is caught by the exact same "authorization fingerprint no longer matches frozen definition" mechanism `execution-plan-reconciliation.ts`'s `revalidatePlanAuthorization` already enforces (proven live in the completed-run-recovery hotfix's own test #17).

Validation rules (enforced at Task-creation, fail closed):

1. Every `qaContract.deterministic[].kind` is one of the four frozen kinds — no arbitrary/free-form check kind.
2. `command` checks carry `command`/`args` as separate fields (never a shell string), a bounded `timeoutMs` (≤ a frozen ceiling, e.g. 300000ms), and cwd is always the frozen Task `workspaceRoot` — never caller-supplied.
3. `diffScope.allowedPaths` must be a subset of (or equal to) what the Task's own `scope` text already declares — QA cannot silently broaden or narrow the Task's actual authorized scope, only verify it.
4. Every `acceptanceCriteria[]` entry declares exactly one `validationMode`: `DETERMINISTIC`, `SEMANTIC`, or `BOTH`.
   - `DETERMINISTIC` or `BOTH` → at least one `qaContract.deterministic[]` check must carry that AC's `criterionId`. A `DETERMINISTIC`/`BOTH` criterion with no attributed check is rejected at creation (an AC that nothing ever mechanically checks is not a deterministic criterion).
   - `SEMANTIC` or `BOTH` → the Task requires `qaContract.semantic.qaWorkerId` to be present; the semantic QA Agent evaluates exactly the set of ACs whose `validationMode` is `SEMANTIC` or `BOTH` — this set is *derived*, never separately re-declared, so it can never drift out of sync with `acceptanceCriteria`.
   - A `BOTH` criterion is not "the same fact checked twice" — the deterministic check verifies a mechanical fact (e.g. the file exists / a test command exits 0) and the semantic check verifies the requested *behavior/intent* is genuinely satisfied; both must independently `PASS` for that criterion to `PASS` (§8 aggregation).
5. `acceptanceCriteria` ids are unique, non-empty, and immutable once the Task exists.

There is no disjointness requirement between deterministic and semantic coverage — `BOTH` is a first-class, expected combination, not an error.

A Task with no `qaContract` has no QA Gate: `promoteObservedResult` behaves exactly as it does today (unconditional `ensurePmDeliveryForTaskVerify`). This is the backward-compatibility seam — V1/V1.5 Tasks are never retroactively QA-gated.

## 8. QA State Machine

Task keeps its existing two-axis model (`executionState` × `pmState`) **completely unchanged**. QA is a third axis that lives entirely inside `QaAttemptRecord` and is never written onto `TaskRecord`. The only Task-visible effects of QA are the *timing* of two transitions that already exist:

```
Run completes (RESULT_RECEIVED, pmState still PENDING)
        │
        ▼
   [QaAttemptRecord created — PENDING]
        │
        ▼
  DETERMINISTIC_RUNNING ──FAIL─────► finalQaStatus=FAIL     (semantic NEVER runs — hard gate, §"Non-override invariant")
        │                ──BLOCKED─► finalQaStatus=BLOCKED  (semantic NEVER runs — hard gate)
        │PASS
        ▼
  any AC with validationMode SEMANTIC or BOTH configured?
        │NO                                    │YES
        ▼                                      ▼
  finalQaStatus=PASS                    SEMANTIC_RUNNING (MANDATORY, not optional — §10)
  (no QA Agent invoked)                        │
                                    PASS ───────┼─────── FAIL ─────────── error/timeout/unparseable
                                     │                      │                        │
                            finalQaStatus=PASS    finalQaStatus=FAIL      finalQaStatus=BLOCKED
```

**Non-override invariant (mandatory):** a deterministic `FAIL` or `BLOCKED` is final. Semantic QA is never invoked once deterministic has produced `FAIL`/`BLOCKED`, and even if it somehow ran, its output could never move `finalQaStatus` away from `FAIL`/`BLOCKED`. Tests failing, a scope violation, a forbidden file modified, or a required artifact missing are all deterministic `FAIL` conditions that no Semantic Agent opinion can overturn. Deterministic infrastructure uncertainty (a check itself could not run) is `BLOCKED`, and the Semantic Agent cannot "guess through it" — it is simply never asked.

**Aggregation** (deterministic outcome × semantic outcome → `finalQaStatus`):

| Deterministic | Semantic (if invoked) | `finalQaStatus` |
| --- | --- | --- |
| `FAIL` | never invoked | `FAIL` |
| `BLOCKED` | never invoked | `BLOCKED` |
| `PASS`, no `SEMANTIC`/`BOTH` AC configured | not invoked (no LLM call) | `PASS` |
| `PASS` | `PASS` | `PASS` |
| `PASS` | `FAIL` | `FAIL` |
| `PASS` | `BLOCKED`/error/unparseable | `BLOCKED` |

A `BOTH`-mode criterion requires both its attributed deterministic check and its semantic evaluation to independently `PASS`; either one alone is not sufficient, and the table above already produces the right aggregate `finalQaStatus` for that case without a separate rule.

- `finalQaStatus=PASS` → `pmState: PENDING → VERIFYING` (the existing idempotent "ensure review state" branch already in `markResultReceived`) → `ensurePmDeliveryForTaskVerify` mints the ordinary Delivery. **Identical to today's unconditional path**, just gated.
- `finalQaStatus=FAIL` with remediation attempts remaining → **no** `pmState` transition at all (stays `PENDING`) → `executionState: RESULT_RECEIVED → READY` via the QA remediation preparation (§11) → new Run dispatched → new `QaAttemptRecord`.
- `finalQaStatus=FAIL` with remediation exhausted, or `finalQaStatus=BLOCKED` → treated the same as PASS for delivery purposes: `pmState → VERIFYING`, Delivery minted, but the verification-context `qa` block reports the failure so GPT PM reviews it knowingly (§12).

`pmState=CHANGES_REQUESTED` is **never** touched by QA — it remains exclusively GPT PM's own vocabulary (Q5).

## 9. Deterministic QA

Runs first, always, before any QA Agent inference is spent. Four frozen check kinds only:

- **`fileExists`** / **`fileExactContent`** — the same `fs.readFileSync` + exact-byte comparison pattern already proven in `completed-run-recovery.ts`'s artifact verification and in this session's own manual ACCEPT verification of `v15-b.txt`/`v15-c.txt`. No new primitive.
- **`diffScope`** — `git status --porcelain` in the frozen `workspaceRoot`, parsed and compared against `allowedPaths`. This is the Relay-verified version of what a Worker's result text today only self-reports ("git status shows only pre-existing diffs") — QA independently confirms it instead of trusting the Worker's own claim.
- **`command`** — `spawn(command, args, { cwd: workspaceRoot, shell: false, timeout: timeoutMs })`. A **completed** run whose exit code differs from `expectExitCode` is `FAIL` (the check ran and answered "no" — e.g. `npm test` genuinely failed). A spawn error, a timeout, or any exception before an exit code is observed is `BLOCKED` (the check could not determine an answer) — never silently treated as `FAIL`, and never treated as `PASS`. stdout/stderr are captured and truncated to the same bound `dispatcher.ts` already uses for launch diagnostics (`MAX_WORKER_DIAG_CHARS`-style). Never a shell string, never QA-output-driven argv — the command/args always come from the frozen `qaContract`, never from Worker output or QA Agent output.

`fileExists`/`fileExactContent`/`diffScope` follow the same FAIL-vs-BLOCKED split: a readable path that doesn't match is `FAIL`; an unreadable/inaccessible workspace (e.g. permission error, path escapes `workspaceRoot`) is `BLOCKED`.

One Evidence record per attempt: `{ type: 'QA', trustLevel: 'VERIFIED', status: PASS|FAIL|INCONCLUSIVE, source: { kind: 'qa-gate', subsystem: 'deterministic' }, details: { checks: [...] } }` (a `BLOCKED` deterministic verdict maps to the existing `EvidenceStatus: 'INCONCLUSIVE'` — no new evidence status is needed) — the same bounded-evidence convention `recordAdapterObservation` already follows (identity + verdict, not raw dumps).

Deterministic `FAIL` or `BLOCKED` is a **hard gate**: semantic QA is never invoked in either case, unconditionally (non-override invariant, §8) — this is not an inference-saving heuristic, it is a correctness requirement (a Semantic Agent must never be given the chance to appear to override a mechanical fact).

## 10. Semantic QA Agent

**Purpose.** Semantic QA answers one question a mechanical check cannot: *did the Worker actually satisfy the PM's intended Task and Acceptance Criteria?* Passing build/test/file/scope checks alone is not sufficient once any Acceptance Criterion is classified `SEMANTIC` or `BOTH` — a file can exist with the exact required bytes while still not doing what was asked (or, symmetrically, look different from a literal expectation while genuinely satisfying the intent), and only semantic evaluation can tell the difference. Semantic QA specifically evaluates: the original frozen Task intent; the `SEMANTIC`/`BOTH` acceptance criteria; whether the implementation actually fulfills the requested behavior; omissions (a requirement quietly skipped); mismatch between the Worker's claimed Result and the bounded Evidence actually available; and whether the tests/evidence cited meaningfully support the claim (not just "a test file exists").

**Invocation rule — mandatory, not optional.** Semantic QA Agent invocation is driven strictly by contract shape, never by a cost/inference-saving heuristic:

- Deterministic `FAIL` or `BLOCKED` → semantic is **never** invoked (§8 non-override invariant).
- Deterministic `PASS` and **no** `acceptanceCriteria` entry has `validationMode: SEMANTIC | BOTH` → `finalQaStatus=PASS` is produced **without** any LLM inference (this is the only path that legitimately skips the Semantic Agent).
- Deterministic `PASS` and **at least one** `acceptanceCriteria` entry has `validationMode: SEMANTIC | BOTH` → the Semantic QA Agent **MUST** run. This is not skippable, not a "may run" — a Task that declares semantic criteria always gets a genuine semantic evaluation before `finalQaStatus` can be `PASS`.

Dispatched exactly like an implementation Worker (`spawn(cmd, argv, {shell:false})`, `--print`, bounded timeout) but under a distinct Run-folder namespace `worker-qa-{qaWorkerId}/…` so it can never be confused with, or accidentally linked as, an implementation attempt — it is referenced only via `QaAttemptRecord.semantic.sessionRef`, never via `Task.linkedRuns`.

**Semantic QA Agent MUST NOT:** invent new requirements beyond the frozen Task/AC text; broaden scope; improve the product beyond what was asked; alter or reinterpret acceptance criteria; broaden the workspace/scope QA itself checks; or act as PM (it never sets `ACCEPTED`/`CHANGES_REQUESTED`, never mints or dismisses a Delivery, never advances a Plan — those remain exclusively GPT PM's and the canonical kernels' authority, §12).

**Input** (Relay-composed, bounded — same "no full transcript, no chain-of-thought" discipline `retry-prompt.ts` already documents for retry prompts):

- frozen Task prompt/goal/scope
- `acceptanceCriteria` (only the ids whose `validationMode` is `SEMANTIC` or `BOTH`)
- bounded Worker Result text (`result.md`, same truncation convention `pm-verification-context.ts` already applies for the GPT-facing view)
- bounded deterministic QA output (check ids + verdicts, not raw stdout unless a check FAILed, and even then truncated)
- bounded relevant evidence references

Never sent: the entire repository, full conversation history, GPT PM chain-of-thought, secrets, or unrelated Task history.

**Output** — strict structured text only, parsed by a narrow deterministic line parser (same tolerant-but-never-guessing style as `extract.ts`'s transcript parsing — malformed input never crashes, but also never silently resolves to PASS):

```
status: PASS
criteria:
- AC-01: PASS
- AC-03: PASS
```
or
```
status: FAIL
failedCriteria:
- AC-03
reason: <bounded free text>
remediationInstruction: <bounded free text, no new requirements>
```

Any output that fails to parse, times out, or the process errors → `finalQaStatus=BLOCKED` (Q9), with one bounded auto-reattempt of the invocation itself before escalating.

**QA Worker abstraction** (Q14/Q15): `qaWorkerId` resolves through the existing `worker-registry.ts` record set unchanged in shape, with one additive optional field `role?: 'implementation' | 'qa'` so a registry entry can be tagged without breaking existing untagged rows (`role` absent ≡ `implementation`, today's only meaning). V1.6 dogfood uses `claude-code` for both roles — a local model or cheap cloud QA worker later is a new registry row, not a code change. No cost-routing logic is added now.

## 11. QA FAIL Remediation Flow

1. Relay composes a bounded remediation prompt from **only**: the original frozen Task prompt/scope, `failedCriteria`, bounded QA evidence pointers, and `remediationInstruction` — the exact same boundedness discipline `retry-prompt.ts` already enforces for G5 retries, reused verbatim (not reimplemented).
2. Creates `QaRemediationPreparationRecord` (`QRP-{qaAttemptId}`) — `RECEIVED → READY`. Unlike G5-B's four-state machine (`RECEIVED → CHANGES_APPLIED → READY → FAILED`), QA remediation needs no `CHANGES_APPLIED` step because it never touches `pmState` — three states suffice: `RECEIVED → READY → FAILED`.
3. Transitions the Task `RESULT_RECEIVED → READY+PENDING` via the **same canonical transition** `requestTaskRetry` already performs — reused, not duplicated — but the new Run's `retry-context.json` records `qaRemediationPreparationId` (new sibling field), never `retryPreparationId`, so the two lineages are always distinguishable on disk and in `meta.json` (Q5, Q7).
4. Dispatches the same Task, same Worker binding, same workspace — a new Run, never a new Task — via the same frozen-binding dispatch path Plan-owned Tasks and G5-C retries already use.
5. The new Run completes → a new `QaAttemptRecord` (`qaAttemptNumber` = new Run's `taskRunSequence`) evaluates it independently.

`QaRemediationPreparationRecord.dispatchedRunId`/`dispatchedAt`/`consumedAt` are terminal-success bookkeeping identical to `RetryPreparationRecord`'s existing fields — once a preparation is consumed it is never re-dispatched, solving duplicate-remediation prevention without new locking primitives (Q13).

## 12. QA Retry Limit / Escalation

`maxQaRemediationAttempts = 2` (frozen default for V1.6; the field exists on `QaContract` for future configurability but V1.6 dogfood always uses 2 — no per-Task override is exercised yet).

```
Run 1 → QA FAIL #1 → remediation → Run 2
Run 2 → QA FAIL #2 → remediation → Run 3
Run 3 → QA FAIL again → ESCALATE (no Run 4)
```

Escalation triggers (any one is sufficient) — GPT PM receives the Result when:

- **A.** QA `PASS`, or
- **B.** the remediation budget is exhausted (3rd consecutive FAIL), or
- **C.** QA is `BLOCKED`/uncertain (QA Agent invocation failed twice, or a deterministic/semantic contradiction was detected).

In all three cases `pmState → VERIFYING` and `ensurePmDeliveryForTaskVerify` mints the **same ordinary Delivery** — no parallel Plan-specific or QA-specific delivery channel. The PM Review Packet (an additive `qa` block on `relay_pm_get_verification_context`'s existing response) carries: Task, current Run, `finalQaStatus`, `failedCriteria` if any, `qaAttemptNumber`, bounded Result, bounded Evidence, and a remediation-history summary (list of prior `qaAttemptId`s and their verdicts). GPT PM still decides `ACCEPT` or `CHANGES` — QA never decides for it.

## 13. Persistence

`{dataRoot}/{project}/_relay/qa-attempts/{qaAttemptId}/{qa.json,qa.md}` and `{dataRoot}/{project}/_relay/qa-remediation-preparations/{preparationId}/{preparation.json,preparation.md}` — additive directories, same `relayDir()`-rooted, `writeJsonAtomic()`-written, per-record-locked convention as `pm-deliveries/` and `retry-preparations/`. Run remains execution authority (folder/meta/prompt/result unchanged); the QA record owns only the validation verdict; the Task record owns only lifecycle/PM state. No authority is duplicated across the three.

## 14. Restart / Reconciliation

A new bounded internal operation, `reconcileQaGate(dataRoot, project, taskId)` — explicit, not a startup daemon, not an MCP surface by default (mirrors `reconcileExecutionPlan`'s own framing) — resumes from durable evidence at each of the eight named seams:

| # | Seam | Durable evidence consulted | Resolution |
| --- | --- | --- | --- |
| 1 | Result captured, deterministic QA not started | `Task.executionState=RESULT_RECEIVED`, no `qa-attempts/QA-{taskId}-{runId}` | Start deterministic QA for this Run (idempotent — deterministic checks are pure re-reads, safe to rerun) |
| 2 | Deterministic QA complete, QA Agent not started | `QaAttemptRecord.deterministic` set, `.semantic` absent, `qaContract.semantic` present | Start semantic QA once; a stale in-flight sub-run with no persisted output is treated as never-started (its disposable folder is not canonical) |
| 3 | QA Agent response persisted, remediation not dispatched | `QaAttemptRecord.finalQaStatus=FAIL`, budget remaining, no `QaRemediationPreparationRecord` for this `qaAttemptId` | Create the preparation (`RECEIVED→READY`), do not yet dispatch |
| 4 | Remediation Run materialized | `QaRemediationPreparationRecord.status=READY`, `dispatchedRunId` unset, but a Run folder already exists/linked | Adopt the existing Run — set `dispatchedRunId`/`dispatchedAt` — never spawn a second Worker (identical adoption logic to G5-C's `dispatchV1Retry`) |
| 5 | QA PASS but PM Delivery not created | `finalQaStatus=PASS`, `pmState` still `PENDING` | Apply the `PENDING→VERIFYING` transition and call `ensurePmDeliveryForTaskVerify` — both idempotent already |
| 6 | Runtime restart during QA | Any of the above, detected fresh after restart | Same per-seam resolution — QA has no in-memory-only state that isn't reconstructible from durable records, by construction |
| 7 | Duplicate QA execution | A second `reconcileQaGate` call, or a second live trigger, for the same `qaAttemptId` | `QaAttemptRecord` write is keyed by the deterministic `qaAttemptId` — a second evaluation of an already-`finalQaStatus`-set record is a no-op read, mirroring `captureCompletion`'s dedupe-key idempotency |
| 8 | Duplicate remediation trigger | Two concurrent seam-3 resolutions | `QaRemediationPreparationRecord.dispatchedRunId` terminal-bookkeeping (§11) collapses both to one dispatch, mirroring G5-C's existing "one preparation binds at most one retry Run" invariant |

Any seam where evidence is ambiguous (e.g. a QA Agent sub-run folder exists but its ownership cannot be proven — the same ambiguity class `completed-run-recovery.ts`'s `hasAmbiguousUnlinkedRunCandidate`-style check already fails closed on) resolves to **BLOCK/escalate**, never a guess. Determining whether a specific completed sub-run's transcript genuinely belongs to a given semantic-QA invocation reuses `completed-run-recovery.ts`'s own prompt-content correlation primitive, generalized to the `worker-qa-*` Run-folder namespace — this is the same tool, not a new one.

## 15. Completion Criteria

V1.6 is complete only when the exact one-Task dogfood loop in §18 runs end-to-end with zero manual intervention, the retry/escalation/persistence/reconciliation behaviors in §8–§14 are each covered by a focused fixture test, and no V1/V1.5/G4–G6/completed-run-recovery regression suite changes verdict.

## 16. QA Gate

The single insertion point is `result-bridge.ts`, `promoteObservedResult`, step 6 (currently: unconditional `ensurePmDeliveryForTaskVerify(dataRoot, project, taskId)` immediately after `markResultReceived`). The implementation slice replaces that unconditional call with:

```
if (!task.qaContract) {
  await ensurePmDeliveryForTaskVerify(dataRoot, project, taskId);   // unchanged V1/V1.5 path
} else {
  await runOrResumeQaGate(dataRoot, project, taskId, runId);        // new — owns the PENDING→VERIFYING transition itself
}
```

`runOrResumeQaGate` is exactly `reconcileQaGate`'s seam-1-through-5 logic, invoked once synchronously right after promotion instead of only on restart — restart reconciliation and the live trigger are the same function, the same way `promoteObservedResult` itself already serves both live and (via `completed-run-recovery.ts`) recovered observations.

| Test | Required assertion |
| --- | --- |
| No `qaContract` | `promoteObservedResult` behaves byte-identical to today — Delivery minted unconditionally, no `qa-attempts/` record created |
| Deterministic FAIL | no PM Delivery; `pmState` stays `PENDING`; remediation preparation created; new Run dispatched; semantic QA Agent is never invoked (assert zero sub-run folders created) |
| Deterministic BLOCKED (e.g. command spawn error) | `finalQaStatus=BLOCKED`; semantic QA Agent never invoked; Delivery minted with `qa.status=BLOCKED` (escalation, §12) — never conflated with `FAIL`'s remediation path |
| Deterministic PASS, ≥1 `SEMANTIC`/`BOTH` AC configured | semantic QA Agent **is** invoked (mandatory-invocation assertion — a test double/mock QA worker records that it was called) |
| Deterministic PASS, semantic FAIL | no PM Delivery; remediation preparation created; semantic evidence recorded even though deterministic passed; deterministic's own `PASS` is unaffected by the later semantic `FAIL` (both recorded independently) |
| `BOTH`-mode AC, deterministic PASS + semantic PASS | that AC is absent from `failedCriteria`; `finalQaStatus=PASS` |
| `BOTH`-mode AC, deterministic PASS + semantic FAIL | that AC appears in `failedCriteria`; `finalQaStatus=FAIL` — proves semantic cannot be skipped just because the deterministic half of a `BOTH` criterion passed |
| Deterministic PASS, no `SEMANTIC`/`BOTH` AC configured | `finalQaStatus=PASS` without ever invoking a QA Agent (zero sub-run folders created) |
| QA PASS | ordinary Delivery minted; `qa` block on verification context shows PASS |
| Remediation exhausted (3 FAILs) | Delivery minted on the 3rd Run despite FAIL; `qa` block shows `FAIL` + full attempt history; no 4th Run |
| QA Agent errors twice | `finalQaStatus=BLOCKED`; Delivery minted with `qa.status=BLOCKED`; no remediation Run consumed by the BLOCKED path |
| Restart at each of the 8 seams in §14 | resumes exactly once from durable state; no duplicate Run, Event, Delivery, or QA record |
| Duplicate `reconcileQaGate` call | second call is a bounded no-op |
| Plan interaction | QA FAIL/PASS alone never changes `ExecutionPlan.activeTaskId`; only the eventual GPT ACCEPT does (regression against `execution-plan-continuation.ts`) |
| Contract validation | a `DETERMINISTIC`/`BOTH` AC with no attributed `criterionId` check, a `SEMANTIC`/`BOTH` AC with no `qaContract.semantic.qaWorkerId`, non-frozen check kind, shell-string command, or out-of-scope `diffScope.allowedPaths` are all rejected at Task creation |
| V1/V1.5/G4–G6 regression | full existing suite list from the V1.5 QA Gate (§8 of `V15-SEQUENTIAL-TASKS-PLAN-01.md`) plus `test:completed-run-recovery` stay green |

## 17. Dogfood Ready Gate

Do not start dogfood until: build/typecheck PASS; every §16 focused test PASS; the full V1/V1.5/G4–G6/completed-run-recovery regression list PASS; the restored MCP runtime is healthy (`/health` 200, `tools/list` includes no unintended new public surface beyond what §16 lists); and the exact disposable one-Task dogfood contract below is prepared (not created) in advance.

## 18. Dogfood Pass Gate

One Owner GO, one Task, real `claude-code` Worker **and** real `claude-code` QA Worker — the dogfood must prove Semantic QA actually participates, so the FAIL/PASS distinction is deliberately placed on the *semantic* side, not the deterministic side (a purely deterministic exact-content check would never let semantic run at all, per the non-override invariant in §8 — that would only prove the FAIL path skips semantic, never that semantic can decide PASS/FAIL on its own):

- `acceptanceCriteria`:
  - `AC-01` (`validationMode: DETERMINISTIC`) — "the file `.g6-dogfood/v16-qa.txt` exists and no other file is touched."
  - `AC-02` (`validationMode: SEMANTIC`) — "the file's content expresses that the task status is correct/accepted, not incorrect/wrong."
- `qaContract.deterministic = [{kind:'fileExists', path:'.g6-dogfood/v16-qa.txt', criterionId:'AC-01'}, {kind:'diffScope', allowedPaths:['.g6-dogfood/v16-qa.txt']}]` — deliberately **not** `fileExactContent`, so deterministic QA can `PASS` on both Runs and semantic genuinely decides FAIL vs. PASS.
- `qaContract.semantic = { qaWorkerId: 'claude-code' }`.

| Step | Contract |
| --- | --- |
| Worker Run 1 (intentional) | writes `V16_QA\nstatus=wrong` |
| Deterministic QA on Run 1 | `fileExists` PASS, `diffScope` PASS → deterministic `PASS` |
| Semantic QA on Run 1 (mandatory — AC-02 is `SEMANTIC`) | evaluates content `status=wrong` against AC-02 → `FAIL` → `finalQaStatus=FAIL` → no PM Delivery → remediation preparation `QRP-QA-TASK-…-{run1}` created |
| Worker Run 2 (remediation) | same Task, same binding, same workspace; writes `V16_QA\nstatus=correct` |
| Deterministic QA on Run 2 | `fileExists` PASS, `diffScope` PASS → deterministic `PASS` |
| Semantic QA on Run 2 (mandatory) | evaluates content `status=correct` against AC-02 → `PASS` → `finalQaStatus=PASS` → ordinary Delivery minted |
| GPT PM | reviews via the same `relay_pm_get_verification_context` + `relay_pm_submit_judgment` flow used for the real V1.5 dogfood ACCEPTs → ACCEPT |

Required exact counters: `ownerGoCount=1`, `workerRunCount=2`, `qaEvaluationCount=2`, `semanticQaEvaluationCount=2`, `qaFailCount=1`, `qaPassCount=1`, `manualQaRetry=0`, `manualResultCopyPaste=0`, `manualWorkerRedispatch=0`. `semanticQaEvaluationCount=2` (equal to `qaEvaluationCount`) is itself the proof that Semantic QA is mandatory-when-configured rather than an optional/best-effort step (§10) — every deterministic `PASS` triggered a real semantic invocation, not zero and not just one. `BOTH`-mode validation is exercised by the fixture unit tests in §16, not by this minimal one-Task dogfood; a richer future dogfood may add a `BOTH` criterion without changing this contract's shape.

## 19. Metrics

Persist/log only safe logical identities and timestamps, extending the existing V1.5 metrics list: `qaAttemptId`/`taskId`/`runId` per attempt; `finalQaStatus` transitions; `qaAttemptNumber` at PASS/FAIL/BLOCKED; whether semantic QA was invoked for the attempt (`semanticQaEvaluationCount`) and its independent verdict; remediation-preparation create/dispatch/consume events; elapsed time per deterministic check and per semantic invocation; `qaWorkerId` used. No Worker/QA-Agent chain-of-thought, no raw command stdout beyond the bounded truncated excerpt already specified in §9.

## 20. Decision Rule

Pass only if every state-machine transition in §8, every seam in §14, and the exact dogfood counters in §18 hold with zero manual QA retry, zero manual redispatch, and zero GPT PM delivery before `finalQaStatus` is decided. Any duplicate Run, any Delivery minted before QA resolves, any QA-driven `pmState=ACCEPTED` or `CHANGES_REQUESTED`, any Plan advancement not caused by a real GPT ACCEPT, or any unresolved ambiguity is a fail/block — not a partial pass.

## 21. Final Receipt

The eventual implementation/dogfood receipt must report: every new record's schema and one real example on disk; the exact Run/QA-attempt/preparation ID chain for both Runs; the `finalQaStatus` transition trace; byte-for-byte artifact checks; all §18 counters; full regression results (V1/V1.5/G4–G6/completed-run-recovery); and an explicit statement that no existing certified behavior changed verdict.

## 22. Next Step

Architecture is frozen; **do not implement broadly**. The first and only implementation slice to start next is a **standalone QA record kernel**, isolated exactly the way V1.5 Slice 1 isolated the Plan kernel: `QaAttemptRecord`/`QaRemediationPreparationRecord` types, validation, atomic persistence, per-record locking, and unit tests — with **no** wiring into `result-bridge.ts`, no deterministic evaluator, no QA Agent dispatch, and no MCP surface yet. Only after that kernel's own focused tests pass should the deterministic evaluator (Slice 2), then the semantic QA Agent dispatch (Slice 3), then the `result-bridge.ts` insertion point + `reconcileQaGate` (Slice 4), then the additive verification-context `qa` block (Slice 5), and finally the one-Task dogfood (Slice 6) proceed — each gated on the previous slice's tests, exactly as V1.5 was sliced.

Final status:

## V16_QA_GATE_PLAN_FROZEN_READY_FOR_IMPLEMENTATION
