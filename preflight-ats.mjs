#!/usr/bin/env node
// preflight-ats.mjs — resolve a posting's TRUE location and existence straight
// from the ATS JSON API, before any eval agent is dispatched.
//
// Why this exists (2026-07-31): the HTML liveness gate and URL-path heuristics
// both miss cases the ATS API answers definitively.
//   * Greenhouse `location.name` can be "Canada (remote)" while the board's
//     `offices` metadata says "United States" and the JD body carries a US comp
//     paragraph. ClickHouse 5658009004 fooled both checks and has a US twin req.
//   * A careers-shell URL (databricks.com/...?gh_jid=, stripe.com/jobs/search?
//     gh_jid=) redirects to a job LIST when the req is dead, so the page returns
//     200 and HTML liveness calls it active. The job API returns 404.
//
// Usage: node preflight-ats.mjs <tsv-with-url-column> [--url-col N] [--json]
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const AS_JSON = process.argv.includes('--json');
const colArg = process.argv.indexOf('--url-col');
const URL_COL = colArg > -1 ? Number(process.argv[colArg + 1]) : 0;
const CONCURRENCY = 8;

// US / remote-US detection over an ATS location string.
const US_HINT = /\b(united states|usa|u\.s\.|us[- ]remote|remote[- ]us|remote,? usa?|anywhere in the us)\b/i;
const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;
const US_CITIES = /\b(san francisco|new york|nyc|seattle|austin|boston|chicago|denver|atlanta|los angeles|san jose|palo alto|mountain view|sunnyvale|bellevue|pittsburgh|philadelphia|dallas|houston|miami|portland|san diego|washington|arlington|reston|mclean|raleigh|durham|nashville|phoenix|salt lake|minneapolis|detroit|columbus|kansas city|st\.? louis|boulder|santa clara|redmond|cupertino|menlo park|culver city|santa monica|irvine|san mateo|emeryville|brooklyn)\b/i;
const NON_US = /\b(canada|toronto|vancouver|montreal|ottawa|waterloo|united kingdom|uk|london|manchester|edinburgh|dublin|ireland|france|paris|germany|berlin|munich|spain|barcelona|madrid|italy|milan|netherlands|amsterdam|switzerland|zurich|sweden|stockholm|poland|warsaw|krakow|czech|prague|romania|bucharest|portugal|lisbon|israel|tel aviv|india|bangalore|bengaluru|hyderabad|chennai|pune|mumbai|delhi|gurgaon|noida|singapore|japan|tokyo|korea|seoul|china|shanghai|beijing|taiwan|taipei|australia|sydney|melbourne|new zealand|brazil|sao paulo|mexico|argentina|colombia|chile|uae|dubai|egypt|cairo|nigeria|lagos|south africa|philippines|manila|indonesia|jakarta|vietnam|thailand|malaysia|emea|apac|latam)\b/i;

function classifyGeo(loc) {
  if (!loc) return 'unknown';
  const s = String(loc);
  const nonUs = NON_US.test(s);
  const us = US_HINT.test(s) || US_STATES.test(s) || US_CITIES.test(s);
  if (us && !nonUs) return 'us';
  if (nonUs && !us) return 'non-us';
  if (us && nonUs) return 'mixed';       // multi-region req; needs a human look
  return 'unknown';
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'career-ops-preflight' } });
  if (!res.ok) return { ok: false, status: res.status };
  try { return { ok: true, data: await res.json() }; } catch { return { ok: false, status: 'non-json' }; }
}

// --- per-ATS resolvers -------------------------------------------------------

async function greenhouse(url) {
  const u = new URL(url);
  const jid = u.searchParams.get('gh_jid')
    || (u.pathname.match(/\/jobs\/(\d+)/) || [])[1];
  const slug = (u.pathname.match(/^\/(?:embed\/job_board\?for=)?([^/]+)\/jobs\//) || [])[1]
    || u.searchParams.get('for');
  if (!jid) return { ats: 'greenhouse', verdict: 'unresolvable', reason: 'no gh_jid in url' };

  // Board slug is unknown for careers-shell URLs; the per-job endpoint needs it,
  // so fall back to probing the slug guessed from the host.
  const guesses = [slug, u.hostname.split('.')[0], u.hostname.replace(/\.(com|io|ai|co)$/, '').split('.').pop()]
    .filter(Boolean);
  for (const g of new Set(guesses)) {
    const r = await getJson(`https://boards-api.greenhouse.io/v1/boards/${g}/jobs/${jid}`);
    if (r.ok) {
      const loc = r.data.location?.name || '';
      return { ats: 'greenhouse', verdict: 'live', location: loc, geo: classifyGeo(loc), title: r.data.title, board: g };
    }
    if (r.status === 404) continue;
  }
  // A 404 only proves the req is gone when the board slug came from the URL
  // itself (boards.greenhouse.io/{slug}/jobs/...). On a company careers shell
  // the slug is guessed from the hostname, so a miss may just be a wrong guess:
  // report `unknown` and let the eval agent decide rather than dropping a live req.
  const slugIsAuthoritative = /(^|\.)(job-boards|boards)\.greenhouse\.io$/.test(u.hostname);
  return slugIsAuthoritative
    ? { ats: 'greenhouse', verdict: 'dead', reason: `job ${jid} 404 on board ${slug}` }
    : { ats: 'greenhouse', verdict: 'unknown', reason: `job ${jid} not found under guessed slugs [${[...new Set(guesses)].join(', ')}]` };
}

async function lever(url) {
  const m = new URL(url).pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!m) return { ats: 'lever', verdict: 'unresolvable', reason: 'no posting id' };
  const r = await getJson(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
  if (!r.ok) return { ats: 'lever', verdict: 'dead', reason: `posting 404 (${r.status})` };
  const loc = r.data.categories?.location || r.data.workplaceType || '';
  const all = [loc, ...(r.data.categories?.allLocations || [])].join(' / ');
  return { ats: 'lever', verdict: 'live', location: all, geo: classifyGeo(all), title: r.data.text };
}

async function ashby(url) {
  const m = new URL(url).pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!m) return { ats: 'ashby', verdict: 'unresolvable', reason: 'no posting id' };
  const r = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`);
  if (!r.ok) return { ats: 'ashby', verdict: 'unresolvable', reason: `board ${r.status}` };
  const job = (r.data.jobs || []).find(j => j.jobUrl?.includes(m[2]) || j.id === m[2]);
  if (!job) return { ats: 'ashby', verdict: 'dead', reason: 'posting absent from board' };
  const loc = job.location || (job.address?.postalAddress?.addressRegion || '');
  return { ats: 'ashby', verdict: 'live', location: loc, geo: classifyGeo(loc), title: job.title };
}

async function workday(url) {
  // Workday encodes the office in the path; the cxs API needs a POST per tenant,
  // so use the path segment, which has been reliable.
  const seg = decodeURIComponent(new URL(url).pathname).split('/job/')[1] || '';
  const loc = seg.split('/')[0] || '';
  return { ats: 'workday', verdict: 'unknown', location: loc, geo: classifyGeo(loc.replace(/-/g, ' ')) };
}

async function resolve(url) {
  try {
    const h = new URL(url).hostname;
    if (/lever\.co$/.test(h)) return await lever(url);
    if (/ashbyhq\.com$/.test(h)) return await ashby(url);
    if (/myworkdayjobs\.com$/.test(h)) return await workday(url);
    return await greenhouse(url);   // greenhouse-backed, incl. careers shells
  } catch (e) {
    return { verdict: 'error', reason: e.message };
  }
}

// --- run ---------------------------------------------------------------------

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const rows = lines.slice(1).map(l => { const c = l.split('\t'); return { url: c[URL_COL], cells: c }; })
  .filter(r => r.url && r.url.startsWith('http'));

const out = [];
let i = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (i < rows.length) {
    const r = rows[i++];
    out.push({ ...r, ...(await resolve(r.url)) });
  }
}));
out.sort((a, b) => rows.findIndex(r => r.url === a.url) - rows.findIndex(r => r.url === b.url));

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const tally = {};
for (const r of out) {
  const k = `${r.verdict}/${r.geo || '-'}`;
  tally[k] = (tally[k] || 0) + 1;
}
console.log('checked:', out.length);
console.log('verdict/geo:', Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '));
console.log();
for (const r of out) {
  console.log([r.verdict, r.geo || '-', (r.location || r.reason || '').slice(0, 46), r.url].join('\t'));
}
