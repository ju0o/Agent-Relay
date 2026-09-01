You are the PHASE H CLOSED GOAL LOOP IMPLEMENTATION AGENT.

Repository:
ju0o/Agent-Relay

Branch:
dev/adapter-foundation-01

Start SHA:
ce8f7ac

DO NOT touch main.

Accepted/Frozen:
Phase A
Phase B1
Phase B2
Phase C
Phase D
Phase E
Phase F
Phase G

Phase H Architecture / Contract is FROZEN.

==================================================
PHASE H NORTH STAR
==================================================

Relay-driven STATE.
Host-driven INTELLIGENCE.

Relay MUST NOT embed GPT or an autonomous while(true) orchestrator.

External GPT PM / fake test PM drives MCP primitives.

Phase H closes the runtime loop by implementing:

1. Dispatcher Run ↔ Adapter/Capture execution binding
2. trusted Adapter Result Bridge
3. pure get_next_work discovery
4. central PermissionPolicy enforcement
5. Owner task:dispatch IPC
6. PM complete_goal MCP
7. owner-authorized orphan resolution path
8. synthetic deterministic closed-loop E2E

==================================================
NON-NEGOTIABLE TRUST FLOW
==================================================

Worker claim
≠ RESULT_RECEIVED

Process exit
≠ RESULT_RECEIVED

result.md existence
≠ RESULT_RECEIVED

Only trusted bound Adapter observation:

RESPONSE_COMPLETE
+ exact taskId/runId executionBinding
+ persisted capture
+ current attempt validation

may promote:

RUNNING/DISPATCHED
→ RESULT_RECEIVED

==================================================
1. WORKER REGISTRY G.2 AMENDMENT
==================================================

Amend trusted Worker Registry.

Current trusted location remains:

<dataRoot>/_relay/workers/<workerId>.json

Bump schema:

G.1 → G.2

Add:

observationAdapterId?: string

Important implementation interpretation:

- For CLOSED-LOOP / AUTO-OBSERVED dispatch:
  observationAdapterId is REQUIRED.

- Registry infrastructure may still parse explicitly non-observed internal/test
  workers if useful, but normal H dispatch must reject a worker that cannot
  resolve an observation adapter.

Do NOT derive adapter from workerId.

Do NOT accept adapterId from Task/Goal narrative.

Do NOT permit project-level executable or adapter override.

==================================================
REGISTERED ADAPTER VALIDATION
==================================================

For observed dispatch:

worker.observationAdapterId must resolve to a registered Adapter.

Examples currently include:

opencode
claude-code
codex
commandcode
cline
grok

Do not hard-code this list unnecessarily if registry API can validate.

Unknown adapter:
→ INVALID_ARGUMENT / WORKER_UNAVAILABLE-like deterministic failure
before spawn.

==================================================
PUBLIC WORKER VIEW
==================================================

May expose:

workerId
displayName
capabilities
observationAdapterId

Must still NOT expose:

launchCommand
launchArgsPrefix
workingDirectory
environment
absolute executable paths

==================================================
2. WORKSPACE ROOT
==================================================

Extend dispatch request:

interface DispatchRequest {
  taskId: string
  workerId: string
  expectedExecutionState: 'READY'
  workspaceRoot: string
}

workspaceRoot:

- coding repository / Adapter observation scope
- NOT Relay Run folder
- NOT dataRoot
- NOT Worker Registry workingDirectory

==================================================
WORKSPACE VALIDATION
==================================================

workspaceRoot MUST:

- be non-empty
- be absolute
- path.resolve successfully
- exist
- be a directory
- reject NUL
- may be outside dataRoot

Do NOT allow Task narrative or Goal text to supply it implicitly.

Do NOT infer it from Run folder.

Do NOT silently substitute workingDirectory.

Return deterministic INVALID_ARGUMENT for invalid workspace.

==================================================
3. EXECUTION BINDING
==================================================

Extend CaptureManager with optional trusted execution binding.

Preferred:

interface ExecutionBinding {
  dataRoot: string
  project: string
  goalId: string
  taskId: string
  runId: string
}

CaptureContext may carry:

executionBinding?: ExecutionBinding

==================================================
BOUND CAPTURE ARM
==================================================

For Dispatcher-bound execution:

CaptureManager.arm(...):
- folder = existing Dispatcher Run folder
- isDraft = false
- executionBinding present
- workspaceRoot present
- adapterId = Worker Registry observationAdapterId

Invariant:

executionBinding present
→ folder MUST already exist
→ folder MUST correspond to linked runId
→ materializeParams MUST NOT create another Run
→ persist() MUST NEVER call materializeOnce for this attempt

ONE Dispatcher attempt = ONE canonical Run.

==================================================
LEGACY CAPTURE
==================================================

No executionBinding:
preserve current legacy/manual Draft behavior.

Draft:
folder === null
→ materializeOnce allowed

Existing-folder legacy capture:
unchanged.

Do not break Phase A dogfooding workflow.

==================================================
4. CAPTURE ARM ORDER
==================================================

Amend Dispatcher exact order:

1. acquire dispatch lock
2. validate Task READY
3. validate Worker Registry
4. validate workspaceRoot
5. materialize NEW Run
6. link Run
7. CAS READY → DISPATCHED   ← commitment
8. arm CaptureManager against SAME Run:
   - folder
   - executionBinding
   - observationAdapterId
   - workspaceRoot
9. if Capture arm fails:
   - CAS DISPATCHED → FAILED
   - preserve Run
   - ensure partial capture is stopped/cleaned
   - emit typed RUNTIME_ERROR / RUN_FAILED-class event
   - DO NOT spawn
10. spawn Worker
11. spawn success → DISPATCHED → RUNNING
12. existing G post-spawn CAS handling remains

==================================================
PRE-COMMIT FAILURE
==================================================

Before READY→DISPATCHED:

existing G rollback remains:

unlink new Run
delete only new Run folder
no Capture armed
no process spawn

==================================================
POST-COMMIT ARM FAILURE
==================================================

After DISPATCHED:

Run is historical.

NEVER delete it.

Arm failure:

DISPATCHED → FAILED
preserve Run
Event
no spawn
no auto retry

==================================================
5. ADAPTER WORKSPACE CONCURRENCY
==================================================

Implement process-local observed-dispatch lock keyed by:

observationAdapterId
+
path.resolve(workspaceRoot)

At most ONE concurrent auto-observed dispatch per:

(adapterId, workspaceRoot)

Second attempt:
→ CONFLICT

Reason:
current Adapter APIs do not provide deterministic launch-correlated session IDs.

==================================================
LOCK LIFETIME
==================================================

Acquire before Capture arm.

Release when:

- Capture successfully persists terminal completion and stops
- dispatch fails before spawn
- spawn/process failure makes capture no longer valid
- explicit cleanup/disarm
- test reset

Do NOT leak observation lock forever.

==================================================
AMBIGUITY
==================================================

If SessionBindingPolicy still reports ambiguity:

- do not call Result Bridge
- do not mark RESULT_RECEIVED
- surface capture ambiguity / stop-work condition

Manual session selection remains available.

No silent heuristic selection.

==================================================
6. TRUSTED RESULT BRIDGE
==================================================

Create preferred module:

src/backend/result-bridge.ts

Expose a narrow internal function such as:

promoteObservedResult({
  dataRoot,
  project,
  taskId,
  runId,
  completion,
  ...
})

NOT MCP.

NOT Worker-callable.

==================================================
TRUSTED SIGNAL
==================================================

Bridge may promote only when ALL true:

- executionBinding exists
- completion.completionKind === 'RESPONSE_COMPLETE'
- CaptureManager session binding accepted it
- settle completed
- captureCompletion successfully persisted into bound Run folder
- runId exists in Task.linkedRuns
- runId is current attempt
- Task executionState ∈ {DISPATCHED, RUNNING}
  or already RESULT_RECEIVED for idempotent replay
- pmState !== ACCEPTED
- observation belongs to same taskId/runId

Otherwise:
do NOT promote.

Historical attempt:
do NOT promote.

==================================================
CURRENT ATTEMPT
==================================================

Use canonical Task linkedRuns sequence.

Current attempt:

acceptedRunId ?? latest linked Run by taskRunSequence

But bridge must reject ACCEPTED Task.

For active execution:
runId must match latest/current dispatched attempt.

Do not allow old Adapter completion to promote a newer retry Task.

==================================================
7. RESULT BRIDGE ORDER
==================================================

Freeze order:

1. captureCompletion already persists artifacts to bound folder
2. recordAdapterObservation
3. validate Task/run/current-attempt again
4. markResultReceived
5. recordRunResultReceived

If Evidence step fails:
do NOT promote.

Transport completion must have OBSERVED provenance.

==================================================
ADAPTER OBSERVATION
==================================================

Record Phase C:

ADAPTER_OBSERVATION

linked to:

goalId
taskId
runId

Use deterministic/idempotent sourceEventId or existing dedupe mechanism.

Do NOT create caller-controlled trust level.

==================================================
markResultReceived
==================================================

Use frozen B2 implementation.

Expected normal effect:

RUNNING|DISPATCHED + PENDING
→ RESULT_RECEIVED + VERIFYING

Also preserve B2 idempotence.

Never expose:

relay_pm_mark_result_received

Never let Worker call it.

==================================================
RUN_RESULT_RECEIVED EVENT
==================================================

After successful/ensured result state:

recordRunResultReceived

Fact Event remains non-waking per frozen D.

Do NOT modify D pmAttention contract.

==================================================
8. NON-RESPONSE COMPLETIONS
==================================================

CaptureManager currently settles all accepted completion events.

Amend bound execution path so Result Bridge is called ONLY for:

completionKind === 'RESPONSE_COMPLETE'

PROCESS_FAILED
INTERRUPTED
BLOCKED
UNKNOWN

may still persist capture artifacts if existing behavior requires,
but MUST NOT mark RESULT_RECEIVED.

Do not silently map them to success.

==================================================
9. GET NEXT WORK
==================================================

Create preferred:

src/backend/pm-work.ts

Pure derived read only.

Expose:

getNextWork(dataRoot, project, ...)

No writes.

No work item persistence.

No claiming.

No markDelivered.

No dispatch.

==================================================
WORK ITEM KINDS
==================================================

Implement bounded V1 kinds:

EVENT_ATTENTION

TASK_VERIFY

TASK_RETRY_READY

TASK_DISPATCH_READY

GOAL_COMPLETION

STOP_ORPHAN

STOP_FAILED

STOP_BLOCKED

STOP_OWNER_REQUIRED

STOP_POLICY

==================================================
WORK ITEM SAFE SHAPE
==================================================

Use logical IDs only.

Example common:

kind
priority
project
goalId?
taskId?
runId?
eventId?
reason?
cas?
policy?
workerHint?

No physical Run folder.

No workspace path unless absolutely required for owner UI.
Prefer not exposing workspace in work queue.

==================================================
TASK_VERIFY
==================================================

Include Task when:

executionState === RESULT_RECEIVED
pmState === VERIFYING

Must include:

taskId
runId current attempt
expectedExecutionState
expectedPmState

This closes successful-result wake gap even though RUN_RESULT_RECEIVED is
non-waking.

==================================================
TASK_DISPATCH_READY
==================================================

Task:

executionState === READY
pmState === PENDING

Policy behavior:

PLAN:
do not present as PM-actionable dispatch;
emit STOP_POLICY / owner-dispatch-required advisory.

APPROVE:
TASK_DISPATCH_READY actionable to PM.

BYPASS:
TASK_DISPATCH_READY actionable to PM.

Still requires explicit:

workerId
workspaceRoot

No automatic worker selection.

==================================================
GOAL_COMPLETION
==================================================

If evaluateGoalCompletion says eligible:

emit:

GOAL_COMPLETION
goalId
expectedGoalStatus
bounded eligibility summary

No F allowedActions amendment.

==================================================
STOP ITEMS
==================================================

Expose bounded reasons for:

FAILED
BLOCKED
ORPHAN_SUSPECTED
OWNER_DECISION_REQUIRED
policy-denied execution

Do not mutate.

==================================================
ORDER / CAPS
==================================================

Suggested deterministic order:

STOP_*
EVENT_ATTENTION
TASK_VERIFY
GOAL_COMPLETION
TASK_RETRY_READY
TASK_DISPATCH_READY

Respect existing D severity ordering inside Event items.

Global max:
50 items

If truncated:
return bounded warning.

==================================================
10. PM MCP GET NEXT WORK
==================================================

Add:

relay_pm_get_next_work

Input:
prefer {}

Project/dataRoot remain MCP server process scope.

Pure read.

Worker MCP must not expose it.

==================================================
11. CENTRAL PERMISSION GATE
==================================================

Create preferred:

src/backend/permission-gate.ts

Types:

CallerSurface =
  'PM_MCP'
  | 'OWNER_IPC'
  | 'INTERNAL_TRUSTED'

Effect examples:

DISPATCH
COMPLETE_GOAL
ORPHAN_KEEP_WAITING
ORPHAN_CONFIRM_FAILED
ORPHAN_CONFIRM_CANCELLED
ACCEPT_RESULT
REQUEST_CHANGES
REQUEST_RETRY
MERGE_MAIN
RELEASE
DESTRUCTIVE_ACTION
PRODUCTION_DEPLOY
SECRET_CHANGE

==================================================
PERMISSION MATRIX
==================================================

Freeze:

PM_MCP DISPATCH

PLAN:
DENY

APPROVE:
ALLOW

BYPASS:
ALLOW

OWNER_IPC DISPATCH

PLAN:
ALLOW

APPROVE:
ALLOW

BYPASS:
ALLOW

==================================================
PM JUDGMENT
==================================================

accept result
request changes
request retry

PM MCP:
ALLOW in PLAN / APPROVE / BYPASS

Preserve existing B2 legality.

Do not add retry ceiling to raw requestRetry.

==================================================
COMPLETE GOAL
==================================================

PM MCP:

PLAN:
DENY

APPROVE:
ALLOW

BYPASS:
ALLOW

OWNER_IPC:
ALLOW all modes

Goal COMPLETED is NOT:
merge
release
deploy

==================================================
ORPHAN
==================================================

KEEP_WAITING:
PM allowed all modes

CONFIRM_FAILED:
OWNER_IPC only

CONFIRM_CANCELLED:
OWNER_IPC only

PM MCP DENY even BYPASS.

==================================================
HARD CEILINGS
==================================================

PM MCP always denied:

MERGE_MAIN
RELEASE
DESTRUCTIVE_ACTION
PRODUCTION_DEPLOY
SECRET_CHANGE

Permission overrides MUST NOT grant PM these.

==================================================
12. OWNER TASK DISPATCH IPC
==================================================

Extend RelayRequest:

task:dispatch

Input:

dataRoot
project
taskId
workerId
workspaceRoot
expectedExecutionState: 'READY'

Handler:

1. load Goal/Task permission mode
2. authorizeEffect(
     effect='DISPATCH',
     callerSurface='OWNER_IPC'
   )
3. call SAME H/G dispatch pipeline

Do NOT duplicate Dispatcher.

Do NOT accept:

launchCommand
launchArgs
shell
env
cwd override
adapterId override

==================================================
13. PM DISPATCH PERMISSION
==================================================

Existing:

relay_pm_dispatch_task

Add:

workspaceRoot

Before dispatch:

authorizeEffect(
  DISPATCH,
  PM_MCP
)

PLAN:
FORBIDDEN

APPROVE/BYPASS:
allowed

Then same dispatcher path.

==================================================
14. COMPLETE GOAL MCP
==================================================

Add:

relay_pm_complete_goal

Input:

goalId
expectedGoalStatus
reason?

Required:

expectedGoalStatus

Flow:

1. authorizeEffect(COMPLETE_GOAL, PM_MCP)
2. read Goal
3. CAS expectedGoalStatus
4. evaluateGoalCompletion at mutation time
5. if stale/ineligible:
   CONFLICT / INVALID_STATE
6. completeGoal
7. recordGoalCompleted Event
8. return logical Goal result

No Phase F allowedActions amendment.

==================================================
OWNER COMPLETE
==================================================

Existing desktop goal:complete may remain.

SHOULD align it to permission gate + GOAL_COMPLETED Event if safe in scope.

Do not break existing UI.

==================================================
15. ORPHAN RESOLUTION
==================================================

Implement backend narrow functions.

PM MCP required only for:

relay_pm_resolve_orphan
action = KEEP_WAITING

Or design tool to expose enum but reject CONFIRM_* through permission gate.

Safer:
one tool can accept:

KEEP_WAITING
CONFIRM_FAILED
CONFIRM_CANCELLED

but:

PM_MCP:
only KEEP_WAITING allowed

OWNER_IPC:
all three according to policy

==================================================
KEEP_WAITING
==================================================

Must NOT clear recovery block.

It is an explicit decision to leave state unchanged.

May return current recovery status.

==================================================
CONFIRM_FAILED
==================================================

OWNER only.

Require expectedExecutionState:

DISPATCHED or RUNNING

Flow:

1. verify recovery record exists
2. CAS canonical state → FAILED
3. only AFTER successful canonical transition:
   clear recoveryRegistry entry
4. emit typed runtime / owner-decision event if appropriate

==================================================
CONFIRM_CANCELLED
==================================================

Same pattern:

CAS → CANCELLED
then clear recovery entry.

No guessed process signal.

No stale PID kill.

==================================================
G RECOVERY CLEAR HELPER
==================================================

Add a narrow trusted backend helper.

Do not expose arbitrary recoveryRegistry mutation.

==================================================
16. FAILED TASK
==================================================

No reopen.

No PM replacement Task tool.

get_next_work:
STOP_FAILED

Recovery:
Owner uses existing task:create manually.

H does not auto-rewire dependencies.

==================================================
17. RETRY
==================================================

Do NOT enforce max 3 on raw requestRetry.

Existing B2 remains:

RESULT_RECEIVED + CHANGES_REQUESTED
→ READY + PENDING
retryCount++

Host automation may use retryCount as guidance.

No internal auto continuation in H.

==================================================
18. ACTION BEFORE ACK
==================================================

No new backend state needed.

Document/test host protocol:

get_next_work
→ if Event: get_context
→ mark_delivered
→ perform canonical action
→ acknowledge

On CONFLICT:
rebuild context/work.

Never ACK before mutation.

==================================================
19. OBSERVATION LOCK
==================================================

Implement process-local key:

`${observationAdapterId}@@${path.resolve(workspaceRoot)}`

Acquire for auto-observed dispatch.

Same adapter + same workspace:
second observed dispatch → CONFLICT.

Different:
adapter OR workspace
→ may proceed concurrently.

==================================================
LOCK/CAPTURE CLEANUP
==================================================

Carefully integrate lifecycle.

Release observation slot on:

- arm failure
- spawn failure
- process terminal failure if capture should be stopped
- capture successfully persists bound result
- explicit capture stop
- test reset

Do not release merely after spawn success.

==================================================
20. WORKSPACE AUDIT
==================================================

SHOULD persist workspaceRoot to Run meta.json.

If implemented:
do not make it authority for future dispatch.

It is audit only.

Do not expose absolute workspaceRoot through PM Context Packet unless explicitly
designed.

Phase F path boundary must stay intact.

==================================================
21. SYNTHETIC CLOSED LOOP E2E
==================================================

Implement deterministic fake PM tests.

No real Claude/Codex/API credentials.

Required flow:

Goal permission = BYPASS
Task READY

→ dispatch fixture Worker with:
  G.2 Worker Registry
  observationAdapterId
  real temp workspaceRoot

→ verify ONLY one Run created

→ inject / simulate bound RESPONSE_COMPLETE

→ capture writes to existing Run

→ ADAPTER_OBSERVATION

→ Task:
RESULT_RECEIVED + VERIFYING

→ get_next_work:
TASK_VERIFY

→ request_changes:
CHANGES_REQUESTED

→ request_retry:
READY + PENDING

→ no automatic dispatch

→ second explicit dispatch:
fresh R2
R1 preserved

→ second bound RESPONSE_COMPLETE

→ accept_result

→ GOAL_COMPLETION appears

→ relay_pm_complete_goal

→ Goal COMPLETED
→ GOAL_COMPLETED Event

==================================================
NEGATIVE E2E
==================================================

Prove:

Worker CLAIM alone:
does NOT mark RESULT_RECEIVED

process exit:
does NOT mark RESULT_RECEIVED

result.md existence:
does NOT mark RESULT_RECEIVED

historical R1 completion arriving after R2:
does NOT complete R2

PLAN:
PM MCP dispatch denied

PLAN:
Owner task:dispatch allowed

APPROVE:
PM MCP dispatch allowed

BYPASS:
PM MCP dispatch allowed

PM orphan CONFIRM_FAILED:
denied even BYPASS

Owner CONFIRM_FAILED:
allowed with CAS

same adapter+workspace parallel:
second rejected

different workspace:
parallel allowed

==================================================
22. REQUIRED TESTS
==================================================

Add permanent H tests.

Suggested:

H-01 Registry G.2 observationAdapterId
H-02 unknown adapter rejected
H-03 project cannot override adapter mapping
H-04 workspaceRoot required
H-05 relative workspace rejected
H-06 nonexistent workspace rejected
H-07 external absolute workspace accepted
H-08 Run folder != workspaceRoot semantics

H-09 Dispatcher-bound capture uses existing Run
H-10 bound capture never materializeOnce
H-11 arm before spawn
H-12 arm failure → FAILED
H-13 arm failure preserves Run
H-14 arm failure does not spawn

H-15 same adapter/workspace concurrency blocked
H-16 different workspace parallel accepted
H-17 ambiguity prevents promotion

H-18 partial/tool/progress completion no promotion
H-19 PROCESS_FAILED no RESULT_RECEIVED
H-20 Worker claim no promotion
H-21 result file alone no promotion
H-22 RESPONSE_COMPLETE promotes
H-23 observation Evidence before result promotion
H-24 exact current run required
H-25 historical attempt rejected
H-26 duplicate observation idempotent

H-27 markResultReceived → RESULT_RECEIVED
H-28 PENDING → VERIFYING
H-29 CHANGES_REQUESTED → VERIFYING where legal
H-30 ACCEPTED rejected

H-31 get_next_work pure read
H-32 TASK_VERIFY discoverable without waking Event
H-33 GOAL_COMPLETION discoverable
H-34 PLAN STOP_POLICY / no PM dispatch item
H-35 APPROVE dispatch item
H-36 BYPASS dispatch item
H-37 STOP_FAILED
H-38 STOP_ORPHAN
H-39 result cap <= 50

H-40 PLAN PM dispatch denied
H-41 PLAN Owner dispatch allowed
H-42 APPROVE PM dispatch allowed
H-43 BYPASS PM dispatch allowed

H-44 complete_goal PLAN PM denied
H-45 complete_goal APPROVE allowed
H-46 complete_goal BYPASS allowed
H-47 complete_goal stale CAS conflict
H-48 complete_goal re-evaluates eligibility
H-49 GOAL_COMPLETED Event emitted

H-50 orphan KEEP_WAITING leaves block
H-51 PM CONFIRM_FAILED denied
H-52 PM CONFIRM_CANCELLED denied
H-53 Owner CONFIRM_FAILED CAS
H-54 Owner CONFIRM_CANCELLED CAS
H-55 recovery clears only after successful transition

H-56 requestChanges no retry
H-57 requestRetry no dispatch
H-58 no hard retry ceiling added
H-59 FAILED remains terminal

H-60 synthetic closed-loop full E2E

H-61 Phase G regression
H-62 Phase F regression
H-63 Phase E regression
H-64 Phase D regression
H-65 Phase C regression
H-66 B2 regression
H-67 Phase A regression

==================================================
MCP REAL INTEROP
==================================================

Use official MCP client over stdio for:

relay_pm_get_next_work
relay_pm_dispatch_task
relay_pm_complete_goal

At least one happy-path call each.

Verify Worker surface does NOT expose H PM tools.

==================================================
SECURITY
==================================================

Do NOT let MCP provide:

launchCommand
launchArgsPrefix
observationAdapterId override
workingDirectory
shell
env

workspaceRoot is the only new path argument.

Validate it as observation scope.

==================================================
DO NOT BREAK PHASE F
==================================================

No COMPLETE_GOAL added to Phase F allowedActions.

No physical path leakage through PM Context Packet.

get_next_work is separate H work-discovery surface.

==================================================
NON-GOALS
==================================================

DO NOT implement:

embedded GPT
while(true) coordinator
Loop SSOT
automatic worker selection
automatic retry
timeout daemon
FAILED reopen
real auth tokens
multi-PM leases
semantic memory
UI redesign
remote workers
containers
main merge

==================================================
VALIDATION
==================================================

Run:

npm test
npm run typecheck
npm run build

All PASS.

==================================================
GIT DELIVERY
==================================================

Commit scoped Phase H implementation.

Push:
dev/adapter-foundation-01

Verify:
local HEAD == origin/dev/adapter-foundation-01

Return:

TASK_COMPLETE
Role: PHASE_H_CLOSED_GOAL_LOOP_IMPLEMENTATION

Start SHA:
ce8f7ac

End SHA:
<sha>

Tests: PASS/FAIL
Typecheck: PASS/FAIL
Build: PASS/FAIL
Push: PASS/FAIL

Worker Adapter Mapping: PASS/FAIL
Workspace Binding: PASS/FAIL
One Attempt One Run: PASS/FAIL
Capture Arm Ordering: PASS/FAIL
Observation Concurrency: PASS/FAIL

Trusted Result Bridge: PASS/FAIL
Worker Claim Boundary: PASS/FAIL
Historical Attempt Isolation: PASS/FAIL
RESULT_RECEIVED Transition: PASS/FAIL
VERIFYING Transition: PASS/FAIL

Get Next Work: PASS/FAIL
Get Next Work Purity: PASS/FAIL
Successful Result Discovery: PASS/FAIL

Permission Gate: PASS/FAIL
PLAN Semantics: PASS/FAIL
APPROVE Semantics: PASS/FAIL
BYPASS Semantics: PASS/FAIL
Owner Dispatch IPC: PASS/FAIL

Goal Completion MCP: PASS/FAIL
Goal Completion CAS: PASS/FAIL
GOAL_COMPLETED Event: PASS/FAIL

Orphan Keep Waiting: PASS/FAIL
Orphan Owner Resolution: PASS/FAIL
FAILED Terminal: PASS/FAIL

No Embedded GPT: PASS/FAIL
No Auto Retry: PASS/FAIL
No Auto Dispatch Loop: PASS/FAIL
No Loop SSOT: PASS/FAIL

Synthetic Closed Loop E2E: PASS/FAIL
Real MCP Interop: PASS/FAIL

Phase G Regression: PASS/FAIL
Phase F Regression: PASS/FAIL
Phase E Regression: PASS/FAIL
Phase D Regression: PASS/FAIL
Phase C Regression: PASS/FAIL
B2 Regression: PASS/FAIL
Phase A Regression: PASS/FAIL

Blocker:
<if any>

Do NOT self-declare Phase H accepted.