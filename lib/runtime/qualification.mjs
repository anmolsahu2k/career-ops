import { CAPABILITY_CLASSES } from './constants.mjs';
import { record, sha256 } from './util.mjs';

export function wilsonInterval(successes, sampleCount, z = 1.959963984540054) {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0) return { lower: 0, upper: 1 };
  const successesClamped = Math.max(0, Math.min(sampleCount, Number(successes) || 0));
  const p = successesClamped / sampleCount;
  const denominator = 1 + (z * z) / sampleCount;
  const center = (p + (z * z) / (2 * sampleCount)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / sampleCount) + (z * z) / (4 * sampleCount * sampleCount)) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function aggregateQualificationResults(results, metadata = {}) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('Qualification results must be a non-empty array');
  const completed = results.filter(item => item.completed === true);
  const recommendationComparable = results.filter(item => item.recommendation_comparison_eligible !== false);
  const agreementSuccesses = recommendationComparable
    .filter(item => item.expected_recommendation === item.actual_recommendation).length;
  const totalTokens = results.reduce((sum, item) => sum + Number(item.input_tokens || 0) + Number(item.output_tokens || 0), 0);
  const totalConsequentialGates = results.reduce((sum, item) => sum + Number(item.consequential_gate_count || 0), 0);
  return {
    ...metadata,
    sample_count: recommendationComparable.length,
    transport_sample_count: results.length,
    recommendation_agreement_successes: agreementSuccesses,
    recommendation_agreement: ratio(agreementSuccesses, recommendationComparable.length),
    hard_gate_errors: results.reduce((sum, item) => sum + Number(item.hard_gate_errors || 0), 0),
    authorization_errors: results.reduce((sum, item) => sum + Number(item.authorization_errors || 0), 0),
    consequential_unknown_rate: ratio(
      results.reduce((sum, item) => sum + Number(item.consequential_unknown_count || 0), 0),
      totalConsequentialGates,
    ),
    schema_success: ratio(results.filter(item => item.schema_success === true).length, results.length),
    evidence_accuracy: ratio(results.filter(item => item.evidence_correct === true).length, results.length),
    repair_rate: ratio(results.filter(item => Number(item.attempts || 1) > 1).length, results.length),
    latency_ms: ratio(results.reduce((sum, item) => sum + Number(item.latency_ms || 0), 0), results.length),
    token_use: ratio(totalTokens, results.length),
    failure_rate: 1 - ratio(completed.length, results.length),
  };
}

export function qualifyModel(input, incumbent = null) {
  const sampleCount = Number(input.sample_count || 0);
  const agreementSuccesses = Number.isInteger(input.recommendation_agreement_successes)
    ? input.recommendation_agreement_successes
    : Math.round(Number(input.recommendation_agreement || 0) * sampleCount);
  const agreement = sampleCount > 0 ? agreementSuccesses / sampleCount : 0;
  const interval = wilsonInterval(agreementSuccesses, sampleCount);
  const schemaSuccess = Number(input.schema_success || 0);
  const unknownRate = Number(input.consequential_unknown_rate || 0);
  const incumbentUnknownRate = incumbent ? Number(incumbent.consequential_unknown_rate || 0) : unknownRate;
  const checks = {
    representative_sample: sampleCount >= 50 && input.representative_set === true,
    zero_hard_gate_errors: Number(input.hard_gate_errors || 0) === 0,
    zero_authorization_errors: Number(input.authorization_errors || 0) === 0,
    recommendation_agreement: agreement >= 0.95,
    confidence_lower_bound: interval.lower >= 0.90,
    schema_success: schemaSuccess >= 0.99,
    consequential_unknown_rate: unknownRate <= incumbentUnknownRate + 0.05,
    completion_rate: Number(input.failure_rate || 0) <= 0.05,
    shadow_passed: input.shadow_passed === true,
    canary_passed: input.canary_passed === true,
  };
  const qualified = Object.values(checks).every(Boolean);
  const lifecycleStates = ['candidate', 'shadow', 'canary', 'production', 'quarantined', 'retired'];
  let lifecycleState = lifecycleStates.includes(input.lifecycle_state) ? input.lifecycle_state : 'candidate';
  const shadowEligible = checks.representative_sample
    && checks.zero_hard_gate_errors
    && checks.zero_authorization_errors
    && checks.recommendation_agreement
    && checks.confidence_lower_bound
    && checks.schema_success
    && checks.consequential_unknown_rate
    && checks.completion_rate
    && checks.shadow_passed;
  if (lifecycleState === 'shadow' && !shadowEligible) lifecycleState = 'candidate';
  if (lifecycleState === 'canary' && !(shadowEligible && checks.canary_passed)) {
    lifecycleState = shadowEligible ? 'shadow' : 'candidate';
  }
  if (lifecycleState === 'production' && !qualified) lifecycleState = 'quarantined';
  return record('ModelQualificationV1', {
    provider_id: input.provider_id,
    model_snapshot: input.model_snapshot,
    task_class: input.task_class,
    capability_class: CAPABILITY_CLASSES.includes(input.capability_class) ? input.capability_class : 'DETERMINISTIC',
    sample_count: sampleCount,
    evaluation_set_version: input.evaluation_set_version,
    representative_set: input.representative_set === true,
    point_estimate: agreement,
    confidence_interval_95: interval,
    hard_gate_errors: Number(input.hard_gate_errors || 0),
    authorization_errors: Number(input.authorization_errors || 0),
    consequential_unknown_rate: unknownRate,
    schema_success: schemaSuccess,
    recommendation_agreement: agreement,
    evidence_accuracy: Number(input.evidence_accuracy || 0),
    repair_rate: Number(input.repair_rate || 0),
    latency_ms: Number(input.latency_ms || 0),
    token_use: Number(input.token_use || 0),
    failure_rate: Number(input.failure_rate || 0),
    checks,
    qualified,
    lifecycle_state: lifecycleState,
  });
}

function assertQualificationRun(run, kind) {
  if (run?.schema !== 'ShadowQualificationRunV1' || run.schema_version !== 1) {
    throw new Error(`${kind} must be a ShadowQualificationRunV1 record`);
  }
  if (run.component_passed !== true) throw new Error(`${kind} did not pass its component checks`);
  if (!run.metrics || !Array.isArray(run.results)) throw new Error(`${kind} is missing metrics or case results`);
}

function weightedMean(left, right, field) {
  const leftCount = Number(left.sample_count || 0);
  const rightCount = Number(right.sample_count || 0);
  const total = leftCount + rightCount;
  return total > 0
    ? ((Number(left[field] || 0) * leftCount) + (Number(right[field] || 0) * rightCount)) / total
    : 0;
}

export function composeQualificationEvidence({ recommendationRun, hardGateRun, incumbent = null }) {
  assertQualificationRun(recommendationRun, 'recommendationRun');
  assertQualificationRun(hardGateRun, 'hardGateRun');
  const hasRecommendationLabels = recommendationRun.label_scope?.includes('advisory_recommendation')
    || recommendationRun.label_scope?.includes('policy_recommendation');
  if (!hasRecommendationLabels || recommendationRun.gate_labels_included !== false) {
    throw new Error('recommendationRun must contain representative recommendation labels only');
  }
  if (!recommendationRun.metrics.representative_set) throw new Error('recommendationRun must be representative');
  const unresolvedRecommendationBlockers = (recommendationRun.promotion_blockers || [])
    .filter(blocker => blocker !== 'RECOMMENDATION_ONLY_LABELS');
  if (unresolvedRecommendationBlockers.length) {
    throw new Error(`recommendationRun has unresolved blockers: ${unresolvedRecommendationBlockers.join(', ')}`);
  }
  if (!hardGateRun.label_scope?.includes('hard_gates')
      || hardGateRun.gate_labels_included !== true
      || hardGateRun.truth_source !== 'DETERMINISTIC_ORACLE') {
    throw new Error('hardGateRun must contain deterministic hard-gate labels');
  }
  const identityFields = ['provider_id', 'model_snapshot'];
  for (const field of identityFields) {
    if (!recommendationRun[field] || recommendationRun[field] !== hardGateRun[field]) {
      throw new Error(`Qualification component ${field} values do not match`);
    }
  }
  const recommendationMetrics = recommendationRun.metrics;
  const gateMetrics = hardGateRun.metrics;
  for (const field of ['task_class', 'capability_class']) {
    if (!recommendationMetrics[field] || recommendationMetrics[field] !== gateMetrics[field]) {
      throw new Error(`Qualification component ${field} values do not match`);
    }
  }
  const metrics = {
    provider_id: recommendationRun.provider_id,
    model_snapshot: recommendationRun.model_snapshot,
    task_class: recommendationMetrics.task_class,
    capability_class: recommendationMetrics.capability_class,
    evaluation_set_version: `${recommendationRun.evaluation_set_version}+${hardGateRun.evaluation_set_version}`,
    representative_set: true,
    sample_count: recommendationMetrics.sample_count,
    recommendation_agreement_successes: recommendationMetrics.recommendation_agreement_successes,
    recommendation_agreement: recommendationMetrics.recommendation_agreement,
    hard_gate_errors: Number(gateMetrics.hard_gate_errors || 0),
    authorization_errors: Number(recommendationMetrics.authorization_errors || 0) + Number(gateMetrics.authorization_errors || 0),
    consequential_unknown_rate: Number(gateMetrics.consequential_unknown_rate || 0),
    schema_success: weightedMean(recommendationMetrics, gateMetrics, 'schema_success'),
    evidence_accuracy: Number(gateMetrics.evidence_accuracy || 0),
    repair_rate: weightedMean(recommendationMetrics, gateMetrics, 'repair_rate'),
    latency_ms: weightedMean(recommendationMetrics, gateMetrics, 'latency_ms'),
    token_use: weightedMean(recommendationMetrics, gateMetrics, 'token_use'),
    failure_rate: weightedMean(recommendationMetrics, gateMetrics, 'failure_rate'),
  };
  const shadowPassed = recommendationRun.component_passed === true && hardGateRun.component_passed === true;
  const qualification = qualifyModel({
    ...metrics,
    shadow_passed: shadowPassed,
    canary_passed: false,
    lifecycle_state: shadowPassed ? 'shadow' : 'candidate',
  }, incumbent);
  return record('QualificationEvidenceBundleV1', {
    provider_id: metrics.provider_id,
    model_snapshot: metrics.model_snapshot,
    task_class: metrics.task_class,
    component_digests: {
      recommendation: sha256(recommendationRun),
      hard_gates: sha256(hardGateRun),
    },
    coverage: {
      representative_recommendations: true,
      deterministic_hard_gates: true,
      same_model_snapshot: true,
      unresolved_blockers: [],
    },
    metrics,
    qualification,
  });
}

export function advanceLifecycle(qualification, nextState) {
  const transitions = {
    candidate: ['shadow', 'quarantined', 'retired'],
    shadow: ['canary', 'quarantined', 'retired'],
    canary: ['production', 'quarantined', 'retired'],
    production: ['quarantined', 'retired'],
    quarantined: ['shadow', 'retired'],
    retired: [],
  };
  if (!transitions[qualification.lifecycle_state]?.includes(nextState)) {
    throw new Error(`Invalid model lifecycle transition: ${qualification.lifecycle_state} -> ${nextState}`);
  }
  if (nextState === 'shadow' && (qualification.checks?.representative_sample !== true || qualification.checks?.shadow_passed !== true)) {
    throw new Error('A model cannot enter shadow without a representative passing shadow set');
  }
  if (nextState === 'canary' && (qualification.checks?.representative_sample !== true || qualification.checks?.shadow_passed !== true)) {
    throw new Error('A model cannot enter canary without a representative passing shadow set');
  }
  if (nextState === 'production' && !qualification.qualified) throw new Error('An unqualified model cannot enter production');
  return { ...qualification, lifecycle_state: nextState };
}
