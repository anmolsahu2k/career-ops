#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, mergeRuntimeState } from '../lib/runtime/config.mjs';
import { captureBaseline, compareBaselines } from '../lib/runtime/baseline.mjs';
import { certifyCanary } from '../lib/runtime/canary.mjs';
import { observeEnvironment } from '../lib/runtime/doctor.mjs';
import { normalizeEvaluation } from '../lib/runtime/normalize.mjs';
import { evaluateResponse, evaluateWithProvider } from '../lib/runtime/orchestrator.mjs';
import { decide } from '../lib/runtime/policy-engine.mjs';
import { buildProviderRequest, prepareTask } from '../lib/runtime/prepare.mjs';
import { createProvider } from '../lib/runtime/providers/index.mjs';
import { aggregateQualificationResults, composeQualificationEvidence, qualifyModel } from '../lib/runtime/qualification.mjs';
import { cleanupRetention } from '../lib/runtime/retention.mjs';
import { routeTask } from '../lib/runtime/router.mjs';
import { sanitizePresentation } from '../lib/runtime/sanitizer.mjs';
import { evaluateShadowPreflight, runShadowQualification } from '../lib/runtime/shadow.mjs';
import { commitEvaluation, persistencePaths, recoverTransactions } from '../lib/runtime/transaction.mjs';
import { canonicalJson, record } from '../lib/runtime/util.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

function output(value, path) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) {
    process.stdout.write(text);
    return;
  }
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  if (existsSync(resolved)) throw new Error(`Output already exists: ${resolved}`);
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, resolved);
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
    process.stdout.write('Usage: career-ops <baseline|prepare|respond|validate|commit|batch|shadow|canary-certify|recover|route|qualify|qualify-bundle|doctor|quota|cleanup> [options]\n');
    return;
  }
  const target = targetFrom(flags);
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
    const receipt = await commitEvaluation({ target, ...value });
    output(receipt, flags.out);
    return;
  }
  if (command === 'batch') {
    if (!flags.manifest) throw new Error('batch requires --manifest <batch.json>');
    const manifestPath = resolve(flags.manifest);
    const manifest = readJson(manifestPath);
    if (manifest.schema !== 'RuntimeBatchManifestV1' || manifest.schema_version !== 1 || !Array.isArray(manifest.entries)) {
      throw new Error('batch manifest must be RuntimeBatchManifestV1 with an entries array');
    }
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
    output(record(flags.apply ? 'RuntimeBatchResultV1' : 'RuntimeBatchPreviewV1', {
      apply: Boolean(flags.apply),
      total: results.length,
      succeeded: results.length - failed,
      failed,
      results,
    }), flags.out);
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === 'shadow') {
    if (!flags.suite || !flags.config || !flags.provider) throw new Error('shadow requires --suite, --config, and --provider');
    if (!flags['acknowledge-quota']) throw new Error('shadow invokes a provider and requires --acknowledge-quota');
    const config = loadRuntimeConfig(flags.config);
    const providerConfig = config.providers?.[flags.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${flags.provider}`);
    if (providerConfig.type?.endsWith('_api') || providerConfig.type === 'openai_compatible') {
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
    const provider = createProvider(flags.provider, effectiveProviderConfig, config);
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
    output(record('RecoveryResultV1', { results: await recoverTransactions({ target }) }), flags.out);
    return;
  }
  if (command === 'respond') {
    if (!flags.task || !flags.config || !flags.provider) throw new Error('respond requires --task, --config, and --provider');
    const taskBundle = readJson(flags.task);
    const task = taskFrom(taskBundle);
    const config = mergeRuntimeState(loadRuntimeConfig(flags.config), readState(target));
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
      result = await evaluateWithProvider({ task, evidenceContent, provider, retentionTarget: target });
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
    output(routeTask(task, config), flags.out);
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
    const observation = observeEnvironment(loadRuntimeConfig(flags.config));
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
    output(record('CleanupResultV1', cleanupRetention(target)));
    return;
  }
  throw new Error(`Unknown command: ${[command, subcommand].filter(Boolean).join(' ')}`);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.code || error.name, message: error.message, details: error.details || null })}\n`);
  process.exitCode = 1;
});
