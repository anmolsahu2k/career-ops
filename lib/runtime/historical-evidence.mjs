import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { record, sha256 } from './util.mjs';

const MAX_CONTENT_CHARS = 96 * 1024;

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] || ' ';
    const hex = entity[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : ' ';
  });
}

export function plainTextFromHtml(value) {
  return decodeEntities(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|li|br|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .normalize('NFKC')
    .replace(/\0/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
}

function sourceFor(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  // Both the current and legacy Greenhouse board hosts serve the same paths.
  if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') return 'greenhouse';
  if (host === 'jobs.ashbyhq.com') return 'ashby';
  if (/\.wd\d+\.myworkdayjobs\.com$/i.test(host)) return 'workday';
  if (host === 'jobs.lever.co' || host.endsWith('.lever.co')) return 'lever';
  if (host.endsWith('smartrecruiters.com')) return 'smartrecruiters';
  // Company-branded pages that embed a Greenhouse board expose the req id.
  if (parsed.searchParams.has('gh_jid')) return 'greenhouse';
  return 'unsupported';
}

function greenhouseEndpoint(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/i);
  if (match) {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(match[1])}/jobs/${match[2]}?content=true`;
  }
  // Embedded board: /careers?gh_jid=123 needs the board token from the path.
  const jid = parsed.searchParams.get('gh_jid');
  const board = parsed.searchParams.get('gh_src') || parsed.pathname.split('/').filter(Boolean)[0];
  if (jid && board && /^\d+$/.test(jid)) {
    return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${jid}?content=true`;
  }
  return null;
}

function leverEndpoint(url) {
  const parsed = new URL(url);
  const [site, jobId] = parsed.pathname.split('/').filter(Boolean);
  if (!site || !jobId) return null;
  return `https://api.lever.co/v0/postings/${encodeURIComponent(site)}/${encodeURIComponent(jobId)}`;
}

function smartRecruitersEndpoint(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const company = segments[0];
  const posting = segments[1].match(/^(\d{6,})/);
  if (!posting) return null;
  return `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${posting[1]}`;
}

function smartRecruitersHtml(json) {
  const sections = json?.jobAd?.sections || {};
  return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map(key => sections[key]?.text)
    .filter(Boolean)
    .join('\n');
}

/** Best-effort posting date, used by the evaluate age gate. */
function postedAtFor(sourceType, json) {
  const raw = sourceType === 'greenhouse'
    ? (json?.first_published || json?.updated_at)
    : sourceType === 'ashby'
      ? (json?.publishedAt || json?.updatedAt)
      : sourceType === 'workday'
        ? (json?.jobPostingInfo?.startDate || json?.jobPostingInfo?.postedOn)
        : sourceType === 'lever'
          ? json?.createdAt
          : sourceType === 'smartrecruiters'
            ? (json?.releasedDate || json?.createdOn)
            : null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return new Date(raw).toISOString();
  const text = String(raw).trim();
  // Workday renders "Posted 5 Days Ago" / "Posted 30+ Days Ago" instead of a date.
  const relative = text.match(/posted\s+(\d+)\+?\s+days?\s+ago/i);
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000).toISOString();
  if (/posted\s+today|just posted/i.test(text)) return new Date().toISOString();
  if (/posted\s+yesterday/i.test(text)) return new Date(Date.now() - 86_400_000).toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function workdayEndpoint(url) {
  const parsed = new URL(url);
  const tenant = parsed.hostname.split('.')[0];
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIndex = segments.findIndex(value => value.toLowerCase() === 'job');
  if (jobIndex < 1 || jobIndex === segments.length - 1) return null;
  const site = segments[jobIndex - 1];
  return `https://${parsed.hostname}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/job/${segments.slice(jobIndex + 1).map(encodeURIComponent).join('/')}`;
}

function ashbyBoard(url) {
  const parsed = new URL(url);
  const [board, jobId] = parsed.pathname.split('/').filter(Boolean);
  return board && jobId ? { board, jobId } : null;
}

// A bot user-agent gets 403/challenge responses from several ATS edges, which
// previously read as "expired". Present as a normal browser client.
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': BROWSER_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported as invalid response */ }
  return { status: response.status, json, bytes: text.length };
}

// One Ashby request returns the whole board. Without this cache a 200-posting
// board is downloaded 200 times in a single evaluate run.
const BOARD_CACHE_TTL_MS = 10 * 60_000;
const boardCache = new Map();

async function fetchAshbyBoard(fetchImpl, board) {
  const key = board.toLowerCase();
  const cached = boardCache.get(key);
  if (cached && cached.expires_at > Date.now()) return cached.response;
  const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
  const response = await fetchJson(fetchImpl, endpoint);
  boardCache.set(key, { response, expires_at: Date.now() + BOARD_CACHE_TTL_MS, endpoint });
  return response;
}

function ashbyEndpointFor(board) {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
}

function findAshbyJob(json, parsed, sourceUrl) {
  return json?.jobs?.find(item => (
    item.id === parsed.jobId
    || item.jobUrl === sourceUrl
    || item.applyUrl === sourceUrl
    || String(item.jobUrl || '').endsWith(`/${parsed.jobId}`)
  ));
}

/** Test seam: clear the in-process ATS board cache. */
export function clearAtsBoardCache() {
  boardCache.clear();
}

function unavailable(caseId, sourceUrl, sourceType, code, now, details = {}) {
  const body = record('HistoricalEvidenceCacheV1', {
    case_id: caseId,
    captured_at: now.toISOString(),
    source_type: sourceType,
    source_url: sourceUrl,
    exact_source: false,
    complete: false,
    liveness_state: 'UNKNOWN',
    error_code: code,
    ...details,
    title: null,
    content: null,
    content_hash: null,
  });
  return { ...body, record_digest: sha256(body) };
}

/**
 * Lightweight ATS API liveness probe for empty Playwright shells.
 * Returns active/expired/unknown without requiring full JD content.
 */
export async function probeAtsLiveness(sourceUrl, { fetchImpl = fetch } = {}) {
  let sourceType;
  try {
    sourceType = sourceFor(sourceUrl);
  } catch {
    return { result: 'unknown', reason: 'unparseable_url' };
  }
  try {
    if (sourceType === 'greenhouse') {
      const endpoint = greenhouseEndpoint(sourceUrl);
      if (!endpoint) return { result: 'unknown', reason: 'greenhouse_url_unparseable' };
      const response = await fetchJson(fetchImpl, endpoint);
      if (response.status === 404 || response.status === 410) {
        return { result: 'expired', reason: `greenhouse API HTTP ${response.status}` };
      }
      if (response.status === 200 && response.json?.title) {
        return { result: 'active', reason: 'greenhouse API listing present', title: response.json.title };
      }
      return { result: 'unknown', reason: `greenhouse API HTTP ${response.status}` };
    }
    if (sourceType === 'ashby') {
      const parsed = ashbyBoard(sourceUrl);
      if (!parsed) return { result: 'unknown', reason: 'ashby_url_unparseable' };
      const response = await fetchAshbyBoard(fetchImpl, parsed.board);
      if (response.status === 404 || response.status === 410) {
        return { result: 'expired', reason: `ashby API HTTP ${response.status}` };
      }
      if (response.status !== 200) {
        return { result: 'unknown', reason: `ashby API HTTP ${response.status}` };
      }
      const job = findAshbyJob(response.json, parsed, sourceUrl);
      if (!job) return { result: 'expired', reason: 'ashby API job id not listed' };
      return { result: 'active', reason: 'ashby API listing present', title: job.title };
    }
    if (sourceType === 'lever') {
      const endpoint = leverEndpoint(sourceUrl);
      if (!endpoint) return { result: 'unknown', reason: 'lever_url_unparseable' };
      const response = await fetchJson(fetchImpl, endpoint);
      if (response.status === 404 || response.status === 410) {
        return { result: 'expired', reason: `lever API HTTP ${response.status}` };
      }
      if (response.status === 200 && response.json?.text) {
        return { result: 'active', reason: 'lever API listing present', title: response.json.text };
      }
      return { result: 'unknown', reason: `lever API HTTP ${response.status}` };
    }
    if (sourceType === 'smartrecruiters') {
      const endpoint = smartRecruitersEndpoint(sourceUrl);
      if (!endpoint) return { result: 'unknown', reason: 'smartrecruiters_url_unparseable' };
      const response = await fetchJson(fetchImpl, endpoint);
      if (response.status === 404 || response.status === 410) {
        return { result: 'expired', reason: `smartrecruiters API HTTP ${response.status}` };
      }
      if (response.status === 200 && response.json?.name) {
        return { result: 'active', reason: 'smartrecruiters API listing present', title: response.json.name };
      }
      return { result: 'unknown', reason: `smartrecruiters API HTTP ${response.status}` };
    }
    if (sourceType === 'workday') {
      const endpoint = workdayEndpoint(sourceUrl);
      if (!endpoint) return { result: 'unknown', reason: 'workday_url_unparseable' };
      const response = await fetchJson(fetchImpl, endpoint);
      if (response.status === 404 || response.status === 410) {
        return { result: 'expired', reason: `workday API HTTP ${response.status}` };
      }
      if (response.status === 200 && response.json?.jobPostingInfo?.title) {
        return {
          result: 'active',
          reason: 'workday API listing present',
          title: response.json.jobPostingInfo.title,
        };
      }
      return { result: 'unknown', reason: `workday API HTTP ${response.status}` };
    }
    return { result: 'unknown', reason: 'unsupported_source' };
  } catch (error) {
    return { result: 'unknown', reason: error.message || 'ats_probe_failed' };
  }
}

export async function captureHistoricalEvidence({ caseId, sourceUrl, expectedTitle, fetchImpl = fetch, now = new Date() }) {
  const sourceType = sourceFor(sourceUrl);
  try {
    let endpoint;
    let status;
    let title;
    let html;
    let postedAt = null;
    if (sourceType === 'greenhouse') {
      endpoint = greenhouseEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.title;
      html = response.json?.content;
      postedAt = postedAtFor(sourceType, response.json);
    } else if (sourceType === 'workday') {
      endpoint = workdayEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.jobPostingInfo?.title;
      html = response.json?.jobPostingInfo?.jobDescription;
      postedAt = postedAtFor(sourceType, response.json);
    } else if (sourceType === 'ashby') {
      const parsed = ashbyBoard(sourceUrl);
      if (!parsed) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      endpoint = ashbyEndpointFor(parsed.board);
      const response = await fetchAshbyBoard(fetchImpl, parsed.board);
      status = response.status;
      const job = findAshbyJob(response.json, parsed, sourceUrl);
      title = job?.title;
      html = job?.descriptionPlain || job?.descriptionHtml;
      postedAt = postedAtFor(sourceType, job);
      if (status === 200 && !job) status = 404;
    } else if (sourceType === 'lever') {
      endpoint = leverEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.text;
      html = response.json?.descriptionPlain || response.json?.description;
      postedAt = postedAtFor(sourceType, response.json);
    } else if (sourceType === 'smartrecruiters') {
      endpoint = smartRecruitersEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.name;
      html = smartRecruitersHtml(response.json);
      postedAt = postedAtFor(sourceType, response.json);
    } else {
      return unavailable(caseId, sourceUrl, sourceType, 'AMBIGUOUS_OR_UNSUPPORTED_SOURCE', now);
    }
    if (status !== 200 || !title || !html) {
      return unavailable(caseId, sourceUrl, sourceType, status === 404 ? 'SOURCE_NOT_LISTED' : 'SOURCE_RESPONSE_INVALID', now, {
        endpoint_url: endpoint,
        http_status: status,
      });
    }
    const normalizedExpected = String(expectedTitle || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const normalizedActual = String(title).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normalizedExpected && normalizedActual && !normalizedExpected.includes(normalizedActual) && !normalizedActual.includes(normalizedExpected)) {
      return unavailable(caseId, sourceUrl, sourceType, 'TITLE_MISMATCH', now, {
        endpoint_url: endpoint,
        http_status: status,
        observed_title: String(title).slice(0, 512),
      });
    }
    const content = plainTextFromHtml(html);
    if (content.length < 200) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_CONTENT_TOO_SHORT', now);
    const body = record('HistoricalEvidenceCacheV1', {
      case_id: caseId,
      captured_at: now.toISOString(),
      source_type: sourceType,
      source_url: sourceUrl,
      endpoint_url: endpoint,
      http_status: status,
      exact_source: true,
      complete: true,
      liveness_state: 'YES',
      error_code: null,
      posted_at: postedAt,
      title: String(title),
      content,
      content_hash: sha256(content),
    });
    return { ...body, record_digest: sha256(body) };
  } catch (error) {
    return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_FETCH_FAILED', now, {
      safe_error: error?.name || 'Error',
    });
  }
}

export function verifyHistoricalEvidenceCache(value) {
  if (value?.schema !== 'HistoricalEvidenceCacheV1' || value.schema_version !== 1) return false;
  const { record_digest: observed, ...body } = value;
  if (!observed || sha256(body) !== observed) return false;
  if (value.complete === true) return value.exact_source === true && sha256(value.content || '') === value.content_hash;
  return value.content === null && value.content_hash === null;
}

export function writeHistoricalEvidenceCache(entries, outputDir) {
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!verifyHistoricalEvidenceCache(entry)) throw new Error(`Invalid evidence cache record for ${entry?.case_id || 'unknown case'}`);
    const path = join(dir, `${entry.case_id}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}

export function readHistoricalEvidenceCache(inputDir) {
  const dir = resolve(inputDir);
  const output = new Map();
  for (let number = 1; number <= 999; number++) {
    const caseId = `HIST-${String(number).padStart(3, '0')}`;
    const path = join(dir, `${caseId}.json`);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (!verifyHistoricalEvidenceCache(value)) throw new Error(`Evidence cache digest mismatch for ${caseId}`);
      output.set(caseId, value);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return output;
}
