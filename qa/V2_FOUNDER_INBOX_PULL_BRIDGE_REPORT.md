# Founder Inbox Pull Bridge Report

BASE_SHA=da18f3873fae332b5ba3fb121938a368c6ddd794
IMPLEMENTATION_SHA=cd501fba43647a88731cf762314f22ed4f040b44
FINAL_HEAD=cd501fba43647a88731cf762314f22ed4f040b44
REMOTE_HEAD=cd501fba43647a88731cf762314f22ed4f040b44
REMOTE_MATCH=true

BRIDGE_ARTIFACT=bridge/founder-bridge.mjs + bridge/install-founder-bridge.ps1 + src/v2/founder-bridge/index.mjs
BRIDGE_HASH=164f97e544a7a0e4738a0f229d9a8da54fadebba64709a2e40881aa70eef8c94 (bridge/founder-bridge.mjs)
LOCAL_INBOX=C:\Users\user\Desktop\FounderInbox
REMOTE_OUTBOX=/home/skkse12/.local/share/AgentRelay/data/founder-outbox
POLL_INTERVAL=15 seconds

CURRENT_GATE=FG-a7ac130dd74dead09ac35559
CURRENT_LOCAL_PACKET=C:\Users\user\Desktop\FounderInbox\JuActl\FG-a7ac130dd74dead09ac35559.md; existing local packet is reused after SHA verification
DELIVERY_ACK_CONTRACT=remote founder-outbox/<project>/receipts/<GATE_ID>.json with GATE_ID, project, localDestination, deliveredAt, contentHash; ASUS FounderGateManager reconciles only matching packet hash to DELIVERED

UTF8_PRESERVED=true; exact real ASUS packet bytes were exercised through the bridge fixture, including Korean text
DUPLICATE_SUPPRESSION=true; existing identical local packet is not pulled again and receipts are idempotent
RESTART_BEHAVIOR=single-instance lock plus 15-second bounded polling; failed pull remains pending for the next run
RESPONSE_CONTRACT=MainPC `<GATE_ID>.response.json` validates exact local packet GATE_ID, uploads to ASUS responses/<GATE_ID>.json, and FounderGateManager consumes only that matching lane
PACKET_NEWLINE_FIX=true; literal `\\n` in expected input is rendered as real Markdown newlines; UTF-8 is preserved

focused tests=`node --test test/v2/founder-bridge.test.mjs test/v2/portfolio-jit.test.mjs` 17/17 PASS
full suite=`npm test` PASS
typecheck=`npm run typecheck` PASS; `git diff --check` PASS
NEW_FAILURES=[]

The real MainPC push path remains unavailable from ASUS, so no false delivery claim was made. The existing reverse pull path is encoded in the installer command below. Founder approval was not created or submitted.

Exact MainPC install/start/verify command:

```powershell
$r="$env:LOCALAPPDATA\AgentRelay\FounderBridge"; New-Item -ItemType Directory -Force $r | Out-Null; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/bridge/founder-bridge.mjs "$r\founder-bridge.mjs"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/bridge/install-founder-bridge.ps1 "$r\install-founder-bridge.ps1"; scp asus:/home/skkse12/Desktop/Projects/Core/Agent-Relay-v2-portfolio-autopilot-dogfood-03/src/v2/founder-bridge/index.mjs "$r\index.mjs"; powershell -NoProfile -ExecutionPolicy Bypass -File "$r\install-founder-bridge.ps1"; $p="$env:USERPROFILE\Desktop\FounderInbox\JuActl\FG-a7ac130dd74dead09ac35559.md"; if (!(Test-Path $p)) { throw "Founder packet was not pulled" }; if (!((Get-Content $p -Encoding UTF8 -Raw) -match 'GATE_ID: FG-a7ac130dd74dead09ac35559')) { throw "Founder packet identity mismatch" }; Get-Content $p -Encoding UTF8 -TotalCount 8
```

Founder Gate remains `BLOCKED_FOR_FOUNDER`; this bridge command only recognizes and acknowledges delivery.

Final status:
FOUNDER_INBOX_BRIDGE_READY_FOR_MAINPC_INSTALL
