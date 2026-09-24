/** Resolve discovery/mirror posting URLs to certified ATS application surfaces.
 *
 * `SRC: greenhouse-api` and a `gh_jid` query prove Greenhouse provenance, but
 * company careers shells (databricks.com/?gh_jid=…) are not fillable hosts for
 * the Job Autofill runner. The first-party embed endpoint is:
 *   https://job-boards.greenhouse.io/embed/job_app?for={board}&token={jid}
 */

import { atsFor, isCertifiedAts } from './ats.mjs';

const DEFAULT_FETCH = (...args) => fetch(...args);

function isGreenhouseHost(hostname) {
  const host = String(hostname || '').replace(/^www\./i, '').toLowerCase();
  return /(^|\.)greenhouse\.io$/i.test(host) || host === 'grnh.se';
}

export function greenhouseJobId(url) {
  try {
    const parsed = new URL(url);
    const ghJid = parsed.searchParams.get('gh_jid');
    if (ghJid && /^\d{5,}$/.test(ghJid)) return ghJid;
    // Path /jobs/{id} and ?token= are Greenhouse board/embed shapes. The same
    // path on Garmin, iCIMS, Work at a Startup, and similar hosts is not.
    if (!isGreenhouseHost(parsed.hostname)) return null;
    const token = parsed.searchParams.get('token');
    if (token && /^\d{5,}$/.test(token)) return token;
    return parsed.pathname.match(/\/jobs\/(\d{5,})\/?$/i)?.[1] || null;
  } catch {
    return null;
  }
}

/** Public Greenhouse jobs API for an official boards*.greenhouse.io URL. */
export function certifiedGreenhouseApiEndpoint(url) {
  try {
    const parsed = new URL(url);
    if (!isGreenhouseHost(parsed.hostname)) return null;
    const jobId = greenhouseJobId(url);
    const pathBoard = parsed.pathname.match(/^\/(?:embed\/job_app\/)?([^/]+)\/jobs\/(\d+)\/?$/i);
    const board = parsed.searchParams.get('for')
      || (pathBoard?.[1] && pathBoard[1] !== 'embed' ? pathBoard[1] : null);
    const id = jobId || pathBoard?.[2];
    if (!board || !id || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(board) || !/^\d+$/.test(String(id))) {
      return null;
    }
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(id)}?content=true`;
  } catch {
    return null;
  }
}

export function buildGreenhouseEmbedUrl(board, jobId) {
  const token = String(jobId || '').trim();
  const forBoard = String(board || '').trim();
  if (!/^\d{5,}$/.test(token) || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(forBoard)) {
    throw new Error('Greenhouse embed URL requires a board token and numeric job id');
  }
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(forBoard)}&token=${encodeURIComponent(token)}`;
}

function slugifyCompany(company = '') {
  const raw = String(company).toLowerCase().normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  const compact = raw.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const hyphen = raw.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return [...new Set([compact, hyphen].filter(Boolean))];
}

/** Ordered board-token guesses for a careers-shell URL. Never invents a host. */
export function guessGreenhouseBoardTokens(url, { company = '' } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return []; }
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const labels = host.split('.').filter(Boolean);
  const pathBoard = parsed.pathname.match(/^\/(?:embed\/job_app)?\/?([^/]+)\/jobs\//i)?.[1]
    || parsed.searchParams.get('for');
  const guesses = [
    pathBoard,
    ...slugifyCompany(company),
    labels[0],
    labels.length > 2 ? labels[labels.length - 2] : null,
  ];
  return [...new Set(guesses
    .map(value => String(value || '').trim())
    .filter(value => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)))];
}

async function probeGreenhouseBoard(board, jobId, fetchImpl) {
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`;
  const response = await fetchImpl(endpoint, {
    headers: { 'User-Agent': 'career-ops-apply-url', Accept: 'application/json' },
  });
  if (!response.ok) return null;
  let payload = null;
  try { payload = await response.json(); } catch { return null; }
  if (!payload || String(payload.id || '') !== String(jobId)) return null;
  return { board, title: payload.title || '', absolute_url: payload.absolute_url || '' };
}

/**
 * Return a certified apply URL when one can be proven from the posting URL.
 * Already-certified hosts pass through. Greenhouse careers shells with gh_jid
 * become the official embed form after a live board probe succeeds.
 */
export async function resolveCertifiedApplyUrl(url, {
  company = '',
  fetchImpl = DEFAULT_FETCH,
} = {}) {
  const original = String(url || '').trim();
  if (!original) return null;
  let parsed;
  try { parsed = new URL(original); } catch { return null; }

  const currentAts = atsFor(original);
  if (isCertifiedAts(currentAts) && currentAts !== 'generic') {
    return {
      url: original,
      ats: currentAts,
      resolved: false,
      board: null,
      job_id: greenhouseJobId(original),
      reason: 'already-certified',
    };
  }

  const jobId = greenhouseJobId(original);
  if (!jobId) {
    return {
      url: original,
      ats: currentAts,
      resolved: false,
      board: null,
      job_id: null,
      reason: 'no-greenhouse-job-id',
    };
  }

  const guesses = guessGreenhouseBoardTokens(original, { company });
  for (const board of guesses) {
    let hit = null;
    try { hit = await probeGreenhouseBoard(board, jobId, fetchImpl); }
    catch { continue; }
    if (!hit) continue;
    const embed = buildGreenhouseEmbedUrl(hit.board, jobId);
    return {
      url: embed,
      ats: 'greenhouse',
      resolved: true,
      board: hit.board,
      job_id: jobId,
      title: hit.title,
      reason: 'greenhouse-embed',
      source_url: original,
    };
  }

  return {
    url: original,
    ats: currentAts,
    resolved: false,
    board: null,
    job_id: jobId,
    reason: 'greenhouse-board-unresolved',
    guesses,
  };
}

/** Sync hint used by the web tracker: a generic host with gh_jid is resolvable. */
export function looksLikeResolvableGreenhouseShell(url) {
  return atsFor(url) === 'generic' && Boolean(greenhouseJobId(url));
}
