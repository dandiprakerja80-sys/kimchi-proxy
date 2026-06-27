const { getStats } = require("./lib/stats.js");
const { getCfStatus } = require("./lib/cloudflare.js");

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
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0c0f;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .card{background:#15171c;border:1px solid #2a2d35;border-radius:16px;padding:48px 40px;width:100%;max-width:400px;box-shadow:0 25px 50px -12px rgba(0,0,0,.5)}
  h1{color:#e7e8eb;font-size:24px;font-weight:700;text-align:center;margin-bottom:8px;letter-spacing:-.5px}
  p{color:#9ca3af;text-align:center;font-size:14px;margin-bottom:32px}
  .field{margin-bottom:20px}
  label{display:block;color:#9ca3af;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  input{width:100%;padding:12px 16px;background:#1a1d23;border:1px solid #2a2d35;border-radius:10px;color:#e7e8eb;font-size:15px;outline:none;transition:border .2s}
  input:focus{border-color:#f97316}
  button{width:100%;padding:14px;background:linear-gradient(135deg,#f97316,#fb923c);border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;margin-top:8px}
  button:hover{opacity:.9}
  .error{color:#ef4444;font-size:13px;text-align:center;margin-top:16px;display:none}
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
<title>Kimchi Proxy — Dashboard</title>
<style>
:root{--bg:#0b0c0f;--panel:#15171c;--panel-2:#1a1d23;--border:#2a2d35;--text:#e7e8eb;--muted:#9ca3af;--accent:#f97316;--accent-2:#fb923c;--danger:#ef4444;--ok:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;min-width:1100px}
.topbar{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:64px;background:linear-gradient(90deg,#15171c 0%,#1a1d23 100%);border-bottom:1px solid var(--border)}
.topbar h1{margin:0;font-size:20px;font-weight:700;display:flex;align-items:center;gap:12px;letter-spacing:.3px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
.dot.warn{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.dot.err{background:var(--danger);box-shadow:0 0 8px var(--danger)}
.topbar-right{display:flex;align-items:center;gap:24px}
.topbar-status{display:flex;align-items:center;gap:10px;font-weight:600;font-size:13px;background:var(--panel-2);padding:6px 14px;border-radius:20px;border:1px solid var(--border)}
.indicator{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok)}
.indicator.warn{background:var(--warn);box-shadow:0 0 6px var(--warn)}
.indicator.err{background:var(--danger);box-shadow:0 0 6px var(--danger)}
.indicator.off{background:var(--muted);box-shadow:none}
.topbar-date{text-align:right}
.topbar-date .day{color:var(--accent);font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.signout{color:var(--text);text-decoration:none;background:var(--panel-2);border:1px solid var(--border);padding:6px 14px;border-radius:6px;font-weight:600;font-size:13px;transition:.15s}
.signout:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.container{padding:28px;max-width:1600px;margin:0 auto}
.range-tabs{display:flex;gap:8px;margin-bottom:24px}
.range-tab{padding:8px 18px;border-radius:8px;background:var(--panel);border:1px solid var(--border);color:var(--muted);cursor:pointer;font-weight:600;transition:.15s}
.range-tab:hover{border-color:var(--accent);color:var(--text)}
.range-tab.active{background:linear-gradient(135deg,var(--accent),var(--accent-2));border-color:transparent;color:#fff}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;margin-bottom:28px}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent);opacity:.7}
.stat.accent::before{background:var(--accent)}
.stat.danger::before{background:var(--danger)}
.stat .label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.stat .value{font-size:26px;font-weight:800}
.stat .sub{font-size:12px;color:var(--muted);margin-top:4px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-bottom:28px}
.card-panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:22px}
.card-panel h3{margin:0 0 18px 0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;color:var(--accent)}
.metric-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.metric-row:last-child{border-bottom:none}
.metric-row .muted{color:var(--muted)}
.metric-row .value{font-weight:700;font-size:15px}
.provider-kimchi{color:var(--ok)}
.provider-cf{color:#60a5fa}
.cf-grid,.key-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:8px;margin-top:16px}
.cf-cell,.key-cell{border-radius:8px;padding:8px 4px;text-align:center;font-size:11px;font-weight:700;border:1px solid var(--border)}
.cf-cell.active,.key-cell.active{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35);color:var(--ok)}
.cf-cell.exhausted,.key-cell.exhausted{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);color:var(--danger)}
.key-cell.throttled{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.35);color:var(--warn)}
.key-cell.error{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.35);color:var(--danger)}
.section{margin-bottom:28px}
.section h2{margin:0 0 16px 0;font-size:17px;font-weight:700;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;font-size:13px}
th{background:var(--panel-2);color:var(--muted);font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.6px;padding:12px 14px;text-align:left}
td{padding:12px 14px;border-top:1px solid var(--border);vertical-align:middle}
tr:hover td{background:rgba(255,255,255,.02)}
td.empty{text-align:center;color:var(--muted);padding:28px}
code{font-family:'Fira Code','Courier New',monospace;font-size:12px;background:var(--panel-2);padding:3px 6px;border-radius:4px}
.badge{display:inline-block;padding:4px 8px;border-radius:6px;font-size:11px;font-weight:700;text-transform:uppercase}
.badge.kimchi{background:rgba(34,197,94,.15);color:var(--ok)}
.badge.cf{background:rgba(59,130,246,.15);color:#93c5fd}
.badge.ok{background:rgba(34,197,94,.15);color:var(--ok)}
.badge.err{background:rgba(239,68,68,.15);color:var(--danger)}
.error-msg{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--danger);font-weight:600}
.console{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.console-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--panel-2);border-bottom:1px solid var(--border);font-weight:700}
.console-filters{display:flex;gap:6px}
.console-filter{padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer}
.console-filter:hover{color:var(--text)}
.console-filter.active{background:var(--accent);color:#fff}
.console-body{max-height:420px;overflow-y:auto;padding:10px 14px;font-family:'Fira Code','Courier New',monospace;font-size:12px;line-height:1.6;background:#0f1013}
.log-entry{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.log-time{color:var(--muted);white-space:nowrap}
.log-level{font-weight:800;width:46px;flex-shrink:0}
.log-level.info{color:#60a5fa}
.log-level.error{color:var(--danger)}
.log-msg{word-break:break-word}
</style>
</head>
<body>
<div class="topbar">
  <h1><span class="dot" id="status-dot"></span> Kimchi Proxy</h1>
  <div class="topbar-right">
    <div class="topbar-status" id="cf-status">
      <span class="indicator" id="cf-indicator"></span>
      <span id="cf-status-text">CF: ...</span>
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
    <div class="stat accent"><div class="label">Est. Cost</div><div class="value" id="s-cost">—</div><div class="sub">Kimchi pricing</div></div>
    <div class="stat danger"><div class="label">Errors</div><div class="value" id="s-err">—</div></div>
    <div class="stat"><div class="label">Avg Response</div><div class="value" id="s-avg">—</div><div class="sub">milliseconds</div></div>
  </div>

  <div class="grid-2">
    <div class="card-panel">
      <h3><span class="icon">🌶️</span> Kimchi</h3>
      <div class="metric-row"><span class="muted">Requests</span><span class="value provider-kimchi" id="p-kimchi-req">—</span></div>
      <div class="metric-row"><span class="muted">Input Tokens</span><span class="value" id="p-kimchi-in">—</span></div>
      <div class="metric-row"><span class="muted">Output Tokens</span><span class="value" id="p-kimchi-out">—</span></div>
      <div class="metric-row"><span class="muted">Avg Response</span><span class="value" id="p-kimchi-avg">—</span></div>
      <div class="metric-row"><span class="muted">Errors</span><span class="value" id="p-kimchi-err">—</span></div>
    </div>
    <div class="card-panel">
      <h3><span class="icon">☁️</span> Cloudflare (GLM 5.2)</h3>
      <div class="metric-row"><span class="muted">Requests</span><span class="value provider-cf" id="p-cf-req">—</span></div>
      <div class="metric-row"><span class="muted">Input Tokens</span><span class="value" id="p-cf-in">—</span></div>
      <div class="metric-row"><span class="muted">Output Tokens</span><span class="value" id="p-cf-out">—</span></div>
      <div class="metric-row"><span class="muted">Avg Response</span><span class="value" id="p-cf-avg">—</span></div>
      <div class="metric-row"><span class="muted">Errors</span><span class="value" id="p-cf-err">—</span></div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card-panel">
      <h3><span class="icon">☁️</span> CF Credential Quota</h3>
      <div class="metric-row"><span class="muted">Total Accounts</span><span class="value" id="cf-total">—</span></div>
      <div class="metric-row"><span class="muted">Active</span><span class="value provider-kimchi" id="cf-active">—</span></div>
      <div class="metric-row"><span class="muted">Exhausted</span><span class="value" id="cf-exhausted">—</span></div>
      <div class="metric-row"><span class="muted">Next UTC Reset</span><span class="value" id="cf-reset">—</span></div>
      <div class="cf-grid" id="cf-grid"></div>
    </div>
    <div class="card-panel">
      <h3><span class="icon">🔑</span> Kimchi API Keys</h3>
      <div class="metric-row"><span class="muted">Total</span><span class="value" id="k-total">—</span></div>
      <div class="metric-row"><span class="muted">Active</span><span class="value provider-kimchi" id="k-active">—</span></div>
      <div class="metric-row"><span class="muted">Exhausted</span><span class="value" id="k-exhausted">—</span></div>
      <div class="metric-row"><span class="muted">Throttled</span><span class="value" id="k-throttled">—</span></div>
      <div class="key-grid" id="key-grid"></div>
    </div>
  </div>

  <div class="section">
    <h2><span class="icon">📊</span> Model Usage</h2>
    <table>
      <thead><tr><th>Model</th><th>Provider</th><th>Requests</th><th>In / Out Tokens</th><th>Avg Response</th><th>Errors</th></tr></thead>
      <tbody id="model-body"><tr><td colspan="6" class="empty">No model usage yet</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2><span class="icon">🔴</span> Errors</h2>
    <table class="err-table">
      <thead><tr><th>#</th><th>Req</th><th>Provider</th><th>Model</th><th>Key</th><th>Status</th><th>Error</th><th>When</th></tr></thead>
      <tbody id="err-body"><tr><td colspan="8" class="empty">No errors</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2><span class="icon">📋</span> Recent Requests</h2>
    <table>
      <thead><tr><th>#</th><th>Provider</th><th>Model</th><th>In / Out</th><th>Key</th><th>Status</th><th>Time</th><th>When</th></tr></thead>
      <tbody id="req-body"><tr><td colspan="8" class="empty">No requests yet</td></tr></tbody>
    </table>
  </div>

  <div class="section">
    <h2><span class="icon">🖥️</span> Console Logs</h2>
    <div class="console">
      <div class="console-header">
        <span>Logs</span>
        <div class="console-filters">
          <div class="console-filter active" data-filter="all">All</div>
          <div class="console-filter" data-filter="info">Info</div>
          <div class="console-filter" data-filter="error">Error</div>
        </div>
      </div>
      <div class="console-body" id="log-body"></div>
    </div>
  </div>
</div>
<script>
let currentRange='today';
let currentLogFilter='all';
let lastCfStatus={};
function fmt(n){if(n===undefined||n===null)return '—';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return n.toLocaleString()}
function fmtMs(n){if(n===undefined||n===null)return '—';return n+'ms'}
function pct(n,d){if(!d)return '0%';return Math.round((n/d)*100)+'%'}
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago'}
function time(ts){return new Date(ts).toLocaleTimeString()}
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
function updateClock(){
  const now=new Date();
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('clock').innerHTML='<div class="day">'+days[now.getDay()]+'</div><div>'+now.getDate()+' '+months[now.getMonth()]+' '+now.getFullYear()+' · '+now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})+'</div>';
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

document.querySelector('.console-filters').addEventListener('click',e=>{
  const btn=e.target.closest('.console-filter');
  if(!btn)return;
  document.querySelectorAll('.console-filter').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  currentLogFilter=btn.dataset.filter;
  renderLogs(window._lastLogs||[]);
});

function renderCfStatus(cf){
  if(!cf)return;
  lastCfStatus=cf;
  const enabled=cf.enabled;
  const exhausted=cf.exhausted||0;
  const total=cf.total||0;
  const ind=document.getElementById('cf-indicator');
  const txt=document.getElementById('cf-status-text');
  const dot=document.getElementById('status-dot');
  if(!enabled){
    ind.className='indicator off';
    txt.textContent='CF: OFF';
    dot.className='dot';
  } else if(exhausted>=total && total>0){
    ind.className='indicator err';
    txt.textContent='CF: ALL EXHAUSTED';
    dot.className='dot err';
  } else if(exhausted>0){
    ind.className='indicator warn';
    txt.textContent='CF: '+exhausted+'/'+total+' exhausted';
    dot.className='dot warn';
  } else {
    ind.className='indicator';
    txt.textContent='CF: ACTIVE ('+total+')';
    dot.className='dot';
  }
  document.getElementById('cf-total').textContent=fmt(total);
  document.getElementById('cf-active').textContent=fmt(cf.active||0);
  document.getElementById('cf-exhausted').textContent=fmt(exhausted);
  document.getElementById('cf-reset').textContent=cf.nextReset?new Date(cf.nextReset).toUTCString():'—';
  const grid=document.getElementById('cf-grid');
  if(total===0){grid.innerHTML='<div class="empty" style="grid-column:1/-1;padding:12px">No CF credentials</div>';return}
  const exhaustedSet=new Set((cf.exhaustedCredentials||[]).map(x=>x.index));
  grid.innerHTML=Array.from({length:total},(_,i)=>{
    const isEx=exhaustedSet.has(i);
    return '<div class="cf-cell '+(isEx?'exhausted':'active')+'" title="Account #'+(i+1)+': '+(isEx?'exhausted until UTC reset':'active')+'"><div class="num">'+(i+1)+'</div><div class="lbl">'+(isEx?'BAN':'OK')+'</div></div>';
  }).join('');
}

function renderKeys(keys){
  if(!keys)return;
  document.getElementById('k-total').textContent=fmt(keys.total||0);
  document.getElementById('k-active').textContent=fmt(keys.active||0);
  document.getElementById('k-exhausted').textContent=fmt(keys.exhausted||0);
  document.getElementById('k-throttled').textContent=fmt(keys.throttled||0);
  const grid=document.getElementById('key-grid');
  const total=keys.total||0;
  if(total===0){grid.innerHTML='<div class="empty" style="grid-column:1/-1;padding:12px">No keys</div>';return}
  const errs=keys.errors||{};
  const exhausted=new Set(keys._exhausted||[]);
  const throttled=new Set(keys._throttled||[]);
  grid.innerHTML=Array.from({length:total},(_,i)=>{
    const err=errs['key_'+i];
    let cls='active',lbl='OK';
    if(exhausted.has(i)){cls='exhausted';lbl='EXH'}
    else if(throttled.has(i)){cls='throttled';lbl='THR'}
    else if(err){cls='error';lbl='ERR'}
    const title='Key #'+(i+1)+(err?': '+err.count+' errors, last: '+err.lastError:'');
    return '<div class="key-cell '+cls+'" title="'+esc(title)+'"><div class="num">'+(i+1)+'</div><div class="lbl">'+lbl+'</div></div>';
  }).join('');
}

function renderProviderBadge(p){
  return '<span class="badge '+(p==='cf'?'cf':'kimchi')+'">'+(p==='cf'?'CF':'Kimchi')+'</span>';
}

function renderLogs(logs){
  const body=document.getElementById('log-body');
  const filtered=currentLogFilter==='all'?logs:logs.filter(l=>l.level===currentLogFilter);
  if(!filtered||filtered.length===0){body.innerHTML='<div class="empty">No logs</div>';return}
  body.innerHTML=filtered.map(l=>'<div class="log-entry"><span class="log-time">'+time(l.timestamp)+'</span><span class="log-level '+l.level+'">'+l.level.toUpperCase()+'</span><span class="log-msg">'+esc(l.message)+'</span></div>').join('');
}

async function load(){
  try{
    const r=await fetch('/api/dashboard?action=stats&range='+currentRange);
    if(!r.ok){window.location.href='/dashboard';return}
    const d=await r.json();

    document.getElementById('s-req').textContent=fmt(d.totalRequests);
    document.getElementById('s-in').textContent=fmt(d.totalInputTokens);
    document.getElementById('s-out').textContent=fmt(d.totalOutputTokens);
    document.getElementById('s-cost').textContent='USD '+(d.estimatedCost||0).toFixed(2);
    document.getElementById('s-err').textContent=fmt(d.totalErrors);
    document.getElementById('s-avg').textContent=fmtMs(d.avgElapsed);

    const kimchi=d.providers?d.providers.kimchi||{requests:0,inputTokens:0,outputTokens:0,errors:0,avgElapsed:0}:{requests:0,inputTokens:0,outputTokens:0,errors:0,avgElapsed:0};
    const cf=d.providers?d.providers.cf||{requests:0,inputTokens:0,outputTokens:0,errors:0,avgElapsed:0}:{requests:0,inputTokens:0,outputTokens:0,errors:0,avgElapsed:0};
    document.getElementById('p-kimchi-req').textContent=fmt(kimchi.requests);
    document.getElementById('p-kimchi-in').textContent=fmt(kimchi.inputTokens);
    document.getElementById('p-kimchi-out').textContent=fmt(kimchi.outputTokens);
    document.getElementById('p-kimchi-avg').textContent=fmtMs(kimchi.avgElapsed);
    document.getElementById('p-kimchi-err').textContent=fmt(kimchi.errors);
    document.getElementById('p-cf-req').textContent=fmt(cf.requests);
    document.getElementById('p-cf-in').textContent=fmt(cf.inputTokens);
    document.getElementById('p-cf-out').textContent=fmt(cf.outputTokens);
    document.getElementById('p-cf-avg').textContent=fmtMs(cf.avgElapsed);
    document.getElementById('p-cf-err').textContent=fmt(cf.errors);

    renderCfStatus(d.cfStatus);
    renderKeys(d.keys);

    const mbody=document.getElementById('model-body');
    const models=d.modelStats||{};
    const modelKeys=Object.keys(models);
    if(modelKeys.length===0){mbody.innerHTML='<tr><td colspan="6" class="empty">No model usage yet</td></tr>'}
    else{mbody.innerHTML=modelKeys.map(m=>{const v=models[m];const provider=m==='@cf/zai-org/glm-5.2'?'cf':(m.indexOf('kimi')>-1?'kimchi':'unknown');return '<tr><td><code>'+esc(m)+'</code></td><td>'+renderProviderBadge(provider)+'</td><td>'+fmt(v.requests)+'</td><td>'+fmt(v.inputTokens)+' / '+fmt(v.outputTokens)+'</td><td>'+fmtMs(v.avgElapsed)+'</td><td>'+fmt(v.errors)+'</td></tr>'}).join('')}

    const etbody=document.getElementById('err-body');
    if(!d.errors||d.errors.length===0){etbody.innerHTML='<tr><td colspan="8" class="empty">No errors</td></tr>'}
    else{etbody.innerHTML=d.errors.map(e=>'<tr><td>'+e.id+'</td><td>#'+e.request_id+'</td><td>'+renderProviderBadge(e.provider||'kimchi')+'</td><td><code>'+esc(e.model)+'</code></td><td>#'+e.keyIndex+'</td><td><span class="badge err">'+e.status+'</span></td><td class="error-msg" title="'+esc(e.error)+'">'+esc(e.error)+'</td><td>'+ago(e.timestamp)+'</td></tr>').join('')}

    const tbody=document.getElementById('req-body');
    if(!d.recentRequests||d.recentRequests.length===0){tbody.innerHTML='<tr><td colspan="8" class="empty">No requests yet</td></tr>'}
    else{tbody.innerHTML=d.recentRequests.map(r=>'<tr><td>'+r.id+'</td><td>'+renderProviderBadge(r.provider||'kimchi')+'</td><td><code>'+esc(r.model)+'</code></td><td>'+fmt(r.inputTokens)+' / '+fmt(r.outputTokens)+'</td><td>#'+r.keyIndex+'</td><td><span class="badge '+(r.status<400?'ok':'err')+'">'+r.status+'</span></td><td>'+r.elapsed+'ms</td><td>'+ago(r.timestamp)+'</td></tr>').join('')}

    window._lastLogs=d.logs||[];
    renderLogs(window._lastLogs);
  }catch(e){}
}
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
      const stats = await getStats(range);
      const cfStatus = await getCfStatus();
      return res.status(200).json({ ...stats, cfStatus });
    } catch (e) {
      return res.status(200).json({
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        estimatedCost: 0,
        totalErrors: 0,
        avgElapsed: 0,
        providers: {},
        modelStats: {},
        keys: { total: 55, active: 55, exhausted: 0, throttled: 0, errors: {} },
        recentRequests: [],
        errors: [],
        logs: [],
        cfStatus: await getCfStatus(),
      });
    }
  }

  res.setHeader("Content-Type", "text/html");
  res.status(200).end(LOGIN_HTML);
};
