# Direct GPT Relay Exhaustive Research 01

Status: RESEARCH ONLY. No V1 behavior, PM Cost Benchmark behavior, MCP wake semantics, Connection Profile architecture, or Worker dispatch is changed by this record.

## Executive finding

Keep the primary architecture: **GPT <-> Agent Relay <-> Worker Agent**. The certified direct MCP/App path is still the best Tier 1 control. The measured B1 result is a whole-cycle observation, not a per-wake price: one minimal Worker Result -> wake -> review -> ACCEPT reduced the Owner's displayed five-hour remaining allowance from 91% to 88% and weekly remaining allowance from 58% to 57%.

There are three realistic GPT-preserving paths worth testing before any PM-host replacement:

1. **Tier 1:** retain the direct plugin/MCP path but test the lowest available Work model/reasoning and a non-production minimal PM tool surface.
2. **Tier 2:** batch independently pending deliveries into one bounded GPT review turn, retaining the same Relay authority and per-delivery judgment rules.
3. **Tier 3:** evaluate ChatGPT Workspace Agents and ChatGPT scheduled GitHub-event tasks as official, event-driven GPT hosts. They are not substitutes for the current path until plugin/MCP write access, usage pool, and result-return behavior are proven.

No result here supports moving to a local/cheap PM, browser automation, or OpenAI API PM as the primary design.

## Evidence and confidence rules

- **PROVEN_LOCAL:** observed in the certified Agent Relay path.
- **CONFIRMED_CHATGPT_HOST_SUPPORT:** explicitly documented by OpenAI for the relevant ChatGPT/Plugin host and, where noted, locally observed.
- **SPEC_SUPPORTED_BUT_CHATGPT_UNCONFIRMED:** plausible MCP/spec capability without a documented ChatGPT-host guarantee; never use as an architectural dependency until a live host experiment passes.
- **NOT_SUPPORTED_FOR_ARCHITECTURE:** no current official host contract was found; do not build against it.

Official sources used: [Plugin UI bridge](https://developers.openai.com/plugins/build/chatgpt-ui), [Plugin quickstart](https://developers.openai.com/plugins/build/app-quickstart), [ChatGPT Work cost guidance](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-usage-and-cost), [models and reasoning](https://learn.chatgpt.com/docs/models), [scheduled tasks](https://learn.chatgpt.com/docs/automations), and [Workspace Agent triggers](https://learn.chatgpt.com/workspace-agents/trigger-runs).

## Track A — Work cost decomposition and isolated micro-benchmarks

OpenAI documents that tokens cover model input, cached input, and output; available model/reasoning controls affect token use, and higher reasoning uses more tokens. It does not publish a ChatGPT Work formula assigning an allowance percentage to `ui/message`, a tool call, or a widget. Therefore B1's -3/-1 point observation cannot be decomposed by assertion.

Run only the following isolated tests, each in a fresh comparable Work conversation, with the same native BEFORE/AFTER evidence format and no Worker dispatch:

| ID | Isolate | Action | Hold constant | Signal |
| --- | --- | --- | --- | --- |
| A1 | base Work turn | Ask for exact `ACK` with no app selected | model, reasoning, fresh thread | Work-entry + tiny-turn floor |
| A2 | one read tool | Call a dedicated tiny read-only relay health/status tool once | A1 prompt/output length | MCP tool-selection/call increment |
| A3 | one write tool | Call a dedicated no-op, audited test-only write endpoint once | A2 context/output | host/tool write-path increment; not a production mutation |
| A4 | host follow-up | A mounted minimal widget issues one bounded `ui/message` `PING` | no Relay Result/Worker | wake-to-assistant-turn increment |
| A5 | context size | same read/judgment-shaped response at 100, 1k, and 10k characters | model, prompt, fresh thread | Verification Context sensitivity |
| A6 | history | repeat A2 in fresh, short, and bounded-long threads | same tool result | accumulated-history sensitivity |
| A7 | configuration | repeat only lowest-cost passing A2 under each Owner-visible model/reasoning pair | exact test card | model/reasoning sensitivity |

Each test is an experiment design, not authorization to build its special fixture now. Never call a fake mutation a Relay judgment, and never use a real Task/Run to measure A1-A7.

## Track B — cheaper Work configuration

The official model control is beneath the Work composer; it exposes only models and reasoning levels available to that account/workspace. The documentation recommends the lowest reasoning that produces the required result, describes Light/Low for quick well-scoped work, and positions Luna for clear repeatable high-volume tasks. Higher reasoning consumes more tokens; Ultra also adds subagents and is unsuitable for a narrow PM judgment baseline.

**Required Owner-visible audit before testing:** screenshot the Work model dropdown and reasoning selector; record every selectable model/effort pair, whether the Agent Relay plugin is selectable in that configuration, whether the widget mounts, and the native allowance unit. Do not infer availability, tool support, or cheaper billing from model names. Candidate first test: the lowest available reasoning on the lightest model that still exposes the Relay plugin and returns a correct bounded judgment.

## Track C — Normal Chat plus MCP

OpenAI's plugin controls document plugins in both Chat and Work. Plugin UI documentation also shows normal MCP tools may drive a UI and that UI code may call tools. This confirms that an MCP/Plugin is not, at the documented platform level, intrinsically Work-only.

However, official documentation reviewed here does **not** say whether a custom app with write tools, a UI resource, `_meta.ui.resourceUri`, or `ui/message` must promote a specific conversation to Work. The Owner's observed promotion of the current widget is real local evidence, but its cause is **UNCONFIRMED**: it could be host rollout, account/plan, conversation selection, or current app surface. The only safe conclusion is a one-turn normal-Chat experiment with an otherwise identical minimal app. Do not remove write tools or alter V1 merely to speculate.

## Track D — reduce GPT turns

The existing widget sends one `ui/message` per claimed delivery. One host follow-up may contain a bounded batch summary, but whether ChatGPT will reliably read N contexts and issue N independent judgments in one assistant turn is unproven. It requires a future safety design: immutable delivery identities, per-delivery CAS, maximum batch size, no cross-delivery ACCEPT inference, and a clear escalation path for mixed outcomes.

Promising Tier 2 design hypothesis: widget waits for `min(N, timeout)` pending deliveries, wakes once with identity-only batch instruction, GPT calls `get_pending_deliveries`, gets each Verification Context, then submits one judgment per delivery. This can reduce wake/assistant-turn count but cannot eliminate the model work of reviewing N results. It is a future experiment, not a G4/G5 change.

A standing decision contract can reduce escalations only for explicitly objective, pre-authorized outcomes. It cannot replace GPT for subjective verification without becoming Tier 4 autonomous middle orchestration. Component state updates can update UI state, but OpenAI documentation does not establish that a state update invokes the model; use it for presentation, not as a free PM wake.

## Track E — event-triggered GPT

ChatGPT scheduled tasks officially support event triggers for Gmail, Slack, and GitHub Pull Request activity on eligible plans. GitHub triggers can filter PR activity and may coalesce multiple matching events arriving close together into one run. This is a genuine Tier 3 GPT event surface, potentially useful for an externalized review queue.

Limits: it is not a direct Relay webhook; only the named connected-app events are documented. It requires a GitHub artifact/event bridge, has event/queue latency, and official docs do not establish that the task can access the Agent Relay plugin or write a Relay judgment. It must be tested as a near-direct GPT PM transport, not assumed. It remains behind direct MCP batching because it adds GitHub and deferred review.

## Track F/H — Workspace Agents and other official entry points

**Workspace Agents are the strongest new official direct-event candidate.** OpenAI documents a server-side API to trigger a published ChatGPT Workspace Agent, optional stable `conversation_key` for continuing its conversation, idempotency keys, and beta run-status polling. A successful trigger currently returns accepted/conversation status, but the agent response itself cannot currently be retrieved through that API. This means a viable Relay design would require the agent to write its bounded decision back through a proven Relay plugin/tool, after which Relay reads its own durable record. That plugin access, the applicable plan, agent model/reasoning controls, and its usage pool are not proven here.

This is not ordinary OpenAI API PM: it is a ChatGPT Workspace Agent host with an official trigger API. It may nevertheless require Workspace Agent access tokens and eligible Business/Enterprise configuration, so it is a Tier 3 evaluation—not the current primary recommendation.

No official arbitrary inbound webhook-to-ChatGPT-Work trigger, generic custom-MCP-event trigger, desktop deep-link trigger, or direct server notification that starts a ChatGPT Work turn was found in the reviewed documentation. Scheduled tasks and Workspace Agent triggers are the documented official event entries.

## Track G — Apps SDK/MCP wake surface

| Capability | Classification | Finding |
| --- | --- | --- |
| `ui/initialize`, `tools/call` | CONFIRMED_CHATGPT_HOST_SUPPORT | Documented MCP Apps bridge methods; locally used. |
| `ui/message` / `window.openai.sendFollowUpMessage` | CONFIRMED_CHATGPT_HOST_SUPPORT | Official mapping and locally proven automatic wake. |
| `window.openai.widgetState` | CONFIRMED_CHATGPT_HOST_SUPPORT | UI-state persistence only; no documented model wake. |
| tool-associated UI resource | CONFIRMED_CHATGPT_HOST_SUPPORT | Official `_meta.ui.resourceUri` mapping. |
| server notifications/resource updates/subscriptions | SPEC_SUPPORTED_BUT_CHATGPT_UNCONFIRMED | No reviewed OpenAI ChatGPT-host contract says these create a model turn. |
| MCP Tasks as a ChatGPT PM scheduler | SPEC_SUPPORTED_BUT_CHATGPT_UNCONFIRMED | No reviewed OpenAI host documentation binds MCP Tasks to ChatGPT Work wake/judgment. |
| `sendFollowUpMessage` as a zero-cost update | NOT_SUPPORTED_FOR_ARCHITECTURE | It is a follow-up message mechanism, not a documented cost-free model bypass. |

## Track I — minimal MCP surface

Local measurement of the current production app's `tools/list` payload found 36 tools, 15,906 JSON bytes, 6,453 schema bytes, and 6,925 description characters. A candidate four-tool PM-only surface—`relay_pm_open_widget`, `relay_pm_list_pending_deliveries`, `relay_pm_get_verification_context`, `relay_pm_submit_judgment`—is 2,077 JSON bytes, 520 schema bytes, and 1,202 description characters: an 86.9% static JSON reduction.

This is a **context-footprint hypothesis**, not a usage reduction claim. The next implementation, if authorized after measurement, must be an isolated non-production endpoint/connector; it must retain the existing production 36-tool app and preserve claim/wake failure semantics. The candidate needs one additional safe mechanism for the widget's durable wake claim; do not silently omit it just to reach four tools.

## Track J — conversation-context cost

Tokens include input and output, so long conversation/tool history is a credible cost driver, but the Work allowance effect is not published. Compare: (A) one long PM thread, (B) fresh thread per review, (C) rolling bounded PM summary, and (D) Relay-owned state plus minimal GPT context. The controlled A6 experiment decides it.

Current default recommendation pending measurement: keep Relay as durable state SSOT, use a concise task-scoped PM instruction and a bounded verification packet, and avoid unrelated project conversation history. Do not assume fresh threads are cheaper: they can lose useful context and require repeated setup.

## Track K — last-resort direct-GPT transports

| Path | Classification | Decision |
| --- | --- | --- |
| Official Workspace Agent trigger | SUPPORTED (subject to eligibility) | Tier 3 experiment only. |
| Scheduled GitHub event task | SUPPORTED (eligible plans/events) | Tier 3 experiment only. |
| Browser extension/client automation | FRAGILE | last resort; do not implement. |
| Desktop UI automation | FRAGILE | last resort; no product dependency. |
| Undocumented deep links/webhooks | UNSUPPORTED | do not build. |
| Credential scraping or bypassing host controls | PROHIBITED | never use. |

## Option matrix

| Option | Direct GPT preserved | Owner manual action | Uses Work allowance | PM calls | Automatic wake | MCP write | Multi-worker scale | Difficulty / reliability | Official support | Required experiment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current Work + full Relay app | Yes | initial setup | Yes, observed | ~1/result | Yes | Yes | limited by 1:1 turns | low / proven local | confirmed | baseline B1 only |
| Work + low reasoning/light model | Yes | select config | Yes, unknown delta | ~1/result | Yes if available | unknown per config | same | low / unknown | model controls confirmed | A7 |
| Normal Chat + same/minimal app | Yes | start Chat | unknown pool/limit | ~1/result | host behavior unproven | app tools supported; exact host behavior unknown | same | low / unknown | plugins in Chat confirmed | C1 |
| Minimal PM MCP endpoint | Yes | connector setup | likely Work if Work host | ~1/result | Yes | Yes | same | medium / high after proof | tool/UI primitives confirmed | I1 |
| Batched pending-delivery wake | Yes | none after setup | Yes, fewer turns hypothesis | <=1/batch | future change | Yes | good | medium / unproven | `ui/message` confirmed, batching semantics not | D1 |
| Scheduled GitHub PR task | Yes, near-direct | connector/task setup | unknown | <=1/coalesced event | event-driven | plugin access unproven | moderate | high / unproven | triggers/coalescing confirmed | E1 |
| Workspace Agent trigger | Yes | admin/publish/token setup | unknown, likely Workspace-Agent governed | 1/trigger | server-triggered | plugin access unproven | good | medium / unproven | trigger API confirmed | F1 |
| GPT planner/final reviewer only | partially | none after policy | lower-turn hypothesis | 2/task | possible | yes | good | high / changes architecture | not evaluated | defer |
| Local/cheap PM | No primary GPT PM | setup | no/other cost | varies | yes | yes | good | medium | secondary only | defer |
| Browser/client automation | nominally | ongoing | unknown | varies | fragile | fragile | poor | high / fragile | no | do not implement |

## Top five experiments (ranked value/cost)

All use the native BEFORE/AFTER record, a fresh comparable conversation, no Worker dispatch, one action only, and a hard stop if the allowance moves by more than the stated cap. A percentage UI may round; preserve the raw displayed unit rather than inventing precision.

| Rank | Hypothesis / exact setup | Pass / fail signal | Maximum burn |
| --- | --- | --- | --- |
| 1 — C1 | A fresh normal Chat conversation, current verified connector, one `relay_pm_open_widget` request with no Task. Capture mode before/after. | Pass: widget mounts and remains Chat with tool access; Fail: host promotes to Work or tools/UI unavailable. | 1 five-hour point; stop immediately on promotion. |
| 2 — A7-light | In fresh Work, select lowest Owner-visible model/effort that exposes Relay; perform one bounded no-Task read. | Pass: correct tool result and <=1 point delta relative to baseline measurement; Fail: unavailable, incorrect, widget/tool loss, or >1 point. | 1 five-hour point. |
| 3 — A1/A2 paired | On separate fresh Work threads, exact `ACK` versus one tiny read-only Relay health/status call; same short prompt. | Pass: reproducible difference within native display precision; Fail: no comparable measurement or >1 point in either run. | 2 five-hour points total. |
| 4 — I1 | Non-production four-to-five-tool connector exposes only bounded PM functions plus required wake claim; call `tools/list` and mount UI—no Task. | Pass: correct mount/tools and lower observed usage than full surface; Fail: parity/security loss or no measurable benefit. | 1 five-hour point. |
| 5 — F1 | If the Owner has an eligible Workspace Agent: publish a PM agent with a proven Relay plugin, trigger one identity-only synthetic event with idempotency key, and verify durable Relay writeback. | Pass: one queued/completed agent run and one correct durable decision; Fail: no eligibility/plugin writeback/response return path. | 1 five-hour point; otherwise zero (eligibility audit only). |

Expected maximum planned burn is **6 five-hour percentage points**, but execution is sequential with stop rules; it is not authorization to spend all six. Do not run A4/A5/A6/D1/E1 until the five tests above decide whether Tier 1 or the Workspace Agent path is viable. Do not run B2 during this research.

## Recommended paths

**Primary:** Tier 1 direct GPT + Relay + Worker. First test normal Chat retention and lowest viable Work model/reasoning. In parallel only as measurement design, retain a separate minimal PM app proposal; implement it only if C1/A7 shows the current host remains costly and I1 has a measurable benefit.

**Secondary:** Tier 2 bounded batching of pending deliveries, but only after a safety design preserves independent delivery identity/CAS. If Tier 1 fails, evaluate Tier 3 Workspace Agent trigger before scheduled GitHub review; it is more direct and supports stable conversation keys, though token/access/plugin behavior remains unproven.

## Unknowns that block a recommendation change

1. Whether the current connector/widget's Work promotion is caused by the app, write tools, UI metadata, or Owner-specific rollout.
2. Which model/reasoning choices the Owner actually sees and whether each retains the plugin/UI/follow-up path.
3. Native allowance attribution for turns, tools, result/context size, and conversation history.
4. Whether a normal Chat plugin follow-up can automatically create the required PM turn.
5. Whether Workspace Agents can use the Agent Relay plugin/write tools, their applicable plan/usage pool, and a reliable Relay-visible output path.
6. Whether scheduled GitHub tasks can access the same plugin/write path and what their event-to-review latency/cost is.
7. Whether ChatGPT hosts MCP server notifications, resource updates, subscriptions, or MCP Tasks as a model-wake mechanism.

## No-change receipt

Runtime behavior modified: **NO**. PM Cost Benchmark B2 run: **NO**. New Task/dispatch: **NO**. Browser extension/API PM/local PM/GitHub deferred review implementation: **NO**.
