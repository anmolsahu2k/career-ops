/**
 * jobs.mjs — single in-flight job runner for the Career-Ops web app.
 * Maps UI actions to evaluateScanResults or spawned pipeline scripts.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { enqueueEligible, enqueuedAttemptKeys, enqueueSelectionOverride, exactAttemptKeys, runApplications } from '../applications/runner.mjs';
import { candidateForTrackerNumber } from '../applications/eligibility.mjs';
import { loadRuntimeConfig, mergeRuntimeState } from '../runtime/config.mjs';
import {
  evaluateQueuePath,
  evaluateScanResults,
  readEvaluateQueue,
  writeEvaluateQueue,
} from '../runtime/evaluate-scan.mjs';
import { persistencePaths } from '../runtime/transaction.mjs';
import { assertWriterHost } from '../runtime/writer-authorization.mjs';
import { record } from '../runtime/util.mjs';
import { playwrightChildEnv } from '../runtime/playwright-browser.mjs';

export const ALLOWED_JOB_ACTIONS = Object.freeze([
  'scan_all',
  'scan',
  'scan_spa',
  'evaluate_plan',
  'evaluate_judge',
  'evaluate_sweep',
  'evaluate_overflow',
  'verify',
  'normalize',
  'dedup',
  'merge',
  'apply_enqueue',
  'apply_run',
  'apply_row',
]);

const PROVIDER_DEFAULTS = {
  evaluate_judge: 'antigravity-gemini-flash-high',
  evaluate_sweep: 'cerebras-gpt-oss-120b',
  evaluate_overflow: 'groq-llama-70b',
};

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

function authorizeWritable(ctx) {
  if (!ctx.configPath) {
    const error = new Error('Mutations require --config (config/runtime.local.yml)');
    error.code = 'WRITER_CONFIG_REQUIRED';
    throw error;
  }
  const config = ctx.config || loadRuntimeConfig(ctx.configPath);
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

function summarizeEvaluate(result) {
  const results = result?.results || [];
  const committed = results.filter(item => item.status === 'COMMITTED').length;
  const skipped = results.filter(item => item.status === 'SKIPPED' || item.status === 'EXPIRED').length;
  const failed = results.filter(item => item.status === 'FAILED').length;
  return {
    status: result?.status || 'OK',
    source: result?.source || null,
    candidate_count: result?.candidate_count ?? results.length,
    queue_path: result?.queue_path || null,
    committed,
    skipped,
    failed,
    message: result?.message || null,
  };
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
        authorizeWritable({ configPath, config, observedHost });
        const queued = await enqueueEligible(target, { includeCurrent: args.include_current === true });
        const queuedCount = enqueuedAttemptKeys(queued).length;
        attachJobProgress(job, broadcast)({
          stage: 'apply',
          phase: 'enqueue',
          result: `${queuedCount} queued`,
        });
        job.result_summary = {
          queued_count: queuedCount,
          message: 'Eligible APPLY rows enqueued',
        };
        return queued;
      }
      case 'apply_run': {
        const selectedConfig = mergeRuntimeState(authorizeWritable({ configPath, config, observedHost }), readState(target));
        if (selectedConfig.applications?.enabled !== true) {
          throw Object.assign(new Error('applications.enabled must be true to run applications'), { code: 'APPLICATIONS_DISABLED' });
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
        const candidate = candidateForTrackerNumber(target, trackerNumber);
        if (!candidate) {
          throw Object.assign(new Error(`Tracker row ${trackerNumber} was not found`), { code: 'TRACKER_NOT_FOUND' });
        }
        if (candidate.near_miss) {
          throw Object.assign(
            new Error(candidate.detail || candidate.blocker || `Row #${trackerNumber} needs Notes hygiene before apply`),
            { code: 'APPLY_NEAR_MISS' },
          );
        }
        let enqueueResult;
        if (candidate.eligible) {
          enqueueResult = await enqueueEligible(target, { trackerNumbers: [trackerNumber], includeCurrent: true });
        } else {
          const override = await enqueueSelectionOverride(target, trackerNumber);
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
