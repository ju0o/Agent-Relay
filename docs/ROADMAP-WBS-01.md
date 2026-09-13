# Agent-Relay Roadmap WBS-01 (forward-looking, no implementation)

- Status: PLANNING DOC ONLY. No product code changed. Nothing here is
  authorized to build — each item names its own gate.
- Anchor: Master Roadmap in `docs/PM-COST-BENCHMARK-01.md`:
  `V1 -> PM Cost Benchmark -> conditional Cost Architecture / PM Host
  Independence -> V1.5 Sequential Tasks -> V2 History/Resume ->
  V2.5 Sub-Agent -> Parallel Multi-Worker -> Cost-Aware Orchestration ->
  Stable PM Runtime`
- Sizing legend (calibrated on H1/H2/R1/R2/R3 experience):
  `S` = 1–2 commits, single module + tests (≈ H2/CLI scale);
  `M` = 3–6 commits, new module + surfaces + fixtures (≈ H1+R1 scale);
  `L` = 7+ commits or certified-path touch, plan-first + recert likely.
- Gate legend: `OWNER_GO` = explicit Owner/PM authorization per increment
  (standing practice since V2 charter); `PLAN_FIRST` = charter+plan doc
  before code (V2 precedent); `CERT` = regression + lead certification,
  and only GPT PM promotes to USER-STABLE (per FINAL_CERTIFICATION_REPORT).

## 0. Where we are (done, `dev/adapter-foundation-01`)

- V1 USER-STABLE certified; V1.5 Sequential Tasks + V1.6 QA Gate delivered
  (V1/V1.5/V1.6 regressions green).
- `DIRECT_GPT_CHAT_RELAY = PRIMARY_ARCHITECTURE_CONFIRMED` (benchmark
  addendum); Normal Chat primary, Work optional.
- V2 History/Resume shipped on-branch: H1 read model, H2 TUI timeline,
  CLI `history`, R1 scan (TUI `[s]` + `resume-scan`), R2 guided actions
  (dispatcher + `resume act` + TUI confirm flow), R3 bridge hooks.
  Locked: R2 always explicit-confirm; recover manual-trigger;
  QRP-RECEIVED permanently report-only (tripwire, plan §6).

## 1. V2 History/Resume — remainder

| ID | Item | Dep | Gate | Size | Notes |
|----|------|-----|------|------|-------|
| V2-R4 | Electron Task panel (History UI in desktop app) | H1 | OWNER_GO | M | Slice-1 explicitly deferred it. H1 reuse; new React panel + IPC `history:get`. No kernel touch. |
| V2-R5 | QRP tripwire watch (process, not code) | — | — | S | Standing watch: a non-forged QRP-RECEIVED finding = evidence a producer exists → scope an advancer then. Until then, zero work. |
| V2-R6 | V2 acceptance bar (cert-style pass list for H1–R3) | V2-R4 | CERT | M | Mirror the V1 cert shape (happy/retry/failure/restart/idempotency on History/Resume paths) so a promotion decision has evidence. Promotion itself is a separate Owner/GPT-PM act. |

## 2. V2.5 Sub-Agent

Precondition: V2.5 HARD gate is still closed (V16 acceptance). First step
is always authorization + charter, never code.

| ID | Item | Dep | Gate | Size | Notes |
|----|------|-----|------|------|-------|
| V25-0 | V2.5 charter + plan (PLAN_FIRST precedent) | — | OWNER_GO | S(docs) | Define "sub-agent" in this app's model (worker-of-worker vs delegated run), non-goals, invariants. |
| V25-1 | Delegation primitives (spawn/link a child run under a parent Task) | V25-0 | OWNER_GO | L | New lifecycle surface; must not disturb dispatch CAS + observation-lock single-owner assumptions — expect lock-model design work. Biggest risk in this epic. |
| V25-2 | Nested lineage (parent/child run binding, evidence linkage) | V25-1 | — (in-epic) | M | Extend `linkedRuns`/runId join + evidence `runId` attribution. Read-model first (History-style), then writes. |
| V25-3 | Permission scoping for sub-agents (new effects in permission-gate) | V25-1 | OWNER_GO | M/L | permission-gate is trust boundary — new effects need threat review; PLAN_FIRST inside the increment. |

## 3. Parallel Multi-Worker

Precondition: V2.5 delegation exists (parallelism without a child model has
nothing to schedule). Benchmark §B3 (MULTI-RESULT PM, future protocol) is
the PM-side prerequisite for fan-in — still uncertified.

| ID | Item | Dep | Gate | Size | Notes |
|----|------|-----|------|------|-------|
| PMW-0 | Parallelism plan (concurrency model + test strategy) | V25-1 | OWNER_GO | S(docs) | Must answer: lock granularity, promotion race rule, judgment fan-in protocol. |
| PMW-1 | Concurrent dispatch (observation-lock + single-delivery bridge are serial today) | PMW-0 | OWNER_GO | L | Touches dispatcher + bridge — certified paths. Expect dedicated concurrency tests (cf. cert's concurrent-ACCEPT proof as template). |
| PMW-2 | Concurrent capture/promotion (idempotency under races) | PMW-1 | — (in-epic) | M/L | Extend duplicate/idempotency suites to N workers; result-bridge single-path rule must survive. |
| PMW-3 | PM fan-in UX (multi-result judgment, B3 protocol) | PMW-1, B3 cert | OWNER_GO | M | B3 is "future-only until separately certified" (benchmark §13) — cannot ship before B3 certification. |

## 4. Cost-Aware Orchestration

Hard precondition: the PM Cost Benchmark itself (B1/B2 runs) is still
awaiting Owner GO with predicates outstanding (benchmark §14). Nothing
below is meaningful without measured unit costs. PMW와 dep 없음은
의도적이다 — Cost-Aware는 워커 토폴로지가 아니라 벤치마크 실측값에
묶여 있어, CAO-0 GREEN 이후 PMW와 병렬 진행 가능하다.

| ID | Item | Dep | Gate | Size | Notes |
|----|------|-----|------|------|-------|
| CAO-0 | Run B1/B2 benchmark to GREEN | — | OWNER_GO | M | Per benchmark doc: restore Claude auth, pass Dogfood predicates, capture B1 before usage evidence. Process-heavy, code-light. |
| CAO-1 | Cost accounting (persist per-task counters: ownerGo/workerRun/wake/manual ops — already supplied ad hoc in addendum) | CAO-0 GREEN | OWNER_GO | M | Where the counters live (task meta vs event log) is a schema decision; additive-only. |
| CAO-2 | Budget policies + dispatch-time enforcement | CAO-1 | OWNER_GO | M/L | Enforcement sits on the certified dispatch path → recert required (CERT). Default-deny vs default-allow needs Owner call. |
| CAO-3 | Normal-Chat primary routing in dispatch defaults | CAO-0 GREEN | OWNER_GO | M | Architecture already confirmed; this is wiring + fallback rules, not a decision. |

## 5. Stable PM Runtime

"Stable" needs a definition before it needs code — that is SPR-0.

| ID | Item | Dep | Gate | Size | Notes |
|----|------|-----|------|------|-------|
| SPR-0 | Stability charter (SLOs, release bar, what re-certs) | V2 cert (V2-R6 shape) | OWNER_GO | S(docs) | Without this, "stable" is untestable. |
| SPR-1 | Cert-observation hardening backlog (process-local capture contexts, worker re-attach scope — cert §Observations) | SPR-0 | OWNER_GO | M | Known-unknowns from certification, not new features. |
| SPR-2 | Release automation + harness promotion (`/tmp` cert harnesses → repo, tag pipeline already exists) | SPR-0 | OWNER_GO | M | Mostly process/tooling; touches CI, not runtime. |
| SPR-3 | Full V1→V2 regression + USER-STABLE re-certification | SPR-1, SPR-2, all epics | CERT (GPT PM promote) | L | The final gate of the whole roadmap. Only GPT PM promotes. |

## 6. Dependency graph (text) and critical path

```
V2-R4 ─┐
V2-R5 (watch, no code) │
V2-R6 ─┴─→ V25-0 → V25-1 ─┬─→ V25-2
       │                  ├─→ V25-3
       │                  └─→ PMW-0 → PMW-1 ─┬─→ PMW-2
       │           B3-cert ───────────────┘  └─→ PMW-3
       └─→ SPR-0 ─┬─→ SPR-1 → SPR-3 ←── (all epics)
                  └─→ SPR-2 → SPR-3
CAO-0 → CAO-1 ─┬─→ CAO-2 (PMW와 독립 — §4)
               └─→ CAO-3
```

Critical path (longest gate+size chain):
`V2-R4 → V2-R6 → V25-0 → V25-1 → PMW-0 → PMW-1 → PMW-2 → SPR-3`,
with `CAO-0` (benchmark GO) and `B3-cert` as the two exogenous risks most
likely to gate PMW-3/CAO regardless of engineering pace.

## 7. Gate register (who lifts what)

| Gate | Lifted by | Currently |
|------|-----------|-----------|
| V2-R4 build | Owner/PM GO | closed |
| V2.5 HARD gate | Owner/PM charter GO | closed (since V16 acceptance) |
| PMW build | Owner/PM GO (after V2.5) | closed |
| B3 protocol cert | benchmark GREEN + Owner/PM | future-only |
| CAO-0 benchmark run | Owner/PM GO (predicates pending) | awaiting GO |
| CAO-2 enforcement semantics | Owner policy call | undecided |
| Stable promotion | GPT PM only | — |

## 8. Standing rules carried forward (non-negotiable per precedent)

1. Plan-first for every L item and every trust-boundary touch.
2. Explicit Owner confirm for every state-changing guided action (R2 rule
   generalizes, not just retry/delivery).
3. No silent repair: corrupted/foreign records fail closed, never auto-healed.
4. Certified paths (dispatch CAS, bridge promotion, QA gate, delivery
   idempotency, retry lineage) change only with recert.
5. Small reviewable commits; tests with fixtures; report discipline per
   increment (files, tests, example output, SHA on working branch, not main).
