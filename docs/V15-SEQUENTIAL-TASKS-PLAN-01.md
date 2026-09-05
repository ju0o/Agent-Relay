# V1.5 Multiple Sequential Tasks — Plan 01

Status: **FROZEN — READY FOR IMPLEMENTATION.** This is the V1.5 SSOT. It is architecture and test planning only: it creates no Plan or Task, dispatches no Worker, and does not change V1, G4/G5, or the certified Chat MCP wake path.

## 1. Current State

V1 is `OWNER_CERTIFIED`. Its certified Task/Run contract remains authoritative: GPT Normal Chat -> Agent Relay MCP -> Worker -> Result Capture -> PM Delivery -> MCP `ui/message` wake -> PM ACCEPT or CHANGES -> same-Task automatic retry.

The current primary PM architecture is frozen as:

`GPT NORMAL CHAT <-> Agent Relay MCP <-> Worker Agent`

CHAT B1 completed one Run, one automatic wake, and ACCEPT with a **0 percentage-point change in the displayed Work/Codex allowance meter**. CHAT B2 (`TASK-0011`) completed Run 1 -> CHANGES -> canonical same-Task retry -> Run 2 -> ACCEPT with two automatic wakes and the same displayed-meter result. B2 supplied counters are `ownerGoCount=1`, `workerRunCount=2`, `automaticWakeCount=2`, `manualResultCopyPaste=0`, `manualContinue=0`, `manualRetryGo=0`, and `conversationMode=CHAT`. These are displayed-meter observations, not token measurements.

## 2. Objective

Prove one bounded Owner GO can execute a frozen ordered Plan of pre-approved Tasks strictly one at a time. The successor starts automatically only after the predecessor's canonical ACCEPT. CHANGES remains a retry of the current Task; it cannot advance the Plan.

## 3. Why Now

Normal Chat is the confirmed primary PM Host, and the V1 retry loop is certified. The smallest next capability is sequential execution, not parallel scheduling, a workflow engine, or a replacement PM host.

## 4. Scope

V1.5 adds one durable **Execution Plan** record above existing Tasks, a narrowly scoped plan-continuation authority, deterministic reconciliation, and focused tests for an ordered sequence. Every Plan step references an existing canonical Task; Task, Run, Delivery, Judgment, Evidence, and Wake records stay authoritative for their respective lifecycles.

### Domain model

`ExecutionPlan` is a bounded, ordered sequence—not a general DAG/workflow engine.

```ts
type ExecutionPlanState =
  | 'PLANNED'     // frozen definition; no Owner GO yet
  | 'RUNNING'     // one Owner GO recorded; one active Task may progress
  | 'BLOCKED'     // conservative stop; explicit Owner recovery required
  | 'COMPLETED'   // every declared Task is ACCEPTED
  | 'FAILED'      // a Task terminally failed; no successor can start
  | 'CANCELLED';  // Owner terminal cancellation; no successor can start

interface ExecutionPlanRecord {
  schemaVersion: 1;
  planId: string;                       // PLAN-0001, monotonic within project
  project: string;
  title: string;
  orderedTaskIds: string[];             // immutable, unique, minimum length 2
  taskBindings: Array<{
    taskId: string;
    workerId: string;
    workspaceRoot: string;
  }>;
  state: ExecutionPlanState;
  activeTaskId?: string;                // sole durable sequence cursor
  authorization?: {
    authorizationId: string;
    approvedAt: string;
    approvedBy: 'OWNER';
    planScopeFingerprint: string;
    taskScopeFingerprints: Record<string, string>;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  terminalAt?: string;
  terminalReason?: string;
  block?: { code: string; reason: string; at: string; taskId?: string };
}
```

Storage is additive and local-first: `{dataRoot}/{project}/_relay/plans/{planId}/plan.json`, written through the existing same-directory atomic JSON-write discipline. A companion immutable `plan.md` is a human-readable projection, not a second authority. Plan event/audit records must be append-only and refer to `planId`, `taskId`, and `runId`; they never replace canonical Task/Run/PM records.

`activeTaskId` is the only persisted cursor. The next index is derived from `orderedTaskIds`; task state and linked Runs remain canonical truth. The plan stores task binding because V1 Tasks do not authoritatively store the pre-approved Worker/workspace dispatch context. It stores scope fingerprints as approval evidence, not copied Task content.

### Frozen invariants

1. One Owner GO authorizes one bounded Plan only.
2. V1.5 Tasks execute strictly in declared order.
3. At most one Plan Task is active at any time.
4. Only canonical ACCEPT advances the cursor.
5. CHANGES never advances the cursor.
6. A retry remains the same Task with a new Run.
7. A failed or blocked Task never silently starts its successor.
8. Frozen Plan scope, Task fingerprints, Worker, and workspace bindings cannot expand during continuation.
9. A valid Plan continuation needs no second Owner GO.
10. Existing V1 single-Task semantics remain unchanged and compatible.
11. PM Delivery identity remains Task/Run based and automatic Chat wake remains the certified MCP path.

### Plan state machine

| From | To | Authority and condition |
| --- | --- | --- |
| `PLANNED` | `RUNNING` | one Owner GO atomically freezes authorization evidence, sets the first Task as active, then attempts that Task's authorized dispatch |
| `RUNNING` | `RUNNING` | current Task ACCEPT causes a durable cursor advance to the next declared Task; retry leaves the same cursor |
| `RUNNING` | `COMPLETED` | every declared Task has canonical `pmState=ACCEPTED` |
| `RUNNING` | `BLOCKED` | uncertainty or explicit host/capture/delivery/transport failure; no successor dispatch |
| `RUNNING` | `FAILED` | active Task is canonically `FAILED`; no successor dispatch |
| `RUNNING` | `CANCELLED` | explicit Owner cancellation only; PLANNED/BLOCKED cancellation authority remains deferred |
| `BLOCKED` | `RUNNING` | explicit Owner recovery after the recorded blocker is resolved and reconciliation proves the active Task is safe |

`COMPLETED`, `FAILED`, and `CANCELLED` are terminal for V1.5. There is no Plan `READY` state: a frozen Plan is `PLANNED`, and the single Owner GO is the only transition that authorizes continuation.

## 5. Non-Scope

No parallel Tasks, DAG scheduling, Sub-Agents, multiple concurrent Workers, arbitrary workflows, cheap/local PM, GitHub deferred PM, Browser Extension, API PM, public onboarding, or stable production tunnel infrastructure. No V1 semantics, G4/G5 contract, or Chat wake semantics are changed.

## Pre-QA Gate

**PASS (architecture freeze only).** Scope, domain model, states, authorization, sequencing invariants, failure behavior, persistence strategy, backward compatibility, QA matrix, and dogfood contract are all specified in this record. No implementation QA has run because no V1.5 runtime code exists yet.

## 6. Implementation Plan

### Authorization and scope contract

One Owner GO authorizes exactly one `PLANNED` Plan and only its immutable `orderedTaskIds`, per-Task Worker/workspace bindings, and captured task/plan scope fingerprints. It does not grant general OWNER_IPC authority, mutate a Goal permission policy, or authorize any Task outside the Plan.

At Plan creation/freeze, validate all of the following before it can accept GO:

- every referenced Task exists in the same project;
- IDs are unique and each Task belongs to the declared bounded Plan scope;
- Task 1 has no in-plan predecessor; each later Task declares its immediate predecessor as a dependency; no external/unapproved dependency is permitted;
- every Task is `PLANNED` with `pmState=PENDING`, no linked Run, and its fingerprint matches the frozen snapshot;
- every binding has a registered Worker and an existing absolute workspace root;
- no referenced Task belongs to another active Plan.

The continuation dispatcher is a new trusted internal path, distinct from `dispatchV1OwnerApproved`. Before every dispatch it must verify: Plan is `RUNNING`; target equals `activeTaskId`; target is the next non-ACCEPTED declared Task; predecessors are ACCEPTED; binding and fingerprints still match authorization; target is canonically `READY`; and no linked active Run exists. It dispatches only that exact binding. It cannot accept caller-supplied worker, workspace, task, or broadened scope.

### Sequential advancement algorithm

1. Owner creates/freeze-validates a Plan and sends one GO. The Plan durably becomes `RUNNING` with Task A as `activeTaskId` and immutable authorization evidence.
2. Reconciliation/readiness promotes only that active, dependency-satisfied `PLANNED` Task to `READY`, then the trusted continuation dispatcher starts it once.
3. Worker/result/delivery/wake/PM judgment use existing V1 Task/Run identity and certified MCP Chat path unchanged.
4. On canonical ACCEPT, acquire the per-plan serialization lock and reread Plan + Task. If the accepted Task is not the active Task, or is duplicate/stale, make no sequence change.
5. If it is the last Task, verify all declared Tasks are ACCEPTED and persist `COMPLETED`. Otherwise atomically advance only `activeTaskId` to the immediate successor, retain `RUNNING`, and record an immutable advance audit fact.
6. Reconciliation dispatches that successor exactly once only when its Task is `READY` and it has no linked active Run.

The plan cursor is advanced before any successor dispatch. A crash before that write leaves the accepted predecessor as active and is repaired by reconciliation. A crash after it leaves the successor active and ready to be dispatched. A crash after dispatch materialization is detected from the canonical linked Run, so reconciliation never creates a second Run.

### CHANGES and retry

CHANGES is fully existing V1 behavior: it applies only to the delivery's current `taskId`/`runId`, creates the durable retry preparation, and drives a new Run of that **same Task** under the existing retry authorization. `activeTaskId` does not move. The successor is ineligible until the current Task's retry result is canonically ACCEPTED. Duplicate CHANGES, duplicate delivery, or duplicate wake must remain idempotent under existing delivery/judgment/retry locks.

### Failure, block, and recovery policy

| Condition | Required V1.5 outcome |
| --- | --- |
| Worker launch failure / active Task `FAILED` | preserve Task/Run evidence; Plan -> `FAILED`; never start successor |
| Result capture failure | Plan -> `BLOCKED`; preserve current Task and evidence; explicit recovery only |
| PM Delivery failure / GPT unavailable | Plan -> `BLOCKED`; no advancement; durable delivery remains authoritative |
| MCP/tunnel/widget unavailable | Plan -> `BLOCKED`; no advancement; repair transport then explicit Owner recovery |
| CHANGES | current Task retry only; Plan remains `RUNNING`, same `activeTaskId` |
| Task explicitly `BLOCKED` or `CANCELLED` | Plan -> `BLOCKED`; never start successor |
| Relay restart | reconcile durable Plan, Task, Run, Delivery, Wake, and retry records; infer no missing approval and never duplicate-dispatch |

When facts are incomplete or conflicting, the only valid outcome is `BLOCKED`. No automatic skip, failure inference, successor start, or scope expansion is allowed.

### Backward compatibility

V1 single-Task intake and `dispatchV1OwnerApproved` remain unchanged. Existing Tasks without a `planId` have no Plan behavior. PM Deliveries, Verification Contexts, Judgments, retry preparations, retry authorizations, and wakes remain Task/Run keyed; V1.5 only consults their canonical state. The existing one-delivery-at-a-time host behavior remains compatible because V1.5 permits only one active Plan Task.

### Implementation slices

1. **Plan kernel:** types, validation, atomic persistence, monotonic IDs, per-plan lock, audit projection, and no runtime dispatch.
2. **Owner GO + continuation authority:** exact Plan authorization, active-task readiness, dispatch guard, and scope-fingerprint checks.
3. **Advance/reconcile:** ACCEPT-triggered cursor advance, restart reconciliation, duplicate guards, and conservative blocker recording.
4. **Surfaces:** minimal MCP/TUI plan read/create/GO status only after kernel tests; no catalog expansion unrelated to V1.5.
5. **Certification:** focused tests, regressions, then the bounded Chat dogfood Plan below.

## 7. Completion Criteria

V1.5 is complete only when one Owner GO executes a frozen three-Task Plan A -> B (one automatic same-Task retry) -> C in Chat mode; each successor begins only after its predecessor ACCEPT; the Plan becomes `COMPLETED`; all counters and exact artifacts pass; and no prohibited intervention occurs.

## 8. QA Gate

| Test | Required assertion |
| --- | --- |
| Three ACCEPTs | A, B, C dispatch strictly in order; one active Task max; Plan completes |
| Middle retry | B CHANGES -> same B retry -> B ACCEPT; C starts only after B ACCEPT |
| Middle failure | B `FAILED`; C has no Run and Plan is `FAILED` |
| Duplicate ACCEPT | same Task/Run ACCEPT replay never advances twice or dispatches two successors |
| Duplicate delivery/wake | delivery/wake replay never double-dispatches active or successor Task |
| Restart after ACCEPT | recover once between A ACCEPT and B dispatch; exactly one B Run results |
| Restart during retry | recover B preparation/dispatch; exactly one B retry Run results |
| Scope mutation | changed Task/binding/fingerprint or out-of-plan Task is rejected before effect |
| V1 regression | existing single-Task dispatch/ACCEPT/CHANGES/retry suites stay green |
| Chat wake regression | current G4c/G6 Widget `ui/message` path stays Task/Run keyed and works unchanged |
| Worker/observation regression | selected Claude profile and same resolved observation context remain valid |

Required focused suites will be introduced with the implementation. Relevant existing regression commands are `test:v1-g1-pm-intake`, `test:v1-g2-owner-dispatch`, `test:v1-g3-result-return`, `test:v1-g4a-pm-delivery`, `test:v1-g4b-verification-context`, `test:v1-g4c-pm-host-wake`, `test:v1-g5a-pm-judgment`, `test:v1-g5a-judgment-durability`, `test:v1-g5b-retry-preparation`, `test:v1-g5c-auto-redispatch`, `test:g6-mcp-pm-wake`, and `test:g6-observation-profile-context`.

## 9. Dogfood Ready Gate

Do not start dogfood until build PASS, focused V1.5 tests PASS, the listed V1 regressions PASS, selected Claude profile auth PASS, observation PASS, MCP App PASS, public endpoint PASS, Chat widget mount PASS, no runtime blocker, and the exact disposable Plan below is prepared. Owner-intervention counters must be ready before GO.

## 10. Dogfood Pass Gate

Use real **Chat** mode and one Owner GO. Prepare only this disposable Plan (do not create it during planning):

| Ordered Task | Contract / expected final artifact |
| --- | --- |
| A | create `.g6-dogfood/v15-a.txt` containing exactly `V15_A_ACCEPTED\n` |
| B Run 1 | create `.g6-dogfood/v15-b.txt` containing exactly `V15_B\nattempt=1\n`; GPT intentionally submits CHANGES |
| B Run 2 | replace it with exactly `V15_B\nattempt=2\n`, then GPT ACCEPTs |
| C | create `.g6-dogfood/v15-c.txt` containing exactly `V15_C_ACCEPTED\n` |

Expected trace: `Owner GO -> A -> ACCEPT -> B1 -> CHANGES -> automatic B2 -> ACCEPT -> C -> ACCEPT -> Plan COMPLETED`.

Required counters: `ownerGoCount=1`, `manualResultCopyPaste=0`, `manualContinue=0`, `manualRetryGo=0`, `manualNextTaskGo=0`, `browserExtension=0`, `openAiApiPm=0`, `conversationMode=CHAT`. Work mode is prohibited. Also record `workerRunCount=4`, `automaticWakeCount=4`, `acceptCount=3`, `changesCount=1`, Plan ID, Task/Run/Delivery IDs, and byte-for-byte artifact checks.

## 11. Metrics

Persist/log only safe logical identities and timestamps: plan state transitions; active-task transitions; dispatch/retry counts; wake/delivery/judgment counts; Worker/Relay/host failure class; elapsed time; artifact verdicts; and all Owner-intervention counters. Do not infer ChatGPT token usage. `conversationMode=CHAT` and any native allowance display are Owner-provided evidence.

## 12. Decision Rule

Pass only if every sequencing invariant, exact artifact, and counter above holds with no manual continuation/retry/next-task GO. Any duplicate Run, skipped/early successor, scope expansion, non-Chat dogfood, missing evidence, or uncertainty is a fail/block—not a partial pass.

## 13. Final Receipt

The implementation/dogfood receipt must report Plan ID/state, each Task/Run/Delivery/judgment identity, transition trace, artifact bytes, counters, Chat mode evidence, exact regression results, and any blocker. It must explicitly state that V1 semantics and G4/G5 were preserved.

## 14. Next Step

Implement **Slice 1 only**: the isolated Plan kernel and its persistence/validation/transition tests. Do not wire dispatch, MCP/TUI surfaces, or dogfood until Slice 1 passes review.

## C1 diagnostic retirement guidance

C1-A through C1-E are disposable diagnostic servers/tunnels, not production services. After their Owner observations are recorded, stop only the named `agent-relay-c1-*-app` and `agent-relay-c1-*-tunnel` tmux sessions; remove their temporary connectors in ChatGPT; retain `docs/C1-NORMAL-CHAT-PROMOTION-BOUNDARY-PREP-01.md` and screenshots/evidence. Do not stop `agent-relay-mcp-app`, `agent-relay-mcp-tunnel`, or alter the production connector.

## Slice 6 — Full QA / Dogfood-Ready certification (2026-09-05)

Status: **V15_DOGFOOD_READY.** No product-code change was required; this Slice adds only the certification record and the reproducible fixture E2E suite. No new product features were added.

Accepted implementation SHAs:

- Slice 1 (Plan kernel): `ded29d25ebfff7fe0a42ddce9a779f74f90235ff`
- Slice 2 (Owner GO / first dispatch): `46c284ac7f4e210d0f1b4249fcacbb6f17e66be6`
- Slice 3 (ACCEPT continuation): `46c661eb1e49116e5c13499e9a20e0f3429485f4`
- Slice 4 (restart reconciliation): `8d6906b0fb2ee5f0dc6fd4c48c4603da1261df75`
- Slice 5 (MCP Plan surface): `d06abfd187ff6d018d8259f1ad38304497018bd5`

QA results (all re-run on the Slice 1–5 tip; isolated `TEST_ROOT` fixtures unless noted):

- Track A (Plan kernel, `test:v15-plan-kernel`): 31/31 PASS — valid creation, malformed rejection, immutable order/bindings, fingerprint stability, transitions, terminal resurrection rejection, atomic persistence, mutation locking, concurrent CAS safety.
- Track B (Owner GO, `test:v15-plan-first-dispatch`): 26/26 PASS — exactly one GO, frozen-order first Task, Worker/workspace/scope validation, canonical V1 dispatch reuse, duplicate/concurrent GO safe, fail-closed dispatch failure.
- Track C (ACCEPT continuation, `test:v15-plan-accept-advancement`): 23/23 PASS — A ACCEPT -> B once, B CHANGES no-advance, same-Task retry, retry ACCEPT -> C once, C ACCEPT -> COMPLETED, stale/duplicate/concurrent ACCEPT safe.
- Track D (restart reconciliation, `test:v15-plan-reconciliation`): 27/27 PASS — all 15 crash windows covered (pre-dispatch through contradictory durable state); never double-dispatch; ambiguous states BLOCK.
- Track E (MCP surface, `test:v15-plan-mcp-surface`): 48/48 PASS — four Plan tools through production-shaped server, strict schemas, bounded outputs, no mutation/result/prompt/transcript/credential leakage, duplicate GO safe, V1 PM tools unchanged.
- Track F (fixture E2E, `test:v15-slice6-dogfood-ready`): 22/22 PASS — three fixture Tasks driven Owner GO -> A ACCEPT -> B1 CHANGES -> B2 ACCEPT -> C ACCEPT -> Plan COMPLETED; exact results `V15_A_ACCEPTED`, `V15_B\nattempt=1`, `V15_B\nattempt=2`, `V15_C_ACCEPTED`; dispatch sequence exactly A run 1, B run 1, B run 2, C run 1 (4 Worker Runs, no extras, no duplicate IDs).
- Track G (PM Delivery reuse): covered in the same suite — one ordinary identity-only `TASK_VERIFY` delivery per attempt (`PMD-{taskId}-{runId}`, 4 total, no result text inside), visible to `listPendingPmDeliveries`/`reconcilePmDeliveries` exactly as ordinary Task/Run deliveries; no Plan-specific delivery channel.
- Track H (Normal Chat host readiness): production MCP app exposes 40 tools (existing V1 tools + `relay_pm_open_widget` + `relay_pm_submit_judgment` + the four V1.5 Plan tools) and 1 resource (`ui://agent-relay/pm-widget-v2`, 9326 bytes, polls pending deliveries, no secrets). No Work dependency introduced.
- Track I (real Worker precheck): `claude-code` registry record present; effective profile for the dogfood workspaceRoot is `pro` -> `/home/skkse12/.claude-pro` (exists); `resolveClaudeConfigContext` (observation) returns the same directory as the Worker wrapper routing; noninteractive `claude --print` smoke exit 0 with exact `SMOKE_OK`; `git status` diff before/after smoke empty (no repository modification).
- Track J (runtime precheck): MCP app healthy on `:3899` (`/health` 200, `initialize`, `tools/list`, `resources/list`, widget `resources/read` all verified). Previous Quick Tunnel was dead; a fresh production Quick Tunnel was restored: `https://workstation-examine-laptop-east.trycloudflare.com` (`/health` 200 through the public URL).
- V1 regressions: G2 (58), G3 (37), G4A (61), G4B (82), G4C (49), G5A (52), G5A-durability (15), G5B (82), G5C (114), G6-MCP-wake (41), G6-launch-diag (14), G6-observation-profile (12) — all PASS, zero failures.
- Build/typecheck: `npm run build` exit 0, `npm run typecheck` exit 0.
- C1 cleanup: no C1 diagnostic server/tunnel processes were running; nothing stopped; C1 documentation retained; production MCP app/tunnel untouched.

Dogfood Ready Gate: ALL PASS (Slices 1–5 QA, fixture E2E, Run count = 4, no duplicate dispatch, ordinary PM Deliveries, V1 green, build/typecheck green, Claude auth/smoke green, observation green, MCP app + public endpoint + widget healthy, dogfood contract frozen, no runtime blocker). Real Owner dogfood was NOT run.

Frozen real-Owner dogfood contract (disposable; do not create until dogfood session):

- Plan title: `Agent Relay V1.5 sequential certification`
- Task A creates `.g6-dogfood/v15-a.txt` with exactly `V15_A_ACCEPTED\n`, then ACCEPT.
- Task B Run 1 creates `.g6-dogfood/v15-b.txt` with exactly `V15_B\nattempt=1\n`; after automatic wake submit CHANGES. Retry changes only `attempt=1` -> `attempt=2`; then ACCEPT.
- Task C creates `.g6-dogfood/v15-c.txt` with exactly `V15_C_ACCEPTED\n`, then ACCEPT.
- All three Tasks: `workerId=claude-code`, `workspaceRoot=/home/skkse12/Desktop/Projects/Core/Agent-Relay`, no network. Only the three declared artifact files may be modified.
- Frozen counters: `ownerGoCount=1`, `workerRunCount=4`, `automaticWakeCount=4`, judgments A=ACCEPT / B1=CHANGES / B2=ACCEPT / C=ACCEPT, `manualResultCopyPaste=0`, `manualContinue=0`, `manualRetryGo=0`, `manualNextTaskGo=0`, `manualWidgetWake=0`, `browserExtension=0`, `openAiApiPm=0`, `conversationMode=CHAT`.

Known limitations:

- Public endpoint is a Cloudflare Quick Tunnel (no uptime guarantee); a fresh URL must be issued to the Owner at dogfood time and the ChatGPT connector re-pointed by the Owner.
- `BLOCKED` Plans require explicit Owner recovery (no auto-recovery daemon, by design).
- Out-of-plan Tasks are never activated by Plan reconciliation (verified); ambiguous durable state resolves to `BLOCKED`, never to a guessed dispatch.
- Widget secret scan: one `SK-` substring is a delivery-ID prefix fragment in widget JS, not credential material (Slice 5 no-secret assertion holds).
