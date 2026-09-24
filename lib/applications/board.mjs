/**
 * board.mjs — localhost Apply Attempts board.
 * Exposes createApplyBoardHandler for composition into the Career-Ops web app.
 *
 * Distinct from root apply-board.mjs (scan-history checklist). This board is the
 * ApplicationAttemptV1 state machine UI.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { getAttempt, listAttempts, transitionAttempt } from './store.mjs';
import { generatedAnswerLabel } from './policy.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';

export const ATTEMPT_DISPLAY_STATES = Object.freeze([
  'QUEUED', 'RUNNING', 'READY_TO_SUBMIT', 'SUBMITTED', 'NEEDS_REVIEW',
  'WAITING_LOGIN', 'SUBMISSION_UNKNOWN', 'FAILED', 'SKIPPED',
]);

const RETRYABLE = new Set(['NEEDS_REVIEW', 'WAITING_LOGIN', 'FAILED']);
const DISPLAY_STATES = ATTEMPT_DISPLAY_STATES;
function providerUsage(usage) {
  return (usage || []).map(item => ({
    provider: typeof item?.provider === 'string' ? item.provider.slice(0, 80) : 'local',
    input_tokens: Number.isFinite(item?.input_tokens) ? item.input_tokens : null,
    output_tokens: Number.isFinite(item?.output_tokens) ? item.output_tokens : null,
    total_tokens: Number.isFinite(item?.total_tokens) ? item.total_tokens : null,
  }));
}

function answerSummary(answer) {
  return {
    field_id: String(answer?.field_id || '').slice(0, 160),
    provenance: String(answer?.provenance || 'unknown').slice(0, 80),
    confidence: Number.isFinite(answer?.confidence) ? answer.confidence : null,
    evidence_ids: (answer?.evidence_ids || []).map(id => String(id).slice(0, 100)).slice(0, 12),
    claims_validated: answer?.claims_validated === true,
    length: String(answer?.text || '').length,
  };
}

function safeScreenshotNames(attempt) {
  return (attempt.artifacts || []).map(path => basename(path))
    .filter(name => /^redacted-[a-z0-9][a-z0-9._-]*\.png$/i.test(name));
}

function reportHref(attempt) {
  const link = String(attempt.report_id || '').match(/\]\(([^)]+)\)/)?.[1];
  return link && !/^https?:/i.test(link) ? link : '';
}

function applyExternalHost(attempt) {
  if (typeof attempt.external_host === 'string' && attempt.external_host.trim()) {
    return attempt.external_host.trim().slice(0, 200);
  }
  const url = applyExternalUrl(attempt);
  if (url) {
    try { return new URL(url).hostname.slice(0, 200); } catch { /* ignore */ }
  }
  for (const item of attempt.blockers || []) {
    const match = String(item?.detail || '').match(/Apply externally:\s*(\S+)/i);
    if (match) {
      const value = match[1];
      try { return new URL(value).hostname.slice(0, 200); } catch { return value.slice(0, 200); }
    }
  }
  return '';
}

function applyExternalUrl(attempt) {
  if (typeof attempt.external_url === 'string' && /^https?:/i.test(attempt.external_url.trim())) {
    return attempt.external_url.trim().slice(0, 500);
  }
  for (const item of attempt.blockers || []) {
    const match = String(item?.detail || '').match(/Apply externally:\s*(https?:\/\/\S+)/i);
    if (match) return match[1].slice(0, 500);
  }
  if (typeof attempt.external_host === 'string' && /^https?:/i.test(attempt.external_host.trim())) {
    return attempt.external_host.trim().slice(0, 500);
  }
  return '';
}

export function publicAttempt(attempt) {
  const generatedLabels = (attempt.answers || [])
    .filter(answer => answer?.claims_validated !== true && /generated/i.test(String(answer?.provenance || '')))
    .map(answer => generatedAnswerLabel(answer));
  let leftover = [...generatedLabels];
  return {
    attempt_id: attempt.attempt_id, idempotency_key: attempt.idempotency_key,
    tracker_number: attempt.tracker_number, role: attempt.role, company: attempt.company,
    canonical_url: attempt.canonical_url, ats: attempt.ats, state: attempt.state, step: attempt.step,
    external_host: applyExternalHost(attempt),
    external_url: applyExternalUrl(attempt),
    external_ats: typeof attempt.external_ats === 'string' ? attempt.external_ats.slice(0, 40) : '',
    report_path: reportHref(attempt),
    blockers: (attempt.blockers || []).map(item => {
      let question = typeof item?.question === 'string' ? item.question.trim() : '';
      if (item?.code === 'VALIDATION_ERROR' && !question) {
        question = leftover.shift() || 'Unlabeled required field';
      }
      return {
        code: String(item?.code || 'UNKNOWN').slice(0, 80),
        question: question.slice(0, 240),
        detail: typeof item?.detail === 'string' ? item.detail.slice(0, 300) : '',
      };
    }),
    selected_resume: attempt.selected_resume || null,
    provider_usage: providerUsage(attempt.provider_usage),
    answers: (attempt.answers || []).map(answerSummary),
    screenshots: safeScreenshotNames(attempt),
    artifacts: (attempt.artifacts || []).map(path => basename(path)).filter(name => !/\.png$/i.test(name)),
    updated_at: attempt.updated_at,
  };
}

export function renderApplyBoardPage(token, { allowActions = false, basePath = '' } = {}) {
  const apiBase = basePath.replace(/\/$/, '');
  return `<!doctype html><meta charset="utf-8"><title>Career-Ops Apply Attempts</title>
<style>body{font:13.5px/1.45 "Segoe UI",system-ui;margin:1rem 1.1rem;background:#f4f6f7;color:#15171a}h1{font-size:1.05rem;margin:0 0 .35rem;letter-spacing:-.02em}table{border-collapse:collapse;width:100%;background:white;border:1px solid #d8e0e5;border-radius:10px;overflow:hidden}td,th{padding:.55rem .65rem;border-bottom:1px solid #e6ecf0;text-align:left;vertical-align:top}th{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#5d6d78;background:#eef2f4}code{font-size:12px}.state{font-weight:700}button{margin:.1rem .35rem .1rem 0;border:1px solid #c5d0d8;background:#fff;border-radius:7px;padding:.28rem .55rem;cursor:pointer}.meta{color:#5d6d78;font-size:12px}details{max-width:32rem}label{margin-right:.7rem;color:#5d6d78}img{max-width:500px;border:1px solid #bbb;margin-top:.5rem}#counts{color:#5d6d78;margin:.2rem 0 .6rem}.pill{display:inline-block;border:1px solid #c5d0d8;border-radius:999px;padding:.05rem .45rem;margin:0 .2rem .2rem 0;font-size:11px;background:#eef2f4}</style>
<h1>Apply Attempts</h1>
<p class="meta">Autonomous applier attempt board. Separate from the scan-history checklist (<code>node apply-board.mjs</code>).</p>
<p id="counts"></p><p id="filters"></p><p id="atsFilters"></p>
<table><thead><tr><th>State</th><th>Role</th><th>Review details</th><th>Resume and run</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<script>
const csrf=${JSON.stringify(token)};
const actions=${JSON.stringify(allowActions)};
const apiBase=${JSON.stringify(apiBase)};
const states=${JSON.stringify(DISPLAY_STATES)};
let selected=new Set(['QUEUED','RUNNING','READY_TO_SUBMIT','NEEDS_REVIEW','WAITING_LOGIN','SUBMISSION_UNKNOWN']);
let selectedAts=new Set();
const e=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const tokenText=u=>u.map(x=>[x.provider,x.input_tokens,x.output_tokens,x.total_tokens].filter(v=>v!==null&&v!==undefined&&v!=='').join(' / ')).join('; ');
function filters(){document.querySelector('#filters').innerHTML=states.map(s=>'<label><input type="checkbox" data-state="'+s+'" '+(selected.has(s)?'checked':'')+'> '+s+'</label>').join('')}
function details(x){
  const b=x.blockers.map(v=>'<li><b>'+e(v.code)+'</b>'+(v.question?' — '+e(v.question):'')+(v.detail?'<br><span class="meta">'+e(v.detail)+'</span>':'')+'</li>').join('')||'<li>None</li>';
  const a=x.answers.map(v=>'<li>'+e(v.field_id)+' — '+e(v.provenance)+', '+(v.claims_validated?'claims validated':'claims need review')+', '+v.length+' chars'+(v.evidence_ids.length?' ('+e(v.evidence_ids.join(', '))+')':'')+'</li>').join('')||'<li>No generated answers</li>';
  const shots=x.screenshots.map(n=>'<img alt="Redacted application screenshot" src="'+apiBase+'/api/screenshot/'+encodeURIComponent(x.idempotency_key)+'/'+encodeURIComponent(n)+'">').join('');
  const pills=x.blockers.slice(0,4).map(v=>'<span class="pill">'+e(v.code)+'</span>').join('');
  return pills+'<details><summary>Blockers, answer provenance, and safe screenshot</summary><b>Blockers</b><ul>'+b+'</ul><b>Generated answers (text redacted)</b><ul>'+a+'</ul>'+shots+'</details>';
}
async function load(){
  const a=await fetch(apiBase+'/api/attempts').then(r=>r.json());
  const counts={}; const atsSet=new Set();
  a.forEach(x=>{counts[x.state]=(counts[x.state]||0)+1; atsSet.add(x.ats||'unknown')});
  if(!selectedAts.size) selectedAts=atsSet;
  document.querySelector('#counts').textContent=Object.entries(counts).map(([k,v])=>k+': '+v).join(' · ')||'No attempts';
  document.querySelector('#atsFilters').innerHTML=[...atsSet].sort().map(s=>'<label><input type="checkbox" data-ats="'+e(s)+'" '+(selectedAts.has(s)?'checked':'')+'> '+e(s)+'</label>').join('');
  const visible=a.filter(x=>selected.has(x.state)&&selectedAts.has(x.ats||'unknown'));
  const controls=x=>actions?(
    (['NEEDS_REVIEW','WAITING_LOGIN','FAILED'].includes(x.state)?'<button data-a="retry" data-k="'+e(x.idempotency_key)+'">Resume now</button>':'')+
    (x.state==='QUEUED'||x.state==='READY_TO_SUBMIT'?'<button data-a="skip" data-k="'+e(x.idempotency_key)+'">Skip</button>':'')+
    (x.state==='SUBMISSION_UNKNOWN'?'<button data-a="ack" data-k="'+e(x.idempotency_key)+'">Acknowledge result</button>':'')
  ):'<span class="meta">Read-only board</span>';
  document.querySelector('#rows').innerHTML=visible.map(x=>'<tr><td class="state">'+e(x.state)+'<br><span class="meta">Step '+e(x.step)+'</span></td><td><a href="'+e(x.canonical_url)+'" target="_blank" rel="noopener">'+e(x.company)+' — '+e(x.role)+'</a><br><code>#'+x.tracker_number+' '+e(x.ats)+'</code>'+(x.report_path?'<br><span class="meta">Report: '+e(x.report_path)+'</span>':'')+'</td><td>'+details(x)+'</td><td><code>'+e(x.selected_resume?.kind||'—')+' '+e(x.selected_resume?.hash||'')+'</code><br><span class="meta">'+e(tokenText(x.provider_usage)||'No model usage')+'</span></td><td><a href="'+e(x.canonical_url)+'" target="_blank" rel="noopener">Open</a><br>'+controls(x)+'</td></tr>').join('')||'<tr><td colspan="5">No attempts match the selected filters.</td></tr>';
}
document.addEventListener('change',ev=>{
  const s=ev.target.dataset.state; const ats=ev.target.dataset.ats;
  if(s){ev.target.checked?selected.add(s):selected.delete(s)}
  if(ats){ev.target.checked?selectedAts.add(ats):selectedAts.delete(ats)}
  if(s||ats) load();
});
document.addEventListener('click',async ev=>{
  const b=ev.target.closest('button'); if(!b) return;
  const response=await fetch(apiBase+'/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action:b.dataset.a,key:b.dataset.k})});
  if(!response.ok) alert((await response.json()).error||'Action refused');
  load();
});
filters(); load();
</script>`;
}

function boardArtifactPath(target, attempt, filename) {
  if (!safeScreenshotNames(attempt).includes(filename)) return null;
  const root = resolve(persistencePaths(target).runtimeDir, 'applications', 'artifacts', attempt.attempt_id);
  const path = resolve(root, filename);
  return path.startsWith(`${root}\\`) || path.startsWith(`${root}/`) ? path : null;
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  };
}

export function createApplyBoardHandler(target, {
  allowActions = false,
  onRetry = null,
  csrfToken = null,
  basePath = '',
} = {}) {
  const token = csrfToken || randomBytes(24).toString('hex');
  const prefix = basePath.replace(/\/$/, '');

  function stripPrefix(pathname) {
    if (!prefix) return pathname;
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
    return null;
  }

  async function handle(req, res, { port = 8788 } = {}) {
    const origin = req.headers.origin;
    const host = req.headers.host || '';
    const sameOrigin = !origin || origin === `http://${host}` || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
    if (!sameOrigin) {
      res.writeHead(403);
      res.end('cross-origin denied');
      return true;
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const path = stripPrefix(url.pathname);
    if (path === null) return false;

    const headers = securityHeaders();
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(renderApplyBoardPage(token, { allowActions, basePath: prefix }));
      return true;
    }
    if (req.method === 'GET' && path === '/api/attempts') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(listAttempts(target).map(publicAttempt)));
      return true;
    }
    const screenshot = path.match(/^\/api\/screenshot\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && screenshot) {
      let key; let filename;
      try {
        key = decodeURIComponent(screenshot[1]);
        filename = decodeURIComponent(screenshot[2]);
      } catch {
        res.writeHead(400);
        res.end('bad path');
        return true;
      }
      const attempt = getAttempt(target, key);
      const pathOnDisk = attempt && boardArtifactPath(target, attempt, filename);
      if (!pathOnDisk || !existsSync(pathOnDisk)) {
        res.writeHead(404);
        res.end('not found');
        return true;
      }
      res.writeHead(200, { ...headers, 'content-type': 'image/png' });
      createReadStream(pathOnDisk).pipe(res);
      return true;
    }
    if (req.method === 'POST' && path === '/api/action') {
      if (!allowActions) {
        res.writeHead(403);
        res.end('board is read-only');
        return true;
      }
      if (req.headers['x-csrf-token'] !== token) {
        res.writeHead(403);
        res.end('csrf denied');
        return true;
      }
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 16_384) req.destroy();
      });
      await new Promise(resolveEnd => {
        req.on('end', async () => {
          try {
            const { action, key } = JSON.parse(body || '{}');
            const attempt = getAttempt(target, key);
            if (!attempt) throw new Error('attempt not found');
            if (action === 'retry' && RETRYABLE.has(attempt.state)) {
              transitionAttempt(target, key, 'QUEUED', { blockers: [] });
              if (typeof onRetry === 'function') await onRetry(key);
            } else if (action === 'skip' && (attempt.state === 'QUEUED' || attempt.state === 'READY_TO_SUBMIT')) {
              transitionAttempt(target, key, 'SKIPPED');
            } else if (action === 'ack' && attempt.state === 'SUBMISSION_UNKNOWN') {
              transitionAttempt(target, key, 'SUBMISSION_UNKNOWN', {
                submission_evidence: {
                  ...(attempt.submission_evidence || {}),
                  acknowledged_at: new Date().toISOString(),
                },
              });
            } else {
              throw new Error('action not permitted for state');
            }
            res.writeHead(200, { ...headers, 'content-type': 'application/json' });
            res.end('{"ok":true}');
          } catch (error) {
            res.writeHead(400, { ...headers, 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error.message }));
          } finally {
            resolveEnd();
          }
        });
      });
      return true;
    }
    return false;
  }

  return { token, handle };
}

export function serveApplyBoard(target, { port = 8788, allowActions = false, onRetry = null } = {}) {
  const board = createApplyBoardHandler(target, { allowActions, onRetry });
  const server = createServer(async (req, res) => {
    const handled = await board.handle(req, res, { port });
    if (!handled) {
      res.writeHead(404, securityHeaders());
      res.end('not found');
    }
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Apply Attempts: http://127.0.0.1:${server.address().port}\n`));
  return server;
}
