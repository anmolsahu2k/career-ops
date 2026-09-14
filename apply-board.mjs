#!/usr/bin/env node

/**
 * apply-board.mjs — Scan-history checklist (NOT ApplicationAttempt state)
 *
 * Reads data/scan-history.tsv (all scanned jobs) and renders a self-contained
 * HTML board with search, source-filter chips, sortable columns, clickable
 * Apply links, and per-job "applied" checkboxes.
 * For autonomous attempt state use: node bin/career-ops.mjs apply serve
 *
 * Applied state is persisted to a FILE: data/applied.tsv.
 *   - `--serve` mode runs a tiny local server so each checkbox writes straight
 *     to data/applied.tsv (durable, git-trackable).
 *   - Opening the static output/apply-board.html directly (file://) still works
 *     but falls back to browser localStorage (not durable across machines).
 *
 * data/applied.tsv is a lightweight "I clicked apply on this link" log. It is
 * SEPARATE from data/applications.md (the curated, fit-scored tracker managed
 * via merge-tracker.mjs). Zero external deps.
 *
 * Usage:
 *   node apply-board.mjs            # build output/apply-board.html (static)
 *   node apply-board.mjs --open     # build + open in browser (macOS)
 *   node apply-board.mjs --serve    # run server at http://localhost:8787 (durable)
 *   node apply-board.mjs --serve --port 9000
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { scoreJobs } from './lib/fit-score.mjs';
import { resolvePaths } from './lib/paths.mjs';

// Paths resolve under $CAREER_OPS_DATA_DIR (default ft/); profile.yml is shared root.
const P = resolvePaths(import.meta.url);
const SCAN_HISTORY_PATH = join(P.dataDir, 'scan-history.tsv');
const PIPELINE_PATH = join(P.dataDir, 'pipeline.md');
const APPLIED_PATH = join(P.dataDir, 'applied.tsv');
const PROFILE_PATH = join(P.root, 'config', 'profile.yml');
const OUT_DIR = join(P.target, 'output');
const OUT_PATH = join(OUT_DIR, 'apply-board.html');
const APPLIED_HEADER = 'url\tapplied_at\tcompany\ttitle\tsource\n';

// ── Data loading ────────────────────────────────────────────────────

function loadJobs() {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    console.error(`Error: ${SCAN_HISTORY_PATH} not found. Run a scan first (node scan.mjs, or CAREER_OPS_DATA_DIR=. for the archive).`);
    process.exit(1);
  }
  const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1);
  const seen = new Set();
  const jobs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const [url, date, source, title, company] = line.split('\t');
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    jobs.push({ url, date: date || '', source: source || '', title, company: company || '' });
  }
  return jobs;
}

// Score jobs against config/profile.yml → scoring (fit heuristic).
// Returns { jobs, scored }; if no profile, jobs get score:null and scored:false.
function annotateFit(jobs) {
  if (!existsSync(PROFILE_PATH)) return { jobs: jobs.map(j => ({ ...j, score: null, matched: null })), scored: false };
  let scoring = null;
  try { scoring = (yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) || {}).scoring || null; } catch { /* ignore */ }
  if (!scoring) return { jobs: jobs.map(j => ({ ...j, score: null, matched: null })), scored: false };
  return { jobs: scoreJobs(jobs, scoring), scored: true };
}

// Pre-seed "applied" from any checked ([x]) rows in pipeline.md.
function loadAppliedFromPipeline() {
  const applied = [];
  if (!existsSync(PIPELINE_PATH)) return applied;
  const text = readFileSync(PIPELINE_PATH, 'utf-8');
  for (const m of text.matchAll(/- \[x\]\s+(https?:\/\/\S+)/gi)) applied.push(m[1]);
  return applied;
}

// ── data/applied.tsv (persistent store) ─────────────────────────────

function readAppliedMap() {
  const map = new Map(); // url -> {url, applied_at, company, title, source}
  if (!existsSync(APPLIED_PATH)) return map;
  const lines = readFileSync(APPLIED_PATH, 'utf-8').split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const [url, applied_at, company, title, source] = line.split('\t');
    if (url) map.set(url, { url, applied_at: applied_at || '', company: company || '', title: title || '', source: source || '' });
  }
  return map;
}

function writeAppliedMap(map) {
  mkdirSync(P.dataDir, { recursive: true });
  const rows = [...map.values()].map(r =>
    `${r.url}\t${r.applied_at}\t${r.company}\t${r.title}\t${r.source}`
  );
  writeFileSync(APPLIED_PATH, APPLIED_HEADER + rows.join('\n') + (rows.length ? '\n' : ''), 'utf-8');
}

function upsertApplied(url, on, meta = {}) {
  const map = readAppliedMap();
  if (on) {
    if (!map.has(url)) {
      map.set(url, {
        url,
        applied_at: new Date().toISOString(),
        company: meta.company || '',
        title: meta.title || '',
        source: meta.source || '',
      });
    }
  } else {
    map.delete(url);
  }
  writeAppliedMap(map);
  return map;
}

// ── HTML ────────────────────────────────────────────────────────────

function buildHtml(jobs, appliedSeed, scored) {
  const counts = jobs.reduce((m, j) => (m[j.source] = (m[j.source] || 0) + 1, m), {});
  const sources = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const dataJson = JSON.stringify({ jobs, applied: appliedSeed, scored: !!scored }).replace(/</g, '\\u003c');
  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const chips = [`<button class="chip active" data-src="">All <b>${jobs.length}</b></button>`]
    .concat(sources.map(s => `<button class="chip" data-src="${s}">${s} <b>${counts[s]}</b></button>`))
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Apply Board — ${jobs.length} jobs</title>
<style>
  :root{
    --bg:#f7f8fa; --panel:#fff; --text:#1a1d24; --muted:#697488; --border:#e4e7ec;
    --accent:#2b6cff; --accent-ink:#fff; --applied:#9aa3b2; --row-hover:#f0f4ff; --chip:#eef2f9;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#0e1117; --panel:#161b22; --text:#e6edf3; --muted:#8b949e; --border:#26303c;
      --accent:#4c8bff; --accent-ink:#04122e; --applied:#5b6472; --row-hover:#1b2430; --chip:#1c232d; }
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
  header{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--border);padding:14px 18px}
  h1{margin:0 0 10px;font-size:17px;font-weight:650}
  h1 small{color:var(--muted);font-weight:400;font-size:13px;margin-left:8px}
  .toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
  input[type=search]{font:inherit;padding:8px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);flex:1;min-width:220px}
  .toggle{display:flex;align-items:center;gap:6px;color:var(--muted);white-space:nowrap;cursor:pointer;user-select:none}
  .stat{color:var(--muted);white-space:nowrap}
  .stat b{color:var(--text)}
  .btn{font:inherit;font-size:13px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);cursor:pointer}
  .btn:hover{background:var(--row-hover)}
  .save{font-size:12px;color:var(--muted)}
  .save.ok{color:#1a9e5f}
  .chips{display:flex;flex-wrap:wrap;gap:7px}
  .chip{font:inherit;font-size:12.5px;padding:5px 12px;border:1px solid var(--border);border-radius:20px;background:var(--chip);color:var(--text);cursor:pointer}
  .chip b{color:var(--muted);font-weight:600;margin-left:3px}
  .chip.active{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  .chip.active b{color:var(--accent-ink);opacity:.85}
  .wrap{overflow-x:auto}
  table{border-collapse:collapse;width:100%;min-width:720px}
  thead th{position:sticky;top:0;text-align:left;font-size:12px;letter-spacing:.02em;text-transform:uppercase;color:var(--muted);
    padding:10px 12px;border-bottom:1px solid var(--border);background:var(--panel);cursor:pointer;white-space:nowrap}
  thead th.nosort{cursor:default}
  th .arrow{opacity:.6;font-size:10px}
  tbody td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody tr:hover{background:var(--row-hover)}
  tr.done td{color:var(--applied)}
  tr.done .title{text-decoration:line-through;color:var(--applied)}
  .title{font-weight:550;color:var(--text)}
  .company{white-space:nowrap}
  .src{display:inline-block;font-size:11px;color:var(--muted);background:var(--chip);border:1px solid var(--border);border-radius:20px;padding:2px 9px}
  .fit{display:inline-block;min-width:34px;text-align:center;font-weight:700;font-size:12px;padding:3px 8px;border-radius:6px;cursor:default}
  .fit-high{background:#1a9e5f22;color:#1a9e5f;border:1px solid #1a9e5f55}
  .fit-mid{background:#c9820022;color:#b7791f;border:1px solid #c9820055}
  .fit-low{background:var(--chip);color:var(--muted);border:1px solid var(--border)}
  @media (prefers-color-scheme: dark){ .fit-mid{color:#e0a83e} }
  .apply{display:inline-block;text-decoration:none;background:var(--accent);color:var(--accent-ink);padding:6px 13px;border-radius:7px;font-weight:600;font-size:13px;white-space:nowrap}
  .apply:hover{filter:brightness(1.08)}
  td.chk{text-align:center}
  input[type=checkbox]{width:17px;height:17px;cursor:pointer;accent-color:var(--accent)}
  .empty{padding:40px;text-align:center;color:var(--muted)}
  footer{padding:14px 18px;color:var(--muted);font-size:12px}
  code{background:var(--chip);padding:1px 5px;border-radius:4px}
</style>
</head>
<body>
<header>
  <h1>Apply Board <small>generated ${generatedAt} · <span id="store">browser storage</span></small></h1>
  <div class="toolbar">
    <input type="search" id="q" placeholder="Search title or company… (press /)" autocomplete="off">
    <select id="minfit" title="Minimum fit score">
      <option value="0">Any fit</option>
      <option value="70">Fit 70+ (strong)</option>
      <option value="45">Fit 45+ (decent)</option>
    </select>
    <label class="toggle"><input type="checkbox" id="hideApplied"> Hide applied</label>
    <button class="btn" id="export">Export applied ↓</button>
    <span class="stat" id="stat"></span>
    <span class="save" id="save"></span>
  </div>
  <div class="chips" id="chips">${chips}</div>
</header>

<div class="wrap">
  <table>
    <thead>
      <tr>
        <th class="nosort">✓</th>
        <th data-k="score" data-num="1">Fit <span class="arrow"></span></th>
        <th data-k="company">Company <span class="arrow"></span></th>
        <th data-k="title">Title <span class="arrow"></span></th>
        <th data-k="source">Source <span class="arrow"></span></th>
        <th data-k="date">Posted <span class="arrow"></span></th>
        <th class="nosort">Apply</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" hidden>No jobs match your filters.</div>
</div>

<footer>
  Click headers to sort · chips filter by source · checkboxes mark applied.
  In <code>--serve</code> mode they save to <code>data/applied.tsv</code>; otherwise to this browser.
  Refresh with <code>node apply-board.mjs</code> after a scan.
</footer>

<script>
const DATA = ${dataJson};
const LS_KEY = 'apply-board-applied-v1';
let mode = 'local';                 // 'server' if the local API answers
const applied = new Set();
const saveEl = document.getElementById('save');

function persistLocal(){ try { localStorage.setItem(LS_KEY, JSON.stringify([...applied])); } catch(e){} }
function flash(msg, ok){ saveEl.textContent = msg; saveEl.className = 'save' + (ok ? ' ok' : ''); if(ok) setTimeout(()=>{saveEl.textContent='';}, 1200); }

async function initApplied(){
  // Try the local server API first (durable → data/applied.tsv)
  try {
    const r = await fetch('api/applied');
    if (r.ok){ const j = await r.json(); (j.urls||[]).forEach(u=>applied.add(u)); mode='server';
      document.getElementById('store').textContent = 'saving to data/applied.tsv'; return; }
  } catch(e){ /* file:// or no server → localStorage */ }
  (DATA.applied||[]).forEach(u=>applied.add(u));
  try { (JSON.parse(localStorage.getItem(LS_KEY))||[]).forEach(u=>applied.add(u)); } catch(e){}
}

async function setApplied(job, on){
  if(on) applied.add(job.url); else applied.delete(job.url);
  if(mode==='server'){
    try{
      const r = await fetch('api/applied', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({url:job.url, applied:on, company:job.company, title:job.title, source:job.source})});
      if(!r.ok) throw new Error('http '+r.status);
      flash('saved', true);
    }catch(e){ flash('save failed — kept in browser', false); persistLocal(); }
  } else { persistLocal(); }
}

const rowsEl=document.getElementById('rows'), emptyEl=document.getElementById('empty'), statEl=document.getElementById('stat');
const qEl=document.getElementById('q'), hideEl=document.getElementById('hideApplied');
const NUM_KEYS = new Set(['score']);
let sortKey = DATA.scored ? 'score' : 'date', sortDir=-1, srcFilter='', minFit=0;

function esc(s){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function fitCell(j){
  if(j.score==null) return '<span class="fit fit-low">—</span>';
  const band = j.score>=70?'high':j.score>=45?'mid':'low';
  const m = j.matched || {};
  const parts = [];
  if(m.role&&m.role.length) parts.push('role: '+m.role.join(', '));
  if(m.skills&&m.skills.length) parts.push('skills: '+m.skills.join(', '));
  if(m.level&&m.level.length) parts.push('level: '+m.level.join(', '));
  if(m.off&&m.off.length) parts.push('off-target: '+m.off.join(', '));
  const tip = parts.length ? parts.join(' · ') : 'no keyword matches';
  return '<span class="fit fit-'+band+'" title="'+esc(tip)+'">'+j.score+'</span>';
}

function currentView(){
  const q=qEl.value.trim().toLowerCase(), hide=hideEl.checked;
  let view = DATA.jobs.filter(j => {
    if (srcFilter && j.source !== srcFilter) return false;
    if (minFit && (j.score==null || j.score < minFit)) return false;
    if (hide && applied.has(j.url)) return false;
    if (q && !((j.title+' '+j.company).toLowerCase().includes(q))) return false;
    return true;
  });
  if (NUM_KEYS.has(sortKey)){
    view.sort((a,b)=>{ const x=a[sortKey]??-1, y=b[sortKey]??-1; return (x-y)*sortDir; });
  } else {
    view.sort((a,b)=>{ const x=(a[sortKey]||'').toLowerCase(), y=(b[sortKey]||'').toLowerCase();
      if(!x&&y)return 1; if(x&&!y)return -1; return x<y?-1*sortDir:x>y?1*sortDir:0; });
  }
  return view;
}
function updateStat(view){ statEl.innerHTML='Showing <b>'+view.length+'</b> of '+DATA.jobs.length+' · <b>'+applied.size+'</b> applied'; }

function render(){
  const view=currentView(), frag=document.createDocumentFragment();
  for(const j of view){
    const tr=document.createElement('tr'); if(applied.has(j.url)) tr.className='done';
    tr.innerHTML =
      '<td class="chk"><input type="checkbox" data-url="'+esc(j.url)+'"'+(applied.has(j.url)?' checked':'')+'></td>'+
      '<td>'+fitCell(j)+'</td>'+
      '<td class="company">'+esc(j.company)+'</td>'+
      '<td class="title">'+esc(j.title)+'</td>'+
      '<td><span class="src">'+esc(j.source)+'</span></td>'+
      '<td>'+esc(j.date)+'</td>'+
      '<td><a class="apply" href="'+esc(j.url)+'" target="_blank" rel="noopener">Apply →</a></td>';
    frag.appendChild(tr);
  }
  rowsEl.replaceChildren(frag); emptyEl.hidden = view.length!==0; updateStat(view);
}

rowsEl.addEventListener('change', async e => {
  const cb=e.target.closest('input[type=checkbox]'); if(!cb) return;
  const job = DATA.jobs.find(j=>j.url===cb.dataset.url); if(!job) return;
  await setApplied(job, cb.checked);
  cb.closest('tr').classList.toggle('done', cb.checked);
  if(hideEl.checked && cb.checked) render(); else updateStat(currentView());
});

document.getElementById('chips').addEventListener('click', e => {
  const chip=e.target.closest('.chip'); if(!chip) return;
  srcFilter = chip.dataset.src;
  document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active', c===chip));
  render();
});

document.querySelectorAll('thead th[data-k]').forEach(th => th.addEventListener('click', () => {
  const k=th.dataset.k; if(sortKey===k) sortDir*=-1; else { sortKey=k; sortDir=1; }
  document.querySelectorAll('thead .arrow').forEach(a=>a.textContent='');
  th.querySelector('.arrow').textContent = sortDir===1?'▲':'▼'; render();
}));

document.getElementById('export').addEventListener('click', () => {
  const rows = DATA.jobs.filter(j=>applied.has(j.url))
    .map(j=>[j.url,j.company,j.title,j.source].map(x=>String(x).replace(/\\t/g,' ')).join('\\t'));
  const blob = new Blob(['url\\tcompany\\ttitle\\tsource\\n'+rows.join('\\n')+'\\n'], {type:'text/tab-separated-values'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='applied.tsv'; a.click();
});

qEl.addEventListener('input', render);
hideEl.addEventListener('change', render);
document.getElementById('minfit').addEventListener('change', e => { minFit = +e.target.value || 0; render(); });
document.addEventListener('keydown', e => { if(e.key==='/' && document.activeElement!==qEl){ e.preventDefault(); qEl.focus(); } });

// Reflect the default sort (Fit ▼ when scored, else Posted ▼) in the header arrow.
(function(){ const th=document.querySelector('thead th[data-k="'+sortKey+'"]'); if(th) th.querySelector('.arrow').textContent = sortDir===1?'▲':'▼'; })();

initApplied().then(render);
</script>
</body>
</html>`;
}

// ── Server mode ─────────────────────────────────────────────────────

function startServer(port, jobs, scored) {
  const html = buildHtml(jobs, [], scored); // applied seeded from data/applied.tsv via /api/applied
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && url === '/api/applied') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ urls: [...readAppliedMap().keys()] }));
    }
    if (req.method === 'POST' && url === '/api/applied') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const { url: jobUrl, applied: on, company, title, source } = JSON.parse(body || '{}');
          if (!jobUrl) throw new Error('missing url');
          const map = upsertApplied(jobUrl, !!on, { company, title, source });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: map.size }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(port, () => {
    const applied = readAppliedMap();
    console.log(`Apply board (server mode) → http://localhost:${port}`);
    console.log(`  ${jobs.length} jobs · ${applied.size} already applied (data/applied.tsv)`);
    console.log('  Checkbox ticks persist to data/applied.tsv. Ctrl+C to stop.');
    if (process.argv.includes('--open') && process.platform === 'darwin') {
      execFile('open', [`http://localhost:${port}`], () => {});
    }
  });
}

// ── Main ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const { jobs, scored } = annotateFit(loadJobs());

  if (args.includes('--serve')) {
    const pi = args.indexOf('--port');
    const port = pi !== -1 ? parseInt(args[pi + 1], 10) : 8787;
    startServer(port, jobs, scored);
    return;
  }

  // Static build: seed applied from data/applied.tsv (falls back to pipeline.md [x])
  const seed = existsSync(APPLIED_PATH) ? [...readAppliedMap().keys()] : loadAppliedFromPipeline();
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, buildHtml(jobs, seed, scored), 'utf-8');

  const bySource = jobs.reduce((m, j) => (m[j.source] = (m[j.source] || 0) + 1, m), {});
  const strong = scored ? jobs.filter(j => j.score >= 70).length : 0;
  console.log(`Apply board built: ${OUT_PATH}`);
  console.log(`  ${jobs.length} jobs · ${seed.length} pre-marked applied` + (scored ? ` · ${strong} strong-fit (70+)` : ' · fit scoring OFF (no config/profile.yml)'));
  console.log('  by source: ' + Object.entries(bySource).map(([s, n]) => `${s} ${n}`).join(', '));
  console.log(`\n  Browse + click Apply:   open ${OUT_PATH}`);
  console.log('  Durable applied store:  node apply-board.mjs --serve   (writes data/applied.tsv)');

  if (args.includes('--open') && process.platform === 'darwin') {
    execFile('open', [OUT_PATH], err => { if (err) console.error('  (could not auto-open):', err.message); });
  }
}

main();
