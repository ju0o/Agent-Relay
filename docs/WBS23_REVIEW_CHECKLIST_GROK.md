WBS23_REVIEW_CHECKLIST: 2026-09-16T06:55:08Z

# Independent review checklist — WBS-2 / WBS-3 must NOT break the observation boundary

**Issue:** ju0o/Agent-Relay#6 (V1 role-runtime orchestrator; supersedes ChatGPT-Work-wake-first as primary path)  
**Specs:** `Agent-Relay-ghpm/docs/WBS1_2_SPEC.md`, `docs/WBS3_SPEC.md`  
**Tree:** `/home/skkse12/Desktop/Projects/Core/Agent-Relay-ghpm` (read-only for this note)

WBS-2 adds a **separate** command-side `RoleRuntimeAdapter`. WBS-3 adds an OpenCode **command** adapter. Neither may mutate or overload the existing **observe-only** `AgentAdapter` contract.

---

## 1. Observation boundary — byte-compatible exports (do not change semantics)

### 1.1 `src/integrations/core/types.ts` — AgentAdapter observation SSOT

| Export | Line | Must remain |
|---|---:|---|
| `CompletionKind` | 10 | Union of `RESPONSE_COMPLETE` \| `PROCESS_FAILED` \| `INTERRUPTED` \| `BLOCKED` \| `UNKNOWN` |
| `COMPLETION_KINDS` | 17 | Array mirror of the union |
| `AgentCompletion` | 25 | Fields: `adapterId`, `agentName`, `sessionId?`, `workspace`, `startedAt?`, `observedAt`, `terminalSignal`, `exitCode?`, `rawFinalText`, `rawProtocolRef?`, `completionKind` — **RESPONSE_COMPLETE ≠ Task success** |
| `AdapterPhase` | 46 | `connecting` \| `watching` \| `captured` \| `error` \| `stopped` |
| `SessionObservation` | 49 | `sessionId`, `directory?`, `title?`, `updatedMs?`, `isNew`, `inFlight` |
| `AdapterEvent` | 60 | `status` \| `completion` \| `error` \| `sessions` (+ `armPass`) |
| `WatchTarget` | 70 | `workspaceRoot?`, `claudeConfigDir?` |
| `WatchHandle` | 80 | `adapterId`, `stop()` |
| `AgentAdapter` | 85 | `id`, `agentName`, `startWatch(target, sink)` only — **no send/command methods** |
| `CaptureOutcome` | 96 | `ok`, `written`, `skipped`, `duplicate`, `reason?` |

**FAIL if WBS-2/3:** adds command methods onto `AgentAdapter`; changes `AgentCompletion` meaning; makes observation decide Task/QA success; renames/removes any export above without a versioned migration (none allowed in V1).

### 1.2 `src/integrations/core/validate.ts`

| Export | Line |
|---|---:|
| `ValidationResult` | 3 |
| `validateAgentCompletion` | 23 |

### 1.3 `src/integrations/core/registry.ts` (observation registry)

| Export | Line |
|---|---:|
| `registerAdapter` | 5 |
| `getAdapter` | 12 |
| `listAdapters` | 16 |
| `clearAdapters` | 21 |

Must stay distinct from role-runtime registry (do not merge maps).

### 1.4 `src/integrations/core/binding.ts`

| Export | Line |
|---|---:|
| `BindingReason` | 23 |
| `BindingDecision` | 25 |
| `BindingInfo` | 27 |
| `turnCompletedAfterArm` | 42 |
| `turnStartedAfterArm` | 55 |
| `SessionBindingPolicy` | 69 |

### 1.5 `src/integrations/core/capture.ts`

| Export | Line |
|---|---:|
| `dedupeKeyOf` | 11 |
| `captureCompletion` | 45 |

### 1.6 OpenCode **observation** stack (reuse, don’t rewrite semantics)

| Export | File:line |
|---|---|
| `OcSessionInfo`, `OcMessage` | `opencode/client.ts:26`, `:33` |
| `OpenCodeServerClient` (+ `attach`, `launch`, `listSessions`, `listMessages`, `stop`, `endpointPort`, `owned`) | `client.ts:155+` |
| `discoverRunningServers` | `client.ts:274` |
| `selectCandidateSessions` | `watch.ts:16` |
| `OpenCodeAdapter` implements `AgentAdapter` | `watch.ts:82` |
| `createOpenCodeAdapter` | `watch.ts:261` |
| `ExtractKind`, `ExtractResult`, `messageText`, `pickLastTurn`, `summarizeLastTurn` | `extract.ts:11+` |

### 1.7 Additive command-side surface (WBS-2 — already present; WBS-3 implements against it)

These are **allowed / expected** new files; they must **not** edit `AgentAdapter`:

| Export | File:line |
|---|---|
| `RoleCapabilityFlags`, `InputEnvelope`, `RoleRuntimeAdapter`, `RoleSession`, `roleSessionPath`, `readRoleSession`, `writeRoleSession`, `ensureRoleSession` | `core/role-runtime.ts:4–11` |
| `registerRoleRuntimeAdapter`, `getRoleRuntimeAdapter`, `listRoleRuntimeAdapters`, `clearRoleRuntimeAdapters`, `assertRoleSatisfiable`, `resolveRoleRuntime` | `core/role-runtime-registry.ts:4–9` |

**FAIL if:** observation `registerAdapter` is reused for command adapters; role-sessions JSON becomes Task/Run/Result SSOT; `AgentAdapter.startWatch` gains side-effecting send.

---

## 2. Existing OpenCode client — session scope & pitfalls the command adapter must respect

### 2.1 How sessions are scoped today

- Comment in `client.ts:15–18`: **`GET /session` is scoped by the server process’s resolved project** (git root of its cwd).
- `OpenCodeServerClient.launch(cwd?)` (`client.ts:178`): if `cwd` omitted → spawn in a **neutral non-git temp dir** to get a broader/global session list; if `cwd` set → sessions filtered to that project root.
- Health probe after launch: `GET /session` (`client.ts:193`) — not `/global/health` (WBS-3 adds that for the command server).
- `listMessages(sessionId)` → `GET /session/{id}/message` (`client.ts:230–234`).
- Observation watch (`watch.ts:98`) launches with `target.workspaceRoot`, then **also** `discoverRunningServers` to attach to live interactive servers (Windows-oriented discovery; Linux returns `[]` today — `client.ts:275`).

### 2.2 Port ownership & process lifecycle

| Rule | Detail |
|---|---|
| Port candidates | Observation launcher tries `47800–47809` (`client.ts:22`) |
| Ownership | `owned === (proc !== null)`; `attach(port)` never owns/`stop()` is no-op for attached servers (`client.ts:163–175`, `242–246`) |
| Listen proof | Must see own stdout `opencode server listening on …` matching the chosen port — never trust a bare TCP probe against a **foreign** occupant (`client.ts:105–107`) |
| Teardown | Owned processes killed via process-tree kill; attached TUI servers must **not** be killed |

### 2.3 Pitfalls for WBS-3 command adapter

1. **Different server identity:** WBS-3 targets `http://127.0.0.1:4111` + Basic auth password file — **not** the observation `478xx` ephemeral server. Do not assume one client instance serves both.  
2. **Do not change `client.ts` GET semantics** (spec: additive `command-adapter.ts`). Shared helpers OK only if observation behavior stays identical.  
3. **Never call `/config/providers`** (leaks provider keys) — WBS3_SPEC.  
4. **Password:** read from `~/.config/agent-relay/opencode-server.pass` (mode `0600` observed); never log/print; never commit.  
5. **PM tools off:** `POST /session/{id}/message` with `tools: {}` so PM cannot mutate workspace / run shell — capability flags must report `writeWorkspace:false`, `shell:false`.  
6. **Session bookkeeping ≠ Task truth:** durable ids only under `{dataRoot}/_relay/role-sessions/<project>/<roleId>.json`.  
7. **No paid fallback:** if health/auth fails → `health.ok=false` / BLOCKED; do not silently switch to OpenAI API.  
8. **Linux discovery gap:** `discoverRunningServers` is Windows-only today — command adapter must not rely on it for PM continuity; use bookkeeping + `GET /session/{id}/message` resume instead.

---

## 3. Twenty-point reviewer checklist (WBS-1/2/3 deliveries)

Apply to each PR/commit claiming WBS-1, WBS-2, or WBS-3.

1. **`AgentAdapter` untouched** — no new methods; `types.ts` observation exports unchanged (diff shows add-only for role-runtime files).  
2. **Separate registries** — observation `registerAdapter` vs `registerRoleRuntimeAdapter` not conflated.  
3. **Capability flags truthful** — reported booleans match real server behavior (esp. `writeWorkspace`/`shell` false for PM OpenCode adapter).  
4. **PM read-only enforcement** — messages sent with `tools: {}` (or equivalent); no writeWorkspace permission profile for `pm` in role config.  
5. **No `writeWorkspace` / shell for PM** — `assertRoleSatisfiable` rejects pm assignment requiring write/shell.  
6. **No secrets in logs/evidence** — password never printed; no `/config/providers`; authMode has no tokens; WBS3 evidence JSON scrubbed.  
7. **No paid API fallback** — failure path does not call OpenAI HTTP APIs; free/subscription OpenCode only.  
8. **zeroExtraBilling** — role config rejects `false` in V1.  
9. **Session bookkeeping ≠ Task SSOT** — role-sessions files contain only adapter/session timestamps; no Task/Run/Result mirrors.  
10. **`ensureSession` → `send` → `collect`** cycle works for PM envelope kinds without touching observation watch.  
11. **`resume` after process restart** — new process loads role-sessions id and `GET /session/{id}/message` succeeds (or health false → BLOCKED).  
12. **Continuity** — two sequential sends in one session; second can reference first (WBS-3 proof).  
13. **Structured output ownership** — adapter returns text; caller parses; invalid structure → `INVALID_STRUCTURED_OUTPUT`, no canonical mutation.  
14. **InputEnvelope kinds** only as specified; no silent Task DB writes from the adapter.  
15. **Tests not mocks-only** — unit fake HTTP server **plus** (for WBS-3) real proof script evidence against loopback.  
16. **Observation regression** — existing OpenCode watch/extract/binding tests still pass; launch still uses listen-line + `/session` probe.  
17. **Port isolation** — command adapter does not steal/kill observation ports `47800–47809` or attach-kill TUI servers.  
18. **Role graph** (WBS-1) — default edges match issue #6; unknown envelope/role rejected.  
19. **PM ≠ Builder** — same OpenCode install OK, but permission profile + tools + roleId must keep PM from acting as Builder.  
20. **Proof against live loopback** — WBS-3 evidence uses free model by default; password file present; reviewer can re-fetch session/messages read-only (§4).

---

## 4. Certification-time checks for WBS-3 proof (read-only; never print the password)

**Password file (meta only):**

```bash
# Confirm exists + mode; DO NOT cat/print contents
ls -la ~/.config/agent-relay/opencode-server.pass
# Expect: -rw------- (0600), owner = cert runner
test -r ~/.config/agent-relay/opencode-server.pass
```

**Fetch from the live OpenCode command server** (default `127.0.0.1:4111` per WBS3_SPEC — confirm against proof script config if different):

```bash
PASS_FILE="$HOME/.config/agent-relay/opencode-server.pass"
BASE="${OPENCODE_BASE_URL:-http://127.0.0.1:4111}"
# Basic auth user "opencode"; password from file — password must not appear in shell history dumps committed to git
AUTH=$(python3 -c 'import pathlib; print("opencode:"+pathlib.Path.home().joinpath(".config/agent-relay/opencode-server.pass").read_text().strip())')

# Health (non-secret)
curl -sS -u "$AUTH" "$BASE/global/health" | jq .

# List sessions — confirm PM session id from role-sessions bookkeeping exists
PROJECT=<cert-project>
SID=$(jq -r .sessionId "$AGENT_RELAY_DATA_ROOT/_relay/role-sessions/$PROJECT/pm.json")
echo "sessionId=$SID"   # id only, OK
curl -sS -u "$AUTH" "$BASE/session" | jq --arg id "$SID" '[.[] | select(.id==$id) | {id,title,directory}]'

# Message history — prove ≥2 assistant turns for continuity proof (text lengths only in cert notes)
curl -sS -u "$AUTH" "$BASE/session/$(python3 -c 'import urllib.parse,os; print(urllib.parse.quote(os.environ["SID"],safe=""))' 2>/dev/null || echo "$SID")/message" \
  | jq '[.[] | {role:.info.role, model:.info.modelID, provider:.info.providerID, text_len:((.parts//[])|map(select(.type=="text")|.text)|join("")|length), err:(.info.error!=null)}] | .[-6:]'

# Negative: must NOT use this in cert scripts
# curl ... "$BASE/config/providers"   # FORBIDDEN — leaks keys
```

Unset auth material after:

```bash
unset AUTH
```

**PASS evidence pack should include:** non-secret `docs/WBS3_EVIDENCE.md` (or equivalent) with session id, timestamps, model id (prefer `opencode/*-free`), two-turn continuity, resume-after-restart note, and explicit “no password / no provider keys logged.”

**FAIL if:** password appears in evidence/logs/CI output; `/config/providers` called; session missing after claimed resume; PM message used write tools; paid OpenAI API traffic observed.

---

## 5. Quick diff heuristic for reviewers

```bash
cd /home/skkse12/Desktop/Projects/Core/Agent-Relay-ghpm
git diff <base>..<head> --stat -- src/integrations/core/types.ts src/integrations/core/registry.ts \
  src/integrations/opencode/client.ts src/integrations/opencode/watch.ts src/integrations/opencode/extract.ts
# Expect: empty or comment-only on these files for WBS-2/3
git diff <base>..<head> --name-only | rg 'role-runtime|command-adapter|roles/'
# Expect: additive paths only
```

---

*Independent reviewer applies this checklist; implementing PM does not self-certify WBS-3.*
