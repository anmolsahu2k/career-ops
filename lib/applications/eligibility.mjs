import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { attemptKey, safeCanonicalUrl } from './contracts.mjs';

function scoreOf(value) {
  const match = String(value || '').replace(/\*+/g, '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return match ? Number(match[1]) : NaN;
}

function urlFrom(row, target) {
  // The report header is the canonical URL source. Tracker notes are prose and
  // commonly terminate a URL with sentence punctuation, which must not become
  // part of the application idempotency key or navigation target.
  const link = String(row.report || '').match(/\]\(([^)]+)\)/)?.[1];
  if (link && !/^https?:/i.test(link)) {
    try {
      const report = readFileSync(resolve(target, link), 'utf8');
      const reportUrl = report.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1]
        || report.match(/https?:\/\/[^\s)]+/i)?.[0];
      if (reportUrl) return reportUrl.replace(/[.,;:!?]+$/, '');
    } catch { /* Fall back to the tracker note below. */ }
  }
  const text = `${row.notes || ''} ${row.report || ''}`;
  const markdown = text.match(/\]\((https?:\/\/[^)\s]+)\)/i);
  const plain = text.match(/https?:\/\/[^\s|)]+/i);
  return (markdown?.[1] || plain?.[0] || '').replace(/[.,;:!?]+$/, '');
}

function trackerRows(target) {
  const tracker = join(resolve(target), 'data', 'applications.md');
  if (!existsSync(tracker)) return [];
  const lines = readFileSync(tracker, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  return lines.map(line => parseTrackerRow(line, columns)).filter(Boolean);
}

/** Explicit APPLY token required for the unattended queue; DO NOT APPLY wins. */
export function hasApplyToken(notes = '') {
  const text = String(notes || '');
  if (/\bDO\s+NOT\s+APPLY\b/i.test(text)) return false;
  return /\bAPPLY\b/i.test(text);
}

function candidateFromRow(row, target) {
  const rawUrl = urlFrom(row, target);
  if (!rawUrl) {
    return {
      row,
      eligible: false,
      near_miss: false,
      blocker: 'CANONICAL_URL_MISSING',
      detail: 'No HTTPS URL in report header or tracker notes',
    };
  }
  let canonical_url;
  try {
    canonical_url = safeCanonicalUrl(rawUrl);
  } catch {
    return {
      row,
      eligible: false,
      near_miss: false,
      blocker: 'CANONICAL_URL_INVALID',
      detail: rawUrl.slice(0, 200),
    };
  }
  const statusOk = String(row.status).trim() === 'Evaluated';
  const score = scoreOf(row.score);
  const scoreOk = score >= 4;
  const applyOk = hasApplyToken(row.notes);
  if (statusOk && scoreOk && applyOk) {
    return {
      row,
      eligible: true,
      near_miss: false,
      canonical_url,
      idempotency_key: attemptKey(row.num, canonical_url),
    };
  }
  // Near-miss: would enter the queue after Notes/status hygiene only.
  if (statusOk && scoreOk && !applyOk) {
    return {
      row,
      eligible: false,
      near_miss: true,
      canonical_url,
      idempotency_key: attemptKey(row.num, canonical_url),
      blocker: 'MISSING_APPLY_TOKEN',
      detail: 'Evaluated at 4.0+ but Notes lack an explicit APPLY token (runtime commits stamp APPLY.)',
    };
  }
  let blocker = 'NOT_ELIGIBLE';
  let detail = '';
  if (!statusOk) {
    blocker = 'STATUS_NOT_EVALUATED';
    detail = `status=${row.status}`;
  } else if (!scoreOk) {
    blocker = 'SCORE_BELOW_FLOOR';
    detail = `score=${row.score}`;
  }
  return {
    row,
    eligible: false,
    near_miss: false,
    canonical_url,
    idempotency_key: attemptKey(row.num, canonical_url),
    blocker,
    detail,
  };
}

export function isEligibleRow(row) {
  return String(row.status).trim() === 'Evaluated'
    && scoreOf(row.score) >= 4
    && hasApplyToken(row.notes);
}

/** Only rows with an explicit canonical application URL enter the queue. */
export function eligibleRows(target) {
  return trackerRows(target).filter(isEligibleRow).map(row => candidateFromRow(row, target));
}

/** Full diagnostic pass used by enqueue preview and apply doctor. */
export function diagnoseTrackerRows(target) {
  return trackerRows(target).map(row => candidateFromRow(row, target));
}

/** Find an exact tracker row without relaxing the normal queue's eligibility.
 * This supports a separately auditable, user-selected one-off override. */
export function candidateForTrackerNumber(target, trackerNumber) {
  const row = trackerRows(target).find(item => item.num === Number(trackerNumber));
  return row ? candidateFromRow(row, target) : null;
}

export { scoreOf };
