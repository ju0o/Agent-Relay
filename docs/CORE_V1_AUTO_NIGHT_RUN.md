# CORE V1 Auto Night Run

Founder authorization recorded in `BACKLOG.md`. Runtime default timezone is
`Asia/Seoul`; the operational deadline is `05:00` — freeze 04:55, checkpoint
04:58, hard stop 05:00. The supervisor deadline is injectable
(`agent-relay night-run up --deadline <HH:MM>`, code default `DEFAULT_DEADLINE`
in `src/v2/night-run/index.mjs`); operational runs use `05:00`.

## ASUS one-time setup

Run this once on ASUS as the configured user (`skkse12`):

```sh
printf '%s\n' 'skkse12 ALL=(root) NOPASSWD: /usr/sbin/poweroff' | sudo visudo -f /etc/sudoers.d/agent-relay-night-run
sudo -n /usr/sbin/poweroff --help >/dev/null
```

This grants only `/sbin/poweroff`. Agent Relay never edits `/etc/sudoers`,
stores passwords, or waits for an interactive sudo prompt. If `sudo -n` is not
allowed, the run remains recorded and reports `SHUTDOWN_PERMISSION_REQUIRED`.

## Report delivery: ASUS → MainPC push

Finalization order is send → MainPC shutdown → ASUS poweroff
(`finalizeNightRun` in `src/v2/night-run/index.mjs`). ASUS pushes
`NIGHT_REPORT_YYYY-MM-DD.md` to MainPC with `send-to-mainpc`
(`AGENT_RELAY_SEND_TO_MAINPC`, default
`.../send-to-mainpc/scripts/send-to-mainpc.sh`); the transfer counts as
`DELIVERED` only when the output contains `SENT:` and the remote SHA256 matches
the local file (`sendReportToMainPc`).

## MainPC

```powershell
.\scripts\core-night.ps1 -Deadline 05:00
```

MainPC uses the existing `ssh asus` transport. It launches a detached ASUS
Night Run (`--deadline 05:00 --no-poweroff`), polls with bounded reconnects,
pulls `NIGHT_REPORT_YYYY-MM-DD.md` via `scp`, and verifies the ASUS source
SHA256 (`sha256sum`) against the MainPC copy (`Get-FileHash`). Only after that
succeeds does it schedule `shutdown.exe /s /t 30`, then asks ASUS over
`ssh asus` to run a delayed detached `sudo -n /usr/sbin/poweroff`.
The wrapper refuses shutdown unless the ASUS status `endReason` is one of
`WBS_EXHAUSTED`, `DEADLINE_COMPLETE`, `DEADLINE_FORCED_CHECKPOINT` with a
non-empty `endedAt`.

The report and `LAST_NIGHT_RUN.json` are written before the final ASUS command.
Unfinished worktrees remain available for the next reconcile/resume.
