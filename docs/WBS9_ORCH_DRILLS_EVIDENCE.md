# WBS-9 orchestrator drills evidence

Run date: 2026-09-16. The harness uses disposable roots under `/tmp/agent-relay-orch-drills-*`; it does not use the live data root.

## Dedicated result

Command:

```text
node --test test/v1-orchestrator-drills.test.mjs
```

```text
1..8
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
```

## Canonical counts

Counts are `tasks / pm-deliveries / pm-judgments`; `pending` is pending PM deliveries.

| Drill | Before | After | Result |
|---|---:|---:|---|
| 1 duplicate QA response | 1/1/0, pending 1 | 1/1/1, pending 0 | PASS; second gate call was `REPLAY_IGNORED`, one PM send |
| 2 provider/session unavailable | 1/1/0, pending 1 | broken call unchanged; healthy retry 1/1/1, pending 0 | PASS for fail-closed canonical state; runtime audit gap is recorded below |
| 3 rate limit 429 | 1/1/0, pending 1 | 1/1/0, pending 1 | PASS for canonical immutability; retryAfter audit gap is recorded below |
| 4 zero-billing fallback | 1/1/0, pending 1 | 1/1/0, pending 1 | PASS for paid fallback owner gate; symbolic `free-B` gap recorded below |
| 5 concurrent final gate | 1/1/0, pending 1 | 1/1/1, pending 0 | PASS; one judgment and one reconciliation |
| 6 restart after CREATE_TASK | 0/0/0 | 2/0/0 | DEFECT reproduced: second bootstrap creates another Task |
| 7 corrupted PM session | 0/0/0 | 0/0/0 | PASS; fresh adapter session and no canonical task mutation |
| 8 frozen next contract | 1/1/0 | 2/1/1 | DEFECT reproduced: existing `task_id` is ignored and a new Task is created |

Canonical fixture paths are created through existing APIs below the disposable root:

```text
<root>/<project>/_relay/tasks/<taskId>/task.json
<root>/<project>/_relay/pm-deliveries/<deliveryId>/delivery.json
<root>/<project>/_relay/pm-judgments/<judgmentId>/judgment.json
<root>/<project>/_runs/run-<n>/meta.json
<root>/<project>/_relay/role-sessions/<project>/pm.json
<root>/worker-registry.json
<root>/Drill*.qa-count
```

The test asserts the live marker remains present and the `find` snapshot of `/home/skkse12/.local/share/AgentRelay/data`, excluding `V02CControlTower`, is unchanged.

## Defects routed to PM

- `// DEFECT` drill 2: `ensureSession()` errors such as `ECONNREFUSED`/503 escape `processFinalGate`; no durable `BLOCKED_RUNTIME` audit record is emitted. Canonical state remains untouched and a healthy subsequent call applies once.
- `// DEFECT` drill 3: a non-timeout 429 from `send()` escapes; no durable `retryAfter` is recorded.
- `// DEFECT` drill 4: fallback selection checks the adapter id for a free-tier model suffix, so the spec's registered symbolic `[free-B]` is rejected as `OWNER_REQUIRED`.
- `// DEFECT` drill 6: a dispatch-hook crash after `createTask()` is not resumed from a durable create marker; the next bootstrap creates a second Task.
- `// DEFECT` drill 8: `handleAcceptAndNext()` does not enforce `CONTRACT_FROZEN` when `next_task_contract.task_id` targets an already-dispatched Task.

## Required regression runs

`npx tsc -p tsconfig.server.json` passed.

Full requested test command:

```text
node --test test/v1-*.test.mjs test/opencode-command-adapter.test.mjs
1..60
# tests 60
# suites 0
# pass 58
# fail 2
```

The two failures are pre-existing/concurrent-lane failures in `v1-g4a-pm-delivery` (state mismatch: current `IGNORED`, expected `PENDING`) and `v1-g5c-auto-redispatch` (missing host `REDISPATCHED` retryRunId). No orchestrator-drills file caused either failure.

```text
npm run test:roles
1..8
# tests 8
# suites 0
# pass 8
# fail 0
```
