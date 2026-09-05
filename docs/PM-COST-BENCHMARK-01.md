# PM Cost Benchmark 01

Status: PREPARED — execution is blocked until the Dogfood Ready Gate passes.
Scope freeze: V1 remains `OWNER_CERTIFIED`; this document creates no Relay Task, dispatches no Worker, and changes no V1 behavior.

## 1. Current State

The certified V1 path is Owner GO -> ChatGPT PM -> Agent Relay -> Claude Code -> Result Capture -> PM Delivery -> MCP Widget Wake -> PM judgment -> (when CHANGES) automatic same-Task retry -> ACCEPT. `TASK-0008` is the certification evidence, not a benchmark input. Its counters are fixed as supplied: ownerGoCount=1, manualResultCopyPaste=0, manualContinue=0, manualRetryGo=0, browserExtension=0, openAiApiPm=0.

## 2. Objective

Measure the native ChatGPT Work/Codex usage consumed when GPT performs only PM actions and Claude Code performs implementation. Never estimate or invent a token count: preserve the exact native usage unit displayed by the Owner.

## 3. Why Now

V1 is certified. Before V1.5 or multi-worker work, the product needs evidence about whether a Work-hosted PM is economically practical.

## 4. Scope

Prepare and later run B1 and B2 through the existing certified V1 path. Record PM-only usage, PM turns/wakes/judgments, run/result sizes, timing, interventions, and failures. B3 is a future protocol only.

## 5. Non-Scope

No V1 reopening; no V1.5 implementation; no task dispatch in this preparation; no G4/G5 or wake change; no Browser Extension; no OpenAI API PM; no changes to Agent Relay product code or Owner `.gitignore`; no modification of TASK-0005, TASK-0006, TASK-0007, or historical evidence.

## 6. Implementation Plan

1. Owner captures native ChatGPT Work/Codex usage before a benchmark.
2. PM creates exactly the one benchmark Task Contract below and dispatches it only after an explicit Owner GO.
3. Relay/Worker execute the existing path; PM reads only the Verification Context needed for the judgment.
4. Owner captures native usage after the terminal ACCEPT or classified failure.
5. Record the metrics schema verbatim, then classify the observed cost without converting native units to tokens.

### B1 — MINIMAL PM (executable after gates)

**Task Contract (create only at dogfood time):** In a new disposable, local, no-network workspace, create `pm-cost-benchmark/B1/result.txt` containing exactly `B1_ACCEPTED\n`. Do not read or modify Agent Relay source, the data root, or any file outside that disposable workspace. In the Worker final result, return exactly `B1_ACCEPTED` and the relative artifact path `pm-cost-benchmark/B1/result.txt`.

**Expected path:** Owner GO -> one Worker Run -> one Result -> one automatic GPT wake -> one Verification Context inspection -> one ACCEPT.

**Verification:** byte-for-byte artifact equals `B1_ACCEPTED\n`; captured final result contains only the expected marker and relative path. Expected result payload is bounded to 128 characters.

### B2 — RETRY PM (executable after gates)

**Task Contract (create only at dogfood time):** In a new disposable, local, no-network workspace, first create `pm-cost-benchmark/B2/result.txt` containing exactly `B2_RUN_1_NEEDS_CHANGES\n` and return exactly `B2_RUN_1_NEEDS_CHANGES` plus the relative path. The predeclared PM CHANGES instruction is: `Replace the complete file pm-cost-benchmark/B2/result.txt with exactly B2_RUN_2_ACCEPTED followed by one newline. Return only B2_RUN_2_ACCEPTED and that relative path.` On the same-Task automatic retry, perform that instruction.

**Expected path:** Owner GO -> Run 1 -> Result 1 -> one automatic GPT wake -> one Verification Context inspection -> one CHANGES -> automatic same-Task retry -> Run 2 -> Result 2 -> one automatic GPT wake -> one Verification Context inspection -> one ACCEPT.

**Verification:** Run 1 artifact is exactly `B2_RUN_1_NEEDS_CHANGES\n` before judgment; final artifact is byte-for-byte `B2_RUN_2_ACCEPTED\n`. Each Worker result is bounded to 128 characters.

### B3 — MULTI-RESULT PM (future protocol; not executable in this benchmark)

**Blocker:** Current V1 certification proves one Task and its same-Task retry loop. It does not certify a 3–5 result queue, batch PM judgment, or multi-task sequential behavior. Running B3 now would either create un-certified multi-task behavior or conflate multiple separate B1/B2 runs with a batch-review claim.

**Future protocol after the required product certification:** prepare 3–5 independently scoped disposable Tasks with distinct fixed marker files; make each Result available without PM judgment; then measure one bounded PM review cycle per delivery and any batch judgment mechanism separately. Preserve each delivery/run identity and never infer that one ACCEPT covers another Task. B3 remains non-executable until that capability and its observation semantics are certified.

## 7. Completion Criteria

This preparation is complete when this scope is frozen; B1/B2 expected artifacts and result bounds are defined; B3 is explicitly blocked rather than implemented; the metric schema, native-usage capture steps, failure classes, intervention rules, and gates are recorded.

## 8. QA Gate

Before dogfood, require all of: build PASS; relevant V1 regression PASS; Claude authentication PASS; observation path PASS; local MCP App PASS; public Tunnel/endpoint PASS; Widget mount PASS; no pending blocker; B1/B2 Task Contracts ready; and the BEFORE/AFTER capture procedures ready. B3 is excluded because it is a future protocol, not a B1/B2 execution prerequisite.

## 9. Dogfood Ready Gate

All QA conditions above must be true. The Owner must use one unchanged ChatGPT Work/Codex conversation/session for each benchmark, capture BEFORE immediately before Owner GO, and capture AFTER immediately after terminal ACCEPT or a terminal classified failure. Do not dispatch while any predicate is false.

## 10. Dogfood Pass Gate

B1 passes only with one run, one wake, one ACCEPT, zero CHANGES, exact artifact, no prohibited intervention, and recorded native usage delta. B2 passes only with two runs, two wakes, one CHANGES, one automatic same-Task retry, one ACCEPT, exact final artifact, no manual retry GO, and recorded native usage delta. A passing functional loop without native BEFORE/AFTER evidence is an incomplete cost benchmark.

## 11. Metrics

Create one immutable record per benchmark run using this schema. `nativeUsageUnit`, `nativeUsageBefore`, `nativeUsageAfter`, and `nativeUsageDelta` are copied from the ChatGPT UI exactly; token fields stay null unless the UI itself displays tokens.

```json
{
  "benchmarkId": "B1|B2|B3-FUTURE",
  "runDateTimeKst": "ISO-8601",
  "chatgptSurface": "Work|Codex|exact UI label",
  "nativeUsageUnit": "exact displayed unit",
  "nativeUsageBefore": "exact displayed value",
  "nativeUsageAfter": "exact displayed value",
  "nativeUsageDelta": "after-minus-before in the same native unit, or NOT_COMPUTABLE",
  "pmAssistantTurnCount": 0,
  "automaticWakeCount": 0,
  "workerRunCount": 0,
  "judgmentCount": 0,
  "acceptCount": 0,
  "changesCount": 0,
  "verificationContextCharacters": [0],
  "verificationContextTokenEstimate": [null],
  "tokenEstimateMethod": "null unless a declared, reproducible local estimator is used",
  "workerResultCharacters": [0],
  "elapsedWallClockSeconds": 0,
  "ownerInterventions": [],
  "manualCopies": 0,
  "manualContinues": 0,
  "manualRetryGo": 0,
  "workerFailures": [],
  "relayFailures": [],
  "hostFailures": [],
  "artifactVerification": "PASS|FAIL|NOT_RUN",
  "evidenceRefs": ["native-before screenshot/value", "native-after screenshot/value", "Relay logical IDs only"]
}
```

Count a PM assistant turn only when GPT emits a benchmark PM action or judgment, excluding Owner usage-capture messages. Count an automatic wake only when the widget/host receives a successful Relay wake; do not count polling. Character counts use the exact serialized Verification Context and Worker result captured for that run. A token estimate is optional, clearly labeled, and never substituted for native usage.

### Failure classification and intervention rules

- **Worker failure:** Claude launch, execution, or declared artifact/result failure.
- **Relay failure:** dispatch, binding, observation, capture, delivery, retry, or judgment persistence failure.
- **Host failure:** ChatGPT Work/Codex session, connector, widget mount/wake, or native-usage display/capture failure.
- **Owner intervention:** record every Owner action beyond the one GO and required two usage captures. Manual copy/paste, Continue, and retry GO each increment their separate counters. Any manual retry GO invalidates B2's certified-loop comparison; do not silently repair or rerun under the same record.

### Native usage measurement audit

The Agent Relay host can observe Relay records (runs, deliveries, judgments, bounded contexts/results) and its own health. It cannot read a ChatGPT account, plan allowance, Work credits, UI percentage, token balance, or the Owner's screenshots. Therefore it cannot autonomously report ChatGPT usage numbers.

**Exact Owner BEFORE procedure (one interaction):**

1. In the exact ChatGPT Work/Codex session to host the benchmark, open the product's visible usage/allowance indicator without changing plan, model, or session.
2. Capture a screenshot that includes the displayed value/unit and local timestamp; if the UI supplies text only, copy the exact displayed value and unit into the benchmark record instead.
3. Return to the same session. Record `nativeUsageBefore` verbatim. Do this immediately before the single Owner GO; do not send unrelated prompts between capture and GO.

**Exact Owner AFTER procedure (one interaction):**

1. Immediately after terminal ACCEPT, or a terminal classified failure, open that same visible usage/allowance indicator.
2. Capture a matching screenshot/value and timestamp in the same native unit.
3. Record `nativeUsageAfter` verbatim and compute a delta only when the UI's unit is ordinal and comparable. Otherwise record `NOT_COMPUTABLE`; never manufacture tokens or credits.

## 12. Decision Rule

No numeric threshold is set before the native unit is observed. After at least three comparable B1 and three comparable B2 samples in one stable native unit, the Owner sets thresholds from observed deltas and expected result volume: document the median, upper observed range, and the projected per-result cost for 3 and 5 reviews. Then freeze numeric GREEN/YELLOW/RED cutoffs in a follow-up decision record.

- **GREEN:** the frozen observed PM cost is sufficiently small for the projected 3–5-result workload; Work remains primary PM Host.
- **YELLOW:** cost is meaningful but manageable; next work is PM Wake Compression, Verification Context Compression, then Batch Judgment.
- **RED:** cost is too high for the projected multi-worker workload; next priority is PM HOST INDEPENDENCE before V1.5.

## 13. Final Receipt

Preparation receipt must state the observed native unit (or that it was unavailable), B1/B2 metrics, artifact verdicts, all interventions/failures, and the GREEN/YELLOW/RED decision. It must distinguish B3 as future-only until separately certified.

## 14. Next Step

Do not dispatch. Restore and prove Claude authentication, then complete the remaining Dogfood Ready predicates. Once every predicate passes, capture B1 BEFORE usage evidence and wait for the Owner's explicit GO.

## Master Roadmap

`V1 -> PM Cost Benchmark -> conditional Cost Architecture / PM Host Independence -> V1.5 Sequential Tasks -> V2 History/Resume -> V2.5 Sub-Agent -> Parallel Multi-Worker -> Cost-Aware Orchestration -> Stable PM Runtime`
