# WBS-3 — OpenCode command adapter evidence (real run, 2026-09-16)

`node scripts/wbs3-proof.mjs` against the live loopback server (`http://127.0.0.1:4111`, Basic auth, password read from `~/.config/agent-relay/opencode-server.pass`), default model `opencode/nemotron-3.5-lightning-free` (cost 0). Output is non-secret (no password/token/key values).

```json
{
  "model": {
    "providerID": "opencode",
    "modelID": "nemotron-3.5-lightning-free"
  },
  "baseUrl": "http://127.0.0.1:4111",
  "dataRoot": "/tmp/agent-relay-wbs3-proof-x9y6H4/data",
  "health": {
    "ok": true
  },
  "authMode": {
    "mode": "free",
    "provider": "opencode"
  },
  "ensureSession1": {
    "sessionId": "ses_f56f9da2effeug5jqhjNBnSHB0",
    "created": true
  },
  "promptA": {
    "text": "WBS3_A_OK",
    "tokens": 8634,
    "cost": 0
  },
  "promptB": {
    "text": "BLUEBERRY",
    "tokens": 8720,
    "cost": 0
  },
  "continuity": true,
  "restartResume": {
    "ensured": {
      "sessionId": "ses_f56f9da2effeug5jqhjNBnSHB0",
      "created": false
    },
    "resumed": {
      "ok": true
    }
  },
  "historyReadableMessageCount": 4
}
WBS3_PROOF: PASS
```

Coverage against the WBS-3 proof requirement:
- `health()` → `ok: true`.
- `authMode()` → `{mode: 'free', provider: 'opencode'}` (default model ends `-free`).
- `ensureSession` (persistent policy) → fresh session created (`created: true`).
- Prompt A (`"Remember the word BLUEBERRY..."`) → collected reply `WBS3_A_OK`.
- Prompt B referencing prompt A (`"what single word did I ask you to remember?"`) → collected reply `BLUEBERRY` — same-session conversational memory confirmed (`continuity: true`).
- A second OS process (`execFileSync(process.execPath, [resumeScriptPath])`, real child process, not just a new object) re-imports the compiled adapter, calls `ensureSession` with the same `{roleId, project, sessionKey}` and the same `dataRoot`, and resumes the identical `sessionId` (`created: false`) via the durable bookkeeping file at `{dataRoot}/_relay/role-sessions/WBS3Proof/pm.json` — proves session survival across a process restart.
- `resume()` (`GET /session/{id}/message`) → `ok: true`; a direct history fetch in the proof script confirms `historyReadableMessageCount: 4` (2 user + 2 assistant messages), i.e. history is readable after the simulated restart.

Unit tests (fake in-process HTTP server, no real OpenCode needed):

```
node --test test/opencode-command-adapter.test.mjs
# tests 9
# pass 9
# fail 0
```

No secrets were printed, logged, or committed by the adapter, tests, or proof script. `GET /config/providers` was never called (confirmed by code inspection of `command-adapter.ts` and `scripts/wbs3-proof.mjs`).

## Re-proof 2026-09-16 ~07:35Z (after Grok review #1 P1(1))
- Review #1 re-ran the proof with the default model `opencode/nemotron-3.5-lightning-free` → `WBS3_PROOF: FAIL` (message POST timeout). PM probe: that model stalls in its reasoning step (no reply in 120 s); `mimo-v2.5-free` 1.9 s, `big-pickle` 5.2 s, `nemotron-3-ultra-free` 18.6 s all answered `PROBE_OK`.
- `node scripts/wbs3-proof.mjs --model opencode/mimo-v2.5-free` → `WBS3_PROOF: PASS` (ensure/send/collect, restart resume `ok: true`, history readable 4 messages). Zero cost; password file read, never printed.
- Consequence: V1CERT PM assignment now `mimo-v2.5-free` with fallbackChain `[opencode/big-pickle, opencode/nemotron-3-ultra-free]`; the orchestrator must treat a hung free model as BLOCKED_RUNTIME (bounded send timeout) and walk only free fallbacks.
