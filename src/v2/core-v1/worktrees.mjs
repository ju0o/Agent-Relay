"use strict";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

function exec(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ code, signal, stdout, stderr, pid: child.pid });
        return;
      }
      reject(
        Object.assign(
          new Error(stderr.trim() || `${command} exit ${code}`),
          { code, signal, stdout, stderr, pid: child.pid },
        ),
      );
    });
  });
}

async function revParse(repo, ref) {
  try {
    return (await exec("git", ["-C", repo, "rev-parse", ref])).stdout.trim();
  } catch {
    return null;
  }
}

export function managedRefFor(projectId) {
  return `refs/heads/agent-relay/core-v1/${projectId}`;
}

async function sourceBase(project) {
  let base = await revParse(project.path, project.ref || "HEAD");
  if (!base && project.ref) {
    base = await revParse(project.path, `refs/remotes/origin/${project.ref}`);
  }
  return base;
}

export async function promoteAcceptedCommit(project, commitSha) {
  if (!project?.path || !existsSync(project.path)) {
    throw new Error(`target unavailable: ${project?.id || "unknown"}`);
  }

  const managedRef = managedRefFor(project.id);
  await exec("git", ["-C", project.path, "cat-file", "-e", `${commitSha}^{commit}`]);

  const current = await revParse(project.path, managedRef);
  const base = current || (await sourceBase(project));
  if (!base) throw new Error(`cannot resolve promotion base for ${project.id}`);

  await exec("git", ["-C", project.path, "merge-base", "--is-ancestor", base, commitSha]);

  if (current) {
    await exec("git", ["-C", project.path, "update-ref", managedRef, commitSha, current]);
  } else {
    await exec("git", ["-C", project.path, "update-ref", managedRef, commitSha]);
  }

  return { ref: managedRef, base, commitSha };
}

export class CoreV1WorktreeManager {
  constructor(root) {
    this.root = root;
  }

  async create(project, taskId) {
    if (!project?.path || !existsSync(project.path)) {
      throw new Error(`target unavailable: ${project?.id || "unknown"}`);
    }

    if (project.repository) {
      const remote = (await exec("git", ["-C", project.path, "remote", "get-url", "origin"]))
        .stdout
        .trim()
        .replace(/\.git$/, "");
      if (remote !== project.repository.replace(/\.git$/, "")) {
        throw new Error(`target repository mismatch: ${project.id}`);
      }
    }

    const managedRef = managedRefFor(project.id);
    const existingManagedHead = await revParse(project.path, managedRef);
    const base = existingManagedHead || (await sourceBase(project));

    if (!base) throw new Error(`cannot resolve base for ${project.id}`);

    if (project.expectedHeadSha && !existingManagedHead && base !== project.expectedHeadSha) {
      throw new Error(`target SHA mismatch: ${project.id}`);
    }

    const name = `${project.id}-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
    const path = join(this.root, name);
    await mkdir(this.root, { recursive: true });
    await exec("git", ["-C", project.path, "worktree", "add", "--detach", path, base]);

    return {
      path,
      base,
      projectId: project.id,
      managedRef,
      async cleanup() {
        await exec("git", ["-C", project.path, "worktree", "remove", "--force", path]).catch(() => {});
        await rm(path, { recursive: true, force: true });
      },
    };
  }
}
