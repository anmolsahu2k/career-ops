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

function candidateFromRow(row, target) {
  const rawUrl = urlFrom(row, target);
  if (!rawUrl) return { row, eligible: false, blocker: 'CANONICAL_URL_MISSING' };
  try {
    const canonical_url = safeCanonicalUrl(rawUrl);
    return { row, eligible: isEligibleRow(row), canonical_url, idempotency_key: attemptKey(row.num, canonical_url) };
  } catch {
    return { row, eligible: false, blocker: 'CANONICAL_URL_INVALID' };
  }
}

export function isEligibleRow(row) {
  return String(row.status).trim() === 'Evaluated'
    && scoreOf(row.score) >= 4
    && /\bAPPLY\b/i.test(String(row.notes || ''));
}

/** Only rows with an explicit canonical application URL enter the queue. */
export function eligibleRows(target) {
  return trackerRows(target).filter(isEligibleRow).map(row => candidateFromRow(row, target));
}

/** Find an exact tracker row without relaxing the normal queue's eligibility.
 * This supports a separately auditable, user-selected one-off override. */
export function candidateForTrackerNumber(target, trackerNumber) {
  const row = trackerRows(target).find(item => item.num === Number(trackerNumber));
  return row ? candidateFromRow(row, target) : null;
}

export { scoreOf };
