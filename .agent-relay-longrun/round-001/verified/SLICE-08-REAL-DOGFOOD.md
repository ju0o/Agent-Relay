# Slice 8 — Real Dogfood — Checkpoint Receipt

Slice: 8 (Real Dogfood, frozen §18 semantic contract)
Branch: dev/adapter-foundation-01
Parent commit: 1067e9c (Slice 7)
Frozen SSOT: docs/V16-QA-GATE-PLAN-01.md §10, §18, §20
DataRoot (production, real path): /home/skkse12/.local/share/AgentRelay/data
Project: V16DOGFOOD (disposable, isolated from ws/V1.5 tasks)

## Implementation (two narrow corrections — both required for §18 to be possible)
1. `scripts/relay-worker-claude.mjs` — QA passthrough mode (additive): a bare
   `--print <prompt>` with zero relay-arg tokens (the exact shape
   qa-semantic-evaluator invokeOnce produces against this wrapper's own
   registry row) is served as direct `claude --print <prompt>` (inherited cwd
   = authoritative workspaceRoot, default permission mode, Owner profile
   routing, stdout verbatim, stderr bounded+prefixed, signals forwarded,
   exit code propagated). Previously Fatal → semantic BLOCKED ×2, so frozen
   §18 (qaWorkerId 'claude-code' for the QA role) was structurally impossible.
   Relay path takes precedence whenever any relay token is present (proven by
   focused test 4). No Task load / prompt.md / launch log / Result / Evidence
   / MCP in this branch.
2. `scripts/relay-worker-claude.mjs` — QA-remediation prompt recompute
   (additive): Runs carrying qa-remediation-context.json recompute via the
   shared dist composer (composeQaRemediationPrompt from durable prep +
   attempt + frozen Task + bounded prior excerpt — identical inputs to
   qa-gate.ts dispatchFromPreparation). Previously the wrapper knew only
   retry-context.json, recomputed the INITIAL prompt, hit the byte-mismatch
   refusal, exited 1, and wedged the Task FAILED (proven live on TASK-0001
   Run 2). Dual-context folders refuse safely.
3. `src/backend/qa-gate.ts` — export-only (zero behavior change):
   summarizeAttemptDeterministic + semanticReasonFromAttempt exported for the
   wrapper recompute (V1-G5-C dispatcher-prewrite/wrapper-recompute pattern).
4. Tests: test/v16-slice8-wrapper-qa-mode.test.mjs (8 assertions,
   CLAUDE_EXE override — wrapper's own documented escape hatch) +
   test/v16-slice8-wrapper-qa-remediation.test.mjs (6 assertions, real kernels
   build a FAIL→prep fixture; wrapper agrees with pre-written prompt.md and
   spawns) + 2 fixtures + package.json scripts.

## Focused tests
- wrapper-qa-mode: 8 passed, 0 failed. wrapper-qa-remediation: 6 passed, 0 failed.
- Regression post-change: s1 57, s2 65, s4 105, s5 43, s6 72, s7 78 — all 0 failed. typecheck PASS, build PASS.

## QA Agent verdict — PASS (independent sub-agent)
## Architecture Review verdict — PASS, frozen-conflicts 0 (independent sub-agent; 5 non-blocking P2s, 1 applied: bounded QA stderr buffer)

## Real dogfood (frozen §18, zero manual intervention in the counted loop)
Dogfood Task: TASK-0002 / GOAL-0002. Workspace: /tmp/arl-v16-dogfood-ws-1789049531681
(fresh git repo, .g6-dogfood tracked via .gitkeep so the new file matches the
frozen allowedPaths entry exactly; repo-root dirt isolated by construction).
Worker Run 1 wrote `V16_QA / status=wrong` via the frozen Task DOGFOOD
PROTOCOL instruction ("(intentional)" per §18 table — operator-designed first
attempt, executed entirely through the real dispatch path).
- Deterministic QA Run 1: fileExists PASS + diffScope PASS → PASS.
- Semantic QA Run 1 (real claude-code via wrapper passthrough, mandatory):
  FAIL AC-02 with reason + remediationInstruction → finalQaStatus=FAIL →
  no Delivery → prep QRP-QA-TASK-0002-… READY (same Task/binding/workspace).
- WITHOUT MANUAL REDISPATCH: reconcile dispatched Run 2 (FAIL_REMEDIATION_DISPATCHED).
- Worker Run 2 (remediation prompt.md, backend-composed) wrote
  `V16_QA / status=correct`; wrapper recomputed byte-identical prompt (live
  proof of correction 2 — no mismatch refusal).
- Deterministic QA Run 2: PASS. Semantic QA Run 2 (real): PASS AC-02 →
  finalQaStatus=PASS → ordinary Delivery PMD-TASK-0002-… minted.
- Verification packet qa block: status PASS, attemptNumber 2, semanticEvaluated
  true, qaWorkerId claude-code, full FAIL→PASS remediationHistory.
- GPT PM judgment (same flow as V1.5 ACCEPTs): ACCEPT →
  TASK-0002 ACCEPTED, acceptedRunId = Run 2.

Exact §18 counters (TASK-0002): ownerGoCount=1, workerRunCount=2,
qaEvaluationCount=2, semanticQaEvaluationCount=2, qaFailCount=1, qaPassCount=1,
manualQaRetry=0, manualWorkerRedispatch=0, manualResultCopyPaste=0.
Runner logs: /tmp/arl-v16-dogfood/run-fresh.log + resume2.log (COUNTERS JSON).
Durable evidence: qa-attempts QA-TASK-0002-… (×2), qa-semantic-runs (×2, real
claude stdout), prep QRP-… (consumed by Run 2), Delivery PMD-…, judgment ACCEPT.

## Superseded attempt (disclosed, kept on disk — not counted, not deleted)
TASK-0001 proved the Run 1 FAIL half genuinely (det PASS + sem FAIL AC-02)
but its Run 2 died on correction-2's root cause (prompt-mismatch refusal →
Task FAILED per at-most-once semantics, exactly as Slice 7 F6 specifies).
Its prep/run/attempt records remain as bug-finding evidence. The counted
exercise is TASK-0002 (ownerGoCount=1 scoped to it).

## Notes / known limitations
- Live result-bridge FAIL→dispatch raced the observation-lock release twice
  (transient CONFLICT, surfaced as uncaughtException in the throwaway runner;
  prep READY persisted and canonical reconcileQaGate resumed — resume-by-design,
  no wedge). Runner-side guards added; no product change (reconcile is the
  sanctioned resume path). Worth a future P2: bridge-side transient retry vs
  propagate.
- Auth footnote: the agent shell's default ~/.claude OAuth is expired, but
  Relay's own Team/Pro routing sends non-Team workspaces to ~/.claude-pro
  (fresh 09-10, AUTH_OK verified) — which is what all Relay-spawned workers
  used. LONG_RUN_PM_BLOCKER.md (written on the stale premise) removed.
- Workspace binding choice (isolated clean git repo vs repo root) documented
  above; relative contract path .g6-dogfood/v16-qa.txt honored exactly.

## Next Slice authorized
YES → V1.6 completion gate (all slices PASS; MVP candidate pending GPT PM).
