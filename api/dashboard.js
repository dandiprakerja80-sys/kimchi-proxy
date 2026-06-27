

const { getSettings, setSettings } = require("./lib/settings.js");

function getSessionSecret() {
  return process.env.DASHBOARD_PASSWORD || "kimchi-proxy";
}

function verifyPassword(password) {
  return password === getSessionSecret();
}

function generateToken() {
  return Buffer.from(`session:${Date.now()}:${Math.random().toString(36)}`).toString("base64");
}

function checkAuth(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/dashboard_token=([^;]+)/);
  if (!match) return false;
  try {
    const decoded = Buffer.from(match[1], "base64").toString();
    return decoded.startsWith("session:");
  } catch {
    return false;
  }
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimchi Proxy — Login</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;font-family:system-ui,-apple-system,sans-serif}
  .card{background:#111118;border:1px solid #1e1e2e;border-radius:16px;padding:48px 40px;width:100%;max-width:400px;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
  h1{color:#f0f0f5;font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;letter-spacing:-.5px}
  p{color:#6b6b80;text-align:center;font-size:14px;margin-bottom:32px}
  .field{margin-bottom:20px}
  label{display:block;color:#9090a8;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  input{width:100%;padding:12px 16px;background:#1a1a25;border:1px solid #2a2a3a;border-radius:10px;color:#f0f0f5;font-size:15px;outline:none;transition:border .2s}
  input:focus{border-color:#ff6b35}
  button{width:100%;padding:14px;background:linear-gradient(135deg,#ff6b35,#ff4500);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;margin-top:8px}
  button:hover{opacity:.9}
  .error{color:#ff4545;font-size:13px;text-align:center;margin-top:16px;display:none}
  .logo{text-align:center;margin-bottom:24px;font-size:40px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">🌶️</div>
  <h1>Kimchi Proxy</h1>
  <p>Enter dashboard password</p>
  <form id="loginForm">
    <div class="field">
      <label>Password</label>
      <input type="password" id="password" placeholder="••••••••" autofocus>
    </div>
    <button type="submit">Sign In</button>
    <div class="error" id="error">Invalid password</div>
  </form>
</div>
<script>
document.getElementById('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const pw = document.getElementById('password').value;
  const res = await fetch('/api/dashboard', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({password: pw})
  });
  if (res.ok) {
    window.location.href = '/dashboard';
  } else {
    document.getElementById('error').style.display = 'block';
  }
};
</script>
</body>
</html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kimchi Proxy — Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0f;color:#f0f0f5;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;background:#0f0f16;border-bottom:1px solid #1a1a28}
  .topbar h1{font-size:18px;font-weight:700;display:flex;align-items:center;gap:10px}
  .topbar .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .topbar-right{display:flex;align-items:center;gap:20px}
  .cf-toggle{display:flex;align-items:center;gap:10px;background:#111118;border:1px solid #1e1e2e;border-radius:10px;padding:8px 14px}
  .cf-toggle span{font-size:12px;font-weight:600;color:#9090a8;text-transform:uppercase;letter-spacing:.5px}
  .cf-toggle button{padding:6px 14px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;min-width:70px}
  .cf-toggle button.on{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff}
  .cf-toggle button.off{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff}
  .cf-toggle button:hover{opacity:.85}
  .topbar-date{color:#9090a8;font-size:13px;font-weight:500;text-align:right;line-height:1.4}
  .topbar-date .day{color:#f0f0f5;font-weight:700;font-size:14px}
  .topbar a.signout{color:#6b6b80;text-decoration:none;font-size:13px;transition:color .2s}
  .topbar a.signout:hover{color:#ff6b35}
  .container{max-width:1200px;margin:0 auto;padding:32px}
  .range-tabs{display:flex;gap:8px;margin-bottom:24px}
  .range-tab{padding:8px 20px;border-radius:8px;border:1px solid #1e1e2e;background:#111118;color:#6b6b80;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s}
  .range-tab:hover{border-color:#ff6b35;color:#f0f0f5}
  .range-tab.active{background:linear-gradient(135deg,#ff6b35,#ff4500);border-color:transparent;color:#fff}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;margin-bottom:32px}
  .stat{background:#111118;border:1px solid #1e1e2e;border-radius:14px;padding:24px}
  .stat .label{color:#6b6b80;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  .stat .value{font-size:28px;font-weight:700;color:#f0f0f5;letter-spacing:-.5px}
  .stat .sub{color:#6b6b80;font-size:12px;margin-top:4px}
  .stat.accent .value{color:#ff6b35}
  .stat.danger .value{color:#ff4545}
  .stat.warn .value{color:#eab308}
  .stat.ok .value{color:#22c55e}
  .provider-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;margin-bottom:32px}
  .provider-card{background:#111118;border:1px solid #1e1e2e;border-radius:14px;padding:24px}
  .provider-card.kimchi{border-left:4px solid #ff6b35}
  .provider-card.cf{border-left:4px solid #f48120}
  .provider-card h3{font-size:16px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .provider-card.kimchi h3{color:#ff6b35}
  .provider-card.cf h3{color:#f48120}
  .provider-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
  .provider-metrics .pm .num{font-size:22px;font-weight:700;color:#f0f0f5}
  .provider-metrics .pm .lbl{color:#6b6b80;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
  .badge-kimchi{background:rgba(255,107,53,.15);color:#ff6b35}
  .badge-cf{background:rgba(244,129,32,.15);color:#f48120}
  .section{margin-bottom:32px}
  .section h2{font-size:16px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .section h2 .icon{font-size:18px}
  table{width:100%;border-collapse:collapse;background:#111118;border:1px solid #1e1e2e;border-radius:14px;overflow:hidden}
  th{text-align:left;padding:14px 20px;background:#16161f;color:#6b6b80;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px}
  td{padding:12px 20px;border-top:1px solid #1a1a28;font-size:14px;color:#c0c0d0}
  tr:hover td{background:#16161f}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
  .badge.ok{background:rgba(34,197,94,.15);color:#22c55e}
  .badge.err{background:rgba(255,69,69,.15);color:#ff4545}
  .badge.warn{background:rgba(234,179,8,.15);color:#eab308}
  .console{background:#0c0c14;border:1px solid #1e1e2e;border-radius:14px;overflow:hidden}
  .console-header{padding:12px 20px;background:#13131c;border-bottom:1px solid #1e1e2e;display:flex;align-items:center;justify-content:space-between}
  .console-header span{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#6b6b80}
  .console-body{padding:16px 20px;max-height:320px;overflow-y:auto;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;line-height:1.8}
  .log-entry{display:flex;gap:12px}
  .log-time{color:#4a4a5a;min-width:80px}
  .log-level{min-width:50px;font-weight:600}
  .log-level.info{color:#22c55e}
  .log-level.error{color:#ff4545}
  .log-msg{color:#a0a0b0}
  .key-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px}
  .key-card{background:#16161f;border:1px solid #1e1e2e;border-radius:12px;padding:20px;text-align:center}
  .key-card .num{font-size:32px;font-weight:700;margin-bottom:4px}
  .key-card .lbl{color:#6b6b80;font-size:11px;text-transform:uppercase;letter-spacing:1px}
  .key-card.kimchi .num{color:#ff6b35}
  .key-card.cf .num{color:#f48120}
  .table-wrap{max-height:320px;overflow-y:auto;border-radius:14px;border:1px solid #1e1e2e;background:#111118}
  .table-wrap table{border:none;border-radius:0}
  .table-wrap::-webkit-scrollbar{width:8px}
  .table-wrap::-webkit-scrollbar-track{background:#111118}
  .table-wrap::-webkit-scrollbar-thumb{background:#2a2a3a;border-radius:4px}
  .table-wrap::-webkit-scrollbar-thumb:hover{background:#3a3a4a}
  .err-table td.error-msg{max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
  @media(max-width:768px){.stats,.key-grid{grid-template-columns:repeat(2,1fr)}.container{padding:16px}}
</style>
</head>
<body>
<div class="topbar">
  <h1><span class="dot"></span> Kimchi Proxy</h1>
  <div class="topbar-right">
    <div class="cf-toggle">
      <span>CF (GLM 5.2)</span>
      <button id="cf-toggle-btn" class="on">ON</button>
    </div>
    <div class="topbar-date" id="clock"></div>
    <a class="signout" href="/api/dashboard?action=logout">Sign Out</a>
  </div>
</div>
<div class="container">
  <div class="range-tabs" id="range-tabs">
    <div class="range-tab active" data-range="today">Today</div>
    <div class="range-tab" data-range="week">This Week</div>
    <div class="range-tab" data-range="month">This Month</div>
    <div class="range-tab" data-range="all">All Time</div>
  </div>
  <div class="stats">
    <div class="stat"><div class="label">Total Requests</div><div class="value" id="s-req">—</div></div>
    <div class="stat"><div class="label">Input Tokens</div><div class="value" id="s-in">—</div></div>
    <div class="stat"><div class="label">Output Tokens</div><div class="value" id="s-out">—</div></div>
    <div class="stat accent"><div class="label">Est. Cost</div><div class="value" id="s-cost">—</div><div class="sub">based on Kimchi pricing</div></div>
  </div>

  <div class="provider-grid">
    <div class="provider-card kimchi">
      <h3>🌶️ Kimchi</h3>
      <div class="provider-metrics">
        <div class="pm"><div class="num" id="p-kimchi-req">—</div><div class="lbl">Requests</div></div>
        <div class="pm"><div class="num" id="p-kimchi-err">—</div><div class="lbl">Errors</div></div>
        <div class="pm"><div class="num" id="p-kimchi-in">—</div><div class="lbl">Input Tokens</div></div>
        <div class="pm"><div class="num" id="p-kimchi-out">—</div><div class="lbl">Output Tokens</div></div>
      </div>
    </div>
    <div class="provider-card cf">
      <h3>☁️ Cloudflare AI</h3>
      <div class="provider-metrics">
        <div class="pm"><div class="num" id="p-cf-req">—</div><div class="lbl">Requests</div></div>
        <div class="pm"><div class="num" id="p-cf-err">—</div><div class="lbl">Errors</div></div>
        <div class="pm"><div class="num" id="p-cf-in">—</div><div class="lbl">Input Tokens</div></div>
        <div class="pm"><div class="num" id="p-cf-out">—</div><div class="lbl">Output Tokens</div></div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2><span class="icon">🔑</span> API Keys</h2>
    <div class="key-grid">
      <div class="key-card kimchi"><div class="num" id="k-kimchi">—</div><div class="lbl">Kimchi Keys</div></div>
      <div class="key-card cf"><div class="num" id="k-cf">—</div><div class="lbl">Cloudflare Credentials</div></div>
    </div>
  </div>

  <div class="section">
    <h2><span class="icon">🔴</span> Errors</h2>
    <div class="table-wrap">
      <table class="err-table">
        <thead><tr><th>#</th><th>Req</th><th>Provider</th><th>Model</th><th>Key</th><th>Status</th><th>Error</th><th>When</th></tr></thead>
        <tbody id="err-body"><tr><td colspan="8" style="text-align:center;color:#4a4a5a">No errors yet</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <h2><span class="icon">📋</span> Recent Requests</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Provider</th><th>Model</th><th>In / Out</th><th>Key</th><th>Status</th><th>Finish</th><th>Time</th><th>When</th></tr></thead>
        <tbody id="req-body"><tr><td colspan="9" style="text-align:center;color:#4a4a5a">No requests yet</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="section">
    <h2><span class="icon">🖥️</span> Console</h2>
    <div class="console">
      <div class="console-header"><span>Logs</span><span id="log-count">0 entries</span></div>
      <div class="console-body" id="log-body"></div>
    </div>
  </div>
</div>
<script>
let currentRange='today';
function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString()}
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function time(ts){return new Date(ts).toLocaleTimeString()}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function updateClock(){
  const now=new Date();
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day=days[now.getDay()];
  const date=now.getDate();
  const month=months[now.getMonth()];
  const year=now.getFullYear();
  const time=now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true});
  document.getElementById('clock').innerHTML='<div class="day">'+day+'</div><div>'+date+' '+month+' '+year+' · '+time+'</div>';
}
updateClock();
setInterval(updateClock,1000);
document.getElementById('range-tabs').addEventListener('click',e=>{
  const tab=e.target.closest('.range-tab');
  if(!tab)return;
  document.querySelectorAll('.range-tab').forEach(t=>t.classList.remove('active'));
  tab.classList.add('active');
  currentRange=tab.dataset.range;
  load();
});
async function load(){
  try{
    const r=await fetch('/api/dashboard?action=stats&range='+currentRange);
    if(!r.ok){window.location.href='/dashboard';return}
    const d=await r.json();
    document.getElementById('s-req').textContent=fmt(d.totalRequests);
    document.getElementById('s-in').textContent=fmt(d.totalInputTokens);
    document.getElementById('s-out').textContent=fmt(d.totalOutputTokens);
    document.getElementById('s-cost').textContent='~$'+d.estimatedCost.toFixed(2);
    if(d.keys){
      document.getElementById('k-kimchi').textContent=d.keys.total;
    }
    if(d.cloudflare){
      document.getElementById('k-cf').textContent=d.cloudflare.credentials;
    }
    const kimchi=d.providers?.kimchi||{requests:0,inputTokens:0,outputTokens:0,errors:0};
    const cf=d.providers?.cf||{requests:0,inputTokens:0,outputTokens:0,errors:0};
    document.getElementById('p-kimchi-req').textContent=fmt(kimchi.requests);
    document.getElementById('p-kimchi-err').textContent=fmt(kimchi.errors);
    document.getElementById('p-kimchi-in').textContent=fmt(kimchi.inputTokens);
    document.getElementById('p-kimchi-out').textContent=fmt(kimchi.outputTokens);
    document.getElementById('p-cf-req').textContent=fmt(cf.requests);
    document.getElementById('p-cf-err').textContent=fmt(cf.errors);
    document.getElementById('p-cf-in').textContent=fmt(cf.inputTokens);
    document.getElementById('p-cf-out').textContent=fmt(cf.outputTokens);
    function providerBadge(p){const provider=p||'kimchi'; return '<span class="badge '+(provider==='cf'?'badge-cf':'badge-kimchi')+'">'+(provider==='cf'?'CF':'Kimchi')+'</span>';}
    const etbody=document.getElementById('err-body');
    if(!d.errors||d.errors.length===0){etbody.innerHTML='<tr><td colspan="8" style="text-align:center;color:#4a4a5a">No errors</td></tr>'}
    else{etbody.innerHTML=d.errors.map(e=>'<tr><td>'+e.id+'</td><td>#'+e.request_id+'</td><td>'+providerBadge(e.provider)+'</td><td><code>'+esc(e.model)+'</code></td><td>#'+e.keyIndex+'</td><td><span class="badge err">'+e.status+'</span></td><td class="error-msg" title="'+esc(e.error)+'">'+esc(e.error)+'</td><td>'+ago(e.timestamp)+'</td></tr>').join('')}
    const tbody=document.getElementById('req-body');
    if(d.recentRequests.length===0){tbody.innerHTML='<tr><td colspan="9" style="text-align:center;color:#4a4a5a">No requests yet</td></tr>';return}
    tbody.innerHTML=d.recentRequests.map(r=>'<tr><td>'+r.id+'</td><td>'+providerBadge(r.provider)+'</td><td><code>'+esc(r.model)+'</code></td><td>'+fmt(r.inputTokens)+' / '+fmt(r.outputTokens)+'</td><td>#'+r.keyIndex+'</td><td><span class="badge '+(r.status<400?'ok':'err')+'">'+r.status+'</span></td><td><code>'+esc(r.finishReason||'-')+'</code></td><td>'+r.elapsed+'ms</td><td>'+ago(r.timestamp)+'</td></tr>').join('');
    document.getElementById('log-count').textContent=d.logs.length+' entries';
    document.getElementById('log-body').innerHTML=d.logs.slice(0,100).map(l=>'<div class="log-entry"><span class="log-time">'+time(l.timestamp)+'</span><span class="log-level '+l.level+'">'+l.level.toUpperCase()+'</span><span class="log-msg">'+esc(l.message)+'</span></div>').join('');
  }catch(e){}
}
async function loadSettings(){
  try{
    const r=await fetch('/api/settings');
    if(!r.ok)return;
    const s=await r.json();
    const btn=document.getElementById('cf-toggle-btn');
    if(!btn)return;
    const enabled=s.cf_enabled!==false;
    btn.className=enabled?'on':'off';
    btn.textContent=enabled?'ON':'OFF';
  }catch(e){}
}
async function toggleCf(){
  try{
    const btn=document.getElementById('cf-toggle-btn');
    if(!btn)return;
    const currentOn=btn.classList.contains('on');
    btn.disabled=true;
    const r=await fetch('/api/settings',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cf_enabled:!currentOn})
    });
    btn.disabled=false;
    if(!r.ok)return;
    await loadSettings();
    load();
  }catch(e){}
}
document.getElementById('cf-toggle-btn').addEventListener('click',toggleCf);
loadSettings();
load();
setInterval(load,5000);
</script>
</body>
</html>`;

module.exports = async function handler(req, res) {
  if (req.method === "GET" && (req.url === "/dashboard" || req.url === "/api/dashboard" || req.url === "/api/dashboard?") && !req.url.includes("action=")) {
    if (!checkAuth(req)) {
      res.setHeader("Content-Type", "text/html");
      return res.status(200).end(LOGIN_HTML);
    }
    res.setHeader("Content-Type", "text/html");
    return res.status(200).end(DASHBOARD_HTML);
  }

  if (req.method === "POST" && req.url === "/api/dashboard") {
    let data = req.body;
    if (!data || typeof data !== "object") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    if (verifyPassword(data.password)) {
      const token = generateToken();
      res.setHeader("Set-Cookie", `dashboard_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      return res.status(200).json({ ok: true });
    }
    return res.status(401).json({ error: "Invalid password" });
  }

  if (req.method === "GET" && req.url === "/api/dashboard?action=logout") {
    res.setHeader("Set-Cookie", "dashboard_token=; Path=/; Max-Age=0");
    res.setHeader("Location", "/dashboard");
    return res.status(302).end();
  }

  if (req.url && req.url.startsWith("/api/dashboard?action=stats")) {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const url = new URL(req.url, "http://localhost");
    const range = url.searchParams.get("range") || "today";
    try {
      const statsUrl = `https://${req.headers.host}/api/v1/chat/completions?action=stats&range=${range}`;
      const statsRes = await fetch(statsUrl, {
        headers: {
          Cookie: req.headers.cookie || "",
          Authorization: `Bearer ${process.env.PROXY_API_KEY || "kimchi-proxy-free"}`,
        },
      });
      const stats = await statsRes.json();
      return res.status(200).json(stats);
    } catch (e) {
      return res.status(200).json({ totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0, estimatedCost: 0, totalErrors: 0, providers: {}, requests: [], errors: [], keys: { total: 55, active: 55, exhausted: 0, throttled: 0, errors: [] }, cloudflare: { credentials: 0 }, recentRequests: [] });
    }
  }

  if (req.method === "GET" && req.url === "/api/settings") {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const settings = await getSettings();
      return res.status(200).json(settings);
    } catch (e) {
      return res.status(500).json({ error: "Failed to load settings" });
    }
  }

  if (req.method === "POST" && req.url === "/api/settings") {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    let data = req.body;
    if (!data || typeof data !== "object") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }
    }
    try {
      const settings = await setSettings(data);
      return res.status(200).json(settings);
    } catch (e) {
      return res.status(500).json({ error: "Failed to save settings" });
    }
  }

  res.setHeader("Content-Type", "text/html");
  res.status(200).end(LOGIN_HTML);
};
