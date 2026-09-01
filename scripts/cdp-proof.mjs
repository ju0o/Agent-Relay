/* Temporary CDP driver — real Electron UI proof of capture arm path. */
const CDP_BASE = 'http://127.0.0.1:9229';
const targets = await (await fetch(`${CDP_BASE}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
  console.error('NO PAGE TARGET');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const consoleLogs = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLogs.push(args);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable');

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    return { exception: r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails) };
  }
  return r.result?.value;
}

const out = {};

// 1) Bridge + initial strip + button state
out.bridge = await evalJs(`({ hasRelayApi: typeof window.relayApi !== 'undefined', callType: typeof (window.relayApi && window.relayApi.call) })`);
out.stripBefore = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);
out.buttonBefore = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); return b?{text:b.textContent.trim(),disabled:b.disabled}:'(not found)'; })()`);

// 2) Open run #01 in the active tab
await evalJs(`(() => { const row=[...document.querySelectorAll('.tree-run-btn')].find(x=>x.textContent.includes('#01')); if(row){row.click(); return 'clicked '+(row.textContent||'').trim();} return 'no run row'; })()`);
await sleep(800);
out.afterOpen = await evalJs(`({ strip: document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)', button: (()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신'));return b?{text:b.textContent.trim(),disabled:b.disabled}:'(nf)';})() })`);

// 3) Click the capture button (OpenCode is default select)
out.clickResult = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); if(!b) return 'button not found'; if(b.disabled) return 'button DISABLED'; b.click(); return 'clicked'; })()`);
await sleep(3500);

// 4) Post-click strip + button
out.stripAfter = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);
out.buttonAfter = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('자동수신')||x.textContent.includes('수신 해제')); return b?b.textContent.trim():'(nf)'; })()`);

console.log('=== RESULT ===');
console.log(JSON.stringify(out, null, 2));
console.log('=== RENDERER CONSOLE (ARL-DEBUG) ===');
for (const l of consoleLogs) if (l.includes('ARL-DEBUG') || l.includes('세션')) console.log(l.slice(0, 300));

ws.close();
process.exit(0);