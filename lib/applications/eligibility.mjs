import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { atsFor, isCertifiedAts } from './ats.mjs';
import { looksLikeResolvableGreenhouseShell } from './apply-url.mjs';
import { attemptKey, safeCanonicalUrl } from './contracts.mjs';

export const DEDICATED_APPLY_SCORE_FLOOR = 4;

export function applyScoreFloor(config = {}, { ats } = {}) {
  if (ats === 'handshake') {
    const n = Number(config?.applications?.main_profile?.apply_score_minimum);
    return Number.isFinite(n) ? n : 3.5;
  }
  return DEDICATED_APPLY_SCORE_FLOOR;
}

function scoreOf(value) {
  const match = String(value || '').replace(/\*+/g, '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
  return match ? Number(match[1]) : NaN;
}

function urlFrom(row, target, report = '') {
  // The report header is the canonical URL source. Tracker notes are prose and
  // commonly terminate a URL with sentence punctuation, which must not become
  // part of the application idempotency key or navigation target.
  if (report) {
    const reportUrl = report.match(/^\*\*URL:\*\*\s*(https?:\/\/\S+)/mi)?.[1]
      || report.match(/https?:\/\/[^\s)]+/i)?.[0];
    if (reportUrl) return reportUrl.replace(/[.,;:!?]+$/, '');
  }
  const link = String(row.report || '').match(/\]\(([^)]+)\)/)?.[1];
  if (link && /^https?:/i.test(link)) {
    return link.replace(/[.,;:!?]+$/, '');
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

/** Explicit APPLY or CONSIDER token required for the unattended queue; DO NOT APPLY wins. */
export function hasApplyToken(notes = '') {
  const text = String(notes || '');
  if (/\bDO\s+NOT\s+APPLY\b/i.test(text)) return false;
  return /\bAPPLY\b/i.test(text) || /\bCONSIDER\b/i.test(text);
}

/** Policy recommendation line from a committed A-G report. */
export function reportQueueDecision(report = '') {
  const raw = String(report || '').match(/^## Recommendation\s*\r?\n+([^\n]+)/m)?.[1] || '';
  // Agent templates sometimes bold the verb (`**Apply within 48 hours.**`).
  // Strip leading/trailing markdown emphasis so the canonical verb still parses.
  const line = raw.replace(/^[*_`~\s]+/, '').replace(/[*_`~]+$/g, '').trim();
  if (/^Do not apply\b/i.test(line)) return 'DO_NOT_APPLY';
  if (/^Apply\b/i.test(line)) return 'APPLY';
  if (/^Consider\b/i.test(line)) return 'CONSIDER';
  return null;
}

function loadReport(row, target) {
  const link = String(row.report || '').match(/\]\(([^)]+)\)/)?.[1];
  if (!link || /^https?:/i.test(link)) return '';
  try { return readFileSync(resolve(target, link), 'utf8'); }
  catch { return ''; }
}

/** Notes APPLY/CONSIDER, or report Recommendation Apply/Consider. DO NOT APPLY wins. */
export function hasEnqueueAuthority(notes, report) {
  if (/\bDO\s+NOT\s+APPLY\b/i.test(String(notes || ''))) return false;
  if (hasApplyToken(notes)) return true;
  const decision = reportQueueDecision(report);
  return decision === 'APPLY' || decision === 'CONSIDER';
}

/**
 * Fail-closed contract for Evaluated rows at the dedicated apply floor:
 * enqueue authority must be explicit in Notes or ## Recommendation.
 * Used by verify-pipeline and merge-tracker so incomplete agent reports
 * cannot silently land as MISSING_APPLY_TOKEN near-misses again.
 */
export function evaluatedQueueContract({ status, score, notes, report }, { scoreFloor = DEDICATED_APPLY_SCORE_FLOOR } = {}) {
  const cleanStatus = String(status || '').replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  if (cleanStatus !== 'Evaluated') return { ok: true, reason: null };
  if (!(scoreOf(score) >= Number(scoreFloor))) return { ok: true, reason: null };
  if (/\bDO\s+NOT\s+APPLY\b/i.test(String(notes || ''))) {
    return { ok: false, reason: 'Evaluated rows must not carry DO NOT APPLY; use Rejected-at-eval' };
  }
  if (hasEnqueueAuthority(notes, report)) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `Evaluated ${String(score).replace(/\*+/g, '').trim()} needs APPLY./CONSIDER. in Notes or ## Recommendation starting with Apply/Consider`,
  };
}

/** Evaluated 4.0+ APPLY rows are still a near-miss when the host is not an
 * enabled ATS. Generic careers shells with a Greenhouse job id stay open for
 * embed resolution. */
export function portalNearMiss(url, allowedAts = null) {
  if (!url) return null;
  const resolvableGreenhouse = looksLikeResolvableGreenhouseShell(url);
  let ats = 'generic';
  try { ats = atsFor(url); } catch { ats = 'generic'; }
  if (resolvableGreenhouse) {
    if (allowedAts && !allowedAts.has('greenhouse')) {
      return {
        blocker: 'UNSUPPORTED_PORTAL',
        detail: 'Greenhouse is not in the local supported_ats allowlist',
      };
    }
    return null;
  }
  if (allowedAts && allowedAts.has(ats)) return null;
  if (!allowedAts) return null;
  if (!isCertifiedAts(ats) || !allowedAts.has(ats)) {
    const enabled = [...allowedAts].join(', ') || 'none';
    return {
      blocker: 'UNSUPPORTED_PORTAL',
      detail: isCertifiedAts(ats)
        ? `${ats} is not in the local supported_ats allowlist (${enabled})`
        : 'Application host is not a certified ATS surface',
    };
  }
  return null;
}

function candidateFromRow(row, target, { allowedAts = null, scoreFloor = DEDICATED_APPLY_SCORE_FLOOR } = {}) {
  const report = loadReport(row, target);
  const rawUrl = urlFrom(row, target, report);
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
  const scoreOk = score >= Number(scoreFloor);
  const applyOk = hasEnqueueAuthority(row.notes, report);
  if (statusOk && scoreOk) {
    const portal = portalNearMiss(canonical_url, allowedAts);
    if (portal) {
      return {
        row,
        eligible: false,
        near_miss: true,
        canonical_url,
        idempotency_key: attemptKey(row.num, canonical_url),
        blocker: portal.blocker,
        detail: portal.detail,
      };
    }
  }
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
      detail: `Evaluated at ${Number(scoreFloor).toFixed(1)}+ but Notes lack APPLY/CONSIDER and the report is not an Apply or Consider recommendation`,
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

export function isEligibleRow(row, { scoreFloor = DEDICATED_APPLY_SCORE_FLOOR } = {}) {
  return String(row.status).trim() === 'Evaluated'
    && scoreOf(row.score) >= Number(scoreFloor)
    && hasApplyToken(row.notes);
}

/** Only rows with an explicit canonical application URL enter the queue. */
export function eligibleRows(target, options = {}) {
  return diagnoseTrackerRows(target, options).filter(item => item.eligible);
}

/** Full diagnostic pass used by enqueue preview and apply doctor. */
export function diagnoseTrackerRows(target, options = {}) {
  return trackerRows(target).map(row => candidateFromRow(row, target, options));
}

/** Find an exact tracker row without relaxing the normal queue's eligibility.
 * This supports a separately auditable, user-selected one-off override. */
export function candidateForTrackerNumber(target, trackerNumber, options = {}) {
  const row = trackerRows(target).find(item => item.num === Number(trackerNumber));
  return row ? candidateFromRow(row, target, options) : null;
}

export { scoreOf };
