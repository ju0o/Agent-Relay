/* Temporary CDP driver — prove the SILENT NO-OP: clicking the disabled capture
   button (no saved run folder) produces NO toast, NO log, NO state change. */
const CDP_BASE = 'http://127.0.0.1:9229';
const targets = await (await fetch(`${CDP_BASE}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) { console.error('NO PAGE TARGET'); process.exit(2); }
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
  return r.exceptionDetails ? { exception: r.exceptionDetails.exception?.description ?? '?' } : r.result?.value;
}

// Reload to get a fresh tab (no saved run folder)
await send('Page.reload', { ignoreCache: true });
await sleep(3500);

const out = {};
out.stripBefore = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);
out.button = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); return b?{disabled:b.disabled, text:b.textContent.trim()}:'(nf)'; })()`);
out.flashBefore = await evalJs(`document.querySelector('.flash')?.innerText ?? '(none)'`);

// Force a click programmatically (same as a real user click; disabled buttons don't fire)
out.clickAttempt = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); if(!b) return 'btn nf'; b.click(); return 'click() dispatched on disabled='+b.disabled; })()`);
await sleep(1500);

out.flashAfter = await evalJs(`document.querySelector('.flash')?.innerText ?? '(none)'`);
out.stripAfter = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);

const armLogged = consoleLogs.some((l) => l.includes('armAutoCapture ENTER'));
out.armAutoCaptureEntered = armLogged;

console.log('=== SILENT NO-OP PROOF ===');
console.log(JSON.stringify(out, null, 2));
console.log('=== RENDERER LOGS (tail) ===');
for (const l of consoleLogs) if (l.includes('ARL-DEBUG') || l.includes('세션')) console.log(l.slice(0, 200));
ws.close();
process.exit(0);