# CORE V1 Auto Night Run

Founder authorization recorded in `BACKLOG.md`. Runtime default timezone is
`Asia/Seoul`; default deadline is `03:00`.

## ASUS one-time setup

Run this once on ASUS as the configured user (`skkse12`):

```sh
printf '%s\n' 'skkse12 ALL=(root) NOPASSWD: /usr/sbin/poweroff' | sudo visudo -f /etc/sudoers.d/agent-relay-night-run
sudo -n /usr/sbin/poweroff --help >/dev/null
```

This grants only `/sbin/poweroff`. Agent Relay never edits `/etc/sudoers`,
stores passwords, or waits for an interactive sudo prompt. If `sudo -n` is not
allowed, the run remains recorded and reports `SHUTDOWN_PERMISSION_REQUIRED`.

## MainPC

```powershell
.\scripts\core-night.ps1
```

The existing SSH alias `mainpc` is used for the MainPC transport unless
`MAINPC_SSH_TARGET` overrides it. The ASUS supervisor performs the bounded sequence: `NIGHT_REPORT_YYYY-MM-DD.md`
→ Send-to-MainPC with destination SHA verification → `shutdown.exe /s /t 30`
→ `sudo -n /usr/sbin/poweroff`. The MainPC wrapper only accepts a valid durable
`WBS_EXHAUSTED` or `DEADLINE_COMPLETE` result; it never issues a guessed local
shutdown command. A missing report transfer or shutdown result remains recorded
and does not wait for a password.

The report and `LAST_NIGHT_RUN.json` are written before the final ASUS command.
Unfinished worktrees remain available for the next reconcile/resume.
