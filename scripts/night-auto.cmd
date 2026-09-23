@echo off
rem Double-click: hand tonight to ASUS. It sends NIGHT_REPORT here, shuts this PC down, then itself.
rem Needs the ASUS key registered on this PC (preflight shows mainpc_push: OK). Change the end time here:
set DEADLINE=04:30
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core-night.ps1" -Deadline %DEADLINE% -Push
pause
