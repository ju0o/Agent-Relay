AUTOWAKE_CERT_PROTOCOL: 2026-09-16T06:34:45Z

# Independent certification review protocol — automatic-wake ChatGPT PM loop

**Issue:** ju0o/Agent-Relay#3 · **Spec:** `Agent-Relay-ghpm/docs/AR_GH_PM_AUTO_SPEC.md` · **Wake PR:** ju0o/Agent-Relay#5 (`pm-transport-wake` → `pm-transport-base`, draft, DO NOT MERGE)

**Reviewer role:** Grok (or successor independent seat). The implementing PM / Builder **must not** self-certify. This document is the procedure you will execute later for **disposable E2E** and **live E2E**.

**Hard rules during certification:** read-only against live `~/.local/share/AgentRelay/data` except where the disposable run uses an explicit throwaway `--dataRoot`; no GitHub writes from the reviewer; no `tmux`/unit/process mutation; no merge of PR #5.

---

## 0. Scope of the two certifications

| Track | dataRoot / project | Purpose |
|---|---|---|
| **Disposable** | Bridge `--dataRoot` under `/tmp/…` (or documented disposable path); allowlisted test project | Prove exporter/importer/dedupe/safety against local or `local` transport + simulated/real PR comments as documented in runbook |
| **Live** | ONE low-risk real project under `~/.local/share/AgentRelay/data/<project>` | Prove zero Founder wake actions through full loop; only then Owner may set `AGENT_RELAY_CHATGPT_AUTO_PM=CERTIFIED` |

Both tracks must satisfy §2 checks and §3 cross-consistency. Live additionally requires §1.5 Founder-wake evidence.

---

## 1. Evidence sources (read-only fetch)

### 1.1 GitHub — wake PR #5

```bash
# PR metadata
gh pr view 5 -R ju0o/Agent-Relay --json title,isDraft,state,headRefName,baseRefName,author,createdAt,updatedAt

# Commits on the PR (packet pushes)
gh api repos/ju0o/Agent-Relay/pulls/5/commits \
  --jq '.[] | {sha:.sha[0:12], date:.commit.author.date, author:.commit.author.name, msg:.commit.message}'

# Files in a commit (must be exactly one new inbox packet for a packet push)
gh api repos/ju0o/Agent-Relay/commits/<sha> \
  --jq '{sha:.sha[0:12], files:[.files[]|{filename,status,additions,deletions}]}'

# PR issue comments (judgments + importer replies)
gh api repos/ju0o/Agent-Relay/issues/5/comments --paginate \
  --jq '.[] | {id, user:.user.login, created_at, body}'

# Optional: issue timeline (commits, comments, reviews)
gh api repos/ju0o/Agent-Relay/issues/5/timeline --paginate
```

**Packet commit recognition:** message matches `PM_PACKET <task_id> <packet_id>` (or documented equivalent); tree change under `pm-bridge/inbox/<packet_id>.json` only (plus allowed README/bootstrap once).

**Comment recognition:**
- Judgment: body starts with / contains exact header `PM_JUDGMENT v1` and fields `packet_id`, `context_hash`, `decision`, `retry`, `reason`.
- Importer reply: `PM_IMPORT v1` with disposition (`APPLIED` | `REJECTED_STALE` | `REJECTED_INVALID` | `REPLAY_IGNORED` | `OWNER_REQUIRED_RECORDED` | `FAILED`).

### 1.2 Distinguishing Founder typing vs Work acting — `FOUNDER_WAKE_ACTIONS`

| Signal | How to read | Confidence |
|---|---|---|
| Comment `user.login` | Compare to Founder GitHub login (`ju0o`) vs the **ChatGPT-connected GitHub identity** bound in Work (record the login at setup time in the cert evidence pack) | High if Work posts as a distinct app/bot or known secondary user |
| Commit author | Packet commits must be `"Agent Relay PM Bridge"` (exporter), not Founder | High for exporter |
| PR timeline | Founder comments that are **not** `PM_JUDGMENT` / `PM_IMPORT` during the loop window count as human chatter; any Founder message whose intent is “wake/continue PM” = wake action | Medium |
| ChatGPT Work run log | If Work UI exposes run timestamps tied to the PR commit SHA, correlate commit → Work run → judgment comment | High when visible — **UNVERIFIED** whether GitHub API exposes Work runs |
| Same login for Founder and Work | If Work posts comments as `ju0o`, **GitHub does not expose “human vs Work”** on the comment object | **UNVERIFIED / UNRESOLVABLE via API alone** |

**Protocol when author identity is shared:**  
1. Require the cert runbook to record the Work-connected identity **before** live E2E.  
2. If Work and Founder share `ju0o`, set `FOUNDER_WAKE_ACTIONS: UNVERIFIED` unless an out-of-band Work run screenshot/log proves zero manual prompts **and** the Founder attests no `계속`/paste during the window.  
3. Still FAIL if any Founder-authored comment is clearly a manual wake instruction, or if the Founder admits a manual wake.

### 1.3 Local bridge audit JSONL

Path from CLI `--audit-dir` (document exact path in the run under review). Each line roughly:

`{ ts, packet_id, github comment id/url, project, task_id, run_id, delivery_id, result_id?, context_hash, decision, retry, disposition, resulting canonical state… }`

```bash
# Read-only
wc -l <audit.jsonl>
python3 -c 'import json,sys; [print(json.loads(l).get("disposition"), json.loads(l).get("packet_id")) for l in open(sys.argv[1])]' <audit.jsonl>
```

### 1.4 Canonical Agent Relay records (read-only)

Under `$DATA_ROOT/<project>/_relay/` (live default `~/.local/share/AgentRelay/data/<project>/_relay/`):

| Record | Path pattern | Fields to read |
|---|---|---|
| Task | `tasks/<taskId>/task.json` | `taskId`, `executionState`, `pmState`, `acceptedRunId`, `linkedRuns[]` (`runId`, `folder`) |
| Delivery | `pm-deliveries/PMD-<taskId>-<runId>/delivery.json` | `deliveryId`, `taskId`, `runId`, `status` (`PENDING`→`DELIVERED`→`ACKNOWLEDGED` / `IGNORED`) |
| Judgment | `pm-judgments/PMJ-<deliveryId>/judgment.json` | `judgmentId`, `deliveryId`, `taskId`, `runId`, `decision`, `status` (`APPLIED`/`…`), `reason` |
| Retry prep | `retry-preparations/RTP-<judgmentId>/preparation.json` (+ `.md`) | linkage to judgment; SAME Task indicators |
| Events | `events/*.ndjson` or project event log | optional corroboration of `PM_*` / result events |

```bash
# Examples (substitute DATA_ROOT + project)
jq '{taskId,executionState,pmState,acceptedRunId,runs:(.linkedRuns|length)}' \
  "$DATA_ROOT/$PROJECT/_relay/tasks/$TASK/task.json"
jq '{deliveryId,status,taskId,runId}' \
  "$DATA_ROOT/$PROJECT/_relay/pm-deliveries/$DELIVERY/delivery.json"
jq '{judgmentId,decision,status,taskId,runId,deliveryId}' \
  "$DATA_ROOT/$PROJECT/_relay/pm-judgments/$JUDGMENT/judgment.json"
```

### 1.5 Transport clone (read-only)

```bash
git -C ~/.local/share/agent-relay-pm-transport/repo fetch --all
git -C ~/.local/share/agent-relay-pm-transport/repo log pm-transport-wake --oneline | head
git -C ~/.local/share/agent-relay-pm-transport/repo show <sha>:pm-bridge/inbox/<packet_id>.json | jq '{packet_id,task_id,delivery_id,bounded_context_hash,allowed_actions}'
```

### 1.6 Secrets scan (transport)

```bash
# Packet files in PR commits / local clone — fail if secrets patterns appear
git -C <repo> grep -nE 'sk-|api[_-]?key|Bearer |Authorization:|OPENAI|password' pm-bridge/ || true
```

`SECRETS_IN_TRANSPORT: NONE` only if no hits in packet JSON / commit contents (ignore this protocol doc and PR description examples).

---

## 2. Checks per issue / spec section

For each check: **commands**, **expected observation**, **FAIL if**.

### 2.1 Exactly one packet per pending Delivery

**Commands:** list pending deliveries in cert project; list `pm-bridge/inbox/*.json` commits whose packet `delivery_id` matches; count unique `(delivery_id, bounded_context_hash)` in state-file + commits.

**Expect:** one packet commit per `(delivery, context_hash)` while that Delivery remains the current pending VERIFY delivery.

**FAIL:** two commits with same `delivery_id` + same `bounded_context_hash`; or zero packet while Delivery stays `PENDING` past exporter run success.

### 2.2 Exactly one wake per packet commit

**Infer wake (no Work API):** within a bounded window (e.g. ≤15 min of commit timestamp), exactly one new `PM_JUDGMENT v1` comment appears whose `packet_id` matches the packet in that commit; no Founder wake comment in between.

**Commands:** correlate `pulls/5/commits[].commit.author.date` → `issues/5/comments` filtered by `packet_id`.

**Expect:** 1 judgment comment per packet commit (or OWNER_REQUIRED once); importer then posts one `PM_IMPORT`.

**FAIL:** zero judgment after successful packet commit while Work is claimed configured; **or** ≥2 non-identical judgments for same `packet_id` without supersession rules; **or** Founder wake message between commit and first judgment.

### 2.3 CHANGES → SAME Task retry

**Commands:** after CHANGES+`retry: SAME_TASK` + `PM_IMPORT … APPLIED`, read `task.json` + new `linkedRuns` entry + `retry-preparations/RTP-…`.

**Expect:** **same** `taskId`; **new** `runId`; no second Task folder created; retry prep references the judgment.

**FAIL:** new `TASK-*` created for the retry; or same `runId` reused when a new attempt was required; or CHANGES applied without retry prep when `SAME_TASK` was required and canonically legal.

### 2.4 Second Result → second packet → second judgment (no Founder action)

**Commands:** after attempt-2 Result + pending Delivery, expect new commit `PM_PACKET … <packet_id_2>` and later `PM_JUDGMENT` for `packet_id_2`.

**Expect:** second automatic cycle; Founder wake count still 0 / UNVERIFIED per §1.2.

**FAIL:** second Result with pending Delivery but no new packet; or packet without subsequent judgment while Work enabled; or Founder intervenes to continue.

### 2.5 ACCEPT terminal

**Commands:** judgment `decision: ACCEPT` → `PM_IMPORT APPLIED` → `judgment.json` `status: APPLIED` `decision: ACCEPT` → Delivery reconciled to `ACKNOWLEDGED` (or project’s AR-04 path) → `task.pmState` accepted / terminal per backend rules (`acceptedRunId` set).

**Expect:** no further packet for that Delivery; Task not left `PENDING` PM.

**FAIL:** ACCEPT comment with no canonical APPLIED judgment; or Task still awaiting PM on that run.

### 2.6 Dedupe — duplicate commit / poll / comment

**Commands:** re-run exporter poll; re-push same packet; re-post byte-identical `PM_JUDGMENT`; check audit dispositions `REPLAY_IGNORED` / no new commit / no duplicate APPLIED.

**Expect:** no duplicate packet commit; identical judgment → idempotent no-op; non-identical second judgment for same packet → rejected.

**FAIL:** second APPLIED for same delivery/judgment; duplicate inbox file commit for same hash.

### 2.7 Stale hash rejection

**Commands:** craft/simulate judgment with wrong `context_hash` (disposable/`local` transport); observe importer.

**Expect:** `REJECTED_STALE` (or equivalent) in `PM_IMPORT` + audit; **no** canonical judgment apply.

**FAIL:** stale hash applied to canonical state.

### 2.8 Malformed / malicious judgment rejection

**Cases:** bad schema; wrong `task_id`/`run_id`/`delivery_id`; disallowed action; tampered ids.

**Expect:** `REJECTED_INVALID`; canonical untouched.

**FAIL:** any canonical write from malformed input.

### 2.9 Importer / exporter restart recovery

**Commands:** kill bridge mid-import after record write before reply (disposable); restart; ensure single APPLIED + eventual `PM_IMPORT`; exporter restart does not mint duplicate packet for same hash.

**Expect:** restart-safe exactly-once effects.

**FAIL:** double apply; lost apply with permanent pending packet and no recovery path.

### 2.10 GitHub outage → canonical untouched

**Commands:** disposable with unreachable origin / `--dry-run` documented failure; or fault injection per runbook.

**Expect:** no new judgment/delivery transition attributable to importer during outage.

**FAIL:** canonical mutation without successful validated import path.

### 2.11 Work failure leaves packet pending / recoverable

**Expect:** packet commit remains on branch; Delivery still pending; a later successful Work/judgment can still apply (or Owner documents recovery).

**FAIL:** packet deleted; Delivery abandoned without audit; unrecoverable stuck state with no documented recovery.

---

## 3. Cross-consistency table (mandatory artifact)

Build one row per `packet_id` in the cert window:

| packet_id | commit sha | commit time | judgment comment id | judgment author | judgment decision/retry | PM_IMPORT id | audit disposition | deliveryId | delivery status | judgmentId / status | taskId | runId(s) | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

**Fill from:** §1.1–1.4.  

**CANONICAL_MATCH: YES** only if every row’s GitHub ids ↔ audit ↔ `delivery.json` / `judgment.json` / `task.json` agree on ids and decision outcome.  

**Any mismatch = FAIL** (example: comment says ACCEPT but judgment missing; packet `task_id` ≠ judgment `taskId`; APPLIED audit but Delivery still PENDING with no reconcile path).

Also verify packet JSON `bounded_context_hash` equals importer recomputation story in audit (when audit records both).

---

## 4. Disposable vs live execution order

1. **Disposable first** — run `test/github-pm-bridge.test.mjs` + documented disposable-real script from `docs/GITHUB_PM_AUTO_WAKE.md`; complete §2–§3; produce a draft verdict.  
2. **Live second** — single low-risk Task; Founder one-time Work bind already done; reviewer watches PR #5 + canonical project; **no** Founder wake; complete §2–§3 + §1.2; final verdict.  
3. Only on live **PASS** may Owner set `AGENT_RELAY_CHATGPT_AUTO_PM=CERTIFIED` (leave `AGENT_RELAY_CHATGPT_PM=NOT_CERTIFIED`).

---

## 5. Verdict block format (exact)

After each cert track, write a block (and attach the §3 table + command transcripts):

```text
AUTOWAKE_CERT: PASS|FAIL
FOUNDER_WAKE_ACTIONS: 0|<n>|UNVERIFIED
PACKETS/WAKES/JUDGMENTS: n/n/n
CANONICAL_MATCH: YES|NO
SAME_TASK_RETRY: YES|NO|N/A
SECRETS_IN_TRANSPORT: NONE|<found>
```

**Semantics:**
- `PACKETS/WAKES/JUDGMENTS` — counts in the cert window (packet commits / inferred wakes / `PM_JUDGMENT` comments). For a full multi-turn happy path expect e.g. `2/2/2` (CHANGES then ACCEPT) or `1/1/1` (ACCEPT-only). Mismatch among the three → investigate; usually **FAIL** unless documented OWNER_REQUIRED short-circuit.
- `SAME_TASK_RETRY: N/A` only if the path never issued CHANGES+SAME_TASK; otherwise YES/NO.
- `FOUNDER_WAKE_ACTIONS: 0` required for live PASS when identity is distinguishable; use `UNVERIFIED` only per §1.2 and never upgrade to PASS without Founder attestation + Work-run evidence.

**PASS requires:** all §2 applicable checks green, §3 `CANONICAL_MATCH: YES`, `SECRETS_IN_TRANSPORT: NONE`, and for live: automatic multi-turn success definition from issue #3 with wake actions `0` or justified `UNVERIFIED`+attestation accepted by Owner explicitly.

---

## 6. Pre-flight (before starting a cert run)

- [ ] PR #5 still draft, head `pm-transport-wake`, base `pm-transport-base`  
- [ ] Work trigger bound (live) or disposable transport documented  
- [ ] Bridge commit SHA under review recorded (`git -C Agent-Relay-ghpm rev-parse HEAD`)  
- [ ] dataRoot / project allowlist recorded  
- [ ] ChatGPT Work GitHub login recorded for author comparison  
- [ ] Clock skew note (commit UTC vs comment UTC)

---

*End of protocol. Independent reviewer executes; PM does not fill the verdict.*
