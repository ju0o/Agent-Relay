#!/usr/bin/env node
import { FounderInboxBridge } from "../src/v2/founder-bridge/index.mjs";

const bridge = new FounderInboxBridge({
  alias: process.env.REMOTE_ALIAS || "asus",
  remoteRoot: process.env.REMOTE_DATA_ROOT || "/home/skkse12/.local/share/AgentRelay/data",
  localInbox: process.env.LOCAL_INBOX || `${process.env.USERPROFILE || process.env.HOME}/Desktop/FounderInbox`,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 15000),
});
const command = process.argv[2] || "run";
if (command === "once") console.log(JSON.stringify(await bridge.once(), null, 2));
else if (command === "run") await bridge.run();
else throw new Error(`usage: founder-bridge.mjs [run|once]`);
