#!/usr/bin/env node
import { FounderInboxBridge } from "../src/v2/founder-bridge/index.mjs";
import { FounderGateUiServer } from "../src/v2/founder-ui/index.mjs";

const localInbox = process.env.LOCAL_INBOX || `${process.env.USERPROFILE || process.env.HOME}/Desktop/FounderInbox`;
const bridge = new FounderInboxBridge({ alias: process.env.REMOTE_ALIAS || "asus", remoteRoot: process.env.REMOTE_DATA_ROOT || "/home/skkse12/.local/share/AgentRelay/data", localInbox });
const server = new FounderGateUiServer({ localInbox, bridge, port: Number(process.env.FOUNDER_UI_PORT || 3847) });
const port = await server.start();
console.log(`FOUNDER_GATE_UI_READY http://127.0.0.1:${port}`);
const stop = async () => { await server.stop(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);

