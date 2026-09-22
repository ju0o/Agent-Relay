# CORE V1 Auto Development Team

## Goal lock

The active program is intentionally limited to four lanes:

1. Agent Relay
2. actl
3. JuPlan
4. JuCeipt

JuControler is the later Windows/UI integration target. Other Ju* projects are outside the active CORE V1 queue unless they are explicitly re-authorized.

## Required loop

Each managed lane follows the same contract:

```text
Project PM
  -> Agent Relay
  -> Worker
  -> RESULT_PACKET
  -> independent QA
  -> ACCEPT | REQUEST_CHANGES | FOUNDER_GATE
```

`REQUEST_CHANGES` returns to the Worker automatically within retry policy. `ACCEPT` returns control to the Project PM, which may dispatch only the next repository-authorized task. Founder interruption is reserved for real Founder Gates.

## PM safety model

The current PM implementation uses Codex in read-only mode. The PM is not allowed to invent task scope. It can only dispatch the exact next task already registered in the project's authoritative CORE V1 manifest.

This keeps AI PM behavior useful while preserving repository-backed authorization.

`codex-chatgpt-web` may be used later as an optional bootstrap/view transport, but it is not part of the Agent Relay runtime dependency chain and is not required for the CORE V1 loop.

## Independent QA

A project can set `qaRuntime` independently from its Worker runtime. CORE V1 currently uses Codex QA for the four managed lanes, so Cursor/Claude Product Workers do not self-certify their own result process.

## Commands

```bash
npm exec -- agent-relay core-v1 up
npm exec -- agent-relay core-v1 once
npm exec -- agent-relay core-v1 status
npm exec -- agent-relay core-v1 results
npm exec -- agent-relay core-v1 results --json
npm exec -- agent-relay core-v1 reconcile
npm exec -- agent-relay core-v1 stop
```

`core-v1 results` is intentionally plain text so the MainPC can copy all lane results at once over SSH, for example:

```powershell
ssh asus "cd ~/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03 && npm exec -- agent-relay core-v1 results" | Set-Clipboard
```

## Lane rules

- **Agent Relay:** Priority 0. PM-managed self-dogfood lane.
- **actl:** Cursor remains the Product Worker. No new implementation is invented while the current Founder Windows E2E gate is authoritative.
- **JuPlan:** V1 stays STABLE. Only explicit bounded Agent Relay integration work may be registered as a task.
- **JuCeipt:** Dirty primary checkout remains protected. No Relay-managed commit is allowed until an exact authorized patch/task is registered safely.
- **JuControler:** inactive integration target until the CORE V1 loop is stable.

## Acceptance definition

The team is operational when a real task can complete:

```text
PM decision
-> Relay queue
-> Worker
-> RESULT_PACKET
-> independent QA
-> ACCEPT or automatic retry
-> PM NEXT
```

without the Founder manually copying intermediate Worker/QA prompts.
