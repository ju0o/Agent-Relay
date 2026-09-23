# Founder Start Here

## Canonical Agent Relay location

- Machine: ASUS (SSH alias: `asus`)
- Primary checkout: `/home/skkse12/Desktop/Projects/Core/Agent-Relay`
- Current CORE V1 implementation branch: `feat/core-v1-auto-dev-team-01`
- Current review: PR #8 — `feat(core-v1): automate PM → Worker → QA → NEXT across core lanes`

The old manual PM chat/prompt shuttle is not the canonical execution path anymore. The CORE V1 implementation is intended to make Agent Relay own the PM → Worker → independent QA → retry/ACCEPT → durable promotion → NEXT loop.

## MainPC: one-line isolated verification

Run this from MainPC PowerShell:

```powershell
ssh asus "cd /home/skkse12/Desktop/Projects/Core/Agent-Relay && git fetch origin feat/core-v1-auto-dev-team-01 && git show origin/feat/core-v1-auto-dev-team-01:scripts/core-v1-asus-verify.sh | bash"
```

This command does **not** switch/reset/stash the primary checkout. It creates a separate verification worktree at:

`/home/skkse12/Desktop/Projects/Core/Agent-Relay-core-v1-pr8`

Then it:

1. installs exact dependencies with `npm ci`,
2. runs focused CORE V1 tests,
3. runs the full test suite,
4. uses isolated verification state,
5. runs one real `core-v1 once` cycle,
6. prints the Founder-readable Result Inbox,
7. writes machine-readable output to `/tmp/agent-relay-core-v1-pr8-results.json`.

## CORE V1 commands

From the verification checkout:

```bash
cd /home/skkse12/Desktop/Projects/Core/Agent-Relay-core-v1-pr8
npm exec -- agent-relay core-v1 status
npm exec -- agent-relay core-v1 once
npm exec -- agent-relay core-v1 results
npm exec -- agent-relay core-v1 results --json
npm exec -- agent-relay core-v1 reconcile
npm exec -- agent-relay core-v1 stop
```

Do not start the continuous `core-v1 up` loop until the isolated one-cycle verification is reviewed and accepted.

## Registered project paths in PR #8

- Agent Relay: active checkout (`$AGENT_RELAY_REPO`)
- JuActl: `/home/skkse12/Desktop/Projects/Core/actl-v0.1.1-managed`
- JuPlan: `/home/skkse12/Desktop/Projects/Team/JuPlan`
- JuCeipt: `/home/skkse12/Desktop/Projects/Team/JuCeipt`
- JuControler: `/home/skkse12/Desktop/Projects/Core/JuControler` (later integration target, not an active CORE V1 Worker lane)

## Founder rule

Do not search old chat tabs to find the PM. Start from this document and the repository state. ChatGPT Web may still be used as a PM/view surface, but the final Agent Relay runtime must not depend on manual copy/paste or `codex-chatgpt-web`.
