"use strict";

export const PM_DECISIONS = Object.freeze(["DISPATCH", "HOLD", "COMPLETE", "FOUNDER_GATE"]);

function packetLine(text, prefix) {
  const line = String(text)
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.trim().startsWith(prefix));

  if (!line) return null;

  try {
    return JSON.parse(line.trim().slice(prefix.length).trim());
  } catch {
    return null;
  }
}

export function parsePmPacket(text) {
  const packet = packetLine(text, "PM_PACKET:");

  if (
    !packet ||
    packet.schema !== "agent-relay.pm.v1" ||
    !packet.projectId ||
    !PM_DECISIONS.includes(packet.decision) ||
    typeof packet.reason !== "string"
  ) {
    throw new Error("invalid PM_PACKET");
  }

  if (packet.decision === "DISPATCH" && !packet.taskId) {
    throw new Error("PM_PACKET DISPATCH requires taskId");
  }

  return packet;
}

export function pmPrompt({ project, candidate, completedTaskIds = [] }) {
  return [
    "You are the Project PM for an Agent Relay CORE V1 lane.",
    "You are read-only. Do not modify files, commit, push, or widen Product scope.",
    `PROJECT: ${project.id}`,
    `AUTHORITATIVE_SSOT: ${project.ssot || "repository-backed SSOT"}`,
    `CURRENT_PROJECT_STATE: ${project.state || "UNKNOWN"}`,
    `COMPLETED_TASK_IDS: ${JSON.stringify(completedTaskIds)}`,
    candidate
      ? `NEXT_AUTHORIZED_CANDIDATE: ${JSON.stringify(candidate)}`
      : "NEXT_AUTHORIZED_CANDIDATE: null",
    "",
    "Rules:",
    "- You may DISPATCH only the exact NEXT_AUTHORIZED_CANDIDATE taskId shown above.",
    "- If there is no candidate, return COMPLETE when the V1 lane is complete, otherwise HOLD.",
    "- Return FOUNDER_GATE only for a genuine human/Product decision.",
    "- Never invent a new task or change task scope/files/tests.",
    "",
    `End with exactly one line: PM_PACKET: ${JSON.stringify({
      schema: "agent-relay.pm.v1",
      projectId: project.id,
      decision: candidate ? "DISPATCH" : "HOLD",
      taskId: candidate?.taskId || null,
      reason: "<repository-backed PM reason>",
    })}`,
  ].join("\n");
}

export class CodexPmAdapter {
  constructor({ runtime }) {
    this.runtime = runtime;
  }

  async decide({ project, candidate, completedTaskIds = [] }) {
    if (!candidate) {
      if (["V1_COMPLETE", "VERIFIED_DONE"].includes(project.state)) {
        return {
          schema: "agent-relay.pm.v1",
          projectId: project.id,
          decision: "COMPLETE",
          taskId: null,
          reason: "No remaining authorized CORE V1 task",
        };
      }

      if (project.state === "FOUNDER_GATE") {
        return {
          schema: "agent-relay.pm.v1",
          projectId: project.id,
          decision: "FOUNDER_GATE",
          taskId: null,
          reason: "Project is already at a Founder Gate",
        };
      }

      return {
        schema: "agent-relay.pm.v1",
        projectId: project.id,
        decision: "HOLD",
        taskId: null,
        reason: "No repository-authorized candidate is registered",
      };
    }

    const run = await this.runtime.run({
      workspace: project.path,
      sandbox: "read-only",
      prompt: pmPrompt({ project, candidate, completedTaskIds }),
    });

    const packet = parsePmPacket(run.text);

    if (packet.projectId !== project.id) {
      throw new Error(`PM project mismatch: ${packet.projectId} != ${project.id}`);
    }

    if (packet.decision === "DISPATCH" && packet.taskId !== candidate.taskId) {
      throw new Error(`PM attempted unauthorized task: ${packet.taskId}`);
    }

    return {
      ...packet,
      evidence: {
        pid: run.pid,
        startedAt: run.startedAt,
        exitCode: run.code,
      },
    };
  }
}
