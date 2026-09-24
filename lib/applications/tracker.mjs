import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { persistencePaths, acquireWriterLock } from '../runtime/transaction.mjs';
import { listAttempts, transitionAttempt } from './store.mjs';
import { TERMINAL_ATTEMPT_STATES } from './contracts.mjs';
import { withApplyUrlToken } from '../sources.mjs';

export function calendarDate(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** The only application writer for applications.md.  It changes two existing
 * cells and appends a non-sensitive attempt reference; it never adds columns. */
export async function markApplied(target, trackerNumber, attemptId, now = new Date(), timeZone = undefined) {
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const original = readFileSync(paths.appsFile, 'utf8');
    const lines = original.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let changed = false;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber)) return line;
      if (row.status === 'Applied') return line;
      if (row.status !== 'Evaluated') throw new Error(`Tracker row ${trackerNumber} changed to ${row.status}`);
      const cells = line.split('|');
      cells[columns.status] = ' Applied ';
      cells[columns.date] = ` ${calendarDate(now, timeZone)} `;
      const note = String(cells[columns.notes] || '').trim();
      cells[columns.notes] = ` ${[note, `APP:${attemptId}`].filter(Boolean).join(' ')} `;
      changed = true;
      return cells.join('|');
    });
    if (!changed) return { changed: false };
    const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, paths.appsFile);
    return { changed: true };
  } finally { await lock.release(); }
}

/** Record Handshake Apply Externally destination in Notes. Never adds columns. */
export async function markExternalApplyUrl(target, trackerNumber, url, host = '') {
  const href = String(url || '').trim();
  const hostname = String(host || '').trim();
  if (!href && !hostname) return { changed: false };
  if (/(^|\.)joinhandshake\.com$/i.test(hostname || href)) return { changed: false };
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const original = readFileSync(paths.appsFile, 'utf8');
    const lines = original.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let changed = false;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber)) return line;
      const note = withApplyUrlToken(row.notes, href, hostname);
      if (note === String(row.notes || '').trim()) return line;
      const cells = line.split('|');
      cells[columns.notes] = ` ${note} `;
      changed = true;
      return cells.join('|');
    });
    if (!changed) return { changed: false };
    const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, paths.appsFile);
    return { changed: true };
  } finally { await lock.release(); }
}

/** Notes pointer for a cover letter that was generated for this row. */
export async function markCoverLetter(target, trackerNumber, relativePath) {
  const href = String(relativePath || '').replace(/\\/g, '/').replace(/^\//, '');
  if (!href || href.includes('..')) return { changed: false };
  const token = `CL: [${href.split('/').pop()}](${href})`;
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const lines = readFileSync(paths.appsFile, 'utf8').split(/\r?\n/);
    const columns = resolveColumns(lines);
    let changed = false;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber) || /(?:^|\s)CL:/.test(row.notes || '')) return line;
      const cells = line.split('|');
      const note = String(cells[columns.notes] || '').trim();
      cells[columns.notes] = ` ${[note, token].filter(Boolean).join(' ')} `;
      changed = true;
      return cells.join('|');
    });
    if (!changed) return { changed: false };
    const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, paths.appsFile);
    return { changed: true };
  } finally { await lock.release(); }
}

/** Candidate-only tracker status. Same meaning as the dashboard `d` key.
 * Automated jobs must not call this. */
export async function markDiscarded(target, trackerNumber) {
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const original = readFileSync(paths.appsFile, 'utf8');
    const lines = original.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let found = false;
    let changed = false;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber)) return line;
      found = true;
      if (row.status === 'Discarded') return line;
      const cells = line.split('|');
      cells[columns.status] = ' Discarded ';
      changed = true;
      return cells.join('|');
    });
    if (!found) {
      throw Object.assign(new Error(`Tracker row ${trackerNumber} was not found`), { code: 'TRACKER_NOT_FOUND' });
    }
    if (!changed) return { changed: false, already: true };
    const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, paths.appsFile);
    return { changed: true, already: false };
  } finally { await lock.release(); }
}

function closeOpenAttempts(target, trackerNumber, blocker) {
  const skipped = [];
  for (const attempt of listAttempts(target)) {
    if (Number(attempt.tracker_number) !== Number(trackerNumber)) continue;
    if (TERMINAL_ATTEMPT_STATES.has(attempt.state)) continue;
    skipped.push(transitionAttempt(target, attempt.idempotency_key, 'SKIPPED', {
      blockers: [blocker],
    }));
  }
  return skipped;
}

function skipOpenAttempts(target, trackerNumber) {
  return closeOpenAttempts(target, trackerNumber, {
    code: 'USER_DISCARDED',
    question: '',
    detail: 'Candidate discarded the tracker row',
  });
}

/** User-triggered Applied status. Does not submit an application. */
export async function markTrackerApplied(target, trackerNumber, now = new Date(), timeZone = undefined) {
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  let tracker;
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const original = readFileSync(paths.appsFile, 'utf8');
    const lines = original.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let found = false;
    let changed = false;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber)) return line;
      found = true;
      if (row.status === 'Applied') return line;
      const cells = line.split('|');
      cells[columns.status] = ' Applied ';
      cells[columns.date] = ` ${calendarDate(now, timeZone)} `;
      changed = true;
      return cells.join('|');
    });
    if (!found) {
      throw Object.assign(new Error(`Tracker row ${trackerNumber} was not found`), { code: 'TRACKER_NOT_FOUND' });
    }
    if (changed) {
      const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
      renameSync(temp, paths.appsFile);
    }
    tracker = { changed, already: !changed };
  } finally { await lock.release(); }
  const skipped = closeOpenAttempts(target, trackerNumber, {
    code: 'USER_APPLIED',
    question: '',
    detail: 'Candidate marked the tracker row Applied',
  });
  return {
    tracker_number: Number(trackerNumber),
    tracker,
    skipped_count: skipped.length,
    skipped_keys: skipped.map(item => item.idempotency_key),
  };
}

/** User-triggered discard: tracker Discarded, then skip open attempts. */
export async function discardTrackerRow(target, trackerNumber) {
  const tracker = await markDiscarded(target, trackerNumber);
  const skipped = skipOpenAttempts(target, trackerNumber);
  return {
    tracker_number: Number(trackerNumber),
    tracker,
    skipped_count: skipped.length,
    skipped_keys: skipped.map(item => item.idempotency_key),
  };
}

function writeAtomic(path, content) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

/** Keep the evaluation report and apply-time JD receipt aligned with the
 * tracker after an adapter-recognized submission. The posting text is captured
 * from the live page with its application form removed, so candidate answers
 * never enter the archive. */
export function recordAppliedArtifacts(target, attempt, {
  postingText = '', appliedAt = new Date(), timeZone = undefined, sourceUrl = '',
} = {}) {
  const link = String(attempt.report_id || '').match(/\]\(([^)]+)\)/)?.[1];
  if (!link || /^https?:/i.test(link)) throw new Error('Application report path is missing');
  const root = resolve(target);
  const reportPath = resolve(root, link);
  if (relative(root, reportPath).startsWith(`..${sep}`) || relative(root, reportPath) === '..') {
    throw new Error('Application report path escapes the target');
  }
  if (!existsSync(reportPath)) throw new Error('Application report not found');
  const report = readFileSync(reportPath, 'utf8');
  let updated = report.replace(/(\*\*Status:\*\*\s*)Evaluated\b/, '$1Applied');
  // Reports created before Status became a mandatory trusted header still
  // exist in the live funnel. A confirmed submission should upgrade that
  // legacy report in place instead of leaving tracker and archive state split.
  if (updated === report && !/\*\*Status:\*\*\s*Applied\b/.test(report)) {
    const newline = report.includes('\r\n') ? '\r\n' : '\n';
    const lines = report.split(/\r?\n/);
    const resumeIndex = lines.findIndex(line => /^\*\*Resume:\*\*/.test(line));
    const urlIndex = lines.findIndex(line => /^\*\*URL:\*\*/.test(line));
    const insertAfter = resumeIndex >= 0 ? resumeIndex : urlIndex;
    if (insertAfter < 0) throw new Error('Application report trusted header not found');
    lines.splice(insertAfter + 1, 0, '**Status:** Applied');
    updated = lines.join(newline);
  }
  if (updated !== report) writeAtomic(reportPath, updated);

  const stem = basename(reportPath, '.md').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const archivePath = join(dirname(reportPath), `${stem}-jd.md`);
  const archived = calendarDate(appliedAt, timeZone);
  const body = String(postingText || '').trim() || '{posting text unavailable - not captured at apply time}';
  const content = `# JD Archive: ${attempt.company} - ${attempt.role}\n\n**URL:** ${sourceUrl || attempt.canonical_url}\n**Archived:** ${archived} (at time of application)\n**Tracker row:** #${attempt.tracker_number}\n\n---\n\n${body}\n`;
  if (!existsSync(archivePath)) writeAtomic(archivePath, content);
  return { report_path: reportPath, archive_path: archivePath };
}

/** Correct a false positive only when this runner's exact marker is present.
 * This is deliberately narrower than a general "unapply" operation: a portal
 * may visibly reject a request after an HTTP 2xx response, and that result must
 * never remain Applied in the tracker. */
export async function revertFalseApplied(target, trackerNumber, attemptId) {
  const paths = persistencePaths(target);
  const lock = await acquireWriterLock(paths);
  try {
    if (!existsSync(paths.appsFile)) throw new Error('Tracker not found');
    const original = readFileSync(paths.appsFile, 'utf8');
    const lines = original.split(/\r?\n/);
    const columns = resolveColumns(lines);
    let changed = false;
    const marker = `APP:${attemptId}`;
    const next = lines.map(line => {
      const row = parseTrackerRow(line, columns);
      if (!row || row.num !== Number(trackerNumber)) return line;
      if (row.status !== 'Applied' || !String(row.notes || '').includes(marker)) {
        throw new Error(`Tracker row ${trackerNumber} is not the false-positive application record`);
      }
      const cells = line.split('|');
      cells[columns.status] = ' Evaluated ';
      cells[columns.date] = ' ';
      const note = String(cells[columns.notes] || '').trim()
        .replace(new RegExp(`(?:^|\\s)${marker.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?=\\s|$)`), '')
        .replace(/\s{2,}/g, ' ').trim();
      cells[columns.notes] = ` ${note} `;
      changed = true;
      return cells.join('|');
    });
    if (!changed) return { changed: false };
    const temp = join(dirname(paths.appsFile), `.applications.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temp, next.join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temp, paths.appsFile);
    return { changed: true };
  } finally { await lock.release(); }
}
