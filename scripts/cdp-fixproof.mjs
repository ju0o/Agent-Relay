/* Temporary CDP driver — prove the FIX: clicking capture button with no saved
   run folder now shows a visible error toast (never a silent no-op). */
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

// Fresh state (no saved run folder)
await send('Page.reload', { ignoreCache: true });
await sleep(3500);

const out = {};
out.button = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); return b?{disabled:b.disabled,text:b.textContent.trim()}:'(nf)'; })()`);
out.stripBefore = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);

// Click the (now enabled) button with no folder
out.click = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); if(!b) return 'nf'; b.click(); return 'clicked disabled='+b.disabled; })()`);
await sleep(1200);

out.flashAfter = await evalJs(`document.querySelector('.flash')?.innerText ?? '(none)'`);
out.flashKind = await evalJs(`document.querySelector('.flash')?.className ?? ''`);
const armEnter = consoleLogs.filter((l) => l.includes('armAutoCapture ENTER'));
out.armAutoCaptureEntered = armEnter.length > 0;
out.lastArmLog = armEnter[armEnter.length - 1] ?? '(none)';

console.log('=== FIX PROOF (no-folder click) ===');
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);