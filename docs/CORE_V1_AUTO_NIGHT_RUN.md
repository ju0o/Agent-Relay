# CORE V1 Auto Night Run

Founder authorization recorded in `BACKLOG.md`. Runtime default timezone is
`Asia/Seoul`; default deadline is `03:00`.

Routine non-financial feature, quality/reliability, UI/UX, and integration
WBS may be selected by each PM after reading its authoritative SSOT. The
existing independent QA and promotion gates remain mandatory. Financial,
credential, account/OAuth, and irreversible external actions remain Founder
gates; this policy does not create Product tasks without SSOT-backed PM scope.

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

MainPC uses the existing `ssh asus` transport. It launches a detached ASUS
Night Run, polls with bounded reconnects, pulls
`NIGHT_REPORT_YYYY-MM-DD.md`, and verifies the ASUS source SHA256 against the
MainPC copy. Only after that succeeds does it schedule
`shutdown.exe /s /t 30`, then asks ASUS over `ssh asus` to run a delayed
detached `sudo -n /usr/sbin/poweroff`. There is no ASUS→MainPC SSH or push
dependency.

The report and `LAST_NIGHT_RUN.json` are written before the final ASUS command.
Unfinished worktrees remain available for the next reconcile/resume.
