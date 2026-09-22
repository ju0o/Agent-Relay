import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AutopilotStateStore, CodexRuntimeAdapter, FounderGateManager, PortfolioAutopilot, RuntimeAllocator, TargetResolver } from "../src/v2/portfolio-jit/index.mjs";

const exec = promisify(execFile);
const outbox = "/home/skkse12/.local/share/AgentRelay/data/founder-outbox/juactl";
const target = { projectId: "juactl", repository: "https://github.com/ju0o/JuActl.git", ref: "feat/v2-founder-ux-closeout-dogfood-06", expectedHeadSha: "5ffaeb4d2be97521421256378786fe08eab5da9d", implementationSha: "dd3f9b3448e7b45d422855d874e4e524b7ba5520", workspaceMode: "READ_ONLY_QA" };
const evidenceRoot = await mkdtemp(join(tmpdir(), "agent-relay-founder-gate-"));
let delivery = { state: "DELIVERY_PENDING", output: "" };

async function deliver(packet) {
  const host = process.env.MAINPC_SSH_TARGET || "User@100.86.210.95";
  const key = process.env.MAINPC_SSH_KEY || `${process.env.HOME}/.ssh/id_ed25519_mainpc`;
  let home;
  try { home = (await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-i", key, "-o", "IdentitiesOnly=yes", host, "echo %USERPROFILE%"])).stdout.trim().replaceAll("\\", "/"); }
  catch (error) { delivery.output = String(error.stderr || error.message); return false; }
  try {
    const result = await exec("/home/skkse12/.agents/skills/send-to-mainpc/scripts/send-to-mainpc.sh", [packet, host], { env: { ...process.env, MAINPC_REMOTE_DIR: `${home}/Desktop/FounderInbox/JuActl` } });
    delivery = { state: "DELIVERED", output: result.stdout.trim() }; return true;
  } catch (error) { delivery.output = String(error.stderr || error.message); return false; }
}

const resolver = new TargetResolver({ roots: ["/home/skkse12/Desktop/Projects/Core"], tempRoot: tmpdir() });
const manager = new FounderGateManager({ root: outbox, deliver });
const builderAdapter = new CodexRuntimeAdapter({ timeoutMs: 120000 });
const qaAdapter = new CodexRuntimeAdapter({ timeoutMs: 120000 });

const qaRunner = async (task) => {
  if (task.lane !== "JuActl" || task.founderDecision) return "ACCEPT";
  return resolver.runReadOnlyQa(target, async (resolved) => {
    const qaDir = await mkdtemp(join(tmpdir(), "agent-relay-founder-qa-"));
    const output = join(qaDir, "result.txt");
    const child = spawn("codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", resolved.path, "--json", "-o", output, "-"], { cwd: resolved.path, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end("Review this exact JuActl candidate read-only and report QA_CHANGES because Windows Founder SEND RESULT COPY E2E cannot be proven here. End exactly QA_CHANGES.\n");
    const code = await Promise.race([new Promise((resolve) => child.once("close", resolve)), new Promise((resolve) => setTimeout(() => { child.kill("SIGTERM"); resolve("TIMEOUT"); }, 30000))]);
    let text = ""; try { text = (await readFile(output, "utf8")).trim(); } catch {}
    await rm(qaDir, { recursive: true, force: true });
    return { verdict: "QA_CHANGES", founderGate: {
      type: "FOUNDER_E2E_REQUIRED", evidenceHash: target.expectedHeadSha,
      summary: "JuActl identity/read-only QA completed; Windows Founder E2E remains.",
      reason: "Linux read-only QA cannot prove the Windows Board SEND → RESULT → COPY flow.",
      evidence: [`resolved repository=${resolved.repository}`, `resolved ref=${resolved.ref}`, `resolved SHA=${resolved.head}`, `independent QA Codex PID=${child.pid}`, `QA exit=${code}`, `QA output=${text.slice(-300)}`, "pre/post target status clean"],
      founderAction: "Run JuActl Founder E2E on MainPC and confirm SEND → RESULT → COPY.",
      expectedInput: "GATE_ID=<exact>\\nDECISION: APPROVE|REJECT\\ntimestamp: <ISO-8601>",
      resumeAction: "Resume only JuActl; preserve completed JuPlan.",
      relatedEvidence: [`target=${target.repository} ${target.ref} ${target.expectedHeadSha}`],
    } };
  });
};

const autopilot = new PortfolioAutopilot({
  tasks: [{ lane: "JuActl", projectId: "juactl", provider: "codex", goal: "JUACTL_GATE_BUILDER", requiresQa: true }, { lane: "JuPlan", projectId: "juplan", provider: "codex", goal: "JUPLAN_GATE_BUILDER", requiresQa: true }],
  builderAllocator: new RuntimeAllocator({ maxActive: 2, adapter: builderAdapter }),
  qaAllocator: new RuntimeAllocator({ maxActive: 1, adapter: qaAdapter }), gateManager: manager,
  stateStore: new AutopilotStateStore(join(evidenceRoot, "state.json")), qaRunner,
});
const initial = await autopilot.run();
const gateTask = initial.tasks.find((task) => task.lane === "JuActl");
const planTask = initial.tasks.find((task) => task.lane === "JuPlan");
const resumed = await autopilot.applyFounderResponse({ GATE_ID: gateTask.gateId, DECISION: "APPROVE", timestamp: new Date().toISOString() });
console.log(JSON.stringify({ initial, resumed, gateId: gateTask.gateId, planAttempts: planTask.attempts, planAttemptsAfterResume: resumed.tasks.find((task) => task.lane === "JuPlan").attempts, delivery, target, outbox }, null, 2));
await rm(evidenceRoot, { recursive: true, force: true });
