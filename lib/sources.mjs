// lib/sources.mjs — canonical discovery-source taxonomy for the `SRC:` Notes token.
// One row = one source. Analytics (source-analytics.mjs) and the backfill
// (backfill-src.mjs) both read the taxonomy from here so they cannot drift.

// Canonical source ids, grouped by the engine that discovers them.
export const SOURCE_GROUPS = {
  'direct-ats': [
    'greenhouse-api', 'ashby-api', 'lever-api', 'workday-api',
    'smartrecruiters-api', 'recruitee-api', 'playwright-spa',
  ],
  aggregator: [
    'jobright-newgrad-swe', 'jobright-newgrad-engineering',
    'jobright-newgrad-data-analysis', 'jobright-h1b', 'jobright-unspecified',
    'speedyapply-swe-newgrad', 'speedyapply-ai-newgrad',
    'simplifyjobs-newgrad', 'vanshb03-newgrad-2027',
  ],
  external: ['external-moaijobs', 'external-deeplearningjobs', 'external-agentic-engineering-jobs'],
  // jobspy scrapes several job boards and labels each row with the board it
  // came from (`site`), not with "jobspy", so keep the board identity and mark
  // the engine that fetched it.
  board: [
    'hiringcafe', 'adzuna', 'jobspy', 'hn-hiring',
    'jobspy-linkedin', 'jobspy-indeed', 'jobspy-glassdoor',
    'jobspy-ziprecruiter', 'jobspy-google',
    // Direct feed scanners (not routed through jobspy).
    'freehire', 'linkedin-guest',
  ],
  manual: ['websearch', 'gmail-sweep', 'handshake', 'cmu-weekly-email', 'manual', 'unknown'],
};

export const CANONICAL_SOURCES = Object.values(SOURCE_GROUPS).flat();

export function groupOf(source) {
  for (const [group, list] of Object.entries(SOURCE_GROUPS)) {
    if (list.includes(source)) return group;
  }
  return 'manual';
}

// Aliases seen in the wild: scan-history portal values, aggregator repo slugs,
// and batch-filename tokens that predate this taxonomy.
const ALIASES = {
  greenhouse: 'greenhouse-api',
  ashby: 'ashby-api',
  lever: 'lever-api',
  workday: 'workday-api',
  smartrecruiters: 'smartrecruiters-api',
  recruitee: 'recruitee-api',
  playwright: 'playwright-spa',
  spa: 'playwright-spa',
  hnhiring: 'hn-hiring',
  'hn-hiring-ingest': 'hn-hiring',
  'jobright-newgrad': 'jobright-unspecified',
  jobright: 'jobright-unspecified',
  'jobright-ai': 'jobright-unspecified',
  // "aggregator" / "aggregator-unknown" are deliberately absent: they name the
  // engine, not the feed, so they must resolve to null and let the caller's
  // resolution chain fall through to a more specific signal.
  simplifyjobs: 'simplifyjobs-newgrad',
  'simplifyjobs-summer': 'simplifyjobs-newgrad',
  speedyapply: 'speedyapply-swe-newgrad',
  vanshb03: 'vanshb03-newgrad-2027',
  'vanshb03-2026': 'vanshb03-newgrad-2027',
  'hiring-cafe': 'hiringcafe',
  'web-search': 'websearch',
  gmail: 'gmail-sweep',
  // CMU Career Services' weekly Job & Internship email spreadsheet.
  cmu: 'cmu-weekly-email',
  'cmu-career-services': 'cmu-weekly-email',
  // jobspy-ingest.py passes the scraped board's own name through `site`.
  linkedin: 'jobspy-linkedin',
  indeed: 'jobspy-indeed',
  glassdoor: 'jobspy-glassdoor',
  zip_recruiter: 'jobspy-ziprecruiter',
  ziprecruiter: 'jobspy-ziprecruiter',
  google: 'jobspy-google',
};

// Host -> direct-ATS source. Only hosts scan.mjs / scan-spa.mjs actually hit.
const HOST_SOURCES = [
  [/(^|\.)greenhouse\.io$/, 'greenhouse-api'],
  [/(^|\.)boards\.greenhouse\.io$/, 'greenhouse-api'],
  [/(^|\.)job-boards\.greenhouse\.io$/, 'greenhouse-api'],
  [/(^|\.)ashbyhq\.com$/, 'ashby-api'],
  [/(^|\.)lever\.co$/, 'lever-api'],
  [/myworkdayjobs\.com$/, 'workday-api'],
  [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters-api'],
  [/(^|\.)recruitee\.com$/, 'recruitee-api'],
  [/(^|\.)workable\.com$/, 'playwright-spa'],
  [/(^|\.)jobright\.ai$/, 'jobright-unspecified'],
  [/(^|\.)moaijobs\.com$/, 'external-moaijobs'],
  [/(^|\.)deeplearningjobs\.com$/, 'external-deeplearningjobs'],
  [/(^|\.)ycombinator\.com$/, 'hn-hiring'],
  [/(^|\.)joinhandshake\.com$/, 'handshake'],
  [/(^|\.)hiring\.cafe$/, 'hiringcafe'],
  [/(^|\.)adzuna\.com$/, 'adzuna'],
  [/(^|\.)freehire\.me$/, 'freehire'],
  [/(^|\.)simplify\.jobs$/, 'simplifyjobs-newgrad'],
];

// Requisition params that identify the backing ATS on a company-branded host
// (e.g. precisely.com/...?gh_jid=... is a Greenhouse-embedded board).
const PARAM_SOURCES = [['gh_jid', 'greenhouse-api'], ['ashby_jid', 'ashby-api']];

/** Normalize any raw source string (portal value, repo slug, filename token). */
export function normalizeSource(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '-');
  if (!s) return null;
  // A date or a free-text search phrase is not a source.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  if (CANONICAL_SOURCES.includes(s)) return s;
  if (ALIASES[s]) return ALIASES[s];
  // Repo slugs like "jobright-ai/Data-Analysis-New-Grad" or "SpeedyApply/AI".
  if (s.includes('jobright')) {
    if (s.includes('data') || s.includes('analysis')) return 'jobright-newgrad-data-analysis';
    if (s.includes('engineering')) return 'jobright-newgrad-engineering';
    if (s.includes('h1b') || s.includes('h-1b')) return 'jobright-h1b';
    if (s.includes('swe') || s.includes('software')) return 'jobright-newgrad-swe';
    return 'jobright-unspecified';
  }
  // scan-spa.mjs emits `playwright-{provider}` (playwright-workable, ...).
  if (s.startsWith('playwright')) return 'playwright-spa';
  if (s.includes('speedyapply')) return s.includes('ai') ? 'speedyapply-ai-newgrad' : 'speedyapply-swe-newgrad';
  if (s.includes('simplify')) return 'simplifyjobs-newgrad';
  if (s.includes('vanshb03')) return 'vanshb03-newgrad-2027';
  if (s.startsWith('external-')) return s;
  return null;
}

/**
 * Source implied by a posting URL's host or requisition params, or null.
 * NOTE: for ATS hosts this identifies the ATS, not who surfaced the posting.
 * Callers should treat it as an inference of last resort, not provenance.
 */
export function sourceFromUrl(url) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = parsed.hostname.toLowerCase();
  for (const [re, source] of HOST_SOURCES) if (re.test(host)) return source;
  for (const [param, source] of PARAM_SOURCES) if (parsed.searchParams.has(param)) return source;
  return null;
}

// Requisition-identifying params, kept when fingerprinting a URL.
const REQ_ID_PARAMS = ['gh_jid', 'jobid', 'job_id', 'reqid', 'req_id', 'lever-source', 'ashby_jid'];

/**
 * Fingerprint a posting URL so the same req joins across scan-history, batch
 * TSVs and the tracker. Mirrors normalizeUrl in merge-tracker.mjs, which is
 * CLI-only (top-level side effects) and so cannot be imported. Keep in sync.
 */
export function normalizeUrlKey(url) {
  if (!url) return '';
  let u = String(url).trim().toLowerCase();
  const [bare, query = ''] = u.split('#')[0].split('?');
  const keptParams = query
    .split('&')
    .map(kv => kv.split('='))
    .filter(([k, v]) => v && REQ_ID_PARAMS.includes(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  u = bare
    .replace(/\/+$/, '')
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/(apply|application)\/?$/, '');
  const wd = u.match(/^([^/]+\.wd\d+\.myworkdayjobs\.com)\/.*_([a-z0-9][a-z0-9-]{3,})$/);
  if (wd) return `${wd[1]}/_${wd[2]}`;
  return keptParams ? `${u}?${keptParams}` : u;
}

/** Read the `SRC: x` token out of a tracker Notes cell. */
export function readSrcToken(notes) {
  const m = String(notes || '').match(/\bSRC:\s*([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Return `notes` with a `SRC: {source}` token present exactly once.
 * The token is appended as a sentence so the 9-column Notes cell stays free text.
 */
export function withSrcToken(notes, source) {
  const body = String(notes || '').trim();
  const stripped = body.replace(/\s*\bSRC:\s*[a-z0-9][a-z0-9-]*\.?/gi, '').trim();
  const token = `SRC: ${source}.`;
  if (!stripped) return token;
  return `${stripped}${/[.!?]$/.test(stripped) ? '' : '.'} ${token}`;
}
