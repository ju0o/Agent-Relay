param(
  [string]$BridgeRoot = "$env:LOCALAPPDATA\AgentRelay\FounderBridge",
  [string]$RemoteAlias = "asus",
  [string]$RemoteDataRoot = "/home/skkse12/.local/share/AgentRelay/data",
  [string]$LocalInbox = "$env:USERPROFILE\Desktop\FounderInbox"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $BridgeRoot | Out-Null
$node = Join-Path $BridgeRoot "founder-bridge.mjs"
$source = Join-Path $PSScriptRoot "founder-bridge.mjs"
if ([IO.Path]::GetFullPath($source) -ne [IO.Path]::GetFullPath($node)) { Copy-Item -Force $source $node }
$moduleDir = Join-Path $BridgeRoot "src\v2\founder-bridge"
New-Item -ItemType Directory -Force -Path $moduleDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "index.mjs") (Join-Path $moduleDir "index.mjs")
$uiModuleDir = Join-Path $BridgeRoot "src\v2\founder-ui"
New-Item -ItemType Directory -Force -Path $uiModuleDir | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "founder-ui.mjs") (Join-Path $uiModuleDir "index.mjs")
Copy-Item -Force (Join-Path $PSScriptRoot "founder-gate-ui.mjs") (Join-Path $BridgeRoot "founder-gate-ui.mjs")
$env:REMOTE_ALIAS = $RemoteAlias
$env:REMOTE_DATA_ROOT = $RemoteDataRoot
$env:LOCAL_INBOX = $LocalInbox
$env:POLL_INTERVAL_MS = "15000"
& node $node once
$task = "Agent Relay Founder Inbox Bridge"
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$node`" run"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Description "Pull Agent Relay Founder Gate packets and upload responses" -Force | Out-Null
Start-ScheduledTask -TaskName $task
$uiTask = "Agent Relay Founder Gate UI"
$uiAction = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$(Join-Path $BridgeRoot 'founder-gate-ui.mjs')`""
Register-ScheduledTask -TaskName $uiTask -Action $uiAction -Trigger $trigger -Description "Local Founder Gate web UI" -Force | Out-Null
Start-ScheduledTask -TaskName $uiTask
Write-Output "FOUNDER_BRIDGE_STARTED: $task"
Write-Output "FOUNDER_GATE_UI_STARTED: http://127.0.0.1:3847"
