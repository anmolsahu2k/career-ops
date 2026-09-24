/**
 * page.mjs — Career-Ops web app HTML shell (all funnel tabs).
 */

export function renderCareerOpsPage({ csrfToken, writable = false, applicationsEnabled = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Career-Ops</title>
<style>
:root {
  --bg: #0b1014;
  --bg-elev: #121a20;
  --panel: #161f27;
  --panel-2: #1c2730;
  --ink: #e8eef2;
  --muted: #8b9aa6;
  --faint: #5d6d78;
  --line: #2a3843;
  --accent: #2ad4a8;
  --accent-dim: #1a8f74;
  --accent-ink: #07362f;
  --warn: #e3b15a;
  --warn-bg: #2a2112;
  --danger: #e15b6a;
  --danger-bg: #2a1418;
  --info: #7eb6ff;
  --ok: #2ad4a8;
  --shadow: 0 18px 50px rgba(0,0,0,.35);
  --mono: "Cascadia Mono", "IBM Plex Mono", ui-monospace, monospace;
  --sans: "Segoe UI", "IBM Plex Sans", system-ui, sans-serif;
  --radius: 12px;
  --header-h: 3.4rem;
  --nav-h: 3.15rem;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font: 13.5px/1.45 var(--sans);
  color: var(--ink);
  background:
    radial-gradient(900px 420px at 8% -8%, rgba(42,212,168,.12), transparent 55%),
    radial-gradient(700px 380px at 100% 0%, rgba(126,182,255,.08), transparent 50%),
    var(--bg);
  min-height: 100vh;
}
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
a { color: var(--accent); }
code, .mono { font-family: var(--mono); font-size: 12px; }
.muted { color: var(--muted); }
.hidden { display: none !important; }
.topbar {
  position: sticky; top: 0; z-index: 12;
  display: flex; align-items: center; gap: .85rem;
  height: var(--header-h);
  padding: 0 1.15rem;
  border-bottom: 1px solid var(--line);
  background: rgba(11,16,20,.88);
  backdrop-filter: blur(14px);
}
.brand {
  display: flex; align-items: center; gap: .65rem;
  min-width: 11rem;
}
.mark {
  width: 1.7rem; height: 1.7rem; border-radius: 7px;
  display: grid; place-items: center;
  background: linear-gradient(160deg, #3aefc3, #14856c);
  color: #06241e; font-weight: 800; font-size: 12px;
  letter-spacing: -.04em;
}
.brand h1 {
  margin: 0; font-size: 15px; letter-spacing: -.02em; font-weight: 650;
}
.brand small { display: block; color: var(--faint); font-size: 11px; font-weight: 500; }
.chips { display: flex; gap: .4rem; flex-wrap: wrap; margin-left: auto; align-items: center; }
.chip {
  display: inline-flex; align-items: center; gap: .35rem;
  border: 1px solid var(--line); background: var(--panel);
  color: var(--muted); border-radius: 999px;
  padding: .22rem .6rem; font-size: 11.5px;
}
.chip.ok { border-color: #1f5f4e; color: var(--accent); background: #10251f; }
.chip.warn { border-color: #6a5424; color: var(--warn); background: var(--warn-bg); }
.chip.job { border-color: #355a7a; color: var(--info); background: #152230; }
.dot { width: .45rem; height: .45rem; border-radius: 50%; background: currentColor; }
.dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
.funnel-nav {
  position: sticky; top: var(--header-h); z-index: 11;
  display: grid; grid-template-columns: repeat(5, minmax(0,1fr));
  gap: .35rem; padding: .5rem .85rem;
  border-bottom: 1px solid var(--line);
  background: rgba(18,26,32,.92);
  backdrop-filter: blur(12px);
}
.funnel-nav button {
  appearance: none; border: 1px solid transparent;
  background: transparent; color: var(--muted);
  border-radius: 10px; padding: .45rem .55rem;
  text-align: left; min-width: 0;
}
.funnel-nav button:hover { background: var(--panel); color: var(--ink); }
.funnel-nav button.active {
  background: var(--panel-2);
  border-color: var(--line);
  color: var(--ink);
  box-shadow: inset 0 0 0 1px rgba(42,212,168,.18);
}
.funnel-nav button.next-hint { outline: 1px dashed rgba(42,212,168,.45); }
.funnel-nav .kicker { display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.funnel-nav .label { display: flex; justify-content: space-between; gap: .4rem; align-items: baseline; }
.funnel-nav .count { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.shell { padding: 1rem 1.15rem 1.5rem; max-width: 1280px; margin: 0 auto; }
body.job-open .shell { padding-bottom: 6.5rem; }
.panel { animation: fade .18s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.hero {
  display: flex; gap: 1rem; align-items: flex-start; justify-content: space-between;
  flex-wrap: wrap; margin-bottom: 1rem;
}
.hero h2 { margin: 0 0 .25rem; font-size: 1.35rem; letter-spacing: -.03em; }
.toolbar {
  display: flex; gap: .5rem; flex-wrap: wrap; align-items: center;
  margin: 0 0 .85rem; padding: .7rem .8rem;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
}
.field { display: flex; align-items: center; gap: .4rem; color: var(--muted); font-size: 12.5px; }
.field input, .field select {
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: .38rem .55rem; min-width: 0;
}
.field input[type=number] { width: 4.6rem; }
.field input[type=text] { width: 13rem; }
.grow { flex: 1; }
button.action, button.ghost, button.danger, button.quiet {
  border-radius: 8px; padding: .42rem .8rem; border: 1px solid transparent;
  font-weight: 600;
}
button.action { background: var(--accent); color: var(--accent-ink); }
button.action:hover { filter: brightness(1.05); }
button.ghost { background: transparent; border-color: var(--line); color: var(--ink); }
button.ghost:hover { border-color: var(--accent-dim); }
button.danger { background: var(--danger-bg); border-color: #5d2430; color: #ffb4bc; }
button.quiet { background: transparent; color: var(--muted); border: 0; padding: .3rem .45rem; }
button:disabled { opacity: .38; cursor: not-allowed; filter: none; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(8.4rem, 1fr)); gap: .55rem; }
.stat {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: .75rem .8rem; text-align: left; width: 100%; color: inherit;
}
.stat:hover { border-color: var(--accent-dim); }
.stat b { display: block; font-size: 1.45rem; letter-spacing: -.03em; }
.stat span { color: var(--muted); font-size: 12px; }
.section-head {
  display: flex; justify-content: space-between; gap: .6rem; align-items: baseline;
  margin: 1.1rem 0 .45rem;
}
.section-head h3 { margin: 0; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
.table-wrap {
  overflow: auto; max-height: min(58vh, 42rem);
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
}
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: .48rem .65rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { position: sticky; top: 0; background: #1a242c; color: var(--faint); font-weight: 600; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; z-index: 1; }
tr:hover td { background: rgba(255,255,255,.02); }
td.clip { max-width: 18rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty {
  padding: 2.2rem 1.2rem; text-align: center; color: var(--muted);
  border: 1px dashed var(--line); border-radius: var(--radius); background: var(--bg-elev);
}
.empty h3 { margin: 0 0 .35rem; color: var(--ink); font-size: 1rem; }
.pill {
  display: inline-block; border-radius: 999px; padding: .08rem .5rem;
  font-size: 11px; font-weight: 650; border: 1px solid var(--line);
}
.pill.evaluated, .pill.active, .pill.queued, .pill.eligible { color: var(--accent); background: #10251f; border-color: #1f5f4e; }
.pill.applied, .pill.submitted { color: var(--info); background: #152230; border-color: #355a7a; }
.pill.rejected, .pill.expired, .pill.failed, .pill.near_miss { color: #ffb4bc; background: var(--danger-bg); border-color: #5d2430; }
.pill.discarded, .pill.skipped { color: var(--muted); background: #1b2329; }
.note {
  color: var(--muted); font-size: 12.5px; margin: .4rem 0 0;
}
.model-line {
  display: flex; flex-wrap: wrap; gap: .35rem; margin: .45rem 0 0;
}
.model-line .pill .n {
  font-family: var(--mono); font-weight: 500; margin-left: .3rem; color: var(--faint);
}
.hygiene-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: .65rem; }
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: .9rem;
}
.card h3 { margin: 0 0 .3rem; font-size: 14px; }
.card .row { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .7rem; }
.filter-row { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin: 0 0 .55rem; }
.filter-chip {
  appearance: none; border: 1px solid var(--line); background: var(--bg-elev);
  color: var(--muted); border-radius: 999px; padding: .2rem .55rem; font-size: 11.5px; font-weight: 600;
}
.filter-chip.active { color: var(--accent); border-color: #1f5f4e; background: #10251f; }
.filter-chip .n { font-family: var(--mono); margin-left: .25rem; color: inherit; opacity: .85; }
.apply-grid { display: grid; grid-template-columns: 1.4fr .9fr; gap: .75rem; }
@media (max-width: 980px) { .apply-grid { grid-template-columns: 1fr; } }
.table-wrap td a { color: var(--ink); text-decoration: none; }
.table-wrap td a:hover { color: var(--accent); }
.attempt-role a { color: var(--ink); text-decoration: none; font-weight: 600; }
.attempt-role a:hover { color: var(--accent); }
.row-menu {
  position: fixed; z-index: 40; min-width: 11rem;
  background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: .25rem; box-shadow: 0 8px 24px rgba(0,0,0,.35);
}
.row-menu button {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: transparent; border: 0; color: var(--ink);
  padding: .45rem .6rem; border-radius: 6px; font: inherit;
}
.row-menu button:hover { background: var(--bg-elev); color: var(--accent); }
.attempt-meta { color: var(--faint); font-size: 11.5px; margin-top: .15rem; }
.attempt-meta a { color: var(--accent); font-weight: 600; text-decoration: underline; }
.blocker-pills { display: flex; flex-wrap: wrap; gap: .25rem; margin-bottom: .35rem; }
.attempt-details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
.attempt-details ul { margin: .35rem 0 0; padding-left: 1.1rem; }
.attempt-shots { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .45rem; }
.attempt-shots img {
  max-width: min(100%, 280px); border: 1px solid var(--line); border-radius: 8px; background: #0a0e12;
}
.pill.needs_review, .pill.waiting_login, .pill.submission_unknown { color: var(--warn); background: var(--warn-bg); border-color: #6a5424; }
.compact-list { margin: .45rem 0 0; padding: 0; list-style: none; }
.compact-list li { display: flex; gap: .45rem; align-items: baseline; margin: .28rem 0; }
.compact-list .pill { flex: 0 0 auto; }
.stack-actions { display: flex; flex-direction: column; gap: .3rem; align-items: flex-start; }
.job-dock {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 13;
  margin: 0; padding: .55rem .85rem .7rem;
  background: rgba(18,26,32,.96);
  border-top: 1px solid var(--line);
  backdrop-filter: blur(12px);
}
.job-dock.idle { display: none; }
.job-bar-meta { display: flex; gap: .7rem; align-items: flex-start; flex-wrap: wrap; }
.job-bar-meta strong { flex: 0 0 auto; padding-top: .15rem; }
.job-bar-meta button { flex: 0 0 auto; }
.job-bar-meta .grow {
  flex: 1 1 14rem;
  min-width: 12rem;
  overflow: visible;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.35;
}
.meter { height: .38rem; margin-top: .45rem; background: #24313a; border-radius: 99px; overflow: hidden; }
.meter > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, var(--accent-dim), var(--accent)); transition: width .25s; }
.log {
  max-height: 12rem; overflow: auto; margin: .55rem 0 0;
  background: #070b0e; color: #c9d6de; font: 12px/1.4 var(--mono);
  padding: .6rem .7rem; border-radius: 8px; white-space: pre-wrap;
}
.log:empty, .log.collapsed { display: none; }
.drawer {
  position: fixed; inset: 0; z-index: 30; display: none;
  background: rgba(0,0,0,.45);
}
.drawer.open { display: block; }
.drawer-panel {
  position: absolute; top: 0; right: 0; height: 100%; width: min(40rem, 100%);
  background: var(--bg-elev); border-left: 1px solid var(--line);
  display: flex; flex-direction: column; box-shadow: var(--shadow);
}
.drawer-head { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; border-bottom: 1px solid var(--line); }
.drawer pre { flex: 1; margin: 0; overflow: auto; padding: 1rem; white-space: pre-wrap; }
.dialog-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  display: none; align-items: center; justify-content: center; z-index: 40;
}
.dialog-backdrop.open { display: flex; }
.dialog {
  background: var(--panel); border-radius: 14px; padding: 1.1rem 1.15rem;
  width: min(28rem, calc(100vw - 2rem)); border: 1px solid var(--line);
  box-shadow: var(--shadow);
}
.dialog h3 { margin: 0 0 .4rem; }
.dialog .row { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1rem; }
.toasts { position: fixed; right: 1rem; bottom: 4.6rem; z-index: 50; display: flex; flex-direction: column; gap: .4rem; }
.toast {
  background: var(--panel-2); border: 1px solid var(--line); color: var(--ink);
  padding: .55rem .75rem; border-radius: 10px; min-width: 14rem; max-width: 22rem;
  box-shadow: var(--shadow);
}
.toast.err { border-color: #5d2430; }
@media (max-width: 860px) {
  .funnel-nav { grid-template-columns: repeat(3, minmax(0,1fr)); }
  .shell { padding-bottom: 8rem; }
  .field input[type=text] { width: 9rem; }
}
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="mark">CO</div>
    <div>
      <h1>Career-Ops</h1>
      <small>Local funnel operator · 127.0.0.1</small>
    </div>
  </div>
  <div class="chips">
    <span class="chip" id="host-chip">host</span>
    <span class="chip warn" id="mode-chip">loading</span>
    <span class="chip" id="otp-chip">Gmail OTP</span>
    <span class="chip" id="cdp-chip">CDP</span>
    <span class="chip job hidden" id="job-chip"><span class="dot pulse"></span><span id="job-chip-text">idle</span></span>
  </div>
</header>
<nav class="funnel-nav" id="tabs" aria-label="Funnel stages">
  <button type="button" data-tab="overview" class="active"><span class="kicker">00</span><span class="label">Overview</span></button>
  <button type="button" data-tab="discovery"><span class="kicker">01 discover</span><span class="label">Discovery <span class="count" id="nav-discovery">0</span></span></button>
  <button type="button" data-tab="evaluate"><span class="kicker">02 evaluate</span><span class="label">Evaluate <span class="count" id="nav-evaluate">0</span></span></button>
  <button type="button" data-tab="tracker"><span class="kicker">03 track</span><span class="label">Tracker <span class="count" id="nav-tracker">0</span></span></button>
  <button type="button" data-tab="hygiene"><span class="kicker">04 hygiene</span><span class="label">Hygiene</span></button>
</nav>
<main class="shell">
  <section class="panel" data-panel="overview">
    <div class="hero">
      <div>
        <h2 id="overview-title">Ready when you are</h2>
        <p class="muted" id="next-hint">Loading funnel…</p>
      </div>
      <button type="button" class="action" id="continue-next">Continue next step</button>
    </div>
    <div class="stats" id="overview-stats"></div>
    <p class="note">Qualification, shadow, and canary stay CLI-only. Cover letters and resume PDFs stay out of this app. Apply runs with submit=true; submissionGate still gates the Submit click.</p>
  </section>
  <section class="panel hidden" data-panel="discovery">
    <div class="hero">
      <div>
        <h2>Discovery</h2>
        <p class="muted">Zero-token scan into <span class="mono">scan-results-*.tsv</span>. Scan does not write the tracker. Check visible rows and evaluate them together. Select all shown follows the ATS chips.</p>
        <p class="model-line" id="discovery-models"></p>
      </div>
    </div>
    <div class="toolbar">
      <button type="button" class="action" data-job="scan_all">Run scan:all</button>
      <label class="field"><input type="checkbox" id="scan-dry-run"> dry-run</label>
      <label class="field">skip <input type="text" id="scan-skip" placeholder="adzuna,hiringcafe"></label>
      <span class="grow"></span>
      <button type="button" class="ghost" data-job="scan">scan</button>
      <button type="button" class="ghost" data-job="scan_spa">scan:spa</button>
    </div>
    <article class="card" id="handshake-card" style="margin:.75rem 0 1rem">
      <h3>Handshake live eval + apply</h3>
      <p class="muted">Not part of scan:all. Career-Ops attaches to the Chrome window already signed into Handshake. Enable Remote Debugging at chrome://inspect/#remote-debugging and click Allow when Chrome asks. Scores each posting with the existing Evaluate judge and applies when the score is 3.5 or higher. Submit still goes through submissionGate.</p>
      <p class="muted" id="handshake-ready"></p>
      <p class="muted" id="handshake-filters">Filters: Full-Time · United States · remote · 21 days · hide applied</p>
      <div class="row">
        <label class="field">max <input type="number" id="handshake-max" value="10" min="1" max="50"></label>
        <button type="button" class="action" data-job="handshake_session" data-confirm="Handshake session will open job-search in your signed-in Chrome, apply Career-Ops filters, evaluate each posting with the existing Evaluate judge, and apply when the score is 3.5 or higher. Submit still goes through submissionGate.">Session (eval + apply if 3.5+)</button>
        <button type="button" class="ghost" data-job="handshake_job" data-confirm="Evaluate the open Handshake job tab with the existing Evaluate judge and apply if the score is 3.5 or higher. Submit still goes through submissionGate.">Current Handshake tab</button>
        <button type="button" class="ghost" data-job="handshake_doctor">Handshake doctor</button>
      </div>
    </article>
    <div class="section-head"><h3>Triage backlog</h3><span class="muted" id="triage-meta"></span></div>
    <div class="filter-row" id="triage-ats-filters"></div>
    <div class="toolbar">
      <button type="button" class="ghost" id="select-triage">Select all shown</button>
      <button type="button" class="action" id="evaluate-selected" data-job="evaluate_row" data-selected="1">Evaluate selected</button>
      <span class="muted" id="triage-selected-meta"></span>
    </div>
    <div id="triage-table"></div>
    <div class="section-head"><h3>Recent scan history</h3></div>
    <div id="history-table"></div>
  </section>
  <section class="panel hidden" data-panel="evaluate">
    <div class="hero">
      <div>
        <h2>Evaluate</h2>
        <p class="muted">Plan prunes rejects and saves the queue. Judge / sweep / overflow score <b>only</b> that queue.</p>
        <p class="model-line" id="evaluate-models"></p>
      </div>
    </div>
    <div class="toolbar">
      <label class="field">Plan max <input type="number" id="plan-max" value="25" min="1" max="500"></label>
      <button type="button" class="action" data-job="evaluate_plan">Plan</button>
      <button type="button" class="action" data-job="evaluate_judge" data-confirm="Judge will call Flash High and write reports + tracker rows.">Judge</button>
      <button type="button" class="ghost" data-job="evaluate_sweep" data-confirm="Sweep will score the queue via Cerebras and write commits.">Sweep</button>
      <button type="button" class="ghost" data-job="evaluate_overflow" data-confirm="Overflow will score the queue via Groq and write commits.">Overflow</button>
      <span class="grow"></span>
      <button type="button" class="ghost" id="select-queue">Select all</button>
      <button type="button" class="danger" id="remove-queue">Remove selected</button>
    </div>
    <div class="section-head"><h3>Eval queue</h3><span class="muted" id="queue-meta"></span></div>
    <div id="queue-table"></div>
  </section>
  <section class="panel hidden" data-panel="tracker">
    <div class="hero">
      <div>
        <h2>Tracker</h2>
        <p class="muted">One row per tracker number. Attempt wins; else Eligible, Near-miss, or tracker Status. Dedicated Chrome enqueue needs Evaluated · 4.0+ · <code>APPLY</code> or <code>CONSIDER</code>. Handshake live apply uses floor 3.5 in the signed-in Chrome session. Submit still requires submissionGate.</p>
        <p class="model-line" id="tracker-models"></p>
      </div>
    </div>
    <div class="toolbar">
      <button type="button" class="action" data-job="apply_enqueue" data-confirm="Enqueue eligible Evaluated APPLY and CONSIDER rows into the attempt store.">Enqueue eligible</button>
      <button type="button" class="ghost" data-job="apply_run" data-confirm="Run queued attempts with submit=true. submissionGate still has to permit the Submit click.">Run queued</button>
      <button type="button" class="ghost" data-job="handshake_doctor">Handshake doctor</button>
      <button type="button" class="ghost" id="refresh-status">Refresh</button>
      <label class="field">Find <input type="text" id="attempt-filter" placeholder="# / company / role / ATS / status"></label>
      <span class="grow"></span>
      <span class="muted" id="apply-meta"></span>
    </div>
    <div class="stats" id="apply-stats"></div>
    <div class="section-head">
      <h3>Pipeline</h3>
      <span class="muted" id="attempts-meta"></span>
    </div>
    <div class="filter-row" id="attempt-state-filters"></div>
    <div class="filter-row" id="attempt-ats-filters"></div>
    <div id="attempts-table"></div>
    <div class="apply-grid" style="margin-top:1rem">
      <div>
        <div class="section-head"><h3>Readiness</h3><span class="muted" id="doctor-meta"></span></div>
        <div id="doctor-panel" class="card"></div>
      </div>
      <div>
        <div class="section-head"><h3>Analytics</h3><span class="muted" id="analytics-meta"></span></div>
        <div id="analytics-panel" class="card"></div>
      </div>
    </div>
  </section>
  <section class="panel hidden" data-panel="hygiene">
    <div class="hero">
      <div>
        <h2>Hygiene</h2>
        <p class="muted">Dry-run first. Writes to the tracker need an explicit confirm.</p>
      </div>
    </div>
    <div class="hygiene-grid">
      <article class="card">
        <h3>Verify</h3>
        <p class="muted">Validate tracker rows, statuses, scores, and report links. Read-only.</p>
        <div class="row"><button type="button" class="action" data-job="verify">Verify</button></div>
      </article>
      <article class="card">
        <h3>Normalize</h3>
        <p class="muted">Canonical status labels in applications.md.</p>
        <div class="row">
          <button type="button" class="ghost" data-job="normalize">Dry-run</button>
          <button type="button" class="danger" data-job="normalize" data-apply="1" data-confirm="Apply normalize writes to applications.md.">Apply</button>
        </div>
      </article>
      <article class="card">
        <h3>Dedup</h3>
        <p class="muted">Detect duplicate tracker rows.</p>
        <div class="row">
          <button type="button" class="ghost" data-job="dedup">Dry-run</button>
          <button type="button" class="danger" data-job="dedup" data-apply="1" data-confirm="Apply dedup writes to applications.md.">Apply</button>
        </div>
      </article>
      <article class="card">
        <h3>Merge</h3>
        <p class="muted">Merge tracker-addition TSVs. Only if those files exist.</p>
        <div class="row">
          <button type="button" class="ghost" data-job="merge">Dry-run</button>
          <button type="button" class="danger" data-job="merge" data-apply="1" data-confirm="Apply merge writes tracker rows from additions.">Apply</button>
        </div>
      </article>
    </div>
  </section>
</main>
<div class="job-dock idle" id="job-dock">
  <div class="job-bar-meta">
    <strong id="job-title">Idle</strong>
    <span class="muted grow" id="progress-text"></span>
    <button type="button" class="ghost" id="toggle-log" disabled>Log</button>
    <button type="button" class="danger hidden" id="cancel-job">Cancel</button>
    <button type="button" class="quiet" id="dismiss-job">Dismiss</button>
  </div>
  <div class="meter" aria-hidden="true"><i id="job-meter"></i></div>
  <pre class="log collapsed" id="log"></pre>
</div>
<div class="drawer" id="report-drawer">
  <div class="drawer-panel">
    <div class="drawer-head">
      <strong id="report-title">Report</strong>
      <button type="button" class="ghost" id="close-report">Close</button>
    </div>
    <pre id="report-view" class="mono"></pre>
  </div>
</div>
<div class="dialog-backdrop" id="confirm-dialog">
  <div class="dialog" role="dialog" aria-modal="true">
    <h3>Confirm write</h3>
    <p id="confirm-text"></p>
    <div class="row">
      <button type="button" class="ghost" id="confirm-cancel">Cancel</button>
      <button type="button" class="action" id="confirm-ok">Confirm</button>
    </div>
  </div>
</div>
<div class="toasts" id="toasts"></div>
<div id="row-menu" class="row-menu hidden" role="menu">
  <button type="button" data-row-menu="copy-job" role="menuitem">Copy job link</button>
</div>
<script>
let csrf = ${JSON.stringify(csrfToken)};
let writable = ${JSON.stringify(Boolean(writable))};
let applicationsEnabled = ${JSON.stringify(Boolean(applicationsEnabled))};
let status = null;
let confirmAction = null;
let activeTab = 'overview';
let activeJobAction = null;
const JOB_LABELS = {
  scan_all: 'scan:all',
  scan: 'scan',
  scan_spa: 'scan:spa',
  evaluate_plan: 'Plan',
  evaluate_judge: 'Judge',
  evaluate_sweep: 'Sweep',
  evaluate_overflow: 'Overflow',
  evaluate_row: 'Evaluate',
  verify: 'Verify',
  normalize: 'Normalize',
  dedup: 'Dedup',
  merge: 'Merge',
  apply_enqueue: 'Enqueue',
  apply_run: 'Apply run',
  apply_row: 'Apply',
  apply_retry: 'Resume',
  tracker_discard: 'Discard',
  tracker_mark_applied: 'Mark applied',
  handshake_doctor: 'Handshake doctor',
  handshake_job: 'Handshake tab',
  handshake_session: 'Handshake session',
};
function jobLabel(action) { return JOB_LABELS[action] || action || 'Job'; }
function progressLine(p = {}) {
  const bits = [
    p.stage,
    p.phase,
    p.tracker_number != null ? '#' + p.tracker_number : null,
    p.step != null ? 'step ' + p.step : null,
    Number.isFinite(Number(p.done)) && Number(p.total) ? p.done + '/' + p.total : null,
    p.company,
    p.title,
    p.result,
    p.code,
    p.error,
  ].filter(Boolean);
  return bits.join(' · ') || 'working…';
}
const PIPELINE_STATES = [
  'ELIGIBLE','NEAR_MISS','QUEUED','RUNNING','READY_TO_SUBMIT','WAITING_LOGIN','NEEDS_REVIEW','SUBMISSION_UNKNOWN',
  'FAILED','SKIPPED','SUBMITTED',
  'EVALUATED','APPLIED','RESPONDED','INTERVIEW','OFFER','REJECTED','REJECTED_AT_EVAL','DISCARDED','PURGED',
];
const DEFAULT_PIPELINE_STATES = new Set(['ELIGIBLE','NEAR_MISS','QUEUED','RUNNING','READY_TO_SUBMIT','NEEDS_REVIEW','WAITING_LOGIN','SUBMISSION_UNKNOWN']);
let attemptStateFilter = new Set(DEFAULT_PIPELINE_STATES);
let attemptAtsFilter = new Set();
let seenAttemptAts = new Set();
let triageRowsCache = [];
let triageAtsFilter = new Set();
let seenTriageAts = new Set();
let triageSelected = new Set();
const TABS = ['overview','discovery','evaluate','tracker','hygiene'];
const NEXT_COPY = {
  discovery: ['Scan for new postings', 'Run scan:all to fill the triage backlog.'],
  evaluate: ['Plan, then judge the queue', 'Prune rejects, then score only the saved eval queue.'],
  apply: ['Work the tracker', 'One row per posting. Attempt wins; else Eligible, Near-miss, or tracker Status.'],
  tracker: ['Work the tracker', 'One row per posting. Attempt wins; else Eligible, Near-miss, or tracker Status. Work queue hides Submitted, Applied, and Rejected unless you toggle them.'],
  hygiene: ['Verify tracker integrity', 'Dry-run hygiene before any write.'],
};

const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pill = (label, cls) => '<span class="pill '+esc(cls || String(label).toLowerCase())+'">'+esc(label)+'</span>';

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  document.querySelector('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function emptyState(title, body) {
  return '<div class="empty"><h3>'+esc(title)+'</h3><p>'+esc(body)+'</p></div>';
}

function tableHtml(headers, rowsHtml, emptyTitle, emptyBody) {
  if (!rowsHtml) return emptyState(emptyTitle, emptyBody);
  return '<div class="table-wrap"><table><thead><tr>'+headers.map(h => '<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rowsHtml+'</tbody></table></div>';
}

function setTab(name) {
  if (name === 'apply') name = 'tracker';
  if (!TABS.includes(name)) name = 'overview';
  activeTab = name;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}

function highlightNext() {
  const next = status && (status.next_step === 'apply' ? 'tracker' : status.next_step);
  document.querySelectorAll('#tabs button').forEach(b => {
    b.classList.toggle('next-hint', Boolean(next) && b.dataset.tab === next);
    if (b.classList.contains('active')) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

async function api(path, options = {}, retried = false) {
  const headers = { ...(options.headers || {}) };
  const rawBody = options.body;
  let body = rawBody;
  if (options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
  if (rawBody && typeof rawBody === 'object') {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ ...rawBody, csrf });
  }
  const res = await fetch(path, { ...options, headers, body });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  adoptCsrf(data);
  if (!res.ok && data.code === 'CSRF_DENIED' && !retried && options.method && options.method !== 'GET') {
    await refreshCsrf();
    return api(path, options, true);
  }
  if (!res.ok) throw new Error(data.error || data.message || text || res.statusText);
  return data;
}

function adoptCsrf(data) {
  if (data && typeof data.csrf === 'string' && /^[a-f0-9]{48}$/.test(data.csrf)) csrf = data.csrf;
}

async function refreshCsrf() {
  const res = await fetch('/api/status');
  const data = await res.json().catch(() => ({}));
  adoptCsrf(data);
}

function showProgress(active, text, ratio) {
  const dock = document.querySelector('#job-dock');
  const chip = document.querySelector('#job-chip');
  const keepDock = Boolean(active || text);
  dock.classList.toggle('idle', !keepDock);
  document.body.classList.toggle('job-open', keepDock);
  if (text) document.querySelector('#progress-text').textContent = text;
  document.querySelector('#job-title').textContent = jobLabel(activeJobAction);
  chip.classList.toggle('hidden', !active);
  document.querySelector('#job-chip-text').textContent = (active ? jobLabel(activeJobAction) + ' · ' : '') + (text || 'idle');
  document.querySelector('#cancel-job').classList.toggle('hidden', !active);
  const meter = document.querySelector('#job-meter');
  const pct = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) * 100 : (active ? 12 : 0);
  meter.style.width = pct + '%';
}

function formatJobLine(job) {
  if (!job) return '';
  const summary = job.result_summary || {};
  if (summary.message) return summary.message;
  if (job.error && job.error.message) return job.action + ' failed: ' + job.error.message;
  if (job.status === 'done') return (job.action || 'Job') + ' finished';
  return (job.action || 'Job') + ' · ' + (job.status || '');
}

function syncLogButton() {
  const log = document.querySelector('#log');
  const has = Boolean(log.textContent.trim());
  document.querySelector('#toggle-log').disabled = !has;
  if (!has) log.classList.add('collapsed');
}

function appendLog(text) {
  if (!text) return;
  const log = document.querySelector('#log');
  log.textContent += text;
  log.scrollTop = log.scrollHeight;
  if (log.textContent.trim()) {
    log.classList.remove('collapsed');
    document.querySelector('#toggle-log').disabled = false;
  }
}

function gateButtons() {
  document.querySelectorAll('[data-job="scan_all"],[data-job="scan"],[data-job="scan_spa"],[data-job="evaluate_plan"],[data-job="evaluate_judge"],[data-job="evaluate_sweep"],[data-job="evaluate_overflow"],[data-job="evaluate_row"],[data-job="normalize"],[data-job="dedup"],[data-job="merge"],[data-job="apply_enqueue"],[data-job="tracker_discard"],[data-job="tracker_mark_applied"],[data-job="handshake_doctor"],#remove-queue,#select-queue,#select-triage,#evaluate-selected').forEach(btn => {
    const blocked = btn.dataset.blocked === '1';
    btn.disabled = !writable || blocked;
  });
  document.querySelectorAll('[data-job="verify"]').forEach(btn => { btn.disabled = false; });
  const handshakeOn = Boolean(status && status.handshake && status.handshake.enabled);
  document.querySelectorAll('[data-job="apply_run"],[data-job="apply_row"],[data-job="apply_retry"]').forEach(btn => {
    const blocked = btn.dataset.blocked === '1';
    btn.disabled = !writable || !applicationsEnabled || blocked;
  });
  document.querySelectorAll('[data-job="handshake_job"],[data-job="handshake_session"]').forEach(btn => {
    const blocked = btn.dataset.blocked === '1';
    btn.disabled = !writable || !applicationsEnabled || !handshakeOn || blocked;
    btn.title = handshakeOn
      ? ''
      : 'Set applications.main_profile.enabled: true and ats: [handshake] in config/runtime.local.yml';
  });
}

function renderOverview() {
  if (!status) return;
  const s = status;
  const next = s.next_step || 'discovery';
  const copy = NEXT_COPY[next] || ['Continue', ''];
  document.querySelector('#overview-title').textContent = copy[0];
  document.querySelector('#next-hint').textContent = copy[1] + (s.current_job ? ' · job ' + s.current_job.action + ' (' + s.current_job.status + ')' : '');
  document.querySelector('#continue-next').textContent = 'Go to ' + next;
  document.querySelector('#nav-discovery').textContent = s.discovery.triage_count;
  document.querySelector('#nav-evaluate').textContent = s.evaluate.queue_count;
  document.querySelector('#nav-tracker').textContent = s.apply.work_queue_count ?? s.apply.eligible_count;
  document.querySelector('#overview-stats').innerHTML = [
    ['discovery', 'Triage', s.discovery.triage_count],
    ['evaluate', 'Eval queue', s.evaluate.queue_count],
    ['tracker', 'Tracker', s.tracker.total],
    ['tracker', 'Evaluated', s.tracker.status_counts.Evaluated || 0],
    ['tracker', 'Applied', s.tracker.status_counts.Applied || 0],
    ['tracker', 'Rejected', s.tracker.status_counts.Rejected || 0],
    ['tracker', 'Apply eligible', s.apply.eligible_count],
    ['tracker', 'Near-miss', s.apply.near_miss_count || 0],
  ].map(([tab,k,v]) => '<button type="button" class="stat" data-jump="'+tab+'"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></button>').join('');
  const mode = document.querySelector('#mode-chip');
  const host = document.querySelector('#host-chip');
  const otpChip = document.querySelector('#otp-chip');
  const otp = s.apply?.doctor?.gmail_otp;
  if (!otp) {
    otpChip.className = 'chip';
    otpChip.textContent = 'Gmail OTP unknown';
    otpChip.title = 'Launch with --config to check email verification.';
  } else if (otp.ready && Number(otp.expires_in_seconds) > 0 && Number(otp.expires_in_seconds) <= 2 * 86400) {
    otpChip.className = 'chip warn';
    otpChip.textContent = 'Gmail OTP re-auth soon';
    otpChip.title = otp.detail || 'Testing-app Gmail token expires within 2 days.';
  } else if (otp.ready) {
    otpChip.className = 'chip ok';
    otpChip.textContent = Number(otp.expires_in_seconds) > 0
      ? 'Gmail OTP ready · ' + Math.floor(Number(otp.expires_in_seconds) / 86400) + 'd'
      : 'Gmail OTP ready';
    otpChip.title = otp.detail || 'Greenhouse email codes can be read from Gmail.';
  } else if (otp.enabled) {
    otpChip.className = 'chip warn';
    otpChip.textContent = 'Gmail OTP broken';
    otpChip.title = otp.detail || 'Gmail OTP is on but not ready.';
  } else {
    otpChip.className = 'chip';
    otpChip.textContent = 'Gmail OTP off';
    otpChip.title = otp.detail || 'Email verification will wait for a pause or a pasted code.';
  }
  renderCdpChip(s);
  renderHandshakeCard(s);
  host.textContent = s.observed_host || 'this host';
  if (!s.writable) {
    mode.className = 'chip warn';
    mode.textContent = 'read-only';
  } else {
    mode.className = 'chip ok';
    mode.textContent = s.applications_enabled ? 'writable · apply on' : 'writable · apply gated';
  }
  writable = s.writable;
  applicationsEnabled = s.applications_enabled;
  gateButtons();
  highlightNext();
}

function renderCdpChip(s) {
  const chip = document.querySelector('#cdp-chip');
  if (!chip) return;
  const hs = s.handshake || {};
  if (!hs.enabled) {
    chip.className = 'chip';
    chip.textContent = 'CDP off';
    chip.title = hs.detail || 'Handshake main_profile disabled';
    return;
  }
  if (hs.cdp_ok) {
    chip.className = 'chip ok';
    if (hs.attach === 'live') chip.textContent = 'Live Chrome';
    else chip.textContent = hs.logged_in ? 'CDP connected' : 'CDP · no Handshake login';
  } else {
    chip.className = 'chip warn';
    chip.textContent = 'CDP down';
  }
  chip.title = hs.detail || '';
}

function renderHandshakeCard(s) {
  const el = document.querySelector('#handshake-filters');
  const ready = document.querySelector('#handshake-ready');
  const hs = s && s.handshake || {};
  if (ready) {
    if (!hs.enabled) {
      ready.textContent = 'Handshake is gated until applications.main_profile.enabled is true and ats includes handshake.';
    } else if (!hs.cdp_ok) {
      ready.textContent = 'Cannot see the open Chrome yet. In that window open chrome://inspect/#remote-debugging and enable Remote Debugging. When you click Session, bring Chrome to the front and click Allow on the second Allow dialog.';
    } else if (hs.attach === 'live') {
      ready.textContent = hs.detail || 'Inspect is on. Click Session, then immediately Allow the Chrome dialog. The inspect toggle is not enough.';
    } else if (!hs.logged_in) {
      ready.textContent = 'CDP is connected. Open a signed-in Handshake tab in that Chrome window.';
    } else {
      ready.textContent = hs.detail || 'CDP connected. Session will apply the filters below.';
    }
  }
  if (!el) return;
  const filters = hs.filters || {};
  const bits = [
    (filters.job_types || []).join(', ') || 'Full-Time',
    (filters.locations || []).join(', ') || 'United States',
    filters.include_remote ? 'remote' : null,
    filters.posted_within_days ? filters.posted_within_days + ' days' : null,
    filters.hide_applied ? 'hide applied' : null,
    'floor ' + (hs.apply_score_minimum ?? 3.5),
  ].filter(Boolean);
  el.textContent = 'Filters Career-Ops will apply: ' + bits.join(' · ');
}

function renderPhaseModels(tab, items) {
  const el = document.querySelector('#' + tab + '-models');
  if (!el) return;
  const rows = Array.isArray(items) ? items : [];
  el.innerHTML = rows.map(item => {
    const model = item.model && item.model !== 'none' ? item.model : (item.detail || 'none');
    const title = [item.provider_id, item.detail].filter(Boolean).join(' · ');
    return '<span class="pill"' + (title ? ' title="'+esc(title)+'"' : '') + '>'+esc(item.role)+' <span class="n">'+esc(model)+'</span></span>';
  }).join('');
}

function renderDiscovery() {
  if (!status) return;
  renderPhaseModels('discovery', status.discovery && status.discovery.models);
  renderHandshakeCard(status);
  if (!triageRowsCache.length) {
    document.querySelector('#triage-meta').textContent = status.discovery.triage_count + ' rows · ' + (status.discovery.triage_files || []).map(f => f.split('/').pop()).join(', ');
  }
}

function visibleTriageRows() {
  return triageRowsCache.filter(row => triageAtsFilter.has(row.ats || 'unknown'));
}

function shownTriageSelection() {
  return visibleTriageRows().map(row => row.url).filter(url => url && triageSelected.has(url));
}

function syncTriageSelectionMeta() {
  const shown = shownTriageSelection().length;
  const visible = visibleTriageRows().length;
  const el = document.querySelector('#triage-selected-meta');
  if (el) el.textContent = shown ? shown + ' selected of ' + visible + ' shown' : visible ? 'None selected' : '';
}

function triageRowHtml(r) {
  const checked = triageSelected.has(r.url) ? ' checked' : '';
  return '<tr><td><input type="checkbox" data-triage-url="'+esc(r.url)+'"'+checked+'></td><td>'+(r.url ? '<a href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.company)+'</a>' : esc(r.company))+'</td><td class="clip">'+(r.url ? '<a href="'+esc(r.url)+'" target="_blank" rel="noopener">'+esc(r.title)+'</a>' : esc(r.title))+'</td><td>'+pill(r.ats || 'unknown')+'</td><td class="mono">'+esc(r.source)+'</td><td>'+evaluateRowButton(r)+'</td></tr>';
}

function renderTriageTable() {
  const rows = triageRowsCache;
  const atsSeen = [...new Set(rows.map(item => item.ats || 'unknown'))].sort();
  for (const ats of atsSeen) {
    if (!seenTriageAts.has(ats)) {
      seenTriageAts.add(ats);
      triageAtsFilter.add(ats);
    }
  }
  for (const ats of [...triageAtsFilter]) {
    if (!atsSeen.includes(ats)) triageAtsFilter.delete(ats);
  }
  if (atsSeen.length && !triageAtsFilter.size) {
    for (const ats of atsSeen) triageAtsFilter.add(ats);
  }
  const counts = {};
  for (const row of rows) {
    const ats = row.ats || 'unknown';
    counts[ats] = (counts[ats] || 0) + 1;
  }
  const filters = document.querySelector('#triage-ats-filters');
  filters.innerHTML = atsSeen.length
    ? atsSeen.map(ats => '<button type="button" class="filter-chip'+(triageAtsFilter.has(ats)?' active':'')+'" data-triage-ats="'+esc(ats)+'">'+esc(ats)+'<span class="n">'+(counts[ats] || 0)+'</span></button>').join('')
    : '<span class="muted">No ATS labels yet</span>';
  const visible = visibleTriageRows();
  const known = new Set(rows.map(row => row.url).filter(Boolean));
  for (const url of [...triageSelected]) {
    if (!known.has(url)) triageSelected.delete(url);
  }
  const files = status && status.discovery && status.discovery.triage_files
    ? status.discovery.triage_files.map(f => f.split('/').pop()).join(', ')
    : '';
  document.querySelector('#triage-meta').textContent = visible.length + ' shown · ' + rows.length + ' total' + (files ? ' · ' + files : '');
  document.querySelector('#triage-table').innerHTML = tableHtml(
    ['','Company','Title','ATS','Source',''],
    visible.map(triageRowHtml).join(''),
    'No matching triage rows',
    'Toggle an ATS chip or run scan:all to collect postings into scan-results TSV.'
  );
  syncTriageSelectionMeta();
  gateButtons();
}

async function loadTriage() {
  const data = await api('/api/triage');
  triageRowsCache = data.rows || [];
  renderTriageTable();
  const hist = (status && status.discovery.scan_history_tail || []).map(r =>
    '<tr><td>'+pill(r.status)+'</td><td class="mono clip">'+esc(r.url)+'</td><td>'+esc(r.detail)+'</td></tr>'
  ).join('');
  document.querySelector('#history-table').innerHTML = tableHtml(
    ['Status','URL','Detail'], hist,
    'No scan history yet', 'History appears after a discovery run.'
  );
}

function renderEvaluate() {
  if (!status) return;
  renderPhaseModels('evaluate', status.evaluate && status.evaluate.models);
  document.querySelector('#queue-meta').textContent = status.evaluate.queue_count + ' in queue';
  const rows = status.evaluate.queue.map(r =>
    '<tr><td><input type="checkbox" data-url="'+esc(r.url)+'"></td><td>'+esc(r.company)+'</td><td class="clip">'+esc(r.title)+'</td><td>'+esc(r.location)+'</td><td class="mono"><a href="'+esc(r.url)+'" target="_blank" rel="noopener">open</a></td></tr>'
  ).join('');
  document.querySelector('#queue-table').innerHTML = tableHtml(
    ['','Company','Title','Location','URL'], rows,
    'Queue empty', 'Run Plan to prune triage and save evaluate-queue.tsv.'
  );
}

function evaluateRowButton(r) {
  const confirm = 'Evaluate '+ (r.company || '') + ' - ' + (r.title || '') + '. Flash High will write a report and tracker row for this posting only.';
  return '<button type="button" class="action" data-job="evaluate_row" data-url="'+esc(r.url)+'" data-confirm="'+esc(confirm)+'" title="Evaluate this posting only. Writes a report and tracker row.">Evaluate</button>';
}

function applyRowButton({ trackerNumber, company, role, canApply, reason = '', nearMiss = false, eligible = false, ats = '' }) {
  const handshake = String(ats || '').toLowerCase() === 'handshake';
  const blocked = canApply ? '' : '1';
  const why = canApply
    ? (handshake
      ? 'Apply this Handshake row in the already-open Chrome. Dedicated Chrome is not used. submissionGate still gates Submit.'
      : (eligible
        ? 'Enqueue and run the auto-applier with submit=true. submissionGate still gates the Submit click.'
        : 'User-selected override: auto-applier with submit=true. submissionGate still gates the Submit click.'))
    : ('Cannot apply: ' + (reason || 'blocked')
      + (reason === 'unsupported_portal'
        ? ' — host is not an enabled ATS (local supported_ats allowlist)'
        : (nearMiss ? ' — add APPLY or CONSIDER to Notes, or a matching report recommendation' : '')));
  const confirm = handshake
    ? 'Apply #'+trackerNumber+' '+company+' - '+role+' in the already-open Handshake Chrome. Click Allow if Chrome asks. Submit still goes through submissionGate.'
    : 'Apply #'+trackerNumber+' '+company+' - '+role+' with submit=true. Chrome will open, the form will fill, and Submit will click only if submissionGate permits it.';
  return '<button type="button" class="action" data-job="apply_row" data-tracker="'+esc(trackerNumber)+'" data-blocked="'+blocked+'" data-confirm="'+esc(confirm)+'" title="'+esc(why)+'">Apply</button>';
}

function discardRowButton({ trackerNumber, company, role, discarded = false }) {
  const blocked = discarded ? '1' : '';
  const why = discarded
    ? 'Already Discarded'
    : 'Set tracker Status to Discarded. Open apply attempts that are not submitted will be skipped.';
  const confirm = 'Discard #'+trackerNumber+' '+company+' - '+role+'. Tracker status becomes Discarded. Open apply attempts that are not submitted will be skipped. This is your call, not an eval verdict.';
  return '<button type="button" class="danger" data-job="tracker_discard" data-tracker="'+esc(trackerNumber)+'" data-blocked="'+blocked+'" data-confirm="'+esc(confirm)+'" title="'+esc(why)+'">Discard</button>';
}

function markAppliedRowButton({ trackerNumber, company, role, applied = false }) {
  const blocked = applied ? '1' : '';
  const why = applied
    ? 'Tracker status is already Applied'
    : 'Set tracker Status to Applied. Does not submit the application.';
  const confirm = 'Mark #'+trackerNumber+' '+company+' - '+role+' as Applied. Tracker status becomes Applied and the date updates. This does not submit the application. Open apply attempts will be skipped.';
  return '<button type="button" class="ghost" data-job="tracker_mark_applied" data-tracker="'+esc(trackerNumber)+'" data-blocked="'+blocked+'" data-confirm="'+esc(confirm)+'" title="'+esc(why)+'">Mark applied</button>';
}

function renderApply() {
  if (!status) return;
  renderPhaseModels('tracker', status.tracker && status.tracker.models);
  const a = status.apply || {};
  const c = a.attempt_counts || {};
  const rows = a.pipeline || a.attempts || [];
  document.querySelector('#apply-meta').textContent =
    (a.actions_enabled ? 'actions on' : 'read-only actions')
    + ' · Work queue ' + (a.work_queue_count ?? 0)
    + ' · Eligible ' + (c.ELIGIBLE || 0)
    + ' · Near-miss ' + (c.NEAR_MISS || 0)
    + ' · Tracker ' + ((status.tracker && status.tracker.total) || 0);

  document.querySelector('#apply-stats').innerHTML = [
    ['Eligible', c.ELIGIBLE || 0, 'ELIGIBLE'],
    ['Near-miss', c.NEAR_MISS || 0, 'NEAR_MISS'],
    ['Queued', c.QUEUED || 0, 'QUEUED'],
    ['Needs review', c.NEEDS_REVIEW || 0, 'NEEDS_REVIEW'],
    ['Ready', c.READY_TO_SUBMIT || 0, 'READY_TO_SUBMIT'],
    ['Submitted', c.SUBMITTED || 0, 'SUBMITTED'],
  ].map(([k,v,filter]) => '<button type="button" class="stat" data-attempt-stat="'+esc(filter)+'"><b>'+esc(v)+'</b><span>'+esc(k)+'</span></button>').join('');

  const atsSeen = [...new Set(rows.map(item => item.ats || 'unknown'))].sort();
  for (const ats of atsSeen) {
    if (!seenAttemptAts.has(ats)) {
      seenAttemptAts.add(ats);
      attemptAtsFilter.add(ats);
    }
  }

  const extraStates = Object.keys(c).filter(state => !PIPELINE_STATES.includes(state)).sort();
  document.querySelector('#attempt-state-filters').innerHTML = PIPELINE_STATES.concat(extraStates).map(state => {
    const count = c[state] || 0;
    return '<button type="button" class="filter-chip'+(attemptStateFilter.has(state)?' active':'')+'" data-attempt-state="'+esc(state)+'">'+esc(state)+'<span class="n">'+count+'</span></button>';
  }).join('');
  document.querySelector('#attempt-ats-filters').innerHTML = atsSeen.length
    ? atsSeen.map(ats => '<button type="button" class="filter-chip'+(attemptAtsFilter.has(ats)?' active':'')+'" data-ats="'+esc(ats)+'">'+esc(ats)+'</button>').join('')
    : '<span class="muted">No ATS labels yet</span>';

  const q = (document.querySelector('#attempt-filter')?.value || '').trim().toLowerCase();
  const visible = rows.filter(item => {
    if (q) {
      const hay = [item.tracker_number, item.company, item.role, item.ats, item.state, item.canonical_url, item.external_url, item.external_host, item.score, item.date, item.source, item.tracker_status]
        .map(v => String(v || '').toLowerCase()).join(' ');
      return hay.includes(q);
    }
    if (!attemptStateFilter.has(item.state)) return false;
    if (atsSeen.length && !attemptAtsFilter.has(item.ats || 'unknown')) return false;
    return true;
  });
  document.querySelector('#attempts-meta').textContent = q
    ? visible.length + ' matches · search includes submitted and applied rows'
    : visible.length + ' shown · ' + rows.length + ' total';
  document.querySelector('#attempts-table').innerHTML = tableHtml(
    ['State','Role','Review','Resume / usage','Actions'],
    visible.map(attemptRowHtml).join(''),
    q ? 'No matching rows' : 'No matching pipeline rows',
    q
      ? 'Search looks through every state, including Submitted and Applied.'
      : 'Work queue hides Submitted, Skipped, Failed, Applied, Rejected, and Purged unless you toggle them.'
  );

  const doctor = a.doctor;
  const doctorEl = document.querySelector('#doctor-panel');
  const doctorMeta = document.querySelector('#doctor-meta');
  if (!doctor) {
    doctorMeta.textContent = 'needs --config';
    doctorEl.innerHTML = '<p class="muted">Launch with <code>--config</code> to check resumes, seed answers, and ATS allowlist.</p>';
  } else {
    doctorMeta.textContent = doctor.ready ? 'ready' : 'not ready';
    const checks = doctor.checks || [];
    const checkList = checks.length
      ? '<ul class="compact-list">'+checks.map(item => {
          const cls = item.ok ? 'active' : 'rejected';
          return '<li><span class="pill '+cls+'">'+(item.ok?'OK':'FAIL')+'</span><span><code>'+esc(item.code)+'</code> '+esc(item.detail)+'</span></li>';
        }).join('')+'</ul>'
      : (doctor.failed && doctor.failed.length
        ? '<ul class="compact-list">'+doctor.failed.map(item => '<li><code>'+esc(item.code)+'</code> '+esc(item.detail)+'</li>').join('')+'</ul>'
        : '<p class="muted">Configuration checks passed.</p>');
    doctorEl.innerHTML = '<p><span class="pill '+(doctor.ready?'active':'rejected')+'">'+(doctor.ready?'READY':'NOT READY')+'</span> '
      + esc(doctor.summary || '') + '</p>'
      + checkList;
  }

  const analytics = a.analytics;
  const analyticsMeta = document.querySelector('#analytics-meta');
  const analyticsEl = document.querySelector('#analytics-panel');
  if (!analytics) {
    analyticsMeta.textContent = 'no attempts yet';
    analyticsEl.innerHTML = '<p class="muted">Analytics appear after enqueue / run.</p>';
  } else {
    analyticsMeta.textContent = (analytics.attempt_count || 0) + ' attempts';
    const blockers = (analytics.top_blockers || []).map(b => '<span class="pill">'+esc(b.code)+' '+esc(b.count)+'</span>').join(' ') || '<span class="muted">none</span>';
    const ats = Object.entries(analytics.by_ats || {}).map(([k,v]) => esc(k)+':'+v).join(' · ') || '—';
    const conv = analytics.conversion || {};
    analyticsEl.innerHTML = '<p class="muted">ATS mix: '+ats+'</p>'
      + '<p class="muted">queued→ready '+(conv.queued_to_ready ?? '—')
      + ' · ready→submitted '+(conv.ready_to_submitted ?? '—')+'</p>'
      + '<div class="blocker-pills">'+blockers+'</div>';
  }
  gateButtons();
}

function applyLinkLabel(url) {
  try { return new URL(url).hostname.replace(/^www[.]/, ''); } catch { return 'Apply'; }
}

function linkifyDetail(detail) {
  const text = String(detail || '');
  const lower = text.toLowerCase();
  let start = lower.indexOf('https://');
  if (start < 0) start = lower.indexOf('http://');
  if (start < 0) return esc(text);
  let end = start;
  while (end < text.length && text[end] !== ' ' && text[end] !== '\\n' && text[end] !== ')') end += 1;
  let url = text.slice(start, end);
  while (/[),.;]$/.test(url)) url = url.slice(0, -1);
  return esc(text.slice(0, start))
    + '<a href="'+esc(url)+'" target="_blank" rel="noopener">'+esc(applyLinkLabel(url))+'</a>'
    + esc(text.slice(start + url.length));
}

function attemptRowHtml(x) {
  const actionsOn = Boolean(status?.apply?.actions_enabled);
  const blockers = (x.blockers || []).slice(0, 4).map(v => '<span class="pill">'+esc(v.code)+'</span>').join('');
  const blockerList = (x.blockers || []).map(v =>
    '<li><b>'+esc(v.code)+'</b>'+(v.question?' — '+esc(v.question):'')+(v.detail?'<div class="attempt-meta">'+linkifyDetail(v.detail)+'</div>':'')+'</li>'
  ).join('') || '<li>None</li>';
  const answers = (x.answers || []).map(v =>
    '<li>'+esc(v.field_id)+' — '+esc(v.provenance)+', '+(v.claims_validated?'validated':'needs review')+', '+esc(v.length)+' chars</li>'
  ).join('') || '<li>No generated answers</li>';
  const shots = x.idempotency_key
    ? (x.screenshots || []).map(n =>
      '<img alt="Redacted screenshot" src="/apply/api/screenshot/'+encodeURIComponent(x.idempotency_key)+'/'+encodeURIComponent(n)+'">'
    ).join('')
    : '';
  const usage = (x.provider_usage || []).map(u => [u.provider, u.input_tokens, u.output_tokens, u.total_tokens].filter(v => v !== null && v !== undefined && v !== '').join(' / ')).join('; ');
  const canApplyNow = ['QUEUED', 'READY_TO_SUBMIT', 'ELIGIBLE'].includes(x.state)
    || (x.kind === 'tracker' && Boolean(x.can_apply));
  const portalBlocked = (x.blockers || []).some(item => item.code === 'UNSUPPORTED_PORTAL')
    || x.apply_reason === 'unsupported_portal';
  const applyBtn = applyRowButton({
    trackerNumber: x.tracker_number,
    company: x.company,
    role: x.role,
    canApply: actionsOn && canApplyNow,
    reason: canApplyNow ? '' : (portalBlocked ? 'unsupported_portal' : (x.apply_reason || String(x.state || 'blocked').toLowerCase())),
    nearMiss: x.state === 'NEAR_MISS' || Boolean(x.apply_near_miss),
    eligible: x.state === 'ELIGIBLE' || x.kind === 'attempt' || Boolean(x.apply_eligible),
    ats: x.ats,
  });
  const discarded = String(x.tracker_status || '') === 'Discarded' || x.state === 'DISCARDED';
  const alreadyApplied = String(x.tracker_status || '') === 'Applied' || x.state === 'APPLIED' || x.state === 'SUBMITTED';
  const discardBtn = discardRowButton({
    trackerNumber: x.tracker_number,
    company: x.company,
    role: x.role,
    discarded,
  });
  const markAppliedBtn = markAppliedRowButton({
    trackerNumber: x.tracker_number,
    company: x.company,
    role: x.role,
    applied: alreadyApplied,
  });
  const controls = actionsOn && x.kind === 'attempt'
    ? (
      (['NEEDS_REVIEW','WAITING_LOGIN','FAILED'].includes(x.state)
        ? '<button type="button" class="action" data-job="apply_retry" data-key="'+esc(x.idempotency_key)+'">Resume</button>' : '')
      + (x.state === 'QUEUED' || x.state === 'READY_TO_SUBMIT'
        ? '<button type="button" class="ghost" data-attempt-action="skip" data-key="'+esc(x.idempotency_key)+'">Skip</button>' : '')
      + (x.state === 'SUBMISSION_UNKNOWN'
        ? '<button type="button" class="ghost" data-attempt-action="ack" data-key="'+esc(x.idempotency_key)+'">Acknowledge</button>' : '')
    )
    : (actionsOn ? '' : '<span class="muted">Read-only</span>');
  const stepLabel = x.kind === 'attempt' ? 'Step '+esc(x.step) : ([x.date, x.tracker_status || x.score].filter(Boolean).join(' · ') || 'Not enqueued');
  const jobUrl = /^https?:/i.test(String(x.canonical_url || '')) ? x.canonical_url : '';
  const applyUrl = /^https?:/i.test(String(x.external_url || '')) ? x.external_url : '';
  const applyHost = x.external_host || '';
  const applyLabel = applyHost || applyLinkLabel(applyUrl);
  const openUrl = applyUrl || x.canonical_url || '';
  const openHref = openUrl ? '<a class="ghost" style="padding:.35rem .65rem;border:1px solid var(--line);border-radius:8px;text-decoration:none" href="'+esc(openUrl)+'" target="_blank" rel="noopener">'+(applyUrl ? 'Open apply' : 'Open')+'</a>' : '';
  const applyLink = applyUrl
    ? ' · <a data-apply-url href="'+esc(applyUrl)+'" target="_blank" rel="noopener">'+esc(applyLabel)+'</a>'
    : (applyHost && applyHost !== x.ats ? ' · '+esc(applyHost) : '');
  return '<tr'+(jobUrl ? ' data-job-url="'+esc(jobUrl)+'"' : '')+'>'
    + '<td><span class="pill '+esc(String(x.state||'').toLowerCase())+'">'+esc(x.state)+'</span><div class="attempt-meta">'+stepLabel+'</div></td>'
    + '<td class="attempt-role">'+(x.canonical_url
      ? '<a href="'+esc(x.canonical_url)+'" target="_blank" rel="noopener">'+esc(x.company)+' — '+esc(x.role)+'</a>'
      : esc(x.company)+' — '+esc(x.role))
    + '<div class="attempt-meta"><code>#'+esc(x.tracker_number)+'</code> · '+esc(x.ats||'unknown')
    + applyLink
    + (x.score ? ' · '+esc(x.score) : '')
    + (x.date ? ' · '+esc(x.date) : '')
    + (x.source && x.source !== x.ats ? ' · '+esc(x.source) : '')
    + (x.report_path ? ' · <button type="button" class="quiet" data-report="'+esc(x.report_path)+'">Report</button>' : '')
    + '</div></td>'
    + '<td><div class="blocker-pills">'+blockers+'</div>'
    + '<details class="attempt-details"><summary>Details</summary>'
    + '<b>Blockers</b><ul>'+blockerList+'</ul><b>Answers</b><ul>'+answers+'</ul>'
    + (shots ? '<div class="attempt-shots">'+shots+'</div>' : '')
    + '</details></td>'
    + '<td><code>'+esc(x.selected_resume?.kind || '—')+'</code>'
    + (x.selected_resume?.hash ? '<div class="attempt-meta mono">'+esc(String(x.selected_resume.hash).slice(0, 12))+'…</div>' : '')
    + '<div class="attempt-meta">'+esc(usage || (x.kind === 'attempt' ? 'No model usage' : 'Not run'))+'</div></td>'
    + '<td><div class="stack-actions">'+applyBtn+markAppliedBtn+discardBtn+openHref+controls+'</div></td>'
    + '</tr>';
}

async function refresh() {
  status = await api('/api/status');
  renderOverview();
  renderDiscovery();
  renderEvaluate();
  renderApply();
  await loadTriage().catch(() => {});
  const job = status.current_job;
  if (job && (job.status === 'running' || job.status === 'starting')) {
    showProgress(true, job.action + ' · ' + job.status, job.progress && job.progress.total ? job.progress.done / job.progress.total : 0.15);
  }
}

async function startJob(action, args = {}) {
  const log = document.querySelector('#log');
  log.textContent = '';
  log.classList.add('collapsed');
  syncLogButton();
  activeJobAction = action;
  document.querySelector('#job-dock').classList.remove('idle');
  showProgress(true, 'Starting ' + jobLabel(action) + '…', 0.05);
  if (action === 'apply_run' || action === 'apply_row' || action === 'apply_enqueue' || action === 'apply_retry'
    || action === 'handshake_job' || action === 'handshake_session') {
    appendLog(jobLabel(action) + ' started (existing Evaluate judge; submissionGate still gates Submit)\\n');
  }
  await api('/api/jobs', { method: 'POST', body: { action, args } });
}

function askConfirm(message, fn) {
  confirmAction = fn;
  document.querySelector('#confirm-text').textContent = message;
  document.querySelector('#confirm-dialog').classList.add('open');
  document.querySelector('#confirm-ok').focus();
}

function closeDialog() {
  document.querySelector('#confirm-dialog').classList.remove('open');
  confirmAction = null;
}

document.querySelector('#tabs').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
  highlightNext();
});

document.querySelector('#continue-next').addEventListener('click', () => {
  if (!status) return;
  setTab(status.next_step === 'discovery' ? 'discovery' : status.next_step);
});

document.querySelector('#overview-stats').addEventListener('click', ev => {
  const b = ev.target.closest('[data-jump]');
  if (b) setTab(b.dataset.jump);
});

document.querySelector('#refresh-status').addEventListener('click', () => refresh());
document.querySelector('#attempt-filter')?.addEventListener('input', () => renderApply());

let rowMenuUrl = '';
function hideRowMenu() {
  const menu = document.querySelector('#row-menu');
  if (menu) menu.classList.add('hidden');
  rowMenuUrl = '';
}
function copyJobLink(url) {
  const area = document.createElement('textarea');
  area.value = url;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  if (copied) return Promise.resolve(true);
  if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(url).then(() => true, () => false);
}
document.querySelector('#attempts-table').addEventListener('contextmenu', (event) => {
  const row = event.target.closest('tr[data-job-url]');
  const url = row ? row.getAttribute('data-job-url') : '';
  if (!url) return;
  event.preventDefault();
  rowMenuUrl = url;
  const menu = document.querySelector('#row-menu');
  menu.classList.remove('hidden');
  const width = menu.offsetWidth || 180;
  const height = menu.offsetHeight || 36;
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
});
document.querySelector('#row-menu').addEventListener('click', async (event) => {
  event.stopPropagation();
  const button = event.target.closest('[data-row-menu="copy-job"]');
  const url = rowMenuUrl;
  hideRowMenu();
  if (!button || !url) return;
  const ok = await copyJobLink(url);
  toast(ok ? 'Job link copied' : 'Could not copy the job link', ok ? '' : 'err');
});
document.addEventListener('click', () => hideRowMenu());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hideRowMenu(); });

document.querySelector('[data-panel="discovery"]')?.addEventListener('click', ev => {
  const atsBtn = ev.target.closest('[data-triage-ats]');
  if (!atsBtn) return;
  const ats = atsBtn.dataset.triageAts;
  if (triageAtsFilter.has(ats)) triageAtsFilter.delete(ats);
  else triageAtsFilter.add(ats);
  renderTriageTable();
});

document.querySelector('#triage-table')?.addEventListener('change', ev => {
  const box = ev.target.closest('input[data-triage-url]');
  if (!box) return;
  if (box.checked) triageSelected.add(box.dataset.triageUrl);
  else triageSelected.delete(box.dataset.triageUrl);
  syncTriageSelectionMeta();
});

document.querySelector('#select-triage')?.addEventListener('click', () => {
  const urls = visibleTriageRows().map(row => row.url).filter(Boolean);
  if (!urls.length) return;
  const allOn = urls.every(url => triageSelected.has(url));
  if (allOn) urls.forEach(url => triageSelected.delete(url));
  else urls.forEach(url => triageSelected.add(url));
  renderTriageTable();
});

document.querySelector('[data-panel="tracker"]')?.addEventListener('click', async ev => {
  const stateBtn = ev.target.closest('[data-attempt-state]');
  if (stateBtn) {
    const state = stateBtn.dataset.attemptState;
    if (attemptStateFilter.has(state)) attemptStateFilter.delete(state);
    else attemptStateFilter.add(state);
    renderApply();
    return;
  }
  const atsBtn = ev.target.closest('[data-ats]');
  if (atsBtn && atsBtn.classList.contains('filter-chip')) {
    const ats = atsBtn.dataset.ats;
    if (attemptAtsFilter.has(ats)) attemptAtsFilter.delete(ats);
    else attemptAtsFilter.add(ats);
    renderApply();
    return;
  }
  const stat = ev.target.closest('[data-attempt-stat]');
  if (stat) {
    const key = stat.dataset.attemptStat;
    attemptStateFilter = new Set([key]);
    renderApply();
    return;
  }
  const actionBtn = ev.target.closest('[data-attempt-action]');
  if (actionBtn) {
    try {
      await api('/apply/api/action', {
        method: 'POST',
        body: { action: actionBtn.dataset.attemptAction, key: actionBtn.dataset.key },
      });
      toast('Attempt updated');
      await refresh();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  const reportBtn = ev.target.closest('[data-report]');
  if (reportBtn) {
    try {
      const data = await api('/api/report?path=' + encodeURIComponent(reportBtn.dataset.report));
      document.querySelector('#report-title').textContent = reportBtn.dataset.report;
      document.querySelector('#report-view').textContent = data.markdown || '';
      document.querySelector('#report-drawer').classList.add('open');
    } catch (err) { toast(err.message, 'err'); }
  }
});

document.querySelector('#close-report').addEventListener('click', () => document.querySelector('#report-drawer').classList.remove('open'));
document.querySelector('#report-drawer').addEventListener('click', ev => {
  if (ev.target.id === 'report-drawer') document.querySelector('#report-drawer').classList.remove('open');
});

document.body.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-job]');
  if (!b) return;
  const action = b.dataset.job;
  const args = {};
  if (action === 'scan_all') {
    args.dry_run = document.querySelector('#scan-dry-run').checked;
    const skip = document.querySelector('#scan-skip').value.trim();
    if (skip) args.skip = skip;
  }
  if (action === 'evaluate_plan') args.max = Number(document.querySelector('#plan-max').value) || 25;
  if (action === 'evaluate_row') {
    if (b.dataset.selected === '1') {
      const urls = shownTriageSelection();
      if (!urls.length) {
        toast('Select discovery rows first', 'err');
        return;
      }
      args.urls = urls;
      askConfirm('Evaluate '+urls.length+' shown posting(s) with Flash High. Writes a report and tracker row for each.', () => startJob(action, args).catch(err => toast(err.message, 'err')));
      return;
    }
    args.url = b.dataset.url;
  }
  if (action === 'handshake_session') args.max = Number(document.querySelector('#handshake-max')?.value) || 10;
  if (action === 'apply_row' || action === 'tracker_discard' || action === 'tracker_mark_applied') args.tracker_number = Number(b.dataset.tracker);
  if (action === 'apply_retry') args.key = b.dataset.key;
  if (b.dataset.apply === '1') args.apply = true;
  const run = () => startJob(action, args).catch(err => toast(err.message, 'err'));
  if (b.dataset.confirm) askConfirm(b.dataset.confirm, run);
  else run();
});

document.querySelector('#select-queue').addEventListener('click', () => {
  const boxes = [...document.querySelectorAll('#queue-table input[type=checkbox]')];
  const allOn = boxes.length && boxes.every(el => el.checked);
  boxes.forEach(el => { el.checked = !allOn; });
});

document.querySelector('#remove-queue').addEventListener('click', async () => {
  const urls = [...document.querySelectorAll('#queue-table input[type=checkbox]:checked')].map(el => el.dataset.url);
  if (!urls.length) return toast('Select queue rows first', 'err');
  askConfirm('Remove ' + urls.length + ' URL(s) from the eval queue?', async () => {
    await api('/api/queue/remove', { method: 'POST', body: { urls } });
    await refresh();
  });
});

document.querySelector('#confirm-ok').addEventListener('click', () => {
  const fn = confirmAction; closeDialog(); if (fn) fn();
});
document.querySelector('#confirm-cancel').addEventListener('click', closeDialog);
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape') return;
  closeDialog();
  document.querySelector('#report-drawer').classList.remove('open');
});

document.querySelector('#toggle-log').addEventListener('click', () => {
  const log = document.querySelector('#log');
  if (!log.textContent.trim()) {
    toast('No process output for this job');
    return;
  }
  log.classList.toggle('collapsed');
});
document.querySelector('#dismiss-job').addEventListener('click', () => {
  document.querySelector('#job-dock').classList.add('idle');
  showProgress(false, '');
});
document.querySelector('#cancel-job').addEventListener('click', async () => {
  try {
    await api('/api/jobs/cancel', { method: 'POST', body: {} });
    toast('Cancel requested');
  } catch (err) { toast(err.message, 'err'); }
});

let events = null;
let eventsTimer = null;
function connectEvents() {
  if (eventsTimer) { clearTimeout(eventsTimer); eventsTimer = null; }
  if (events) { events.close(); events = null; }
  events = new EventSource('/api/events');
  events.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      adoptCsrf(msg);
      if (msg.event === 'log') appendLog(msg.text || '');
      if (msg.event === 'progress') {
        const p = msg.progress || {};
        const ratio = p.total ? Number(p.done || 0) / Number(p.total) : 0.2;
        showProgress(true, progressLine(p), ratio);
      }
      if (msg.event === 'job_started') {
        activeJobAction = msg.job && msg.job.action;
        showProgress(true, 'Running ' + jobLabel(activeJobAction), 0.08);
      }
      if (msg.event === 'job_done' || msg.event === 'job_error') {
        const j = msg.job || {};
        activeJobAction = j.action || activeJobAction;
        appendLog('\\n' + formatJobLine(j) + '\\n');
        showProgress(false, formatJobLine(j), j.status === 'done' ? 1 : 0);
        document.querySelector('#cancel-job').classList.add('hidden');
        syncLogButton();
        if (j.status === 'error') toast(j.error && j.error.message || 'Job failed', 'err');
        else toast(jobLabel(j.action) + ' finished');
        refresh();
      }
    } catch {}
  };
  events.onerror = () => {
    if (!events || events.readyState !== 2) return;
    events.close();
    events = null;
    eventsTimer = setTimeout(connectEvents, 750);
  };
}
connectEvents();

const hashTab = location.hash.replace('#','');
if (hashTab === 'apply' || TABS.includes(hashTab)) setTab(hashTab);

refresh().catch(err => {
  document.querySelector('#mode-chip').className = 'chip warn';
  document.querySelector('#mode-chip').textContent = 'status failed';
  document.querySelector('#otp-chip').className = 'chip warn';
  document.querySelector('#otp-chip').textContent = 'Gmail OTP unknown';
  const cdpChip = document.querySelector('#cdp-chip');
  if (cdpChip) {
    cdpChip.className = 'chip warn';
    cdpChip.textContent = 'CDP unknown';
  }
  document.querySelector('#next-hint').textContent = err.message;
  toast('Failed to load status: ' + err.message, 'err');
});
</script>
</body>
</html>`;
}
