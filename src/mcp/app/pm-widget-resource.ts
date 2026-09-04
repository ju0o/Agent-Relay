/**
 * V1-G6-MCP — Agent Relay PM widget resource.
 *
 * Production-shaped MCP App widget (based on the live-proven spike, not a
 * wholesale copy). Responsibilities ONLY:
 *   1. initialize via the current MCP Apps protocol
 *   2. poll a lightweight pending-delivery tool (relay_pm_list_pending_deliveries)
 *   3. detect one actionable PM Delivery
 *   4. maintain local in-widget dedupe for the mounted session
 *   5. claim the durable wake (relay_pm_claim_wake) and fire ui/message with
 *      the bounded AGENT_RELAY_PM_WAKE instruction
 *   6. show simple status
 *
 * No business logic lives in the widget. No Result text is fetched or shown.
 * The HTML is embedded so the compiled dist needs no asset-copy step.
 */

export const PM_WIDGET_RESOURCE_URI = 'ui://agent-relay/pm-widget';
export const PM_WIDGET_RESOURCE_NAME = 'Agent Relay PM';
export const PM_WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';
export const PM_WIDGET_RESOURCE_VERSION = '2026-01-26';

export function pmWidgetHtml(): string {
  return WIDGET_HTML;
}

const WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<title>Agent Relay PM</title>
<style>
  :root {
    --bg:#ffffff; --panel:#f5f5f5; --text:#1a1a1a; --muted:#555555; --border:#d0d0d0;
    --ok:#0a7d33; --err:#b42318; --mut:#7a5af8; --wait:#8a6d00;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121212; --panel:#1e1e1e; --text:#e8e8e8; --muted:#9a9a9a; --border:#3a3a3a; }
  }
  body[data-theme="dark"] { --bg:#121212; --panel:#1e1e1e; --text:#e8e8e8; --muted:#9a9a9a; --border:#3a3a3a; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin:0; padding:14px; font-size:14px;
         background: var(--bg); color: var(--text); }
  .card { border:1px solid var(--border); border-radius:10px; padding:14px; }
  .title { font-size:15px; font-weight:700; margin:0 0 10px; }
  .statusline { display:flex; align-items:center; gap:8px; margin:4px 0 10px; font-weight:600; }
  .dot { width:10px; height:10px; border-radius:50%; flex:none; }
  .dot.connected{background:var(--ok);} .dot.waiting{background:var(--wait);} .dot.ready{background:var(--ok);}
  .dot.fail{background:var(--err);} .dot.sent{background:var(--mut);}
  .state { font-size:14px; }
  .sub { color: var(--muted); font-size:12px; }
  details { margin-top:10px; }
  summary { cursor:pointer; color:var(--muted); font-size:12px; user-select:none; }
  #log { margin:6px 0 0; padding:8px; border:1px solid var(--border); border-radius:6px;
         background: var(--panel); color: var(--text); max-height:150px; overflow:auto;
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px;
         white-space:pre-wrap; word-break:break-word; }
  #log .t { color: var(--muted); }
</style>
</head>
<body>
  <div class="card">
    <div class="title">Agent Relay</div>
    <div class="statusline"><span class="dot waiting" id="dot"></span><span class="state" id="status">Connecting…</span></div>
    <div class="sub" id="sub"></div>
    <details>
      <summary>debug log</summary>
      <div id="log"></div>
    </details>
  </div>
  <script>
    (function () {
      'use strict';
      var dotEl = document.getElementById('dot');
      var statusEl = document.getElementById('status');
      var subEl = document.getElementById('sub');
      var logEl = document.getElementById('log');
      var sessionHandled = {};
      var claiming = false;
      var POLL_MS = 1500;

      function setStatus(kind, text, sub) {
        dotEl.className = 'dot ' + kind;
        statusEl.textContent = text;
        subEl.textContent = sub || '';
      }
      function logLine(text) {
        var d = document.createElement('div');
        var t = document.createElement('span');
        t.className = 't';
        t.textContent = '[' + new Date().toISOString().slice(11, 19) + '] ';
        d.appendChild(t);
        d.appendChild(document.createTextNode(text));
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
      }

      // ---- minimal JSON-RPC over postMessage (MCP Apps bridge) ----
      var nextId = 1;
      function sendRequest(method, params, timeoutMs) {
        var id = nextId++;
        return new Promise(function (resolve, reject) {
          var done = false;
          var to = setTimeout(function () {
            if (!done) { done = true; cleanup(); reject(new Error('timeout waiting for ' + method)); }
          }, timeoutMs || 15000);
          function listener(ev) {
            var d = ev.data;
            if (!d || d.id !== id) return;
            cleanup();
            if (d.result) resolve(d.result);
            else reject(new Error((d.error && d.error.message) || ('error ' + method)));
          }
          function cleanup() { clearTimeout(to); window.removeEventListener('message', listener); }
          window.addEventListener('message', listener);
        });
      }
      function sendNotification(method, params) {
        window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params }, '*');
      }

      function applyTheme(theme) {
        if (theme === 'dark' || theme === 'light') document.body.setAttribute('data-theme', theme);
      }

      // tools/call proxied by the host. Structured result preferred.
      async function callTool(name, args) {
        var r = await sendRequest('tools/call', { name: name, arguments: args || {} }, 15000);
        if (r && r.isError) {
          var txt = (r.content && r.content[0] && r.content[0].text) || '';
          throw new Error('tool ' + name + ' error: ' + txt);
        }
        if (r && r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent;
        if (r && r.content && r.content[0] && typeof r.content[0].text === 'string') {
          try { return JSON.parse(r.content[0].text); } catch (e) { return r.content[0].text; }
        }
        return r || {};
      }

      async function poll() {
        try {
          var list = await callTool('relay_pm_list_pending_deliveries', {});
          var deliveries = (list && list.deliveries) || [];
          if (deliveries.length === 0) {
            setStatus('waiting', 'Connected', 'Waiting for Agent result…');
            return;
          }
          for (var i = 0; i < deliveries.length; i++) {
            var d = deliveries[i];
            if (!d || !d.deliveryId) continue;
            if (sessionHandled[d.deliveryId]) continue;
            if (claiming) continue;
            claiming = true;
            try { await handleDelivery(d); }
            catch (e) { logLine('handle delivery error: ' + e.message); }
            finally { claiming = false; }
          }
        } catch (e) {
          setStatus('waiting', 'Connected', 'Waiting for Agent result…');
          logLine('poll error: ' + e.message);
        }
      }

      async function handleDelivery(delivery) {
        sessionHandled[delivery.deliveryId] = true;
        setStatus('ready', 'PM review ready', delivery.taskId ? 'TASK-' + delivery.taskId.replace(/^TASK-/, '') : delivery.deliveryId);
        logLine('delivery actionable: ' + delivery.deliveryId + ' task=' + delivery.taskId);
        var claim;
        try {
          claim = await callTool('relay_pm_claim_wake', { deliveryId: delivery.deliveryId });
        } catch (e) {
          logLine('claim failed: ' + e.message);
          return;
        }
        if (!claim || claim.claimable !== true) {
          logLine('not claimable: ' + (claim && claim.reason));
          return;
        }
        var instruction = claim.instruction;
        if (!instruction) { logLine('claim returned no instruction'); return; }
        setStatus('sent', 'Waking GPT…', delivery.deliveryId);
        logLine('wake claimed (attempt ' + claim.record.attemptCount + '). firing ui/message.');
        try {
          var r = await sendRequest('ui/message', {
            role: 'user',
            content: [ { type: 'text', text: instruction } ]
          }, 20000);
          logLine('ui/message accepted: ' + JSON.stringify(r));
          setStatus('sent', 'PM review ready', 'Wake sent — GPT notified');
        } catch (e) {
          logLine('ui/message error: ' + e.message);
          setStatus('fail', 'Wake failed', delivery.deliveryId);
          try {
            var f = await callTool('relay_pm_mark_wake_failed', { deliveryId: delivery.deliveryId, reason: e.message.slice(0, 300) });
            logLine('wake marked FAILED for retry: ' + (f && f.status));
          } catch (e2) { logLine('mark failed error: ' + e2.message); }
          sessionHandled[delivery.deliveryId] = false; // allow bounded retry next poll
        }
      }

      async function init() {
        try {
          var res = await sendRequest('ui/initialize', {
            protocolVersion: '2026-01-26',
            appInfo: { name: 'agent-relay-pm', version: '1.0.0' },
            appCapabilities: {}
          }, 15000);
          applyTheme(res.hostContext && res.hostContext.theme);
          sendNotification('ui/notifications/initialized', {});
          logLine('initialized');
          setStatus('waiting', 'Connected', 'Waiting for Agent result…');
          setInterval(poll, POLL_MS);
          poll();
        } catch (e) {
          setStatus('fail', 'Initialization failed', e.message);
          logLine('initialize FAILED: ' + e.message);
        }
      }

      window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d) return;
        if (d.method === 'ui/resource-teardown') {
          logLine('view torn down: ' + ((d.params && d.params.reason) || ''));
          if (d.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: d.id, result: {} }, '*');
        }
      });

      init();
    })();
  </script>
</body>
</html>
`;