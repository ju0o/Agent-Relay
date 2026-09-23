#!/usr/bin/env node
/**
 * relay-worker-opencode.mjs — Semantic QA passthrough worker backed by OpenCode.
 *
 * Purpose: give the `qa` role a runtime that is NOT the Claude subscription, so
 * a Claude session-limit does not stall the supervisor loop and escalate a
 * machine failure to the Founder (observed 2026-09-16, TASK-0006).
 *
 * Shape served: the exact invocation qa-semantic-evaluator.ts invokeOnce
 * produces against a worker registry row — `--print <prompt>` with no relay
 * args. Anything else fails closed; this wrapper is QA-only and never pretends
 * to be an implementation worker.
 *
 * Billing posture: FREE TIER ONLY. The model must end in `-free` or be
 * `big-pickle` (same allowlist as isFreeTierModel in role-loop.ts). Any other
 * model is refused before spawn — metered `opencode-go/*` can never be reached
 * through this path, regardless of configuration.
 *
 * stdout carries only the assistant text (extracted from `--format json`
 * `type:"text"` events) so the semantic line parser sees a clean block. The
 * default human renderer prints chrome like `> build · <model>`, which would
 * corrupt that parse; JSON mode avoids it. All diagnostics go to stderr.
 */
import { spawn } from "node:child_process";

const DEFAULT_MODEL = "opencode/mimo-v2.5-free";
const RELAY_ARGS = new Set([
  "--dataRoot", "--project", "--taskId", "--runId",
  "--workspaceRoot", "--claudeConfigDir",
]);

/** Free-tier allowlist, mirrored from role-loop.ts isFreeTierModel. */
function isFreeTierModel(model) {
  if (!model) return false;
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return /-free$/.test(bare) || bare === "big-pickle";
}

/** Detect the QA passthrough shape; returns the prompt or null. */
function detectQaPrompt(argv) {
  for (const tok of argv) if (RELAY_ARGS.has(tok)) return null;
  const idx = argv.indexOf("--print");
  if (idx === -1) return null;
  const prompt = argv[idx + 1];
  if (prompt === undefined || prompt.startsWith("--")) return null;
  return prompt;
}

async function runQaPassthrough(prompt, model) {
  const exitCode = await new Promise((resolve) => {
    let child;
    try {
      child = spawn("opencode", ["run", "--format", "json", "-m", model, prompt], {
        cwd: process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      process.stderr.write(`[relay-worker-opencode:qa] spawn threw: ${err?.message ?? err}\n`);
      resolve(1);
      return;
    }
    const onSig = (s) => () => { try { child.kill(s); } catch { /* already gone */ } };
    const onTerm = onSig("SIGTERM"), onInt = onSig("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);

    let buf = "";
    const emitLine = (line) => {
      const t = line.trim();
      if (!t) return;
      let ev;
      try { ev = JSON.parse(t); } catch { return; }
      if (ev?.type === "text" && typeof ev?.part?.text === "string") {
        process.stdout.write(ev.part.text);
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        emitLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    const errChunks = [];
    let errLen = 0;
    child.stderr.on("data", (d) => {
      if (errLen < 8000) { errChunks.push(d); errLen += d.length; }
    });
    child.on("error", (err) => {
      process.stderr.write(`[relay-worker-opencode:qa] spawn error: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, sig) => {
      if (buf) emitLine(buf);
      process.stdout.write("\n");
      process.removeListener("SIGTERM", onTerm);
      process.removeListener("SIGINT", onInt);
      const excerpt = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 2000);
      if (excerpt) process.stderr.write(`${excerpt}\n`);
      resolve(code ?? (sig ? 1 : 0));
    });
  });
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
const model = process.env.RELAY_QA_OPENCODE_MODEL || DEFAULT_MODEL;

if (!isFreeTierModel(model)) {
  process.stderr.write(
    `[relay-worker-opencode:qa] refused: model "${model}" is not free-tier. ` +
    `This worker is free-tier-only by policy; metered models are never spawned here.\n`
  );
  process.exit(2);
}

const prompt = detectQaPrompt(argv);
if (prompt === null) {
  process.stderr.write(
    `[relay-worker-opencode:qa] refused: this worker serves only the QA passthrough ` +
    `shape (--print <prompt>, no relay args). It is not an implementation worker.\n`
  );
  process.exit(2);
}

await runQaPassthrough(prompt, model);
