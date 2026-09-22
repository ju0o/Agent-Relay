"use strict";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safe = (value) => String(value).replace(/[^A-Za-z0-9._-]/g, "_");

export class FounderBridgeTransport {
  constructor({ alias = "asus", remoteRoot = "/home/skkse12/.local/share/AgentRelay/data", ssh = "ssh", scp = "scp" } = {}) {
    this.alias = alias; this.remoteRoot = remoteRoot; this.ssh = ssh; this.scp = scp;
  }
  async discover() {
    const { stdout } = await exec(this.ssh, [this.alias, "find", `${this.remoteRoot}/founder-outbox`, "-type", "f", "-path", "*/packets/*.md"]);
    return stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  async pull(remotePath, localPath) { await exec(this.scp, [`${this.alias}:${remotePath}`, localPath]); }
  async hash(remotePath) { const { stdout } = await exec(this.ssh, [this.alias, "sha256sum", remotePath]); return stdout.trim().split(/\s+/)[0]; }
  async push(localPath, remotePath) {
    await exec(this.ssh, [this.alias, "mkdir", "-p", dirname(remotePath)]);
    await exec(this.scp, [localPath, `${this.alias}:${remotePath}`]);
  }
}

export class FounderInboxBridge {
  constructor({ transport, localInbox, remoteRoot = "/home/skkse12/.local/share/AgentRelay/data", pollIntervalMs = 15_000, lockPath } = {}) {
    this.transport = transport || new FounderBridgeTransport({ remoteRoot });
    this.localInbox = localInbox;
    this.remoteRoot = remoteRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.lockPath = lockPath || join(localInbox, ".founder-bridge.lock");
    this.lock = null;
  }

  async acquireSingleInstance() {
    await mkdir(dirname(this.lockPath), { recursive: true });
    try { this.lock = await open(this.lockPath, "wx"); await this.lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return true; }
    catch { throw new Error("Founder Inbox Bridge already running"); }
  }
  async releaseSingleInstance() { await this.lock?.close().catch(() => {}); this.lock = null; await rm(this.lockPath, { force: true }); }

  _remoteProject(remotePath) {
    const parts = remotePath.split("/"); const index = parts.lastIndexOf("packets"); return parts[index - 1] || "unknown";
  }
  async _localProject(remoteProject) {
    try { const existing = await readdir(this.localInbox); return existing.find((name) => name.toLowerCase() === remoteProject.toLowerCase()) || remoteProject; }
    catch { return remoteProject; }
  }
  async _receipt(gateId, project, destination, contentHash) {
    return { GATE_ID: gateId, gateId, project, localDestination: destination, deliveredAt: new Date().toISOString(), contentHash };
  }
  async _writeTemp(path, bytes) { const temp = `${path}.bridge-${process.pid}.tmp`; await writeFile(temp, bytes); await rename(temp, path); }

  async syncOnce() {
    const results = []; const remotePackets = await this.transport.discover();
    for (const remotePath of remotePackets) {
      const remoteProject = this._remoteProject(remotePath); const project = await this._localProject(remoteProject);
      const remoteName = basename(remotePath);
      const localDir = join(this.localInbox, project); const localPath = join(localDir, remoteName);
      await mkdir(localDir, { recursive: true });
      let localBytes; try { localBytes = await readFile(localPath); } catch { localBytes = null; }
      const remoteHash = this.transport.hash ? await this.transport.hash(remotePath) : null;
      if (localBytes && remoteHash && sha256(localBytes) !== remoteHash) throw new Error(`local packet hash mismatch: ${localPath}`);
      if (!localBytes) { await this.transport.pull(remotePath, localPath); localBytes = await readFile(localPath); }
      const content = localBytes.toString("utf8"); const match = content.match(/^GATE_ID:\s*(\S+)\s*$/m); const packetProject = content.match(/^PROJECT:\s*(\S+)\s*$/m)?.[1];
      if (!match) throw new Error(`packet missing GATE_ID: ${remotePath}`);
      if (!packetProject || packetProject.toLowerCase() !== remoteProject.toLowerCase()) throw new Error(`packet project mismatch: ${remotePath}`);
      const contentHash = sha256(localBytes); const receipt = await this._receipt(match[1], project, localPath, contentHash);
      const receiptPath = join(localDir, `${match[1]}.delivery.json`); await this._writeTemp(receiptPath, JSON.stringify(receipt, null, 2));
      const remoteReceipt = `${this.remoteRoot}/founder-outbox/${remoteProject}/receipts/${match[1]}.json`;
      await this.transport.push(receiptPath, remoteReceipt);
      results.push({ gateId: match[1], project, localPath, contentHash, remoteReceipt, state: "DELIVERED" });
    }
    return results;
  }

  async uploadResponses() {
    const uploaded = [];
    for (const project of await readdir(this.localInbox)) {
      const directory = join(this.localInbox, project); let entries; try { entries = await readdir(directory); } catch { continue; }
      for (const name of entries.filter((x) => /^FG-[A-Za-z0-9_-]+\.response\.json$/.test(x))) {
        const path = join(directory, name); const response = JSON.parse(await readFile(path, "utf8"));
        const gateId = response.GATE_ID || response.gateId; const decision = response.DECISION || response.decision;
        if (!/^FG-[A-Za-z0-9_-]+$/.test(gateId || "") || !decision || !response.timestamp) throw new Error(`invalid Founder response: ${path}`);
        const packet = await readFile(join(directory, `${gateId}.md`), "utf8").catch(() => "");
        if (!packet.match(new RegExp(`^GATE_ID:\\s*${gateId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "m"))) throw new Error(`stale Founder response: ${path}`);
        const remoteProject = packet.match(/^PROJECT:\s*(\S+)\s*$/m)?.[1] || project;
        const remotePath = `${this.remoteRoot}/founder-outbox/${remoteProject}/responses/${gateId}.json`;
        await this.transport.push(path, remotePath); await writeFile(`${path}.uploaded`, new Date().toISOString());
        uploaded.push({ gateId, project, remotePath });
      }
    }
    return uploaded;
  }

  async once() { return { packets: await this.syncOnce(), responses: await this.uploadResponses() }; }
  async run({ signal } = {}) {
    await this.acquireSingleInstance();
    try { do { await this.once(); await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs)); } while (!signal?.aborted); }
    finally { await this.releaseSingleInstance(); }
  }
}
