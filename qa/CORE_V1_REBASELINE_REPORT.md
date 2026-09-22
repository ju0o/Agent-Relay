# Agent Relay CORE V1 Rebaseline

BRANCH=feat/v2-portfolio-autopilot-dogfood-03
BASE_HEAD=22765d9e5d4a124092e4a737945465d4f99797a
INFRA_COMMIT=bc54411c3acd23b80af1ecfd6dc7bebc54daeffc
SELF_DOGFOOD_TASK_1_COMMIT=f4633f84956c696379ba9e83a368b6967097aa39
SELF_DOGFOOD_TASK_2_COMMIT=ec138d65d6db3aa463af0d53304c61584dbe72a0

## Bootstrap transport

`codex-chatgpt-web` is already installed at `~/.codex-chatgpt-web` (runtime
5.0.8). The browser endpoint `127.0.0.1:42777` returned HTTP 200 and the
control endpoint `127.0.0.1:41327` is listening and correctly returned HTTP
401 without its protected credential. The running serve process was PID 3974
with launcher PID 3232.

Agent Relay has no consumer for this transport: no `chatgpt-web`/`codex-web`
integration exists in `src`, `bridge`, `scripts`, or `test`. The exact broken
edge is ChatGPT Web PM → development transport → Agent Relay intake. The
local closed loop starts from the repository manifest/state instead. Worker →
QA → ACCEPT → NEXT is operational locally, but PM input and result return are
not yet carried through this bootstrap.

## CORE V1 table

| project | V1 criteria / SSOT | progress and next authorized task | Worker | QA | blocker | execute now |
|---|---|---|---|---|---|---|
| Agent Relay | `BACKLOG.md`, `config/portfolio.json`; PM → Worker → RESULT → QA → NEXT | Two ordered self-dogfood tasks accepted; `V1_COMPLETE` | Codex | Codex read-only | PM transport intake gap | YES, local manifest loop |
| actl | JuActl private SSOT, target `5ffaeb4d…` | No bounded Agent Relay-owned actl V1 task authorized | Cursor | independent QA after task | `BLOCKED_SCOPE`; dirty primary requires isolation | NO |
| JuPlan | `JuPlan-Private/CONTROL_TOWER.md`; V1 release package | V1 evidence complete; Founder PAUSE keeps V1.1 idle | Claude Team | independent QA after task | `HOLD`: V1.1 not authorized; public visibility requires Founder GO | NO |
| JuCeipt | `JuCeipt-Private/docs/operations/PM_STATUS_BOARD.md`; M2/MVP acceptance | M2 PM review not closed; no implementation task | Claude | independent QA after task | `BLOCKED_SCOPE`, Claude auth unavailable, 48 dirty changes preserved | NO |
| JuControler | private SSOT; integration target only | Not a CORE V1 implementation lane | Claude Team | — | `INTEGRATION_TARGET` / HOLD | NO |

Unrelated projects were removed from the active manifest queue. JuQode and
JuAgentEconomy remain only as durable historical evidence; JuMembers and
JuDoctor are not active or discovered. No prior accepted task was replayed.

## Agent Relay self-dogfood evidence

First authorized task:
`AGENTRELAY-V1-MOVE-RUN-RECURSIVE`

- Builder PID `632264`, writable isolated worktree
  `.../worktrees/agent-relay-agentrelay-v1-move-run-recursive-1790081554427`
- real change committed as `f4633f84956c696379ba9e83a368b6967097aa39`
- structured RESULT_PACKET: `IMPLEMENTED`, changed `src/backend/fs.ts` and
  `test/fs.test.mjs`, requested build/test commands
- independent QA PID `646285`, verdict `ACCEPT`
- task persisted as `VERIFIED_DONE`

Automatic NEXT proof:
after the first ACCEPT, the runner selected
`AGENTRELAY-V1-EXPORT-NESTED-PATH` without Founder relay.

- Builder PID `654641`, writable isolated worktree
  `.../worktrees/agent-relay-agentrelay-v1-export-nested-path-1790081940896`
- real change committed as `ec138d65d6db3aa463af0d53304c61584dbe72a0`
- independent QA PID `664050`, verdict `ACCEPT`
- task persisted as `VERIFIED_DONE`
- final Agent Relay project state: `V1_COMPLETE`

No REQUEST_CHANGES occurred in this run, so no retry was needed. The retry
path remains covered by the focused runner tests. No Founder manually copied
Worker or QA prompts/results during this self-dogfood.

## Remaining CORE V1 WBS

1. Add the repository-backed PM intake/result return contract for the temporary
   `codex-chatgpt-web` bootstrap without making it a permanent dependency.
2. Give actl a bounded authorized V1 task only after the Agent Relay loop can
   drive it through its Cursor adapter.
3. Reconcile JuCeipt M2 PM review and Claude runtime availability; preserve the
   dirty primary checkout and use an isolated clean base.
4. Keep JuPlan V1 stable and do not start V1.1 while PAUSE remains authoritative.
5. Defer JuControler integration until the four CORE V1 products are
   operational.

## Validation

FOCUSED_TESTS=`node --test test/v2/portfolio-runner.test.mjs` — 7/7 PASS
FULL_TEST=`npm test` — PASS (`test:fs`, `test:vnext`, `test:v03`)
TYPECHECK=`npm run typecheck` — PASS
DIFF_CHECK=`git diff --check` — PASS
ACTIVE_MANIFEST=agent-relay,juactl,juplan,juceipt
INACTIVE_MANIFEST=jucontroler
ACTIVE_BUILDERS=0
ACTIVE_QA=0
RESTART_RECONCILE=PASS (persistent service remained RUNNING; completed tasks were not replayed)
FOUNDER_MANUAL_RELAY=0
FOUNDER_GATE=none created by this run; existing JuPlan Founder PAUSE remains authoritative

FINAL_STATUS=CORE_V1_LOOP_PARTIAL
