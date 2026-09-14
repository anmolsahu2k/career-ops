/**
 * status.mjs — read-only funnel snapshot for the Career-Ops web app.
 * Never returns CV text, emails, or other candidate PII.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listAttempts } from '../applications/store.mjs';
import { diagnoseTrackerRows } from '../applications/eligibility.mjs';
import { applicationQueuePreview } from '../applications/enqueue-summary.mjs';
import { applicationAttemptAnalytics } from '../applications/analytics.mjs';
import { diagnoseApplications } from '../applications/doctor.mjs';
import { TERMINAL_ATTEMPT_STATES } from '../applications/contracts.mjs';
import { publicAttempt } from '../applications/board.mjs';
import { atsFor } from '../applications/ats.mjs';
import { looksLikeResolvableGreenhouseShell } from '../applications/apply-url.mjs';
import { readSrcToken } from '../sources.mjs';
import {
  evaluateQueuePath,
  listScanResultFiles,
  loadScanResults,
  readEvaluateQueue,
} from '../runtime/evaluate-scan.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';

function countBy(rows, keyFn) {
  const counts = {};
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function readTrackerRows(appsFile) {
  if (!existsSync(appsFile)) return [];
  const lines = readFileSync(appsFile, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  return lines.map(line => parseTrackerRow(line, columns)).filter(Boolean);
}

function publicTrackerRow(row, { diagnosticsByNum = new Map(), attemptsByNum = new Map() } = {}) {
  const report = String(row.report || '');
  const reportMatch = report.match(/\(([^)]+\.md)\)/);
  const source = readSrcToken(row.notes) || '';
  const attempts = attemptsByNum.get(Number(row.num)) || [];
  const terminal = attempts.find(item => TERMINAL_ATTEMPT_STATES.has(item.state));
  const active = attempts.find(item => ['QUEUED', 'RUNNING', 'WAITING_LOGIN', 'READY_TO_SUBMIT', 'SUBMITTING', 'NEEDS_REVIEW'].includes(item.state));
  const evaluated = String(row.status || '').trim() === 'Evaluated';
  const diagnosis = diagnosticsByNum.get(Number(row.num)) || null;
  const portalUnsupported = Boolean(diagnosis?.canonical_url)
    && atsFor(diagnosis.canonical_url) === 'generic'
    && !looksLikeResolvableGreenhouseShell(diagnosis.canonical_url);
  let apply_reason = 'not_evaluated';
  if (!evaluated) apply_reason = String(row.status || 'unknown').toLowerCase();
  else if (terminal) apply_reason = String(terminal.state).toLowerCase();
  else if (active && active.state !== 'QUEUED' && active.state !== 'READY_TO_SUBMIT') apply_reason = String(active.state).toLowerCase();
  else if (portalUnsupported) apply_reason = 'unsupported_portal';
  else if (diagnosis?.near_miss) apply_reason = String(diagnosis.blocker || 'near_miss').toLowerCase();
  else if (diagnosis?.eligible) apply_reason = 'eligible';
  else if (diagnosis?.blocker) apply_reason = String(diagnosis.blocker).toLowerCase();
  else apply_reason = 'override';
  // Near-miss rows (e.g. missing APPLY token) must not one-click apply until Notes are fixed.
  // Company careers mirrors with only a Greenhouse job id are discovery URLs, not certified apply hosts.
  const can_apply = evaluated && !terminal && !portalUnsupported
    && !(active && !['QUEUED', 'READY_TO_SUBMIT'].includes(active.state))
    && !diagnosis?.near_miss;
  return {
    num: row.num,
    date: row.date || '',
    company: row.company || '',
    role: row.role || '',
    score: row.score || '',
    status: row.status || '',
    source,
    report_path: reportMatch ? reportMatch[1] : '',
    posting_url: typeof diagnosis?.canonical_url === 'string' ? diagnosis.canonical_url : '',
    notes_preview: String(row.notes || '').slice(0, 160),
    can_apply,
    apply_eligible: Boolean(diagnosis?.eligible),
    apply_near_miss: Boolean(diagnosis?.near_miss),
    apply_reason,
    attempt_state: (terminal || active || {}).state || '',
  };
}

function scanHistoryTail(dataDir, limit = 12) {
  const path = join(dataDir, 'scan-history.tsv');
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const body = lines[0]?.startsWith('url\t') ? lines.slice(1) : lines;
  return body.slice(-limit).reverse().map(line => {
    const [url = '', status = '', detail = ''] = line.split('\t');
    return {
      url: url.slice(0, 200),
      status: status.slice(0, 80),
      detail: detail.slice(0, 120),
    };
  });
}

function publicDoctor(config, target) {
  if (!config) return null;
  try {
    const report = diagnoseApplications(target, config);
    return {
      ready: report.ready === true,
      summary: report.summary || '',
      failed: (report.checks || []).filter(item => !item.ok).map(item => ({
        code: item.code,
        detail: String(item.detail || '').slice(0, 200),
      })),
      near_miss_count: report.queue?.near_miss_count || 0,
    };
  } catch (error) {
    return {
      ready: false,
      summary: String(error.message || error).slice(0, 200),
      failed: [{ code: 'DOCTOR_ERROR', detail: String(error.message || error).slice(0, 200) }],
      near_miss_count: 0,
    };
  }
}

/**
 * Build a safe funnel snapshot for the UI.
 */
export function buildFunnelStatus({
  target,
  repoRoot,
  writable = false,
  writerHost = null,
  observedHost = null,
  applicationsEnabled = false,
  currentJob = null,
  config = null,
} = {}) {
  const paths = persistencePaths(target);
  const triageFiles = listScanResultFiles(paths.dataDir);
  const triageRows = loadScanResults(triageFiles);
  const queuePath = evaluateQueuePath(paths.dataDir);
  const queueRows = readEvaluateQueue(queuePath);
  const trackerRows = readTrackerRows(paths.appsFile);
  const statusCounts = countBy(trackerRows, row => row.status);
  const rawAttempts = listAttempts(target);
  const attemptsByNum = new Map();
  for (const item of rawAttempts) {
    const num = Number(item.tracker_number);
    if (!attemptsByNum.has(num)) attemptsByNum.set(num, []);
    attemptsByNum.get(num).push(item);
  }
  const attempts = rawAttempts
    .map(publicAttempt)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  let preview = {
    eligible_count: 0,
    eligible: [],
    near_misses: [],
    by_blocker: {},
    human_summary: '',
  };
  let diagnosticsByNum = new Map();
  try {
    preview = applicationQueuePreview(target);
    diagnosticsByNum = new Map(
      diagnoseTrackerRows(target).map(item => [Number(item.row.num), item]),
    );
  } catch {
    preview = { eligible_count: 0, eligible: [], near_misses: [], by_blocker: {}, human_summary: '' };
  }

  let analytics = null;
  try {
    const full = applicationAttemptAnalytics(target);
    analytics = {
      attempt_count: full.attempt_count,
      by_state: full.by_state,
      by_ats: full.by_ats,
      top_blockers: (full.top_blockers || []).slice(0, 8),
      conversion: full.conversion,
    };
  } catch {
    analytics = null;
  }

  const rows = [...trackerRows].reverse().map(row => publicTrackerRow(row, { diagnosticsByNum, attemptsByNum }));

  let nextStep = 'discovery';
  if (queueRows.length) nextStep = 'evaluate';
  else if (triageRows.length) nextStep = 'evaluate';
  else if (preview.eligible_count) nextStep = 'apply';
  else if (trackerRows.length) nextStep = 'tracker';

  return {
    schema: 'CareerOpsWebStatusV1',
    schema_version: 1,
    target,
    repo_root: repoRoot,
    writable: Boolean(writable),
    writer_host: writerHost,
    observed_host: observedHost,
    applications_enabled: Boolean(applicationsEnabled),
    next_step: nextStep,
    current_job: currentJob,
    discovery: {
      triage_files: triageFiles.map(path => path.replace(/\\/g, '/')),
      triage_count: triageRows.length,
      scan_history_tail: scanHistoryTail(paths.dataDir),
    },
    evaluate: {
      queue_path: queuePath.replace(/\\/g, '/'),
      queue_count: queueRows.length,
      queue: queueRows.slice(0, 200).map(row => ({
        url: row.url,
        company: row.company,
        title: row.title,
        location: row.location || '',
        source: row.source || '',
      })),
    },
    tracker: {
      total: trackerRows.length,
      status_counts: statusCounts,
      rows,
      recent: rows.slice(0, 40),
    },
    apply: {
      board_path: '/apply/',
      actions_enabled: Boolean(writable && applicationsEnabled),
      attempt_counts: countBy(attempts, item => item.state),
      attempts: attempts.slice(0, 200),
      eligible_count: preview.eligible_count,
      eligible: (preview.eligible || []).slice(0, 50),
      near_miss_count: (preview.near_misses || []).length,
      near_misses: (preview.near_misses || []).slice(0, 40),
      by_blocker: preview.by_blocker || {},
      human_summary: preview.human_summary || '',
      analytics,
      doctor: publicDoctor(config, target),
    },
  };
}

export function readReportMarkdown(target, relativePath) {
  const paths = persistencePaths(target);
  const cleaned = String(relativePath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..') || !cleaned.endsWith('.md')) {
    throw Object.assign(new Error('Invalid report path'), { code: 'BAD_REPORT_PATH' });
  }
  const absolute = join(paths.target, cleaned);
  const root = paths.target.replace(/\\/g, '/');
  const check = absolute.replace(/\\/g, '/');
  if (!check.startsWith(`${root}/`) && check !== root) {
    throw Object.assign(new Error('Report path escapes target'), { code: 'BAD_REPORT_PATH' });
  }
  if (!existsSync(absolute)) {
    throw Object.assign(new Error('Report not found'), { code: 'REPORT_NOT_FOUND' });
  }
  return readFileSync(absolute, 'utf8');
}

export function listTriagePreview(target, limit = 40) {
  const paths = persistencePaths(target);
  const rows = loadScanResults(listScanResultFiles(paths.dataDir));
  return {
    total: rows.length,
    rows: rows.slice(0, limit).map(row => ({
      url: row.url,
      company: row.company,
      title: row.title,
      location: row.location || '',
      source: row.source || '',
    })),
  };
}
