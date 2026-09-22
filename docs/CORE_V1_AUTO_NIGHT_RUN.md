# CORE V1 Auto Night Run

Founder authorization recorded in `BACKLOG.md`. Runtime default timezone is
`Asia/Seoul`; default deadline is `03:00`.

## ASUS one-time setup

Run this manually on ASUS after replacing `YOUR_LINUX_USER`:

```sh
printf '%s\n' 'YOUR_LINUX_USER ALL=(root) NOPASSWD: /sbin/poweroff' | sudo visudo -f /etc/sudoers.d/agent-relay-night-run
sudo -n /sbin/poweroff --help >/dev/null
```

This grants only `/sbin/poweroff`. Agent Relay never edits `/etc/sudoers`,
stores passwords, or waits for an interactive sudo prompt. If `sudo -n` is not
allowed, the run remains recorded and reports `SHUTDOWN_PERMISSION_REQUIRED`.

## MainPC

```powershell
.\scripts\core-night.ps1
```

The wrapper refuses to power off ASUS or MainPC unless the durable night record
is a valid `WBS_EXHAUSTED` or `DEADLINE_COMPLETE` record.
