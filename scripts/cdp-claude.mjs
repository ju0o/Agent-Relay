/* Temporary CDP driver — real Electron proof: Claude Code capture arm path. */
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
const out = {};

// 1) Disarm if currently armed
await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('수신 해제')); if(b){b.click(); return 'disarmed';} return 'not armed'; })()`);
await sleep(1200);

// 2) Select claude-code in the agent dropdown (React-compatible change event)
out.select = await evalJs(`(() => {
  const s=[...document.querySelectorAll('select')].find(x=>[...x.options].some(o=>o.value==='claude-code'));
  if(!s) return 'select not found';
  const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
  setter.call(s,'claude-code');
  s.dispatchEvent(new Event('change',{bubbles:true}));
  return 'selected claude-code';
})()`);
await sleep(400);

// 3) Click the arm button
out.click = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('세션 연결·자동수신')); if(!b) return 'btn nf'; if(b.disabled) return 'btn DISABLED'; b.click(); return 'clicked'; })()`);
await sleep(4000);

out.stripAfter = await evalJs(`document.querySelector('.sess-bound-status')?.innerText ?? '(no strip)'`);
out.buttonAfter = await evalJs(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('수신 해제')||x.textContent.includes('세션 연결·자동수신')); return b?b.textContent.trim():'(nf)'; })()`);

console.log('=== CLAUDE RESULT ===');
console.log(JSON.stringify(out, null, 2));
console.log('=== RENDERER LOGS ===');
for (const l of consoleLogs) if (l.includes('ARL-DEBUG')) console.log(l.slice(0, 300));
ws.close();
process.exit(0);