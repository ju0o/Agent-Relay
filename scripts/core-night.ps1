param(
  [string]$AsusHost = "asus",
  [string]$Deadline = "03:00",
  [int]$DisconnectTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
$statusJson = ssh -o BatchMode=yes -o ConnectTimeout=5 $AsusHost "agent-relay night-run up --deadline $Deadline" 2>&1
$rawStatus = $statusJson -join "`n"
$start = $rawStatus.IndexOf("{")
$end = $rawStatus.LastIndexOf("}")
if ($start -lt 0 -or $end -le $start) { throw "Refusing shutdown: NIGHT_RUN_COMPLETE is missing." }
$status = $rawStatus.Substring($start, $end - $start + 1) | ConvertFrom-Json
if ($status.schema -ne "agent-relay.last-night-run.v1" -or
    ($status.endReason -ne "WBS_EXHAUSTED" -and $status.endReason -ne "DEADLINE_COMPLETE") -or
    [string]::IsNullOrWhiteSpace($status.endedAt) -or
    $status.reportTransferState -notin @("DELIVERED", "REPORT_TRANSFER_FAILED") -or
    $status.mainPcShutdownRequested -ne $true) {
  throw "Refusing shutdown: NIGHT_RUN_COMPLETE is unknown or corrupt."
}
Write-Output $statusJson
