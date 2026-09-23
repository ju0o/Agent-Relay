@echo off
rem Double-click to start tonight's Agent Relay Night Run. Change the end time here (24h, KST):
set DEADLINE=04:30
rem Keep this window open and MainPC awake; it pulls the report and shuts down MainPC, then ASUS.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core-night.ps1" -Deadline %DEADLINE%
pause
