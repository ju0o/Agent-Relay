# Worker Connection Profile Architecture 01

Status: **FROZEN ARCHITECTURE**. This is the single source of truth for a public-ready Worker Connection Profile capability. It is a design record only: no current dispatcher, Worker, observer, onboarding UI, installer, or PM Cost Benchmark behavior is changed.

## Decision

Separate these concepts permanently:

1. **Worker Runtime** — an executable integration, for example `claude-code`.
2. **Worker Connection Profile** — one user-facing authenticated account/context for one Worker Runtime, for example `Claude Pro` or `Claude Team`.
3. **Workspace Routing Rule** — a deterministic workspace-to-Connection-Profile selection, for example `/Projects/Team/** -> Claude Team`.

A Worker Runtime is never an account. One Worker Runtime may have many Connection Profiles. A Run resolves exactly one profile before any Run is persisted, then the Worker and Observation Adapter use that same persisted resolution.

## Current Compatibility Status

The current Claude resolver uses profile-specific `CLAUDE_CONFIG_DIR` and an Owner-specific Team workspace fallback. It is:

`OWNER_LOCAL_WORKAROUND`
`NOT_PUBLIC_READY`

It remains temporarily for existing dogfood/PM Cost Benchmark compatibility only. It is not a public default, a documented user setup step, or a reusable path rule. No public user must create directories, edit configuration, set environment variables, or manually map account paths.

## Domain Model

```text
WorkerRuntime (claude-code)
  1 ── * ConnectionProfile (Claude Pro, Claude Team)
  1 ── * WorkspaceRoutingRule (workspace selector -> profileId)

Dispatch request
  -> select WorkerRuntime
  -> resolve explicit profile OR matching routing rule OR default profile
  -> create ResolvedWorkerExecutionContext
  -> persist safe immutable Run context
  -> launch Worker and arm Observer from that exact context
```

### Worker Runtime

`WorkerRuntime` is provider/integration metadata, not a credential container. It owns CLI detection, provider-auth driver behavior, supported connection tests, and adapter identity. Existing trusted Worker Registry launch details remain a separate execution concern. Future connection records refer to a stable `workerId`/runtime identifier; they do not duplicate launch commands, environment, or credentials.

### Connection Profile schema

Persist one secret-free record per profile under a future connection store (exact storage implementation is intentionally deferred):

```json
{
  "schemaVersion": 1,
  "profileId": "WCP-uuid",
  "workerId": "claude-code",
  "displayName": "Claude Team",
  "configDirectoryRef": "provider-managed local directory reference",
  "isDefault": false,
  "status": "AUTHENTICATED",
  "statusCheckedAt": "2026-09-05T00:00:00.000Z",
  "statusDetailCode": "OK",
  "createdAt": "2026-09-05T00:00:00.000Z",
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

Required invariants:

- `profileId` is immutable and globally unique; `workerId` must resolve to an installed Worker Runtime.
- `displayName` is user-editable, non-secret, and unique per Worker Runtime for clear UI selection.
- `configDirectoryRef` is a local implementation reference only. It is validated as a directory at connect/test/dispatch time, never treated as credential content, and is not exposed through public PM views or logs.
- At most one `isDefault: true` profile exists per Worker Runtime. A Worker with usable profiles must have an explicit default before fallback can be used.
- `status` is one of `UNKNOWN`, `AUTHENTICATED`, `AUTH_REQUIRED`, `AUTH_EXPIRED`, `UNAVAILABLE`, or `DISCONNECTED`. It is advisory health metadata, not proof that a future Worker run will succeed.
- `statusDetailCode` is an allowlisted, non-secret machine code; raw provider output, account e-mail, tokens, environment dumps, and credential bytes are excluded.
- `DISCONNECTED` means Relay has removed its reference only. It never deletes Provider CLI credentials unless the user separately completes provider-owned logout/deletion in that provider's flow.

### Workspace Routing Rule schema

```json
{
  "schemaVersion": 1,
  "ruleId": "WRR-uuid",
  "workerId": "claude-code",
  "profileId": "WCP-uuid",
  "matchType": "WORKSPACE_PREFIX",
  "workspacePrefix": "/Users/example/Projects/Team",
  "priority": 100,
  "enabled": true,
  "createdAt": "2026-09-05T00:00:00.000Z",
  "updatedAt": "2026-09-05T00:00:00.000Z"
}
```

Rules are scoped to one Worker Runtime and must reference an active Connection Profile for that same Worker. `WORKSPACE_PREFIX` means the normalized workspace itself or a descendant, never a substring match. At creation and resolution, Relay canonicalizes an existing workspace path (including platform case rules and resolved symlinks where available); it rejects empty paths, NUL, relative paths, and ambiguous duplicate selectors. A higher `priority` wins; ties are resolved by the longest matching prefix; any remaining tie is a configuration error, never arbitrary account selection. `enabled: false` removes a rule from selection without deleting audit history.

## Runtime Resolution Contract

For every dispatchable Run, the Dispatcher is the sole resolver. PM task narrative, Worker prompt, environment inherited by the observer, and observer-side heuristics have no authority to choose an account.

1. Validate the chosen Worker Runtime and the absolute workspace.
2. If the dispatch API later supports an explicit `profileId`, validate that it belongs to the chosen Worker Runtime and is usable. Explicit selection is an Owner-facing choice; it never comes from Task text.
3. Otherwise select enabled matching rules by priority, then longest canonical prefix. If none matches, select that runtime's one default profile.
4. Reject safely with `CONNECTION_PROFILE_REQUIRED` when no default exists, `CONNECTION_PROFILE_UNAVAILABLE` when the resolved profile is not usable, and `CONNECTION_PROFILE_AMBIGUOUS` for unresolved ties. Error UX names the friendly profile and offers Connect/Re-authenticate/Choose Profile; it never prints a config path or secret.
5. Resolve one `ResolvedWorkerExecutionContext`, validate its provider directory/reference, and run a non-secret connection test when required by freshness policy.
6. Persist the context atomically before linking/arming/spawning. Only then arm observation and launch the Worker.

Proposed safe immutable Run fields:

```json
{
  "workerId": "claude-code",
  "connectionProfileId": "WCP-uuid",
  "connectionProfileDisplayNameSnapshot": "Claude Team",
  "connectionContextVersion": 1,
  "configDirectoryRefSnapshot": "local provider reference",
  "workspaceRoutingRuleId": "WRR-uuid or null",
  "resolutionSource": "EXPLICIT|ROUTING_RULE|DEFAULT"
}
```

The Worker launch receives only the effective provider context needed for that Run. The Capture/Observation Adapter receives the exact same immutable Run-bound context. It must prefer it to ambient process state and must never independently infer a profile from the workspace, `CLAUDE_CONFIG_DIR`, or current process environment. Retry runs reuse the original resolved profile context unless a separately designed, Owner-authorized policy explicitly permits re-resolution; no silent account switch is allowed.

## Multi-Account Resolution Algorithm

```text
resolve(workerId, workspace, explicitProfileId?):
  candidates = active profiles for workerId
  if explicitProfileId: require it is a usable candidate; return EXPLICIT
  matches = enabled valid rules matching canonical(workspace)
  if matches: choose max(priority, matching-prefix-length)
              reject any remaining tie; require target profile usable
              return ROUTING_RULE
  default = exactly one usable default profile for workerId
  if default: return DEFAULT
  fail CONNECTION_PROFILE_REQUIRED
```

No account is selected by directory name, provider account name, path substring, or "first available" ordering. A profile failing a connection test is not silently replaced by another profile: Relay reports the named profile's failure and waits for explicit Owner resolution, preserving account intent.

## Claude Pro / Claude Team Example

| Object | Value |
| --- | --- |
| Worker Runtime | `claude-code` |
| Profile A | `WCP-claude-pro`, display `Claude Pro`, default `true` |
| Profile B | `WCP-claude-team`, display `Claude Team`, default `false` |
| Rule | `WORKSPACE_PREFIX /Projects/Team` -> `WCP-claude-team`, priority 100 |
| Fallback | all other workspaces -> `WCP-claude-pro` through the default profile |

This represents the Owner's current semantic intent without preserving its private path or hardcoding a Pro/Team concept into the runtime. The UI may describe the rule as "Use Claude Team for folders inside Team"; it does not reveal `CLAUDE_CONFIG_DIR`.

## Public Onboarding UX (future implementation requirement)

1. **Choose Worker:** show installed/available Worker Runtimes; choose Claude Code.
2. **Detect CLI:** run a safe version/availability probe and show a repair/install action if missing.
3. **Connect:** launch the provider CLI's official browser/web authentication flow from the app; Relay does not render a provider password/token form.
4. **Connection test:** invoke the provider-supported non-destructive status/test and show a clear result.
5. **Name profile:** ask for a friendly label such as `Personal` or `Work Team`.
6. **Choose scope:** make it the default or add friendly folder-specific rules through a folder picker.
7. **Done:** show profile health, default/rules, Re-authenticate, Disconnect, Test connection, and an explicit profile picker where dispatch UX supports it.

Normal onboarding contains no shell commands, environment-variable instructions, hand-edited configuration, or manually typed account paths.

## Re-authentication, Disconnect, and Error UX

- `AUTH_REQUIRED` or `AUTH_EXPIRED` presents `Reconnect <friendly name>` and launches the provider's official login path. It preserves routing rules and profile identity unless the Owner chooses otherwise.
- `UNAVAILABLE` presents a non-secret reason such as CLI missing, provider unavailable, or connection test failed, plus a retry/test action.
- A dispatch blocked on a selected profile never falls back to a different account. The message identifies the friendly profile and offers Re-authenticate, Choose Profile, or Cancel.
- `Disconnect` requires confirmation, removes Relay's profile reference and routing rules only after the user chooses the desired scope, preserves historical Run snapshots, and does not delete provider credentials.

## Security and Credential Boundary

The Provider CLI/browser authentication flow remains the authority for credentials. Agent Relay never persists OAuth access tokens, refresh tokens, cookies, credential-file content, passwords, secret headers, raw provider auth output, or an auth-environment dump. It stores only the declared safe profile/routing metadata and allowlisted health state. Paths/references are local configuration metadata, treated as sensitive operational detail: redact them from public MCP/TUI views, shared diagnostics, telemetry, and PM-facing payloads. Connection tests must redact raw stderr and use allowlisted status codes.

## Migration Concept

This is a staged, opt-in migration; no existing profile is auto-created and no legacy Run metadata is rewritten.

1. **Compatibility phase (now):** retain the current Owner-local resolver unchanged and label it `OWNER_LOCAL_WORKAROUND / NOT_PUBLIC_READY`.
2. **Data phase:** introduce the secret-free profile/rule store, validation, and read-only migration preview. Existing Runs retain their current directory-only context for reproducibility.
3. **Guided migration phase:** show the Owner a provider-driven Connect flow, let them create friendly profiles and rules, test each profile, and select a default. Do not infer account identity from paths or copy credentials.
4. **Resolution phase:** only after explicit migration completion, route new Runs through the frozen resolver. Existing Runs/retries keep their saved context.
5. **Deprecation phase:** after public onboarding is proven, warn only the affected Owner-local setup; never remove a legacy profile/directory or silently change routing.

## Public Release Gate

No public release of this capability until all are implemented and verified:

- Worker detection and guided provider login/browser-web authentication
- multiple accounts per Worker Runtime with friendly profile names
- default profile and folder/workspace routing
- explicit profile selection and connection test
- credential isolation, safe secret handling, and secret-redaction tests
- re-authentication and Disconnect UX
- meaningful auth-expired/unavailable errors without path/secret leakage
- exact Worker/Observer same-context propagation and retry preservation tests
- zero-command-line onboarding for normal users
- migration preview, opt-in migration, and legacy compatibility tests

## Relationship to PM Cost Benchmark

This architecture creates no PM Cost Benchmark Task, does not alter its scope, and adds no new benchmark gate. The benchmark remains governed by its existing gates; at this snapshot it is independently blocked by Claude authentication and unproven owner-side connector widget mount, not by this architecture document.
