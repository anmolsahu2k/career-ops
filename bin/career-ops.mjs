#!/usr/bin/env node
import '../lib/runtime/playwright-preload.mjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, mergeRuntimeState } from '../lib/runtime/config.mjs';
import { captureBaseline, compareBaselines } from '../lib/runtime/baseline.mjs';
import { certifyCanary } from '../lib/runtime/canary.mjs';
import { observeEnvironment } from '../lib/runtime/doctor.mjs';
import { runLocalHardwareQualification } from '../lib/runtime/local-hardware-qualification.mjs';
import { normalizeEvaluation } from '../lib/runtime/normalize.mjs';
import { evaluateResponse, evaluateWithProvider } from '../lib/runtime/orchestrator.mjs';
import { decide } from '../lib/runtime/policy-engine.mjs';
import { buildProviderRequest, prepareTask } from '../lib/runtime/prepare.mjs';
import { createProvider } from '../lib/runtime/providers/index.mjs';
import { aggregateQualificationResults, composeQualificationEvidence, qualifyModel } from '../lib/runtime/qualification.mjs';
import { cleanupRetention } from '../lib/runtime/retention.mjs';
import { routeProfileTask, routeTask } from '../lib/runtime/router.mjs';
import {
  addRoutingSignals,
  assertFreshManualQuotas,
  buildRouteShadowPlan,
  resolveRoutingProfile,
  runRouteShadow,
  runTriageRanking,
} from '../lib/runtime/route-shadow.mjs';
import { sanitizePresentation } from '../lib/runtime/sanitizer.mjs';
import { evaluateShadowPreflight, runShadowQualification } from '../lib/runtime/shadow.mjs';
import { commitEvaluation, persistencePaths, recoverTransactions } from '../lib/runtime/transaction.mjs';
import { canonicalJson, record } from '../lib/runtime/util.mjs';
import { assertWriterHost } from '../lib/runtime/writer-authorization.mjs';
import { enqueueEligible, enqueuedAttemptKeys, enqueueSelectionOverride, exactAttemptKeys, retryApplication, runApplications, stageMfaCode } from '../lib/applications/runner.mjs';
import { serveApplyBoard } from '../lib/applications/board.mjs';
import { acknowledgeManualSubmission } from '../lib/applications/acknowledge.mjs';
import { runLocalApplicationProseQualification } from '../lib/applications/local-prose-qualification.mjs';
import { diagnoseApplications } from '../lib/applications/doctor.mjs';
import { diagnoseHandshake, runHandshakeJob, runHandshakeSession } from '../lib/handshake/session.mjs';
import { applicationQueuePreview } from '../lib/applications/enqueue-summary.mjs';
import { applicationAttemptAnalytics } from '../lib/applications/analytics.mjs';
import { evaluateScanResults } from '../lib/runtime/evaluate-scan.mjs';
import {
  formatEvaluateProgress,
  formatEvaluateSummary,
  shouldUseHumanEvaluateOutput,
} from '../lib/runtime/evaluate-report.mjs';
import { serveCareerOpsApp } from '../lib/web/career-ops-app.mjs';
import { loadLocalEnv } from '../lib/runtime/load-env.mjs';
import { sanitizePlaywrightBrowsersEnv } from '../lib/runtime/playwright-browser.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadLocalEnv({ root: repoRoot });
sanitizePlaywrightBrowsersEnv();

function argsOf(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) positional.push(value);
    else {
      const key = value.slice(2);
      if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[key] = argv[++index];
      else flags[key] = true;
    }
  }
  return { positional, flags };
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function taskFrom(value) {
  return value.schema === 'PreparedTaskBundleV1' ? value.task : value;
}

function targetFrom(flags) {
  if (flags.target) return resolve(flags.target);
  const selected = process.env.CAREER_OPS_DATA_DIR || 'ft';
  if (selected.split(/[\\/]/).includes('..')) throw new Error('CAREER_OPS_DATA_DIR cannot contain ..');
  return resolve(repoRoot, selected);
}

function statePath(target) {
  return join(persistencePaths(target).runtimeDir, 'runtime-state.json');
}

function readState(target) {
  const path = statePath(target);
  return existsSync(path) ? readJson(path) : record('RuntimeStateV1', { provider_observations: {}, resource_pools: {} });
}

function writeState(target, state) {
  const path = statePath(target);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${canonicalJson(state)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}

function output(value, path, { overwrite = false } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) {
    process.stdout.write(text);
    return;
  }
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  if (existsSync(resolved) && !overwrite) throw new Error(`Output already exists: ${resolved}`);
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, resolved);
}

function checkpointPrefix(value) {
  const resolved = resolve(value);
  return resolved.replace(/\.(triage|judgment|escalation)\.json$/i, '').replace(/\.json$/i, '');
}

function checkpointPath(prefix, stage) {
  return `${checkpointPrefix(prefix)}.${stage}.json`;
}

function authorizeMutation(flags, config = null) {
  if (!flags.config) {
    const error = new Error('Runtime mutation requires --config <runtime.yml> for writer authorization');
    error.code = 'WRITER_CONFIG_REQUIRED';
    throw error;
  }
  const selectedConfig = config || loadRuntimeConfig(flags.config);
  assertWriterHost(selectedConfig);
  return selectedConfig;
}

/**
 * A committed evaluation is the only normal path that may create application
 * work automatically. This keeps discovery-only scans inert while ensuring a
 * user-enabled post-scan rollout sees exactly the rows just committed, not an
 * arbitrary tracker backlog. `runApplications` still re-checks eligibility,
 * ATS allowlist, liveness, and the at-most-once attempt state before opening a
 * browser.
 */
async function autoApplyCommittedRows(target, config, trackerNumbers) {
  const policy = config?.applications;
  if (policy?.enabled !== true || policy.auto_after_scan !== true) return null;
  const numbers = [...new Set((trackerNumbers || []).map(Number).filter(Number.isFinite))];
  if (!numbers.length) return null;
  const queued = await enqueueEligible(target, { trackerNumbers: numbers, includeCurrent: true, config });
  const run = await runApplications(target, config, {
    // This is intentionally configuration-gated rather than inherited from a
    // generic commit flag. The user enables application submission locally;
    // checked-in configuration always leaves it off.
    submit: policy.auto_submit === true,
    max: 1,
    attemptKeys: enqueuedAttemptKeys(queued),
  });
  return record('CommittedApplicationRunV1', { tracker_numbers: numbers, queued, run });
}

function validatedFromFiles(taskPath, responsePath) {
  const task = taskFrom(readJson(taskPath));
  const responseText = readFileSync(resolve(responsePath), 'utf8');
  let response;
  try { response = JSON.parse(responseText); } catch { response = responseText; }
  if (response?.schema === 'RawProviderResultV1') {
    const normalized = normalizeEvaluation(task, response);
    const decision = decide(task, normalized);
    const presentation = sanitizePresentation(normalized.presentation_content, decision);
    return { task, rawResult: response, normalized, decision, presentation };
  }
  return evaluateResponse(task, response);
}

async function main() {
  const { positional, flags } = argsOf(process.argv.slice(2));
  const [command, subcommand] = positional;
  if (!command || command === 'help') {
    process.stdout.write('Usage: career-ops <apply|handshake|baseline|prepare|respond|validate|commit|batch|evaluate|ui|shadow|route-shadow|hardware-qualify|canary-certify|recover|route|qualify|qualify-bundle|doctor|quota|cleanup> [options]\n');
    return;
  }
  const target = targetFrom(flags);
  if (command === 'apply') {
    if (subcommand === 'qualify-local-prose') {
      if (!flags.config || !flags.provider) throw new Error('apply qualify-local-prose requires --config and --provider');
      const config = loadRuntimeConfig(flags.config);
      const providerConfig = config.providers?.[flags.provider];
      if (!providerConfig) throw new Error(`Unknown provider: ${flags.provider}`);
      const provider = createProvider(flags.provider, { ...providerConfig, enabled: true,
        json_schema_file: resolve(repoRoot, 'schemas/runtime/application-answer-response.v1.schema.json') }, config);
      try {
        const qualification = await runLocalApplicationProseQualification({ provider, providerId: flags.provider, providerConfig,
          caseCount: flags.cases === undefined ? 50 : Number(flags.cases),
          onProgress(progress) { process.stderr.write(`${JSON.stringify({ event: 'application_prose_qualification_progress', ...progress })}\n`); },
        });
        output(qualification, flags.out);
        if (!qualification.qualified) process.exitCode = 2;
      } finally { provider.close?.(); }
      return;
    }
    if (subcommand === 'doctor') {
      if (!flags.config) throw new Error('apply doctor requires --config');
      const config = loadRuntimeConfig(flags.config);
      const report = diagnoseApplications(target, config);
      output(report, flags.out);
      if (flags.human) process.stdout.write(`${report.summary}\n${report.queue?.near_misses?.length ? `\nNear-misses: ${report.queue.near_miss_count}\n` : ''}`);
      if (!report.ready) process.exitCode = 2;
      return;
    }
    if (subcommand === 'analytics') {
      output(applicationAttemptAnalytics(target), flags.out);
      return;
    }
    if (subcommand === 'enqueue') {
      const config = flags.config ? loadRuntimeConfig(flags.config) : null;
      if (!flags.apply) {
        const preview = applicationQueuePreview(target, { config });
        output(preview, flags.out);
        if (flags.human) process.stdout.write(`${preview.human_summary}\n`);
        return;
      }
      authorizeMutation(flags, config);
      output(record('ApplicationEnqueueResultV1', await enqueueEligible(target, {
        includeCurrent: flags['include-current'] === true,
        config,
      })));
      return;
    }
    if (subcommand === 'run') {
      if (!flags.config) throw new Error('apply run requires --config');
      if (!flags.apply) throw new Error('apply run changes local attempt state and requires --apply');
      const config = mergeRuntimeState(authorizeMutation(flags), readState(target));
      const selectedTrackerNumber = flags['tracker-number'] === undefined ? null : Number(flags['tracker-number']);
      if (selectedTrackerNumber !== null && (!Number.isInteger(selectedTrackerNumber) || selectedTrackerNumber <= 0)) {
        throw new Error('apply run --tracker-number requires a positive integer');
      }
      const selected = selectedTrackerNumber === null ? null
        : await enqueueEligible(target, { trackerNumbers: [selectedTrackerNumber], includeCurrent: true, config });
      output(record('ApplicationRunResultV1', await runApplications(target, config, {
        submit: flags.submit === true,
        max: flags.max || 1,
        pauseForAuthentication: flags['pause-for-auth'] === true,
        attemptKeys: selected ? exactAttemptKeys(target, selectedTrackerNumber, selected) : null,
      })));
      return;
    }
    if (subcommand === 'mfa-code') {
      if (!flags.apply || !flags.config || !flags['tracker-number'] || typeof flags.code !== 'string') {
        throw new Error('apply mfa-code requires --tracker-number, --code, --config, and --apply');
      }
      authorizeMutation(flags);
      output(record('ApplicationMfaCodeHandoffV1', stageMfaCode(target, Number(flags['tracker-number']), flags.code)));
      return;
    }
    if (subcommand === 'override') {
      if (!flags.apply || !flags.config || !flags['tracker-number']) {
        throw new Error('apply override requires --tracker-number, --config, and --apply');
      }
      const config = authorizeMutation(flags);
      output(record('ApplicationSelectionOverrideV1', await enqueueSelectionOverride(target, Number(flags['tracker-number']), { config })));
      return;
    }
    if (subcommand === 'retry') {
      if (!flags.apply || !flags.config || !flags['tracker-number']) {
        throw new Error('apply retry requires --tracker-number, --config, and --apply');
      }
      authorizeMutation(flags);
      output(record('ApplicationRetryResultV1', retryApplication(target, Number(flags['tracker-number']), {
        confirmNotSubmitted: flags['confirm-not-submitted'] === true,
      })));
      return;
    }
    if (subcommand === 'after-scan') {
      if (!flags.config || !flags.apply) throw new Error('apply after-scan requires --config and --apply');
      if (!flags['tracker-numbers']) throw new Error('apply after-scan requires --tracker-numbers <n,n,...>');
      const config = mergeRuntimeState(authorizeMutation(flags), readState(target));
      if (config.applications?.auto_after_scan !== true) throw new Error('applications.auto_after_scan must be true for apply after-scan');
      const trackerNumbers = String(flags['tracker-numbers']).split(',').map(Number).filter(Number.isFinite);
      const queued = await enqueueEligible(target, { trackerNumbers, includeCurrent: true, config });
      output(record('PostScanApplicationResultV1', {
        queued,
        run: await runApplications(target, config, {
          submit: flags.submit === true,
          max: flags.max || 1,
          attemptKeys: enqueuedAttemptKeys(queued),
        }),
      }));
      return;
    }
    if (subcommand === 'serve') {
      // A board opened without local configuration is intentionally read-only.
      // Enabling action buttons requires writer authorization, and Resume now
      // launches only the exact requeued attempt.
      if (!flags.config || !flags.apply) {
        serveApplyBoard(target, { port: Number(flags.port || 8788) });
        return;
      }
      const config = mergeRuntimeState(authorizeMutation(flags), readState(target));
      if (config.applications?.enabled !== true) throw new Error('applications.enabled must be true for an actionable apply board');
      let replay = Promise.resolve();
      serveApplyBoard(target, {
        port: Number(flags.port || 8788), allowActions: true,
        onRetry: key => {
          // Serialize UI clicks and keep a replay bound to its own idempotency
          // key, so another queued row cannot be opened accidentally.
          replay = replay.then(() => runApplications(target, config, {
            submit: flags.submit === true, max: 1, attemptKeys: [key],
          }));
          return replay;
        },
      });
      return;
    }
    if (subcommand === 'acknowledge') {
      if (!flags.apply || !flags.config || !flags['tracker-number']) {
        throw new Error('apply acknowledge requires --tracker-number, --config, and --apply');
      }
      const config = authorizeMutation(flags);
      output(record('ApplicationManualAcknowledgementV1', await acknowledgeManualSubmission(target, Number(flags['tracker-number']), {
        timeZone: config.applications?.time_zone,
      })));
      return;
    }
    throw new Error('Usage: career-ops apply <doctor|analytics|enqueue|run|override|retry|after-scan|serve|acknowledge|qualify-local-prose|mfa-code>');
  }
  if (command === 'baseline') {
    const baseline = captureBaseline({ repoRoot, target });
    output(flags.before ? compareBaselines(readJson(flags.before), baseline) : baseline, flags.out);
    return;
  }
  if (command === 'prepare') {
    if (!flags.input) throw new Error('prepare requires --input <seed.json>');
    const input = readJson(flags.input);
    const task = prepareTask(input);
    const sourceEvidence = Array.isArray(input.evidence) ? input.evidence : [];
    const evidenceContent = Object.fromEntries(task.evidence_manifest.map((item, index) => [item.id, String(sourceEvidence[index]?.content ?? '')]));
    output(record('PreparedTaskBundleV1', { task, provider_request: buildProviderRequest(task, evidenceContent) }), flags.out);
    return;
  }
  if (command === 'validate') {
    if (!flags.task || !flags.response) throw new Error('validate requires --task and --response');
    const value = validatedFromFiles(flags.task, flags.response);
    output(record('ValidatedEvaluationBundleV1', {
      task: value.task,
      normalized: value.normalized,
      decision: value.decision,
      presentation: value.presentation,
    }), flags.out);
    return;
  }
  if (command === 'commit') {
    if (!flags.task || !flags.response) throw new Error('commit requires --task and --response');
    const value = validatedFromFiles(flags.task, flags.response);
    if (!flags.apply) {
      output(record('CommitPreviewV1', { apply_required: true, decision: value.decision }));
      return;
    }
    const config = mergeRuntimeState(authorizeMutation(flags), readState(target));
    const receipt = await commitEvaluation({ target, ...value });
    const application = await autoApplyCommittedRows(target, config, [receipt.report_identity?.report_number]);
    output(application ? record('CommitAndApplicationResultV1', { receipt, application }) : receipt, flags.out);
    return;
  }
  if (command === 'batch') {
    if (!flags.manifest) throw new Error('batch requires --manifest <batch.json>');
    const manifestPath = resolve(flags.manifest);
    const manifest = readJson(manifestPath);
    if (manifest.schema !== 'RuntimeBatchManifestV1' || manifest.schema_version !== 1 || !Array.isArray(manifest.entries)) {
      throw new Error('batch manifest must be RuntimeBatchManifestV1 with an entries array');
    }
    const config = flags.apply ? mergeRuntimeState(authorizeMutation(flags), readState(target)) : null;
    const results = [];
    for (let index = 0; index < manifest.entries.length; index++) {
      const entry = manifest.entries[index];
      const id = String(entry?.id ?? index + 1);
      try {
        if (typeof entry?.task !== 'string' || typeof entry?.response !== 'string') {
          throw new Error('entry requires task and response file paths');
        }
        const taskPath = resolve(dirname(manifestPath), entry.task);
        const responsePath = resolve(dirname(manifestPath), entry.response);
        const value = validatedFromFiles(taskPath, responsePath);
        if (flags.apply) {
          const receipt = await commitEvaluation({ target, ...value });
          results.push({ id, status: 'COMMITTED', receipt });
        } else {
          results.push({ id, status: 'VALIDATED', decision: value.decision });
        }
      } catch (error) {
        results.push({ id, status: 'FAILED', error: error.message });
      }
    }
    const failed = results.filter(item => item.status === 'FAILED').length;
    const application = flags.apply
      ? await autoApplyCommittedRows(target, config, results.filter(item => item.status === 'COMMITTED')
        .map(item => item.receipt?.report_identity?.report_number))
      : null;
    output(record(flags.apply ? 'RuntimeBatchResultV1' : 'RuntimeBatchPreviewV1', {
      apply: Boolean(flags.apply),
      total: results.length,
      succeeded: results.length - failed,
      failed,
      results,
      ...(application ? { application } : {}),
    }), flags.out);
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === 'evaluate') {
    const files = flags.file ? [resolve(flags.file)] : null;
    const config = flags.config
      ? (flags.apply
        ? mergeRuntimeState(authorizeMutation(flags), readState(target))
        : mergeRuntimeState(loadRuntimeConfig(flags.config), readState(target)))
      : null;
    if (flags.apply && !flags.config) throw new Error('evaluate --apply requires --config');
    const human = shouldUseHumanEvaluateOutput({
      flags,
      stdoutIsTTY: Boolean(process.stdout.isTTY),
    });
    const progressTty = Boolean(process.stderr.isTTY) && flags.json !== true;
    let lastProgressStage = null;
    let lastProgressAt = 0;
    const result = await evaluateScanResults({
      target,
      config,
      files,
      max: flags.max === undefined ? Infinity : Number(flags.max),
      apply: flags.apply === true,
      fromQueue: flags['from-queue'] === true,
      queuePath: flags.queue ? resolve(flags.queue) : null,
      skipLiveness: flags['skip-liveness'] === true,
      provider: flags.provider || null,
      profile: flags.profile || null,
      concurrency: flags.concurrency === undefined ? 10 : Number(flags.concurrency),
      evaluateConcurrency: flags['eval-concurrency'] === undefined ? 3 : Number(flags['eval-concurrency']),
      acknowledgeQuota: flags['acknowledge-quota'] === true,
      maxAgeDays: flags['max-age-days'] === undefined ? 21 : Number(flags['max-age-days']),
      allowSenior: flags['allow-senior'] === true,
      forceProvider: flags['force-provider'] === true,
      livenessCache: flags['no-liveness-cache'] !== true,
      refreshLiveness: flags['refresh-liveness'] === true,
      livenessTtlHours: flags['liveness-ttl-hours'] === undefined ? 12 : Number(flags['liveness-ttl-hours']),
      onProgress(progress) {
        if (!progressTty) {
          process.stderr.write(`${JSON.stringify({ event: 'evaluate_progress', ...progress })}\n`);
          return;
        }
        if (lastProgressStage && lastProgressStage !== progress.stage) {
          process.stderr.write('\n');
          lastProgressAt = 0;
        }
        lastProgressStage = progress.stage;
        const done = Number(progress.done || 0);
        const total = Number(progress.total || 0);
        const isFinal = total > 0 && done >= total;
        // Throttle mid-stage redraws so Cursor's terminal does not smear wraps.
        if (!isFinal && done - lastProgressAt < 3 && done !== 1) return;
        lastProgressAt = done;
        process.stderr.write(formatEvaluateProgress(progress, {
          tty: true,
          columns: process.stderr.columns,
        }));
        if (isFinal) process.stderr.write('\n');
      },
    });
    if (progressTty && lastProgressStage) process.stderr.write('\n');
    if (human) {
      // Evaluate plans/results are rerun artifacts; allow replacing --out.
      if (flags.out) output(result, flags.out, { overwrite: true });
      process.stdout.write(formatEvaluateSummary(result, { colorize: Boolean(process.stdout.isTTY) }));
    } else {
      output(result, flags.out, { overwrite: Boolean(flags.out) });
    }
    if (result.failed) process.exitCode = 1;
    return;
  }
  if (command === 'shadow') {
    if (!flags.suite || !flags.config || !flags.provider) throw new Error('shadow requires --suite, --config, and --provider');
    if (!flags['acknowledge-quota']) throw new Error('shadow invokes a provider and requires --acknowledge-quota');
    const config = loadRuntimeConfig(flags.config);
    const providerConfig = config.providers?.[flags.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${flags.provider}`);
    const localOpenAiProvider = providerConfig.type === 'openai_compatible'
      && providerConfig.local_only === true;
    if (providerConfig.type?.endsWith('_api') || (providerConfig.type === 'openai_compatible' && !localOpenAiProvider)) {
      throw new Error('shadow CLI does not enable billed API providers');
    }
    const definition = readJson(flags.suite);
    const caseIds = flags['case-ids'] === undefined
      ? null
      : String(flags['case-ids']).split(',').map(value => value.trim()).filter(Boolean);
    if (caseIds && flags.offset !== undefined) throw new Error('--case-ids cannot be combined with --offset');
    const offset = flags.offset === undefined ? 0 : Number(flags.offset);
    const limit = caseIds ? caseIds.length : flags.limit === undefined ? definition.case_count : Number(flags.limit);
    const providerRuns = flags['provider-runs'] === undefined ? limit : Number(flags['provider-runs']);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error('--offset must be non-negative and --limit must be 1-50');
    }
    if (!Number.isInteger(providerRuns) || providerRuns < 1 || providerRuns > limit) {
      throw new Error('--provider-runs must be between 1 and --limit');
    }
    const effectiveProviderConfig = providerRuns < limit
      ? {
          ...providerConfig,
          input_mode: 'stdin_json',
          json_schema_file: providerConfig.shadow_json_schema_file,
        }
      : providerConfig;
    if (providerRuns < limit && !effectiveProviderConfig.json_schema_file) {
      throw new Error('Batched shadow runs require shadow_json_schema_file');
    }
    const provider = createProvider(flags.provider, localOpenAiProvider
      ? { ...effectiveProviderConfig, enabled: true }
      : effectiveProviderConfig, config);
    let result;
    try {
      result = await runShadowQualification({
        definition,
        provider,
        providerId: flags.provider,
        offset,
        limit,
        caseIds,
        providerRuns,
        onProgress(progress) {
          process.stderr.write(`${JSON.stringify({ event: 'shadow_progress', ...progress })}\n`);
        },
      });
    } finally {
      provider.close?.();
    }
    if (flags.preflight) {
      const minimumAgreement = flags['minimum-agreement'] === undefined ? 1 : Number(flags['minimum-agreement']);
      const preflightGate = evaluateShadowPreflight(result, {
        minimumAgreement,
        requireNoRepairs: flags['allow-preflight-repairs'] !== true,
      });
      result = { ...result, preflight_gate: preflightGate };
      output(result, flags.out);
      if (!preflightGate.passed) process.exitCode = 2;
      return;
    }
    output(result, flags.out);
    return;
  }
  if (command === 'route-shadow') {
    if (!flags.suite || !flags.config || !flags.profile) {
      throw new Error('route-shadow requires --suite, --config, and --profile');
    }
    const definition = readJson(flags.suite);
    const configured = loadRuntimeConfig(flags.config);
    const profile = resolveRoutingProfile(configured, flags.profile);
    const maxJudgments = flags['max-judgments'] === undefined ? 50 : Number(flags['max-judgments']);
    const maxEscalations = flags['max-escalations'] === undefined ? 10 : Number(flags['max-escalations']);
    if (!Number.isInteger(maxJudgments) || maxJudgments < 1 || maxJudgments > 50) {
      throw new Error('--max-judgments must be 1-50');
    }
    if (!Number.isInteger(maxEscalations) || maxEscalations < 0 || maxEscalations > 50) {
      throw new Error('--max-escalations must be 0-50');
    }
    const baseline = flags.baseline ? readJson(flags.baseline) : null;
    if (flags['plan-only']) {
      if (flags.resume || flags.checkpoint) throw new Error('--resume and --checkpoint are only valid for executed route shadows');
      output(buildRouteShadowPlan({
        definition,
        profileId: flags.profile,
        profile,
        maxJudgments,
        maxEscalations,
        baseline,
      }), flags.out);
      return;
    }
    if (!flags['acknowledge-quota']) {
      throw new Error('route-shadow invokes providers and requires --acknowledge-quota');
    }
    const config = mergeRuntimeState(configured, readState(target));
    assertFreshManualQuotas(config, profile);
    if (flags.resume === true || flags.checkpoint === true) {
      throw new Error('--resume and --checkpoint require a file path');
    }
    const resume = flags.resume ? readJson(flags.resume) : null;
    const selectedCheckpointPrefix = flags.checkpoint || flags.resume || null;
    const result = await runRouteShadow({
      definition,
      profileId: flags.profile,
      profile,
      maxJudgments,
      maxEscalations,
      baseline,
      resume,
      onCheckpoint: selectedCheckpointPrefix ? async checkpoint => {
        const path = checkpointPath(selectedCheckpointPrefix, checkpoint.completed_stage);
        output(checkpoint, path);
        process.stderr.write(`${JSON.stringify({
          event: 'route_shadow_checkpoint',
          stage: checkpoint.completed_stage,
          path,
        })}\n`);
      } : null,
      async runStage({ stage, providerId, caseIds, providerRuns }) {
        const providerConfig = config.providers[providerId];
        if (providerConfig.type?.endsWith('_api') || providerConfig.type === 'openai_compatible') {
          throw new Error(`route-shadow does not enable API provider ${providerId}`);
        }
        const stageSchema = stage === 'triage'
          ? providerConfig.triage_json_schema_file
          : providerConfig.routing_json_schema_file;
        const effective = {
          ...providerConfig,
          ...(stage === 'triage' ? { input_mode: 'stdin_json' } : {}),
          json_schema_file: stageSchema,
        };
        if (!effective.json_schema_file) {
          throw new Error(`${stage} stage requires its configured JSON schema for ${providerId}`);
        }
        const provider = createProvider(providerId, effective, config);
        try {
          if (stage === 'triage') {
            return await runTriageRanking({
              definition,
              provider,
              providerId,
              caseIds,
              batchSize: profile.triage.batch_size,
              onProgress(progress) {
                process.stderr.write(`${JSON.stringify({ event: 'route_shadow_progress', stage, ...progress })}\n`);
              },
            });
          }
          return await runShadowQualification({
            definition,
            provider,
            providerId,
            caseIds,
            providerRuns,
            taskTransform: addRoutingSignals,
            onProgress(progress) {
              process.stderr.write(`${JSON.stringify({ event: 'route_shadow_progress', stage, ...progress })}\n`);
            },
          });
        } finally {
          provider.close?.();
        }
      },
    });
    output(result, flags.out);
    return;
  }
  if (command === 'hardware-qualify') {
    if (!flags.config || !flags.provider) throw new Error('hardware-qualify requires --config and --provider');
    const config = loadRuntimeConfig(flags.config);
    const providerConfig = config.providers?.[flags.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${flags.provider}`);
    if (providerConfig.type !== 'openai_compatible' || providerConfig.local_only !== true) {
      throw new Error('hardware-qualify accepts only a local openai_compatible provider');
    }
    const caseCount = flags.cases === undefined ? 50 : Number(flags.cases);
    const provider = createProvider(flags.provider, { ...providerConfig, enabled: true }, config);
    const qualification = await runLocalHardwareQualification({
      provider,
      providerId: flags.provider,
      providerConfig,
      caseCount,
      onProgress(progress) {
        process.stderr.write(`${JSON.stringify({ event: 'hardware_qualification_progress', ...progress })}\n`);
      },
    });
    output(qualification, flags.out);
    if (!qualification.qualified) process.exitCode = 2;
    return;
  }
  if (command === 'canary-certify') {
    if (!flags.qualification || !flags.receipts) {
      throw new Error('canary-certify requires --qualification and comma-separated --receipts');
    }
    const receiptPaths = String(flags.receipts).split(',').map(value => value.trim()).filter(Boolean);
    const minimumReceipts = flags['minimum-receipts'] === undefined ? 3 : Number(flags['minimum-receipts']);
    const certification = certifyCanary({
      qualificationBundle: readJson(flags.qualification),
      receipts: receiptPaths.map(readJson),
      target,
      minimumReceipts,
    });
    output(certification, flags.out);
    if (!certification.passed) process.exitCode = 2;
    return;
  }
  if (command === 'recover') {
    if (!flags.apply) throw new Error('recover changes persisted state and requires --apply');
    authorizeMutation(flags);
    output(record('RecoveryResultV1', { results: await recoverTransactions({ target }) }), flags.out);
    return;
  }
  if (command === 'respond') {
    if (!flags.task || !flags.config || !flags.provider) throw new Error('respond requires --task, --config, and --provider');
    const taskBundle = readJson(flags.task);
    const task = taskFrom(taskBundle);
    const config = mergeRuntimeState(loadRuntimeConfig(flags.config), readState(target));
    if (flags.apply) authorizeMutation(flags, config);
    const routed = routeTask(task, { ...config, providers: { [flags.provider]: config.providers?.[flags.provider] } });
    if (routed.result !== 'ROUTED' || routed.provider_id !== flags.provider) throw new Error(`Provider is not eligible: ${routed.reason || routed.result}`);
    const providerConfig = config.providers?.[flags.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${flags.provider}`);
    const provider = createProvider(flags.provider, providerConfig, config);
    const evidenceContent = flags.evidence
      ? readJson(flags.evidence)
      : Object.fromEntries((taskBundle.provider_request?.evidence || []).map(item => [item.id, item.content]));
    let result;
    try {
      result = await evaluateWithProvider({
        task,
        evidenceContent,
        provider,
        retentionTarget: flags.apply ? target : null,
      });
    } finally {
      provider.close?.();
    }
    if (flags.apply) {
      output(await commitEvaluation({ target, ...result }), flags.out);
      return;
    }
    output(record('ValidatedEvaluationBundleV1', {
      task,
      normalized: result.normalized,
      decision: result.decision,
      presentation: result.presentation,
      provider_provenance: result.rawResult.provider_snapshot,
      usage: result.rawResult.usage,
    }), flags.out);
    return;
  }
  if (command === 'route') {
    if (!flags.task || !flags.config) throw new Error('route requires --task and --config');
    const task = taskFrom(readJson(flags.task));
    const config = mergeRuntimeState(loadRuntimeConfig(flags.config), readState(target));
    output(flags.profile
      ? routeProfileTask(task, config, flags.profile, { mode: flags.mode || 'individual' })
      : routeTask(task, config), flags.out);
    return;
  }
  if (command === 'qualify') {
    if (!flags.metrics && !flags.results) throw new Error('qualify requires --metrics <json> or --results <json>');
    const metrics = flags.results
      ? aggregateQualificationResults(readJson(flags.results), flags.metadata ? readJson(flags.metadata) : {})
      : readJson(flags.metrics);
    output(qualifyModel(metrics, flags.incumbent ? readJson(flags.incumbent) : null), flags.out);
    return;
  }
  if (command === 'qualify-bundle') {
    if (!flags.recommendations || !flags['hard-gates']) {
      throw new Error('qualify-bundle requires --recommendations <shadow-run.json> and --hard-gates <shadow-run.json>');
    }
    output(composeQualificationEvidence({
      recommendationRun: readJson(flags.recommendations),
      hardGateRun: readJson(flags['hard-gates']),
      incumbent: flags.incumbent ? readJson(flags.incumbent) : null,
    }), flags.out);
    return;
  }
  if (command === 'doctor') {
    if (!flags.config) throw new Error('doctor requires --config');
    const config = loadRuntimeConfig(flags.config);
    if (flags.apply) authorizeMutation(flags, config);
    const observation = observeEnvironment(config);
    if (flags.apply) {
      const state = readState(target);
      state.environment = observation.environment;
      state.capability_profile = observation.capability_profile;
      state.provider_observations = observation.provider_observations;
      writeState(target, state);
    }
    output(observation, flags.out);
    return;
  }
  if (command === 'quota' && subcommand === 'status') {
    output(readState(target));
    return;
  }
  if (command === 'quota' && subcommand === 'set') {
    if (!flags.pool || flags.remaining === undefined) throw new Error('quota set requires --pool and --remaining');
    if (!flags.apply) throw new Error('quota set changes runtime state and requires --apply');
    authorizeMutation(flags);
    const remaining = Number(flags.remaining);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 1) throw new Error('--remaining must be 0-1');
    const state = readState(target);
    state.resource_pools[flags.pool] = record('ResourcePoolV1', {
      quota_state: 'AVAILABLE',
      remaining_ratio: remaining,
      observed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    writeState(target, state);
    output(state);
    return;
  }
  if (command === 'cleanup') {
    if (!flags.apply) throw new Error('cleanup deletes expired local retention files and requires --apply');
    authorizeMutation(flags);
    output(record('CleanupResultV1', cleanupRetention(target)));
    return;
  }
  if (command === 'handshake') {
    if (!flags.config) throw new Error('handshake requires --config');
    if (subcommand === 'doctor') {
      const config = loadRuntimeConfig(flags.config);
      const report = await diagnoseHandshake(target, config);
      output(report, flags.out);
      if (flags.human) process.stdout.write(`${report.summary}\n`);
      if (!report.ready) process.exitCode = 2;
      return;
    }
    if (subcommand === 'job' || subcommand === 'session') {
      if (!flags.apply) throw new Error(`handshake ${subcommand} changes tracker/attempt state and requires --apply`);
      const config = mergeRuntimeState(authorizeMutation(flags), readState(target));
      if (config.applications?.enabled !== true) {
        throw new Error('applications.enabled must be true for handshake job/session');
      }
      if (subcommand === 'session' && flags.max === undefined) {
        throw new Error('handshake session requires --max');
      }
      const progress = (event) => {
        process.stderr.write(`${JSON.stringify({ event: 'handshake_progress', ...event })}\n`);
      };
      const shared = {
        target,
        config,
        repoRoot,
        submit: flags.submit === true,
        acknowledgeQuota: true,
        forceProvider: flags['force-provider'] === true,
        onProgress: progress,
      };
      const result = subcommand === 'job'
        ? await runHandshakeJob(shared)
        : await runHandshakeSession({ ...shared, max: Number(flags.max) });
      output(result, flags.out);
      return;
    }
    throw new Error('Usage: career-ops handshake <doctor|job|session>');
  }
  if (command === 'ui') {
    await serveCareerOpsApp({
      target,
      repoRoot,
      configPath: flags.config ? resolve(flags.config) : null,
      port: flags.port === undefined ? 8790 : Number(flags.port),
    });
    // Keep the process alive for the HTTP server.
    await new Promise(() => {});
    return;
  }
  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.code || error.name, message: error.message, details: error.details || null })}\n`);
  process.exitCode = 1;
});
