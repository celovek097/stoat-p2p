// Small HTML pages served by the node itself: a landing page when the web
// client has not been built, and the /node dashboard (peers, addresses).

import type { StoatNode } from "../node.ts";

const escape = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --fg:#1b1d21; --muted:#667; --accent:#6c5ce7; --line:#e3e5ea; }
@media (prefers-color-scheme: dark) { :root { --bg:#16171b; --card:#1f2126; --fg:#e8e9ec; --muted:#9aa; --line:#2c2f36; } }
* { box-sizing: border-box; }
body { margin:0; font: 15px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 0 0 12px; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
code, .mono { font-family: ui-monospace, monospace; font-size: 13px; word-break: break-all; }
table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
.pill { display:inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; background: var(--line); }
.ok { background: #2ecc7133; color: #27ae60; } .bad { background: #e74c3c33; color: #e74c3c; }
input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
button, .button { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer; text-decoration: none; display: inline-block; }
form { display: flex; gap: 8px; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function landingPage(node: StoatNode, origin: string): string {
  return layout(
    "stoat-p2p",
    `<h1>stoat-p2p node</h1>
<p class="muted">This node speaks the Stoat API, but the web client has not been built yet.</p>
<div class="card"><h2>Build the web client</h2>
<p>Run <code>npm run build:web</code> in the stoat-p2p directory, then restart the node. The official Stoat web client will be served here.</p>
<p>Any Stoat-compatible client can also use this node directly:</p>
<table><tr><td>API</td><td class="mono">${escape(origin)}/api</td></tr>
<tr><td>Events</td><td class="mono">${escape(origin.replace(/^http/, "ws"))}/events</td></tr>
<tr><td>Files</td><td class="mono">${escape(origin)}/autumn</td></tr></table></div>
<p><a class="button" href="/node">Node dashboard</a></p>
<p class="muted">Node ${escape(node.nodeId)}</p>`,
  );
}

export function dashboardPage(node: StoatNode, origin: string, local: boolean): string {
  const status = node.p2p.status();
  const peers = status.peers
    .map(
      (p) => `<tr><td class="mono">${escape(p.name || p.id.slice(0, 12))}<br><span class="muted">${escape(p.id.slice(0, 16))}…</span></td>
<td class="mono">${escape(p.url ?? "incoming")}</td><td><span class="pill ${p.connected ? "ok" : "bad"}">${p.connected ? "connected" : "offline"}</span>${p.relay ? ' <span class="pill">relay</span>' : ""}</td>
<td>${p.users} users · ${p.scopes} scopes</td></tr>`,
    )
    .join("");
  const addresses = [...status.announce, `${origin.replace(/^http/, "ws")}/p2p`];
  return layout(
    "stoat-p2p · node",
    `<h1>stoat-p2p node</h1><p class="muted">${escape(node.options.name)} · ${status.events} events · ${status.scopes} scopes · ${status.pending} waiting for dependencies</p>
<p><a class="button" href="/">Open Stoat</a></p>
<div class="card"><h2>Share this address with friends</h2>
<p class="muted">Other nodes connect to you with one of these addresses (the last one works only if it is reachable from their network).</p>
${addresses.map((a) => `<p class="mono">${escape(a)}</p>`).join("")}
<p class="muted">Node key: <span class="mono">${escape(node.nodeId)}</span></p></div>
<div class="card"><h2>Peers</h2>${peers ? `<table>${peers}</table>` : '<p class="muted">No peers yet.</p>'}
${
  local
    ? `<h2 style="margin-top:16px">Connect to a peer</h2><form onsubmit="event.preventDefault(); fetch('/node/api/peers',{method:'POST',body:JSON.stringify({url:this.url.value})}).then(()=>location.reload())">
<input name="url" placeholder="ws://friend.example.org:14702/p2p" required><button>Connect</button></form>`
    : '<p class="muted">Peers can be added from this machine only (localhost).</p>'
}</div>
<div class="card"><h2>Local users</h2>${
      node.accounts
        .list()
        .map((a) => {
          const p = node.world.profiles.get(a.id);
          return `<p><b>${escape(p?.display_name ?? p?.username ?? "(not onboarded)")}</b> <span class="mono muted">${escape(a.id)}</span></p>`;
        })
        .join("") || '<p class="muted">No accounts yet — create one in the Stoat client.</p>'
    }</div>`,
  );
}
