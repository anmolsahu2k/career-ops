import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { persistencePaths, acquireWriterLock } from '../runtime/transaction.mjs';

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
