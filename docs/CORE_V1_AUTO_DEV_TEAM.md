# CORE V1 Automatic Development Team

## Goal

Replace Founder-driven prompt shuttling with one Agent Relay-managed loop per active project:

`Project PM -> Agent Relay -> Worker -> RESULT_PACKET -> independent QA -> retry or ACCEPT -> PM NEXT`

The Founder is only interrupted for payment, credentials/OAuth, irreversible external actions, true Product decisions, or required physical E2E.

## Active lanes

- `agent-relay`: Codex PM -> Codex Worker -> Codex QA. Self-dogfood is the first acceptance proof.
- `juactl`: Codex PM -> Cursor Worker -> Codex QA. Product implementation remains blocked unless repository scope authorizes it; current physical Founder gate is Windows Board `SEND -> RESULT -> COPY`.
- `juplan`: Codex PM. V1 remains STABLE/complete until a bounded integration task is recorded in the authoritative SSOT/WBS. No V1.1 Product expansion is implied.
- `juceipt`: Codex PM -> Claude Worker -> Codex QA once the exact already-authorized Retry 01 dirty patch is safely captured. The dirty primary checkout must not be reset/cleaned/stashed wholesale.
- `jucontroler`: not an active Worker lane. It remains the later MainPC Windows/UI integration target.

## Runtime discovery

Agent Relay must not assume that an interactive CLI is also present in the non-interactive SSH PATH. Runtime adapters resolve installed executables through the user's login shell and then execute the resolved absolute path.

Cursor discovery order: explicit `CURSOR_BIN`, `agent`, `cursor-agent`, `cursor`.

Claude discovery order: explicit `CLAUDE_BIN` / `CLAUDE_TEAM_BIN`, then `claude`.

`claude-team` is an ownership lane, not a separate executable requirement; it may use the authenticated Claude Code CLI while preserving owner/runtime identity in Agent Relay.

## State isolation

Legacy `portfolio` state and CORE V1 managed-team state are intentionally separate.

- legacy: `~/.local/share/AgentRelay/data/portfolio-execution/state.json`
- CORE V1: `~/.local/share/AgentRelay/data/portfolio-execution/core-v1/state.json`

This prevents stale Portfolio decisions/tasks from making a fresh CORE V1 lane appear complete, held, or queued incorrectly.

## PM safety model

The current PM implementation uses Codex in read-only mode. The PM is not allowed to invent task scope. It can only dispatch the exact next task already registered in the project's authoritative CORE V1 manifest.

`codex-chatgpt-web` may be used later as an optional bootstrap/view transport, but it is not part of the Agent Relay runtime dependency chain and is not required for the CORE V1 loop.

## Independent QA

A project can set `qaRuntime` independently from its Worker runtime. CORE V1 currently uses Codex QA for managed lanes, so Cursor/Claude Product Workers do not self-certify their own result process.

## Durable accepted work

A managed task is not allowed to advance merely because QA printed `ACCEPT`.

After QA accepts, Agent Relay promotes the accepted commit to:

`refs/heads/agent-relay/core-v1/<project>`

Only a promoted managed task is considered complete for PM NEXT selection. The following task worktree starts from that managed ref.

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

`core-v1 results` is intentionally plain text so MainPC can copy all lane results at once over SSH.

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
-> durable promotion
-> PM NEXT
```

without the Founder manually copying intermediate Worker/QA prompts.
