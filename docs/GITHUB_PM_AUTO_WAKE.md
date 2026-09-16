# GitHub PM automatic wake bridge

The bridge exports each pending `TASK_VERIFY` delivery as one bounded JSON
packet under `pm-bridge/inbox/`, commits it to the provisioned wake PR branch,
and imports strict `PM_JUDGMENT v1` PR comments through the existing PM APIs.

## One-time Founder Work setup

Create one event-triggered ChatGPT Work task with this exact guard:

- repository: `ju0o/Agent-Relay`
- pull request: `#5` (the persistent `pm-transport-wake` → `pm-transport-base` PR)
- trigger: a new PR commit/update whose changed files include
  `pm-bridge/inbox/*.json`
- do not trigger on ordinary comments, reviews, or unrelated files

Work prompt contract:

```text
Fetch the newly added pm-bridge/inbox/*.json packet and only its bounded evidence refs. Verify evidence independently; distinguish NOT_PROVEN, DEFECT, and BLOCKED. Choose only an action in allowed_actions. Preserve the same Task on CHANGES. Never create a replacement Task/Run because transport failed. Post exactly one strict PM_JUDGMENT v1 comment to PR #5:
PM_JUDGMENT v1
packet_id: <packet_id>
context_hash: <bounded_context_hash>
decision: ACCEPT | CHANGES | OWNER_REQUIRED
retry: NONE | SAME_TASK
reason: <bounded reason>
Use OWNER_REQUIRED when a Founder/Product/security/destructive gate is required. Ignore unrelated activity.
```

The Founder authorizes this connected-app trigger once. The certification loop
must then use zero manual wake messages.

## PM commands

Disposable real-GitHub dry run:

```bash
npm run build:server
node dist/server/github-pm/main.js --dataRoot /tmp/agent-relay-pm-data --project Demo --transport git-gh --repo-dir "$HOME/.local/share/agent-relay-pm-transport/repo" --pr ju0o/Agent-Relay#5 --state-file /tmp/agent-relay-pm-state.json --audit-dir /tmp/agent-relay-pm-audit --mode both --dry-run --once
```

Live run against the provisioned inbox PR:

```bash
node dist/server/github-pm/main.js --dataRoot "$AGENT_RELAY_DATA_ROOT" --project <allowlisted-project> --transport git-gh --repo-dir "$HOME/.local/share/agent-relay-pm-transport/repo" --pr ju0o/Agent-Relay#5 --state-file "$AGENT_RELAY_DATA_ROOT/.pm-bridge-state.json" --audit-dir "$AGENT_RELAY_DATA_ROOT/.pm-bridge-audit" --mode both --poll-ms 5000
```

