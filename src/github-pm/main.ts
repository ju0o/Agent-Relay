import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getTask } from '../backend/goal-task.js';
import { listPendingPmDeliveries, getPmDelivery } from '../backend/pm-delivery.js';
import { getVerificationContextForDelivery } from '../backend/pm-verification-context.js';
import { listPmJudgments, submitPmJudgment } from '../backend/pm-judgment.js';
import { prepareRetryForJudgment } from '../backend/retry-preparation.js';
import { resolveCurrentAttemptRunId } from '../backend/goal-task-runtime.js';
import { listEvidenceForRun } from '../backend/evidence.js';

type Comment = { id: string; url: string; body: string };
type State = { packets: Record<string, any>; seen: string; applied: Record<string, string>; pendingReplies?: Record<string, string> };
type Transport = { listComments(since?: string): Comment[]; postComment(body: string): { id: string; url: string }; putPacket(packet: any): { id: string; url: string } };

const json = (v: unknown) => JSON.stringify(v);
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } };
const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(tmp, file); };
const parseArgs = (argv: string[]) => {
  const a: Record<string, any> = { project: [] };
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === '--project') a.project.push(argv[++i]); else if (k === '--once') a.once = true; else if (k === '--dry-run') a.dryRun = true; else if (k.startsWith('--')) { const name = k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); a[name] = argv[++i]; } }
  a.inbox ??= a.pr;
  if (!a.dataRoot || !a.stateFile || !a.auditDir || !a.inbox || !a.transport) throw new Error('required: --dataRoot --project --transport --pr --state-file --audit-dir');
  a.mode ??= 'both'; a.repoDir ??= process.env.AGENT_RELAY_PM_TRANSPORT_REPO; return a;
};
const endpoint = (inbox: string) => { const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(inbox); if (!m) throw new Error(`invalid --inbox: ${inbox}`); return { repo: m[1], pr: m[2] }; };

function git(dir: string, args: string[], input?: string): string { return execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function makeTransport(a: any): Transport {
  const ep = endpoint(a.inbox); const commentRoot = a.transportDir ?? path.join(a.repoDir ?? '.', '.comments'); const commentsDir = fs.existsSync(path.join(commentRoot, 'comments')) ? path.join(commentRoot, 'comments') : commentRoot;
  const dry = (cmd: string) => { console.log(cmd); return { id: 'DRY-RUN', url: '' }; };
  const listComments = (since = ''): Comment[] => {
    if (a.transport === 'local') { if (!fs.existsSync(commentsDir)) return []; return fs.readdirSync(commentsDir).sort().map(n => readJson<Comment>(path.join(commentsDir, n), { id: '', url: '', body: '' })).filter(c => Number(c.id) > Number(since)); }
    const out = execFileSync('gh', ['api', '--paginate', `repos/${ep.repo}/issues/${ep.pr}/comments`, '--jq', '.[]'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(x => JSON.parse(x)).filter((c: any) => Number(c.id) > Number(since)).map((c: any) => ({ id: String(c.id), url: c.html_url, body: c.body }));
  };
  const postComment = (body: string) => {
    if (a.dryRun) return dry(`gh api repos/${ep.repo}/issues/${ep.pr}/comments --method POST -f body=${JSON.stringify(body)}`);
    if (a.transport === 'local') { fs.mkdirSync(commentsDir, { recursive: true }); const ids = fs.readdirSync(commentsDir).map(Number).filter(Number.isFinite); const id = String((ids.length ? Math.max(...ids) : 0) + 1); const c = { id, url: `local://${id}`, body }; writeJson(path.join(commentsDir, id), c); return c; }
    const c = JSON.parse(execFileSync('gh', ['api', `repos/${ep.repo}/issues/${ep.pr}/comments`, '--method', 'POST', '-f', `body=${body}`], { encoding: 'utf8' })); return { id: String(c.id), url: c.html_url };
  };
  const putPacket = (packet: any) => {
    const rel = `pm-bridge/inbox/${packet.packet_id}.json`;
    if (a.dryRun) { console.log(`git -C ${a.repoDir} add ${rel}`); console.log(`git -C ${a.repoDir} commit -m ${JSON.stringify(`PM_PACKET ${packet.task_id} ${packet.packet_id}`)}`); console.log(`git -C ${a.repoDir} push origin HEAD:pm-transport-wake`); return { id: 'DRY-RUN', url: '' }; }
    fs.mkdirSync(path.join(a.repoDir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(a.repoDir, rel), JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
    git(a.repoDir, ['add', rel]); git(a.repoDir, ['-c', 'user.name=Agent Relay PM Bridge', '-c', 'user.email=agent-relay-pm-bridge@localhost', 'commit', '-m', `PM_PACKET ${packet.task_id} ${packet.packet_id}`]); git(a.repoDir, ['push', 'origin', 'HEAD:pm-transport-wake']); return { id: git(a.repoDir, ['rev-parse', 'HEAD']), url: '' };
  };
  return { listComments, postComment, putPacket };
}

function audit(a: any, item: any) { fs.mkdirSync(a.auditDir, { recursive: true }); fs.appendFileSync(path.join(a.auditDir, 'pm-bridge.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...item }) + '\n'); }
function packetFor(a: any, delivery: any) {
  const context = getVerificationContextForDelivery(a.dataRoot, delivery.project, delivery.deliveryId);
  const history = listPmJudgments(a.dataRoot, delivery.project).map(j => ({ judgmentId: j.judgmentId, deliveryId: j.deliveryId, decision: j.decision, status: j.status }));
  const canonical = { context };
  const contextHash = hash(json(canonical)); const packetId = hash(`${delivery.project}|${delivery.deliveryId}|${contextHash}`).slice(0, 16);
  const retry = context.task.executionState === 'RESULT_RECEIVED' && context.task.pmState === 'VERIFYING' && context.attempt.isCurrentAttempt;
  const task = getTask(a.dataRoot, delivery.project, delivery.taskId); const link = task.linkedRuns.find(r => r.runId === delivery.runId);
  return { schema_version: 'pm-packet.v1', packet_id: packetId, project: delivery.project, task_id: context.task.taskId, run_id: delivery.runId, delivery_id: delivery.deliveryId, ...(context.result.source !== 'missing' ? { result_id: hash(`${delivery.runId}|${context.result.source}|${context.result.text}`).slice(0, 16) } : {}), created_at: new Date().toISOString(), bounded_context_hash: contextHash, allowed_actions: retry ? ['ACCEPT', 'CHANGES', 'RETRY_SAME_TASK'] : ['ACCEPT', 'CHANGES'], canonical_state_summary: { task: context.task, delivery: context.delivery, attempt: context.attempt }, verification_context: context, judgment_history: history, evidence_refs: listEvidenceForRun(a.dataRoot, delivery.project, delivery.runId).map(e => e.evidenceId), retry_lineage: { attempt: link?.taskRunSequence ?? 0, source_run_id: delivery.runId } };
}
function packetBody(p: any) { return `@ju0o Agent Relay: ChatGPT 검토 필요 — ${p.task_id}\nPM_PACKET v1\n${JSON.stringify(p, null, 2)}`; }
function exportPackets(a: any, t: Transport, s: State) {
  for (const project of a.project) for (const d of listPendingPmDeliveries(a.dataRoot, project)) {
    const p = packetFor(a, d); const old = s.packets[d.deliveryId]; if (old?.context_hash === p.bounded_context_hash) continue;
    if (old && !a.dryRun) t.postComment(`PM_PACKET SUPERSEDED\npacket_id: ${old.packet_id}\nreason: bounded context changed while delivery remained pending`);
    const c = t.putPacket(p); s.packets[d.deliveryId] = { packet_id: p.packet_id, context_hash: p.bounded_context_hash, packet: p, commitId: c.id }; writeJson(a.stateFile, s);
  }
}

function parseJudgment(body: string): any | null {
  const lines = body.trim().split('\n'); const start = lines.indexOf('PM_JUDGMENT v1'); if (start < 0 || lines.length < start + 5) return null;
  const out: any = {}; for (const line of lines.slice(start + 1)) { const m = /^(packet_id|context_hash|decision|retry|reason): (.*)$/.exec(line); if (!m) return null; if (out[m[1]] !== undefined) return null; out[m[1]] = m[2]; }
  if (!/^[0-9a-f]{16}$/.test(out.packet_id) || !/^[0-9a-f]{64}$/.test(out.context_hash) || !['ACCEPT', 'CHANGES', 'OWNER_REQUIRED'].includes(out.decision) || !['NONE', 'SAME_TASK'].includes(out.retry) || typeof out.reason !== 'string' || out.reason.length > 1000 || out.reason.includes('\n')) return null; return out;
}
function checkSchema(p: any): boolean { return !!p && p.schema_version === 'pm-packet.v1' && /^[0-9a-f]{16}$/.test(p.packet_id) && typeof p.project === 'string' && /^TASK-\d+$/.test(p.task_id) && typeof p.run_id === 'string' && typeof p.delivery_id === 'string' && /^[0-9a-f]{64}$/.test(p.bounded_context_hash) && Array.isArray(p.allowed_actions) && p.verification_context && p.canonical_state_summary && Array.isArray(p.evidence_refs) && p.retry_lineage; }
function checkCurrentCanonical(a: any, p: any): any { return packetFor(a, getPmDelivery(a.dataRoot, p.project, p.delivery_id)); }
function checkHash(current: any, judgment: any): boolean { return current.bounded_context_hash === judgment.context_hash; }
function checkPendingDelivery(current: any): boolean { return current.verification_context.delivery.status === 'PENDING' || current.verification_context.delivery.status === 'DELIVERED'; }
function checkIds(current: any, packet: any): boolean { return current.project === packet.project && current.task_id === packet.task_id && current.run_id === packet.run_id && current.delivery_id === packet.delivery_id; }
function checkAllowed(current: any, judgment: any): boolean { return judgment.decision !== 'ACCEPT' || judgment.retry === 'NONE' ? current.allowed_actions.includes(judgment.decision) && (judgment.retry !== 'SAME_TASK' || current.allowed_actions.includes('RETRY_SAME_TASK')) : false; }
function stateSummary(a: any, p: any) { try { const d = getPmDelivery(a.dataRoot, p.project, p.delivery_id); const task = getTask(a.dataRoot, p.project, d.taskId); return { delivery: d, judgment: listPmJudgments(a.dataRoot, p.project).find(j => j.deliveryId === p.delivery_id), task: { executionState: task.executionState, pmState: task.pmState } }; } catch { return {}; } }
async function importJudgments(a: any, t: Transport, s: State) {
  for (const [packetId, body] of Object.entries(s.pendingReplies ?? {})) {
    if (!a.dryRun) t.postComment(body);
    delete s.pendingReplies![packetId]; writeJson(a.stateFile, s);
  }
  for (const c of t.listComments(s.seen)) { s.seen = c.id; const j = parseJudgment(c.body); if (!j) continue; const pEntry = Object.values(s.packets).find((x: any) => x.packet_id === j.packet_id) as any; let disposition = 'REJECTED_INVALID'; let p = pEntry?.packet; let result: any = {};
    if (p && a.project.includes(p.project) && checkSchema(p) && checkHash(p, j)) {
      try {
        const current = checkCurrentCanonical(a, p);
        const allowed = current.allowed_actions; const replay = s.applied[j.packet_id];
        if (replay) disposition = replay === json(j) ? 'REPLAY_IGNORED' : 'REJECTED_INVALID';
        else if (!checkHash(current, j)) disposition = 'REJECTED_STALE';
        else if (!checkPendingDelivery(current)) disposition = 'REJECTED_STALE';
        else if (!checkIds(current, p)) disposition = 'REJECTED_INVALID';
        else if (j.decision === 'OWNER_REQUIRED') disposition = 'OWNER_REQUIRED_RECORDED';
        else if (!checkAllowed(current, j)) disposition = 'REJECTED_INVALID';
        else {
          const input: any = { deliveryId: p.delivery_id, decision: j.decision, reason: j.reason };
          if (j.decision === 'CHANGES') input.retryInstruction = j.reason;
          await submitPmJudgment(a.dataRoot, p.project, input);
          if (j.decision === 'CHANGES' && j.retry === 'SAME_TASK') await prepareRetryForJudgment(a.dataRoot, p.project, p.delivery_id);
          result = stateSummary(a, p); disposition = 'APPLIED';
        }
      } catch { disposition = 'FAILED'; }
    }
    audit(a, { packet_id: j.packet_id, commentId: c.id, commentUrl: c.url, project: p?.project, taskId: p?.task_id, runId: p?.run_id, deliveryId: p?.delivery_id, resultId: p?.result_id, context_hash: j.context_hash, decision: j.decision, retry: j.retry, disposition, resultingState: result || stateSummary(a, p ?? {}) });
    if (p && !s.applied[j.packet_id] && disposition === 'APPLIED') { s.applied[j.packet_id] = json(j); const reply = `PM_IMPORT v1\npacket_id: ${j.packet_id}\ndisposition: ${disposition}\nresulting_state: ${JSON.stringify(result || stateSummary(a, p ?? {}))}`; s.pendingReplies ??= {}; s.pendingReplies[j.packet_id] = reply; writeJson(a.stateFile, s); if (process.env.PM_BRIDGE_FAULT_AFTER_WRITE === '1') throw new Error('fault hook after write'); if (!a.dryRun) t.postComment(reply); delete s.pendingReplies[j.packet_id]; }
    else if (!a.dryRun) t.postComment(`PM_IMPORT v1\npacket_id: ${j.packet_id}\ndisposition: ${disposition}\nresulting_state: ${JSON.stringify(result || stateSummary(a, p ?? {}))}`);
    writeJson(a.stateFile, s);
  }
}
async function run(a: any) { const t = makeTransport(a); const s = readJson<State>(a.stateFile, { packets: {}, seen: '', applied: {}, pendingReplies: {} }); if (a.mode !== 'import') exportPackets(a, t, s); if (a.mode !== 'export') await importJudgments(a, t, s); }
if (require.main === module) { try { const a = parseArgs(process.argv.slice(2)); if (a.pollMs && !a.once) setInterval(() => { run(a).catch(e => console.error(String(e))); }, Number(a.pollMs)); else run(a).catch(e => { console.error(String(e)); process.exitCode = 1; }); } catch (e) { console.error(String(e)); process.exitCode = 1; } }
