"use strict";

import { createServer } from "node:http";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

const html = (value) => String(value ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
const fields = (text) => Object.fromEntries([...text.matchAll(/^([A-Z_]+):\s*(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const section = (text, title) => { const start = text.indexOf(`## ${title}`); if (start < 0) return ""; const body = text.slice(start).replace(/^## [^\n]*\n?/, ""); const end = body.indexOf("\n## "); return (end < 0 ? body : body.slice(0, end)).trim(); };
const bullets = (text) => text.split(/\r?\n/).map((x) => x.replace(/^[-*]\s*/, "").trim()).filter(Boolean);

function checklist(gate) {
  if (gate.type !== "FOUNDER_E2E_REQUIRED") return [];
  if (gate.project.toLowerCase() === "juactl" || gate.taskId.toLowerCase() === "juactl") return [
    { key: "sendSuccess", label: "SEND 성공?", type: "boolean" },
    { key: "resultCorrect", label: "RESULT가 보이고 정확한가?", type: "boolean" },
    { key: "copyCorrect", label: "COPY RESULT가 정확한가?", type: "boolean" },
    { key: "uxProblems", label: "UX 문제", type: "text" },
    { key: "founderNote", label: "Founder note", type: "textarea" },
  ];
  return [{ key: "founderNote", label: "Founder note", type: "textarea" }];
}

export function parseFounderPacket(text, filePath) {
  const f = fields(text); const evidence = bullets(section(text, "이미 Agent가 확인한 것")); const related = bullets(section(text, "관련 증거"));
  return {
    gateId: f.GATE_ID, project: f.PROJECT, type: f.TYPE, status: f.STATUS || "BLOCKED_FOR_FOUNDER", createdAt: f.CREATED_AT, taskId: f.TASK_ID, runId: f.RUN_ID,
    summary: section(text, "지금 어디까지 됐나"), reason: section(text, "왜 사람 확인이 필요한가"), founderAction: section(text, "Founder가 해야 할 것"),
    resumeAction: section(text, "결정 후 자동으로 할 일"), evidence, relatedEvidence: related, filePath, checklist: checklist({ type: f.TYPE, project: f.PROJECT, taskId: f.TASK_ID || "" }),
    raw: { repository: related.join(" ").match(/https?:\/\/\S+/)?.[0] || "", ref: related.join(" ").match(/ref=(\S+)/)?.[1] || "", sha: related.join(" ").match(/(?:sha=)?([0-9a-f]{40})\b/i)?.[1] || "" },
  };
}

export class FounderGateUiServer {
  constructor({ localInbox, bridge, port = 3847 } = {}) { this.localInbox = localInbox; this.bridge = bridge; this.port = port; this.server = null; }

  async _gates() {
    const gates = []; let projects = [];
    try { projects = await readdir(this.localInbox, { withFileTypes: true }); } catch { return gates; }
    for (const project of projects.filter((x) => x.isDirectory() && !x.name.startsWith("."))) {
      let files; try { files = await readdir(join(this.localInbox, project.name)); } catch { continue; }
      for (const file of files.filter((x) => x.endsWith(".md"))) {
        try {
          const path = join(this.localInbox, project.name, file); const gate = parseFounderPacket(await readFile(path, "utf8"), path);
          if (gate.gateId) {
            try { const response = JSON.parse(await readFile(join(this.localInbox, project.name, `${gate.gateId}.response.json`), "utf8")); if (await readFile(join(this.localInbox, project.name, `${gate.gateId}.response.json.uploaded`), "utf8").catch(() => null)) gate.status = response.DECISION === "REJECT" ? "REJECTED" : "SUBMITTED"; } catch { /* open gate */ }
            gates.push(gate);
          }
        } catch { /* incomplete packet is not shown */ }
      }
    }
    return gates;
  }

  async _gate(id) { return (await this._gates()).find((gate) => gate.gateId === id) || null; }

  async _respond(id, payload) {
    const gate = await this._gate(id); if (!gate) throw new Error("gate not found");
    if (payload.gateId !== id || !["APPROVE", "REQUEST_CHANGES", "PAUSE"].includes(payload.decision)) throw new Error("invalid gate response");
    const answers = { ...(payload.answers || {}) };
    const allowed = new Set(gate.checklist.map((item) => item.key)); if (gate.type === "SECRET_REQUIRED") allowed.add("secret");
    if (Object.keys(answers).some((key) => !allowed.has(key))) throw new Error("gate evidence fields are read-only");
    if (gate.type === "SECRET_REQUIRED" && answers.secret) { answers.secretProvided = true; delete answers.secret; }
    const response = { GATE_ID: id, DECISION: payload.decision, timestamp: new Date().toISOString(), answers, founderNote: String(payload.founderNote || "") };
    const responsePath = join(join(this.localInbox, basename(join(this.localInbox, gate.filePath.split(/[\\/]/).slice(-2, -1)[0]))), `${id}.response.json`);
    await writeFile(responsePath, JSON.stringify(response, null, 2), { encoding: "utf8", flag: "wx" }).catch(async (error) => { if (error.code !== "EEXIST") throw error; throw new Error("gate response already submitted"); });
    try { const uploaded = await this.bridge.uploadResponses(); return { state: uploaded.some((x) => x.gateId === id) ? (payload.decision === "REJECT" ? "REJECTED" : "SUBMITTED") : "DELIVERY_PENDING", gateId: id }; }
    catch { return { state: "DELIVERY_PENDING", gateId: id }; }
  }

  _page() {
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Founder Gate</title><style>
body{font-family:system-ui,sans-serif;background:#10151c;color:#eef2f7;margin:0}main{max-width:1100px;margin:0 auto;padding:28px}a,button{cursor:pointer}button{border:0;border-radius:7px;padding:10px 15px;font-weight:700}.open{background:#4ea1ff;color:#08111d}.approve{background:#55d187}.changes{background:#f5bd4f}.pause{background:#9aa7b8}.card{background:#19232f;border:1px solid #344556;border-radius:10px;padding:18px;margin:12px 0}.muted{color:#aebdcb}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#304358;font-size:12px}label{display:block;margin:14px 0}input,textarea,select{display:block;width:100%;box-sizing:border-box;margin-top:6px;background:#0d1218;color:#fff;border:1px solid #506276;border-radius:6px;padding:10px}details{margin-top:18px}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}.danger{color:#ffca8a}</style></head><body><main><div id="app">불러오는 중…</div></main><script>
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
const get=async p=>{const r=await fetch(p);if(!r.ok)throw Error(await r.text());return r.json()};
function home(gates){const projects=[...new Set(gates.map(g=>g.project))].join(', ')||'없음';document.getElementById('app').innerHTML='<h1>Founder Gate</h1><p class="muted">활성 프로젝트: '+esc(projects)+' · Founder gates: '+gates.length+'</p><p class="muted">Founder 확인이 필요한 작업만 표시됩니다. 기술 정보는 접혀 있습니다.</p><div class="grid">'+gates.map(g=>'<article class="card"><span class="pill">'+esc(g.type)+'</span><h2>'+esc(g.project)+'</h2><p>'+esc(g.summary)+'</p><p class="muted">'+esc(g.createdAt)+' · '+esc(g.status)+'</p><button class="open" onclick="openGate(\''+encodeURIComponent(g.gateId)+'\')">OPEN</button></article>').join('')+'</div>'};
async function openGate(id){const g=await get('/api/gates/'+id);document.getElementById('app').innerHTML='<p><a href="#" onclick="load()">← 목록</a></p><h1>'+esc(g.project)+'</h1><span class="pill">'+esc(g.type)+'</span><p class="muted">현재 상태: '+esc(g.status)+' · 생성: '+esc(g.createdAt)+'</p><section class="card"><h2>어디까지 됐나</h2><p>'+esc(g.summary)+'</p><h2>왜 확인이 필요한가</h2><p>'+esc(g.reason)+'</p><h2>이미 확인된 것</h2><ul>'+g.evidence.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul><h2>결정 후 자동 작업</h2><p>'+esc(g.resumeAction)+'</p><details><summary>기술 정보</summary><p>'+esc(g.raw.repository)+'</p><p>'+esc(g.raw.ref)+'</p><p>'+esc(g.raw.sha)+'</p><ul>'+g.relatedEvidence.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul></details></section><section class="card"><h2>Founder 결정</h2><form onsubmit="submitGate(event,\''+encodeURIComponent(g.gateId)+'\')"><div>'+g.checklist.map(q=>q.type==='boolean'?'<label>'+esc(q.label)+'<select name="'+esc(q.key)+'"><option value="">선택</option><option value="true">예</option><option value="false">아니오</option></select></label>':'<label>'+esc(q.label)+(q.type==='textarea'?'<textarea name="'+esc(q.key)+'" rows="3"></textarea>':'<input name="'+esc(q.key)+'" '+(g.type==='SECRET_REQUIRED'?'type="password"':'')+' required>')+'</label>').join('')+'</div><label>결정<select name="decision" required><option value="">선택</option><option>APPROVE</option><option>REQUEST_CHANGES</option><option>PAUSE</option></select></label><label>Founder note<textarea name="founderNote" rows="4"></textarea></label><div class="actions"><button class="approve">SUBMIT</button></div><p class="muted">제출 후 상태는 실제 업로드 결과만 표시됩니다.</p></form></section>'};
async function submitGate(e,id){e.preventDefault();const f=new FormData(e.target),answers={};for(const [k,v] of f)if(!['decision','founderNote'].includes(k))answers[k]=v;const r=await fetch('/api/gates/'+id+'/respond',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({gateId:decodeURIComponent(id),decision:f.get('decision'),founderNote:f.get('founderNote'),answers})});const x=await r.json();document.getElementById('app').innerHTML='<h1>'+esc(x.state)+'</h1><p>'+esc(x.state==='DELIVERY_PENDING'?'전송이 완료되지 않았습니다. Bridge가 다음 주기에 재시도합니다.':'응답이 Bridge에 전달되었습니다. ASUS Agent Relay의 lane 재개는 확인 전까지 주장하지 않습니다.')+'</p><button class="open" onclick="load()">목록</button>'};
async function load(){try{home(await get('/api/gates'))}catch(e){document.getElementById('app').textContent='Bridge Inbox을 읽을 수 없습니다: '+e}}load();
</script></body></html>`;
  }

  async start() {
    this.server = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(this._page()); return; }
        if (req.method === "GET" && req.url === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
        if (req.method === "GET" && req.url === "/api/gates") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(await this._gates())); return; }
        const match = req.url.match(/^\/api\/gates\/([^/]+)(\/respond)?$/);
        if (match && req.method === "GET") { const gate = await this._gate(decodeURIComponent(match[1])); if (!gate) throw Object.assign(new Error("not found"), { code: 404 }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(gate)); return; }
        if (match && match[2] && req.method === "POST") { let body = ""; for await (const chunk of req) body += chunk; const result = await this._respond(decodeURIComponent(match[1]), JSON.parse(body)); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); return; }
        res.writeHead(404); res.end("not found");
      } catch (error) { res.writeHead(error.code === 404 ? 404 : 400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.port, "127.0.0.1", resolve); });
    return this.server.address().port;
  }
  async stop() { await new Promise((resolve) => this.server?.close(resolve)); }
}
