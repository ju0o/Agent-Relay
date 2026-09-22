# Founder Gate Web UI Report

BASE_SHA=5e4d7282f1d78bbaa106a782d68fc69ccf8bc00c
IMPLEMENTATION_SHA=46458032e01a409cfb4e782ec48b9bf88c7ea0ad
FINAL_HEAD=46458032e01a409cfb4e782ec48b9bf88c7ea0ad
REMOTE_HEAD=46458032e01a409cfb4e782ec48b9bf88c7ea0ad
REMOTE_MATCH=true

UI_ARTIFACT=bridge/founder-gate-ui.mjs + src/v2/founder-ui/index.mjs
UI_HASH=2953b7a8223803f4bb460eaac52a71cef3df502212129243283ec9a2f12cca2c (bridge/founder-gate-ui.mjs)
LOCAL_URL=http://127.0.0.1:3847
LOCAL_INBOX=C:\Users\user\Desktop\FounderInbox

CURRENT_GATE=FG-a7ac130dd74dead09ac35559
CURRENT_GATE_PROJECT=JuActl
CURRENT_GATE_TYPE=FOUNDER_E2E_REQUIRED
CURRENT_GATE_UI_DOGFOOD=PASS; exact ASUS packet bytes were rendered in a loopback server with active project/gate count, OPEN, read-only evidence, Korean reason, technical details, and SEND/RESULT/COPY checklist
DECISION_SUBMITTED=false; no Founder response sidecar was created or uploaded

READ_ONLY_FIELDS=project, state, completed evidence, block reason, repo/ref/SHA, tests/QA, next automatic action
EDITABLE_FIELDS=decision APPROVE|REQUEST_CHANGES|PAUSE, gate-specific answers, Founder note
SECRET_HANDLING=SECRET_REQUIRED uses password input and stores only secretProvided=true; no secret value is written to HTML or response JSON
RESPONSE_FLOW=validated exact GATE_ID -> UTF-8 response sidecar -> existing FounderInboxBridge.uploadResponses() -> ASUS response inbox
STATUS_TRUTH=SUBMITTED only after bridge upload succeeds; DELIVERY_PENDING on transport failure; remote RESUMED is not claimed by the UI before evidence exists
PORT_BIND=127.0.0.1 only
STARTUP=existing user-level Scheduled Task installer starts both Bridge and UI after logon; no admin, account, OAuth, or secret changes

focused tests=`node --test test/v2/founder-ui.test.mjs test/v2/founder-bridge.test.mjs test/v2/portfolio-jit.test.mjs` 19/19 PASS
full suite=`npm test` PASS
typecheck=`npm run typecheck` PASS; `git diff --check` PASS
NEW_FAILURES=[]

Exact MainPC install/start/verify command:

```powershell
$r="$env:LOCALAPPDATA\AgentRelay\FounderBridge"; New-Item -ItemType Directory -Force $r | Out-Null; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/bridge/founder-bridge.mjs "$r\founder-bridge.mjs"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/bridge/install-founder-bridge.ps1 "$r\install-founder-bridge.ps1"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/src/v2/founder-bridge/index.mjs "$r\index.mjs"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/bridge/founder-gate-ui.mjs "$r\founder-gate-ui.mjs"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/src/v2/founder-ui/index.mjs "$r\founder-ui.mjs"; powershell -NoProfile -ExecutionPolicy Bypass -File "$r\install-founder-bridge.ps1"; $p="$env:USERPROFILE\Desktop\FounderInbox\JuActl\FG-a7ac130dd74dead09ac35559.md"; if (!(Test-Path $p)) { throw "Founder packet missing" }; if (!((Get-Content $p -Encoding UTF8 -Raw) -match 'GATE_ID: FG-a7ac130dd74dead09ac35559')) { throw "Gate identity mismatch" }; if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3847/api/health).StatusCode -ne 200) { throw "Founder UI unavailable" }; Get-Content $p -Encoding UTF8 -TotalCount 8
```

Founder approval was not fabricated or submitted. Portfolio Autopilot semantics were not changed.

Final status:
FOUNDER_GATE_WEB_UI_READY_FOR_FOUNDER_E2E
