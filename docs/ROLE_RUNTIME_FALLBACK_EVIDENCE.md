# Role runtime fallback evidence

Date: 2026-09-16

## Confirmed before implementation

- `src/orchestrator/role-loop.ts` had fallback selection only in
  `resolvePmAdapterForTurn`; it is coupled to the PM billing guard.
- `src/orchestrator/main.ts` registered OpenCode adapters only for the PM
  assignment and its chain. Builder dispatch uses `dispatchV1OwnerApproved`
  with a worker record; QA uses the QA-gate worker launcher.
- Before W-G, `src/integrations/opencode/command-adapter.ts` was the only
  `RoleRuntimeAdapter` implementation and reported `writeWorkspace: false`.
- `src/roles/role-config.ts` validates `capabilityRequirements` against the
  selected adapter, including `writeWorkspace`.
- Read-only live config
  `~/.local/share/AgentRelay/data/_relay/roles/V1CERT.json` has
  `builder.fallbackChain: []` and `qa.fallbackChain: []`.

## Change

`src/integrations/cline/command-adapter.ts` adds a Cline CLI adapter using only
`--json --provider cline-pass --cwd` (and `--id` for resume); it never accepts
or emits an API key. The measured adapter capabilities include
`writeWorkspace: true`, `structuredOutput: true`, and `persistentSession: true`.

`src/integrations/core/role-runtime-registry.ts` now exports
`resolveRoleRuntimeWithFallback()`. It walks any role's primary and fallback
adapter ids, accepts a primary only when the caller's `primaryUsable` predicate
allows it, and rechecks registration plus capability requirements for every
candidate. Exhaustion throws `ROLE_CAPABILITY_MISMATCH`; no fallback is
silently selected.

`src/orchestrator/main.ts` registers model-qualified OpenCode and
`cline-pass/<model>` fallback entries for every role assignment.
`actl-managed:*` and `qa-worker:*` remain worker integrations, not fabricated
adapters.

## Evidence

Command:

```text
npx tsc -p tsconfig.server.json
node --test test/role-runtime-fallback.test.mjs test/role-runtime-registry.test.mjs
```

Result: `5 tests`, `5 pass`, `0 fail`.

Live adapter smoke (single temporary directory): `cline --json` through
`ClineCommandAdapter` exited 0 using provider `cline-pass`; it created
`adapter-smoke.txt` with exact content `CLINERUNTIME_OK`, and `collect()`
returned the JSON `run_result` text. No `--key` option was used.

The tests prove capable fallback selection for both `builder` and `qa`, plus
fail-closed behavior for missing/incapable candidates. The Cline adapter's
write capability is backed by the live smoke above. They do not claim live
Builder/QA canonical dispatch fallback: the current worker dispatch APIs do
not accept a `RoleRuntimeAdapter`, and the live V1CERT chains remain empty.
An explicit adapter-to-worker dispatch seam and fallback assignments are still
required before that end-to-end behavior can be certified.

## W-G2 relay-worker-cline evidence

Changed/new paths:

- `/home/skkse12/Desktop/Projects/Core/Agent-Relay/scripts/relay-worker-cline.mjs`
- `~/.local/share/AgentRelay/data/_relay/workers/builder-cline.json` (registration only)
- `test/relay-worker-cline.test.mjs`

The wrapper consumes the same five Relay arguments as the Claude wrapper,
validates the latest linked Run, writes an idempotent `prompt.md`, invokes only
`cline --json --auto-approve true -c <workspaceRoot> --provider cline-pass`
(adding `--id <session-id>` when the worker session record exists), bounds
diagnostics to stderr, writes a bounded launch log, and propagates the Cline
exit code. No API-key option is present.

Unit/regression command and result:

```text
npx tsc -p tsconfig.server.json
npm run test:roles                         # 8 tests, 8 pass, 0 fail
node --test --test-concurrency=1 \
  test/relay-worker-cline.test.mjs \
  test/cline-command-adapter.test.mjs \
  test/role-runtime-fallback.test.mjs \
  test/role-runtime-registry.test.mjs \
  test/opencode-command-adapter.test.mjs   # 16 tests, 16 pass, 0 fail
```

Live wrapper proof (one disposable run):

```text
node --input-type=module - <<'NODE' ... createV1TaskFromContract →
atomicMaterializeRun → linkRunToTask → READY→DISPATCHED→RUNNING →
spawn relay-worker-cline.mjs ... NODE
```

Measured output: `exitCode=0`, `fileExists=true`,
`fileContent=CLINERELAY_OK`, `promptRecorded=true`,
`launchLogRecorded=true`, `sessionRecord=true`.

Generated paths were `/tmp/wg2-relay-workspace-WzPGbO/wrapper-smoke.txt`,
the linked Run folder under `/tmp/wg2-relay-data-l4p1wN`, and its
`prompt.md`/`worker-launch.log`; no live Task/Run data was used.

Worker registry validation:

```text
VALID workerId=builder-cline role=implementation observationAdapterId=cline
```

Known integration gap: `builder-cline.json` is schema-valid, but the Core
dispatcher requires `observationAdapterId` to be registered. The current
`Agent-Relay-ghpm` Core has no `AgentAdapter` with id `cline`, so a canonical
dispatcher call would fail closed with `Unknown observation adapter 'cline'`.
The wrapper relay protocol itself is proven; registering a Cline observation
adapter is outside this wrapper-only scope and is required before claiming an
end-to-end Builder dispatch.
