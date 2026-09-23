# C1 Normal Chat MCP Promotion Boundary — Preparation 01

Status: OWNER TEST READY. This is an isolated diagnostic; it does not modify the production MCP App, Agent Relay data root, V1, G4/G5, or any Task.

## Purpose and controls

OpenAI Docs confirms that Plugins can be used in Chat and Work, and that an MCP UI can expose UI resources, tool calls, and `ui/message`. It does not publish a rule saying a UI resource, tool-count, write tool, or follow-up message necessarily promotes a conversation to Work. This experiment identifies the Owner-host boundary without claiming a cause in advance.

All diagnostic variants hold these constants: Streamable HTTP MCP, one static App widget resource (`ui://agent-relay-diagnostic/c1-boundary-widget`), one opener with `_meta.ui.resourceUri`, identical `ui/initialize`, and an optional manual `ui/message` button. They never read Agent Relay state or dispatch a Worker. The optional write probe is process-local memory only.

## Variant matrix and exact delta

| Variant | Tools | Catalog JSON bytes | Input-schema bytes | Read/write | Widget / `_meta` / annotation | `ui/message` | Delta from previous |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| C1-A | `relay_pm_open_widget` | 335 | 76 | opener/UI only | 1 static resource; opener has `_meta.ui.resourceUri`; no annotations | identical optional bridge button; host proof pending | baseline UI resource |
| C1-B | A + `relay_diag_read_status` | 588 | 152 | one harmless read | same as A | same as A | add one read-only tool |
| C1-C | A + list pending work + verification context | 917 | 284 | two PM-shaped reads | same as A | same as A | replace B's generic read with the minimum PM read pair |
| C1-D | C + `relay_pm_submit_judgment` diagnostic probe | 1,384 | 484 | one process-local write | same as A | same as A | add exactly one PM-shaped write |
| C1-E | same four-tool minimum PM shape | 1,329 | 484 | diagnostic inert judgment | same as A | same as A | production-shaped descriptions only; no admin/worker/debug catalog |
| C1-F | production app | 15,906 | 6,453 | production reads/writes/wake | `ui://agent-relay/pm-widget-v2`; `relay_pm_open_widget` has `_meta.ui.resourceUri`; no returned annotations | existing production widget behavior; not exercised in C1 transport validation | known Work-promoting control |

The byte counts are UTF-8 `JSON.stringify(tools)` and the sum of UTF-8 `JSON.stringify(inputSchema)` from the verified public `tools/list` response on 2026-09-05. C1-A/B isolate UI versus a single generic read. C1-B/C intentionally switch the **read-surface role** from one generic diagnostic read to the two PM reads required for inspection. C1-C/D then varies only write capability; C1-D/E vary only production-shaped descriptions. Neither writes Relay state.

## Launch commands

Use unique local ports and the existing `/tmp/agent-relay-cloudflared` binary. Each process is disposable and must be stopped after its Owner test.

```bash
node scripts/c1-normal-chat-boundary-server.mjs --variant c1-a --port 3901
node scripts/c1-normal-chat-boundary-server.mjs --variant c1-b --port 3902
node scripts/c1-normal-chat-boundary-server.mjs --variant c1-c --port 3903
node scripts/c1-normal-chat-boundary-server.mjs --variant c1-d --port 3904
node scripts/c1-normal-chat-boundary-server.mjs --variant c1-e --port 3905
/tmp/agent-relay-cloudflared tunnel --url http://127.0.0.1:<port>
```

## Verified public endpoints

All endpoints below passed public `/health`, `initialize`, `tools/list`, `resources/list`, widget `resources/read`, and opener `tools/call` (where the diagnostic opener exists) on 2026-09-05. The optional `ui/message` control requires the ChatGPT-host Owner proof and has not been invoked by this transport check.

| Variant | Exact MCP URL | Connector name |
| --- | --- | --- |
| C1-A | `https://brunette-departmental-feeds-deployment.trycloudflare.com/mcp` | `Agent Relay C1-A UI only` |
| C1-B | `https://alien-call-teach-stage.trycloudflare.com/mcp` | `Agent Relay C1-B one read` |
| C1-C | `https://qualifying-weblog-joint-restrictions.trycloudflare.com/mcp` | `Agent Relay C1-C PM reads` |
| C1-D | `https://radio-rounds-sweet-corners.trycloudflare.com/mcp` | `Agent Relay C1-D one write` |
| C1-E | `https://zum-minds-mississippi-bali.trycloudflare.com/mcp` | `Agent Relay C1-E min PM` |
| C1-F | `https://ana-grass-inspection-era.trycloudflare.com/mcp` | existing production connector |

## Owner test procedure — Phase 1 (promotion only)

Perform the baseline/read sequence A -> B -> C. Run D only if C remains normal Chat (C is then the smallest passing **PM-read** surface); run E only if D remains normal Chat. Run F last only while the allowance budget remains. If a prior variant promotes before the stated observation is captured, stop rather than consume allowance on later variants. For each permitted variant: create/select only that connector, open a **fresh normal Chat**, and send exactly:

```text
Open the Agent Relay C1 diagnostic widget. Do not call any other tool.
```

| Variant | Connector name | Exact MCP URL | Expected observation | Required screenshot |
| --- | --- | --- | --- | --- |
| C1-A | `Agent Relay C1-A UI only` | `https://brunette-departmental-feeds-deployment.trycloudflare.com/mcp` | widget shows `Connected — diagnostic idle`; determine Chat vs Work | conversation mode + mounted widget + timestamp |
| C1-B | `Agent Relay C1-B one read` | `https://alien-call-teach-stage.trycloudflare.com/mcp` | same; no automatic tool call expected | same |
| C1-C | `Agent Relay C1-C PM reads` | `https://qualifying-weblog-joint-restrictions.trycloudflare.com/mcp` | same; no automatic tool call expected | same |
| C1-D | `Agent Relay C1-D one write` | `https://radio-rounds-sweet-corners.trycloudflare.com/mcp` | same; never click/call judgment in Phase 1 | same |
| C1-E | `Agent Relay C1-E min PM` | `https://zum-minds-mississippi-bali.trycloudflare.com/mcp` | same; never call judgment in Phase 1 | same |
| C1-F | existing production connector | `https://ana-grass-inspection-era.trycloudflare.com/mcp` | current widget behavior/control | same |

Record the exact URL, connector name, mode before/after prompt, widget mount yes/no, tools-callable yes/no, and native usage before/after in the C1 record. A server health page (`/health`) and MCP `initialize`, `tools/list`, `resources/list`, and widget `resources/read` must pass before Owner testing.

## Phase 2 — optional follow-up proof

Only for the smallest Phase-1 variant that remains normal Chat, use a new fresh normal Chat and the same connector. Mount the widget, click **Optional diagnostic follow-up** once, and observe whether Chat remains normal and a reply is created. The fixed payload asks for `C1_DIAGNOSTIC_ACK` and explicitly forbids tools. Capture before/after mode and native usage. It creates no Task, Worker, data-root write, or production Relay write.

## Cost and stop rules

- Total additional five-hour allowance target: **<= 1 displayed percentage point**, measured cumulatively across the C1 sequence.
- Capture native usage before C1-A and after every variant; preserve the UI's native unit and rounding.
- Stop immediately if cumulative burn exceeds one point, a host unexpectedly enters Work before the intended observation is captured, a diagnostic tool touches Relay state, or any Worker/Task activity appears.
- Do not test optional follow-up if Phase 1 has consumed the allowance budget.

## Decision tree

- A promotes: UI resource/opener is the first confirmed boundary; do not infer a write-tool cause.
- A stays Chat, B/C promote: the first changed read/catalog boundary is the result.
- C stays Chat, D promotes: one PM-shaped write capability is the candidate boundary; next architecture question is a supported separation of Chat UI/read from a write decision path.
- E stays Chat: minimum PM catalog becomes highest-priority surface candidate, subject to a separate security/parity design.
- F alone promotes: catalog size/production metadata is implicated, not yet causally proved; run I1.

## Follow-up definitions (not authorized to run now)

- **A7 — lowest viable Work model/reasoning.** Hypothesis: an Owner-visible lower model/reasoning pair preserves one bounded PM read/mount while using less native Work allowance. Setup: the smallest C1 surface that passes functional mount, one fresh Work chat per pair, and no Task/Worker. Capture native before and after each pair; prompt only for the diagnostic widget and its bounded static read. Signal: exact mode/model/effort, mount result, tool result, and native delta. Pass: functional parity at a lower native delta; fail: no lower option, no parity, or a larger delta. Stop at one displayed five-hour point across A7.
- **I1 — minimal PM MCP usage.** Hypothesis: catalog/context reduction lowers a bounded Work PM interaction's native cost. Setup: current C1-F and C1-E in matched fresh Work chats, same short prompt, no Task/Worker, and no follow-up. Capture native before/after and the 36-tool versus four-tool catalog sizes. Signal: native delta plus mount/tool success. Pass: lower delta with equivalent bounded behavior; fail: no material native reduction or lost behavior. Stop at one displayed five-hour point across I1.
- **S1 — Standing PM Contract feasibility.** Hypothesis: a pre-authorized, explicitly bounded objective policy can let Relay continue without another GPT turn while reserving subjective acceptance/changes for GPT. Setup: architecture-only review of a single synthetic contract with scope, expiry, allowed objective predicates, escalation events, and immutable audit evidence. Pass: a contract can fail closed and cannot autonomously ACCEPT subjective Worker output; fail: it requires a broad autonomous judgment or weakens G4/G5. No runtime or Work experiment is authorized.
- **BATCH-1 — one wake, multiple deliveries.** Hypothesis: one supported follow-up can let GPT inspect and decide two independent bounded synthetic deliveries in one assistant turn. Setup: isolated synthetic server, two fixed delivery IDs, distinct static Verification Contexts, explicit per-delivery CAS values, one manual `ui/message`, and no Task/Worker. Capture native before/after, wake count, assistant-turn count, and each independent result. Pass: exactly one wake/one GPT review with two correct non-cross-contaminated decisions; fail: host creates separate turns, mixes deliveries, or any state escapes the diagnostic server. Stop at one displayed five-hour point.

## No-change receipt

Production runtime changed: NO. Worker dispatched: NO. Production Task created: NO. PM Cost B2 run: NO.
