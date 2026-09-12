import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFreshManualQuotas,
  assertNoLocalIndexInputs,
  buildRouteShadowPlan,
  chooseEscalations,
  compactTriageEvidence,
  escalationTriggers,
  resolveRoutingProfile,
  runRouteShadow,
  runTriageRanking,
} from '../lib/runtime/route-shadow.mjs';

const profile = {
  triage: { provider: 'flash', batch_size: 2, authority: 'RANK_ONLY' },
  judgment: { provider: 'luna' },
  escalation: {
    provider: 'sol', max_share: 0.2, apply_score_minimum: 4,
    boundary_minimum: 3.8, boundary_maximum: 4.2, confidence_minimum: 0.85,
    contradiction_reason_codes: ['EVIDENCE_CONFLICT'],
    missing_evidence_reason_codes: ['REQUIRED_EVIDENCE_INCOMPLETE', 'SCORE_MISSING'],
  },
};

function definition(count = 5) {
  return {
    schema: 'RuntimeQualificationSetV1', schema_version: 1,
    evaluation_set_version: 'route-test-v1', case_count: count,
    representative: false, task_class: 'job_evaluation', risk: 'MEDIUM', minimum_capability_class: 'STANDARD',
    scenarios: [{ id: 'case', score: 4, advisory_recommendation: 'CONSIDER', expected_recommendation: 'CONSIDER', fit_summary: 'Balanced fit.' }],
  };
}

function result(caseId, overrides = {}) {
  return {
    case_id: caseId, provider_run: 1, completed: true, schema_success: true,
    advisory_recommendation: 'CONSIDER', actual_score: 3.5, actual_confidence: 0.9,
    policy_reason_codes: [], attempts: 1, latency_ms: 10,
    input_tokens: 10, output_tokens: 2, total_tokens: 12,
    measurement_quality: 'EXACT_COMPONENTS', usage_trace: [],
    ...overrides,
  };
}

test('configured profile selects Flash rank-only, Luna routine judgment, and Sol escalation', () => {
  const config = { providers: { flash: {}, luna: {}, sol: {} }, routing_profiles: { 'career-ops-job-v1': profile } };
  assert.equal(resolveRoutingProfile(config, 'career-ops-job-v1').judgment.provider, 'luna');
  assert.equal(profile.triage.authority, 'RANK_ONLY');
  assert.equal(profile.escalation.provider, 'sol');
});

test('every escalation trigger is recognized while missing evidence alone avoids Sol', () => {
  assert.ok(escalationTriggers(result('a', { advisory_recommendation: 'APPLY' }), null, profile).includes('LIKELY_APPLY'));
  assert.ok(escalationTriggers(result('a', { actual_score: 4.3 }), null, profile).includes('HIGH_SCORE'));
  assert.ok(escalationTriggers(result('a', { actual_score: 3.9 }), null, profile).includes('DECISION_BOUNDARY'));
  assert.ok(escalationTriggers(result('a', { actual_confidence: 0.5 }), null, profile).includes('LOW_CONFIDENCE'));
  assert.ok(escalationTriggers(result('a'), result('a', { advisory_recommendation: 'APPLY' }), profile).includes('MODEL_DISAGREEMENT'));
  assert.ok(escalationTriggers(result('a', { contradictory_dimensions: ['ROLE_FIT'] }), null, profile).includes('CONTRADICTORY_EVIDENCE'));
  assert.deepEqual(escalationTriggers(result('a', {
    actual_confidence: 0.5,
    policy_reason_codes: ['REQUIRED_EVIDENCE_INCOMPLETE', 'SCORE_MISSING'],
  }), null, profile), []);
});

test('escalations obey the 20 percent cap and prioritize likely APPLY', () => {
  const judgments = Array.from({ length: 10 }, (_, index) => result(`c${index}`, {
    advisory_recommendation: index === 7 ? 'APPLY' : 'CONSIDER',
    actual_confidence: 0.5 + index / 100,
  }));
  const selected = chooseEscalations(judgments, [], profile, 10);
  assert.equal(selected.cap, 2);
  assert.equal(selected.selected.length, 2);
  assert.equal(selected.selected[0].result.case_id, 'c7');
});

test('pipeline shadow only defers or advances Flash rankings and never finalizes or mutates', async () => {
  const stageProviders = [];
  const run = await runRouteShadow({
    definition: definition(), profileId: 'career-ops-job-v1', profile,
    maxJudgments: 5, maxEscalations: 10,
    async runStage({ stage, providerId, caseIds }) {
      stageProviders.push([stage, providerId]);
      return {
        provider_run_count: caseIds.length, provider_call_count: caseIds.length,
        results: caseIds.map((id, index) => result(id, stage === 'judgment' && index === 0
          ? { advisory_recommendation: 'APPLY', actual_score: 4.5 }
          : { actual_score: 3 - index / 10 })),
      };
    },
  });
  assert.deepEqual(stageProviders, [['triage', 'flash'], ['judgment', 'luna'], ['escalation', 'sol']]);
  assert.equal(run.non_mutating, true);
  assert.equal(run.escalation.cap, 1);
  assert.ok(run.dispositions.every(item => item.finalized === false && item.mutated === false));
  assert.doesNotMatch(JSON.stringify(run), /provider_request|evidence_content|local-index\.md/i);
});

test('Flash triage uses a compact rank-only contract and accounts for its repair attempt', async () => {
  let calls = 0;
  const provider = {
    snapshot: () => ({ provider: 'flash', model_snapshot: 'flash-low' }),
    async complete(request) {
      calls++;
      return {
        response: calls === 1 ? { evaluations: [] } : {
          evaluations: request.cases.map((item, index) => ({
            case_id: item.case_id,
            rank_score: 5 - index,
            provisional_recommendation: index === 0 ? 'APPLY' : 'CONSIDER',
            confidence: 0.9,
          })),
        },
        usage: calls === 1
          ? { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 }
          : { promptTokenCount: 20, candidatesTokenCount: 2, totalTokenCount: 22 },
        latency_ms: 5,
      };
    },
  };
  const ids = ['case-01', 'case-02', 'case-03'];
  const run = await runTriageRanking({ definition: definition(3), provider, providerId: 'flash', caseIds: ids });
  assert.equal(calls, 2);
  assert.equal(run.provider_requests.length, 2);
  assert.equal(run.results.length, 3);
  assert.ok(run.results.every(item => item.completed && item.attempts === 2));
  assert.ok(run.results.every(item => item.policy_recommendation === undefined));
  assert.equal(run.provider_requests.reduce((sum, item) => sum + item.usage.total_tokens, 0), 33);
});

test('Flash triage batches ten cases and sends bounded decision signals instead of full evidence', async () => {
  const captured = [];
  const provider = {
    snapshot: () => ({ provider: 'flash', model_snapshot: 'flash-low' }),
    async complete(request) {
      captured.push(request);
      return {
        response: {
          evaluations: request.cases.map(item => ({
            case_id: item.case_id,
            rank_score: 4,
            provisional_recommendation: 'APPLY',
            confidence: 0.9,
          })),
        },
        usage: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
        latency_ms: 5,
      };
    },
  };
  const ids = Array.from({ length: 10 }, (_, index) => `case-${String(index + 1).padStart(2, '0')}`);
  const run = await runTriageRanking({
    definition: definition(10), provider, providerId: 'flash', caseIds: ids, batchSize: 10,
  });
  assert.equal(captured.length, 1);
  assert.equal(run.provider_run_count, 1);
  assert.equal(captured[0].cases.length, 10);
  assert.ok(captured[0].cases.every(item => item.evidence.every(source => !Object.hasOwn(source, 'content'))));
  assert.doesNotMatch(JSON.stringify(captured[0]), /expected_output|presentation_content|https:\/\/jobs\.example\.com/);
});

test('compact triage evidence retains bounded fit, constraint, level, compensation, and liveness signals', () => {
  const compact = compactTriageEvidence([{
    id: 'EV-1', source_type: 'ats', liveness_state: 'YES', structured_fields: { required_evidence_complete: 'YES' },
    content: [
      'Software Engineer role summary.',
      'Core role fit matches distributed backend systems and Python.',
      'A second skill gap is production Kubernetes experience.',
      'Requires US citizenship and an active clearance.',
      'Minimum 3 years experience at the senior level.',
      'Base salary range is $140,000 to $170,000 plus equity.',
      'Hybrid location with three days in office.',
      'Posting verified active and fresh today.',
      'Evidence conflict: the title is junior but duties are senior.',
      `Presentation-only filler ${'x'.repeat(800)}.`,
    ].join('\n'),
  }]);
  const text = JSON.stringify(compact);
  for (const expected of ['role fit', 'skill gap', 'citizenship', '3 years', '$140,000', 'Hybrid', 'active', 'conflict']) {
    assert.match(text, new RegExp(expected.replace('$', '\\$'), 'i'));
  }
  assert.doesNotMatch(text, /Presentation-only filler/);
  assert.ok(compact[0].signals.every(signal => signal.text.length <= 320));
});

test('route shadow resumes from a digest-bound stage checkpoint without rerunning Flash', async () => {
  let triageCheckpoint;
  const firstStages = [];
  await assert.rejects(runRouteShadow({
    definition: definition(), profileId: 'career-ops-job-v1', profile,
    maxJudgments: 5, maxEscalations: 10,
    async onCheckpoint(checkpoint) { triageCheckpoint = checkpoint; },
    async runStage({ stage, caseIds }) {
      firstStages.push(stage);
      if (stage === 'judgment') throw new Error('simulated interruption');
      return {
        provider_run_count: 1, provider_call_count: 1,
        results: caseIds.map((id, index) => result(id, { actual_score: 5 - index / 10 })),
      };
    },
  }), /simulated interruption/);
  assert.deepEqual(firstStages, ['triage', 'judgment']);
  assert.equal(triageCheckpoint.completed_stage, 'triage');
  assert.doesNotMatch(JSON.stringify(triageCheckpoint), /prompt|evidence_content|local-index\.md/i);

  const resumedStages = [];
  const checkpoints = [];
  const resumed = await runRouteShadow({
    definition: definition(), profileId: 'career-ops-job-v1', profile,
    maxJudgments: 5, maxEscalations: 10, resume: triageCheckpoint,
    async onCheckpoint(checkpoint) { checkpoints.push(checkpoint.completed_stage); },
    async runStage({ stage, caseIds }) {
      resumedStages.push(stage);
      return {
        provider_run_count: caseIds.length, provider_call_count: caseIds.length,
        results: caseIds.map((id, index) => result(id, stage === 'judgment' && index === 0
          ? { advisory_recommendation: 'APPLY', actual_score: 4.5 }
          : {})),
      };
    },
  });
  assert.deepEqual(resumedStages, ['judgment', 'escalation']);
  assert.deepEqual(checkpoints, ['judgment', 'escalation']);
  assert.equal(resumed.stages[0].completed_count, 5);

  const tampered = structuredClone(triageCheckpoint);
  tampered.runs.triage.results[0].actual_score = 0;
  await assert.rejects(runRouteShadow({
    definition: definition(), profileId: 'career-ops-job-v1', profile,
    maxJudgments: 5, maxEscalations: 10, resume: tampered,
    async runStage() { throw new Error('must not run'); },
  }), /digest mismatch/);
});

test('projection supports complete, partial, and missing baselines without treating UNKNOWN as zero', () => {
  const baseline = {
    stages: ['triage', 'judgment', 'escalation'].map(stage => ({
      stage, case_count: 5,
      usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60, measurement_quality: 'EXACT_COMPONENTS' },
    })),
  };
  const complete = buildRouteShadowPlan({ definition: definition(), profileId: 'p', profile, maxJudgments: 5, maxEscalations: 10, baseline });
  assert.equal(complete.projected.usage.measurement_quality, 'EXACT_COMPONENTS');
  const partial = buildRouteShadowPlan({ definition: definition(), profileId: 'p', profile, maxJudgments: 5, maxEscalations: 10, baseline: { stages: baseline.stages.slice(0, 2) } });
  assert.equal(partial.projected.stages[2].projected_usage.total_tokens, null);
  assert.equal(partial.projected.usage.total_tokens, null);
  const missing = buildRouteShadowPlan({ definition: definition(), profileId: 'p', profile, maxJudgments: 5, maxEscalations: 10 });
  assert.equal(missing.projected.usage.total_tokens, null);
});

test('stale or unknown manual quota observations fail closed', () => {
  const config = {
    providers: { flash: { resource_pool: 'google' }, luna: { resource_pool: 'chatgpt' }, sol: { resource_pool: 'chatgpt' } },
    resource_pools: {
      google: { quota_state: 'UNKNOWN' },
      chatgpt: { quota_state: 'AVAILABLE', remaining_ratio: 0.8, minimum_reserve_ratio: 0.2, observed_at: '2026-09-07T10:00:00Z', expires_at: '2026-09-07T10:30:00Z' },
    },
  };
  assert.throws(() => assertFreshManualQuotas(config, profile, { now: new Date('2026-09-07T10:15:00Z') }), /google/);
  config.resource_pools.google = { ...config.resource_pools.chatgpt, expires_at: '2026-09-07T10:10:00Z' };
  assert.throws(() => assertFreshManualQuotas(config, profile, { now: new Date('2026-09-07T10:15:00Z') }), /stale/);
});

test('local-index paths are rejected before any provider stage', () => {
  assert.throws(() => assertNoLocalIndexInputs([{ evidence_content: { x: 'D:/private/historical-split-label-review-local-index.md' } }]), /cannot contain/);
});
