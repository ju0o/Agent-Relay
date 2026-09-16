# WBS-6/9 Builder dispatch drills

Command:

```bash
node --test test/v1-builder-dispatch-drills.test.mjs
```

Summary:

```text
1..5
# tests 5
# pass 5
# fail 0
```

Disposable canonical paths asserted by the harness:

```text
<root>/WBS69/_relay/goals/GOAL-0001/goal.json
<root>/WBS69/_relay/tasks/TASK-0001/task.json
<root>/WBS69/<run-date>/_runs/<run>/meta.json
<run-folder>/agent-result.md
<run-folder>/result.md
<run-folder>/evidence/adapter.json
<root>/WBS69/_relay/qa-attempts/<qaAttemptId>/qa-attempt.json
<root>/WBS69/_relay/pm-deliveries/<deliveryId>/delivery.json
```

Assertions cover `RESULT_RECEIVED`, one linked Run, exact result artifacts,
byte-identical Task/QA/Delivery counts after duplicate completion, truthful
dispatcher recovery/terminal state after non-zero worker exit, historical
Run rejection without changing the latest Task, and restart reconciliation.

No files under `~/.local/share/AgentRelay/data` are used or written. No
network or production worker is used. Existing QA/Result machinery remains
unchanged; no Builder-worker selection gap was introduced by this drill.
