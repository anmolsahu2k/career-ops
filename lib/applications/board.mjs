import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { getAttempt, listAttempts, transitionAttempt } from './store.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';

const RETRYABLE = new Set(['NEEDS_REVIEW', 'WAITING_LOGIN', 'FAILED']);
const DISPLAY_STATES = ['QUEUED', 'RUNNING', 'SUBMITTED', 'NEEDS_REVIEW', 'SUBMISSION_UNKNOWN'];

function providerUsage(usage) {
  return (usage || []).map(item => ({
    provider: typeof item?.provider === 'string' ? item.provider.slice(0, 80) : 'local',
    input_tokens: Number.isFinite(item?.input_tokens) ? item.input_tokens : null,
    output_tokens: Number.isFinite(item?.output_tokens) ? item.output_tokens : null,
    total_tokens: Number.isFinite(item?.total_tokens) ? item.total_tokens : null,
  }));
}

function answerSummary(answer) {
  // Answers themselves can contain personal details. The board exposes the
  // provenance needed to review them, never the text itself.
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
  // Only screenshots captured with the runner's redaction pass become web
  // files. Arbitrary and legacy artifact paths remain local audit records.
  return (attempt.artifacts || []).map(path => basename(path))
    .filter(name => /^redacted-[a-z0-9][a-z0-9._-]*\.png$/i.test(name));
}

function publicAttempt(attempt) {
  return {
    attempt_id: attempt.attempt_id, idempotency_key: attempt.idempotency_key,
    tracker_number: attempt.tracker_number, role: attempt.role, company: attempt.company,
    canonical_url: attempt.canonical_url, ats: attempt.ats, state: attempt.state, step: attempt.step,
    blockers: (attempt.blockers || []).map(item => ({
      code: String(item?.code || 'UNKNOWN').slice(0, 80),
      question: typeof item?.question === 'string' ? item.question.slice(0, 240) : '',
      detail: typeof item?.detail === 'string' ? item.detail.slice(0, 300) : '',
    })),
    selected_resume: attempt.selected_resume || null,
    provider_usage: providerUsage(attempt.provider_usage),
    answers: (attempt.answers || []).map(answerSummary),
    screenshots: safeScreenshotNames(attempt),
    artifacts: (attempt.artifacts || []).map(path => basename(path)).filter(name => !/\.png$/i.test(name)),
    updated_at: attempt.updated_at,
  };
}

function page(token, { allowActions = false } = {}) { return `<!doctype html><meta charset="utf-8"><title>Career-Ops Apply Board</title>
<style>body{font:14px system-ui;margin:2rem;background:#f7f7f8;color:#15171a}table{border-collapse:collapse;width:100%;background:white}td,th{padding:.6rem;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}code{font-size:12px}.state{font-weight:700}button{margin:.1rem .4rem .1rem 0}.meta{color:#555;font-size:12px}details{max-width:32rem}label{margin-right:.7rem}img{max-width:500px;border:1px solid #bbb;margin-top:.5rem}</style>
<h1>Apply Board</h1><p id="counts"></p><p id="filters"></p><table><thead><tr><th>State</th><th>Role</th><th>Review details</th><th>Resume and run</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<script>const csrf=${JSON.stringify(token)};const actions=${JSON.stringify(allowActions)};const states=${JSON.stringify(DISPLAY_STATES)};let selected=new Set(states);
const e=s=>String(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const tokenText=u=>u.map(x=>[x.provider,x.input_tokens,x.output_tokens,x.total_tokens].filter(v=>v!==null&&v!==undefined&&v!=='').join(' / ')).join('; ');
function filters(){document.querySelector('#filters').innerHTML=states.map(s=>'<label><input type="checkbox" data-state="'+s+'" '+(selected.has(s)?'checked':'')+'> '+s+'</label>').join('')}
function details(x){const b=x.blockers.map(v=>'<li><b>'+e(v.code)+'</b>'+(v.question?' — '+e(v.question):'')+(v.detail?'<br><span class="meta">'+e(v.detail)+'</span>':'')+'</li>').join('')||'<li>None</li>';
const a=x.answers.map(v=>'<li>'+e(v.field_id)+' — '+e(v.provenance)+', '+(v.claims_validated?'claims validated':'claims need review')+', '+v.length+' chars'+(v.evidence_ids.length?' ('+e(v.evidence_ids.join(', '))+')':'')+'</li>').join('')||'<li>No generated answers</li>';
const shots=x.screenshots.map(n=>'<img alt="Redacted application screenshot" src="/api/screenshot/'+encodeURIComponent(x.idempotency_key)+'/'+encodeURIComponent(n)+'">').join('');
return '<details><summary>Blockers, answer provenance, and safe screenshot</summary><b>Blockers</b><ul>'+b+'</ul><b>Generated answers (text redacted)</b><ul>'+a+'</ul>'+shots+'</details>'}
async function load(){const a=await fetch('/api/attempts').then(r=>r.json());const counts={};a.forEach(x=>counts[x.state]=(counts[x.state]||0)+1);document.querySelector('#counts').textContent=Object.entries(counts).map(([k,v])=>k+': '+v).join(' · ')||'No attempts';const visible=a.filter(x=>selected.has(x.state));const controls=x=>actions?(['NEEDS_REVIEW','WAITING_LOGIN','FAILED'].includes(x.state)?'<button data-a="retry" data-k="'+e(x.idempotency_key)+'">Resume now</button>':'')+(x.state==='QUEUED'?'<button data-a="skip" data-k="'+e(x.idempotency_key)+'">Skip</button>':'')+(x.state==='SUBMISSION_UNKNOWN'?'<button data-a="ack" data-k="'+e(x.idempotency_key)+'">Acknowledge result</button>':''):'<span class="meta">Read-only board</span>';document.querySelector('#rows').innerHTML=visible.map(x=>'<tr><td class="state">'+e(x.state)+'<br><span class="meta">Step '+e(x.step)+'</span></td><td><a href="'+e(x.canonical_url)+'" target="_blank" rel="noopener">'+e(x.company)+' — '+e(x.role)+'</a><br><code>#'+x.tracker_number+' '+e(x.ats)+'</code></td><td>'+details(x)+'</td><td><code>'+e(x.selected_resume?.kind||'—')+' '+e(x.selected_resume?.hash||'')+'</code><br><span class="meta">'+e(tokenText(x.provider_usage)||'No model usage')+'</span></td><td><a href="'+e(x.canonical_url)+'" target="_blank" rel="noopener">Open</a><br>'+controls(x)+'</td></tr>').join('')||'<tr><td colspan="5">No attempts match the selected states.</td></tr>'}
document.addEventListener('change',ev=>{const s=ev.target.dataset.state;if(!s)return;ev.target.checked?selected.add(s):selected.delete(s);load()});document.addEventListener('click',async ev=>{const b=ev.target.closest('button');if(!b)return;const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({action:b.dataset.a,key:b.dataset.k})});if(!response.ok)alert((await response.json()).error||'Action refused');load()});filters();load();</script>`; }

function boardArtifactPath(target, attempt, filename) {
  if (!safeScreenshotNames(attempt).includes(filename)) return null;
  const root = resolve(persistencePaths(target).runtimeDir, 'applications', 'artifacts', attempt.attempt_id);
  const path = resolve(root, filename);
  return path.startsWith(`${root}\\`) || path.startsWith(`${root}/`) ? path : null;
}

export function serveApplyBoard(target, { port = 8788, allowActions = false, onRetry = null } = {}) {
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === `http://127.0.0.1:${req.headers.host}`;
    if (!sameOrigin) { res.writeHead(403); return res.end('cross-origin denied'); }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" };
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' }); return res.end(page(token, { allowActions })); }
    if (req.method === 'GET' && url.pathname === '/api/attempts') { res.writeHead(200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(listAttempts(target).map(publicAttempt))); }
    const screenshot = url.pathname.match(/^\/api\/screenshot\/([^/]+)\/([^/]+)$/);
    if (req.method === 'GET' && screenshot) {
      let key; let filename;
      try { key = decodeURIComponent(screenshot[1]); filename = decodeURIComponent(screenshot[2]); } catch { res.writeHead(400); return res.end('bad path'); }
      const attempt = getAttempt(target, key); const path = attempt && boardArtifactPath(target, attempt, filename);
      if (!path || !existsSync(path)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { ...headers, 'content-type': 'image/png' }); return createReadStream(path).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (!allowActions) { res.writeHead(403); return res.end('board is read-only'); }
      if (req.headers['x-csrf-token'] !== token) { res.writeHead(403); return res.end('csrf denied'); }
      let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 16_384) req.destroy(); });
      return req.on('end', async () => {
        try {
          const { action, key } = JSON.parse(body || '{}'); const attempt = getAttempt(target, key);
          if (!attempt) throw new Error('attempt not found');
          if (action === 'retry' && RETRYABLE.has(attempt.state)) {
            transitionAttempt(target, key, 'QUEUED', { blockers: [] });
            if (typeof onRetry === 'function') await onRetry(key);
          }
          else if (action === 'skip' && attempt.state === 'QUEUED') transitionAttempt(target, key, 'SKIPPED');
          else if (action === 'ack' && attempt.state === 'SUBMISSION_UNKNOWN') {
            transitionAttempt(target, key, 'SUBMISSION_UNKNOWN', { submission_evidence: { ...(attempt.submission_evidence || {}), acknowledged_at: new Date().toISOString() } });
          } else throw new Error('action not permitted for state');
          res.writeHead(200, { ...headers, 'content-type': 'application/json' }); res.end('{"ok":true}');
        } catch (error) { res.writeHead(400, { ...headers, 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
      });
    }
    res.writeHead(404, headers); res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Apply Board: http://127.0.0.1:${server.address().port}\n`));
  return server;
}
