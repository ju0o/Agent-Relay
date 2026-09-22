import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreV1Team,
  buildCoreV1Snapshot,
  formatCoreV1Results,
} from "../../src/v2/core-v1/index.mjs";
import { parsePmPacket } from "../../src/v2/core-v1/pm.mjs";

test("PM packet parser rejects invented or malformed responses", () => {
  assert.equal(
    parsePmPacket(
      'PM_PACKET: {"schema":"agent-relay.pm.v1","projectId":"agent-relay","decision":"DISPATCH","taskId":"T1","reason":"authorized"}',
    ).taskId,
    "T1",
  );

  assert.throws(() => parsePmPacket("looks good"), /invalid PM_PACKET/);
  assert.throws(
    () =>
      parsePmPacket(
        'PM_PACKET: {"schema":"agent-relay.pm.v1","projectId":"agent-relay","decision":"DISPATCH","reason":"missing task"}',
      ),
    /requires taskId/,
  );
});

test("CORE V1 PM automatically queues NEXT after QA ACCEPT without Founder relay", async () => {
  const manifest = {
    projects: [
      {
        id: "agent-relay",
        active: true,
        pmManaged: true,
        runtime: "codex",
        qaRuntime: "codex",
        state: "QUEUED",
        tasks: [
          { taskId: "T1", scope: "one", files: [], tests: [] },
          { taskId: "T2", scope: "two", files: [], tests: [] },
        ],
      },
    ],
  };

  let state = {
    service: "IDLE",
    tasks: [],
    projects: [{ id: "agent-relay", state: "QUEUED", blockers: [] }],
    activeBuilders: [],
    activeQa: [],
    pmDecisions: [],
  };

  const runner = {
    runtime: {},
    async reconcile() { return state; },
    async load() { return state; },
    async save(next) { state = next; return state; },
    async enqueue(projectId) {
      const project = manifest.projects.find((item) => item.id === projectId);
      const next = project.tasks.find(
        (definition) =>
          !state.tasks.some(
            (task) =>
              task.taskId === definition.taskId && task.state === "VERIFIED_DONE",
          ),
      );
      if (!state.tasks.some((task) => task.taskId === next.taskId)) {
        state.tasks.push({ ...next, projectId, state: "QUEUED", attempts: 0, qaAttempts: 0 });
      }
      return next;
    },
    async runOnce() {
      const queued = state.tasks.find((task) => task.state === "QUEUED");
      queued.state = "VERIFIED_DONE";
      queued.attempts = 1;
      queued.qaAttempts = 1;
      queued.result = {
        schema: "agent-relay.result.v1",
        taskId: queued.taskId,
        status: "IMPLEMENTED",
        changedFiles: [],
        tests: [],
        summary: "done",
      };
      queued.qa = {
        schema: "agent-relay.qa.v1",
        taskId: queued.taskId,
        verdict: "ACCEPT",
        tests: [],
        findings: [],
        summary: "accepted",
      };
      return state;
    },
  };

  const pmAdapter = {
    async decide({ project, candidate }) {
      return candidate
        ? {
            schema: "agent-relay.pm.v1",
            projectId: project.id,
            decision: "DISPATCH",
            taskId: candidate.taskId,
            reason: "next authorized candidate",
          }
        : {
            schema: "agent-relay.pm.v1",
            projectId: project.id,
            decision: "COMPLETE",
            taskId: null,
            reason: "complete",
          };
    },
  };

  const team = new CoreV1Team({ runner, manifest, pmAdapter });
  await team.runOnce();

  assert.equal(state.tasks.find((task) => task.taskId === "T1").state, "VERIFIED_DONE");
  assert.equal(state.tasks.find((task) => task.taskId === "T2").state, "QUEUED");
  assert.equal(state.pmDecisions[0].taskId, "T2");
});

test("CORE V1 result inbox exposes PM, Worker, QA, NEXT and blockers", () => {
  const manifest = {
    projects: [
      {
        id: "agent-relay",
        active: true,
        pmManaged: true,
        runtime: "codex",
        qaRuntime: "codex",
        tasks: [
          { taskId: "T1", scope: "one", files: [], tests: [] },
          { taskId: "T2", scope: "two", files: [], tests: [] },
        ],
      },
    ],
  };

  const state = {
    service: "IDLE",
    activeBuilders: [],
    activeQa: [],
    pmDecisions: [
      {
        projectId: "agent-relay",
        decision: "DISPATCH",
        taskId: "T2",
        reason: "authorized next",
      },
    ],
    projects: [{ id: "agent-relay", state: "QUEUED", blockers: ["example"] }],
    tasks: [
      {
        projectId: "agent-relay",
        taskId: "T1",
        state: "VERIFIED_DONE",
        attempts: 1,
        qaAttempts: 1,
        result: { summary: "implemented" },
        qa: { verdict: "ACCEPT" },
      },
    ],
  };

  const snapshot = buildCoreV1Snapshot({ manifest, state });
  const text = formatCoreV1Results(snapshot);

  assert.match(text, /PM: DISPATCH/);
  assert.match(text, /WORKER: codex/);
  assert.match(text, /QA: codex \/ ACCEPT/);
  assert.match(text, /NEXT: T2/);
  assert.match(text, /BLOCKERS: example/);
});
