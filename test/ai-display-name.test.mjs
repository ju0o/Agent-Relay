import assert from "node:assert/strict";
import test from "node:test";
import { aiDisplayName } from "../dist/server/shared/projectLabels.js";

test("aiDisplayName maps runtime ids to product names", () => {
  for (const [id, name] of Object.entries({
    codex: "Codex",
    opencode: "OpenCode",
    cline: "Cline",
    grok: "Grok",
    cursor: "Cursor",
    claude: "Claude",
    "claude-team": "Claude 팀",
    "claude-pro": "Claude Pro",
  })) assert.equal(aiDisplayName(id), name);
});

test("aiDisplayName returns unknown ids unchanged", () => {
  assert.equal(aiDisplayName("mystery"), "mystery");
  assert.equal(aiDisplayName("constructor"), "constructor");
});
