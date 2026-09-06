import { evaluateResponse, evaluateWithProvider } from './orchestrator.mjs';
import { parseProviderJson } from './normalize.mjs';
import { buildProviderRequest, prepareTask } from './prepare.mjs';
import { aggregateQualificationResults, qualifyModel } from './qualification.mjs';
import { record, sha256 } from './util.mjs';

const DEFAULT_GATES = Object.freeze({
  posting_live: 'YES',
  citizenship_restricted: 'NO',
  geography_eligible: 'YES',
  sponsorship_compatible: 'YES',
  required_evidence_complete: 'YES',
});

function assertSet(definition) {
  const synthetic = definition?.schema === 'RuntimeQualificationSetV1' && definition.schema_version === 1;
  const prepared = definition?.schema === 'RuntimePreparedQualificationSetV1' && definition.schema_version === 1;
  if (!synthetic && !prepared) throw new Error('Unsupported qualification set schema or version');
  if (!definition.evaluation_set_version || !Number.isInteger(definition.case_count) || definition.case_count < 1) {
    throw new Error('Qualification set requires a version and positive case_count');
  }
  if (synthetic && (!Array.isArray(definition.scenarios) || definition.scenarios.length === 0)) {
    throw new Error('Qualification set requires scenarios');
  }
  if (prepared) {
    const { set_digest: observedDigest, ...unsigned } = definition;
    if (!observedDigest || sha256(unsigned) !== observedDigest) throw new Error('Prepared qualification set digest mismatch');
    if (!Array.isArray(definition.cases) || definition.cases.length !== definition.case_count) {
      throw new Error('Prepared qualification set case_count mismatch');
    }
    if (definition.human_approved !== true || definition.promotion_eligible !== false || definition.gate_labels_included !== false) {
      throw new Error('Prepared historical set must be human-approved and non-promotable without gate labels');
    }
  }
}

function evidenceText(gates, scenario, caseId) {
  const statements = [
    `Synthetic qualification case ${caseId}.`,
    gates.posting_live === 'YES' ? 'The posting is active.' : gates.posting_live === 'NO' ? 'The posting is closed.' : 'Posting liveness is not stated.',
    gates.citizenship_restricted === 'YES' ? 'U.S. citizens only.' : gates.citizenship_restricted === 'NO' ? 'No citizenship requirement.' : 'Citizenship requirements are not stated.',
    gates.sponsorship_compatible === 'YES' ? 'Visa sponsorship is available.' : gates.sponsorship_compatible === 'NO' ? 'No visa sponsorship.' : 'Visa sponsorship is not stated.',
    gates.geography_eligible === 'YES' ? 'The stated work location is eligible.' : gates.geography_eligible === 'NO' ? 'The stated work location is outside the eligible geography.' : 'Geographic eligibility is not stated.',
    gates.required_evidence_complete === 'YES' ? 'All required scoring evidence is present.' : 'Required scoring evidence is incomplete.',
    scenario.fit_summary,
    scenario.score === null
      ? 'The deterministic fit rubric does not authorize a score.'
      : `The deterministic fit rubric score is ${Number(scenario.score).toFixed(1)} out of 5.`,
    `The advisory recommendation before hard-gate policy is ${scenario.advisory_recommendation}.`,
  ];
  return statements.filter(Boolean).join(' ');
}

export function expandQualificationSet(definition, { now = new Date().toISOString() } = {}) {
  assertSet(definition);
  if (definition.schema === 'RuntimePreparedQualificationSetV1') {
    return definition.cases.map(item => {
      if (!['ADVISORY_RECOMMENDATION', 'POLICY_DECISION', 'DIAGNOSTIC_FINAL_OUTCOME'].includes(item.comparison_stage)) {
        throw new Error(`Unsupported comparison stage for ${item.id}`);
      }
      if (sha256(item.evidence_content?.['EV-1'] || '') !== item.evidence_digest) {
        throw new Error(`Prepared evidence digest mismatch for ${item.id}`);
      }
      buildProviderRequest(item.task, item.evidence_content);
      return item;
    });
  }
  return Array.from({ length: definition.case_count }, (_, index) => {
    const scenario = definition.scenarios[index % definition.scenarios.length];
    const repetition = Math.floor(index / definition.scenarios.length) + 1;
    const caseId = `${scenario.id}-${String(repetition).padStart(2, '0')}`;
    const gates = { ...DEFAULT_GATES, ...(scenario.gates || {}) };
    const content = evidenceText(gates, scenario, caseId);
    const task = prepareTask({
      task_class: definition.task_class || 'job_evaluation',
      risk: definition.risk || 'MEDIUM',
      minimum_capability_class: definition.minimum_capability_class || 'STANDARD',
      company: `Qualification ${String(index + 1).padStart(2, '0')}`,
      role: scenario.role || 'Software Engineer, New Grad',
      url: `https://jobs.example.com/qualification/${caseId}`,
      resume: scenario.resume || 'SDE',
      source: 'greenhouse',
      evidence: [{
        id: 'EV-1', source_type: 'greenhouse', uri: `https://jobs.example.com/qualification/${caseId}`,
        content, retrieved_at: now, liveness_state: gates.posting_live,
        structured_fields: {
          citizenship_restricted: gates.citizenship_restricted,
          geography_eligible: gates.geography_eligible,
          sponsorship_compatible: gates.sponsorship_compatible,
          required_evidence_complete: gates.required_evidence_complete,
        },
      }],
      idempotency_key: sha256(`${definition.evaluation_set_version}:${caseId}`),
    }, { now, taskId: `qualification-${caseId}` });
    return {
      id: caseId,
      task,
      evidence_content: { 'EV-1': content },
      expected_gates: gates,
      expected_recommendation: scenario.expected_recommendation,
    };
  });
}

function token(usage, name) {
  return Number(usage?.[name] || 0);
}

function successResult(item, evaluation, { usage = {}, attempts = 1, latencyMs = 0, providerRun = 0 } = {}) {
  const expectedGates = item.expected_gates || {};
  const gateErrors = Object.entries(expectedGates)
    .filter(([gate, expected]) => evaluation.normalized.decision_inputs.gates[gate].value !== expected).length;
  const warnings = evaluation.normalized.validation_warnings;
  const consequentialGates = ['citizenship_restricted', 'geography_eligible', 'sponsorship_compatible']
    .filter(gate => Object.hasOwn(expectedGates, gate));
  const advisoryComparison = item.comparison_stage === 'ADVISORY_RECOMMENDATION';
  const recommendationComparisonEligible = item.comparison_stage !== 'DIAGNOSTIC_FINAL_OUTCOME';
  const gateValues = Object.fromEntries(Object.entries(evaluation.normalized.decision_inputs.gates)
    .map(([gate, resolution]) => [gate, resolution.value]));
  return {
    case_id: item.id,
    provider_run: providerRun,
    completed: true,
    schema_success: true,
    expected_recommendation: item.expected_recommendation,
    recommendation_comparison_eligible: recommendationComparisonEligible,
    actual_recommendation: advisoryComparison
      ? evaluation.normalized.decision_inputs.recommendation
      : evaluation.decision.decision,
    advisory_recommendation: evaluation.normalized.decision_inputs.recommendation,
    policy_recommendation: evaluation.decision.decision,
    gate_values: gateValues,
    policy_reason_codes: evaluation.decision.reasons.map(reason => reason.code),
    actual_score: evaluation.normalized.decision_inputs.score,
    actual_confidence: evaluation.normalized.decision_inputs.confidence,
    hard_gate_errors: gateErrors,
    authorization_errors: 0,
    consequential_gate_count: consequentialGates.length,
    consequential_unknown_count: consequentialGates
      .filter(gate => evaluation.normalized.decision_inputs.gates[gate].value === 'UNKNOWN').length,
    evidence_correct: Object.keys(expectedGates).length > 0
      && gateErrors === 0
      && !warnings.some(value => /unsupported|enrichment/i.test(value)),
    attempts,
    latency_ms: latencyMs,
    input_tokens: token(usage, 'input_tokens'),
    output_tokens: token(usage, 'output_tokens'),
    thinking_tokens: token(usage, 'thinking_tokens'),
    cache_read_tokens: token(usage, 'cache_read_tokens'),
    response_digest: sha256(evaluation.rawResult.response),
  };
}

function failureResult(item, error, { attempts = 2, providerRun = 0, usage = {}, latencyMs = 0 } = {}) {
  const expectedGates = item.expected_gates || {};
  return {
    case_id: item.id,
    provider_run: providerRun,
    completed: false,
    schema_success: false,
    expected_recommendation: item.expected_recommendation,
    recommendation_comparison_eligible: item.comparison_stage !== 'DIAGNOSTIC_FINAL_OUTCOME',
    actual_recommendation: 'FAILED',
    advisory_recommendation: null,
    policy_recommendation: null,
    gate_values: {},
    policy_reason_codes: [],
    actual_score: null,
    actual_confidence: null,
    hard_gate_errors: 0,
    authorization_errors: 0,
    consequential_gate_count: ['citizenship_restricted', 'geography_eligible', 'sponsorship_compatible']
      .filter(gate => Object.hasOwn(expectedGates, gate)).length,
    consequential_unknown_count: 0,
    evidence_correct: false,
    attempts,
    latency_ms: latencyMs,
    input_tokens: token(usage, 'input_tokens'),
    output_tokens: token(usage, 'output_tokens'),
    thinking_tokens: token(usage, 'thinking_tokens'),
    cache_read_tokens: token(usage, 'cache_read_tokens'),
    error_code: error.code || error.name,
    error_message: String(error.message).slice(0, 500),
  };
}

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens'];

export function evaluateShadowPreflight(run, { minimumAgreement = 1, requireNoRepairs = true } = {}) {
  const threshold = Number(minimumAgreement);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('minimumAgreement must be between 0 and 1');
  }
  if (run?.schema !== 'ShadowQualificationRunV1' || !run.metrics) {
    throw new Error('Shadow preflight requires a ShadowQualificationRunV1 record');
  }
  const checks = {
    recommendation_agreement: Number(run.metrics.recommendation_agreement || 0) >= threshold,
    schema_success: Number(run.metrics.schema_success || 0) === 1,
    completion: Number(run.metrics.failure_rate || 0) === 0,
    zero_hard_gate_errors: Number(run.metrics.hard_gate_errors || 0) === 0,
    zero_authorization_errors: Number(run.metrics.authorization_errors || 0) === 0,
    repair_rate: !requireNoRepairs || Number(run.metrics.repair_rate || 0) === 0,
  };
  return record('ShadowPreflightGateV1', {
    minimum_agreement: threshold,
    require_no_repairs: requireNoRepairs,
    checks,
    passed: Object.values(checks).every(Boolean),
  });
}

function addUsage(left = {}, right = {}) {
  return Object.fromEntries(USAGE_FIELDS.map(name => [name, token(left, name) + token(right, name)]));
}

function divideUsage(usage, count) {
  return Object.fromEntries(USAGE_FIELDS.map(name => [name, Math.ceil(token(usage, name) / count)]));
}

function includePriorConsumption(result, prior) {
  return {
    ...result,
    attempts: result.attempts + prior.attempts,
    latency_ms: result.latency_ms + prior.latencyMs,
    input_tokens: result.input_tokens + token(prior.usage, 'input_tokens'),
    output_tokens: result.output_tokens + token(prior.usage, 'output_tokens'),
    thinking_tokens: result.thinking_tokens + token(prior.usage, 'thinking_tokens'),
    cache_read_tokens: result.cache_read_tokens + token(prior.usage, 'cache_read_tokens'),
    ...(prior.error ? {
      fallback_from_error_code: prior.error.code || prior.error.name || 'VALIDATION_ERROR',
      fallback_from_error_message: String(prior.error.message || 'Batch case validation failed').slice(0, 500),
    } : {}),
  };
}

function partitionCases(cases, providerRuns) {
  const batches = [];
  let cursor = 0;
  for (let run = 0; run < providerRuns; run++) {
    const remainingCases = cases.length - cursor;
    const remainingRuns = providerRuns - run;
    const size = Math.ceil(remainingCases / remainingRuns);
    batches.push(cases.slice(cursor, cursor + size));
    cursor += size;
  }
  return batches;
}

async function evaluateBatch(batch, provider, providerRun, { repairFrom = null } = {}) {
  const requests = batch.map(item => buildProviderRequest(item.task, item.evidence_content));
  const request = {
    instruction: `${requests[0].instruction} Return one object with an evaluations array. Preserve each case_id and place that case's provider response under response. For qualification, keep every A-G field to one short factual sentence of at most 160 characters.`,
    task: { task_id: `shadow-batch-${providerRun}` },
    cases: batch.map((item, index) => ({ case_id: item.id, task: requests[index].task, evidence: requests[index].evidence })),
  };
  let lastError = repairFrom;
  let accumulatedUsage = {};
  let accumulatedLatency = 0;
  const maximumAttempts = repairFrom ? 1 : 2;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    try {
      const raw = await provider.complete(request, {
        attempt,
        repair: lastError ? { error: lastError.code || lastError.name, message: lastError.message } : null,
      });
      accumulatedUsage = addUsage(accumulatedUsage, raw.usage);
      accumulatedLatency += raw.latency_ms;
      const parsed = parseProviderJson(raw.response);
      if (!Array.isArray(parsed.evaluations)) {
        throw new Error('Batch response must contain an evaluations array');
      }
      const requestedIds = new Set(batch.map(item => item.id));
      const returnedIds = parsed.evaluations.map(item => item?.case_id);
      if (new Set(returnedIds).size !== returnedIds.length || returnedIds.some(id => !requestedIds.has(id))) {
        throw new Error('Batch response contains duplicate or foreign case IDs');
      }
      const byId = new Map(parsed.evaluations.map(item => [item?.case_id, item?.response]));
      const allocatedUsage = divideUsage(accumulatedUsage, batch.length);
      const results = [];
      const failures = [];
      for (const item of batch) {
        try {
          if (!byId.has(item.id)) throw new Error(`Batch response omitted ${item.id}`);
          const evaluation = evaluateResponse(item.task, byId.get(item.id), provider.snapshot());
          results.push(successResult(item, evaluation, {
            usage: allocatedUsage,
            attempts: attempt,
            latencyMs: accumulatedLatency,
            providerRun,
          }));
        } catch (error) {
          failures.push({ item, error, prior: { usage: allocatedUsage, attempts: attempt, latencyMs: accumulatedLatency, error } });
        }
      }
      if (failures.length && batch.length === 1 && attempt < maximumAttempts) {
        lastError = failures[0].error;
        continue;
      }
      return { results, failures, attempts: attempt };
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(lastError, {
    attempts: maximumAttempts,
    prior: { usage: divideUsage(accumulatedUsage, batch.length), attempts: maximumAttempts, latencyMs: accumulatedLatency },
  });
}

export async function runShadowQualification({
  definition,
  provider,
  providerId,
  offset = 0,
  limit = definition.case_count,
  caseIds = null,
  providerRuns = null,
  onProgress = null,
}) {
  const expanded = expandQualificationSet(definition);
  let cases;
  if (caseIds) {
    if (!Array.isArray(caseIds) || caseIds.length < 1 || caseIds.length > 50 || new Set(caseIds).size !== caseIds.length) {
      throw new Error('caseIds must contain 1-50 unique case IDs');
    }
    const byId = new Map(expanded.map(item => [item.id, item]));
    const missing = caseIds.filter(caseId => !byId.has(caseId));
    if (missing.length) throw new Error(`Unknown qualification case IDs: ${missing.join(', ')}`);
    cases = caseIds.map(caseId => byId.get(caseId));
  } else {
    cases = expanded.slice(offset, offset + limit);
  }
  const selectedProviderRuns = providerRuns ?? cases.length;
  if (!Number.isInteger(selectedProviderRuns) || selectedProviderRuns < 1 || selectedProviderRuns > cases.length) {
    throw new Error('providerRuns must be between 1 and the selected case count');
  }
  const results = [];
  let providerCallCount = 0;
  let fallbackRunCount = 0;
  const batches = partitionCases(cases, selectedProviderRuns);
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    if (batch.length === 1) {
      const item = batch[0];
      try {
        const evaluation = await evaluateWithProvider({ task: item.task, evidenceContent: item.evidence_content, provider });
        providerCallCount += evaluation.rawResult.attempts;
        results.push(successResult(item, evaluation, {
          usage: evaluation.rawResult.usage,
          attempts: evaluation.rawResult.attempts,
          latencyMs: evaluation.rawResult.latency_ms,
          providerRun: index + 1,
        }));
      } catch (error) {
        providerCallCount += error.attempts || 2;
        results.push(failureResult(item, error, {
          attempts: error.attempts || 2,
          providerRun: index + 1,
          usage: error.usage || {},
          latencyMs: error.latencyMs || 0,
        }));
      }
    } else {
      try {
        const outcome = await evaluateBatch(batch, provider, index + 1);
        providerCallCount += outcome.attempts;
        results.push(...outcome.results);
        for (const failed of outcome.failures) {
          const fallbackRun = `${index + 1}-fallback-${fallbackRunCount + 1}`;
          fallbackRunCount++;
          try {
            const fallback = await evaluateBatch([failed.item], provider, fallbackRun, { repairFrom: failed.error });
            providerCallCount += fallback.attempts;
            if (fallback.results.length === 1) {
              results.push(includePriorConsumption(fallback.results[0], failed.prior));
            } else {
              const fallbackFailure = fallback.failures[0];
              results.push(failureResult(failed.item, fallbackFailure.error, {
                attempts: failed.prior.attempts + fallbackFailure.prior.attempts,
                providerRun: fallbackRun,
                usage: addUsage(failed.prior.usage, fallbackFailure.prior.usage),
                latencyMs: failed.prior.latencyMs + fallbackFailure.prior.latencyMs,
              }));
            }
          } catch (fallbackError) {
            providerCallCount += fallbackError.attempts || 2;
            const prior = fallbackError.prior || { usage: {}, attempts: fallbackError.attempts || 2, latencyMs: 0 };
            results.push(failureResult(failed.item, fallbackError, {
              attempts: failed.prior.attempts + prior.attempts,
              providerRun: fallbackRun,
              usage: addUsage(failed.prior.usage, prior.usage),
              latencyMs: failed.prior.latencyMs + prior.latencyMs,
            }));
          }
        }
      } catch (error) {
        providerCallCount += error.attempts || 2;
        for (let fallbackIndex = 0; fallbackIndex < batch.length; fallbackIndex++) {
          const item = batch[fallbackIndex];
          const fallbackRun = `${index + 1}-fallback-${fallbackIndex + 1}`;
          fallbackRunCount++;
          try {
            const fallback = await evaluateBatch([item], provider, fallbackRun, { repairFrom: error });
            providerCallCount += fallback.attempts;
            if (fallback.results.length === 1) {
              results.push(includePriorConsumption(fallback.results[0], error.prior));
            } else {
              const fallbackFailure = fallback.failures[0];
              results.push(failureResult(item, fallbackFailure.error, {
                attempts: error.prior.attempts + fallbackFailure.prior.attempts,
                providerRun: fallbackRun,
                usage: addUsage(error.prior.usage, fallbackFailure.prior.usage),
                latencyMs: error.prior.latencyMs + fallbackFailure.prior.latencyMs,
              }));
            }
          } catch (fallbackError) {
            providerCallCount += fallbackError.attempts || 2;
            const batchPrior = error.prior || { usage: {}, attempts: error.attempts || 2, latencyMs: 0 };
            const fallbackPrior = fallbackError.prior || { usage: {}, attempts: fallbackError.attempts || 2, latencyMs: 0 };
            results.push(failureResult(item, fallbackError, {
              attempts: batchPrior.attempts + fallbackPrior.attempts,
              providerRun: fallbackRun,
              usage: addUsage(batchPrior.usage, fallbackPrior.usage),
              latencyMs: batchPrior.latencyMs + fallbackPrior.latencyMs,
            }));
          }
        }
      }
    }
    results.sort((left, right) => cases.findIndex(item => item.id === left.case_id) - cases.findIndex(item => item.id === right.case_id));
    const recentResults = results.slice(-batch.length);
    onProgress?.({
      completed: results.length,
      total: cases.length,
      provider_run: index + 1,
      provider_runs: batches.length,
      status: recentResults.every(item => item.completed) ? 'OK' : 'FAILED',
      failures: recentResults.filter(item => !item.completed).map(item => ({
        case_id: item.case_id,
        error_code: item.error_code,
        error_message: item.error_message,
      })),
    });
  }
  const snapshot = provider.snapshot();
  const metadata = {
    provider_id: providerId,
    model_snapshot: snapshot.model_snapshot,
    task_class: definition.task_class || 'job_evaluation',
    capability_class: snapshot.capability_class,
    evaluation_set_version: definition.evaluation_set_version,
    representative_set: definition.representative === true,
    truth_source: definition.truth_source || 'UNSPECIFIED',
    label_scope: definition.label_scope || ['recommendation', 'hard_gates'],
    gate_labels_included: definition.gate_labels_included !== false,
    promotion_eligible: definition.promotion_eligible !== false,
  };
  const metrics = aggregateQualificationResults(results, metadata);
  const completeSet = definition.case_count >= 50 && results.length === definition.case_count;
  const numericalChecksPassed = completeSet
    && metrics.hard_gate_errors === 0
    && metrics.authorization_errors === 0
    && metrics.schema_success >= 0.99
    && metrics.recommendation_agreement >= 0.95
    && metrics.failure_rate <= 0.05;
  const recommendationComponent = metadata.label_scope.includes('advisory_recommendation')
    || metadata.label_scope.includes('policy_recommendation');
  const validRecommendationComponent = recommendationComponent
    && metadata.representative_set
    && !(definition.promotion_blockers || []).some(blocker => blocker !== 'RECOMMENDATION_ONLY_LABELS');
  const hardGateComponent = metadata.label_scope.includes('hard_gates')
    && metadata.gate_labels_included
    && metadata.truth_source === 'DETERMINISTIC_ORACLE';
  const componentPassed = numericalChecksPassed && (validRecommendationComponent || hardGateComponent);
  const shadowPassed = definition.representative === true
    && definition.gate_labels_included !== false
    && definition.promotion_eligible !== false
    && definition.case_count >= 50
    && results.length === definition.case_count
    && metrics.hard_gate_errors === 0
    && metrics.authorization_errors === 0
    && metrics.schema_success >= 0.99
    && metrics.recommendation_agreement >= 0.95
    && metrics.failure_rate <= 0.05;
  const qualification = qualifyModel({
    ...metrics,
    shadow_passed: shadowPassed,
    canary_passed: false,
    lifecycle_state: shadowPassed ? 'shadow' : 'candidate',
  });
  return record('ShadowQualificationRunV1', {
    provider_id: providerId,
    model_snapshot: snapshot.model_snapshot,
    evaluation_set_version: definition.evaluation_set_version,
    qualification_set_digest: definition.set_digest || sha256(definition),
    truth_source: metadata.truth_source,
    label_scope: metadata.label_scope,
    gate_labels_included: metadata.gate_labels_included,
    promotion_eligible: metadata.promotion_eligible,
    promotion_blockers: definition.promotion_blockers || [],
    component_passed: componentPassed,
    offset,
    ...(caseIds ? { selected_case_ids: [...caseIds] } : {}),
    requested_count: cases.length,
    planned_provider_run_count: batches.length,
    fallback_provider_run_count: fallbackRunCount,
    provider_run_count: batches.length + fallbackRunCount,
    provider_call_count: providerCallCount,
    results,
    metrics,
    qualification,
  });
}
