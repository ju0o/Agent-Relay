param(
  [string]$AsusHost = "asus",
  [string]$Deadline = "04:30",
  [int]$PollSeconds = 15,
  [int]$PollTimeoutSeconds = 90000,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$transportArgs = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=5")
$sshArgs = @($transportArgs + $AsusHost)
$relay = "/home/skkse12/.local/bin/agent-relay"

function Invoke-Asus([string]$Command) {
  $output = & ssh @sshArgs $Command 2>&1
  if ($LASTEXITCODE -ne 0) { throw "ASUS SSH command failed: $Command" }
  return $output
}

function Read-Status($Output) {
  $raw = $Output -join "`n"
  $start = $raw.IndexOf("{"); $end = $raw.LastIndexOf("}")
  if ($start -lt 0 -or $end -le $start) { return $null }
  try { return ($raw.Substring($start, $end - $start + 1) | ConvertFrom-Json) } catch { return $null }
}

$pidFile = "~/.local/share/AgentRelay/data/portfolio-execution/night-run.pid"
if ($DryRun) {
  # DryRun validates transport + status only: never launches, pulls, or shuts down.
  Write-Output "ASUS_SSH: $((Invoke-Asus 'printf MAINPC_TO_ASUS_OK') -join '')"
  Write-Output "NIGHT_RUN_PID: $((Invoke-Asus "cat $pidFile 2>/dev/null || echo none") -join '')"
  Write-Output "STATUS: $((Invoke-Asus "$relay night-run status") -join "`n")"
  exit 0
}
$launch = Invoke-Asus "if kill -0 `$(cat $pidFile 2>/dev/null) 2>/dev/null; then echo NIGHT_RUN_ATTACHED; else nohup $relay night-run up --deadline $Deadline --mainpc-pull >> ~/.local/share/AgentRelay/data/portfolio-execution/night-run.log 2>&1 < /dev/null & echo NIGHT_RUN_STARTED; fi"
if (-not (($launch -join "`n") -match "NIGHT_RUN_(STARTED|ATTACHED)")) { throw "Refusing activation: detached Night Run was not acknowledged." }

$status = $null; $started = Get-Date
while (((Get-Date) - $started).TotalSeconds -lt $PollTimeoutSeconds) {
  $status = Read-Status (Invoke-Asus "$relay night-run status")
  if ($null -ne $status -and $status.endReason -in @("WBS_EXHAUSTED", "DEADLINE_COMPLETE", "DEADLINE_FORCED_CHECKPOINT") -and -not [string]::IsNullOrWhiteSpace($status.endedAt)) { break }
  Start-Sleep -Seconds $PollSeconds
}
if ($null -eq $status -or $status.endReason -notin @("WBS_EXHAUSTED", "DEADLINE_COMPLETE", "DEADLINE_FORCED_CHECKPOINT") -or $status.shutdownState -ne "READY_FOR_MAINPC_PULL") { throw "Refusing shutdown: NIGHT_RUN_COMPLETE is unknown, corrupt, or timed out." }

$remoteReport = [string]$status.reportPathAsus
if ($remoteReport -notmatch '^/[A-Za-z0-9_./-]+$') { throw "Refusing report pull: unsafe ASUS path." }
$reportName = Split-Path -Leaf $remoteReport
$localReport = Join-Path (Join-Path $env:USERPROFILE "Desktop") $reportName
$localState = Join-Path (Join-Path $env:USERPROFILE "Desktop") "LAST_NIGHT_RUN.json"
if ($DryRun) { $reportPulled = $true } else { & scp @transportArgs "${AsusHost}:$remoteReport" $localReport; if ($LASTEXITCODE -ne 0) { throw "REPORT_PULL_FAILED" }; $reportPulled = Test-Path -LiteralPath $localReport }
if (-not $reportPulled -or (Test-Path -LiteralPath $localReport -PathType Leaf -and (Get-Item -LiteralPath $localReport).Length -le 0)) { throw "REPORT_PULL_FAILED: destination missing or empty." }
if (-not $DryRun) { $remoteState = [string]$status.checkpointPath; if ($remoteState -notmatch '^/[A-Za-z0-9_./-]+$') { throw "Refusing state pull: unsafe ASUS path." }; & scp @transportArgs "${AsusHost}:$remoteState" $localState; if ($LASTEXITCODE -ne 0) { throw "STATE_PULL_FAILED" }; if (-not (Test-Path -LiteralPath $localState -PathType Leaf) -or (Get-Item -LiteralPath $localState).Length -le 0) { throw "STATE_PULL_FAILED: destination missing or empty." } }

$remoteHash = if ($DryRun) { "DRY_RUN" } else { ((Invoke-Asus "sha256sum -- '$remoteReport'") -join "`n") -match '([0-9a-fA-F]{64})'; $Matches[1].ToLowerInvariant() }
$localHash = if ($DryRun) { "DRY_RUN" } else { (Get-FileHash -LiteralPath $localReport -Algorithm SHA256).Hash.ToLowerInvariant() }
if ($remoteHash -ne $localHash) { throw "HASH_VERIFY_FAILED: ASUS=$remoteHash MainPC=$localHash" }

$mainPcScheduled = $false
try {
  if (-not $DryRun) { & shutdown.exe /s /t 30; if ($LASTEXITCODE -ne 0) { throw "MAINPC_SHUTDOWN_FAILED" } }
  $mainPcScheduled = $true
  $asusPoweroff = "nohup sh -c 'sleep 5; exec sudo -n /usr/sbin/poweroff' >/dev/null 2>&1 </dev/null &"
  if (-not $DryRun) { Invoke-Asus $asusPoweroff | Out-Null }
} catch {
  if ($mainPcScheduled -and -not $DryRun) { & shutdown.exe /a | Out-Null }
  throw
}

Write-Output "NIGHT_RUN_COMPLETE: $($status.endReason)"
Write-Output "REPORT: $localReport"
Write-Output "HASH: $localHash"
Write-Output "MAINPC_SHUTDOWN: $(if ($DryRun) { 'MOCKED' } else { 'SCHEDULED_30S' })"
Write-Output "ASUS_POWEROFF: $(if ($DryRun) { 'MOCKED' } else { 'SCHEDULED' })"
