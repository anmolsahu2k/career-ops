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
import { atsFor, rolloutAllowlist } from '../applications/ats.mjs';
import { looksLikeResolvableGreenhouseShell } from '../applications/apply-url.mjs';
import { readApplyHostToken, readApplyUrlToken, readSrcToken } from '../sources.mjs';
import {
  evaluateQueuePath,
  listScanResultFiles,
  loadScanResults,
  readEvaluateQueue,
} from '../runtime/evaluate-scan.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { funnelPhaseModels } from './phase-models.mjs';
import { handshakeConfigSnapshot } from '../handshake/status.mjs';

const PIPELINE_STATE_RANK = Object.freeze({
  ELIGIBLE: 0,
  QUEUED: 1,
  RUNNING: 2,
  READY_TO_SUBMIT: 3,
  WAITING_LOGIN: 4,
  NEEDS_REVIEW: 5,
  SUBMISSION_UNKNOWN: 6,
  NEAR_MISS: 7,
  FAILED: 8,
  SKIPPED: 9,
  SUBMITTED: 10,
  EVALUATED: 20,
  APPLIED: 21,
  RESPONDED: 22,
  INTERVIEW: 23,
  OFFER: 24,
  REJECTED: 25,
  REJECTED_AT_EVAL: 26,
  DISCARDED: 27,
  PURGED: 28,
});

export const WORK_QUEUE_STATES = Object.freeze(new Set([
  'ELIGIBLE',
  'NEAR_MISS',
  'QUEUED',
  'RUNNING',
  'READY_TO_SUBMIT',
  'NEEDS_REVIEW',
  'WAITING_LOGIN',
  'SUBMISSION_UNKNOWN',
]));

export function trackerPipelineState(status) {
  const raw = String(status || '').trim();
  if (!raw) return 'UNKNOWN';
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function pipelineAts(url, fallback = 'unknown') {
  if (!url) return fallback;
  try { return atsFor(url) || fallback; } catch { return fallback; }
}

export function discoveryAts(url) {
  if (!url) return 'unknown';
  try {
    const ats = atsFor(url);
    if (ats && ats !== 'generic') return ats;
    if (looksLikeResolvableGreenhouseShell(url)) return 'greenhouse';
    return ats || 'generic';
  } catch {
    return 'unknown';
  }
}

function overlayTrackerMeta(row, trackerRow) {
  if (!trackerRow) return row;
  const merged = {
    ...row,
    date: row.date || trackerRow.date || '',
    source: row.source || trackerRow.source || '',
    tracker_status: trackerRow.status || row.tracker_status || '',
    score: row.score || trackerRow.score || '',
    report_path: row.report_path || trackerRow.report_path || '',
    canonical_url: row.canonical_url || trackerRow.posting_url || trackerRow.canonical_url || '',
    ats: row.ats && row.ats !== 'unknown'
      ? row.ats
      : pipelineAts(row.canonical_url || trackerRow.posting_url, row.ats || 'unknown'),
    external_host: row.external_host || trackerRow.external_host || '',
    external_url: row.external_url || trackerRow.external_url || '',
    can_apply: row.kind === 'attempt' ? Boolean(row.can_apply) : Boolean(trackerRow.can_apply),
    apply_reason: row.kind === 'attempt' ? (row.apply_reason || '') : (trackerRow.apply_reason || ''),
    apply_eligible: Boolean(trackerRow.apply_eligible),
    apply_near_miss: Boolean(trackerRow.apply_near_miss),
  };
  if (merged.tracker_status === 'Applied' && !['SUBMITTED', 'SUBMISSION_UNKNOWN'].includes(merged.state)) {
    merged.state = 'APPLIED';
    merged.can_apply = false;
  }
  return merged;
}

function attemptIsCertified(item) {
  const ats = String(item?.ats || '').toLowerCase();
  return Boolean(ats) && ats !== 'generic' && ats !== 'unknown';
}

function attemptOutcomeRank(state) {
  switch (state) {
    case 'SUBMITTED': return 0;
    case 'SUBMISSION_UNKNOWN': return 1;
    case 'READY_TO_SUBMIT':
    case 'RUNNING':
    case 'WAITING_LOGIN': return 2;
    case 'NEEDS_REVIEW':
    case 'QUEUED': return 3;
    case 'FAILED':
    case 'SKIPPED': return 4;
    default: return 5;
  }
}

function betterAttempt(candidate, current) {
  if (!current) return true;
  const candCert = attemptIsCertified(candidate);
  const curCert = attemptIsCertified(current);
  if (candCert !== curCert) return candCert;
  const byOutcome = attemptOutcomeRank(candidate.state) - attemptOutcomeRank(current.state);
  if (byOutcome !== 0) return byOutcome < 0;
  return String(candidate.updated_at || '').localeCompare(String(current.updated_at || '')) > 0;
}

/** One row per tracker number. Attempt wins; else Eligible / Near-miss / tracker Status. */
export function buildApplyPipeline({ attempts = [], eligible = [], near_misses = [], tracker = [] } = {}) {
  const claimed = new Set();
  const rows = [];
  const trackerByNum = new Map();
  for (const item of tracker) {
    const num = Number(item?.num ?? item?.tracker_number);
    if (Number.isFinite(num)) trackerByNum.set(num, item);
  }
  const winningAttempts = new Map();
  const unnumberedAttempts = [];
  for (const item of attempts) {
    const num = Number(item?.tracker_number);
    const normalized = {
      ...item,
      kind: 'attempt',
      state: item.state || 'QUEUED',
      score: item.score || '',
      ats: item.ats || pipelineAts(item.canonical_url),
    };
    if (!Number.isFinite(num)) {
      unnumberedAttempts.push(normalized);
      continue;
    }
    const current = winningAttempts.get(num);
    if (betterAttempt(normalized, current)) winningAttempts.set(num, normalized);
  }
  for (const [num, item] of winningAttempts) {
    claimed.add(num);
    rows.push(overlayTrackerMeta(item, trackerByNum.get(num)));
  }
  for (const item of unnumberedAttempts) {
    rows.push(overlayTrackerMeta(item, null));
  }
  for (const item of eligible) {
    const num = Number(item?.tracker_number);
    if (!Number.isFinite(num) || claimed.has(num)) continue;
    claimed.add(num);
    rows.push(overlayTrackerMeta({
      kind: 'eligible',
      state: 'ELIGIBLE',
      step: 0,
      tracker_number: num,
      company: item.company || '',
      role: item.role || '',
      score: item.score || '',
      ats: item.ats || pipelineAts(item.canonical_url),
      canonical_url: item.canonical_url || '',
      report_path: '',
      blockers: [],
      selected_resume: item.resume_hint ? { kind: item.resume_hint } : null,
      provider_usage: [],
      answers: [],
      screenshots: [],
      idempotency_key: '',
      attempt_id: '',
      can_apply: true,
      apply_reason: 'eligible',
      apply_eligible: true,
      apply_near_miss: false,
    }, trackerByNum.get(num)));
  }
  for (const item of near_misses) {
    const num = Number(item?.tracker_number);
    if (!Number.isFinite(num) || claimed.has(num)) continue;
    claimed.add(num);
    rows.push(overlayTrackerMeta({
      kind: 'near_miss',
      state: 'NEAR_MISS',
      step: 0,
      tracker_number: num,
      company: item.company || '',
      role: item.role || '',
      score: item.score || '',
      ats: pipelineAts(item.canonical_url),
      canonical_url: item.canonical_url || '',
      report_path: '',
      blockers: [{
        code: String(item.blocker || 'NEAR_MISS').slice(0, 80),
        question: '',
        detail: String(item.detail || '').slice(0, 300),
      }],
      selected_resume: null,
      provider_usage: [],
      answers: [],
      screenshots: [],
      idempotency_key: '',
      attempt_id: '',
      can_apply: false,
      apply_reason: String(item.blocker || 'near_miss').toLowerCase(),
      apply_eligible: false,
      apply_near_miss: true,
    }, trackerByNum.get(num)));
  }
  for (const item of tracker) {
    const num = Number(item?.num ?? item?.tracker_number);
    if (!Number.isFinite(num) || claimed.has(num)) continue;
    claimed.add(num);
    rows.push({
      kind: 'tracker',
      state: trackerPipelineState(item.status),
      tracker_status: item.status || '',
      step: 0,
      tracker_number: num,
      date: item.date || '',
      company: item.company || '',
      role: item.role || '',
      score: item.score || '',
      source: item.source || '',
      ats: pipelineAts(item.posting_url || item.canonical_url),
      canonical_url: item.posting_url || item.canonical_url || '',
      report_path: item.report_path || '',
      external_url: item.external_url || '',
      external_host: item.external_host || '',
      blockers: item.apply_near_miss
        ? [{
          code: String(item.apply_reason || 'NEAR_MISS').toUpperCase().slice(0, 80),
          question: '',
          detail: '',
        }]
        : [],
      selected_resume: null,
      provider_usage: [],
      answers: [],
      screenshots: [],
      idempotency_key: '',
      attempt_id: '',
      can_apply: Boolean(item.can_apply),
      apply_reason: item.apply_reason || '',
      apply_eligible: Boolean(item.apply_eligible),
      apply_near_miss: Boolean(item.apply_near_miss),
    });
  }
  return rows.sort((left, right) => {
    const rank = (PIPELINE_STATE_RANK[left.state] ?? 50) - (PIPELINE_STATE_RANK[right.state] ?? 50);
    if (rank !== 0) return rank;
    return Number(right.tracker_number || 0) - Number(left.tracker_number || 0);
  });
}

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
  const applyUrl = readApplyUrlToken(row.notes) || '';
  const applyHost = readApplyHostToken(row.notes) || '';
  const attempts = attemptsByNum.get(Number(row.num)) || [];
  const terminal = attempts.find(item => TERMINAL_ATTEMPT_STATES.has(item.state));
  const active = attempts.find(item => ['QUEUED', 'RUNNING', 'WAITING_LOGIN', 'READY_TO_SUBMIT', 'SUBMITTING', 'NEEDS_REVIEW'].includes(item.state));
  const evaluated = String(row.status || '').trim() === 'Evaluated';
  const diagnosis = diagnosticsByNum.get(Number(row.num)) || null;
  const portalUnsupported = diagnosis?.blocker === 'UNSUPPORTED_PORTAL'
    || (Boolean(diagnosis?.canonical_url)
      && atsFor(diagnosis.canonical_url) === 'generic'
      && !looksLikeResolvableGreenhouseShell(diagnosis.canonical_url));
  let apply_reason = 'not_evaluated';
  if (!evaluated) apply_reason = String(row.status || 'unknown').toLowerCase();
  else if (terminal) apply_reason = String(terminal.state).toLowerCase();
  else if (active && active.state !== 'QUEUED' && active.state !== 'READY_TO_SUBMIT') apply_reason = String(active.state).toLowerCase();
  else if (portalUnsupported) apply_reason = 'unsupported_portal';
  else if (diagnosis?.near_miss) apply_reason = String(diagnosis.blocker || 'near_miss').toLowerCase();
  else if (diagnosis?.eligible) apply_reason = 'eligible';
  else if (diagnosis?.blocker) apply_reason = String(diagnosis.blocker).toLowerCase();
  else apply_reason = 'override';
  // Near-miss rows (e.g. missing APPLY/CONSIDER) must not one-click apply until Notes are fixed.
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
    external_url: applyUrl,
    external_host: applyHost,
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
    const otp = (report.checks || []).find(item => item.code === 'GMAIL_OTP');
    const enabled = config.applications?.gmail_otp?.enabled === true;
    return {
      ready: report.ready === true,
      summary: report.summary || '',
      failed: (report.checks || []).filter(item => !item.ok).map(item => ({
        code: item.code,
        detail: String(item.detail || '').slice(0, 200),
      })),
      checks: (report.checks || []).map(item => ({
        code: item.code,
        ok: item.ok === true,
        detail: String(item.detail || '').slice(0, 200),
      })),
      gmail_otp: {
        enabled,
        ready: enabled && otp?.ok === true,
        detail: String(otp?.detail || '').slice(0, 200),
        expires_in_seconds: Number.isFinite(Number(otp?.expires_in_seconds)) ? Number(otp.expires_in_seconds) : null,
      },
      near_miss_count: report.queue?.near_miss_count || 0,
    };
  } catch (error) {
    return {
      ready: false,
      summary: String(error.message || error).slice(0, 200),
      failed: [{ code: 'DOCTOR_ERROR', detail: String(error.message || error).slice(0, 200) }],
      checks: [],
      gmail_otp: { enabled: false, ready: false, detail: 'doctor failed', expires_in_seconds: null },
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
    preview = applicationQueuePreview(target, { config });
    diagnosticsByNum = new Map(
      diagnoseTrackerRows(target, { allowedAts: rolloutAllowlist(config) }).map(item => [Number(item.row.num), item]),
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

  const pipeline = buildApplyPipeline({
    attempts,
    eligible: preview.eligible || [],
    near_misses: preview.near_misses || [],
    tracker: rows,
  });
  const workQueueCount = pipeline.filter(item => WORK_QUEUE_STATES.has(item.state)).length;
  const models = funnelPhaseModels(config || {});

  let nextStep = 'discovery';
  if (queueRows.length) nextStep = 'evaluate';
  else if (triageRows.length) nextStep = 'evaluate';
  else if (workQueueCount || trackerRows.length) nextStep = 'tracker';

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
      models: models.discovery,
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
      models: models.evaluate,
    },
    tracker: {
      total: trackerRows.length,
      status_counts: statusCounts,
      rows,
      recent: rows.slice(0, 40),
      models: models.tracker,
    },
    apply: {
      board_path: '/apply/',
      actions_enabled: Boolean(writable && applicationsEnabled),
      attempt_counts: countBy(pipeline, item => item.state),
      attempts: attempts.slice(0, 200),
      pipeline,
      work_queue_count: workQueueCount,
      eligible_count: pipeline.filter(item => item.state === 'ELIGIBLE').length,
      eligible: (preview.eligible || []).slice(0, 50),
      near_miss_count: pipeline.filter(item => item.state === 'NEAR_MISS').length,
      near_misses: (preview.near_misses || []).slice(0, 40),
      by_blocker: preview.by_blocker || {},
      human_summary: preview.human_summary || '',
      analytics,
      doctor: publicDoctor(config, target),
    },
    handshake: handshakeConfigSnapshot(config || {}),
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

export function listTriagePreview(target, limit = Infinity) {
  const paths = persistencePaths(target);
  const rows = loadScanResults(listScanResultFiles(paths.dataDir));
  const sliced = Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  return {
    total: rows.length,
    rows: sliced.map(row => ({
      url: row.url,
      company: row.company,
      title: row.title,
      location: row.location || '',
      ats: discoveryAts(row.url),
      source: row.source || '',
    })),
  };
}
