"use strict";

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexPmAdapter } from "./pm.mjs";
import { promoteAcceptedCommit } from "./worktrees.mjs";

export const CORE_V1_PROJECTS = Object.freeze(["agent-relay", "juactl", "juplan", "juceipt"]);

function definitions(project) {
  return project?.tasks || (project?.task ? [project.task] : []);
}

function taskIsTerminal(task) {
  return ["VERIFIED_DONE", "HOLD", "FOUNDER_GATE"].includes(task?.state);
}

function activeTaskFor(state, projectId) {
  return [...(state.tasks || [])]
    .reverse()
    .find((task) => task.projectId === projectId && !taskIsTerminal(task));
}

function latestTaskFor(state, projectId) {
  return [...(state.tasks || [])]
    .reverse()
    .find((task) => task.projectId === projectId);
}

function nextDefinition(project, state) {
  return definitions(project).find(
    (definition) =>
      !(state.tasks || []).some(
        (task) =>
          task.projectId === project.id &&
          task.taskId === definition.taskId &&
          task.state === "VERIFIED_DONE" &&
          (!task.coreV1Managed || task.promotion),
      ),
  );
}

function projectState(state, project) {
  return state.projects?.find((item) => item.id === project.id) || project;
}

export function buildCoreV1Snapshot({ manifest, state }) {
  const lanes = manifest.projects
    .filter((project) => CORE_V1_PROJECTS.includes(project.id))
    .map((project) => {
      const reconciled = projectState(state, project);
      const latest = latestTaskFor(state, project.id);
      const active = activeTaskFor(state, project.id);
      const next = nextDefinition(project, state);
      const pm = [...(state.pmDecisions || [])]
        .reverse()
        .find((decision) => decision.projectId === project.id);

      return {
        project: project.id,
        projectState: reconciled.state || project.state || "UNKNOWN",
        pm: {
          state: pm?.decision || (project.pmManaged ? "WAITING" : "UNMANAGED"),
          reason: pm?.reason || null,
          evidence: pm?.evidence || null,
        },
        currentTask: active?.taskId || null,
        latestTask: latest?.taskId || null,
        worker: {
          runtime: project.runtime || project.owner || null,
          state: active?.state || latest?.state || "IDLE",
          pid: active?.builderEvidence?.pid || null,
          workspace: active?.builderEvidence?.workspace || null,
        },
        result: latest?.result || null,
        qa: {
          runtime: project.qaRuntime || "codex",
          verdict: latest?.qa?.verdict || null,
          pid: latest?.qaEvidence?.pid || null,
        },
        attempts: latest?.attempts || 0,
        qaAttempts: latest?.qaAttempts || 0,
        nextTask: next?.taskId || null,
        promotion: latest?.promotion || null,
        blockers: reconciled.blockers || [],
        founderRequired:
          reconciled.state === "FOUNDER_GATE" || Boolean(reconciled.founderRequired),
        founderGateId: reconciled.gateId || null,
      };
    });

  return {
    schema: "agent-relay.core-v1.snapshot.v1",
    service: state.service || "STOPPED",
    updatedAt: state.updatedAt || new Date().toISOString(),
    activeBuilders: state.activeBuilders?.length || 0,
    activeQa: state.activeQa?.length || 0,
    lanes,
  };
}

export function formatCoreV1Results(snapshot) {
  const lines = [
    "CORE V1 AUTO DEVELOPMENT TEAM",
    `service: ${snapshot.service}`,
    `builders: ${snapshot.activeBuilders} | qa: ${snapshot.activeQa}`,
    "",
  ];

  for (const lane of snapshot.lanes) {
    lines.push(`[${lane.project}]`);
    lines.push(`PM: ${lane.pm.state}${lane.pm.reason ? ` — ${lane.pm.reason}` : ""}`);
    lines.push(`STATE: ${lane.projectState}`);
    lines.push(`TASK: ${lane.currentTask || lane.latestTask || "none"}`);
    lines.push(`WORKER: ${lane.worker.runtime || "none"} / ${lane.worker.state}`);
    lines.push(`QA: ${lane.qa.runtime || "none"} / ${lane.qa.verdict || "waiting"}`);
    lines.push(`NEXT: ${lane.nextTask || "none"}`);
    if (lane.result?.summary) lines.push(`RESULT: ${lane.result.summary}`);
    if (lane.promotion?.ref) lines.push(`PROMOTED: ${lane.promotion.ref} @ ${lane.promotion.commitSha}`);
    if (lane.blockers.length) lines.push(`BLOCKERS: ${lane.blockers.join(" | ")}`);
    if (lane.founderRequired) lines.push(`FOUNDER_GATE: ${lane.founderGateId || "required"}`);
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export class CoreV1Team {
  constructor({ runner, manifest, pmAdapter, snapshotPath, promote = promoteAcceptedCommit }) {
    this.runner = runner;
    this.manifest = manifest;
    this.pmAdapter = pmAdapter || new CodexPmAdapter({ runtime: runner.runtime });
    this.snapshotPath = snapshotPath;
    this.promote = promote;
  }

  coreProjects() {
    return this.manifest.projects.filter(
      (project) => project.active !== false && CORE_V1_PROJECTS.includes(project.id),
    );
  }

  async _recordPmDecision(state, decision) {
    state.pmDecisions = [
      ...(state.pmDecisions || []).filter(
        (item) => item.projectId !== decision.projectId,
      ),
      { ...decision, decidedAt: new Date().toISOString() },
    ];
    await this.runner.save(state);
  }

  async _markManagedTask(projectId, taskId) {
    const state = await this.runner.load();
    const task = state.tasks?.find(
      (item) => item.projectId === projectId && item.taskId === taskId,
    );
    if (task) {
      task.coreV1Managed = true;
      await this.runner.save(state);
    }
  }

  async prepare() {
    const state = await this.runner.reconcile();

    for (const project of this.coreProjects()) {
      if (!project.pmManaged) continue;

      const reconciled = projectState(state, project);
      if (["FOUNDER_GATE", "HOLD", "INTEGRATION_TARGET"].includes(reconciled.state)) {
        continue;
      }

      if (activeTaskFor(state, project.id)) continue;

      const latest = latestTaskFor(state, project.id);
      if (latest && ["HOLD", "FOUNDER_GATE"].includes(latest.state)) {
        continue;
      }

      const candidate = nextDefinition(project, state);
      const completedTaskIds = (state.tasks || [])
        .filter(
          (task) =>
            task.projectId === project.id &&
            task.state === "VERIFIED_DONE" &&
            (!task.coreV1Managed || task.promotion),
        )
        .map((task) => task.taskId);

      const decision = await this.pmAdapter.decide({
        project,
        candidate,
        completedTaskIds,
      });

      await this._recordPmDecision(state, decision);

      if (decision.decision === "DISPATCH") {
        const task = await this.runner.enqueue(project.id);
        await this._markManagedTask(project.id, task.taskId);
      }
    }

    return this.runner.load();
  }

  async promoteAccepted() {
    const state = await this.runner.load();
    let changed = false;

    for (const task of state.tasks || []) {
      if (
        task.coreV1Managed !== true ||
        task.state !== "VERIFIED_DONE" ||
        task.promotion
      ) {
        continue;
      }

      if (!task.result?.commitSha) {
        task.state = "HOLD";
        task.error = "CORE_V1_PROMOTION_MISSING_COMMIT_SHA";
        changed = true;
        continue;
      }

      const project = this.manifest.projects.find((item) => item.id === task.projectId);
      if (!project) continue;

      try {
        task.promotion = await this.promote(project, task.result.commitSha);
      } catch (error) {
        task.state = "HOLD";
        task.error = `CORE_V1_PROMOTION_FAILED: ${String(error.message || error)}`;
      }
      changed = true;
    }

    if (changed) await this.runner.save(state);
    return state;
  }

  async runOnce() {
    await this.prepare();
    await this.runner.runOnce();
    await this.promoteAccepted();
    await this.prepare();

    const state = await this.runner.load();
    state.service = "IDLE";
    await this.runner.save(state);

    return this.status();
  }

  async runLoop({ intervalMs = 15_000, signal } = {}) {
    while (!signal?.aborted) {
      await this.runOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return this.status();
  }

  async status() {
    const state = await this.runner.load();
    const snapshot = buildCoreV1Snapshot({ manifest: this.manifest, state });
    await this.persistSnapshot(snapshot);
    return snapshot;
  }

  async results({ json = false } = {}) {
    const snapshot = await this.status();
    return json ? JSON.stringify(snapshot, null, 2) : formatCoreV1Results(snapshot);
  }

  async persistSnapshot(snapshot) {
    if (!this.snapshotPath) return;

    await mkdir(dirname(this.snapshotPath), { recursive: true });
    await writeFile(this.snapshotPath, JSON.stringify(snapshot, null, 2));
    await writeFile(
      this.snapshotPath.replace(/\.json$/i, ".txt"),
      formatCoreV1Results(snapshot),
    );
  }
}
