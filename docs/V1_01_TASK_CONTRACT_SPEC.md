# V1-01 — TASK_CONTRACT v1 (implementation spec; PM-authored 2026-09-16)

Goal: every canonical Task carries a frozen `TASK_CONTRACT v1` whose `contract_hash` is the single reference used by the Builder prompt, the QA gate (QA_PACKET v1), the PM final-gate packet (PM_FINAL_GATE_PACKET v1) and the imported PM_JUDGMENT v1. Criteria cannot change mid-Task; a change is a new `contract_revision` with a new hash and is only allowed before dispatch (or through an explicit Owner-gated re-contract, out of V1 scope).

## Shape (persisted on the Task record as `contract`, additive; existing fields untouched)
```jsonc
{
  "schema_version": "task-contract.v1",
  "project": "<canonical project>",
  "task_id": "TASK-xxxx",
  "goal": "<frozen goal text>",
  "bounded_scope": "<frozen scope text>",
  "acceptance_criteria": [ { "id": "AC-01", "description": "...", "validationMode": "DETERMINISTIC|SEMANTIC|BOTH" } ],   // = existing acceptanceCriteria
  "required_evidence": [ "test output", "diff --stat", "..." ],
  "qa_route": { "deterministic": [ ...existing qaContract.deterministic ], "semantic": { "qaWorkerId": "claude-code" } },   // = existing qaContract
  "retry_policy": { "same_task_only": true, "max_qa_remediations": 2, "max_pm_changes": 2 },
  "owner_gate_conditions": [ "public exposure", "credential", "destructive op", "scope change", "product direction" ],
  "contract_revision": 1,
  "contract_hash": "<sha256 of canonical JSON of all fields above except contract_hash>"
}
```
- Built by `createTask` when `contract` input is provided (or derived from `goal/scope/acceptanceCriteria/qaContract` + defaults when `contractDefaults` requested); validated (`validateTaskContract`), hashed (`computeContractHash` — stable key order, no whitespace, UTF-8).
- Frozen: any attempt to mutate contract fields after the first dispatch is rejected (`CONTRACT_FROZEN`); `refreshTaskReadiness` and dispatch prompts embed `contract_hash`.
- Exposure: `getTask()` returns it; `getVerificationContextForDelivery` includes `contract` + `contract_hash`; QA gate passes `contract_hash` into the QA attempt record snapshot (additive field) and the semantic prompt header; the exporter's packet includes it; the importer requires judgment `contract_hash` == current.

## Tests (test/v1-task-contract.test.mjs, disposable dataRoot)
1. createTask with contract → persisted, hash stable across re-read; 2. same inputs different key order → same hash; 3. any field change → different hash and revision bump only via the explicit pre-dispatch update path; 4. mutation after dispatch → CONTRACT_FROZEN; 5. verification context exposes contract + hash; 6. QA attempt snapshot carries contract_hash; 7. tasks without contract behave exactly as before (opt-in).
