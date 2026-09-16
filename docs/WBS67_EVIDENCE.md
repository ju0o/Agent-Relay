# WBS-6/7 disposable evidence

Command:

```bash
node --test test/v1-qa-loop.test.mjs
```

Observed summary:

```text
1..3
# tests 3
# pass 3
# fail 0
# cancelled 0
```

The disposable root is created with `fs.mkdtempSync('/tmp/arl-wbs67-')`.
For its fresh root, the canonical records are:

```text
<root>/WBS67/_relay/tasks/TASK-0001/task.json
<root>/WBS67/_relay/qa-attempts/QA-TASK-0001-wbs67-run-1/qa-attempt.json
<root>/WBS67/_relay/qa-remediation-preparations/QRP-QA-TASK-0001-wbs67-run-1/preparation.json
<root>/WBS67/_relay/tasks/TASK-0001/task.json  # same Task, linked run 2
<root>/WBS67/_relay/qa-attempts/QA-TASK-0001-wbs67-run-2/qa-attempt.json
<root>/WBS67/_relay/pm-deliveries/PMD-TASK-0001-wbs67-run-2/delivery.json
```

Assertions prove attempt 1 `FAIL`, one QRP, two linked Runs on the same Task,
attempt 2 `PASS`, and exactly one pending `TASK_VERIFY` Delivery. Duplicate
completion and a second `runOrResumeQaGate` call do not create another QA
attempt or Delivery.

QA worker crash is truthful: the existing gate records `BLOCKED` and returns
`BLOCKED_ESCALATED`; its existing escalation path also creates one pending PM
Delivery. This is an existing behavior and is documented rather than changed
in this WBS-6/7 harness.

The remediation dispatch path selects `sourceMeta.workerId` from the original
Builder Run and passes that same worker ID to `dispatchTask`; no Builder-worker
selection gap was observed.

The test never uses `~/.local/share/AgentRelay/data` and performs no network
operation.
