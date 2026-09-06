import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { advanceLifecycle, aggregateQualificationResults, composeQualificationEvidence, qualifyModel, wilsonInterval } from '../lib/runtime/qualification.mjs';
import { effectiveReserveRatio, routeTask } from '../lib/runtime/router.mjs';
import { makeTask, NOW } from './runtime-fixtures.mjs';
import { createProvider } from '../lib/runtime/providers/index.mjs';
import { allowedEnvironment, resolveSchemaPath } from '../lib/runtime/providers/command.mjs';
import { evaluateShadowPreflight, expandQualificationSet, runShadowQualification } from '../lib/runtime/shadow.mjs';
import { record } from '../lib/runtime/util.mjs';
import { makeResponse } from './runtime-fixtures.mjs';

function qualification(overrides = {}) {
  return qualifyModel({
    provider_id: 'provider', model_snapshot: 'snapshot', task_class: 'job_evaluation', capability_class: 'CONSEQUENTIAL',
    representative_set: true,
    sample_count: 200, recommendation_agreement_successes: 195, schema_success: 0.995,
    hard_gate_errors: 0, authorization_errors: 0, consequential_unknown_rate: 0.10,
    evidence_accuracy: 0.99, shadow_passed: true, canary_passed: true,
    lifecycle_state: 'production',
    ...overrides,
  }, { consequential_unknown_rate: 0.10 });
}

function provider(overrides = {}) {
  return {
    enabled: true, available: true, capability_class: 'CONSEQUENTIAL',
    capabilities: ['structured_output', 'evidence_citations'], risk_ceiling: 'CONSEQUENTIAL',
    model_vendor: 'vendor-a', model_family: 'family-a', model_snapshot: 'a-1',
    execution_surface: 'surface-a', resource_pool: 'pool', qualification: qualification(),
    observation: { available: true, expires_at: '2026-09-05T17:00:00.000Z', latency_ms: 100 },
    ...overrides,
  };
}

const pools = { pool: { quota_state: 'AVAILABLE', remaining_ratio: 0.8, minimum_reserve_ratio: 0.2, emergency_reserve_ratio: 0.05, expires_at: '2026-09-05T17:00:00.000Z' } };

test('Wilson interval and qualification enforce confidence and unknown-rate gates', () => {
  assert.ok(wilsonInterval(195, 200).lower >= 0.90);
  assert.equal(qualification().qualified, true);
  assert.equal(qualification({ hard_gate_errors: 1 }).qualified, false);
  assert.equal(qualification({ consequential_unknown_rate: 0.16 }).qualified, false);
  assert.equal(qualification({ sample_count: 50, recommendation_agreement_successes: 48 }).qualified, false);
  const synthetic = qualification({ representative_set: false, lifecycle_state: 'shadow' });
  assert.equal(synthetic.lifecycle_state, 'candidate');
  assert.throws(() => advanceLifecycle(synthetic, 'shadow'), /representative passing shadow set/);
});

test('qualification harness aggregates the fixed evaluation set without model-to-model truth', () => {
  const results = Array.from({ length: 200 }, (_, index) => ({
    completed: true,
    schema_success: index !== 199,
    recommendation_comparison_eligible: true,
    expected_recommendation: 'APPLY',
    actual_recommendation: index < 195 ? 'APPLY' : 'CONSIDER',
    hard_gate_errors: 0, authorization_errors: 0,
    consequential_gate_count: 3, consequential_unknown_count: index < 20 ? 1 : 0,
    evidence_correct: true, attempts: 1, latency_ms: 100, input_tokens: 500, output_tokens: 200,
  }));
  const metrics = aggregateQualificationResults(results, { provider_id: 'p', model_snapshot: 'm', task_class: 'job_evaluation', capability_class: 'CONSEQUENTIAL', representative_set: true });
  assert.equal(metrics.sample_count, 200);
  assert.equal(metrics.transport_sample_count, 200);
  assert.equal(metrics.recommendation_agreement, 0.975);
  assert.equal(metrics.schema_success, 0.995);
  assert.equal(metrics.token_use, 700);
});

test('diagnostic final outcomes are excluded from recommendation qualification', () => {
  const metrics = aggregateQualificationResults([{
    completed: true,
    schema_success: true,
    recommendation_comparison_eligible: false,
    expected_recommendation: 'APPLY',
    actual_recommendation: 'CONSIDER',
    hard_gate_errors: 0,
    authorization_errors: 0,
    consequential_gate_count: 0,
    consequential_unknown_count: 0,
    evidence_correct: false,
    attempts: 1,
    latency_ms: 1,
  }]);
  assert.equal(metrics.sample_count, 0);
  assert.equal(metrics.transport_sample_count, 1);
  assert.equal(metrics.recommendation_agreement_successes, 0);
  assert.equal(metrics.recommendation_agreement, 0);
});

function componentRun(kind, overrides = {}) {
  const recommendations = kind === 'recommendations';
  const metrics = {
    provider_id: 'provider', model_snapshot: 'snapshot-1', task_class: 'job_evaluation', capability_class: 'CONSEQUENTIAL',
    evaluation_set_version: recommendations ? 'historical-v1' : 'oracle-v1',
    representative_set: recommendations, sample_count: 50, recommendation_agreement_successes: 50,
    recommendation_agreement: 1, hard_gate_errors: 0, authorization_errors: 0,
    consequential_unknown_rate: 0.02, schema_success: 1, evidence_accuracy: 1,
    repair_rate: 0, latency_ms: 10, token_use: 100, failure_rate: 0,
  };
  return record('ShadowQualificationRunV1', {
    provider_id: 'provider', model_snapshot: 'snapshot-1',
    evaluation_set_version: metrics.evaluation_set_version,
    truth_source: recommendations ? 'HUMAN_APPROVED_HISTORY' : 'DETERMINISTIC_ORACLE',
    label_scope: recommendations ? ['policy_recommendation'] : ['hard_gates', 'policy_decision'],
    gate_labels_included: !recommendations,
    promotion_eligible: false,
    promotion_blockers: recommendations ? ['RECOMMENDATION_ONLY_LABELS'] : ['SYNTHETIC_NON_REPRESENTATIVE'],
    component_passed: true,
    results: [], metrics,
    ...overrides,
  });
}

test('qualification evidence combines representative recommendations with deterministic hard gates', () => {
  const bundle = composeQualificationEvidence({
    recommendationRun: componentRun('recommendations'),
    hardGateRun: componentRun('hard-gates'),
  });
  assert.equal(bundle.schema, 'QualificationEvidenceBundleV1');
  assert.equal(bundle.coverage.representative_recommendations, true);
  assert.equal(bundle.coverage.deterministic_hard_gates, true);
  assert.equal(bundle.qualification.checks.shadow_passed, true);
  assert.equal(bundle.qualification.lifecycle_state, 'shadow');
  assert.equal(bundle.qualification.qualified, false);
});

test('qualification evidence rejects incomplete history and mismatched snapshots', () => {
  assert.throws(() => composeQualificationEvidence({
    recommendationRun: componentRun('recommendations', {
      promotion_blockers: ['RECOMMENDATION_ONLY_LABELS', 'INCOMPLETE_HISTORICAL_EVIDENCE'],
    }),
    hardGateRun: componentRun('hard-gates'),
  }), /INCOMPLETE_HISTORICAL_EVIDENCE/);
  assert.throws(() => composeQualificationEvidence({
    recommendationRun: componentRun('recommendations'),
    hardGateRun: componentRun('hard-gates', { model_snapshot: 'snapshot-2' }),
  }), /model_snapshot values do not match/);
});

test('router never falls below minimum capability class', () => {
  const task = makeTask({ minimum_capability_class: 'CONSEQUENTIAL' });
  const result = routeTask(task, { providers: { local: provider({ capability_class: 'EXTRACTION' }) }, resource_pools: pools }, { now: NOW });
  assert.equal(result.result, 'NO_ELIGIBLE_PROVIDER');
  assert.equal(result.reason, 'NO_CAPABILITY');
});

test('unknown or reserved quota fails closed', () => {
  const task = makeTask();
  const unknown = routeTask(task, { providers: { a: provider() }, resource_pools: { pool: { quota_state: 'UNKNOWN' } } }, { now: NOW });
  assert.equal(unknown.reason, 'QUOTA_UNAVAILABLE');
  const reserve = routeTask(task, { providers: { a: provider() }, resource_pools: { pool: { quota_state: 'AVAILABLE', remaining_ratio: 0.2, minimum_reserve_ratio: 0.2, expires_at: '2026-09-05T17:00:00.000Z' } } }, { now: NOW });
  assert.equal(reserve.reason, 'QUOTA_UNAVAILABLE');
});

test('adaptive reserve rises when quota burn is ahead of the reset window', () => {
  const reserve = effectiveReserveRatio({
    remaining_ratio: 0.35, minimum_reserve_ratio: 0.2, adaptive_reserve_enabled: true,
    window_started_at: '2026-09-05T15:00:00.000Z', reset_at: '2026-09-05T19:00:00.000Z',
  }, { adaptive: true }, Date.parse('2026-09-05T16:00:00.000Z'));
  assert.ok(reserve > 0.2);
});

test('independent audit requires a different vendor and execution surface', () => {
  const task = makeTask({ minimum_capability_class: 'INDEPENDENT_AUDIT' });
  const notIndependent = provider({ capability_class: 'INDEPENDENT_AUDIT' });
  const result = routeTask(task, { providers: { audit: notIndependent }, resource_pools: pools }, {
    now: NOW, auditOf: { model_vendor: 'vendor-a', execution_surface: 'surface-a' }, requireIndependentAudit: true,
  });
  assert.equal(result.reason, 'AUDIT_INDEPENDENCE_UNAVAILABLE');
  const independent = provider({ capability_class: 'INDEPENDENT_AUDIT', model_vendor: 'vendor-b', execution_surface: 'surface-b' });
  const routed = routeTask(task, { providers: { audit: independent }, resource_pools: pools }, {
    now: NOW, auditOf: { model_vendor: 'vendor-a', execution_surface: 'surface-a' }, requireIndependentAudit: true,
  });
  assert.equal(routed.result, 'ROUTED');
  assert.equal(routed.audit_independence, 'FULL');
});

test('provider-local configuration cannot override the global API billing switch', () => {
  const adapter = createProvider('api', {
    type: 'openai_compatible', enabled: true, api_billing_enabled: true,
    base_url: 'https://api.example.com', api_key_env: 'EXAMPLE_KEY',
  }, { api_billing: false });
  assert.equal(adapter.config.api_billing_enabled, false);
});

test('command adapter unwraps structured CLI envelopes and preserves usage', async () => {
  const program = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write('notice\\n'+JSON.stringify({status:'SUCCESS',response:'{"ok":true}',usage:{input_tokens:12,output_tokens:3}})+'\\n'));`;
  const adapter = createProvider('enveloped-cli', {
    type: 'command', command: [process.execPath, '-e', program], input_mode: 'stdin_text', output_mode: 'response_json_envelope', isolated_workspace: true,
    model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1', capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  const raw = await adapter.complete({ instruction: 'test', task: { task_id: 'task-envelope' }, evidence: [] });
  assert.equal(raw.response, '{"ok":true}');
  assert.equal(raw.usage.input_tokens, 12);
  assert.equal(raw.usage.output_tokens, 3);
  assert.equal(existsSync(adapter.isolatedDirectory), true);
  const contaminant = `${adapter.isolatedDirectory}/contaminant.txt`;
  writeFileSync(contaminant, 'must be cleared');
  await adapter.complete({ instruction: 'test again', task: { task_id: 'task-envelope-2' }, evidence: [] });
  assert.equal(existsSync(contaminant), false);
  const isolatedDirectory = adapter.isolatedDirectory;
  adapter.close();
  assert.equal(existsSync(isolatedDirectory), false);
});

test('command adapter prefers schema-validated structured output over display text', async () => {
  const program = `process.stdout.write(JSON.stringify({status:'SUCCESS',response:'display text',structured_output:{ok:true},usage:{input_tokens:4}})+'\\n')`;
  const adapter = createProvider('structured-cli', {
    type: 'command', command: [process.execPath, '-e', program], input_mode: 'stdin_text', output_mode: 'response_json_envelope',
    model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1', capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  const raw = await adapter.complete({ instruction: 'test', task: { task_id: 'task-structured' }, evidence: [] });
  assert.deepEqual(raw.response, { ok: true });
  assert.equal(raw.usage.input_tokens, 4);
});

test('text-mode command adapter includes bounded repair diagnostics in retry prompts', async () => {
  const program = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:'SUCCESS',response:input})+'\\n'));`;
  const adapter = createProvider('repair-cli', {
    type: 'command', command: [process.execPath, '-e', program], input_mode: 'stdin_text', output_mode: 'response_json_envelope',
    model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1', capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  const raw = await adapter.complete(
    { instruction: 'Return JSON.', task: { task_id: 'task-repair' }, evidence: [] },
    { attempt: 2, repair: { error: 'PRESENTATION_UNSAFE', message: `G contains prohibited content\n${'x'.repeat(600)}` } },
  );
  assert.match(raw.response, /previous output failed validation/i);
  assert.match(raw.response, /PRESENTATION_UNSAFE/);
  assert.match(raw.response, /G contains prohibited content/);
  const payload = JSON.parse(raw.response.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.repair.message.includes('\n'), false);
  assert.equal(payload.repair.message.length, 500);
});

test('command adapter bounds stderr as untrusted provider output', async () => {
  const adapter = createProvider('noisy-cli', {
    type: 'command', command: [process.execPath, '-e', `process.stderr.write('x'.repeat(4096))`],
    maximum_output_bytes: 1024, model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1',
    capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  await assert.rejects(
    adapter.complete({ instruction: 'test', task: { task_id: 'task-noisy' }, evidence: [] }),
    /exceeded the 1024-byte output limit/,
  );
});

test('command failure diagnostics omit an echoed prompt prefix', async () => {
  const adapter = createProvider('failing-cli', {
    type: 'command',
    command: [process.execPath, '-e', `process.stderr.write('SECRET_PROMPT '+ 'x'.repeat(3000) + '\\nERROR: SAFE_FAILURE_TAIL');process.exit(1)`],
    maximum_output_bytes: 8192, model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1',
    capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  await assert.rejects(
    adapter.complete({ instruction: 'test', task: { task_id: 'task-failing' }, evidence: [] }),
    error => !error.message.includes('SECRET_PROMPT') && error.message.includes('SAFE_FAILURE_TAIL'),
  );
});

test('command adapter supports path-based schema flags for Codex-style CLIs', () => {
  const schemaPath = fileURLToPath(new URL('../schemas/runtime/provider-response.v1.schema.json', import.meta.url));
  const adapter = createProvider('schema-cli', {
    type: 'command', command: [process.execPath, '-e', '', '-'],
    json_schema_file: schemaPath, json_schema_flag: '--output-schema', json_schema_mode: 'path',
    model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1',
    capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  assert.deepEqual(adapter.command.slice(-3), ['--output-schema', schemaPath, '-']);
  assert.equal(
    resolveSchemaPath('/D:/Create/career-ops/schemas/runtime/provider-response.v1.schema.json', 'win32'),
    'D:\\Create\\career-ops\\schemas\\runtime\\provider-response.v1.schema.json',
  );
});

test('command adapter preserves only required Windows profile variables for CLI credentials', () => {
  const environment = allowedEnvironment([], {
    Path: 'C:\\bin',
    USERPROFILE: 'C:\\Users\\candidate',
    HOMEDRIVE: 'C:',
    HOMEPATH: '\\Users\\candidate',
    APPDATA: 'C:\\Users\\candidate\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\candidate\\AppData\\Local',
    SystemRoot: 'C:\\Windows',
    CAREER_OPS_RUNTIME: 'v1',
    SECRET_TOKEN: 'must-not-pass',
  }, 'win32');
  assert.equal(environment.Path, 'C:\\bin');
  assert.equal(environment.USERPROFILE, 'C:\\Users\\candidate');
  assert.equal(environment.APPDATA, 'C:\\Users\\candidate\\AppData\\Roaming');
  assert.equal(environment.LOCALAPPDATA, 'C:\\Users\\candidate\\AppData\\Local');
  assert.equal(environment.CAREER_OPS_RUNTIME, 'v1');
  assert.equal(environment.SECRET_TOKEN, undefined);
});

test('command adapter conservatively records Codex total-token stderr', async () => {
  const adapter = createProvider('codex-usage-cli', {
    type: 'command',
    command: [process.execPath, '-e', `process.stderr.write('tokens used\\n14,435\\n');process.stdout.write('{"ok":true}')`],
    usage_mode: 'codex_total', model_vendor: 'test', model_family: 'test', model_snapshot: 'test-1',
    capability_class: 'STANDARD', execution_surface: 'test',
  }, {});
  const raw = await adapter.complete({ instruction: 'test', task: { task_id: 'task-codex-usage' }, evidence: [] });
  assert.equal(raw.usage.input_tokens, 14435);
  assert.equal(raw.usage.output_tokens, 0);
});

test('shadow suite expands deterministically and records metrics without raw responses', async () => {
  const definition = {
    schema: 'RuntimeQualificationSetV1', schema_version: 1, evaluation_set_version: 'test-v1', case_count: 1,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'eligible', score: 4.4, advisory_recommendation: 'APPLY', expected_recommendation: 'APPLY', fit_summary: 'The candidate meets the requirements.' }],
  };
  const expanded = expandQualificationSet(definition, { now: NOW });
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0].id, 'eligible-01');
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async request => record('RawProviderResultV1', {
      task_id: request.task.task_id,
      provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
      response: makeResponse(), usage: { input_tokens: 10, output_tokens: 5 }, latency_ms: 1, attempts: 1, capability_degradation: false,
    }),
  };
  const run = await runShadowQualification({ definition, provider: fakeProvider, providerId: 'fake' });
  assert.equal(run.results[0].completed, true);
  assert.equal(run.results[0].response, undefined);
  assert.equal(run.results[0].advisory_recommendation, 'APPLY');
  assert.equal(run.results[0].policy_recommendation, 'APPLY');
  assert.deepEqual(run.results[0].gate_values, {
    posting_live: 'YES',
    citizenship_restricted: 'NO',
    geography_eligible: 'YES',
    sponsorship_compatible: 'YES',
    required_evidence_complete: 'YES',
  });
  assert.deepEqual(run.results[0].policy_reason_codes, []);
  assert.equal(run.metrics.token_use, 15);
  assert.equal(run.qualification.lifecycle_state, 'candidate');
});

test('shadow suite batches independent case metrics across fewer provider runs', async () => {
  const definition = {
    schema: 'RuntimeQualificationSetV1', schema_version: 1, evaluation_set_version: 'batch-test-v1', case_count: 3,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'eligible', score: 4.4, advisory_recommendation: 'APPLY', expected_recommendation: 'APPLY', fit_summary: 'The candidate meets the requirements.' }],
  };
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async (request, { attempt }) => record('RawProviderResultV1', {
      task_id: request.task.task_id,
      provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
      response: { evaluations: request.cases.map(item => ({ case_id: item.case_id, response: makeResponse() })) },
      usage: { input_tokens: 30, output_tokens: 15 }, latency_ms: 2, attempts: attempt, capability_degradation: false,
    }),
  };
  const run = await runShadowQualification({ definition, provider: fakeProvider, providerId: 'fake', providerRuns: 1 });
  assert.equal(run.provider_run_count, 1);
  assert.equal(run.provider_call_count, 1);
  assert.equal(run.results.length, 3);
  assert.equal(run.results.every(item => item.completed), true);
  assert.equal(run.metrics.token_use, 15);
});

test('shadow suite can target unique challenge case IDs without evaluating neighbors', async () => {
  const definition = {
    schema: 'RuntimeQualificationSetV1', schema_version: 1, evaluation_set_version: 'target-test-v1', case_count: 3,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'eligible', score: 4.4, advisory_recommendation: 'APPLY', expected_recommendation: 'APPLY', fit_summary: 'The candidate meets the requirements.' }],
  };
  const seen = [];
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async request => {
      seen.push(...request.cases.map(item => item.case_id));
      return record('RawProviderResultV1', {
        task_id: request.task.task_id,
        provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
        response: { evaluations: request.cases.map(item => ({ case_id: item.case_id, response: makeResponse() })) },
        usage: {}, latency_ms: 1, attempts: 1, capability_degradation: false,
      });
    },
  };
  const run = await runShadowQualification({
    definition, provider: fakeProvider, providerId: 'fake', caseIds: ['eligible-03', 'eligible-01'], providerRuns: 1,
  });
  assert.deepEqual(seen, ['eligible-03', 'eligible-01']);
  assert.deepEqual(run.selected_case_ids, ['eligible-03', 'eligible-01']);
  assert.deepEqual(run.results.map(item => item.case_id), ['eligible-03', 'eligible-01']);
  await assert.rejects(runShadowQualification({
    definition, provider: fakeProvider, providerId: 'fake', caseIds: ['missing'], providerRuns: 1,
  }), /Unknown qualification case IDs/);
});

test('shadow preflight fails closed on disagreement, repair, or policy errors', () => {
  const run = record('ShadowQualificationRunV1', {
    metrics: {
      recommendation_agreement: 8 / 9,
      schema_success: 1,
      failure_rate: 0,
      hard_gate_errors: 0,
      authorization_errors: 0,
      repair_rate: 0,
    },
  });
  const failed = evaluateShadowPreflight(run);
  assert.equal(failed.passed, false);
  assert.equal(failed.checks.recommendation_agreement, false);
  const passed = evaluateShadowPreflight({
    ...run,
    metrics: { ...run.metrics, recommendation_agreement: 1 },
  });
  assert.equal(passed.passed, true);
  const repaired = evaluateShadowPreflight({
    ...run,
    metrics: { ...run.metrics, recommendation_agreement: 1, repair_rate: 0.1 },
  });
  assert.equal(repaired.passed, false);
  assert.equal(evaluateShadowPreflight({
    ...run,
    metrics: { ...run.metrics, recommendation_agreement: 1, repair_rate: 0.1 },
  }, { requireNoRepairs: false }).passed, true);
});

test('failed shadow batches split into bounded single-case fallback runs', async () => {
  const definition = {
    schema: 'RuntimeQualificationSetV1', schema_version: 1, evaluation_set_version: 'fallback-test-v1', case_count: 3,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'eligible', score: 4.4, advisory_recommendation: 'APPLY', expected_recommendation: 'APPLY', fit_summary: 'The candidate meets the requirements.' }],
  };
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async (request, { attempt }) => {
      if (request.cases.length > 1) throw new Error('synthetic batch failure');
      return record('RawProviderResultV1', {
        task_id: request.task.task_id,
        provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
        response: { evaluations: [{ case_id: request.cases[0].case_id, response: makeResponse() }] },
        usage: {}, latency_ms: 1, attempts: attempt, capability_degradation: false,
      });
    },
  };
  const run = await runShadowQualification({ definition, provider: fakeProvider, providerId: 'fake', providerRuns: 1 });
  assert.equal(run.planned_provider_run_count, 1);
  assert.equal(run.fallback_provider_run_count, 3);
  assert.equal(run.provider_call_count, 5);
  assert.equal(run.results.every(item => item.completed), true);
});

test('one malformed case falls back independently without retrying valid siblings', async () => {
  const definition = {
    schema: 'RuntimeQualificationSetV1', schema_version: 1, evaluation_set_version: 'partial-test-v1', case_count: 3,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'eligible', score: 4.4, advisory_recommendation: 'APPLY', expected_recommendation: 'APPLY', fit_summary: 'The candidate meets the requirements.' }],
  };
  const repairs = [];
  const fakeProvider = {
    snapshot: () => ({ provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' }),
    complete: async (request, { attempt, repair }) => {
      repairs.push(repair);
      return record('RawProviderResultV1', {
      task_id: request.task.task_id,
      provider_snapshot: { provider: 'fake', model_snapshot: 'fake-1', capability_class: 'STANDARD', execution_surface: 'test' },
      response: { evaluations: request.cases.map((item, index) => ({ case_id: item.case_id, response: request.cases.length > 1 && index === 1 ? {} : makeResponse() })) },
      usage: { input_tokens: request.cases.length * 10, output_tokens: request.cases.length * 5 },
      latency_ms: 1, attempts: attempt, capability_degradation: false,
      });
    },
  };
  const run = await runShadowQualification({ definition, provider: fakeProvider, providerId: 'fake', providerRuns: 1 });
  assert.equal(run.provider_call_count, 2);
  assert.equal(run.fallback_provider_run_count, 1);
  assert.deepEqual(run.results.map(item => item.attempts), [1, 2, 1]);
  assert.equal(run.results.every(item => item.completed), true);
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0], null);
  assert.match(repairs[1].message, /decision_inputs must be an object/);
});
