/**
 * jobs.mjs — single in-flight job runner for the Career-Ops web app.
 * Maps UI actions to evaluateScanResults or spawned pipeline scripts.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { enqueueEligible, enqueuedAttemptKeys, enqueueSelectionOverride, exactAttemptKeys, isMfaOnlyResume, runApplications } from '../applications/runner.mjs';
import { diagnoseHandshake, persistHandshakeExternalLanding, runHandshakeJob, runHandshakeSession, runHandshakeTrackerApply } from '../handshake/session.mjs';
import { recordableLanding } from '../handshake/external-landing.mjs';
import { getAttempt, listAttempts, transitionAttempt } from '../applications/store.mjs';
import { applyScoreFloor, candidateForTrackerNumber } from '../applications/eligibility.mjs';
import { discardTrackerRow, markTrackerApplied } from '../applications/tracker.mjs';
import { atsFor, rolloutAllowlist } from '../applications/ats.mjs';
import { loadRuntimeConfig, mergeRuntimeState } from '../runtime/config.mjs';
import {
  evaluateQueuePath,
  evaluateScanResults,
  listScanResultFiles,
  loadScanResults,
  readEvaluateQueue,
  writeEvaluateQueue,
} from '../runtime/evaluate-scan.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';
import { assertWriterHost } from '../runtime/writer-authorization.mjs';
import { record } from '../runtime/util.mjs';
import { playwrightChildEnv } from '../runtime/playwright-browser.mjs';
import { EVALUATE_JOB_PROVIDERS } from './phase-models.mjs';

export const ALLOWED_JOB_ACTIONS = Object.freeze([
  'scan_all',
  'scan',
  'scan_spa',
  'evaluate_plan',
  'evaluate_judge',
  'evaluate_sweep',
  'evaluate_overflow',
  'evaluate_row',
  'verify',
  'normalize',
  'dedup',
  'merge',
  'apply_enqueue',
  'apply_run',
  'apply_row',
  'apply_retry',
  'tracker_discard',
  'tracker_mark_applied',
  'handshake_doctor',
  'handshake_job',
  'handshake_session',
]);

const PROVIDER_DEFAULTS = EVALUATE_JOB_PROVIDERS;

function dataDirFlag(repoRoot, target) {
  const rel = relative(repoRoot, resolve(target)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || rel.includes('..')) {
    throw Object.assign(new Error('Target must stay under the repository root'), { code: 'BAD_TARGET' });
  }
  return rel || '.';
}

function readState(target) {
  const path = join(persistencePaths(target).runtimeDir, 'runtime-state.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : record('RuntimeStateV1', { provider_observations: {}, resource_pools: {} });
}

export const MAX_SELECTED_EVAL_URLS = 100;

/** Normalize one or many Discovery URLs and require each to be in triage. */
export function selectedTriageUrls(args = {}, triageRows = []) {
  const raw = [];
  if (typeof args.url === 'string' && args.url.trim()) raw.push(args.url.trim());
  if (Array.isArray(args.urls)) {
    for (const item of args.urls) {
      if (typeof item === 'string' && item.trim()) raw.push(item.trim());
    }
  }
  const urls = [...new Set(raw)];
  if (!urls.length) {
    throw Object.assign(new Error('evaluate_row requires at least one https URL from triage'), { code: 'BAD_EVAL_URL' });
  }
  if (urls.length > MAX_SELECTED_EVAL_URLS) {
    throw Object.assign(
      new Error(`evaluate_row accepts at most ${MAX_SELECTED_EVAL_URLS} URLs at once`),
      { code: 'EVAL_SELECTION_TOO_LARGE' },
    );
  }
  const known = new Set((Array.isArray(triageRows) ? triageRows : []).map(row => row.url));
  for (const url of urls) {
    if (!/^https:\/\//i.test(url) || url.length > 2000) {
      throw Object.assign(new Error('evaluate_row requires https URLs from triage'), { code: 'BAD_EVAL_URL' });
    }
    if (!known.has(url)) {
      throw Object.assign(new Error('That URL is not in the current triage backlog'), { code: 'URL_NOT_IN_TRIAGE' });
    }
  }
  return urls;
}

function authorizeWritable(ctx) {
  if (!ctx.configPath) {
    const error = new Error('Mutations require --config (config/runtime.local.yml)');
    error.code = 'WRITER_CONFIG_REQUIRED';
    throw error;
  }
  const config = loadRuntimeConfig(ctx.configPath);
  assertWriterHost(config, { currentHost: ctx.observedHost || hostname() });
  return config;
}

function progressLogLine(progress = {}) {
  const bits = [
    progress.stage,
    progress.phase,
    progress.tracker_number != null ? `#${progress.tracker_number}` : null,
    progress.step != null ? `step ${progress.step}` : null,
    Number.isFinite(Number(progress.done)) && Number(progress.total)
      ? `${progress.done}/${progress.total}`
      : null,
    progress.company,
    progress.title,
    progress.result,
  ].filter(Boolean);
  return bits.join(' · ');
}

function attachJobProgress(job, broadcast) {
  return (progress) => {
    job.progress = progress;
    broadcast('progress', { job_id: job.id, progress });
    const line = progressLogLine(progress);
    if (line) broadcast('log', { job_id: job.id, stream: 'progress', text: `${line}\n` });
  };
}

function summarizeApplyRun(run) {
  const results = (run?.results || []).map(item => ({
    tracker_number: item.tracker_number,
    state: item.state,
    company: item.company,
    blockers: (item.blockers || []).map(blocker => blocker.code).filter(Boolean).slice(0, 6),
  }));
  const states = results.map(item => `#${item.tracker_number} ${item.state}`).join(', ');
  return {
    results,
    message: states
      ? `apply finished (submit=true): ${states}`
      : (run?.message || 'apply run finished (submit=true; submissionGate still gates the Submit click)'),
  };
}

function isHandshakeApplyTarget(url, ats = '') {
  if (String(ats || '').toLowerCase() === 'handshake') return true;
  try { return atsFor(url) === 'handshake'; } catch { return false; }
}

function handshakeTrackerCandidate(target, trackerNumber, config) {
  return candidateForTrackerNumber(target, trackerNumber, {
    allowedAts: rolloutAllowlist(config),
    scoreFloor: applyScoreFloor(config, { ats: 'handshake' }),
  });
}

function summarizeHandshakeTrackerApply(result, trackerNumber) {
  const apply = result?.apply && typeof result.apply === 'object' ? result.apply : {};
  const host = apply.external_host || result?.external_host || '';
  const url = apply.url || apply.external_url || result?.url || '';
  const status = apply.status || result?.status || 'COMPLETED';
  const reason = apply.reason || result?.reason || '';
  const hostNote = url || host ? ` · Apply externally: ${url || host}` : '';
  const reasonNote = reason && status !== 'NATIVE' ? ` (${reason})` : '';
  return {
    tracker_number: trackerNumber,
    status,
    reason,
    external_host: host,
    external_url: url,
    message: `Handshake apply for #${trackerNumber}: ${status}${reasonNote}${hostNote}`,
  };
}

function persistHandshakeApplyResult(target, trackerNumber, result) {
  const apply = result?.apply && typeof result.apply === 'object' ? result.apply : {};
  const job = result?.job && typeof result.job === 'object' ? result.job : {};
  return persistHandshakeExternalLanding(target, trackerNumber, recordableLanding({
    host: apply.external_host || result?.external_host || '',
    url: apply.url || apply.external_url || result?.url || '',
    ats: apply.ats || result?.ats || '',
    certified: apply.status === 'EXTERNAL_ATS' || result?.status === 'EXTERNAL_ATS',
  }, {
    href: job.applyUrl || apply.href || '',
    probe: job.applyUrls || apply.probe || [],
  }, job.url || result?.url || ''));
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    started_at: job.started_at,
    finished_at: job.finished_at || null,
    args: job.args || {},
    progress: job.progress || null,
    result_summary: job.result_summary || null,
    error: job.error || null,
  };
}

export function summarizeEvaluate(result) {
  const results = result?.results || [];
  const committed = results.filter(item => item.status === 'COMMITTED').length;
  const staleOrSkipped = results.filter(item => (
    item.status === 'SKIPPED'
    || item.status === 'EXPIRED'
    || item.status === 'SKIPPED_STALE'
  )).length;
  const skipped = (result?.skipped || []).length + (result?.expired || []).length + staleOrSkipped;
  const failed = results.filter(item => item.status === 'FAILED' || item.status === 'FETCH_FAILED').length;
  const firstFailed = results.find(item => item.status === 'FAILED' || item.status === 'FETCH_FAILED');
  const failDetail = firstFailed
    ? [
      firstFailed.company,
      firstFailed.title,
      firstFailed.code || firstFailed.status,
      firstFailed.error,
    ].filter(Boolean).join(': ')
    : null;
  const parts = [
    committed ? `${committed} committed` : null,
    skipped ? `${skipped} skipped` : null,
    failed ? `${failed} failed` : null,
    failDetail,
  ].filter(Boolean);
  return {
    status: result?.status || 'OK',
    source: result?.source || null,
    candidate_count: result?.candidate_count ?? results.length,
    queue_path: result?.queue_path || null,
    committed,
    skipped,
    failed,
    failed_code: firstFailed?.code || firstFailed?.status || null,
    failed_company: firstFailed?.company || null,
    failed_url: firstFailed?.url || null,
    message: result?.message || (parts.length ? parts.join('; ') : null),
  };
}

function evaluateLogText(result) {
  const summary = summarizeEvaluate(result);
  const lines = [summary.message || 'evaluate finished'];
  for (const item of result?.results || []) {
    if (item.status !== 'FAILED' && item.status !== 'FETCH_FAILED') continue;
    lines.push([item.status, item.company, item.title, item.error || item.code, item.url]
      .filter(Boolean)
      .join(' · '));
  }
  return `${lines.join('\n')}\n`;
}

export function evaluateRowFailure(result) {
  const committed = (result?.results || []).find(item => item.status === 'COMMITTED');
  if (committed) return null;
  const failed = (result?.results || []).find(item => item.status === 'FAILED' || item.status === 'FETCH_FAILED')
    || (result?.results || [])[0];
  const skipped = (result?.skipped || [])[0];
  const expired = (result?.expired || [])[0];
  const message = failed?.error
    || skipped?.reason
    || expired?.reason
    || result?.message
    || 'Evaluate did not commit a report';
  return Object.assign(new Error(message), {
    code: failed?.code || skipped?.code || expired?.reason || 'EVAL_ROW_FAILED',
  });
}

export function createJobRunner({
  target,
  repoRoot,
  configPath = null,
  config = null,
  observedHost = hostname(),
  emit = () => {},
} = {}) {
  let current = null;
  let seq = 0;
  const listeners = new Set();

  function broadcast(event, payload = {}) {
    const message = { event, at: new Date().toISOString(), ...payload };
    emit(message);
    for (const listener of listeners) {
      try { listener(message); } catch { /* ignore broken SSE clients */ }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function requireIdle() {
    if (current && (current.status === 'running' || current.status === 'starting')) {
      const error = new Error(`Job already in flight: ${current.action}`);
      error.code = 'JOB_BUSY';
      throw error;
    }
  }

  async function spawnScript(job, scriptName, argv = []) {
    const dataDir = dataDirFlag(repoRoot, target);
    const child = spawn(process.execPath, [join(repoRoot, scriptName), ...argv], {
      cwd: repoRoot,
      env: {
        ...playwrightChildEnv(process.env),
        CAREER_OPS_DATA_DIR: dataDir,
      },
      windowsHide: true,
    });
    job.child = child;
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      broadcast('log', { job_id: job.id, stream: 'stdout', text });
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      broadcast('log', { job_id: job.id, stream: 'stderr', text });
    });
    const code = await new Promise((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', resolvePromise);
    });
    job.child = null;
    if (code !== 0) {
      const error = new Error(`${scriptName} exited with code ${code}`);
      error.code = 'JOB_SCRIPT_FAILED';
      error.exit_code = code;
      throw error;
    }
    return { exit_code: code };
  }

  async function runEvaluate(job, {
    apply = false,
    fromQueue = false,
    max = Infinity,
    provider = null,
    evaluateConcurrency = 2,
    outPath = null,
    skipLiveness = false,
    urls = null,
  } = {}) {
    let selectedConfig = null;
    if (apply) {
      selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
    } else if (configPath) {
      selectedConfig = mergeRuntimeState(loadRuntimeConfig(configPath), readState(target));
    }
    const result = await evaluateScanResults({
      target,
      config: selectedConfig,
      max,
      apply,
      fromQueue,
      provider,
      acknowledgeQuota: apply,
      evaluateConcurrency,
      skipLiveness,
      urls,
      onProgress: attachJobProgress(job, broadcast),
    });
    if (outPath && !apply) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const absolute = resolve(repoRoot, outPath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`);
    }
    job.result_summary = summarizeEvaluate(result);
    broadcast('log', { job_id: job.id, stream: 'stdout', text: evaluateLogText(result) });
    return result;
  }

  async function execute(job) {
    const args = job.args || {};
    switch (job.action) {
      case 'scan_all': {
        const argv = [];
        if (args.dry_run) argv.push('--dry-run');
        if (args.skip) argv.push('--skip', String(args.skip));
        return spawnScript(job, 'scan-all.mjs', argv);
      }
      case 'scan':
        return spawnScript(job, 'scan.mjs', []);
      case 'scan_spa':
        return spawnScript(job, 'scan-spa.mjs', []);
      case 'evaluate_plan': {
        const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 25;
        return runEvaluate(job, {
          apply: false,
          fromQueue: false,
          max,
          outPath: args.out === false ? null : (args.out || 'plan.json'),
          skipLiveness: args.skip_liveness === true,
        });
      }
      case 'evaluate_judge':
        return runEvaluate(job, {
          apply: true,
          fromQueue: true,
          provider: args.provider || PROVIDER_DEFAULTS.evaluate_judge,
          evaluateConcurrency: Number(args.eval_concurrency) || 2,
        });
      case 'evaluate_sweep':
        return runEvaluate(job, {
          apply: true,
          fromQueue: true,
          provider: args.provider || PROVIDER_DEFAULTS.evaluate_sweep,
          evaluateConcurrency: Number(args.eval_concurrency) || 4,
        });
      case 'evaluate_overflow':
        return runEvaluate(job, {
          apply: true,
          fromQueue: true,
          provider: args.provider || PROVIDER_DEFAULTS.evaluate_overflow,
          evaluateConcurrency: Number(args.eval_concurrency) || 3,
        });
      case 'evaluate_row': {
        const triageRows = loadScanResults(listScanResultFiles(persistencePaths(target).dataDir));
        const urls = selectedTriageUrls(args, triageRows);
        const match = triageRows.find(row => row.url === urls[0]);
        attachJobProgress(job, broadcast)({
          stage: 'evaluate',
          phase: 'row',
          url: urls[0],
          result: `${urls.length} selected`,
          company: match?.company,
          title: match?.title,
        });
        const result = await runEvaluate(job, {
          apply: true,
          fromQueue: false,
          max: urls.length,
          urls,
          provider: args.provider || PROVIDER_DEFAULTS.evaluate_judge,
          evaluateConcurrency: urls.length === 1 ? 1 : 2,
        });
        const failure = evaluateRowFailure(result);
        if (failure) throw failure;
        return result;
      }
      case 'verify':
        return spawnScript(job, 'verify-pipeline.mjs', []);
      case 'normalize': {
        const argv = args.apply === true ? [] : ['--dry-run'];
        authorizeWritable({ configPath, config, observedHost });
        return spawnScript(job, 'normalize-statuses.mjs', argv);
      }
      case 'dedup': {
        const argv = args.apply === true ? [] : ['--dry-run'];
        authorizeWritable({ configPath, config, observedHost });
        return spawnScript(job, 'dedup-tracker.mjs', argv);
      }
      case 'merge': {
        const argv = args.apply === true ? [] : ['--dry-run'];
        authorizeWritable({ configPath, config, observedHost });
        return spawnScript(job, 'merge-tracker.mjs', argv);
      }
      case 'apply_enqueue': {
        const selectedConfig = authorizeWritable({ configPath, config, observedHost });
        const queued = await enqueueEligible(target, {
          includeCurrent: args.include_current === true,
          config: selectedConfig,
        });
        const queuedCount = enqueuedAttemptKeys(queued).length;
        attachJobProgress(job, broadcast)({
          stage: 'apply',
          phase: 'enqueue',
          result: `${queuedCount} queued`,
        });
        job.result_summary = {
          queued_count: queuedCount,
          message: 'Eligible APPLY and CONSIDER rows enqueued',
        };
        return queued;
      }
      case 'apply_run': {
        const selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
        if (selectedConfig.applications?.enabled !== true) {
          throw Object.assign(new Error('applications.enabled must be true to run applications'), { code: 'APPLICATIONS_DISABLED' });
        }
        const handshakeQueued = listAttempts(target).find(item =>
          isHandshakeApplyTarget(item.canonical_url, item.ats)
          && ['QUEUED', 'READY_TO_SUBMIT'].includes(item.state)
        );
        if (handshakeQueued) {
          attachJobProgress(job, broadcast)({
            stage: 'handshake',
            phase: 'apply',
            tracker_number: handshakeQueued.tracker_number,
            company: handshakeQueued.company,
            result: 'main_profile',
          });
          const result = await runHandshakeTrackerApply({
            target,
            config: selectedConfig,
            repoRoot,
            trackerNumber: handshakeQueued.tracker_number,
            url: handshakeQueued.canonical_url,
            submit: true,
            onProgress: attachJobProgress(job, broadcast),
          });
          await persistHandshakeApplyResult(target, handshakeQueued.tracker_number, result);
          job.result_summary = summarizeHandshakeTrackerApply(result, handshakeQueued.tracker_number);
          return result;
        }
        const run = await runApplications(target, selectedConfig, {
          submit: true,
          max: Number.isFinite(Number(args.max)) ? Number(args.max) : 1,
          onProgress: attachJobProgress(job, broadcast),
        });
        job.result_summary = summarizeApplyRun(run);
        return run;
      }
      case 'apply_row': {
        const trackerNumber = Number(args.tracker_number);
        if (!Number.isInteger(trackerNumber) || trackerNumber <= 0) {
          throw Object.assign(new Error('apply_row requires a positive tracker_number'), { code: 'BAD_TRACKER_NUMBER' });
        }
        const selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
        if (selectedConfig.applications?.enabled !== true) {
          throw Object.assign(new Error('applications.enabled must be true to run applications'), { code: 'APPLICATIONS_DISABLED' });
        }
        let candidate = candidateForTrackerNumber(target, trackerNumber, {
          allowedAts: rolloutAllowlist(selectedConfig),
        });
        if (!candidate) {
          throw Object.assign(new Error(`Tracker row ${trackerNumber} was not found`), { code: 'TRACKER_NOT_FOUND' });
        }
        if (isHandshakeApplyTarget(candidate.canonical_url)) {
          candidate = handshakeTrackerCandidate(target, trackerNumber, selectedConfig) || candidate;
          if (candidate.near_miss) {
            throw Object.assign(
              new Error(candidate.detail || candidate.blocker || `Row #${trackerNumber} needs Notes hygiene before apply`),
              { code: candidate.blocker === 'UNSUPPORTED_PORTAL' ? 'UNSUPPORTED_PORTAL' : 'APPLY_NEAR_MISS' },
            );
          }
          if (!candidate.eligible) {
            throw Object.assign(
              new Error(candidate.detail || candidate.blocker || `Cannot run Handshake apply for #${trackerNumber}`),
              { code: candidate.blocker === 'UNSUPPORTED_PORTAL' ? 'UNSUPPORTED_PORTAL' : 'APPLY_BLOCKED' },
            );
          }
          attachJobProgress(job, broadcast)({
            stage: 'handshake',
            phase: 'enqueue',
            tracker_number: trackerNumber,
            company: candidate.row?.company || candidate.company,
            result: 'eligible',
          });
          const result = await runHandshakeTrackerApply({
            target,
            config: selectedConfig,
            repoRoot,
            trackerNumber,
            url: candidate.canonical_url,
            submit: args.submit !== false,
            onProgress: attachJobProgress(job, broadcast),
          });
          await persistHandshakeApplyResult(target, trackerNumber, result);
          job.result_summary = summarizeHandshakeTrackerApply(result, trackerNumber);
          return result;
        }
        if (candidate.near_miss) {
          throw Object.assign(
            new Error(candidate.detail || candidate.blocker || `Row #${trackerNumber} needs Notes hygiene before apply`),
            { code: candidate.blocker === 'UNSUPPORTED_PORTAL' ? 'UNSUPPORTED_PORTAL' : 'APPLY_NEAR_MISS' },
          );
        }
        let enqueueResult;
        if (candidate.eligible) {
          enqueueResult = await enqueueEligible(target, {
            trackerNumbers: [trackerNumber],
            includeCurrent: true,
            config: selectedConfig,
          });
        } else {
          const override = await enqueueSelectionOverride(target, trackerNumber, { config: selectedConfig });
          if (override.unsupported || override.blocker === 'UNSUPPORTED_PORTAL') {
            throw Object.assign(
              new Error(`#${trackerNumber} apply URL is not a certified ATS surface (need Greenhouse/Ashby/Lever/Workday/SuccessFactors host, not a company careers mirror)`),
              { code: 'UNSUPPORTED_PORTAL' },
            );
          }
          const runnable = override.attempt && ['QUEUED', 'READY_TO_SUBMIT'].includes(override.attempt.state)
            ? [override.attempt]
            : [];
          enqueueResult = {
            queued: runnable,
            blocked: runnable.length ? [] : [{
              tracker_number: trackerNumber,
              blocker: override.blocker || `EXISTING_${override.attempt?.state || 'UNKNOWN'}`,
              attempt_id: override.attempt?.attempt_id,
            }],
          };
        }
        const attemptKeys = exactAttemptKeys(target, trackerNumber, enqueueResult);
        if (!attemptKeys.length) {
          const blocked = enqueueResult.blocked?.[0];
          throw Object.assign(
            new Error(blocked?.blocker || `Cannot run auto-applier for #${trackerNumber}`),
            { code: blocked?.blocker === 'UNSUPPORTED_PORTAL' ? 'UNSUPPORTED_PORTAL' : 'APPLY_BLOCKED' },
          );
        }
        attachJobProgress(job, broadcast)({
          stage: 'apply',
          phase: 'enqueue',
          tracker_number: trackerNumber,
          company: candidate.row?.company || candidate.company,
          result: candidate.eligible ? 'eligible' : 'override',
        });
        const run = await runApplications(target, selectedConfig, {
          submit: true,
          max: 1,
          attemptKeys,
          onProgress: attachJobProgress(job, broadcast),
        });
        job.result_summary = {
          tracker_number: trackerNumber,
          ...summarizeApplyRun(run),
        };
        if (!run?.results?.length && run?.message) {
          job.result_summary.message = run.message;
        } else if (!job.result_summary.message.includes(`#${trackerNumber}`)) {
          job.result_summary.message = `Auto-applier ran for #${trackerNumber} (submit=true; submissionGate still gates the Submit click)`;
        }
        return run;
      }
      case 'apply_retry': {
        const key = String(args.key || '').trim();
        if (!key) {
          throw Object.assign(new Error('apply_retry requires an attempt key'), { code: 'BAD_ATTEMPT_KEY' });
        }
        const selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
        if (selectedConfig.applications?.enabled !== true) {
          throw Object.assign(new Error('applications.enabled must be true to resume applications'), { code: 'APPLICATIONS_DISABLED' });
        }
        const attempt = getAttempt(target, key);
        if (!attempt) {
          throw Object.assign(new Error('Attempt not found'), { code: 'ATTEMPT_NOT_FOUND' });
        }
        const retryable = new Set(['NEEDS_REVIEW', 'WAITING_LOGIN', 'FAILED', 'QUEUED', 'READY_TO_SUBMIT']);
        if (!retryable.has(attempt.state)) {
          throw Object.assign(new Error(`Attempt ${attempt.state} is not resumable`), { code: 'ATTEMPT_NOT_RETRYABLE' });
        }
        const queuedFresh = attempt.state === 'NEEDS_REVIEW'
          || attempt.state === 'FAILED'
          || (attempt.state === 'WAITING_LOGIN' && !isMfaOnlyResume(attempt));
        if (isHandshakeApplyTarget(attempt.canonical_url, attempt.ats)) {
          if (queuedFresh) {
            transitionAttempt(target, key, 'QUEUED', { blockers: [] });
          }
          attachJobProgress(job, broadcast)({
            stage: 'handshake',
            phase: 'resume',
            tracker_number: attempt.tracker_number,
            company: attempt.company,
            result: queuedFresh ? 'queued' : attempt.state,
          });
          const result = await runHandshakeTrackerApply({
            target,
            config: selectedConfig,
            repoRoot,
            trackerNumber: attempt.tracker_number,
            url: attempt.canonical_url,
            submit: args.submit !== false,
            onProgress: attachJobProgress(job, broadcast),
          });
          await persistHandshakeApplyResult(target, attempt.tracker_number, result);
          job.result_summary = summarizeHandshakeTrackerApply(result, attempt.tracker_number);
          return result;
        }
        if (queuedFresh) {
          transitionAttempt(target, key, 'QUEUED', { blockers: [] });
        }
        attachJobProgress(job, broadcast)({
          stage: 'apply',
          phase: 'resume',
          tracker_number: attempt.tracker_number,
          company: attempt.company,
          result: queuedFresh ? 'queued' : attempt.state,
        });
        const run = await runApplications(target, selectedConfig, {
          submit: true,
          max: 1,
          attemptKeys: [key],
          onProgress: attachJobProgress(job, broadcast),
        });
        job.result_summary = {
          tracker_number: attempt.tracker_number,
          ...summarizeApplyRun(run),
        };
        if (!run?.results?.length && run?.message) {
          job.result_summary.message = run.message;
        } else if (!String(job.result_summary.message || '').includes(`#${attempt.tracker_number}`)) {
          job.result_summary.message = `Resumed auto-applier for #${attempt.tracker_number} (submit=true; submissionGate still gates the Submit click)`;
        }
        return run;
      }
      case 'tracker_discard': {
        const trackerNumber = Number(args.tracker_number);
        if (!Number.isInteger(trackerNumber) || trackerNumber <= 0) {
          throw Object.assign(new Error('tracker_discard requires a positive tracker_number'), { code: 'BAD_TRACKER_NUMBER' });
        }
        authorizeWritable({ configPath, config, observedHost });
        attachJobProgress(job, broadcast)({
          stage: 'tracker',
          phase: 'discard',
          tracker_number: trackerNumber,
        });
        const result = await discardTrackerRow(target, trackerNumber);
        job.result_summary = {
          tracker_number: trackerNumber,
          changed: result.tracker.changed === true,
          already: result.tracker.already === true,
          skipped_count: result.skipped_count,
          message: result.tracker.already
            ? `#${trackerNumber} was already Discarded`
            : `#${trackerNumber} discarded` + (result.skipped_count ? ` · skipped ${result.skipped_count} open attempt(s)` : ''),
        };
        return result;
      }
      case 'tracker_mark_applied': {
        const trackerNumber = Number(args.tracker_number);
        if (!Number.isInteger(trackerNumber) || trackerNumber <= 0) {
          throw Object.assign(new Error('tracker_mark_applied requires a positive tracker_number'), { code: 'BAD_TRACKER_NUMBER' });
        }
        authorizeWritable({ configPath, config, observedHost });
        attachJobProgress(job, broadcast)({
          stage: 'tracker',
          phase: 'applied',
          tracker_number: trackerNumber,
        });
        const result = await markTrackerApplied(target, trackerNumber);
        job.result_summary = {
          tracker_number: trackerNumber,
          changed: result.tracker.changed === true,
          already: result.tracker.already === true,
          skipped_count: result.skipped_count,
          message: result.tracker.already
            ? `#${trackerNumber} was already Applied`
            : `#${trackerNumber} marked Applied`,
        };
        return result;
      }
      case 'handshake_doctor': {
        const selectedConfig = authorizeWritable({ configPath, config, observedHost });
        attachJobProgress(job, broadcast)({ stage: 'handshake', phase: 'doctor' });
        const report = await diagnoseHandshake(target, selectedConfig);
        job.result_summary = {
          ready: report.ready === true,
          cdp_ok: report.handshake?.cdp_ok === true,
          logged_in: report.handshake?.logged_in === true,
          message: report.summary || 'Handshake doctor finished',
        };
        return report;
      }
      case 'handshake_job':
      case 'handshake_session': {
        const selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
        if (selectedConfig.applications?.enabled !== true) {
          throw Object.assign(new Error('applications.enabled must be true to run Handshake live apply'), { code: 'APPLICATIONS_DISABLED' });
        }
        const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 10;
        if (job.action === 'handshake_session' && (!Number.isFinite(max) || max < 1)) {
          throw Object.assign(new Error('handshake_session requires --max'), { code: 'HANDSHAKE_MAX_REQUIRED' });
        }
        const onProgress = attachJobProgress(job, broadcast);
        const result = job.action === 'handshake_job'
          ? await runHandshakeJob({
            target,
            config: selectedConfig,
            repoRoot,
            submit: args.submit !== false,
            acknowledgeQuota: true,
            onProgress,
          })
          : await runHandshakeSession({
            target,
            config: selectedConfig,
            repoRoot,
            submit: args.submit !== false,
            max,
            acknowledgeQuota: true,
            onProgress,
          });
        const processed = result.processed ?? (result.status === 'EVALUATED' || result.committed ? 1 : 0);
        const query = String(result.filters?.keywords || '').trim();
        const rawCount = Number(result.raw_listing_count) || 0;
        const hosts = [...new Set(
          [result, ...(result.results || [])]
            .map(row => row?.apply?.external_host || row?.external_host)
            .filter(Boolean),
        )];
        const hostNote = hosts.length ? ` · Apply externally: ${hosts.join(', ')}` : '';
        job.result_summary = {
          status: result.status || 'COMPLETED',
          processed,
          listing_count: result.listing_count,
          external_host: hosts[0] || '',
          message: job.action === 'handshake_job'
            ? `Handshake current tab ${result.status || 'done'}${hostNote}`
            : result.listing_count
              ? `Handshake session processed ${processed} of ${result.listing_count} jobs (max ${max})${hostNote}`
              : rawCount
                ? `Handshake session found ${rawCount} jobs, 0 passed the title/level filter`
                : `Handshake session found 0 jobs${query ? ` for "${query}"` : ''}`,
        };
        return result;
      }
      default:
        throw Object.assign(new Error(`Unknown action: ${job.action}`), { code: 'UNKNOWN_ACTION' });
    }
  }

  async function start(action, args = {}) {
    if (!ALLOWED_JOB_ACTIONS.includes(action)) {
      throw Object.assign(new Error(`Action not allowed: ${action}`), { code: 'UNKNOWN_ACTION' });
    }
    requireIdle();
    const job = {
      id: `job-${Date.now()}-${++seq}`,
      action,
      args,
      status: 'starting',
      started_at: new Date().toISOString(),
      progress: null,
      result_summary: null,
      error: null,
      child: null,
    };
    current = job;
    broadcast('job_started', { job: publicJob(job) });
    job.status = 'running';
    queueMicrotask(async () => {
      try {
        await execute(job);
        job.status = 'done';
        job.finished_at = new Date().toISOString();
        broadcast('job_done', { job: publicJob(job) });
      } catch (error) {
        job.status = 'error';
        job.finished_at = new Date().toISOString();
        job.error = { code: error.code || 'JOB_FAILED', message: error.message };
        broadcast('job_error', { job: publicJob(job) });
      }
    });
    return publicJob(job);
  }

  function cancel() {
    if (!current || (current.status !== 'running' && current.status !== 'starting')) {
      throw Object.assign(new Error('No running job'), { code: 'NO_JOB' });
    }
    if (current.child) {
      current.child.kill();
    }
    current.status = 'cancelled';
    current.finished_at = new Date().toISOString();
    current.error = { code: 'CANCELLED', message: 'Cancelled by operator' };
    broadcast('job_error', { job: publicJob(current) });
    return publicJob(current);
  }

  function removeQueueUrls(urls = []) {
    authorizeWritable({ configPath, config, observedHost });
    const path = evaluateQueuePath(persistencePaths(target).dataDir);
    const rows = readEvaluateQueue(path);
    const drop = new Set((urls || []).map(String));
    const next = rows.filter(row => !drop.has(row.url));
    writeEvaluateQueue(path, next);
    return { removed: rows.length - next.length, remaining: next.length };
  }

  return {
    start,
    cancel,
    removeQueueUrls,
    subscribe,
    getCurrent: () => publicJob(current),
    authorizeWritable: () => authorizeWritable({ configPath, config, observedHost }),
  };
}
