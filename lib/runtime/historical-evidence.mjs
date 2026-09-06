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
  if (parsed.hostname === 'job-boards.greenhouse.io') return 'greenhouse';
  if (parsed.hostname === 'jobs.ashbyhq.com') return 'ashby';
  if (/\.wd\d+\.myworkdayjobs\.com$/i.test(parsed.hostname)) return 'workday';
  return 'unsupported';
}

function greenhouseEndpoint(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/i);
  if (!match) return null;
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(match[1])}/jobs/${match[2]}?content=true`;
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

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json', 'user-agent': 'career-ops/1.6 qualification-evidence' },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported as invalid response */ }
  return { status: response.status, json, bytes: text.length };
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

export async function captureHistoricalEvidence({ caseId, sourceUrl, expectedTitle, fetchImpl = fetch, now = new Date() }) {
  const sourceType = sourceFor(sourceUrl);
  try {
    let endpoint;
    let status;
    let title;
    let html;
    if (sourceType === 'greenhouse') {
      endpoint = greenhouseEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.title;
      html = response.json?.content;
    } else if (sourceType === 'workday') {
      endpoint = workdayEndpoint(sourceUrl);
      if (!endpoint) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      title = response.json?.jobPostingInfo?.title;
      html = response.json?.jobPostingInfo?.jobDescription;
    } else if (sourceType === 'ashby') {
      const parsed = ashbyBoard(sourceUrl);
      if (!parsed) return unavailable(caseId, sourceUrl, sourceType, 'SOURCE_URL_UNPARSEABLE', now);
      endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parsed.board)}?includeCompensation=true`;
      const response = await fetchJson(fetchImpl, endpoint);
      status = response.status;
      const job = response.json?.jobs?.find(item => item.id === parsed.jobId || item.jobUrl === sourceUrl || item.applyUrl === sourceUrl);
      title = job?.title;
      html = job?.descriptionPlain || job?.descriptionHtml;
      if (status === 200 && !job) status = 404;
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
