param(
  [string]$AsusHost = "asus",
  [string]$Deadline = "03:00",
  [int]$DisconnectTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$statusJson = ssh $AsusHost "agent-relay night-run up --deadline $Deadline"
$status = $statusJson | ConvertFrom-Json
if ($status.schema -ne "agent-relay.last-night-run.v1" -or
    ($status.endReason -ne "WBS_EXHAUSTED" -and $status.endReason -ne "DEADLINE_COMPLETE") -or
    [string]::IsNullOrWhiteSpace($status.endedAt)) {
  throw "Refusing shutdown: NIGHT_RUN_COMPLETE is unknown or corrupt."
}

$power = ssh $AsusHost "agent-relay night-run shutdown" | ConvertFrom-Json
if ($power.status -ne "POWEROFF_REQUESTED") {
  throw "Refusing MainPC shutdown: ASUS poweroff was not confirmed ($($power.status))."
}

$disconnectDeadline = (Get-Date).AddSeconds($DisconnectTimeoutSeconds)
$disconnected = $false
while ((Get-Date) -lt $disconnectDeadline) {
   ssh -o ConnectTimeout=2 $AsusHost "true" *> $null
   if ($LASTEXITCODE -ne 0) { $disconnected = $true; break }
   Start-Sleep -Seconds 1
 }
if (-not $disconnected) { throw "Refusing MainPC shutdown: ASUS SSH did not disconnect." }

Stop-Computer -Force
