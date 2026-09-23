@echo off
rem Double-click: connection + preflight check only. Never starts, pulls, or shuts down anything.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core-night.ps1" -DryRun
pause
