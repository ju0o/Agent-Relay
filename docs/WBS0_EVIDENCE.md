# WBS-0 — Host rehydration + subscription runtime proof (PASS, 2026-09-16T06:52:33Z)

1–3. Host state: see docs/V1_REHYDRATION.md (deployment tree `ar/local-auth-transport` edc7dce; AR-04 d70c39a; this worktree `ar/github-pm-bridge-v0` from 93506a0; remote main d16c60c stale — not used).
4. OpenCode: `/usr/local/bin/opencode` **1.18.27**.
5. Auth: `opencode auth list` → exactly one credential, **OpenCode Go (api)** — the Founder's existing OpenCode plan (gateway opencode.ai/zen/go). **No ChatGPT Plus/Pro OAuth provider is configured** → optional one-time Founder action: `opencode auth login` → OpenAI → ChatGPT Plus/Pro. No OpenAI API key exists or was created.
6. Server: `opencode serve --hostname 127.0.0.1 --port 4111` (PM tmux window `opencode-serve`), now protected by `OPENCODE_SERVER_PASSWORD` (file `~/.config/agent-relay/opencode-server.pass`, 0600); unauthenticated request → 401.
7. Session: `POST /session` → `ses_f5703e753ffegWDwM1w6k6Wb11`.
8. Prompt/response (programmatic, HTTP `POST /session/{id}/message`):
   - opencode-go/gpt-5.6-luna → `WBS0_OK` (4s; tokens total 6551; metered cost 0.0016 against the EXISTING Go plan, no new credential);
   - continuity: second message → `BLUEBERRY` (session memory preserved); history = 4 messages;
   - free tier: opencode/nemotron-3.5-lightning-free → `FREE_OK`, cost 0.
   - session survived a server restart (messages still readable).
9. No new paid API credential required. Zero OpenAI API usage.
10. Evidence is non-secret (no tokens/keys). NOTE: `GET /config/providers` returns provider keys — never persist its output.

Fallback order stays as issue #6 WBS-0 (Cline → Claude Code → other paid/free). PM runtime default for V1 certification: OpenCode session; provider selection is a RoleAssignment field (WBS-1).
