# WBS-4 … WBS-8 — Role loop orchestrator on top of existing machinery (implementation spec; from issue #6; PM-authored)

Principle: the loop is a rules/state machine over EXISTING canonical records; no new Task store. New module `src/orchestrator/role-loop.ts` + CLI `dist/server/orchestrator/main.js --dataRoot --project --role-config <path> --once|--poll-ms --audit-dir --state-file`.

## WBS-4 — TASK_CONTRACT v1 (docs/V1_01_TASK_CONTRACT_SPEC.md is the field spec)
- `src/backend/task-contract.ts`: `buildTaskContract(input)`, `computeContractHash(contract)` (canonical JSON, sorted keys, sha256), `validateTaskContract`, `freezeCheck(task, incomingContract)` → CONTRACT_FROZEN unless `contract_revision` bump with `revision_reason` persisted BEFORE further execution (revision record under `_relay/task-contracts/<task>/rev-N.json`).
- Persisted on the Task as `contract` via `goals.createTask({... contract})` (additive field); `acceptanceCriteria`/`qaContract` on the Task are derived FROM the contract (single source): acceptance_criteria → acceptanceCriteria; qa_route → qaContract; so the existing QA gate works unchanged.
- The Builder prompt (existing dispatch prompt composer) and the QA semantic prompt get `contract_hash` in their headers (additive lines).

## WBS-5 — PM bootstrap / planning loop
- `buildPmBootstrapPacket(dataRoot, project, roleConfig)` = bounded text: project SSOT refs (goal title/statement), current WBS/goal (from the Goal record + a durable `_relay/pm-context/<project>.md` the Owner/PM writes — NOT chat memory), durable decisions (same file, section), current/previous accepted Task (from tasks), relevant evidence refs (last accepted result), Owner locks (from role config `ownerGateConditions`). Include `contextHash`.
- Send via RoleRuntimeAdapter (pm) with `system` = PM instruction contract (docs/GPT_PM_INSTRUCTION_CONTRACT.md adapted: output MUST be one fenced block `PM_TASK_DECISION v1` YAML/JSON: decision CREATE_TASK|CHANGES|OWNER_REQUIRED|PROJECT_COMPLETE; task_contract (TASK_CONTRACT v1 fields when CREATE_TASK); reason).
- Parse strictly (`parsePmTaskDecision`); invalid → INVALID_STRUCTURED_OUTPUT → re-ask once with the validation error; still invalid → BLOCKED (no canonical mutation). CREATE_TASK → WBS-4 createTask (contract, AC, qaContract) → WBS-6 dispatch. PROJECT_COMPLETE/OWNER_REQUIRED → stop truthfully, audit.

## WBS-6 — Builder dispatch / Result capture (existing)
- Dispatch = existing `v1-dispatch.dispatchV1OwnerApproved` through the actl-managed Codex worker (same path as the PM driver), prompt = frozen TASK_CONTRACT rendering (goal, bounded_scope, acceptance_criteria, required_evidence, contract_hash, attempt N, and for retries the criterion-specific failures). Result capture = existing result-bridge; duplicate completion already idempotent (assert in tests); runtime crash → existing FAILED/BLOCKED semantics (assert).
- Collect budget: reuse `resumeActlManagedCollect` loop semantics (the PM driver's) inside the orchestrator with bounded retries.

## WBS-7 — Automatic QA gate (existing V1.6, wired)
- On RESULT_RECEIVED for a contract Task: `runOrResumeQaGate` already runs deterministic + semantic QA (qaWorkerId from qa_route; V1 default `claude-code`), FAIL ⇒ QRP same-Task remediation Run (Builder redispatch — verify it dispatches through the same actl worker; if the existing remediation dispatch targets the claude-code worker path instead of the Task's Builder worker, adapt via the registered Builder worker id in the contract), PASS ⇒ pending PM Delivery.
- `QA_PACKET v1` / `QA_RESULT v1` are projections of the existing QaAttemptRecord (render functions `renderQaPacket(attempt, contract)` / `renderQaResult(attempt)` for the audit and the PM final packet); overall PASS|CHANGES(=FAIL)|BLOCKED.
- Certification requires attempt-1 QA CHANGES → attempt-2 QA PASS: the disposable Task uses the V16 DOGFOOD PROTOCOL pattern (first attempt intentionally violates a SEMANTIC criterion) with a real Builder run.

## WBS-8 — PM final gate (direct PM runtime call; no external wake)
- Trigger: pending TASK_VERIFY Delivery for a Task whose latest QA attempt is PASS (or non-QA legacy task).
- `buildPmFinalGatePacket` = contract + contract_hash, Result (bounded summary), QA criterion matrix (from the QA attempt), evidence refs, retry history (linkedRuns + QRP/RTP lineage), current canonical state, allowed actions (ACCEPT, CHANGES, OWNER_REQUIRED, ACCEPT_AND_NEXT only if the Goal/WBS has an authorized next step), contextHash.
- Send to pm adapter; parse `PM_JUDGMENT v1` (decision ACCEPT|CHANGES|OWNER_REQUIRED|ACCEPT_AND_NEXT, retry NONE|SAME_TASK, reason, contract_hash, context_hash, next_task_contract?). Apply ONLY after re-reading canonical state (task/run/result/delivery/contract_hash/context_hash equality; latest QA still PASS; no newer run) → `submitPmJudgment` (ACCEPT/CHANGES) [+ AR-04 reconcile] → CHANGES+SAME_TASK → `prepareRetryForJudgment` → existing retry dispatch → loop; ACCEPT_AND_NEXT → validate next TASK_CONTRACT v1 → createTask → WBS-6 dispatch (only inside the authorized Goal scope: same goalId; else OWNER_REQUIRED). Audit JSONL for every step (no secrets). Idempotent: per-delivery state; duplicates → REPLAY_IGNORED.

## Tests (disposable dataRoot; fake pm adapter with scripted outputs; real QA gate with a fake QA worker command that returns scripted `status:` output; fake Builder = a scripted worker that writes files)
WBS-4: hash stability/freeze/revision. WBS-5: bootstrap packet bounded + parse valid/invalid/re-ask/BLOCKED. WBS-7: QA FAIL → remediation → PASS → Delivery minted (drive with scripted QA outputs). WBS-8: ACCEPT applies once; CHANGES → same-Task retry preparation; ACCEPT_AND_NEXT creates+dispatches next task only within scope; stale hash/context → fail closed; duplicate judgment → REPLAY_IGNORED; restart between QA and PM resumes. Zero live-dataRoot writes.
